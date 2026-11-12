"""names.txt is a FIFO queue -- each requested name is used once, in the
order it was received, on the team the viewer asked for, before any name
repeats. peek_names() is read-only (what render() uses, so re-rendering
the same seed stays idempotent); consume_names() actually removes entries
and logs them to league/names_used.txt, and is only ever called by
`colorwars commit`.
"""

from __future__ import annotations

from pathlib import Path

from ..names import clean_name, load_blocklist


def _read_queue(names_path: Path) -> list[tuple[str, str]]:
    """[(team_name, raw_name), ...] in file order; comments/blank lines skipped."""
    if not names_path.exists():
        return []
    out = []
    for line in names_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) == 2:
            out.append((parts[0], parts[1]))
    return out


def peek_names(team_name: str, count: int, names_path: Path, blocklist_path: Path) -> list[str]:
    blocked = load_blocklist(blocklist_path)
    picked: list[str] = []
    for t, raw in _read_queue(names_path):
        if t != team_name:
            continue
        cleaned = clean_name(raw)
        if not cleaned or cleaned.lower() in blocked:
            continue
        picked.append(cleaned)
        if len(picked) >= count:
            break
    while len(picked) < count:
        picked.append(f"{team_name} {len(picked) + 1}")
    return picked


def consume_names(used_this_episode: dict[str, list[str]], names_path: Path, used_log_path: Path) -> None:
    """Removes the given names (team_name -> the clean names actually used,
    in order) from the front of the queue, appends them to names_used.txt.
    Fallback "<Team> N" names are never in the real queue, so they're
    naturally left alone here."""
    queue = _read_queue(names_path)
    wanted_by_team = {t: list(names) for t, names in used_this_episode.items()}
    remaining: list[tuple[str, str]] = []
    used_log_lines: list[str] = []

    for t, raw in queue:
        wanted = wanted_by_team.get(t)
        if wanted and clean_name(raw) == wanted[0]:
            used_log_lines.append(f"{t} {wanted.pop(0)}")
            continue
        remaining.append((t, raw))

    names_path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(f"{t} {raw}" for t, raw in remaining)
    names_path.write_text(body + ("\n" if body else ""), encoding="utf-8")

    if used_log_lines:
        used_log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(used_log_path, "a", encoding="utf-8") as fh:
            for line in used_log_lines:
                fh.write(line + "\n")
