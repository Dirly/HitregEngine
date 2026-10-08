"""Kit parts: the carved DC library's recipes as 9-slice parts, plus the kit's own native parts.

Library parts are read from apps/playground/projects/dc-carved-library/authoring/recipes/<id>.json.
Only their ADD nodes become solids (box / prism, with the recipe's own rotation); sub/intersect
cutters are dropped and counted, so a part that depends on cutters (arches, recessed panels) is not
offered here - the kit draws those natively. Part frame = the recipe's engine frame: u = x (along),
v = y (up, floor at 0), w = z (depth, centred).

Slice bands are the curated ones of references/slicing-rules.md: geometry never crosses a band plane
with a slanted face, so the piecewise-linear map is exact.
"""
import json
import math
import os

from geom import Solid, prism, orient, nine_slice

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RECIPES = os.path.join(ENGINE, "apps", "playground", "projects", "dc-carved-library", "authoring", "recipes")

# id -> slice bands (part frame) and what the kit uses it for
LIBRARY = {
    "column-octagonal": {"bands": {"u": [-0.07, 0.07], "v": [0.95, 2.25], "w": [-0.07, 0.07]}, "use": "freestanding pier, base + shaft + capital"},
    "base-moulded": {"bands": {"u": [-0.07, 0.07], "w": [-0.07, 0.07]}, "use": "pier / post pad"},
    "capital-moulded": {"bands": {"u": [-0.07, 0.07], "w": [-0.07, 0.07]}, "use": "pier head"},
    "wall-plain": {"bands": {"u": [-0.9, 0.9], "v": [1.0, 2.2], "w": [-0.12, 0.12]}, "use": "masonry wall run: stock, plinth, string course, frieze, coping"},
    "coping-straight": {"bands": {"u": [-1.0, 1.0]}, "use": "chamfered coping on ledges, dais edges, parapets"},
}

_cache = {}


def _euler(rx, ry, rz):
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    return [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
            [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
            [-sy, cy * sx, cy * cx]]


def _node_solid(node, role):
    R = _euler(*node.get("rotation", [0, 0, 0]))
    pos = node.get("position", [0, 0, 0])
    if node["shape"] == "box":
        sx, sy, sz = node["size"]
        poly = [(-sx / 2, -sz / 2), (sx / 2, -sz / 2), (sx / 2, sz / 2), (-sx / 2, sz / 2)]
        h = sy
    elif node["shape"] == "prism":
        poly, h = node["polygon"], node["height"]
    else:
        raise ValueError(f"library node shape {node['shape']} is not supported")
    # local prism: footprint x/z, extruded along y, centred
    base = prism(poly, -h / 2, h / 2, role)  # verts (x, z_as_y, y_as_z): remap below

    def to_engine(p):
        lx, lz, ly = p[0], p[1], p[2]  # geom.prism put the footprint in x/y and height in z
        return tuple(pos[i] + R[i][0] * lx + R[i][1] * ly + R[i][2] * lz for i in range(3))
    return orient(base.mapped(to_engine))


def library_part(part_id):
    """(solids in part frame tagged by recipe palette role, info) for a carved-library recipe."""
    if part_id in _cache:
        return _cache[part_id]
    if part_id not in LIBRARY:
        raise ValueError(f"unknown library part {part_id}; have {sorted(LIBRARY)}")
    with open(os.path.join(RECIPES, part_id + ".json"), encoding="utf-8") as fh:
        recipe = json.load(fh)
    vol = recipe["volume"]
    palette = vol["palette"]
    default = vol.get("surface", {}).get("wall", 0)
    solids, dropped = [], 0
    for node in vol["nodes"]:
        if node.get("op", "add") != "add":
            dropped += 1
            continue
        idx = (node.get("surface") or {}).get("wall", default)
        solids.append(_node_solid(node, palette[idx]))
    lo = [min(v[i] for s in solids for v in s.verts) for i in range(3)]
    hi = [max(v[i] for s in solids for v in s.verts) for i in range(3)]
    info = {"id": part_id, "revision": recipe.get("revision"), "nodes": len(vol["nodes"]), "droppedCutters": dropped,
            "size": [hi[i] - lo[i] for i in range(3)], "min": lo, "max": hi, "bands": LIBRARY[part_id]["bands"]}
    _cache[part_id] = (solids, info)
    return solids, info


def sized_part(part_id, size, role_map):
    """A library part 9-sliced to a complete outer size (U, V, W) (None keeps an axis), roles mapped
    through role_map {recipe role: kit role}. Returns solids in the part frame with v from 0."""
    solids, info = library_part(part_id)
    src = info["size"]
    tgt = [size[i] if size[i] is not None else src[i] for i in range(3)]
    # bands are in the part frame; the map anchors u/w at the centre and v at the floor
    out = nine_slice(solids, info["bands"], src, tgt)
    return [Solid(s.verts, s.faces, role_map.get(s.role, role_map.get("*", s.role))) for s in out]
