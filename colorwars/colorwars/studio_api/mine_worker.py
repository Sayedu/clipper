"""python -m colorwars.studio_api.mine_worker <jobs_dir> <job_id>

Runs one story-director (mine) job to completion in its own process, same
reasoning as render_worker.py. mine() itself has no fine-grained progress
hook (it's a single multiprocessing.Pool.imap_unordered call) -- the job
goes queued -> running -> done/error with an elapsed-time readout in the
UI rather than a frame counter, a deliberate scope call, not an oversight.
"""

from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path

from ..engine.config import Settings
from ..engine.mining import MineFilters, mine as run_mine
from .engine_helpers import build_episode
from .jobs import JobStore


def main() -> int:
    jobs_dir = Path(sys.argv[1])
    job_id = sys.argv[2]
    store = JobStore(jobs_dir)
    job = store.get(job_id)
    if job is None:
        print(f"no such job: {job_id}", file=sys.stderr)
        return 1

    store.update(job_id, status="running", started_at=time.time())

    try:
        episode, _settings = build_episode(job["event_id"], job.get("episode_overrides"),
                                            bool(job.get("finale")), Settings.load())
        filters = MineFilters(**(job.get("filters") or {}))
        top_rows, total_valid = run_mine(
            job["event_id"], episode, int(job.get("runs", 300)), int(job.get("top", 10)),
            filters, start_seed=int(job.get("start_seed", 1)), processes=job.get("processes"),
        )
        store.update(job_id, status="done", finished_at=time.time(),
                     result={"top_rows": top_rows, "total_valid": total_valid})
        return 0
    except Exception as e:  # noqa: BLE001 -- report, never crash the API
        store.update(job_id, status="error", finished_at=time.time(),
                     error=f"{e}\n{traceback.format_exc()}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
