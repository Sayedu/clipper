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
