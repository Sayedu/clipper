"""Champion Duel's sound voices. Same determinism rule as every event:
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

    if kind == "hit":
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        source = data.get("kind", "contact")
        base_freq = {"contact": 220, "spike": 320, "twin": 500}.get(source, 220)
        mono = synth.sine_sweep(base_freq, base_freq * 0.5, 0.1, sample_rate)
        noise = synth.noise_burst(0.08, sample_rate, seed_int)
        n = min(len(mono), len(noise))
        mono = (mono[:n] * 0.5 + noise[:n] * 0.3).astype(np.float32)
        mono = synth.apply_envelope(mono, 0.001, 0.08, sample_rate) * 0.5
        return _center(mono)

    if kind == "big_hit":
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        thud = synth.sine(70, 0.3, sample_rate)
        noise = synth.noise_burst(0.3, sample_rate, seed_int)
        mono = synth.apply_envelope((thud * 0.7 + noise * 0.5).astype(np.float32), 0.001, 0.26, sample_rate) * 0.75
        return _center(mono)

    if kind == "block":
        mono = synth.sine_sweep(1600, 2400, 0.1, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.08, sample_rate) * 0.45
        return _center(mono)

    if kind == "win_sting":
        mono = synth.major_chord_arpeggio(261.63, sample_rate)
        return _center(mono)

    return np.zeros((1, 2), dtype=np.float32)
