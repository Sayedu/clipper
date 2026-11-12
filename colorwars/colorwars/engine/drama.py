"""Shared drama analysis: turns a SimRecord into the stats both the story
director (mining) and the render-time meta.json/commit() pipeline need --
lead changes, near misses, how long the final two survived together,
whether the winner was ever in last place late, whether the crown team
lost, dead stretches, early wipeouts. Pure function of (record,
crown_team_id); no randomness, nothing event-specific beyond the generic
SimEvent kinds every event already emits (collision/elimination/hazard/
near_miss/lead_change), so this stays reusable by future events too.
"""

from __future__ import annotations

from dataclasses import dataclass

from .records import SimRecord

LATE_THRESHOLD_SEC = 15.0
DEAD_STRETCH_SEC = 9.0


@dataclass
class DramaStats:
    lead_changes: int
    near_misses: int
    final_two_sec: float
    was_last_after_15: bool
    comeback_margin: int
    crown_team_lost: bool
    dead_stretches_over_9s: int
    wiped_before_15: bool

    def score(self) -> float:
        s = self.lead_changes * 3.0
        s += min(self.final_two_sec, 10.0)
        s += min(self.near_misses * 1.5, 8.0)
        if self.was_last_after_15:
            s += 8.0
        if self.crown_team_lost:
            s += 3.0
        s -= 5.0 * self.dead_stretches_over_9s
        if self.wiped_before_15:
            s -= 5.0
        return s

    def to_dict(self) -> dict:
        return {
            "lead_changes": self.lead_changes,
            "near_misses": self.near_misses,
            "final_two_sec": round(self.final_two_sec, 3),
            "was_last_after_15": self.was_last_after_15,
            "comeback_margin": self.comeback_margin,
            "crown_team_lost": self.crown_team_lost,
            "dead_stretches_over_9s": self.dead_stretches_over_9s,
            "wiped_before_15": self.wiped_before_15,
            "score": round(self.score(), 3),
        }


def analyze_drama(record: SimRecord, crown_team_id: str | None) -> DramaStats:
    team_ids = sorted({b.team_id for b in record.balls})
    hz = record.physics_hz

    lead_changes = sum(1 for e in record.events if e.kind == "lead_change")
    near_misses = sum(1 for e in record.events if e.kind == "near_miss")

    final_two_steps = sum(1 for step in record.steps if sum(1 for b in step.balls if b.alive) == 2)
    final_two_sec = final_two_steps / hz

    winner_id = record.winner_team_id
    was_last_after_15 = False
    comeback_margin = 0
    for step in record.steps:
        if step.t < LATE_THRESHOLD_SEC or winner_id is None:
            continue
        counts: dict[str, int] = {tid: 0 for tid in team_ids}
        for i, b in enumerate(step.balls):
            if b.alive:
                counts[record.balls[i].team_id] += 1
        winner_count = counts.get(winner_id, 0)
        others = [c for tid, c in counts.items() if tid != winner_id]
        if not others:
            continue
        if winner_count <= min(others):
            was_last_after_15 = True
            comeback_margin = max(comeback_margin, max(others) - winner_count)

    crown_team_lost = crown_team_id is not None and crown_team_id != winner_id

    active_kinds = {"elimination", "hazard", "near_miss"}
    active_times = sorted(e.t for e in record.events if e.kind in active_kinds)
    dead_stretches = 0
    prev_t = 0.0
    for t in active_times:
        if t - prev_t > DEAD_STRETCH_SEC:
            dead_stretches += 1
        prev_t = t
    if record.sim_duration_sec() - prev_t > DEAD_STRETCH_SEC:
        dead_stretches += 1

    wiped_before_15 = False
    for step in record.steps:
        if step.t >= LATE_THRESHOLD_SEC:
            break
        counts = {tid: 0 for tid in team_ids}
        for i, b in enumerate(step.balls):
            if b.alive:
                counts[record.balls[i].team_id] += 1
        if any(c == 0 for c in counts.values()):
            wiped_before_15 = True
            break

    return DramaStats(
        lead_changes=lead_changes,
        near_misses=near_misses,
        final_two_sec=final_two_sec,
        was_last_after_15=was_last_after_15,
        comeback_margin=comeback_margin,
        crown_team_lost=crown_team_lost,
        dead_stretches_over_9s=dead_stretches,
        wiped_before_15=wiped_before_15,
    )
