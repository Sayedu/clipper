"""Disaster Drop's course generator: seeded modules stacked top to bottom,
each adding static (or, for the spinner, kinematic) pymunk geometry. Every
module function takes the same shape -- (space, rng, x0, x1, y_top, y_bot,
cfg) -> list of kinematic bodies it needs stepped every physics frame (most
return an empty list) -- so sim.py's main loop never needs to know which
module types exist.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import pymunk

CT_WALL = 1


@dataclass
class Module:
    kind: str
    y_top: float
    y_bottom: float
    spinners: list[pymunk.Body] = field(default_factory=list)


MODULE_TYPES = [
    "peg_field", "zigzag_ramp", "spinner_gauntlet", "funnel",
    "trapdoor_floor", "bumper_maze", "split_paths",
]


def _seg(space: pymunk.Space, a: tuple[float, float], b: tuple[float, float], thickness: float) -> None:
    shape = pymunk.Segment(space.static_body, a, b, thickness / 2)
    shape.collision_type = CT_WALL
    shape.elasticity = 0.6
    shape.friction = 0.5
    space.add(shape)


def _build_peg_field(space, rng, x0, x1, y_top, y_bot, cfg) -> list[pymunk.Body]:
    peg_r = 15.0
    row_h = 150.0
    cols = 5
    row = y_top + row_h * 0.5
    col_w = (x1 - x0) / cols
    row_idx = 0
    while row < y_bot - row_h * 0.3:
        offset = (col_w / 2) if row_idx % 2 else 0.0
        for c in range(cols):
            cx = x0 + col_w * (c + 0.5) + offset
            if cx < x0 + peg_r * 1.5 or cx > x1 - peg_r * 1.5:
                continue
            jitter_x = rng.uniform(-18, 18)
            jitter_y = rng.uniform(-18, 18)
            shape = pymunk.Circle(space.static_body, peg_r, (cx + jitter_x, row + jitter_y))
            shape.collision_type = CT_WALL
            shape.elasticity = 0.75
            shape.friction = 0.3
            space.add(shape)
        row += row_h
        row_idx += 1
    return []


def _build_zigzag_ramp(space, rng, x0, x1, y_top, y_bot, cfg) -> list[pymunk.Body]:
    thickness = cfg["wall_thickness"]
    rung_h = 190.0
    inset = 26.0
    # the low-end gap used to be inset*2.2 (~57px) -- barely wider than a
    # ball's own diameter, a near-guaranteed jam with 12 balls funneling
    # through nearly single file (found by tracing a real stuck ball back
    # to a zigzag_ramp module). A real drop-course gap needs a few ball-
    # widths of clearance, not barely one.
    gap = 230.0
    y = y_top
    right_side = rng.chance(0.5)
    while y + rung_h < y_bot:
        if right_side:
            a, b = (x0 + inset, y), (x1 - gap, y + rung_h)
        else:
            a, b = (x1 - inset, y), (x0 + gap, y + rung_h)
        _seg(space, a, b, thickness)
        y += rung_h * 0.82  # slight vertical overlap so a ball can't fall straight through
        right_side = not right_side
    return []


def _build_spinner_gauntlet(space, rng, x0, x1, y_top, y_bot, cfg) -> list[pymunk.Body]:
    thickness = cfg["wall_thickness"]
    spacing = 340.0
    bar_len = (x1 - x0) * 0.56
    y = y_top + spacing * 0.5
    bodies = []
    while y < y_bot - spacing * 0.3:
        cx = (x0 + x1) / 2
        body = pymunk.Body(body_type=pymunk.Body.KINEMATIC)
        body.position = (cx, y)
        omega = rng.uniform(1.6, 2.8) * (1 if rng.chance(0.5) else -1)
        body.angular_velocity = omega
        shape = pymunk.Segment(body, (-bar_len / 2, 0), (bar_len / 2, 0), thickness / 2)
        shape.collision_type = CT_WALL
        shape.elasticity = 0.7
        shape.friction = 0.3
        space.add(body, shape)
        bodies.append(body)
        y += spacing
    return bodies


def _build_funnel(space, rng, x0, x1, y_top, y_bot, cfg) -> list[pymunk.Body]:
    thickness = cfg["wall_thickness"]
    gap = rng.uniform(300, 380)
    cx = (x0 + x1) / 2
    _seg(space, (x0, y_top), (cx - gap / 2, y_bot), thickness)
    _seg(space, (x1, y_top), (cx + gap / 2, y_bot), thickness)
    return []


def _build_trapdoor_floor(space, rng, x0, x1, y_top, y_bot, cfg) -> list[pymunk.Body]:
    # a PERFECTLY FLAT floor segment is a real trap: a ball landing on it has
    # zero net horizontal force and can rest there forever (found by actually
    # dropping balls through an isolated module and watching one sit for 9s+
    # instead of assuming a gap alone was enough). Sloping each side down
    # toward the gap means gravity itself always carries a resting ball on.
    thickness = cfg["wall_thickness"]
    floor_y = (y_top + y_bot) / 2
    # steep enough that gravity clearly dominates friction -- a shallow
    # slope here (first tried: 70px of drop over a ~400-500px run) let a
    # ball settle into a near-equilibrium creep (gravity-along-slope barely
    # exceeding friction) at ~35px/s, which is slow enough that it could
    # out-wait the anti-stuck window without ever being truly motionless.
    # Found by tracing one ball's actual recorded velocity across a whole
    # module rather than assuming a gap was enough once it stopped resting.
    slope = 260.0
    gap_w = rng.uniform(240, 310)
    gap_center = rng.uniform(x0 + gap_w, x1 - gap_w)
    _seg(space, (x0, floor_y - slope), (gap_center - gap_w / 2, floor_y), thickness)
    _seg(space, (gap_center + gap_w / 2, floor_y), (x1, floor_y - slope), thickness)
    return []


def _build_bumper_maze(space, rng, x0, x1, y_top, y_bot, cfg) -> list[pymunk.Body]:
    # same flat-resting-surface trap as the floor above -- slope each stub
    # down toward its own open (gap) side.
    thickness = cfg["wall_thickness"]
    row_h = 210.0
    stub_frac = 0.48
    drop = 170.0  # same reasoning as the floor's slope above -- steep enough to actually accelerate, not just creep
    y = y_top
    from_left = rng.chance(0.5)
    while y + row_h * 0.3 < y_bot:
        length = (x1 - x0) * stub_frac
        if from_left:
            a, b = (x0, y - drop), (x0 + length, y)
        else:
            a, b = (x1, y - drop), (x1 - length, y)
        _seg(space, a, b, thickness)
        y += row_h
        from_left = not from_left
    return []


def _build_split_paths(space, rng, x0, x1, y_top, y_bot, cfg) -> list[pymunk.Body]:
    thickness = cfg["wall_thickness"]
    cx = (x0 + x1) / 2
    split_len = min(y_bot - y_top - 120, rng.uniform(550, 900))
    split_start = y_top + ((y_bot - y_top) - split_len) / 2
    split_end = split_start + split_len
    # the divider's top ~90px leans a few degrees off dead-vertical, in a
    # seeded direction -- a SYMMETRIC peak (first tried: a centered roof
    # cap) just relocates the same balancing-act bug to the cap's apex, as
    # an isolated drop test showed directly (a ball landing exactly on a
    # symmetric tip has zero net horizontal force either way). An
    # asymmetric lean has no such balance point, so anything landing near
    # the top is reliably carried to one side instead.
    lean = 34.0 if rng.chance(0.5) else -34.0
    lean_h = 90.0
    _seg(space, (cx + lean, split_start), (cx, split_start + lean_h), thickness)
    _seg(space, (cx, split_start + lean_h), (cx, split_end), thickness)
    # a couple of small pegs per lane for minor interest
    for lane_cx in ((x0 + cx) / 2, (cx + x1) / 2):
        peg_y = split_start + split_len * rng.uniform(0.3, 0.7)
        shape = pymunk.Circle(space.static_body, 16.0, (lane_cx, peg_y))
        shape.collision_type = CT_WALL
        shape.elasticity = 0.75
        shape.friction = 0.3
        space.add(shape)
    return []


_BUILDERS = {
    "peg_field": _build_peg_field,
    "zigzag_ramp": _build_zigzag_ramp,
    "spinner_gauntlet": _build_spinner_gauntlet,
    "funnel": _build_funnel,
    "trapdoor_floor": _build_trapdoor_floor,
    "bumper_maze": _build_bumper_maze,
    "split_paths": _build_split_paths,
}


def render_geometry(space: pymunk.Space, modules: list[Module]) -> dict:
    """Plain-data geometry for draw.py to render -- decouples the renderer
    from pymunk specifics beyond this one extraction. Static shapes are
    attached to space.static_body (position (0,0), angle 0), so their
    stored local coordinates already equal world coordinates directly."""
    segments: list[tuple[tuple[float, float], tuple[float, float], float]] = []
    circles: list[tuple[tuple[float, float], float]] = []
    for shape in space.shapes:
        if getattr(shape, "collision_type", None) != CT_WALL:
            continue
        if isinstance(shape, pymunk.Segment):
            segments.append(((shape.a.x, shape.a.y), (shape.b.x, shape.b.y), shape.radius))
        elif isinstance(shape, pymunk.Circle):
            segments_pos = (shape.body.position.x + shape.offset.x, shape.body.position.y + shape.offset.y)
            circles.append((segments_pos, shape.radius))

    spinners = []
    for m in modules:
        for body in m.spinners:
            bar_len = None
            for shape in body.shapes:
                if isinstance(shape, pymunk.Segment):
                    bar_len = (shape.a, shape.b, shape.radius)
            if bar_len is not None:
                spinners.append({"pos": (body.position.x, body.position.y), "omega": body.angular_velocity,
                                  "half_a": bar_len[0], "half_b": bar_len[1], "thickness": bar_len[2]})

    return {"segments": segments, "circles": circles, "spinners": spinners}


def generate_course(space: pymunk.Space, rng, cfg: dict, x0: float, x1: float) -> tuple[list[Module], float]:
    """Builds the whole course into `space`, returns (modules, total_height).
    Module count and type sequence are seeded -- this is the knob the brief
    means by "the miner may change the number of modules": different seeds
    naturally produce different course lengths (and so different video
    durations), rather than find_seed/mine needing a second search axis."""
    course_cfg = cfg["course"]
    n_modules = rng.randint(int(course_cfg["modules_min"]), int(course_cfg["modules_max"]))
    y = float(course_cfg["start_margin_px"])

    modules: list[Module] = []
    prev_kind = None
    for _ in range(n_modules):
        pool = [k for k in MODULE_TYPES if k != prev_kind] or MODULE_TYPES
        kind = rng.pick(pool)
        height = rng.uniform(float(course_cfg["module_height_min"]), float(course_cfg["module_height_max"]))
        y_top, y_bot = y, y + height
        bodies = _BUILDERS[kind](space, rng, x0, x1, y_top, y_bot, cfg["physics"])
        modules.append(Module(kind=kind, y_top=y_top, y_bottom=y_bot, spinners=bodies))
        y = y_bot
        prev_kind = kind

    total_height = y + float(course_cfg["finish_margin_px"])
    return modules, total_height
