"""Loads the YAML/text config files under config/ into plain Python objects.
Nothing here is hardcoded game data -- every number an event uses to
simulate or direct comes from one of these files.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_yaml(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


@dataclass(frozen=True)
class Team:
    id: str
    name: str
    color: str
    personality: str
    traits: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Settings:
    width: int
    height: int
    fps: int
    preview_width: int
    preview_height: int
    preview_fps: int
    safe_x_min: int
    safe_x_max: int
    safe_y_min: int
    safe_y_max: int
    sample_rate: int
    target_lufs: float
    ffmpeg_path: str
    duration_min_sec: float
    duration_max_sec: float
    background_color: str
    font_heavy: Path
    font_label: Path
    end_card_path: Path
    out_dir: Path
    teams_path: Path
    names_path: Path
    blocklist_path: Path
    episode_path: Path
    season_path: Path
    names_used_path: Path
    theme_path: Path

    @staticmethod
    def load(repo_root: Path = REPO_ROOT) -> "Settings":
        raw = _load_yaml(repo_root / "config" / "settings.yaml")
        res = raw["resolution"]
        prev = raw["preview"]
        safe = raw["safe_area"]
        audio = raw["audio"]
        dur = raw["duration"]
        fonts = raw["fonts"]
        paths = raw["paths"]
        return Settings(
            width=res["width"],
            height=res["height"],
            fps=raw["fps"],
            preview_width=prev["width"],
            preview_height=prev["height"],
            preview_fps=prev["fps"],
            safe_x_min=safe["x_min"],
            safe_x_max=safe["x_max"],
            safe_y_min=safe["y_min"],
            safe_y_max=safe["y_max"],
            sample_rate=audio["sample_rate"],
            target_lufs=audio["target_lufs"],
            # the configured path is a local macOS dev workaround (this
            # machine's bare `ffmpeg` is broken -- see settings.yaml's own
            # comment); CI (Ubuntu, apt-installed ffmpeg, no such path)
            # overrides it with this env var instead of editing the YAML.
            ffmpeg_path=os.environ.get("COLORWARS_FFMPEG_PATH", raw["ffmpeg_path"]),
            duration_min_sec=dur["min_sec"],
            duration_max_sec=dur["max_sec"],
            background_color=raw["background_color"],
            font_heavy=repo_root / fonts["heavy"],
            font_label=repo_root / fonts["label"],
            end_card_path=repo_root / raw["end_card"],
            out_dir=repo_root / paths["out_dir"],
            teams_path=repo_root / paths["teams"],
            names_path=repo_root / paths["names"],
            blocklist_path=repo_root / paths["blocklist"],
            episode_path=repo_root / paths["episode"],
            season_path=repo_root / paths["season"],
            names_used_path=repo_root / paths["names_used"],
            theme_path=repo_root / paths["theme"],
        )


def load_teams(path: Path) -> list[Team]:
    raw = _load_yaml(path)
    return [
        Team(id=t["id"], name=t["name"], color=t["color"], personality=t["personality"], traits=t.get("traits", {}))
        for t in raw["teams"]
    ]


def load_episode(path: Path) -> dict:
    raw = _load_yaml(path)
    return raw["episode"]


def load_event_config(repo_root: Path, event_id: str) -> dict:
    return _load_yaml(repo_root / "config" / "events" / f"{event_id}.yaml")
