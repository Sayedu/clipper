"""Champion Duel's own drama signal. engine.drama.analyze_drama's
vocabulary (lead changes across a field of teams, wipeouts, near misses)
doesn't fit a 1v1 HP race at all -- there's no "team count alive" concept
with only 2 participants, so this overrides Event.drama_stats() instead
of inheriting the generic default, the same call Shell Shuffle made.
"""

from __future__ import annotations

from ...engine.records import SimRecord

LATE_THRESHOLD_SEC = 15.0


def is_valid(record: SimRecord) -> bool:
    return record.winner_team_id is not None and len(record.placements) == 2


def drama_stats(record: SimRecord, episode: dict) -> dict:
    hits = [e for e in record.events if e.kind == "hit" and not e.data["blocked"]]
    blocks = [e for e in record.events if e.kind == "hit" and e.data["blocked"]]
    big_hits = [e for e in hits if e.data["damage"] >= 8.0]
    biggest_hit = max((e.data["damage"] for e in hits), default=0.0)

    # a comeback: the eventual winner was ever behind on HP after the
    # early game, tracked via the defender's post-hit HP on the LOSER's
    # landed hits against the winner.
    winner_id = record.winner_team_id
    was_behind = False
    for e in hits:
        if e.data["defender"] != winner_id or e.t < 5.0:
            continue
        if e.data["defender_hp_after"] < 35.0:
            was_behind = True

    sim_total = record.sim_duration_sec()
    late_big_hit = any(e.t >= sim_total - LATE_THRESHOLD_SEC for e in big_hits)
    crown_lost = episode.get("crown_team") is not None and episode.get("crown_team") != winner_id

    score = len(hits) * 0.8 + len(big_hits) * 4.0 + len(blocks) * 1.0
    if was_behind:
        score += 8.0
    if late_big_hit:
        score += 5.0
    if crown_lost:
        score += 3.0
    score += max(0.0, 10.0 - abs(30.0 - sim_total) * 0.3)  # a mid-length fight reads best, not instant or deadline-long

    return {
        "hits_landed": len(hits),
        "blocks": len(blocks),
        "big_hits": len(big_hits),
        "biggest_hit": round(biggest_hit, 1),
        "was_comeback": was_behind,
        "late_big_hit": late_big_hit,
        "crown_team_lost": crown_lost,
        "score": round(score, 3),
    }
