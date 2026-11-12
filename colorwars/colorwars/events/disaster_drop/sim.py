"""Disaster Drop: deterministic physics. 240 Hz fixed steps, 12 balls (3 per
team) fall through a seeded vertical course (course.py) while a crusher
descends from above, accelerating, and disasters fire on a seeded timer.
Nothing here reads the wall clock or touches randomness outside the one
Rng instance it's given.
"""

from __future__ import annotations

import math

import pymunk

from ...engine.config import Settings, Team
from ...engine.records import BallInfo, BallState, SimEvent, SimRecord, StepRecord
from ...engine.rng import Rng
from ...league.names_queue import peek_names
from .course import CT_WALL, generate_course

TAU = 2 * math.pi
CT_BALL = 2
CT_CRUSHER = 3

FINISHED_BONUS = 1_000_000.0  # any finished team outranks any not-yet-finished team


class _Ball:
    __slots__ = ("info", "body", "shape", "alive", "finished", "finish_t",
                 "stuck_ref_pos", "stuck_ref_t", "stuck_since_t", "nudge_count",
                 "frozen_until_t", "fall_vx", "fall_vy", "fallback_pos",
                 "burst", "next_burst_t")

    def __init__(self, info: BallInfo, body: pymunk.Body, shape: pymunk.Shape, burst: bool, next_burst_t: float):
        self.info = info
        self.body = body
        self.shape = shape
        self.alive = True
        self.finished = False
        self.finish_t: float | None = None
        self.stuck_ref_pos = body.position
        self.stuck_ref_t = 0.0
        self.stuck_since_t: float | None = None
        self.nudge_count = 0
        self.frozen_until_t = 0.0
        self.fall_vx = 0.0
        self.fall_vy = 0.0
        self.fallback_pos: pymunk.Vec2d | None = None
        self.burst = burst
        self.next_burst_t = next_burst_t

    def progress_y(self, finish_y: float) -> float:
        if self.finished:
            return finish_y
        if self.alive:
            return min(self.body.position.y, finish_y)
        return min(self.fallback_pos.y if self.fallback_pos is not None else 0.0, finish_y)


def _spawn_balls(space, rng: Rng, teams: list[Team], settings: Settings, cfg: dict,
                  start_margin: float, x0: float, x1: float) -> list[_Ball]:
    balls_cfg = cfg["balls"]
    radius_base = float(balls_cfg["radius"])
    elasticity = float(balls_cfg["elasticity"])
    friction = float(balls_cfg["friction"])
    per_team = int(balls_cfg["per_team"])
    n_total = len(teams) * per_team

    xs = [x0 + (x1 - x0) * (i + 0.5) / n_total for i in range(n_total)]
    xs = rng.shuffled(xs)
    # staggering the drop height too (not just x), independently shuffled --
    # all 12 starting at nearly the same y meant they arrived at the first
    # bottleneck at nearly the same instant, which is exactly what produces
    # a dense, sometimes-permanent pile-up (confirmed directly: an isolated
    # trap turned out to be 7+ balls within 200px of each other, several
    # nearly touching).
    y_band = max(60.0, start_margin - 80.0)
    ys = [y_band * (i + 0.5) / n_total for i in range(n_total)]
    ys = rng.shuffled(ys)

    balls: list[_Ball] = []
    ball_id = 0
    idx = 0
    for team in teams:
        names = peek_names(team.name, per_team, settings.names_path, settings.blocklist_path)
        traits = team.traits
        mass_mult = float(traits.get("mass_mult", 1.0))
        elasticity_add = float(traits.get("elasticity_add", 0.0))
        radius_mult = float(traits.get("radius_mult", 1.0))
        burst = bool(traits.get("burst_impulse", False))
        burst_min = float(traits.get("burst_interval_min_sec", 4.0))
        burst_max = float(traits.get("burst_interval_max_sec", 7.0))
        for i in range(per_team):
            r = radius_base * radius_mult
            mass = 1.0 * mass_mult
            moment = pymunk.moment_for_circle(mass, 0, r)
            body = pymunk.Body(mass, moment)
            body.position = (xs[idx], ys[idx] + rng.uniform(-20, 20))
            shape = pymunk.Circle(body, r)
            shape.elasticity = min(0.95, elasticity + elasticity_add)
            shape.friction = friction
            shape.collision_type = CT_BALL
            space.add(body, shape)
            info = BallInfo(id=ball_id, team_id=team.id, team_name=team.name, name=names[i], base_radius=r)
            next_burst_t = rng.uniform(burst_min, burst_max) if burst else 0.0
            b = _Ball(info, body, shape, burst, next_burst_t)
            shape.ball_ref = b
            balls.append(b)
            ball_id += 1
            idx += 1
    return balls


class _Crusher:
    def __init__(self, space: pymunk.Space, cfg: dict, x0: float, x1: float):
        self.speed = float(cfg["crusher"]["start_speed"])
        self.accel = float(cfg["crusher"]["accel"])
        self.body = pymunk.Body(body_type=pymunk.Body.KINEMATIC)
        self.body.position = ((x0 + x1) / 2, float(cfg["crusher"]["start_y"]))
        thickness = float(cfg["physics"]["wall_thickness"]) * 2.4
        half_w = (x1 - x0) / 2 + 30
        shape = pymunk.Segment(self.body, (-half_w, 0), (half_w, 0), thickness / 2)
        shape.collision_type = CT_CRUSHER
        shape.elasticity = 0.2
        shape.friction = 0.2
        space.add(self.body, shape)

    def step(self, dt: float) -> None:
        self.body.velocity = (0, self.speed)
        self.speed += self.accel * dt

    @property
    def y(self) -> float:
        return self.body.position.y


def _weighted_pick(rng: Rng, items: list, weight_fn) -> object:
    pool = []
    for item in items:
        w = max(1, round(weight_fn(item) * 4))
        pool.extend([item] * w)
    return rng.pick(pool)


def simulate(seed: int, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
    rng = Rng(seed)
    pcfg = event_cfg["physics"]
    hz = int(pcfg["step_hz"])
    dt = 1.0 / hz
    max_speed = float(pcfg["max_speed"])
    wall_thickness = float(pcfg["wall_thickness"])
    anti_stuck_dist = float(pcfg["anti_stuck_distance_px"])
    anti_stuck_window = float(pcfg["anti_stuck_window_sec"])
    stuck_trap_sec = float(pcfg["stuck_trap_sec"])
    gravity_y = float(pcfg["gravity"])

    space = pymunk.Space()
    space.gravity = (0, gravity_y)
    # pymunk/Chipmunk already raises this to dt internally each step --
    # applying **dt here too would nearly cancel the damping (confirmed by
    # directly measuring open-space terminal velocity before settling on
    # this), so the config value is used as-is.
    space.damping = float(pcfg["damping"])

    x0 = float(event_cfg["playfield"]["x_min"])
    x1 = float(event_cfg["playfield"]["x_max"])

    modules, course_height = generate_course(space, rng, event_cfg, x0, x1)
    finish_y = course_height

    # side walls for the whole course height
    side_shape_l = pymunk.Segment(space.static_body, (x0, -2000), (x0, course_height + 500), wall_thickness / 2)
    side_shape_r = pymunk.Segment(space.static_body, (x1, -2000), (x1, course_height + 500), wall_thickness / 2)
    for s in (side_shape_l, side_shape_r):
        s.collision_type = CT_WALL
        s.elasticity = 0.6
        s.friction = 0.5
        space.add(s)

    start_margin = float(event_cfg["course"]["start_margin_px"])
    balls = _spawn_balls(space, rng, teams, settings, event_cfg, start_margin, x0, x1)
    crusher = _Crusher(space, event_cfg, x0, x1)

    team_ids = [t.id for t in teams]
    crown_team_id = episode.get("crown_team")

    events: list[SimEvent] = []
    steps: list[StepRecord] = []
    step_counter = {"i": 0}
    crusher_hits: list[_Ball] = []

    def on_crusher_hit(arbiter, space_, data):
        a, b = arbiter.shapes
        ball_shape = a if a.collision_type == CT_BALL else b
        ball = ball_shape.ball_ref
        if ball.alive and not ball.finished:
            crusher_hits.append(ball)
        return True

    space.on_collision(CT_CRUSHER, CT_BALL, begin=on_crusher_hit)

    last_pluck_t = {"t": -1.0}

    def on_ball_wall_post_solve(arbiter, space_, data):
        impulse = arbiter.total_impulse.length
        if impulse < 40.0 or t - last_pluck_t["t"] < 0.03:
            return
        a, b = arbiter.shapes
        ball_shape = a if a.collision_type == CT_BALL else b
        pos = ball_shape.body.position
        events.append(SimEvent(step_counter["i"], t, "collision",
                                {"x": pos.x, "y": pos.y, "impulse": impulse}))
        last_pluck_t["t"] = t

    space.on_collision(CT_BALL, CT_WALL, post_solve=on_ball_wall_post_solve)

    dcfg = event_cfg["disasters"]
    interval_min, interval_max = float(dcfg["interval_min_sec"]), float(dcfg["interval_max_sec"])
    warning_sec = float(dcfg["warning_sec"])
    crown_weight, leader_weight = float(dcfg["crown_weight"]), float(dcfg["leader_weight"])

    next_disaster_t = rng.uniform(interval_min, interval_max)
    pending_disaster: dict | None = None  # chosen at the warning, applied at next_disaster_t
    active_disaster: dict | None = None
    gravity_flipped = False
    magnet_team: str | None = None

    def _team_progress(tid: str) -> float:
        tballs = [b for b in balls if b.info.team_id == tid]
        best = max((b.progress_y(finish_y) for b in tballs), default=0.0)
        finished_tballs = [b for b in tballs if b.finished]
        if finished_tballs:
            earliest = min(b.finish_t for b in finished_tballs)
            return finish_y + FINISHED_BONUS - earliest
        return best

    def _current_leader_ball():
        candidates = [b for b in balls if b.alive and not b.finished]
        if not candidates:
            return None
        return max(candidates, key=lambda b: b.body.position.y)

    def _ball_weight(b: _Ball, leader_ball) -> float:
        w = 1.0
        if b.info.team_id == crown_team_id:
            w *= crown_weight
        if leader_ball is not None and b.info.id == leader_ball.info.id:
            w *= leader_weight
        return w

    def _team_weight(tid: str, leader_tid: str | None) -> float:
        w = 1.0
        if tid == crown_team_id:
            w *= crown_weight
        if leader_tid is not None and tid == leader_tid:
            w *= leader_weight
        return w

    leader_team_id = max(team_ids, key=_team_progress) if team_ids else None
    team_resolved_t: dict[str, float] = {}
    near_miss_armed = False
    near_miss_peak_gap = None
    crusher_closest_gap = float("inf")
    t = 0.0
    sim_deadline = float(event_cfg["timing"]["sim_deadline_sec"])
    finish_tail = float(event_cfg["timing"]["finish_tail_sec"])
    course_trapped = False
    finish_line_t: float | None = None

    while t < sim_deadline:
        # -- crusher --
        crusher.step(dt)

        # -- disaster lifecycle --
        if active_disaster is not None and t >= active_disaster["end_t"]:
            if active_disaster["type"] == "gravity_flip":
                space.gravity = (0, gravity_y)
                gravity_flipped = False
            elif active_disaster["type"] == "wall":
                space.remove(*active_disaster["shapes"])
            elif active_disaster["type"] == "magnet":
                magnet_team = None
            active_disaster = None

        if active_disaster is None and pending_disaster is None and t >= next_disaster_t - warning_sec:
            leader_ball = _current_leader_ball()
            dtype = rng.pick(dcfg["types"])
            target_ball = None
            target_team = None
            if dtype in ("lightning", "hammer", "boost"):
                alive_balls = [b for b in balls if b.alive and not b.finished]
                if alive_balls:
                    target_ball = _weighted_pick(rng, alive_balls, lambda b: _ball_weight(b, leader_ball))
            elif dtype == "magnet":
                active_teams = [tid for tid in team_ids if tid not in team_resolved_t]
                if active_teams:
                    target_team = _weighted_pick(rng, active_teams, lambda tid: _team_weight(tid, leader_team_id))
            pending_disaster = {"type": dtype, "ball": target_ball, "team": target_team}
            team_name = None
            if target_ball is not None:
                team_name = target_ball.info.team_name
            elif target_team is not None:
                team_name = next((tm.name for tm in teams if tm.id == target_team), None)
            events.append(SimEvent(step_counter["i"], t, "warning",
                                    {"about": "disaster", "type": dtype, "team": team_name}))

        if pending_disaster is not None and t >= next_disaster_t:
            dtype = pending_disaster["type"]
            target_ball = pending_disaster["ball"]
            target_team = pending_disaster["team"]
            team_name = target_ball.info.team_name if target_ball is not None else (
                next((tm.name for tm in teams if tm.id == target_team), None) if target_team else None)
            events.append(SimEvent(step_counter["i"], t, "disaster", {"type": dtype, "team": team_name}))

            if dtype == "lightning" and target_ball is not None:
                target_ball.frozen_until_t = t + float(dcfg["lightning_freeze_sec"])
            elif dtype == "hammer" and target_ball is not None:
                direction = 1.0 if target_ball.body.position.x < (x0 + x1) / 2 else -1.0
                target_ball.body.apply_impulse_at_local_point((direction * float(dcfg["hammer_impulse"]), -150))
            elif dtype == "wall":
                leader_ball = _current_leader_ball()
                wall_y = (leader_ball.body.position.y + 500) if leader_ball is not None else 1000.0
                wall_y = min(wall_y, finish_y - 200)
                gap_w = 260.0
                gap_cx = rng.uniform(x0 + gap_w, x1 - gap_w)
                shape = pymunk.Segment(space.static_body, (x0, wall_y), (gap_cx - gap_w / 2, wall_y), wall_thickness / 2)
                shape2 = pymunk.Segment(space.static_body, (gap_cx + gap_w / 2, wall_y), (x1, wall_y), wall_thickness / 2)
                for s in (shape, shape2):
                    s.collision_type = CT_WALL
                    s.elasticity = 0.6
                    s.friction = 0.5
                space.add(shape, shape2)
                active_disaster = {"type": "wall", "end_t": t + float(dcfg["wall_duration_sec"]),
                                    "shapes": [shape, shape2]}
            elif dtype == "boost" and target_ball is not None:
                target_ball.body.apply_impulse_at_local_point((0, float(dcfg["boost_impulse"])))
            elif dtype == "gravity_flip":
                space.gravity = (0, -gravity_y)
                gravity_flipped = True
                active_disaster = {"type": "gravity_flip", "end_t": t + float(dcfg["gravity_flip_sec"])}
            elif dtype == "magnet" and target_team is not None:
                magnet_team = target_team
                active_disaster = {"type": "magnet", "end_t": t + float(dcfg["magnet_duration_sec"])}

            if dtype in ("lightning", "hammer", "boost"):
                active_disaster = active_disaster or {"type": dtype, "end_t": t + 0.01}

            pending_disaster = None
            next_disaster_t = t + rng.uniform(interval_min, interval_max)

        if magnet_team is not None:
            force = float(dcfg["magnet_force"])
            for b in balls:
                if b.info.team_id == magnet_team and b.alive and not b.finished:
                    b.body.apply_force_at_world_point((0, -force), b.body.position)

        # -- yellow-style seeded bursts --
        for b in balls:
            if b.burst and b.alive and not b.finished and t >= b.next_burst_t:
                ang = rng.uniform(0, TAU)
                b.body.apply_impulse_at_local_point((420 * math.cos(ang), 420 * math.sin(ang)))
                b.next_burst_t = t + rng.uniform(4.0, 7.0)

        # -- frozen balls: hold velocity at zero while lightning-frozen --
        for b in balls:
            if b.alive and not b.finished and t < b.frozen_until_t:
                b.body.velocity = (0, 0)
                b.body.angular_velocity = 0.0

        space.step(dt)

        # -- speed cap, anti-stuck, trap detection --
        for b in balls:
            if not (b.alive and not b.finished):
                continue
            v = b.body.velocity
            speed = v.length
            if speed > max_speed:
                b.body.velocity = v * (max_speed / speed)

            pos = b.body.position
            if (pos - b.stuck_ref_pos).length >= anti_stuck_dist:
                b.stuck_ref_pos = pos
                b.stuck_ref_t = t
                b.stuck_since_t = None
                b.nudge_count = 0
            else:
                if b.stuck_since_t is None:
                    b.stuck_since_t = b.stuck_ref_t
                if t - b.stuck_ref_t >= anti_stuck_window:
                    # escalating strength: a ball wedged in a multi-ball
                    # pile (found directly -- an isolated trap turned out to
                    # be 7+ balls within 200px of each other) often needs
                    # more than one nudge to actually break free. Biased
                    # mostly downward (world space, via
                    # apply_impulse_at_world_point -- a LOCAL-point impulse
                    # would get rotated by however much the ball has spun,
                    # defeating a deliberate direction bias) rather than a
                    # pure random angle, since "escape" in a vertical race
                    # essentially always means continuing to fall past
                    # whatever's blocking, not drifting back upward.
                    ang = math.pi / 2 + rng.uniform(-1.15, 1.15)
                    strength = 320.0 + 260.0 * b.nudge_count
                    impulse = (strength * math.cos(ang), strength * math.sin(ang))
                    b.body.apply_impulse_at_world_point(impulse, b.body.position)
                    b.stuck_ref_pos = pos
                    b.stuck_ref_t = t
                    b.nudge_count += 1
                if t - b.stuck_since_t >= stuck_trap_sec and not course_trapped:
                    course_trapped = True
                    events.append(SimEvent(step_counter["i"], t, "course_trapped",
                                            {"ball_id": b.info.id, "team_id": b.info.team_id}))

        # -- crusher hits (collected during space.step via the collision callback) --
        for b in crusher_hits:
            if b.alive and not b.finished:
                b.alive = False
                b.fall_vx, b.fall_vy = b.body.velocity.x, b.body.velocity.y
                b.fallback_pos = pymunk.Vec2d(b.body.position.x, b.body.position.y)
                space.remove(b.shape, b.body)
                events.append(SimEvent(step_counter["i"], t, "elimination",
                                        {"ball_id": b.info.id, "team_id": b.info.team_id, "cause": "crusher"}))
        crusher_hits.clear()

        # -- advance eliminated balls' fallback position (manual, out of pymunk) --
        for b in balls:
            if not b.alive and not b.finished and b.fallback_pos is not None:
                b.fallback_pos = pymunk.Vec2d(b.fallback_pos.x + b.fall_vx * dt, b.fallback_pos.y + b.fall_vy * dt)

        # -- finish line --
        for b in balls:
            if b.alive and not b.finished and b.body.position.y >= finish_y:
                b.finished = True
                b.finish_t = t
                events.append(SimEvent(step_counter["i"], t, "finish",
                                        {"ball_id": b.info.id, "team_id": b.info.team_id}))

        # -- team resolution (best ball finished, or all 3 eliminated) --
        for tid in team_ids:
            if tid in team_resolved_t:
                continue
            tballs = [b for b in balls if b.info.team_id == tid]
            if any(b.finished for b in tballs):
                team_resolved_t[tid] = t
            elif all((not b.alive) for b in tballs):
                team_resolved_t[tid] = t

        # -- lead tracking --
        new_leader = max(team_ids, key=_team_progress) if team_ids else None
        if new_leader != leader_team_id:
            leader_team_id = new_leader
            events.append(SimEvent(step_counter["i"], t, "lead_change", {"team_id": leader_team_id}))

        # -- crusher near-miss tracking (armed/resolved, same style as Ring of Doom) --
        active_racers = [b for b in balls if b.alive and not b.finished]
        if active_racers:
            last_ball = min(active_racers, key=lambda b: b.body.position.y)
            gap = last_ball.body.position.y - crusher.y
            crusher_closest_gap = min(crusher_closest_gap, gap)
            if gap < 260 and not near_miss_armed:
                near_miss_armed = True
                near_miss_peak_gap = gap
            elif near_miss_armed:
                near_miss_peak_gap = min(near_miss_peak_gap, gap)
                if gap > 340:
                    events.append(SimEvent(step_counter["i"], t, "near_miss",
                                            {"ball_id": last_ball.info.id, "peak_r": -near_miss_peak_gap}))
                    near_miss_armed = False

        # -- record step --
        ball_states = []
        for b in balls:
            if b.alive:
                p, v = b.body.position, b.body.velocity
                ball_states.append(BallState(p.x, p.y, b.body.angle, v.x, v.y, not b.finished))
            else:
                p = b.fallback_pos if b.fallback_pos is not None else pymunk.Vec2d(0, 0)
                ball_states.append(BallState(p.x, p.y, 0.0, b.fall_vx, b.fall_vy, False))
        steps.append(StepRecord(t=t, ring_angle=crusher.y, gaps_deg=(), balls=ball_states))

        if len(team_resolved_t) >= len(team_ids) and finish_line_t is None:
            finish_line_t = max(team_resolved_t.values())
        if finish_line_t is not None and t >= finish_line_t + finish_tail:
            break

        t += dt
        step_counter["i"] += 1

    placements = sorted(team_ids, key=lambda tid: -_team_progress(tid))
    winner_team_id = placements[0] if placements and team_resolved_t.get(placements[0]) is not None else None

    mvp_ball = None
    if winner_team_id is not None:
        wballs = [b for b in balls if b.info.team_id == winner_team_id]
        finished_w = [b for b in wballs if b.finished]
        mvp_ball = min(finished_w, key=lambda b: b.finish_t) if finished_w else (
            max(wballs, key=lambda b: b.progress_y(finish_y)) if wballs else None)
    mvp_name = mvp_ball.info.name if mvp_ball else ""

    return SimRecord(
        seed=seed,
        event_id="disaster_drop",
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
