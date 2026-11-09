"""Synthesise the "Eye Test" soundtrack — an offline rebuild of the game's
restrained Web Audio voices, matching the RBJ-cookbook biquad math (identical
to Web Audio's BiquadFilterNode) and mixing philosophy already established by
python/colorwar_audio.py and python/followball_audio.py in this repo: short
one-shot envelopes (nothing loops or sustains — no drone), a fixed-seed noise
buffer so renders are byte-stable, gentle overall level.

The render logs one event per sound (target-shown / lock / near-miss / freeze
/ reveal-fanfare / finish). Voices are placed by their absolute FRAME index
((f - 1.5)/fps), which lands the transient on the frame the visual beat is
drawn.

  python eyetest_audio.py --events frames/events.json --duration 19 --out et.wav
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import lfilter, lfilter_zi

SR = 48000
MASTER = 0.26

_NOISE = np.random.default_rng(0xE1E7E5).uniform(-1.0, 1.0, int(SR * 0.5)).astype(np.float32)


def log(m):
    sys.stderr.write(str(m).rstrip() + "\n"); sys.stderr.flush()


def progress(pct, msg=""):
    sys.stderr.write("@progress " + json.dumps({"pct": max(0.0, min(1.0, float(pct))), "msg": msg}) + "\n")
    sys.stderr.flush()


# ── oscillators (cumsum-phase, so swept frequencies are exact) ─────────────
def osc(kind, freq_env, n):
    f = np.full(n, float(freq_env), np.float64) if np.isscalar(freq_env) else np.asarray(freq_env[:n], np.float64)
    if len(f) < n:
        f = np.concatenate([f, np.full(n - len(f), f[-1])])
    ph = 2 * np.pi * np.cumsum(f) / SR
    if kind == "sine":
        return np.sin(ph).astype(np.float32)
    if kind == "triangle":
        return (2.0 / np.pi * np.arcsin(np.sin(ph))).astype(np.float32)
    raise ValueError(kind)


def lin_ramp(v0, v1, dur):
    n = max(1, int(SR * dur))
    return np.linspace(v0, v1, n)


# ── shared envelope (same shape as colorwar/followball's): linRamp -> peak,
# expRamp -> near-zero, linRamp -> 0. Nothing is ever cut while still audible. ──
def env_curve(peak, atk, dec):
    na = max(1, int(SR * atk))
    nd = max(1, int(SR * dec))
    nz = max(1, int(SR * 0.02))
    a = np.linspace(0.0001, peak, na)
    b = peak * (0.0008 / max(peak, 1e-9)) ** np.linspace(0.0, 1.0, nd)
    c = np.linspace(b[-1], 0.0, nz)
    return np.concatenate([a, b, c]).astype(np.float32)


def venv(sig, peak, atk, dec):
    e = env_curve(peak, atk, dec)
    n = len(e)
    if len(sig) < n:
        sig = np.concatenate([sig, np.zeros(n - len(sig), np.float32)])
    return (sig[:n] * e).astype(np.float32)


# ── RBJ Audio-EQ-Cookbook biquad — identical to Web Audio's BiquadFilterNode ──
def _rbj(kind, f0, q):
    f0 = float(np.clip(f0, 10.0, SR * 0.49))
    w0 = 2 * np.pi * f0 / SR
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2 * max(q, 1e-4))
    if kind == "lowpass":
        b = np.array([(1 - cw) / 2, 1 - cw, (1 - cw) / 2])
        a = np.array([1 + alpha, -2 * cw, 1 - alpha])
    elif kind == "highpass":
        b = np.array([(1 + cw) / 2, -(1 + cw), (1 + cw) / 2])
        a = np.array([1 + alpha, -2 * cw, 1 - alpha])
    elif kind == "bandpass":
        b = np.array([alpha, 0.0, -alpha])
        a = np.array([1 + alpha, -2 * cw, 1 - alpha])
    else:
        raise ValueError(kind)
    return b / a[0], np.array([1.0, a[1] / a[0], a[2] / a[0]])


def bq(x, kind, f0, f1, dur, q=1.0):
    """One biquad whose centre frequency sweeps f0 -> f1 (linear) over `dur`,
    then holds. Filter state carried across sub-blocks — no restart clicks."""
    n = len(x)
    if abs(f1 - f0) < 0.5:
        b, a = _rbj(kind, f0, q)
        return lfilter(b, a, x).astype(np.float32)
    ramp_n = max(1, int(SR * dur))
    out = np.zeros(n, np.float32)
    zi = None
    nblk = 24
    for k in range(nblk):
        i0 = k * n // nblk
        i1 = (k + 1) * n // nblk
        if i1 <= i0:
            continue
        frac = min(1.0, i0 / ramp_n)
        fc = f0 + (f1 - f0) * frac
        b, a = _rbj(kind, fc, q)
        if zi is None:
            zi = lfilter_zi(b, a) * float(x[i0])
        y, zi = lfilter(b, a, x[i0:i1], zi=zi)
        out[i0:i1] = y
    return out.astype(np.float32)


def noise(dur, rate=1.0):
    n = int(SR * dur)
    if rate == 1.0:
        src = _NOISE
    else:
        idx = np.clip((np.arange(int(n * 1.4)) * rate).astype(int), 0, len(_NOISE) - 1)
        src = _NOISE[idx]
    if n <= len(src):
        return src[:n].copy()
    return np.tile(src, int(np.ceil(n / len(src))))[:n].copy()


# ── voices ──────────────────────────────────────────────────────────────
def v_target_shown():
    parts = []
    for k, st in enumerate((0, 5)):
        seg = venv(osc("sine", 440 * 2 ** (st / 12.0), int(SR * 0.34)), 0.2, 0.014, 0.26)
        pad = np.zeros(int(SR * k * 0.08), np.float32)
        parts.append(np.concatenate([pad, seg]))
    n = max(len(p) for p in parts)
    out = np.zeros(n, np.float32)
    for p in parts:
        out[:len(p)] += p
    return out


def v_lock():
    # a soft mechanical click — camera-autofocus-confirm feel. Reused
    # identically at the intro highlight AND the reveal for acoustic symmetry
    # (matching the visual symmetry of drawHighlight()/viewfinder()).
    s = venv(bq(noise(0.06), "bandpass", 2600, 2600, 0.0, q=2.2), 0.16, 0.004, 0.05)
    return s


def v_near_miss():
    # a brief pitch-swept whoosh (Doppler-pass feel), rate-gated 1:1 with the
    # visual convergence events in game.js.
    s = noise(0.24, 1.3)
    w = bq(s, "bandpass", 1400, 700, 0.22, q=0.7)
    return venv(w, 0.07, 0.02, 0.2)


def v_freeze():
    # one soft, low, SHORT damped thump — not a drone. Decays within ~0.34s.
    return venv(osc("sine", 110.0, int(SR * 0.34)), 0.12, 0.01, 0.3)


def v_reveal_fanfare():
    parts = []
    for k, st in enumerate((0, 4, 7, 12)):
        seg = venv(osc("triangle", 349 * 2 ** (st / 12.0), int(SR * 0.46)), 0.22, 0.014, 0.4)
        pad = np.zeros(int(SR * k * 0.05), np.float32)
        parts.append(np.concatenate([pad, seg]))
    n = max(len(p) for p in parts)
    out = np.zeros(n, np.float32)
    for p in parts:
        out[:len(p)] += p
    return out


def v_finish():
    parts = []
    for k, st in enumerate((0, 4, 7, 12, 16)):
        seg = venv(osc("triangle", 262 * 2 ** (st / 12.0), int(SR * 0.7)), 0.25, 0.016, 0.5)
        pad = np.zeros(int(SR * k * 0.08), np.float32)
        parts.append(np.concatenate([pad, seg]))
    n = max(len(p) for p in parts)
    out = np.zeros(n, np.float32)
    for p in parts:
        out[:len(p)] += p
    return out


def place(bus, sig, at, gain=1.0):
    p = int(at * SR)
    if p < 0 or p >= len(bus):
        return
    e = min(len(bus), p + len(sig))
    bus[p:e] += sig[: e - p] * gain


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.events) as fh:
        blob = json.load(fh)
    events = blob.get("events", [])
    fps = float(blob.get("fps", 60.0))

    n = int(SR * (args.duration + 1.2))
    bus = np.zeros(n, np.float32)

    n_by = {}
    for i, ev in enumerate(events):
        et = ev.get("type")
        at = max(0.0, (ev.get("f", ev.get("t", 0.0) * fps) - 1.5) / fps)
        n_by[et] = n_by.get(et, 0) + 1
        if et == "target-shown":
            place(bus, v_target_shown(), at)
        elif et == "lock":
            place(bus, v_lock(), at)
        elif et == "near-miss":
            place(bus, v_near_miss(), at)
        elif et == "freeze":
            place(bus, v_freeze(), at)
        elif et == "reveal-fanfare":
            place(bus, v_reveal_fanfare(), at)
        elif et == "finish":
            place(bus, v_finish(), at)
        if i % 20 == 0:
            progress(0.05 + 0.85 * (i / max(1, len(events))), "synthesising voices")

    progress(0.92, "mixing")
    mixed = bus * MASTER
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.99:
        mixed *= 0.99 / peak
    stereo = np.stack([mixed, mixed], axis=1).astype(np.float32)
    sf.write(args.out, stereo, SR)
    log(f"eyetest_audio: {len(events)} events {dict(sorted(n_by.items()))} -> {args.out} ({args.duration:.1f}s)")
    progress(1.0, "done")


if __name__ == "__main__":
    main()
