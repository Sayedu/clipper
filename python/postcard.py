"""Generate a designed 9:16 background for a text/question post — NO AI, so it can
never contain a face, a person, or an animal. A deep two-stop gradient, a faint
Islamic 8-point-star lattice, and a vignette for text contrast.

Usage:
  python postcard.py --out bg.png [--w 1080 --h 1920 --seed 7 --palette 3]
"""

from __future__ import annotations

import argparse
import math
import random

from common import emit_result, log, main

# Deep palettes — every one is dark enough for large white text with a soft shadow.
PALETTES = [
    ((13, 79, 79), (10, 20, 40)),      # teal -> midnight
    ((11, 61, 46), (6, 17, 12)),       # emerald -> near-black
    ((59, 31, 94), (20, 18, 28)),      # royal purple -> charcoal
    ((18, 58, 107), (10, 15, 44)),     # deep blue -> indigo
    ((92, 31, 46), (26, 17, 20)),      # burgundy -> charcoal
    ((30, 58, 47), (8, 15, 11)),       # forest -> black
    ((42, 59, 92), (10, 14, 23)),      # slate blue -> black
    ((120, 66, 18), (28, 16, 8)),      # amber -> brown
]


def _lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def _gradient(w, h, c0, c1, angle_deg):
    import numpy as np
    from PIL import Image

    ang = math.radians(angle_deg)
    dx, dy = math.cos(ang), math.sin(ang)
    xs = np.arange(w)[None, :]
    ys = np.arange(h)[:, None]
    proj = xs * dx + ys * dy
    corners = [c * dx + r * dy for c in (0, w) for r in (0, h)]
    lo, hi = min(corners), max(corners)
    t = (proj - lo) / ((hi - lo) or 1.0)
    t = t * t * (3 - 2 * t)  # smoothstep
    a = np.array(c0, dtype=float)
    b = np.array(c1, dtype=float)
    rgb = (a + (b - a) * t[..., None]).clip(0, 255).astype("uint8")
    return Image.fromarray(rgb, "RGB")


def _star8(draw, cx, cy, r, fill, width):
    """An 8-point star = two overlapping squares (one rotated 45°)."""
    for rot in (0.0, math.pi / 4):
        pts = [
            (cx + r * math.cos(rot + i * math.pi / 2), cy + r * math.sin(rot + i * math.pi / 2))
            for i in range(4)
        ]
        draw.polygon(pts, outline=fill, width=width)


def _lattice(w, h, rgb, alpha):
    """Faint tiled star-and-octagon lattice across the whole frame."""
    from PIL import Image, ImageDraw

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    step = w // 4
    r = step * 0.42
    line = (rgb[0], rgb[1], rgb[2], alpha)
    for gy in range(-1, h // step + 2):
        for gx in range(-1, w // step + 2):
            cx = gx * step + (step // 2 if gy % 2 else 0)
            cy = gy * step
            _star8(d, cx, cy, r, line, 2)
            # small octagon between stars
            oct_pts = [
                (cx + step / 2 + r * 0.5 * math.cos(a), cy + step / 2 + r * 0.5 * math.sin(a))
                for a in [i * math.pi / 4 + math.pi / 8 for i in range(8)]
            ]
            d.polygon(oct_pts, outline=line, width=1)
    return layer


def _vignette(w, h, strength=0.55):
    import numpy as np
    from PIL import Image

    cx, cy = w / 2, h / 2
    xs = (np.arange(w)[None, :] - cx) / cx
    ys = (np.arange(h)[:, None] - cy) / cy
    d = np.sqrt(xs**2 + ys**2) / math.sqrt(2)
    m = (d**2 * 255 * strength).clip(0, 255).astype("uint8")
    return Image.fromarray(m, "L")


def make() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--w", type=int, default=1080)
    ap.add_argument("--h", type=int, default=1920)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--palette", type=int, default=None)
    args = ap.parse_args()

    from PIL import Image

    rng = random.Random(args.seed)
    pi = args.palette if args.palette is not None else rng.randrange(len(PALETTES))
    c0, c1 = PALETTES[pi % len(PALETTES)]
    angle = rng.choice([90, 105, 115, 70, 60])

    log(f"palette {pi} {c0}->{c1}, angle {angle}")
    base = _gradient(args.w, args.h, c0, c1, angle).convert("RGBA")

    # lattice in a light tint of the brighter stop
    tint = _lerp(c0, (255, 255, 255), 0.6)
    base.alpha_composite(_lattice(args.w, args.h, tint, rng.randint(14, 26)))

    # vignette
    dark = Image.new("RGBA", (args.w, args.h), (0, 0, 0, 255))
    base = Image.composite(dark, base, _vignette(args.w, args.h, rng.uniform(0.45, 0.62)))

    base.convert("RGB").save(args.out, "PNG")
    log(f"wrote {args.out} ({args.w}x{args.h})")
    emit_result({"path": args.out, "palette": pi}, None)


if __name__ == "__main__":
    main(make)
