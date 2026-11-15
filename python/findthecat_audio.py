"""Synthesise the "Find The Cat" soundtrack — the Follow The Ball alt-variant
content type (render/findthecat/game.js).

The render logs one event per sound, each synced to a real on-screen event:
  land    a cup touching down (the intro drop-in, the show cup coming back
          down, the end of every swap) — a short soft wooden tok
  swap    a cup swap starting — a quick swoosh on a walking pentatonic note
  tick    each 3-2-1 countdown beat
  riser   a tension sweep from the last countdown beat into the reveal
  reveal  the winning cup lifting — a bright pop sting, plus (unless
          --no-clip) the real cat-laugh-meme-1.wav clip

Everything except that one clip is synthesised here. The clip is a
narrow, deliberate exception (same one documented in colorwars/colorwars/
audio/clips.py): it was supplied by the user and its licence is unknown,
so --no-clip renders an SFX-only mix made 100% from self-generated sound,
for posting with a TikTok sound added in the app instead.

Every voice gets a small deterministic pitch variation (hashed from the
event's frame index) so repeated sounds don't feel copy-pasted, while the
same render still always produces the identical audio.

  python findthecat_audio.py --events frames/events.json --duration 21 --out ftc.wav [--no-clip]
"""

import argparse
import json
import sys
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import lfilter

SR = 48000
MASTER = 0.3
CLIP_GAIN = 0.2  # was 0.85, then 0.5, then 0.3 — too loud right as the cat is shown
CLIP_PATH = Path(__file__).resolve().parents[1] / "assets" / "findthecat-sfx" / "cat-laugh-meme-1.wav"

_NOISE = np.random.default_rng(0xCA7).uniform(-1.0, 1.0, int(SR * 2.0)).astype(np.float32)


def log(m):
    sys.stderr.write(str(m).rstrip() + "\n"); sys.stderr.flush()


def progress(pct, msg=""):
    sys.stderr.write("@progress " + json.dumps({"pct": max(0.0, min(1.0, float(pct))), "msg": msg}) + "\n")
    sys.stderr.flush()


def load_clip(path: Path, sample_rate: int) -> np.ndarray:
    """Loads a pre-trimmed, pre-converted-to-this-project's-sample-rate WAV
    verbatim as a (n, 2) float32 array in -1..1."""
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


def jitter(frame, spread):
    """Deterministic pitch multiplier in [1 - spread, 1 + spread], hashed
    from the event's frame index."""
    h = ((int(frame) * 2654435761) & 0xFFFFFFFF) / 0xFFFFFFFF
    return 1.0 + (h * 2.0 - 1.0) * spread


def osc(kind, freq, n):
    ph = 2 * np.pi * np.arange(n) * float(freq) / SR
    if kind == "sine":
        return np.sin(ph).astype(np.float32)
    if kind == "triangle":
        return (2.0 / np.pi * np.arcsin(np.sin(ph))).astype(np.float32)
    raise ValueError(kind)


def sweep(f0, f1, n):
    """Exponential frequency sweep (cumsum phase, so it's click-free)."""
    f = f0 * (f1 / f0) ** np.linspace(0.0, 1.0, n)
    return np.sin(2 * np.pi * np.cumsum(f) / SR).astype(np.float32)


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


def lowpass(x, cutoff):
    """One-pole lowpass — enough to turn white noise into a soft thud body."""
    a = np.exp(-2 * np.pi * cutoff / SR)
    return lfilter([1 - a], [1, -a], x).astype(np.float32)


# ── voices ───────────────────────────────────────────────────────────────
def v_land(soft, j):
    """A cup touching the table: a short low sine knock plus a breath of
    filtered noise. Swap landings (soft) are quieter than the intro drop."""
    knock = venv(osc("sine", 150.0 * j, int(SR * 0.06)), 0.10 if soft else 0.18, 0.002, 0.045)
    body = venv(lowpass(noise(0.05), 900.0), 0.12 if soft else 0.2, 0.001, 0.03)
    n = max(len(knock), len(body))
    out = np.zeros(n, np.float32)
    out[: len(knock)] += knock
    out[: len(body)] += body
    return out


def v_swap(hz, speed, j):
    """A quick swoosh: a triangle blip on the walking-scale note plus a
    breath of noise whose level tracks how fast this particular swap is."""
    body = venv(osc("triangle", hz * j, int(SR * 0.09)), 0.22, 0.004, 0.06)
    air = venv(noise(0.1), 0.16 + 0.1 * speed, 0.003, 0.07)
    n = max(len(body), len(air))
    out = np.zeros(n, np.float32)
    out[: len(body)] += body
    out[: len(air)] += air
    return out


def v_tick(hot, j):
    freq = (1500.0 if hot else 1100.0) * j
    peak = 0.22 if hot else 0.16
    return venv(osc("sine", freq, int(SR * 0.09)), peak, 0.004, 0.06)


def v_riser(dur):
    """Tension into the reveal: a rising sine sweep under rising noise,
    swelling from silence and cut clean right as the cup lifts."""
    n = max(1, int(SR * dur))
    tone = sweep(180.0, 760.0, n)
    hiss = lowpass(noise(dur), 2500.0)[:n]
    swell = np.linspace(0.0, 1.0, n) ** 2
    out = (tone * 0.16 + hiss * 0.35) * swell
    fade = min(n, int(SR * 0.012))
    out[-fade:] *= np.linspace(1.0, 0.0, fade)
    return out.astype(np.float32)


def v_pop(j, final):
    """A bright rising arpeggio — the winner sting as the cup lifts. The
    last round of the video gets one extra note."""
    notes = (0, 4, 7, 12) if final else (0, 4, 7)
    parts = []
    for k, st in enumerate(notes):
        seg = venv(osc("triangle", 440 * j * 2 ** (st / 12.0), int(SR * 0.3)), 0.3, 0.006, 0.2)
        pad = np.zeros(int(SR * k * 0.045), np.float32)
        parts.append(np.concatenate([pad, seg]))
    n = max(len(p) for p in parts)
    out = np.zeros(n, np.float32)
    for p in parts:
        out[: len(p)] += p
    return out


def add(bus, sig, p):
    n = len(bus)
    e = min(n, p + len(sig))
    if 0 <= p < n and e > p:
        bus[p:e] += sig[: e - p]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-clip", action="store_true", help="SFX-only mix: skip the cat laugh clip")
    args = ap.parse_args()

    with open(args.events) as fh:
        blob = json.load(fh)
    events = blob.get("events", [])
    fps = float(blob.get("fps", 60.0))

    n = int(SR * (args.duration + 2.0))
    direct = np.zeros(n, np.float32)          # synthesised voices, scaled by MASTER
    clip_bus = np.zeros((n, 2), np.float32)   # the real laugh clip, kept at its own level

    clip = None
    if not args.no_clip:
        clip = load_clip(CLIP_PATH, SR) if CLIP_PATH.exists() else None
        if clip is None:
            log(f"findthecat_audio: WARNING {CLIP_PATH} missing -- reveal will have no laugh clip")

    n_by = {}
    for i, ev in enumerate(events):
        et = ev.get("type")
        f = ev.get("f", ev.get("t", 0.0) * fps)
        at = max(0.0, (f - 1.5) / fps)
        n_by[et] = n_by.get(et, 0) + 1
        p = int(at * SR)
        if et == "land":
            add(direct, v_land(bool(ev.get("soft")), jitter(f, 0.08)), p)
        elif et == "swap":
            add(direct, v_swap(float(ev.get("hz", 500.0)), float(ev.get("speed", 0.5)), jitter(f, 0.012)), p)
        elif et == "tick":
            add(direct, v_tick(bool(ev.get("hot")), jitter(f, 0.02)), p)
        elif et == "riser":
            add(direct, v_riser(float(ev.get("dur", 1.5))), p)
        elif et == "reveal":
            add(direct, v_pop(jitter(f, 0.03), bool(ev.get("final"))), p)
            if clip is not None:
                cp = int((at + 0.08) * SR)
                ce = min(n, cp + len(clip))
                if cp < n and ce > cp:
                    clip_bus[cp:ce] += clip[: ce - cp] * CLIP_GAIN
        if i % 25 == 0:
            progress(0.05 + 0.85 * (i / max(1, len(events))), "synthesising voices")

    progress(0.92, "mixing")
    direct_stereo = np.stack([direct, direct], axis=1).astype(np.float32) * MASTER
    mixed = direct_stereo + clip_bus
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.99:
        mixed *= 0.99 / peak
    sf.write(args.out, mixed, SR)
    kind = "sfx-only" if args.no_clip else "full"
    log(f"findthecat_audio ({kind}): {len(events)} events {dict(sorted(n_by.items()))} -> {args.out} ({args.duration:.1f}s)")
    progress(1.0, "done")


if __name__ == "__main__":
    main()
