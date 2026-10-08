"""Shared Blender PRIMITIVES for natural (shaped, not prismatic) dungeon volumes.

Run inside Blender (headless or MCP). Every helper returns ONE object made of
ONE closed solid with thickness, tagged for tools/mesh-dc/export_blender.py:
dc_export=True, dc_group, dc_role='structure', and dc_noise when given, so the
project's role-noise table (tools/mesh-dc/noise.mjs) roughens it on import.

    import sys; sys.path.insert(0, r"<engine>/tools/mesh-dc")
    import shapes_blender as shapes
    shapes.cave_ceiling("den.roof", outline, z_spring=3.4, rise=1.4, thickness=0.6,
                        material="basalt", group="gate", noise="rock-roof", seed=7)
    shapes.ring_wall("den.wall", outline, thickness=0.8, z0=-0.6, z1=4.0,
                     material="basalt", group="gate", noise="rock-wall")
    shapes.cave_tunnel("neck", [(0,0,0), (6,1,0), (12,0,-0.8)], width=2.8, height=2.9,
                       thickness=0.8, material="basalt", group="gate", noise="rock-wall")

These are primitives, not set pieces: a room's story-specific builder stays in
its own project. Geometry roughness comes from csg noise on import; these give
the LARGE shape (domed/uneven crowns, wandering sections) that noise cannot.
Coordinates are Blender metres (Z up). Outlines are [(x, y), ...] footprints.
"""
import math
import random

import bpy
import bmesh
from mathutils import Vector, noise as mnoise


# ----------------------------------------------------------------- plumbing --
def _material(role):
    m = bpy.data.materials.get(role)
    if m is None:
        m = bpy.data.materials.new(role)
        m["dc_role"] = role
    return m


def _object(name, verts, faces, material, group, noise=None, collection=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    mesh.validate(clean_customdata=False)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(_material(material))
    obj = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(obj)
    obj["dc_export"] = True
    obj["dc_group"] = group
    obj["dc_role"] = "structure"
    if noise:
        obj["dc_noise"] = noise
    return obj


def noise_tag(obj, key):
    """Key an existing structural object into the project's noise table ('rock-wall', 'rock-roof', 'tread', ...)."""
    obj["dc_noise"] = key
    return obj


def _ccw(pts):
    a = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    return list(pts) if a > 0 else list(reversed(pts))


def _smooth(x, y, z, scale, seed):
    """Smooth value noise in [0, 1], deterministic per seed."""
    return 0.5 + 0.5 * mnoise.noise(Vector((x / scale + seed * 17.13, y / scale - seed * 5.71, z / scale + seed * 2.39)))


def offset_outline(pts, d):
    """Offset a CCW outline outward by d (mitred, clamped at sharp corners)."""
    pts = _ccw(pts)
    n = len(pts)
    out = []
    for i in range(n):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % n])
        e0 = (p1 - p0).normalized()
        e1 = (p2 - p1).normalized()
        n0 = Vector((e0.y, -e0.x))
        n1 = Vector((e1.y, -e1.x))
        m = (n0 + n1)
        m = m.normalized() if m.length > 1e-9 else n0
        k = max(0.35, m.dot(n0))
        q = p1 + m * (d / k)
        out.append((q.x, q.y))
    return out


def _star_check(pts, c, label):
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        if (a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0]) <= 1e-9:
            raise ValueError(f"{label}: outline is not star-shaped about its centre {c}; split the room or pass centre=")


# --------------------------------------------------------- domed ceiling --
def cave_ceiling(name, outline, z_spring, rise, thickness, material, group, *, noise=None, seed=1,
                 rings=7, jitter=0.35, jitter_scale=2.2, lap=0.0, centre=None, crown=None, collection=None):
    """An uneven DOMED roof over a cave footprint: one closed solid.

    The underside starts at z_spring on the outline (so it sits on the walls),
    climbs a dome profile to `rise` at the crown, plus a smooth bumpy 0..jitter
    (zero at the rim). It never dips below z_spring, so door heads and the
    plan's clearances measured to z_spring stay true. The top is flat at
    z_spring + rise + jitter + thickness (buried in rock). `lap` grows the rim
    outward to bury it inside the walls. `crown=(x, y)` moves the high point
    off-centre (outline must be star-shaped about `centre`, default centroid).
    """
    pts = _ccw([tuple(p) for p in outline])
    if lap:
        pts = offset_outline(pts, lap)
    n = len(pts)
    c = centre or (sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n)
    _star_check(pts, c, name)
    hi = crown or c
    verts, faces = [], []
    for k in range(rings):
        t = k / rings  # 0 rim .. ->1 crown
        for p in pts:
            # rings shrink toward the crown point so an off-centre crown stays inside
            x = hi[0] + (p[0] - hi[0]) * (1 - t)
            y = hi[1] + (p[1] - hi[1]) * (1 - t)
            dome = 1 - (1 - t) ** 2
            z = z_spring + rise * dome + jitter * t * _smooth(x, y, 0.0, jitter_scale, seed)
            verts.append((x, y, z))
    verts.append((hi[0], hi[1], z_spring + rise + jitter * _smooth(hi[0], hi[1], 0.0, jitter_scale, seed)))
    centre_i = len(verts) - 1
    top_z = z_spring + rise + jitter + thickness
    top0 = len(verts)
    verts += [(p[0], p[1], top_z) for p in pts]
    for k in range(rings - 1):
        for i in range(n):
            a, b = k * n + i, k * n + (i + 1) % n
            faces.append((a, b, b + n, a + n))
    last = (rings - 1) * n
    for i in range(n):
        faces.append((last + i, last + (i + 1) % n, centre_i))
        faces.append((i, top0 + i, top0 + (i + 1) % n, (i + 1) % n))  # rim band
    faces.append(tuple(range(top0 + n - 1, top0 - 1, -1)))
    return _object(name, verts, faces, material, group, noise, collection)


# ------------------------------------------------------------ ring wall --
def ring_wall(name, outline, thickness, z0, z1, material, group, *, noise=None, collection=None):
    """Closed wall band around a footprint: inner face on the outline, outer face `thickness` out."""
    inner = _ccw([tuple(p) for p in outline])
    outer = offset_outline(inner, thickness)
    n = len(inner)
    verts = [(p[0], p[1], z0) for p in inner] + [(p[0], p[1], z1) for p in inner] + \
            [(p[0], p[1], z0) for p in outer] + [(p[0], p[1], z1) for p in outer]
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, n + i, n + j, j))                 # inner face
        faces.append((2 * n + i, 2 * n + j, 3 * n + j, 3 * n + i))  # outer face
        faces.append((n + i, 3 * n + i, 3 * n + j, n + j))  # top
        faces.append((i, j, 2 * n + j, 2 * n + i))          # bottom
    return _object(name, verts, faces, material, group, noise, collection)


# --------------------------------------------------------- lofted tunnel --
def cave_section(width, height, *, points=17, squareness=3.0, bury=0.3):
    """Inner arch profile (u across, v up) from the right foot over the crown to the left foot.
    squareness 2 = ellipse, higher = straighter walls and a flatter (still curved) crown."""
    hw = width / 2
    prof = [(hw, -bury)]
    for i in range(points):
        th = math.pi * i / (points - 1)
        c, s = math.cos(th), math.sin(th)
        prof.append((hw * math.copysign(abs(c) ** (2 / squareness), c), height * abs(s) ** (2 / squareness)))
    prof.append((-hw, -bury))
    return prof


def cave_tunnel(name, path, width, height, thickness, material, group, *, noise=None, seed=1, step=0.6,
                irregular=0.35, irregular_scale=2.5, crown_jitter=0.4, squareness=3.0, points=17, bury=0.3,
                width_wander=0.15, corners="smooth", collection=None):
    """A wandering natural passage: an irregular arch section LOFTED along `path`.

    path: [(x, y, z_floor), ...] floor-centre points (Blender frame); a point may
    carry its own width and height as (x, y, z_floor, width, height), linearly
    interpolated between points (a widening mouth, a low neck). The shell
    is walls + roof only; its feet sink `bury` below the floor, so lay the
    existing floor slab (or treads) under it. Each station's section is the
    `cave_section` arch, widened/narrowed by width_wander, with the walls
    pushed OUTWARD by 0..irregular and the crown raised by 0..crown_jitter
    (smooth along the path): the lane never gets narrower than `width` *
    (1 - width_wander) nor lower than `height`. corners="smooth" turns the
    section gradually (keep bends gentle: turn radius above the width, or the
    inner side folds); corners="mitre" sets one mitred section on each path
    vertex (walls stay parallel to both legs, as a mitred wall run) and keeps
    the other stations out of the mitre's reach, so sharp bends close cleanly;
    a leg shorter than its two bends' reach raises.
    """
    P = [Vector(tuple(p)[:3]) for p in path]
    if len(P) < 2:
        raise ValueError(f"{name}: path needs two or more points")
    W = [float(p[3]) if len(p) > 3 else width for p in path]
    H = [float(p[4]) if len(p) > 4 else height for p in path]
    if corners not in ("smooth", "mitre"):
        raise ValueError(f"{name}: corners must be 'smooth' or 'mitre'")
    flat = lambda v: Vector((v.x, v.y, 0.0))
    seg_n = [Vector((-(P[i + 1] - P[i]).y, (P[i + 1] - P[i]).x, 0.0)).normalized() for i in range(len(P) - 1)]
    # mitre side vector per path vertex (scaled so the walls stay parallel to each leg) and its reach along the legs
    mitre, reach = {}, {}
    for i in range(1, len(P) - 1):
        a, b = seg_n[i - 1], seg_n[i]
        m = (a + b)
        c = max(0.35, m.normalized().dot(a)) if m.length > 1e-9 else 0.35
        mitre[i] = m.normalized() / c if m.length > 1e-9 else a
        half = math.acos(max(-1.0, min(1.0, a.dot(b)))) / 2
        outer_hw = W[i] / 2 * (1 + width_wander) + irregular + thickness
        reach[i] = outer_hw * math.tan(half) + 0.3 if corners == "mitre" else 0.0
    # stations at uniform spacing (in mitre mode clear of each bend's reach), each with its width, height and side
    stations, s_acc = [], 0.0
    for i in range(len(P) - 1):
        a, b = P[i], P[i + 1]
        seg = (b - a)
        L = flat(seg).length
        r0, r1 = reach.get(i, 0.0), reach.get(i + 1, 0.0)
        if corners == "mitre" and L < r0 + r1 + 0.1:
            raise ValueError(f"{name}: leg {i} is {L:.2f} m, shorter than its bends' mitre reach ({r0:.2f} + {r1:.2f}): lengthen it or soften the turn")
        fs = [0.0] + ([r0 / L] if r0 > 1e-9 else [])
        lo, hi = r0, L - r1
        m = max(1, int(math.ceil((hi - lo) / step)))
        fs += [(lo + (hi - lo) * k / m) / L for k in range(1, m)]
        fs += ([(L - r1) / L] if r1 > 1e-9 else []) + [1.0]
        for f in fs[(0 if i == 0 else 1):]:
            side = None
            if corners == "mitre":
                side = mitre.get(i) if f == 0.0 else mitre.get(i + 1) if f == 1.0 else None
                side = side if side is not None else seg_n[i]
            stations.append((a + seg * f, s_acc + L * f, W[i] + (W[i + 1] - W[i]) * f, H[i] + (H[i + 1] - H[i]) * f, side))
        s_acc += L
    base = cave_section(2.0, 1.0, points=points, squareness=squareness, bury=0.0)  # u in [-1, 1]: u * hw spans the full width
    M = len(base)
    verts = []
    for si, (p, s, w_at, h_at, side) in enumerate(stations):
        if side is None:
            q0 = stations[max(0, si - 2)][0]
            q1 = stations[min(len(stations) - 1, si + 2)][0]
            t = Vector((q1.x - q0.x, q1.y - q0.y)).normalized()
            side = Vector((-t.y, t.x, 0.0))
        w = w_at * (1 + width_wander * (2 * _smooth(s, 0, 0, irregular_scale * 2, seed + 3) - 1))
        hw = w / 2
        inner, outer = [], []
        for j, (u, v) in enumerate(base):
            ends = j in (0, M - 1)
            uu, vv = u * hw, (-bury if ends else v * h_at)
            th = math.pi * max(0, min(1, (j - 1) / (M - 3)))
            # outward direction of this profile point (u across, v up)
            du, dv = math.cos(th), math.sin(th)
            if ends:
                du, dv = (1.0 if j == 0 else -1.0), 0.0
            bump = irregular * _smooth(s, j * 0.9, 0, irregular_scale, seed)
            if dv > 0.7:
                bump += crown_jitter * _smooth(s, 0, 5, irregular_scale, seed + 1) * (dv - 0.7) / 0.3
            iu, iv = uu + du * bump, vv + dv * bump
            ou, ov = iu + du * thickness, iv + dv * thickness
            inner.append(p + side * iu + Vector((0, 0, iv)))
            outer.append(p + side * ou + Vector((0, 0, ov)))
        verts += inner + list(reversed(outer))
    K = 2 * M
    faces = []
    for si in range(len(stations) - 1):
        a0, b0 = si * K, (si + 1) * K
        for j in range(K):
            j1 = (j + 1) % K
            faces.append((a0 + j, a0 + j1, b0 + j1, b0 + j))
    last = (len(stations) - 1) * K
    faces.append(tuple(range(K - 1, -1, -1)))
    faces.append(tuple(range(last, last + K)))
    return _object(name, verts, faces, material, group, noise, collection)
