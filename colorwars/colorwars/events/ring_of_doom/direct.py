"""Ring of Doom: the edit. Turns a raw SimRecord into a Timeline -- which
sim-time to show at which video frame, where the camera zooms, what text
overlays when. Never re-simulates anything; only ever samples the SimRecord
that already exists.

Duration strategy: no slow motion anywhere, and no minimum length either,
both by request. The action always plays at real speed (never slower, never
sped up either -- there's nothing left to fit a speed multiplier to). The
video ends ~1.5s after the winner card appears instead of being padded out
(the old approach: replaying the action again under the winner card) to
reach a 61s floor -- a short raw sim now just makes a short video, which is
fine. The raw sim is capped at a 66s deadline (config timing.sim_deadline_sec),
so even the longest run plus this short tail still lands comfortably under
the 70s video ceiling with no fitting required.
"""

from __future__ import annotations

import math

from ...engine.config import Settings
from ...engine.records import AudioCue, OverlayCue, SimRecord, Timeline

FREEZE_SEC = 0.3
WINNER_CARD_SEC = 1.0
OUTRO_SEC = 0.2


def _find_last_elimination(record: SimRecord):
    elims = [e for e in record.events if e.kind == "elimination"]
    return elims[-1] if elims else None


def _best_near_miss_time_in_final_two(record: SimRecord) -> float | None:
    misses = [e for e in record.events if e.kind == "near_miss"]
    if not misses:
        return None
    # "in the final two": only misses that happened once <=2 balls were alive
    final_two_misses = []
    for e in misses:
        step_idx = min(len(record.steps) - 1, round(e.t * record.physics_hz))
        alive = sum(1 for b in record.steps[step_idx].balls if b.alive)
        if alive <= 2:
            final_two_misses.append(e)
    pool = final_two_misses or misses
    return max(pool, key=lambda e: e.data.get("peak_r", 0.0)).t


def direct(record: SimRecord, settings: Settings, cfg: dict, episode: dict, fps: int) -> Timeline:
    sim_total = record.sim_duration_sec()

    # real time, always -- no duration target to fit anymore, so no speed
    # multiplier is needed (see module docstring).
    base_speed = 1.0

    # -- walk sim time from 0 -> sim_total, building the video frame array --
    # the ring stays a constant size the whole video now (reported directly:
    # the zoom-in during the final two balls made it look like the circle
    # was changing size) -- frame_zoom is always 1.0, kept as a real field
    # (not removed from Timeline) only because other events still use it.
    frame_sim_time: list[float] = []
    frame_speed: list[float] = []
    frame_zoom: list[float] = []
    dt_video = 1.0 / fps

    sim_t = 0.0
    # cap the frame count generously; the loop breaks once we exhaust sim_total
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

    # -- freeze: hold the final sim instant for FREEZE_SEC of video time --
    freeze_frame_count = max(1, round(FREEZE_SEC * fps))
    freeze_frame_index = action_frames
    for _ in range(freeze_frame_count):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)
        frame_zoom.append(1.0)

    # -- winner card + outro: no sim playback, just held on the final instant --
    winner_frames = max(1, round(WINNER_CARD_SEC * fps))
    outro_frames = max(1, round(OUTRO_SEC * fps))
    for _ in range(winner_frames + outro_frames):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)
        frame_zoom.append(1.0)

    total_frames = len(frame_sim_time)

    # -- safety trim only -- there's no minimum to pad up to anymore (by
    #    request: the video should end ~1-1.5s after the winner card, not
    #    wait out a 61s floor). A sim that ran right up against its own
    #    deadline could in principle still land past video_max_sec once the
    #    short tail above is added, so this trims evenly-spaced frames out
    #    of the action portion if so; in practice this almost never fires.
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

    # -- overlays --
    # the "comment which color wins" prompt now stays up for the whole
    # action, not just the first second -- by request, it's the one thing
    # that should be on screen the entire time until the winner is shown.
    # It replaces the old hook(1s)->storyline(2s)->nothing sequence, which
    # would otherwise compete with it for the same screen region.
    overlays: list[OverlayCue] = [
        OverlayCue(0, freeze_frame_index, "hook", {"text": "COMMENT WHICH COLOR WINS"}),
    ]
    for e in record.events:
        if e.kind != "elimination":
            continue
        ball = record.balls[e.data["ball_id"]]
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is not None:
            overlays.append(OverlayCue(frame_at, min(frame_at + round(1.2 * fps), total_frames),
                                        "toast", {"text": f"{ball.name.upper()} IS OUT"}))

    winner_team = next((t for t in record.teams if t.id == record.winner_team_id), None)
    winner_name = winner_team.name if winner_team else "?"
    standings_start = freeze_frame_index + freeze_frame_count + winner_frames
    overlays.append(OverlayCue(freeze_frame_index, standings_start, "winner",
                                {"team": winner_name, "mvp": record.mvp_name}))
    overlays.append(OverlayCue(standings_start, total_frames, "standings",
                                {"standings": episode.get("standings", {}), "teaser": episode.get("teaser", "")}))

    # -- audio cues: collisions (rate-limited), eliminations, warnings, hazards,
    #    plus the directorial drone/heartbeat/sting in the final stretch --
    audio_cues = _build_audio_cues(record, frame_sim_time, fps, freeze_frame_index, total_frames)

    # cover.png: the closest near miss in the final two reads better than a
    # plain freeze frame -- this used to live in the shared pipeline as a
    # special case keyed off event_id; moved here since "what's my best
    # cover frame" is squarely this event's own call, same as Shell
    # Shuffle picking its own 1st-place reveal moment.
    cover_sim_t = _best_near_miss_time_in_final_two(record)
    cover_frame_index = freeze_frame_index
    if cover_sim_t is not None:
        frame_at = _sim_time_to_frame(frame_sim_time, cover_sim_t)
        if frame_at is not None:
            cover_frame_index = frame_at

    # the ring never moves, so the camera (what frame_zoom zooms around)
    # just sits on its fixed center the whole video -- disaster_drop is the
    # first event that needs this to actually move. Read from cfg rather
    # than hardcoded (a stale hardcoded ring center was a real bug class in
    # this project before -- see CLAUDE.md's draw_frame/event_cfg decision).
    cam_x, cam_y = float(cfg["ring"]["center"][0]), float(cfg["ring"]["center"][1])

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
    # frame_sim_time is monotonically non-decreasing -- binary search would be
    # nicer, but these lists are a few thousand long at most; linear is fine.
    for i, st in enumerate(frame_sim_time):
        if st >= t:
            return i
    return None


def _build_audio_cues(record: SimRecord, frame_sim_time: list[float], fps: int,
                       freeze_frame_index: int, total_frames: int) -> list[AudioCue]:
    cues: list[AudioCue] = []
    last_pluck_video_t = -1.0
    pluck_count_in_window: list[float] = []

    for e in record.events:
        frame_at = _sim_time_to_frame(frame_sim_time, e.t)
        if frame_at is None:
            continue
        video_t = frame_at / fps

        if e.kind == "collision":
            pluck_count_in_window = [t for t in pluck_count_in_window if video_t - t < 0.1]
            if len(pluck_count_in_window) >= 12:
                continue
            pluck_count_in_window.append(video_t)
            cues.append(AudioCue(video_t, "pluck", {
                "impulse": e.data.get("impulse", 0.0),
                "x": e.data.get("x", 540.0),
                "progress": e.t / max(1.0, record.sim_duration_sec()),
            }))
        elif e.kind == "elimination":
            cues.append(AudioCue(video_t, "pop", {}))
            cues.append(AudioCue(video_t + 0.05, "whoosh", {}))
        elif e.kind == "warning":
            cues.append(AudioCue(video_t, "tick", {}))
            cues.append(AudioCue(video_t + 0.15, "tick", {}))
        elif e.kind == "hazard":
            cues.append(AudioCue(video_t, "crackle" if e.data.get("kind") == "lightning" else "thud", {}))

    freeze_video_t = freeze_frame_index / fps
    drone_start = max(0.0, freeze_video_t - 15.0)
    cues.append(AudioCue(drone_start, "drone_start", {"duration": freeze_video_t - drone_start}))
    heartbeat_start = max(drone_start, freeze_video_t - 6.0)
    cues.append(AudioCue(heartbeat_start, "heartbeat", {"duration": freeze_video_t - heartbeat_start}))
    cues.append(AudioCue(freeze_video_t, "bass_drop", {}))
    cues.append(AudioCue(freeze_video_t + FREEZE_SEC, "win_sting", {}))

    return sorted(cues, key=lambda c: c.video_time)
