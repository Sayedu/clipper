"""Shared, event-agnostic sound synthesis primitives. Everything is
numpy + math -- no samples, no external audio files, ever. An event's
sound_voice() composes these into its own specific cues; this module
has no idea what a "pluck" or "bass_drop" means semantically, it just
knows how to make noise, tones and envelopes.
"""

from __future__ import annotations

import numpy as np

C_MAJOR_PENTATONIC = [0, 2, 4, 7, 9]  # semitone offsets from the root, one octave


def note_freq(root_hz: float, scale_degree: int, octave: int = 0) -> float:
    """scale_degree indexes into C_MAJOR_PENTATONIC (wrapping across
    octaves); octave shifts by whole 12-semitone jumps on top of that."""
    semitones = C_MAJOR_PENTATONIC[scale_degree % len(C_MAJOR_PENTATONIC)]
    semitones += 12 * (scale_degree // len(C_MAJOR_PENTATONIC))
    semitones += 12 * octave
    return root_hz * (2.0 ** (semitones / 12.0))


def karplus_strong(freq: float, duration_sec: float, sample_rate: int, seed_int: int, decay: float = 0.996) -> np.ndarray:
    """A plucked-string voice: a short burst of seeded noise fed through a
    simple averaging delay line at the string's period. seed_int makes the
    exact noise burst (and therefore the exact waveform) reproducible."""
    n = max(1, int(duration_sec * sample_rate))
    period = max(2, int(sample_rate / max(20.0, freq)))
    rng = np.random.default_rng(seed_int)
    buf = rng.uniform(-1.0, 1.0, period).astype(np.float64)
    out = np.zeros(n, dtype=np.float64)
    for i in range(n):
        out[i] = buf[i % period]
        buf[i % period] = decay * 0.5 * (buf[i % period] + buf[(i + 1) % period])
    return out.astype(np.float32)


def noise_burst(duration_sec: float, sample_rate: int, seed_int: int) -> np.ndarray:
    n = max(1, int(duration_sec * sample_rate))
    rng = np.random.default_rng(seed_int)
    return rng.uniform(-1.0, 1.0, n).astype(np.float32)


def sine(freq: float, duration_sec: float, sample_rate: int, phase: float = 0.0) -> np.ndarray:
    n = max(1, int(duration_sec * sample_rate))
    t = np.arange(n) / sample_rate
    return np.sin(2 * np.pi * freq * t + phase).astype(np.float32)


def sine_sweep(freq0: float, freq1: float, duration_sec: float, sample_rate: int) -> np.ndarray:
    n = max(1, int(duration_sec * sample_rate))
    t = np.arange(n) / sample_rate
    freq_t = np.linspace(freq0, freq1, n)
    phase = 2 * np.pi * np.cumsum(freq_t) / sample_rate
    return np.sin(phase).astype(np.float32)


def envelope(n: int, attack: float, decay: float, sample_rate: int) -> np.ndarray:
    """Linear attack, exponential-ish decay to ~0, all within n samples."""
    a_n = max(1, int(attack * sample_rate))
    d_n = max(1, n - a_n)
    a_n = min(a_n, n)
    d_n = n - a_n
    env = np.ones(n, dtype=np.float32)
    env[:a_n] = np.linspace(0.0, 1.0, a_n)
    if d_n > 0:
        tail = np.linspace(0.0, 1.0, d_n)
        env[a_n:] = np.exp(-tail * (1.0 / max(0.05, decay)) * 5.0)
    return env


def apply_envelope(sig: np.ndarray, attack: float, decay: float, sample_rate: int) -> np.ndarray:
    env = envelope(len(sig), attack, decay, sample_rate)
    return (sig * env).astype(np.float32)


def pan_stereo(mono: np.ndarray, pan: float) -> np.ndarray:
    """pan in [-1, 1], -1 = hard left, 1 = hard right. Equal-power pan law."""
    pan = max(-1.0, min(1.0, pan))
    theta = (pan + 1.0) * (np.pi / 4.0)
    left = mono * np.cos(theta)
    right = mono * np.sin(theta)
    return np.stack([left, right], axis=1).astype(np.float32)


def major_chord_arpeggio(root_hz: float, sample_rate: int, note_sec: float = 0.11, hold_sec: float = 0.5) -> np.ndarray:
    """Root, major third, fifth, octave -- arpeggiated up, then held as a
    stereo-summed chord. Used for the win sting."""
    intervals = [0, 4, 7, 12]
    total_n = int((len(intervals) * note_sec + hold_sec) * sample_rate)
    bus = np.zeros(total_n, dtype=np.float64)
    for k, semi in enumerate(intervals):
        freq = root_hz * (2.0 ** (semi / 12.0))
        start = int(k * note_sec * sample_rate)
        dur = total_n / sample_rate - k * note_sec
        tone = sine(freq, max(0.05, dur), sample_rate)
        tone = apply_envelope(tone, 0.01, 0.6, sample_rate)
        end = min(total_n, start + len(tone))
        bus[start:end] += tone[: end - start] * 0.6
    return bus.astype(np.float32)
