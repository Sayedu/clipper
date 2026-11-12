"""Shell Shuffle: the edit. Unlike Ring of Doom, this event's total sim
length is a pure function of config (every move has a fixed, seed-
independent duration -- only WHICH pair swaps or WHICH trick plays is
seeded), so there is no slow motion or adaptive base-speed to solve for:
video time samples sim time 1:1. direct() just builds the overlay and
audio cue timeline from the event log sim.py already wrote.
"""

from __future__ import annotations

from ...engine.config import Settings
from ...engine.records import AudioCue, OverlayCue, SimRecord, Timeline

RANK_LABELS = ["1ST", "2ND", "3RD", "4TH"]


def _event_t(record: SimRecord, kind: str, **data_match) -> float | None:
    for e in record.events:
        if e.kind != kind:
            continue
        if all(e.data.get(k) == v for k, v in data_match.items()):
            return e.t
    return None


def _frame_at(frame_sim_time: list[float], t: float) -> int:
    for i, st in enumerate(frame_sim_time):
        if st >= t:
            return i
    return len(frame_sim_time) - 1


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
    total_frames = len(frame_sim_time)

    # safety net, mirroring Ring of Doom's -- the config's own timing is
    # tuned to already land in [min,max], but this isn't just assumed.
    min_frames = round(settings.duration_min_sec * fps)
    max_frames = round(settings.duration_max_sec * fps)
    if total_frames > max_frames:
        keep = max_frames
        idxs = [round(i * (total_frames - 1) / max(1, keep - 1)) for i in range(keep)] if keep > 1 else [0]
        frame_sim_time = [frame_sim_time[i] for i in idxs]
        total_frames = len(frame_sim_time)
    elif total_frames < min_frames:
        pad = min_frames - total_frames
        frame_sim_time.extend([sim_total] * pad)
        total_frames = len(frame_sim_time)

    frame_speed = [1.0] * total_frames
    frame_zoom = [1.0] * total_frames
    frame_camera_x = [540.0] * total_frames
    frame_camera_y = [960.0] * total_frames

    overlays = _build_overlays(record, frame_sim_time, total_frames, episode)
    audio_cues = _build_audio_cues(record, frame_sim_time, fps)

    win_t = _event_t(record, "win") or sim_total
    freeze_t = _event_t(record, "freeze_end") or sim_total
    cover_frame_index = _frame_at(frame_sim_time, win_t)
    freeze_frame_index = _frame_at(frame_sim_time, freeze_t)

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
        cover_frame_index=cover_frame_index,
        freeze_frame_index=freeze_frame_index,
    )


def _build_overlays(record: SimRecord, frame_sim_time: list[float], total_frames: int, episode: dict) -> list[OverlayCue]:
    overlays: list[OverlayCue] = []

    reveal_shown_t = _event_t(record, "reveal_shown") or 0.0
    overlays.append(OverlayCue(0, _frame_at(frame_sim_time, reveal_shown_t), "hook", {"text": "FIND YOUR BALL"}))

    storyline_start_t = reveal_shown_t
    storyline_end_t = reveal_shown_t + 2.0
    overlays.append(OverlayCue(
        _frame_at(frame_sim_time, storyline_start_t),
        _frame_at(frame_sim_time, storyline_end_t),
        "storyline", {"text": episode.get("hook_line", "")},
    ))

    for which in (1, 2):
        start_t = _event_t(record, "got_it", which=which)
        end_t = _event_t(record, "got_it_closed", which=which)
        if start_t is not None and end_t is not None:
            overlays.append(OverlayCue(_frame_at(frame_sim_time, start_t), _frame_at(frame_sim_time, end_t),
                                        "got_it", {}))

    podium_t = _event_t(record, "podium_arrive")
    if podium_t is not None:
        overlays.append(OverlayCue(_frame_at(frame_sim_time, podium_t), total_frames, "podium_labels", {}))

    freeze_end_t = _event_t(record, "freeze_end")
    if freeze_end_t is not None:
        overlays.append(OverlayCue(_frame_at(frame_sim_time, podium_t or 0.0), _frame_at(frame_sim_time, freeze_end_t),
                                    "freeze_prompt", {}))

    pop_events = [e for e in record.events if e.kind == "reveal_pop"]
    win_t = _event_t(record, "win")
    win_f = _frame_at(frame_sim_time, win_t) if win_t is not None else total_frames
    for idx, e in enumerate(pop_events):
        start_f = _frame_at(frame_sim_time, e.t)
        # the 1st-place reveal card ends where the "win" card takes over --
        # otherwise both show at once, same overlap bug as win/standings above.
        end_f = _frame_at(frame_sim_time, pop_events[idx + 1].t) if idx + 1 < len(pop_events) else win_f
        team = next((t for t in record.teams if t.id == e.data["team_id"]), None)
        overlays.append(OverlayCue(start_f, end_f, "reveal", {
            "rank": RANK_LABELS[e.data["placement_index"]],
            "team": team.name if team else e.data["team_id"],
        }))

    outro_start_t = _event_t(record, "outro_start")
    outro_start_f = _frame_at(frame_sim_time, outro_start_t) if outro_start_t is not None else total_frames

    if win_t is not None:
        # end exactly where standings starts -- otherwise both cards are
        # "active" on the final frames and the text overlaps unreadably
        # (the same bug Ring of Doom's Phase 2 safe-area review caught).
        winner_team = next((t for t in record.teams if t.id == record.winner_team_id), None)
        overlays.append(OverlayCue(_frame_at(frame_sim_time, win_t), outro_start_f, "win", {
            "team": winner_team.name if winner_team else "?", "mvp": record.mvp_name,
        }))

    if outro_start_t is not None:
        overlays.append(OverlayCue(outro_start_f, total_frames, "standings", {
            "standings": episode.get("standings", {}), "teaser": episode.get("teaser", ""),
        }))

    return overlays


def _build_audio_cues(record: SimRecord, frame_sim_time: list[float], fps: int) -> list[AudioCue]:
    cues: list[AudioCue] = []

    def video_t(sim_t: float) -> float:
        return _frame_at(frame_sim_time, sim_t) / fps

    for e in record.events:
        if e.kind == "move_start":
            cues.append(AudioCue(video_t(e.t), "swish", {"kind": e.data.get("kind")}))
        elif e.kind == "move_end":
            cues.append(AudioCue(video_t(e.t), "click", {}))
        elif e.kind == "got_it":
            cues.append(AudioCue(video_t(e.t), "pop", {}))
        elif e.kind == "reveal_pop":
            cues.append(AudioCue(video_t(e.t), "pop", {}))

    first_pop = next((e for e in record.events if e.kind == "reveal_pop"), None)
    win_event = next((e for e in record.events if e.kind == "win"), None)
    if first_pop is not None and win_event is not None:
        start = max(0.0, video_t(first_pop.t) - 0.3)
        end = video_t(win_event.t)
        cues.append(AudioCue(start, "drumroll", {"duration": max(0.3, end - start)}))
    if win_event is not None:
        cues.append(AudioCue(video_t(win_event.t), "win_sting", {}))

    return sorted(cues, key=lambda c: c.video_time)
