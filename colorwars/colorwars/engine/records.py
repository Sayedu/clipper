"""The data that flows between the four pipeline stages. simulate() produces
a SimRecord; direct() reads it and produces a Timeline; render() and
mix_audio() read both and never touch each other's output directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class BallInfo:
    """Static per-ball metadata, fixed for the whole run."""

    id: int
    team_id: str
    team_name: str
    name: str
    base_radius: float


@dataclass
class BallState:
    """One ball's state at one physics step."""

    x: float
    y: float
    angle: float
    vx: float
    vy: float
    alive: bool


@dataclass
class StepRecord:
    """One physics step (at the fixed physics rate, not the video rate)."""

    t: float  # sim seconds since start
    ring_angle: float
    gaps_deg: tuple[tuple[float, float], ...]  # (center_deg, half_width_deg) per active gap
    balls: list[BallState]


@dataclass
class SimEvent:
    """A discrete, timestamped thing that happened during the sim --
    collisions, eliminations, hazards, near misses, lead changes, warnings."""

    step: int
    t: float
    kind: str
    data: dict = field(default_factory=dict)


@dataclass
class SimRecord:
    seed: int
    event_id: str
    physics_hz: int
    steps: list[StepRecord]
    events: list[SimEvent]
    balls: list[BallInfo]
    teams: list  # list[Team] (engine.config.Team) -- kept generic to avoid a circular import
    winner_team_id: str | None
    placements: list[str]  # team ids, winner first
    mvp_name: str
    duration_steps: int

    def sim_duration_sec(self) -> float:
        return self.duration_steps / self.physics_hz


@dataclass
class OverlayCue:
    start_frame: int
    end_frame: int
    kind: str
    data: dict = field(default_factory=dict)


@dataclass
class AudioCue:
    video_time: float  # seconds into the FINAL video's own timeline
    kind: str
    data: dict = field(default_factory=dict)


@dataclass
class Timeline:
    """The edit. Video time maps to sim time through `frame_sim_time` --
    slow motion is just sampling the same recorded sim more densely over a
    stretch of extra video frames; nothing is ever re-simulated."""

    fps: int
    total_frames: int
    frame_sim_time: list[float]  # len == total_frames; sim seconds to sample for frame i
    frame_speed: list[float]  # len == total_frames; the slow-mo multiplier active at frame i
    frame_zoom: list[float]  # len == total_frames; camera zoom (1.0 = no zoom)
    overlays: list[OverlayCue]
    audio_cues: list[AudioCue]
    cover_frame_index: int
    freeze_frame_index: int | None

    def duration_sec(self) -> float:
        return self.total_frames / self.fps
