"""Sound bed library for post packaging: eight short music loops synthesised
from scratch here (no samples, no recordings), so every one is royalty free
by construction. One is laid quietly under a video's own sound effects,
ducked whenever the game makes a sound, faded out before the end card.

    packaging_bed.py --track arp --seed 7 --orig game.wav --content-end 40.2 --out mix.wav
    packaging_bed.py --list
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import butter, lfilter

SR = 48000

# name: (bpm range, mode, character) -- read by the packaging to describe the pick
TRACKS = {
    "pulse": ((100, 116), "minor", "four on the floor kick, sub bass, soft hats"),
    "arp": ((118, 132), "minor", "sixteenth note synth arpeggio over a pad"),
    "lofi": ((76, 88), "major", "dusty electric piano chords with a lazy beat"),
    "marimba": ((104, 116), "major", "wooden marimba ostinato and bass"),
    "chip": ((128, 140), "major", "8 bit square lead and triangle bass"),
    "ambient": ((66, 76), "major", "slow pad with sparse bell plucks"),
    "tension": ((88, 98), "minor", "low pulsing ostinato that slowly opens up"),
    "bounce": ((108, 120), "major", "plucky bass and claps on two and four"),
}

PROG = {"minor": [(0, "m"), (8, "M"), (3, "M"), (10, "M")], "major": [(0, "M"), (7, "M"), (9, "m"), (5, "M")]}
ROOTS = [57, 60, 62, 64, 65, 67]  # A3 C4 D4 E4 F4 G4


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def chord(root, kind):
    return [root, root + (3 if kind == "m" else 4), root + 7]


def lowpass(x, cut):
    b, a = butter(2, min(cut, SR / 2 - 100) / (SR / 2))
    return lfilter(b, a, x)


def highpass(x, cut):
    b, a = butter(2, cut / (SR / 2), btype="high")
    return lfilter(b, a, x)


def env(n, a=0.005, d=0.2, s=0.0, r=0.05, length=None):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    if s > 0:
        e = e * (s + (1 - s) * np.exp(-np.maximum(0, t - a) / max(d, 1e-4)))
    else:
        e = e * np.exp(-np.maximum(0, t - a) / max(d, 1e-4))
    if length is not None and length < n / SR:
        rel = np.clip(1 - (t - length) / max(r, 1e-4), 0, 1)
        e = e * np.where(t > length, rel, 1)
    return e


def osc(kind, f, n, phase=0.0):
    t = np.arange(n) / SR
    w = 2 * np.pi * f * t + phase
    if kind == "sine":
        return np.sin(w)
    if kind == "tri":
        return 2 / np.pi * np.arcsin(np.sin(w))
    harmonics = [k for k in range(1, 16) if f * k < SR / 2.2]
    if kind == "saw":
        return sum(np.sin(k * w) / k for k in harmonics) * 0.6
    if kind == "square":
        return sum(np.sin(k * w) / k for k in harmonics if k % 2) * 0.8
    raise ValueError(kind)


class Bed:
    def __init__(self, dur, seed):
        self.n = int(dur * SR)
        self.buf = np.zeros(self.n)
        self.rng = np.random.default_rng(seed)

    def add(self, t, sig, gain=1.0):
        i = int(t * SR)
        if i >= self.n:
            return
        j = min(self.n, i + len(sig))
        self.buf[i:j] += sig[: j - i] * gain

    # ---- voices
    def kick(self, t, g=0.9):
        n = int(0.28 * SR)
        tt = np.arange(n) / SR
        f = 45 + 80 * np.exp(-tt / 0.03)
        self.add(t, np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.12), g)

    def hat(self, t, g=0.18, dec=0.035):
        n = int(0.09 * SR)
        self.add(t, highpass(self.rng.standard_normal(n), 7000) * env(n, 0.001, dec), g)

    def clap(self, t, g=0.35):
        n = int(0.2 * SR)
        x = lowpass(highpass(self.rng.standard_normal(n), 900), 4000)
        e = env(n, 0.001, 0.06) + 0.6 * np.roll(env(n, 0.001, 0.02), int(0.012 * SR))
        self.add(t, x * e, g)

    def tone(self, t, m, length, kind="sine", g=0.3, a=0.005, d=0.3, s=0.0, cut=None):
        n = int((length + 0.3) * SR)
        x = osc(kind, hz(m), n, self.rng.uniform(0, 6.28)) * env(n, a, d, s, 0.12, length)
        if cut:
            x = lowpass(x, cut)
        self.add(t, x, g)

    def marimba(self, t, m, g=0.3):
        n = int(0.6 * SR)
        f = hz(m)
        tt = np.arange(n) / SR
        x = np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.22) + 0.35 * np.sin(2 * np.pi * 4 * f * tt) * np.exp(-tt / 0.05)
        self.add(t, x, g)

    def bell(self, t, m, g=0.16):
        n = int(2.0 * SR)
        f = hz(m)
        tt = np.arange(n) / SR
        x = sum(a * np.sin(2 * np.pi * f * r * tt) * np.exp(-tt / d) for r, a, d in [(1, 1, 0.9), (2.76, 0.5, 0.4), (5.4, 0.25, 0.2)])
        self.add(t, x, g)

    def pad(self, t, notes, length, g=0.12, cut=1400):
        n = int((length + 0.6) * SR)
        x = sum(osc("saw", hz(m) * dt, n) for m in notes for dt in (0.997, 1.003))
        self.add(t, lowpass(x * env(n, 0.35, 1.0, 0.85, 0.5, length), cut), g / len(notes))


def build(track, dur, seed):
    (lo, hi), mode, _ = TRACKS[track]
    rng = np.random.default_rng(seed)
    bpm = float(rng.integers(lo, hi + 1))
    root = int(rng.choice(ROOTS))
    beat = 60.0 / bpm
    bar = 4 * beat
    prog = PROG[mode]
    B = Bed(dur, seed)
    bars = int(dur / bar) + 2
    for k in range(bars):
        t0 = k * bar
        off, kind = prog[k % 4]
        ch = chord(root + off, kind)
        bass = root + off - 24
        if track == "pulse":
            for b in range(4):
                B.kick(t0 + b * beat, 0.7)
                B.hat(t0 + b * beat + beat / 2, 0.12)
            for b in range(8):
                B.tone(t0 + b * beat / 2, bass, beat / 2 * 0.9, "saw", 0.16, d=0.12, cut=300)
        elif track == "arp":
            B.pad(t0, [m - 12 for m in ch], bar, 0.10, 900)
            seq = ch + [ch[0] + 12]
            for s in range(16):
                B.tone(t0 + s * beat / 4, seq[(s * (1 + k % 2)) % 4], beat / 4 * 0.8, "saw", 0.06, d=0.08, cut=2600)
            B.kick(t0, 0.5)
            B.kick(t0 + 2 * beat, 0.5)
        elif track == "lofi":
            for b in (0, 2):
                for m in ch + [ch[0] + 11 if kind == "M" else ch[0] + 10]:
                    B.tone(t0 + b * beat + 0.02 * rng.random(), m, beat * 1.6, "sine", 0.06, a=0.01, d=0.9)
            B.kick(t0, 0.5)
            B.kick(t0 + 2.5 * beat, 0.4)
            B.clap(t0 + beat, 0.16)
            B.clap(t0 + 3 * beat, 0.16)
            for b in range(8):
                B.hat(t0 + b * beat / 2 + (0.06 if b % 2 else 0), 0.06)
        elif track == "marimba":
            pat = [0, 2, 1, 2, 0, 2, 1, 3]
            seq = ch + [ch[0] + 12]
            for s in range(8):
                B.marimba(t0 + s * beat / 2, seq[pat[s]], 0.22)
            B.tone(t0, bass, beat * 1.8, "tri", 0.18, d=0.5)
            B.tone(t0 + 2 * beat, bass + 7, beat * 1.8, "tri", 0.15, d=0.5)
        elif track == "chip":
            seq = ch + [ch[0] + 12, ch[1] + 12, ch[2], ch[1], ch[0] + 12]
            for s in range(8):
                B.tone(t0 + s * beat / 2, seq[s] + 12, beat / 2 * 0.7, "square", 0.045, d=0.25, s=0.5, cut=5000)
            for b in range(4):
                B.tone(t0 + b * beat, bass + (12 if b % 2 else 0), beat * 0.8, "tri", 0.2, d=0.3, s=0.6)
                B.hat(t0 + b * beat + beat / 2, 0.08, 0.02)
        elif track == "ambient":
            B.pad(t0, ch + [ch[0] + 12], bar, 0.14, 1100)
            for s in rng.choice(8, size=2, replace=False):
                B.bell(t0 + s * beat / 2, int(rng.choice(ch)) + 12, 0.1)
        elif track == "tension":
            cut = 300 + 1600 * min(1.0, t0 / max(1.0, dur))
            for s in range(8):
                B.tone(t0 + s * beat / 2, bass + 12 + (0 if s % 4 else 0), beat / 2 * 0.6, "saw", 0.12, d=0.09, cut=cut)
            B.kick(t0, 0.55)
            B.kick(t0 + 2 * beat, 0.45)
            for b in range(16):
                B.hat(t0 + b * beat / 4, 0.05 + 0.04 * (b % 4 == 0), 0.02)
        elif track == "bounce":
            for s, step in enumerate([0, 0, 7, 0, 12, 0, 7, 5]):
                if s in (1, 5):
                    continue
                B.tone(t0 + s * beat / 2, bass + 12 + step, beat / 2 * 0.6, "saw", 0.11, d=0.1, cut=1200)
            B.kick(t0, 0.55)
            B.kick(t0 + 2 * beat, 0.5)
            B.clap(t0 + beat, 0.28)
            B.clap(t0 + 3 * beat, 0.28)
    x = B.buf
    return x / (np.max(np.abs(x)) + 1e-9), {"bpm": bpm, "root": root, "mode": mode}


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--track")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--orig")
    ap.add_argument("--content-end", type=float)
    ap.add_argument("--out")
    ap.add_argument("--below-db", type=float, default=12.0, help="how far under the game's own sound the bed sits")
    a = ap.parse_args()
    if a.list:
        print(json.dumps({k: {"bpm": v[0], "mode": v[1], "sound": v[2]} for k, v in TRACKS.items()}))
        return

    orig, sr = sf.read(a.orig, always_2d=True)
    if sr != SR:
        sys.exit(f"expected {SR} Hz input, got {sr}")
    n = len(orig)
    mono = orig.mean(axis=1)
    content_n = min(n, int(a.content_end * SR))
    bed, info = build(a.track, n / SR + 0.5, a.seed)
    bed = bed[:n]

    # level: the bed's RMS sits `below_db` under the game audio's active RMS
    win = int(0.05 * SR)
    frames = mono[: content_n - content_n % win].reshape(-1, win)
    fr = np.sqrt((frames ** 2).mean(axis=1))
    active = fr[fr > 10 ** (-50 / 20)]
    target = 20 * np.log10(np.sqrt((active ** 2).mean()) + 1e-12) - a.below_db if len(active) else -36.0
    bed = bed * 10 ** ((target - rms_db(bed[:content_n])) / 20)

    # duck under the game's sounds: fast attack, slow release
    e = np.abs(mono)
    att, rel = np.exp(-1 / (0.004 * SR)), np.exp(-1 / (0.25 * SR))
    sm = np.empty_like(e)
    acc = 0.0
    for i in range(0, n, 64):  # control rate is plenty for a gain curve
        blk = e[i:i + 64].max()
        acc = att * acc + (1 - att) * blk if blk > acc else rel * acc + (1 - rel) * blk
        sm[i:i + 64] = acc
    ref = np.percentile(sm[:content_n], 95) + 1e-9
    gain = 1 - 0.55 * np.clip(sm / ref, 0, 1)

    # fade in over 0.3s; fade out over 1.5s finishing where the game ends
    t = np.arange(n) / SR
    fade = np.clip(t / 0.3, 0, 1) * np.clip((a.content_end - t) / 1.5, 0, 1)
    bed = bed * gain * fade
    mix = orig + bed[:, None]
    peak = np.max(np.abs(mix))
    if peak > 0.97:
        mix *= 0.97 / peak
    sf.write(a.out, mix, SR, subtype="PCM_16")
    info.update({"track": a.track, "seed": a.seed, "bedDbBelowGame": a.below_db})
    print(json.dumps(info))


if __name__ == "__main__":
    main()
