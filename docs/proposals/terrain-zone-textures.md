# PROPOSAL: Zone ground textures

**Status: BUILT 2026-10-02 (see "Status" at the end).** Written 2026-10-01. Goal: per-zone and per-town ground with one terrain material.

## 1. The black array path: cause and status

**Cause (reproduced and proven): the mesher, not the array path.**
`marching-cubes.ts:124` and `dual-contouring.ts:351` compute per-vertex
attributes into a fixed `new Float32Array(16)`, but `mesh.ts` asks for
`surfaceCount + 3` (splat + tint). Up to 13 surfaces fit. At 14+ the tint writes
are silently dropped and read back `undefined`, so `color` is NaN on every
vertex and `tintByVertexColor` turns the ground black, with no warning.

Headless runs (scratch world from `combat-field`, `mmo/*` tiles): at 13 surfaces the
ground is textured. At 16 the array is packed and wired, but every vertex has a
NaN tint and the ground is black. With the scratch sized to the stream width
(patch then **reverted**, since the mesher is out of scope) the tint reads
`1,1,1` and the ground is textured near and far. The earlier "no texture nodes"
note did not reproduce; it was most likely a stale build.

**Fixed (2026-10-01, owner-approved):** both meshers now size the scratch to the stream width; `test/voxel-wide-palette.test.ts` meshes a 16-surface field (mc and dc) and fails without the fix.

**Fixed in the array path (`terrain-splat.ts`):** the packer resampled tiles
through a canvas with bilinear smoothing on. That blurred 128 px PSX tiles when
they were upscaled to the array size and drew a seam line at every tile repeat.
Smoothing is now turned off when `filter` is `"nearest"`. Verified by a headless close-up; render
tests and typecheck pass.

**Also fixed:** the per-map path fails at 12 maps (17 sampled textures measured), so `SPLAT_ARRAY_THRESHOLD` is now 11 and a 12-surface palette packs (`test/terrain-splat-threshold.test.ts`).

## 2. Recommended model: biome sets + zone overrides, 4 indexed layers per vertex

- **One world texture array** holds every ground tile: the shared base,
  biome-specific tiles, and zone overrides.
- **Biomes** weight over that palette as they do today. A biome-specific texture
  is just another palette entry.
- **Zones** (recipe `regions`) override up to four **roles**: `road`, `paving`,
  `cliff` and `accent`. Surfaces are tagged with a role. A zone override replaces
  the layer that fills a role; it does not add a layer.
- **Mesher output:** the mesher already computes the dense weight vector. It then
  reduces it to the **top 4 layers per vertex** and emits two attributes,
  `splatIndex` (4 layer ids) and `splatWeight` (4 weights). That stays two
  attributes however deep the palette is (today it is ceil(N/4)). The indices are
  `flat` varyings, so the three vertices of a triangle must carry the same ordered
  set. The mesher builds the union per triangle, keeps the heaviest 4 in sorted
  order, and duplicates vertices only where neighbouring sets differ. Dropped
  weight moves to the same-role layer, so it fades instead of popping.

**How many textures:** about 12 shared, 8 biome-specific and 4 roles × about 8
zone looks (towns of one culture share their cobble): **about 30–40 layers**.

| alternative | why not |
| --- | --- |
| Dense weights, bigger palette (today) | ceil(N/4) attributes and 3N fetches. At 32 layers it hits the attribute and inter-stage limits. |
| Separate material per zone | More pipelines (performance-lessons §1), it splits HLOD merges, and borders become a hard line. |
| Fixed semantic slots + per-cell zone look | Interpolation-safe with no duplication, but biome variety is capped at the slot count. This is the fallback if duplication measures badly. |

## 3. Borders

Biome sets already blend over the climate-zone border (`zones.border`, 220 m)
and its edge noise, so nothing changes there. A zone override is weighted by
**region membership**: a smoothstep of the signed distance to the region
polygon, jittered by the existing `climate.edge` noise so the transition does
not follow a clean offset curve. Across the band, a role's weight is split
between zone A's layer and zone B's layer, so a road turns from dirt to cobble
over the band.

- **Open ground:** wide band, about 150 m.
- **Ridge:** 20–40 m on the crest, which hides the change.
- **River:** river plus banks; the bed and bank paint runs on top and hides the join.
- **Coast:** one side is sea, so nothing blends; the shore belongs to the land zone.

## 4. Distance

Far-ring and HLOD proxies are meshed **per cell** at a coarser lattice
(`hlodVoxelCoarsen`) and then merged. They run the same top-4 reduction, so they
carry the same two attributes and merge cleanly. Blends get softer; a 45 m town pad is
about 6 far-tier vertices across, which is enough.

Three generates mips **per array layer**, with no bleeding between layers, so
the far ground converges to each tile's average colour. **No per-layer average
colour is needed** unless a future flat-colour far material is measured to be
worth it.

## 5. Cost

| | fetches/pixel | bindings | weight bytes/vertex |
| --- | --- | --- | --- |
| today, 11 per-map | 33 | 11 | 48 (3 × vec4) |
| dense array, 16 | 48 | 1 | 64 |
| indexed top-4 | **12** | 1 | 8–20 + duplication |

**Array memory:** about 87 KB per layer at 128² RGBA8 with mips, so 40 layers
take about 3.5 MB at 128², about 14 MB at 256² and about 56 MB at 512². Today's
packer upsamples every tile to the largest one present (one 512² cliff makes all
the others 512²), so tile size has to be one decision.

**Before claiming it is free** (per `docs/performance-lessons.md`: profile first,
read p50/p95 rather than fps, and check draws and triangles):
`tools/perf-probe.mjs` on a published build, comparing today's 11 per-map layers
against indexed top-4 using the same tiles.

Views: player height across a town into a zone border (the fragment-heavy
case), `rotate` at a river border, and `walk` 1 km so the far ring streams.
Record frame p50/p95, `render` self and off-loop time, draw calls (must not
change), resident vertex memory with duplication growth, and `worldgen stats`
mesh ms/cell.

## 6. Town paving

Paving should be **a terrain layer painted by the town stage**. Streets are road
polylines with `surface: "cobble"`, and the pad gets a `paving` role with
noise-perturbed verges. That machinery already exists in `paintRoads`.

It follows terraces and seams exactly, costs no draw calls, streams and HLODs
for free, and blends at its edges.

**Decals** are for hero details only (a mosaic, a well surround or a drain). Each
one is a draw, it is projected per chunk, it can z-fight, and it has no HLOD.

**Mesh paving** (kerbs, steps, raised plazas) belongs to the building kit, only
where the geometry actually differs.

**Limit:** the vertex spacing is about 2 m, so a painted edge is about 2 m soft.
Streets 3 m and wider read well. A 1.5 m alley needs kit kerb meshes or edge
decals.

## 7. Build steps

1. Done: mesher scratch fix and threshold 11.
3. **S:** cobble streets through the existing road paint in `worldgen towns`, on
   the dense array path (up to 16).
4. **M:** surface roles plus `regions[].ground` overrides, the membership blend,
   and a lint check that each override names a palette surface.
5. **L:** indexed top-4 emission: mesher reduction, triangle-consistent sets, the
   new attributes, shader depth-from-varying, and the volumes (csg) path.
6. **M:** packer changes: one authored tile size, no upsampling, and the average
   colour per layer.
7. **M:** the measurement plan above. Only then raise `MAX_SURFACES`.
8. **S:** update `docs/voxel-worlds.md` §15/§21.

## Owner decisions

- Terrain tile size: 128² (PSX, smallest) or 256².
- Zone override roles: road, paving, cliff and accent, or fewer.
- Default border band on open ground: about 150 m, or something else.
- Town cobble now (steps 1–3) or wait for zone overrides (step 4).
- Maximum layers per vertex: 4, or 3 (cheaper but more popping).

## Status (2026-10-02)

Built: recipe `surfaces[].role`, `regions[].ground`, `roads[].role`, `zoneGround`, `splat: "indexed"`
(core `zone-ground.ts`, `splat-top4.ts`, field remap, mesher reduction, merge); material `source: "indexed"`
(one texture array, 4 layers/fragment); `worldgen zone-textures` + status row; palettes in
`authoring/zonegen/palettes/<id>.json`; `town-ground paving`. Applied to proving zone-5 (17 surfaces, indexed;
Tidewell and Ledgecroft streets `role: "paving"`). Tests: `packages/core/test/zone-ground.test.ts`,
`packages/render/test/terrain-splat-indexed.test.ts`.

Remaining (stopped at the token budget):
- After-perf: `node tools/town-perf.mjs --scene proving --port 5404` x3 (before: frame p50 22.7 / 20.5 / 19.1 ms,
  545-548 draws, same spawn camera in Tidewell). Not yet re-run.
- Pictures: Tidewell cobble street, road, cliff strata and the far view were shot and read correctly. The fen
  view and the zone-4/zone-5 border need better framing: the border follows a river along its whole length, so
  a land-to-land blend picture was not found. The 150 m blend is proven numerically in the tests, not in a picture.
- The packer resamples every slice to 512² because of the cliff tiles (about 24 MB with mips for 17 layers).
- Not measured: vertex duplication from top-4 sets or mesh ms/cell (`worldgen stats`).
