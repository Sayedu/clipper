"""Ties sim/direct/draw/sound together behind the shared Event interface.
No custom drama.py -- "alive" here means "hasn't escaped yet", which lines
up with Event.drama_stats()'s default (engine.drama.analyze_drama) well
enough to use as-is (lead_change is real; near_miss/wipeout never fire,
which analyze_drama handles as zero contributions, not an error).
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


class GreatEscapeEvent(Event):
    id: ClassVar[str] = "great_escape"
    display_name: ClassVar[str] = "Great Escape"

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
            ParamSpec(name="physics.gravity", label="Gravity", type="float",
                      default=event_cfg["physics"]["gravity"], min=200, max=1500, group="Setup"),
            ParamSpec(name="rings.gap_deg", label="Ring gap width (deg)", type="float",
                      default=event_cfg["rings"]["gap_deg"], min=10, max=60, group="Rings"),
            ParamSpec(name="rings.speed_min", label="Ring rotation speed (min)", type="float",
                      default=event_cfg["rings"]["speed_min"], min=0.1, max=2.0, step=0.05, group="Rings"),
            ParamSpec(name="rings.speed_max", label="Ring rotation speed (max)", type="float",
                      default=event_cfg["rings"]["speed_max"], min=0.1, max=3.0, step=0.05, group="Rings"),
            ParamSpec(name="replay.win_slowmo_speed", label="Winning-escape slow-mo speed", type="float",
                      default=event_cfg["replay"]["win_slowmo_speed"], min=0.1, max=1.0, step=0.05,
                      group="Slow motion", help="Lower = slower. 1.0 = no slowdown."),
        ]
        return dedupe_by_name(curated + super().params_schema(event_cfg))
