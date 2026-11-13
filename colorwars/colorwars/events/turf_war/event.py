"""Ties sim/direct/draw/sound together behind the shared Event interface.
No custom drama.py -- this event's "alive" flag (a team is alive until its
cell count hits zero) lines up with Event.drama_stats()'s default
(engine.drama.analyze_drama) well enough to use as-is, and there's no
course/choreography validity concept to check beyond "did it produce a
real winner."
"""

from __future__ import annotations

from typing import ClassVar

from ...engine.config import Settings, Team
from ...engine.event import Event
from ...engine.params import ParamSpec, dedupe_by_name
from ...engine.records import AudioCue, SimRecord, Timeline
from . import draw as _draw
from . import sound as _sound
from .direct import direct as _direct
from .sim import simulate as _simulate


class TurfWarEvent(Event):
    id: ClassVar[str] = "turf_war"
    display_name: ClassVar[str] = "Turf War"

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
        return record.winner_team_id is not None and len(record.placements) == 4

    def params_schema(self, event_cfg: dict, teams: list[Team] | None = None) -> list[ParamSpec]:
        curated = [
            ParamSpec(name="ball.speed", label="Ball speed", type="float", default=event_cfg["ball"]["speed"],
                      min=80, max=600, group="Setup"),
            ParamSpec(name="powerups.interval_sec", label="Power-up frequency (sec)", type="float",
                      default=event_cfg["powerups"]["interval_sec"], min=3, max=20, group="Power-ups",
                      help="How often a new bomb/ghost/speed power-up appears on the grid."),
            ParamSpec(name="powerups.speed_mult", label="Speed power-up multiplier", type="float",
                      default=event_cfg["powerups"]["speed_mult"], min=1.0, max=3.0, step=0.1, group="Power-ups"),
            ParamSpec(name="powerups.speed_duration_sec", label="Speed power-up duration", type="float",
                      default=event_cfg["powerups"]["speed_duration_sec"], min=1, max=10, group="Power-ups"),
            ParamSpec(name="timing.sim_deadline_sec", label="Match length (sim sec)", type="float",
                      default=event_cfg["timing"]["sim_deadline_sec"], min=20, max=90, group="Setup"),
        ]
        return dedupe_by_name(curated + super().params_schema(event_cfg))
