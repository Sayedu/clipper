"""python -m colorwars bracket

Renders a 3-episode Champion Duel bracket: two semifinals seeded by
current standings (1st vs 4th, 2nd vs 3rd -- or teams.yaml order if the
season has no episodes yet), then a final between the two semifinal
winners. Semifinal winners are read directly off each render's own
meta.json, not off league/season.json -- nothing here commits anything,
same "render never writes the season" rule as a normal render, so a
bracket can be rendered and reviewed before any of its 3 episodes are
actually posted.
"""

from __future__ import annotations

from pathlib import Path

from .config import REPO_ROOT, Settings, Team, load_teams
from .pipeline import build_episode_from_season, find_seed, run_render
from .registry import get_event


def _standings_order(season: dict, team_ids: list[str]) -> list[str]:
    if not season["episodes"]:
        return list(team_ids)
    standings = season["standings"]
    return sorted(team_ids, key=lambda tid: -standings[tid]["points"])


def run_bracket(preview: bool = False, find_seed_max_tries: int = 500) -> list[dict]:
    """Returns the 3 episodes' meta dicts, in order [sf1, sf2, final]."""
    event = get_event("champion_duel")
    settings, teams, event_cfg, base_episode, season = build_episode_from_season(REPO_ROOT, "champion_duel")
    teams_by_id = {t.id: t for t in teams}
    team_ids = [t.id for t in teams]

    order = _standings_order(season, team_ids)
    sf_pairs = [(order[0], order[3]), (order[1], order[2])]
    base_number = base_episode["number"]

    metas: list[dict] = []
    winners: list[str] = []
    for i, (a, b) in enumerate(sf_pairs, start=1):
        episode = dict(base_episode)
        episode["number"] = base_number + i - 1
        episode["id"] = f"ep{episode['number']:03d}"
        episode["duel_matchup"] = (a, b)
        episode["hook_line"] = f"SEMIFINAL {i}: {teams_by_id[a].name.upper()} VS {teams_by_id[b].name.upper()}"
        episode["teaser"] = "Next: the bracket continues."
        seed = find_seed(event, settings, event_cfg, teams, episode, max_tries=find_seed_max_tries)
        out_dir = settings.out_dir / episode["id"]
        meta = run_render(event, seed, settings, event_cfg, teams, episode, out_dir, preview=preview)
        metas.append(meta)
        winners.append(meta["winner"])

    final_episode = dict(base_episode)
    final_episode["number"] = base_number + 2
    final_episode["id"] = f"ep{final_episode['number']:03d}"
    final_episode["duel_matchup"] = (winners[0], winners[1])
    final_episode["hook_line"] = (
        f"THE FINAL: {teams_by_id[winners[0]].name.upper()} VS {teams_by_id[winners[1]].name.upper()}"
    )
    final_episode["teaser"] = "A new champion is crowned."
    seed = find_seed(event, settings, event_cfg, teams, final_episode, max_tries=find_seed_max_tries)
    out_dir = settings.out_dir / final_episode["id"]
    meta = run_render(event, seed, settings, event_cfg, teams, final_episode, out_dir, preview=preview)
    metas.append(meta)

    return metas
