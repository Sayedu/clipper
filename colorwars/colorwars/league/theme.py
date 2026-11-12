"""league/theme.json: a 32-note melody (C major pentatonic scale degrees,
spanning two octaves), generated once per season so a recurring in-episode
sound (Great Escape's ring collisions, one note per hit) always plays the
same recognizable tune across every episode of that season -- viewers
start to recognize it. Regenerated automatically the first time a new
season_number shows up; nothing else ever writes this file.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..engine.rng import Rng

NOTE_COUNT = 32


def load_or_build_theme(season_number: int, path: Path) -> list[int]:
    """Each note is 0-9: degree = note % 5 (indexes the pentatonic scale),
    octave = note // 5 (0 or 1). Decoding into an actual frequency is the
    consuming event's own sound.py's job, same as every other voice."""
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("season_number") == season_number and len(data.get("notes", [])) == NOTE_COUNT:
            return data["notes"]
    rng = Rng(9000 + season_number)
    notes = [rng.randint(0, 9) for _ in range(NOTE_COUNT)]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"season_number": season_number, "notes": notes}, indent=2) + "\n", encoding="utf-8")
    return notes
