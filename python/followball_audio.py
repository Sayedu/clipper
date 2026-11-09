"""Synthesise the "Follow the ball" soundtrack — an offline rebuild of the
design's Web Audio graph (Follow The Ball handoff/SPEC.md §6 + the .dc.html
sfx* methods).

The render logs one event per sound (swap / reveal / tick / answer / finish).
This rebuilds each voice with the same oscillators, the shared SPEC §6 envelope
(no attack under 6ms, nothing stopped while audible) and RBJ-cookbook biquads
(the exact math Web Audio's BiquadFilterNode uses), sums them through the two
buses — swap/reveal/tick -> duck -> master 0.28; answer chord + finish fanfare
-> master direct — and applies the answer's momentary duck. Voices are placed by
their absolute FRAME index ((f - 1.5)/fps), which lands the transient on the
frame the visual beat is drawn.

  python followball_audio.py --events frames/events.json --duration 19 --out ftb.wav
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import lfilter, lfilter_zi

SR = 48000
MASTER = 0.28

# fixed-seed noise so renders are byte-stable (SPEC §6 uses a live 0.5s buffer)
_NOISE = np.random.default_rng(0xF0110B).uniform(-1.0, 1.0, int(SR * 0.6)).astype(np.float32)
_RNG = np.random.default_rng(0xBA11)   # for the swap-air playbackRate jitter


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


# ── SPEC §6 shared envelope ──────────────────────────────────────────────
# gain 0.0001 @ at; linRamp -> peak by at+atk; expRamp -> 0.0008 by at+atk+dec;
# linRamp -> 0 by at+atk+dec+0.02. Total length atk+dec+0.06 (a hair of tail).
def env_curve(peak, atk, dec):
    na = max(1, int(SR * atk))
    nd = max(1, int(SR * dec))
    nz = max(1, int(SR * 0.02))
    a = np.linspace(0.0001, peak, na)                                   # linRamp -> peak
    b = peak * (0.0008 / max(peak, 1e-9)) ** np.linspace(0.0, 1.0, nd)  # expRamp -> 0.0008
    c = np.linspace(b[-1], 0.0, nz)                                     # linRamp -> 0
    return np.concatenate([a, b, c]).astype(np.float32)


def venv(sig, peak, atk, dec):
    """Apply the shared envelope to `sig`, trimming/padding to the env length."""
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
    elif kind == "bandpass":            # Web Audio "bandpass": constant 0 dB peak
        b = np.array([alpha, 0.0, -alpha])
        a = np.array([1 + alpha, -2 * cw, 1 - alpha])
    else:
        raise ValueError(kind)
    return b / a[0], np.array([1.0, a[1] / a[0], a[2] / a[0]])


def bq(x, kind, f0, f1, dur, q=1.0):
    """One biquad whose centre frequency sweeps f0 -> f1 (linear, like Web Audio's
    linearRampToValueAtTime) over `dur`, then holds. Filter STATE carried across
    32 sub-blocks so there are no restart clicks. f0 == f1 is a static filter."""
    n = len(x)
    if abs(f1 - f0) < 0.5:
        b, a = _rbj(kind, f0, q)
        return lfilter(b, a, x).astype(np.float32)
    ramp_n = max(1, int(SR * dur))
    out = np.zeros(n, np.float32)
    zi = None
    nblk = 32
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


# ── voices — 1:1 with the .dc.html sfxSwap / sfxReveal / sfxTick / sfxAnswer / sfxFinish ──
def v_swap(hz, speed):
    body_n = int(SR * 0.35)
    o = osc("sine", hz, body_n)
    o2 = osc("triangle", hz * 2, body_n) * 0.24
    body = bq(o + o2, "lowpass", 2200 + speed * 1400, 2200 + speed * 1400, 0.0, q=0.9)
    body = venv(body, 0.30, 0.012, 0.26)
    air_n = int(SR * 0.22)
    rate = float(_RNG.uniform(0.8, 1.2))
    air = bq(noise(0.22, rate), "bandpass",
             900 + speed * 700, 1800 + speed * 900, 0.1, q=0.8)
    air = venv(air, 0.045, 0.03, 0.1)
    out = np.zeros(len(body), np.float32)
    out += body
    out[:len(air)] += air
    return out


def v_reveal():
    parts = []
    for k, st in enumerate((0, 7)):
        seg = venv(osc("sine", 392 * 2 ** (st / 12.0), int(SR * 0.4)), 0.22, 0.014, 0.30)
        pad = np.zeros(int(SR * k * 0.07), np.float32)
        parts.append(np.concatenate([pad, seg]))
    n = max(len(p) for p in parts)
    out = np.zeros(n, np.float32)
    for p in parts:
        out[:len(p)] += p
    return out


def v_tick(hot):
    f0, f1 = (1100, 980) if hot else (740, 680)
    peak = 0.10 if hot else 0.07
    g = np.concatenate([lin_ramp(f0, f1, 0.07), np.full(int(SR * 0.1), f1)])
    return venv(osc("sine", g, int(SR * 0.17)), peak, 0.008, 0.08)


def v_answer():
    parts = []
    for k, st in enumerate((0, 4, 7, 12)):
        seg = venv(osc("triangle", 349 * 2 ** (st / 12.0), int(SR * 0.6)), 0.24, 0.014, 0.46)
        pad = np.zeros(int(SR * k * 0.04), np.float32)
        parts.append(np.concatenate([pad, seg]))
    n = max(len(p) for p in parts)
    chord = np.zeros(n, np.float32)
    for p in parts:
        chord[:len(p)] += p
    hpn = venv(bq(noise(0.18), "highpass", 4600, 4600, 0.0), 0.09, 0.01, 0.10)
    out = chord.copy()
    out[:len(hpn)] += hpn
    return out


def v_finish():
    parts = []
    for k, st in enumerate((0, 4, 7, 12, 16)):
        seg = venv(osc("triangle", 262 * 2 ** (st / 12.0), int(SR * 0.7)), 0.27, 0.016, 0.54)
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
    ap.add_argument("--sfx-dir", default=None)   # accepted, unused — synthesis path
    args = ap.parse_args()

    with open(args.events) as fh:
        blob = json.load(fh)
    events = blob.get("events", [])
    fps = float(blob.get("fps", 60.0))

    n = int(SR * (args.duration + 1.6))
    duckbus = np.zeros(n, np.float32)     # swap / reveal / tick -> duck
    direct = np.zeros(n, np.float32)      # answer chord + finish fanfare -> master direct
    duck_gain = np.ones(n, np.float32)

    last_swap = -9.0
    n_by = {}
    for i, ev in enumerate(events):
        et = ev.get("type")
        at = max(0.0, (ev.get("f", ev.get("t", 0.0) * fps) - 1.5) / fps)
        n_by[et] = n_by.get(et, 0) + 1
        if et == "swap":
            if at - last_swap < 0.045:            # SPEC §6 rate gate (recorder already gates; belt+braces)
                continue
            last_swap = at
            place(duckbus, v_swap(float(ev["hz"]), float(ev.get("speed", 0.5))), at)
        elif et == "reveal":
            place(duckbus, v_reveal(), at)
        elif et == "tick":
            place(duckbus, v_tick(bool(ev.get("hot"))), at)
        elif et == "answer":
            place(direct, v_answer(), at)
            # SPEC §6: duck 0.5 held 60ms -> linear back to 1 by 300ms
            p = int(at * SR)
            hold = int(SR * 0.06); ramp = int(SR * 0.24)
            if 0 <= p < n:
                duck_gain[p:min(n, p + hold)] = np.minimum(duck_gain[p:min(n, p + hold)], 0.5)
                seg = min(n, p + hold + ramp) - (p + hold)
                if seg > 0:
                    duck_gain[p + hold:p + hold + seg] = np.minimum(
                        duck_gain[p + hold:p + hold + seg], np.linspace(0.5, 1.0, seg))
        elif et == "finish":
            place(direct, v_finish(), at)
        if i % 40 == 0:
            progress(0.05 + 0.85 * (i / max(1, len(events))), "synthesising voices")

    progress(0.92, "mixing")
    # SPEC §6 graph: (duck voices * duck_gain + direct) * master(0.28)
    mixed = (duckbus * duck_gain + direct) * MASTER
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.99:
        mixed *= 0.99 / peak
    stereo = np.stack([mixed, mixed], axis=1).astype(np.float32)
    sf.write(args.out, stereo, SR)
    log(f"followball_audio: {len(events)} events {dict(sorted(n_by.items()))} -> {args.out} ({args.duration:.1f}s)")
    progress(1.0, "done")


if __name__ == "__main__":
    main()
