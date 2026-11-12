"""Ties sim/direct/draw/sound together behind the shared Event interface."""

from __future__ import annotations

from typing import ClassVar

from ...engine.config import Settings, Team
from ...engine.event import Event
from ...engine.records import AudioCue, SimRecord, Timeline
from . import draw as _draw
from . import sound as _sound
from .direct import direct as _direct
from .sim import simulate as _simulate


class RingOfDoomEvent(Event):
    id: ClassVar[str] = "ring_of_doom"
    display_name: ClassVar[str] = "Ring of Doom"

    def simulate(self, seed: int, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
        # last_place_team_id travels through the generic `episode` dict
        # (set by league.pipeline's auto-built episode) rather than widening
        # the shared Event interface for one event's own mechanic.
        last_place = episode.get("last_place_team_id")
        return _simulate(seed, settings, event_cfg, teams, episode, last_place_team_id=last_place)

    def direct(self, record: SimRecord, settings: Settings, event_cfg: dict, episode: dict, fps: int) -> Timeline:
        return _direct(record, settings, event_cfg, episode, fps)

    def draw_frame(self, canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int) -> None:
        _draw.draw_frame(canvas, record, timeline, settings, teams, frame_idx)

    def init_render(self, settings: Settings) -> None:
        _draw.init_fonts(settings)

    def sound_voice(self, cue: AudioCue, sample_rate: int):
        return _sound.sound_voice(cue, sample_rate)

    def is_valid(self, record: SimRecord) -> bool:
        """A run is only valid if a single ball was left by the sim
        deadline -- see config/events/ring_of_doom.yaml's timing block."""
        if record.winner_team_id is None:
            return False
        last_step = record.steps[-1] if record.steps else None
        if last_step is None:
            return False
        return sum(1 for b in last_step.balls if b.alive) == 1
