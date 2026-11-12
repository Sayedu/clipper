"""Synthesise the "Pause Game" soundtrack — an offline rebuild of the game's
restrained Web Audio voice, matching the RBJ-cookbook/envelope conventions
established by python/eyetest_audio.py and the other *_audio.py scripts in
this repo: short one-shot envelopes (nothing loops or sustains), gentle
overall level.

The render logs one event per sound: `zone-enter`, fired each time the
needle crosses from outside into the green win margin (not every frame it's
inside — only the crossing). Voices are placed by their absolute FRAME index
((f - 1.5)/fps), which lands the transient on the frame the visual beat (the
needle snapping to green) is drawn.

  python pausegame_audio.py --events frames/events.json --duration 11 --out pg.wav
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf

SR = 48000
MASTER = 0.3


def log(m):
    sys.stderr.write(str(m).rstrip() + "\n"); sys.stderr.flush()


def progress(pct, msg=""):
    sys.stderr.write("@progress " + json.dumps({"pct": max(0.0, min(1.0, float(pct))), "msg": msg}) + "\n")
    sys.stderr.flush()


def osc(kind, freq, n):
    f = np.full(n, float(freq), np.float64)
    ph = 2 * np.pi * np.cumsum(f) / SR
    if kind == "sine":
        return np.sin(ph).astype(np.float32)
    raise ValueError(kind)


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


# a crisp two-note bright chime -- the needle just snapped to green
def v_zone_enter():
    parts = []
    for k, st in enumerate((0, 7)):
        seg = venv(osc("sine", 660 * 2 ** (st / 12.0), int(SR * 0.2)), 0.18, 0.006, 0.14)
        pad = np.zeros(int(SR * k * 0.03), np.float32)
        parts.append(np.concatenate([pad, seg]))
    n = max(len(p) for p in parts)
    out = np.zeros(n, np.float32)
    for p in parts:
        out[: len(p)] += p
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

    n = int(SR * (args.duration + 0.4))
    bus = np.zeros(n, np.float32)

    count = 0
    for i, ev in enumerate(events):
        if ev.get("type") == "zone-enter":
            at = max(0.0, (ev.get("f", 0) - 1.5) / fps)
            place(bus, v_zone_enter(), at)
            count += 1
        if i % 10 == 0:
            progress(0.05 + 0.85 * (i / max(1, len(events))), "synthesising voices")

    progress(0.92, "mixing")
    mixed = bus * MASTER
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.99:
        mixed *= 0.99 / peak
    stereo = np.stack([mixed, mixed], axis=1).astype(np.float32)
    sf.write(args.out, stereo, SR)
    log(f"pausegame_audio: {count} zone-enter events -> {args.out} ({args.duration:.1f}s)")
    progress(1.0, "done")


if __name__ == "__main__":
    main()
