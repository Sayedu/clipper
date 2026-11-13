"""Disk-backed job state -- a page refresh never loses a job because
nothing about a job lives only in memory. Each job is one JSON file under
out/_studio_jobs/<job_id>.json, written atomically (temp file + rename) so
a crash mid-write can never leave a half-written, unparseable file behind.

Render/mine jobs actually RUN in their own subprocess (render_worker.py /
mine_worker.py), spawned with a job id as the only argument -- never a
user-supplied string built into a shell command. The subprocess owns
writing its own progress into this same file; the API process (and the
scheduler below) only ever reads it back or flips status to "canceled".
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Literal

JobKind = Literal["render", "mine"]
JobStatus = Literal["queued", "running", "done", "error", "canceled"]


class JobStore:
    def __init__(self, jobs_dir: Path):
        self.jobs_dir = jobs_dir
        self.jobs_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, job_id: str) -> Path:
        # job ids are always ones *we* generated (uuid4 hex) -- never taken
        # from a request path segment without this check, so a client can't
        # walk the job store out of its directory.
        if not job_id.isalnum():
            raise ValueError("invalid job id")
        return self.jobs_dir / f"{job_id}.json"

    def create(self, kind: JobKind, payload: dict[str, Any]) -> dict:
        job_id = uuid.uuid4().hex
        job = {
            "id": job_id,
            "kind": kind,
            "status": "queued",
            "created_at": time.time(),
            "started_at": None,
            "finished_at": None,
            "frames_done": 0,
            "total_frames": None,
            "error": None,
            "result": None,
            "cancel_requested": False,
            **payload,
        }
        self._write(job)
        return job

    def get(self, job_id: str) -> dict | None:
        path = self._path(job_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def list(self) -> list[dict]:
        jobs = []
        for p in self.jobs_dir.glob("*.json"):
            try:
                jobs.append(json.loads(p.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                continue
        jobs.sort(key=lambda j: j.get("created_at", 0), reverse=True)
        return jobs

    def update(self, job_id: str, **fields: Any) -> dict | None:
        job = self.get(job_id)
        if job is None:
            return None
        job.update(fields)
        self._write(job)
        return job

    def request_cancel(self, job_id: str) -> dict | None:
        return self.update(job_id, cancel_requested=True)

    def _write(self, job: dict) -> None:
        path = self._path(job["id"])
        tmp = path.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(json.dumps(job, indent=2, default=str), encoding="utf-8")
        tmp.replace(path)


def write_progress(jobs_dir: Path, job_id: str, **fields: Any) -> None:
    """Used by the worker subprocess itself -- a thin wrapper so it doesn't
    need the full JobStore (and its job-id validation, irrelevant once the
    id is already known-good) just to patch a few fields."""
    store = JobStore(jobs_dir)
    store.update(job_id, **fields)


def job_is_canceled(jobs_dir: Path, job_id: str) -> bool:
    store = JobStore(jobs_dir)
    job = store.get(job_id)
    return bool(job and job.get("cancel_requested"))


if __name__ == "__main__":
    # tiny manual smoke check: `python -m colorwars.studio_api.jobs`
    store = JobStore(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/colorwars_jobs_smoke"))
    j = store.create("render", {"event_id": "ring_of_doom", "seed": 1})
    print(store.get(j["id"]))
