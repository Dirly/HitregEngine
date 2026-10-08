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
