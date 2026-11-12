"""python -m colorwars render --event ring_of_doom --seed 42
   python -m colorwars render --event ring_of_doom --best
   python -m colorwars find-seed --event ring_of_doom
   python -m colorwars mine --event ring_of_doom --runs 500 --top 5
   python -m colorwars commit <episode_id>
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

from .engine.config import REPO_ROOT, Settings, load_teams
from .engine.mining import MineFilters, mine as run_mine
from .engine.pipeline import build_episode_from_season, commit_episode, find_seed, run_render

_REGISTRY = {}


def _get_event(event_id: str):
    if event_id not in _REGISTRY:
        if event_id == "ring_of_doom":
            from .events.ring_of_doom.event import RingOfDoomEvent

            _REGISTRY[event_id] = RingOfDoomEvent()
        else:
            raise SystemExit(f"unknown event: {event_id!r} (known: ring_of_doom)")
    return _REGISTRY[event_id]


def _best_seed_from_csv(event_id: str) -> int:
    csv_path = REPO_ROOT / "out" / f"mine_{event_id}.csv"
    if not csv_path.exists():
        raise SystemExit(f"no {csv_path} yet -- run `mine --event {event_id}` first")
    with open(csv_path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        raise SystemExit(f"{csv_path} has no rows -- run `mine --event {event_id}` again")
    return int(rows[0]["seed"])  # mine() always writes score-descending


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="colorwars")
    sub = parser.add_subparsers(dest="command", required=True)

    p_render = sub.add_parser("render", help="render a finished episode video")
    p_render.add_argument("--event", required=True)
    seed_group = p_render.add_mutually_exclusive_group(required=True)
    seed_group.add_argument("--seed", type=int)
    seed_group.add_argument("--best", action="store_true", help="use the top seed from the last `mine` run")
    p_render.add_argument("--preview", action="store_true", help="fast 540x960 30fps preview instead of the full 1080x1920 60fps render")
    p_render.add_argument("--out", default=None, help="output directory (defaults to out/<episode_id>)")
    p_render.add_argument("--finale", action="store_true", help="this episode's points count double")
    p_render.add_argument("--legacy-episode", action="store_true",
                           help="use config/episode.yaml directly instead of building it from league/season.json")

    p_find = sub.add_parser("find-seed", help="return the first seed that produces a valid run")
    p_find.add_argument("--event", required=True)
    p_find.add_argument("--start", type=int, default=1)
    p_find.add_argument("--max-tries", type=int, default=500)
    p_find.add_argument("--legacy-episode", action="store_true")

    p_mine = sub.add_parser("mine", help="simulate many seeds in parallel and rank them for drama")
    p_mine.add_argument("--event", required=True)
    p_mine.add_argument("--runs", type=int, default=500)
    p_mine.add_argument("--top", type=int, default=5)
    p_mine.add_argument("--start", type=int, default=1)
    p_mine.add_argument("--processes", type=int, default=None)
    p_mine.add_argument("--winner")
    p_mine.add_argument("--not-winner")
    p_mine.add_argument("--comeback", action="store_true")
    p_mine.add_argument("--min-lead-changes", type=int, default=0)
    p_mine.add_argument("--photo-finish", action="store_true")

    p_commit = sub.add_parser("commit", help="apply a rendered episode's results to league/season.json (run after posting)")
    p_commit.add_argument("episode_id")
    p_commit.add_argument("--event", default="ring_of_doom")

    args = parser.parse_args(argv)

    if args.command == "render":
        event = _get_event(args.event)
        if args.legacy_episode:
            from .engine.pipeline import load_common

            settings, teams, event_cfg, episode = load_common(REPO_ROOT, args.event)
        else:
            settings, teams, event_cfg, episode, _season = build_episode_from_season(REPO_ROOT, args.event, is_finale=args.finale)

        seed = args.seed if args.seed is not None else _best_seed_from_csv(args.event)
        out_dir = Path(args.out) if args.out else settings.out_dir / episode.get("id", "ep000")
        t0 = time.time()
        meta = run_render(event, seed, settings, event_cfg, teams, episode, out_dir, preview=args.preview)
        dt = time.time() - t0
        print(f"rendered {out_dir / 'final.mp4'} in {dt:.1f}s")
        print(f"  seed: {seed}  duration: {meta['duration_sec']:.1f}s  winner: {meta['winner']}  mvp: {meta['mvp']}")
        print(f"  placements: {meta['placements']}")
        print(f"  hook: {episode.get('hook_line')}")
        print(f"  teaser: {episode.get('teaser')}")
        return 0

    if args.command == "find-seed":
        event = _get_event(args.event)
        if args.legacy_episode:
            from .engine.pipeline import load_common

            settings, teams, event_cfg, episode = load_common(REPO_ROOT, args.event)
        else:
            settings, teams, event_cfg, episode, _season = build_episode_from_season(REPO_ROOT, args.event)
        seed = find_seed(event, settings, event_cfg, teams, episode, start_seed=args.start, max_tries=args.max_tries)
        print(seed)
        return 0

    if args.command == "mine":
        settings, teams, event_cfg, episode, _season = build_episode_from_season(REPO_ROOT, args.event)
        filters = MineFilters(
            winner=args.winner, not_winner=args.not_winner, comeback=args.comeback,
            min_lead_changes=args.min_lead_changes, photo_finish=args.photo_finish,
        )
        t0 = time.time()
        top_rows, total_valid = run_mine(args.event, episode, args.runs, args.top, filters,
                                          start_seed=args.start, processes=args.processes)
        dt = time.time() - t0
        print(f"mined {args.runs} seeds in {dt:.1f}s -- {total_valid} valid and matching filters")
        for row in top_rows:
            print(f"  seed {row['seed']:>6}  score {row['score']:>6.1f}  "
                  f"winner {row['winner']:<7} leadchg {row['lead_changes']}  "
                  f"finaltwo {row['final_two_sec']:.1f}s  nearmiss {row['near_misses']}  "
                  f"comeback {row['was_last_after_15']}")
        print(f"wrote out/mine_{args.event}.csv")
        return 0

    if args.command == "commit":
        settings = Settings.load(REPO_ROOT)
        teams = load_teams(settings.teams_path)
        out_dir = settings.out_dir / args.episode_id
        season = commit_episode(settings, teams, out_dir)
        print(f"committed {args.episode_id} to {settings.season_path}")
        print("standings:")
        for tid, row in sorted(season["standings"].items(), key=lambda kv: -kv[1]["points"]):
            print(f"  {tid:<8} {row['points']:>3} pts  {row['wins']} wins  "
                  f"{row['streak_type'] or '-'} streak x{row['streak_count']}")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
