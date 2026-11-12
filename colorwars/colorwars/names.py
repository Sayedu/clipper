"""Name cleaning + the blocklist check, shared by league/names_queue.py.
(Phase 1 had a random name-pool assigner here too; Phase 2 replaced it with
the FIFO queue in league/names_queue.py -- see that module.)
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
