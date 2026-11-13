"""Turns pasted raw TikTok comments into names.txt entries. One comment per
line; whichever team name appears in the line (case-insensitive, whole
word) is the team, and whatever's left on the line -- cleaned the exact
same way clean_name() already does for the real queue -- is the candidate
name. Shown back to the user as accepted/rejected-with-a-reason before
anything is written, so a bad paste doesn't silently drop half the names.
"""

from __future__ import annotations

import re
from pathlib import Path

from ..names import load_blocklist, strip_invalid_chars


def parse_raw_comments(text: str, team_names: list[str], blocklist_path: Path) -> dict:
    blocklist = load_blocklist(blocklist_path)
    team_lookup = {t.lower(): t for t in team_names}
    accepted: list[dict] = []
    rejected: list[dict] = []

    for raw_line in text.splitlines():
        raw = raw_line.strip()
        if not raw:
            continue

        found_team: str | None = None
        remainder = raw
        for lower, team in team_lookup.items():
            m = re.search(rf"\b{re.escape(lower)}\b", raw, re.IGNORECASE)
            if m:
                found_team = team
                remainder = raw[:m.start()] + raw[m.end():]
                break

        if found_team is None:
            rejected.append({"raw": raw, "team": None, "reason": "no team mentioned"})
            continue

        stripped = strip_invalid_chars(remainder)
        if not stripped:
            rejected.append({"raw": raw, "team": found_team, "reason": "bad characters (nothing left after cleaning)"})
            continue
        if len(stripped) > 12:
            rejected.append({"raw": raw, "team": found_team, "reason": "too long (max 12 characters)"})
            continue
        if stripped.lower() in blocklist:
            rejected.append({"raw": raw, "team": found_team, "reason": "blocklist"})
            continue

        accepted.append({"raw": raw, "team": found_team, "name": stripped})

    return {"accepted": accepted, "rejected": rejected}


def append_to_queue(names_path: Path, accepted: list[dict]) -> int:
    """Appends to the BACK of the FIFO queue (new comments are used after
    whatever's already waiting), one '<Team> <Name>' line per accepted
    entry. Returns how many lines were written."""
    if not accepted:
        return 0
    lines = [f"{item['team']} {item['name']}" for item in accepted]
    names_path.parent.mkdir(parents=True, exist_ok=True)
    existing = names_path.read_text(encoding="utf-8") if names_path.exists() else ""
    if existing and not existing.endswith("\n"):
        existing += "\n"
    names_path.write_text(existing + "\n".join(lines) + "\n", encoding="utf-8")
    return len(lines)
