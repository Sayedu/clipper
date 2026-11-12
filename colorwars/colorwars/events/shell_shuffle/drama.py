"""Shell Shuffle's own drama signal. engine.drama.analyze_drama (lead
changes, near misses, wipeouts...) doesn't fit this game at all -- there
are no "alive" balls to wipe out, no collisions, no near misses -- so this
event overrides Event.drama_stats() instead of inheriting that default.

Per the brief: reward the crown team's cup moving the most in round 3, and
reward 1st place not being the crown team; reject (in is_valid, a hard
constraint, not a soft score) any run where a cup never really moves
during round 3.
"""

from __future__ import annotations

from ...engine.records import SimRecord

STILL_THRESHOLD_PX = 6.0


def _round3_bounds(record: SimRecord) -> tuple[float, float]:
    start = next((e.t for e in record.events if e.kind == "round_start" and e.data.get("round") == 3), 0.0)
    end = next((e.t for e in record.events if e.kind == "round_end" and e.data.get("round") == 3),
               record.sim_duration_sec())
    return start, end


def round3_cup_distances(record: SimRecord) -> dict[int, float]:
    """Total on-screen travel distance per cup during round 3 only."""
    start, end = _round3_bounds(record)
    distances = {i: 0.0 for i in range(len(record.balls))}
    prev = None
    for step in record.steps:
        if step.t < start or step.t > end:
            prev = None
            continue
        if prev is not None:
            for i, bs in enumerate(step.balls):
                dx, dy = bs.x - prev[i][0], bs.y - prev[i][1]
                distances[i] += (dx * dx + dy * dy) ** 0.5
        prev = [(bs.x, bs.y) for bs in step.balls]
    return distances


def is_valid(record: SimRecord) -> bool:
    if record.winner_team_id is None or len(record.placements) != 4:
        return False
    distances = round3_cup_distances(record)
    if not distances:
        return False
    return min(distances.values()) >= STILL_THRESHOLD_PX


def drama_stats(record: SimRecord, episode: dict) -> dict:
    crown_id = episode.get("crown_team")
    distances = round3_cup_distances(record)
    max_dist = max(distances.values()) if distances else 0.0

    crown_cup = next((b.id for b in record.balls if b.team_id == crown_id), None) if crown_id else None
    crown_distance = distances.get(crown_cup, 0.0) if crown_cup is not None else 0.0
    crown_distance_frac = (crown_distance / max_dist) if max_dist > 0 else 0.0

    upset = crown_id is not None and record.winner_team_id != crown_id

    score = crown_distance_frac * 10.0
    if upset:
        score += 8.0

    return {
        "crown_cup_round3_distance_px": round(crown_distance, 1),
        "crown_cup_round3_distance_frac": round(crown_distance_frac, 3),
        "min_cup_round3_distance_px": round(min(distances.values()), 1) if distances else 0.0,
        "upset": upset,
        "score": round(score, 3),
    }
