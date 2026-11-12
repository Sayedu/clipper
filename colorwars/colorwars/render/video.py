"""The shared, event-agnostic renderer: ask the event to draw each frame
onto a skia canvas, pipe raw RGBA bytes straight into ffmpeg's stdin
(libx264, yuv420p, crf 18, preset veryfast). No frame ever touches disk.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

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
    out_path: Path,
    width: int,
    height: int,
    fps: int,
) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if hasattr(event, "init_render"):
        event.init_render(settings)

    surface = skia.Surface(width, height)
    scale = width / settings.width  # 1.0 for a full render, <1 for --preview

    cmd = [
        settings.ffmpeg_path, "-y",
        "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{width}x{height}", "-r", str(fps),
        "-i", "-",
        "-an",
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert proc.stdin is not None

    try:
        for frame_idx in range(timeline.total_frames):
            with surface as canvas:
                canvas.save()
                if scale != 1.0:
                    canvas.scale(scale, scale)
                event.draw_frame(canvas, record, timeline, settings, teams, frame_idx)
                canvas.restore()
            img = surface.makeImageSnapshot()
            # skia.Surface's native snapshot format is already RGBA_8888, matching
            # the -pix_fmt rgba ffmpeg is told to expect below -- confirmed directly
            # (img.colorType() == kRGBA_8888_ColorType) rather than assumed.
            proc.stdin.write(img.tobytes())
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
