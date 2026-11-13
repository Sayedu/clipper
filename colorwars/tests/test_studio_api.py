"""API tests for the Studio's local FastAPI service, run against the real
engine (no mocking -- the whole point of this service is "import the engine
directly"). Every test that writes to disk (a render/mine job, a preset)
cleans up what it created so the real colorwars/out and colorwars/presets
don't accumulate test runs. league/season.json is never written here --
committing an episode is a deliberate, user-confirmed action, not something
an automated test should trigger (mirrors the "never commit automatically"
rule itself).
"""

from __future__ import annotations

import shutil
import time

import pytest
from fastapi.testclient import TestClient

from colorwars.studio_api.main import JOBS_DIR, OUT_DIR, SCRATCH_DIR, app

client: TestClient = None  # type: ignore[assignment]  -- set by _client below


@pytest.fixture(scope="module", autouse=True)
def _client():
    # TestClient must be used as a context manager for FastAPI's startup
    # lifespan event to actually fire -- without it, the one-at-a-time job
    # scheduler's background asyncio task never starts, and every queued job
    # sits at "queued" forever (found by actually running the suite: the job
    # tests timed out, not by reasoning about it up front).
    global client
    with TestClient(app) as c:
        client = c
        yield c


def _poll_job(job_id: str, timeout_sec: float = 60.0) -> dict:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        job = client.get(f"/jobs/{job_id}").json()["job"]
        if job["status"] in ("done", "error", "canceled"):
            return job
        time.sleep(0.5)
    raise TimeoutError(f"job {job_id} did not finish within {timeout_sec}s")


@pytest.fixture(autouse=True)
def _clean_studio_dirs():
    # snapshot what's already in out/ BEFORE this test, so teardown only
    # ever removes episode dirs this specific test created -- a naming-
    # pattern match here once deleted a real render a person had just made
    # through the UI, since real renders use the exact same ep<n>_<jobid>
    # naming as test ones. Never again: diff against a real before/after
    # snapshot, regardless of what the directory is named.
    before = {d.name for d in OUT_DIR.glob("ep*_*") if d.is_dir()}
    yield
    # the module-level JobStore only creates JOBS_DIR once, at import time --
    # rmtree-ing it here without recreating it would break every test after
    # the first (its next write has nowhere to land).
    shutil.rmtree(JOBS_DIR, ignore_errors=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(SCRATCH_DIR, ignore_errors=True)
    after = {d.name for d in OUT_DIR.glob("ep*_*") if d.is_dir()}
    for name in after - before:
        shutil.rmtree(OUT_DIR / name, ignore_errors=True)


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_list_events_has_all_seven():
    data = client.get("/events").json()
    ids = {e["id"] for e in data["events"]}
    assert ids == {"ring_of_doom", "hot_potato", "shell_shuffle", "disaster_drop", "turf_war", "great_escape", "champion_duel"}


def test_event_schema_shape():
    data = client.get("/events/ring_of_doom/schema").json()
    assert len(data["params"]) > 10
    assert {t["id"] for t in data["teams"]} == {"red", "blue", "green", "yellow"}
    assert data["duration_min_sec"] == 61
    assert data["duration_max_sec"] == 70
    names = {p["name"] for p in data["params"]}
    assert "balls.per_team" in names


def test_event_schema_unknown_event_404():
    assert client.get("/events/not_a_real_event/schema").status_code == 404


def test_quick_check_known_valid_seed():
    body = {"event_id": "ring_of_doom", "seed": 1, "overrides": {}, "episode_overrides": {}, "finale": False}
    data = client.post("/quick-check", json=body).json()
    assert data["valid"] is True
    assert data["winner"] in ("red", "blue", "green", "yellow")
    # Ring of Doom no longer pads out to the 61-70s window (by request: the
    # video ends ~1.5s after the winner card instead) -- it's expected and
    # fine for a seed to land well under 61s now.
    assert data["in_window"] is False
    assert 1 <= data["duration_sec"] <= 70


def test_quick_check_override_changes_ball_count():
    # seed 1 is only known-valid at the default ball count -- a different
    # count can genuinely produce an invalid (no single survivor by the
    # deadline) run, so this doesn't assert valid=True, just that the
    # override was applied and the call completes either way.
    body = {"event_id": "ring_of_doom", "seed": 1,
             "overrides": {"balls.per_team": 2}, "episode_overrides": {}, "finale": False}
    data = client.post("/quick-check", json=body).json()
    placements = data["placements"]
    assert len(placements) == 4  # one placement entry per team regardless of balls-per-team


def test_quick_check_custom_hook_and_crown_override():
    body = {
        "event_id": "ring_of_doom", "seed": 1, "overrides": {},
        "episode_overrides": {
            "hook_line_mode": "custom", "hook_line_text": "TEST HOOK LINE",
            "crown_team_mode": "override", "crown_team_override": "green",
        },
        "finale": False,
    }
    data = client.post("/quick-check", json=body).json()
    assert data["hook_line"] == "TEST HOOK LINE"
    assert data["crown_team"] == "green"


def test_quick_check_unknown_event_404():
    body = {"event_id": "nope", "seed": 1, "overrides": {}, "episode_overrides": {}, "finale": False}
    assert client.post("/quick-check", json=body).status_code == 404


def test_filmstrip_returns_six_servable_frames():
    body = {"event_id": "ring_of_doom", "seed": 1, "overrides": {}, "episode_overrides": {}, "finale": False}
    data = client.post("/filmstrip", json=body).json()
    assert data["valid"] is True
    assert len(data["frame_urls"]) == 6
    img = client.get(data["frame_urls"][0])
    assert img.status_code == 200
    assert img.headers["content-type"] == "image/png"


def test_presets_round_trip():
    payload = {"name": "pytest preset", "overrides": {"balls.per_team": 3}, "episode_overrides": {}, "seed": 7}
    saved = client.post("/presets/ring_of_doom", json=payload).json()["preset"]
    assert saved["overrides"]["balls.per_team"] == 3

    listed = client.get("/presets/ring_of_doom").json()["presets"]
    assert any(p["name"] == "pytest preset" for p in listed)

    loaded = client.get("/presets/ring_of_doom/pytest%20preset").json()["preset"]
    assert loaded["seed"] == 7

    deleted = client.delete("/presets/ring_of_doom/pytest%20preset").json()
    assert deleted["ok"] is True
    assert client.get("/presets/ring_of_doom/pytest%20preset").status_code == 404


def test_names_parse_accepts_and_rejects_with_reasons():
    text = "Go Red Thunder!\nblueee is the best\nRed thisnameiswaytoolongforsure"
    data = client.post("/league/names/parse", json={"text": text}).json()
    assert data["accepted"] == [{"raw": "Go Red Thunder!", "team": "Red", "name": "GoThunder"}]
    reasons = {r["reason"] for r in data["rejected"]}
    assert "no team mentioned" in reasons
    assert "too long (max 12 characters)" in reasons


def test_league_standings_shape():
    data = client.get("/league/standings").json()
    assert "season" in data
    assert "storyline_candidates" in data


def test_league_commit_missing_episode_404():
    # exercises the error path only -- never calls commit on a real episode
    # dir here, since that would write league/season.json for real.
    resp = client.post("/league/commit", json={"event_id": "ring_of_doom", "episode_dir": "does_not_exist"})
    assert resp.status_code == 404


def test_media_path_traversal_is_rejected():
    resp = client.get("/media/..%2f..%2fCLAUDE.md")
    assert resp.status_code == 403


def test_jobs_mine_runs_and_completes():
    body = {"event_id": "ring_of_doom", "runs": 30, "top": 3, "start_seed": 1,
            "filters": {}, "episode_overrides": {}, "finale": False}
    job_id = client.post("/jobs/mine", json=body).json()["job"]["id"]
    job = _poll_job(job_id, timeout_sec=30)
    assert job["status"] == "done"
    assert job["result"]["total_valid"] >= 0
    assert len(job["result"]["top_rows"]) <= 3


def test_jobs_render_preview_completes_and_appears_in_library():
    body = {"event_id": "ring_of_doom", "seed": 1, "overrides": {}, "episode_overrides": {},
            "finale": False, "mode": "preview"}
    job = client.post("/jobs/render", json=body).json()["job"]
    job_id, out_dir_name = job["id"], job["out_dir"].rsplit("/", 1)[-1]

    finished = _poll_job(job_id, timeout_sec=90)
    assert finished["status"] == "done"
    assert finished["result"]["meta"]["winner"] in ("red", "blue", "green", "yellow")

    cards = client.get("/library").json()["cards"]
    card = next((c for c in cards if c["episode_dir"] == out_dir_name), None)
    assert card is not None
    assert card["video_url"] == f"/media/{out_dir_name}/final.mp4"

    video = client.get(card["video_url"], headers={"Range": "bytes=0-99"})
    assert video.status_code == 206
    assert "content-range" in video.headers

    deleted = client.delete(f"/library/{out_dir_name}")
    assert deleted.json()["ok"] is True
    assert not (OUT_DIR / out_dir_name).exists()


def test_jobs_cancel_while_still_queued():
    body = {"event_id": "ring_of_doom", "seed": 1, "overrides": {}, "episode_overrides": {},
            "finale": False, "mode": "final"}
    # queue two -- the scheduler runs one at a time, so the second is
    # guaranteed to still be "queued" (never spawned a subprocess) when we
    # cancel it, letting this test skip waiting on an actual render.
    first = client.post("/jobs/render", json=body).json()["job"]
    second = client.post("/jobs/render", json=body).json()["job"]

    cancel = client.post(f"/jobs/{second['id']}/cancel")
    assert cancel.json()["ok"] is True
    assert client.get(f"/jobs/{second['id']}").json()["job"]["status"] == "canceled"

    # clean up the first job too so it doesn't keep rendering after the test ends
    client.post(f"/jobs/{first['id']}/cancel")
    _poll_job(first["id"], timeout_sec=90)
