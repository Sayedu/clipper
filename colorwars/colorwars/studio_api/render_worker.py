"""python -m colorwars.studio_api.render_worker <jobs_dir> <job_id>

Runs one render job to completion in its own process (so "cancel" is a
real SIGTERM/process kill, and a crash in one render can't take the API
down). Spawned with exactly two arguments, both server-controlled (a
fixed directory, a uuid4 this same process generated) -- never a string
built from request data.
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

from ..engine.pipeline import run_render
from ..engine.registry import get_event
from .engine_helpers import apply_overrides, build_episode, names_path_for
from .jobs import JobStore, job_is_canceled


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
        settings, teams, event_cfg = apply_overrides(job["event_id"], job.get("overrides") or {})
        episode, settings = build_episode(job["event_id"], job.get("episode_overrides"),
                                           bool(job.get("finale")), settings)
        names_path = names_path_for(settings, job.get("episode_overrides"), jobs_dir / f"{job_id}_scratch")
        if names_path != settings.names_path:
            import dataclasses
            settings = dataclasses.replace(settings, names_path=names_path)

        event = get_event(job["event_id"])
        out_dir = Path(job["out_dir"])

        def on_frame(done: int, total: int) -> None:
            if done % 5 == 0 or done == total:
                store.update(job_id, frames_done=done, total_frames=total)

        def should_cancel() -> bool:
            return job_is_canceled(jobs_dir, job_id)

        meta = run_render(
            event, int(job["seed"]), settings, event_cfg, teams, episode, out_dir,
            preview=job.get("mode") == "preview",
            volume_mult=float(job.get("volume_mult", 1.0)),
            on_frame=on_frame,
            should_cancel=should_cancel,
        )
        # run_render()'s own meta.json has no notion of "the Studio config
        # that produced this" -- only seed/winner/placements/etc, which are
        # derived outcomes, not the inputs. The Library's "render again with
        # these settings" button needs the actual inputs back, and needs them
        # to still work after this job record itself is long gone (job files
        # aren't kept forever the way out/<episode>/ is), so they're folded
        # into meta.json itself rather than left only in the job store.
        meta["studio_overrides"] = job.get("overrides") or {}
        meta["studio_episode_overrides"] = job.get("episode_overrides") or {}
        (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

        store.update(job_id, status="done", finished_at=time.time(),
                     result={"out_dir": str(out_dir), "meta": meta})
        return 0
    except RuntimeError as e:
        if "canceled" in str(e):
            # a canceled render never produced a usable output -- leaving its
            # half-written _video_only.mp4 and empty dir behind would just
            # accumulate as clutter every time someone cancels (this job
            # system expects to be run and canceled many times over).
            import shutil
            shutil.rmtree(out_dir, ignore_errors=True)
            store.update(job_id, status="canceled", finished_at=time.time())
            return 0
        store.update(job_id, status="error", finished_at=time.time(),
                     error=f"{e}\n{traceback.format_exc()}")
        return 1
    except Exception as e:  # noqa: BLE001 -- a render job's own errors must never crash the API, just be reported
        store.update(job_id, status="error", finished_at=time.time(),
                     error=f"{e}\n{traceback.format_exc()}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
