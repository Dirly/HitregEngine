"""Rule-based placement: a room description + a style -> named pieces of closed solids.

A piece is {"name": "<room>.<kind>.<n>", "kind", "solids": [Solid], "noise": key|None}, or a deferred
Blender shape {"name", "kind", "shape": "cave_ceiling", "args": {...}, "noise"}. Pieces of one room share
its dc_group, so overlapping solids union in the DC field (no booleans anywhere).

Kinds are what the dungeon `recipe` gate counts: structural kinds (wall, floor, roof, ceiling, step...) are
not detail; everything else (pilaster, arch, voussoir, rib, springer, corbel, cornice, plinth, niche, pier,
post, beam, brace, rafter, purlin, stalactite, pillar, ledge...) is built detail.
"""
import math
import random

import geom as G
from geom import Solid, prism, box, frame_prism, sweep, sub, add, mul, dot, unit, left, length
from parts import sized_part

SIDES = {"S": (0, -1), "E": (1, 0), "N": (0, 1), "W": (-1, 0)}


# ----------------------------------------------------------- the room --
class Room:
    def __init__(self, spec, style):
        self.spec, self.style = spec, style
        self.id = spec["id"]
        if "outline" in spec:
            self.outline = G.ccw(spec["outline"])
        else:
            (x0, x1), (y0, y1) = spec["x"], spec["y"]
            self.outline = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        self.z = float(spec.get("floor", 0))
        self.H = float(spec.get("height", style.get("height", 3.4)))
        self.rng = random.Random(spec.get("seed", 1))
        self.n = len(self.outline)
        self.edges = []
        for i in range(self.n):
            a, b = self.outline[i], self.outline[(i + 1) % self.n]
            d = unit(sub(b, a))
            self.edges.append({"i": i, "a": a, "b": b, "d": d, "n": left(d), "len": length(sub(b, a)), "doors": [], "open": False})
        for side in spec.get("openSides", []):
            self.edge_for_side(side)["open"] = True
        for k, door in enumerate(spec.get("doors", [])):
            e = self.edge_for_side(door["side"]) if "side" in door else self.edges[door["edge"]]
            if "t" in door:
                t = door["t"]
            elif "at" in door:  # plan style: absolute x on N/S walls, absolute y on E/W walls
                k = 0 if abs(e["d"][0]) >= abs(e["d"][1]) else 1
                t = (door["at"] - e["a"][k]) / e["d"][k]
            else:
                t = e["len"] / 2
            ds = style["door"]
            w = door.get("width", ds.get("width", 2.4))
            h = door.get("height", ds.get("height", min(self.H - 0.4, 3.0)))
            kind = door.get("arch", ds.get("arch", "round"))
            rise = G.arch_rise(kind, w, door.get("rise"))
            spring = h - rise
            if spring < ds.get("minSpring", 2.6) - 1e-6 and not door.get("low"):
                raise ValueError(f"{spec['id']} door {k}: springs at {spring:.2f} m, so it clears less than {ds.get('minSpring', 2.6)} m toward its jambs "
                                 f"(clear height is measured across the whole width); raise its height to {h - spring + ds.get('minSpring', 2.6):.2f} "
                                 f"or flatten the arch, or mark it \"low\": true")
            e["doors"].append({"k": k, "id": door.get("id", f"door{k}"), "t": t, "w": w, "crown": h, "kind": kind,
                               "rise": door.get("rise"), "spring": h - rise, "frame": door.get("frame", True)})
        for e in self.edges:
            e["doors"].sort(key=lambda d: d["t"])
        self.pieces, self.counts, self.markers = [], {}, []

    def skin(self, wt):
        """The outline grown by the wall thickness, except across open sides (a neighbour's floor/roof is there)."""
        # walled sides: past the wall and its outer plinth projection, so no solid ends flush on a slab edge (DC non-manifold)
        lines = [(add(e["a"], mul(e["n"], 0.0 if e["open"] else -(wt + 0.15))), e["d"]) for e in self.edges]
        pts = []
        for i in range(self.n):
            (p0, d0), (p1, d1) = lines[i - 1], lines[i]
            den = d0[0] * d1[1] - d0[1] * d1[0]
            if abs(den) < 1e-9:
                pts.append(p1)
                continue
            w = sub(p1, p0)
            pts.append(add(p0, mul(d0, (w[0] * d1[1] - w[1] * d1[0]) / den)))
        return pts

    def ext(self, along, end, wt):
        """How far an along-axis vault/roof runs past its end wall (end 0 = start, 1 = far end): 0 over an open side."""
        nb = self.edges[along["i"] - 1] if end == 0 else self.edges[(along["i"] + 1) % self.n]
        return 0.0 if nb["open"] else wt

    def edge_for_side(self, side):
        want = SIDES[side]
        return max(self.edges, key=lambda e: dot(mul(e["n"], -1), want))

    def P(self, e, t, w=0.0):
        """Point on edge e at distance t from its start, w inward."""
        return add(add(e["a"], mul(e["d"], t)), mul(e["n"], w))

    def piece(self, kind, solids, noise=None, **extra):
        self.counts[kind] = self.counts.get(kind, 0) + 1
        p = {"name": f"{self.id}.{kind}.{self.counts[kind]}", "kind": kind, "solids": solids, "noise": noise}
        p.update(extra)
        self.pieces.append(p)
        return p

    def role(self, key):
        return self.style["roles"].get(key, key)

    def blocked(self, e, t, half):
        """True when [t-half, t+half] on edge e meets a door (with its jamb frame)."""
        jamb = self.style["door"].get("jamb", 0.3)
        return any(abs(t - d["t"]) < half + d["w"] / 2 + jamb + 0.05 for d in e["doors"])

    def spans(self):
        xs = [p[0] for p in self.outline]
        ys = [p[1] for p in self.outline]
        return max(xs) - min(xs), max(ys) - min(ys)


def frame_of(e):
    """Wall-plane frame for geom.frame_prism: u along the edge, w inward (n)."""
    return (e["a"], e["d"], e["n"])


# ----------------------------------------------------------- shared ---
def floor_slab(r, role, t, noise=None):
    wt = r.style["wall"]["thickness"]
    r.piece("floor", [prism(r.skin(wt), r.z - t, r.z, role)], noise)


def wall_intervals(r, e, top):
    """Edge e split around its doors: [(t0, t1)] solid runs and the door list."""
    runs, t = [], 0.0
    for d in e["doors"]:
        runs.append((t, d["t"] - d["w"] / 2))
        t = d["t"] + d["w"] / 2
    runs.append((t, e["len"]))
    return [(a, b) for a, b in runs if b - a > 0.02]


def corner_ext(r, e, wt):
    """Extend a wall run past convex corners by the wall thickness so outer corners close."""
    i = e["i"]
    prev, nxt = r.edges[i - 1], r.edges[(i + 1) % r.n]
    cross_in = prev["d"][0] * e["d"][1] - prev["d"][1] * e["d"][0]   # > 0: left turn at e's start (convex)
    cross_out = e["d"][0] * nxt["d"][1] - e["d"][1] * nxt["d"][0]
    return (wt if cross_in > 1e-6 and not prev["open"] else 0.0), (wt if cross_out > 1e-6 and not nxt["open"] else 0.0)


def lift(solids, dz):
    for s in solids:
        s.verts = [(x, y, z + dz) for x, y, z in s.verts]
    return solids


def door_heads(r, e, top, wt, role, voussoir_role, style_door):
    """Walling over each door (an arched spandrel through the wall) and its dressed frame: jambs lining the
    reveal, imposts at the springing, a voussoir ring with a proud keystone (or a lintel for flat heads).
    Door heights are relative to the room floor."""
    for d in e["doors"]:
        fr = (r.P(e, d["t"]), e["d"], e["n"])
        r.piece("wall", lift([frame_prism(G.spandrel(d["kind"], d["w"], d["spring"], top - r.z, d["rise"]), fr, -wt, 0.0, role)], r.z))
        if not d["frame"]:
            continue
        ring = style_door.get("ring", 0.3)
        proj = style_door.get("proj", 0.08)
        count = style_door.get("voussoirs", 9)
        if d["kind"] != "flat" and count:
            for k, poly in enumerate(G.voussoirs(d["kind"], d["w"], d["spring"], ring, count, d["rise"])):
                pk = proj * (1.8 if k == count // 2 else (1.0 if k % 2 == 0 else 0.6))
                r.piece("voussoir", lift([frame_prism(poly, fr, -0.2, pk, voussoir_role)], r.z))
        else:
            hw = d["w"] / 2 + ring
            r.piece("lintel", lift([frame_prism([(-hw, d["crown"]), (hw, d["crown"]), (hw, d["crown"] + ring + 0.1), (-hw, d["crown"] + ring + 0.1)], fr, -0.2, proj, voussoir_role)], r.z))
        jamb = style_door.get("jamb", 0.3)
        for s in (-1, 1):
            a, b = sorted((s * d["w"] / 2, s * (d["w"] / 2 + jamb)))
            r.piece("jamb", lift([frame_prism([(a, 0), (b, 0), (b, d["spring"]), (a, d["spring"])], fr, -wt, proj, voussoir_role)], r.z))
            if style_door.get("impost", True) and d["kind"] != "flat":
                a2, b2 = (a - 0.12, b) if s < 0 else (a, b + 0.12)
                ip = [(a2, d["spring"] - 0.24), (b2, d["spring"] - 0.24), (b2, d["spring"]), (a2, d["spring"])]
                r.piece("impost", lift([frame_prism(ip, fr, -0.1, proj + 0.1, voussoir_role)], r.z))
        r.markers.append({"kind": "doorway", "room": r.id, "id": d["id"], "center": list(r.P(e, d["t"])) + [r.z],
                          "width": d["w"], "height": d["crown"], "facing": list(mul(e["n"], -1))})



def masonry_walls(r, top):
    """Rectilinear walls from the 9-sliced carved-library `wall-plain` (plinth, string course, frieze, coping)."""
    st = r.style
    wt = st["wall"]["thickness"]
    roles = {"large-ashlar": r.role("wall"), "dressed-trim": r.role("trim")}
    part = st["wall"].get("part")
    for e in r.edges:
        if e["open"]:
            continue
        e0, e1 = corner_ext(r, e, wt)
        runs = wall_intervals(r, e, top)
        for (t0, t1) in runs:
            a0 = t0 - (e0 if t0 <= 1e-6 else 0)
            a1 = t1 + (e1 if t1 >= e["len"] - 1e-6 else 0)
            L = a1 - a0
            if part and L >= 1.25:
                solids = sized_part(part, (L, top - r.z, wt + 0.24), roles)
                # part frame: u centred, v up from floor, w centred on the wall core -> shift to the wall line
                origin = r.P(e, (a0 + a1) / 2)
                placed = G.place([s.mapped(lambda p: (p[0], p[1], p[2] - wt / 2)) for s in solids], origin, e["d"], r.z)
                r.piece("wall", [placed[0]])
                for s, k in zip(placed[1:], ("plinth", "string-course", "frieze", "cornice")):
                    r.piece(k, [s])
            else:
                poly = [r.P(e, a0), r.P(e, a1), r.P(e, a1, -wt), r.P(e, a0, -wt)]
                r.piece("wall", [prism(poly, r.z - 0.3, top, r.role("wall"))])
        # over each door: the library facing's upper courses still run across it
        for d in e["doors"]:
            if part:
                solids = sized_part(part, (d["w"] + 0.02, top - r.z, wt + 0.24), roles)
                keep = [s for s in solids[1:] if s.bounds()[0][1] >= d["crown"] - r.z + 0.25]
                placed = G.place([s.mapped(lambda p: (p[0], p[1], p[2] - wt / 2)) for s in keep], r.P(e, d["t"]), e["d"], r.z)
                for s in placed:
                    r.piece("cornice", [s])
        door_heads(r, e, top, wt, r.role("wall"), r.role("trim"), st["door"])


def native_walls(r, top, role, noise=None, base=None):
    """Mitred wall runs around any outline (natural rock, rubble), split at doors."""
    wt = r.style["wall"]["thickness"]
    z0 = r.z - 0.3 if base is None else base
    for e in r.edges:
        if e["open"]:
            continue
        runs = wall_intervals(r, e, top)
        i = e["i"]
        prev, nxt = r.edges[i - 1], r.edges[(i + 1) % r.n]
        m0 = G.mitre(prev["n"], e["n"])
        m1 = G.mitre(e["n"], nxt["n"])
        for (t0, t1) in runs:
            pa_out = add(e["a"], mul(m0, -wt)) if t0 <= 1e-6 else r.P(e, t0, -wt)
            pb_out = add(e["b"], mul(m1, -wt)) if t1 >= e["len"] - 1e-6 else r.P(e, t1, -wt)
            r.piece("wall", [prism([r.P(e, t0), r.P(e, t1), pb_out, pa_out], z0, top, role)], noise)
        for d in e["doors"]:
            sp = frame_prism(G.spandrel(d["kind"], d["w"], d["spring"], top - r.z, d["rise"]),
                             (r.P(e, d["t"]), e["d"], e["n"]), -wt, 0.0, role)
            r.piece("wall", [sp.mapped(lambda p: (p[0], p[1], p[2] + r.z))], noise)
            r.markers.append({"kind": "doorway", "room": r.id, "id": d["id"], "center": list(r.P(e, d["t"])) + [r.z],
                              "width": d["w"], "height": d["crown"], "facing": list(mul(e["n"], -1))})


def bays(r, e, every, margin):
    """Evenly spaced stations along edge e (bay boundaries), skipping doors."""
    n = max(1, round(e["len"] / every))
    pitch = e["len"] / n
    return [k * pitch for k in range(1, n) if not r.blocked(e, k * pitch, margin)], pitch


# ------------------------------------------------------ masonry rooms --
def pilaster(r, e, t, top, roles, ps):
    w, pr = ps["width"], ps["proj"]
    o = r.P(e, t)
    fr = (o, e["d"], e["n"])
    base_h, cap_h = ps.get("base", 0.42), ps.get("capital", 0.34)
    r.piece("pilaster", [
        frame_prism([(-w / 2 - 0.1, 0), (w / 2 + 0.1, 0), (w / 2 + 0.1, 0.24), (-w / 2 - 0.1, 0.24)], fr, -0.1, pr + 0.12, roles["trim"]),
        frame_prism([(-w / 2 - 0.05, 0.24), (w / 2 + 0.05, 0.24), (w / 2 + 0.05, base_h), (-w / 2 - 0.05, base_h)], fr, -0.1, pr + 0.06, roles["trim"]),
        frame_prism([(-w / 2, base_h), (w / 2, base_h), (w / 2, top - cap_h), (-w / 2, top - cap_h)], fr, -0.1, pr, roles["pier"]),
        frame_prism([(-w / 2 - 0.06, top - cap_h), (w / 2 + 0.06, top - cap_h), (w / 2 + 0.06, top - cap_h / 2), (-w / 2 - 0.06, top - cap_h / 2)], fr, -0.1, pr + 0.07, roles["trim"]),
        frame_prism([(-w / 2 - 0.13, top - cap_h / 2), (w / 2 + 0.13, top - cap_h / 2), (w / 2 + 0.13, top), (-w / 2 - 0.13, top)], fr, -0.1, pr + 0.14, roles["trim"]),
    ])
    for s in r.pieces[-1]["solids"]:
        s.verts = [(x, y, z + r.z) for x, y, z in s.verts]
    r.markers.append({"kind": "sconce", "room": r.id, "at": list(add(o, mul(e["n"], pr + 0.15))) + [r.z + min(2.2, top - 0.6)], "facing": list(e["n"])})


def niche(r, e, t0, t1, top, ns, roles):
    """A blind arched niche in the bay [t0, t1]: the wall face is built around it (no cut)."""
    w = min(ns["width"], (t1 - t0) - 0.9)
    if w < 0.6:
        return False
    tc = (t0 + t1) / 2
    sill, h, dep = ns["sill"], ns["height"], ns["depth"]
    kind = ns.get("arch", "round")
    rise = G.arch_rise(kind, w)
    spring = sill + h - rise
    fr = (r.P(e, tc), e["d"], e["n"])
    # the inner leaf the niche is sunk into: projects `dep` from the wall face, built around the opening
    sol = [frame_prism([(-w / 2 - 0.4, 0), (w / 2 + 0.4, 0), (w / 2 + 0.4, sill), (-w / 2 - 0.4, sill)], fr, -0.05, dep, roles["wall"]),
           frame_prism(G.spandrel(kind, w, spring, min(top - 0.6, sill + h + 0.7), None, 0.4), fr, -0.05, dep, roles["wall"])]
    for s in (-1, 1):
        sol.append(frame_prism([(s * w / 2, sill), (s * (w / 2 + 0.4), sill), (s * (w / 2 + 0.4), spring), (s * w / 2, spring)], fr, -0.05, dep, roles["wall"]))
    sol.append(frame_prism([(-w / 2 - 0.12, sill - 0.12), (w / 2 + 0.12, sill - 0.12), (w / 2 + 0.12, sill), (-w / 2 - 0.12, sill)], fr, dep - 0.05, dep + 0.1, roles["trim"]))
    for s in sol:
        s.verts = [(x, y, z + r.z) for x, y, z in s.verts]
    r.piece("niche", sol)
    r.markers.append({"kind": "niche", "room": r.id, "at": list(r.P(e, tc, 0.05)) + [r.z + sill], "width": w, "height": h})
    return True


def wainscot(r, e, runs, ws, roles):
    """Panelled dado: base board + rail (swept, fixed ends) and stiles REPEATED along the run (repeat 9-slice)."""
    h, mod, pr = ws["height"], ws["module"], ws.get("proj", 0.06)
    for (t0, t1) in runs:
        L = t1 - t0
        if L < 2 * mod:
            continue
        base = [frame_prism([(0, 0), (L, 0), (L, 0.22), (0, 0.22)], (r.P(e, t0), e["d"], e["n"]), -0.05, pr + 0.04, roles["timber"])]
        rail = [frame_prism([(0, h - 0.12), (L, h - 0.12), (L, h), (0, h)], (r.P(e, t0), e["d"], e["n"]), -0.05, pr + 0.05, roles["timber"])]
        panel = [frame_prism([(0, 0.22), (L, 0.22), (L, h - 0.12), (0, h - 0.12)], (r.P(e, t0), e["d"], e["n"]), -0.05, pr * 0.5, roles["panel"])]
        stile = lambda u: [frame_prism([(u - 0.07, 0.22), (u + 0.07, 0.22), (u + 0.07, h - 0.12), (u - 0.07, h - 0.12)], (r.P(e, t0), e["d"], e["n"]), -0.05, pr, roles["timber"])]
        n = max(1, round(L / mod))
        for s in base + rail + panel:
            s.verts = [(x, y, z + r.z) for x, y, z in s.verts]
        r.piece("wainscot", base + rail + panel)
        for k in range(n + 1):
            u = min(max(0.07, k * L / n), L - 0.07)
            st = stile(u)
            for s in st:
                s.verts = [(x, y, z + r.z) for x, y, z in s.verts]
            r.piece("stile", st)


def barrel(r, top, cs, roles):
    """A segmental/round barrel vault along the long axis of a rectangle, with transverse ribs on the bays."""
    o = r.outline
    e0, e1 = r.edges[0], r.edges[1]
    along, across = (e0, e1) if e0["len"] >= e1["len"] else (e1, r.edges[2])
    A, L = along["d"], along["len"]
    span = across["len"]
    wt = r.style["wall"]["thickness"]
    kind = cs.get("arch", "segmental")
    rise = G.arch_rise(kind, span, cs.get("rise", 0.28) * span if kind == "segmental" else None)
    t = cs.get("thickness", 0.5)
    # cross-section frame: u across (centred), extruded along A
    start = along["a"]
    mid = G.add(start, mul(along["n"], span / 2))
    curve = G.arch_curve(kind, span, rise)
    c = span / 2
    poly = [(-c - wt, top), (-c, top)] + [(u, top + dz) for u, dz, _, _ in curve][1:-1] + [(c, top), (c + wt, top), (c + wt, top + rise + t), (-c - wt, top + rise + t)]
    cross_dir = mul(along["n"], -1)  # u grows from the far wall toward `along`
    fr = (mid, cross_dir, A)
    r.piece("vault", [frame_prism(poly, fr, -r.ext(along, 0, wt), L + r.ext(along, 1, wt), roles["ceiling"])])
    stations = []
    if cs.get("ribs", True):
        n = max(1, round(L / r.style["pilasters"]["every"]))
        stations = [k * L / n for k in range(1, n)]
        rw, rd = cs.get("ribWidth", 0.42), cs.get("ribDepth", 0.2)
        for s in stations:
            ring = []
            for u, dz, nu, nz in curve:
                ring.append((u - nu * rd, top + dz - nz * rd))
            outer = [(u + nu * 0.15, top + dz + nz * 0.15) for u, dz, nu, nz in curve][::-1]
            poly = ring + outer
            r.piece("rib", [frame_prism(poly, fr, s - rw / 2, s + rw / 2, roles["trim"])])
    return along, stations


def flat_ceiling(r, top, roles, cs):
    wt = r.style["wall"]["thickness"]
    t = cs.get("thickness", 0.5)
    r.piece("ceiling", [prism(r.skin(wt), top, top + t, roles["ceiling"])])


def rib_slab(r, top, roles, cs, every):
    """Flat ceiling with segmental ribs across the short span at every bay (any convex outline)."""
    flat_ceiling(r, top, roles, cs)
    xs, ys = r.spans()
    d = (1, 0) if xs >= ys else (0, 1)
    nrm = (-d[1], d[0])
    c = G.centroid(r.outline)
    lo = min(dot(p, d) for p in r.outline)
    hi = max(dot(p, d) for p in r.outline)
    n = max(1, round((hi - lo) / every))
    for k in range(1, n):
        p = add(mul(d, lo + k * (hi - lo) / n), mul(nrm, dot(c, nrm)))
        ch = G.chord(r.outline, p, nrm)
        if not ch:
            continue
        span = ch[1] - ch[0]
        rise = min(cs.get("ribRise", 0.6), span * 0.2)
        curve = G.arch_curve("segmental", span, rise)
        spring = top - rise
        poly = [(u, spring + dz) for u, dz, _, _ in curve] + [(span / 2, top + 0.1), (-span / 2, top + 0.1)]
        mid = add(p, mul(nrm, (ch[0] + ch[1]) / 2))
        r.piece("rib", [frame_prism(poly, (mid, nrm, d), -0.21, 0.21, roles["trim"])])


def freestanding(r, top, roles, cs, st):
    """Aisled hall: rows of 9-sliced library columns with arcades between them."""
    col = st.get("columns")
    if not col:
        return []
    xs, ys = r.spans()
    if not G.is_rect(r.outline) or min(xs, ys) < col["minSpan"]:
        return []
    d = (1, 0) if xs >= ys else (0, 1)
    nrm = (-d[1], d[0])
    lo = min(dot(p, d) for p in r.outline)
    hi = max(dot(p, d) for p in r.outline)
    lo_n = min(dot(p, nrm) for p in r.outline)
    hi_n = max(dot(p, nrm) for p in r.outline)
    aisle = col["aisle"]
    n = max(2, round((hi - lo) / st["pilasters"]["every"]))
    stations = [lo + k * (hi - lo) / n for k in range(1, n)]
    rows = [lo_n + aisle, hi_n - aisle]
    roles_map = {"large-ashlar": roles["pier"], "dressed-trim": roles["trim"]}
    spring = top - col.get("arcadeDrop", 0.0)
    kind = col.get("arcade", "round")
    placed = []
    for rn in rows:
        pts = [add(mul(d, s), mul(nrm, rn)) for s in stations]
        for p in pts:
            sol = sized_part(col["part"], (None, spring - r.z, None), roles_map)
            r.piece("pier", G.place(sol, p, d, r.z))
            placed.append(p)
        bay = (hi - lo) / n
        # arcade arches spring from the capitals between neighbouring columns
        for a, b in zip(pts, pts[1:]):
            mid = mul(add(a, b), 0.5)
            span = bay - 1.4
            rise = G.arch_rise(kind, span)
            # the arch can not rise above the ceiling: spring below the top by its rise
            sp = top - rise - 0.35
            poly = G.spandrel(kind, span, sp, top + 0.1, None, 0.75)
            r.piece("arcade", [frame_prism(poly, (mid, d, nrm), -0.35, 0.35, roles["wall"])])
            for k, v in enumerate(G.voussoirs(kind, span, sp, 0.28, 7)):
                r.piece("voussoir", [frame_prism(v, (mid, d, nrm), -0.42, 0.42, roles["trim"])])
    r.markers += [{"kind": "pier", "room": r.id, "at": list(p) + [r.z], "radius": 0.75} for p in placed]
    return placed


def dais(r, st, roles):
    """A raised platform with steps against the wall facing the main door (a second floor height)."""
    ds = st.get("dais")
    if not ds or not G.is_rect(r.outline):
        return
    xs, ys = r.spans()
    if max(xs, ys) < ds["minLength"]:
        return
    # the short wall with no door, else skip
    cands = [e for e in r.edges if not e["doors"] and not e["open"] and e["len"] <= min(xs, ys) + 1e-6]
    if not cands:
        return
    doors = [r.P(x, d["t"]) for x in r.edges for d in x["doors"]]
    e = max(cands, key=lambda c: min([length(sub(r.P(c, c["len"] / 2), p)) for p in doors] or [0]))
    depth, rise, nsteps = ds["depth"], ds["rise"], ds.get("steps", 3)
    margin = ds.get("margin", 1.2)
    t0, t1 = margin, e["len"] - margin
    poly = [r.P(e, t0), r.P(e, t1), r.P(e, t1, depth), r.P(e, t0, depth)]
    r.piece("dais", [prism(poly, r.z - 0.2, r.z + rise, roles["floor"])])
    step_run = 0.36
    for k in range(nsteps - 1):
        hk = rise * (nsteps - 1 - k) / nsteps
        w0 = depth + k * step_run
        poly = [r.P(e, t0 + 0.6, w0), r.P(e, t1 - 0.6, w0), r.P(e, t1 - 0.6, w0 + step_run), r.P(e, t0 + 0.6, w0 + step_run)]
        r.piece("step", [prism(poly, r.z - 0.2, r.z + hk, roles["floor"])], noise="tread")
    # coping-straight (library) along the dais front edge, sliced to its length
    if ds.get("coping"):
        L = t1 - t0
        sol = sized_part("coping-straight", (L, None, None), {"*": roles["trim"]})
        lo = min(v[1] for s in sol for v in s.verts)
        hi = max(v[1] for s in sol for v in s.verts)
        h = hi - lo
        k = ds.get("copingHeight", 0.18) / h
        sol = [s.mapped(lambda p: (p[0], (p[1] - lo) * k, p[2] * 0.4)) for s in sol]
        r.piece("dais-edge", G.place([s.mapped(lambda p: (p[0], p[1] + rise - 0.05, p[2] + depth - 0.1)) for s in sol], r.P(e, (t0 + t1) / 2), e["d"], r.z))
    r.markers.append({"kind": "dais", "room": r.id, "at": list(r.P(e, e["len"] / 2, depth / 2)) + [r.z + rise]})


def build_masonry(r):
    st = r.style
    roles = {k: r.role(k) for k in ("wall", "trim", "floor", "ceiling", "pier", "timber", "panel")}
    cs = dict(st.get("ceiling", {}), **r.spec.get("ceiling", {}))
    top = r.z + r.H
    floor_slab(r, roles["floor"], st.get("floor", {}).get("thickness", 0.5))
    masonry_walls(r, top)
    ps = dict(st.get("pilasters", {}), **r.spec.get("pilasters", {}))
    xs, ys = r.spans()
    small = min(xs, ys) < ps.get("minSpan", 0)
    ns = st.get("niches")
    for e in r.edges:
        if e["open"]:
            continue
        stations, pitch = bays(r, e, ps.get("every", 3.2), ps.get("width", 0.6) / 2 + 0.1) if not small else ([], e["len"])
        for t in stations:
            pilaster(r, e, t, r.H, roles, ps)
        if ns and not small and not e["doors"]:
            edges = [0.0] + stations + [e["len"]]
            for k, (a, b) in enumerate(zip(edges, edges[1:])):
                if k % ns.get("everyBay", 2) == ns.get("offset", 1) % ns.get("everyBay", 2):
                    niche(r, e, a, b, r.H, ns, roles)
        if st.get("wainscot"):
            wainscot(r, e, wall_intervals(r, e, top), st["wainscot"], roles)
    ctype = cs.get("type", "flat")
    if ctype == "barrel" and G.is_rect(r.outline) and not freestanding_wanted(r, st):
        _, stations = barrel(r, top, cs, roles)
        # a rib landing on a door gets a corbel instead of its pilaster
    elif ctype == "beams":
        beams(r, top, roles, cs, ps.get("every", 3.2))
    elif ctype in ("barrel", "rib-slab"):
        rib_slab(r, top, roles, cs, ps.get("every", 3.2))
    else:
        flat_ceiling(r, top, roles, cs)
    freestanding(r, top, roles, cs, st)
    dais(r, st, roles)


def freestanding_wanted(r, st):
    col = st.get("columns")
    xs, ys = r.spans()
    return bool(col) and G.is_rect(r.outline) and min(xs, ys) >= col["minSpan"]


def beams(r, top, roles, cs, every):
    """Flat boarded ceiling on timber beams across the short span, each beam on two corbels."""
    flat_ceiling(r, top, roles, cs)
    xs, ys = r.spans()
    d = (1, 0) if xs >= ys else (0, 1)
    nrm = (-d[1], d[0])
    c = G.centroid(r.outline)
    lo = min(dot(p, d) for p in r.outline)
    hi = max(dot(p, d) for p in r.outline)
    n = max(1, round((hi - lo) / every))
    bw, bh = cs.get("beamWidth", 0.36), cs.get("beamDepth", 0.42)
    for k in range(1, n):
        p = add(mul(d, lo + k * (hi - lo) / n), mul(nrm, dot(c, nrm)))
        ch = G.chord(r.outline, p, nrm)
        if not ch:
            continue
        mid = add(p, mul(nrm, (ch[0] + ch[1]) / 2))
        span = ch[1] - ch[0]
        r.piece("beam", [frame_prism([(-span / 2 - 0.2, top - bh), (span / 2 + 0.2, top - bh), (span / 2 + 0.2, top + 0.05), (-span / 2 - 0.2, top + 0.05)], (mid, nrm, d), -bw / 2, bw / 2, roles["timber"])])
        for s in (-1, 1):
            u = s * span / 2
            cb = [(u, top - bh - 0.5), (u - s * 0.12, top - bh - 0.5), (u - s * 0.45, top - bh), (u, top - bh)]
            r.piece("corbel", [frame_prism(cb, (mid, nrm, d), -bw / 2 - 0.03, bw / 2 + 0.03, roles["trim"])])


# --------------------------------------------------------- timber hall --
def build_timber(r):
    """Giant-timber hall: stone walls to the eaves, a pitched roof carried on bays of posts, tie beams,
    king posts, braces, principal rafters, purlins and a ridge."""
    st = r.style
    roles = {k: r.role(k) for k in ("wall", "trim", "floor", "ceiling", "pier", "timber", "panel")}
    ts = dict(st["timber"], **r.spec.get("timber", {}))
    if not G.is_rect(r.outline):
        raise ValueError(f"{r.id}: the timber hall rule needs a rectangle")
    top = r.z + r.H
    e0, e1 = r.edges[0], r.edges[1]
    along = e0 if e0["len"] >= e1["len"] else e1
    A, L = along["d"], along["len"]
    span = r.edges[(along["i"] + 1) % 4]["len"]
    wt = st["wall"]["thickness"]
    pitch = ts.get("pitch", 0.45)
    rise = pitch * span / 2
    floor_slab(r, roles["floor"], st.get("floor", {}).get("thickness", 0.5))
    # walls: the long walls to the eaves; the gable ends to the ridge
    masonry_walls(r, top)
    for e in r.edges:
        if e is along or e["i"] == (along["i"] + 2) % 4 or e["open"]:
            continue
        poly = [r.P(e, -wt), r.P(e, e["len"] + wt), r.P(e, e["len"] + wt, -wt), r.P(e, -wt, -wt)]
        r.piece("wall", [prism(poly, top - 0.05, top + rise + 1.0, roles["wall"])])
    mid = add(along["a"], mul(along["n"], span / 2))
    cross = mul(along["n"], -1)
    fr = (mid, cross, A)
    c = span / 2
    t = ts.get("roofThickness", 0.5)
    roof = [(-c - wt, top), (-c, top), (0, top + rise), (c, top), (c + wt, top), (c + wt, top + rise + t + 0.6), (-c - wt, top + rise + t + 0.6)]
    r.piece("roof", [frame_prism(roof, fr, -r.ext(along, 0, wt), L + r.ext(along, 1, wt), roles["ceiling"])])
    n = max(2, round(L / ts.get("bay", 4.0)))
    stations = [k * L / n for k in range(1, n)]
    pw, tb = ts.get("post", 0.62), ts.get("tie", 0.62)
    rw = ts.get("rafter", 0.48)
    tie_z = top - 0.35
    slope = rise / c
    for s in stations:
        # wall posts on library base pads; none in front of a doorway on the long walls (it would block the door)
        for side in (-1, 1):
            u = side * (c - pw / 2 + 0.12)
            if any(length(sub(add(mid, add(mul(cross, u), mul(A, s))), r.P(e, d["t"]))) < d["w"] / 2 + pw / 2 + 1.3
                   for e in r.edges for d in e["doors"]):
                continue
            pad = sized_part("base-moulded", (None, None, None), {"*": roles["trim"]})
            p = add(mid, add(mul(cross, u), mul(A, s)))
            r.piece("post-pad", G.place(pad, p, A, r.z))
            r.piece("post", [frame_prism([(u - pw / 2, r.z + 0.55), (u + pw / 2, r.z + 0.55), (u + pw / 2, tie_z), (u - pw / 2, tie_z)], fr, s - pw / 2, s + pw / 2, roles["timber"])])
            # knee brace: post -> tie beam
            k0 = (u - side * pw / 2, tie_z - r.z - 1.6)
            k1 = (u - side * (pw / 2 + 1.6), tie_z - r.z - tb / 2)
            r.piece("brace", [_strut(k0, k1, 0.26, fr, s, roles["timber"], r.z)])
        r.piece("tie-beam", [frame_prism([(-c - 0.1, tie_z - tb / 2), (c + 0.1, tie_z - tb / 2), (c + 0.1, tie_z + tb / 2), (-c - 0.1, tie_z + tb / 2)], fr, s - tb / 2, s + tb / 2, roles["timber"])])
        r.piece("king-post", [frame_prism([(-0.25, tie_z), (0.25, tie_z), (0.25, top + rise + 0.2), (-0.25, top + rise + 0.2)], fr, s - 0.25, s + 0.25, roles["timber"])])
        for side in (-1, 1):
            a = (side * (c + 0.1), top - 0.05 - r.z)
            b = (0, top + rise - r.z - 0.1)
            r.piece("rafter", [_strut((a[0], a[1] - rw), (b[0], b[1] - rw), rw, fr, s, roles["timber"], r.z, offset_up=True)])
            # struts from the king post foot to the rafter
            q = (side * c * 0.45, top + rise * 0.55 - r.z - rw)
            r.piece("strut", [_strut((side * 0.2, tie_z - r.z + 0.3), q, 0.22, fr, s, roles["timber"], r.z)])
        r.markers.append({"kind": "hanging", "room": r.id, "at": list(add(mid, mul(A, s))) + [tie_z - 0.4]})
    # ridge and purlins run the length of the hall
    r.piece("ridge", [frame_prism([(-0.28, top + rise - 0.55), (0.28, top + rise - 0.55), (0.28, top + rise + 0.2), (-0.28, top + rise + 0.2)], fr, -0.2, L + 0.2, roles["timber"])])
    for side in (-1, 1):
        for f in ts.get("purlins", [0.35, 0.68]):
            u = side * c * (1 - f)
            z = top + rise * f - 0.12
            r.piece("purlin", [frame_prism([(u - 0.2, z - 0.42), (u + 0.2, z - 0.42), (u + 0.2, z + 0.15), (u - 0.2, z + 0.15)], fr, -0.2, L + 0.2, roles["timber"])])
        # wall plate on the long walls
        u = side * (c - 0.2)
        r.piece("wall-plate", [frame_prism([(u - 0.3, top - 0.3), (u + 0.3, top - 0.3), (u + 0.3, top + 0.1), (u - 0.3, top + 0.1)], fr, -0.2, L + 0.2, roles["timber"])])
    # aisle posts in very wide halls carry the tie beams at third points
    if span >= ts.get("aisleSpan", 99):
        for s in stations:
            for side in (-1, 1):
                u = side * c / 3
                p = add(mid, add(mul(cross, u), mul(A, s)))
                pad = sized_part("base-moulded", (None, None, None), {"*": roles["trim"]})
                r.piece("post-pad", G.place(pad, p, A, r.z))
                r.piece("post", [frame_prism([(u - pw / 2, r.z + 0.55), (u + pw / 2, r.z + 0.55), (u + pw / 2, tie_z), (u - pw / 2, tie_z)], fr, s - pw / 2, s + pw / 2, roles["timber"])])
                r.markers.append({"kind": "pier", "room": r.id, "at": list(p) + [r.z], "radius": pw})
    # stone pilasters on the long walls between bays? no: posts carry; sconces on the posts
    dais(r, st, roles)


def _strut(a, b, w, fr, s, role, z0, offset_up=False):
    """A diagonal timber in the cross-section plane from a to b ((u, z) relative to the floor), w thick."""
    d = unit(sub(b, a))
    n = (-d[1], d[0])
    if offset_up:
        pts = [a, b, add(b, mul(n, w if n[1] > 0 else -w)), add(a, mul(n, w if n[1] > 0 else -w))]
    else:
        pts = [add(a, mul(n, -w / 2)), add(b, mul(n, -w / 2)), add(b, mul(n, w / 2)), add(a, mul(n, w / 2))]
    pts = [(u, z + z0) for u, z in pts]
    return frame_prism(pts, fr, s - w / 2, s + w / 2, role)


# -------------------------------------------------------- natural rooms --
def build_natural(r):
    """Natural cave: rough mitred rock walls, a domed uneven roof (shapes_blender.cave_ceiling), an earth
    floor, and by rule rock pillars, stalactite clusters, stalagmites and a raised rock shelf. Every rock
    piece carries its noise key, so role noise does the surface; no box lumps."""
    st = r.style
    ns = dict(st["natural"], **r.spec.get("natural", {}))
    rock, roof, floor = r.role("rock"), r.role("ceiling"), r.role("floor")
    top = r.z + r.H
    rise = r.spec.get("rise", ns.get("rise", 1.6))
    wt = st["wall"]["thickness"]
    r.piece("floor", [prism(r.skin(wt), r.z - 0.6, r.z, floor)], ns.get("floorNoise", "earth-floor"))
    native_walls(r, top + 0.3, rock, ns.get("wallNoise", "rock-wall"))
    r.pieces.append({"name": f"{r.id}.roof.1", "kind": "roof", "shape": "cave_ceiling", "noise": ns.get("roofNoise", "rock-roof"),
                     "args": {"outline": r.outline, "z_spring": top, "rise": rise, "thickness": 0.8, "material": roof,
                              "seed": r.spec.get("seed", 1), "lap": wt * 0.6, "jitter": ns.get("jitter", 0.35)}})
    lanes = lane_segments(r)
    c = G.centroid(r.outline)
    area = abs(G.area2(r.outline))
    rng = r.rng
    # rock pillars: one per pillarArea m2 of floor, kept clear of walls and the walk lanes
    want = int(area // ns.get("pillarArea", 70))
    placed = sample(r, rng, want, ns.get("pillarWall", 2.2), lanes, ns.get("lane", 2.2), spacing=4.5)
    for p in placed:
        rad = rng.uniform(*ns.get("pillarRadius", [0.7, 1.1]))
        rings = []
        h = r.H + rise + 0.8
        for k, f in enumerate([-0.05, 0.12, 0.35, 0.55, 0.75, 0.9, 1.0]):
            waist = 1 - 0.38 * math.sin(math.pi * min(1, max(0, f)))
            rr = rad * (1.6 if f < 0.05 else waist + (0.5 if f >= 0.99 else 0))
            ring = []
            for j in range(9):
                a = 2 * math.pi * j / 9 + k * 0.21
                q = rr * (0.85 + 0.3 * rng.random())
                ring.append((p[0] + q * math.cos(a), p[1] + q * math.sin(a), r.z - 0.3 + h * max(f, 0) if f >= 0 else r.z - 0.3))
            rings.append(ring)
        r.piece("pillar", [G.loft_rings(rings, rock)], ns.get("wallNoise", "rock-wall"))
        r.markers.append({"kind": "pier", "room": r.id, "at": [p[0], p[1], r.z], "radius": rad * 1.6})
    # stalactite clusters hang near the crown; tips stay above the springing (the plan's clear height)
    for k in range(ns.get("clusters", 2)):
        f = rng.uniform(0.15, 0.4)
        ang = rng.uniform(0, 2 * math.pi)
        q = add(c, (math.cos(ang) * f * 4, math.sin(ang) * f * 4))
        if not G.inside(r.outline, q):
            continue
        root = top + rise * 0.8
        for j in range(rng.randint(3, 5)):
            p = add(q, (rng.uniform(-0.9, 0.9), rng.uniform(-0.9, 0.9)))
            ln = rng.uniform(0.5, max(0.6, rise * 0.7))
            r.piece("stalactite", [G.cone((p[0], p[1], root + 0.6), rng.uniform(0.22, 0.4), -(ln + 0.6), rock, sides=6, rot=rng.random())], ns.get("wallNoise", "rock-wall"))
    # stalagmites near the walls, out of the lanes
    for p in sample(r, rng, ns.get("stalagmites", 5), 0.6, lanes, ns.get("lane", 2.2), spacing=1.2, max_wall=1.6):
        r.piece("stalagmite", [G.cone((p[0], p[1], r.z - 0.2), rng.uniform(0.25, 0.45), rng.uniform(0.5, 1.2), rock, sides=6, rot=rng.random())], ns.get("wallNoise", "rock-wall"))
    # a raised rock shelf along the longest wall without a door: the room's second floor height
    sh = ns.get("shelf")
    if sh:
        cand = sorted([e for e in r.edges if not e["doors"] and not e["open"]], key=lambda e: -e["len"])
        if cand and cand[0]["len"] > 4 and min(r.spans()) >= sh.get("minSpan", 7):
            e = cand[0]
            dpt = sh.get("depth", 1.6)
            poly = [r.P(e, 0.4), r.P(e, e["len"] - 0.4), r.P(e, e["len"] - 0.8, dpt), r.P(e, 0.8, dpt * 0.8)]
            if all(G.inside(r.outline, q) for q in poly[2:]):
                r.piece("ledge", [prism(poly, r.z - 0.3, r.z + sh.get("height", 0.75), rock)], ns.get("wallNoise", "rock-wall"))
                r.markers.append({"kind": "shelf", "room": r.id, "at": list(r.P(e, e["len"] / 2, dpt / 2)) + [r.z + sh.get("height", 0.75)]})


def lane_segments(r):
    """Walk lanes: every doorway to the room centre (and door to door)."""
    c = G.centroid(r.outline)
    doors = [r.P(e, d["t"]) for e in r.edges for d in e["doors"]] + [r.P(e, e["len"] / 2) for e in r.edges if e["open"]]
    segs = [(p, c) for p in doors]
    segs += [(a, b) for i, a in enumerate(doors) for b in doors[i + 1:]]
    return segs


def sample(r, rng, count, min_wall, lanes, lane, spacing, max_wall=None):
    xs = [p[0] for p in r.outline]
    ys = [p[1] for p in r.outline]
    out = []
    for _ in range(count * 60):
        if len(out) >= count:
            break
        p = (rng.uniform(min(xs), max(xs)), rng.uniform(min(ys), max(ys)))
        if not G.inside(r.outline, p):
            continue
        dw = G.dist_to_outline(r.outline, p)
        if dw < min_wall or (max_wall and dw > max_wall):
            continue
        if any(G.dist_to_seg(p, a, b) < lane for a, b in lanes):
            continue
        if any(length(sub(p, q)) < spacing for q in out):
            continue
        out.append(p)
    return out


# --------------------------------------------------------------- entry --
BUILDERS = {"masonry": build_masonry, "timber": build_timber, "natural": build_natural}


def build_room(spec, style):
    r = Room(spec, style)
    (build_stair if spec.get("kind") == "stair" or "stair" in spec else BUILDERS[style["construction"]])(r)
    return r


# ------------------------------------------------------------- stairs --
def stair_profile(r):
    """A stair room's long axis, pitch line and ceiling line. spec.stair: {up: N|E|S|W (the climbing direction), rise,
    riser, tread, landing (lower landing length; the upper one is the rest), headroom (above the nosing line),
    ceiling: barrel|segmental|pointed|raked|natural}. Returns (frame, L, width, l0, F, rise, z0, pitch(u), ceil(u))."""
    ss = dict(r.style.get("stair", {}), **r.spec.get("stair", {}))
    if not G.is_rect(r.outline):
        raise ValueError(f"{r.id}: a stair room needs a rectangle")
    lo = r.edge_for_side({"N": "S", "S": "N", "E": "W", "W": "E"}[ss["up"]])   # the low end's wall line
    A = mul(lo["n"], 1)                                                       # inward from the low end = up the flight
    side = r.edges[(lo["i"] + 1) % r.n]
    L, width = side["len"], lo["len"]
    origin = G.add(lo["a"], mul(lo["d"], width / 2))                          # centre of the low end
    rise, riser, tread = ss["rise"], ss.get("riser", 0.2), ss.get("tread", 0.32)
    n = max(1, round(abs(rise) / riser))
    F = n * tread
    l0 = ss.get("landing", 1.2)
    if L - l0 - F < 0.8:
        raise ValueError(f"{r.id}: {n} steps x {tread} m + landing {l0} m leave {L - l0 - F:.2f} m of upper landing (< 0.8): lengthen the room")
    H = ss.get("headroom", 3.4)
    z0 = r.z

    def pitch(u):
        return z0 + rise * min(1.0, max(0.0, (u - l0) / F))
    win = ss.get("fillet", 1.6)   # the kinks at both landings are rounded over this length (no step, no pinch)

    def ceil(u):
        k = 8
        return H + sum(pitch(u + win * (j / k - 0.5)) for j in range(k + 1)) / (k + 1)
    return ss, (origin, lo["d"], A), L, width, l0, F, n, rise, pitch, ceil


def build_stair(r):
    """A stair or ramp passage whose ceiling FOLLOWS the flight: a raking barrel/segmental/pointed vault or a raked
    slab (masonry/timber styles), or a lofted natural tunnel with a noised sloped roof (natural styles). Headroom is
    constant above the nosing line; the kinks at both landings are filleted, so the vault meets each landing's level
    ceiling (and the neighbour's doorway head at the same height) without a step."""
    st = r.style
    ss, (o, X, A), L, width, l0, F, n, rise, pitch, ceil = stair_profile(r)
    natural = st["construction"] == "natural"
    wt = st["wall"]["thickness"]
    c = width / 2
    floor_role = r.role("floor")
    tread_role = r.role("rock") if natural else r.role("trim")

    def P(a, u, z):  # a across (from the centre line, toward X), u along the flight
        return (o[0] + X[0] * a + A[0] * u, o[1] + X[1] * a + A[1] * u, z)
    opp = {"N": "S", "S": "N", "E": "W", "W": "E"}
    if not (r.edge_for_side(ss["up"])["open"] and r.edge_for_side(opp[ss["up"]])["open"]):
        raise ValueError(f"{r.id}: both ends of a stair room are openSides (each runs into a neighbour's doorway)")
    ex0 = ex1 = ss.get("lap", 0.3)   # into the neighbours' walls (same dc_group: the field unions the joint)
    us = [-ex0 + k * (L + ex0 + ex1) / max(1, round((L + ex0 + ex1) / 0.25)) for k in range(round((L + ex0 + ex1) / 0.25) + 1)]
    z0, z1 = pitch(0), pitch(L)
    # landings and treads: crisp (null noise), full width plus into the walls
    ww = c + (0.1 if natural else wt)
    r.piece("floor", [G.loft_rings([[P(-ww, u, min(z0, z1) - 0.6), P(ww, u, min(z0, z1) - 0.6), P(ww, u, pitch(u) if u <= l0 or u >= l0 + F else min(z0, z1) - 0.3), P(-ww, u, pitch(u) if u <= l0 or u >= l0 + F else min(z0, z1) - 0.3)] for u in (-ex0, l0)], floor_role)])
    r.piece("floor", [G.loft_rings([[P(-ww, u, min(z0, z1) - 0.6), P(ww, u, min(z0, z1) - 0.6), P(ww, u, z1), P(-ww, u, z1)] for u in (l0 + F, L + ex1)], floor_role)])
    for k in range(n):
        top = z0 + rise * (k + 1) / n if rise > 0 else z0 + rise * k / n
        u0, u1 = l0 + k * F / n, l0 + (k + 1) * F / n
        if rise > 0:
            u1 = l0 + F if k == n - 1 else u1 + 0.02
        r.piece("step", [G.loft_rings([[P(-ww, u, min(z0, z1) - 0.6), P(ww, u, min(z0, z1) - 0.6), P(ww, u, top), P(-ww, u, top)] for u in (u0, u1 + 0.001)], tread_role)])
    marker = {"kind": "stair", "room": r.id, "path": [list(P(0, 0, 0)[:2]), list(P(0, L, 0)[:2])],
              "prof": [[0, z0], [l0, z0], [l0 + F, z1], [L, z1]], "flight": [l0, l0 + F], "width": width,
              "headroom": ss.get("headroom", 3.4), "ceiling": "natural" if natural else ss.get("ceiling", "barrel"), "steps": n}
    r.markers.append(marker)
    if natural:
        ns = dict(st.get("natural", {}), **r.spec.get("natural", {}))
        path = [P(0, u, pitch(u)) for u in us[::4]] + ([P(0, us[-1], pitch(us[-1]))] if (len(us) - 1) % 4 else [])
        r.pieces.append({"name": f"{r.id}.roof.1", "kind": "roof", "shape": "cave_tunnel", "noise": ns.get("roofNoise", "rock-roof"),
                         "args": {"path": [tuple(p) for p in path], "width": width, "height": ss.get("headroom", 3.4) + 0.3,
                                  "thickness": wt, "material": r.role("rock"), "seed": r.spec.get("seed", 1),
                                  "bury": abs(rise) / n + 0.35, "irregular": ns.get("tunnelIrregular", 0.3), "crown_jitter": 0.3}})
        return
    # masonry: raking side walls up to the springing, a raking vault (or raked slab), raking courses, ribs
    kind = ss.get("ceiling", "barrel")
    akind = {"barrel": "round", "segmental": "segmental", "pointed": "pointed"}.get(kind)
    arise = G.arch_rise(akind, width, ss.get("archRise", 0.28) * width if akind == "segmental" else None) if akind else 0.0
    spring = lambda u: ceil(u) - arise
    t = st.get("ceiling", {}).get("thickness", 0.5)
    wall, trim, ceil_role = r.role("wall"), r.role("trim"), r.role("ceiling")
    for s in (-1, 1):
        a_in, a_out = s * c, s * (c + wt)
        ring = lambda u: [P(a_in, u, min(z0, z1) - 0.6), P(a_out, u, min(z0, z1) - 0.6), P(a_out, u, spring(u) + 0.12), P(a_in, u, spring(u) + 0.12)]
        r.piece("wall", [G.loft_rings([ring(u) for u in us], wall)])
        # raking plinth on the pitch line and a raking string course at the springing (parallel to the flight)
        pl = lambda u: [P(s * (c - 0.1), u, pitch(u) - 0.2), P(s * (c + 0.05), u, pitch(u) - 0.2), P(s * (c + 0.05), u, pitch(u) + 0.38), P(s * (c - 0.1), u, pitch(u) + 0.38)]
        r.piece("plinth", [G.loft_rings([pl(u) for u in us if 0 <= u <= L], trim)])
        sc = lambda u: [P(s * (c - 0.14), u, spring(u) - 0.26), P(s * (c + 0.05), u, spring(u) - 0.26), P(s * (c + 0.05), u, spring(u)), P(s * (c - 0.14), u, spring(u))]
        r.piece("string-course", [G.loft_rings([sc(u) for u in us if 0 <= u <= L], trim)])
    if akind:
        curve = G.arch_curve(akind, width, arise)
        sec = [(-c - wt, 0.0), (-c, 0.0)] + [(a, dz) for a, dz, _, _ in curve][1:-1] + [(c, 0.0), (c + wt, 0.0), (c + wt, arise + t), (-c - wt, arise + t)]
    else:
        sec = [(-c - wt, 0.0), (c + wt, 0.0), (c + wt, t), (-c - wt, t)]
    r.piece("vault", [G.loft_rings([[P(a, u, spring(u) + dz) for a, dz in sec] for u in us], ceil_role)])
    every = st.get("pilasters", {}).get("every", 3.2)
    m = max(1, round(L / every))
    rw, rd = st.get("ceiling", {}).get("ribWidth", 0.42), st.get("ceiling", {}).get("ribDepth", 0.2)
    for k in range(1, m):
        uc = k * L / m
        if akind:
            inner = [(a - na * rd, dz - nz * rd) for a, dz, na, nz in curve]
            outer = [(a + na * 0.15, dz + nz * 0.15) for a, dz, na, nz in curve][::-1]
            poly = inner + outer
        else:
            poly = [(-c, -rd), (c, -rd), (c, 0.15), (-c, 0.15)]
        # a rib is square to the flight's axis but rakes with it: its two faces sit at their own ceiling heights
        r.piece("rib", [G.loft_rings([[P(a, u, spring(u) + dz) for a, dz in poly] for u in (uc - rw / 2, uc + rw / 2)], trim)])
