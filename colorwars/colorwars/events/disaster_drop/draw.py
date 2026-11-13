"""Disaster Drop's frame renderer. Course geometry isn't stored on
SimRecord (it would be a lot of event-specific data bolted onto a generic
dataclass) -- it's regenerated here from record.seed the same way
simulate() built it originally (course generation is cheap and has no
physics to step, just geometry), then cached per (seed, cfg). Zero live
randomness in the actual pixels, same rule as the other two events.
"""

from __future__ import annotations

import json
import math

import pymunk
import skia

from ...engine.config import Settings, Team
from ...engine.records import SimRecord, Timeline
from ...engine.rng import Rng
from .course import generate_course, render_geometry

_COURSE_CACHE: dict[tuple[int, str], dict] = {}


def _get_course_geometry(seed: int, cfg: dict) -> dict:
    # keyed by the actual cfg used, not just seed -- this is a long-running
    # server process (the Studio's API), and the same seed can legitimately
    # be rendered with different course overrides across requests; caching
    # by seed alone silently reused a stale (and visually mismatched)
    # course from an earlier request with different config.
    key = (seed, json.dumps(cfg, sort_keys=True, default=str))
    if key not in _COURSE_CACHE:
        rng = Rng(seed)
        space = pymunk.Space()
        x0, x1 = float(cfg["playfield"]["x_min"]), float(cfg["playfield"]["x_max"])
        modules, _height = generate_course(space, rng, cfg, x0, x1)
        _COURSE_CACHE[key] = render_geometry(space, modules)
    return _COURSE_CACHE[key]


def _hex_to_color(hex_str: str, alpha: int = 255) -> int:
    h = hex_str.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return skia.Color(r, g, b, alpha)


class _GlowCache:
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


def _active_overlays(timeline: Timeline, frame_idx: int):
    return [o for o in timeline.overlays if o.start_frame <= frame_idx < o.end_frame]


def _step_index(record: SimRecord, sim_t: float) -> int:
    idx = round(sim_t * record.physics_hz)
    return max(0, min(len(record.steps) - 1, idx))


def draw_frame(canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int,
               event_cfg: dict) -> None:
    w, h = float(settings.width), float(settings.height)
    sim_t = timeline.frame_sim_time[frame_idx]
    zoom = timeline.frame_zoom[frame_idx]
    cam_x = timeline.frame_camera_x[frame_idx]
    cam_y = timeline.frame_camera_y[frame_idx]
    step = record.steps[_step_index(record, sim_t)]
    crusher_y = step.ring_angle  # repurposed field -- see sim.py's StepRecord note
    overlays = _active_overlays(timeline, frame_idx)
    overlay_kinds = {o.kind for o in overlays}
    teams_by_id = {t.id: t for t in teams}
    geometry = _get_course_geometry(record.seed, event_cfg)

    canvas.clear(_hex_to_color(settings.background_color))

    canvas.save()
    canvas.translate(w / 2, h / 2)
    canvas.scale(zoom, zoom)
    canvas.translate(-cam_x, -cam_y)

    _draw_course(canvas, geometry, sim_t)
    _draw_crusher(canvas, crusher_y, settings)
    _draw_balls(canvas, step, record, teams_by_id, sim_t)

    canvas.restore()

    _draw_hud(canvas, settings, overlays, overlay_kinds)


def _draw_course(canvas, geometry: dict, sim_t: float) -> None:
    wall_paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, Color=skia.Color(150, 160, 180))
    for a, b, radius in geometry["segments"]:
        wall_paint.setStrokeWidth(radius * 2)
        canvas.drawLine(a[0], a[1], b[0], b[1], wall_paint)
    peg_paint = skia.Paint(AntiAlias=True, Color=skia.Color(150, 160, 180))
    for pos, radius in geometry["circles"]:
        canvas.drawCircle(pos[0], pos[1], radius, peg_paint)
    spin_paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, Color=skia.Color(180, 150, 220))
    for sp in geometry["spinners"]:
        angle = sp["omega"] * sim_t
        cx, cy = sp["pos"]
        ax, ay = sp["half_a"]
        bx, by = sp["half_b"]
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        wax = cx + ax * cos_a - ay * sin_a
        way = cy + ax * sin_a + ay * cos_a
        wbx = cx + bx * cos_a - by * sin_a
        wby = cy + bx * sin_a + by * cos_a
        spin_paint.setStrokeWidth(sp["thickness"] * 2)
        canvas.drawLine(wax, way, wbx, wby, spin_paint)


def _draw_crusher(canvas, crusher_y: float, settings: Settings) -> None:
    x0, x1 = 0.0, settings.width + 400.0  # drawn wide; camera clips it naturally
    paint = skia.Paint(AntiAlias=True, Color=skia.Color(220, 60, 60))
    canvas.drawRect(skia.Rect(x0 - 400, crusher_y - 14, x1, crusher_y + 14), paint)
    spike_paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 110, 90))
    spike_w = 36.0
    n = int((x1 - x0 + 800) / spike_w)
    for i in range(n):
        sx = x0 - 400 + i * spike_w
        path = skia.Path()
        path.moveTo(sx, crusher_y + 14)
        path.lineTo(sx + spike_w / 2, crusher_y + 14 + 24)
        path.lineTo(sx + spike_w, crusher_y + 14)
        path.close()
        canvas.drawPath(path, spike_paint)
    glow_paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 80, 80, 70),
                             ImageFilter=skia.ImageFilters.Blur(18, 18))
    canvas.drawRect(skia.Rect(x0 - 400, crusher_y - 30, x1, crusher_y + 10), glow_paint)


_OUTCOME_CACHE: dict[int, dict[int, tuple[str, float]]] = {}


def _ball_outcomes(record: SimRecord) -> dict[int, tuple[str, float]]:
    """ball_id -> ("eliminated"|"finished", t). BallState.alive is repurposed
    (see sim.py) to mean "still an active racer", so it's False for BOTH a
    finished ball and an eliminated one -- not enough on its own to tell a
    winner's own victorious ball apart from a crushed one, which a rendered
    frame showed directly (the eventual winner's ball had the same X-eyes
    death mark as everything the crusher actually hit)."""
    if record.seed not in _OUTCOME_CACHE:
        outcomes: dict[int, tuple[str, float]] = {}
        for e in record.events:
            if e.kind == "elimination":
                outcomes[e.data["ball_id"]] = ("eliminated", e.t)
            elif e.kind == "finish":
                outcomes[e.data["ball_id"]] = ("finished", e.t)
        _OUTCOME_CACHE[record.seed] = outcomes
    return _OUTCOME_CACHE[record.seed]


def _draw_balls(canvas, step, record: SimRecord, teams_by_id: dict, sim_t: float) -> None:
    outcomes = _ball_outcomes(record)
    for i, bs in enumerate(step.balls):
        info = record.balls[i]
        team = teams_by_id[info.team_id]
        color_hex = team.color
        r = info.base_radius
        outcome, outcome_t = outcomes.get(i, (None, None))
        eliminated = outcome == "eliminated" and outcome_t is not None and outcome_t <= sim_t
        alpha = 140 if eliminated else 255
        glow = _GLOW.get(color_hex, r)
        canvas.drawImage(glow, bs.x - glow.width() / 2, bs.y - glow.height() / 2)
        body_paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(color_hex, alpha))
        canvas.drawCircle(bs.x, bs.y, r, body_paint)
        if eliminated:
            dark = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 200), Style=skia.Paint.kStroke_Style, StrokeWidth=2.2)
            d = r * 0.4
            canvas.drawLine(bs.x - d, bs.y - d, bs.x + d, bs.y + d, dark)
            canvas.drawLine(bs.x - d, bs.y + d, bs.x + d, bs.y - d, dark)


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
    x_min = settings.safe_x_min
    y_min = settings.safe_y_min
    heavy_big = _heavy_font(settings, 56)
    heavy_mid = _heavy_font(settings, 38)
    heavy_small = _heavy_font(settings, 28)

    showing_card = bool(overlay_kinds & {"hook", "storyline", "winner", "standings"})
    if not showing_card:
        white = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
        canvas.drawString("DISASTER DROP", x_min, y_min + 40, heavy_small, white)

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
        canvas.drawString(text, center_x - tw / 2, 260, heavy_big, white)

    elif overlay.kind == "storyline":
        text = overlay.data.get("text", "")
        if text:
            _draw_wrapped_centered(canvas, text, heavy_small, white, center_x, 340, max_w, 40)

    elif overlay.kind == "disaster_card":
        text = overlay.data["text"]
        tw = heavy_mid.measureText(text)
        bg = skia.Paint(AntiAlias=True, Color=skia.Color(140, 0, 0, 170))
        rect = skia.Rect(center_x - tw / 2 - 26, 420, center_x + tw / 2 + 26, 480)
        canvas.drawRoundRect(rect, 14, 14, bg)
        canvas.drawString(text, center_x - tw / 2, 462, heavy_mid, white)

    elif overlay.kind == "toast":
        text = overlay.data["text"]
        tw = heavy_mid.measureText(text)
        bg = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 160))
        rect = skia.Rect(center_x - tw / 2 - 20, 1300, center_x + tw / 2 + 20, 1356)
        canvas.drawRoundRect(rect, 12, 12, bg)
        canvas.drawString(text, center_x - tw / 2, 1338, heavy_mid, white)

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
