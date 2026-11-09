"""Synthesise the "Color war" soundtrack — an offline port of the design's
Web Audio graph (design_handoff_color_war/SPEC.md §11 + _extracted-logic.js).

The render logs one event per sound. This rebuilds each voice with the same
oscillators, exponential ramps and **RBJ-cookbook biquads** (the exact math a
Web Audio `BiquadFilterNode` uses), sums them through the same two buses
(flip/death -> duck -> master 0.26; bomb + win -> master direct — win bypasses
the duck so a coincident paint bomb can't duck the fanfare), and applies the
bomb's duck. Voices are placed by their absolute FRAME index (`(f - 1.5)/fps`),
which lands the transient on the frame the flash is drawn.

Two voices are deliberately tuned off SPEC §11 on the user's ask: the `bubble`
flip is pitched down a touch, band-limited and level-compensated on high notes
("less high pitch, sometimes gets loud"), and `bomb` has its bright triad
darkened and trimmed ("a bit less annoying"). Both changes are marked inline.

  python colorwar_audio.py --events frames/events.json --duration 40 --out war.wav
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import lfilter, lfilter_zi

SR = 48000
MASTER = 0.26

# shared 0.5 s white-noise buffer (SPEC §11) — fixed seed so renders are stable
_NOISE = np.random.default_rng(0x5eed).uniform(-1.0, 1.0, int(SR * 0.5)).astype(np.float32)


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
        y = np.sin(ph)
    elif kind == "triangle":
        y = 2.0 / np.pi * np.arcsin(np.sin(ph))
    elif kind == "sawtooth":
        y = 2.0 * (ph / (2 * np.pi) - np.floor(0.5 + ph / (2 * np.pi)))
    else:
        raise ValueError(kind)
    return y.astype(np.float32)


def exp_ramp(v0, v1, dur):
    """Web Audio exponentialRampToValueAtTime — geometric v0 -> v1 over dur."""
    n = max(1, int(SR * dur))
    v0 = max(abs(v0), 1e-9); v1 = max(abs(v1), 1e-9)
    return (v0 * (v1 / v0) ** np.linspace(0.0, 1.0, n)).astype(np.float64)


def gain_env(points, n):
    """points: [('set'|'lin'|'exp', value, time_s)] — piecewise AudioParam automation."""
    env = np.zeros(n, np.float64)
    cur = points[0][1]
    ti = 0
    prev_t = 0.0
    for kind, val, tt in points:
        end = min(n, ti + max(0, int(SR * (tt - prev_t))))
        if end > ti:
            if kind == "set":
                env[ti:end] = cur
            elif kind == "lin":
                env[ti:end] = np.linspace(cur, val, end - ti)
            else:
                a = max(abs(cur), 1e-9); b = max(abs(val), 1e-9)
                env[ti:end] = a * (b / a) ** np.linspace(0.0, 1.0, end - ti)
        cur = val
        ti = end
        prev_t = tt
    if ti < n:
        env[ti:] = cur
    return env.astype(np.float32)


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
    """One biquad whose centre frequency sweeps f0 -> f1 (exp) over `dur`, then
    holds. Processed in 32 sub-blocks with the filter STATE carried across them
    (no restart clicks) — the same thing a live time-varying BiquadFilterNode
    does. f0 == f1 is a plain static filter."""
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
        fc = f0 * (f1 / f0) ** frac
        b, a = _rbj(kind, fc, q)
        if zi is None:
            zi = lfilter_zi(b, a) * float(x[i0])
        y, zi = lfilter(b, a, x[i0:i1], zi=zi)
        out[i0:i1] = y
    return out.astype(np.float32)


def noise(dur):
    n = int(SR * dur)
    if n <= len(_NOISE):
        return _NOISE[:n].copy()
    return np.tile(_NOISE, int(np.ceil(n / len(_NOISE))))[:n].copy()


# ── voices — 1:1 with _extracted-logic.js sfxFlip / bubble / sfxBomb / sfxDeath / sfxWin ──
def v_pluck(hz):
    n = int(SR * 0.11)
    tri = osc("triangle", hz, n) * gain_env(
        [("set", 0.0, 0), ("lin", 0.5, 0.004), ("exp", 0.0008, 0.09)], n)
    n2 = int(SR * 0.06)
    sine = osc("sine", hz * 2.01, n2) * gain_env([("set", 0.18, 0), ("exp", 0.0006, 0.05)], n2)
    n3 = int(SR * 0.03)
    clk = bq(noise(0.03), "highpass", 3200, 3200, 0.03, q=1.0)   # Web Audio BiquadFilterNode.Q default is 1
    clk = clk * gain_env([("set", 0.10, 0), ("exp", 0.0005, 0.02)], n3)
    out = tri.copy()
    out[:n2] += sine
    out[:n3] += clk
    return out


def v_bubble(hz):
    n = int(SR * 0.1)
    # Design: sine glide 0.42hz -> hz -> 1.06hz through a Q5.5 bandpass. Web Audio
    # renders the glide topping out lower; tuned to bubble-*.wav (~0.72hz) then,
    # per the user, nudged ~1 semitone down + the band pulled in and the top end
    # rolled off ("a bit less high pitch"). `loud` pulls the LEVEL of the high
    # (fast-combo) notes down so a flurry doesn't stack up harsh + loud.
    loud = float(np.clip(230.0 / max(hz, 1.0), 0.62, 1.0))   # 1.0 @220Hz -> ~0.63 @296Hz
    fenv = np.concatenate([exp_ramp(hz * 0.41, hz * 0.70, 0.042), exp_ramp(hz * 0.70, hz * 0.74, 0.033)])
    o = osc("sine", fenv, n)
    o = bq(o, "bandpass", hz * 1.5, hz * 3.0, 0.06, q=5.5)
    o = o * gain_env([("set", 0.0001, 0), ("lin", 0.52 * loud, 0.006), ("exp", 0.0008, 0.085)], n)
    n2 = int(SR * 0.07)
    air = bq(noise(0.07), "bandpass", hz * 1.15, hz * 2.9, 0.05, q=2.2)
    air = air * gain_env([("set", 0.0001, 0), ("lin", 0.11 * loud, 0.008), ("exp", 0.0004, 0.055)], n2)
    out = o.copy()
    out[:n2] += air
    out = bq(out, "lowpass", 6500, 6500, 0.03, q=0.9)       # just clip the shrill top
    return out


def v_bomb():
    # SPEC §11.2 shape + full release, but darkened and pulled DOWN twice on the
    # user's ask ("a bit less annoying", then "a little less"): triad lowpass
    # 3400 -> 2700 Hz; thud 0.22 -> 0.16, sub 0.5 -> 0.36, triad bus 0.34 -> 0.25.
    # Centroid ~1730 -> ~665 Hz (near the design's paint-bomb.wav ~810). The duck
    # in main() is also softened so the "hole" it punches is gentler.
    total = int(SR * 0.54)
    out = np.zeros(total, np.float32)
    n1 = int(SR * 0.16)
    thud = bq(noise(0.16), "bandpass", 1450, 410, 0.13, q=1.1)
    thud = thud * gain_env([("set", 0.0001, 0), ("lin", 0.16, 0.008), ("exp", 0.0005, 0.14)], n1)
    out[:n1] += thud
    n2 = int(SR * 0.34)
    # a big sub sine on every bomb (and they fire ~1/s late game) just distorts
    # phone speakers, so it's the most trimmed component.
    sub = osc("sine", np.concatenate([exp_ramp(96, 36, 0.24), np.full(n2, 36.0)])[:n2], n2)
    sub = sub * gain_env([("set", 0.0001, 0), ("lin", 0.36, 0.01), ("exp", 0.001, 0.30)], n2)
    out[:n2] += sub
    root = 174.6
    triad = np.zeros(total, np.float32)
    for k, mul in enumerate((1.0, 1.25, 1.5, 2.0)):
        i0 = int(SR * (0.014 + k * 0.012))
        nv = int(SR * 0.48)
        v = osc("sine" if k == 3 else "triangle", root * mul, nv)
        g = gain_env([("set", 0.0001, 0), ("lin", 0.065 if k == 3 else 0.115, 0.02), ("exp", 0.0005, 0.46)], nv)
        end = min(total, i0 + nv)
        triad[i0:end] += (v * g)[: end - i0]
    triad = bq(triad, "lowpass", 1400, 2700, 0.12, q=1.0)
    triad = triad * gain_env([("set", 0.0001, 0), ("lin", 0.25, 0.05), ("exp", 0.0006, 0.5)], total)
    out += triad
    return out


def v_death():
    n = int(SR * 0.8)
    o = osc("sawtooth", np.concatenate([exp_ramp(620, 48, 0.7), np.full(n, 48.0)])[:n], n)
    o = bq(o, "lowpass", 2400, 300, 0.7, q=1.0)   # Web Audio Q default
    o = o * gain_env([("set", 0.34, 0), ("exp", 0.0006, 0.78)], n)
    return o


def v_win(base):
    total = int(SR * 0.75)
    out = np.zeros(total, np.float32)
    for k, st in enumerate((0, 4, 7, 12)):
        i0 = int(SR * k * 0.09)
        nv = int(SR * 0.44)
        v = osc("triangle", base * (2.0 ** (st / 12.0)), nv)
        g = gain_env([("set", 0.0, 0), ("lin", 0.36, 0.01), ("exp", 0.0006, 0.42)], nv)
        end = min(total, i0 + nv)
        out[i0:end] += (v * g)[: end - i0]
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

    n = int(SR * (args.duration + 1.5))
    duckbus = np.zeros(n, np.float32)     # flip / death -> duck
    direct = np.zeros(n, np.float32)      # bomb + win -> master direct (win bypasses the duck so a coincident bomb can't duck the fanfare)
    duck_gain = np.ones(n, np.float32)

    n_by = {}
    for i, ev in enumerate(events):
        et = ev.get("type")
        # place on the frame the flash is drawn: f_0000N.jpg shows at video-time
        # (N-1)/fps, and the collision happened mid-substep, so (f - 1.5)/fps
        # lands the transient right on the visible hit. (The sim's own `t`
        # resets to 0 at the end of the countdown, which is why it can't be
        # used directly — it's ~2.5 s behind the frame timeline.)
        at = max(0.0, (ev.get("f", ev.get("t", 0.0) * fps) - 1.5) / fps)
        n_by[et] = n_by.get(et, 0) + 1
        if et == "flip":
            sig = v_bubble(float(ev["hz"])) if ev.get("sound") == "bubble" else v_pluck(float(ev["hz"]))
            place(duckbus, sig, at)
        elif et == "death":
            place(duckbus, v_death(), at)
        elif et == "win":
            place(direct, v_win(float(ev.get("base", 220.0))), at)   # straight to master, bypassing the duck
        elif et == "bomb":
            place(direct, v_bomb(), at)
            # SPEC §11.2 step 4 is duck to 0.4; softened to 0.5 (user: "bomb a
            # little less") so the bomb moment is a gentler dip, not a hole.
            p = int(at * SR)
            hold = int(SR * 0.07); ramp = int(SR * 0.23)
            floor = 0.5
            if 0 <= p < n:
                duck_gain[p:min(n, p + hold)] = np.minimum(duck_gain[p:min(n, p + hold)], floor)
                seg = min(n, p + hold + ramp) - (p + hold)
                if seg > 0:
                    duck_gain[p + hold:p + hold + seg] = np.minimum(
                        duck_gain[p + hold:p + hold + seg], np.linspace(floor, 1.0, seg))
        if i % 200 == 0:
            progress(0.05 + 0.85 * (i / max(1, len(events))), "synthesising voices")

    progress(0.92, "mixing")
    # soft-knee ceiling on the flip/death bus only: a single bubble (~0.09) passes
    # through untouched, but a fast combo stacking 2-3 of them (~0.25-0.6) gets
    # rounded off instead of spiking — the user's "sometimes it gets a bit loud".
    # tanh is transparent well below the knee and never clips above it.
    knee = 0.42
    duckbus = knee * np.tanh(duckbus / knee)
    # SPEC §11 graph: (voices*duck + bomb) * master(0.26). No master filter in the
    # design — the worker's loudnorm sets the delivered level.
    mixed = (duckbus * duck_gain + direct) * MASTER
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.99:
        mixed *= 0.99 / peak
    stereo = np.stack([mixed, mixed], axis=1).astype(np.float32)
    sf.write(args.out, stereo, SR)
    log(f"colorwar_audio: {len(events)} events {dict(sorted(n_by.items()))} -> {args.out} ({args.duration:.1f}s)")
    progress(1.0, "done")


if __name__ == "__main__":
    main()
