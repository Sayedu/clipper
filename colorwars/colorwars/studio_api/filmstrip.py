"""6 real still frames spread across a run, rendered directly with skia --
no ffmpeg pipe, no audio, so this stays fast enough to call synchronously
from an API route (the Studio's own safe-area review step, scripted, uses
the equivalent ffmpeg-based seek -- this is the same idea without needing
a finished video file first).
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import skia

from ..engine.config import Settings
from ..engine.registry import get_event
from .engine_helpers import apply_overrides, build_episode, names_path_for


def render_filmstrip(event_id: str, seed: int, overrides: dict, episode_overrides: dict | None,
                      finale: bool, scratch_dir: Path, count: int = 6) -> dict:
    settings, teams, event_cfg = apply_overrides(event_id, overrides)
    episode, settings = build_episode(event_id, episode_overrides, finale, settings)
    names_path = names_path_for(settings, episode_overrides, scratch_dir)
    if names_path != settings.names_path:
        settings = dataclasses.replace(settings, names_path=names_path)

    event = get_event(event_id)
    record = event.simulate(seed, settings, event_cfg, teams, episode)
    if not event.is_valid(record):
        return {"valid": False, "frames": []}

    timeline = event.direct(record, settings, event_cfg, episode, settings.preview_fps)
    event.init_render(settings) if hasattr(event, "init_render") else None

    total = timeline.total_frames
    if count <= 1 or total <= 1:
        idxs = [0]
    else:
        idxs = [round(i * (total - 1) / (count - 1)) for i in range(count)]

    surface = skia.Surface(settings.preview_width, settings.preview_height)
    frames: list[bytes] = []
    for idx in idxs:
        with surface as canvas:
            event.draw_frame(canvas, record, timeline, settings, teams, idx, event_cfg)
        img = surface.makeImageSnapshot()
        frames.append(bytes(img.encodeToData()))

    return {"valid": True, "frames": frames, "frame_indices": idxs, "total_frames": total}
