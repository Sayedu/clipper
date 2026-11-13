"""Ties sim/direct/draw/sound together behind the shared Event interface."""

from __future__ import annotations

from typing import ClassVar

from ...engine.config import Settings, Team
from ...engine.event import Event
from ...engine.params import ParamSpec, dedupe_by_name, team_trait_params
from ...engine.records import AudioCue, SimRecord, Timeline
from . import draw as _draw
from . import sound as _sound
from .direct import direct as _direct
from .sim import simulate as _simulate


class RingOfDoomEvent(Event):
    id: ClassVar[str] = "ring_of_doom"
    display_name: ClassVar[str] = "Ring of Doom"
    # the video ends ~1.5s after the winner card now instead of being
    # padded to a 61s floor (see direct.py) -- mine()/find-seed must not
    # reject an otherwise-valid seed just for being short.
    enforce_duration_window: ClassVar[bool] = False

    def simulate(self, seed: int, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
        # last_place_team_id travels through the generic `episode` dict
        # (set by league.pipeline's auto-built episode) rather than widening
        # the shared Event interface for one event's own mechanic.
        last_place = episode.get("last_place_team_id")
        return _simulate(seed, settings, event_cfg, teams, episode, last_place_team_id=last_place)

    def direct(self, record: SimRecord, settings: Settings, event_cfg: dict, episode: dict, fps: int) -> Timeline:
        return _direct(record, settings, event_cfg, episode, fps)

    def draw_frame(self, canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int, event_cfg: dict) -> None:
        _draw.draw_frame(canvas, record, timeline, settings, teams, frame_idx, event_cfg)

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

    def params_schema(self, event_cfg: dict, teams: list[Team] | None = None) -> list[ParamSpec]:
        curated = [
            ParamSpec(name="balls.per_team", label="Balls per team", type="int",
                      default=event_cfg["balls"]["per_team"], min=1, max=8, step=1, group="Setup",
                      help="How many balls each of the 4 teams starts with (16 total at the default 4)."),
            ParamSpec(name="gravity", label="Gravity", type="float", default=event_cfg["gravity"],
                      min=300, max=2000, group="Setup"),
            # Curated for the same reason as ring.radius/elimination_radius
            # below: this is the one real stopping condition simulate() has
            # (sim.py reads it directly, independent of the video's own
            # duration window) -- the generic heuristic range would let
            # Randomize push it down near 0, leaving no time for the field
            # to ever narrow to a single survivor, for any seed.
            ParamSpec(name="timing.sim_deadline_sec", label="Sim time limit (sec)", type="float",
                      default=event_cfg["timing"]["sim_deadline_sec"], min=45, max=120, group="Setup",
                      help="How much raw simulated time the ring gets to produce a winner before the "
                           "seed is thrown out as invalid."),
            ParamSpec(name="ring.rotation_speed", label="Ring rotation speed", type="float",
                      default=event_cfg["ring"]["rotation_speed"], min=0.1, max=2.0, group="Ring",
                      help="Radians/sec the ring spins at the start of the episode."),
            ParamSpec(name="gaps.interval_sec", label="Gap-widening interval", type="float",
                      default=event_cfg["gaps"]["interval_sec"], min=2, max=20, group="Ring",
                      help="How often (seconds) a gap widens or a new one opens, before the 48s speedup."),
            # Curated (not left to the generic Advanced fallback) specifically
            # to keep elimination_radius > ring.radius always true -- the
            # generic heuristic walker ranges each independently (both
            # positive leaves get a wide, uncoordinated 0..3x-default range),
            # and Randomize landing on elimination_radius < ring.radius
            # eliminates balls on contact with the wall instead of past it,
            # making a clean single-survivor outcome rare-to-impossible for
            # EVERY seed, not just an unlucky one -- found exactly this way,
            # by Randomize repeatedly producing a config no reroll could fix.
            ParamSpec(name="ring.radius", label="Ring radius", type="int",
                      default=event_cfg["ring"]["radius"], min=280, max=420, group="Ring",
                      help="How big the ring is on screen."),
            ParamSpec(name="elimination_radius", label="Elimination radius", type="int",
                      default=event_cfg["elimination_radius"], min=440, max=600, group="Ring",
                      help="How far past the ring wall a ball must fly to be eliminated. Always kept "
                           "bigger than the ring radius above so a ball is eliminated past the wall, not at it."),
            ParamSpec(name="hazards.interval_min_sec", label="Hazard frequency (min sec)", type="float",
                      default=event_cfg["hazards"]["interval_min_sec"], min=3, max=30, group="Hazards"),
            ParamSpec(name="hazards.interval_max_sec", label="Hazard frequency (max sec)", type="float",
                      default=event_cfg["hazards"]["interval_max_sec"], min=3, max=40, group="Hazards"),
        ]
        if teams:
            curated += team_trait_params(
                {t.id: t.traits for t in teams},
                ["mass_mult", "elasticity_add", "radius_mult"],
            )
        return dedupe_by_name(curated + super().params_schema(event_cfg))
