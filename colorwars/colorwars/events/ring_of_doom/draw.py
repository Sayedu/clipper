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

GAP_NEAR_PX = 60.0
TRAIL_STEPS_BACK = 6


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


def _recent_events(record: SimRecord, sim_t: float, window: float, kinds: set[str]):
    return [e for e in record.events if e.kind in kinds and sim_t - window <= e.t <= sim_t]


def draw_frame(canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int,
               event_cfg: dict) -> None:
    w, h = float(settings.width), float(settings.height)
    sim_t = timeline.frame_sim_time[frame_idx]
    step = record.steps[_step_index(record, sim_t)]
    overlays = _active_overlays(timeline, frame_idx)
    overlay_kinds = {o.kind for o in overlays}
    teams_by_id = {t.id: t for t in teams}

    # must match whatever ring.* the actual simulate() call used -- never a
    # hardcoded default. A Studio override of ring.radius/segments/center
    # that this draw path ignored would desync the drawn wall from the real
    # physics wall, visually reading as "the ball passed through solid wall".
    ring_cfg = event_cfg["ring"]
    ring_radius = float(ring_cfg["radius"])
    ring_center = (float(ring_cfg["center"][0]), float(ring_cfg["center"][1]))
    ring_segments = int(ring_cfg["segments"])

    # -- background --
    canvas.clear(_hex_to_color(settings.background_color))
    canvas.drawRect(skia.Rect(0, 0, w, h), _vignette_paint(w, h))

    cx, cy = ring_center

    _draw_ring(canvas, step, ring_center, ring_radius, ring_segments)
    _draw_particles(canvas, record, sim_t, ring_center)
    _draw_balls(canvas, step, record, teams_by_id, sim_t, ring_center, ring_radius)

    _draw_hud(canvas, settings, record, episode_overlays=overlays, overlay_kinds=overlay_kinds, step=step, teams=teams)


def _draw_ring(canvas, step, ring_center, ring_radius: float, ring_segments: int) -> None:
    cx, cy = ring_center
    ring_color = "#B8C0CC"

    slot_deg = 360.0 / ring_segments
    gaps = step.gaps_deg
    ring_angle_deg = math.degrees(step.ring_angle)

    wall_paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=10, Color=_hex_to_color(ring_color))

    # the pulsing red "gap warning" arc used to be drawn here too, directly
    # over the gap -- it's a continuous arc (addArc) laid over a wall that's
    # actually built from 96 DISCRETE segments, and the two don't line up
    # exactly at segment boundaries. Reported directly as "the opening
    # became a red line" and "it looks open when it isn't" -- removed
    # rather than reconciled, since the segment loop below is already the
    # single source of truth for what's actually open (identical formula to
    # the physics side's own gap check), and needs no warning drawn over it
    # to stay correct.
    for i in range(ring_segments):
        slot_center_local = (i + 0.5) * slot_deg
        covered = any(abs(((slot_center_local - c + 180) % 360) - 180) <= hw for c, hw in gaps)
        if covered:
            continue
        a0 = math.radians(i * slot_deg + ring_angle_deg)
        a1 = math.radians((i + 1) * slot_deg + ring_angle_deg)
        p0 = (cx + ring_radius * math.cos(a0), cy + ring_radius * math.sin(a0))
        p1 = (cx + ring_radius * math.cos(a1), cy + ring_radius * math.sin(a1))
        canvas.drawLine(p0[0], p0[1], p1[0], p1[1], wall_paint)


def _draw_particles(canvas, record: SimRecord, sim_t: float, ring_center) -> None:
    hits = _recent_events(record, sim_t, 0.4, {"collision", "elimination"})
    for e in hits:
        if e.kind == "collision" and e.data.get("impulse", 0) < 900:
            continue
        age = sim_t - e.t
        life = 0.4
        if age > life:
            continue
        frac = age / life
        x, y = e.data.get("x", ring_center[0]), e.data.get("y", ring_center[1])
        color = skia.Color(255, 90, 90, int(255 * (1 - frac))) if e.kind == "elimination" else \
            skia.Color(255, 230, 160, int(200 * (1 - frac)))
        paint = skia.Paint(AntiAlias=True, Color=color)
        n = 10 if e.kind == "elimination" else 5
        for k in range(n):
            ang = (k / n) * 2 * math.pi + e.step * 0.013
            dist = frac * (70 if e.kind == "elimination" else 32)
            px, py = x + dist * math.cos(ang), y + dist * math.sin(ang)
            canvas.drawCircle(px, py, max(1.0, 4 * (1 - frac)), paint)


def _draw_balls(canvas, step, record: SimRecord, teams_by_id: dict, sim_t: float, ring_center, ring_radius: float) -> None:
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

            body_paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(color_hex))
            canvas.drawCircle(bs.x, bs.y, r, body_paint)

            dist_from_center = math.hypot(bs.x - ring_center[0], bs.y - ring_center[1])
            near_wall = dist_from_center >= ring_radius - GAP_NEAR_PX
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
_SMALL_LABEL_FONT: skia.Font | None = None
_ROSTER_TEAM_FONT: skia.Font | None = None


def _label_font(settings: Settings) -> skia.Font:
    global _LABEL_FONT
    if _LABEL_FONT is None:
        tf = skia.Typeface.MakeFromFile(str(settings.font_label))
        _LABEL_FONT = skia.Font(tf, 22)
    return _LABEL_FONT


def _label_font_small() -> skia.Font:
    # loaded by init_fonts() alongside _LABEL_FONT; falls back to a blank
    # typeface only if somehow called before that (never happens in a real
    # render -- init_render() always runs first).
    return _SMALL_LABEL_FONT or skia.Font(skia.Typeface(), 20)


def _roster_team_font() -> skia.Font:
    # the team-color label under each roster column, deliberately bigger
    # than the player-name font above it (by request, read clearly at a
    # glance) -- loaded by init_fonts() alongside the others.
    return _ROSTER_TEAM_FONT or skia.Font(skia.Typeface(), 25)


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
    global _LABEL_FONT, _SMALL_LABEL_FONT, _ROSTER_TEAM_FONT
    tf = skia.Typeface.MakeFromFile(str(settings.font_label))
    _LABEL_FONT = skia.Font(tf, 22)
    _SMALL_LABEL_FONT = skia.Font(tf, 20)   # was 17 -- the roster's player names, made easier to read
    _ROSTER_TEAM_FONT = skia.Font(tf, 25)   # the roster's team-color labels, bigger still


def _draw_hud(canvas, settings: Settings, record: SimRecord, episode_overlays, overlay_kinds, step, teams) -> None:
    x_min, x_max = settings.safe_x_min, settings.safe_x_max
    y_min, y_max = settings.safe_y_min, settings.safe_y_max
    heavy_big = _heavy_font(settings, 64)
    heavy_mid = _heavy_font(settings, 40)
    heavy_small = _heavy_font(settings, 30)

    showing_card = bool(overlay_kinds & {"winner", "standings", "hook"})

    if not showing_card:
        # -- top: event title + N LEFT --
        title_paint = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
        canvas.drawString("RING OF DOOM", x_min, y_min + 40, heavy_small, title_paint)
        alive = sum(1 for b in step.balls if b.alive)
        n_left_text = f"{alive} LEFT"
        tw = heavy_mid.measureText(n_left_text)
        canvas.drawString(n_left_text, (x_min + x_max) / 2 - tw / 2, y_min + 95, heavy_mid, title_paint)

    # -- bottom: a full roster, one column per team, every ball by name,
    # crossed out the moment it's eliminated -- shown throughout (including
    # under the winner/standings cards), since it sits below the ring, not
    # over it, and "who's still in it" stays useful info right to the end.
    _draw_roster(canvas, x_min, x_max, y_max, record, step, teams)

    for o in episode_overlays:
        _draw_overlay(canvas, o, heavy_big, heavy_mid, heavy_small, settings)


def _draw_roster(canvas, x_min: float, x_max: float, y_max: float, record: SimRecord, step, teams) -> None:
    # sized up from an earlier, smaller pass (icon_r 13->16, row_h 44->50,
    # name font 17->20pt, team-label font a new, bigger 25pt) -- by request,
    # the whole roster was reading too small. ring.center in config was
    # also moved up (see ring_of_doom.yaml) to free the extra vertical room
    # this needs, including a bigger gap above the roster's first row.
    font = _label_font_small()
    team_font = _roster_team_font()
    icon_r = 16.0
    row_h = 50.0
    rows = 4
    name_offset = icon_r + 18.0  # ball-center to name-baseline
    group_label_gap = 36.0       # name baseline to team-label baseline
    text_descent_buffer = 8.0    # room for the team label's own descenders
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

        # the team-color label, one per group, under its last ball's name --
        # e.g. "RED" under the red column -- bigger than the name font and
        # in the team's own color so it reads clearly at a glance.
        label = team.name.upper()
        lw = team_font.measureText(label)
        canvas.drawString(label, col_x - lw / 2, last_name_y + group_label_gap, team_font,
                           skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color)))


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
        # word-wrapped (not a single drawString) since this line is now a
        # full sentence ("COMMENT WHICH COLOR WINS") rather than a short
        # phrase like the old "ONLY 1 SURVIVES" -- a fixed-position single
        # line would run past the safe area at this font size.
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
        team = overlay.data["team"]
        mvp = overlay.data["mvp"]
        _draw_confetti(canvas, settings, team)
        t1 = f"{team.upper()} WINS"
        tw = heavy_big.measureText(t1)
        canvas.drawString(t1, center_x - tw / 2, 800, heavy_big, white)
        t2 = f"MVP: {mvp.upper()}"
        tw2 = heavy_mid.measureText(t2)
        canvas.drawString(t2, center_x - tw2 / 2, 870, heavy_mid, white)

    # the "standings" overlay (a STANDINGS title, a points line per team, and
    # a wrapped teaser sentence, all stacked over the ring) used to render
    # here -- reported directly as "too much going on" inside the circle,
    # on top of the ring/balls still visibly in motion underneath it. The
    # "winner" card above already carries the moment that actually matters
    # (who won, who the MVP was); dropped the rest rather than trim it down,
    # since any text stacked here runs into the same complaint.


def _draw_confetti(canvas, settings: Settings, team_name: str) -> None:
    color_by_name = {"Red": "#FF4D5E", "Blue": "#3DA5FF", "Green": "#3DDC84", "Yellow": "#FFD23F"}
    hex_color = color_by_name.get(team_name, "#FFFFFF")
    paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(hex_color, 220))
    for i in range(40):
        x = (i * 97) % settings.width
        y = (i * 53) % 700 + 100
        size = 6 + (i % 3) * 3
        canvas.drawRect(skia.Rect(x, y, x + size, y + size * 2), paint)
