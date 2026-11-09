"""Procedural "which colour escapes first?" ring-escape race.

The most-watched physics-video format on Shorts / TikTok / Reels is the
"will the ball escape?" bounce: a ball trapped in nested rings, bouncing and
growing until it slips through a gap and breaks out. This turns that into a
race — 3-6 coloured balls start caged in the centre of a stack of spinning
neon rings, each ring with a moving gap. A ball climbs outward one ring at a
time; slipping through the gap promotes it to the next lane. First colour to
clear the outermost ring wins.

Why it holds attention (the design leans on all of it):
  * an open loop — you can't look away until someone breaks out
  * a near-miss every second — the gap is always *almost* lined up
  * visible progress — the lane a ball sits in, and the pips below it
  * escalation — speed + bounce-note pitch climb as balls get deeper
  * a real payoff — burst + boom + shake on the winning break-out

Deterministic given the seed; guaranteed to finish (gaps widen if the race
stalls); self-tunes speed so it lands near the requested length.

Look matches "Color race": near-black gradient, Chakra Petch, neon + bloom,
strong vignette, 3-2-1 countdown, bottom winner card, 1080x1920 @ 60fps, and
the frame is inset a touch (SAFE_SCALE) so nothing hides under TikTok's UI.

Outputs (silent mp4 + wav + JSON):
  --out-video race.mp4   --out-audio race.wav   --out result.json
"""

from __future__ import annotations

import argparse
import math
import os
import subprocess
from collections import deque

import numpy as np

from common import emit_result, log, progress

# --- viewport + timing ----------------------------------------------
W, H_VIEW = 1080, 1920
FPS = 60
SUBSTEPS = 6
COUNT_SECS = 3.0                    # 3-2-1-GO before the cage releases
SAFE_TOP = 150
SAFE_SCALE = 0.90

# --- arena --------------------------------------------------------
CX, CY = 540.0, 1024.0           # arena centre (low — leaves the top for the HUD)
R_OUTER = 526.0                    # nominal outer radius (lane_layout may nudge it)
R_INNER = 104.0                   # lane 0 (the centre disc)
RING_THICK = 5                    # skinny neon lines — room for lots of them

# --- physics ----------------------------------------------------
BALL_GROW = 0.16                   # + per wall bounce — subtle
GRAV = 235.0                       # light — balls float and ricochet, don't pool
E_WALL = 0.97                      # near-elastic → lively, continuous bounces
E_BALL = 0.98
SPEED0 = 430.0
SPEED_FLOOR = 305.0               # a lively minimum, barely scaled by the tuner
SPEED_CAP = 1150.0
SPEED_RAMP = 1.28                 # gentle speed-up over the race
GAP_HALF0 = math.radians(24.0)    # half-width of a ring's gap arc
STALL_SECS = 2.6
MAX_SECS = 46.0
ESC_LOCK = 0.16                   # min gap between one ball's ring break-outs

# --- sound gates (kept sparse + soft) -------------------------
SND_COOLDOWN = 0.13
SND_MAX_RATE = 7
SND_MIN_IMP = 90.0

# --- colours — BGR for OpenCV ---------------------------------
MARBLE_COLORS = [
    ("CYAN",    (255, 231, 0)),
    ("MAGENTA", (149, 45, 255)),
    ("LIME",    (46, 255, 180)),
    ("AMBER",   (32, 176, 255)),
    ("CORAL",   (60, 90, 255)),
    ("VIOLET",  (247, 85, 168)),
]
RING_INNER_COL = np.array([255, 216, 92], np.float32)     # bright cyan
RING_OUTER_COL = np.array([224, 96, 246], np.float32)     # violet
RING_FINAL_COL = np.array([150, 60, 255], np.float32)     # hot pink-red ("final")
COL_SPARK = (245, 245, 255)

# C-major pentatonic, three octaves — a bounce always lands on a pleasant note
# and the melody climbs as balls get deeper
_PENTA = []
for _o in range(3):
    for _s in (0, 2, 4, 7, 9):
        _PENTA.append(130.81 * (2 ** (_o + _s / 12.0)))
_PENTA = np.array(_PENTA)


# --- fonts / text helpers (Chakra Petch) ----------------------
_FONT_DIR = ""
_FONT_CACHE: dict = {}
_FONT_FILE = {"bold": "ChakraPetch-Bold.ttf", "semi": "ChakraPetch-SemiBold.ttf", "med": "ChakraPetch-Medium.ttf"}


def _font(size, w="bold"):
    from PIL import ImageFont
    key = (int(size), w)
    hit = _FONT_CACHE.get(key)
    if hit is not None:
        return hit
    try:
        f = ImageFont.truetype(os.path.join(_FONT_DIR, _FONT_FILE.get(w, _FONT_FILE["bold"])), int(size))
    except Exception:
        try:
            f = ImageFont.truetype(os.path.join(_FONT_DIR, "Anton-Regular.ttf"), int(size))
        except Exception:
            f = ImageFont.load_default()
    _FONT_CACHE[key] = f
    return f


def _spaced(d, xy, s, font, fill, sp=3):
    x, y = xy
    for ch in s:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + sp
    return x


def _spaced_w(d, s, font, sp=3):
    return sum(d.textlength(ch, font=font) + sp for ch in s) - sp


def _rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def _fit_font(d, s, size, max_w, sp=3, w="bold"):
    """Largest font <= `size` whose spaced width fits `max_w`."""
    for px in range(int(size), 12, -2):
        if _spaced_w(d, s, _font(px, w), sp) <= max_w:
            return _font(px, w)
    return _font(14, w)


# --- geometry ------------------------------------------------
def ang_norm(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def lane_layout(n):
    """Ring radii, innermost -> outermost. Lane k is the annulus between ring
    k-1 and ring k (lane 0 = the disc inside ring 0). With many thin rings the
    lanes get tight — the ball shrinks to match so it still fits and bounces."""
    lane_w = max(32.0, (R_OUTER - R_INNER) / (n - 1)) if n > 1 else 220.0
    radii = [R_INNER + k * lane_w for k in range(n)]
    br_max = max(9.0, min(26.0, lane_w * 0.40))
    br0 = max(8.0, min(18.0, lane_w * 0.30, br_max - 1.5))
    return radii, lane_w, br0, br_max


def ring_colour(k, n):
    if k == n - 1:
        return RING_FINAL_COL
    f = k / max(1, n - 1)
    return RING_INNER_COL * (1 - f) + RING_OUTER_COL * f


# --- simulation --------------------------------------------
class Ball:
    __slots__ = ("i", "x", "y", "vx", "vy", "r", "level", "times", "rank",
                 "flash", "snd_t", "bounces", "esc_t", "lock", "near")

    def __init__(self, i, x, y, vx, vy, r0):
        self.i = i
        self.x, self.y = x, y
        self.vx, self.vy = vx, vy
        self.r = r0
        self.level = 0
        self.times: list[float] = []
        self.rank = 0                  # 0 = racing, else finishing place
        self.flash = 0.0
        self.snd_t = -1.0
        self.bounces = 0
        self.esc_t = -1.0
        self.lock = 0.0
        self.near = 0.0               # "so close to the gap" glow, decays


def start_balls(n_balls, n_rings, rng):
    """Clustered near the centre, moving ~tangentially so nobody rockets
    straight out through a chance-aligned stack of gaps."""
    _r, _lw, br0, _bm = lane_layout(n_rings)
    out = []
    for i in range(n_balls):
        a = 2 * math.pi * i / n_balls + rng.uniform(-0.3, 0.3)
        dd = rng.uniform(10, R_INNER * 0.42)
        sp = SPEED0 * rng.uniform(0.9, 1.1)
        va = a + math.pi / 2 + rng.uniform(-0.7, 0.7)
        out.append(Ball(i, CX + math.cos(a) * dd, CY + math.sin(a) * dd,
                        math.cos(va) * sp, math.sin(va) * sp, br0))
    return out


def simulate(n_rings, balls, rng, speed_scale=1.0, record=False):
    """Fixed-step deterministic sim. `speed_scale` is the length knob (higher
    → faster balls → shorter race). A ball climbs outward one ring at a time;
    it can only leave its lane through that ring's rotating gap."""
    radii, lane_w, _br0, br_max = lane_layout(n_rings)
    r_out = radii[-1]

    gap_half, omega, phase = [], [], []
    for k in range(n_rings):
        final = k == n_rings - 1
        gap_half.append(GAP_HALF0 * (0.82 if final else 1.18 if k == 0 else rng.uniform(0.92, 1.12)))
        # inner rings spin faster so the gap comes around often (a quick open);
        # outer rings drift slower (the finish tightens up)
        spin = 1.7 - 0.9 * (k / max(1, n_rings - 1))
        base = rng.uniform(0.34, 0.56) * spin * (0.6 if final else 1.0)
        omega.append(base * (1 if k % 2 == 0 else -1))
        phase.append(rng.uniform(0, 2 * math.pi))
    gap_widen = 0.0

    dt = 1.0 / (FPS * SUBSTEPS)
    steps = 0
    t = 0.0
    hold = COUNT_SECS
    frames: list[dict] = []
    events: list[tuple] = []
    sparks: deque = deque(maxlen=160)
    shake = 0.0
    last_escape_t = hold
    winner = -1
    win_t = -1.0
    snd_slots: dict = {}
    max_steps = int(MAX_SECS * FPS * SUBSTEPS)

    while steps < max_steps:
        t = steps / (FPS * SUBSTEPS)
        running = t >= hold
        ramp = 1.0 + (SPEED_RAMP - 1.0) * min(1.0, (t - hold) / 9.0) if running else 1.0
        vmul = speed_scale * ramp
        gaps_now = [phase[k] + omega[k] * (t * 1.05) for k in range(n_rings)]

        if not running:
            # during the countdown the balls settle into a slow huddle near the
            # bottom of lane 0, leaving the middle clear for the countdown digit
            oy = CY + R_INNER * 0.44
            for b in balls:
                aa = math.atan2(b.y - oy, b.x - CX) + dt * 1.1
                dd = min(R_INNER * 0.4, math.hypot(b.x - CX, b.y - oy))
                b.x = CX + math.cos(aa) * dd
                b.y = oy + math.sin(aa) * dd
        elif winner < 0:
            if t - last_escape_t > STALL_SECS:
                gap_widen = min(math.radians(30), gap_widen + dt * 0.45)

            act = [b.level for b in balls if b.rank == 0 and b.level < n_rings]
            min_lv = min(act) if act else 0
            max_lv = max(act) if act else 0

            for b in balls:
                if b.rank:
                    continue
                b.vy += GRAV * dt
                sp = math.hypot(b.vx, b.vy)
                lo = max(210.0, SPEED_FLOOR * vmul)
                if 1e-3 < sp < lo:
                    b.vx *= lo / sp
                    b.vy *= lo / sp
                elif sp > SPEED_CAP:
                    b.vx *= SPEED_CAP / sp
                    b.vy *= SPEED_CAP / sp
                if max_lv - min_lv >= 2:
                    if b.level == min_lv:
                        b.vx *= 1.006
                        b.vy *= 1.006
                    elif b.level == max_lv:
                        b.vx *= 0.996
                        b.vy *= 0.996

                b.x += b.vx * dt
                b.y += b.vy * dt
                b.near = max(0.0, b.near - dt * 3.0)

                if b.level >= n_rings:
                    if math.hypot(b.x - CX, b.y - CY) > r_out + 150:
                        if b.rank == 0:
                            b.rank = sum(1 for x in balls if x.rank) + 1
                    continue

                dx, dy = b.x - CX, b.y - CY
                d = math.hypot(dx, dy) or 1e-6
                nx, ny = dx / d, dy / d

                # inner wall — the ring you already cleared, solid from outside
                if b.level > 0:
                    r_in = radii[b.level - 1]
                    if d - b.r <= r_in:
                        vn = b.vx * nx + b.vy * ny
                        if vn < 0:
                            b.vx -= (1 + E_WALL) * vn * nx
                            b.vy -= (1 + E_WALL) * vn * ny
                        push = r_in - (d - b.r)
                        b.x += nx * push
                        b.y += ny * push
                        _bounce_snd(b, abs(vn), t, hold, sp, events, snd_slots)

                # outer wall — the ring you're trying to clear (has the gap)
                R = radii[b.level]
                gh = gap_half[b.level] + gap_widen
                if d + b.r >= R:
                    theta = math.atan2(dy, dx)
                    off = abs(ang_norm(theta - gaps_now[b.level]))
                    vrad = b.vx * nx + b.vy * ny
                    if off < gh + 0.12:
                        b.near = 1.0
                    if off < max(0.03, gh - b.r / R - 0.03) and vrad > 40.0 and t >= b.lock:
                        b.level += 1
                        b.lock = t + ESC_LOCK
                        b.times.append(round(t, 3))
                        b.esc_t = t
                        last_escape_t = t
                        final = b.level >= n_rings
                        shake = min(1.0, shake + (0.8 if final else 0.28))
                        x01 = float(np.clip(b.x / W, 0, 1))
                        events.append((t, "escape", b.level, b.i, x01))
                        for _ in range(22 if final else 12):
                            ea = rng.uniform(0, 2 * math.pi)
                            sparks.append([b.x, b.y, math.cos(ea), math.sin(ea),
                                           rng.uniform(0.5, 1.1), b.i])
                        if final and winner < 0:
                            winner = b.i
                            win_t = t
                            b.rank = 1
                            events.append((t, "win", n_rings, b.i, x01))
                        # nudge it outward into the new lane
                        b.x += nx * (b.r + 2)
                        b.y += ny * (b.r + 2)
                    else:
                        vn = b.vx * nx + b.vy * ny
                        if vn > 0:
                            b.vx -= (1 + E_WALL) * vn * nx
                            b.vy -= (1 + E_WALL) * vn * ny
                        b.x -= nx * (d + b.r - R)
                        b.y -= ny * (d + b.r - R)
                        b.r = min(br_max, b.r + BALL_GROW)
                        b.bounces += 1
                        b.flash = 1.0
                        _bounce_snd(b, abs(vn), t, hold, sp, events, snd_slots, b.level)
                        if off < gh + 0.14:
                            sparks.append([b.x, b.y, nx, ny, 0.7, b.i])

            # ball ↔ ball
            for a in range(len(balls)):
                ba = balls[a]
                if ba.rank and ba.level >= n_rings:
                    continue
                for c in range(a + 1, len(balls)):
                    bc = balls[c]
                    if bc.rank and bc.level >= n_rings:
                        continue
                    dx, dy = bc.x - ba.x, bc.y - ba.y
                    dd = math.hypot(dx, dy) or 1e-6
                    md = ba.r + bc.r + 1.5
                    if dd < md:
                        nx, ny = dx / dd, dy / dd
                        dvn = (bc.vx - ba.vx) * nx + (bc.vy - ba.vy) * ny
                        # always hard-separate so they never stack into one blob
                        push = (md - dd) / 2 + 0.5
                        ba.x -= nx * push
                        ba.y -= ny * push
                        bc.x += nx * push
                        bc.y += ny * push
                        if dvn < 0:
                            j = -(1 + E_BALL) * dvn / 2
                            ba.vx -= j * nx
                            ba.vy -= j * ny
                            bc.vx += j * nx
                            bc.vy += j * ny
                            # a touch of spin-apart along the tangent, so a head-on
                            # meeting slides into two arcs instead of a pile-up
                            tx, ty = -ny, nx
                            kick = 26.0
                            ba.vx -= tx * kick
                            ba.vy -= ty * kick
                            bc.vx += tx * kick
                            bc.vy += ty * kick
                            if abs(dvn) > 190 and t - ba.snd_t > 0.12:
                                ba.snd_t = t
                                events.append((t, "clack", float(np.clip(ba.x / W, 0, 1)), abs(dvn)))

        for b in balls:
            b.flash = max(0.0, b.flash - dt * 6.0)
        shake = max(0.0, shake - dt * 3.0)
        for s in sparks:
            s[0] += s[2] * 300 * dt
            s[1] += s[3] * 300 * dt
            s[4] -= dt * 1.7
        while sparks and sparks[0][4] <= 0:
            sparks.popleft()

        if winner >= 0 and t - win_t > 1.5:
            break

        if record and steps % SUBSTEPS == 0:
            if not running:
                left = hold - t
                cd = "GO" if left <= 0.5 else str(int(math.ceil(left - 0.5)))
                ph = "count"
            elif winner >= 0:
                cd, ph = "", "over"
            else:
                cd, ph = "", "run"
            lead, best_key = -1, None
            for b in balls:
                if b.rank and b.level >= n_rings:
                    lead = b.i if winner == b.i else lead
                    continue
                lv = min(b.level, n_rings)
                off = 0.0
                if b.level < n_rings:
                    off = abs(ang_norm(math.atan2(b.y - CY, b.x - CX) - gaps_now[b.level]))
                key = (lv, -off)
                if best_key is None or key > best_key:
                    best_key, lead = key, b.i
            frames.append({
                "t": round(t, 3),
                "phase": ph,
                "cd": cd,
                "shake": round(shake, 3),
                "lead": lead,
                "gaps": [round(g, 4) for g in gaps_now],
                "gh": [round(gap_half[k] + gap_widen, 4) for k in range(n_rings)],
                "balls": [(b.x, b.y, b.r, b.i, b.level, b.flash, b.rank, b.near) for b in balls],
                "sparks": [(s[0], s[1], s[4], s[5]) for s in sparks],
            })
        steps += 1

    rest = sorted((b for b in balls if b.rank == 0), key=lambda b: (-b.level, b.i))
    place = sum(1 for b in balls if b.rank) + 1
    for b in rest:
        b.rank = place
        place += 1

    return {
        "n_rings": n_rings,
        "radii": radii,
        "lane_w": lane_w,
        "r_out": r_out,
        "winner": winner,
        "win_t": win_t if win_t > 0 else t,
        "duration": (len(frames) / FPS) if record and frames else t,
        "order": [b.i for b in sorted(balls, key=lambda b: b.rank)],
        "levels": {b.i: b.level for b in balls},
        "ranks": {b.i: b.rank for b in balls},
        "frames": frames,
        "events": events,
        "hold": hold,
    }


def _bounce_snd(b, imp, t, hold, sp, events, slots, level=0):
    if imp <= SND_MIN_IMP or t - b.snd_t <= SND_COOLDOWN:
        return
    slot = int(t * SND_MAX_RATE)
    if slots.get(slot):
        return
    slots[slot] = 1
    b.snd_t = t
    pitch01 = float(np.clip((level * 2 + min(4, int(sp / 300))) / (len(_PENTA) - 1), 0, 1))
    vol = 0.25 + 0.6 * min(1.0, imp / 850.0)
    events.append((t, "bounce", level, pitch01, vol, float(np.clip(b.x / W, 0, 1))))


# --- render --------------------------------------------------
def render(res, colors, ffmpeg, out_video):
    import cv2
    from PIL import Image, ImageDraw, ImageFilter

    frames = res["frames"]
    total = len(frames)
    n = len(colors)
    n_rings = res["n_rings"]
    radii = res["radii"]
    r_out = res["r_out"]
    winner = res["winner"]
    win_t = res["win_t"]
    run_t = res["hold"]

    proc = subprocess.Popen(
        [ffmpeg, "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H_VIEW}",
         "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-preset", "medium",
         "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_video],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    tt = np.linspace(0.0, 1.0, H_VIEW)[:, None, None]
    bg = (np.array([24.0, 10.0, 10.0]) * (1 - tt) + np.array([11.0, 5.0, 5.0]) * tt).astype(np.uint8)
    bg = np.repeat(bg, W, axis=1)

    yy, xx = np.mgrid[0:H_VIEW, 0:W].astype(np.float32)
    dc = np.sqrt((xx - CX) ** 2 + (yy - CY) ** 2)
    vig = (1.0 - 0.5 * np.clip((dc - (r_out + 30)) / 760.0, 0.0, 1.0)).astype(np.float32)[..., None]
    arena = (1.0 + 0.13 * np.clip(1.0 - dc / (r_out + 24), 0.0, 1.0)).astype(np.float32)[..., None]
    bg_arena = np.clip(bg.astype(np.float32) * arena, 0, 255).astype(np.uint8)

    ins_w = int(round(W * SAFE_SCALE)) & ~1
    ins_h = int(round(H_VIEW * SAFE_SCALE)) & ~1
    ins_x = (W - ins_w) // 2
    ins_y = int((H_VIEW - ins_h) * 0.42)

    _sph: dict = {}

    def sphere(r):
        r = int(round(r))
        hit = _sph.get(r)
        if hit is not None:
            return hit
        SR = int(r * 1.7)
        sd = 2 * SR + 1
        gy, gx = np.mgrid[0:sd, 0:sd].astype(np.float32)
        nx = (gx - SR) / r
        ny = (gy - SR) / r
        r2 = nx * nx + ny * ny
        inside = r2 <= 1.0
        nz = np.sqrt(np.clip(1.0 - r2, 0.0, 1.0))
        lx, ly, lz = -0.40, -0.52, 0.76
        ndl = np.clip(nx * lx + ny * ly + nz * lz, 0.0, 1.0)
        rim = (np.clip(1.0 - nz, 0, 1) ** 2.4) * 0.6
        tint = np.clip(0.32 + 0.95 * ndl + rim, 0.0, 1.8)[..., None].astype(np.float32)
        spec = ((ndl ** 55) * 1.6 * inside)[..., None].astype(np.float32)
        alpha = np.maximum(np.clip((1.0 - r2) * (r * 0.6), 0.0, 1.0),
                           inside.astype(np.float32))[..., None].astype(np.float32)
        _sph[r] = (SR, tint, spec, alpha)
        return _sph[r]

    def blit_sphere(im, cx, cy, col, flash, rr):
        SR, tint, spec, alpha = sphere(rr)
        sdd = 2 * SR + 1
        x0, y0 = cx - SR, cy - SR
        sx0, sy0 = max(0, -x0), max(0, -y0)
        dx0, dy0 = max(0, x0), max(0, y0)
        dx1, dy1 = min(W, x0 + sdd), min(H_VIEW, y0 + sdd)
        if dx1 <= dx0 or dy1 <= dy0:
            return
        sx1, sy1 = sx0 + (dx1 - dx0), sy0 + (dy1 - dy0)
        a = alpha[sy0:sy1, sx0:sx1]
        body = np.clip(tint[sy0:sy1, sx0:sx1] * col + spec[sy0:sy1, sx0:sx1] * 255.0 + flash * 70.0, 0, 255)
        reg = im[dy0:dy1, dx0:dx1].astype(np.float32)
        im[dy0:dy1, dx0:dx1] = (reg * (1 - a) + body * a).astype(np.uint8)

    WC_H = 760
    WC_TOP = H_VIEW - WC_H
    scrim = Image.new("RGBA", (W, WC_H), (0, 0, 0, 0))
    _sd = ImageDraw.Draw(scrim)
    for i in range(WC_H):
        _sd.line([(0, i), (W, i)], fill=(10, 4, 5, int(254 * (i / WC_H) ** 1.05)))

    trails = [deque(maxlen=7) for _ in range(n)]
    prog_every = max(1, total // 50)

    for fi, fr in enumerate(frames):
        img = bg_arena.copy()

        # --- rings: outermost first; a cleared ring stays as a faint ghost ---
        for k in range(n_rings - 1, -1, -1):
            col = ring_colour(k, n_rings)
            R = radii[k]
            cr = tuple(int(v) for v in col)
            if all(b[4] > k for b in fr["balls"]):
                cv2.circle(img, (int(CX), int(CY)), int(R), tuple(int(v * 0.15) for v in cr), 1, cv2.LINE_AA)
                continue
            gc, gh = fr["gaps"][k], fr["gh"][k]
            a0 = math.degrees(gc + gh)
            sweep = 360.0 - 2 * math.degrees(gh)
            # skinny neon: a soft wide glow, then a crisp bright core
            for th, sc in ((RING_THICK + 10, 0.20), (RING_THICK + 4, 0.42), (RING_THICK, 1.0)):
                cv2.ellipse(img, (int(CX), int(CY)), (int(R), int(R)), 0, a0, a0 + sweep,
                            tuple(int(v * sc) for v in cr), th, cv2.LINE_AA)
            # rounded caps at the two gap ends (no white outline)
            for sgn in (1, -1):
                ex = int(CX + math.cos(gc + sgn * gh) * R)
                ey = int(CY + math.sin(gc + sgn * gh) * R)
                cv2.circle(img, (ex, ey), max(2, RING_THICK // 2 + 1), cr, -1, cv2.LINE_AA)

        # --- sparks ---
        for (sx, sy, life, cidx) in fr["sparks"]:
            c = COL_SPARK if cidx < 0 or cidx >= n else colors[cidx][1]
            cv2.circle(img, (int(sx), int(sy)), max(1, int(5 * life + 1)), c, -1, cv2.LINE_AA)

        # --- balls ---
        for (bx, by, br, cid, lv, flash, rank, near) in fr["balls"]:
            if not (rank and lv >= n_rings):
                trails[cid].append((bx, by))
        for (bx, by, br, cid, lv, flash, rank, near) in fr["balls"]:
            col = colors[cid][1]
            cx, cyv = int(bx), int(by)
            tr = trails[cid]
            if len(tr) > 1:
                for ti, (tx, ty) in enumerate(tr):
                    f = ti / len(tr)
                    cv2.circle(img, (int(tx), int(ty)), max(1, int(br * 0.5 * f)),
                               tuple(int(v * 0.30 * f) for v in col), -1, cv2.LINE_AA)
            cv2.circle(img, (cx, cyv + int(br * 0.5)), int(br * 0.9), (6, 4, 4), -1, cv2.LINE_AA)
            is_lead = fr["lead"] == cid and fr["phase"] == "run"
            # a soft glow in the ball's own colour — swells on a bounce or a near-miss,
            # never a hard white ring
            hg = 0.16 + 0.36 * near + 0.5 * flash + (0.12 if is_lead else 0.0)
            halo = br + 5 + flash * 18 + near * 12 + (4 if is_lead else 0)
            cv2.circle(img, (cx, cyv), int(halo), tuple(min(255, int(v * hg)) for v in col), -1, cv2.LINE_AA)
            blit_sphere(img, cx, cyv, np.array(col, np.float32), flash, br)

        # --- screen shake (game layer only) — a gentle nudge, not a jolt ---
        sh = fr["shake"]
        if sh > 0.02:
            mag = sh * sh * 9.0
            M = np.float32([[1, 0, math.sin(fr["t"] * 80.0) * mag],
                            [0, 1, math.cos(fr["t"] * 67.0) * mag]])
            img = cv2.warpAffine(img, M, (W, H_VIEW), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

        # ---- HUD ----
        ov = Image.new("RGBA", (W, H_VIEW), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)

        counting = fr["phase"] == "count"
        over = fr["phase"] == "over"
        big = counting or (fr["t"] - run_t) < 0.9

        if not over:
            if big:
                # the hook — big, two lines, over the countdown + a colour legend
                ba = 1.0 if counting else max(0.0, 1.0 - (fr["t"] - run_t) / 0.9)
                A = int(255 * ba)
                for li, line in enumerate(("WHICH COLOR", "ESCAPES FIRST?")):
                    f1 = _fit_font(d, line, 96, W - 96, 4)
                    lw = _spaced_w(d, line, f1, 4)
                    _spaced(d, ((W - lw) / 2, SAFE_TOP + 14 + li * 96), line, f1, (255, 255, 255, A), 4)
                f2 = _font(30)
                sub = "PICK ONE · COMMENT YOUR COLOR"
                sw = _spaced_w(d, sub, f2, 3)
                _spaced(d, ((W - sw) / 2, SAFE_TOP + 214), sub, f2, (0, 231, 255, A), 3)
                lf = _font(24)
                step = min(190, (W - 120) / n)
                lx = W / 2 - (n - 1) * step / 2
                for i, (nm, cbgr) in enumerate(colors):
                    rgb = (cbgr[2], cbgr[1], cbgr[0], A)
                    cxp = lx + i * step
                    d.ellipse([cxp - 16, SAFE_TOP + 274, cxp + 16, SAFE_TOP + 306], fill=rgb)
                    nw = d.textlength(nm, font=lf)
                    d.text((cxp - nw / 2, SAFE_TOP + 316), nm, font=lf, fill=(255, 255, 255, int(170 * ba)))
            else:
                # a small persistent header, sat just above the arena — nothing
                # else on screen but the race
                f1 = _fit_font(d, "WHICH COLOR ESCAPES FIRST?", 44, W - 110, 2)
                qw = _spaced_w(d, "WHICH COLOR ESCAPES FIRST?", f1, 2)
                _spaced(d, ((W - qw) / 2, SAFE_TOP + 190), "WHICH COLOR ESCAPES FIRST?", f1, (255, 255, 255, 150), 2)

        # countdown digit — neon bloom, centred in lane 0 above the huddle
        if fr["cd"]:
            cd = fr["cd"]
            f = _font(196 if cd != "GO" else 148)
            cw = d.textlength(cd, font=f)
            cx0 = int((W - cw) / 2)
            cy0 = int(CY - 150)
            for colr, blur, al in (((149, 45, 255), 34, 150), ((255, 231, 0), 18, 190)):
                lay = Image.new("RGBA", (W, H_VIEW), (0, 0, 0, 0))
                ImageDraw.Draw(lay).text((cx0, cy0), cd, font=f, fill=(*colr, 255))
                lay = lay.filter(ImageFilter.GaussianBlur(blur))
                lay.putalpha(lay.getchannel("A").point(lambda v, m=al: min(255, int(v * m / 90))))
                ov.alpha_composite(lay)
            d.text((cx0, cy0), cd, font=f, fill=(255, 255, 255, 252))

        if winner >= 0 and fr["t"] >= win_t:
            _draw_winner(d, ov, scrim, colors, winner, res, fr["t"], win_t, WC_TOP)

        # --- bloom ---
        f32 = img.astype(np.float32)
        sm = cv2.resize(f32, (W // 4, H_VIEW // 4), interpolation=cv2.INTER_AREA)
        bloom = cv2.GaussianBlur(np.clip(sm - 118.0, 0.0, None), (0, 0), 11.0)
        bloom = cv2.resize(bloom, (W, H_VIEW), interpolation=cv2.INTER_LINEAR)
        img_glow = np.clip(f32 + bloom * 0.6, 0.0, 255.0)
        # once the winner is in, sink the still-bouncing losers so the card reads clean
        if winner >= 0 and fr["t"] > win_t:
            img_glow *= 1.0 - 0.6 * min(1.0, (fr["t"] - win_t) / 0.5)

        hud = np.asarray(ov)
        ha = hud[:, :, 3:4].astype(np.float32) * (1.0 / 255.0)
        hrgb = hud[:, :, 2::-1].astype(np.float32)
        out = np.clip(img_glow * vig * (1.0 - ha) + hrgb * ha, 0, 255).astype(np.uint8)

        if SAFE_SCALE < 1.0:
            frame = bg.copy()
            frame[ins_y:ins_y + ins_h, ins_x:ins_x + ins_w] = cv2.resize(
                out, (ins_w, ins_h), interpolation=cv2.INTER_AREA)
            out = frame

        proc.stdin.write(np.ascontiguousarray(out).tobytes())
        if fi % prog_every == 0:
            progress(0.34 + 0.6 * fi / max(total, 1), f"rendering {fi}/{total}")

    proc.stdin.close()
    proc.wait()


def _draw_winner(d, ov, scrim, colors, winner, res, t_now, win_t, WC_TOP):
    wa = min(1.0, (t_now - win_t) / 0.35)
    A = int(255 * wa)
    sc = scrim
    if wa < 1:
        sc = scrim.copy()
        sc.putalpha(scrim.getchannel("A").point(lambda v: int(v * wa)))
    ov.alpha_composite(sc, (0, WC_TOP))
    wname, wbgr = colors[winner]
    wrgb = (wbgr[2], wbgr[1], wbgr[0])
    lf = _font(30)
    lw = _spaced_w(d, "ESCAPED FIRST", lf, 9)
    _spaced(d, ((W - lw) / 2, WC_TOP + 150), "ESCAPED FIRST", lf, (255, 255, 255, int(225 * wa)), 9)
    nf = _font(140)
    nw = d.textlength(wname, font=nf)
    if nw > W - 76:
        nf = _font(int(140 * (W - 76) / nw))
        nw = d.textlength(wname, font=nf)
    for rad in (16, 10, 5):
        for ang in range(0, 360, 45):
            d.text(((W - nw) / 2 + int(math.cos(math.radians(ang)) * rad),
                    WC_TOP + 198 + int(math.sin(math.radians(ang)) * rad)),
                   wname, font=nf, fill=wrgb + (int(58 * wa),))
    d.text(((W - nw) / 2, WC_TOP + 198), wname, font=nf, fill=wrgb + (A,))


# --- audio --------------------------------------------------
def synth_audio(res, out_wav):
    """SFX only — no music, no bass 'boom'. Every wall bounce is a soft glassy
    music-box note that climbs the scale as a ball gets deeper; slipping through
    a ring is a gentle airy 'shff' + a bright little 'ting'; the winner gets a
    warm music-box arpeggio with a shimmer. Light room, soft-clipped, easy on
    the ear — the caller loudnorm's the final mux."""
    import soundfile as sf
    from scipy.signal import lfilter

    events = res["events"]
    duration = res["duration"]
    sr = 48000
    n = int((duration + 2.5) * sr)
    buf = np.zeros((n, 2), np.float32)
    scr = np.arange(3 * sr) / sr

    def pan(x01):
        p = 0.24 + 0.52 * min(1.0, max(0.0, float(x01)))
        return math.cos(p * math.pi / 2), math.sin(p * math.pi / 2)

    def place(mono, i, x01, g):
        m = len(mono)
        if i < 0 or i + m >= n:
            return
        lft, rgt = pan(x01)
        buf[i:i + m, 0] += mono * (g * lft)
        buf[i:i + m, 1] += mono * (g * rgt)

    def mbox(freq, dur=0.5, decay=11.0):
        """Rounded music-box / celesta tone — fundamental + a soft octave, quick
        soft attack, gentle tail. Pure sine, nothing harsh."""
        m = int(dur * sr)
        tt = scr[:m]
        env = np.exp(-tt * decay)
        at = min(m, int(0.004 * sr))
        env[:at] *= np.sin(np.linspace(0, math.pi / 2, at)) ** 2
        ph = 2 * math.pi * freq * tt
        body = np.sin(ph) + 0.28 * np.sin(2 * ph) * np.exp(-tt * decay * 2.0)
        return (body * env).astype(np.float32)

    def tick(freq, seed):
        """A tiny soft 'tock' for ball-to-ball taps — barely there."""
        m = int(0.07 * sr)
        tt = scr[:m]
        rr = np.random.default_rng(seed)
        f = freq * (1.0 + (rr.random() - 0.5) * 0.12)
        env = np.exp(-tt * 40.0)
        return (np.sin(2 * math.pi * f * tt) * env).astype(np.float32)

    def shff(dur=0.26):
        """Airy filtered-noise sweep upward — the 'slipped through' whisper."""
        m = int(dur * sr)
        rr = np.random.default_rng(11)
        noise = rr.standard_normal(m)
        # brighten over time by mixing a rising-cutoff-ish emphasis
        env = np.sin(np.linspace(0, math.pi, m)) ** 1.6
        hp = noise - lfilter([0.02], [1.0, -0.98], noise)
        return (hp * env * 0.5).astype(np.float32)

    def ting(freq):
        m = int(0.5 * sr)
        tt = scr[:m]
        env = np.exp(-tt * 9.0)
        return ((np.sin(2 * math.pi * freq * tt) + 0.22 * np.sin(2 * math.pi * 3 * freq * tt) * np.exp(-tt * 20.0))
                * env * 0.5).astype(np.float32)

    def shimmer():
        m = int(1.1 * sr)
        tt = scr[:m]
        out = np.zeros(m, np.float32)
        rr = np.random.default_rng(5)
        for _ in range(9):
            f = rr.uniform(1400.0, 3200.0)
            s = int(rr.uniform(0, 0.5) * sr)
            e = np.exp(-(tt) * rr.uniform(7.0, 13.0))
            g = rr.uniform(0.15, 0.4)
            out[s:] += (np.sin(2 * math.pi * f * tt[: m - s]) * e[: m - s] * g)
        return (out * 0.5).astype(np.float32)

    # bounces — rate-limited (loudest per slot), climbing pentatonic music-box
    bounces = sorted((e for e in events if e[1] == "bounce"), key=lambda e: e[0])
    wv = 1.0 / SND_MAX_RATE
    kept, last_slot, best = [], -1, None
    for e in bounces:
        s = int(e[0] / wv)
        if s != last_slot:
            if best:
                kept.append(best)
            last_slot, best = s, e
        elif e[4] > best[4]:
            best = e
    if best:
        kept.append(best)
    for (t, _k, _lv, pitch01, vol, x01) in kept:
        idx = int(np.clip(pitch01, 0, 1) * (len(_PENTA) - 1))
        place(mbox(float(_PENTA[idx]) * 2.0, 0.4, 12.0), int(t * sr), x01, 0.15 * (0.5 + 0.5 * vol))

    for (t, kind, *rest) in events:
        if kind == "clack":
            x01, imp = rest
            place(tick(320.0 + 160.0 * min(1.0, imp / 900.0), 0xC0 + int(t * 97) % 900),
                  int(t * sr), x01, 0.09 * min(1.0, imp / 650.0))
        elif kind == "escape":
            lvl, _bi, x01 = rest
            i = int(t * sr)
            place(shff(), i, x01, 0.16)
            place(ting(880.0 * (2 ** (min(7, lvl) / 12.0))), i + int(0.06 * sr), x01, 0.17)
        elif kind == "win":
            i = int(t * sr)
            x01 = rest[2]
            for k, mult in enumerate((1.0, 1.5, 2.0, 2.51, 3.0)):
                place(mbox(392.0 * mult, 1.2, 4.5), i + int(k * 0.085 * sr), x01, 0.24 - k * 0.028)
            place(shimmer(), i + int(0.1 * sr), x01, 0.14)

    def comb(x, dcy, g):
        y = x.copy()
        for s0 in range(dcy, len(x), dcy):
            s1 = min(s0 + dcy, len(x))
            y[s0:s1] += g * y[s0 - dcy:s0 - dcy + (s1 - s0)]
        return y

    mono = buf.mean(axis=1)
    wet = np.zeros(n, np.float32)
    for D, g in [(1361, 0.36), (1747, 0.32), (2111, 0.28)]:
        wet += comb(mono, D, g)
    wet = (lfilter([0.22], [1.0, -0.78], wet) * 0.055).astype(np.float32)
    buf[:, 0] += wet
    buf[:, 1] += np.concatenate([np.zeros(31, np.float32), wet[:-31]])

    y = buf - lfilter([0.010], [1.0, -0.990], buf, axis=0)   # trim any sub rumble
    y = lfilter([0.55], [1.0, -0.45], y, axis=0)             # soften the very top
    peak = float(np.max(np.abs(y))) or 1.0
    y = np.tanh(y / peak * 0.95) * 0.52
    sf.write(out_wav, y.astype(np.float32), sr, subtype="PCM_16")


# --- main --------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=-1)
    ap.add_argument("--balls", type=int, default=4)
    ap.add_argument("--rings", type=int, default=8)
    ap.add_argument("--target", type=float, default=22.0)
    ap.add_argument("--fonts-dir", default="")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--out-video", required=True)
    ap.add_argument("--out-audio", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    global _FONT_DIR
    _FONT_DIR = args.fonts_dir or os.path.join(os.path.dirname(__file__), "..", "assets", "fonts")

    base = args.seed if args.seed >= 0 else int(np.random.SeedSequence().entropy % 2_000_000)
    n_balls = max(3, min(6, args.balls))
    n_rings = max(3, min(14, args.rings))
    target = max(12.0, min(45.0, args.target))
    log(f"escape race · seed {base} · {n_balls} balls · {n_rings} rings · ~{target:.0f}s")

    progress(0.04, "tuning the race")

    def run(seed, sc):
        b = start_balls(n_balls, n_rings, np.random.default_rng(seed + 3))
        return simulate(n_rings, b, np.random.default_rng(seed + 7), sc, record=False)

    def quality(res):
        if res["winner"] < 0:
            return 99.0
        gap = abs(res["win_t"] - target) / target
        lv = res["levels"]
        wl = lv[res["winner"]]
        runner = max((v for k, v in lv.items() if k != res["winner"]), default=0)
        close = 0.0 if runner >= wl - 1 else (0.5 if runner >= wl - 2 else 1.4)
        return gap + close

    chosen = best = None
    for attempt in range(12):
        seed = base + attempt * 101
        sc = 1.0
        res = run(seed, sc)
        for _ in range(7):
            if res["winner"] < 0:
                sc *= 1.6
            else:
                err = res["win_t"] / target
                if 0.85 <= err <= 1.15:
                    break
                sc = float(np.clip(sc * err ** 0.85, 0.3, 4.0))
            res = run(seed, sc)
        q = quality(res)
        log(f"  seed {seed}: {res['win_t']:.1f}s  scale {sc:.2f}  q {q:.2f}")
        if q <= 0.2:
            chosen = (seed, sc)
            break
        if best is None or q < best[2]:
            best = (seed, sc, q)

    if chosen:
        seed, sc = chosen
    elif best:
        seed, sc = best[0], best[1]
        log(f"best-effort seed {seed} (q {best[2]:.2f})")
    else:
        seed, sc = base, 2.4
        log("fallback: fast race")

    pool = 4 if n_balls <= 4 else len(MARBLE_COLORS)
    perm = np.random.default_rng((seed ^ 0x9E3779B9) & 0xFFFFFFFF).permutation(pool)
    colors = [MARBLE_COLORS[k] for k in perm[:n_balls]]

    progress(0.16, "running the race")
    balls = start_balls(n_balls, n_rings, np.random.default_rng(seed + 3))
    res = simulate(n_rings, balls, np.random.default_rng(seed + 7), sc, record=True)
    if res["winner"] < 0:
        raise SystemExit("escaperace: the race did not finish")
    wname = colors[res["winner"]][0]
    log(f"{' vs '.join(c[0] for c in colors)} -> {wname} escapes first "
        f"at {res['win_t']:.1f}s ({len(res['frames'])} frames)")

    progress(0.34, "rendering")
    render(res, colors, args.ffmpeg, args.out_video)

    progress(0.95, "sound design")
    synth_audio(res, args.out_audio)

    wb, wg, wr = colors[res["winner"]][1]
    emit_result({
        "seed": int(seed),
        "map": "rings",
        "mapName": f"{res['n_rings']} RINGS",
        "winner": wname,
        "winnerRgb": [int(wr), int(wg), int(wb)],
        "colors": [c[0] for c in colors],
        "winAtSec": round(res["win_t"], 2),
        "durationSec": round(res["duration"], 2),
        "rings": int(res["n_rings"]),
        "events": len(res["events"]),
    }, args.out)
    progress(1.0, "done")


if __name__ == "__main__":
    main()
