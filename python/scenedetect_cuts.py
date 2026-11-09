"""Detect hard cuts / scene changes in a video with PySceneDetect.

Usage:
  python scenedetect_cuts.py --video SOURCE.mp4 --out cuts.json [--threshold 27]

Result: {"cuts": [sec, ...], "durationSec": float}
  `cuts` are scene *boundary* timestamps so clip edges can be snapped to real edits.
"""

from __future__ import annotations

import argparse

from common import emit_result, log, main, progress


def _seconds(tc) -> float:
    try:
        return float(tc.get_seconds())
    except Exception:  # noqa: BLE001
        try:
            return float(tc.seconds)
        except Exception:  # noqa: BLE001
            return float(tc)


def detect_cuts() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out")
    ap.add_argument("--threshold", type=float, default=27.0)
    ap.add_argument("--min-scene-sec", type=float, default=0.6)
    args = ap.parse_args()

    from scenedetect import ContentDetector, SceneManager, open_video

    progress(0.05, "opening video")
    try:
        video = open_video(args.video, backend="opencv")
    except Exception:  # noqa: BLE001 — fall back to whatever backend is available
        video = open_video(args.video)

    fps = float(video.frame_rate or 30.0)
    duration = _seconds(video.duration) if video.duration else 0.0

    sm = SceneManager()
    sm.add_detector(
        ContentDetector(threshold=args.threshold, min_scene_len=max(int(args.min_scene_sec * fps), 1))
    )

    progress(0.15, "scanning for cuts")
    sm.detect_scenes(video, show_progress=False)
    scenes = sm.get_scene_list()

    cuts: list[float] = [0.0]
    for start, end in scenes:
        cuts.append(round(_seconds(start), 3))
        cuts.append(round(_seconds(end), 3))
    if duration:
        cuts.append(round(duration, 3))

    hi = (duration or (cuts[-1] if cuts else 0.0)) + 0.001
    uniq = sorted({c for c in cuts if 0.0 <= c <= hi})
    log(f"{len(scenes)} scenes → {len(uniq)} unique boundaries over {duration:.1f}s")
    progress(1.0, f"{len(scenes)} scenes")
    emit_result({"cuts": uniq, "durationSec": round(duration, 3)}, args.out)


if __name__ == "__main__":
    main(detect_cuts)
