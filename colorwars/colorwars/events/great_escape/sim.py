"""Great Escape: deterministic physics. 4 balls (one per team) start at the
arena center inside 6 concentric, independently rotating rings, each with
one fixed-size gap. A ring's gap is just a set of excluded segments in its
own LOCAL frame -- since the ring body rotates (kinematic angular_velocity,
the same technique Ring of Doom's ring uses), the gap sweeps through every
world angle once per rotation for free, no per-step gap bookkeeping
needed. A ball crossing a ring's radius outward can only have done so
through that exact gap (pymunk's own collision response already stops it
at any solid segment), so "shatter" detection is just comparing a ball's
radial distance this step against last step, not special angle math.
"""

from __future__ import annotations

import math

import pymunk

from ...engine.config import Settings, Team
from ...engine.records import BallInfo, BallState, SimEvent, SimRecord, StepRecord
from ...engine.rng import Rng
from ...league.names_queue import peek_names

TAU = 2 * math.pi
CT_WALL = 1
CT_BALL = 2


class _Ring:
    __slots__ = ("radius", "alive", "body", "shapes")

    def __init__(self, space: pymunk.Space, center: tuple[float, float], radius: float, segments: int,
                 omega: float, gap_half_deg: float, wall_thickness: float):
        self.radius = radius
        self.alive = True
        self.body = pymunk.Body(body_type=pymunk.Body.KINEMATIC)
        self.body.position = center
        self.body.angular_velocity = omega
        space.add(self.body)

        slot_deg = 360.0 / segments
        self.shapes: list[pymunk.Segment] = []
        for i in range(segments):
            slot_center_deg = (i + 0.5) * slot_deg
            # gap fixed at local angle 0 -- the body's own rotation sweeps
            # it through every world angle over one full period.
            if abs(((slot_center_deg - 0 + 180) % 360) - 180) <= gap_half_deg:
                continue
            a0, a1 = math.radians(i * slot_deg), math.radians((i + 1) * slot_deg)
            p0 = (radius * math.cos(a0), radius * math.sin(a0))
            p1 = (radius * math.cos(a1), radius * math.sin(a1))
            shape = pymunk.Segment(self.body, p0, p1, wall_thickness / 2)
            shape.collision_type = CT_WALL
            shape.elasticity = 0.85
            shape.friction = 0.3
            space.add(shape)
            self.shapes.append(shape)

    def shatter(self, space: pymunk.Space) -> None:
        if not self.alive:
            return
        self.alive = False
        space.remove(*self.shapes, self.body)
        self.shapes = []


class _Ball:
    __slots__ = ("info", "body", "shape", "escaped", "escape_t", "max_r", "prev_r",
                 "stuck_ref_pos", "stuck_ref_t")

    def __init__(self, info: BallInfo, body: pymunk.Body, shape: pymunk.Shape, start_r: float):
        self.info = info
        self.body = body
        self.shape = shape
        self.escaped = False
        self.escape_t: float | None = None
        self.max_r = start_r
        self.prev_r = start_r
        self.stuck_ref_pos = body.position
        self.stuck_ref_t = 0.0


def simulate(seed: int, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
    rng = Rng(seed)
    pcfg = event_cfg["physics"]
    hz = int(pcfg["step_hz"])
    dt = 1.0 / hz
    max_speed = float(pcfg["max_speed"])
    wall_thickness = float(pcfg["wall_thickness"])
    anti_stuck_dist = float(pcfg["anti_stuck_distance_px"])
    anti_stuck_window = float(pcfg["anti_stuck_window_sec"])

    space = pymunk.Space()
    space.gravity = (0, float(pcfg["gravity"]))

    cx, cy = float(event_cfg["arena"]["center"][0]), float(event_cfg["arena"]["center"][1])
    rcfg = event_cfg["rings"]
    radii = [float(r) for r in rcfg["radii"]]
    gap_half = float(rcfg["gap_deg"]) / 2.0
    segments = int(rcfg["segments"])
    speed_min, speed_max = float(rcfg["speed_min"]), float(rcfg["speed_max"])

    rings: list[_Ring] = []
    for i, radius in enumerate(radii):
        omega_mag = rng.uniform(speed_min, speed_max)
        omega = omega_mag if i % 2 == 0 else -omega_mag
        rings.append(_Ring(space, (cx, cy), radius, segments, omega, gap_half, wall_thickness))
    outer_radius = radii[-1]

    ball_cfg = event_cfg["ball"]
    ball_radius = float(ball_cfg["radius"])
    elasticity = float(ball_cfg["elasticity"])
    friction = float(ball_cfg["friction"])

    balls: list[_Ball] = []
    for i, team in enumerate(teams):
        name = peek_names(team.name, 1, settings.names_path, settings.blocklist_path)[0]
        info = BallInfo(id=i, team_id=team.id, team_name=team.name, name=name, base_radius=ball_radius)
        mass = 1.0
        body = pymunk.Body(mass, pymunk.moment_for_circle(mass, 0, ball_radius))
        jitter_r = rng.uniform(0, 20)
        jitter_a = rng.uniform(0, TAU)
        start_x, start_y = cx + jitter_r * math.cos(jitter_a), cy + jitter_r * math.sin(jitter_a)
        body.position = (start_x, start_y)
        shape = pymunk.Circle(body, ball_radius)
        shape.elasticity = elasticity
        shape.friction = friction
        shape.collision_type = CT_BALL
        space.add(body, shape)
        b = _Ball(info, body, shape, jitter_r)
        shape.ball_ref = b
        kick_ang = rng.uniform(0, TAU)
        kick_mag = rng.uniform(80, 160)
        body.velocity = (kick_mag * math.cos(kick_ang), kick_mag * math.sin(kick_ang))
        balls.append(b)

    events: list[SimEvent] = []
    steps: list[StepRecord] = []
    step_i = 0
    t = 0.0

    def on_ball_wall_post_solve(arbiter, space_, data):
        impulse = arbiter.total_impulse.length
        if impulse < 40.0:
            return
        a, b = arbiter.shapes
        ball_shape = a if a.collision_type == CT_BALL else b
        pos = ball_shape.body.position
        events.append(SimEvent(step_i, t, "collision", {"x": pos.x, "y": pos.y, "impulse": impulse}))

    space.on_collision(CT_BALL, CT_WALL, post_solve=on_ball_wall_post_solve)

    team_ids = [t.id for t in teams]

    def leading_team() -> str:
        best_ball = max(balls, key=lambda b: (b.escaped, b.max_r))
        return best_ball.info.team_id

    leader = leading_team()
    escape_order: list[str] = []
    sim_deadline = float(event_cfg["timing"]["sim_deadline_sec"])

    while t < sim_deadline:
        if len(escape_order) >= len(team_ids):
            break

        space.step(dt)

        for b in balls:
            if b.escaped:
                continue
            v = b.body.velocity
            speed = v.length
            if speed > max_speed:
                b.body.velocity = v * (max_speed / speed)
                v = b.body.velocity

            pos = b.body.position
            if (pos - b.stuck_ref_pos).length >= anti_stuck_dist:
                b.stuck_ref_pos = pos
                b.stuck_ref_t = t
            elif t - b.stuck_ref_t >= anti_stuck_window:
                ang = rng.uniform(0, TAU)
                b.body.apply_impulse_at_world_point((220 * math.cos(ang), 220 * math.sin(ang)), pos)
                b.stuck_ref_pos = pos
                b.stuck_ref_t = t

            r = math.hypot(pos.x - cx, pos.y - cy)
            b.max_r = max(b.max_r, r)

            for ring in rings:
                if ring.alive and b.prev_r < ring.radius <= r:
                    ring.shatter(space)
                    events.append(SimEvent(step_i, t, "ring_shatter",
                                            {"ring_radius": ring.radius, "team_id": b.info.team_id}))

            if r >= outer_radius and b.prev_r < outer_radius:
                b.escaped = True
                b.escape_t = t
                escape_order.append(b.info.team_id)
                events.append(SimEvent(step_i, t, "escape",
                                        {"team_id": b.info.team_id, "place": len(escape_order)}))

            b.prev_r = r

        new_leader = leading_team()
        if new_leader != leader:
            leader = new_leader
            events.append(SimEvent(step_i, t, "lead_change", {"team_id": leader}))

        steps.append(StepRecord(
            t=t, ring_angle=0.0, gaps_deg=(),
            balls=[BallState(b.body.position.x, b.body.position.y, b.body.angle,
                              b.body.velocity.x, b.body.velocity.y, not b.escaped) for b in balls],
        ))

        t += dt
        step_i += 1

    not_escaped = [tid for tid in team_ids if tid not in escape_order]
    not_escaped_sorted = sorted(not_escaped, key=lambda tid: -next(b.max_r for b in balls if b.info.team_id == tid))
    placements = escape_order + not_escaped_sorted
    winner_team_id = placements[0] if escape_order else None
    winner_ball = next((b for b in balls if b.info.team_id == winner_team_id), None) if winner_team_id else None
    mvp_name = winner_ball.info.name if winner_ball else ""

    return SimRecord(
        seed=seed,
        event_id="great_escape",
        physics_hz=hz,
        steps=steps,
        events=events,
        balls=[b.info for b in balls],
        teams=teams,
        winner_team_id=winner_team_id,
        placements=placements,
        mvp_name=mvp_name,
        duration_steps=len(steps),
    )
