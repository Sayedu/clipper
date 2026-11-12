"""The one interface every event implements. The shared pipeline
(pipeline.py) only ever calls these four methods, in this order, and never
reaches into an event's internals -- that is what lets a later phase add
Shell Shuffle or Disaster Drop without touching this file or pipeline.py.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import ClassVar

from .config import Settings, Team
from .records import AudioCue, SimRecord, Timeline


class Event(ABC):
    id: ClassVar[str]
    display_name: ClassVar[str]

    @abstractmethod
    def simulate(
        self,
        seed: int,
        settings: Settings,
        event_cfg: dict,
        teams: list[Team],
        episode: dict,
    ) -> SimRecord:
        """Deterministic, fixed-step physics. Same (seed, event_cfg, teams)
        -> byte-identical SimRecord, always. No wall clock, no rendering."""

    @abstractmethod
    def direct(
        self,
        record: SimRecord,
        settings: Settings,
        event_cfg: dict,
        episode: dict,
        fps: int,
    ) -> Timeline:
        """The edit: slow motion, camera, overlays, audio cue timing. Owns
        the hard 61-70s duration requirement -- trims slow motion to fit,
        never touches the physics."""

    @abstractmethod
    def draw_frame(
        self,
        canvas,
        record: SimRecord,
        timeline: Timeline,
        settings: Settings,
        teams: list[Team],
        frame_idx: int,
    ) -> None:
        """Draw exactly one output frame onto the given skia.Canvas, sized
        to settings.width x settings.height (the shared renderer handles
        scaling down for --preview, not the event)."""

    @abstractmethod
    def sound_voice(self, cue: AudioCue, sample_rate: int):
        """Synthesize exactly one audio cue's waveform: a stereo np.ndarray
        shaped (n, 2), float32, -1..1 -- the event applies its own panning
        (e.g. by x position) before returning. The shared mixer
        (audio/mix.py) just places it at cue.video_time and sums the bus;
        it never knows what a 'pluck' or 'bass_drop' actually is."""

    @abstractmethod
    def is_valid(self, record: SimRecord) -> bool:
        """Whether this run is usable at all -- find_seed() and mine() both
        skip a seed for which this returns False. What "valid" means is
        entirely event-specific (Ring of Doom: exactly one survivor by the
        sim deadline; Shell Shuffle: no cup motionless for all of round 3)."""

    def drama_stats(self, record: SimRecord, episode: dict) -> dict:
        """Turns a SimRecord into the stats the story director (mine) ranks
        by and meta.json/commit() store -- must be a dict with at least a
        numeric "score" key. This is NOT abstract: engine.drama.analyze_drama
        covers Ring of Doom (and any future event built on the same generic
        collision/elimination/hazard/near_miss/lead_change vocabulary) as a
        sane default. An event whose drama signal doesn't fit that
        vocabulary -- like a cup game, which has no "alive" balls to wipe
        out -- overrides this instead of getting nonsense numbers back."""
        from .drama import analyze_drama

        return analyze_drama(record, episode.get("crown_team")).to_dict()
