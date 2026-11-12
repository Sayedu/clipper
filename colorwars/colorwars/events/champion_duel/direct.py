"""Champion Duel: the edit. Raw fight length varies a lot (observed 9-20s
across a handful of seeds -- these are fast, high-damage exchanges) so
this reuses Ring of Doom's adaptive base-speed solve, plus slow motion on
any hit over the big-hit threshold, plus a literal instant replay of the
finishing blow appended after the main action.

The replay works by resampling an EARLIER sim-time window again, in slow
motion, as extra frames at the END of the video -- nothing in the shared
Timeline/render contract requires frame_sim_time to be monotonic (the
renderer and the audio mixer both just sample whatever time each frame
array entry says), so "go back and show that again" is just more frames
with earlier sim times, not a special replay mechanism.
"""

from __future__ import annotations

from ...engine.config import Settings
from ...engine.records import AudioCue, OverlayCue, SimRecord, Timeline

FREEZE_SEC = 0.5
WINNER_CARD_SEC = 3.0
OUTRO_SEC = 5.0
HOOK_SEC = 1.0
STORYLINE_SEC = 2.0
BIG_HIT_WINDOW_SEC = 1.0


def _sim_time_to_frame(frame_sim_time: list[float], t: float) -> int | None:
    for i, st in enumerate(frame_sim_time):
        if st >= t:
            return i
    return None


def _finishing_hit(record: SimRecord):
    hits = [e for e in record.events if e.kind == "hit" and not e.data["blocked"]]
    for e in reversed(hits):
        if e.data["defender_hp_after"] <= 0:
            return e
    return hits[-1] if hits else None


def direct(record: SimRecord, settings: Settings, cfg: dict, episode: dict, fps: int) -> Timeline:
    sim_total = record.sim_duration_sec()
    rcfg = cfg["replay"]
    big_hit_threshold = float(rcfg["big_hit_threshold"])
    slowmo_speed = float(rcfg["slowmo_speed"])
    slowmo_window = float(rcfg["slowmo_window_sec"])
    final_replay_sec = float(rcfg["final_replay_sec"])

    big_hits = [e for e in record.events if e.kind == "hit" and not e.data["blocked"]
                and e.data["damage"] >= big_hit_threshold]
    special: list[tuple[float, float, float]] = []
    for e in big_hits:
        s0, s1 = max(0.0, e.t - slowmo_window * 0.3), min(sim_total, e.t + slowmo_window * 0.7)
        special.append((s0, s1, slowmo_speed))
    special.sort(key=lambda s: s[0])
    merged: list[tuple[float, float, float]] = []
    for seg in special:
        if merged and seg[0] <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], seg[1]), min(merged[-1][2], seg[2]))
        else:
            merged.append(seg)
    special = merged

    special_sim_time = sum(e - s for s, e, _ in special)
    special_video_time = sum((e - s) / spd for s, e, spd in special)
    normal_sim_time = max(0.0, sim_total - special_sim_time)

    fixed_sec = FREEZE_SEC + WINNER_CARD_SEC + OUTRO_SEC + final_replay_sec
    target_total = (settings.duration_min_sec + settings.duration_max_sec) / 2.0
    normal_video_budget = max(1.0, target_total - fixed_sec - special_video_time)
    base_speed = normal_sim_time / normal_video_budget if normal_video_budget > 0 else 1.0
    base_speed = max(0.05, min(4.0, base_speed))

    def speed_at(sim_t: float) -> float:
        for s, e, spd in special:
            if s <= sim_t <= e:
                return spd
        return base_speed

    dt_video = 1.0 / fps
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

    # the replay: resample the finishing blow's own window again, slowly,
    # as its own block of frames at the very end. The sim stops the instant
    # a champion's HP hits zero -- no steps exist past that -- so a window
    # centered on the hit and clamped to sim_total got cut short on the
    # right and barely reached the actual impact (confirmed directly: the
    # first version of this left the replay showing HP never quite
    # dropping to zero). Anchoring the window's END at sim_total (the
    # genuine last instant) and holding there briefly fixes that for real,
    # rather than just nudging the clamp.
    replay_start_frame = len(frame_sim_time)
    finishing = _finishing_hit(record)
    if finishing is not None:
        r1 = sim_total
        r0 = max(0.0, r1 - slowmo_window)
        approach_frames = max(1, round(final_replay_sec * 0.7 * fps))
        hold_frames = max(1, round(final_replay_sec * 0.3 * fps))
        for k in range(approach_frames):
            frame_sim_time.append(r0 + (r1 - r0) * (k / max(1, approach_frames - 1)))
            frame_speed.append(slowmo_speed)
        for _ in range(hold_frames):
            frame_sim_time.append(r1)
            frame_speed.append(0.0)

    total_frames = len(frame_sim_time)
    cx = float(cfg["arena"]["origin"][0]) + float(cfg["arena"]["size"]) / 2
    cy = float(cfg["arena"]["origin"][1]) + float(cfg["arena"]["size"]) / 2

    min_frames = round(settings.duration_min_sec * fps)
    max_frames = round(settings.duration_max_sec * fps)
    if total_frames > max_frames:
        excess = total_frames - max_frames
        if excess < action_frames:
            keep = action_frames - excess
            idxs = [round(i * (action_frames - 1) / max(1, keep - 1)) for i in range(keep)] if keep > 1 else [0]
            tail = frame_sim_time[action_frames:]
            tail_speed = frame_speed[action_frames:]
            frame_sim_time = [frame_sim_time[i] for i in idxs] + tail
            frame_speed = [frame_speed[i] for i in idxs] + tail_speed
            freeze_frame_index = len(idxs)
            replay_start_frame = replay_start_frame - (action_frames - len(idxs))
            total_frames = len(frame_sim_time)
    elif total_frames < min_frames:
        pad = min_frames - total_frames
        frame_sim_time.extend([sim_total] * pad)
        frame_speed.extend([0.0] * pad)
        total_frames = len(frame_sim_time)
    frame_zoom = [1.0] * total_frames
    frame_camera_x = [cx] * total_frames
    frame_camera_y = [cy] * total_frames

    overlays = _build_overlays(record, frame_sim_time, total_frames, episode, freeze_frame_index,
                                replay_start_frame, fps)
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
                     freeze_frame_index: int, replay_start_frame: int, fps: int) -> list[OverlayCue]:
    overlays: list[OverlayCue] = []
    hook_end = min(round(HOOK_SEC * fps), total_frames)
    overlays.append(OverlayCue(0, hook_end, "hook", {"text": "CHAMPION DUEL"}))
    overlays.append(OverlayCue(hook_end, min(round((HOOK_SEC + STORYLINE_SEC) * fps), total_frames),
                                "storyline", {"text": episode.get("hook_line", "")}))

    winner_team = next((t for t in record.teams if t.id == record.winner_team_id), None)
    winner_name = winner_team.name if winner_team else "?"
    standings_start = freeze_frame_index + max(1, round(WINNER_CARD_SEC * fps))
    overlays.append(OverlayCue(freeze_frame_index, standings_start, "winner",
                                {"team": winner_name, "mvp": record.mvp_name}))
    # standings ends where the replay begins -- otherwise both cards would
    # be "active" on the same final frames, the same overlap bug found and
    # fixed in several earlier events.
    standings_end = replay_start_frame if replay_start_frame > standings_start else total_frames
    overlays.append(OverlayCue(standings_start, standings_end, "standings",
                                {"standings": episode.get("standings", {}), "teaser": episode.get("teaser", "")}))
    if replay_start_frame < total_frames:
        overlays.append(OverlayCue(replay_start_frame, total_frames, "replay", {}))
    return overlays


def _build_audio_cues(record: SimRecord, frame_sim_time: list[float], fps: int) -> list[AudioCue]:
    cues: list[AudioCue] = []

    def video_t(sim_t: float) -> float:
        f = _sim_time_to_frame(frame_sim_time, sim_t)
        return (f if f is not None else len(frame_sim_time) - 1) / fps

    for e in record.events:
        if e.kind != "hit":
            continue
        vt = video_t(e.t)
        if e.data["blocked"]:
            cues.append(AudioCue(vt, "block", {}))
        elif e.data["damage"] >= 8.0:
            cues.append(AudioCue(vt, "big_hit", {}))
        else:
            cues.append(AudioCue(vt, "hit", {"kind": e.data["kind"]}))

    finishing = _finishing_hit(record)
    if finishing is not None:
        cues.append(AudioCue(video_t(finishing.t) + 0.2, "win_sting", {}))

    return sorted(cues, key=lambda c: c.video_time)
