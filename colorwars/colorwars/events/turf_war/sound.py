"""Turf War's sound voices. Same determinism rule as every other event:
every cue's waveform comes only from the cue's own data.
"""

from __future__ import annotations

import numpy as np

from ...audio import synth


def _center(mono: np.ndarray) -> np.ndarray:
    return synth.pan_stereo(mono, 0.0)


def sound_voice(cue, sample_rate: int) -> np.ndarray:
    kind = cue.kind
    data = cue.data

    if kind == "blip":
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        degree = seed_int % 5
        freq = synth.note_freq(196.0, degree, 1)
        mono = synth.sine(freq, 0.07, sample_rate)
        mono = synth.apply_envelope(mono, 0.002, 0.06, sample_rate) * 0.35
        return _center(mono)

    if kind == "spawn":
        mono = synth.sine_sweep(500, 1100, 0.2, sample_rate)
        mono = synth.apply_envelope(mono, 0.01, 0.18, sample_rate) * 0.4
        return _center(mono)

    if kind == "bomb":
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        noise = synth.noise_burst(0.3, sample_rate, seed_int)
        thud = synth.sine(55, 0.3, sample_rate)
        mono = synth.apply_envelope((noise * 0.6 + thud * 0.6).astype(np.float32), 0.002, 0.25, sample_rate) * 0.7
        return _center(mono)

    if kind == "ghost":
        mono = synth.sine_sweep(1400, 600, 0.3, sample_rate)
        mono = synth.apply_envelope(mono, 0.02, 0.25, sample_rate) * 0.4
        return _center(mono)

    if kind == "speed":
        mono = synth.sine_sweep(300, 950, 0.25, sample_rate)
        mono = synth.apply_envelope(mono, 0.005, 0.2, sample_rate) * 0.45
        return _center(mono)

    if kind == "pop":
        mono = synth.sine_sweep(900, 180, 0.12, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.1, sample_rate) * 0.7
        return _center(mono)

    if kind == "win_sting":
        mono = synth.major_chord_arpeggio(261.63, sample_rate)
        return _center(mono)

    return np.zeros((1, 2), dtype=np.float32)
