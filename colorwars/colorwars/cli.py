"""python -m colorwars render --event ring_of_doom --seed 42
   python -m colorwars find-seed --event ring_of_doom
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from .engine.config import REPO_ROOT
from .engine.pipeline import find_seed, load_common, run_render

_REGISTRY = {}


def _get_event(event_id: str):
    if event_id not in _REGISTRY:
        if event_id == "ring_of_doom":
            from .events.ring_of_doom.event import RingOfDoomEvent

            _REGISTRY[event_id] = RingOfDoomEvent()
        else:
            raise SystemExit(f"unknown event: {event_id!r} (known: ring_of_doom)")
    return _REGISTRY[event_id]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="colorwars")
    sub = parser.add_subparsers(dest="command", required=True)

    p_render = sub.add_parser("render", help="render a finished episode video")
    p_render.add_argument("--event", required=True)
    p_render.add_argument("--seed", type=int, required=True)
    p_render.add_argument("--preview", action="store_true", help="fast 540x960 30fps preview instead of the full 1080x1920 60fps render")
    p_render.add_argument("--out", default=None, help="output directory (defaults to out/<episode_id>)")

    p_find = sub.add_parser("find-seed", help="return the first seed that produces a valid run")
    p_find.add_argument("--event", required=True)
    p_find.add_argument("--start", type=int, default=1)
    p_find.add_argument("--max-tries", type=int, default=500)

    args = parser.parse_args(argv)

    if args.command == "render":
        event = _get_event(args.event)
        settings, teams, event_cfg, episode = load_common(REPO_ROOT, args.event)
        out_dir = Path(args.out) if args.out else settings.out_dir / episode.get("id", "ep000")
        t0 = time.time()
        meta = run_render(event, args.seed, settings, event_cfg, teams, episode, out_dir, preview=args.preview)
        dt = time.time() - t0
        print(f"rendered {out_dir / 'final.mp4'} in {dt:.1f}s")
        print(f"  duration: {meta['duration_sec']:.1f}s  winner: {meta['winner']}  mvp: {meta['mvp']}")
        print(f"  placements: {meta['placements']}")
        return 0

    if args.command == "find-seed":
        event = _get_event(args.event)
        settings, teams, event_cfg, episode = load_common(REPO_ROOT, args.event)
        seed = find_seed(event, settings, event_cfg, teams, episode, start_seed=args.start, max_tries=args.max_tries)
        print(seed)
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
