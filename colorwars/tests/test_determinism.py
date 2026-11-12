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
from colorwars.events.shell_shuffle.event import ShellShuffleEvent

KNOWN_VALID_SEED = 2
SHELL_SHUFFLE_SEED = 1  # every seed is valid by construction (scripted, not simulated-to-failure); 1 is just stable to pin


def _load(event_id: str = "ring_of_doom"):
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    cfg = load_event_config(REPO_ROOT, event_id)
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


def test_shell_shuffle_simulate_is_deterministic():
    settings, teams, cfg, episode = _load("shell_shuffle")
    event = ShellShuffleEvent()

    r1 = event.simulate(SHELL_SHUFFLE_SEED, settings, cfg, teams, episode)
    r2 = event.simulate(SHELL_SHUFFLE_SEED, settings, cfg, teams, episode)

    assert len(r1.steps) == len(r2.steps)
    assert r1.placements == r2.placements
    assert r1.winner_team_id == r2.winner_team_id
    assert r1.mvp_name == r2.mvp_name
    assert len(r1.events) == len(r2.events)
    for s1, s2 in zip(r1.steps, r2.steps):
        for b1, b2 in zip(s1.balls, s2.balls):
            assert b1.x == b2.x and b1.y == b2.y and b1.angle == b2.angle and b1.vy == b2.vy


def test_shell_shuffle_render_three_seconds_twice_matches_by_hash():
    settings, teams, cfg, episode = _load("shell_shuffle")
    event = ShellShuffleEvent()

    record = event.simulate(SHELL_SHUFFLE_SEED, settings, cfg, teams, episode)
    assert event.is_valid(record)
    timeline = event.direct(record, settings, cfg, episode, settings.preview_fps)

    n_frames = min(settings.preview_fps * 3, timeline.total_frames)

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


def test_shell_shuffle_rejects_a_cup_that_never_moves_in_round3():
    """is_valid() must actually be checked, not assumed true -- fabricate a
    record where one cup's round-3 steps never move and confirm it's
    rejected, mirroring the mining brief's hard constraint."""
    from colorwars.engine.records import BallInfo, BallState, SimEvent, SimRecord, StepRecord
    from colorwars.events.shell_shuffle.drama import is_valid as shuffle_is_valid

    balls = [BallInfo(id=i, team_id=f"t{i}", team_name=f"T{i}", name=f"n{i}", base_radius=95.0) for i in range(4)]
    steps = []
    for k in range(10):
        t = 10.0 + k * 0.1  # inside the round-3 window below
        states = [BallState(x=100.0 + (i * 50 if i != 0 else 0) + (k if i != 0 else 0),
                             y=900.0, angle=1.0, vx=0.0, vy=0.0, alive=False) for i in range(4)]
        steps.append(StepRecord(t=t, ring_angle=0.0, gaps_deg=(), balls=states))
    events = [
        SimEvent(0, 10.0, "round_start", {"round": 3}),
        SimEvent(len(steps) - 1, steps[-1].t, "round_end", {"round": 3}),
    ]
    record = SimRecord(seed=1, event_id="shell_shuffle", physics_hz=60, steps=steps, events=events,
                        balls=balls, teams=[], winner_team_id="t0", placements=["t0", "t1", "t2", "t3"],
                        mvp_name="n0", duration_steps=len(steps))

    assert shuffle_is_valid(record) is False
