"""Synthesise the "Laser Nations" soundtrack from the render's event log.

The brief: *relaxing*. No music bed, no pad — just soft, warm, heavily reverbed
music-box tones with lots of air around them, low-passed so nothing is ever
bright. When a lot is happening the mix ducks hard so it stays a gentle wash.

  * bounce -> a soft music-box note, C-major pentatonic, pitch drifts up with the
              match's pace; sparse (~6/s max), panned, long reverb tail
  * slice  -> a barely-there breath of air
  * speed  -> a slow warm upward swell
  * down   -> a soft, round low tone (a nation is knocked out)
  * vortex -> a deep, slow swell + a low drone bed for the black-hole finish
  * win    -> a gentle major arpeggio + a soft shimmer

Master = soft compression + a 5 kHz low-pass + a real high-shelf cut + a big
lush plate reverb. The worker loudnorm's the final mux to a quiet ~-24 LUFS.

  python lasernations_audio.py --events frames/events.json --duration 57.6 \
      --out lasernations.wav
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

SR = 44100

# C-major pentatonic, 3 octaves from G3 — bounces drift up this as the pace rises
SCALE = [196.0 * (2.0 ** (o + d / 12.0)) for o in range(3) for d in (0, 2, 4, 7, 9)]
F_ROOT = 174.61  # F, for the win arpeggio


def log(m):
    sys.stderr.write(str(m).rstrip() + "\n")
    sys.stderr.flush()


def progress(pct, msg=""):
    pct = max(0.0, min(1.0, float(pct)))
    sys.stderr.write("@progress " + json.dumps({"pct": pct, "msg": msg}) + "\n")
    sys.stderr.flush()


def lp(x, cutoff):
    sos = butter(2, min(cutoff, SR * 0.49) / (SR / 2), btype="low", output="sos")
    return sosfilt(sos, x)


def hp(x, cutoff):
    sos = butter(2, max(20.0, cutoff) / (SR / 2), btype="high", output="sos")
    return sosfilt(sos, x)


def _env(n, a, d, curve=3.0):
    """Percussive envelope: soft raised-cosine attack, exponential decay."""
    e = np.ones(n, np.float32)
    ai = max(1, int(SR * a))
    if ai < n:
        e[:ai] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, ai))
        t = np.arange(n - ai) / SR
        e[ai:] = np.exp(-t * (curve / max(d, 1e-3)))
    else:
        e[:] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, n))
    return e


def tone(freq, dur, a=0.008, d=None, curve=3.0, glide_to=None, partial=0.2):
    """A rounded sine tone with a soft, fast-decaying octave partial + optional glide."""
    d = dur if d is None else d
    n = int(SR * dur)
    t = np.arange(n) / SR
    if glide_to:
        k = np.linspace(0.0, 1.0, n)
        inst = freq * (glide_to / freq) ** k
        ph = 2 * np.pi * np.cumsum(inst) / SR
    else:
        ph = 2 * np.pi * freq * t
    s = np.sin(ph) + partial * np.sin(2 * ph) * np.exp(-t * 13.0)
    return (s * _env(n, a, d, curve)).astype(np.float32)


def breath(dur, cutoff0, cutoff1):
    """A soft filtered-noise 'shhh' that closes down — nearly subliminal."""
    n = int(SR * dur)
    x = np.random.default_rng().standard_normal(n).astype(np.float32)
    out = x
    for kk in np.linspace(0.0, 1.0, 8):
        out = lp(out, cutoff0 * (cutoff1 / cutoff0) ** kk)
    return (out * _env(n, 0.03, dur, 2.2)).astype(np.float32)


def hit_noise(dur, cutoff, curve=7.0):
    """A tight, punchy filtered-noise transient — fast attack, fast decay.
    Duel mode's clashes/slashes need an actual crack, not breath()'s slow
    closing 'shhh' (that's built for ambience, not impact)."""
    n = int(SR * dur)
    x = np.random.default_rng().standard_normal(n).astype(np.float32)
    x = lp(x, cutoff)
    return (x * _env(n, 0.002, dur, curve)).astype(np.float32)


def place(buf_l, buf_r, sig, at_sec, gain, pan=0.5):
    pos = int(at_sec * SR)
    if pos < 0 or pos >= len(buf_l):
        return
    end = min(len(buf_l), pos + len(sig))
    seg = sig[: end - pos]
    pan = float(np.clip(pan, 0.0, 1.0))
    gl = gain * np.sqrt(1.0 - pan) * 1.28
    gr = gain * np.sqrt(pan) * 1.28
    buf_l[pos:end] += seg * gl
    buf_r[pos:end] += seg * gr


def plate(x, decay=(0.36, 0.3, 0.24), delays=(719, 1013, 1361), taps=2):
    """A short, dark ambience — just enough to round the transients, no long wash."""
    y = np.zeros_like(x)
    for d, g in zip(delays, decay):
        if d >= len(x):
            continue
        acc = np.zeros_like(x)
        acc[d:] = x[:-d]
        cur = acc.copy()
        for _ in range(taps):
            sh = np.zeros_like(cur)
            sh[d:] = cur[:-d] * g
            cur = cur + sh
        y += cur
    y = lp(y, 3200)
    peak = np.max(np.abs(y)) + 1e-9
    return y / peak


def compress(x, thresh=0.24, ratio=3.6):
    a = np.abs(x)
    over = a > thresh
    g = np.ones_like(x)
    g[over] = (thresh + (a[over] - thresh) / ratio) / (a[over] + 1e-9)
    return x * lp(g, 60.0)


def soft_limit(x, ceil=0.55):
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
    black_hole = bool(data.get("blackHole", False))
    duel = data.get("mode") == "duel"

    n = int(SR * (args.duration + 1.2))
    dry_l = np.zeros(n, np.float32)
    dry_r = np.zeros(n, np.float32)
    wet_l = np.zeros(n, np.float32)
    wet_r = np.zeros(n, np.float32)

    trans_t = np.array(
        [float(e.get("t", 0.0)) for e in events if e.get("type") in ("bounce", "slice")],
        dtype=np.float64,
    )

    def duck(t):
        if trans_t.size == 0:
            return 1.0
        near = int(np.sum(np.abs(trans_t - t) < 0.45))
        return float(np.clip(1.1 / (1.0 + 0.2 * max(0, near - 1)), 0.22, 1.0))

    last_bounce_t = -9.0
    last_slice_t = -9.0
    n_by = {}

    for i, ev in enumerate(events):
        et = ev.get("type")
        t = float(ev.get("t", 0.0))
        n_by[et] = n_by.get(et, 0) + 1
        pan = 0.5 + (float(ev.get("x", 0.5)) - 0.5) * 0.6

        if et == "bounce":
            if t - last_bounce_t < 0.15:          # ~6.5/s ceiling — sparse, musical
                continue
            last_bounce_t = t
            pace = float(np.clip(ev.get("pace", 0.0), 0.0, 1.0))
            hue = int(ev.get("hue", 0))
            base = int(round(pace * (len(SCALE) - 6)))
            idx = min(len(SCALE) - 1, base + (hue // 47) % 3)
            f = SCALE[idx] * (1.0 + ((hue % 13) - 6) * 0.0014)
            sig = tone(f, 0.34, a=0.005, d=0.26, curve=3.4, partial=0.18)   # short music-box plink
            g = (0.1 + 0.03 * pace) * duck(t)
            place(dry_l, dry_r, sig, t, g, pan=pan)
            place(wet_l, wet_r, sig, t, g * 0.4, pan=pan)

        elif et == "slice":
            if t - last_slice_t < 0.3:             # ~3/s ceiling
                continue
            last_slice_t = t
            b = breath(0.11, 1500, 640) * 0.4     # quick "tss"
            place(dry_l, dry_r, b, t, 0.035 * duck(t), pan=pan)
            place(wet_l, wet_r, b, t, 0.03 * duck(t), pan=pan)

        elif et == "start":
            # kickoff hit — a short upward whoosh + a soft thump, energetic not loud
            up = tone(120, 0.3, a=0.004, d=0.24, glide_to=520, partial=0.15)
            thump = tone(70, 0.22, a=0.003, d=0.19, glide_to=44, partial=0.0)
            hiss = np.concatenate([breath(0.16, 3600, 900), np.zeros(int(SR * 0.14), np.float32)])
            m = np.zeros(max(len(up), len(thump), len(hiss)), np.float32)
            m[: len(up)] += up * 0.55
            m[: len(thump)] += thump * 0.8
            m[: len(hiss)] += hiss * 0.3
            place(dry_l, dry_r, m, t, 0.34, pan=0.5)
            place(wet_l, wet_r, m, t, 0.12, pan=0.5)

        elif et == "down":
            thoom = tone(115, 0.36, a=0.006, d=0.3, glide_to=58, partial=0.1)   # quick low "dun"
            place(dry_l, dry_r, thoom, t, 0.22, pan=0.5)
            place(wet_l, wet_r, thoom, t, 0.1, pan=0.5)
            fall = tone(220, 0.26, a=0.006, d=0.22, glide_to=150, partial=0.05)
            place(dry_l, dry_r, fall, t + 0.1, 0.07, pan=0.5)

        elif et == "vortex":
            sw = tone(38, 1.7, a=0.5, d=1.4, glide_to=26, partial=0.0)
            sw2 = tone(95, 1.2, a=0.35, d=1.0, glide_to=52, partial=0.0)
            m = np.zeros(max(len(sw), len(sw2)), np.float32)
            m[: len(sw)] += sw
            m[: len(sw2)] += sw2 * 0.3
            place(dry_l, dry_r, m, t, 0.3, pan=0.5)
            place(wet_l, wet_r, m, t, 0.12, pan=0.5)

        elif et == "win":
            for k, s in enumerate((0, 4, 7, 12, 16)):
                f = F_ROOT * 2 ** (s / 12.0)
                note = tone(f, 0.66 - k * 0.05, a=0.008, d=0.56 - k * 0.05, curve=2.6, partial=0.26)
                place(dry_l, dry_r, note, t + k * 0.1, 0.095 - k * 0.009, pan=0.5)
                place(wet_l, wet_r, note, t + k * 0.1, 0.05, pan=0.5)
            place(dry_l, dry_r, tone(F_ROOT / 2, 1.1, a=0.02, d=0.95, partial=0.0), t, 0.08, pan=0.5)
            place(dry_l, dry_r, tone(F_ROOT * 4, 0.7, a=0.05, d=0.6, partial=0.0), t + 0.06, 0.02, pan=0.5)

        elif et == "clash":
            # a fat, heavy hit — both fighters just collided head-on
            impact = float(np.clip(ev.get("impact", 0.0), 0.0, 1.0))
            thump = tone(70 + impact * 20, 0.3, a=0.004, d=0.22 + impact * 0.1, glide_to=40, partial=0.25)
            crack = hit_noise(0.1, 1800 + impact * 1200)
            ring = tone(1500 + impact * 500, 0.06, a=0.001, d=0.05, glide_to=800, partial=0.0)
            place(dry_l, dry_r, thump, t, 0.3 + impact * 0.12, pan=0.5)
            place(dry_l, dry_r, crack, t, 0.34 + impact * 0.16, pan=0.5)
            place(dry_l, dry_r, ring, t, 0.07, pan=0.5)
            place(wet_l, wet_r, thump, t, 0.08, pan=0.5)

        elif et == "slash":
            # a fast sweep landing on the other fighter — punchier than the
            # territory mode's "slice" (this one is a HIT, not a trail-cut)
            combo = int(ev.get("combo", 0))
            pace = float(np.clip(ev.get("pace", 0.0), 0.0, 1.0))
            up = min(combo, 8) * 30
            crack = hit_noise(0.09, 2600)
            tw = tone(620 + up, 0.16, a=0.003, d=0.12 + pace * 0.05, glide_to=260 + up, partial=0.2)
            tick = tone(2400 + up * 4, 0.05, a=0.001, d=0.035, partial=0.0)
            place(dry_l, dry_r, crack, t, 0.26, pan=pan)
            place(dry_l, dry_r, tw, t, 0.24, pan=pan)
            place(dry_l, dry_r, tick, t, 0.06, pan=pan)
            place(wet_l, wet_r, tw, t, 0.06, pan=pan)

        elif et == "perk":
            # a bright reward chime — root note colours it faintly by kind
            root = {"heal": 392.0, "shield": 466.16, "rage": 220.0, "haste": 523.25}.get(ev.get("kind"), 392.0)
            for k, s in enumerate((0, 4, 7)):
                f = root * 2 ** (s / 12.0)
                note = tone(f, 0.34, a=0.008, d=0.28 - k * 0.03, curve=3.2, partial=0.22)
                place(dry_l, dry_r, note, t + k * 0.055, 0.16 - k * 0.02, pan=0.5)
                place(wet_l, wet_r, note, t + k * 0.055, 0.08, pan=0.5)
            place(dry_l, dry_r, hit_noise(0.18, 3600, curve=3.5), t, 0.05, pan=0.5)

        if i % 200 == 0:
            progress(0.05 + 0.75 * (i / max(1, len(events))), "voicing events")

    progress(0.85, "mixing")

    if black_hole:
        vt = next((float(e["t"]) for e in events if e.get("type") == "vortex"), None)
        if vt is not None:
            start = int(vt * SR)
            dur = n - start
            if dur > 0:
                td = np.arange(dur) / SR
                drone = (np.sin(2 * np.pi * 36 * td) + 0.3 * np.sin(2 * np.pi * 54.5 * td)).astype(np.float32)
                fade = np.clip(td / 2.0, 0.0, 1.0) * np.clip((td[-1] - td) / 1.5 + 1.0, 0.0, 1.0)
                drone = lp(drone * fade, 95) * 0.026   # a faint bed, not a "sound"
                dry_l[start:] += drone
                dry_r[start:] += drone

    progress(0.9, "reverb")
    wl = plate(wet_l)
    wr = plate(wet_r)
    wet_amt = 0.22 if duel else 0.55   # duel wants punch, not the territory mode's soft wash
    left = dry_l + wl * wet_amt
    right = dry_r + wr * wet_amt

    def master(ch):
        if duel:
            # brighter, punchier — a fight should have some bite, never the
            # deliberately-soft "relaxing" ceiling the territory mode wants
            ch = compress(ch, thresh=0.22, ratio=3.6)
            ch = lp(ch, 9000.0)
            ch = ch - 0.25 * hp(ch, 3400.0)   # a gentle trim, not a hard shelf cut
            ch = soft_limit(ch, 0.82)
        else:
            ch = compress(ch, thresh=0.26, ratio=3.2)
            ch = lp(ch, 5200.0)                 # soft ceiling — nothing bright
            ch = ch - 0.5 * hp(ch, 2900.0)    # ~ -5 dB high-shelf cut
            ch = soft_limit(ch, 0.6)
        return ch

    left = master(left)
    right = master(right)

    stereo = np.stack([left, right], axis=1)
    peak = float(np.max(np.abs(stereo)))
    peak_cap = 0.88 if duel else 0.6   # duel is meant to hit harder; territory stays a soft wash
    if peak > peak_cap:
        stereo *= peak_cap / peak

    sf.write(args.out, stereo.astype(np.float32), SR)
    log(f"lasernations_audio: {len(events)} events {dict(sorted(n_by.items()))} -> {args.out} ({args.duration:.1f}s)")
    progress(1.0, "done")


if __name__ == "__main__":
    main()
