"""Shared logic the Studio's API routes and job workers both need: turning
a Setup-form payload (seed, dotted-path config overrides, team-trait
overrides, episode-level overrides) into the real settings/teams/event_cfg/
episode objects the engine's own pipeline functions take, without ever
mutating the files on disk that back a normal CLI render.
"""

from __future__ import annotations

import copy
import dataclasses
import tempfile
from pathlib import Path
from typing import Any

from ..engine.config import REPO_ROOT, Settings, Team, load_event_config, load_teams
from ..engine.params import set_dotted
from ..engine.pipeline import build_episode_from_season
from ..engine.records import SimRecord, Timeline
from ..engine.registry import get_event
from ..league.names_queue import read_queue_lines


def apply_overrides(event_id: str, overrides: dict[str, Any]) -> tuple[Settings, list[Team], dict]:
    """overrides is a flat {dotted.path: value} dict covering event_cfg
    paths (e.g. "balls.per_team") and team-trait paths ("team.red.duel_power").
    Returns (settings, teams, event_cfg) -- none of it touches disk."""
    settings = Settings.load(REPO_ROOT)
    teams = load_teams(settings.teams_path)
    event_cfg = copy.deepcopy(load_event_config(REPO_ROOT, event_id))

    team_overrides: dict[str, dict[str, Any]] = {}
    for path, value in overrides.items():
        if path.startswith("team."):
            _, tid, trait = path.split(".", 2)
            team_overrides.setdefault(tid, {})[trait] = value
        else:
            set_dotted(event_cfg, path, value)

    if team_overrides:
        new_teams = []
        for t in teams:
            if t.id in team_overrides:
                new_traits = {**t.traits, **team_overrides[t.id]}
                new_teams.append(Team(id=t.id, name=t.name, color=t.color, personality=t.personality, traits=new_traits))
            else:
                new_teams.append(t)
        teams = new_teams

    return settings, teams, event_cfg


def build_episode(event_id: str, episode_overrides: dict[str, Any] | None, finale: bool,
                   settings: Settings) -> tuple[dict, Settings]:
    """Returns (episode, settings) -- settings is handed back too since a
    duration-window override replaces it with a new instance (frozen
    dataclass, so this never touches config/settings.yaml on disk)."""
    episode_overrides = episode_overrides or {}
    _settings, _teams, _cfg, episode, _season = build_episode_from_season(REPO_ROOT, event_id, is_finale=finale)

    hook_mode = episode_overrides.get("hook_line_mode", "auto")
    if hook_mode == "custom" and episode_overrides.get("hook_line_text"):
        episode["hook_line"] = episode_overrides["hook_line_text"]

    crown_mode = episode_overrides.get("crown_team_mode", "auto")
    if crown_mode == "override" and episode_overrides.get("crown_team_override"):
        episode["crown_team"] = episode_overrides["crown_team_override"]

    duration_min = episode_overrides.get("duration_min_sec")
    duration_max = episode_overrides.get("duration_max_sec")
    if duration_min is not None or duration_max is not None:
        settings = dataclasses.replace(
            settings,
            duration_min_sec=float(duration_min) if duration_min is not None else settings.duration_min_sec,
            duration_max_sec=float(duration_max) if duration_max is not None else settings.duration_max_sec,
        )

    return episode, settings


def names_path_for(settings: Settings, episode_overrides: dict[str, Any] | None,
                    scratch_dir: Path) -> Path:
    """If the request supplies custom names, builds a scratch names.txt
    (custom names first, then the real queue's own entries as a fallback)
    and returns its path; otherwise returns the real queue path untouched.
    peek_names() is read-only either way -- this never calls consume_names()
    or writes to the real league/names.txt."""
    episode_overrides = episode_overrides or {}
    if episode_overrides.get("names_mode") != "custom":
        return settings.names_path
    custom: dict[str, list[str]] = episode_overrides.get("custom_names") or {}
    if not custom:
        return settings.names_path

    scratch_dir.mkdir(parents=True, exist_ok=True)
    scratch_path = scratch_dir / "names_scratch.txt"
    lines: list[str] = []
    for team_name, names in custom.items():
        for name in names:
            if name.strip():
                lines.append(f"{team_name} {name.strip()}")
    for team_name, raw in read_queue_lines(settings.names_path):
        lines.append(f"{team_name} {raw}")
    scratch_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return scratch_path


def quick_check(event_id: str, seed: int, overrides: dict[str, Any],
                 episode_overrides: dict[str, Any] | None, finale: bool = False) -> dict:
    """simulate() + direct() only -- no render, back in well under a
    second for every event in this project (none of them need pymunk to
    take longer than that for a single seed)."""
    settings, teams, event_cfg = apply_overrides(event_id, overrides)
    episode, settings = build_episode(event_id, episode_overrides, finale, settings)

    with tempfile.TemporaryDirectory() as scratch:
        names_path = names_path_for(settings, episode_overrides, Path(scratch))
        if names_path != settings.names_path:
            settings = dataclasses.replace(settings, names_path=names_path)

        event = get_event(event_id)
        record: SimRecord = event.simulate(seed, settings, event_cfg, teams, episode)
        valid = event.is_valid(record)
        timeline: Timeline | None = None
        duration_sec = None
        in_window = False
        if valid:
            timeline = event.direct(record, settings, event_cfg, episode, settings.fps)
            duration_sec = timeline.duration_sec()
            in_window = settings.duration_min_sec <= duration_sec <= settings.duration_max_sec
        drama = event.drama_stats(record, episode) if valid else {}

        timeline_events = [
            {"t": round(e.t, 2), "kind": e.kind, "data": e.data}
            for e in sorted(record.events, key=lambda e: e.t)
        ]

        return {
            "valid": valid,
            "winner": record.winner_team_id,
            "placements": record.placements,
            "mvp": record.mvp_name,
            "duration_sec": duration_sec,
            "in_window": in_window,
            "duration_min_sec": settings.duration_min_sec,
            "duration_max_sec": settings.duration_max_sec,
            "drama": drama,
            "timeline_events": timeline_events[:200],  # a long run can log a lot; the panel only needs "key moments"
            "hook_line": episode.get("hook_line"),
            "teaser": episode.get("teaser"),
            "crown_team": episode.get("crown_team"),
        }
