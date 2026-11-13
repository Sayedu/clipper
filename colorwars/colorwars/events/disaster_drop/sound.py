"""Disaster Drop's sound voices. Same determinism rule as the other
events: every cue's waveform comes only from the cue's own data. "pluck"
reuses Ring of Doom's Karplus-Strong technique (the same synth.py
primitive, called the same way) since peg/wall bounces are the same kind
of sound in spirit; win_sting is Phase 1's own voice, called identically.
"""

from __future__ import annotations

import numpy as np

from ...audio import synth

ROOT_HZ = 220.0
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
        degree = seed_int % 5
        freq = synth.note_freq(ROOT_HZ, degree, 0)
        vol = max(0.06, min(0.9, impulse / 1400.0))
        mono = synth.karplus_strong(freq, 0.25, sample_rate, seed_int)
        mono = synth.apply_envelope(mono, 0.002, 0.2, sample_rate) * vol
        return synth.pan_stereo(mono, _x_to_pan(data.get("x", 540.0)))

    if kind == "tick":
        mono = synth.sine(1800, 0.04, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.03, sample_rate) * 0.5
        return _center(mono)

    if kind == "crunch":
        # a loud, punchy "brainrot" hit on elimination -- a fast sub-bass
        # downward sweep (the boom) plus a sharp noise crack up front (the
        # hit), with a short comedic upward "boing" chirp right after so it
        # reads as a little funny/slapstick, not just a dramatic thud. By
        # request: eliminations should grab attention and get a laugh.
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        boom = synth.sine_sweep(150, 35, 0.3, sample_rate)
        boom = synth.apply_envelope(boom, 0.001, 0.28, sample_rate) * 0.95
        crack = synth.noise_burst(0.06, sample_rate, seed_int)
        crack = synth.apply_envelope(crack, 0.001, 0.05, sample_rate) * 0.8
        n = max(len(boom), len(crack))
        mono = np.zeros(n, dtype=np.float32)
        mono[: len(crack)] += crack
        mono[: len(boom)] += boom
        boing = synth.sine_sweep(300, 700, 0.1, sample_rate)
        boing = synth.apply_envelope(boing, 0.01, 0.08, sample_rate) * 0.35
        start = int(0.08 * sample_rate)
        end = start + len(boing)
        if end > len(mono):
            mono = np.pad(mono, (0, end - len(mono)))
        mono[start:end] += boing
        return _center(mono.astype(np.float32))

    if kind == "finish_blip":
        mono = synth.sine_sweep(520, 900, 0.18, sample_rate)
        mono = synth.apply_envelope(mono, 0.005, 0.15, sample_rate) * 0.6
        return _center(mono)

    if kind == "win_sting":
        mono = synth.major_chord_arpeggio(261.63, sample_rate)
        return _center(mono)

    if kind == "lightning":
        seed_int = int(abs(cue.video_time * 1000)) % (2 ** 31)
        crackle = synth.noise_burst(0.3, sample_rate, seed_int)
        crackle *= np.abs(np.sin(np.linspace(0, 40, len(crackle))))
        zap = synth.sine_sweep(2200, 300, 0.12, sample_rate)
        n = min(len(crackle), len(zap))
        mono = (crackle[:n] * 0.5 + zap[:n] * 0.5).astype(np.float32)
        mono = synth.apply_envelope(mono, 0.002, 0.25, sample_rate) * 0.7
        return _center(mono)

    if kind == "hammer":
        whoosh = synth.noise_burst(0.3, sample_rate, int(abs(cue.video_time * 1000)) % (2 ** 31))
        whoosh = synth.apply_envelope(whoosh, 0.05, 0.2, sample_rate) * 0.35
        thud = synth.sine(70, 0.25, sample_rate)
        thud = synth.apply_envelope(thud, 0.15, 0.15, sample_rate) * 0.6
        n = min(len(whoosh), len(thud))
        mono = (whoosh[:n] + thud[:n]).astype(np.float32)
        return _center(mono)

    if kind == "wall":
        mono = synth.sine(90, 0.3, sample_rate)
        mono = synth.apply_envelope(mono, 0.002, 0.25, sample_rate) * 0.7
        return _center(mono)

    if kind == "boost":
        mono = synth.sine_sweep(250, 820, 0.3, sample_rate)
        mono = synth.apply_envelope(mono, 0.01, 0.25, sample_rate) * 0.6
        return _center(mono)

    if kind == "gravity_flip":
        mono = synth.sine_sweep(700, 140, 0.4, sample_rate) + synth.sine_sweep(140, 700, 0.4, sample_rate) * 0.5
        mono = synth.apply_envelope(mono.astype(np.float32), 0.02, 0.35, sample_rate) * 0.5
        return _center(mono)

    if kind == "magnet":
        dur = 1.2
        n = int(dur * sample_rate)
        base = synth.sine(110, dur, sample_rate)
        tremolo = 0.6 + 0.4 * np.sin(2 * np.pi * 7.0 * np.arange(n) / sample_rate)
        mono = (base * tremolo).astype(np.float32)
        mono = synth.apply_envelope(mono, 0.05, 0.9, sample_rate) * 0.5
        return _center(mono)

    return np.zeros((1, 2), dtype=np.float32)
