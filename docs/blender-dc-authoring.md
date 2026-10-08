# Dungeon rooms are authored in Blender, imported into DC

Decision (2026-09-15, Derek): hand-crafted dungeon rooms and tunnels are modeled in
Blender through the Blender MCP server and brought into the engine by the
`tools/mesh-dc` bridge ("Blender to DC"). The voxel construction tools
(`dc-construction`, `dc-carving`, `dc-arch-fit`) stay for carving, stairs, portals and
cave fitting inside an imported stamp; they are no longer the first tool for a room.
Reason: rooms must feel man-made and purposeful, and modeling that in Blender is faster
and more legible than composing CSG recipes. DC removes internal coincident faces
within a shared field. Independently extracted groups are separate meshes;
importing them together does not union them.

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
- Solids may overlap or touch; inside one `dc_group` they union in the field.
  Between groups, place joins inside solid stone and check the assembled surfaces.
  A lap along an exposed coplanar wall or floor still produces overlapping faces
  and can z-fight. Union pieces sharing exposed surfaces in one field, or partition
  at buried interfaces. Do not hide duplicate surfaces with depth bias.
- One `dc_group` per room, storey or tunnel. Keep each under 15 M cells at the intended
  voxel size (0.12 m blockout, 0.06 m for inspected stair detail).
- Audit both each extracted mesh and the assembled groups. Per-mesh manifold
  checks cannot detect intersections or coincident faces between separate models.
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

## Dungeon room kit (plan in, architecture out)

`tools/dungeon-room-kit` builds the architecture of a room from a short description instead of a hand-scripted
box assembly: per room, an outline (or x/y ranges), floor, height, a STYLE and its doorways. Rules then place,
from data, pilasters with bases and capitals on every bay, dressed arched doorways (round, segmental, pointed or
flat; jambs, imposts, a voussoir ring with a proud keystone), barrel vaults with transverse ribs or ribbed and beamed
ceilings, plinth / string-course / frieze / coping runs (the carved DC library's `wall-plain`, 9-sliced to each
wall run), blind niches, repeating panelled wainscot, aisled arcades of 9-sliced octagonal piers, coped daises,
pitched timber roof bays, or for natural rooms a shaped cave (mitred rock walls, `cave_ceiling` dome, lofted rock
pillars, stalactites, stalagmites, a rock shelf) with every rock piece tagged for role noise. Output is the usual
closed solids, one `dc_group` per room, named `<room>.<kind>.<n>` so the `recipe` gate counts the detail.

```
node tools/dungeon-room-kit/roomkit.mjs all authoring/rooms.json --out reports/kit
```

runs Blender headless, exports the stamp (noise table embedded with doorway boxes and walk-lane capsules from the
plan's `route`), DC-bakes and audits each room and prints built detail per room; import, merged bake, split-floor
and the later stages follow as for any stamp. A dungeon with set pieces calls `blender_build.build_rooms(...)` from
its own `build.py` and adds them to the same groups. Styles are data (`tools/dungeon-room-kit/styles`); pick or
extend one per dungeon: shared rules, never a shared set piece. Parts, styles and limits:
`tools/dungeon-room-kit/README.md`. Proof and numbers: `projects-archive/roomkit-proof/NOTES.md`; stairs: `projects/roomkit-stairs/NOTES.md`.

## Stair ceilings

- A stair's ceiling follows the flight: build it from the pitch (nosing) line plus a constant headroom, never from the
  landing levels. A flat ceiling over a rise R costs R of headroom at the top of the flight; a roof stepped once per
  metre or two reads as boxes and pinches by the step height. Room kit: `"kind": "stair"` (README there).
- Fillet the two kinks (flat landing to flight, flight to landing) over ~1.6 m so the vault meets each landing's level
  ceiling and the neighbour's door head without a step; a moving average of the pitch line plus headroom does it, and
  only lowers the top kink by ~window x slope / 8 (under 0.1 m at a 0.2/0.32 pitch).
- For a round raking barrel the clear at the body edge (width/2 - 0.45 m) is the binding number, not the crown: a
  2.8 m barrel at 3.6 m crown headroom gives 2.66 m at the lane edge above the nosings.
- Measure clear height against the BAKE: cast down to the walking surface, then up to the first downward face, every
  0.1 m along the line and at both lane edges (`quality.mjs stairs`). Detrend by the pitch line before looking for
  steps, and max-filter narrow drops (ribs, arch rings < 0.8 m) out first, or every transverse rib reads as a stepped
  roof. A natural roof is judged on its crown: at a 2.6 m tunnel's lane edges the ray grazes the noised shoulder.
- Calibration (2026-10-06, nothing changed): fieldfast-barrow and gnawspur-deeps stairs have roofs stepped 0.4-1.0 m
  (bands 0.5-1.4 m); fieldfast-hall's ceilings step once per riser (0.2 m, band 0.2 m: headroom fine, soffit stepped);
  rime-hall's giant ramps have bands of 1-3 m at 9-13 m clear and its melt-crawl lane edges reach 2.4 m.

## DC role noise

Owner ruling (2026-10-05): natural walls and ceilings are ROUGH geometry; built
masonry, timber, trim and stairs stay CRISP. Noise is applied by the engine
(csg node `noise`, `packages/core/src/voxel/csg.ts`) on import; the Blender
source stays clean and editable. It is GEOMETRY: the field is displaced, so
the extracted vertices move and silhouettes change. It is not texture or
normal-map noise.

**Role noise is on by default for every new dungeon with natural rooms**
(caves, burrows, gnawed or ice passages). The zone-3 dungeons came out flat
because nothing asked for it. A builder turns it off only for a dungeon with no
natural surfaces, and records that decision in the plan.

Two scales, two tools. The LARGE shape (lobes, leaning walls, domed crowns,
wavelengths of metres) is modelled in Blender. `projects/noise-lab/NOTES.md`
(2026-09-16) is the test bed for that. Its findings carry over: use few
control points with a large amplitude, because many small jitters make
spikes; displace outward only, so a lane width becomes a guaranteed minimum;
pin the displacement to zero at connectors, so openings land on plan-accurate
wall; overshoot internal datums so no sub-voxel wafers form; lap joins by at
least two voxels. Role noise is the SURFACE scale on top of that: 0.25-0.55 m
of relief at a 2-2.6 m feature size. `grow` and the protection zones are the
engine-side equivalents of noise-lab's outward-only and pinned-at-connector
rules.

**How a dungeon enables it**

1. Tag natural solids in the build script with `dc_noise` (an object custom
   property): `rock-wall`, `rock-roof`, `burrow-roof`, `tread`, ... Untagged
   solids are keyed by their palette role (`basalt`, `silt`, ...). The shared
   primitives below take `noise=` directly; `shapes.noise_tag(obj, key)` tags
   anything else.
2. Write the table as project data, `authoring/noise.json`
   (`{version: 1, roles: {key: {amount, scale, octaves?, floor?} | null}}`);
   defaults are in `docs/world-standards/dungeons.md`. `null` is crisp.
   `floor: true` caps the amount at 6 cm. Every entry grows the solid
   outward only (`grow`), so a 0.8 m wall cannot open under 0.45 m of noise.
3. Add protection zones (noise fades to zero there): `routeProtect(stamp,
   route)` lays capsules along the walk lane, following the stamp's own floors
   by continuity from the entrance; `openingProtect(floorCentre, width, height)`
   boxes each doorway. Both are in `tools/mesh-dc/noise.mjs`. The **floor
   band** needs no zones: every noised role except `floor: true` roles fades
   to zero from 0.2 m under to 0.6 m over each walkable floor and is back to
   full 0.4 m higher (`BAND_DEFAULTS`). The floors are the stamp's own exposed
   up-facing faces (`floorGrid`: normal y >= 0.6 with >= 1 m of headroom, on a
   0.5 m grid), dilated past each floor edge so wall feet are covered. Wall
   feet then meet the floor clean and vertical, which keeps the floor
   dressable. Override per table (`"band": {above, below, fade, cell,
   minClear}`, or `null` for off) or per role (`band: {...}` / `band: false`).
   The csg form is a `protect` entry `{ floors: {origin, cell, columns, rows,
   spans}, above, below, fade }`.
4. Embed the resolved table in the mesh-stamp (`export_mesh_stamp(noise=...)`
   or a post-export step, see `projects/gnawspur-rough/authoring/noise-protect.mjs`).
   `convertMeshStamp` and the registered **Blender to DC** tool then split each
   group into one crisp mesh node plus one node per noised key; the volume
   report lists `noiseNodes` per group.
5. After the exact planar merge, decimate noised volumes with
   `tools/mesh-dc/decimate.mjs` (`decimateRough`, absolute 2 cm error bound),
   then audit as before. Rerun walk, doorway and view gates.

A solid touching any crisp role stays crisp (only ~1% of solids mix roles).
Crisp nodes keep exact source normals; noised nodes get gradient normals. A
volume made only of mesh nodes keeps block culling with a margin of twice the
largest amount, and far hard-union mesh nodes are skipped exactly per sample,
so the per-role split costs little on its own.

**Shaped natural volumes** — `tools/mesh-dc/shapes_blender.py` (shared
primitives; set-piece builders stay per dungeon). Import it with
`sys.path.insert(0, "<engine>/tools/mesh-dc")`.

- `cave_ceiling(name, outline, z_spring, rise, thickness, ...)` — an uneven
  domed roof over a star-shaped footprint, springing at `z_spring` on the
  outline and never dipping below it (door heads and planned clearances stay
  true). `lap` buries the rim in the walls; `crown=(x, y)` moves the high point.
  It replaces a flat `poly_prism` roof.
- `cave_tunnel(name, path, width, height, thickness, ...)` — an irregular arch
  section lofted along floor-centre points. Walls only push outward and the
  crown only rises, so the lane is never narrower than `width * (1 - width_wander)`
  or lower than `height`. Lay the floor or treads under its buried feet.
- `ring_wall(name, outline, thickness, z0, z1, ...)` — one closed wall band
  around a footprint (cut doors with the usual boolean helpers).
- `cave_section`, `offset_outline` and `noise_tag` are the building blocks.

Box "rock lumps" are no longer needed; noise on the wall does that job.

### Lessons (DC role noise)

Proved on `projects/gnawspur-rough` (a copy of gnawspur-deeps, 2026-10-06). The
copy has the gnawed half noised and domed, the masonry half crisp, and the
granary moved to its own group.

- **Ship cost is triangles, not extraction.** A noised surface has no coplanar
  regions, so the exact planar merge does nothing to it (bolthole went from
  54,760 to 52,516). `decimate.mjs` at 2 cm gets ~5x back. Whole dungeon:
  0.49 M shipped triangles crisp became 0.85 M noised (+73%). Raw DC went from
  4.74 M to 5.45 M. The total bake went from 737 s to 1,379 s on the same
  machine (different sessions).
- **Splitting a group into role nodes doubles extraction by itself**, because
  every mesh node answers every sample. The exact far-node skip, the bounded
  `distance(x, y, z, bound)` query, and hoisting `visit` out of the per-sample
  closure in `triangle-mesh.ts` (~10% of all extraction under tsx, crisp
  imports included) recover part of it. Noise itself (3 octaves) is ~10%.
- **meshopt collapses can pinch two sheets onto one edge and leave
  zero-area caps.** `decimateRough` locks pinched vertices (growing rings)
  and re-simplifies, and edge-flips caps. Gate the result with `meshAudit`
  anyway; the bake falls back to the exact merge if it fails.
- **Raw Perlin rarely leaves +-0.55**, so `grow` stretches it. Unstretched, the
  relief was ~0.3 x amount and the walls read as straight.
- **Noise beat the dress mapper; the floor band fixes most of it.** Without
  the band, wall feet grown onto the floor read as stair cells in `tools/dress`
  socket maps, and dressing plans failed. With the default band, the live
  dungeon's 18 crisp plans re-checked at 14/18 unchanged. The other four needed
  a one-prop nudge, or are geometry (see below). Walls still bulge at the
  mapper's 1.0 m and 1.7 m wall slices, so a prop pinned tight to a crisp wall
  line can land on a new wall cell. A noised burrow also has no straight wall
  span for a wall-auto torch, which then falls back to the floor, possibly
  mid-lane. After turning noise on, re-run `dressing.mjs maps` and check the
  EXISTING plans before running `dress-fix`, which drops items it cannot place.
  `dressing.mjs plans` rewrites plans from templates, so the fixes are lost.
  Earth floors at <= 3 cm still map as floor: their slopes stay below the tread
  band. The sockets tool also now treats any sloped face within 6 cm of the
  floor as floor relief (`--floor-relief`).
- **Untagged roles leak.** `basalt` box lumps in built rooms were roughened
  until the table set `basalt: null`. Noise only what is tagged natural.
- **Domed roofs raise group bounds.** nest went over the 15 M cell cap until
  the granary got its own group and the ship-hull hall a lower rise (0.9 m).
- Walk gate after noise: 177/177 legs, 27/27 doorways >= 2.6 m, 850.34 m
  (live: 850.36 m). The protection zones (233 lane capsules + 27 door boxes)
  did their job.
