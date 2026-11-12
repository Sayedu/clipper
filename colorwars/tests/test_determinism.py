"""The determinism contract, checked two ways:

1. simulate() itself: the same seed produces byte-identical physics state
   across an independent run, for the whole sim.
2. The renderer: given a fixed SimRecord + Timeline, rendering the first 3
   seconds of frames twice (two independent skia Surfaces, two independent
   draw_frame passes) produces pixel-identical frames, hashed.

Seed 2 is used throughout because it's already known to produce a valid
Ring of Doom run (checked once via `find-seed`) -- the test isn't re-running
find-seed itself, just re-verifying determinism on a run already known to
finish.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import skia

from colorwars.engine.config import REPO_ROOT, Settings, load_episode, load_event_config, load_teams
from colorwars.events.ring_of_doom.event import RingOfDoomEvent

KNOWN_VALID_SEED = 2


def _load():
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    cfg = load_event_config(REPO_ROOT, "ring_of_doom")
    episode = load_episode(settings.episode_path)
    return settings, teams, cfg, episode


def test_simulate_is_deterministic():
    settings, teams, cfg, episode = _load()
    event = RingOfDoomEvent()

    r1 = event.simulate(KNOWN_VALID_SEED, settings, cfg, teams, episode)
    r2 = event.simulate(KNOWN_VALID_SEED, settings, cfg, teams, episode)

    assert len(r1.steps) == len(r2.steps)
    assert r1.winner_team_id == r2.winner_team_id
    assert r1.mvp_name == r2.mvp_name
    assert len(r1.events) == len(r2.events)
    for s1, s2 in zip(r1.steps, r2.steps):
        for b1, b2 in zip(s1.balls, s2.balls):
            assert b1.x == b2.x and b1.y == b2.y and b1.vx == b2.vx and b1.vy == b2.vy and b1.alive == b2.alive


def test_render_three_seconds_twice_matches_by_hash():
    settings, teams, cfg, episode = _load()
    event = RingOfDoomEvent()

    record = event.simulate(KNOWN_VALID_SEED, settings, cfg, teams, episode)
    assert event.is_valid(record)
    timeline = event.direct(record, settings, cfg, episode, settings.preview_fps)

    n_frames = settings.preview_fps * 3  # "3 seconds" of frames
    n_frames = min(n_frames, timeline.total_frames)

    def render_hashes() -> list[str]:
        event.init_render(settings)
        surface = skia.Surface(settings.preview_width, settings.preview_height)
        hashes = []
        for frame_idx in range(n_frames):
            with surface as canvas:
                event.draw_frame(canvas, record, timeline, settings, teams, frame_idx)
            img = surface.makeImageSnapshot()
            hashes.append(hashlib.sha256(img.tobytes()).hexdigest())
        return hashes

    hashes_a = render_hashes()
    hashes_b = render_hashes()

    assert len(hashes_a) == n_frames
    assert hashes_a == hashes_b
