"""python -m colorwars mine --event ring_of_doom --runs 500 --top 5

Simulates many seeds in parallel OS processes (this is CPU-bound physics,
so real processes to get past the GIL, not threads) and scores each for
drama. Never touches season.json and never renders a frame -- simulate() +
direct() only, which is what makes mining hundreds of seeds fast.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from multiprocessing import Pool

from .config import REPO_ROOT, Settings, load_event_config, load_teams
from .registry import get_event


def _get_event(event_id: str):
    return get_event(event_id)


def _mine_one(task: tuple[int, str, dict]) -> dict | None:
    """Runs in a worker process -- must stay a module-level function
    (picklable) and reload its own settings/teams/cfg, since nothing is
    shared across the process boundary."""
    seed, event_id, episode = task
    event = _get_event(event_id)
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    cfg = load_event_config(REPO_ROOT, event_id)

    record = event.simulate(seed, settings, cfg, teams, episode)
    if not event.is_valid(record):
        return None

    timeline = event.direct(record, settings, cfg, episode, settings.fps)
    duration = timeline.duration_sec()
    if not (settings.duration_min_sec <= duration <= settings.duration_max_sec):
        return None

    drama = event.drama_stats(record, episode)
    row = {"seed": seed, "winner": record.winner_team_id, "mvp": record.mvp_name,
           "duration_sec": round(duration, 2)}
    row.update(drama)
    return row


@dataclass
class MineFilters:
    winner: str | None = None
    not_winner: str | None = None
    comeback: bool = False
    min_lead_changes: int = 0
    photo_finish: bool = False  # final two survived together >= 6s


def _passes(row: dict, f: MineFilters) -> bool:
    """The --comeback/--min-lead-changes/--photo-finish flags are Ring of
    Doom specific (its drama_stats() is the only one with these keys) --
    on an event whose drama dict doesn't have them, .get() just treats
    them as not applying rather than crashing mine() for every seed."""
    if f.winner and row["winner"] != f.winner:
        return False
    if f.not_winner and row["winner"] == f.not_winner:
        return False
    if f.comeback and not row.get("was_last_after_15", False):
        return False
    if row.get("lead_changes", 0) < f.min_lead_changes:
        return False
    if f.photo_finish and row.get("final_two_sec", 0.0) < 6.0:
        return False
    return True


def mine(event_id: str, episode: dict, runs: int, top: int, filters: MineFilters,
          start_seed: int = 1, processes: int | None = None) -> tuple[list[dict], int]:
    """Returns (top N rows sorted by score, total valid-and-filtered count)."""
    tasks = [(seed, event_id, episode) for seed in range(start_seed, start_seed + runs)]
    results: list[dict] = []
    with Pool(processes=processes) as pool:
        for row in pool.imap_unordered(_mine_one, tasks, chunksize=4):
            if row is not None and _passes(row, filters):
                results.append(row)
    results.sort(key=lambda r: -r["score"])

    out_path = REPO_ROOT / "out" / f"mine_{event_id}.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if results:
        with open(out_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(results[0].keys()))
            writer.writeheader()
            writer.writerows(results)

    return results[:top], len(results)
