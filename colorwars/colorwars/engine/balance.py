"""python -m colorwars balance --runs 2000

Runs every Champion Duel matchup many times (varying only the seed) and
nudges each team's single tunable `duel_power` trait until no matchup wins
more than 60% of the time for either side, then writes the tuned numbers
back into teams.yaml.

Each team's power knob means something different mechanically (Red: spike
reach growth; Blue: shield arc growth; Green: twin damage; Yellow: speed
growth) -- this module never needs to know that. It only ever sees "a
team's power, a float, nudge it up or down a few percent," which Champion
Duel's own sim.py is what actually interprets.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from multiprocessing import Pool
from pathlib import Path

from .config import REPO_ROOT, Settings, Team, load_event_config, load_teams

WIN_RATE_CEILING = 0.6
ADJUST_STEP = 0.05  # +/- 5% per out-of-balance matchup per round


def _sim_matchup(args: tuple[int, str, str, dict[str, float]]) -> str | None:
    """Runs in a worker process -- module-level and picklable, reloads its
    own settings/teams/cfg per call since nothing is shared across the
    process boundary (the same constraint mining.py's worker has)."""
    seed, team_a_id, team_b_id, power = args
    from ..events.champion_duel.event import ChampionDuelEvent

    settings = Settings.load(REPO_ROOT)
    raw_teams = load_teams(settings.teams_path)
    teams = [
        Team(id=t.id, name=t.name, color=t.color, personality=t.personality,
             traits={**t.traits, "duel_power": power.get(t.id, t.traits.get("duel_power", 1.0))})
        for t in raw_teams
    ]
    cfg = load_event_config(REPO_ROOT, "champion_duel")
    episode = {"crown_team": None, "duel_matchup": (team_a_id, team_b_id)}
    event = ChampionDuelEvent()
    record = event.simulate(seed, settings, cfg, teams, episode)
    return record.winner_team_id


@dataclass
class MatchupResult:
    team_a: str
    team_b: str
    rate_a: float
    rate_b: float

    @property
    def balanced(self) -> bool:
        return self.rate_a <= WIN_RATE_CEILING and self.rate_b <= WIN_RATE_CEILING


def _run_round(matchups: list[tuple[str, str]], power: dict[str, float], runs: int,
                processes: int | None, start_seed: int) -> list[MatchupResult]:
    results: list[MatchupResult] = []
    for a, b in matchups:
        tasks = [(seed, a, b, dict(power)) for seed in range(start_seed, start_seed + runs)]
        wins = {a: 0, b: 0}
        with Pool(processes=processes) as pool:
            for winner in pool.imap_unordered(_sim_matchup, tasks, chunksize=25):
                if winner in wins:
                    wins[winner] += 1
        total = wins[a] + wins[b]
        rate_a = wins[a] / total if total else 0.5
        rate_b = wins[b] / total if total else 0.5
        results.append(MatchupResult(a, b, rate_a, rate_b))
    return results


def tune(runs: int, max_rounds: int = 20, processes: int | None = None,
         on_round=None) -> tuple[dict[str, float], list[MatchupResult], int]:
    """Returns (power, results, rounds_used) -- the power/results returned
    are the best round SEEN, not necessarily the last one. A fixed 5% step
    each round oscillates rather than settling (confirmed directly: round
    17 of a real 20-round run had Yellow at 68% against Red, and round 20
    had it back down to 45%, with other matchups swinging the same way in
    between) -- decaying the step and keeping the least-imbalanced round
    found is standard practice for exactly this kind of oscillation,
    rather than just reporting whatever the last round happened to land on.
    """
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    team_ids = [t.id for t in teams]
    power = {t.id: float(t.traits.get("duel_power", 1.0)) for t in teams}
    matchups = [(team_ids[i], team_ids[j]) for i in range(len(team_ids)) for j in range(i + 1, len(team_ids))]

    best_power = dict(power)
    best_results: list[MatchupResult] = []
    best_badness = float("inf")

    for round_i in range(1, max_rounds + 1):
        results = _run_round(matchups, power, runs, processes, start_seed=round_i * 100_000 + 1)
        if on_round is not None:
            on_round(round_i, power, results)
        badness = sum(max(0.0, r.rate_a - WIN_RATE_CEILING) ** 2 + max(0.0, r.rate_b - WIN_RATE_CEILING) ** 2
                       for r in results)
        if badness < best_badness:
            best_badness = badness
            best_power = dict(power)
            best_results = results
        if all(r.balanced for r in results):
            return power, results, round_i
        step = ADJUST_STEP / (1.0 + 0.15 * (round_i - 1))
        for r in results:
            if r.balanced:
                continue
            if r.rate_a > r.rate_b:
                power[r.team_a] *= (1.0 - step)
                power[r.team_b] *= (1.0 + step)
            else:
                power[r.team_b] *= (1.0 - step)
                power[r.team_a] *= (1.0 + step)
    return best_power, best_results, max_rounds


def save_tuned_power(teams_path: Path, power: dict[str, float]) -> None:
    """Patches each team's `duel_power:` line in place via text, rather
    than a load-then-yaml.safe_dump round trip -- PyYAML doesn't preserve
    comments on a round trip, and teams.yaml's per-trait comments (what
    each number means, which event reads it) are worth keeping."""
    lines = teams_path.read_text(encoding="utf-8").split("\n")
    current_team: str | None = None
    for i, line in enumerate(lines):
        id_match = re.match(r"\s*-\s*id:\s*(\w+)", line)
        if id_match:
            current_team = id_match.group(1)
            continue
        if current_team is None:
            continue
        power_match = re.match(r"(\s*duel_power:\s*)([\d.eE+-]+)(.*)", line)
        if power_match and current_team in power:
            indent_and_key, _old_value, rest = power_match.groups()
            lines[i] = f"{indent_and_key}{power[current_team]:.4g}{rest}"
    teams_path.write_text("\n".join(lines), encoding="utf-8")
