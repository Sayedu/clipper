"""Ring of Doom: deterministic physics. 240 Hz fixed steps, a spinning
kinematic ring with widening gaps, 16 balls (4 per team), periodic hazards.
Nothing here reads the wall clock or touches randomness outside the one
Rng instance it's given.
"""

from __future__ import annotations

import math

import pymunk

from ...engine.config import Settings, Team
from ...engine.records import BallInfo, BallState, SimEvent, SimRecord, StepRecord
from ...engine.rng import Rng

TAU = 2 * math.pi

# pymunk collision types
CT_WALL = 1
CT_BALL = 2
CT_HAZARD = 3


class _GapZone:
    __slots__ = ("center_deg", "half_width_deg")

    def __init__(self, center_deg: float, half_width_deg: float):
        self.center_deg = center_deg % 360.0
        self.half_width_deg = half_width_deg

    def covers(self, slot_center_deg: float) -> bool:
        d = (slot_center_deg - self.center_deg + 180) % 360 - 180
        return abs(d) <= self.half_width_deg


class _Ring:
    """The spinning ring: a kinematic body with up to 96 short wall
    segments attached in its local frame, some of which are removed where
    a gap currently covers them. Gaps only ever grow (widen or a new one
    opens), so this only ever removes segments, never re-adds them."""

    def __init__(self, cfg: dict, space: pymunk.Space):
        ring_cfg = cfg["ring"]
        self.radius = float(ring_cfg["radius"])
        self.center = tuple(ring_cfg["center"])
        self.segments = int(ring_cfg["segments"])
        self.thickness = float(ring_cfg["thickness"])
        self.rotation_speed = float(ring_cfg["rotation_speed"])
        self.speedup_per_phase = float(ring_cfg["rotation_speedup_per_phase"])

        self.body = pymunk.Body(body_type=pymunk.Body.KINEMATIC)
        self.body.position = self.center
        self.body.angle = 0.0
        self.body.angular_velocity = self.rotation_speed
        space.add(self.body)

        self.slot_deg = 360.0 / self.segments
        self._shapes: dict[int, pymunk.Segment] = {}
        self._space = space
        for i in range(self.segments):
            self._add_slot(i)

        self.gaps: list[_GapZone] = []
        self.reversed_once = False

    def _slot_points(self, i: int) -> tuple[tuple[float, float], tuple[float, float]]:
        a0 = math.radians(i * self.slot_deg)
        a1 = math.radians((i + 1) * self.slot_deg)
        r = self.radius
        return (r * math.cos(a0), r * math.sin(a0)), (r * math.cos(a1), r * math.sin(a1))

    def _add_slot(self, i: int) -> None:
        if i in self._shapes:
            return
        p0, p1 = self._slot_points(i)
        seg = pymunk.Segment(self.body, p0, p1, self.thickness / 2.0)
        seg.elasticity = 0.99  # was 0.9, then 0.97 -- matches the balls' own bounciness bump
        seg.friction = 0.15
        seg.collision_type = CT_WALL
        self._space.add(seg)
        self._shapes[i] = seg

    def _remove_slot(self, i: int) -> None:
        shape = self._shapes.pop(i, None)
        if shape is not None:
            self._space.remove(shape)

    def apply_gaps(self, gaps: list[_GapZone]) -> None:
        self.gaps = gaps
        for i in range(self.segments):
            slot_center = (i + 0.5) * self.slot_deg
            covered = any(g.covers(slot_center) for g in gaps)
            if covered and i in self._shapes:
                self._remove_slot(i)

    def speed_up(self) -> None:
        self.rotation_speed *= 1.0 + self.speedup_per_phase
        sign = 1.0 if self.body.angular_velocity >= 0 else -1.0
        self.body.angular_velocity = sign * self.rotation_speed

    def reverse(self) -> None:
        self.body.angular_velocity = -self.body.angular_velocity
        self.reversed_once = True

    def angle_deg(self) -> float:
        return math.degrees(self.body.angle) % 360.0


def _team_trait(team: Team, key: str, default):
    return team.traits.get(key, default)


def _spawn_positions(count: int, center: tuple[float, float], radius: float) -> list[tuple[float, float]]:
    out = []
    for i in range(count):
        a = TAU * i / count
        out.append((center[0] + radius * math.cos(a), center[1] + radius * math.sin(a)))
    return out


class _Ball:
    __slots__ = ("info", "body", "shape", "alive", "near_miss_armed", "near_miss_peak_r",
                 "elim_fall_vx", "elim_fall_vy", "body_pos_fallback")

    def __init__(self, info: BallInfo, body: pymunk.Body, shape: pymunk.Circle):
        self.info = info
        self.body = body
        self.shape = shape
        self.alive = True
        self.near_miss_armed = False
        self.near_miss_peak_r = 0.0
        self.elim_fall_vx = 0.0
        self.elim_fall_vy = 0.0
        self.body_pos_fallback = None


def simulate(seed: int, settings: Settings, cfg: dict, teams: list[Team], episode: dict,
             last_place_team_id: str | None = None) -> SimRecord:
    from ...league.names_queue import peek_names  # local import avoids a cycle with engine.event

    rng = Rng(seed)
    hz = int(cfg["physics"]["step_hz"])
    dt = 1.0 / hz
    gravity = float(cfg["gravity"])
    elim_radius = float(cfg["elimination_radius"])
    max_speed = float(cfg["physics"]["max_speed"])
    ball_radius_base = float(cfg["balls"]["radius"])
    ball_elasticity = float(cfg["balls"]["elasticity"])
    ball_friction = float(cfg["balls"]["friction"])

    space = pymunk.Space()
    space.gravity = (0, gravity)
    space.collision_bias = 0.0  # no bias-based position correction (keeps it fully deterministic by impulse only)

    # last-place team's one-time shield, fresh every episode (not season.json
    # state) -- absorbs their first hazard hit, whichever hazard type it is.
    shield_state = {"team_id": last_place_team_id, "available": last_place_team_id is not None}

    ring = _Ring(cfg, space)
    cx, cy = ring.center

    # ---- spawn balls: interleaved by team so one team's 4 aren't clustered ----
    spawn_radius = ring.radius * 0.5
    spawn_pts = _spawn_positions(len(teams) * cfg["balls"]["per_team"], (cx, cy), spawn_radius)

    balls: list[_Ball] = []
    ball_infos: list[BallInfo] = []
    per_team = int(cfg["balls"]["per_team"])
    slot = 0
    # queue-based, not random: the same names.txt state always assigns the
    # same names for the same team, in file order -- no RNG involved, so
    # commenters' names never depend on the seed.
    team_names = {t.id: peek_names(t.name, per_team, settings.names_path, settings.blocklist_path) for t in teams}
    for round_i in range(per_team):
        for team in teams:
            x, y = spawn_pts[slot]
            # small seeded jitter so it's not a perfect geometric ring
            x += rng.uniform(-20, 20)
            y += rng.uniform(-20, 20)

            radius = ball_radius_base * float(_team_trait(team, "radius_mult", 1.0))
            mass = 1.0 * float(_team_trait(team, "mass_mult", 1.0))
            elasticity = min(0.98, ball_elasticity + float(_team_trait(team, "elasticity_add", 0.0)))

            body = pymunk.Body(mass, pymunk.moment_for_circle(mass, 0, radius))
            body.position = (x, y)
            body.velocity = (rng.uniform(-80, 80), rng.uniform(-80, 80))
            shape = pymunk.Circle(body, radius)
            shape.elasticity = elasticity
            shape.friction = ball_friction
            shape.collision_type = CT_BALL
            space.add(body, shape)

            info = BallInfo(id=slot, team_id=team.id, team_name=team.name, name=team_names[team.id][round_i], base_radius=radius)
            ball = _Ball(info, body, shape)
            shape.ball_ref = ball  # dynamic attribute: collision callbacks map shape -> our wrapper
            balls.append(ball)
            ball_infos.append(info)
            slot += 1

    # ---- collision event logging ----
    events: list[SimEvent] = []
    step_counter = {"i": 0}

    def on_ball_ball_post_solve(arbiter, space_, data):
        a, b = arbiter.shapes
        impulse = arbiter.total_impulse.length
        if impulse < 1.0:
            return
        pos = (a.body.position + b.body.position) * 0.5
        events.append(SimEvent(step_counter["i"], step_counter["i"] / hz, "collision",
                                {"x": pos.x, "y": pos.y, "impulse": impulse, "kind": "ball_ball"}))

    def on_ball_wall_post_solve(arbiter, space_, data):
        a, b = arbiter.shapes
        impulse = arbiter.total_impulse.length
        if impulse < 1.0:
            return
        ball_shape = a if a.collision_type == CT_BALL else b
        events.append(SimEvent(step_counter["i"], step_counter["i"] / hz, "collision",
                                {"x": ball_shape.body.position.x, "y": ball_shape.body.position.y,
                                 "impulse": impulse, "kind": "ball_wall"}))

    def on_ball_hazard_post_solve(arbiter, space_, data):
        impulse = arbiter.total_impulse.length
        if impulse < 1.0:
            return
        a, b = arbiter.shapes
        ball_shape = a if a.collision_type == CT_BALL else b
        ball = ball_shape.ball_ref
        if shield_state["available"] and ball.info.team_id == shield_state["team_id"]:
            # the physical bounce already resolved by the time post_solve fires
            # (this isn't a pre-solve veto point) -- approximate "absorbed" by
            # damping the ball's resulting velocity, rather than leaving the
            # full hazard impact in place.
            ball_shape.body.velocity = ball_shape.body.velocity * 0.4
            shield_state["available"] = False
            events.append(SimEvent(step_counter["i"], step_counter["i"] / hz, "shield",
                                    {"ball_id": ball.info.id, "team_id": ball.info.team_id}))
            return
        events.append(SimEvent(step_counter["i"], step_counter["i"] / hz, "collision",
                                {"x": ball_shape.body.position.x, "y": ball_shape.body.position.y,
                                 "impulse": impulse, "kind": "ball_hazard"}))

    space.on_collision(CT_BALL, CT_BALL, post_solve=on_ball_ball_post_solve)
    space.on_collision(CT_BALL, CT_WALL, post_solve=on_ball_wall_post_solve)
    space.on_collision(CT_BALL, CT_HAZARD, post_solve=on_ball_hazard_post_solve)

    # ---- gap schedule state ----
    gap_cfg = cfg["gaps"]
    gaps: list[_GapZone] = [_GapZone(rng.uniform(0, 360), cfg["ring"]["initial_gap_deg"] / 2.0)]
    ring.apply_gaps(gaps)
    next_gap_event_t = gap_cfg["interval_sec"]
    gap_warning_fired = False
    reverse_at_t = rng.uniform(15.0, 50.0)  # the one random reverse point, if enabled below
    reverse_enabled = bool(cfg["ring"].get("reverse_once", True))

    # ---- hazard schedule state ----
    haz_cfg = cfg["hazards"]
    next_hazard_t = rng.uniform(haz_cfg["interval_min_sec"], haz_cfg["interval_max_sec"])
    hazard_warning_fired = False
    active_hazard = None  # {"kind","body","shape","end_t"}

    teams_by_id = {t.id: t for t in teams}
    crown_team_id = episode.get("crown_team")

    def alive_count(team_id: str) -> int:
        return sum(1 for b in balls if b.alive and b.info.team_id == team_id)

    leader = None
    team_eliminated_step: dict[str, int] = {}
    steps: list[StepRecord] = []

    sim_deadline = float(cfg["timing"]["sim_deadline_sec"])
    t = 0.0
    i = 0
    winner_team_id = None

    while t < sim_deadline:
        step_counter["i"] = i

        # -- gap schedule --
        fast_after = gap_cfg["fast_after_sec"]
        interval = gap_cfg["fast_interval_sec"] if t >= fast_after else gap_cfg["interval_sec"]
        warn_lead = gap_cfg["warning_sec"]
        if not gap_warning_fired and t >= next_gap_event_t - warn_lead:
            events.append(SimEvent(i, t, "warning", {"about": "gap"}))
            gap_warning_fired = True
        if t >= next_gap_event_t:
            if len(gaps) < gap_cfg["max_gaps"] and rng.chance(0.5):
                gaps.append(_GapZone(rng.uniform(0, 360), gap_cfg["widen_deg"] / 2.0))
                events.append(SimEvent(i, t, "gap_change", {"action": "new_gap", "count": len(gaps)}))
            else:
                g = rng.pick(gaps)
                g.half_width_deg += gap_cfg["widen_deg"]
                events.append(SimEvent(i, t, "gap_change", {"action": "widen", "half_width_deg": g.half_width_deg}))
            ring.apply_gaps(gaps)
            ring.speed_up()
            next_gap_event_t = t + interval
            gap_warning_fired = False

        # -- ring reversal (once), only if the config actually asks for it --
        # cfg["ring"]["reverse_once"] used to be dead config (the reversal
        # always fired regardless of this flag) -- fixed to actually gate on
        # it, since always-reversing is exactly what was reported as "it
        # just rotates the other way" at the end.
        if reverse_enabled and not ring.reversed_once and t >= reverse_at_t:
            ring.reverse()
            events.append(SimEvent(i, t, "reverse", {}))

        # -- hazard schedule --
        if active_hazard is not None and t >= active_hazard["end_t"]:
            for shp in active_hazard["shapes"]:
                space.remove(shp)
            space.remove(active_hazard["body"])
            active_hazard = None

        if active_hazard is None:
            if not hazard_warning_fired and t >= next_hazard_t - haz_cfg["warning_sec"]:
                events.append(SimEvent(i, t, "warning", {"about": "hazard"}))
                hazard_warning_fired = True
            if t >= next_hazard_t:
                kind = rng.pick(list(haz_cfg["types"]))
                if kind == "lightning":
                    alive_balls = [b for b in balls if b.alive]
                    if alive_balls:
                        weights = [2.0 if b.info.team_id == crown_team_id else 1.0 for b in alive_balls]
                        total = sum(weights)
                        r = rng.uniform(0, total)
                        acc = 0.0
                        target = alive_balls[-1]
                        for b, w in zip(alive_balls, weights):
                            acc += w
                            if r <= acc:
                                target = b
                                break
                        if shield_state["available"] and target.info.team_id == shield_state["team_id"]:
                            shield_state["available"] = False
                            events.append(SimEvent(i, t, "shield", {"ball_id": target.info.id, "team_id": target.info.team_id}))
                        else:
                            ang = rng.uniform(0, TAU)
                            mag = 1800.0
                            target.body.apply_impulse_at_local_point((mag * math.cos(ang), mag * math.sin(ang)))
                            events.append(SimEvent(i, t, "hazard", {"kind": "lightning", "ball_id": target.info.id}))
                elif kind == "center_bumper":
                    hb = pymunk.Body(body_type=pymunk.Body.STATIC)
                    hb.position = (cx, cy)
                    hs = pymunk.Circle(hb, 70)
                    hs.elasticity = 1.1
                    hs.collision_type = CT_HAZARD
                    space.add(hb, hs)
                    active_hazard = {"kind": kind, "body": hb, "shapes": [hs], "end_t": t + haz_cfg["center_bumper_duration_sec"]}
                    events.append(SimEvent(i, t, "hazard", {"kind": kind}))
                else:  # spinner_bar
                    hb = pymunk.Body(body_type=pymunk.Body.KINEMATIC)
                    hb.position = (cx, cy)
                    hb.angular_velocity = rng.pick([-1, 1]) * 3.0
                    hs = pymunk.Segment(hb, (-180, 0), (180, 0), 10)
                    hs.elasticity = 1.0
                    hs.collision_type = CT_HAZARD
                    space.add(hb, hs)
                    active_hazard = {"kind": kind, "body": hb, "shapes": [hs], "end_t": t + haz_cfg["spinner_bar_duration_sec"]}
                    # angular_velocity recorded so draw.py can replay the bar's
                    # exact rotation -- it was never drawn at all before (see
                    # draw.py), which is exactly why a ball suddenly getting
                    # hit by it looked like it moved "out of nowhere."
                    events.append(SimEvent(i, t, "hazard", {"kind": kind, "angular_velocity": hb.angular_velocity}))
                next_hazard_t = t + rng.uniform(haz_cfg["interval_min_sec"], haz_cfg["interval_max_sec"])
                hazard_warning_fired = False

        # -- physics step --
        space.step(dt)

        # -- speed cap + anti-stuck + elimination + near-miss, for alive balls --
        for b in balls:
            if not b.alive:
                # already-eliminated balls keep falling off-screen under a simple
                # manual kinematic extrapolation (they're out of the pymunk space)
                b.elim_fall_vy += gravity * dt
                continue
            v = b.body.velocity
            speed = v.length
            if speed > max_speed:
                b.body.velocity = v * (max_speed / speed)

            pos = b.body.position

            r = math.hypot(pos.x - cx, pos.y - cy)
            if r >= 410 and not b.near_miss_armed:
                b.near_miss_armed = True
                b.near_miss_peak_r = r
            elif b.near_miss_armed:
                b.near_miss_peak_r = max(b.near_miss_peak_r, r)
                if r < 390:
                    events.append(SimEvent(i, t, "near_miss", {"ball_id": b.info.id, "peak_r": b.near_miss_peak_r}))
                    b.near_miss_armed = False

            if r >= elim_radius:
                b.alive = False
                b.elim_fall_vx, b.elim_fall_vy = b.body.velocity.x, b.body.velocity.y
                b.body_pos_fallback = pymunk.Vec2d(pos.x, pos.y)
                space.remove(b.shape, b.body)
                events.append(SimEvent(i, t, "elimination", {"ball_id": b.info.id, "team_id": b.info.team_id}))
                if alive_count(b.info.team_id) == 0:
                    team_eliminated_step[b.info.team_id] = i

        # -- advance eliminated balls' fallback position (manual, out of pymunk) --
        for b in balls:
            if not b.alive and b.body_pos_fallback is not None:
                b.body_pos_fallback = pymunk.Vec2d(
                    b.body_pos_fallback.x + b.elim_fall_vx * dt,
                    b.body_pos_fallback.y + b.elim_fall_vy * dt,
                )

        # -- lead tracking --
        counts = {tm.id: alive_count(tm.id) for tm in teams}
        best = max(counts.values())
        tied = [tid for tid, c in counts.items() if c == best]
        if leader not in tied:
            leader = sorted(tied, key=lambda tid: [tm.id for tm in teams].index(tid))[0]
            events.append(SimEvent(i, t, "lead_change", {"team_id": leader}))

        # -- record step --
        ball_states = []
        for b in balls:
            if b.alive:
                p, v = b.body.position, b.body.velocity
                ball_states.append(BallState(p.x, p.y, b.body.angle, v.x, v.y, True))
            else:
                p = b.body_pos_fallback if b.body_pos_fallback is not None else pymunk.Vec2d(0, 0)
                ball_states.append(BallState(p.x, p.y, 0.0, b.elim_fall_vx, b.elim_fall_vy, False))
        steps.append(StepRecord(
            t=t,
            ring_angle=ring.body.angle,
            gaps_deg=tuple((g.center_deg, g.half_width_deg) for g in gaps),
            balls=ball_states,
        ))

        # -- stop early once only one team remains --
        alive_teams = [tm.id for tm in teams if alive_count(tm.id) > 0]
        if len(alive_teams) <= 1 and winner_team_id is None:
            winner_team_id = alive_teams[0] if alive_teams else leader
            break

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
        event_id="ring_of_doom",
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
