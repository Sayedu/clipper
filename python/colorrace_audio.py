"""Synthesise the "Color race" (Marble Rush) soundtrack from the render event log.

Satisfying, not shrill: every marble contact lands on a soft music-box note on a
C-major pentatonic scale (bouncy pads an octave up), panned by x; boost/mud pads
get a quick whoosh; the countdown ticks; each finisher rings a chime; the winner
gets a warm arpeggio. Master: gentle compression + a ~6.5 kHz low-pass + a little
plate reverb. No music bed. The worker loudnorm's the final mux.

  python colorrace_audio.py --events frames/events.json --duration 24.0 --out race.wav
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

SR = 44100

# C-major pentatonic, C3–C5 (matches the design's _PENTA)
SCALE = [130.81 * (2.0 ** (o + s / 12.0)) for o in range(2) for s in (0, 2, 4, 7, 9)]
WIN_ROOT = 196.0  # G


def log(m):
    sys.stderr.write(str(m).rstrip() + "\n"); sys.stderr.flush()


def progress(pct, msg=""):
    sys.stderr.write("@progress " + json.dumps({"pct": max(0.0, min(1.0, float(pct))), "msg": msg}) + "\n")
    sys.stderr.flush()


def lp(x, cutoff):
    sos = butter(2, min(cutoff, SR * 0.49) / (SR / 2), btype="low", output="sos")
    return sosfilt(sos, x)


def hp(x, cutoff):
    sos = butter(2, max(20.0, cutoff) / (SR / 2), btype="high", output="sos")
    return sosfilt(sos, x)


def _env(n, a, d, curve=3.2):
    e = np.ones(n, np.float32)
    ai = max(1, int(SR * a))
    if ai < n:
        e[:ai] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, ai))
        t = np.arange(n - ai) / SR
        e[ai:] = np.exp(-t * (curve / max(d, 1e-3)))
    else:
        e[:] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, n))
    return e


def tone(freq, dur, a=0.004, d=None, curve=3.4, glide_to=None, partial=0.28):
    d = dur if d is None else d
    n = int(SR * dur)
    t = np.arange(n) / SR
    if glide_to:
        k = np.linspace(0.0, 1.0, n)
        inst = freq * (glide_to / freq) ** k
        ph = 2 * np.pi * np.cumsum(inst) / SR
    else:
        ph = 2 * np.pi * freq * t
    s = np.sin(ph) + partial * np.sin(2 * ph) * np.exp(-t * 12.0)
    return (s * _env(n, a, d, curve)).astype(np.float32)


def noise_sweep(dur, c0, c1):
    n = int(SR * dur)
    x = np.random.default_rng().standard_normal(n).astype(np.float32)
    out = x
    for kk in np.linspace(0.0, 1.0, 7):
        out = lp(out, c0 * (c1 / c0) ** kk)
    return (out * _env(n, 0.02, dur, 2.4)).astype(np.float32)


def place(l, r, sig, at, gain, pan=0.5):
    pos = int(at * SR)
    if pos < 0 or pos >= len(l):
        return
    end = min(len(l), pos + len(sig))
    seg = sig[: end - pos]
    pan = float(np.clip(pan, 0.0, 1.0))
    l[pos:end] += seg * gain * np.sqrt(1.0 - pan) * 1.3
    r[pos:end] += seg * gain * np.sqrt(pan) * 1.3


def plate(x, decay=(0.4, 0.34, 0.28), delays=(911, 1237, 1601), taps=2):
    y = np.zeros_like(x)
    for dl, g in zip(delays, decay):
        if dl >= len(x):
            continue
        acc = np.zeros_like(x)
        acc[dl:] = x[:-dl]
        cur = acc.copy()
        for _ in range(taps):
            sh = np.zeros_like(cur)
            sh[dl:] = cur[:-dl] * g
            cur = cur + sh
        y += cur
    y = lp(y, 3400)
    return y / (np.max(np.abs(y)) + 1e-9)


def compress(x, thresh=0.28, ratio=3.2):
    a = np.abs(x)
    over = a > thresh
    g = np.ones_like(x)
    g[over] = (thresh + (a[over] - thresh) / ratio) / (a[over] + 1e-9)
    return x * lp(g, 80.0)


def soft_limit(x, ceil=0.62):
    return np.tanh(x / ceil) * ceil


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.events) as fh:
        data = json.load(fh)
    events = data.get("events", [])

    n = int(SR * (args.duration + 0.8))
    dry_l = np.zeros(n, np.float32)
    dry_r = np.zeros(n, np.float32)
    wet_l = np.zeros(n, np.float32)
    wet_r = np.zeros(n, np.float32)

    hit_t = np.array([float(e["t"]) for e in events if e.get("type") == "hit"], dtype=np.float64)

    def duck(t):
        if hit_t.size == 0:
            return 1.0
        near = int(np.sum(np.abs(hit_t - t) < 0.4))
        return float(np.clip(1.1 / (1.0 + 0.16 * max(0, near - 1)), 0.28, 1.0))

    last_hit = -9.0
    step = 0
    n_by = {}
    for i, ev in enumerate(events):
        et = ev.get("type")
        t = float(ev.get("t", 0.0))
        n_by[et] = n_by.get(et, 0) + 1
        pan = 0.5 + (float(ev.get("x", 0.5)) - 0.5) * 0.65

        if et == "hit":
            if t - last_hit < 0.055:
                continue
            last_hit = t
            imp = float(np.clip(ev.get("imp", 0.3), 0.0, 1.0))
            oct_up = 2.0 if ev.get("kind") == "b" else 1.0
            f = float(np.random.default_rng(i).choice(SCALE)) * oct_up
            sig = tone(f, 0.42, a=0.002, d=0.34, curve=3.6, partial=0.3)
            g = (0.07 + 0.06 * imp) * duck(t)
            place(dry_l, dry_r, sig, t, g, pan=pan)
            place(wet_l, wet_r, sig, t, g * 0.45, pan=pan)

        elif et == "boost":
            m = tone(160, 0.34, a=0.004, d=0.28, glide_to=560, partial=0.15)
            m += np.concatenate([noise_sweep(0.26, 800, 3200),
                                 np.zeros(max(0, len(m) - int(SR * 0.26)), np.float32)])[: len(m)] * 0.3
            place(dry_l, dry_r, m, t, 0.16, pan=pan)
            place(wet_l, wet_r, m, t, 0.06, pan=pan)

        elif et == "mud":
            m = tone(320, 0.4, a=0.004, d=0.34, glide_to=90, partial=0.1)
            place(dry_l, dry_r, m, t, 0.15, pan=pan)
            place(wet_l, wet_r, m, t, 0.05, pan=pan)

        elif et == "count":
            nn = ev.get("n")
            if nn == "GO":
                m = tone(180, 0.3, a=0.003, d=0.24, glide_to=440, partial=0.2)
                place(dry_l, dry_r, m, t, 0.3, pan=0.5)
                place(wet_l, wet_r, m, t, 0.1, pan=0.5)
            else:
                place(dry_l, dry_r, tone(520, 0.1, a=0.002, d=0.08, partial=0.0), t, 0.13, pan=0.5)

        elif et == "finish":
            pos = int(ev.get("pos", 4))
            f = WIN_ROOT * (2.0 ** ((0 if pos == 1 else -pos) / 12.0)) * (2 if pos == 1 else 1)
            m = tone(f, 0.7, a=0.004, d=0.62, curve=2.4, partial=0.35)
            place(dry_l, dry_r, m, t, 0.12 if pos == 1 else 0.07, pan=0.5)
            place(wet_l, wet_r, m, t, 0.07, pan=0.5)

        elif et == "win":
            for k, s in enumerate((0, 4, 7, 12, 16)):
                m = tone(WIN_ROOT * 2 ** (s / 12.0), 0.8 - k * 0.06, a=0.006, d=0.7 - k * 0.06, curve=2.2, partial=0.3)
                place(dry_l, dry_r, m, t + k * 0.09, 0.09 - k * 0.008, pan=0.5)
                place(wet_l, wet_r, m, t + k * 0.09, 0.06, pan=0.5)
            place(dry_l, dry_r, tone(WIN_ROOT / 2, 1.3, a=0.02, d=1.1, partial=0.0), t, 0.08, pan=0.5)

        if i % 200 == 0:
            progress(0.05 + 0.8 * (i / max(1, len(events))), "voicing events")

    progress(0.9, "mixing")
    dry_l += plate(wet_l) * 0.6
    dry_r += plate(wet_r) * 0.6

    def master(ch):
        ch = compress(ch, thresh=0.28, ratio=3.2)
        ch = lp(ch, 6500.0)
        ch = ch - 0.32 * hp(ch, 3400.0)
        ch = soft_limit(ch, 0.62)
        return ch

    stereo = np.stack([master(dry_l), master(dry_r)], axis=1)
    peak = float(np.max(np.abs(stereo)))
    if peak > 0.66:
        stereo *= 0.66 / peak
    sf.write(args.out, stereo.astype(np.float32), SR)
    log(f"colorrace_audio: {len(events)} events {dict(sorted(n_by.items()))} -> {args.out} ({args.duration:.1f}s)")
    progress(1.0, "done")


if __name__ == "__main__":
    main()
