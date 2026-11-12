"""Ties sim/direct/draw/sound together behind the shared Event interface,
same shape as RingOfDoomEvent."""

from __future__ import annotations

from typing import ClassVar

from ...engine.config import Settings, Team
from ...engine.event import Event
from ...engine.records import AudioCue, SimRecord, Timeline
from . import draw as _draw
from . import drama as _drama
from . import sound as _sound
from .direct import direct as _direct
from .sim import simulate as _simulate


class ShellShuffleEvent(Event):
    id: ClassVar[str] = "shell_shuffle"
    display_name: ClassVar[str] = "Shell Shuffle"

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
        return _drama.is_valid(record)

    def drama_stats(self, record: SimRecord, episode: dict) -> dict:
        return _drama.drama_stats(record, episode)
