"""Great Escape: the edit. Raw sim length varies a lot by seed (observed
18-42s across a handful of seeds) since it depends on how quickly rotating
gaps happen to line up with each ball -- there's no course-length-style
knob the way Disaster Drop has, so this adapts Ring of Doom's base-speed
solve: stretch the normal action to land near the middle of 61-70s, with
an extra-slow window around the winning escape for drama.
"""

from __future__ import annotations

from ...engine.config import Settings
from ...engine.records import AudioCue, OverlayCue, SimRecord, Timeline

FREEZE_SEC = 0.5
WINNER_CARD_SEC = 3.0
OUTRO_SEC = 5.0
HOOK_SEC = 1.0
STORYLINE_SEC = 2.0
WIN_SLOWMO_WINDOW_SEC = 1.6
WIN_SLOWMO_SPEED = 0.4


def _sim_time_to_frame(frame_sim_time: list[float], t: float) -> int | None:
    for i, st in enumerate(frame_sim_time):
        if st >= t:
            return i
    return None


def direct(record: SimRecord, settings: Settings, cfg: dict, episode: dict, fps: int) -> Timeline:
    sim_total = record.sim_duration_sec()
    win_event = next((e for e in record.events if e.kind == "escape" and e.data["place"] == 1), None)
    win_t = win_event.t if win_event else sim_total

    # slow-mo amounts live in config (cfg["replay"]) rather than as module
    # constants, so the Studio page can expose and randomize them per run.
    rcfg = cfg.get("replay", {})
    win_slowmo_window = float(rcfg.get("win_slowmo_window_sec", WIN_SLOWMO_WINDOW_SEC))
    win_slowmo_speed = float(rcfg.get("win_slowmo_speed", WIN_SLOWMO_SPEED))

    special_start = max(0.0, win_t - win_slowmo_window)
    special_end = min(sim_total, win_t + 0.2)
    special_sim_time = special_end - special_start
    special_video_time = special_sim_time / win_slowmo_speed
    normal_sim_time = max(0.0, sim_total - special_sim_time)

    fixed_sec = FREEZE_SEC + WINNER_CARD_SEC + OUTRO_SEC
    target_total = (settings.duration_min_sec + settings.duration_max_sec) / 2.0
    normal_video_budget = max(1.0, target_total - fixed_sec - special_video_time)
    base_speed = normal_sim_time / normal_video_budget if normal_video_budget > 0 else 1.0
    base_speed = max(0.05, min(4.0, base_speed))

    dt_video = 1.0 / fps

    def speed_at(sim_t: float) -> float:
        return win_slowmo_speed if special_start <= sim_t <= special_end else base_speed

    frame_sim_time: list[float] = []
    frame_speed: list[float] = []
    sim_t = 0.0
    guard = 0
    while sim_t < sim_total and guard < 200_000:
        frame_sim_time.append(sim_t)
        spd = speed_at(sim_t)
        frame_speed.append(spd)
        sim_t += dt_video * spd
        guard += 1
    if not frame_sim_time:
        frame_sim_time = [0.0]
        frame_speed = [1.0]
    action_frames = len(frame_sim_time)

    freeze_frames = max(1, round(FREEZE_SEC * fps))
    freeze_frame_index = action_frames
    for _ in range(freeze_frames):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)

    winner_frames = max(1, round(WINNER_CARD_SEC * fps))
    outro_frames = max(1, round(OUTRO_SEC * fps))
    for _ in range(winner_frames + outro_frames):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)

    total_frames = len(frame_sim_time)
    frame_zoom = [1.0] * total_frames
    cx = float(cfg["arena"]["center"][0])
    cy = float(cfg["arena"]["center"][1])
    frame_camera_x = [cx] * total_frames
    frame_camera_y = [cy] * total_frames

    min_frames = round(settings.duration_min_sec * fps)
    max_frames = round(settings.duration_max_sec * fps)
    if total_frames > max_frames:
        excess = total_frames - max_frames
        if excess < action_frames:
            keep = action_frames - excess
            idxs = [round(i * (action_frames - 1) / max(1, keep - 1)) for i in range(keep)] if keep > 1 else [0]
            frame_sim_time = [frame_sim_time[i] for i in idxs] + frame_sim_time[action_frames:]
            frame_speed = [frame_speed[i] for i in idxs] + frame_speed[action_frames:]
            frame_zoom = frame_zoom[: len(frame_sim_time)]
            frame_camera_x = frame_camera_x[: len(frame_sim_time)]
            frame_camera_y = frame_camera_y[: len(frame_sim_time)]
            freeze_frame_index = len(idxs)
            total_frames = len(frame_sim_time)
    elif total_frames < min_frames:
        pad = min_frames - total_frames
        frame_sim_time.extend([sim_total] * pad)
        frame_speed.extend([0.0] * pad)
        frame_zoom.extend([1.0] * pad)
        frame_camera_x.extend([cx] * pad)
        frame_camera_y.extend([cy] * pad)
        total_frames = len(frame_sim_time)

    overlays = _build_overlays(record, frame_sim_time, total_frames, episode, freeze_frame_index, fps)
    audio_cues = _build_audio_cues(record, frame_sim_time, fps, episode)

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
    overlays.append(OverlayCue(0, hook_end, "hook", {"text": "ESCAPE THE RINGS"}))
    overlays.append(OverlayCue(hook_end, min(round((HOOK_SEC + STORYLINE_SEC) * fps), total_frames),
                                "storyline", {"text": episode.get("hook_line", "")}))

    for e in record.events:
        if e.kind != "escape":
            continue
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is None:
            continue
        ball = next((b for b in record.balls if b.team_id == e.data["team_id"]), None)
        name = ball.name.upper() if ball else "?"
        place = e.data["place"]
        suffix = {1: "ST", 2: "ND", 3: "RD", 4: "TH"}.get(place, "TH")
        overlays.append(OverlayCue(frame_at, min(frame_at + round(1.2 * fps), total_frames), "toast",
                                    {"text": f"{name} ESCAPES - {place}{suffix}"}))

    winner_team = next((t for t in record.teams if t.id == record.winner_team_id), None)
    winner_name = winner_team.name if winner_team else "?"
    standings_start = freeze_frame_index + max(1, round(WINNER_CARD_SEC * fps))
    overlays.append(OverlayCue(freeze_frame_index, standings_start, "winner",
                                {"team": winner_name, "mvp": record.mvp_name}))
    overlays.append(OverlayCue(standings_start, total_frames, "standings",
                                {"standings": episode.get("standings", {}), "teaser": episode.get("teaser", "")}))
    return overlays


def _build_audio_cues(record: SimRecord, frame_sim_time: list[float], fps: int, episode: dict) -> list[AudioCue]:
    cues: list[AudioCue] = []
    theme_notes = episode.get("theme_notes") or list(range(32))
    note_i = 0

    def video_t(sim_t: float) -> float:
        f = _sim_time_to_frame(frame_sim_time, sim_t)
        return (f if f is not None else len(frame_sim_time) - 1) / fps

    for e in record.events:
        vt = video_t(e.t)
        if e.kind == "collision":
            note = theme_notes[note_i % len(theme_notes)]
            note_i += 1
            cues.append(AudioCue(vt, "theme_note", {"note": note, "x": e.data.get("x", 540.0)}))
        elif e.kind == "ring_shatter":
            cues.append(AudioCue(vt, "glass_burst", {}))
        elif e.kind == "escape":
            cues.append(AudioCue(vt, "whoosh_out", {}))
            if e.data["place"] == 1:
                cues.append(AudioCue(vt + 0.3, "win_sting", {}))

    return sorted(cues, key=lambda c: c.video_time)
