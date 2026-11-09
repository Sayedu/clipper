"""3D marble race — Blender headless renderer.

A wooden obstacle course is generated fresh each run; glossy marbles are dropped
in with real rigid-body physics and race to the finish. A chase camera follows
the leader down the course. Rendered with EEVEE.

Run:  blender --background --factory-startup --python marblerace.py -- \
        --seed N --balls N --target SEC --res 1080x1920 --fps 30 \
        --out-frames DIR --out JSON [--quick]

Writes a PNG sequence to --out-frames and a result JSON to --out. The Node step
muxes the frames + a synthesised audio track into the final mp4.
"""

import argparse
import json
import math
import os
import random
import sys

import bpy
import mathutils

V = mathutils.Vector


# ---------------------------------------------------------------- args / io

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=-1)
    ap.add_argument("--balls", type=int, default=4)
    ap.add_argument("--target", type=float, default=24.0)
    ap.add_argument("--res", default="1080x1920")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--out-frames", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--quick", action="store_true")
    return ap.parse_args(argv)


def log(m):
    sys.stderr.write(str(m).rstrip() + "\n")
    sys.stderr.flush()


def progress(p, m=""):
    sys.stderr.write("@progress " + json.dumps({"pct": max(0.0, min(1.0, p)), "msg": m}) + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- constants

MARBLES = [
    ("RED",    (0.83, 0.07, 0.09)),
    ("GREEN",  (0.30, 0.78, 0.14)),
    ("BLUE",   (0.09, 0.40, 0.92)),
    ("YELLOW", (0.97, 0.79, 0.08)),
    ("ORANGE", (0.97, 0.42, 0.06)),
    ("CYAN",   (0.10, 0.80, 0.88)),
]

MR = 0.40          # marble radius
LANE_W = 3.6       # lane floor width
WALL_H = 2.6       # tall walls, leaned inward — the lane is a deep trough
WALL_LEAN = math.radians(16)
WALL_T = 0.34
FLOOR_T = 0.5


# ---------------------------------------------------------------- helpers

def cube(name, loc, size, rot=(0, 0, 0), mat=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = size
    if mat:
        o.data.materials.append(mat)
    return o


def cyl(name, loc, radius, depth, rot=(0, 0, 0), mat=None, verts=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth,
                                        location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    if mat:
        o.data.materials.append(mat)
    return o


def add_rb(o, kind, bounce=0.15, friction=0.6, mass=1.0, shape="BOX"):
    rbw = bpy.context.scene.rigidbody_world
    if o.name not in rbw.collection.objects:
        rbw.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.rigidbody.object_add()
    rb = o.rigid_body
    if kind == "active":
        rb.type = "ACTIVE"
        rb.mass = mass
    else:
        rb.type = "PASSIVE"
        rb.kinematic = (kind == "animated")
    rb.collision_shape = shape
    rb.restitution = bounce
    rb.friction = friction
    rb.linear_damping = 0.03
    rb.angular_damping = 0.035
    rb.collision_margin = 0.006
    o.select_set(False)


# ---------------------------------------------------------------- materials

def m_wood():
    m = bpy.data.materials.get("Wood")
    if m:
        return m
    m = bpy.data.materials.new("Wood")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (0.5, 0.5, 6.0)
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "Z"
    wave.inputs["Scale"].default_value = 3.0
    wave.inputs["Distortion"].default_value = 6.0
    wave.inputs["Detail"].default_value = 2.0
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 3.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.25
    ramp.color_ramp.elements[0].color = (0.42, 0.25, 0.12, 1)
    ramp.color_ramp.elements[1].position = 0.8
    ramp.color_ramp.elements[1].color = (0.82, 0.60, 0.36, 1)
    nt.links.new(coord.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], wave.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    nt.links.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.55
    return m


def m_marble(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = 0.14
    for k, v in (("Coat Weight", 0.7), ("Coat Roughness", 0.04), ("Specular IOR Level", 0.6)):
        if k in b.inputs:
            b.inputs[k].default_value = v
    return m


def m_checker():
    m = bpy.data.materials.new("Checker")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    ck = nt.nodes.new("ShaderNodeTexChecker")
    ck.inputs["Scale"].default_value = 10.0
    ck.inputs["Color1"].default_value = (0.9, 0.9, 0.9, 1)
    ck.inputs["Color2"].default_value = (0.06, 0.06, 0.06, 1)
    nt.links.new(ck.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.4
    return m


# ---------------------------------------------------------------- scene

def setup_scene(res, fps, quick, n_frames):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    w, h = (int(x) for x in res.split("x"))
    if quick:
        w, h = round(w * 0.42), round(h * 0.42)
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.fps = fps
    try:
        sc.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        sc.render.engine = "BLENDER_EEVEE"
    ee = sc.eevee
    for a, v in (("taa_render_samples", 6 if quick else 32), ("use_raytracing", not quick),
                 ("use_shadows", True), ("use_gtao", True), ("gtao_distance", 0.5),
                 ("use_bloom", True)):
        if hasattr(ee, a):
            try:
                setattr(ee, a, v)
            except Exception:
                pass
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.frame_start = 1
    sc.frame_end = n_frames

    # world: soft blue sky
    world = bpy.data.worlds.new("W")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    bgn = nt.nodes["Background"]
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "EASING"
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mapn = nt.nodes.new("ShaderNodeMapping")
    mapn.inputs["Rotation"].default_value = (math.radians(90), 0, 0)
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.55, 0.72, 0.95, 1)
    ramp.color_ramp.elements[1].color = (0.20, 0.42, 0.80, 1)
    nt.links.new(tc.outputs["Generated"], mapn.inputs["Vector"])
    nt.links.new(mapn.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bgn.inputs["Color"])
    bgn.inputs["Strength"].default_value = 0.9

    # sun
    ld = bpy.data.lights.new("Sun", "SUN")
    ld.energy = 3.2
    ld.angle = math.radians(3.0)
    lo = bpy.data.objects.new("Sun", ld)
    sc.collection.objects.link(lo)
    lo.rotation_euler = (math.radians(48), math.radians(6), math.radians(-35))

    # rigid body world
    bpy.ops.rigidbody.world_add()
    rbw = sc.rigidbody_world
    rbw.collection = bpy.data.collections.new("RB")
    rbw.substeps_per_frame = 14
    rbw.solver_iterations = 20
    rbw.point_cache.frame_start = 1
    rbw.point_cache.frame_end = n_frames
    sc.gravity = (0.0, 0.0, -14.0)
    return sc


# ---------------------------------------------------------------- course

def catmull_rom(keys, n_sub):
    P = [V(keys[0])] + [V(k) for k in keys] + [V(keys[-1])]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for s in range(n_sub):
            t = s / n_sub
            t2, t3 = t * t, t * t * t
            out.append(0.5 * (2 * p1 + (-p0 + p2) * t
                              + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-2])
    return out


def resample(poly, step):
    """Even-arc-length resample of a polyline."""
    out = [poly[0]]
    acc = 0.0
    i = 0
    cur = poly[0].copy()
    while i < len(poly) - 1:
        seg = poly[i + 1] - cur
        L = seg.length
        if acc + L >= step:
            cur = cur + seg * ((step - acc) / L)
            out.append(cur.copy())
            acc = 0.0
        else:
            acc += L
            cur = poly[i + 1].copy()
            i += 1
    if (out[-1] - poly[-1]).length > step * 0.4:
        out.append(poly[-1])
    return out


def build_course(rng, target, wood, checker):
    """A course of overlapping box tiles along a smooth descending centreline
    (guaranteed gap-free + solid BOX collision), plus paddle-wheel spinners.
    Returns (statics, spinners, gate, start_pos, path, finish_s)."""
    statics = []
    spinners = []
    up = V((0, 0, 1))

    n_key = max(6, int(round(target / 3.6)))
    keys = [(0.0, -6.0, 6.4), (0.0, 0.0, 3.6)]     # a steep-ish start so they get going
    x, y, z = 0.0, 0.0, 3.6
    xv = 0.0
    for i in range(n_key):
        seg = rng.uniform(8.0, 11.0)
        slope = rng.uniform(0.26, 0.40)            # ~15-22° — rolls, doesn't rocket
        xv = max(-3.6, min(3.6, xv + rng.uniform(-2.2, 2.2)))
        y += seg
        z -= slope * seg
        keys.append((xv, y, z))
    keys.append((xv * 0.3, y + 8.0, z - 1.4))
    keys.append((xv * 0.3, y + 16.0, z - 1.8))

    centre = resample(catmull_rom(keys, 10), 1.7)
    total = sum((centre[i + 1] - centre[i]).length for i in range(len(centre) - 1))

    # tiles: a wide floor + two tall inward-leaning walls, aligned to the local
    # tangent, overlapping the neighbours generously (gap-free trough).
    for i, c in enumerate(centre):
        tang = (centre[min(i + 2, len(centre) - 1)] - centre[max(i - 2, 0)])
        if tang.length < 1e-4:
            tang = V((0, 1, 0))
        tang.normalize()
        r = tang.cross(up)
        r = r.normalized() if r.length > 1e-4 else V((1, 0, 0))
        base_rot = tang.to_track_quat("Y", "Z").to_euler()
        hw = LANE_W / 2
        if rng.random() < 0.1 and 10 < i < len(centre) - 14:
            hw *= 0.62
        f = cube(f"t{i}f", (c.x, c.y, c.z - FLOOR_T / 2), (LANE_W + 2.2, 3.4, FLOOR_T), mat=wood)
        f.rotation_euler = base_rot
        statics.append(f)
        for s in (-1, 1):
            wc = c + r * (s * (hw + WALL_T * 0.5)) + up * (WALL_H * 0.42)
            w = cube(f"t{i}w{s}", (wc.x, wc.y, wc.z), (WALL_T, 3.4, WALL_H), mat=wood)
            e = base_rot.copy()
            e.rotate(mathutils.Euler((0, -s * WALL_LEAN, 0)))
            w.rotation_euler = e
            statics.append(w)

    c0 = centre[0]
    statics.append(cube("start_pad", (c0.x, c0.y - 1.5, c0.z - FLOOR_T / 2),
                        (LANE_W + 2.0, 5.0, FLOOR_T), mat=checker))
    statics.append(cube("start_back", (c0.x, c0.y - 3.7, c0.z + WALL_H), (LANE_W + 3, 0.5, WALL_H * 2.4), mat=wood))
    for s in (-1, 1):
        statics.append(cube(f"start_side{s}", (c0.x + s * (LANE_W / 2 + 1.1), c0.y - 1.5, c0.z + WALL_H / 2),
                            (WALL_T * 2, 5.0, WALL_H + 0.8), mat=wood))
    start_pos = V((c0.x, c0.y - 1.0, c0.z + 0.55))
    gate = cube("gate", (c0.x, c0.y + 0.9, c0.z + 0.95), (LANE_W + 1.0, 0.3, 1.9), mat=wood)

    cf = centre[-1]
    statics.append(cube("finish_pad", (cf.x, cf.y + 2.0, cf.z - FLOOR_T / 2), (LANE_W + 4.0, 9.0, FLOOR_T), mat=checker))
    statics.append(cube("finish_back", (cf.x, cf.y + 6.8, cf.z + WALL_H), (LANE_W + 5, 0.6, WALL_H * 3), mat=wood))
    for s in (-1, 1):
        statics.append(cube(f"finish_side{s}", (cf.x + s * (LANE_W / 2 + 2.0), cf.y + 2.0, cf.z + WALL_H / 2),
                            (WALL_T * 2, 9.0, WALL_H), mat=wood))

    cand = list(range(12, len(centre) - 14, max(6, len(centre) // 6)))
    for j in rng.sample(cand, k=min(len(cand), max(2, n_key // 2))):
        c = centre[j]
        tang = (centre[j + 1] - centre[j]).normalized()
        yaw = math.atan2(tang.x, tang.y)
        sp = make_spinner(f"spin{j}", V((c.x, c.y, c.z + 1.1)), yaw,
                          rng.uniform(2.4, 4.4) * rng.choice([-1, 1]), wood)
        spinners.append(sp)

    path = list(centre)
    finish_s = total - 7.0
    return statics, spinners, gate, start_pos, path, finish_s


def make_spinner(name, loc, yaw, omega, wood):
    """A paddle wheel: blades spinning about the (yawed) X axis so it scoops
    marbles coming down the chute."""
    a1 = cube(f"{name}_a", loc, (LANE_W + 0.7, 0.30, 0.62), rot=(0, 0, yaw), mat=wood)
    a2 = cube(f"{name}_b", loc, (LANE_W + 0.7, 0.62, 0.30), rot=(0, 0, yaw), mat=wood)
    hub = cyl(f"{name}_h", loc, 0.42, LANE_W + 1.3, rot=(0, math.radians(90), yaw), mat=wood)
    for child in (a2, hub):
        child.parent = a1
        child.matrix_parent_inverse = a1.matrix_world.inverted()
    a1["omega"] = omega
    a1["yaw"] = yaw
    return a1


# ---------------------------------------------------------------- marbles

def add_marbles(n, colors, start_pos, rng):
    objs = []
    for i in range(n):
        off = (-1.6 + 3.2 * i / max(1, n - 1))
        bpy.ops.mesh.primitive_ico_sphere_add(
            subdivisions=3, radius=MR,
            location=(start_pos.x + off + rng.uniform(-0.04, 0.04),
                      start_pos.y + rng.uniform(-0.12, 0.12),
                      start_pos.z + 0.05 + i * 0.015))
        o = bpy.context.object
        o.name = f"marble_{i}"
        bpy.ops.object.shade_smooth()
        o.data.materials.append(m_marble(f"mm{i}", colors[i][1]))
        add_rb(o, "active", bounce=0.2, friction=0.28, mass=1.0, shape="SPHERE")
        o.rigid_body.linear_damping = 0.13
        o.rigid_body.angular_damping = 0.06
        objs.append(o)
    return objs


# ---------------------------------------------------------------- sim

def arclen_progress(path_cum, path, p):
    """Distance along the course polyline of the point on it nearest to p."""
    best_d = 1e18
    best_s = 0.0
    for k in range(len(path) - 1):
        a, b = path[k], path[k + 1]
        ab = b - a
        L2 = ab.length_squared or 1e-9
        t = max(0.0, min(1.0, (p - a).dot(ab) / L2))
        c = a + ab * t
        d = (p - c).length_squared
        if d < best_d:
            best_d = d
            best_s = path_cum[k] + ab.length * t
    return best_s


def simulate(sc, marbles, spinners, gate, n_frames, fps, run_frame, path, finish_s):
    # spinner keyframes — spin about local X inside the yawed frame
    for sp in spinners:
        om = sp["omega"]
        yaw = sp["yaw"]
        for f in (1, n_frames):
            sp.rotation_euler = (om * (f / fps), 0, yaw)
            sp.keyframe_insert("rotation_euler", frame=f)
    # gate: solid, then drops away just before GO
    if gate:
        z0 = gate.location.z
        gate.keyframe_insert("location", frame=1)
        gate.location.z = z0
        gate.keyframe_insert("location", frame=run_frame - 2)
        gate.location.z = z0 - 5.0
        gate.keyframe_insert("location", frame=run_frame + 4)

    path_cum = [0.0]
    for k in range(len(path) - 1):
        path_cum.append(path_cum[-1] + (path[k + 1] - path[k]).length)

    pos_log = {m.name: [] for m in marbles}
    prog_log = {m.name: [] for m in marbles}
    finish_frame = {}
    settled = {}

    sc.frame_set(1)
    for f in range(1, n_frames + 1):
        sc.frame_set(f)
        for m in marbles:
            p = m.matrix_world.translation.copy()
            pos_log[m.name].append((p.x, p.y, p.z))
            s = arclen_progress(path_cum, path, p)
            prog_log[m.name].append(s)
            if m.name not in finish_frame and s >= finish_s:
                finish_frame[m.name] = f
            # stuck / fell off guard: below the path by a lot
            if m.name not in settled and p.z < path[-1].z - 8.0:
                settled[m.name] = f
        if f % 30 == 0:
            progress(0.14 + 0.30 * f / n_frames, f"simulating {f}/{n_frames}")
        if f in (2, run_frame + 5, n_frames // 3, 2 * n_frames // 3, n_frames):
            ps = [prog_log[m.name][-1] for m in marbles]
            zs = [round(pos_log[m.name][-1][2], 1) for m in marbles]
            log(f"  f{f}: progress {[round(p,1) for p in ps]} · z {zs} · finish_s {finish_s:.0f}")
    return pos_log, prog_log, finish_frame, path_cum


# ---------------------------------------------------------------- camera

def animate_camera(sc, pos_log, prog_log, marbles, end_frame, fps):
    cd = bpy.data.cameras.new("Cam")
    cd.lens = 24
    cam = bpy.data.objects.new("Cam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    names = [m.name for m in marbles]

    cam_p = None
    look_p = None
    for f in range(1, end_frame + 1):
        idx = f - 1
        pts = [V(pos_log[n][idx]) for n in names]
        progs = [prog_log[n][idx] for n in names]
        lead_i = max(range(len(names)), key=lambda k: progs[k])
        leader = pts[lead_i]
        pack = sum(pts, V((0, 0, 0))) / len(pts)
        focus = leader.lerp(pack, 0.35)

        # travel direction of the leader (for a "behind" cam), smoothed
        j = max(0, idx - 6)
        travel = (V(pos_log[names[lead_i]][idx]) - V(pos_log[names[lead_i]][j]))
        travel.z = 0
        if travel.length < 0.5:
            travel = V((0, 1, 0))
        travel.normalize()

        desired = focus - travel * 9.0 + V((0, 0, 5.2))
        desired += V((math.sin(f / fps * 0.5) * 1.2, 0, math.cos(f / fps * 0.4) * 0.5))
        if cam_p is None:
            cam_p = desired.copy()
            look_p = focus.copy()
        cam_p = cam_p.lerp(desired, 0.09)
        look_p = look_p.lerp(focus, 0.16)

        cam.location = cam_p
        d = (look_p + V((0, 0, 0.4))) - cam_p
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
    return cam


# ---------------------------------------------------------------- main

def main():
    args = parse_args()
    seed = args.seed if args.seed >= 0 else random.randint(1, 2_000_000)
    rng = random.Random(seed)
    n_balls = max(3, min(6, args.balls))
    target = max(12.0, min(60.0, args.target))
    fps = args.fps
    n_frames = int((target + 4.5) * fps)
    run_frame = int(2.6 * fps)

    log(f"marblerace seed {seed} · {n_balls} marbles · ~{target:.0f}s · {n_frames}f @ {fps}")
    progress(0.02, "building the course")

    sc = setup_scene(args.res, fps, args.quick, n_frames)
    wood = m_wood()
    checker = m_checker()

    statics, spinners, gate, start_pos, path, finish_s = build_course(rng, target, wood, checker)
    log(f"course: {len(statics)} tiles, {len(spinners)} spinners, {len(path)} path pts, start {tuple(round(v,1) for v in start_pos)}")
    for o in statics:
        add_rb(o, "passive", bounce=0.1, friction=0.45, shape="BOX")
    add_rb(gate, "animated", bounce=0.1, friction=0.5, shape="BOX")
    for sp in spinners:
        add_rb(sp, "animated", bounce=0.28, friction=0.5, shape="CONVEX_HULL")

    colors = rng.sample(MARBLES, n_balls)
    marbles = add_marbles(n_balls, colors, start_pos, rng)

    progress(0.12, "simulating physics")
    pos_log, prog_log, finish_frame, path_cum = simulate(
        sc, marbles, spinners, gate, n_frames, fps, run_frame, path, finish_s)

    ordered = sorted(finish_frame.items(), key=lambda kv: kv[1])
    if ordered:
        winner_name, win_frame = ordered[0]
    else:
        winner_name = max(marbles, key=lambda m: prog_log[m.name][-1]).name
        win_frame = n_frames
    win_at = win_frame / fps
    end_frame = min(n_frames, win_frame + int(2.8 * fps))
    sc.frame_end = end_frame

    progress(0.46, "framing the camera")
    animate_camera(sc, pos_log, prog_log, marbles, end_frame, fps)

    widx = [m.name for m in marbles].index(winner_name)
    wname, wrgb = colors[widx]
    # finish order for the result
    order = sorted(range(n_balls), key=lambda k: (finish_frame.get(marbles[k].name, 10**9),
                                                  -prog_log[marbles[k].name][-1]))

    progress(0.5, "rendering")
    os.makedirs(args.out_frames, exist_ok=True)
    sc.render.filepath = os.path.join(args.out_frames, "f_")
    sc.frame_set(1)
    bpy.ops.render.render(animation=True)

    result = {
        "seed": int(seed),
        "map": "wooden-course",
        "mapName": "WOODEN COURSE",
        "winner": wname,
        "winnerRgb": [int(round(c * 255)) for c in wrgb],
        "colors": [c[0] for c in colors],
        "order": [colors[k][0] for k in order],
        "winAtSec": round(win_at, 2),
        "durationSec": round(end_frame / fps, 2),
        "frames": end_frame,
        "fps": fps,
        "events": 0,
    }
    with open(args.out, "w") as fh:
        json.dump(result, fh)
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    progress(1.0, "done")
    log(f"winner {wname} at {win_at:.1f}s · order {result['order']}")


if __name__ == "__main__":
    main()
