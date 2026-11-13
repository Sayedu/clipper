"""The Studio's generic param schema. Every Event exposes its tunables as a
flat list of ParamSpec so the website can build one form from whatever an
event returns, instead of hand-coding a form per event. Events that don't
curate anything still get a full, working (if plainly-labeled) form for
free via walk_config_params(), which turns every leaf scalar in the
event's own YAML config into a param spec with a heuristic range.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ParamSpec:
    name: str  # dotted path into event_cfg (e.g. "balls.per_team"), or a
    # team-trait path ("team.red.mass_mult") -- see params_to_overrides()
    label: str
    type: str  # "int" | "float" | "bool" | "select" | "text"
    default: Any
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[dict] | None = None  # [{"value": ..., "label": ...}]
    help: str = ""
    randomizable: bool = True
    group: str = "General"

    def to_dict(self) -> dict:
        return {
            "name": self.name, "label": self.label, "type": self.type, "default": self.default,
            "min": self.min, "max": self.max, "step": self.step, "options": self.options,
            "help": self.help, "randomizable": self.randomizable, "group": self.group,
        }


_GENERIC_SKIP = {"event.id", "event.name"}


def _humanize(path: str) -> str:
    last = path.split(".")[-1]
    return last.replace("_", " ").title()


def _heuristic_range(value: float) -> tuple[float, float]:
    if value == 0:
        return (0.0, 10.0)
    if value > 0:
        return (0.0, round(value * 3, 4))
    return (round(value * 3, 4), 0.0)


def walk_config_params(cfg: dict, group: str = "Advanced", prefix: str = "") -> list[ParamSpec]:
    out: list[ParamSpec] = []
    for key, value in cfg.items():
        path = f"{prefix}.{key}" if prefix else key
        if path in _GENERIC_SKIP:
            continue
        if isinstance(value, dict):
            out.extend(walk_config_params(value, group, path))
        elif isinstance(value, bool):
            out.append(ParamSpec(name=path, label=_humanize(path), type="bool", default=value, group=group))
        elif isinstance(value, int):
            lo, hi = _heuristic_range(value)
            # a positive int that's actually a count/segments/Hz-like knob
            # (ring.segments, balls.per_team, physics.step_hz, ...) crashes
            # outright at 0 (ZeroDivisionError, an empty-team edge case, a
            # frozen sim) -- found by Randomize genuinely producing one and
            # every subsequent quick-check failing. _heuristic_range's own
            # floor is always 0 for a positive default; raise it to 1 here,
            # but only when the field's own default wasn't already 0 (that
            # case means the config's author considers 0 a real value).
            if lo == 0 and value > 0:
                lo = 1
            out.append(ParamSpec(name=path, label=_humanize(path), type="int", default=value,
                                  min=lo, max=hi, step=1, group=group))
        elif isinstance(value, float):
            lo, hi = _heuristic_range(value)
            out.append(ParamSpec(name=path, label=_humanize(path), type="float", default=value,
                                  min=lo, max=hi, step=round(abs(value) / 20, 5) or 0.01, group=group))
        elif isinstance(value, str):
            out.append(ParamSpec(name=path, label=_humanize(path), type="text", default=value,
                                  group=group, randomizable=False))
        # lists are left to curated, event-specific specs -- too varied to
        # auto-range meaningfully (a list of radii is not a list of weights)
    return out


def dedupe_by_name(specs: list[ParamSpec]) -> list[ParamSpec]:
    seen: set[str] = set()
    out: list[ParamSpec] = []
    for s in specs:
        if s.name in seen:
            continue
        seen.add(s.name)
        out.append(s)
    return out


def team_trait_params(team_ids_and_traits: dict[str, dict[str, Any]], relevant_keys: list[str],
                       group: str = "Team strength") -> list[ParamSpec]:
    """relevant_keys: which trait keys this particular event actually reads
    -- e.g. Ring of Doom cares about mass_mult/elasticity_add/radius_mult,
    Champion Duel only cares about duel_power. Keeps the form from showing
    a team trait that has no effect on the event currently selected."""
    out: list[ParamSpec] = []
    for tid, traits in team_ids_and_traits.items():
        for key in relevant_keys:
            if key not in traits:
                continue
            value = traits[key]
            path = f"team.{tid}.{key}"
            if isinstance(value, bool):
                out.append(ParamSpec(name=path, label=f"{tid.title()}: {_humanize(key)}", type="bool",
                                      default=value, group=group))
            elif isinstance(value, (int, float)):
                lo, hi = _heuristic_range(float(value))
                out.append(ParamSpec(name=path, label=f"{tid.title()}: {_humanize(key)}",
                                      type="float", default=value, min=lo, max=hi,
                                      step=round(abs(value) / 20, 5) or 0.01, group=group))
    return out


def _step(cur: Any, part: str) -> Any:
    """A path segment is a list index if the container at this point is a
    list (e.g. Shell Shuffle's "rounds.2.swaps") -- otherwise a dict key."""
    if isinstance(cur, list):
        return cur[int(part)]
    return cur[part]


def set_dotted(d: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    cur: Any = d
    for p in parts[:-1]:
        nxt = cur[int(p)] if isinstance(cur, list) else cur.setdefault(p, {})
        cur = nxt
    last = parts[-1]
    if isinstance(cur, list):
        cur[int(last)] = value
    else:
        cur[last] = value


def get_dotted(d: dict, path: str, default: Any = None) -> Any:
    cur: Any = d
    for p in path.split("."):
        try:
            cur = _step(cur, p)
        except (KeyError, IndexError, ValueError, TypeError):
            return default
    return cur
