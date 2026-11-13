"""The shared, event-agnostic renderer: ask the event to draw each frame
onto a skia canvas, pipe raw RGBA bytes straight into ffmpeg's stdin
(libx264, yuv420p, crf 18, preset veryfast). No frame ever touches disk.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable

import skia

from ..engine.config import Settings
from ..engine.event import Event
from ..engine.records import SimRecord, Timeline


def render_video(
    event: Event,
    record: SimRecord,
    timeline: Timeline,
    settings: Settings,
    teams: list,
    event_cfg: dict,
    out_path: Path,
    width: int,
    height: int,
    fps: int,
    on_frame: Callable[[int, int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> Path:
    """on_frame(frames_done, total_frames) -- an optional progress hook
    (the Studio's job worker uses it to write progress to disk; every
    other caller, including the CLI, just omits it). should_cancel() lets
    a caller abort mid-render (checked between frames, not mid-frame)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if hasattr(event, "init_render"):
        event.init_render(settings)

    surface = skia.Surface(width, height)
    scale = width / settings.width  # 1.0 for a full render, <1 for --preview

    # skia's native 32-bit color type (kN32_ColorType, what Surface actually
    # allocates) is platform-dependent -- RGBA_8888 on this macOS dev
    # machine, but BGRA_8888 on the Linux CI runner (confirmed: the real
    # cause of posted videos coming out with red/blue swapped and every
    # other color shifted -- R and B were silently transposed the whole
    # time there, since this used to hardcode "rgba" for ffmpeg's input
    # regardless of what was actually being written to stdin). Ask the
    # surface what it actually is instead of assuming.
    color_type = surface.imageInfo().colorType()
    if color_type == skia.kRGBA_8888_ColorType:
        input_pix_fmt = "rgba"
    elif color_type == skia.kBGRA_8888_ColorType:
        input_pix_fmt = "bgra"
    else:
        raise RuntimeError(f"unexpected skia surface color type {color_type} -- add it to render_video()'s pix_fmt mapping")

    cmd = [
        settings.ffmpeg_path, "-y",
        "-f", "rawvideo", "-pix_fmt", input_pix_fmt,
        "-s", f"{width}x{height}", "-r", str(fps),
        "-i", "-",
        "-an",
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        # explicit BT.709 tagging -- without it libx264 writes no color
        # metadata at all, leaving a downstream decoder/transcoder to guess
        # the matrix instead of reading it. Harmless and good practice to
        # keep even though the real bug above was the channel order, not this.
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-x264opts", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert proc.stdin is not None

    try:
        for frame_idx in range(timeline.total_frames):
            if should_cancel is not None and should_cancel():
                raise RuntimeError("canceled")
            with surface as canvas:
                canvas.save()
                if scale != 1.0:
                    canvas.scale(scale, scale)
                event.draw_frame(canvas, record, timeline, settings, teams, frame_idx, event_cfg)
                canvas.restore()
            img = surface.makeImageSnapshot()
            # img.tobytes() returns pixels in the surface's own native color
            # type (whatever color_type resolved to above) -- input_pix_fmt
            # was picked to match that exactly, so this is always correct
            # regardless of platform.
            proc.stdin.write(img.tobytes())
            if on_frame is not None:
                on_frame(frame_idx + 1, timeline.total_frames)
    finally:
        proc.stdin.close()
        stderr = proc.stderr.read().decode("utf-8", "ignore") if proc.stderr else ""
        ret = proc.wait()
        if ret != 0:
            raise RuntimeError(f"ffmpeg failed (code {ret}):\n{stderr[-4000:]}")

    return out_path


def extract_cover(video_path: Path, cover_path: Path, at_sec: float, ffmpeg_path: str) -> Path:
    cmd = [ffmpeg_path, "-y", "-ss", str(max(0.0, at_sec)), "-i", str(video_path),
           "-frames:v", "1", "-q:v", "2", str(cover_path)]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return cover_path


def mux_audio(video_only_path: Path, wav_path: Path, final_path: Path, ffmpeg_path: str, target_lufs: float) -> Path:
    cmd = [
        ffmpeg_path, "-y",
        "-i", str(video_only_path), "-i", str(wav_path),
        "-af", f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-map", "0:v:0", "-map", "1:a:0",
        "-shortest",
        str(final_path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return final_path


def append_end_card(video_path: Path, end_card_path: Path, ffmpeg_path: str, fps: int) -> None:
    """Concatenates end_card_path onto the end of video_path, in place --
    held for its own full length (currently 2s), by request, on every
    final render. Uses the `concat` FILTER (decoded frames), not the
    concat demuxer (raw stream copy): the end card is a fixed 30fps clip
    muxed once by scripts/render-endcard.mjs, while the main video can be
    any fps (60 normally), so the two almost never share identical stream
    parameters -- the filter re-encodes and re-times frames to handle
    that, the demuxer would just refuse to join them."""
    if not end_card_path.exists():
        raise FileNotFoundError(f"end card asset missing: {end_card_path}")
    tmp_path = video_path.with_name(video_path.stem + "_endcard" + video_path.suffix)
    cmd = [
        ffmpeg_path, "-y",
        "-i", str(video_path), "-i", str(end_card_path),
        "-filter_complex",
        "[0:v]setsar=1[v0];[1:v]setsar=1[v1];[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][a]",
        "-map", "[v]", "-map", "[a]",
        "-r", str(fps),
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-x264opts", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off",
        "-c:a", "aac", "-b:a", "192k",
        str(tmp_path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    tmp_path.replace(video_path)
