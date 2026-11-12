"""Turf War: deterministic grid-territory game. No pymunk -- balls move at
constant speed in straight lines, bouncing off the arena walls and off any
cell they enter that isn't already their own team's (which also converts
it). Zero per-step grid snapshots go in StepRecord (784 cells every
physics step would be far more data than this needs) -- the grid's state
at any sim_t is reconstructed later from a sparse "cell_converted" event
log plus the fixed initial-quadrant rule, the same "regenerate from the
log" approach Disaster Drop's course geometry uses.
"""

from __future__ import annotations

import math

from ...engine.config import Settings, Team
from ...engine.records import BallInfo, BallState, SimEvent, SimRecord, StepRecord
from ...engine.rng import Rng
from ...league.names_queue import peek_names

TAU = 2 * math.pi
PHYSICS_HZ = 120


def initial_grid(size: int, team_ids: list[str]) -> list[list[str]]:
    """Fixed (not seeded) quadrant assignment: team order from teams.yaml
    maps to top-left, top-right, bottom-left, bottom-right. Always the
    same regardless of seed -- draw.py recomputes this directly rather
    than needing it logged as an event."""
    half = size // 2
    grid = []
    for r in range(size):
        row = []
        for c in range(size):
            top, left = r < half, c < half
            if top and left:
                row.append(team_ids[0])
            elif top and not left:
                row.append(team_ids[1])
            elif not top and left:
                row.append(team_ids[2])
            else:
                row.append(team_ids[3])
        grid.append(row)
    return grid


def simulate(seed: int, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
    rng = Rng(seed)
    grid_cfg = event_cfg["grid"]
    size = int(grid_cfg["size"])
    cell_px = float(grid_cfg["cell_px"])
    ox, oy = float(grid_cfg["origin"][0]), float(grid_cfg["origin"][1])

    ball_cfg = event_cfg["ball"]
    radius = float(ball_cfg["radius"])
    base_speed = float(ball_cfg["speed"])

    pu_cfg = event_cfg["powerups"]
    pu_interval = float(pu_cfg["interval_sec"])
    bomb_r = int(pu_cfg["bomb_radius_cells"])
    ghost_n = int(pu_cfg["ghost_cells"])
    speed_mult = float(pu_cfg["speed_mult"])
    speed_dur = float(pu_cfg["speed_duration_sec"])

    team_ids = [t.id for t in teams]
    if len(team_ids) != 4:
        raise ValueError("turf_war needs exactly 4 teams (one per quadrant)")

    half = size // 2
    grid = initial_grid(size, team_ids)
    cells_owned = {tid: 0 for tid in team_ids}
    for row in grid:
        for owner in row:
            cells_owned[owner] += 1

    balls = []
    for i, team in enumerate(teams):
        name = peek_names(team.name, 1, settings.names_path, settings.blocklist_path)[0]
        info = BallInfo(id=i, team_id=team.id, team_name=team.name, name=name, base_radius=radius)
        qr, qc = (0 if i in (0, 1) else 1), (0 if i in (0, 2) else 1)
        cell_r = rng.randint(qr * half + 2, (qr + 1) * half - 3)
        cell_c = rng.randint(qc * half + 2, (qc + 1) * half - 3)
        x = ox + (cell_c + 0.5) * cell_px
        y = oy + (cell_r + 0.5) * cell_px
        ang = rng.uniform(0, TAU)
        balls.append({
            "info": info, "x": x, "y": y,
            "vx": base_speed * math.cos(ang), "vy": base_speed * math.sin(ang),
            "alive": True, "ghost_left": 0, "speed_until": 0.0,
            "prev_cell": (cell_r, cell_c),
        })

    dt = 1.0 / PHYSICS_HZ
    steps: list[StepRecord] = []
    events: list[SimEvent] = []
    step_i = 0
    t = 0.0
    sim_deadline = float(event_cfg["timing"]["sim_deadline_sec"])

    arena_min_x, arena_min_y = ox, oy
    arena_max_x, arena_max_y = ox + size * cell_px, oy + size * cell_px

    leader = max(team_ids, key=lambda tid: cells_owned[tid])
    team_elim_t: dict[str, float] = {}
    powerup: dict | None = None
    next_pu_t = pu_interval

    def eliminate_if_empty(owner_tid: str) -> None:
        if cells_owned[owner_tid] == 0 and owner_tid not in team_elim_t:
            team_elim_t[owner_tid] = t
            events.append(SimEvent(step_i, t, "elimination", {"team_id": owner_tid}))
            for ob in balls:
                if ob["info"].team_id == owner_tid:
                    ob["alive"] = False

    def convert(r: int, c: int, tid: str) -> None:
        owner = grid[r][c]
        if owner == tid:
            return
        grid[r][c] = tid
        cells_owned[owner] -= 1
        cells_owned[tid] += 1
        events.append(SimEvent(step_i, t, "cell_converted", {"cell": [r, c], "team_id": tid}))
        eliminate_if_empty(owner)

    while t < sim_deadline:
        if sum(1 for tid in team_ids if cells_owned[tid] > 0) <= 1:
            break

        if powerup is None and t >= next_pu_t:
            r, c = rng.randint(0, size - 1), rng.randint(0, size - 1)
            ptype = rng.pick(["bomb", "ghost", "speed"])
            powerup = {"cell": (r, c), "type": ptype}
            events.append(SimEvent(step_i, t, "powerup_spawn", {"cell": [r, c], "type": ptype}))
            next_pu_t = t + pu_interval

        for b in balls:
            if not b["alive"]:
                continue
            mult = speed_mult if t < b["speed_until"] else 1.0
            nx = b["x"] + b["vx"] * mult * dt
            ny = b["y"] + b["vy"] * mult * dt

            if nx - radius < arena_min_x:
                nx = 2 * (arena_min_x + radius) - nx
                b["vx"] = abs(b["vx"])
            elif nx + radius > arena_max_x:
                nx = 2 * (arena_max_x - radius) - nx
                b["vx"] = -abs(b["vx"])
            if ny - radius < arena_min_y:
                ny = 2 * (arena_min_y + radius) - ny
                b["vy"] = abs(b["vy"])
            elif ny + radius > arena_max_y:
                ny = 2 * (arena_max_y - radius) - ny
                b["vy"] = -abs(b["vy"])
            b["x"], b["y"] = nx, ny

            cell_r = min(size - 1, max(0, int((ny - oy) // cell_px)))
            cell_c = min(size - 1, max(0, int((nx - ox) // cell_px)))
            prev_r, prev_c = b["prev_cell"]
            if (cell_r, cell_c) != (prev_r, prev_c):
                tid = b["info"].team_id
                if grid[cell_r][cell_c] != tid:
                    convert(cell_r, cell_c, tid)
                    if b["ghost_left"] > 0:
                        b["ghost_left"] -= 1
                    else:
                        if cell_r != prev_r:
                            b["vy"] = -b["vy"]
                        if cell_c != prev_c:
                            b["vx"] = -b["vx"]
                b["prev_cell"] = (cell_r, cell_c)

                if powerup is not None and (cell_r, cell_c) == powerup["cell"]:
                    ptype = powerup["type"]
                    if ptype == "bomb":
                        for dr in range(-bomb_r, bomb_r + 1):
                            for dc in range(-bomb_r, bomb_r + 1):
                                rr, cc = cell_r + dr, cell_c + dc
                                if 0 <= rr < size and 0 <= cc < size:
                                    convert(rr, cc, tid)
                    elif ptype == "ghost":
                        b["ghost_left"] = ghost_n
                    elif ptype == "speed":
                        b["speed_until"] = t + speed_dur
                    events.append(SimEvent(step_i, t, "powerup_pickup", {"team_id": tid, "type": ptype}))
                    powerup = None

        new_leader = max(team_ids, key=lambda tid: cells_owned[tid])
        if new_leader != leader:
            leader = new_leader
            events.append(SimEvent(step_i, t, "lead_change", {"team_id": leader}))

        steps.append(StepRecord(
            t=t, ring_angle=0.0, gaps_deg=(),
            balls=[BallState(b["x"], b["y"], 0.0, b["vx"], b["vy"], b["alive"]) for b in balls],
        ))

        t += dt
        step_i += 1

    placements = sorted(team_ids, key=lambda tid: (cells_owned[tid] if cells_owned[tid] > 0 else -1,
                                                     team_elim_t.get(tid, -1.0)), reverse=True)
    winner_team_id = placements[0]
    winner_ball = next(b for b in balls if b["info"].team_id == winner_team_id)
    mvp_name = winner_ball["info"].name

    return SimRecord(
        seed=seed,
        event_id="turf_war",
        physics_hz=PHYSICS_HZ,
        steps=steps,
        events=events,
        balls=[b["info"] for b in balls],
        teams=teams,
        winner_team_id=winner_team_id,
        placements=placements,
        mvp_name=mvp_name,
        duration_steps=len(steps),
    )
