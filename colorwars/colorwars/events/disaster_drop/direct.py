"""Disaster Drop: the edit. Like Shell Shuffle (and unlike Ring of Doom),
this event's course length -- not a speed-stretch -- is the duration knob
(see course.py), so video time samples sim time 1:1. What direct() DOES
own uniquely here is the camera: a smoothed vertical (and horizontal)
follow on the leading ball, zooming out as the pack spreads so the
trailing ball stays in frame.
"""

from __future__ import annotations

from ...engine.config import Settings
from ...engine.records import AudioCue, OverlayCue, SimRecord, Timeline

WINNER_CARD_SEC = 3.0
OUTRO_SEC = 5.0
HOOK_SEC = 1.0
STORYLINE_SEC = 2.0


def _sim_time_to_frame(frame_sim_time: list[float], t: float) -> int | None:
    for i, st in enumerate(frame_sim_time):
        if st >= t:
            return i
    return None


def _step_at(record: SimRecord, sim_t: float):
    idx = round(sim_t * record.physics_hz)
    return record.steps[max(0, min(len(record.steps) - 1, idx))]


def _finish_y(record: SimRecord) -> float:
    return max((s.y for step in record.steps for s in step.balls), default=1000.0)


def direct(record: SimRecord, settings: Settings, cfg: dict, episode: dict, fps: int) -> Timeline:
    sim_total = record.sim_duration_sec()
    dt_video = 1.0 / fps
    finish_y = _finish_y(record)
    cam_cfg = cfg["camera"]
    smoothing = float(cam_cfg["smoothing_per_sec"])
    zoom_min = float(cam_cfg["zoom_min"])
    spread_start = float(cam_cfg["spread_zoom_start_px"])
    spread_full = float(cam_cfg["spread_zoom_full_px"])
    playfield_cx = (float(cfg["playfield"]["x_min"]) + float(cfg["playfield"]["x_max"])) / 2

    frame_sim_time: list[float] = []
    t = 0.0
    while t < sim_total:
        frame_sim_time.append(t)
        t += dt_video
    if not frame_sim_time:
        frame_sim_time = [0.0]
    action_frames = len(frame_sim_time)

    # -- camera: exponential smoothing toward the leading (still-racing) ball --
    frame_camera_x: list[float] = []
    frame_camera_y: list[float] = []
    frame_zoom: list[float] = []
    cam_x, cam_y, zoom = playfield_cx, 0.0, 1.0
    for sim_t in frame_sim_time:
        step = _step_at(record, sim_t)
        racing = [(b.x, min(b.y, finish_y)) for b, info in zip(step.balls, record.balls) if b.alive]
        if racing:
            leader_x, leader_y = max(racing, key=lambda p: p[1])
            last_y = min(p[1] for p in racing)
        else:
            leader_x, leader_y, last_y = cam_x, finish_y, finish_y
        spread = max(0.0, leader_y - last_y)
        if spread <= spread_start:
            target_zoom = 1.0
        elif spread >= spread_full:
            target_zoom = zoom_min
        else:
            frac = (spread - spread_start) / (spread_full - spread_start)
            target_zoom = 1.0 + (zoom_min - 1.0) * frac

        k = min(1.0, smoothing * dt_video)
        cam_x += (leader_x - cam_x) * k
        cam_y += (leader_y - cam_y) * k
        zoom += (target_zoom - zoom) * k

        frame_camera_x.append(cam_x)
        frame_camera_y.append(cam_y)
        frame_zoom.append(zoom)

    frame_speed = [1.0] * action_frames

    # -- freeze on the finish, then winner card + standings outro --
    winner_frames = max(1, round(WINNER_CARD_SEC * fps))
    outro_frames = max(1, round(OUTRO_SEC * fps))
    final_cam_x = frame_camera_x[-1] if frame_camera_x else playfield_cx
    final_cam_y = frame_camera_y[-1] if frame_camera_y else finish_y
    for _ in range(winner_frames + outro_frames):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)
        frame_zoom.append(1.0)
        frame_camera_x.append(playfield_cx)
        frame_camera_y.append(final_cam_y)

    total_frames = len(frame_sim_time)
    freeze_frame_index = action_frames

    # -- safety net: force the final length into [min,max], same spirit as
    #    the other two events (course length is tuned to usually land here
    #    already, but this isn't just assumed) --
    min_frames = round(settings.duration_min_sec * fps)
    max_frames = round(settings.duration_max_sec * fps)
    if total_frames > max_frames:
        excess = total_frames - max_frames
        if excess < action_frames:
            keep = action_frames - excess
            idxs = [round(i * (action_frames - 1) / max(1, keep - 1)) for i in range(keep)] if keep > 1 else [0]
            frame_sim_time = [frame_sim_time[i] for i in idxs] + frame_sim_time[action_frames:]
            frame_speed = [frame_speed[i] for i in idxs] + frame_speed[action_frames:]
            frame_zoom = [frame_zoom[i] for i in idxs] + frame_zoom[action_frames:]
            frame_camera_x = [frame_camera_x[i] for i in idxs] + frame_camera_x[action_frames:]
            frame_camera_y = [frame_camera_y[i] for i in idxs] + frame_camera_y[action_frames:]
            freeze_frame_index = keep
            total_frames = len(frame_sim_time)
    elif total_frames < min_frames:
        pad = min_frames - total_frames
        frame_sim_time.extend([sim_total] * pad)
        frame_speed.extend([0.0] * pad)
        frame_zoom.extend([1.0] * pad)
        frame_camera_x.extend([playfield_cx] * pad)
        frame_camera_y.extend([final_cam_y] * pad)
        total_frames = len(frame_sim_time)

    overlays = _build_overlays(record, frame_sim_time, total_frames, episode, freeze_frame_index, fps)
    audio_cues = _build_audio_cues(record, frame_sim_time, fps)

    return Timeline(
        fps=fps,
        total_frames=total_frames,
        frame_sim_time=frame_sim_time,
        frame_speed=frame_speed,
        frame_zoom=frame_zoom,
        frame_camera_x=frame_camera_x,
        frame_camera_y=frame_camera_y,
        overlays=overlays,
        audio_cues=audio_cues,
        cover_frame_index=freeze_frame_index,
        freeze_frame_index=freeze_frame_index,
    )


def _build_overlays(record: SimRecord, frame_sim_time: list[float], total_frames: int, episode: dict,
                     freeze_frame_index: int, fps: int) -> list[OverlayCue]:
    overlays: list[OverlayCue] = []
    hook_end = min(round(HOOK_SEC * fps), total_frames)
    overlays.append(OverlayCue(0, hook_end, "hook", {"text": "12 BALLS DROP"}))
    overlays.append(OverlayCue(hook_end, min(round((HOOK_SEC + STORYLINE_SEC) * fps), total_frames),
                                "storyline", {"text": episode.get("hook_line", "")}))

    for e in record.events:
        if e.kind != "warning" or e.data.get("about") != "disaster":
            continue
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is None:
            continue
        team = e.data.get("team")
        text = f"{e.data['type'].upper().replace('_', ' ')}" + (f": {team.upper()}" if team else "")
        overlays.append(OverlayCue(frame_at, min(frame_at + round(1.0 * fps), total_frames), "disaster_card", {"text": text}))

    seen_teams: set[str] = set()
    for e in record.events:
        if e.kind != "finish" or e.data["team_id"] in seen_teams:
            continue
        seen_teams.add(e.data["team_id"])
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is None:
            continue
        ball = next((b for b in record.balls if b.team_id == e.data["team_id"]), None)
        name = ball.name.upper() if ball else "?"
        overlays.append(OverlayCue(frame_at, min(frame_at + round(1.2 * fps), total_frames),
                                    "toast", {"text": f"{name} FINISHES!"}))

    winner_team = next((t for t in record.teams if t.id == record.winner_team_id), None)
    winner_name = winner_team.name if winner_team else "?"
    standings_start = freeze_frame_index + max(1, round(WINNER_CARD_SEC * fps))
    overlays.append(OverlayCue(freeze_frame_index, standings_start, "winner",
                                {"team": winner_name, "mvp": record.mvp_name}))
    overlays.append(OverlayCue(standings_start, total_frames, "standings",
                                {"standings": episode.get("standings", {}), "teaser": episode.get("teaser", "")}))
    return overlays


def _build_audio_cues(record: SimRecord, frame_sim_time: list[float], fps: int) -> list[AudioCue]:
    cues: list[AudioCue] = []

    def video_t(sim_t: float) -> float:
        f = _sim_time_to_frame(frame_sim_time, sim_t)
        return (f if f is not None else len(frame_sim_time) - 1) / fps

    pluck_window: list[float] = []
    for e in record.events:
        vt = video_t(e.t)
        if e.kind == "collision":
            pluck_window = [x for x in pluck_window if vt - x < 0.1]
            if len(pluck_window) >= 10:
                continue
            pluck_window.append(vt)
            cues.append(AudioCue(vt, "pluck", {"impulse": e.data.get("impulse", 0.0), "x": e.data.get("x", 540.0)}))
        elif e.kind == "warning" and e.data.get("about") == "disaster":
            cues.append(AudioCue(vt, "tick", {}))
            cues.append(AudioCue(vt + 0.15, "tick", {}))
        elif e.kind == "disaster":
            cues.append(AudioCue(vt, e.data["type"], {}))
        elif e.kind == "elimination":
            cues.append(AudioCue(vt, "crunch", {}))
        elif e.kind == "finish":
            cues.append(AudioCue(vt, "finish_blip", {}))

    winner_finish = next((e for e in record.events if e.kind == "finish" and e.data["team_id"] == record.winner_team_id), None)
    if winner_finish is not None:
        cues.append(AudioCue(video_t(winner_finish.t) + 0.3, "win_sting", {}))

    return sorted(cues, key=lambda c: c.video_time)
