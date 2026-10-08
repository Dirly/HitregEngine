"""Blender side of the dungeon room kit: room plan -> tagged closed solids -> (optionally) the mesh stamp.

Two ways in:

1. From a dungeon's own build.py (set pieces stay there, the kit does the architecture):

    import sys; sys.path.insert(0, r"<engine>/tools/dungeon-room-kit/kit")
    import blender_build as kit
    report = kit.build_rooms(plan_dict_or_path)          # objects tagged dc_group / dc_role / dc_noise
    ... add this dungeon's own set pieces ...
    kit.export(plan, stamp_path, audit_path)            # tools/mesh-dc/export_blender.export_mesh_stamp

2. Headless, through the CLI (tools/dungeon-room-kit/roomkit.mjs build):

    blender --background --factory-startup --python blender_build.py -- <rooms.json> <out-dir>
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
KIT = os.path.dirname(HERE)
ENGINE = os.path.abspath(os.path.join(KIT, "..", ".."))
sys.path.insert(0, os.path.join(ENGINE, "tools", "mesh-dc"))

import geom  # noqa: E402
import rules  # noqa: E402
from parts import library_part, LIBRARY  # noqa: E402

DEFAULT_PALETTE = [
    {"id": "large-ashlar", "color": "#8c8880"}, {"id": "coursed-stone", "color": "#7d7a72"},
    {"id": "small-brick", "color": "#8a7466"}, {"id": "flagstone", "color": "#93908a"},
    {"id": "dressed-trim", "color": "#b3a98c"}, {"id": "vault-ceiling", "color": "#6e7069"},
    {"id": "basalt", "color": "#3e4044"}, {"id": "lichen", "color": "#5d6b46"},
    {"id": "wood", "color": "#4a3320"}, {"id": "metal", "color": "#55585c"},
    {"id": "smooth-stone", "color": "#6b6d75"}, {"id": "silt", "color": "#4d4030"},
]


def _merge(a, b):
    out = dict(a)
    for k, v in (b or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_style(name, overrides=None, seen=()):
    path = os.path.join(KIT, "styles", name + ".json")
    with open(path, encoding="utf-8") as fh:
        st = json.load(fh)
    if st.get("extends"):
        if st["extends"] in seen:
            raise ValueError(f"style {name}: extends loop")
        st = _merge(load_style(st["extends"], None, seen + (name,)), {k: v for k, v in st.items() if k != "extends"})
    return _merge(st, overrides)


def load_plan(plan):
    if isinstance(plan, str):
        base = os.path.dirname(os.path.abspath(plan))
        with open(plan, encoding="utf-8") as fh:
            plan = json.load(fh)
        plan["_base"] = base
    return plan


def structural_kinds():
    with open(os.path.join(ENGINE, "tools", "dungeon-pipeline", "thresholds.json"), encoding="utf-8") as fh:
        return set(json.load(fh)["recipe"]["structuralKinds"])


def plan_rooms(plan):
    """Pure geometry (no bpy): [(room spec, Room)]. Usable for tests in any Python."""
    out = []
    for spec in plan["rooms"]:
        st = load_style(spec["style"], (plan.get("styles") or {}).get(spec["style"]))
        if spec.get("rules"):
            st = _merge(st, spec["rules"])
        out.append((spec, rules.build_room(spec, st)))
    return out


# ------------------------------------------------------------ Blender --
def _material(role):
    import bpy
    m = bpy.data.materials.get(role)
    if m is None:
        m = bpy.data.materials.new(role)
        m["dc_role"] = role
    return m


def _object(name, solids, group, noise, collection):
    import bpy
    verts, faces, mats, roles = [], [], [], []
    for s in solids:
        o = len(verts)
        verts += s.verts
        if s.role not in roles:
            roles.append(s.role)
        for f in s.faces:
            faces.append([i + o for i in f])
            mats.append(roles.index(s.role))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    for role in roles:
        mesh.materials.append(_material(role))
    for poly, mi in zip(mesh.polygons, mats):
        poly.material_index = mi
    mesh.validate(clean_customdata=False)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj["dc_export"] = True
    obj["dc_group"] = group
    obj["dc_role"] = "structure"
    if noise:
        obj["dc_noise"] = noise
    return obj


def build_rooms(plan, clear=True):
    """Build every room of the plan into the open Blender scene. Returns the per-room report."""
    import bpy
    import shapes_blender as shapes
    plan = load_plan(plan)
    if clear:
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    coll = bpy.data.collections.get("room-kit") or bpy.data.collections.new("room-kit")
    if coll.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(coll)
    structural = structural_kinds()
    report = {"rooms": [], "objects": 0, "solids": 0, "markers": []}
    t0 = time.time()
    for spec, room in plan_rooms(plan):
        group = spec.get("group", spec["id"])
        kinds, solids_n, detail = {}, 0, 0
        for p in room.pieces:
            if p.get("shape") == "cave_ceiling":
                a = p["args"]
                shapes.cave_ceiling(p["name"], a["outline"], a["z_spring"], a["rise"], a["thickness"], a["material"], group,
                                    noise=p["noise"], seed=a["seed"], lap=a["lap"], jitter=a["jitter"], collection=coll)
                n = 1
            elif p.get("shape") == "cave_tunnel":
                a = p["args"]
                shapes.cave_tunnel(p["name"], a["path"], a["width"], a["height"], a["thickness"], a["material"], group, noise=p["noise"],
                                   seed=a["seed"], bury=a["bury"], irregular=a["irregular"], crown_jitter=a["crown_jitter"], collection=coll)
                n = 1
            else:
                _object(p["name"], p["solids"], group, p["noise"], coll)
                n = len(p["solids"])
            kinds[p["kind"]] = kinds.get(p["kind"], 0) + n
            solids_n += n
            if p["kind"] not in structural:
                detail += n
        report["rooms"].append({"id": spec["id"], "group": group, "style": spec["style"], "construction": room.style["construction"],
                                "pieces": len(room.pieces), "solids": solids_n, "detail": detail, "kinds": kinds})
        report["markers"] += room.markers
        report["objects"] += len(room.pieces)
        report["solids"] += solids_n
    report["buildSeconds"] = round(time.time() - t0, 3)
    return report


def export(plan, stamp_path, audit_path=None):
    """Export the kit's objects through tools/mesh-dc/export_blender.py (closed-solid validation, roles, noise)."""
    import bpy
    plan = load_plan(plan)
    ns = {}
    with open(os.path.join(ENGINE, "tools", "mesh-dc", "export_blender.py"), encoding="utf-8") as fh:
        exec(compile(fh.read(), "export_blender.py", "exec"), ns)
    noise = plan.get("noise")
    if isinstance(noise, str):
        noise = os.path.join(plan.get("_base", ""), noise)
    objs = [o for o in bpy.data.objects if o.get("dc_export")]
    return ns["export_mesh_stamp"](stamp_path, objects=objs, anchor=tuple(plan.get("anchor", (0, 0, 0))),
                                   palette=plan.get("palette", DEFAULT_PALETTE), name=plan.get("name", "room kit"),
                                   audit_path=audit_path, noise=noise)


def main(argv):
    import bpy
    rooms_path, out_dir = argv[0], argv[1]
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()
    plan = load_plan(rooms_path)
    report = build_rooms(plan)
    stem = plan.get("id", "rooms")
    stamp = os.path.join(out_dir, f"{stem}.mesh-stamp.json")
    audit = os.path.join(out_dir, "source-audit.json")
    t1 = time.time()
    export(plan, stamp, audit)
    report["exportSeconds"] = round(time.time() - t1, 3)
    report["stamp"] = stamp
    report["sourceAudit"] = audit
    report["library"] = {k: {kk: vv for kk, vv in library_part(k)[1].items() if kk in ("revision", "droppedCutters", "size")} for k in LIBRARY}
    if "--blend" in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, f"{stem}.blend"))
    report["blenderSeconds"] = round(time.time() - t0, 3)
    with open(os.path.join(out_dir, "kit-report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1)
    with open(os.path.join(out_dir, "markers.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "frame": "plan (x east, y north, z up), metres", "markers": report["markers"]}, fh, indent=1)
    for r in report["rooms"]:
        print(f"ROOM {r['id']:<18} {r['construction']:<8} pieces={r['pieces']:<4} solids={r['solids']:<4} detail={r['detail']}")
    print(f"KIT OK solids={report['solids']} build={report['buildSeconds']}s export={report['exportSeconds']}s")


if __name__ == "__main__":
    if "--" in sys.argv:
        try:
            main(sys.argv[sys.argv.index("--") + 1:])
        except Exception as exc:  # make the headless run fail loudly
            import traceback
            traceback.print_exc()
            print("KIT FAILED", exc)
            sys.exit(1)
