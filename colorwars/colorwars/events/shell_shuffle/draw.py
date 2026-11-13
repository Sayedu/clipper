"""Shell Shuffle's frame renderer. Zero live randomness, same rule as Ring
of Doom's draw.py -- any visual "randomness" (confetti layout) is a
deterministic function of frame index, never an RNG call here.

cup_radius/lift_height come from event_cfg (the exact cfg simulate() used),
not hardcoded -- the Studio can override table.cup_radius/table.lift_height
per render, and a draw path that ignored the override would size/lift cups
inconsistently with whatever sim.py actually used. table.center stays a
plain constant here: it's a list, so the Studio's generic param walker
never exposes it as an override (no "list" ParamSpec type), making it
unreachable in practice -- revisit if a future curated spec changes that.
"""

from __future__ import annotations

import math

import skia

from ...engine.config import Settings, Team
from ...engine.records import SimRecord, Timeline

TABLE_CENTER = (540.0, 900.0)
PODIUM_SLOTS = [(-330.0, -70.0), (-110.0, 30.0), (110.0, 55.0), (330.0, 110.0)]
RANK_LABELS = ["1ST", "2ND", "3RD", "4TH"]


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


def _cup_path(cx: float, base_y: float, r: float, h: float) -> skia.Path:
    top_r = r * 0.62
    path = skia.Path()
    path.moveTo(cx - r, base_y)
    path.quadTo(cx - r, base_y - h * 0.95, cx - top_r, base_y - h)
    path.lineTo(cx + top_r, base_y - h)
    path.quadTo(cx + r, base_y - h * 0.95, cx + r, base_y)
    path.close()
    return path


def _cup_paint(base_y: float, h: float) -> skia.Paint:
    shader = skia.GradientShader.MakeLinear(
        points=[(0.0, base_y - h), (0.0, base_y)],
        colors=[skia.Color(60, 64, 76, 255), skia.Color(18, 20, 26, 255)],
        positions=[0.0, 1.0],
    )
    return skia.Paint(AntiAlias=True, Shader=shader)


def draw_frame(canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int,
               event_cfg: dict) -> None:
    w, h = float(settings.width), float(settings.height)
    sim_t = timeline.frame_sim_time[frame_idx]
    step = record.steps[_step_index(record, sim_t)]
    overlays = _active_overlays(timeline, frame_idx)
    overlay_kinds = {o.kind for o in overlays}
    teams_by_id = {t.id: t for t in teams}
    table_cfg = event_cfg["table"]
    cup_radius = float(table_cfg["cup_radius"])
    lift_height = float(table_cfg["lift_height"])

    canvas.clear(_hex_to_color(settings.background_color))
    canvas.drawRect(skia.Rect(0, 0, w, h), _vignette_paint(w, h))

    _draw_table_shadow(canvas)

    # back-to-front draw order: angle doubles as this event's scale field --
    # the "front" role in a swap scales up, "back" scales down, so sorting
    # ascending by scale draws the smaller (farther) cup first.
    draw_order = sorted(range(4), key=lambda cup: step.balls[cup].angle)
    for cup in draw_order:
        _draw_cup_and_ball(canvas, step.balls[cup], record.balls[cup], teams_by_id[record.balls[cup].team_id], settings,
                            cup_radius, lift_height)

    if "podium_labels" in overlay_kinds:
        _draw_podium_labels(canvas, settings, cup_radius)

    _draw_hud(canvas, settings, overlays, overlay_kinds)


def _draw_table_shadow(canvas) -> None:
    cx, cy = TABLE_CENTER
    paint = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 90))
    canvas.drawOval(skia.Rect(cx - 520, cy + 10, cx + 520, cy + 60), paint)


def _draw_cup_and_ball(canvas, bs, info, team: Team, settings: Settings, cup_radius: float, lift_height: float) -> None:
    x, base_y = bs.x, bs.y
    scale = bs.angle
    lift = max(0.0, min(1.0, bs.vy))
    r = cup_radius * scale
    cup_h = r * 1.15

    if lift > 0.0:
        glow = _GLOW.get(team.color, r * 0.6)
        paint = skia.Paint(AntiAlias=True)
        paint.setAlphaf(lift)
        canvas.drawImage(glow, x - glow.width() / 2, base_y - glow.height() / 2, paint=paint)
        body_paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color))
        body_paint.setAlphaf(lift)
        canvas.drawCircle(x, base_y, r * 0.52, body_paint)
        if lift > 0.85:
            _draw_ball_label(canvas, settings, x, base_y, r, info.name)

    cup_y = base_y - lift * lift_height
    path = _cup_path(x, cup_y, r, cup_h)
    canvas.drawPath(path, _cup_paint(cup_y, cup_h))
    rim_paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 255, 255, 40),
                            Style=skia.Paint.kStroke_Style, StrokeWidth=2.5)
    canvas.drawPath(path, rim_paint)


_LABEL_FONT: skia.Font | None = None


def _label_font() -> skia.Font | None:
    return _LABEL_FONT


def _draw_ball_label(canvas, settings: Settings, x: float, y: float, r: float, name: str) -> None:
    font = _label_font()
    if font is None:
        return
    text = name.upper()
    outline = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 220), Style=skia.Paint.kStroke_Style, StrokeWidth=4)
    fill = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
    tw = font.measureText(text)
    tx, ty = x - tw / 2, y + r * 0.72 + 30
    canvas.drawString(text, tx, ty, font, outline)
    canvas.drawString(text, tx, ty, font, fill)


def _heavy_font(settings: Settings, size: float) -> skia.Font:
    tf = skia.Typeface.MakeFromFile(str(settings.font_heavy))
    return skia.Font(tf, size)


def init_fonts(settings: Settings) -> None:
    global _LABEL_FONT
    tf = skia.Typeface.MakeFromFile(str(settings.font_label))
    _LABEL_FONT = skia.Font(tf, 22)


def _draw_podium_labels(canvas, settings: Settings, cup_radius: float) -> None:
    font = _heavy_font(settings, 34)
    paint = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
    cx, cy = TABLE_CENTER
    for rank, (dx, dy) in enumerate(PODIUM_SLOTS):
        x, y = cx + dx, cy + dy
        text = RANK_LABELS[rank]
        tw = font.measureText(text)
        canvas.drawString(text, x - tw / 2, y + cup_radius * 1.35, font, paint)


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
    x_min, x_max = settings.safe_x_min, settings.safe_x_max
    y_min = settings.safe_y_min
    heavy_big = _heavy_font(settings, 60)
    heavy_mid = _heavy_font(settings, 40)
    heavy_small = _heavy_font(settings, 30)

    showing_card = bool(overlay_kinds & {"hook", "storyline", "win", "standings"})
    if not showing_card:
        white = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
        canvas.drawString("SHELL SHUFFLE", x_min, y_min + 40, heavy_small, white)

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
        canvas.drawString(text, center_x - tw / 2, 240, heavy_big, white)

    elif overlay.kind == "storyline":
        text = overlay.data.get("text", "")
        if text:
            _draw_wrapped_centered(canvas, text, heavy_small, white, center_x, 330, max_w, 42)

    elif overlay.kind == "got_it":
        text = "GOT IT?"
        tw = heavy_mid.measureText(text)
        bg = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 160))
        rect = skia.Rect(center_x - tw / 2 - 24, 420, center_x + tw / 2 + 24, 480)
        canvas.drawRoundRect(rect, 14, 14, bg)
        canvas.drawString(text, center_x - tw / 2, 462, heavy_mid, white)

    elif overlay.kind == "freeze_prompt":
        _draw_wrapped_centered(canvas, "WHERE IS YOUR TEAM?", heavy_mid, white, center_x, 1280, max_w, 48)
        _draw_wrapped_centered(canvas, "COMMENT THE CUP", heavy_small, white, center_x, 1360, max_w, 42)

    elif overlay.kind == "reveal":
        text = f"{overlay.data['rank']}: {overlay.data['team'].upper()}"
        tw = heavy_big.measureText(text)
        canvas.drawString(text, center_x - tw / 2, 1280, heavy_big, white)

    elif overlay.kind == "win":
        team = overlay.data["team"]
        mvp = overlay.data["mvp"]
        _draw_confetti(canvas, settings, team)
        t1 = f"{team.upper()} WINS"
        tw = heavy_big.measureText(t1)
        canvas.drawString(t1, center_x - tw / 2, 1300, heavy_big, white)
        t2 = f"MVP: {mvp.upper()}"
        tw2 = heavy_mid.measureText(t2)
        canvas.drawString(t2, center_x - tw2 / 2, 1370, heavy_mid, white)

    elif overlay.kind == "standings":
        # starts below every podium cup's own name/rank labels (max podium
        # label y is ~1140 -- found by actually rendering a frame and
        # checking it, not assumed) so the two never overlap.
        standings = overlay.data.get("standings", {})
        teaser = overlay.data.get("teaser", "")
        title = "STANDINGS"
        tw = heavy_mid.measureText(title)
        canvas.drawString(title, center_x - tw / 2, 1180, heavy_mid, white)
        y = 1225
        for team_id, pts in standings.items():
            line = f"{team_id.upper()}: {pts}"
            tw2 = heavy_small.measureText(line)
            canvas.drawString(line, center_x - tw2 / 2, y, heavy_small, white)
            y += 32
        if teaser:
            _draw_wrapped_centered(canvas, teaser, heavy_small, white, center_x, y + 15, max_w, 28)


def _draw_confetti(canvas, settings: Settings, team_name: str) -> None:
    color_by_name = {"Red": "#FF4D5E", "Blue": "#3DA5FF", "Green": "#3DDC84", "Yellow": "#FFD23F"}
    hex_color = color_by_name.get(team_name, "#FFFFFF")
    paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(hex_color, 220))
    for i in range(40):
        x = (i * 97) % settings.width
        y = (i * 53) % 700 + 850
        size = 6 + (i % 3) * 3
        canvas.drawRect(skia.Rect(x, y, x + size, y + size * 2), paint)
