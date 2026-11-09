"""Synthesise the marble-race soundtrack from the physics event log.

No music, no rolling bed — just a warm rounded wooden "knock" for every real
marble contact, panned, with a hint of room. Kept easy on the ear; the caller
loudnorm's the final mux.

  python marblerace_audio.py --events frames/events.json --duration 22.5 \
      --out race.wav
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

SR = 44100


def log(m):
    sys.stderr.write(str(m).rstrip() + "\n")
    sys.stderr.flush()


def lp(x, cutoff):
    sos = butter(2, min(cutoff, SR * 0.49) / (SR / 2), btype="low", output="sos")
    return sosfilt(sos, x)


def bandpass(x, lo, hi):
    lo = max(20.0, min(lo, SR * 0.45))
    hi = max(lo + 20.0, min(hi, SR * 0.49))
    sos = butter(2, [lo / (SR / 2), hi / (SR / 2)], btype="band", output="sos")
    return sosfilt(sos, x)


def knock(dur=0.13, freq=250.0, seed=0):
    """A soft wooden 'tok' — a low pitched thunk + a tiny mallet transient,
    rounded (no sharp click), medium-short decay."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    rng = np.random.default_rng(seed)
    env = np.exp(-t * 17.0)
    env[: int(SR * 0.002)] *= np.linspace(0.0, 1.0, int(SR * 0.002))
    tone = (np.sin(2 * np.pi * freq * t)
            + 0.3 * np.sin(2 * np.pi * freq * 2.0 * t) * np.exp(-t * 34.0)) * env
    body = bandpass(rng.standard_normal(n), freq * 0.8, freq * 2.6) * env * 0.35
    s = tone * 0.8 + body
    return (s / (np.max(np.abs(s)) + 1e-9)).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.events) as fh:
        data = json.load(fh)
    fps = data.get("fps", 30)
    frames = data["frames"]
    n_samples = int(SR * args.duration) + SR // 4

    # a small palette of wooden knocks at different pitches
    knocks = [knock(0.11 + 0.03 * (k % 3), 170 + 55 * k, seed=k) for k in range(6)]

    left = np.zeros(n_samples, np.float32)
    right = np.zeros(n_samples, np.float32)
    rng = np.random.default_rng(99)
    n_hits = 0
    for fr in frames:
        imps = fr.get("impacts") or []
        if not imps:
            continue
        base = int(fr["f"] / fps * SR)
        for mag in imps:
            amp = float(np.clip(mag / 900.0, 0.05, 1.0)) * 0.42
            k = knocks[rng.integers(0, len(knocks))]
            pos = base + rng.integers(0, int(SR / fps))
            end = min(n_samples, pos + len(k))
            seg = k[: end - pos] * amp
            pan = rng.uniform(0.34, 0.66)
            left[pos:end] += seg * (1 - pan) * 1.4
            right[pos:end] += seg * pan * 1.4
            n_hits += 1

    # a hint of room so the knocks aren't bone-dry
    def comb(x, d, g):
        y = x.copy()
        for s0 in range(d, len(x), d):
            s1 = min(s0 + d, len(x))
            y[s0:s1] += g * y[s0 - d:s0 - d + (s1 - s0)]
        return y

    mono = (left + right) * 0.5
    wet = np.zeros(n_samples, np.float32)
    for d, g in [(1201, 0.42), (1523, 0.38), (1867, 0.34)]:
        wet += comb(mono, d, g)
    wet = lp(wet, 4200) * 0.09
    left += wet
    right += np.concatenate([np.zeros(23, np.float32), wet[:-23]])

    stereo = np.stack([left, right], axis=1)
    peak = np.max(np.abs(stereo))
    if peak > 0.7:
        stereo *= 0.7 / peak
    sf.write(args.out, stereo.astype(np.float32), SR)
    log(f"marblerace_audio: {len(frames)} frames, {n_hits} knocks, {args.duration:.1f}s -> {args.out}")


if __name__ == "__main__":
    main()
