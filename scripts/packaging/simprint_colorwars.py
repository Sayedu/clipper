"""Gameplay fingerprint for a colorwars event (Ring of Doom, Hot Potato).

Imports the engine from --code (any checkout, e.g. a worktree of an older
tag) but reads configs/teams/episode from --config, so two code versions
are compared on identical inputs. Hashes every physics step's ball state,
the event log, placements and MVP: the whole SimRecord.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--event", required=True)
    ap.add_argument("--seed", type=int, required=True)
    a = ap.parse_args()

    sys.path.insert(0, a.code)
    from colorwars.engine.pipeline import load_common  # noqa: E402
    from colorwars.engine.registry import get_event  # noqa: E402

    settings, teams, event_cfg, episode = load_common(Path(a.config), a.event)
    record = get_event(a.event).simulate(a.seed, settings, event_cfg, teams, episode)

    steps = hashlib.sha256()
    for s in record.steps:
        steps.update(repr((round(s.t, 9), round(s.ring_angle, 9), s.gaps_deg)).encode())
        for b in s.balls:
            steps.update(repr((b.x, b.y, b.angle, b.vx, b.vy, b.alive)).encode())
    events = hashlib.sha256(repr([(e.step, e.t, e.kind, sorted(e.data.items(), key=lambda kv: kv[0])) for e in record.events]).encode())
    print(json.dumps({
        "seed": a.seed,
        "steps": len(record.steps),
        "stepsHash": steps.hexdigest(),
        "eventsHash": events.hexdigest(),
        "events": len(record.events),
        "placements": record.placements,
        "winner": record.winner_team_id,
        "mvp": record.mvp_name,
    }))


if __name__ == "__main__":
    main()
