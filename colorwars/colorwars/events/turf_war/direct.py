"""Turf War: the edit. Sim length is either the fixed 58s deadline or an
earlier last-team-standing stop, never seed-stretched, so video time
samples sim time 1:1 like Shell Shuffle and Disaster Drop. direct() builds
the overlay/audio timeline and a per-frame reconstruction of the grid
(from the sparse cell_converted event log) that draw.py needs for the
live cell-count bar and the territory map itself.
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


def direct(record: SimRecord, settings: Settings, cfg: dict, episode: dict, fps: int) -> Timeline:
    sim_total = record.sim_duration_sec()
    dt_video = 1.0 / fps

    frame_sim_time: list[float] = []
    t = 0.0
    while t < sim_total:
        frame_sim_time.append(t)
        t += dt_video
    if not frame_sim_time:
        frame_sim_time = [0.0]
    action_frames = len(frame_sim_time)

    playfield_cx = float(cfg["grid"]["origin"][0]) + float(cfg["grid"]["size"]) * float(cfg["grid"]["cell_px"]) / 2
    playfield_cy = float(cfg["grid"]["origin"][1]) + float(cfg["grid"]["size"]) * float(cfg["grid"]["cell_px"]) / 2

    frame_speed = [1.0] * action_frames
    frame_zoom = [1.0] * action_frames
    frame_camera_x = [playfield_cx] * action_frames
    frame_camera_y = [playfield_cy] * action_frames

    winner_frames = max(1, round(WINNER_CARD_SEC * fps))
    outro_frames = max(1, round(OUTRO_SEC * fps))
    for _ in range(winner_frames + outro_frames):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)
        frame_zoom.append(1.0)
        frame_camera_x.append(playfield_cx)
        frame_camera_y.append(playfield_cy)

    total_frames = len(frame_sim_time)
    freeze_frame_index = action_frames

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
        frame_camera_y.extend([playfield_cy] * pad)
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
    overlays.append(OverlayCue(0, hook_end, "hook", {"text": "CLAIM THE GRID"}))
    overlays.append(OverlayCue(hook_end, min(round((HOOK_SEC + STORYLINE_SEC) * fps), total_frames),
                                "storyline", {"text": episode.get("hook_line", "")}))

    for e in record.events:
        if e.kind != "elimination":
            continue
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is None:
            continue
        team_name = next((t.name for t in record.teams if t.id == e.data["team_id"]), e.data["team_id"])
        overlays.append(OverlayCue(frame_at, min(frame_at + round(1.2 * fps), total_frames), "toast",
                                    {"text": f"{team_name.upper()} ELIMINATED"}))

    for e in record.events:
        if e.kind != "powerup_pickup":
            continue
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is None:
            continue
        team_name = next((t.name for t in record.teams if t.id == e.data["team_id"]), "?")
        overlays.append(OverlayCue(frame_at, min(frame_at + round(0.9 * fps), total_frames), "toast",
                                    {"text": f"{team_name.upper()}: {e.data['type'].upper()}"}))

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
        if e.kind == "cell_converted":
            pluck_window = [x for x in pluck_window if vt - x < 0.08]
            if len(pluck_window) >= 8:
                continue
            pluck_window.append(vt)
            cues.append(AudioCue(vt, "blip", {"team_id": e.data["team_id"]}))
        elif e.kind == "powerup_spawn":
            cues.append(AudioCue(vt, "spawn", {}))
        elif e.kind == "powerup_pickup":
            cues.append(AudioCue(vt, e.data["type"], {}))
        elif e.kind == "elimination":
            cues.append(AudioCue(vt, "pop", {}))

    cues.append(AudioCue(video_t(record.sim_duration_sec()) + 0.1, "win_sting", {}))

    return sorted(cues, key=lambda c: c.video_time)
