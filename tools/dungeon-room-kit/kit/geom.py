"""Pure-Python solid geometry for the dungeon room kit (no bpy; runs in Blender or plain Python).

A Solid is ONE closed solid: verts [(x, y, z)], faces [[i, ...]] (outward winding, ngons allowed;
concave caps are fine, Blender's polyfill tessellates them), one palette role. Frame: Blender metres,
x east, y north, z up (the plan frame).

Everything here is boolean-free: openings are made by building pieces AROUND them, and solids of one
room overlap freely because a dc_group unions its solids in the DC field.
"""
import math


class Solid:
    __slots__ = ("verts", "faces", "role")

    def __init__(self, verts, faces, role):
        self.verts, self.faces, self.role = [tuple(map(float, v)) for v in verts], [list(f) for f in faces], role

    def mapped(self, fn):
        return Solid([fn(v) for v in self.verts], self.faces, self.role)

    def bounds(self):
        xs, ys, zs = zip(*self.verts)
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


# ------------------------------------------------------------------ 2D --
def area2(poly):
    return sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly))) / 2


def dedupe(poly, eps=1e-6):
    """Drop consecutive (and closing) duplicate points, which would make zero-area triangles."""
    out = []
    for p in poly:
        if not out or abs(p[0] - out[-1][0]) > eps or abs(p[1] - out[-1][1]) > eps:
            out.append(p)
    while len(out) > 1 and abs(out[0][0] - out[-1][0]) <= eps and abs(out[0][1] - out[-1][1]) <= eps:
        out.pop()
    return out


def ccw(poly):
    poly = [tuple(map(float, p)) for p in poly]
    return poly if area2(poly) > 0 else poly[::-1]


def sub(a, b): return (a[0] - b[0], a[1] - b[1])
def add(a, b): return (a[0] + b[0], a[1] + b[1])
def mul(a, s): return (a[0] * s, a[1] * s)
def dot(a, b): return a[0] * b[0] + a[1] * b[1]
def length(a): return math.hypot(a[0], a[1])


def unit(a):
    l = length(a) or 1.0
    return (a[0] / l, a[1] / l)


def left(d):
    """Inward normal of a CCW outline edge with direction d."""
    return (-d[1], d[0])


def mitre(n0, n1):
    """Offset vector at a corner whose edges have unit normals n0, n1 (offset 1 along both)."""
    s = 1 + dot(n0, n1)
    if s < 0.15:  # spike guard for very sharp corners
        s = 0.15
    return ((n0[0] + n1[0]) / s, (n0[1] + n1[1]) / s)


def offset_poly(poly, d):
    """Offset a CCW polygon by d (positive = inward), mitred."""
    n = len(poly)
    out = []
    for i in range(n):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % n]
        m = mitre(left(unit(sub(b, a))), left(unit(sub(c, b))))
        out.append(add(b, mul(m, d)))
    return out


def centroid(poly):
    a = area2(poly) or 1e-9
    cx = sum((poly[i][0] + poly[(i + 1) % len(poly)][0]) * (poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]) for i in range(len(poly)))
    cy = sum((poly[i][1] + poly[(i + 1) % len(poly)][1]) * (poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]) for i in range(len(poly)))
    return (cx / (6 * a), cy / (6 * a))


def inside(poly, p):
    x, y, c = p[0], p[1], False
    for i in range(len(poly)):
        a, b = poly[i - 1], poly[i]
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            c = not c
    return c


def dist_to_seg(p, a, b):
    d = sub(b, a)
    t = max(0.0, min(1.0, dot(sub(p, a), d) / max(dot(d, d), 1e-12)))
    return length(sub(p, add(a, mul(d, t))))


def dist_to_outline(poly, p):
    return min(dist_to_seg(p, poly[i - 1], poly[i]) for i in range(len(poly)))


def chord(poly, p, d):
    """Interior span of the line p + t d through a convex-ish outline: (t0, t1) or None."""
    ts = []
    for i in range(len(poly)):
        a, b = poly[i - 1], poly[i]
        e = sub(b, a)
        den = d[0] * e[1] - d[1] * e[0]
        if abs(den) < 1e-12:
            continue
        w = sub(a, p)
        t = (w[0] * e[1] - w[1] * e[0]) / den
        s = (w[0] * d[1] - w[1] * d[0]) / den
        if -1e-9 <= s <= 1 + 1e-9:
            ts.append(t)
    if len(ts) < 2:
        return None
    return min(ts), max(ts)


def is_rect(poly, tol=1e-3):
    if len(poly) != 4:
        return False
    for i in range(4):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % 4]
        if abs(dot(unit(sub(b, a)), unit(sub(c, b)))) > tol:
            return False
    return True


# ------------------------------------------------------------- solids --
def prism(poly, z0, z1, role):
    """Vertical extrusion of a simple polygon (any winding) from z0 to z1."""
    poly = ccw(dedupe([tuple(map(float, p)) for p in poly]))
    n = len(poly)
    verts = [(x, y, z0) for x, y in poly] + [(x, y, z1) for x, y in poly]
    faces = [list(range(n - 1, -1, -1)), list(range(n, 2 * n))]
    faces += [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    return Solid(verts, faces, role)


def box(c, size, role, yaw=0.0):
    """Axis box centred at c=(x,y,z) with full extents size, turned by yaw (radians) about z."""
    hx, hy = size[0] / 2, size[1] / 2
    cs, sn = math.cos(yaw), math.sin(yaw)
    pts = [(c[0] + x * cs - y * sn, c[1] + x * sn + y * cs) for x, y in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy))]
    return prism(pts, c[2] - size[2] / 2, c[2] + size[2] / 2, role)


def frame_prism(poly_uv, frame, w0, w1, role):
    """Extrude a polygon drawn in a vertical wall plane. frame = (origin(x,y), u_dir(x,y), n_dir(x,y)):
    a (u, z) point at depth w maps to origin + u*u_dir + w*n_dir, height z. w0 < w1 along n_dir."""
    o, ud, nd = frame
    poly_uv = dedupe([tuple(map(float, p)) for p in poly_uv])
    if area2(poly_uv) < 0:
        poly_uv = poly_uv[::-1]
    n = len(poly_uv)

    def P(u, z, w):
        return (o[0] + ud[0] * u + nd[0] * w, o[1] + ud[1] * u + nd[1] * w, z)
    verts = [P(u, z, w0) for u, z in poly_uv] + [P(u, z, w1) for u, z in poly_uv]
    # (u, z, w) is right-handed when u x n points up; fix winding by signed volume below
    faces = [list(range(n - 1, -1, -1)), list(range(n, 2 * n))]
    faces += [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    return orient(Solid(verts, faces, role))


def orient(s):
    """Flip all faces when the signed volume is negative (closed solids only)."""
    vol = 0.0
    for f in s.faces:
        a = s.verts[f[0]]
        for i in range(1, len(f) - 1):
            b, c = s.verts[f[i]], s.verts[f[i + 1]]
            vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
    if vol < 0:
        s.faces = [f[::-1] for f in s.faces]
    return s


def sweep(path, profile, role, closed=False):
    """Sweep a 2D profile [(o, h)] along a horizontal polyline path [(x, y, z)].
    o is the offset to the LEFT of travel (inward on a CCW outline), h is height above the path point.
    Corners are mitred (fixed), straight runs stretch: the profile is the 9-slice's edge and the mitre its corner.
    Open paths get flat end caps."""
    n = len(path)
    m = len(profile)
    dirs = [unit(sub(path[(i + 1) % n][:2], path[i][:2])) for i in range(n if closed else n - 1)]
    verts = []
    for i in range(n):
        if closed:
            k = mitre(left(dirs[i - 1]), left(dirs[i]))
        elif i == 0:
            k = left(dirs[0])
        elif i == n - 1:
            k = left(dirs[-1])
        else:
            k = mitre(left(dirs[i - 1]), left(dirs[i]))
        x, y, z = path[i]
        verts += [(x + k[0] * o, y + k[1] * o, z + h) for o, h in profile]
    faces = []
    rings = n if closed else n - 1
    for i in range(rings):
        a, b = i * m, ((i + 1) % n) * m
        for j in range(m):
            faces.append([a + j, a + (j + 1) % m, b + (j + 1) % m, b + j])
    if not closed:
        faces.append(list(range(m)))
        faces.append(list(range(n * m - 1, (n - 1) * m - 1, -1)))
    return orient(Solid(verts, faces, role))


def loft_rings(rings, role):
    """Close a stack of equal-count horizontal rings [[(x, y, z)...], ...] into one solid (capped ends)."""
    m = len(rings[0])
    verts = [p for r in rings for p in r]
    faces = [list(range(m - 1, -1, -1)), list(range((len(rings) - 1) * m, len(rings) * m))]
    for k in range(len(rings) - 1):
        for j in range(m):
            a, b = k * m, (k + 1) * m
            faces.append([a + j, a + (j + 1) % m, b + (j + 1) % m, b + j])
    return orient(Solid(verts, faces, role))


def cone(base_c, r, h, role, sides=7, tip_r=0.04, rot=0.0):
    """A tapered spike: a frustum from radius r at base_c[2] to tip_r at base_c[2]+h (h may be negative)."""
    def ring(z, rr):
        return [(base_c[0] + rr * math.cos(rot + 2 * math.pi * k / sides), base_c[1] + rr * math.sin(rot + 2 * math.pi * k / sides), z) for k in range(sides)]
    lo, hi = sorted([(base_c[2], r), (base_c[2] + h, tip_r)], key=lambda t: t[0])
    return loft_rings([ring(*lo), ring(*hi)], role)


# ---------------------------------------------------------------- arch --
def arch_curve(kind, span, rise=None, segments=14):
    """Intrados of an opening as (u, dz, nu, nz) from u=-span/2 to +span/2, dz above the springing;
    (nu, nz) is the outward (away from the opening) unit normal. kind: round | segmental | pointed | flat."""
    c = span / 2
    if kind == "flat":
        return [(-c, 0.0, 0.0, 1.0), (c, 0.0, 0.0, 1.0)]
    if kind == "round":
        rise = c
    if kind == "segmental":
        rise = rise or span * 0.28
        R = (c * c + rise * rise) / (2 * rise)
        zc = rise - R
        a0 = math.atan2(-zc, -c)
        a1 = math.atan2(-zc, c)
        pts = []
        for k in range(segments + 1):
            a = a0 + (a1 - a0) * k / segments
            pts.append((R * math.cos(a), zc + R * math.sin(a), math.cos(a), math.sin(a)))
        return pts
    if kind == "round":
        return [(c * math.cos(math.pi - math.pi * k / segments), c * math.sin(math.pi - math.pi * k / segments),
                 math.cos(math.pi - math.pi * k / segments), math.sin(math.pi - math.pi * k / segments)) for k in range(segments + 1)]
    if kind == "pointed":
        rise = max(rise or span * 0.8, c)
        R = (c * c + rise * rise) / (2 * c)
        pts = []
        half = segments // 2
        # left half: centre at (-c + R, 0), from angle pi to the crown
        cx = -c + R
        a_top = math.atan2(rise, 0 - cx)
        for k in range(half + 1):
            a = math.pi + (a_top - math.pi) * k / half
            pts.append((cx + R * math.cos(a), R * math.sin(a), math.cos(a), math.sin(a)))
        for k in range(half - 1, -1, -1):
            u, z, nu, nz = pts[k]
            pts.append((-u, z, -nu, nz))
        return pts
    raise ValueError(f"unknown arch kind {kind}")


def arch_rise(kind, span, rise=None):
    if kind == "round":
        return span / 2
    if kind == "flat":
        return 0.0
    if kind == "segmental":
        return rise or span * 0.28
    return max(rise or span * 0.8, span / 2)


def spandrel(kind, span, spring, top, rise=None, margin=0.0):
    """(u, z) polygon of the walling above an opening: [-span/2-margin, span/2+margin] x [arch, top]."""
    c = span / 2
    curve = arch_curve(kind, span, rise)
    poly = [(-c - margin, top), (-c - margin, spring)]
    poly += [(u, spring + dz) for u, dz, _, _ in curve]
    poly += [(c + margin, spring), (c + margin, top)]
    return poly


def voussoirs(kind, span, spring, ring, count=9, rise=None):
    """Annular pieces of an arch ring (u, z) polygons, keystone index count//2."""
    curve = arch_curve(kind, span, rise, segments=count * 4)
    pieces = []
    step = (len(curve) - 1) / count
    for k in range(count):
        i0, i1 = round(k * step), round((k + 1) * step)
        seg = curve[i0:i1 + 1]
        inner = [(u, spring + dz) for u, dz, _, _ in seg]
        outer = [(u + nu * ring, spring + dz + nz * ring) for u, dz, nu, nz in seg][::-1]
        pieces.append(inner + outer)
    return pieces


# ------------------------------------------------------------ 9-slice --
def band_map(a, b, delta, centred):
    """Piecewise-linear 9-slice axis map (references/slicing-rules.md): fixed below a, fixed above b
    (shifted by delta), the [a, b] band stretched; centred axes subtract delta/2."""
    span = b - a
    sh = delta / 2 if centred else 0.0

    def f(q):
        if q <= a:
            r = q
        elif q >= b:
            r = q + delta
        else:
            r = a + (q - a) * (span + delta) / span
        return r - sh
    return f


def nine_slice(solids, bands, source, target):
    """Stretch solids defined once in a part frame (u along, v up, w depth) to a target size.
    bands: {"u": [a, b], "v": [a, b], "w": [a, b]} slice planes (a band the geometry never crosses with a
    slanted face). source/target: (U, V, W) complete outer sizes. u and w are centred, v is floor-anchored.
    Corner and edge regions keep their measurements; only the middle band grows."""
    maps = []
    for axis, i in (("u", 0), ("v", 1), ("w", 2)):
        if axis in bands and target[i] is not None and abs(target[i] - source[i]) > 1e-9:
            a, b = bands[axis]
            if target[i] - source[i] < -(b - a) + 0.02:
                raise ValueError(f"9-slice: {axis} cannot shrink below its fixed regions ({source[i]} -> {target[i]})")
            maps.append(band_map(a, b, target[i] - source[i], centred=(axis != "v")))
        else:
            maps.append(lambda q: q)
    return [s.mapped(lambda p: (maps[0](p[0]), maps[1](p[1]), maps[2](p[2]))) for s in solids]


def repeat_slice(left_tiles, mid_tile, right_tiles, module, length):
    """Repeat-mode 9-slice along u: fixed end tiles, the middle tile repeated round(n) times and
    re-spaced to land exactly on length. Tiles are lists of solids in part frame, u from 0."""
    ends = module  # end tiles occupy one module each
    n = max(0, round((length - 2 * ends) / module))
    pitch = (length - 2 * ends) / n if n else 0
    out = [s for s in left_tiles]
    for k in range(n):
        off = ends + k * pitch
        out += [s.mapped(lambda p, off=off: (p[0] * pitch / module + off, p[1], p[2])) for s in mid_tile]
    out += [s.mapped(lambda p: (p[0] + length - ends, p[1], p[2])) for s in right_tiles]
    return out


def place(solids, origin, u_dir, z0=0.0):
    """Part frame (u along u_dir, v up, w = left of u_dir) -> plan frame at origin(x, y) and floor z0."""
    n_dir = left(u_dir)
    return [orient(s.mapped(lambda p: (origin[0] + u_dir[0] * p[0] + n_dir[0] * p[2], origin[1] + u_dir[1] * p[0] + n_dir[1] * p[2], z0 + p[1]))) for s in solids]
