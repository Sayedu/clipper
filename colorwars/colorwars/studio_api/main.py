"""The Studio's local API. Binds to 127.0.0.1 only (see run.py); the
website never talks to it directly either -- Next.js proxies /colorwars-api/*
to this process server-side, so the browser only ever sees one origin.

Render/mine jobs run one at a time: a single background asyncio task picks
the oldest queued job and awaits its subprocess before looking for the
next one. Nothing here ever builds a shell command from request data --
job ids are server-generated uuid4 hex strings, passed to subprocesses as
plain argv entries, never interpolated into a command string.
"""

from __future__ import annotations

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..engine.config import REPO_ROOT, Settings, load_event_config, load_teams
from ..engine.pipeline import build_episode_from_season, commit_episode
from ..engine.registry import KNOWN_EVENT_IDS, get_event
from ..league import season as season_lib
from ..league.names_queue import read_queue_lines
from ..league.storylines import generate_candidates
from .engine_helpers import apply_overrides
from .filmstrip import render_filmstrip
from .jobs import JobStore
from .names_parser import append_to_queue, parse_raw_comments
from .presets import delete_preset, list_presets, load_preset, save_preset

OUT_DIR = REPO_ROOT / "out"
JOBS_DIR = OUT_DIR / "_studio_jobs"
SCRATCH_DIR = OUT_DIR / "_studio_scratch"
jobs = JobStore(JOBS_DIR)

_new_job_event: asyncio.Event | None = None


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _new_job_event
    _new_job_event = asyncio.Event()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    task = asyncio.create_task(_scheduler_loop())
    yield
    task.cancel()


app = FastAPI(title="colorwars studio api", lifespan=_lifespan)


async def _scheduler_loop() -> None:
    assert _new_job_event is not None
    worker_by_kind = {"render": "colorwars.studio_api.render_worker", "mine": "colorwars.studio_api.mine_worker"}
    while True:
        queued = [j for j in jobs.list() if j["status"] == "queued"]
        queued.sort(key=lambda j: j["created_at"])
        if not queued:
            _new_job_event.clear()
            await _new_job_event.wait()
            continue
        job = queued[0]
        module = worker_by_kind.get(job["kind"])
        if module is None:
            jobs.update(job["id"], status="error", error=f"unknown job kind {job['kind']!r}")
            continue
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", module, str(JOBS_DIR), job["id"],
            cwd=str(REPO_ROOT),
        )
        await proc.wait()
        # if the worker crashed before writing its own error (e.g. killed),
        # make sure the job doesn't stay stuck at "running" forever.
        current = jobs.get(job["id"])
        if current and current["status"] == "running":
            jobs.update(job["id"], status="error", error=f"worker exited with code {proc.returncode}")


def _wake_scheduler() -> None:
    if _new_job_event is not None:
        _new_job_event.set()


# ----------------------------------------------------------------- events --

@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/events")
def list_events() -> dict:
    out = []
    for eid in KNOWN_EVENT_IDS:
        event = get_event(eid)
        out.append({"id": event.id, "display_name": event.display_name})
    return {"events": out}


@app.get("/events/{event_id}/schema")
def event_schema(event_id: str) -> dict:
    _require_known_event(event_id)
    event = get_event(event_id)
    event_cfg = load_event_config(REPO_ROOT, event_id)
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    specs = event.params_schema(event_cfg, teams)
    return {
        "event_id": event_id,
        "params": [s.to_dict() for s in specs],
        "teams": [{"id": t.id, "name": t.name, "color": t.color, "traits": t.traits} for t in teams],
        "duration_min_sec": settings.duration_min_sec,
        "duration_max_sec": settings.duration_max_sec,
    }


def _require_known_event(event_id: str) -> None:
    if event_id not in KNOWN_EVENT_IDS:
        raise HTTPException(404, f"unknown event: {event_id!r}")


# ------------------------------------------------------------ quick check --

class RunConfig(BaseModel):
    event_id: str
    seed: int
    overrides: dict[str, Any] = Field(default_factory=dict)
    episode_overrides: dict[str, Any] = Field(default_factory=dict)
    finale: bool = False


@app.post("/quick-check")
def quick_check_route(body: RunConfig) -> dict:
    _require_known_event(body.event_id)
    from .engine_helpers import quick_check

    try:
        return quick_check(body.event_id, body.seed, body.overrides, body.episode_overrides, body.finale)
    except Exception as e:  # noqa: BLE001 -- surfaced to the UI as a readable error, not a 500 stack trace
        raise HTTPException(400, str(e)) from e


@app.post("/filmstrip")
def filmstrip_route(body: RunConfig) -> dict:
    _require_known_event(body.event_id)
    scratch = SCRATCH_DIR / f"filmstrip_{os.getpid()}_{body.seed}"
    try:
        result = render_filmstrip(body.event_id, body.seed, body.overrides, body.episode_overrides,
                                   body.finale, scratch)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e
    if not result["valid"]:
        return {"valid": False, "frame_urls": []}
    scratch.mkdir(parents=True, exist_ok=True)
    urls = []
    for i, png in enumerate(result["frames"]):
        path = scratch / f"frame_{i}.png"
        path.write_bytes(png)
        urls.append(f"/media/_studio_scratch/{scratch.name}/frame_{i}.png")
    return {"valid": True, "frame_urls": urls, "frame_indices": result["frame_indices"]}


# ----------------------------------------------------------------- presets --

class PresetBody(BaseModel):
    name: str
    overrides: dict[str, Any] = Field(default_factory=dict)
    episode_overrides: dict[str, Any] = Field(default_factory=dict)
    seed: int | None = None


@app.get("/presets/{event_id}")
def presets_list(event_id: str) -> dict:
    return {"presets": list_presets(REPO_ROOT, event_id)}


@app.post("/presets/{event_id}")
def presets_save(event_id: str, body: PresetBody) -> dict:
    data = save_preset(REPO_ROOT, event_id, body.name,
                        {"overrides": body.overrides, "episode_overrides": body.episode_overrides, "seed": body.seed})
    return {"preset": data}


@app.get("/presets/{event_id}/{name}")
def presets_load(event_id: str, name: str) -> dict:
    data = load_preset(REPO_ROOT, event_id, name)
    if data is None:
        raise HTTPException(404, "no such preset")
    return {"preset": data}


@app.delete("/presets/{event_id}/{name}")
def presets_delete(event_id: str, name: str) -> dict:
    ok = delete_preset(REPO_ROOT, event_id, name)
    if not ok:
        raise HTTPException(404, "no such preset")
    return {"ok": True}


# -------------------------------------------------------------------- jobs --

class RenderJobBody(RunConfig):
    mode: str = "final"  # "final" | "preview"
    volume_mult: float = 1.0


class MineJobBody(BaseModel):
    event_id: str
    runs: int = 300
    top: int = 10
    start_seed: int = 1
    filters: dict[str, Any] = Field(default_factory=dict)
    episode_overrides: dict[str, Any] = Field(default_factory=dict)
    finale: bool = False


@app.post("/jobs/render")
def create_render_job(body: RenderJobBody) -> dict:
    _require_known_event(body.event_id)
    if body.mode not in ("final", "preview"):
        raise HTTPException(400, "mode must be 'final' or 'preview'")
    settings = Settings.load(REPO_ROOT)
    _s, _t, _c, episode, _season = build_episode_from_season(REPO_ROOT, body.event_id, is_finale=body.finale)
    # out_dir can't just be settings.out_dir / episode["id"]: that id comes
    # from season.json's current episode count, which doesn't move until
    # commit -- two renders queued before either is committed (exactly what
    # "Make N" does) would otherwise both resolve to e.g. out/ep004 and
    # overwrite each other. The job id (always unique) keeps each one apart;
    # the human-readable episode id is still in meta.json/caption for commit.
    job = jobs.create("render", {
        "event_id": body.event_id, "seed": body.seed, "overrides": body.overrides,
        "episode_overrides": body.episode_overrides, "finale": body.finale,
        "mode": body.mode, "volume_mult": body.volume_mult,
    })
    episode_label = episode.get("id", "ep000")
    out_dir = settings.out_dir / f"{episode_label}_{job['id'][:8]}"
    jobs.update(job["id"], out_dir=str(out_dir))
    job["out_dir"] = str(out_dir)
    _wake_scheduler()
    return {"job": job}


@app.post("/jobs/mine")
def create_mine_job(body: MineJobBody) -> dict:
    _require_known_event(body.event_id)
    job = jobs.create("mine", {
        "event_id": body.event_id, "runs": body.runs, "top": body.top, "start_seed": body.start_seed,
        "filters": body.filters, "episode_overrides": body.episode_overrides, "finale": body.finale,
    })
    _wake_scheduler()
    return {"job": job}


@app.get("/jobs")
def list_jobs() -> dict:
    return {"jobs": jobs.list()}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return {"job": job}


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    job = jobs.request_cancel(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    # a still-queued job (never started a subprocess) can be canceled immediately
    if job["status"] == "queued":
        jobs.update(job_id, status="canceled")
    return {"ok": True}


# "Make N" (randomize, mine, render -- N times in a row) has no dedicated
# route: randomization needs the params schema and the Setup form's lock
# state, which only the frontend has, so it composes the building blocks
# above itself -- randomize overrides, POST /jobs/mine, poll until done,
# POST /jobs/render with the winning seed/overrides, repeat N times. The
# one-at-a-time scheduler below already guarantees those jobs run in order
# without the frontend needing to wait for each one serially if it'd rather
# queue several and watch them drain.


# ----------------------------------------------------------------- library --

@app.get("/library")
def list_library() -> dict:
    cards = []
    if OUT_DIR.exists():
        for d in sorted(OUT_DIR.iterdir(), reverse=True):
            if not d.is_dir() or d.name.startswith("_"):
                continue
            meta_path = d / "meta.json"
            if not meta_path.exists():
                continue
            import json

            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            caption = (d / "caption.txt").read_text(encoding="utf-8") if (d / "caption.txt").exists() else ""
            pinned = (d / "pinned_comment.txt").read_text(encoding="utf-8") if (d / "pinned_comment.txt").exists() else ""
            cards.append({
                "episode_dir": d.name,
                "meta": meta,
                "caption": caption,
                "pinned_comment": pinned,
                "video_url": f"/media/{d.name}/final.mp4" if (d / "final.mp4").exists() else None,
                "cover_url": f"/media/{d.name}/cover.png" if (d / "cover.png").exists() else None,
            })
    return {"cards": cards}


@app.delete("/library/{episode_dir}")
def delete_library_item(episode_dir: str) -> dict:
    path = _safe_out_path(episode_dir)
    if not path.is_dir():
        raise HTTPException(404, "no such episode")
    import shutil

    shutil.rmtree(path)
    return {"ok": True}


def _safe_out_path(name: str) -> Path:
    if "/" in name or ".." in name or name.startswith("_"):
        raise HTTPException(400, "invalid episode directory")
    return OUT_DIR / name


# ------------------------------------------------------------------ league --

@app.get("/league/standings")
def league_standings() -> dict:
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    team_ids = [t.id for t in teams]
    season = season_lib.load_season(settings.season_path, team_ids)
    teams_by_id = {t.id: t for t in teams}
    candidates = generate_candidates(season, teams_by_id)
    candidates_sorted = sorted(candidates, key=lambda c: -c.score)
    return {
        "season": season,
        "crown_team": season_lib.crown_team_id(season),
        "last_place_team": season_lib.last_place_team_id(season),
        "storyline_candidates": [{"text": c.text, "score": c.score, "kind": c.kind} for c in candidates_sorted],
    }


class CommitBody(BaseModel):
    event_id: str
    episode_dir: str


@app.post("/league/commit")
def league_commit(body: CommitBody) -> dict:
    """Never called automatically -- only from this explicit route, which
    the UI only ever calls after the user confirms in a dialog."""
    _require_known_event(body.event_id)
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    out_dir = _safe_out_path(body.episode_dir)
    if not out_dir.is_dir():
        raise HTTPException(404, "no such episode")
    try:
        season = commit_episode(settings, teams, out_dir)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e
    return {"season": season}


@app.get("/league/names")
def league_names() -> dict:
    settings = Settings.load(REPO_ROOT)
    queue = read_queue_lines(settings.names_path)
    used: list[tuple[str, str]] = []
    if settings.names_used_path.exists():
        used = read_queue_lines(settings.names_used_path)
    return {
        "queue": [{"team": t, "name": n} for t, n in queue],
        "used": [{"team": t, "name": n} for t, n in used],
    }


class ParseNamesBody(BaseModel):
    text: str


@app.post("/league/names/parse")
def league_names_parse(body: ParseNamesBody) -> dict:
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    return parse_raw_comments(body.text, [t.name for t in teams], settings.blocklist_path)


class SaveNamesBody(BaseModel):
    accepted: list[dict]


@app.post("/league/names/save")
def league_names_save(body: SaveNamesBody) -> dict:
    settings = Settings.load(REPO_ROOT)
    n = append_to_queue(settings.names_path, body.accepted)
    return {"saved": n}


# ------------------------------------------------------------------- media --

@app.get("/media/{path:path}")
def media(path: str):
    # the only files this API ever serves -- resolved and checked against
    # OUT_DIR so "../.." can't walk it anywhere else on disk.
    candidate = (OUT_DIR / path).resolve()
    try:
        candidate.relative_to(OUT_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "forbidden") from None
    if not candidate.is_file():
        raise HTTPException(404, "no such file")
    return FileResponse(candidate)
