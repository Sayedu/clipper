"""Ring of Doom's frame renderer. Pure function of (record, timeline,
frame_idx) -- zero live randomness here, ever: any visual "randomness"
(confetti positions, particle scatter) is a deterministic function of frame
index / event data instead, so the same inputs always paint the identical
pixel. That is what lets the determinism test hash rendered frames, not
just physics state.
"""

from __future__ import annotations

import math

import skia

from ...engine.config import Settings, Team
from ...engine.records import SimRecord, Timeline

RING_RADIUS = 400.0
RING_CENTER = (540.0, 820.0)
GAP_NEAR_PX = 60.0
TRAIL_STEPS_BACK = 6


def _hex_to_color(hex_str: str, alpha: int = 255) -> int:
    h = hex_str.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return skia.Color(r, g, b, alpha)


class _GlowCache:
    """Pre-rendered radial-glow sprites, one per (color, radius) pair --
    built once, blitted every frame. Never re-blurred per frame."""

    def __init__(self):
        self._cache: dict[tuple[str, int], skia.Image] = {}

    def get(self, color_hex: str, radius: float) -> skia.Image:
        key = (color_hex, int(radius))
        img = self._cache.get(key)
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
        self._cache[key] = img
        return img


_GLOW = _GlowCache()


def _vignette_paint(w: float, h: float) -> skia.Paint:
    shader = skia.GradientShader.MakeRadial(
        center=(w / 2, h / 2), radius=max(w, h) * 0.75,
        colors=[skia.Color(0, 0, 0, 0), skia.Color(0, 0, 0, 140)],
        positions=[0.55, 1.0],
    )
    return skia.Paint(Shader=shader)


def _active_overlays(timeline: Timeline, frame_idx: int):
    return [o for o in timeline.overlays if o.start_frame <= frame_idx < o.end_frame]


def _step_index(record: SimRecord, sim_t: float) -> int:
    idx = round(sim_t * record.physics_hz)
    return max(0, min(len(record.steps) - 1, idx))


def _recent_events(record: SimRecord, sim_t: float, window: float, kinds: set[str]):
    return [e for e in record.events if e.kind in kinds and sim_t - window <= e.t <= sim_t]


def draw_frame(canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int) -> None:
    w, h = float(settings.width), float(settings.height)
    sim_t = timeline.frame_sim_time[frame_idx]
    zoom = timeline.frame_zoom[frame_idx]
    step = record.steps[_step_index(record, sim_t)]
    overlays = _active_overlays(timeline, frame_idx)
    overlay_kinds = {o.kind for o in overlays}
    teams_by_id = {t.id: t for t in teams}

    # -- screen shake: a small, deterministic jitter near a recent elimination --
    recent_elims = _recent_events(record, sim_t, 0.15, {"elimination"})
    shake_x = shake_y = 0.0
    if recent_elims:
        age = sim_t - recent_elims[-1].t
        amp = max(0.0, 3.0 * (1.0 - age / 0.15))
        shake_x = amp * math.sin(frame_idx * 7.3)
        shake_y = amp * math.cos(frame_idx * 5.1)

    canvas.save()
    canvas.translate(shake_x, shake_y)

    # -- background --
    canvas.clear(_hex_to_color(settings.background_color))
    canvas.drawRect(skia.Rect(0, 0, w, h), _vignette_paint(w, h))

    cx, cy = RING_CENTER

    canvas.save()
    canvas.translate(cx, cy)
    canvas.scale(zoom, zoom)
    canvas.translate(-cx, -cy)

    _draw_ring(canvas, step, sim_t, record, overlays)
    _draw_particles(canvas, record, sim_t)
    _draw_balls(canvas, step, record, teams_by_id, sim_t)

    canvas.restore()  # back to un-zoomed, un-shaken-but-still-shaken-outer space

    canvas.restore()  # back to the true screen space (undo shake too, for crisp HUD)

    _draw_hud(canvas, settings, record, episode_overlays=overlays, overlay_kinds=overlay_kinds, step=step, teams=teams)


def _draw_ring(canvas, step, sim_t, record: SimRecord, overlays) -> None:
    cx, cy = RING_CENTER
    gap_warning_active = any(e.kind == "warning" and e.data.get("about") == "gap" and abs(e.t - sim_t) < 1.0
                              for e in record.events)

    ring_color = "#B8C0CC"
    glow_paint = skia.Paint(
        AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=28,
        Color=_hex_to_color(ring_color, 50),
        ImageFilter=skia.ImageFilters.Blur(10, 10),
    )
    canvas.drawCircle(cx, cy, RING_RADIUS, glow_paint)

    slot_deg = 360.0 / 96
    gaps = step.gaps_deg
    ring_angle_deg = math.degrees(step.ring_angle)

    wall_paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=10, Color=_hex_to_color(ring_color))
    warn_paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=12,
                             Color=_hex_to_color("#FF4D5E", 220))

    for i in range(96):
        slot_center_local = (i + 0.5) * slot_deg
        covered = any(abs(((slot_center_local - c + 180) % 360) - 180) <= hw for c, hw in gaps)
        if covered:
            continue
        a0 = math.radians(i * slot_deg + ring_angle_deg)
        a1 = math.radians((i + 1) * slot_deg + ring_angle_deg)
        p0 = (cx + RING_RADIUS * math.cos(a0), cy + RING_RADIUS * math.sin(a0))
        p1 = (cx + RING_RADIUS * math.cos(a1), cy + RING_RADIUS * math.sin(a1))
        canvas.drawLine(p0[0], p0[1], p1[0], p1[1], wall_paint)

    if gap_warning_active:
        pulse = 0.5 + 0.5 * math.sin(sim_t * 14.0)
        warn_paint.setColor(_hex_to_color("#FF4D5E", int(120 + 120 * pulse)))
        for c, hw in gaps:
            a0 = math.radians(c - hw + ring_angle_deg)
            a1 = math.radians(c + hw + ring_angle_deg)
            path = skia.Path()
            path.addArc(skia.Rect(cx - RING_RADIUS, cy - RING_RADIUS, cx + RING_RADIUS, cy + RING_RADIUS),
                        math.degrees(a0), math.degrees(a1 - a0))
            canvas.drawPath(path, warn_paint)


def _draw_particles(canvas, record: SimRecord, sim_t: float) -> None:
    hits = _recent_events(record, sim_t, 0.4, {"collision", "elimination"})
    for e in hits:
        if e.kind == "collision" and e.data.get("impulse", 0) < 900:
            continue
        age = sim_t - e.t
        life = 0.4
        if age > life:
            continue
        frac = age / life
        x, y = e.data.get("x", RING_CENTER[0]), e.data.get("y", RING_CENTER[1])
        color = skia.Color(255, 90, 90, int(255 * (1 - frac))) if e.kind == "elimination" else \
            skia.Color(255, 230, 160, int(200 * (1 - frac)))
        paint = skia.Paint(AntiAlias=True, Color=color)
        n = 10 if e.kind == "elimination" else 5
        for k in range(n):
            ang = (k / n) * 2 * math.pi + e.step * 0.013
            dist = frac * (70 if e.kind == "elimination" else 32)
            px, py = x + dist * math.cos(ang), y + dist * math.sin(ang)
            canvas.drawCircle(px, py, max(1.0, 4 * (1 - frac)), paint)


def _draw_balls(canvas, step, record: SimRecord, teams_by_id: dict, sim_t: float) -> None:
    step_idx = _step_index(record, sim_t)
    for i, bs in enumerate(step.balls):
        info = record.balls[i]
        team = teams_by_id[info.team_id]
        color_hex = team.color
        r = info.base_radius

        if bs.alive:
            # -- trail: a few recent positions at decreasing opacity --
            for back in range(TRAIL_STEPS_BACK, 0, -1):
                j = max(0, step_idx - back * 2)
                prev = record.steps[j].balls[i]
                if not prev.alive:
                    continue
                alpha = int(70 * (1 - back / TRAIL_STEPS_BACK))
                if alpha <= 0:
                    continue
                paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(color_hex, alpha))
                canvas.drawCircle(prev.x, prev.y, r * 0.8, paint)

            glow = _GLOW.get(color_hex, r)
            canvas.drawImage(glow, bs.x - glow.width() / 2, bs.y - glow.height() / 2)

            body_paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(color_hex))
            canvas.drawCircle(bs.x, bs.y, r, body_paint)

            dist_from_center = math.hypot(bs.x - RING_CENTER[0], bs.y - RING_CENTER[1])
            near_wall = dist_from_center >= RING_RADIUS - GAP_NEAR_PX
            _draw_eyes(canvas, bs, r, eliminated=False, widened=near_wall)
            _draw_label(canvas, bs, r, info.name)
        else:
            # fading, falling, out of the game -- still drawn so it visibly drifts off-screen
            fade = 1.0
            body_paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(color_hex, int(255 * fade)))
            canvas.drawCircle(bs.x, bs.y, r, body_paint)
            _draw_eyes(canvas, bs, r, eliminated=True, widened=False)


def _draw_eyes(canvas, bs, r: float, eliminated: bool, widened: bool) -> None:
    eye_r = r * (0.34 if widened else 0.26)
    offset = r * 0.38
    for side in (-1, 1):
        ex, ey = bs.x + side * offset, bs.y - r * 0.15
        white = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
        canvas.drawCircle(ex, ey, eye_r, white)
        if eliminated:
            dark = skia.Paint(AntiAlias=True, Color=skia.ColorBLACK, Style=skia.Paint.kStroke_Style, StrokeWidth=2.4)
            d = eye_r * 0.55
            canvas.drawLine(ex - d, ey - d, ex + d, ey + d, dark)
            canvas.drawLine(ex - d, ey + d, ex + d, ey - d, dark)
        else:
            speed = math.hypot(bs.vx, bs.vy)
            lean = 0.0 if speed < 1 else min(1.0, speed / 900.0)
            ang = math.atan2(bs.vy, bs.vx) if speed > 1 else 0.0
            pupil_off = eye_r * 0.4 * lean
            pupil = skia.Paint(AntiAlias=True, Color=skia.ColorBLACK)
            canvas.drawCircle(ex + pupil_off * math.cos(ang), ey + pupil_off * math.sin(ang), eye_r * 0.45, pupil)


_LABEL_FONT: skia.Font | None = None
_HEAVY_FONT: skia.Font | None = None


def _label_font(settings: Settings) -> skia.Font:
    global _LABEL_FONT
    if _LABEL_FONT is None:
        tf = skia.Typeface.MakeFromFile(str(settings.font_label))
        _LABEL_FONT = skia.Font(tf, 22)
    return _LABEL_FONT


def _heavy_font(settings: Settings, size: float) -> skia.Font:
    tf = skia.Typeface.MakeFromFile(str(settings.font_heavy))
    return skia.Font(tf, size)


def _draw_label(canvas, bs, r: float, name: str) -> None:
    global _LABEL_FONT
    if _LABEL_FONT is None:
        return
    text = name.upper()
    outline = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 220), Style=skia.Paint.kStroke_Style, StrokeWidth=4)
    fill = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
    tw = _LABEL_FONT.measureText(text)
    x, y = bs.x - tw / 2, bs.y + r + 26
    canvas.drawString(text, x, y, _LABEL_FONT, outline)
    canvas.drawString(text, x, y, _LABEL_FONT, fill)


def init_fonts(settings: Settings) -> None:
    """Call once before rendering any frame -- loads the two OFL fonts."""
    global _LABEL_FONT
    tf = skia.Typeface.MakeFromFile(str(settings.font_label))
    _LABEL_FONT = skia.Font(tf, 22)


def _draw_hud(canvas, settings: Settings, record: SimRecord, episode_overlays, overlay_kinds, step, teams) -> None:
    x_min, x_max = settings.safe_x_min, settings.safe_x_max
    y_min, y_max = settings.safe_y_min, settings.safe_y_max
    heavy_big = _heavy_font(settings, 64)
    heavy_mid = _heavy_font(settings, 40)
    heavy_small = _heavy_font(settings, 30)

    showing_card = bool(overlay_kinds & {"winner", "standings", "hook", "storyline"})

    if not showing_card:
        # -- top: event title + N LEFT --
        title_paint = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
        canvas.drawString("RING OF DOOM", x_min, y_min + 40, heavy_small, title_paint)
        alive = sum(1 for b in step.balls if b.alive)
        n_left_text = f"{alive} LEFT"
        tw = heavy_mid.measureText(n_left_text)
        canvas.drawString(n_left_text, (x_min + x_max) / 2 - tw / 2, y_min + 95, heavy_mid, title_paint)

        # -- bottom: team strip with alive dots --
        counts: dict[str, int] = {}
        for i, bs in enumerate(step.balls):
            if bs.alive:
                tid = record.balls[i].team_id
                counts[tid] = counts.get(tid, 0) + 1
        strip_y = y_max - 40
        slot_w = (x_max - x_min) / len(teams)
        for k, team in enumerate(teams):
            cx0 = x_min + slot_w * (k + 0.5)
            alive_n = counts.get(team.id, 0)
            for d in range(4):
                dot_color = _hex_to_color(team.color) if d < alive_n else skia.Color(255, 255, 255, 60)
                canvas.drawCircle(cx0 - 24 + d * 16, strip_y, 6, skia.Paint(AntiAlias=True, Color=dot_color))

    for o in episode_overlays:
        _draw_overlay(canvas, o, heavy_big, heavy_mid, heavy_small, settings)


def _wrap_text(text: str, font: skia.Font, max_width: float) -> list[str]:
    """Greedy word wrap by MEASURED width, not a guessed character count --
    storyline/teaser text is generated dynamically now (Phase 2) and varies
    in length, so a fixed character cutoff was truncating mid sentence."""
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
    """Draws `text` word-wrapped and centered, returns the y just below the
    last line (so callers can stack more content under it)."""
    y = start_y
    for line in _wrap_text(text, font, max_width):
        tw = font.measureText(line)
        canvas.drawString(line, center_x - tw / 2, y, font, paint)
        y += line_height
    return y


def _draw_overlay(canvas, overlay, heavy_big, heavy_mid, heavy_small, settings: Settings) -> None:
    w = settings.width
    white = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
    center_x = w / 2

    if overlay.kind == "hook":
        text = overlay.data["text"]
        tw = heavy_big.measureText(text)
        canvas.drawString(text, center_x - tw / 2, 260, heavy_big, white)
        if overlay.data.get("chips"):
            chip_text = "PICK YOUR TEAM"
            tw2 = heavy_small.measureText(chip_text)
            canvas.drawString(chip_text, center_x - tw2 / 2, 330, heavy_small, white)

    elif overlay.kind == "storyline":
        text = overlay.data["text"]
        max_w = settings.safe_x_max - settings.safe_x_min - 40
        _draw_wrapped_centered(canvas, text, heavy_small, white, center_x, 400, max_w, 42)

    elif overlay.kind == "toast":
        text = overlay.data["text"]
        tw = heavy_mid.measureText(text)
        bg = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 160))
        rect = skia.Rect(center_x - tw / 2 - 20, 500, center_x + tw / 2 + 20, 556)
        canvas.drawRoundRect(rect, 12, 12, bg)
        canvas.drawString(text, center_x - tw / 2, 538, heavy_mid, white)

    elif overlay.kind == "winner":
        team = overlay.data["team"]
        mvp = overlay.data["mvp"]
        _draw_confetti(canvas, settings, team)
        t1 = f"{team.upper()} WINS"
        tw = heavy_big.measureText(t1)
        canvas.drawString(t1, center_x - tw / 2, 800, heavy_big, white)
        t2 = f"MVP: {mvp.upper()}"
        tw2 = heavy_mid.measureText(t2)
        canvas.drawString(t2, center_x - tw2 / 2, 870, heavy_mid, white)

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
            y += 44
        if teaser:
            max_w = settings.safe_x_max - settings.safe_x_min - 40
            _draw_wrapped_centered(canvas, teaser, heavy_small, white, center_x, y + 30, max_w, 42)


def _draw_confetti(canvas, settings: Settings, team_name: str) -> None:
    color_by_name = {"Red": "#FF4D5E", "Blue": "#3DA5FF", "Green": "#3DDC84", "Yellow": "#FFD23F"}
    hex_color = color_by_name.get(team_name, "#FFFFFF")
    paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(hex_color, 220))
    for i in range(40):
        x = (i * 97) % settings.width
        y = (i * 53) % 700 + 100
        size = 6 + (i % 3) * 3
        canvas.drawRect(skia.Rect(x, y, x + size, y + size * 2), paint)
