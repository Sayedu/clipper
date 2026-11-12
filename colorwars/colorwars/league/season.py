"""league/season.json: the one piece of persistent league state. Rendering
never writes this file -- only `colorwars commit <episode_id>` does, after
the episode has actually been posted. Everything else (crown team, last
place, storylines, the auto-built episode dict) is derived by reading it.
"""

from __future__ import annotations

import json
from pathlib import Path

POINTS_BY_PLACEMENT = [10, 6, 3, 1]  # index 0 = 1st place


def _hth_key(a: str, b: str) -> str:
    return "|".join(sorted([a, b]))


def default_season(team_ids: list[str], season_number: int = 1) -> dict:
    standings = {
        tid: {"points": 0, "wins": 0, "podiums": 0, "streak_type": None, "streak_count": 0}
        for tid in team_ids
    }
    head_to_head = {}
    for i, a in enumerate(team_ids):
        for b in team_ids[i + 1 :]:
            head_to_head[_hth_key(a, b)] = {a: 0, b: 0}
    return {
        "season_number": season_number,
        "episodes": [],
        "standings": standings,
        "records": {
            "fastest_win": None,
            "biggest_comeback": None,
            "longest_losing_streak": {"team": None, "count": 0},
        },
        "head_to_head": head_to_head,
    }


def load_season(path: Path, team_ids: list[str]) -> dict:
    if not path.exists():
        return default_season(team_ids)
    with open(path, "r", encoding="utf-8") as fh:
        season = json.load(fh)
    # a team added after the season file was created still needs an entry
    for tid in team_ids:
        season["standings"].setdefault(
            tid, {"points": 0, "wins": 0, "podiums": 0, "streak_type": None, "streak_count": 0}
        )
    return season


def save_season(season: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(season, fh, indent=2)
        fh.write("\n")


def crown_team_id(season: dict) -> str | None:
    if not season["episodes"]:
        return None
    standings = season["standings"]
    return max(standings, key=lambda tid: standings[tid]["points"])


def last_place_team_id(season: dict) -> str | None:
    if not season["episodes"]:
        return None
    standings = season["standings"]
    return min(standings, key=lambda tid: standings[tid]["points"])


def points_for(placement_index: int, is_finale: bool) -> int:
    base = POINTS_BY_PLACEMENT[placement_index] if placement_index < len(POINTS_BY_PLACEMENT) else 0
    return base * 2 if is_finale else base


def apply_episode(season: dict, *, episode_id: str, event_id: str, seed: int,
                   placements: list[str], mvp: str, date: str, is_finale: bool,
                   duration_sec: float, drama: dict) -> None:
    """Mutates `season` in place with one episode's results. The only
    function that should ever be called by `commit`."""
    crown_before = crown_team_id(season)

    season["episodes"].append({
        "id": episode_id, "event": event_id, "seed": seed, "placements": placements,
        "mvp": mvp, "date": date, "is_finale": is_finale, "duration_sec": duration_sec,
        "drama": drama,
    })

    standings = season["standings"]
    for idx, tid in enumerate(placements):
        row = standings.setdefault(tid, {"points": 0, "wins": 0, "podiums": 0, "streak_type": None, "streak_count": 0})
        row["points"] += points_for(idx, is_finale)
        if idx == 0:
            row["wins"] += 1
        if idx < 3:
            row["podiums"] += 1
        won = idx == 0
        if row["streak_type"] == ("win" if won else "loss"):
            row["streak_count"] += 1
        else:
            row["streak_type"] = "win" if won else "loss"
            row["streak_count"] = 1

    # head-to-head: whoever placed better between each pair "won" that pairing
    for i, a in enumerate(placements):
        for b in placements[i + 1 :]:
            key = _hth_key(a, b)
            row = season["head_to_head"].setdefault(key, {a: 0, b: 0})
            row.setdefault(a, 0)
            row.setdefault(b, 0)
            row[a] += 1  # a placed ahead of every b later in the list

    records = season["records"]
    winner = placements[0] if placements else None
    # fastest_win uses sim seconds (the RAW physics length), not duration_sec
    # (the final VIDEO length after slow motion) -- set via set_fastest_win(),
    # called by commit() directly since it has the sim-time stat, not here.

    if drama.get("comeback_margin", 0) > 0:
        bc = records.get("biggest_comeback")
        if bc is None or drama["comeback_margin"] > bc.get("margin", 0):
            records["biggest_comeback"] = {"episode_id": episode_id, "team": winner, "margin": drama["comeback_margin"]}

    # track the running best in a local, not the dict itself -- reassigning
    # records["longest_losing_streak"] each hit while still comparing against
    # a reference captured before the loop meant the comparison baseline
    # never advanced, so the LAST tied team always won instead of the first.
    best_count = records["longest_losing_streak"].get("count", 0)
    for tid, row in standings.items():
        if row["streak_type"] == "loss" and row["streak_count"] > best_count:
            best_count = row["streak_count"]
            records["longest_losing_streak"] = {"team": tid, "count": row["streak_count"]}

    _ = crown_before  # kept for callers that want to compare crown before/after


def set_fastest_win(season: dict, episode_id: str, team: str, sim_seconds: float) -> None:
    fw = season["records"].get("fastest_win")
    if fw is None or sim_seconds < fw.get("sim_seconds", float("inf")):
        season["records"]["fastest_win"] = {"episode_id": episode_id, "team": team, "sim_seconds": sim_seconds}


def head_to_head_summary(season: dict, a: str, b: str) -> tuple[int, int]:
    row = season["head_to_head"].get(_hth_key(a, b), {})
    return row.get(a, 0), row.get(b, 0)
