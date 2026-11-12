"""Great Escape's frame renderer. Ring rotation speeds are seeded but
never stored on SimRecord (same reasoning as Disaster Drop's course
geometry) -- they're the very first thing simulate() draws from the Rng,
so draw.py replays just that one step (Rng(seed) then 6 rng.uniform calls)
to recover them, then computes each ring's current angle analytically
(omega * sim_t) rather than needing per-step rotation data.
"""

from __future__ import annotations

import math

import skia

from ...engine.config import REPO_ROOT, Settings, Team, load_event_config
from ...engine.records import SimRecord, Timeline
from ...engine.rng import Rng

_RING_CACHE: dict[int, list[dict]] = {}


def _get_rings(seed: int) -> list[dict]:
    if seed not in _RING_CACHE:
        cfg = load_event_config(REPO_ROOT, "great_escape")
        rcfg = cfg["rings"]
        radii = [float(r) for r in rcfg["radii"]]
        speed_min, speed_max = float(rcfg["speed_min"]), float(rcfg["speed_max"])
        gap_half = float(rcfg["gap_deg"]) / 2.0
        rng = Rng(seed)
        rings = []
        for i, radius in enumerate(radii):
            omega_mag = rng.uniform(speed_min, speed_max)
            omega = omega_mag if i % 2 == 0 else -omega_mag
            rings.append({"radius": radius, "omega": omega, "gap_half_deg": gap_half})
        _RING_CACHE[seed] = rings
    return _RING_CACHE[seed]


def _hex_to_color(hex_str: str, alpha: int = 255) -> int:
    h = hex_str.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return skia.Color(r, g, b, alpha)


_GLOW_CACHE: dict[tuple[str, int], skia.Image] = {}


def _glow(color_hex: str, radius: float) -> skia.Image:
    key = (color_hex, int(radius))
    img = _GLOW_CACHE.get(key)
    if img is not None:
        return img
    size = int(radius * 4)
    surface = skia.Surface(size, size)
    with surface as canvas:
        canvas.clear(skia.ColorTRANSPARENT)
        cx = cy = size / 2
        shader = skia.GradientShader.MakeRadial(
            center=(cx, cy), radius=radius * 2,
            colors=[_hex_to_color(color_hex, 160), _hex_to_color(color_hex, 0)],
            positions=[0.0, 1.0],
        )
        paint = skia.Paint(Shader=shader, AntiAlias=True)
        canvas.drawCircle(cx, cy, radius * 2, paint)
    img = surface.makeImageSnapshot()
    _GLOW_CACHE[key] = img
    return img


def _active_overlays(timeline: Timeline, frame_idx: int):
    return [o for o in timeline.overlays if o.start_frame <= frame_idx < o.end_frame]


def _step_index(record: SimRecord, sim_t: float) -> int:
    idx = round(sim_t * record.physics_hz)
    return max(0, min(len(record.steps) - 1, idx))


def _shatter_t(record: SimRecord, radius: float) -> float | None:
    for e in record.events:
        if e.kind == "ring_shatter" and e.data["ring_radius"] == radius:
            return e.t
    return None


def draw_frame(canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int) -> None:
    sim_t = timeline.frame_sim_time[frame_idx]
    cam_x = timeline.frame_camera_x[frame_idx]
    cam_y = timeline.frame_camera_y[frame_idx]
    zoom = timeline.frame_zoom[frame_idx]
    step = record.steps[_step_index(record, sim_t)]
    overlays = _active_overlays(timeline, frame_idx)
    overlay_kinds = {o.kind for o in overlays}
    teams_by_id = {t.id: t for t in teams}
    rings = _get_rings(record.seed)
    w, h = float(settings.width), float(settings.height)

    canvas.clear(_hex_to_color(settings.background_color))
    canvas.drawRect(skia.Rect(0, 0, w, h), _vignette_paint(w, h))

    canvas.save()
    canvas.translate(w / 2, h / 2)
    canvas.scale(zoom, zoom)
    canvas.translate(-cam_x, -cam_y)

    for ring in rings:
        shatter_t = _shatter_t(record, ring["radius"])
        if shatter_t is not None and sim_t >= shatter_t:
            age = sim_t - shatter_t
            if age < 0.5:
                _draw_glass_burst(canvas, cam_x, cam_y, ring["radius"], age)
            continue
        _draw_ring(canvas, cam_x, cam_y, ring, sim_t)

    for i, bs in enumerate(step.balls):
        info = record.balls[i]
        team = teams_by_id[info.team_id]
        r = info.base_radius
        alpha = 255 if bs.alive else 160
        glow = _glow(team.color, r)
        canvas.drawImage(glow, bs.x - glow.width() / 2, bs.y - glow.height() / 2)
        body_paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color, alpha))
        canvas.drawCircle(bs.x, bs.y, r, body_paint)
        ring_paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 255, 255, 230),
                                 Style=skia.Paint.kStroke_Style, StrokeWidth=2.0)
        canvas.drawCircle(bs.x, bs.y, r, ring_paint)

    canvas.restore()

    _draw_hud(canvas, settings, overlays, overlay_kinds)


def _vignette_paint(w: float, h: float) -> skia.Paint:
    shader = skia.GradientShader.MakeRadial(
        center=(w / 2, h / 2), radius=max(w, h) * 0.75,
        colors=[skia.Color(0, 0, 0, 0), skia.Color(0, 0, 0, 140)],
        positions=[0.55, 1.0],
    )
    return skia.Paint(Shader=shader)


def _draw_ring(canvas, cx: float, cy: float, ring: dict, sim_t: float) -> None:
    radius = ring["radius"]
    gap_center_deg = math.degrees(ring["omega"] * sim_t) % 360.0
    gap_half = ring["gap_half_deg"]
    start_deg = gap_center_deg + gap_half
    sweep_deg = 360.0 - 2 * gap_half

    paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=9,
                        Color=skia.Color(170, 180, 200))
    glow_paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=20,
                             Color=skia.Color(170, 180, 200, 50), ImageFilter=skia.ImageFilters.Blur(8, 8))
    rect = skia.Rect(cx - radius, cy - radius, cx + radius, cy + radius)
    path = skia.Path()
    path.addArc(rect, start_deg, sweep_deg)
    canvas.drawPath(path, glow_paint)
    canvas.drawPath(path, paint)

    # gap edges pulse faintly so the gap reads as an opening, not a render gap
    warn_paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=11,
                             Color=skia.Color(120, 220, 255, 120))
    gap_path = skia.Path()
    gap_path.addArc(rect, gap_center_deg - gap_half, 2 * gap_half)
    canvas.drawPath(gap_path, warn_paint)


def _draw_glass_burst(canvas, cx: float, cy: float, radius: float, age: float) -> None:
    frac = min(1.0, age / 0.5)
    alpha = int(220 * (1 - frac))
    if alpha <= 0:
        return
    paint = skia.Paint(AntiAlias=True, Color=skia.Color(220, 230, 255, alpha))
    n = 48
    for i in range(n):
        ang = (i / n) * 2 * math.pi
        dist = radius + frac * 90
        x = cx + dist * math.cos(ang)
        y = cy + dist * math.sin(ang)
        size = 5 + (i % 3) * 3
        canvas.drawRect(skia.Rect(x - size / 2, y - size / 2, x + size / 2, y + size / 2), paint)


_LABEL_FONT: skia.Font | None = None


def init_fonts(settings: Settings) -> None:
    global _LABEL_FONT
    tf = skia.Typeface.MakeFromFile(str(settings.font_label))
    _LABEL_FONT = skia.Font(tf, 20)


def _heavy_font(settings: Settings, size: float) -> skia.Font:
    tf = skia.Typeface.MakeFromFile(str(settings.font_heavy))
    return skia.Font(tf, size)


def _wrap_text(text: str, font: skia.Font, max_width: float) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    cur = words[0]
    for word in words[1:]:
        trial = cur + " " + word
        if font.measureText(trial) <= max_width:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    lines.append(cur)
    return lines


def _draw_wrapped_centered(canvas, text: str, font: skia.Font, paint, center_x: float,
                            start_y: float, max_width: float, line_height: float) -> float:
    y = start_y
    for line in _wrap_text(text, font, max_width):
        tw = font.measureText(line)
        canvas.drawString(line, center_x - tw / 2, y, font, paint)
        y += line_height
    return y


def _draw_hud(canvas, settings: Settings, overlays, overlay_kinds) -> None:
    x_min, y_min = settings.safe_x_min, settings.safe_y_min
    heavy_big = _heavy_font(settings, 56)
    heavy_mid = _heavy_font(settings, 38)
    heavy_small = _heavy_font(settings, 28)

    if not (overlay_kinds & {"hook", "storyline", "winner", "standings"}):
        white = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
        canvas.drawString("GREAT ESCAPE", x_min, y_min + 40, heavy_small, white)

    for o in overlays:
        _draw_overlay(canvas, o, heavy_big, heavy_mid, heavy_small, settings)


def _draw_overlay(canvas, overlay, heavy_big, heavy_mid, heavy_small, settings: Settings) -> None:
    w = settings.width
    white = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
    center_x = w / 2
    max_w = settings.safe_x_max - settings.safe_x_min - 40

    if overlay.kind == "hook":
        text = overlay.data["text"]
        tw = heavy_big.measureText(text)
        canvas.drawString(text, center_x - tw / 2, 220, heavy_big, white)

    elif overlay.kind == "storyline":
        text = overlay.data.get("text", "")
        if text:
            _draw_wrapped_centered(canvas, text, heavy_small, white, center_x, 260, max_w, 38)

    elif overlay.kind == "toast":
        text = overlay.data["text"]
        tw = heavy_mid.measureText(text)
        bg = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 160))
        rect = skia.Rect(center_x - tw / 2 - 20, 1460, center_x + tw / 2 + 20, 1512)
        canvas.drawRoundRect(rect, 12, 12, bg)
        canvas.drawString(text, center_x - tw / 2, 1498, heavy_mid, white)

    elif overlay.kind == "winner":
        team = overlay.data["team"]
        mvp = overlay.data["mvp"]
        _draw_confetti(canvas, settings, team)
        t1 = f"{team.upper()} WINS"
        tw = heavy_big.measureText(t1)
        canvas.drawString(t1, center_x - tw / 2, 700, heavy_big, white)
        t2 = f"MVP: {mvp.upper()}"
        tw2 = heavy_mid.measureText(t2)
        canvas.drawString(t2, center_x - tw2 / 2, 770, heavy_mid, white)

    elif overlay.kind == "standings":
        standings = overlay.data.get("standings", {})
        teaser = overlay.data.get("teaser", "")
        title = "STANDINGS"
        tw = heavy_mid.measureText(title)
        canvas.drawString(title, center_x - tw / 2, 700, heavy_mid, white)
        y = 760
        for team_id, pts in standings.items():
            line = f"{team_id.upper()}: {pts}"
            tw2 = heavy_small.measureText(line)
            canvas.drawString(line, center_x - tw2 / 2, y, heavy_small, white)
            y += 40
        if teaser:
            _draw_wrapped_centered(canvas, teaser, heavy_small, white, center_x, y + 30, max_w, 38)


def _draw_confetti(canvas, settings: Settings, team_name: str) -> None:
    color_by_name = {"Red": "#FF4D5E", "Blue": "#3DA5FF", "Green": "#3DDC84", "Yellow": "#FFD23F"}
    hex_color = color_by_name.get(team_name, "#FFFFFF")
    paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(hex_color, 220))
    for i in range(40):
        x = (i * 97) % settings.width
        y = (i * 53) % 600 + 150
        size = 6 + (i % 3) * 3
        canvas.drawRect(skia.Rect(x, y, x + size, y + size * 2), paint)
