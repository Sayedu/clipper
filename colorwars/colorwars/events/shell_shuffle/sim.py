"""Shell Shuffle: deterministic choreography, not physics. 4 cups on a table,
each permanently hiding one team's ball -- cups change SLOT (table
position), the ball never changes cup. Every move (swap, double swap, fake
swap, orbit, lift tease) is a pure function of its own seeded plan and
elapsed time within the move, so nothing here needs pymunk or any
per-frame integration; the "physics_hz" stepping is just a sampling rate
for the StepRecord array, not a simulation step.

Field reuse note (nothing elsewhere reads these for this event, so this is
safe): BallState.angle holds the cup's current draw SCALE (1.0 = normal),
BallState.vy holds its current LIFT fraction (0 = resting on the ball, 1 =
fully raised, showing it), BallState.vx is unused (0.0). BallState.alive
means "this cup's ball is currently visible" (lift at/above
ALIVE_LIFT_THRESHOLD) -- true during the opening reveal, both GOT IT
checks, and a cup's turn in the final countdown, false otherwise.
"""

from __future__ import annotations

import math

from ...engine.config import Settings, Team
from ...engine.records import BallInfo, BallState, SimEvent, SimRecord, StepRecord
from ...engine.rng import Rng
from ...league.names_queue import peek_names

ALIVE_LIFT_THRESHOLD = 0.85

SLOT_PAIRS = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)]
DOUBLE_PARTITIONS = [((0, 1), (2, 3)), ((0, 2), (1, 3)), ((0, 3), (1, 2))]


def _smoothstep(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def _triangle(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return 2 * u if u <= 0.5 else 2 * (1 - u)


def _lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * u


class _TableGeom:
    def __init__(self, table_cfg: dict):
        self.cx, self.cy = float(table_cfg["center"][0]), float(table_cfg["center"][1])
        self.spacing = float(table_cfg["slot_spacing"])
        self.cup_radius = float(table_cfg["cup_radius"])
        self.arc_front = float(table_cfg["arc_height_front"])
        self.arc_back = float(table_cfg["arc_height_back"])
        self.scale_front = float(table_cfg["scale_front"])
        self.scale_back = float(table_cfg["scale_back"])
        self.orbit_bulge = float(table_cfg["orbit_radius"])
        self.lift_height = float(table_cfg["lift_height"])
        self.tease_max = float(table_cfg["lift_tease_max"])

    def slot_pos(self, slot: int) -> tuple[float, float]:
        return (self.cx + (slot - 1.5) * self.spacing, self.cy)


def _podium_pos(rank: int, podium_cfg: dict, geom: _TableGeom) -> tuple[float, float]:
    dx, dy = podium_cfg["slots"][rank]
    return (geom.cx + float(dx), geom.cy + float(dy))


def _make_step(t: float, cup_states: list[tuple[float, float, float, float]]) -> StepRecord:
    balls = [
        BallState(x=x, y=y, angle=scale, vx=0.0, vy=lift, alive=lift >= ALIVE_LIFT_THRESHOLD)
        for (x, y, scale, lift) in cup_states
    ]
    return StepRecord(t=t, ring_angle=0.0, gaps_deg=(), balls=balls)


def _plan_move(rng: Rng, slot_cup: list[int], kind: str) -> dict:
    """Builds a move's render legs plus the slot permutation it leaves
    behind (empty for fake_swap/lift_tease, which never change occupancy).
    """
    if kind in ("swap", "fake_swap"):
        slot_a, slot_b = rng.pick(SLOT_PAIRS)
        cup_a, cup_b = slot_cup[slot_a], slot_cup[slot_b]
        a_front = rng.chance(0.5)
        if kind == "swap":
            legs = [
                {"cup": cup_a, "slot_from": slot_a, "slot_to": slot_b, "role": "front" if a_front else "back"},
                {"cup": cup_b, "slot_from": slot_b, "slot_to": slot_a, "role": "back" if a_front else "front"},
            ]
            permutation = {slot_a: slot_b, slot_b: slot_a}
        else:
            legs = [
                {"cup": cup_a, "slot_from": slot_a, "slot_to": slot_b, "role": "fake_front" if a_front else "fake_back"},
                {"cup": cup_b, "slot_from": slot_b, "slot_to": slot_a, "role": "fake_back" if a_front else "fake_front"},
            ]
            permutation = {}
        return {"kind": kind, "cups": [cup_a, cup_b], "legs": legs, "permutation": permutation}

    if kind == "double_swap":
        (s1, s2), (s3, s4) = rng.pick(DOUBLE_PARTITIONS)
        legs = []
        permutation = {}
        cups = []
        for sa, sb in ((s1, s2), (s3, s4)):
            cup_a, cup_b = slot_cup[sa], slot_cup[sb]
            a_front = rng.chance(0.5)
            legs.append({"cup": cup_a, "slot_from": sa, "slot_to": sb, "role": "front" if a_front else "back"})
            legs.append({"cup": cup_b, "slot_from": sb, "slot_to": sa, "role": "back" if a_front else "front"})
            permutation[sa], permutation[sb] = sb, sa
            cups.extend([cup_a, cup_b])
        return {"kind": kind, "cups": cups, "legs": legs, "permutation": permutation}

    if kind == "orbit":
        direction = 1 if rng.chance(0.5) else -1
        legs = []
        permutation = {}
        cups = []
        for slot in range(4):
            cup = slot_cup[slot]
            target = (slot + direction) % 4
            legs.append({"cup": cup, "slot_from": slot, "slot_to": target, "role": "orbit"})
            permutation[slot] = target
            cups.append(cup)
        return {"kind": kind, "cups": cups, "legs": legs, "permutation": permutation}

    if kind == "lift_tease":
        slot = rng.randint(0, 3)
        cup = slot_cup[slot]
        legs = [{"cup": cup, "slot_from": slot, "slot_to": slot, "role": "tease"}]
        return {"kind": kind, "cups": [cup], "legs": legs, "permutation": {}}

    raise ValueError(f"unknown move kind: {kind!r}")


def _apply_permutation(cup_slot: list[int], slot_cup: list[int], permutation: dict[int, int]) -> None:
    if not permutation:
        return
    old_slot_cup = list(slot_cup)
    for s_from, s_to in permutation.items():
        cup = old_slot_cup[s_from]
        slot_cup[s_to] = cup
        cup_slot[cup] = s_to


def _move_cup_states(plan: dict, u: float, geom: _TableGeom) -> dict[int, tuple[float, float, float, float]]:
    out: dict[int, tuple[float, float, float, float]] = {}
    eased = _smoothstep(u)
    for leg in plan["legs"]:
        cup = leg["cup"]
        role = leg["role"]
        x0, y0 = geom.slot_pos(leg["slot_from"])
        x1, y1 = geom.slot_pos(leg["slot_to"])

        if role in ("front", "back"):
            x = _lerp(x0, x1, eased)
            arc_t = math.sin(math.pi * eased)
            if role == "front":
                y = y0 - geom.arc_front * arc_t
                scale = 1.0 + (geom.scale_front - 1.0) * arc_t
            else:
                y = y0 + geom.arc_back * arc_t
                scale = 1.0 + (geom.scale_back - 1.0) * arc_t
            out[cup] = (x, y, scale, 0.0)

        elif role in ("fake_front", "fake_back"):
            tri = _smoothstep(_triangle(u))
            x = _lerp(x0, x1, 0.5 * tri)
            if role == "fake_front":
                y = y0 - geom.arc_front * tri
                scale = 1.0 + (geom.scale_front - 1.0) * tri
            else:
                y = y0 + geom.arc_back * tri
                scale = 1.0 + (geom.scale_back - 1.0) * tri
            out[cup] = (x, y, scale, 0.0)

        elif role == "orbit":
            x_lin, y_lin = _lerp(x0, x1, eased), _lerp(y0, y1, eased)
            mx, my = _lerp(x0, x1, 0.5), _lerp(y0, y1, 0.5)
            dx, dy = mx - geom.cx, my - geom.cy
            norm = math.hypot(dx, dy) or 1.0
            bulge = geom.orbit_bulge * math.sin(math.pi * eased)
            x = x_lin + (dx / norm) * bulge
            y = y_lin + (dy / norm) * bulge
            scale = 1.0 + 0.08 * math.sin(math.pi * eased)
            out[cup] = (x, y, scale, 0.0)

        elif role == "tease":
            tri = _smoothstep(_triangle(u))
            lift = geom.tease_max * tri
            scale = 1.0 + 0.04 * tri
            out[cup] = (x0, y0, scale, lift)

    return out


def _append_move(steps: list[StepRecord], t: float, hz: int, duration_sec: float, plan: dict,
                  cup_slot: list[int], geom: _TableGeom) -> float:
    n = max(1, round(duration_sec * hz))
    for k in range(n):
        u = (k + 1) / n
        moving = _move_cup_states(plan, u, geom)
        states = []
        for cup in range(4):
            if cup in moving:
                states.append(moving[cup])
            else:
                x, y = geom.slot_pos(cup_slot[cup])
                states.append((x, y, 1.0, 0.0))
        steps.append(_make_step(t, states))
        t += 1.0 / hz
    return t


def _append_hold(steps: list[StepRecord], t: float, hz: int, duration_sec: float,
                  pos_fn, lift_by_cup) -> float:
    """pos_fn(cup) -> (x, y). lift_by_cup is either a constant float or a
    callable cup -> float, so per-cup reveal states (some open, some not)
    and uniform holds (all cups at the same lift) share one helper."""
    n = max(1, round(duration_sec * hz))
    get_lift = lift_by_cup if callable(lift_by_cup) else (lambda _cup: lift_by_cup)
    for _ in range(n):
        states = []
        for cup in range(4):
            x, y = pos_fn(cup)
            states.append((x, y, 1.0, get_lift(cup)))
        steps.append(_make_step(t, states))
        t += 1.0 / hz
    return t


def _append_transition(steps: list[StepRecord], t: float, hz: int, duration_sec: float,
                        pos_fn, lift_from: float, lift_to: float) -> float:
    n = max(1, round(duration_sec * hz))
    for k in range(n):
        u = (k + 1) / n
        lift = _lerp(lift_from, lift_to, _smoothstep(u))
        states = [(x, y, 1.0, lift) for (x, y) in (pos_fn(cup) for cup in range(4))]
        steps.append(_make_step(t, states))
        t += 1.0 / hz
    return t


def _append_single_reveal(steps: list[StepRecord], t: float, hz: int, lift_sec: float, hold_sec: float,
                           target_cup: int, pos_fn, cup_lift_state: dict[int, float]) -> float:
    n1 = max(1, round(lift_sec * hz))
    for k in range(n1):
        u = (k + 1) / n1
        eased = _smoothstep(u)
        states = []
        for cup in range(4):
            x, y = pos_fn(cup)
            lift = eased if cup == target_cup else cup_lift_state.get(cup, 0.0)
            states.append((x, y, 1.0, lift))
        steps.append(_make_step(t, states))
        t += 1.0 / hz
    cup_lift_state[target_cup] = 1.0

    n2 = max(1, round(hold_sec * hz))
    for _ in range(n2):
        states = [(x, y, 1.0, cup_lift_state.get(cup, 0.0)) for cup, (x, y) in enumerate(pos_fn(c) for c in range(4))]
        steps.append(_make_step(t, states))
        t += 1.0 / hz
    return t


def _flatten_weights(weights: dict) -> list[str]:
    pool: list[str] = []
    for kind, w in weights.items():
        pool.extend([kind] * int(w))
    return pool


def simulate(seed: int, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
    rng = Rng(seed)
    hz = int(event_cfg.get("physics_hz", 60))
    geom = _TableGeom(event_cfg["table"])
    podium_cfg = event_cfg["podium"]
    reveal_cfg = event_cfg["reveal"]
    got_it_cfg = event_cfg["got_it"]
    reveal_seq_cfg = event_cfg["reveal_sequence"]
    outro_cfg = event_cfg["outro"]
    trick_pool = _flatten_weights(event_cfg["trick_weights"])

    team_ids_in_order = [t.id for t in teams]
    teams_by_id = {t.id: t for t in teams}
    shuffled_team_ids = rng.shuffled(team_ids_in_order)

    balls: list[BallInfo] = []
    for cup_id, tid in enumerate(shuffled_team_ids):
        team = teams_by_id[tid]
        name = peek_names(team.name, 1, settings.names_path, settings.blocklist_path)[0]
        balls.append(BallInfo(id=cup_id, team_id=tid, team_name=team.name, name=name, base_radius=geom.cup_radius))

    cup_slot = [0, 1, 2, 3]
    slot_cup = [0, 1, 2, 3]

    steps: list[StepRecord] = []
    events: list[SimEvent] = []
    t = 0.0

    def row_pos(cup: int) -> tuple[float, float]:
        return geom.slot_pos(cup_slot[cup])

    # -- opening reveal: balls shown, then cups drop over them --
    t = _append_hold(steps, t, hz, float(reveal_cfg["show_sec"]), row_pos, 1.0)
    events.append(SimEvent(len(steps) - 1, t, "reveal_shown", {}))
    t = _append_transition(steps, t, hz, float(reveal_cfg["drop_sec"]), row_pos, 1.0, 0.0)
    events.append(SimEvent(len(steps) - 1, t, "cups_dropped", {}))

    # -- three rounds of swaps --
    for round_idx, round_cfg in enumerate(event_cfg["rounds"], start=1):
        events.append(SimEvent(len(steps) - 1, t, "round_start", {"round": round_idx}))
        n_swaps = int(round_cfg["swaps"])
        swap_sec = float(round_cfg["swap_sec"])
        pause_sec = float(round_cfg["pause_sec"])
        tricks = bool(round_cfg["tricks"])

        for _beat in range(n_swaps):
            kind = rng.pick(trick_pool) if tricks else "swap"
            plan = _plan_move(rng, slot_cup, kind)
            events.append(SimEvent(len(steps), t, "move_start", {"kind": kind, "cups": plan["cups"]}))
            t = _append_move(steps, t, hz, swap_sec, plan, cup_slot, geom)
            _apply_permutation(cup_slot, slot_cup, plan["permutation"])
            events.append(SimEvent(len(steps) - 1, t, "move_end", {"kind": kind, "cups": plan["cups"]}))
            if pause_sec > 0:
                t = _append_hold(steps, t, hz, pause_sec, row_pos, 0.0)

        events.append(SimEvent(len(steps) - 1, t, "round_end", {"round": round_idx}))

        if round_idx in (1, 2):
            t = _append_transition(steps, t, hz, float(got_it_cfg["lift_sec"]), row_pos, 0.0, 1.0)
            events.append(SimEvent(len(steps) - 1, t, "got_it", {"which": round_idx}))
            t = _append_hold(steps, t, hz, float(got_it_cfg["hold_sec"]), row_pos, 1.0)
            t = _append_transition(steps, t, hz, float(got_it_cfg["drop_sec"]), row_pos, 1.0, 0.0)
            events.append(SimEvent(len(steps) - 1, t, "got_it_closed", {"which": round_idx}))

    # -- move to podium formation --
    def podium_pos(cup: int) -> tuple[float, float]:
        return _podium_pos(cup_slot[cup], podium_cfg, geom)

    move_sec = float(podium_cfg["move_sec"])
    n_move = max(1, round(move_sec * hz))
    bulge_px = 18.0
    for k in range(n_move):
        u = (k + 1) / n_move
        eased = _smoothstep(u)
        states = []
        for cup in range(4):
            x0, y0 = geom.slot_pos(cup_slot[cup])
            x1, y1 = podium_pos(cup)
            mx, my = _lerp(x0, x1, 0.5), _lerp(y0, y1, 0.5)
            dx, dy = mx - geom.cx, my - geom.cy
            norm = math.hypot(dx, dy) or 1.0
            bulge = bulge_px * math.sin(math.pi * eased)
            x = _lerp(x0, x1, eased) + (dx / norm) * bulge
            y = _lerp(y0, y1, eased) + (dy / norm) * bulge
            states.append((x, y, 1.0, 0.0))
        steps.append(_make_step(t, states))
        t += 1.0 / hz
    events.append(SimEvent(len(steps) - 1, t, "podium_arrive", {}))

    # -- freeze: "WHERE IS YOUR TEAM?" --
    t = _append_hold(steps, t, hz, float(podium_cfg["freeze_sec"]), podium_pos, 0.0)
    events.append(SimEvent(len(steps) - 1, t, "freeze_end", {}))

    # -- reveal countdown, 4th up to 1st --
    cup_lift_state: dict[int, float] = {}
    lift_sec = float(reveal_seq_cfg["lift_sec"])
    hold_sec = float(reveal_seq_cfg["hold_sec"])
    for placement_index in (3, 2, 1, 0):
        target_cup = slot_cup[placement_index]
        events.append(SimEvent(len(steps), t, "reveal_pop", {
            "placement_index": placement_index, "team_id": balls[target_cup].team_id,
        }))
        extra_hold = hold_sec + float(reveal_seq_cfg["win_extra_sec"]) if placement_index == 0 else hold_sec
        t = _append_single_reveal(steps, t, hz, lift_sec, extra_hold, target_cup, podium_pos, cup_lift_state)
        if placement_index == 0:
            events.append(SimEvent(len(steps) - 1, t, "win", {"team_id": balls[target_cup].team_id}))

    # -- confetti hold + standings outro (no cup movement) --
    t = _append_hold(steps, t, hz, float(outro_cfg["confetti_hold_sec"]), podium_pos, lambda cup: cup_lift_state.get(cup, 0.0))
    events.append(SimEvent(len(steps) - 1, t, "outro_start", {}))
    t = _append_hold(steps, t, hz, float(outro_cfg["standings_sec"]), podium_pos, lambda cup: cup_lift_state.get(cup, 0.0))

    placements = [balls[slot_cup[i]].team_id for i in range(4)]
    winner_team_id = placements[0]
    mvp_name = balls[slot_cup[0]].name

    return SimRecord(
        seed=seed,
        event_id="shell_shuffle",
        physics_hz=hz,
        steps=steps,
        events=events,
        balls=balls,
        teams=teams,
        winner_team_id=winner_team_id,
        placements=placements,
        mvp_name=mvp_name,
        duration_steps=len(steps),
    )
