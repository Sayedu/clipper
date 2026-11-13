"""Ring of Doom's specific sound voices. Every cue's waveform is derived
deterministically from the cue's own data (never the wall clock, never an
unseeded RNG) -- the same AudioCue always produces the identical samples.
"""

from __future__ import annotations

import numpy as np

from ...audio import synth

ROOT_HZ = 196.0  # G3 -- low enough to climb a couple octaves through the episode
FRAME_WIDTH = 1080.0


def _x_to_pan(x: float) -> float:
    return max(-1.0, min(1.0, (x / FRAME_WIDTH) * 2.0 - 1.0))


def _mono_to_stereo_center(mono: np.ndarray) -> np.ndarray:
    return synth.pan_stereo(mono, 0.0)


def sound_voice(cue, sample_rate: int) -> np.ndarray:
    kind = cue.kind
    data = cue.data

    if kind == "pluck":
        progress = max(0.0, min(1.0, data.get("progress", 0.0)))
        impulse = data.get("impulse", 0.0)
        # deterministic "random" degree/octave from the cue's own numbers,
        # not from any RNG -- same collision always plays the same note.
        seed_int = int(abs(cue.video_time * 1000) + impulse) % (2 ** 31)
        degree = seed_int % 5
        octave = int(progress * 2.4)  # pitch range climbs through the episode
        freq = synth.note_freq(ROOT_HZ, degree, octave)
        vol = max(0.08, min(1.0, impulse / 2200.0))
        # a short upward pitch sweep reads as a water-bubble "bloop" rather
        # than the plucked-string resonance karplus_strong gave it -- snappier
        # too (0.12s vs 0.35s), which matters more now that bouncier balls
        # mean collisions happen a lot more often.
        mono = synth.sine_sweep(freq * 0.55, freq * 1.2, 0.12, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.09, sample_rate) * vol
        return synth.pan_stereo(mono, _x_to_pan(data.get("x", 540.0)))

    if kind == "pop":
        mono = synth.sine_sweep(900, 180, 0.12, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.1, sample_rate) * 0.8
        return _mono_to_stereo_center(mono)

    if kind == "whoosh":
        mono = synth.noise_burst(0.25, sample_rate, int(abs(cue.video_time * 1000)) % (2 ** 31))
        mono = synth.apply_envelope(mono, 0.02, 0.2, sample_rate) * 0.3
        return _mono_to_stereo_center(mono)

    if kind == "tick":
        mono = synth.sine(1800, 0.04, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.03, sample_rate) * 0.5
        return _mono_to_stereo_center(mono)

    if kind == "crackle":
        mono = synth.noise_burst(0.4, sample_rate, int(abs(cue.video_time * 1000)) % (2 ** 31))
        mono *= np.abs(np.sin(np.linspace(0, 30, len(mono))))  # a jagged, crackly amplitude
        mono = synth.apply_envelope(mono.astype(np.float32), 0.005, 0.35, sample_rate) * 0.5
        return _mono_to_stereo_center(mono)

    if kind == "thud":
        mono = synth.sine(60, 0.3, sample_rate)
        mono = synth.apply_envelope(mono, 0.002, 0.25, sample_rate) * 0.7
        return _mono_to_stereo_center(mono)

    if kind == "drone_start":
        dur = max(1.0, data.get("duration", 15.0))
        mono = synth.sine(55, dur, sample_rate) * 0.18 + synth.sine(55 * 1.5, dur, sample_rate) * 0.07
        fade_in = min(2.0, dur * 0.2)
        mono = synth.apply_envelope(mono.astype(np.float32), fade_in, dur, sample_rate)
        return _mono_to_stereo_center(mono)

    if kind == "heartbeat":
        dur = max(1.0, data.get("duration", 6.0))
        bpm = 70 + 40 * (1.0 - min(1.0, dur / 10.0))  # a little faster the closer we are to the end
        beat_period = 60.0 / max(40.0, bpm)
        n_beats = max(1, int(dur / beat_period))
        bus = np.zeros(int(dur * sample_rate), dtype=np.float32)
        for k in range(n_beats):
            thump = synth.sine(55, 0.12, sample_rate)
            thump = synth.apply_envelope(thump, 0.001, 0.1, sample_rate) * 0.5
            start = int(k * beat_period * sample_rate)
            end = min(len(bus), start + len(thump))
            bus[start:end] += thump[: end - start]
        return _mono_to_stereo_center(bus)

    if kind == "bass_drop":
        mono = synth.sine_sweep(220, 40, 0.6, sample_rate)
        mono = synth.apply_envelope(mono, 0.001, 0.55, sample_rate) * 0.9
        return _mono_to_stereo_center(mono)

    if kind == "win_sting":
        mono = synth.major_chord_arpeggio(261.63, sample_rate)  # C4 major
        return _mono_to_stereo_center(mono)

    # unknown cue kind -- silence rather than crash, so a future event-specific
    # cue someone forgets to wire up just plays nothing instead of breaking the mix
    return np.zeros((1, 2), dtype=np.float32)
