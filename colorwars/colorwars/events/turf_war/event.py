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

    def draw_frame(self, canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int) -> None:
        _draw.draw_frame(canvas, record, timeline, settings, teams, frame_idx)

    def init_render(self, settings: Settings) -> None:
        _draw.init_fonts(settings)

    def sound_voice(self, cue: AudioCue, sample_rate: int):
        return _sound.sound_voice(cue, sample_rate)

    def is_valid(self, record: SimRecord) -> bool:
        return record.winner_team_id is not None and len(record.placements) == 4
