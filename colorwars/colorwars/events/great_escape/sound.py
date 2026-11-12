"""Great Escape's sound voices. "theme_note" decodes the cue's note index
(0-9: degree = note % 5, octave = note // 5) against the season's shared
32-note melody (league/theme.json) via the same Karplus-Strong pluck
technique Ring of Doom uses for its collision notes -- same style of
sound, deterministic either way, just sourced from the shared theme
instead of a per-cue pseudo-random degree.
"""

from __future__ import annotations

import numpy as np

from ...audio import synth

ROOT_HZ = 220.0


def _center(mono) -> np.ndarray:
    return synth.pan_stereo(mono, 0.0)


def _x_to_pan(x: float) -> float:
    return max(-1.0, min(1.0, (x / 1080.0) * 2.0 - 1.0))


def sound_voice(cue, sample_rate: int) -> np.ndarray:
    kind = cue.kind
    data = cue.data

    if kind == "theme_note":
        note = int(data.get("note", 0))
        degree, octave = note % 5, note // 5
        freq = synth.note_freq(ROOT_HZ, degree, octave)
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        mono = synth.karplus_strong(freq, 0.3, sample_rate, seed_int)
        mono = synth.apply_envelope(mono, 0.002, 0.25, sample_rate) * 0.5
        return synth.pan_stereo(mono, _x_to_pan(data.get("x", 540.0)))

    if kind == "glass_burst":
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        noise = synth.noise_burst(0.35, sample_rate, seed_int)
        shimmer = synth.sine_sweep(3200, 1800, 0.3, sample_rate)
        n = min(len(noise), len(shimmer))
        mono = (noise[:n] * 0.5 + shimmer[:n] * 0.4).astype(np.float32)
        mono = synth.apply_envelope(mono, 0.001, 0.3, sample_rate) * 0.6
        return _center(mono)

    if kind == "whoosh_out":
        mono = synth.sine_sweep(600, 1400, 0.35, sample_rate)
        mono = synth.apply_envelope(mono, 0.02, 0.3, sample_rate) * 0.5
        return _center(mono)

    if kind == "win_sting":
        mono = synth.major_chord_arpeggio(261.63, sample_rate)
        return _center(mono)

    return np.zeros((1, 2), dtype=np.float32)
