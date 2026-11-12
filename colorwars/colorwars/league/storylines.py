"""Generates candidate storylines from the season's own stats, scores them
by how extreme the underlying stat is, and picks the hook line (best) and
the outro teaser (best of what's left, phrased forward-looking).
"""

from __future__ import annotations

from dataclasses import dataclass

from .season import head_to_head_summary


@dataclass
class Storyline:
    text: str
    score: float
    kind: str


def _team_name(teams_by_id: dict, tid: str) -> str:
    t = teams_by_id.get(tid)
    return t.name.upper() if t else tid.upper()


def generate_candidates(season: dict, teams_by_id: dict) -> list[Storyline]:
    out: list[Storyline] = []
    standings = season["standings"]
    team_ids = list(standings.keys())

    for tid, row in standings.items():
        name = _team_name(teams_by_id, tid)
        if row["streak_type"] == "loss" and row["streak_count"] >= 2:
            out.append(Storyline(
                f"{name} has lost {row['streak_count']} in a row. Can they turn it around?",
                score=row["streak_count"], kind="losing_streak",
            ))
        if row["streak_type"] == "win" and row["streak_count"] >= 2:
            out.append(Storyline(
                f"{name} is on a {row['streak_count']} episode win streak.",
                score=row["streak_count"] + 1, kind="winning_streak",
            ))
        if row["wins"] == 0 and len(season["episodes"]) >= 2:
            out.append(Storyline(
                f"{name} is still searching for their first win.",
                score=len(season["episodes"]) * 0.8, kind="first_win",
            ))

    # rivalry: the pair with the most games played together is the most
    # "established" rivalry worth bringing up.
    best_pair, best_games = None, 0
    for i, a in enumerate(team_ids):
        for b in team_ids[i + 1:]:
            wa, wb = head_to_head_summary(season, a, b)
            games = wa + wb
            if games > best_games:
                best_games, best_pair = games, (a, b)
    if best_pair and best_games >= 2:
        a, b = best_pair
        wa, wb = head_to_head_summary(season, a, b)
        out.append(Storyline(
            f"{_team_name(teams_by_id, a)} vs {_team_name(teams_by_id, b)}: {wa} {wb} all time.",
            score=best_games, kind="rivalry",
        ))

    # crown pressure: how close is 2nd place to the crown team's points?
    if len(season["episodes"]) >= 1:
        ranked = sorted(standings.items(), key=lambda kv: -kv[1]["points"])
        if len(ranked) >= 2:
            leader_id, leader_row = ranked[0]
            second_id, second_row = ranked[1]
            margin = leader_row["points"] - second_row["points"]
            if margin <= 10:
                out.append(Storyline(
                    f"{_team_name(teams_by_id, leader_id)} holds the crown by just {margin} points.",
                    score=max(1.0, 12 - margin), kind="crown_pressure",
                ))

    # record chase: close to the longest losing streak on record
    longest = season["records"].get("longest_losing_streak") or {}
    if longest.get("count", 0) >= 2:
        out.append(Storyline(
            f"{_team_name(teams_by_id, longest['team'])}'s {longest['count']} episode losing "
            f"streak is now the longest in league history.",
            score=longest["count"] * 1.2, kind="record_chase",
        ))

    return out


def pick_hook_and_teaser(season: dict, teams_by_id: dict) -> tuple[str, str]:
    candidates = generate_candidates(season, teams_by_id)
    if not candidates:
        return "A brand new season begins. Who takes the first crown?", "Who will rise? Find out next time."

    ranked = sorted(candidates, key=lambda c: -c.score)
    hook = ranked[0].text

    teaser_source = next((c for c in ranked[1:] if c.kind != ranked[0].kind), ranked[0])
    teaser = _as_teaser(teaser_source)
    return hook, teaser


def _as_teaser(c: Storyline) -> str:
    if c.kind == "losing_streak":
        return "Next time: can the skid finally end?"
    if c.kind == "winning_streak":
        return "Next time: can the streak keep going?"
    if c.kind == "first_win":
        return "Next time: is this finally the one?"
    if c.kind == "rivalry":
        return "Next time: the rivalry continues."
    if c.kind == "crown_pressure":
        return "Next time: the crown is still up for grabs."
    if c.kind == "record_chase":
        return "Next time: history could be made."
    return "Next time: anything can happen."
