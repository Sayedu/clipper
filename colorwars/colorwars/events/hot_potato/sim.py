"""Hot Potato: 16 balls (4 per team) bounce inside a solid circular arena.
One ball holds "the bomb" at a time; touching the holder passes it to you.
Every round has a shrinking timer -- whoever's holding it when the timer
hits zero is eliminated, and the bomb restarts on a fresh random holder
for a shorter round. Last team standing wins.

No ring rotation, no gaps, no hazards -- the arena is one static, always-
solid wall (same discrete-segment technique Ring of Doom uses for its own
wall, just never animated or opened). All the drama comes from the bomb
mechanic itself: nothing here applies an impulse to a ball that isn't a
direct result of a real collision or gravity, by the same "no invisible
forces" rule Ring of Doom's anti-stuck impulse was removed for.
"""

from __future__ import annotations

import math

import pymunk

from ...engine.config import Settings, Team
from ...engine.records import BallInfo, BallState, SimEvent, SimRecord, StepRecord
from ...engine.rng import Rng

TAU = 2 * math.pi

CT_WALL = 1
CT_BALL = 2


def _spawn_positions(count: int, center: tuple[float, float], radius: float) -> list[tuple[float, float]]:
    out = []
    for i in range(count):
        a = TAU * i / count
        out.append((center[0] + radius * math.cos(a), center[1] + radius * math.sin(a)))
    return out


class _Ball:
    __slots__ = ("info", "body", "shape", "alive", "elim_fall_vx", "elim_fall_vy", "body_pos_fallback")

    def __init__(self, info: BallInfo, body: pymunk.Body, shape: pymunk.Circle):
        self.info = info
        self.body = body
        self.shape = shape
        self.alive = True
        self.elim_fall_vx = 0.0
        self.elim_fall_vy = 0.0
        self.body_pos_fallback = None


def simulate(seed: int, settings: Settings, cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
    from ...league.names_queue import peek_names  # local import avoids a cycle with engine.event

    rng = Rng(seed)
    hz = int(cfg["physics"]["step_hz"])
    dt = 1.0 / hz
    gravity = float(cfg["gravity"])
    max_speed = float(cfg["physics"]["max_speed"])
    ball_radius_base = float(cfg["balls"]["radius"])
    ball_elasticity = float(cfg["balls"]["elasticity"])
    ball_friction = float(cfg["balls"]["friction"])

    arena_cfg = cfg["arena"]
    arena_radius = float(arena_cfg["radius"])
    arena_center = tuple(arena_cfg["center"])
    arena_segments = int(arena_cfg["segments"])
    arena_thickness = float(arena_cfg["thickness"])

    bomb_cfg = cfg["bomb"]
    round_sec_start = float(bomb_cfg["round_sec_start"])
    round_sec_min = float(bomb_cfg["round_sec_min"])
    round_sec_decay = float(bomb_cfg["round_sec_decay"])
    pass_cooldown = float(bomb_cfg["pass_cooldown_sec"])
    warning_sec = float(bomb_cfg["warning_sec"])

    space = pymunk.Space()
    space.gravity = (0, gravity)
    space.collision_bias = 0.0

    cx, cy = arena_center
    arena_body = pymunk.Body(body_type=pymunk.Body.STATIC)
    arena_body.position = arena_center
    space.add(arena_body)
    slot_deg = 360.0 / arena_segments
    for i in range(arena_segments):
        a0 = math.radians(i * slot_deg)
        a1 = math.radians((i + 1) * slot_deg)
        p0 = (arena_radius * math.cos(a0), arena_radius * math.sin(a0))
        p1 = (arena_radius * math.cos(a1), arena_radius * math.sin(a1))
        seg = pymunk.Segment(arena_body, p0, p1, arena_thickness / 2.0)
        seg.elasticity = 0.97
        seg.friction = 0.2
        seg.collision_type = CT_WALL
        space.add(seg)

    # ---- spawn balls: interleaved by team so one team's 4 aren't clustered ----
    spawn_radius = arena_radius * 0.5
    spawn_pts = _spawn_positions(len(teams) * cfg["balls"]["per_team"], (cx, cy), spawn_radius)

    balls: list[_Ball] = []
    ball_infos: list[BallInfo] = []
    per_team = int(cfg["balls"]["per_team"])
    slot = 0
    team_names = {t.id: peek_names(t.name, per_team, settings.names_path, settings.blocklist_path) for t in teams}
    for round_i in range(per_team):
        for team in teams:
            x, y = spawn_pts[slot]
            x += rng.uniform(-20, 20)
            y += rng.uniform(-20, 20)

            radius = ball_radius_base
            mass = 1.0
            body = pymunk.Body(mass, pymunk.moment_for_circle(mass, 0, radius))
            body.position = (x, y)
            body.velocity = (rng.uniform(-80, 80), rng.uniform(-80, 80))
            shape = pymunk.Circle(body, radius)
            shape.elasticity = ball_elasticity
            shape.friction = ball_friction
            shape.collision_type = CT_BALL
            space.add(body, shape)

            info = BallInfo(id=slot, team_id=team.id, team_name=team.name, name=team_names[team.id][round_i], base_radius=radius)
            ball = _Ball(info, body, shape)
            shape.ball_ref = ball
            balls.append(ball)
            ball_infos.append(info)
            slot += 1

    events: list[SimEvent] = []
    step_counter = {"i": 0}

    # ---- bomb state ----
    alive_ids = [b.info.id for b in balls]
    holder_id = rng.pick(alive_ids)
    round_num = 1
    round_duration = round_sec_start
    round_deadline = round_duration
    last_pass_t = -999.0
    warning_fired = False

    def on_ball_ball_post_solve(arbiter, space_, data):
        nonlocal holder_id, last_pass_t
        impulse = arbiter.total_impulse.length
        if impulse < 1.0:
            return
        a, b = arbiter.shapes
        pos = (a.body.position + b.body.position) * 0.5
        t_now = step_counter["i"] / hz
        events.append(SimEvent(step_counter["i"], t_now, "collision",
                                {"x": pos.x, "y": pos.y, "impulse": impulse, "kind": "ball_ball"}))

        ball_a: _Ball = a.ball_ref
        ball_b: _Ball = b.ball_ref
        if t_now - last_pass_t < pass_cooldown:
            return
        if ball_a.info.id == holder_id and ball_b.alive:
            holder_id = ball_b.info.id
            last_pass_t = t_now
            events.append(SimEvent(step_counter["i"], t_now, "bomb_pass",
                                    {"from_ball_id": ball_a.info.id, "to_ball_id": ball_b.info.id}))
        elif ball_b.info.id == holder_id and ball_a.alive:
            holder_id = ball_a.info.id
            last_pass_t = t_now
            events.append(SimEvent(step_counter["i"], t_now, "bomb_pass",
                                    {"from_ball_id": ball_b.info.id, "to_ball_id": ball_a.info.id}))

    def on_ball_wall_post_solve(arbiter, space_, data):
        impulse = arbiter.total_impulse.length
        if impulse < 1.0:
            return
        a, b = arbiter.shapes
        ball_shape = a if a.collision_type == CT_BALL else b
        events.append(SimEvent(step_counter["i"], step_counter["i"] / hz, "collision",
                                {"x": ball_shape.body.position.x, "y": ball_shape.body.position.y,
                                 "impulse": impulse, "kind": "ball_wall"}))

    space.on_collision(CT_BALL, CT_BALL, post_solve=on_ball_ball_post_solve)
    space.on_collision(CT_BALL, CT_WALL, post_solve=on_ball_wall_post_solve)

    balls_by_id = {b.info.id: b for b in balls}

    def alive_count(team_id: str) -> int:
        return sum(1 for b in balls if b.alive and b.info.team_id == team_id)

    leader = None
    team_eliminated_step: dict[str, int] = {}
    steps: list[StepRecord] = []

    sim_deadline = float(cfg["timing"]["sim_deadline_sec"])
    t = 0.0
    i = 0
    winner_team_id = None

    events.append(SimEvent(0, 0.0, "bomb_round_start",
                            {"holder_ball_id": holder_id, "round_num": round_num, "round_deadline": round_deadline}))

    while t < sim_deadline:
        step_counter["i"] = i

        if not warning_fired and t >= round_deadline - warning_sec and t < round_deadline:
            events.append(SimEvent(i, t, "warning", {"about": "bomb"}))
            warning_fired = True

        if t >= round_deadline:
            holder = balls_by_id.get(holder_id)
            if holder is not None and holder.alive:
                holder.alive = False
                holder.elim_fall_vx, holder.elim_fall_vy = holder.body.velocity.x, holder.body.velocity.y
                pos = holder.body.position
                holder.body_pos_fallback = pymunk.Vec2d(pos.x, pos.y)
                space.remove(holder.shape, holder.body)
                events.append(SimEvent(i, t, "elimination",
                                        {"ball_id": holder.info.id, "team_id": holder.info.team_id, "cause": "bomb"}))
                if alive_count(holder.info.team_id) == 0:
                    team_eliminated_step[holder.info.team_id] = i

            alive_teams_now = [tm.id for tm in teams if alive_count(tm.id) > 0]
            if len(alive_teams_now) <= 1:
                winner_team_id = alive_teams_now[0] if alive_teams_now else leader
                # record this final step before stopping, same as the main
                # per-step recording below, so the last frame reflects the
                # just-eliminated holder too
                ball_states = []
                for b in balls:
                    if b.alive:
                        p, v = b.body.position, b.body.velocity
                        ball_states.append(BallState(p.x, p.y, b.body.angle, v.x, v.y, True))
                    else:
                        p = b.body_pos_fallback if b.body_pos_fallback is not None else pymunk.Vec2d(0, 0)
                        ball_states.append(BallState(p.x, p.y, 0.0, b.elim_fall_vx, b.elim_fall_vy, False))
                steps.append(StepRecord(t=t, ring_angle=0.0, gaps_deg=(), balls=ball_states))
                break

            remaining_ids = [b.info.id for b in balls if b.alive]
            holder_id = rng.pick(remaining_ids)
            round_num += 1
            round_duration = max(round_sec_min, round_duration * round_sec_decay)
            round_deadline = t + round_duration
            warning_fired = False
            events.append(SimEvent(i, t, "bomb_round_start",
                                    {"holder_ball_id": holder_id, "round_num": round_num, "round_deadline": round_deadline}))

        space.step(dt)

        for b in balls:
            if not b.alive:
                b.elim_fall_vy += gravity * dt
                continue
            v = b.body.velocity
            speed = v.length
            if speed > max_speed:
                b.body.velocity = v * (max_speed / speed)

        for b in balls:
            if not b.alive and b.body_pos_fallback is not None:
                b.body_pos_fallback = pymunk.Vec2d(
                    b.body_pos_fallback.x + b.elim_fall_vx * dt,
                    b.body_pos_fallback.y + b.elim_fall_vy * dt,
                )

        counts = {tm.id: alive_count(tm.id) for tm in teams}
        best = max(counts.values())
        tied = [tid for tid, c in counts.items() if c == best]
        if leader not in tied:
            leader = sorted(tied, key=lambda tid: [tm.id for tm in teams].index(tid))[0]
            events.append(SimEvent(i, t, "lead_change", {"team_id": leader}))

        ball_states = []
        for b in balls:
            if b.alive:
                p, v = b.body.position, b.body.velocity
                ball_states.append(BallState(p.x, p.y, b.body.angle, v.x, v.y, True))
            else:
                p = b.body_pos_fallback if b.body_pos_fallback is not None else pymunk.Vec2d(0, 0)
                ball_states.append(BallState(p.x, p.y, 0.0, b.elim_fall_vx, b.elim_fall_vy, False))
        steps.append(StepRecord(t=t, ring_angle=0.0, gaps_deg=(), balls=ball_states))

        t += dt
        i += 1

    placements = [winner_team_id] if winner_team_id else []
    losers = sorted(
        (tid for tid in team_eliminated_step if tid != winner_team_id),
        key=lambda tid: team_eliminated_step[tid],
        reverse=True,
    )
    placements.extend(losers)

    survivor = next((b for b in balls if b.alive), None)
    mvp_name = survivor.info.name if survivor else (balls[-1].info.name if balls else "")

    return SimRecord(
        seed=seed,
        event_id="hot_potato",
        physics_hz=hz,
        steps=steps,
        events=events,
        balls=ball_infos,
        teams=teams,
        winner_team_id=winner_team_id,
        placements=placements,
        mvp_name=mvp_name,
        duration_steps=len(steps),
    )
