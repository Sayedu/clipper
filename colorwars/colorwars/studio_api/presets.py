"""Named Setup-form presets, one JSON file per preset under
colorwars/presets/<event_id>/<name>.json. Plain, inspectable files (not a
database) -- there's no need for anything heavier for a handful of
hand-saved presets per event.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_\- ]{1,64}$")


def _safe_slug(name: str) -> str:
    if not _SAFE_NAME_RE.match(name):
        raise ValueError("preset name must be 1-64 letters/digits/spaces/-/_ characters")
    return re.sub(r"\s+", "_", name.strip())


def presets_dir(repo_root: Path, event_id: str) -> Path:
    return repo_root / "presets" / event_id


def list_presets(repo_root: Path, event_id: str) -> list[dict]:
    out = []
    d = presets_dir(repo_root, event_id)
    if not d.exists():
        return out
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append({"name": data.get("name", p.stem), "saved_at": data.get("saved_at")})
    return out


def save_preset(repo_root: Path, event_id: str, name: str, payload: dict) -> dict:
    import time

    slug = _safe_slug(name)
    d = presets_dir(repo_root, event_id)
    d.mkdir(parents=True, exist_ok=True)
    data = {"name": name, "saved_at": time.time(), "event_id": event_id, **payload}
    (d / f"{slug}.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


def load_preset(repo_root: Path, event_id: str, name: str) -> dict | None:
    slug = _safe_slug(name)
    path = presets_dir(repo_root, event_id) / f"{slug}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def delete_preset(repo_root: Path, event_id: str, name: str) -> bool:
    slug = _safe_slug(name)
    path = presets_dir(repo_root, event_id) / f"{slug}.json"
    if not path.exists():
        return False
    path.unlink()
    return True
