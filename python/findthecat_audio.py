"""Synthesise the "Find The Cat" soundtrack — the Follow The Ball alt-variant
content type (render/findthecat/game.js).

The render logs one event per sound (swap / tick / reveal) — the README's own
suggested SFX list: "swoosh SFX per swap, tick per countdown number, pop on
reveal." swap/tick/pop are synthesised here in the same oscillator+envelope
style as followball_audio.py. The reveal ALSO layers in the real
cat-laugh-meme-1.wav clip verbatim -- a narrow, deliberate exception to the
"always synthesise" rule, same one documented in colorwars/colorwars/audio/
clips.py: the whole point of this cue is a specific, recognizable meme clip,
not a procedural approximation of a cat laughing.

  python findthecat_audio.py --events frames/events.json --duration 21 --out ftc.wav
"""

import argparse
import json
import sys
import wave
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48000
MASTER = 0.3
CLIP_PATH = Path(__file__).resolve().parents[1] / "assets" / "findthecat-sfx" / "cat-laugh-meme-1.wav"

_NOISE = np.random.default_rng(0xCA7).uniform(-1.0, 1.0, int(SR * 0.6)).astype(np.float32)


def log(m):
    sys.stderr.write(str(m).rstrip() + "\n"); sys.stderr.flush()


def progress(pct, msg=""):
    sys.stderr.write("@progress " + json.dumps({"pct": max(0.0, min(1.0, float(pct))), "msg": msg}) + "\n")
    sys.stderr.flush()


def load_clip(path: Path, sample_rate: int) -> np.ndarray:
    """Loads a pre-trimmed, pre-converted-to-this-project's-sample-rate WAV
    verbatim as a (n, 2) float32 array in -1..1. See the module docstring --
    this is the one place in this script that plays a real sample instead of
    synthesising."""
    with wave.open(str(path), "rb") as wf:
        if wf.getframerate() != sample_rate:
            raise ValueError(
                f"{path} is {wf.getframerate()}Hz, not {sample_rate}Hz -- re-render the asset at the "
                f"project's sample rate instead of resampling at playback time."
            )
        channels = wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels == 1:
        return np.repeat(pcm[:, None], 2, axis=1)
    return pcm.reshape(-1, channels)[:, :2]


def osc(kind, freq, n):
    ph = 2 * np.pi * np.arange(n) * float(freq) / SR
    if kind == "sine":
        return np.sin(ph).astype(np.float32)
    if kind == "triangle":
        return (2.0 / np.pi * np.arcsin(np.sin(ph))).astype(np.float32)
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


def noise(dur):
    n = int(SR * dur)
    if n <= len(_NOISE):
        return _NOISE[:n].copy()
    return np.tile(_NOISE, int(np.ceil(n / len(_NOISE))))[:n].copy()


# ── voices ───────────────────────────────────────────────────────────────
def v_swap(hz, speed):
    """A quick swoosh: a short filtered-feeling tone blip (triangle, so it
    reads brighter/airier than a pure sine) plus a breath of noise whose
    level tracks how fast this particular swap is."""
    body = venv(osc("triangle", hz, int(SR * 0.09)), 0.22, 0.004, 0.06)
    air = venv(noise(0.1), 0.16 + 0.1 * speed, 0.003, 0.07)
    n = max(len(body), len(air))
    out = np.zeros(n, np.float32)
    out[: len(body)] += body
    out[: len(air)] += air
    return out


def v_tick(hot):
    freq = 1500.0 if hot else 1100.0
    peak = 0.22 if hot else 0.16
    return venv(osc("sine", freq, int(SR * 0.09)), peak, 0.004, 0.06)


def v_pop():
    """A bright three-note rising arpeggio -- the "ta-da" sting right as the
    winning cup starts lifting, landing just ahead of the real laugh clip."""
    parts = []
    for k, st in enumerate((0, 4, 7)):
        seg = venv(osc("triangle", 440 * 2 ** (st / 12.0), int(SR * 0.3)), 0.3, 0.006, 0.2)
        pad = np.zeros(int(SR * k * 0.045), np.float32)
        parts.append(np.concatenate([pad, seg]))
    n = max(len(p) for p in parts)
    out = np.zeros(n, np.float32)
    for p in parts:
        out[: len(p)] += p
    return out


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

    n = int(SR * (args.duration + 2.0))
    direct = np.zeros(n, np.float32)     # swap / tick / pop -- synthesised, scaled by MASTER
    clip_bus = np.zeros((n, 2), np.float32)   # the real laugh clip, kept at its own level

    clip = load_clip(CLIP_PATH, SR) if CLIP_PATH.exists() else None
    if clip is None:
        log(f"findthecat_audio: WARNING {CLIP_PATH} missing -- reveal will have no laugh clip")

    n_by = {}
    for i, ev in enumerate(events):
        et = ev.get("type")
        at = max(0.0, (ev.get("f", ev.get("t", 0.0) * fps) - 1.5) / fps)
        n_by[et] = n_by.get(et, 0) + 1
        p = int(at * SR)
        if et == "swap":
            sig = v_swap(float(ev.get("hz", 500.0)), float(ev.get("speed", 0.5)))
            e = min(n, p + len(sig))
            if p < n and e > p:
                direct[p:e] += sig[: e - p]
        elif et == "tick":
            sig = v_tick(bool(ev.get("hot")))
            e = min(n, p + len(sig))
            if p < n and e > p:
                direct[p:e] += sig[: e - p]
        elif et == "reveal":
            sig = v_pop()
            e = min(n, p + len(sig))
            if p < n and e > p:
                direct[p:e] += sig[: e - p]
            if clip is not None:
                cp = int((at + 0.08) * SR)
                ce = min(n, cp + len(clip))
                if cp < n and ce > cp:
                    clip_bus[cp:ce] += clip[: ce - cp] * 0.85
        if i % 20 == 0:
            progress(0.05 + 0.85 * (i / max(1, len(events))), "synthesising voices")

    progress(0.92, "mixing")
    direct_stereo = np.stack([direct, direct], axis=1).astype(np.float32) * MASTER
    mixed = direct_stereo + clip_bus
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.99:
        mixed *= 0.99 / peak
    sf.write(args.out, mixed, SR)
    log(f"findthecat_audio: {len(events)} events {dict(sorted(n_by.items()))} -> {args.out} ({args.duration:.1f}s)")
    progress(1.0, "done")


if __name__ == "__main__":
    main()
