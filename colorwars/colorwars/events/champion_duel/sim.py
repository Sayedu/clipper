"""Champion Duel: deterministic 1v1 combat. No pymunk -- champions move at
a constant (per-champion) speed, steering (not bouncing) toward each
other with a seeded weave, the same "constant speed, direction-only"
style Turf War uses. Each team's signature power is a pure function of its
own hits-landed counter and its tunable teams.yaml `duel_power` trait, so
`colorwars balance` only ever has one number per team to move.
"""

from __future__ import annotations

import math

from ...engine.config import Settings, Team
from ...engine.records import BallInfo, BallState, SimEvent, SimRecord, StepRecord
from ...engine.rng import Rng
from ...league.names_queue import peek_names

TAU = 2 * math.pi
PHYSICS_HZ = 120


class _Champion:
    __slots__ = ("info", "team", "x", "y", "heading", "hp", "hits_landed",
                 "contact_cd_t", "spike_cd_t", "twin_cd_t",
                 "weave_freq", "weave_phase",
                 "knockback_until_t", "knockback_heading")

    def __init__(self, info: BallInfo, team: Team, x: float, y: float, heading: float,
                 hp: float, weave_freq: float, weave_phase: float):
        self.info = info
        self.team = team
        self.x = x
        self.y = y
        self.heading = heading
        self.hp = hp
        self.hits_landed = 0
        self.contact_cd_t = -999.0
        self.spike_cd_t = -999.0
        self.twin_cd_t = -999.0
        self.weave_freq = weave_freq
        self.weave_phase = weave_phase
        self.knockback_until_t = -1.0
        self.knockback_heading = 0.0


class _Twin:
    __slots__ = ("info", "x", "y", "alive", "cd_t")

    def __init__(self, info: BallInfo, x: float, y: float):
        self.info = info
        self.x = x
        self.y = y
        self.alive = False
        self.cd_t = -999.0


def _duel_power(team: Team, default: float) -> float:
    return float(team.traits.get("duel_power", default))


def _red_reach(hits: int, cfg: dict, power: float) -> float:
    return min(float(cfg["red_spike_max_reach"]), float(cfg["red_spike_base_reach"]) + hits * power)


def _red_spike_damage(reach: float, cfg: dict) -> float:
    """Scales with current reach (itself driven by duel_power) rather than
    a fixed number, so nerfing/buffing Red's power actually moves its
    damage output, not just how far it can poke."""
    extra = reach - float(cfg["red_spike_base_reach"])
    return float(cfg["red_spike_base_damage"]) + extra * float(cfg["red_spike_damage_per_reach_px"])


def _blue_shield_half_deg(hits: int, cfg: dict, power: float) -> float:
    width = min(float(cfg["blue_shield_max_deg"]), float(cfg["blue_shield_base_deg"]) + hits * power)
    return width / 2.0


def _green_twin_count(hits: int, cfg: dict) -> int:
    return min(int(cfg["green_twin_max"]), hits // int(cfg["green_twin_hits_per_spawn"]))


def _yellow_speed_mult(hits: int, power: float) -> float:
    return (1.0 + power) ** hits


def _turn_toward(heading: float, target: float, max_turn: float) -> float:
    diff = (target - heading + math.pi) % TAU - math.pi
    diff = max(-max_turn, min(max_turn, diff))
    return heading + diff


def simulate(seed: int, settings: Settings, event_cfg: dict, teams: list[Team], episode: dict) -> SimRecord:
    rng = Rng(seed)
    ccfg = event_cfg["champion"]
    pcfg = event_cfg["powers"]
    arena_origin = event_cfg["arena"]["origin"]
    arena_size = float(event_cfg["arena"]["size"])
    ax0, ay0 = float(arena_origin[0]), float(arena_origin[1])
    ax1, ay1 = ax0 + arena_size, ay0 + arena_size

    radius = float(ccfg["radius"])
    hp0 = float(ccfg["hp"])
    base_speed = float(ccfg["base_speed"])
    contact_damage = float(ccfg["contact_damage"])
    contact_cooldown = float(ccfg["contact_cooldown_sec"])
    turn_rate = float(ccfg["turn_rate"])
    weave_amp = math.radians(float(ccfg["weave_amplitude_deg"]))
    weave_fmin, weave_fmax = float(ccfg["weave_freq_min"]), float(ccfg["weave_freq_max"])
    knockback_push = float(ccfg["knockback_push"])
    knockback_sec = float(ccfg["knockback_sec"])

    teams_by_id = {t.id: t for t in teams}
    all_ids = [t.id for t in teams]
    matchup = episode.get("duel_matchup")
    if not matchup:
        pairs = [(i, j) for i in range(len(all_ids)) for j in range(i + 1, len(all_ids))]
        pair = rng.pick(pairs)
        matchup = (all_ids[pair[0]], all_ids[pair[1]])
    team_a, team_b = teams_by_id[matchup[0]], teams_by_id[matchup[1]]

    cx, cy = (ax0 + ax1) / 2, (ay0 + ay1) / 2

    def make_champion(cid: int, team: Team, start_x: float, start_y: float, heading: float) -> _Champion:
        name = peek_names(team.name, 1, settings.names_path, settings.blocklist_path)[0]
        info = BallInfo(id=cid, team_id=team.id, team_name=team.name, name=name, base_radius=radius)
        wf = rng.uniform(weave_fmin, weave_fmax)
        wp = rng.uniform(0, TAU)
        return _Champion(info, team, start_x, start_y, heading, hp0, wf, wp)

    champ_a = make_champion(0, team_a, ax0 + arena_size * 0.25, cy, 0.0)
    champ_b = make_champion(1, team_b, ax0 + arena_size * 0.75, cy, math.pi)
    champions = [champ_a, champ_b]

    twins: list[_Twin] = []
    next_twin_id = 2
    for champ in champions:
        if champ.team.id == "green":
            for _ in range(int(pcfg["green_twin_max"])):
                name = f"{champ.info.name} Jr"
                info = BallInfo(id=next_twin_id, team_id="green", team_name="Green", name=name, base_radius=15.0)
                twins.append(_Twin(info, champ.x, champ.y))
                next_twin_id += 1

    events: list[SimEvent] = []
    steps: list[StepRecord] = []
    step_i = 0
    t = 0.0
    sim_deadline = float(event_cfg["timing"]["sim_deadline_sec"])

    def opponent_of(c: _Champion) -> _Champion:
        return champ_b if c is champ_a else champ_a

    def deal_damage(defender: _Champion, source_x: float, source_y: float, damage: float, kind: str) -> bool:
        if defender.team.id == "blue":
            half = _blue_shield_half_deg(defender.hits_landed, pcfg, _duel_power(defender.team, 6.0))
            rot_speed = float(pcfg["blue_shield_rotation_speed"])
            center_deg = math.degrees(rot_speed * t) % 360.0
            ang_deg = math.degrees(math.atan2(source_y - defender.y, source_x - defender.x)) % 360.0
            if abs(((ang_deg - center_deg + 180) % 360) - 180) <= half:
                return False
        if defender.team.id == "yellow" and kind == "spike":
            # a fast-moving target is harder for a RANGED, constantly-
            # orbiting attack (Red's spikes specifically) to land cleanly
            # on -- without this Yellow's speed was purely offensive and
            # gave it zero answer to a poke it can't out-range, which
            # `balance` found directly: Yellow lost ~98% of logged runs
            # against Red regardless of how far either side's power was
            # pushed. Scoped to "spike" only, not twins/contact too -- a
            # first attempt covering all non-contact damage overcorrected
            # and made Yellow nearly immune to Green's twins instead,
            # flipping THAT matchup to the opposite extreme (also found by
            # actually re-running balance, not assumed safe).
            mult = _yellow_speed_mult(defender.hits_landed, _duel_power(defender.team, 0.06))
            damage *= max(0.25, 1.0 / mult)
        defender.hp = max(0.0, defender.hp - damage)
        return True

    def apply_hit(attacker: _Champion, defender: _Champion, damage: float, sx: float, sy: float, kind: str) -> None:
        landed = deal_damage(defender, sx, sy, damage, kind)
        if landed:
            attacker.hits_landed += 1
            defender.knockback_until_t = t + knockback_sec
            defender.knockback_heading = math.atan2(defender.y - sy, defender.x - sx)
        events.append(SimEvent(step_i, t, "hit", {
            "attacker": attacker.info.team_id, "defender": defender.info.team_id,
            "damage": damage if landed else 0.0, "blocked": not landed, "kind": kind,
            "x": defender.x, "y": defender.y, "defender_hp_after": defender.hp,
        }))

    dt = 1.0 / PHYSICS_HZ
    winner_team_id: str | None = None

    while t < sim_deadline:
        if champ_a.hp <= 0 or champ_b.hp <= 0:
            break

        for champ in champions:
            opp = opponent_of(champ)
            if t < champ.knockback_until_t:
                desired = champ.knockback_heading
            else:
                base_dir = math.atan2(opp.y - champ.y, opp.x - champ.x)
                weave = weave_amp * math.sin(champ.weave_freq * TAU * t + champ.weave_phase)
                desired = base_dir + weave
            champ.heading = _turn_toward(champ.heading, desired, turn_rate * dt)

            speed = base_speed
            if champ.team.id == "yellow":
                speed *= _yellow_speed_mult(champ.hits_landed, _duel_power(champ.team, 0.06))
            nx = champ.x + speed * math.cos(champ.heading) * dt
            ny = champ.y + speed * math.sin(champ.heading) * dt

            if nx - radius < ax0:
                nx = 2 * (ax0 + radius) - nx
                champ.heading = math.pi - champ.heading
            elif nx + radius > ax1:
                nx = 2 * (ax1 - radius) - nx
                champ.heading = math.pi - champ.heading
            if ny - radius < ay0:
                ny = 2 * (ay0 + radius) - ny
                champ.heading = -champ.heading
            elif ny + radius > ay1:
                ny = 2 * (ay1 - radius) - ny
                champ.heading = -champ.heading
            champ.x, champ.y = nx, ny

        # base contact damage, mutual. Yellow's speed converts into contact
        # damage here (momentum) -- without this, "6% speed per hit" never
        # actually helped Yellow WIN anything: both champions take contact
        # damage on the same overlap regardless of which one is faster, so
        # pure movement speed had no combat payoff at all (confirmed
        # directly: Yellow lost essentially every logged matchup, 0-100%,
        # and no amount of tuning its speed-growth power changed that).
        dist = math.hypot(champ_a.x - champ_b.x, champ_a.y - champ_b.y)
        if dist < radius * 2:
            if t - champ_a.contact_cd_t >= contact_cooldown:
                dmg_a = contact_damage
                if champ_a.team.id == "yellow":
                    dmg_a *= _yellow_speed_mult(champ_a.hits_landed, _duel_power(champ_a.team, 0.06))
                apply_hit(champ_a, champ_b, dmg_a, champ_a.x, champ_a.y, "contact")
                champ_a.contact_cd_t = t
            if t - champ_b.contact_cd_t >= contact_cooldown:
                dmg_b = contact_damage
                if champ_b.team.id == "yellow":
                    dmg_b *= _yellow_speed_mult(champ_b.hits_landed, _duel_power(champ_b.team, 0.06))
                apply_hit(champ_b, champ_a, dmg_b, champ_b.x, champ_b.y, "contact")
                champ_b.contact_cd_t = t

        # red spikes
        for champ in champions:
            if champ.team.id != "red" or champ.hp <= 0:
                continue
            opp = opponent_of(champ)
            if t - champ.spike_cd_t < float(pcfg["red_spike_cooldown_sec"]):
                continue
            reach = _red_reach(champ.hits_landed, pcfg, _duel_power(champ.team, 4.0))
            n_spikes = int(pcfg["red_spike_count"])
            rot = float(pcfg["red_spike_rotation_speed"])
            tip_r = float(pcfg["red_spike_tip_radius"])
            for k in range(n_spikes):
                ang = rot * t + k * (TAU / n_spikes)
                spike_x = champ.x + (radius + reach) * math.cos(ang)
                spike_y = champ.y + (radius + reach) * math.sin(ang)
                if math.hypot(spike_x - opp.x, spike_y - opp.y) <= opp.info.base_radius + tip_r:
                    apply_hit(champ, opp, _red_spike_damage(reach, pcfg), spike_x, spike_y, "spike")
                    champ.spike_cd_t = t
                    break

        # green twins: spawn up to current allowance, chase + hit
        for champ in champions:
            if champ.team.id != "green":
                continue
            allowed = _green_twin_count(champ.hits_landed, pcfg)
            owner_twins = [tw for tw in twins if tw.info.team_id == "green"]
            opp = opponent_of(champ)
            for idx, tw in enumerate(owner_twins):
                if idx < allowed and not tw.alive:
                    tw.alive = True
                    tw.x, tw.y = champ.x, champ.y
                if not tw.alive:
                    continue
                ang = math.atan2(opp.y - tw.y, opp.x - tw.x)
                speed = base_speed * float(pcfg["green_twin_speed_frac"])
                tw.x += speed * math.cos(ang) * dt
                tw.y += speed * math.sin(ang) * dt
                if math.hypot(tw.x - opp.x, tw.y - opp.y) <= opp.info.base_radius + tw.info.base_radius:
                    if t - tw.cd_t >= float(pcfg["green_twin_cooldown_sec"]):
                        apply_hit(champ, opp, _duel_power(champ.team, 1.0), tw.x, tw.y, "twin")
                        tw.cd_t = t

        # vx is repurposed to carry current HP (unused otherwise here) --
        # draw.py's live HP bar needs it every frame, and BallState has no
        # dedicated HP field of its own.
        ball_states = [BallState(c.x, c.y, c.heading, c.hp, 0.0, c.hp > 0) for c in champions]
        ball_states += [BallState(tw.x, tw.y, 0.0, 0.0, 0.0, tw.alive) for tw in twins]
        steps.append(StepRecord(t=t, ring_angle=0.0, gaps_deg=(), balls=ball_states))

        t += dt
        step_i += 1

    if champ_a.hp <= 0 and champ_b.hp > 0:
        winner_team_id = champ_b.info.team_id
    elif champ_b.hp <= 0 and champ_a.hp > 0:
        winner_team_id = champ_a.info.team_id
    else:
        winner_team_id = champ_a.info.team_id if champ_a.hp >= champ_b.hp else champ_b.info.team_id

    loser = champ_b if winner_team_id == champ_a.info.team_id else champ_a
    placements = [winner_team_id, loser.info.team_id]
    winner_champ = champ_a if winner_team_id == champ_a.info.team_id else champ_b
    mvp_name = winner_champ.info.name

    return SimRecord(
        seed=seed,
        event_id="champion_duel",
        physics_hz=PHYSICS_HZ,
        steps=steps,
        events=events,
        balls=[c.info for c in champions] + [tw.info for tw in twins],
        teams=[team_a, team_b],
        winner_team_id=winner_team_id,
        placements=placements,
        mvp_name=mvp_name,
        duration_steps=len(steps),
    )
