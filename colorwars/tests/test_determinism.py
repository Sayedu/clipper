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
from colorwars.events.disaster_drop.event import DisasterDropEvent
from colorwars.events.ring_of_doom.event import RingOfDoomEvent
from colorwars.events.shell_shuffle.event import ShellShuffleEvent
from colorwars.events.champion_duel.event import ChampionDuelEvent
from colorwars.events.great_escape.event import GreatEscapeEvent
from colorwars.events.turf_war.event import TurfWarEvent

KNOWN_VALID_SEED = 2
SHELL_SHUFFLE_SEED = 1  # every seed is valid by construction (scripted, not simulated-to-failure); 1 is just stable to pin
DISASTER_DROP_SEED = 1  # checked once via `find-seed --event disaster_drop`
TURF_WAR_SEED = 1  # checked once via `find-seed --event turf_war`
GREAT_ESCAPE_SEED = 1  # checked once via `find-seed --event great_escape`
CHAMPION_DUEL_SEED = 1  # checked once via `find-seed --event champion_duel`


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


def test_disaster_drop_simulate_is_deterministic():
    settings, teams, cfg, episode = _load("disaster_drop")
    event = DisasterDropEvent()

    r1 = event.simulate(DISASTER_DROP_SEED, settings, cfg, teams, episode)
    r2 = event.simulate(DISASTER_DROP_SEED, settings, cfg, teams, episode)

    assert len(r1.steps) == len(r2.steps)
    assert r1.placements == r2.placements
    assert r1.winner_team_id == r2.winner_team_id
    assert r1.mvp_name == r2.mvp_name
    assert len(r1.events) == len(r2.events)
    for s1, s2 in zip(r1.steps, r2.steps):
        for b1, b2 in zip(s1.balls, s2.balls):
            assert b1.x == b2.x and b1.y == b2.y and b1.vx == b2.vx and b1.vy == b2.vy and b1.alive == b2.alive


def test_disaster_drop_render_three_seconds_twice_matches_by_hash():
    settings, teams, cfg, episode = _load("disaster_drop")
    event = DisasterDropEvent()

    record = event.simulate(DISASTER_DROP_SEED, settings, cfg, teams, episode)
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


def test_disaster_drop_rejects_a_race_nobody_finishes():
    """is_valid() must require a real finisher, not just "someone had the
    best progress when the crusher wiped everyone" -- a rendered frame
    showed this directly (the "winner"'s own ball had the same X-eyes
    elimination mark as everything the crusher actually hit)."""
    from colorwars.engine.records import BallInfo, SimEvent, SimRecord
    from colorwars.events.disaster_drop.drama import is_valid as drop_is_valid

    balls = [BallInfo(id=i, team_id=t, team_name=t.title(), name=f"n{i}", base_radius=19.0)
             for i, t in enumerate(["red", "blue", "green", "yellow"])]
    events = [SimEvent(0, 10.0, "elimination", {"ball_id": i, "team_id": t, "cause": "crusher"})
              for i, t in enumerate(["red", "blue", "green", "yellow"])]
    record = SimRecord(seed=1, event_id="disaster_drop", physics_hz=240, steps=[], events=events,
                        balls=balls, teams=[], winner_team_id="blue",
                        placements=["blue", "red", "green", "yellow"], mvp_name="n1", duration_steps=0)

    assert drop_is_valid(record) is False


def test_turf_war_simulate_is_deterministic():
    settings, teams, cfg, episode = _load("turf_war")
    event = TurfWarEvent()

    r1 = event.simulate(TURF_WAR_SEED, settings, cfg, teams, episode)
    r2 = event.simulate(TURF_WAR_SEED, settings, cfg, teams, episode)

    assert len(r1.steps) == len(r2.steps)
    assert r1.placements == r2.placements
    assert r1.winner_team_id == r2.winner_team_id
    assert r1.mvp_name == r2.mvp_name
    assert len(r1.events) == len(r2.events)
    for s1, s2 in zip(r1.steps, r2.steps):
        for b1, b2 in zip(s1.balls, s2.balls):
            assert b1.x == b2.x and b1.y == b2.y and b1.vx == b2.vx and b1.vy == b2.vy and b1.alive == b2.alive


def test_turf_war_render_three_seconds_twice_matches_by_hash():
    settings, teams, cfg, episode = _load("turf_war")
    event = TurfWarEvent()

    record = event.simulate(TURF_WAR_SEED, settings, cfg, teams, episode)
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


def test_turf_war_initial_grid_is_fixed_quadrants():
    from colorwars.events.turf_war.sim import initial_grid

    team_ids = ["red", "blue", "green", "yellow"]
    grid = initial_grid(28, team_ids)
    assert grid[0][0] == "red"
    assert grid[0][27] == "blue"
    assert grid[27][0] == "green"
    assert grid[27][27] == "yellow"
    counts = {tid: 0 for tid in team_ids}
    for row in grid:
        for owner in row:
            counts[owner] += 1
    assert all(c == 196 for c in counts.values())


def test_great_escape_simulate_is_deterministic():
    settings, teams, cfg, episode = _load("great_escape")
    event = GreatEscapeEvent()

    r1 = event.simulate(GREAT_ESCAPE_SEED, settings, cfg, teams, episode)
    r2 = event.simulate(GREAT_ESCAPE_SEED, settings, cfg, teams, episode)

    assert len(r1.steps) == len(r2.steps)
    assert r1.placements == r2.placements
    assert r1.winner_team_id == r2.winner_team_id
    assert r1.mvp_name == r2.mvp_name
    assert len(r1.events) == len(r2.events)
    for s1, s2 in zip(r1.steps, r2.steps):
        for b1, b2 in zip(s1.balls, s2.balls):
            assert b1.x == b2.x and b1.y == b2.y and b1.vx == b2.vx and b1.vy == b2.vy and b1.alive == b2.alive


def test_great_escape_render_three_seconds_twice_matches_by_hash():
    settings, teams, cfg, episode = _load("great_escape")
    event = GreatEscapeEvent()

    record = event.simulate(GREAT_ESCAPE_SEED, settings, cfg, teams, episode)
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


def test_great_escape_all_rings_eventually_shatter():
    """A rotating gap sweeps through every world angle once per rotation,
    so no ball should ever be permanently trapped -- verified directly
    rather than assumed, since this is the one property the whole event's
    design leans on instead of an explicit anti-trap reject."""
    settings, teams, cfg, episode = _load("great_escape")
    event = GreatEscapeEvent()
    record = event.simulate(GREAT_ESCAPE_SEED, settings, cfg, teams, episode)
    shatters = [e for e in record.events if e.kind == "ring_shatter"]
    escapes = [e for e in record.events if e.kind == "escape"]
    assert len(shatters) == 6
    assert len(escapes) == 4


def test_champion_duel_simulate_is_deterministic():
    settings, teams, cfg, episode = _load("champion_duel")
    event = ChampionDuelEvent()

    r1 = event.simulate(CHAMPION_DUEL_SEED, settings, cfg, teams, episode)
    r2 = event.simulate(CHAMPION_DUEL_SEED, settings, cfg, teams, episode)

    assert len(r1.steps) == len(r2.steps)
    assert r1.placements == r2.placements
    assert r1.winner_team_id == r2.winner_team_id
    assert r1.mvp_name == r2.mvp_name
    assert len(r1.events) == len(r2.events)
    for s1, s2 in zip(r1.steps, r2.steps):
        for b1, b2 in zip(s1.balls, s2.balls):
            assert b1.x == b2.x and b1.y == b2.y and b1.vx == b2.vx and b1.alive == b2.alive


def test_champion_duel_render_three_seconds_twice_matches_by_hash():
    settings, teams, cfg, episode = _load("champion_duel")
    event = ChampionDuelEvent()

    record = event.simulate(CHAMPION_DUEL_SEED, settings, cfg, teams, episode)
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


def test_champion_duel_replay_reaches_the_actual_finishing_instant():
    """Found directly: the sim stops the instant a champion's HP hits
    zero, so a replay window centered on the finishing hit and clamped to
    sim_total got cut short and never actually showed HP reaching zero.
    Checked here instead of just trusting the fix."""
    settings, teams, cfg, episode = _load("champion_duel")
    event = ChampionDuelEvent()
    record = event.simulate(CHAMPION_DUEL_SEED, settings, cfg, teams, episode)
    timeline = event.direct(record, settings, cfg, episode, settings.preview_fps)
    replay = next((o for o in timeline.overlays if o.kind == "replay"), None)
    assert replay is not None
    last_sim_t = timeline.frame_sim_time[replay.end_frame - 1]
    assert abs(last_sim_t - record.sim_duration_sec()) < 1e-6
    loser_idx = next(i for i, b in enumerate(record.balls[:2]) if b.team_id != record.winner_team_id)
    idx = round(last_sim_t * record.physics_hz)
    assert record.steps[min(idx, len(record.steps) - 1)].balls[loser_idx].vx <= 0.0
