"""Ties sim/direct/draw/sound together behind the shared Event interface,
same shape as RingOfDoomEvent."""

from __future__ import annotations

from typing import ClassVar

from ...engine.config import Settings, Team
from ...engine.event import Event
from ...engine.params import ParamSpec, dedupe_by_name
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
        # "rounds" is a list, not a dict -- the generic walker only handles
        # dicts/scalars, so round swap counts need curating explicitly or
        # they wouldn't be exposed at all.
        rounds = event_cfg["rounds"]
        curated = [
            ParamSpec(name=f"rounds.{i}.swaps", label=f"Round {i + 1} swap count", type="int",
                      default=r["swaps"], min=4, max=40, step=1, group="Rounds")
            for i, r in enumerate(rounds)
        ] + [
            ParamSpec(name=f"rounds.{i}.swap_sec", label=f"Round {i + 1} swap speed (sec)", type="float",
                      default=r["swap_sec"], min=0.2, max=2.5, step=0.05, group="Rounds")
            for i, r in enumerate(rounds)
        ] + [
            ParamSpec(name="podium.freeze_sec", label="Freeze length before reveal", type="float",
                      default=event_cfg["podium"]["freeze_sec"], min=1.0, max=6.0, group="Reveal"),
            ParamSpec(name="reveal_sequence.hold_sec", label="Per-cup reveal hold (sec)", type="float",
                      default=event_cfg["reveal_sequence"]["hold_sec"], min=0.2, max=2.0, group="Reveal"),
        ]
        return dedupe_by_name(curated + super().params_schema(event_cfg))
