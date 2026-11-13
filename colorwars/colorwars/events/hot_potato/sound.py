"""Hot Potato's sound voices. Same determinism rule as every other event:
every cue's waveform comes only from the cue's own data, never the wall
clock or live RNG.
"""

from __future__ import annotations

import numpy as np

from ...audio import synth

FRAME_WIDTH = 1080.0


def _x_to_pan(x: float) -> float:
    return max(-1.0, min(1.0, (x / FRAME_WIDTH) * 2.0 - 1.0))


def _center(mono: np.ndarray) -> np.ndarray:
    return synth.pan_stereo(mono, 0.0)


def sound_voice(cue, sample_rate: int) -> np.ndarray:
    kind = cue.kind
    data = cue.data

    if kind == "pluck":
        impulse = data.get("impulse", 0.0)
        seed_int = int(abs(cue.video_time * 1000) + impulse) % (2 ** 31)
        freq = 220.0 + (seed_int % 5) * 40.0
        vol = max(0.06, min(0.6, impulse / 1800.0))
        mono = synth.sine_sweep(freq * 0.6, freq * 1.1, 0.1, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.08, sample_rate) * vol
        return synth.pan_stereo(mono, _x_to_pan(data.get("x", 540.0)))

    if kind == "pass":
        # a quick, bright "hot potato!" blip when the bomb changes hands --
        # snappy and a little comedic, not a plain beep.
        mono = synth.sine_sweep(650, 1100, 0.07, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.06, sample_rate) * 0.55
        return _center(mono)

    if kind == "tick":
        # a sharper, higher-pitched tick than Ring of Doom's gap warning --
        # this one is meant to feel urgent/funny as it speeds up near zero.
        mono = synth.sine(2400, 0.035, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.025, sample_rate) * 0.6
        return _center(mono)

    if kind == "boom":
        # the big "brainrot" payoff: a loud sub-bass boom + a sharp crack up
        # front, same shape as Disaster Drop's beefed-up crunch, but bigger
        # and with a cartoonish downward "wah-wah" tail landing the joke.
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        boom = synth.sine_sweep(160, 30, 0.35, sample_rate)
        boom = synth.apply_envelope(boom, 0.001, 0.32, sample_rate) * 1.0
        crack = synth.noise_burst(0.08, sample_rate, seed_int)
        crack = synth.apply_envelope(crack, 0.001, 0.06, sample_rate) * 0.85
        n = max(len(boom), len(crack))
        mono = np.zeros(n, dtype=np.float32)
        mono[: len(crack)] += crack
        mono[: len(boom)] += boom
        wah = synth.sine_sweep(500, 140, 0.3, sample_rate)
        wah = synth.apply_envelope(wah, 0.02, 0.26, sample_rate) * 0.3
        start = int(0.1 * sample_rate)
        end = start + len(wah)
        if end > len(mono):
            mono = np.pad(mono, (0, end - len(mono)))
        mono[start:end] += wah
        return _center(mono.astype(np.float32))

    if kind == "win_sting":
        mono = synth.major_chord_arpeggio(261.63, sample_rate)
        return _center(mono)

    return np.zeros((1, 2), dtype=np.float32)
