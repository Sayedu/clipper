"""Orchestrates the four pipeline stages for any Event, plus find_seed(),
which just tries simulate() (cheap, headless, no rendering) across seeds
until one is valid.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..audio.mix import build_bus, write_wav
from ..render.video import extract_cover, mux_audio, render_video
from .config import Settings, Team, load_episode, load_event_config, load_teams
from .event import Event
from .records import SimRecord, Timeline


def load_common(repo_root: Path, event_id: str) -> tuple[Settings, list[Team], dict, dict]:
    settings = Settings.load(repo_root)
    teams = load_teams(settings.teams_path)
    event_cfg = load_event_config(repo_root, event_id)
    episode = load_episode(settings.episode_path)
    return settings, teams, event_cfg, episode


def find_seed(event: Event, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict,
              start_seed: int = 1, max_tries: int = 500) -> int:
    for seed in range(start_seed, start_seed + max_tries):
        record = event.simulate(seed, settings, event_cfg, teams, episode)
        if event.is_valid(record):
            return seed
    raise RuntimeError(f"no valid seed found in {max_tries} tries starting at {start_seed}")


def run_render(
    event: Event,
    seed: int,
    settings: Settings,
    event_cfg: dict,
    teams: list[Team],
    episode: dict,
    out_dir: Path,
    preview: bool = False,
) -> dict:
    record: SimRecord = event.simulate(seed, settings, event_cfg, teams, episode)
    if not event.is_valid(record):
        raise RuntimeError(
            f"seed {seed} did not produce a valid run (no single survivor by the sim deadline) -- "
            f"use `find-seed` to get one that does."
        )

    fps = settings.preview_fps if preview else settings.fps
    width = settings.preview_width if preview else settings.width
    height = settings.preview_height if preview else settings.height

    timeline: Timeline = event.direct(record, settings, event_cfg, episode, fps)

    out_dir.mkdir(parents=True, exist_ok=True)
    video_only = out_dir / "_video_only.mp4"
    render_video(event, record, timeline, settings, teams, video_only, width, height, fps)

    bus = build_bus(timeline.audio_cues, event.sound_voice, settings.sample_rate, timeline.duration_sec())
    wav_path = out_dir / "_audio.wav"
    write_wav(bus, settings.sample_rate, wav_path)

    final_path = out_dir / "final.mp4"
    mux_audio(video_only, wav_path, final_path, settings.ffmpeg_path, settings.target_lufs)

    cover_path = out_dir / "cover.png"
    cover_sim_t = _best_near_miss_time_in_final_two(record) or timeline.frame_sim_time[timeline.freeze_frame_index or -1]
    cover_frame = _nearest_frame(timeline, cover_sim_t)
    extract_cover(final_path, cover_path, cover_frame / fps, settings.ffmpeg_path)

    video_only.unlink(missing_ok=True)
    wav_path.unlink(missing_ok=True)

    meta = {
        "seed": seed,
        "event": event.id,
        "duration_sec": timeline.duration_sec(),
        "placements": record.placements,
        "mvp": record.mvp_name,
        "winner": record.winner_team_id,
        "stats": {
            "sim_duration_sec": record.sim_duration_sec(),
            "collisions": sum(1 for e in record.events if e.kind == "collision"),
            "eliminations": sum(1 for e in record.events if e.kind == "elimination"),
            "hazards": sum(1 for e in record.events if e.kind == "hazard"),
        },
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def _best_near_miss_time_in_final_two(record: SimRecord):
    misses = [e for e in record.events if e.kind == "near_miss"]
    if not misses:
        return None
    # "in the final two": only misses that happened once <=2 balls were alive
    final_two_misses = []
    for e in misses:
        step_idx = min(len(record.steps) - 1, round(e.t * record.physics_hz))
        alive = sum(1 for b in record.steps[step_idx].balls if b.alive)
        if alive <= 2:
            final_two_misses.append(e)
    pool = final_two_misses or misses
    return max(pool, key=lambda e: e.data.get("peak_r", 0.0)).t


def _nearest_frame(timeline: Timeline, sim_t: float) -> int:
    best_i, best_d = 0, float("inf")
    for i, st in enumerate(timeline.frame_sim_time):
        d = abs(st - sim_t)
        if d < best_d:
            best_d, best_i = d, i
    return best_i
