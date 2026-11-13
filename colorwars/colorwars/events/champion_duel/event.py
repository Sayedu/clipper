"""Ties sim/direct/draw/sound together behind the shared Event interface."""

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


class ChampionDuelEvent(Event):
    id: ClassVar[str] = "champion_duel"
    display_name: ClassVar[str] = "Champion Duel"

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
            ParamSpec(name="champion.hp", label="HP", type="int", default=event_cfg["champion"]["hp"],
                      min=30, max=300, step=5, group="Setup"),
            ParamSpec(name="champion.base_speed", label="Movement speed", type="float",
                      default=event_cfg["champion"]["base_speed"], min=60, max=400, group="Setup"),
            ParamSpec(name="champion.contact_damage", label="Contact damage", type="float",
                      default=event_cfg["champion"]["contact_damage"], min=1, max=20, group="Setup"),
            ParamSpec(name="replay.big_hit_threshold", label="Big-hit slow-mo threshold", type="float",
                      default=event_cfg["replay"]["big_hit_threshold"], min=3, max=30, group="Slow motion",
                      help="A hit at or above this damage triggers slow motion."),
            ParamSpec(name="replay.slowmo_speed", label="Big-hit slow-mo speed", type="float",
                      default=event_cfg["replay"]["slowmo_speed"], min=0.1, max=1.0, step=0.05, group="Slow motion"),
            ParamSpec(name="replay.final_replay_sec", label="Finishing-blow replay length", type="float",
                      default=event_cfg["replay"]["final_replay_sec"], min=0.5, max=6.0, group="Slow motion"),
        ]
        if teams:
            curated += team_trait_params({t.id: t.traits for t in teams}, ["duel_power"], group="Signature power")
        return dedupe_by_name(curated + super().params_schema(event_cfg))
