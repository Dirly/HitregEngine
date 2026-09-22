# Dungeon rooms are authored in Blender, imported into DC

Decision (2026-09-15, Derek): hand-crafted dungeon rooms and tunnels are modeled in
Blender through the Blender MCP server and brought into the engine by the
`tools/mesh-dc` bridge ("Blender to DC"). The voxel construction tools
(`dc-construction`, `dc-carving`, `dc-arch-fit`) stay for carving, stairs, portals and
cave fitting inside an imported stamp; they are no longer the first tool for a room.
Reason: rooms must feel man-made and purposeful, and modeling that in Blender is faster
and more legible than composing CSG recipes, while DC still removes every coincident
face and z-fight at import.

Proof of the chain: `apps/playground/projects/hero-tower-blender` (NOTES.md there):
export → convert → dual contouring → mesh audit, all groups passing at 0.12 m with no
hand transcription.

## Session setup

The MCP server needs Blender 5.2 running with its `mcp` extension server on port 9876.
Launch it detached:

```
"P:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --python-expr "import bpy; bpy.app.timers.register(lambda: (bpy.ops.blmcp.server_start(), None)[1], first_interval=1.5)"
```

Only one live Blender exists. Parallel agents build in their own headless processes
(`blender --background --python <script>` or the `*_for_cli` MCP tools with a private
blend file) and hand a build module to whoever owns the live session.

## Modeling rules the exporter enforces

- Every structural piece is a **closed solid with thickness**. Rings for round walls,
  prisms for treads, shells with rims for domes. Open shells are refused.
- Solids may overlap or touch; inside one `dc_group` they union in the field. Lap
  neighbouring groups by about 0.1 m so seams hide inside stone.
- One `dc_group` per room, storey or tunnel. Keep each under 15 M cells at the intended
  voxel size (0.12 m blockout, 0.06 m for inspected stair detail).
- **Boolean cuts leave zero-area slivers** the exporter refuses ("degenerate triangle").
  Weld, triangulate and collapse or dissolve them after every boolean (see
  `clean_slivers` in the hero-tower build script).
- Props, furniture, doors and decor are separate objects tagged `dc_role = "prop"` so
  they never enter the field; they still export to the display GLB.
- Water and lava are not palette roles. Model the basin or channel as structure and mark
  the fluid with an empty (`dc_marker = "volume"`, `kind = "water" | "lava"`, extents).

## Materials

Blender materials are named by the eleven stable palette roles in
`docs/dungeon-materials.md` and carry `dc_role`. The exporter turns the material on each
face into a palette index, which becomes per-vertex weights in the volume; nobody paints
voxels. DC discards Blender UVs and textures are placed in world space at 2 m per tile,
so the same role set fits any carved shape. Pass the full ordered palette on export so
slot order is stable across imports and theme swaps.

## Tags

Empties with custom properties, exported two ways: to the display GLB as glTF `extras`
(`export_extras=True`; three.js exposes them as `userData`) and to a sidecar
`markers.json` in engine Y-up around the entrance anchor.

| `dc_marker` | Required props | Meaning |
| --- | --- | --- |
| `connector` | `kind` (doorway, tunnel, stair), `width`, `height`, `level`, `facing`, `to` | An opening another piece must meet |
| `prop` | `prop`, `level` | Where a prop or set-dressing element belongs |
| `anchor` | `kind` (entrance, spawn, boss) | Gameplay anchor |
| `volume` | `kind`, `size` | Water, lava, fog extents |

Connector pairs must agree on position, width and height to within one voxel. The
importer does not yet place markers as prefab children; that is a small extension to
`tools/mesh-dc`.

## Export and prove

```
# in the live Blender (MCP): exec tools/mesh-dc/export_blender.py, then
export_mesh_stamp("<abs>/authoring/<name>.mesh-stamp.json", anchor=<entrance>, palette=<11 roles>, name="...", audit_path="<abs>/reports/source-audit.json")
# offline conversion + extraction + audit, per group
pnpm --dir apps/playground exec tsx projects/<name>/authoring/dc-bake.mts --voxel .12
```

Import for real through the registered **Blender to DC** tool with the mesh-stamp JSON.
Then validate traversal and visuals the way the dungeon-authoring skill already requires.

## The stages, in order — and the two that get skipped

Importing is not shipping. The pipeline below is the whole path from plan to a
scene a player can open; `gloomvein-hold` shipped with stages 7 and 11 missing
and the result would not load at all. Keep a project-local status command (see
`projects/gloomvein-hold/authoring/pipeline.mjs`) that prints each stage as
`ok` / `STALE` / `MISSING` with the command that produces it, so a skipped step
is visible instead of remembered.

| # | Stage | Artifact |
| --- | --- | --- |
| 1 | measured plan | `authoring/plan.json` |
| 2 | build modules, each verified headless | `authoring/rooms`, `authoring/tunnels` |
| 3 | assemble + export (live Blender) | `<name>.mesh-stamp.json`, `markers.json` |
| 4 | clearance sweep | `reports/clearance.json` |
| 5 | offline DC proof | `reports/dc-bake.json`, `authoring/dc-derived/*.gltf` |
| 6 | import through **Blender to DC** | `assets/volumes/<ns>/*.json` (editable) |
| 7 | **merged bake** | `assets/models/<ns>/*.gltf` (what ships) |
| 8 | scene build | the baked scene, and a `-volumes` scene for editing |
| 9 | connectivity gate | `reports/engine/connectivity.json` |
| 10 | doorway gate | `reports/engine/doorways.json` |
| 11 | **follow simulation** | `reports/engine/follow-sim.json` |
| 12 | engine run | `reports/engine/walk/probe.json` |

**7 — the merged bake is not optional.** A scene that instantiates `kind: "csg"`
volumes re-runs dual contouring on every page load: Gloomvein Hold's 71.5 M cells
cost 13 minutes of frozen tab and a ~4 GB heap, against 12 seconds and 738 MB
once baked (8.4 M triangles down to 1.7 M through the exact coplanar merge). Ship
the baked models; keep the volumes beside them as the editable source, exactly as
`faultline-reliquary` and `astra-buried-monastery` do. Never verify a scene in a
browser launched with a raised heap — that proves the harness, not the dungeon.

**11 — simulate the follow before paying for a run.** A route being *walkable* is
not the same as a route being *followable*: the capsule advances to the next
waypoint as soon as it is within its arrival radius, so the arrival radius is how
far it may cut a corner, and a character controller slides along whatever it hits.
Four traversal runs died to that gap before the simulation existed, each costing a
full extraction.

Three facts about this geometry that cost real time, and are worth assuming true
of any Blender-authored dungeon:

- **Every opening cut with `arch=True` loses headroom toward its jambs** — one
  measured 3.56 m on centreline and 1.43 m only 1.4 m off it. Enter and leave a
  doorway along its own axis, then turn.
- **A tunnel's polyline is a guide, not a lane.** One of them was a covered water
  conduit with 0.10 m of clearance over its bed; the walkable lane was the ledge
  beside it. Solve tunnels mouth to mouth and let the router pick the line.
- **A lane sweep proves a doorway; a flood fill proves a room.** `clearance.py`
  reported zero offenders while a room's own collapse had walled it off from its
  north doorway.

Finally, the merge and the audit that grades it **must weld positions the same
way**. `mesh-audit.mjs` welds by exact Float32 equality (`quantizedMeshAudit`
keeps the old 0.1 mm behaviour); a `planar-merge` still quantising to 0.1 mm
invents edges shared by four triangles wherever solids coincide more finely than
that, fails its own manifold gate with no region it can demote, and silently
hands back the input unmerged.

**12 — clear height is measured from the FLOOR UNDER the opening, never from the
datum.** `dwarf-house` passed every clearance gate and then refused to let the
capsule into its sleeping alcove. The alcove arch springs at z 1.70 and crowns at
2.90, which the gate recorded as a 2.90 m opening — but the four steps that climb
into the alcove rise to 0.96 *inside that same arch*, so the real headroom under
the crown is 1.94 m, and a 1.8 m capsule cannot clear the springing line either
side of centre. The arch gate measured the arch's SHAPE (residual, crown,
monotonicity) and the room gate measured floor-to-ceiling elsewhere; nothing
measured soffit-minus-floor at each sample under the opening itself.

The rule, and what a clearance check has to do to enforce it:

- For every opening, sample across its full width; at each sample take the
  floor height **directly beneath that sample** and the soffit above it, and
  gate on the difference. A ramp, stair or raised platform passing under an
  opening is the case that breaks a datum-relative check.
- Verticality budget, restated: passages, doorways and arches clear **2.6 m
  above their own floor at every point across the width**, and rooms clear 3 m.
  An opening whose floor rises must have its head raised by the same amount, or
  the rise must be moved out from under it.
