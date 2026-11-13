"""Ties sim/direct/draw/sound together behind the shared Event interface,
same shape as the other two events."""

from __future__ import annotations

from typing import ClassVar

from ...engine.config import Settings, Team
from ...engine.event import Event
from ...engine.params import ParamSpec, dedupe_by_name, team_trait_params
from ...engine.records import AudioCue, SimRecord, Timeline
from . import draw as _draw
from . import drama as _drama
from . import sound as _sound
from .direct import direct as _direct
from .sim import simulate as _simulate


class DisasterDropEvent(Event):
    id: ClassVar[str] = "disaster_drop"
    display_name: ClassVar[str] = "Disaster Drop"

    def simulate(self, seed: int, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
        return _simulate(seed, settings, event_cfg, teams, episode)

    def direct(self, record: SimRecord, settings: Settings, event_cfg: dict, episode: dict, fps: int) -> Timeline:
        return _direct(record, settings, event_cfg, episode, fps)

    def draw_frame(self, canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int, event_cfg: dict) -> None:
        _draw.draw_frame(canvas, record, timeline, settings, teams, frame_idx, event_cfg)

    def init_render(self, settings: Settings) -> None:
        _draw.init_fonts(settings)

    def sound_voice(self, cue: AudioCue, sample_rate: int):
        return _sound.sound_voice(cue, sample_rate)

    def is_valid(self, record: SimRecord) -> bool:
        return _drama.is_valid(record)

    def drama_stats(self, record: SimRecord, episode: dict) -> dict:
        return _drama.drama_stats(record, episode)

    def params_schema(self, event_cfg: dict, teams: list[Team] | None = None) -> list[ParamSpec]:
        curated = [
            ParamSpec(name="balls.per_team", label="Balls per team", type="int",
                      default=event_cfg["balls"]["per_team"], min=1, max=5, step=1, group="Setup"),
            ParamSpec(name="course.modules_min", label="Course modules (min)", type="int",
                      default=event_cfg["course"]["modules_min"], min=4, max=12, step=1, group="Course",
                      help="Fewer/shorter modules make for a shorter raw race (this is the duration knob)."),
            ParamSpec(name="course.modules_max", label="Course modules (max)", type="int",
                      default=event_cfg["course"]["modules_max"], min=4, max=14, step=1, group="Course"),
            ParamSpec(name="crusher.start_speed", label="Crusher starting speed", type="float",
                      default=event_cfg["crusher"]["start_speed"], min=20, max=300, group="Crusher"),
            ParamSpec(name="crusher.accel", label="Crusher acceleration", type="float",
                      default=event_cfg["crusher"]["accel"], min=0.2, max=10, group="Crusher"),
            ParamSpec(name="disasters.interval_min_sec", label="Disaster frequency (min sec)", type="float",
                      default=event_cfg["disasters"]["interval_min_sec"], min=2, max=20, group="Disasters"),
            ParamSpec(name="disasters.interval_max_sec", label="Disaster frequency (max sec)", type="float",
                      default=event_cfg["disasters"]["interval_max_sec"], min=2, max=30, group="Disasters"),
            ParamSpec(name="camera.zoom_min", label="Camera zoom-out limit", type="float",
                      default=event_cfg["camera"]["zoom_min"], min=0.3, max=1.0, step=0.05, group="Camera"),
        ]
        if teams:
            curated += team_trait_params(
                {t.id: t.traits for t in teams},
                ["mass_mult", "elasticity_add", "radius_mult", "burst_impulse"],
            )
        return dedupe_by_name(curated + super().params_schema(event_cfg))
