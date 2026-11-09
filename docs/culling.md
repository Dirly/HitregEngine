# Culling: behind terrain, too small, interiors

Frustum culling (three's own) drops what is off to the side. Everything else
that is not worth drawing is decided by the culling system
(`packages/render/src/culling.ts`, horizon math in `horizon.ts`), once per
frame just before render, against the camera actually drawing.

## What gets culled, and how

| test | applies to | result |
| --- | --- | --- |
| **behind terrain** | streamed render-only cells, HLOD parts, POIs, `culling` entities | main pass skips it; **shadows keep it** |
| **too small on screen** | `culling.minScreenPx` subtrees; every instanced prop (engine default 1.5 px) | gone from every pass |
| **interior** | `culling.interior` subtrees | drawn only within `reveal` m of its bounds; never in HLOD bakes |
| **over unloaded ground** | base-scene units in a streamed world (POIs, dressings, each batch cell's merged buildings) | gone from every pass while the cell under its centre has no drawn terrain |

A **unit** is a subtree hidden whole. Units come from:

- each streamed cell that is render-only (the fullRender ring; simulation
  cells hold moving things and are not units),
- each HLOD part (merged far terrain + impostors),
- every entity tagged `poi` (every generated POI root, with or without the
  component) and every entity with a `culling` component, in a streamed cell
  or the base scene. They nest: a POI inside a hidden cell is hidden with it;
  a `culling` child of a POI hides on its own tests too.

A unit's static meshes are batched apart from the rest of its cell
(`batchStaticMeshes`' `groupOf`), and its instanced props in the world prop
pool are hidden with it, so a hidden POI costs no draw and no vertices.

## Over unloaded ground

Base-scene content (towns, place-build structures, stairs, POIs, dressings) is built at scene load, but the terrain
it stands on streams in around the focus. Without a gate it drew at any distance — towns and stairs hanging in the
haze kilometres off, over cells that had not streamed in (owner, 2026-10-21). Every base-scene unit is `grounded`:
hidden while `ChunkManager.coversGround` says no cell (full, HLOD or far proxy) is resident under the centre of its
bounds. That includes the static batch's `cell:x,z` groups, where poi-only roots' meshes merge (they were in no
unit before). Meshes wider than a batch cell (an ocean plane) merge into `wide` and are never gated. Content that
streams with its cell, and HLOD parts (their own terrain), need no gate.

Cost: none per frame. Units are re-judged only when `ChunkManager.groundVersion` moves (a cell or HLOD part
published or dropped). Stats HUD: `N unloaded ground`. A/B: `__hitreg.culling.groundGate = false`.
Probe: `tools/far-draw-probe.mts --scene <world>` lists what the camera draws over unloaded ground from fixed
spots, gate off vs on, with pictures; it exits 1 when anything is left with the gate on.

## Places stream (built near the focus, not at load)

Culling hides; it does not save the BUILD. Every parentless root tagged `poi`, `poi:<id>` (dressing groups) or
`town:<id>` — or carrying a `placeStream` component — is left out of the client's base build and built when the focus
(the player in play, the orbit target in the editor) comes within `placeStream.distance` (default 300 m) of its
footprint; it is freed past `distance + keepPadding` (default 100 m), so walking a boundary never rebuilds it.
`landmark` subtrees inside a place stay built (re-rooted at their world transform) and carry the far view; a portal
under a landmark keeps working from anywhere. Selecting a place's entity in the editor builds it and keeps it built.

An explicit `placeStream` on a nested root makes it independently resident. A furnished room can therefore stay
unbuilt while its town shell is loaded: hiding a room alone saves draws, whereas residency also defers model
fetch/decode, render objects and visual effects. The client detaches the room at its world transform; the authored
parent tree and authoritative physics remain intact. Parent edits also update detached rooms. Nested `always`
stays with its enclosing place. Nested tags without an explicit component keep their old inheritance.

`dress apply` gives indoor room roots a 32 m build distance, 48 m keep band and 2 m footprint padding, ahead of the
default 12 m culling reveal. Large open-door sightlines need a measured wider reveal and a build distance at least
20 m farther out. Bell Strand's chapel keeps its mural visible to 80 m and its bulk/rays to 50 m; their build distances
are 100 m/70 m. This is room residency plus distance culling, not wall occlusion. Exterior yards keep normal clutter
grouping. `footprintPadding` defaults to 16 m for existing places; room units use the smaller explicit padding.

- Planning is pure and headless (`planPlaceStreaming`, packages/core/src/place-stream.ts); residency is
  `PlaceStreamer` (apps/playground/src/place-streamer.ts); a built place batches, gates and culls like the base scene
  (`batchPlacedContent` in main.ts) and is precompiled on its own.
- Untouched: the scene doc, `lastExpanded` (queries, portal anchors, quests), the play sim (built from the whole doc,
  statics streamed around bodies on its own) and every server — gameplay authority never streams by a camera.
- `placeStream: { mode: "always" }` keeps a root built at load; `distance` widens or narrows one place.
- A/B: `?places=all` (everything built at load, as before) and `?places=none` (no place ever built).
  `__hitreg.placeStreamer.stats` → places, loaded, entities, loads, unloads, lastBuildMs.

## Props hide by size (no hand tagging)

Out of doors nothing appears nearer than `OUTDOOR_PROP_MIN_REVEAL` (100 m, `propRevealIndex`): a porch has no wall to hide a pop behind. Size still decides a prop's shadow, and a numeric `dressing.hideDistance` stands.

Every placed prop whose catalogue `dressing` declares a `size` hides by DISTANCE: `propHideDistance` takes ~45 m per
metre of its largest extent (scaled by `category`: tableware/documents nearer, sacred/street farther) snapped up to a
bucket (30 / 60 / 100 / 160 m); over 3.5 m it never hides (it is the silhouette). The batcher merges a place's (and
the base scene's) hiding props per bucket per 64 m cell and registers each group as a grounded unit drawn only within
its distance (`interior` + `reveal`). Overrides: `dressing.hideDistance` (metres or `"never"`) on the prop's
catalogue entry; a `culling` component on the placed prop itself; anything under a `landmark` never auto-hides. A
dressing room's authored `culling` takes precedence over the generic distance bucket, so its furniture remains
batched by room and obeys the room's reveal distance, including shadow passes. Enclosing fallback gates must not
claim renderables under an already registered room root, including meshes that arrive asynchronously.

Room-root cull verdicts also gate particle simulation, ambient VFX and authored light candidates. Culling leaves
authored `visible` values alone; a shared hierarchy visibility check carries the verdict to effects whose rendered
objects live outside their source room. Pooled point-light slots remain present with stable identities; hidden
sources stop competing for them, fading out (and revealed ones in) over `LIGHT_PRESENCE_FADE_S` while ranking behind
lit ones, so a room culled or revealed next door never pops the lights around you. This is distance/terrain culling,
not building-wall occlusion or room unloading.

A light under a `culling.interior` room is held to its building (`light-confine.ts`): core `interiorEnclosures` names
the room's parent structure, and the light's slot, pool, halo and fog glow light nothing outside that structure's
yaw-aligned geometry box, floored at the room's lowest furnishing. Point lights have no shadow maps, so without it a
hearth lit the street and the neighbour through the wall. A room root with no parent structure, and interior scenes
(`cullingProfile`), are not confined. A/B: `lightConfine.enabled` (render export).
Window-daylight fixtures on outward-facing window anchors belong to the room behind the pane, so they follow
the same room gate rather than becoming a separate outdoor lighting group (`resolveDressing`).

## Shadow casters

Every shadow caster is drawn again in each sun cascade it falls in, so a town's clutter cost ~3x its main-pass draws
in shadows alone (Bell Strand 2026-11-04: 460 of 758 draws). The host rules two groups out of every shadow pass,
whatever `mesh.castShadow` says (core `shadowlessEntities`, read through the `shadowless` build option, so plain,
merged, instanced and pooled copies all obey):
- **interior furnishings**: anything under a `culling.interior` unit. The house shell already shades its interior.
  Not in an interior scene (a `cullingProfile`, a dungeon), where the room lights are all there is.
- **small props**: a hide distance of `PROP_SHADOW_MIN_HIDE` (30 m) or less, the tableware/small-pot bucket.

What still casts is merged: a shadow pass draws everything with one override material, so `batchStaticMeshes` puts each
culling unit's plain casters (and its loose static meshes) into one shadow-only mesh on `OCCLUDED_LAYER`, whatever their
materials. Cutouts and wind plants keep their own shadows. `?shadowMerge=0` is the A/B.

## Authoring a POI or a building

- The root needs nothing: `poi` tag = a unit that hides behind terrain.
- Put **detail** (clutter, crates, carts, small camp props, loose rocks)
  under a child with `culling: { minScreenPx: 6 }` or so. The landmark
  (tower, statue, walls, big tree) stays outside it and reads from afar; the
  detail arrives once it would cover that many rendered pixels.
- Put **furnishings and inner rooms** under a child with
  `culling: { interior: true, reveal: 12 }` — the shell outside it. Raise
  `reveal` for wide doors or windows you can see into from further out.
- `occlusion: false` only for what must never pop behind a ridge — a beacon.
- **Landmarks through fog**: put `landmark: { fogReach: 700, silhouette: 0.6 }` on the landmark's own root (the
  shell, not the POI root with its clutter); a world `landmark` operator takes the same object as `fog` (placed on
  its streamed entity, outside the bake digest). It draws with its own fog curve — never more fog than the ground, an even
  haze reaching opaque at `fogReach`, fogging toward a darker silhouette tone — while terrain, props and plants keep
  the zone fog (`packages/render/src/landmark-fog.ts`). It is its own culling unit, never hidden by size, carried
  into HLOD/far bakes as real geometry with the same curve (never an impostor, even with `mesh.hlod: false`); behind
  terrain still hides it, and a streamed landmark ends at the world's `farTerrain` ring. Cost: one fog variant per
  (material, reach, silhouette), no extra draws.

Pixels are **render** pixels, after pixelation: a 480-line frame drops a
crate at a shorter distance than native 1440p, because it could not show it.

## How the horizon test works (and what it cannot see)

Every drawn voxel terrain mesh (near cells at full resolution, HLOD parts at
their coarse one) stamps the LOWEST height of each 16 m square into
`HorizonOccluderMap`. Per world azimuth bin (1024 around the circle) the
culler marches out from the eye keeping the steepest "ground I have to look
over" slope; a box whose top stays under it in every bin it spans, at every
distance nearer than itself, is hidden. Using the lowest ground and the most
pessimistic distance makes it conservative: the test in
`packages/render/test/horizon-culling.test.ts` ray-marches every box it hides
over random ridged terrain and requires every point of it to be blocked.

Only terrain occludes. Buildings, dungeon rooms, cliffs made of props and
DC stamps do not; neither does a notch narrower than a square. Occlusion
waits for a unit to clear the horizon by a small slope margin before hiding
it, and shows it again the moment its top reaches the (conservative, lowered)
horizon — before it is really visible, so nothing pops.

Shadows: a unit hidden behind terrain moves to `OCCLUDED_LAYER` (29). The
main camera sees layer 0 only; every shadow camera is given layers 0 and 29
(`SHADOW_CAMERA_LAYERS`, set in `applyShadowSettings` and per cascade). A
tree just behind a crest still throws its shadow over it. Instanced props
share one buffer across passes, so an occluded unit's props are dropped only
past `CullingSystem.shadowDistance` (120 m, the cascades' reach).

## Diagnostics

- A group culled while still in sight shows as the void: the see-through gate (docs/see-through.md) reports it as `culled` with the entity; raise `interiorReveal` past the sight line.

- Stats HUD: `culling: N units · N behind terrain · N small · N interiors ·
  N props · ms`.
- Profiler scope `update/culling`.
- Dev handle: `__hitreg.culling.enabled = false` switches it off live (all
  layers restored); `__hitreg.culling.stats()`.

## Measured (2026-09-30, MMO world, headless Chrome WebGPU, 1600x900)

A/B inside one page session (culling toggled live, medians of 90 frames per
arm), camera at player height 40 m from real POI sites, four headings each:

| world | views | draw calls | triangles | GPU | culling cost |
| --- | --- | --- | --- | --- | --- |
| as generated (no POI prefabs) | 24 | −3% (7455 → 7236) | −2.5% | unchanged | 0.12 ms |
| every POI dressed (house + 20 props + interior) | 20 | −5% (7134 → 6758) | −3.6% | unchanged | 0.18 ms |
| best views (hilly ruin sites) | — | −12 to −16% (486 → 427, 377 → 317) | up to −18% | — | ≤ 0.4 ms |

What that says about where frame time goes, more than about culling:

- The GPU is at 2–4 ms a frame at every spot; frames are 15–30 ms of CPU.
  Culling pays in draw calls and triangles, never in GPU time here.
- At a hilly site the main pass drew 99 HLOD meshes, 41 base-scene meshes,
  18 prop-pool pages, 13 near cells. HLOD blocks are merged per 4x4 / 8x8
  cells to save draws, so one is hidden only when the WHOLE block is behind a
  ridge — the draw-call merge and culling granularity pull against each other.
- A dressed POI inside the full-detail ring (~170 m) hides its interior from
  outside and its clutter past a few dozen metres; beyond the ring it is an
  HLOD silhouette, minus its interior.
- Pixel diff of culled vs unculled frames at the best site: no more change
  than between two culled frames (wind, clouds) — nothing visible is lost.

## Interior scenes (dungeons, instanced interiors)

The furnishing default (`interior: true, reveal: 12`, what `dress apply` gives each room's dressing group) was made
for a house seen from a street. In an instanced dungeon everything is interior, and a giant hall is 50-75 m from door
to far wall: the Rime Hall's dressing appeared 4-68 m AFTER the walker entered the room (owner, 2026-10-06: "walk
halfway through a great hall then everything pops into place").

A scene declares its own distances with ONE `cullingProfile` component (conventionally on its root):

```json
"cullingProfile": { "interiorReveal": 80, "maxMinScreenPx": 0, "occlusion": false }
```

- `interiorReveal` — every `culling.interior` unit reveals at least this far (never lowers a larger `reveal`).
- `maxMinScreenPx` — caps every unit's `minScreenPx` (0: nothing hides by size in short interior sight lines).
- `occlusion: false` — no terrain-horizon test (an instance has no voxel terrain).

`cullRootsOf` applies it (packages/render/src/culling.ts `applyCullingProfile`), so the renderer, chunk cells and
tests see the same settings. Dungeons get it from `tools/dungeon-pipeline/lighting.mts` (`lighting.json`
`cullingProfile`, `interiorReveal: "auto"` = the farthest room-entry-to-dressing distance rounded up to 5 m, >= 30).
The `culling` quality gate walks the plan route and fails a room whose dressing appears more than 2 m after the
walker enters it. Cost: a revealed room is drawn while you are within that distance of it; in the Rime Hall (80 m)
that is a few more dressing groups at once, all already batched per room.
