"""Disaster Drop's drama signal. Unlike Shell Shuffle, this event's
"alive" flag (repurposed here to mean "still an active racer -- not yet
finished or eliminated", the same spirit as Shell Shuffle repurposing it to
mean "ball visible") lines up well enough with engine.drama.analyze_drama's
generic vocabulary (lead_change, near_miss, elimination) that reusing it as
a base is genuinely meaningful here, not misleading like it was for a cup
game -- this event logs real lead_change/near_miss/elimination SimEvents
for exactly that reason. The brief calls its own list "DRAMA SCORE
ADDITIONS", which this takes literally: start from analyze_drama's score,
add this event's own signals on top.
"""

from __future__ import annotations

from ...engine.drama import analyze_drama
from ...engine.records import SimRecord

LATE_THRESHOLD_SEC = 15.0


def is_valid(record: SimRecord) -> bool:
    if record.winner_team_id is None or len(record.placements) != 4:
        return False
    trapped = any(e.kind == "course_trapped" for e in record.events)
    if trapped:
        return False
    # a team can "resolve" either by finishing or by being wiped out --
    # without this check a race where the crusher eliminates all 12 balls
    # before anyone crosses the line still picked a "winner" (whoever's
    # best ball got furthest), which isn't a real race result. Found by
    # actually looking at a rendered run, not by reading the code: every
    # ball on screen had the eliminated X-eyes, yet it still said "BLUE
    # WINS".
    winner_finished = any(e.kind == "finish" and e.data["team_id"] == record.winner_team_id
                           for e in record.events)
    return winner_finished


def _winning_margin_sec(record: SimRecord) -> float | None:
    finishes = sorted((e.t for e in record.events if e.kind == "finish"), key=lambda t: t)
    team_first_finish: dict[str, float] = {}
    for e in record.events:
        if e.kind == "finish":
            tid = e.data["team_id"]
            if tid not in team_first_finish:
                team_first_finish[tid] = e.t
    times = sorted(team_first_finish.values())
    if len(times) < 2:
        return None
    return times[1] - times[0]


def _disaster_hit_leader_late(record: SimRecord) -> bool:
    sim_total = record.sim_duration_sec()
    for e in record.events:
        if e.kind != "disaster" or e.t < sim_total - LATE_THRESHOLD_SEC:
            continue
        # a disaster event's "team" is the team it actually targeted (None
        # for untargeted types like wall/gravity_flip) -- treat "hit the
        # leader" as targeting whichever team was leading right then.
        lead_at_t = None
        for le in record.events:
            if le.kind == "lead_change" and le.t <= e.t:
                lead_at_t = le.data.get("team_id")
        if lead_at_t is None:
            continue
        team_name_by_id = {b.team_id: b.team_name for b in record.balls}
        if e.data.get("team") == team_name_by_id.get(lead_at_t):
            return True
    return False


def _crusher_closeness_px(record: SimRecord) -> float:
    misses = [e for e in record.events if e.kind == "near_miss"]
    if not misses:
        return float("inf")
    return min(e.data.get("peak_r", float("inf")) for e in misses)


def drama_stats(record: SimRecord, episode: dict) -> dict:
    base = analyze_drama(record, episode.get("crown_team")).to_dict()

    margin = _winning_margin_sec(record)
    hit_leader_late = _disaster_hit_leader_late(record)
    crusher_closeness = _crusher_closeness_px(record)

    score = base["score"]
    if margin is not None:
        score += max(0.0, 6.0 - margin)  # a tighter finish is more dramatic, capped
    if hit_leader_late:
        score += 6.0
    if crusher_closeness != float("inf"):
        score += max(0.0, 6.0 - crusher_closeness / 50.0)  # closer calls (smaller gap) score higher

    merged = dict(base)
    merged["winning_margin_sec"] = round(margin, 2) if margin is not None else None
    merged["disaster_hit_leader_late"] = hit_leader_late
    merged["crusher_closest_gap_px"] = None if crusher_closeness == float("inf") else round(crusher_closeness, 1)
    merged["score"] = round(score, 3)
    return merged
