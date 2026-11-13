"""Hot Potato: the edit. Real time only, no slow motion, no padding to a
duration floor -- same philosophy Ring of Doom settled on this session
(see its own direct.py docstring for the reasoning). The video ends
~1.5s after the winner card, whatever the raw sim length turned out to be.

Nothing here re-simulates anything; the bomb-holder/round-timer state
shown on screen is reconstructed purely from the "bomb_round_start" /
"bomb_pass" SimEvents sim.py already logs, the same "derive renderer
state from the event log instead of widening the shared StepRecord"
pattern Disaster Drop and Ring of Doom's hazards use.
"""

from __future__ import annotations

from ...engine.config import Settings
from ...engine.records import AudioCue, OverlayCue, SimRecord, Timeline

FREEZE_SEC = 0.3
WINNER_CARD_SEC = 1.0
OUTRO_SEC = 0.2

# a little slapstick variety on who just got caught holding it -- picked
# deterministically from the elimination's own ball id, never live RNG.
ELIMINATION_LINES = [
    "BOOM! {name} IS OUT",
    "{name} COULDN'T PASS IT IN TIME",
    "{name} GOT CAUGHT HOLDING IT",
    "NOT LIKE THIS, {name}",
]

# tick cues fire at these many seconds before a round's own deadline,
# speeding up as zero approaches -- any offset bigger than that round's
# own duration is simply skipped (a 2s round has no room for a "3s left"
# tick).
TICK_OFFSETS_SEC = [3.0, 2.0, 1.3, 0.8, 0.45, 0.2]


def direct(record: SimRecord, settings: Settings, cfg: dict, episode: dict, fps: int) -> Timeline:
    sim_total = record.sim_duration_sec()
    base_speed = 1.0

    frame_sim_time: list[float] = []
    frame_speed: list[float] = []
    frame_zoom: list[float] = []
    dt_video = 1.0 / fps

    sim_t = 0.0
    guard = 0
    while sim_t < sim_total and guard < 200_000:
        frame_sim_time.append(sim_t)
        frame_speed.append(base_speed)
        frame_zoom.append(1.0)
        sim_t += dt_video * base_speed
        guard += 1
    if not frame_sim_time:
        frame_sim_time = [0.0]
        frame_speed = [1.0]
        frame_zoom = [1.0]

    action_frames = len(frame_sim_time)

    freeze_frame_count = max(1, round(FREEZE_SEC * fps))
    freeze_frame_index = action_frames
    for _ in range(freeze_frame_count):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)
        frame_zoom.append(1.0)

    winner_frames = max(1, round(WINNER_CARD_SEC * fps))
    outro_frames = max(1, round(OUTRO_SEC * fps))
    for _ in range(winner_frames + outro_frames):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)
        frame_zoom.append(1.0)

    total_frames = len(frame_sim_time)

    # safety trim only -- there's no minimum to pad up to, same reasoning
    # as Ring of Doom's own direct.py.
    max_frames = round(settings.duration_max_sec * fps)
    if total_frames > max_frames:
        excess = total_frames - max_frames
        if excess < action_frames:
            keep = action_frames - excess
            idxs = [round(i * (action_frames - 1) / max(1, keep - 1)) for i in range(keep)] if keep > 1 else [0]
            trimmed_time = [frame_sim_time[i] for i in idxs]
            trimmed_speed = [frame_speed[i] for i in idxs]
            trimmed_zoom = [frame_zoom[i] for i in idxs]
            frame_sim_time = trimmed_time + frame_sim_time[action_frames:]
            frame_speed = trimmed_speed + frame_speed[action_frames:]
            frame_zoom = trimmed_zoom + frame_zoom[action_frames:]
            freeze_frame_index = len(trimmed_time)
            total_frames = len(frame_sim_time)

    overlays: list[OverlayCue] = [
        OverlayCue(0, freeze_frame_index, "hook", {"text": "COMMENT WHICH COLOR WINS"}),
    ]
    for e in record.events:
        if e.kind != "elimination":
            continue
        ball = record.balls[e.data["ball_id"]]
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is None:
            continue
        line_idx = e.data["ball_id"] % len(ELIMINATION_LINES)
        text = ELIMINATION_LINES[line_idx].format(name=ball.name.upper())
        overlays.append(OverlayCue(frame_at, min(frame_at + round(1.2 * fps), total_frames), "toast", {"text": text}))

    winner_team = next((t for t in record.teams if t.id == record.winner_team_id), None)
    winner_name = winner_team.name if winner_team else "?"
    standings_start = freeze_frame_index + freeze_frame_count + winner_frames
    overlays.append(OverlayCue(freeze_frame_index, standings_start, "winner",
                                {"team": winner_name, "mvp": record.mvp_name}))
    overlays.append(OverlayCue(standings_start, total_frames, "standings", {}))

    audio_cues = _build_audio_cues(record, frame_sim_time, fps, freeze_frame_index, total_frames)

    # cover.png: the last bomb pass before the final elimination -- "it was
    # JUST handed off" reads better than a plain freeze frame.
    cover_frame_index = freeze_frame_index
    last_elim = next((e for e in reversed(record.events) if e.kind == "elimination"), None)
    if last_elim is not None:
        passes_before = [e for e in record.events if e.kind == "bomb_pass" and e.t < last_elim.t]
        if passes_before:
            frame_at = _sim_time_to_frame(frame_sim_time, passes_before[-1].t)
            if frame_at is not None:
                cover_frame_index = frame_at

    arena_cfg = cfg["arena"]
    cam_x, cam_y = float(arena_cfg["center"][0]), float(arena_cfg["center"][1])

    return Timeline(
        fps=fps,
        total_frames=total_frames,
        frame_sim_time=frame_sim_time,
        frame_speed=frame_speed,
        frame_zoom=frame_zoom,
        frame_camera_x=[cam_x] * total_frames,
        frame_camera_y=[cam_y] * total_frames,
        overlays=overlays,
        audio_cues=audio_cues,
        cover_frame_index=cover_frame_index,
        freeze_frame_index=freeze_frame_index,
    )


def _sim_time_to_frame(frame_sim_time: list[float], t: float) -> int | None:
    for i, st in enumerate(frame_sim_time):
        if st >= t:
            return i
    return None


def _build_audio_cues(record: SimRecord, frame_sim_time: list[float], fps: int,
                       freeze_frame_index: int, total_frames: int) -> list[AudioCue]:
    cues: list[AudioCue] = []
    last_pluck_video_t = -1.0
    MIN_PLUCK_GAP_SEC = 0.045

    # round deadlines, to generate accelerating tick cues from in a second pass
    round_starts: list[tuple[float, float]] = []  # (round_start_video_t, deadline_video_t)

    for e in record.events:
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is None:
            continue
        video_t = frame_at / fps

        if e.kind == "collision":
            if video_t - last_pluck_video_t < MIN_PLUCK_GAP_SEC:
                continue
            last_pluck_video_t = video_t
            cues.append(AudioCue(video_t, "pluck", {"impulse": e.data.get("impulse", 0.0), "x": e.data.get("x", 540.0)}))
        elif e.kind == "bomb_pass":
            cues.append(AudioCue(video_t, "pass", {}))
        elif e.kind == "elimination":
            cues.append(AudioCue(video_t, "boom", {}))
        elif e.kind == "bomb_round_start":
            deadline_frame = _sim_time_to_frame(frame_sim_time, e.data["round_deadline"])
            deadline_video_t = deadline_frame / fps if deadline_frame is not None else None
            if deadline_video_t is not None:
                round_starts.append((video_t, deadline_video_t))

    for start_t, deadline_t in round_starts:
        duration = deadline_t - start_t
        for offset in TICK_OFFSETS_SEC:
            if offset > duration:
                continue
            cues.append(AudioCue(deadline_t - offset, "tick", {}))

    freeze_video_t = freeze_frame_index / fps
    cues.append(AudioCue(freeze_video_t + FREEZE_SEC, "win_sting", {}))

    return sorted(cues, key=lambda c: c.video_time)
