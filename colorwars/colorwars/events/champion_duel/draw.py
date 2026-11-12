"""Champion Duel's frame renderer. Each team's signature power at a given
sim_t depends on that champion's hits-landed count so far, which isn't
stored per step -- it's reconstructed by replaying the "hit" event log up
to sim_t (same regenerate-from-the-log approach used elsewhere), then fed
through the exact same pure power functions sim.py itself uses.
"""

from __future__ import annotations

import math

import skia

from ...engine.config import REPO_ROOT, Settings, Team, load_event_config
from ...engine.records import SimRecord, Timeline
from .sim import _blue_shield_half_deg, _duel_power, _red_reach

_CFG_CACHE: dict | None = None


def _cfg() -> dict:
    global _CFG_CACHE
    if _CFG_CACHE is None:
        _CFG_CACHE = load_event_config(REPO_ROOT, "champion_duel")
    return _CFG_CACHE


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


def _hits_landed_at(record: SimRecord, team_id: str, sim_t: float) -> int:
    n = 0
    for e in record.events:
        if e.t > sim_t:
            break
        if e.kind == "hit" and e.data["attacker"] == team_id and not e.data["blocked"]:
            n += 1
    return n


def _active_overlays(timeline: Timeline, frame_idx: int):
    return [o for o in timeline.overlays if o.start_frame <= frame_idx < o.end_frame]


def _step_index(record: SimRecord, sim_t: float) -> int:
    idx = round(sim_t * record.physics_hz)
    return max(0, min(len(record.steps) - 1, idx))


def _recent_hits(record: SimRecord, sim_t: float, window: float):
    return [e for e in record.events if e.kind == "hit" and sim_t - window <= e.t <= sim_t]


def draw_frame(canvas, record: SimRecord, timeline: Timeline, settings: Settings, teams: list[Team], frame_idx: int) -> None:
    sim_t = timeline.frame_sim_time[frame_idx]
    cam_x = timeline.frame_camera_x[frame_idx]
    cam_y = timeline.frame_camera_y[frame_idx]
    zoom = timeline.frame_zoom[frame_idx]
    step = record.steps[_step_index(record, sim_t)]
    overlays = _active_overlays(timeline, frame_idx)
    overlay_kinds = {o.kind for o in overlays}
    teams_by_id = {t.id: t for t in teams}
    w, h = float(settings.width), float(settings.height)
    pcfg = _cfg()["powers"]
    is_replay = "replay" in overlay_kinds

    canvas.clear(_hex_to_color(settings.background_color))
    canvas.drawRect(skia.Rect(0, 0, w, h), _vignette_paint(w, h))

    canvas.save()
    canvas.translate(w / 2, h / 2)
    canvas.scale(zoom, zoom)
    canvas.translate(-cam_x, -cam_y)

    # arena floor
    origin = _cfg()["arena"]["origin"]
    size = float(_cfg()["arena"]["size"])
    ox, oy = float(origin[0]), float(origin[1])
    floor_paint = skia.Paint(AntiAlias=True, Color=skia.Color(20, 24, 40),
                              Style=skia.Paint.kStroke_Style, StrokeWidth=4)
    canvas.drawRect(skia.Rect(ox, oy, ox + size, oy + size), floor_paint)

    champ_balls = [(i, record.balls[i], step.balls[i]) for i in range(2)]
    twin_balls = [(i, record.balls[i], step.balls[i]) for i in range(2, len(record.balls))]

    for i, info, bs in champ_balls:
        team = teams_by_id[info.team_id]
        hits = _hits_landed_at(record, info.team_id, sim_t)
        if info.team_id == "red":
            _draw_red_spikes(canvas, bs, info, team, hits, sim_t, pcfg)
        elif info.team_id == "blue":
            _draw_blue_shield(canvas, bs, info, team, hits, sim_t, pcfg)

    for _, info, bs in twin_balls:
        if not bs.alive:
            continue
        team = teams_by_id[info.team_id]
        glow = _glow(team.color, info.base_radius)
        canvas.drawImage(glow, bs.x - glow.width() / 2, bs.y - glow.height() / 2)
        paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color, 220))
        canvas.drawCircle(bs.x, bs.y, info.base_radius, paint)

    for i, info, bs in champ_balls:
        team = teams_by_id[info.team_id]
        alpha = 255 if bs.alive else 90
        glow = _glow(team.color, info.base_radius)
        canvas.drawImage(glow, bs.x - glow.width() / 2, bs.y - glow.height() / 2)
        body_paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color, alpha))
        canvas.drawCircle(bs.x, bs.y, info.base_radius, body_paint)
        ring_paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 255, 255, 230),
                                 Style=skia.Paint.kStroke_Style, StrokeWidth=2.5)
        canvas.drawCircle(bs.x, bs.y, info.base_radius, ring_paint)

    _draw_damage_numbers(canvas, record, sim_t)

    canvas.restore()

    if is_replay:
        tint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 60, 60, 26))
        canvas.drawRect(skia.Rect(0, 0, w, h), tint)

    _draw_hp_bars(canvas, record, teams_by_id, step, settings)
    _draw_hud(canvas, settings, overlays, overlay_kinds, is_replay)


def _vignette_paint(w: float, h: float) -> skia.Paint:
    shader = skia.GradientShader.MakeRadial(
        center=(w / 2, h / 2), radius=max(w, h) * 0.75,
        colors=[skia.Color(0, 0, 0, 0), skia.Color(0, 0, 0, 140)],
        positions=[0.55, 1.0],
    )
    return skia.Paint(Shader=shader)


def _draw_red_spikes(canvas, bs, info, team: Team, hits: int, sim_t: float, pcfg: dict) -> None:
    power = _duel_power(team, 4.0)
    reach = _red_reach(hits, pcfg, power)
    n = int(pcfg["red_spike_count"])
    rot = float(pcfg["red_spike_rotation_speed"])
    paint = skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color, 230),
                        Style=skia.Paint.kStroke_Style, StrokeWidth=6)
    tip_paint = skia.Paint(AntiAlias=True, Color=skia.Color(255, 230, 220, 240))
    for k in range(n):
        ang = rot * sim_t + k * (2 * math.pi / n)
        base_r = info.base_radius
        tip_x = bs.x + (base_r + reach) * math.cos(ang)
        tip_y = bs.y + (base_r + reach) * math.sin(ang)
        canvas.drawLine(bs.x + base_r * math.cos(ang), bs.y + base_r * math.sin(ang), tip_x, tip_y, paint)
        canvas.drawCircle(tip_x, tip_y, float(pcfg["red_spike_tip_radius"]), tip_paint)


def _draw_blue_shield(canvas, bs, info, team: Team, hits: int, sim_t: float, pcfg: dict) -> None:
    power = _duel_power(team, 6.0)
    half = _blue_shield_half_deg(hits, pcfg, power)
    rot = float(pcfg["blue_shield_rotation_speed"])
    center_deg = math.degrees(rot * sim_t)
    offset = float(pcfg["blue_shield_radius_offset"])
    r = info.base_radius + offset
    rect = skia.Rect(bs.x - r, bs.y - r, bs.x + r, bs.y + r)
    paint = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=10,
                        Color=skia.Color(140, 210, 255, 235))
    path = skia.Path()
    path.addArc(rect, center_deg - half, 2 * half)
    canvas.drawPath(path, paint)


def _draw_damage_numbers(canvas, record: SimRecord, sim_t: float) -> None:
    for e in _recent_hits(record, sim_t, 0.5):
        if e.data["damage"] <= 0 and not e.data["blocked"]:
            continue
        age = sim_t - e.t
        frac = min(1.0, age / 0.5)
        rise = frac * 36
        alpha = int(255 * (1 - frac))
        if alpha <= 0:
            continue
        x, y = e.data["x"], e.data["y"] - rise - 50
        text = "BLOCKED" if e.data["blocked"] else f"-{int(e.data['damage'])}"
        color = skia.Color(140, 200, 255, alpha) if e.data["blocked"] else skia.Color(255, 90, 90, alpha)
        font = _heavy_font_cached(26)
        paint = skia.Paint(AntiAlias=True, Color=color)
        tw = font.measureText(text)
        canvas.drawString(text, x - tw / 2, y, font, paint)


_HEAVY_FONT_SETTINGS: Settings | None = None
_HEAVY_FONT_CACHE: dict[int, skia.Font] = {}
_LABEL_FONT: skia.Font | None = None


def _heavy_font_cached(size: int) -> skia.Font:
    if size not in _HEAVY_FONT_CACHE and _HEAVY_FONT_SETTINGS is not None:
        tf = skia.Typeface.MakeFromFile(str(_HEAVY_FONT_SETTINGS.font_heavy))
        _HEAVY_FONT_CACHE[size] = skia.Font(tf, size)
    return _HEAVY_FONT_CACHE.get(size) or skia.Font(skia.Typeface(), size)


def init_fonts(settings: Settings) -> None:
    global _LABEL_FONT, _HEAVY_FONT_SETTINGS
    tf = skia.Typeface.MakeFromFile(str(settings.font_label))
    _LABEL_FONT = skia.Font(tf, 20)
    _HEAVY_FONT_SETTINGS = settings
    _HEAVY_FONT_CACHE.clear()


def _heavy_font(settings: Settings, size: float) -> skia.Font:
    tf = skia.Typeface.MakeFromFile(str(settings.font_heavy))
    return skia.Font(tf, size)


def _draw_hp_bars(canvas, record: SimRecord, teams_by_id: dict, step, settings: Settings) -> None:
    bar_w, bar_h = 380.0, 26.0
    y = settings.safe_y_min + 70.0
    positions = [(settings.safe_x_min, 1), (settings.safe_x_max - bar_w, -1)]
    for idx in (0, 1):
        info = record.balls[idx]
        bs = step.balls[idx]
        team = teams_by_id[info.team_id]
        x0, _ = positions[idx]
        hp_frac = max(0.0, min(1.0, bs.vx / 100.0))
        bg = skia.Paint(AntiAlias=True, Color=skia.Color(30, 32, 40, 220))
        canvas.drawRect(skia.Rect(x0, y, x0 + bar_w, y + bar_h), bg)
        fill = skia.Paint(AntiAlias=True, Color=_hex_to_color(team.color, 235))
        fw = bar_w * hp_frac
        fx = x0 if idx == 0 else x0 + bar_w - fw
        canvas.drawRect(skia.Rect(fx, y, fx + fw, y + bar_h), fill)
        border = skia.Paint(AntiAlias=True, Color=skia.Color(255, 255, 255, 140),
                             Style=skia.Paint.kStroke_Style, StrokeWidth=1.5)
        canvas.drawRect(skia.Rect(x0, y, x0 + bar_w, y + bar_h), border)
        if _LABEL_FONT is not None:
            label_paint = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
            text = info.name.upper()
            tx = x0 if idx == 0 else x0 + bar_w - _LABEL_FONT.measureText(text)
            canvas.drawString(text, tx, y - 8, _LABEL_FONT, label_paint)


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


def _draw_hud(canvas, settings: Settings, overlays, overlay_kinds, is_replay: bool) -> None:
    heavy_big = _heavy_font(settings, 56)
    heavy_mid = _heavy_font(settings, 38)
    heavy_small = _heavy_font(settings, 28)

    if is_replay:
        white = skia.Paint(AntiAlias=True, Color=skia.ColorWHITE)
        text = "REPLAY"
        tw = heavy_mid.measureText(text)
        bg = skia.Paint(AntiAlias=True, Color=skia.Color(120, 0, 0, 200))
        rect = skia.Rect(settings.width / 2 - tw / 2 - 20, settings.safe_y_min, settings.width / 2 + tw / 2 + 20,
                          settings.safe_y_min + 56)
        canvas.drawRoundRect(rect, 10, 10, bg)
        canvas.drawString(text, settings.width / 2 - tw / 2, settings.safe_y_min + 40, heavy_mid, white)

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
        canvas.drawString(text, center_x - tw / 2, 900, heavy_big, white)

    elif overlay.kind == "storyline":
        text = overlay.data.get("text", "")
        if text:
            _draw_wrapped_centered(canvas, text, heavy_small, white, center_x, 960, max_w, 38)

    elif overlay.kind == "winner":
        team = overlay.data["team"]
        mvp = overlay.data["mvp"]
        _draw_confetti(canvas, settings, team)
        t1 = f"{team.upper()} WINS"
        tw = heavy_big.measureText(t1)
        canvas.drawString(t1, center_x - tw / 2, 900, heavy_big, white)
        t2 = f"MVP: {mvp.upper()}"
        tw2 = heavy_mid.measureText(t2)
        canvas.drawString(t2, center_x - tw2 / 2, 970, heavy_mid, white)

    elif overlay.kind == "standings":
        standings = overlay.data.get("standings", {})
        teaser = overlay.data.get("teaser", "")
        title = "STANDINGS"
        tw = heavy_mid.measureText(title)
        canvas.drawString(title, center_x - tw / 2, 900, heavy_mid, white)
        y = 960
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
        y = (i * 53) % 700 + 100
        size = 6 + (i % 3) * 3
        canvas.drawRect(skia.Rect(x, y, x + size, y + size * 2), paint)
