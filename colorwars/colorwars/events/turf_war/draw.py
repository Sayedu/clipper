"""Turf War's frame renderer. The grid isn't stored per physics step (784
cells x thousands of steps would dwarf everything else in the record) --
it's reconstructed here from the fixed initial-quadrant rule plus the
sparse cell_converted event log, replayed up to the current sim time. Zero
live randomness, same rule as every other event's draw.py.
"""

from __future__ import annotations

import skia

from ...engine.config import Settings, Team
from ...engine.records import SimRecord, Timeline
from .sim import initial_grid

CELL_GAP = 1.5


def _hex_to_color(hex_str: str, alpha: int = 255) -> int:
    h = hex_str.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return skia.Color(r, g, b, alpha)


def _grid_state_at(record: SimRecord, sim_t: float, grid_size: int) -> tuple[list[list[str]], dict[str, int]]:
    team_ids = [t.id for t in record.teams]
    grid = initial_grid(grid_size, team_ids)
    counts = {tid: 0 for tid in team_ids}
    for row in grid:
        for owner in row:
            counts[owner] += 1
    for e in record.events:
        if e.t > sim_t:
            break
        if e.kind == "cell_converted":
            r, c = e.data["cell"]
            old = grid[r][c]
            if old != e.data["team_id"]:
                counts[old] -= 1
                counts[e.data["team_id"]] += 1
                grid[r][c] = e.data["team_id"]
    return grid, counts


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


def _active_powerup_at(record: SimRecord, sim_t: float):
    last_spawn = None
    for e in record.events:
        if e.t > sim_t:
            break
        if e.kind == "powerup_spawn":
            last_spawn = e
        elif e.kind == "powerup_pickup" and last_spawn is not None and e.t >= last_spawn.t:
            last_spawn = None
    return last_spawn


def draw_frame(canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int,
               event_cfg: dict) -> None:
    w, h = float(settings.width), float(settings.height)
    sim_t = timeline.frame_sim_time[frame_idx]
    step = record.steps[_step_index(record, sim_t)]
    overlays = _active_overlays(timeline, frame_idx)
    overlay_kinds = {o.kind for o in overlays}
    teams_by_id = {t.id: t for t in teams}

    canvas.clear(_hex_to_color(settings.background_color))

    # must match sim.py's own grid.size/cell_px/origin reads exactly -- it
    # derives none of these from the others (cell_px isn't 840/size, it's
    # its own config leaf), so a Studio override to any one of them needs
    # the real numbers here too, not an 840x840-arena assumption.
    grid_cfg = event_cfg["grid"]
    size = int(grid_cfg["size"])
    cell_px = float(grid_cfg["cell_px"])
    ox, oy = float(grid_cfg["origin"][0]), float(grid_cfg["origin"][1])
    grid, counts = _grid_state_at(record, sim_t, size)

    paint = skia.Paint(AntiAlias=True)
    for r in range(size):
        for c in range(size):
            owner = grid[r][c]
            paint.setColor(_hex_to_color(teams_by_id[owner].color, 210))
            x0, y0 = ox + c * cell_px, oy + r * cell_px
            canvas.drawRect(skia.Rect(x0 + CELL_GAP, y0 + CELL_GAP, x0 + cell_px - CELL_GAP, y0 + cell_px - CELL_GAP), paint)

    powerup = _active_powerup_at(record, sim_t)
    if powerup is not None:
        pr, pc = powerup.data["cell"]
        px, py = ox + (pc + 0.5) * cell_px, oy + (pr + 0.5) * cell_px
        _draw_powerup_icon(canvas, px, py, powerup.data["type"])

    for i, bs in enumerate(step.balls):
        info = record.balls[i]
        team = teams_by_id[info.team_id]
        r = info.base_radius
        alpha = 255 if bs.alive else 70
        glow = _glow(team.color, r)
        canvas.drawImage(glow, bs.x - glow.width() / 2, bs.y - glow.height() / 2)
        body_paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color, alpha))
        canvas.drawCircle(bs.x, bs.y, r, body_paint)
        ring_paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 255, 255, 230),
                                 Style=skia.Paint.kStroke_Style, StrokeWidth=2.0)
        canvas.drawCircle(bs.x, bs.y, r, ring_paint)

    if not (overlay_kinds & {"hook", "storyline", "winner", "standings"}):
        _draw_cell_bar(canvas, settings, teams, counts)

    _draw_hud(canvas, settings, overlays, overlay_kinds)


def _draw_powerup_icon(canvas, x: float, y: float, ptype: str) -> None:
    if ptype == "bomb":
        paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 140, 40))
        path = skia.Path()
        s = 16.0
        path.moveTo(x, y - s); path.lineTo(x + s, y); path.lineTo(x, y + s); path.lineTo(x - s, y)
        path.close()
        canvas.drawPath(path, paint)
    elif ptype == "ghost":
        paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 255, 255, 220),
                            Style=skia.Paint.kStroke_Style, StrokeWidth=3.0)
        canvas.drawCircle(x, y, 14, paint)
    elif ptype == "speed":
        paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 230, 80))
        path = skia.Path()
        path.moveTo(x - 10, y - 14); path.lineTo(x + 8, y - 2); path.lineTo(x - 2, y)
        path.lineTo(x + 10, y + 14); path.lineTo(x - 8, y + 2); path.lineTo(x + 2, y)
        path.close()
        canvas.drawPath(path, paint)


def _draw_cell_bar(canvas, settings: Settings, teams: list[Team], counts: dict[str, int]) -> None:
    x_min, x_max = settings.safe_x_min, settings.safe_x_max
    y = settings.safe_y_max - 36
    bar_w = x_max - x_min
    bar_h = 24.0
    total = sum(counts.values()) or 1
    x = float(x_min)
    for team in teams:
        frac = counts.get(team.id, 0) / total
        seg_w = bar_w * frac
        paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color, 230))
        canvas.drawRect(skia.Rect(x, y, x + seg_w, y + bar_h), paint)
        x += seg_w
    border = skia.Paint(AntiAlias=True, Color=skia.Color(255, 255, 255, 120),
                         Style=skia.Paint.kStroke_Style, StrokeWidth=1.5)
    canvas.drawRect(skia.Rect(x_min, y, x_max, y + bar_h), border)


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
        canvas.drawString("TURF WAR", x_min, y_min + 40, heavy_small, white)

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
        # unlike every other event's plain dark background, this card sits
        # over the live (colorful, busy) grid -- a dim backdrop keeps the
        # text readable regardless of which team's cells are behind it.
        _draw_card_backdrop(canvas, settings, 640, 820)
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
        _draw_card_backdrop(canvas, settings, 640, 980)
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


def _draw_card_backdrop(canvas, settings: Settings, top: float, bottom: float) -> None:
    bg = skia.Paint(AntiAlias=True, Color=skia.Color(8, 10, 20, 190))
    canvas.drawRect(skia.Rect(0, top, settings.width, bottom), bg)


def _draw_confetti(canvas, settings: Settings, team_name: str) -> None:
    color_by_name = {"Red": "#FF4D5E", "Blue": "#3DA5FF", "Green": "#3DDC84", "Yellow": "#FFD23F"}
    hex_color = color_by_name.get(team_name, "#FFFFFF")
    paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(hex_color, 220))
    for i in range(40):
        x = (i * 97) % settings.width
        y = (i * 53) % 600 + 150
        size = 6 + (i % 3) * 3
        canvas.drawRect(skia.Rect(x, y, x + size, y + size * 2), paint)
