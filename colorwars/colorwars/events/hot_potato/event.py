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


class HotPotatoEvent(Event):
    id: ClassVar[str] = "hot_potato"
    display_name: ClassVar[str] = "Hot Potato"
    # same reasoning as Ring of Doom: the video ends shortly after the
    # winner card, no 61s floor to hit, so mine()/find-seed must not
    # reject an otherwise-good seed just for being short.
    enforce_duration_window: ClassVar[bool] = False

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
        """A run is only valid if a single team was left by the sim
        deadline -- see config/events/hot_potato.yaml's timing block."""
        if record.winner_team_id is None:
            return False
        last_step = record.steps[-1] if record.steps else None
        if last_step is None:
            return False
        alive_teams = {record.balls[i].team_id for i, b in enumerate(last_step.balls) if b.alive}
        return len(alive_teams) == 1
