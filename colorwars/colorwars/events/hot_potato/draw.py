"""Hot Potato's frame renderer. Pure function of (record, timeline,
frame_idx) -- zero live randomness, same rule every event follows. The
bomb holder and round countdown shown on screen are both derived from
the "bomb_round_start"/"bomb_pass" SimEvents at this frame's sim time,
never from extra StepRecord fields (ring_angle/gaps_deg stay unused
placeholders here, same as every non-Ring-of-Doom event).
"""

from __future__ import annotations

import math

import skia

from ...engine.config import Settings, Team
from ...engine.records import SimRecord, Timeline

TRAIL_STEPS_BACK = 6
BOMB_COLOR = skia.Color(255, 90, 60, 255)
TAU = 2 * math.pi


def _hex_to_color(hex_str: str, alpha: int = 255) -> int:
    h = hex_str.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return skia.Color(r, g, b, alpha)


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


def _current_bomb_state(record: SimRecord, sim_t: float) -> tuple[int | None, float | None]:
    """Returns (holder_ball_id, seconds_remaining_this_round) as of sim_t,
    reconstructed from the event log -- there is no live round/holder
    state on StepRecord."""
    holder_id: int | None = None
    deadline: float | None = None
    round_start_t = 0.0
    for e in record.events:
        if e.t > sim_t:
            break
        if e.kind == "bomb_round_start":
            holder_id = e.data["holder_ball_id"]
            deadline = e.data["round_deadline"]
            round_start_t = e.t
        elif e.kind == "bomb_pass" and e.t >= round_start_t:
            holder_id = e.data["to_ball_id"]
    remaining = None if deadline is None else max(0.0, deadline - sim_t)
    return holder_id, remaining


def draw_frame(canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int,
               event_cfg: dict) -> None:
    w, h = float(settings.width), float(settings.height)
    sim_t = timeline.frame_sim_time[frame_idx]
    step = record.steps[_step_index(record, sim_t)]
    overlays = _active_overlays(timeline, frame_idx)
    overlay_kinds = {o.kind for o in overlays}
    teams_by_id = {t.id: t for t in teams}

    arena_cfg = event_cfg["arena"]
    arena_radius = float(arena_cfg["radius"])
    arena_center = (float(arena_cfg["center"][0]), float(arena_cfg["center"][1]))
    arena_segments = int(arena_cfg["segments"])

    canvas.clear(_hex_to_color(settings.background_color))
    canvas.drawRect(skia.Rect(0, 0, w, h), _vignette_paint(w, h))

    holder_id, remaining = _current_bomb_state(record, sim_t)
    # the countdown/highlight is the one thing that must stay visible
    # through the persistent hook text (unlike Ring of Doom's title, which
    # was fine to hide) -- it's the entire explanation for why a ball is
    # about to explode. Only the winner card (game already over) hides it.
    showing_winner_card = "winner" in overlay_kinds

    _draw_arena(canvas, arena_center, arena_radius, arena_segments)
    _draw_balls(canvas, step, record, teams_by_id, sim_t)
    if holder_id is not None and not showing_winner_card:
        _draw_bomb_holder(canvas, step, holder_id, remaining)
        if remaining is not None:
            _draw_bomb_timer(canvas, arena_center, arena_radius, remaining)

    _draw_hud(canvas, settings, record, episode_overlays=overlays, overlay_kinds=overlay_kinds, step=step, teams=teams)


def _draw_arena(canvas, center, radius: float, segments: int) -> None:
    cx, cy = center
    wall_paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=10, Color=_hex_to_color("#B8C0CC"))
    slot_deg = 360.0 / segments
    for i in range(segments):
        a0 = math.radians(i * slot_deg)
        a1 = math.radians((i + 1) * slot_deg)
        p0 = (cx + radius * math.cos(a0), cy + radius * math.sin(a0))
        p1 = (cx + radius * math.cos(a1), cy + radius * math.sin(a1))
        canvas.drawLine(p0[0], p0[1], p1[0], p1[1], wall_paint)


def _draw_balls(canvas, step, record: SimRecord, teams_by_id: dict, sim_t: float) -> None:
    step_idx = _step_index(record, sim_t)
    for i, bs in enumerate(step.balls):
        info = record.balls[i]
        team = teams_by_id[info.team_id]
        color_hex = team.color
        r = info.base_radius

        if bs.alive:
            for back in range(TRAIL_STEPS_BACK, 0, -1):
                j = max(0, step_idx - back * 2)
                prev = record.steps[j].balls[i]
                if not prev.alive:
                    continue
                alpha = int(60 * (1 - back / TRAIL_STEPS_BACK))
                if alpha <= 0:
                    continue
                canvas.drawCircle(prev.x, prev.y, r * 0.8, skia.Paint(AntiAlias=True, Color=_hex_to_color(color_hex, alpha)))

            canvas.drawCircle(bs.x, bs.y, r, skia.Paint(AntiAlias=True, Color=_hex_to_color(color_hex)))
            _draw_eyes(canvas, bs, r, eliminated=False)
            _draw_label(canvas, bs, r, info.name)
        else:
            canvas.drawCircle(bs.x, bs.y, r, skia.Paint(AntiAlias=True, Color=_hex_to_color(color_hex)))
            _draw_eyes(canvas, bs, r, eliminated=True)


def _draw_eyes(canvas, bs, r: float, eliminated: bool) -> None:
    eye_r = r * 0.26
    offset = r * 0.38
    for side in (-1, 1):
        ex, ey = bs.x + side * offset, bs.y - r * 0.15
        canvas.drawCircle(ex, ey, eye_r, skia.Paint(AntiAlias=True, Color=skia.ColorWHITE))
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
            canvas.drawCircle(ex + pupil_off * math.cos(ang), ey + pupil_off * math.sin(ang), eye_r * 0.45,
                               skia.Paint(AntiAlias=True, Color=skia.ColorBLACK))


def _draw_bomb_holder(canvas, step, holder_id: int, remaining: float | None) -> None:
    """The pulsing ring around whoever's holding it -- this is the "why is
    that ball about to explode" answer, the exact gap that made Ring of
    Doom's hazards look like nothing touched the ball before they were
    fixed to draw anything at all. The countdown number itself lives
    outside the arena now (see _draw_bomb_timer) so it's always readable
    in one fixed place instead of following the holder around the bowl."""
    if holder_id >= len(step.balls):
        return
    bs = step.balls[holder_id]
    if not bs.alive:
        return
    r = 30.0
    pulse_hz = 2.0 if remaining is None or remaining > 1.5 else 2.0 + (1.5 - remaining) * 4.0
    pulse = 0.85 + 0.2 * math.sin(remaining * pulse_hz * TAU if remaining is not None else 0.0)
    canvas.drawCircle(bs.x, bs.y, r * 1.5 * pulse, skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style,
                                                               StrokeWidth=6, Color=BOMB_COLOR))


def _draw_bomb_timer(canvas, center, radius: float, remaining: float) -> None:
    """The round countdown, fixed just outside the top of the arena --
    never moves, always in the same readable spot, with hundredths of a
    second visibly ticking down (not just whole seconds) so it reads as
    smooth motion rather than a number that jumps once a second."""
    cx, cy = center
    y = cy - radius - 56.0
    label = f"{max(0.0, remaining):05.2f}"
    font = _countdown_font()
    tw = font.measureText(label)
    text_color = skia.Color(255, 60, 40, 255) if remaining < 1.5 else skia.ColorWHITE
    outline = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 220), Style=skia.Paint.kStroke_Style, StrokeWidth=5)
    fill = skia.Paint(AntiAlias=True, Color=text_color)
    canvas.drawString(label, cx - tw / 2, y, font, outline)
    canvas.drawString(label, cx - tw / 2, y, font, fill)


_LABEL_FONT: skia.Font | None = None
_SMALL_LABEL_FONT: skia.Font | None = None
_COUNTDOWN_FONT: skia.Font | None = None


def _label_font() -> skia.Font:
    return _LABEL_FONT or skia.Font(skia.Typeface(), 22)


def _label_font_small() -> skia.Font:
    return _SMALL_LABEL_FONT or skia.Font(skia.Typeface(), 20)


def _countdown_font() -> skia.Font:
    return _COUNTDOWN_FONT or skia.Font(skia.Typeface(), 48)


def _draw_label(canvas, bs, r: float, name: str) -> None:
    font = _label_font()
    text = name.upper()
    outline = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 220), Style=skia.Paint.kStroke_Style, StrokeWidth=4)
    fill = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
    tw = font.measureText(text)
    x, y = bs.x - tw / 2, bs.y + r + 26
    canvas.drawString(text, x, y, font, outline)
    canvas.drawString(text, x, y, font, fill)


def init_fonts(settings: Settings) -> None:
    global _LABEL_FONT, _SMALL_LABEL_FONT, _COUNTDOWN_FONT
    tf = skia.Typeface.MakeFromFile(str(settings.font_label))
    _LABEL_FONT = skia.Font(tf, 22)
    _SMALL_LABEL_FONT = skia.Font(tf, 20)
    heavy_tf = skia.Typeface.MakeFromFile(str(settings.font_heavy))
    _COUNTDOWN_FONT = skia.Font(heavy_tf, 52)


def _heavy_font(settings: Settings, size: float) -> skia.Font:
    tf = skia.Typeface.MakeFromFile(str(settings.font_heavy))
    return skia.Font(tf, size)


def _draw_hud(canvas, settings: Settings, record: SimRecord, episode_overlays, overlay_kinds, step, teams) -> None:
    x_min, x_max = settings.safe_x_min, settings.safe_x_max
    y_min, y_max = settings.safe_y_min, settings.safe_y_max

    heavy_big = _heavy_font(settings, 64)
    heavy_mid = _heavy_font(settings, 40)
    heavy_small = _heavy_font(settings, 30)

    showing_card = bool(overlay_kinds & {"winner", "standings", "hook"})
    if not showing_card:
        title_paint = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
        canvas.drawString("HOT POTATO", x_min, y_min + 40, heavy_small, title_paint)
        alive = sum(1 for b in step.balls if b.alive)
        n_left_text = f"{alive} LEFT"
        tw = heavy_mid.measureText(n_left_text)
        canvas.drawString(n_left_text, (x_min + x_max) / 2 - tw / 2, y_min + 95, heavy_mid, title_paint)

    _draw_roster(canvas, x_min, x_max, y_max, record, step, teams)

    for o in episode_overlays:
        _draw_overlay(canvas, o, heavy_big, heavy_mid, heavy_small, settings)


def _draw_roster(canvas, x_min: float, x_max: float, y_max: float, record: SimRecord, step, teams) -> None:
    font = _label_font_small()
    team_font = _COUNTDOWN_FONT or skia.Font(skia.Typeface(), 25)
    icon_r = 16.0
    row_h = 50.0
    rows = 4
    name_offset = icon_r + 18.0
    group_label_gap = 36.0
    text_descent_buffer = 8.0
    top_y = y_max - row_h * (rows - 1) - name_offset - group_label_gap - text_descent_buffer
    slot_w = (x_max - x_min) / len(teams)

    for k, team in enumerate(teams):
        col_x = x_min + slot_w * (k + 0.5)
        ball_idxs = [i for i, b in enumerate(record.balls) if b.team_id == team.id]
        last_name_y = top_y
        for row, i in enumerate(ball_idxs[:rows]):
            info = record.balls[i]
            bs = step.balls[i]
            y = top_y + row * row_h
            color = _hex_to_color(team.color) if bs.alive else _hex_to_color(team.color, 80)
            canvas.drawCircle(col_x, y, icon_r, skia.Paint(AntiAlias=True, Color=color))
            if not bs.alive:
                mark = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE, Style=skia.Paint.kStroke_Style, StrokeWidth=3.2)
                d = icon_r * 0.6
                canvas.drawLine(col_x - d, y - d, col_x + d, y + d, mark)
                canvas.drawLine(col_x - d, y + d, col_x + d, y - d, mark)
            name = info.name.upper()
            tw = font.measureText(name)
            text_color = skia.ColorWHITE if bs.alive else skia.Color(255, 255, 255, 140)
            name_y = y + name_offset
            canvas.drawString(name, col_x - tw / 2, name_y, font, skia.Paint(AntiAlias=True, Color=text_color))
            last_name_y = name_y

        label = team.name.upper()
        lw = team_font.measureText(label)
        canvas.drawString(label, col_x - lw / 2, last_name_y + group_label_gap, team_font,
                           skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color)))


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


def _draw_overlay(canvas, overlay, heavy_big, heavy_mid, heavy_small, settings: Settings) -> None:
    w = settings.width
    white = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
    center_x = w / 2

    if overlay.kind == "hook":
        text = overlay.data["text"]
        max_w = settings.safe_x_max - settings.safe_x_min - 40
        _draw_wrapped_centered(canvas, text, heavy_big, white, center_x, 260, max_w, 70)

    elif overlay.kind == "toast":
        text = overlay.data["text"]
        tw = heavy_mid.measureText(text)
        bg = skia.Paint(AntiAlias=True, Color=skia.Color(0, 0, 0, 160))
        rect = skia.Rect(center_x - tw / 2 - 20, 500, center_x + tw / 2 + 20, 556)
        canvas.drawRoundRect(rect, 12, 12, bg)
        canvas.drawString(text, center_x - tw / 2, 538, heavy_mid, white)

    elif overlay.kind == "winner":
        team = overlay.data.get("team", "?")
        mvp = overlay.data.get("mvp", "")
        t1 = f"{team.upper()} WINS"
        tw = heavy_big.measureText(t1)
        canvas.drawString(t1, center_x - tw / 2, 800, heavy_big, white)
        t2 = f"MVP: {mvp}"
        tw2 = heavy_mid.measureText(t2)
        canvas.drawString(t2, center_x - tw2 / 2, 870, heavy_mid, white)
