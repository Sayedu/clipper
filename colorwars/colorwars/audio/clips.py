"""A narrow, deliberate exception to synth.py's "no samples, no external
audio files, ever" rule: a handful of real meme/SFX clips an event can
choose to play verbatim instead of synthesizing, when the whole point is
a *specific, recognizable* sound (a viral meme clip), not a procedural
approximation of one. Still fully deterministic -- the same clip at the
same cue time always produces the identical samples, same as everything
else in this engine; it's just reading bytes instead of generating them.

Assets live in colorwars/assets/sfx/, pre-trimmed and pre-converted to
48kHz stereo PCM WAV (this project's one audio sample rate -- see
config/settings.yaml's audio.sample_rate) so loading never needs to
resample at render time.
"""

from __future__ import annotations

import wave
from functools import lru_cache
from pathlib import Path

import numpy as np

ASSETS_DIR = Path(__file__).resolve().parents[2] / "assets" / "sfx"


@lru_cache(maxsize=None)
def load_clip(name: str, sample_rate: int) -> np.ndarray:
    """Loads assets/sfx/<name> as a (n, 2) float32 array in -1..1. Cached
    (the file never changes mid-process) since a clip can be referenced by
    many cues across one render."""
    path = ASSETS_DIR / name
    with wave.open(str(path), "rb") as wf:
        if wf.getframerate() != sample_rate:
            raise ValueError(
                f"{path} is {wf.getframerate()}Hz, not {sample_rate}Hz -- re-render the asset at the "
                f"project's sample rate instead of resampling at playback time."
            )
        channels = wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels == 1:
        return np.repeat(pcm[:, None], 2, axis=1)
    return pcm.reshape(-1, channels)[:, :2]
