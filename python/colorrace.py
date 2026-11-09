"""Procedural "which colour will win?" marble race — Marble Rush edition.

Five hand-built courses, each a tall vertical descent the camera chases:

  * ZIGZAG RUSH       slalom ramps, wall trampolines, boost bands
  * PEG STORM         a deep Plinko field — pure luck
  * SPINNER GAUNTLET  eight rotating blades that fling you sideways
  * THE FORK          the track splits every screen; one lane is a mud trap
  * BUMPER PARK       giant bouncy bumpers, pinball chaos

The map layout is chosen (or randomised) up front; within a course every run is
different — pegs jitter, zones shift, blades spin at new speeds, the colours are
re-shuffled — so the winner is never the same twice.

The sim is deterministic given its seed (the video shows one fixed outcome), it
finishes for certain (anti-stall nudges any marble that stops making progress),
and it self-tunes gravity so the race lands near the requested length. A close
race near the line drops into a "photo finish" slow-mo.

Look: dark gradient, neon obstacles with a soft glow, motion trails, spark
bursts on hard hits, a full HUD (map badge, live leaderboard, 3-2-1 countdown,
winner card + podium), 60fps.

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

# --- viewport + timing -------------------------------------------------
W, H_VIEW = 1080, 1920             # native 9:16; final frame is inset (SAFE_SCALE)
FPS = 60
SUBSTEPS = 5
COUNT_SECS = 2.6                    # 3-2-1-GO before the gate drops
SAFE_TOP = 150                     # TikTok's top tabs — keep HUD text below this
SAFE_SCALE = 0.90                  # render full-res, then inset a touch so nothing
                                   # sits under TikTok's buttons / caption when watched

# --- physics (ported from the Marble Rush reference) ------------------
BALL_R = 38.0
GRAV_DEFAULT = 2700.0
BOUNCE = 1.0                        # global bounciness multiplier
E_BOUNCY = 1.02                     # >1 → trampolines add energy
E_SOLID = 0.44
FRICTION = 0.035                    # tangential rub on every contact
WALL_MARGIN = 16.0
WALL_KEEP = 0.55                    # vx retained bouncing off a side wall
FLOOR_KEEP = 0.30
SPEED_CAP = 2900.0
E_BALL = 0.92                       # marble ↔ marble
SPARK_IMP = 260.0                   # impulse above which a hit throws sparks

SND_COOLDOWN = 0.24                # min seconds between sounds from one marble
SND_MAX_RATE = 5                  # global cap on hit sounds/sec — kept sparse
SND_MIN_IMP = 240.0               # grazes below this are silent

# obstacle colours — BGR for OpenCV (hex in the comment)
KIND_COL = {
    "wall":   (74, 47, 43),        # #2b2f4a
    "edge":   (128, 80, 74),       # #4a5080
    "bouncy": (246, 92, 139),      # #8b5cf6  violet trampoline
    "boost":  (163, 255, 0),       # #00ffa3  green
    "mud":    (113, 61, 255),      # #ff3d71  pink slow-zone
    "gate":   (168, 131, 122),     # #7a83a8
}
COL_BOOST = (163, 255, 0)
COL_MUD = (113, 61, 255)
COL_SPARK_BOUNCY = (253, 181, 196)  # #c4b5fd

# marble colours — the reference palette, +2 for 5-6 racers (BGR)
MARBLE_COLORS = [
    ("CYAN",    (255, 231, 0)),     # #00e7ff
    ("MAGENTA", (149, 45, 255)),    # #ff2d95
    ("LIME",    (46, 255, 180)),    # #b4ff2e
    ("AMBER",   (32, 176, 255)),    # #ffb020
    ("CORAL",   (60, 90, 255)),     # #ff5a3c
    ("VIOLET",  (247, 85, 168)),    # #a855f7
]

MAP_IDS = ["zigzag", "pegstorm", "spinner", "fork", "bumper"]

# C-major pentatonic across three octaves — any bounce lands on a pleasant note
# C-major pentatonic, kept LOW (C3–C5) so a busy map never turns shrill
_PENTA = []
for _octv in (0, 1):
    for _semi in (0, 2, 4, 7, 9):
        _PENTA.append(130.81 * (2 ** (_octv + _semi / 12.0)))
_PENTA = np.array(_PENTA)


# --- geometry helper -------------------------------------------------

def closest_on_seg(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    ab2 = abx * abx + aby * aby
    if ab2 < 1e-9:
        return ax, ay
    t = ((px - ax) * abx + (py - ay) * aby) / ab2
    t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
    return ax + t * abx, ay + t * aby


# --- maps -----------------------------------------------------------

def build_map(map_id: str, rng: np.random.Generator, stretch: float = 1.0) -> dict:
    """One of the five courses. `rng` jitters everything that can safely move;
    `stretch` (~0.85–1.8) scales the course length for shorter / longer targets."""
    G: list[dict] = []
    Z: list[dict] = []
    S: list[dict] = []
    st = stretch

    def seg(x1, y1, x2, y2, kind="wall", rad=11.0, slip=False):
        G.append({"t": "s", "x1": x1, "y1": y1, "x2": x2, "y2": y2, "kind": kind, "rad": rad, "slip": slip})

    def peg(x, y, r, kind="wall"):
        G.append({"t": "c", "x": x, "y": y, "r": r, "kind": kind})

    def zone(x, y, w, h, kind):
        Z.append({"x": x, "y": y, "w": w, "h": h, "kind": kind})

    def spin(x, y, ln, speed, arms=2):
        # `phase` is the fixed starting angle; the live angle lives in sim-local
        # state so `simulate()` never mutates the map (tuner vs render must match).
        S.append({"x": x, "y": y, "len": ln, "speed": speed, "arms": arms,
                  "rad": 19.0, "phase": float(rng.uniform(0, 6.28))})

    def j(a):  # symmetric jitter
        return float(rng.uniform(-a, a))

    if map_id == "zigzag":
        name = "ZIGZAG RUSH"
        tag = "SLALOM · SPINNERS · BOOST BANDS"
        rows = max(9, min(20, round(9 + 3.5 * (st - 1))))    # length = more ramps, not air
        gap = rng.uniform(432, 470)
        for i in range(rows):
            y = 540 + i * gap
            # the slalom ramps are SLICK — marbles that land on one shoot straight
            # off it instead of dawdling along the top.
            if i % 2 == 0:
                seg(20, y, 700 + j(40), y + 300, slip=True)
                peg(840 + j(20), y + 380, 50 + j(4), "bouncy")
            else:
                seg(1060, y, 380 + j(40), y + 300, slip=True)
                peg(240 + j(20), y + 380, 50 + j(4), "bouncy")
            if i % 4 == 2:                         # a slow paddle mid-descent
                spin(540 + j(60), y + 150 + j(30), 150 + j(20),
                     rng.uniform(1.4, 2.2) * (1 if rng.random() > 0.5 else -1), 1)
            if i % 2 == 1:
                zone(0, y + 90 + j(24), 1080, 150, "boost")
            if i % 5 == 3:
                zone(0, y + 90 + j(24), 600, 170, "mud")

    elif map_id == "pegstorm":
        name = "PEG STORM"
        tag = "PLINKO CHAOS · PURE LUCK"
        off_amt = rng.uniform(94, 120)
        row_gap = rng.uniform(184, 204)          # kept dense — length comes from more rows
        n_rows = max(18, min(44, round(20 + 9 * (st - 1))))
        bmod = int(rng.integers(4, 7))
        bphase = int(rng.integers(0, bmod))
        for r in range(n_rows):
            y = 640 + r * row_gap
            off = off_amt if r % 2 else 0.0
            bouncy = (r % bmod) == bphase
            for c in range(5):
                peg(120 + off + c * 216 + j(7), y + j(6),
                    21.0 + (4.0 if bouncy else 0.0), "bouncy" if bouncy else "wall")
        for rr in (round(n_rows * 0.32), round(n_rows * 0.68)):
            fy = 640 + rr * row_gap + j(90)
            seg(-40, fy, 350 + j(40), fy + 190)
            seg(1120, fy, 730 + j(40), fy + 190)
        for k in range(2 + int(st > 1.5)):        # rotating paddles break up the field
            spin(rng.uniform(280, 800), 640 + (0.2 + 0.55 * k / max(1, 2)) * n_rows * row_gap + j(80),
                 rng.uniform(150, 210), rng.uniform(1.8, 2.8) * (1 if rng.random() > 0.5 else -1), 2)
        zone(0, 640 + round(n_rows * 0.38) * row_gap, 460, 240, "mud")
        zone(620, 640 + round(n_rows * 0.74) * row_gap, 460, 240, "boost")
        base_y = 640 + n_rows * row_gap
        zone(0, base_y, 1080, 380, "boost")
        seg(300, base_y + 130, 300, base_y + 560, "bouncy", 12)
        seg(780, base_y + 130, 780, base_y + 560, "bouncy", 12)

    elif map_id == "spinner":
        name = "SPINNER GAUNTLET"
        tag = "ROTATING BLADES · BIG SWINGS"
        rows = max(8, min(18, round(8 + 3.0 * (st - 1))))
        gap = rng.uniform(468, 520)
        for i in range(rows):
            y = 780 + i * gap
            left = i % 2 == 0
            speed = (2.6 if left else -2.9) * (1 + i * 0.03) * rng.uniform(0.82, 1.2)
            spin((380 if left else 700) + j(40), y, 265 + j(18), speed, 2)
            seg(760 if left else 0, y + 235, 1080 if left else 320, y + 235, "bouncy", 14)
            if i % 2 == 0:
                zone(0, y + 320, 1080, 210, "boost" if (i // 2) % 2 == 0 else "mud")

    elif map_id == "fork":
        name = "THE FORK"
        tag = "PICK A LANE · ONE IS A TRAP"
        n_forks = max(4, min(8, round(4 + 2.0 * (st - 1))))   # more splits for longer targets
        gap = max(1240.0, rng.uniform(1290, 1410))
        for i in range(n_forks):
            y = 700 + i * gap
            fast_left = bool(rng.integers(0, 2))
            peg(540 + j(18), y - 40, 40, "bouncy")
            if i % 2 == 1:                         # a spinner guarding the split
                spin(540 + j(30), y + 560 + j(40), 170 + j(20),
                     rng.uniform(2.0, 3.0) * (1 if fast_left else -1), 2)
            seg(540, y, 250, y + 300)
            seg(540, y, 830, y + 300)
            seg(120, y + 300, 250, y + 300, "wall", 9)
            seg(830, y + 300, 960, y + 300, "wall", 9)
            seg(250, y + 300, 250, y + 900, "bouncy", 12)
            seg(830, y + 300, 830, y + 900, "bouncy", 12)
            zone(20 if fast_left else 560, y + 340, 500, 520, "boost")
            zone(560 if fast_left else 20, y + 340, 500, 520, "mud")
            px = 690 if fast_left else 250
            for k in range(3):
                peg(px + (120 if k % 2 else 0) + j(10), y + 420 + k * 170, 24, "wall")
            seg(250, y + 900, 480, y + 1120)
            seg(830, y + 900, 600, y + 1120)

    else:  # bumper
        map_id = "bumper"
        name = "BUMPER PARK"
        tag = "GIANT BUMPERS · PINBALL CHAOS"
        rows = max(11, min(24, round(11 + 3.5 * (st - 1))))
        gap = rng.uniform(400, 442)
        for i in range(rows):
            y = 820 + i * gap
            odd = i % 2 == 1
            peg((320 if odd else 760) + j(28), y + j(12), 58 + j(6), "bouncy")
            peg((800 if odd else 280) + j(28), y + 210 + j(12), 40 + j(5), "bouncy")
            peg(540 + j(14), y + 110, 26, "wall")
            peg((180 if odd else 900) + j(20), y + 250 + j(14), 22, "wall")
            if i % 2 == 1:                         # fast spinners in the chaos
                spin(540 + j(120), y + 110 + j(30), 130 + j(20),
                     rng.uniform(3.0, 4.2) * (1 if rng.random() > 0.5 else -1), 2)
            seg(-40, y - 130, 300, y - 40)
            seg(1120, y - 130, 780, y - 40)
            if i % 5 == 2:
                zone(0, y + 250, 1080, 200, "boost")
            if i % 7 == 4:
                zone(120, y + 250, 840, 220, "mud")

    # shift the whole course down so there's room above for the drop + gate
    DY = 300.0
    for o in G:
        if o["t"] == "s":
            o["y1"] += DY
            o["y2"] += DY
        else:
            o["y"] += DY
    for z in Z:
        z["y"] += DY
    for sp in S:
        sp["y"] += DY

    # the finish sits just past the lowest obstacle (robust to jitter + stretch)
    bottom = max((max(o["y1"], o["y2"]) if o["t"] == "s" else o["y"] + o["r"]) for o in G)
    bottom = max(bottom, max((z["y"] + z["h"] for z in Z), default=0.0))
    finish_y = bottom + 150.0
    H = finish_y + 260.0

    gate = {"t": "s", "x1": 60.0, "y1": 660.0, "x2": 1020.0, "y2": 660.0,
            "kind": "gate", "rad": 12.0, "is_gate": True, "open": False}
    G.append(gate)

    # broad-phase: bucket every obstacle into 300px rows
    grid: dict[int, list] = {}

    def gpush(o, a, b):
        for r in range(int(a // 300) - 1, int(b // 300) + 2):
            grid.setdefault(r, []).append(o)

    for o in G:
        if o["t"] == "s":
            gpush(o, min(o["y1"], o["y2"]) - o["rad"], max(o["y1"], o["y2"]) + o["rad"])
        else:
            gpush(o, o["y"] - o["r"], o["y"] + o["r"])

    return {"id": map_id, "name": name, "tag": tag, "H": H, "geo": G, "zones": Z,
            "spinners": S, "finish_y": finish_y, "gate": gate, "grid": grid}


def start_positions(n: int, rng: np.random.Generator):
    xs = np.linspace(232, 848, n)
    return [(float(x + rng.uniform(-12, 12)), 470.0 + (i % 2) * 44.0) for i, x in enumerate(xs)]


# --- simulation ----------------------------------------------------

class Marble:
    __slots__ = ("i", "x", "y", "vx", "vy", "best", "rank", "gscale",
                 "flash", "still", "stall", "snd_t", "note", "zones")

    def __init__(self, i, x, y):
        self.i = i
        self.x, self.y = x, y
        self.vx = self.vy = 0.0
        self.best = y
        self.rank = 0                # 0 = still racing, else finishing place
        self.gscale = 1.0           # gentle catch-up: trailers fall faster, leaders slower
        self.flash = 0.0
        self.still = self.stall = 0.0
        self.snd_t = -1.0
        self.note = i
        self.zones: set[int] = set()


def _hit(b: Marble, px, py, rad, kind, svx, svy, srng, events, now, sparks, slip=False):
    """Resolve a circle vs (point/segment) contact. `svx,svy` = surface velocity.
    `slip` → a near-frictionless "slick" surface: the marble hugs it (low bounce)
    and keeps almost all its along-surface speed, so it slides right off.
    `srng` is a *cosmetic* generator for spark jitter only — kept separate from the
    physics RNG so a recorded run matches the tuner's no-record run exactly."""
    nx, ny = b.x - px, b.y - py
    d = math.hypot(nx, ny)
    mind = BALL_R + rad
    if d >= mind:
        return
    if d < 1e-6:
        nx, ny, d = 0.0, -1.0, 1.0
    nx /= d
    ny /= d
    b.x += nx * (mind - d)
    b.y += ny * (mind - d)
    rvx, rvy = b.vx - svx, b.vy - svy
    vn = rvx * nx + rvy * ny
    if vn >= 0:
        return
    if slip:
        # a slick rail: hug it (low bounce), keep essentially all along-surface
        # speed → gravity slides the marble straight off it.
        e = 0.10 * BOUNCE
        fric = 0.0015
    else:
        e = (E_BOUNCY if kind == "bouncy" else E_SOLID) * BOUNCE
        fric = FRICTION
    ox = rvx - (1 + e) * vn * nx
    oy = rvy - (1 + e) * vn * ny
    tx, ty = -ny, nx
    vt = ox * tx + oy * ty
    ox -= vt * fric * tx
    oy -= vt * fric * ty
    b.vx = ox + svx
    b.vy = oy + svy
    imp = -vn
    if imp > SPARK_IMP:
        b.flash = min(1.0, imp / 1400.0)
        if sparks is not None and len(sparks) < 200:
            cidx = -1 if kind == "bouncy" else b.i
            for _ in range(3):
                sparks.append([px + nx * rad, py + ny * rad,
                               nx * imp * 0.30 + (srng.random() - 0.5) * 200.0,
                               ny * imp * 0.30 + (srng.random() - 0.5) * 200.0,
                               1.0, cidx])
    if imp > SND_MIN_IMP and now - b.snd_t > SND_COOLDOWN:
        b.snd_t = now
        b.note = (b.note + (2 if kind == "bouncy" else 3)) % len(_PENTA)
        snd = "bouncy" if kind == "bouncy" else "peg" if rad < 30 else "wall"
        events.append((now, snd, b.note / len(_PENTA), 0.2 + 0.5 * min(1.0, imp / 1100.0), b.x / W))


def step_physics(m, marbles, dt, g, rng, srng, events, now, sparks, spin_ang, gate_open):
    for i in range(len(spin_ang)):
        spin_ang[i] += m["spinners"][i]["speed"] * dt

    grid = m["grid"]
    for b in marbles:
        if b.rank:
            continue
        b.vy += g * b.gscale * dt
        b.x += b.vx * dt
        b.y += b.vy * dt

        lo, hi = BALL_R + WALL_MARGIN, W - BALL_R - WALL_MARGIN
        if b.x < lo:
            b.x, b.vx = lo, abs(b.vx) * WALL_KEEP
        elif b.x > hi:
            b.x, b.vx = hi, -abs(b.vx) * WALL_KEEP
        if b.y > m["H"] - 40:
            b.y, b.vy = m["H"] - 40, -abs(b.vy) * FLOOR_KEEP

        for o in grid.get(int(b.y // 300), ()):
            if o.get("is_gate") and gate_open:
                continue
            if o["t"] == "s":
                cx, cy = closest_on_seg(b.x, b.y, o["x1"], o["y1"], o["x2"], o["y2"])
                _hit(b, cx, cy, o["rad"], o["kind"], 0.0, 0.0, srng, events, now, sparks, o.get("slip", False))
            else:
                _hit(b, o["x"], o["y"], o["r"], o["kind"], 0.0, 0.0, srng, events, now, sparks)

        for si, sp in enumerate(m["spinners"]):
            if abs(b.y - sp["y"]) > sp["len"] + BALL_R + 40:
                continue
            two_pi = 2 * math.pi
            for a in range(sp["arms"]):
                ang = spin_ang[si] + a * (two_pi / sp["arms"])
                ex = math.cos(ang) * sp["len"]
                ey = math.sin(ang) * sp["len"]
                cx, cy = closest_on_seg(b.x, b.y, sp["x"], sp["y"], sp["x"] + ex, sp["y"] + ey)
                svx = -(cy - sp["y"]) * sp["speed"]
                svy = (cx - sp["x"]) * sp["speed"]
                _hit(b, cx, cy, sp["rad"], "bouncy", svx, svy, srng, events, now, sparks)
            _hit(b, sp["x"], sp["y"], 26.0, "wall", 0.0, 0.0, srng, events, now, sparks)

        for z in m["zones"]:
            inside = z["x"] < b.x < z["x"] + z["w"] and z["y"] < b.y < z["y"] + z["h"]
            zid = id(z)
            if inside:
                if z["kind"] == "boost":
                    b.vy += 2600 * dt
                    b.vx *= 1 + 1.2 * dt
                    if zid not in b.zones and now - b.snd_t > 0.06:
                        b.snd_t = now
                        events.append((now, "boost", 0.7, 0.5, b.x / W))
                else:
                    b.vx *= 1 - 3.4 * dt
                    b.vy *= 1 - 2.6 * dt
                    if zid not in b.zones and now - b.snd_t > 0.06:
                        b.snd_t = now
                        events.append((now, "mud", 0.3, 0.5, b.x / W))
                b.zones.add(zid)
            else:
                b.zones.discard(zid)

        sp2 = math.hypot(b.vx, b.vy)
        if sp2 > SPEED_CAP:
            b.vx *= SPEED_CAP / sp2
            b.vy *= SPEED_CAP / sp2
        if sp2 < 60:
            b.still += dt
            if b.still > 1.2:
                b.vx += (rng.random() - 0.5) * 700
                b.vy -= 300
                b.still = 0.0
        else:
            b.still = 0.0
        if b.y > b.best:
            b.best = b.y
            b.stall = 0.0
        else:
            b.stall += dt
            if b.stall > 2.2:
                b.vy += 1300
                b.vx += (rng.random() - 0.5) * 900
                b.stall = 0.0
        if b.flash > 0:
            b.flash -= dt * 7

    n = len(marbles)
    for i in range(n):
        a = marbles[i]
        if a.rank:
            continue
        for k in range(i + 1, n):
            c = marbles[k]
            if c.rank:
                continue
            dx, dy = c.x - a.x, c.y - a.y
            d = math.hypot(dx, dy)
            mind = 2 * BALL_R
            if d >= mind or d < 1e-6:
                continue
            nx, ny = dx / d, dy / d
            corr = (mind - d) / 2
            a.x -= nx * corr
            a.y -= ny * corr
            c.x += nx * corr
            c.y += ny * corr
            vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny
            if vn < 0:
                p = -(1 + E_BALL) * vn / 2
                a.vx -= p * nx
                a.vy -= p * ny
                c.vx += p * nx
                c.vy += p * ny
                a.flash = c.flash = 0.7
                if -vn > SND_MIN_IMP and now - a.snd_t > SND_COOLDOWN and now - c.snd_t > SND_COOLDOWN:
                    a.snd_t = c.snd_t = now
                    events.append((now, "ball", 0.1, 0.16 + 0.3 * min(1.0, -vn / 800.0),
                                   (a.x + c.x) / (2 * W)))

    if sparks is not None:
        for s in sparks:
            s[3] += 1400 * dt
            s[0] += s[2] * dt
            s[1] += s[3] * dt
            s[4] -= dt * 2.2
        sparks[:] = [s for s in sparks if s[4] > 0]


def simulate(m, starts, rng, gravity, record=False, max_sec=42.0):
    marbles = [Marble(i, x + (rng.random() - 0.5) * 30, y) for i, (x, y) in enumerate(starts)]
    for b in marbles:
        b.vx = (rng.random() - 0.5) * 60

    n = len(marbles)
    dt_frame = 1.0 / FPS
    time = 0.0
    cam = 0.0
    cam_targ = 0.0
    time_scale = 1.0
    phase = "count"
    run_t = 0.0
    finished = 0
    winner = -1
    win_t = 0.0
    over_at = 0.0
    events: list[tuple] = []
    frames: list[dict] = []
    motion: list[float] = []
    sparks: list[list] | None = [] if record else None
    srng = np.random.default_rng(0x5EEDCAFE)   # cosmetic spark jitter only
    lead_hist: list[int] = []
    finish_order: list[tuple[int, float]] = []
    finish_y = m["finish_y"]
    span_top = min(y for _, y in starts)
    spin_ang = [sp["phase"] for sp in m["spinners"]]   # sim-local — never touches the map
    gate_open = False

    while True:
        if phase == "count":
            left = COUNT_SECS - time
            cd = "3" if left > 1.7 else "2" if left > 0.9 else "1" if left > 0.1 else "GO"
            gate_open = left < 0.1
            if left < -0.45:
                phase = "run"
                run_t = time
        else:
            cd = None

        lead = max(marbles, key=lambda b: b.best)
        by_best = sorted(marbles, key=lambda b: b.best, reverse=True)
        close = n > 1 and (by_best[0].best - by_best[1].best) < 260
        near = finish_y - lead.best
        slow = phase == "run" and finished == 0 and -60 < near < 620 and close
        time_scale += ((0.32 if slow else 1.0) - time_scale) * min(1.0, dt_frame * 9)

        # rubber-band — keeps the pack together so the finish stays close AND every
        # marble stays on screen. Scales with how far the field has spread, so it
        # reads as momentum swings rather than a scripted catch-up.
        racing = [b for b in marbles if not b.rank]
        if phase == "run" and len(racing) >= 2:
            lo_b = min(b.best for b in racing)
            hi_b = max(b.best for b in racing)
            span = max(1.0, hi_b - lo_b)
            k = min(1.4, span / 650.0)
            for b in racing:
                frac = (b.best - lo_b) / span
                b.gscale = 1.0 + k * (0.14 * (1.0 - frac) - 0.11 * frac)
        else:
            for b in racing:
                b.gscale = 1.0

        if phase != "over":
            sdt = dt_frame * time_scale / SUBSTEPS
            for _ in range(SUBSTEPS):
                step_physics(m, marbles, sdt, gravity, rng, srng, events, time, sparks, spin_ang, gate_open)

        for b in marbles:
            if b.rank == 0 and b.y > finish_y:
                finished += 1
                b.rank = finished
                finish_order.append((b.i, time))
                events.append((time, "goal", 0.0, 1.0, b.x / W))
                if winner < 0:
                    winner = b.i
                    win_t = time

        # once the win + the podium places are settled, don't make viewers watch
        # the tail — rank whoever's left by depth and wrap up.
        podium_n = min(3, n)
        if winner >= 0 and (finished >= podium_n or time - win_t > 2.8) and finished < n:
            for j, b in enumerate(sorted((b for b in marbles if b.rank == 0),
                                         key=lambda b: b.best, reverse=True)):
                finished += 1
                b.rank = finished
                finish_order.append((b.i, time + 0.3 * (j + 1)))

        # camera — always keep the race leader (most progress = 1st place) in shot,
        # ~62% of the way down. Two-stage smoothing (de-jitter the aim, then ease the
        # camera toward it) + a pan-speed cap so a bouncing leader never whips it.
        alive = [b for b in marbles if not b.rank] or marbles
        lead_now = max(alive, key=lambda b: b.best)
        raw = max(0.0, min(m["H"] - H_VIEW, lead_now.y - H_VIEW * 0.62))
        cam_targ += (raw - cam_targ) * min(1.0, dt_frame * 3.0)
        step = (cam_targ - cam) * min(1.0, dt_frame * 4.0)
        cap = 1150.0 * dt_frame
        cam += max(-cap, min(cap, step))

        if phase == "run":
            lead_hist.append(lead.i)

        if record:
            frames.append({
                "t": time,
                "cam": cam,
                "cd": cd,
                "slow": slow,
                "phase": phase,
                "balls": [(b.x, b.y, b.i, b.best, b.rank, b.flash) for b in marbles],
                "spin": list(spin_ang),
                "sparks": [(s[0], s[1], s[4], int(s[5])) for s in sparks],
            })
            # marble-motion envelope drives the rolling-sound bed
            motion.append(sum(math.hypot(b.vx, b.vy) for b in marbles if not b.rank))

        if finished >= n and phase != "over":
            phase = "over"
            over_at = time
        if phase == "over" and time - over_at > 2.6:
            break
        if winner >= 0 and time - win_t > 6.0:   # hard cap on the tail
            break
        if time > max_sec:
            break
        time += dt_frame

    return {
        "winner": winner,
        "win_t": win_t,
        "run_t": run_t,
        "duration": time,
        "start_y": span_top,
        "finish_y": finish_y,
        "finish_order": finish_order,
        "events": events,
        "frames": frames,
        "motion": motion,
        "lead_hist": lead_hist,
    }


def _finish_gap(res):
    fo = res["finish_order"]
    return fo[1][1] - fo[0][1] if len(fo) > 1 else 99.0


def _drama_ok(res, target):
    """A race worth posting: right length, some lead changes, and — above all —
    a *close finish* (2nd place crosses within a beat of the winner)."""
    if res["winner"] < 0:
        return False, "no winner"
    wt = res["win_t"]
    if wt < max(10.0, 0.5 * target):
        return False, "too quick"
    if wt > min(2.0 * target, 52.0):
        return False, "too slow"
    if _finish_gap(res) > min(2.8, 0.25 * target):
        return False, "runaway winner"
    lh = res["lead_hist"]
    if len(lh) < 40:
        return False, "too short"
    if len(set(lh)) < 2:
        return False, "one marble led the whole way"
    if lh.count(res["winner"]) > 0.9 * len(lh):
        return False, "led wire to wire"
    return True, "ok"


# --- render --------------------------------------------------------

_FONT_DIR = ""
_FONT_CACHE: dict = {}


# the Marble Rush design uses Chakra Petch (500 / 600 / 700)
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


def _leaderboard(balls, finish_times, start_y, finish_y):
    """Just the running ORDER — no distance-to-finish readout. Returns
    [(cid, done, time_or_None)] sorted 1st → last."""
    n = len(balls)
    rows = []
    for (x, y, cid, best, rank, flash) in balls:
        if rank:
            rows.append((cid, 3.0 + (n - rank), True, finish_times.get(cid)))
        else:
            rows.append((cid, (best - start_y) / max(1.0, finish_y - start_y), False, None))
    rows.sort(key=lambda r: -r[1])
    return [(cid, done, ft) for cid, _p, done, ft in rows]


def render(res, colors, m, shape, ffmpeg, out_video):
    import cv2
    from PIL import Image, ImageDraw

    frames = res["frames"]
    total = len(frames)
    n = len(colors)
    finish_y = res["finish_y"]
    start_y = res["start_y"]
    win_t = res["win_t"]
    run_t = res["run_t"]
    winner = res["winner"]
    finish_times = {cid: t for cid, t in res["finish_order"]}
    geo = m["geo"]
    zones = m["zones"]
    spinners = m["spinners"]

    proc = subprocess.Popen(
        [ffmpeg, "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H_VIEW}",
         "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-preset", "medium",
         "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_video],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    # background — the design's near-black vertical gradient  #0a0a18 → #05050b
    tt = np.linspace(0.0, 1.0, H_VIEW)[:, None, None]
    top = np.array([24.0, 10.0, 10.0])          # #0a0a18 (BGR)
    bot = np.array([11.0, 5.0, 5.0])            # #05050b
    bg = (top * (1 - tt) + bot * tt).astype(np.uint8)
    bg = np.repeat(bg, W, axis=1)

    # vignette — the design's strong radial: 0 inside r=500, up to 0.55 by r=1200
    yy, xx = np.mgrid[0:H_VIEW, 0:W].astype(np.float32)
    dpx = np.sqrt((xx - W / 2.0) ** 2 + (yy - H_VIEW / 2.0) ** 2)
    vig = (1.0 - 0.55 * np.clip((dpx - 500.0) / 700.0, 0.0, 1.0)).astype(np.float32)[..., None]

    # inset — render at full res, then scale the finished frame down a touch and
    # sit it a little high on the same near-black gradient, so the HUD and the
    # action stay clear of TikTok's tabs / side buttons / caption while watched
    ins_w = int(round(W * SAFE_SCALE)) & ~1
    ins_h = int(round(H_VIEW * SAFE_SCALE)) & ~1
    ins_x = (W - ins_w) // 2
    ins_y = int((H_VIEW - ins_h) * 0.42)

    # static neon-glow strip for the whole course (half-res, blurred once)
    gh = int(m["H"] / 2) + H_VIEW
    glow_full = np.zeros((gh, W // 2, 3), np.uint8)
    for o in geo:
        if o["kind"] not in ("bouncy", "boost"):
            continue
        col = KIND_COL[o["kind"]]
        if o["t"] == "s":
            cv2.line(glow_full, (int(o["x1"] / 2), int(o["y1"] / 2)),
                     (int(o["x2"] / 2), int(o["y2"] / 2)), col, int(o["rad"]) + 6, cv2.LINE_AA)
        else:
            cv2.circle(glow_full, (int(o["x"] / 2), int(o["y"] / 2)), int(o["r"] / 2) + 4, col, -1, cv2.LINE_AA)
    for z in zones:
        c = COL_BOOST if z["kind"] == "boost" else COL_MUD
        cv2.rectangle(glow_full, (int(z["x"] / 2), int(z["y"] / 2)),
                      (int((z["x"] + z["w"]) / 2), int((z["y"] + z["h"]) / 2)),
                      tuple(int(v * 0.5) for v in c), -1)
    glow_full = cv2.GaussianBlur(glow_full, (0, 0), 7)

    # ---- shaded sphere + contact-shadow sprites for glossy, dimensional marbles ----
    _SR = int(BALL_R) + 3
    _sd = 2 * _SR + 1
    _syy, _sxx = np.mgrid[0:_sd, 0:_sd].astype(np.float32)
    _snx = (_sxx - _SR) / BALL_R
    _sny = (_syy - _SR) / BALL_R
    _sr2 = _snx * _snx + _sny * _sny
    _sin = _sr2 <= 1.0
    _snz = np.sqrt(np.clip(1.0 - _sr2, 0.0, 1.0))
    _lx, _ly, _lz = -0.40, -0.52, 0.76
    _ll = math.sqrt(_lx * _lx + _ly * _ly + _lz * _lz)
    _lx, _ly, _lz = _lx / _ll, _ly / _ll, _lz / _ll
    _ndl = np.clip(_snx * _lx + _sny * _ly + _snz * _lz, 0.0, 1.0)
    _rim = (np.clip(1.0 - _snz, 0, 1) ** 2.4) * 0.6
    SPH_TINT = np.clip(0.34 + 0.92 * _ndl + _rim, 0.0, 1.75)[..., None].astype(np.float32)
    SPH_SPEC = ((_ndl ** 55) * 1.5 * _sin)[..., None].astype(np.float32)
    SPH_A = np.maximum(np.clip((1.0 - _sr2) * (BALL_R * 0.6), 0.0, 1.0),
                       _sin.astype(np.float32))[..., None].astype(np.float32)
    _shr = int(BALL_R * 1.6)
    _shy, _shx = np.mgrid[0:2 * _shr + 1, 0:2 * _shr + 1].astype(np.float32)
    _shd = ((_shx - _shr) / _shr) ** 2 + ((_shy - _shr) / (_shr * 0.5)) ** 2
    SHADOW_A = (np.clip(1.0 - _shd, 0, 1) ** 1.6 * 0.42).astype(np.float32)[..., None]

    def blit_sphere(im, cx, cy, col_bgr, flash):
        x0, y0 = cx - _SR, cy - _SR
        sx0, sy0 = max(0, -x0), max(0, -y0)
        dx0, dy0 = max(0, x0), max(0, y0)
        dx1, dy1 = min(W, x0 + _sd), min(H_VIEW, y0 + _sd)
        if dx1 <= dx0 or dy1 <= dy0:
            return
        sx1, sy1 = sx0 + (dx1 - dx0), sy0 + (dy1 - dy0)
        a = SPH_A[sy0:sy1, sx0:sx1]
        body = np.clip(SPH_TINT[sy0:sy1, sx0:sx1] * col_bgr
                       + SPH_SPEC[sy0:sy1, sx0:sx1] * 255.0 + flash * 70.0, 0, 255)
        reg = im[dy0:dy1, dx0:dx1].astype(np.float32)
        im[dy0:dy1, dx0:dx1] = (reg * (1 - a) + body * a).astype(np.uint8)

    def blit_shadow(im, cx, cy):
        x0, y0 = cx - _shr, cy - _shr
        sx0, sy0 = max(0, -x0), max(0, -y0)
        dx0, dy0 = max(0, x0), max(0, y0)
        dx1, dy1 = min(W, x0 + 2 * _shr + 1), min(H_VIEW, y0 + 2 * _shr + 1)
        if dx1 <= dx0 or dy1 <= dy0:
            return
        sx1, sy1 = sx0 + (dx1 - dx0), sy0 + (dy1 - dy0)
        a = SHADOW_A[sy0:sy1, sx0:sx1]
        reg = im[dy0:dy1, dx0:dx1].astype(np.float32)
        im[dy0:dy1, dx0:dx1] = (reg * (1 - a)).astype(np.uint8)

    # ---- clean rounded-square marble sprite (soft bevel + baked colour halo,
    #      so it never needs a circular glow drawn behind it) ----
    _QR = int(BALL_R * 1.7)
    _qd = 2 * _QR + 1
    _qy, _qx = np.mgrid[0:_qd, 0:_qd].astype(np.float32)
    _qnx = (_qx - _QR) / BALL_R
    _qny = (_qy - _QR) / BALL_R
    _qhalf, _qrad = 0.90, 0.26
    _qax = np.maximum(np.abs(_qnx) - (_qhalf - _qrad), 0.0)
    _qay = np.maximum(np.abs(_qny) - (_qhalf - _qrad), 0.0)
    _qsd = np.sqrt(_qax * _qax + _qay * _qay) - _qrad          # <0 inside the rounded square
    _q_core = np.clip(-_qsd / 0.05, 0.0, 1.0)                    # crisp AA edge
    _q_halo = np.clip((0.62 - np.maximum(_qsd, 0.0)) / 0.62, 0.0, 1.0) ** 1.8
    SQ_A = np.maximum(_q_core, _q_halo * 0.42)[..., None].astype(np.float32)
    _qbev = np.clip(0.72 - 0.52 * (_qnx * 0.45 + _qny * 0.62), 0.42, 1.5)
    _qedge = 1.0 - np.clip((_qsd + 0.16) / 0.16, 0.0, 1.0) * 0.35   # subtle darker rim
    SQ_TINT = np.where(_q_core > 0.5, _qbev * _qedge, 0.5)[..., None].astype(np.float32)
    _qhl = np.exp(-(((_qnx + 0.36) ** 2 + (_qny + 0.42) ** 2) / 0.10)) * (_q_core > 0.5)
    SQ_SPEC = (_qhl * 1.15)[..., None].astype(np.float32)

    def blit_square(im, cx, cy, col_bgr, flash):
        x0, y0 = cx - _QR, cy - _QR
        sx0, sy0 = max(0, -x0), max(0, -y0)
        dx0, dy0 = max(0, x0), max(0, y0)
        dx1, dy1 = min(W, x0 + _qd), min(H_VIEW, y0 + _qd)
        if dx1 <= dx0 or dy1 <= dy0:
            return
        sx1, sy1 = sx0 + (dx1 - dx0), sy0 + (dy1 - dy0)
        a = SQ_A[sy0:sy1, sx0:sx1]
        body = np.clip(SQ_TINT[sy0:sy1, sx0:sx1] * col_bgr
                       + SQ_SPEC[sy0:sy1, sx0:sx1] * 255.0 + flash * 60.0, 0, 255)
        reg = im[dy0:dy1, dx0:dx1].astype(np.float32)
        im[dy0:dy1, dx0:dx1] = (reg * (1 - a) + body * a).astype(np.uint8)

    # precomputed winner scrim — bottom-anchored, transparent → dark (design)
    WC_H = 760
    WC_TOP = H_VIEW - WC_H
    scrim = Image.new("RGBA", (W, WC_H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scrim)
    for i in range(WC_H):
        a = int(240 * (i / WC_H) ** 1.4)
        sd.line([(0, i), (W, i)], fill=(12, 5, 5, a))

    square = shape == "square"
    trails = [deque(maxlen=9) for _ in range(n)]
    prog_every = max(1, total // 50)

    for fi, fr in enumerate(frames):
        cam = fr["cam"]
        cam_i = int(cam)
        img = bg.copy()

        # neon glow slice (world space)
        gs = cam_i // 2
        sl = glow_full[gs:gs + H_VIEW // 2]
        if sl.shape[0] < H_VIEW // 2:
            sl = np.pad(sl, ((0, H_VIEW // 2 - sl.shape[0]), (0, 0), (0, 0)))
        sl = cv2.resize(sl, (W, H_VIEW), interpolation=cv2.INTER_LINEAR)
        cv2.addWeighted(img, 1.0, sl, 0.85, 0, img)

        def SY(wy):
            return int(wy - cam)

        # faint scrolling grid — depth/motion cue only, no distance readout
        gy0 = (cam_i // 200) * 200
        for wy in range(gy0, cam_i + H_VIEW + 200, 200):
            s = wy - cam_i
            cv2.line(img, (0, s), (W, s), (26, 20, 18), 1, cv2.LINE_AA)

        # slow zones + animated chevrons
        for z in zones:
            zs, ze = SY(z["y"]), SY(z["y"] + z["h"])
            if ze < -20 or zs > H_VIEW + 20:
                continue
            boost = z["kind"] == "boost"
            col = COL_BOOST if boost else COL_MUD
            ov = img.copy()
            cv2.rectangle(ov, (int(z["x"]), zs), (int(z["x"] + z["w"]), ze), col, -1)
            cv2.addWeighted(ov, 0.13, img, 0.87, 0, img)
            cv2.rectangle(img, (int(z["x"]), zs), (int(z["x"] + z["w"]), ze),
                          tuple(int(v * 0.55) for v in col), 2, cv2.LINE_AA)
            phase_off = (fr["t"] * (150 if boost else -70)) % 90
            wy = z["y"] + phase_off - 90
            while wy < z["y"] + z["h"]:
                s = SY(wy)
                if z["y"] <= wy <= z["y"] + z["h"] - 8:
                    for cxp in range(int(z["x"]) + 70, int(z["x"] + z["w"]) - 26, 150):
                        if boost:
                            cv2.line(img, (cxp - 24, s + 12), (cxp, s - 12), col, 2, cv2.LINE_AA)
                            cv2.line(img, (cxp, s - 12), (cxp + 24, s + 12), col, 2, cv2.LINE_AA)
                        else:
                            cv2.line(img, (cxp - 22, s), (cxp + 22, s),
                                     tuple(int(v * 0.8) for v in col), 2, cv2.LINE_AA)
                wy += 90

        # geometry — the design's drawSeg: a round-capped bar in the kind colour
        # + a thin bright edge line; bouncy / boost get a soft neon glow.
        def _seg(a, b_, w, kind):
            col = KIND_COL[kind]
            hw = max(2, w // 2)
            if kind in ("bouncy", "boost"):
                gl = tuple(int(v * 0.5) for v in col)
                cv2.line(img, a, b_, gl, w + 20, cv2.LINE_AA)
                cv2.line(img, a, b_, gl, w + 10, cv2.LINE_AA)
            cv2.line(img, a, b_, col, w, cv2.LINE_AA)
            cv2.circle(img, a, hw, col, -1, cv2.LINE_AA)
            cv2.circle(img, b_, hw, col, -1, cv2.LINE_AA)
            edge = KIND_COL["edge"] if kind in ("wall", "gate") else (140, 140, 140)
            cv2.line(img, a, b_, edge, 3, cv2.LINE_AA)

        for o in geo:
            if o.get("is_gate") and o["open"]:
                continue
            if o["t"] == "s":
                y1, y2 = SY(o["y1"]), SY(o["y2"])
                if max(y1, y2) < -40 or min(y1, y2) > H_VIEW + 40:
                    continue
                _seg((int(o["x1"]), y1), (int(o["x2"]), y2), int(o["rad"] * 2), o["kind"])
            else:
                col = KIND_COL[o["kind"]]
                s = SY(o["y"])
                if s < -70 or s > H_VIEW + 70:
                    continue
                p = (int(o["x"]), s)
                r = int(o["r"])
                if o["kind"] == "bouncy":
                    gl = tuple(int(v * 0.5) for v in col)
                    cv2.circle(img, p, r + 12, gl, -1, cv2.LINE_AA)
                    cv2.circle(img, p, r + 6, gl, -1, cv2.LINE_AA)
                    cv2.circle(img, p, r, col, -1, cv2.LINE_AA)
                    cv2.circle(img, p, r, (153, 153, 153), 3, cv2.LINE_AA)
                else:
                    cv2.circle(img, p, r, col, -1, cv2.LINE_AA)
                    cv2.circle(img, p, r, KIND_COL["edge"], 3, cv2.LINE_AA)

        # spinners — arms via the same drawSeg, hub #12142a
        for si, sp in enumerate(spinners):
            s = SY(sp["y"])
            if s < -sp["len"] - 40 or s > H_VIEW + sp["len"] + 40:
                continue
            ang0 = fr["spin"][si]
            for a in range(sp["arms"]):
                ang = ang0 + a * (2 * math.pi / sp["arms"])
                ex = int(sp["x"] + math.cos(ang) * sp["len"])
                ey = int(s + math.sin(ang) * sp["len"])
                _seg((int(sp["x"]), s), (ex, ey), int(sp["rad"] * 2), "bouncy")
            cv2.circle(img, (int(sp["x"]), s), 26, (42, 20, 18), -1, cv2.LINE_AA)
            cv2.circle(img, (int(sp["x"]), s), 26, KIND_COL["edge"], 4, cv2.LINE_AA)

        # finish line (world space)
        fsy = SY(finish_y)
        if -60 < fsy < H_VIEW + 60:
            for x in range(0, W, 54):
                for k in range(2):
                    shade = (255, 244, 242) if ((x // 54 + k) % 2 == 0) else (40, 18, 16)
                    cv2.rectangle(img, (x, fsy + k * 27), (x + 54, fsy + k * 27 + 27), shade, -1)
            cv2.line(img, (0, fsy - 6), (W, fsy - 6), (200, 200, 200), 18, cv2.LINE_AA)   # glow
            cv2.line(img, (0, fsy - 6), (W, fsy - 6), (240, 240, 240), 6, cv2.LINE_AA)

        # sparks
        for (sx, syw, life, cidx) in fr["sparks"]:
            s = int(syw - cam)
            if -10 < s < H_VIEW + 10:
                c = COL_SPARK_BOUNCY if cidx < 0 else colors[cidx][1]
                cv2.circle(img, (int(sx), s), max(1, int(5 * life + 1)), c, -1, cv2.LINE_AA)

        # marbles — trail, contact shadow, colour bounce-light, body, hit pop
        for (bx, by, cid, best, rank, flash) in fr["balls"]:
            if rank == 0:
                trails[cid].append((bx, by))
        for (bx, by, cid, best, rank, flash) in fr["balls"]:
            col = colors[cid][1]
            cx, cyv = int(bx), int(by - cam)
            tr = trails[cid]
            if len(tr) > 1:
                pts = [(int(x), int(y - cam)) for (x, y) in tr]
                for ti in range(1, len(pts)):
                    f = ti / len(pts)
                    cv2.line(img, pts[ti - 1], pts[ti],
                             tuple(int(min(255, v * (0.28 + 0.5 * f))) for v in col),
                             max(3, int(BALL_R * (0.45 + 1.05 * f))), cv2.LINE_AA)
            blit_shadow(img, cx, cyv + int(BALL_R * 0.62))
            # a faint colour halo; the bloom pass does most of the glow work
            cv2.circle(img, (cx, cyv), int(BALL_R + 6 + flash * 22), tuple(int(v * 0.16) for v in col), -1, cv2.LINE_AA)
            if square:
                blit_square(img, cx, cyv, np.array(col, np.float32), flash)
            else:
                blit_sphere(img, cx, cyv, np.array(col, np.float32), flash)
                # the design's thin white flash ring (circles only — brief)
                if flash > 0.03:
                    cv2.circle(img, (cx, cyv), int(BALL_R + 12 + flash * 18),
                               (255, 255, 255), max(1, int(4 * flash + 1)), cv2.LINE_AA)

        # ---- HUD (PIL overlay, composited back onto the BGR frame) ----
        ov = Image.new("RGBA", (W, H_VIEW), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)

        if -80 < fsy < H_VIEW - 40:
            d.text((24, fsy + 92), "FINISH", font=_font(52), fill=(255, 255, 255, 230))

        # snappy hand-off: the intro (question + legend over the countdown) clears
        # within 0.7s of GO, then the badge + leaderboard fade in.
        if fr["phase"] == "count":
            intro_a, hud_a = 1.0, 0.0
        else:
            dt_run = fr["t"] - run_t
            intro_a = max(0.0, 1.0 - dt_run / 0.7)
            hud_a = max(0.0, min(1.0, (dt_run - 0.45) / 0.6))

        # intro: the question + colour legend over the countdown
        if intro_a > 0.02:
            A = int(255 * intro_a)
            f1 = _font(84)
            q = "WHICH COLOR WINS?"
            qw = _spaced_w(d, q, f1, 4)
            _spaced(d, ((W - qw) / 2, SAFE_TOP + 30), q, f1, (255, 255, 255, A), 4)
            f2 = _font(32)
            sub = "DROP YOUR GUESS IN THE COMMENTS"
            sw = _spaced_w(d, sub, f2, 3)
            _spaced(d, ((W - sw) / 2, SAFE_TOP + 140), sub, f2, (0, 231, 255, A), 3)
            step = min(158, (W - 150) / n)
            lx = W / 2 - (n - 1) * step / 2
            nlf = _font(23)
            for i, (nm, cbgr) in enumerate(colors):
                rgb = (cbgr[2], cbgr[1], cbgr[0], A)
                cxp = lx + i * step
                d.ellipse([cxp - 18, SAFE_TOP + 218, cxp + 18, SAFE_TOP + 254], fill=rgb)
                nw = d.textlength(nm, font=nlf)
                d.text((cxp - nw / 2, SAFE_TOP + 266), nm, font=nlf, fill=(255, 255, 255, int(160 * intro_a)))

        # minimal HUD — a compact badge line + tight single-line leaderboard rows
        if hud_a > 0.02:
            A = int(255 * hud_a)
            mL, mR = 46, W - 46
            by = SAFE_TOP + 6
            pulse = 0.5 + 0.5 * math.sin(fr["t"] * 6)
            bf = _font(26)
            bnw = d.textlength(m["name"], font=bf)
            _rrect(d, [mL - 14, by, mL + 32 + bnw, by + 44], 12, fill=(9, 10, 15, int(238 * hud_a)))
            d.ellipse([mL, by + 16, mL + 14, by + 30], fill=(255, 61, 113, int((120 + 130 * pulse) * hud_a)))
            d.text((mL + 26, by + 8), m["name"], font=bf, fill=(255, 255, 255, int(235 * hud_a)))

            # running order only — rank · dot · name (+ finish time once done).
            # No distance-to-finish bar.
            board = _leaderboard(fr["balls"], finish_times, start_y, finish_y)
            rh = 44 if n <= 5 else 38
            ry = SAFE_TOP + 64
            nf = _font(24)
            rf = _font(19)
            tmf = _font(17)
            pw = 0
            for _c, done, ft in board:
                nm = colors[_c][0]
                w2 = 78 + d.textlength(nm, font=nf) + (d.textlength(f"{ft:.1f}s", font=tmf) + 18 if done and ft else 0)
                pw = max(pw, w2)
            _rrect(d, [mL - 14, ry - 6, mL + pw + 16, ry + n * rh + 8], 13,
                   fill=(9, 10, 15, int(250 * hud_a)))
            for pos, (cid, done, ft) in enumerate(board):
                nm, cbgr = colors[cid]
                rgb = (cbgr[2], cbgr[1], cbgr[0])
                cy = ry + rh / 2
                trow = A if pos == 0 else int(210 * hud_a)
                d.text((mL, cy - 13), f"{pos + 1}", font=rf, fill=(255, 255, 255, int(95 * hud_a)))
                d.ellipse([mL + 32, cy - 9, mL + 50, cy + 9], fill=rgb + (A,))
                nx = mL + 66
                d.text((nx, cy - 17), nm, font=nf, fill=(255, 255, 255, trow))
                if done and ft:
                    d.text((nx + d.textlength(nm, font=nf) + 16, cy - 11),
                           f"{ft:.1f}s", font=tmf, fill=rgb + (int(190 * hud_a),))
                ry += rh

        # countdown digit — white with a soft cyan + magenta neon bloom (design)
        if fr["cd"]:
            cd = fr["cd"]
            f = _font(190 if cd != "GO" else 140)
            cw = d.textlength(cd, font=f)
            cx0 = int((W - cw) / 2)
            cy0 = 760
            from PIL import ImageFilter
            for colr, blur, alpha in (((149, 45, 255), 34, 150), ((255, 231, 0), 18, 190)):
                lay = Image.new("RGBA", (W, H_VIEW), (0, 0, 0, 0))
                ImageDraw.Draw(lay).text((cx0, cy0), cd, font=f, fill=(*colr, 255))
                lay = lay.filter(ImageFilter.GaussianBlur(blur))
                lay.putalpha(lay.getchannel("A").point(lambda v, m=alpha: min(255, int(v * m / 90))))
                ov.alpha_composite(lay)
            d.text((cx0, cy0), cd, font=f, fill=(255, 255, 255, 252))

        # photo finish pill
        if fr["slow"]:
            pf = _font(34)
            t = "PHOTO FINISH"
            pw = _spaced_w(d, t, pf, 3)
            x0 = (W - pw - 84) / 2
            _rrect(d, [x0, 1330, x0 + pw + 84, 1398], 34, fill=(255, 61, 113, 238))
            _spaced(d, (x0 + 42, 1340), t, pf, (255, 255, 255, 255), 3)

        # winner card (centre) — fades in as the winner crosses
        if winner >= 0 and fr["t"] >= win_t:
            wa = min(1.0, (fr["t"] - win_t) / 0.35)
            A = int(255 * wa)
            sc = scrim
            if wa < 1:
                sc = scrim.copy()
                sc.putalpha(scrim.getchannel("A").point(lambda v: int(v * wa)))
            ov.alpha_composite(sc, (0, WC_TOP))
            wname, wbgr = colors[winner]
            wrgb = (wbgr[2], wbgr[1], wbgr[0])
            lf = _font(28)
            lw = _spaced_w(d, "WINNER", lf, 8)
            _spaced(d, ((W - lw) / 2, WC_TOP + 130), "WINNER", lf, (255, 255, 255, int(150 * wa)), 8)
            nf = _font(120)
            nw = d.textlength(wname, font=nf)
            if nw > W - 80:
                nf = _font(int(120 * (W - 80) / nw))
                nw = d.textlength(wname, font=nf)
            for rad in (10, 6):
                for ang in range(0, 360, 60):
                    dx, dy = int(math.cos(math.radians(ang)) * rad), int(math.sin(math.radians(ang)) * rad)
                    d.text(((W - nw) / 2 + dx, WC_TOP + 178 + dy), wname, font=nf, fill=wrgb + (int(70 * wa),))
            d.text(((W - nw) / 2, WC_TOP + 178), wname, font=nf, fill=wrgb + (A,))
            pf = _font(28)
            py = WC_TOP + 350
            crossed = [(cid, ft) for cid, ft in res["finish_order"] if ft <= fr["t"] + 1e-6][:3]
            for rk, (cid, ft) in enumerate(crossed, 1):
                pn, pbgr = colors[cid]
                prgb = (pbgr[2], pbgr[1], pbgr[0])
                row = f"{rk}   {pn}"
                rw = d.textlength(row, font=pf)
                tw2 = d.textlength(f"{ft:.2f}s", font=pf)
                x0 = (W - (rw + 44 + tw2)) / 2
                d.ellipse([x0 - 38, py + 4, x0 - 14, py + 28], fill=prgb + (A,))
                d.text((x0, py), row, font=pf, fill=(255, 255, 255, int(215 * wa)))
                d.text((x0 + rw + 44, py), f"{ft:.2f}s", font=pf, fill=prgb + (int(210 * wa),))
                py += 46

        # --- bloom: soft additive glow from the neon + marbles ---
        f32 = img.astype(np.float32)
        sm = cv2.resize(f32, (W // 4, H_VIEW // 4), interpolation=cv2.INTER_AREA)
        bright = np.clip(sm - 130.0, 0.0, None)
        bloom = cv2.GaussianBlur(bright, (0, 0), 11.0)
        bloom = cv2.resize(bloom, (W, H_VIEW), interpolation=cv2.INTER_LINEAR)
        img_glow = np.clip(f32 + bloom * 0.5, 0.0, 255.0)

        # composite the HUD over the bloomed frame at native 1080×1920
        hud = np.asarray(ov)
        ha = hud[:, :, 3:4].astype(np.float32) * (1.0 / 255.0)
        hrgb = hud[:, :, 2::-1].astype(np.float32)         # RGBA → BGR
        out = np.clip(img_glow * vig * (1.0 - ha) + hrgb * ha, 0, 255).astype(np.uint8)

        # inset the whole frame a touch so nothing sits under TikTok's chrome
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


# --- audio --------------------------------------------------------

def synth_audio(res, out_wav):
    """Stereo SFX only — no music, no noise. Every marble contact is a soft
    music-box / marimba note on a C-major pentatonic scale; a boost zone rings a
    quick rising 3-note flourish, a slow zone a soft muted low note; the winner
    gets a warm arpeggio. A light plate reverb ties it together. Pure tones —
    nothing staticky."""
    import soundfile as sf
    from scipy.signal import lfilter

    events = res["events"]
    duration = res["duration"]

    sr = 48000
    n = int((duration + 1.2) * sr)
    buf = np.zeros((n, 2), np.float32)
    scr = np.arange(2 * sr) / sr

    def pan(x01):
        p = 0.2 + 0.6 * min(1.0, max(0.0, float(x01)))
        return math.cos(p * math.pi / 2), math.sin(p * math.pi / 2)

    def place(mono, i, x01, g):
        m = len(mono)
        if i < 0 or i + m >= n:
            return
        left, right = pan(x01)
        buf[i:i + m, 0] += mono * (g * left)
        buf[i:i + m, 1] += mono * (g * right)

    def bell(freq, dur=0.5, decay=9.0, spread=1.0, soft=1.0):
        """Warm inharmonic bell: fundamental + gentle octave + a touch of 3rd
        partial, smooth 3 ms attack, exponential tail. Pure sine — no noise."""
        m = int(dur * sr)
        tt = scr[:m]
        env = np.exp(-tt * decay)
        a = min(m, int(0.003 * sr))
        env[:a] *= np.sin(np.linspace(0, math.pi / 2, a)) ** 2
        ph = 2 * math.pi * freq * tt
        body = (np.sin(ph)
                + 0.34 * np.sin(2.0 * ph) * np.exp(-tt * decay * 1.8)
                + 0.11 * np.sin(3.01 * ph) * np.exp(-tt * decay * 3.2) * spread)
        return (soft * body * env).astype(np.float32)

    def wood(freq, seed):
        """A soft, warm wooden 'tok' — a low damped thud, barely pitched. This is
        what most contacts sound like: quiet, rounded, never shrill."""
        m = int(0.12 * sr)
        tt = scr[:m]
        rr = np.random.default_rng(seed)
        f = freq * (1.0 + (rr.random() - 0.5) * 0.10)
        env = np.exp(-tt * 26.0)
        env[: int(0.0015 * sr)] *= np.linspace(0.0, 1.0, int(0.0015 * sr))
        ph = 2 * math.pi * f * tt
        body = (np.sin(ph) + 0.4 * np.sin(2.7 * ph) * np.exp(-tt * 60.0)) * env
        return body.astype(np.float32)

    specials = [ev for ev in events if ev[1] == "goal"]
    hits = sorted((ev for ev in events if ev[1] in ("bouncy", "peg", "wall", "ball")),
                  key=lambda ev: ev[0])

    win = 1.0 / SND_MAX_RATE
    kept, last_slot, best = [], -1, None
    for ev in hits:
        s = int(ev[0] / win)
        if s != last_slot:
            if best:
                kept.append(best)
            last_slot, best = s, ev
        elif ev[3] > best[3]:
            best = ev
    if best:
        kept.append(best)

    kept.sort(key=lambda ev: ev[0])
    prev_t = -1.0
    dr = np.random.default_rng(0xA11CE)
    for si, (t, kind, pitch01, vol, x01) in enumerate(kept):
        i = int(t * sr)
        duck = 1.0 if prev_t < 0 or t - prev_t > 0.2 else 0.6
        prev_t = t
        idx = int(pitch01 * (len(_PENTA) - 1))
        base = float(_PENTA[idx])
        if kind == "bouncy":
            # the trampoline "boing" — the one musical moment: a soft low bell
            place(bell(base, 0.5, 9.0, soft=0.9), i, x01, 0.24 * vol * duck)
        else:
            # every other contact is just a quiet warm wooden knock
            place(wood(96.0 + 26.0 * pitch01, 0xB0 + si), i, x01, 0.22 * vol * duck)

    # only the winner gets a special sound — no zone / sliding sounds at all
    for (t, kind, _p, _v, x01) in specials:
        if kind != "goal":
            continue
        i = int(t * sr)
        for k, mult in enumerate((1.0, 1.26, 1.5, 2.0)):   # warm low major arpeggio
            place(bell(261.63 * mult, 1.0, 4.0, soft=0.95), i + int(k * 0.08 * sr), x01, 0.30 - k * 0.03)

    # ---- gentle plate reverb (block-processed combs + a smoothing pole) ----
    def comb(x, dcy, g):
        y = x.copy()
        for s0 in range(dcy, len(x), dcy):
            s1 = min(s0 + dcy, len(x))
            y[s0:s1] += g * y[s0 - dcy:s0 - dcy + (s1 - s0)]
        return y

    mono = buf.mean(axis=1)
    wet = np.zeros(n, np.float32)
    for D, g in [(1327, 0.42), (1687, 0.38), (2039, 0.34)]:
        wet += comb(mono, D, g)
    wet = (lfilter([0.24], [1.0, -0.76], wet) * 0.06).astype(np.float32)   # subtle room only
    buf[:, 0] += wet
    buf[:, 1] += np.concatenate([np.zeros(29, np.float32), wet[:-29]])

    # ---- tame + soft-clip. Present, warm, never harsh. ----
    y = buf - lfilter([0.010], [1.0, -0.990], buf, axis=0)     # HP ~80 Hz
    y = lfilter([0.62], [1.0, -0.38], y, axis=0)               # soften the very top
    peak = float(np.max(np.abs(y))) or 1.0
    y = np.tanh(y / peak * 1.1) * 0.6
    sf.write(out_wav, y.astype(np.float32), sr, subtype="PCM_16")


# --- main --------------------------------------------------------

def choose_map(arg: str, seed: int) -> str:
    if arg in MAP_IDS:
        return arg
    return MAP_IDS[int(np.random.default_rng(seed).integers(0, len(MAP_IDS)))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=-1)
    ap.add_argument("--map", default="random")
    ap.add_argument("--shape", default="circle", choices=["circle", "square"])
    ap.add_argument("--balls", type=int, default=4)
    ap.add_argument("--target", type=float, default=20.0)
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
    target = max(12.0, min(60.0, args.target))
    stretch = max(0.9, min(3.0, target / 18.0))
    map_id = choose_map(args.map, base)
    log(f"map: {map_id}  ·  seed {base}  ·  {n_balls} racers  ·  ~{target:.0f}s  ·  x{stretch:.2f}")

    progress(0.03, f"building {map_id}")
    chosen = None
    best = None
    g_hint = GRAV_DEFAULT               # carried forward — the map's speed is consistent
    for attempt in range(16):
        seed = base + attempt * 101
        mrng = np.random.default_rng(seed)
        m = build_map(map_id, mrng, stretch)
        starts = start_positions(n_balls, mrng)

        g = g_hint
        res = None
        for _ in range(6 if attempt == 0 else 2):
            res = simulate(m, starts, np.random.default_rng(seed + 7), g, record=False)
            if res["winner"] < 0:
                g = min(4200.0, g * 1.7)
                continue
            err = res["win_t"] / target
            if 0.85 <= err <= 1.18:
                break
            g = max(850.0, min(4200.0, g * max(0.45, min(2.2, err ** 1.25))))

        if not res or res["winner"] < 0:
            log(f"  attempt {attempt}: no finish — retry")
            continue
        g_hint = g
        ok, why = _drama_ok(res, target)
        gap = _finish_gap(res)
        if ok:
            chosen = (seed, m, starts, g)
            log(f"  attempt {attempt}: ok — {res['win_t']:.0f}s, gap {gap:.1f}s")
            break
        # score best-effort: a tight finish matters far more than exact length
        led = res["lead_hist"].count(res["winner"]) / max(1, len(res["lead_hist"]))
        score = 5.0 * gap + abs(res["win_t"] - target) + 12.0 * max(0.0, led - 0.75)
        if best is None or score < best[4]:
            best = (seed, m, starts, g, score)
        log(f"  attempt {attempt}: {why} — {res['win_t']:.0f}s, gap {gap:.1f}s — retry")

    if chosen is None and best is None:
        log("fallback: forcing a heavy-gravity finish")
        mrng = np.random.default_rng(base)
        m = build_map(map_id, mrng, stretch)
        starts = start_positions(n_balls, mrng)
        seed, g = base, 3200.0
    elif chosen is None:
        seed, m, starts, g = best[0], best[1], best[2], best[3]
        log(f"using best-effort map (seed {seed})")
    else:
        seed, m, starts, g = chosen
    log(f"gravity {g:.0f}")

    # the design ships 4 racers (CYAN/MAGENTA/LIME/AMBER); keep those as the pool
    # for <=4, only reach for the two extras at 5-6.
    pool = 4 if n_balls <= 4 else len(MARBLE_COLORS)
    perm = np.random.default_rng((seed ^ 0x9E3779B9) & 0xFFFFFFFF).permutation(pool)
    colors = [MARBLE_COLORS[k] for k in perm[:n_balls]]

    progress(0.18, "running the race")
    res = simulate(m, starts, np.random.default_rng(seed + 7), g, record=True)
    if res["winner"] < 0:
        raise SystemExit("colorrace: the race did not finish")
    log(f"{' vs '.join(c[0] for c in colors)} → {colors[res['winner']][0]} "
        f"wins at {res['win_t']:.1f}s ({len(res['frames'])} frames)")

    progress(0.34, "rendering")
    render(res, colors, m, args.shape, args.ffmpeg, args.out_video)

    progress(0.95, "sound design")
    synth_audio(res, args.out_audio)

    wname, (wb, wg, wr) = colors[res["winner"]]
    emit_result({
        "seed": int(seed),
        "map": m["id"],
        "mapName": m["name"],
        "winner": wname,
        "winnerRgb": [int(wr), int(wg), int(wb)],
        "colors": [c[0] for c in colors],
        "winAtSec": round(res["win_t"], 2),
        "durationSec": round(res["duration"], 2),
        "events": len(res["events"]),
    }, args.out)
    progress(1.0, "done")


if __name__ == "__main__":
    main()
