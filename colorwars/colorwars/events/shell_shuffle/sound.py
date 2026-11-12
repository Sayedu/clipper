"""Shell Shuffle's sound voices. Same determinism rule as Ring of Doom:
every cue's waveform comes only from the cue's own data, never the wall
clock or an unseeded RNG. "drumroll" has no literal precedent in Phase 1 --
Phase 1's closest built thing is the heartbeat voice (a sequence of thumps
whose spacing tightens near the end), so this reuses that same technique,
retuned into a snare-like roll. "win_sting" is Phase 1's own voice, called
the identical way (the same synth.major_chord_arpeggio on C4).
"""

from __future__ import annotations

import numpy as np

from ...audio import synth


def _center(mono: np.ndarray) -> np.ndarray:
    return synth.pan_stereo(mono, 0.0)


def sound_voice(cue, sample_rate: int) -> np.ndarray:
    kind = cue.kind
    data = cue.data

    if kind == "swish":
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        mono = synth.noise_burst(0.3, sample_rate, seed_int)
        n = len(mono)
        # rises then falls -- a soft "shh" rather than a flat hiss
        shape = np.sin(np.linspace(0, np.pi, n)).astype(np.float32)
        mono = (mono * shape * 0.22).astype(np.float32)
        return _center(mono)

    if kind == "click":
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        tone = synth.sine(2200, 0.03, sample_rate)
        tone = synth.apply_envelope(tone, 0.0005, 0.025, sample_rate) * 0.5
        noise = synth.noise_burst(0.03, sample_rate, seed_int)
        noise = synth.apply_envelope(noise, 0.0005, 0.02, sample_rate) * 0.15
        mono = (tone + noise).astype(np.float32)
        return _center(mono)

    if kind == "pop":
        mono = synth.sine_sweep(900, 180, 0.12, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.1, sample_rate) * 0.8
        return _center(mono)

    if kind == "drumroll":
        dur = max(0.3, data.get("duration", 1.5))
        n_total = int(dur * sample_rate)
        bus = np.zeros(n_total, dtype=np.float32)
        # hit spacing tightens from ~220ms to ~55ms across the roll -- the
        # same "accelerating sequence of discrete thumps" shape as Phase 1's
        # heartbeat, just much faster and noise based instead of a sine thump.
        hit_t = 0.0
        hit_idx = 0
        while hit_t < dur:
            progress = hit_t / dur
            spacing = 0.22 - 0.165 * progress
            seed_int = (int(dur * 1000) + hit_idx) % (2 ** 31)
            hit = synth.noise_burst(0.05, sample_rate, seed_int)
            hit = synth.apply_envelope(hit, 0.001, 0.045, sample_rate) * (0.35 + 0.3 * progress)
            start = int(hit_t * sample_rate)
            end = min(n_total, start + len(hit))
            if end > start:
                bus[start:end] += hit[: end - start]
            hit_t += max(0.05, spacing)
            hit_idx += 1
        return _center(bus)

    if kind == "win_sting":
        mono = synth.major_chord_arpeggio(261.63, sample_rate)  # C4 major, same as Ring of Doom
        return _center(mono)

    return np.zeros((1, 2), dtype=np.float32)
