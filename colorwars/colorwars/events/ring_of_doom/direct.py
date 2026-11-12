"""Ring of Doom: the edit. Turns a raw SimRecord into a Timeline -- which
sim-time to show at which video frame, when to slow down, where the camera
zooms, what text overlays when. Never re-simulates anything; only ever
samples the SimRecord that already exists.

Duration strategy: a sim run can finish anywhere from ~15s to the 66s
deadline depending on the seed. To always land the final video in the
required 61-70s window, the "normal" (non-highlight) stretch of the run
plays at a computed base speed solved so the total adds up correctly;
near-misses and the final elimination get an EXTRA slowdown layered on top
of that, so they still read as more dramatic than the rest even on a seed
whose raw sim was long.
"""

from __future__ import annotations

import math

from ...engine.config import Settings
from ...engine.records import AudioCue, OverlayCue, SimRecord, Timeline

FREEZE_SEC = 0.5
WINNER_CARD_SEC = 3.0
OUTRO_SEC = 5.0
HOOK_SEC = 1.0
STORYLINE_SEC = 2.0
NEAR_MISS_WINDOW_SEC = 1.6
NEAR_MISS_SPEED = 0.5
FINAL_SLOWMO_WINDOW_SEC = 1.8
FINAL_SLOWMO_SPEED = 0.35


def _find_last_elimination(record: SimRecord):
    elims = [e for e in record.events if e.kind == "elimination"]
    return elims[-1] if elims else None


def _find_best_near_miss(record: SimRecord):
    misses = [e for e in record.events if e.kind == "near_miss"]
    if not misses:
        return None
    return max(misses, key=lambda e: e.data.get("peak_r", 0.0))


def _two_balls_left_time(record: SimRecord) -> float | None:
    for step in record.steps:
        if sum(1 for b in step.balls if b.alive) <= 2:
            return step.t
    return None


def direct(record: SimRecord, settings: Settings, cfg: dict, episode: dict, fps: int) -> Timeline:
    sim_total = record.sim_duration_sec()
    last_elim = _find_last_elimination(record)
    near_miss = _find_best_near_miss(record)
    two_left_t = _two_balls_left_time(record)

    last_elim_t = last_elim.t if last_elim else sim_total

    # -- special (extra-slow) sim-time windows, clamped to the sim's own range --
    special: list[tuple[float, float, float, str]] = []  # (sim_start, sim_end, speed, label)
    if near_miss is not None:
        nm_t = near_miss.t
        special.append((max(0.0, nm_t - NEAR_MISS_WINDOW_SEC * 0.5), min(sim_total, nm_t + NEAR_MISS_WINDOW_SEC * 0.5),
                         NEAR_MISS_SPEED, "near_miss"))
    final_start = max(0.0, last_elim_t - FINAL_SLOWMO_WINDOW_SEC)
    special.append((final_start, last_elim_t, FINAL_SLOWMO_SPEED, "final"))
    special.sort(key=lambda s: s[0])
    # drop/merge accidental overlaps (keeps things simple and still correct)
    merged: list[tuple[float, float, float, str]] = []
    for seg in special:
        if merged and seg[0] <= merged[-1][1]:
            s0, _, spd, lab = merged[-1]
            merged[-1] = (s0, max(merged[-1][1], seg[1]), min(spd, seg[2]), lab + "+" + seg[3])
        else:
            merged.append(seg)
    special = merged

    special_sim_time = sum(e - s for s, e, _, _ in special)
    special_video_time = sum((e - s) / spd for s, e, spd, _ in special)
    normal_sim_time = max(0.0, sim_total - special_sim_time)

    fixed_sec = FREEZE_SEC + WINNER_CARD_SEC + OUTRO_SEC
    target_total = (settings.duration_min_sec + settings.duration_max_sec) / 2.0
    normal_video_budget = max(1.0, target_total - fixed_sec - special_video_time)
    base_speed = normal_sim_time / normal_video_budget if normal_video_budget > 0 else 1.0
    base_speed = max(0.05, min(4.0, base_speed))  # keep it sane even on a pathological seed

    # -- walk sim time from 0 -> sim_total, building the video frame array --
    frame_sim_time: list[float] = []
    frame_speed: list[float] = []
    frame_zoom: list[float] = []
    dt_video = 1.0 / fps

    def speed_at(sim_t: float) -> float:
        for s, e, spd, _ in special:
            if s <= sim_t <= e:
                return spd
        return base_speed

    def zoom_at(sim_t: float) -> float:
        return 1.25 if (two_left_t is not None and sim_t >= two_left_t) else 1.0

    sim_t = 0.0
    # cap the frame count generously; the loop breaks once we exhaust sim_total
    guard = 0
    while sim_t < sim_total and guard < 200_000:
        frame_sim_time.append(sim_t)
        spd = speed_at(sim_t)
        frame_speed.append(spd)
        frame_zoom.append(zoom_at(sim_t))
        sim_t += dt_video * spd
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
        frame_zoom.append(1.25)

    # -- winner card + outro: no sim playback, just held on the final instant --
    winner_frames = max(1, round(WINNER_CARD_SEC * fps))
    outro_frames = max(1, round(OUTRO_SEC * fps))
    for _ in range(winner_frames + outro_frames):
        frame_sim_time.append(sim_total)
        frame_speed.append(0.0)
        frame_zoom.append(1.0)

    total_frames = len(frame_sim_time)

    # -- trim or pad by a few frames so we land exactly inside [min,max] sec,
    #    per "direct() may trim slow motion to fit" --
    min_frames = round(settings.duration_min_sec * fps)
    max_frames = round(settings.duration_max_sec * fps)
    if total_frames > max_frames:
        # trim from the base (non-special, non-structural) stretch first: drop
        # evenly-spaced frames out of the action portion.
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
    elif total_frames < min_frames:
        pad = min_frames - total_frames
        frame_sim_time.extend([sim_total] * pad)
        frame_speed.extend([0.0] * pad)
        frame_zoom.extend([1.0] * pad)
        total_frames = len(frame_sim_time)

    # -- overlays --
    overlays: list[OverlayCue] = [
        OverlayCue(0, min(round(HOOK_SEC * fps), total_frames), "hook", {"text": "ONLY 1 SURVIVES", "chips": True}),
        OverlayCue(round(HOOK_SEC * fps), min(round((HOOK_SEC + STORYLINE_SEC) * fps), total_frames),
                   "storyline", {"text": episode.get("hook_line", "")}),
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

    cover_frame_index = freeze_frame_index  # the frozen near-the-win frame doubles as cover.png

    return Timeline(
        fps=fps,
        total_frames=total_frames,
        frame_sim_time=frame_sim_time,
        frame_speed=frame_speed,
        frame_zoom=frame_zoom,
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
