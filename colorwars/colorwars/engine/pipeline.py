"""Orchestrates the four pipeline stages for any Event, the league-driven
episode construction, and find_seed(). Rendering never writes season.json
-- only commit_episode() does, and only when the caller explicitly runs
`colorwars commit <episode_id>` after actually posting.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from ..audio.mix import build_bus, write_wav
from ..league import season as season_lib
from ..league.names_queue import consume_names, peek_names
from ..league.storylines import pick_hook_and_teaser
from ..league.theme import load_or_build_theme
from ..render.video import append_end_card, extract_cover, mux_audio, render_video
from .config import Settings, Team, load_episode, load_event_config, load_teams
from .event import Event
from .records import SimRecord, Timeline

# must match scripts/render-endcard.mjs's own hardcoded -t 2.0
END_CARD_SEC = 2.0

EVENT_HASHTAGS = {
    "ring_of_doom": ["ringofdoom", "lastballstanding"],
    "shell_shuffle": ["shellshuffle", "findtheball"],
    "disaster_drop": ["disasterdrop", "marblerace"],
    "turf_war": ["turfwar", "territory"],
    "great_escape": ["greatescape", "ringbreak"],
    "champion_duel": ["championduel", "1v1"],
}


def load_common(repo_root: Path, event_id: str) -> tuple[Settings, list[Team], dict, dict]:
    """Legacy path: episode comes from the hand-edited config/episode.yaml.
    Still used as the bootstrap fallback by build_episode_from_season() when
    no season exists yet, and directly by callers that explicitly want the
    static file rather than the league-driven one."""
    settings = Settings.load(repo_root)
    teams = load_teams(settings.teams_path)
    event_cfg = load_event_config(repo_root, event_id)
    episode = load_episode(settings.episode_path)
    return settings, teams, event_cfg, episode


def build_episode_from_season(repo_root: Path, event_id: str, is_finale: bool = False) -> tuple[Settings, list[Team], dict, dict, dict]:
    """The Phase 2 default: episode.yaml's old hand-edited fields (crown
    team, standings, hook line, teaser) are now all derived from
    league/season.json automatically. Returns (settings, teams, event_cfg,
    episode, season) -- season is handed back too so callers (render,
    mine) don't need to reload it."""
    settings = Settings.load(repo_root)
    teams = load_teams(settings.teams_path)
    event_cfg = load_event_config(repo_root, event_id)
    team_ids = [t.id for t in teams]
    teams_by_id = {t.id: t for t in teams}

    season = season_lib.load_season(settings.season_path, team_ids)

    episode_number = len(season["episodes"]) + 1
    episode_id = f"ep{episode_number:03d}"
    crown = season_lib.crown_team_id(season) or team_ids[0]
    last_place = season_lib.last_place_team_id(season)
    hook_line, teaser = pick_hook_and_teaser(season, teams_by_id)
    standings_points = {tid: row["points"] for tid, row in season["standings"].items()}
    # season-wide, not episode-specific -- only Great Escape consumes this
    # so far, but it lives here (like crown_team/standings) rather than
    # being threaded through a wider Event interface for one event's sake.
    theme_notes = load_or_build_theme(season["season_number"], settings.theme_path)

    episode = {
        "number": episode_number,
        "id": episode_id,
        "crown_team": crown,
        "last_place_team_id": last_place,
        "hook_line": hook_line,
        "standings": standings_points,
        "teaser": teaser,
        "is_finale": is_finale,
        "theme_notes": theme_notes,
    }
    return settings, teams, event_cfg, episode, season


def find_seed(event: Event, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict,
              start_seed: int = 1, max_tries: int = 500) -> int:
    for seed in range(start_seed, start_seed + max_tries):
        record = event.simulate(seed, settings, event_cfg, teams, episode)
        if event.is_valid(record):
            return seed
    raise RuntimeError(f"no valid seed found in {max_tries} tries starting at {start_seed}")


def run_render(
    event: Event,
    seed: int,
    settings: Settings,
    event_cfg: dict,
    teams: list[Team],
    episode: dict,
    out_dir: Path,
    preview: bool = False,
    volume_mult: float = 1.0,
    on_frame=None,
    should_cancel=None,
) -> dict:
    record: SimRecord = event.simulate(seed, settings, event_cfg, teams, episode)
    if not event.is_valid(record):
        raise RuntimeError(
            f"seed {seed} did not produce a valid run (no single survivor by the sim deadline) -- "
            f"use `find-seed` to get one that does."
        )

    fps = settings.preview_fps if preview else settings.fps
    width = settings.preview_width if preview else settings.width
    height = settings.preview_height if preview else settings.height

    timeline: Timeline = event.direct(record, settings, event_cfg, episode, fps)

    out_dir.mkdir(parents=True, exist_ok=True)
    video_only = out_dir / "_video_only.mp4"
    render_video(event, record, timeline, settings, teams, event_cfg, video_only, width, height, fps,
                 on_frame=on_frame, should_cancel=should_cancel)

    bus = build_bus(timeline.audio_cues, event.sound_voice, settings.sample_rate, timeline.duration_sec(),
                     volume_mult=volume_mult)
    wav_path = out_dir / "_audio.wav"
    write_wav(bus, settings.sample_rate, wav_path)

    final_path = out_dir / "final.mp4"
    mux_audio(video_only, wav_path, final_path, settings.ffmpeg_path, settings.target_lufs)

    # cover_frame_index is each event's own call (Ring of Doom: its best
    # near miss in the final two; Shell Shuffle: the 1st-place reveal) --
    # the shared pipeline just honors it instead of re-deriving a "best
    # frame" from Ring of Doom's own event vocabulary (near_miss) here.
    cover_path = out_dir / "cover.png"
    extract_cover(final_path, cover_path, timeline.cover_frame_index / fps, settings.ffmpeg_path)

    # the branded follow/CTA card, held for its own full length at the end
    # of every real (non-preview) render -- by request. After cover
    # extraction, not before: the cover image should show a real gameplay
    # moment, never the end card.
    if not preview:
        append_end_card(final_path, settings.end_card_path, settings.ffmpeg_path, fps)

    video_only.unlink(missing_ok=True)
    wav_path.unlink(missing_ok=True)

    drama = event.drama_stats(record, episode)

    # which names (per team) this render actually used -- commit() needs this
    # to dequeue the right entries from names.txt; peek_names() is read-only
    # so this doesn't touch the queue itself. Per-team ball count is read off
    # the actual SimRecord rather than event_cfg, since that count is a
    # different shape per event (Ring of Doom: 4 physics balls per team;
    # Shell Shuffle: 1 cup-ball per team) and record.balls is always right.
    # Defaults to 0, not 1: Champion Duel is 1v1, so the two teams NOT in
    # record.balls this episode genuinely used zero names, not one.
    per_team_counts: dict[str, int] = {}
    for b in record.balls:
        per_team_counts[b.team_id] = per_team_counts.get(b.team_id, 0) + 1
    names_used = {t.name: peek_names(t.name, per_team_counts.get(t.id, 0), settings.names_path, settings.blocklist_path)
                  for t in teams}

    meta = {
        "seed": seed,
        "event": event.id,
        "episode_id": episode.get("id"),
        "episode_number": episode.get("number"),
        "is_finale": bool(episode.get("is_finale", False)),
        # the real final file's length -- includes the appended end card
        # (below) on a non-preview render, since that's genuinely part of
        # what gets posted now.
        "duration_sec": timeline.duration_sec() + (0.0 if preview else END_CARD_SEC),
        "placements": record.placements,
        "mvp": record.mvp_name,
        "winner": record.winner_team_id,
        "crown_team_before": episode.get("crown_team"),
        "names_used": names_used,
        "stats": {
            "sim_duration_sec": record.sim_duration_sec(),
            "collisions": sum(1 for e in record.events if e.kind == "collision"),
            "eliminations": sum(1 for e in record.events if e.kind == "elimination"),
            "hazards": sum(1 for e in record.events if e.kind == "hazard"),
            "shields_used": sum(1 for e in record.events if e.kind == "shield"),
        },
        "drama": drama,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    _write_caption(out_dir, event.id, episode, record, meta)
    _write_pinned_comment(out_dir, teams)

    return meta


def _write_caption(out_dir: Path, event_id: str, episode: dict, record: SimRecord, meta: dict) -> None:
    ep_num = episode.get("number", "?")
    event_title = "Ring of Doom" if event_id == "ring_of_doom" else event_id.replace("_", " ").title()

    if event_id == "ring_of_doom":
        # simplified by request -- no hook line, no MVP shoutout, no
        # hashtags, just this exact two-line caption.
        body = f"{event_title}, Episode {ep_num}\n\nComment Who Will Win"
    else:
        hook = episode.get("hook_line", "")
        tags = ["colorwars", "simulation"] + EVENT_HASHTAGS.get(event_id, [])
        hashtag_line = " ".join(f"#{t}" for t in tags)
        body = (
            f"{event_title}, Episode {ep_num}\n\n"
            f"{hook}\n\n"
            f"MVP shoutout: {record.mvp_name} carried the whole episode.\n\n"
            f"{hashtag_line}"
        )
    # "Never use dashes in captions" -- a hard guarantee, not just a style
    # choice in the generated text above, in case a future storyline string adds one.
    body = body.replace("—", ",").replace("–", ",").replace("-", " ")
    (out_dir / "caption.txt").write_text(body, encoding="utf-8")


def _write_pinned_comment(out_dir: Path, teams: list[Team]) -> None:
    team_names = ", ".join(t.name for t in teams)
    text = (
        "Comment your team and a name to get a ball in the next episode!\n"
        f"({team_names})"
    )
    (out_dir / "pinned_comment.txt").write_text(text, encoding="utf-8")


def commit_episode(settings: Settings, teams: list[Team], out_dir: Path) -> dict:
    """The ONLY function that writes league/season.json. Reads the already-
    rendered episode's meta.json, applies it to the season, dequeues the
    names it actually used from names.txt into names_used.txt. Call this
    once, after the episode has actually been posted."""
    meta_path = out_dir / "meta.json"
    if not meta_path.exists():
        raise RuntimeError(f"no meta.json in {out_dir} -- render this episode first")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))

    team_ids = [t.id for t in teams]
    season = season_lib.load_season(settings.season_path, team_ids)

    episode_id = meta["episode_id"] or out_dir.name
    season_lib.apply_episode(
        season,
        episode_id=episode_id,
        event_id=meta["event"],
        seed=meta["seed"],
        placements=meta["placements"],
        mvp=meta["mvp"],
        date=date.today().isoformat(),
        is_finale=meta.get("is_finale", False),
        duration_sec=meta["duration_sec"],
        drama=meta.get("drama", {}),
    )
    winner_team = meta["placements"][0] if meta.get("placements") else None
    if winner_team:
        season_lib.set_fastest_win(season, episode_id, winner_team, meta["stats"]["sim_duration_sec"])

    season_lib.save_season(season, settings.season_path)

    names_used = meta.get("names_used", {})
    if names_used:
        consume_names(names_used, settings.names_path, settings.names_used_path)

    return season
