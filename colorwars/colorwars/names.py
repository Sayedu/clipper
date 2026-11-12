"""Viewer name pool: load names.txt, clean every name (letters/digits/
underscore only, max 12 chars), drop anything on blocklist.txt, fill any
empty slot with a default "<Team> <N>" name.
"""

from __future__ import annotations

import re
from pathlib import Path

_CLEAN_RE = re.compile(r"[^A-Za-z0-9_]")


def clean_name(raw: str) -> str:
    cleaned = _CLEAN_RE.sub("", raw).strip("_")
    return cleaned[:12]


def load_blocklist(path: Path) -> set[str]:
    out: set[str] = set()
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.add(line.lower())
    return out


def load_name_pool(names_path: Path, blocklist_path: Path) -> dict[str, list[str]]:
    """Returns {team_name_lowercase: [clean_name, ...]} in file order, with
    blocked names dropped. "team_name" matches teams.yaml's `name` field
    (e.g. "Red", "Blue")."""
    blocked = load_blocklist(blocklist_path)
    pool: dict[str, list[str]] = {}
    if not names_path.exists():
        return pool
    for line in names_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        team, raw_name = parts
        cleaned = clean_name(raw_name)
        if not cleaned or cleaned.lower() in blocked:
            continue
        pool.setdefault(team, []).append(cleaned)
    return pool


def assign_names(team_name: str, count: int, pool: dict[str, list[str]], rng) -> list[str]:
    """Picks `count` distinct names for this team from the pool (seeded,
    order from `rng.shuffled`), falling back to "<Team> <N>" once the pool
    for that team runs out."""
    available = rng.shuffled(pool.get(team_name, []))
    names: list[str] = []
    for i in range(count):
        if i < len(available):
            names.append(available[i])
        else:
            names.append(f"{team_name} {i + 1}")
    return names
