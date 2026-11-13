"""The shared mixer: places every event-synthesized cue waveform at its
video time, sums into one stereo bus, writes a 48 kHz WAV. Loudnorm + the
AAC mux happen via ffmpeg in render/video.py's final mux step -- this
module only ever deals with raw samples.
"""

from __future__ import annotations

import wave
from pathlib import Path
from typing import Callable

import numpy as np


def build_bus(cues: list, sound_voice_fn: Callable, sample_rate: int, duration_sec: float,
              volume_mult: float = 1.0) -> np.ndarray:
    n = max(1, int(duration_sec * sample_rate) + sample_rate)  # a little tail room for the last cue's decay
    bus = np.zeros((n, 2), dtype=np.float64)
    for cue in cues:
        wav = sound_voice_fn(cue, sample_rate)
        if wav is None or len(wav) == 0:
            continue
        start = max(0, int(cue.video_time * sample_rate))
        end = min(n, start + len(wav))
        if end <= start:
            continue
        bus[start:end] += wav[: end - start]
    # a single master knob the Studio page exposes ("audio volumes") --
    # applied before the peak clamp below so a loud volume_mult still
    # can't actually clip, it just rides closer to the ceiling.
    if volume_mult != 1.0:
        bus *= max(0.0, volume_mult)
    peak = float(np.max(np.abs(bus))) if bus.size else 0.0
    if peak > 0.98:
        bus *= 0.98 / peak
    return bus.astype(np.float32)


def write_wav(bus: np.ndarray, sample_rate: int, path: Path) -> None:
    clipped = np.clip(bus, -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16.tobytes())
