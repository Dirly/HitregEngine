# Procedural voxel worlds (marching cubes)

**Status:** built and verified in-browser (WebGPU) 2026-09-01; second
generation (continents with a hard edge, zones, hydrology, water at every
level, roads that follow the ground) built and verified 2026-09-02 — **§30 is
the current shape of the generator; §1–§29 are the layers under it and the
lessons that produced them.** Open items are listed at the bottom of §8.

Related: `docs/open-world-streaming-plan.md` (the ring/HLOD machinery this
reuses), `docs/performance-lessons.md` (read before touching perf),
`docs/scene-authoring.md`.

---

## 1. What this is

A world is a **recipe** — one small JSON document under `assets/worlds/` — and
everything else is derived from it: the terrain mesh, the collider, the biome
texturing, the trees, the rivers, the towns, the roads. Nothing is baked to
disk. That is the same rule the rest of the engine follows (ARCHITECTURE.md
§2: JSON is authoring truth, not runtime state), applied to terrain.

Marching cubes rather than a heightmap because the field is genuinely 3D: it
has caves you can walk into, cliffs that undercut, and arches. A heightfield
cannot express any of those, and retrofitting them later means rewriting the
mesher, the collider and the placement solver at once.

The pipeline the recipe is shaped for:

```text
noise field  ->  carve streams  ->  mark towns  ->  carve roads  ->  place POIs  ->  WFC buildings
```

Each stage writes a handful of lines into the recipe's `features` and the
terrain re-derives around them. A river is a polyline with a width and a bed
profile. A town is a disc with a target height. You can read the whole world
in a text editor, diff it in git, and hand-edit any of it.

---

## 2. Files

```text
assets/worlds/<id>.json          the recipe — the world
assets/materials/terrain/<id>.json  the terrain material (splat source "vertex")
assets/scenes/<id>.scene.json    a scene with a `voxelWorld` component
```

A scene opts in with one component:

```json
{ "voxelWorld": { "world": "my-world" } }
```

That is the whole integration. `cellSize` and `resolution` come from the
recipe (the component cannot override them — `resolution` is defined relative
to `cellSize`, so a scene-level override would silently change the voxel size
of the world). The component owns only residency and presentation.

---

## 3. How it streams

Generated cells go through the **existing chunk streamer**, not a parallel
one. `ChunkManager` gained a `ChunkProvider` hook: with one installed, a cell's
document is generated on demand instead of read from a `.chunk.json` file, and
everything downstream is unchanged — residency rings, hysteresis, HLOD
supercell merging, physics attach/detach on the simulation boundary,
instanced-batch disposal. All of that was already debugged against a shipped
game; a second streamer would have meant re-finding every one of those bugs.

A generated cell document is deliberately tiny:

```json
{
  "version": 1,
  "entities": {
    "terrain": {
      "components": {
        "transform": { "position": [0, 0, 0] },
        "mesh": { "source": { "kind": "voxel", "world": "my-world", "cell": [3, -2] } },
        "collider": { "shape": "trimesh" }
      }
    },
    "pine_12_-7": { "components": { "transform": {...}, "prefab": { "prefabId": "trees/pine" } } }
  }
}
```

Four lines of terrain regardless of how many triangles it becomes, and one
line per prop — the collapsed-document rule.

---

## 4. The invariants

These are the things that will break silently if you change the wrong thing,
each with the test that holds it (`packages/core/test/voxel.test.ts`,
`packages/physics/test/voxel-collider.test.ts`).

**One mesh, three consumers.** Render, physics and the placement solver all
call `voxelMesh(source)`, which caches by cell. What you see is what you
collide with is what props snap to — by construction, not convention.

**Two density paths must agree.** `field.density(x,y,z)` derives everything
per call; `field.sampleBlock(...)` precomputes column heights, slopes and the
cave lattice for a whole block. They are two implementations of one field. A
test samples a block both ways and compares every voxel.

**Seams weld exactly.** Neighbouring cells emit identical vertices on their
shared plane, because both evaluate the same global lattice and the vertical
band is snapped to multiples of the voxel step. Normals come from the field
gradient (central differences on the sample lattice), not from
`computeVertexNormals()` — so lighting is continuous across a seam without the
two chunks ever exchanging geometry. Tested for position, normal, and by
dropping physics probes exactly on cell edges and corners.

**The mesh is closed.** The marching-cubes case table is *derived at load*
rather than transcribed (see `voxel/tables.ts`): faces are traced into loops
from the sign pattern, which makes watertightness and outward winding
properties of the construction instead of 4,096 hand-typed integers nobody
will ever re-check. The bottom of each cell's band is forced solid, so a cave
running out through the floor is capped rather than left open. You cannot fall
out of the world.

**Scatter is chunk-independent.** Every candidate is a point on a global
lattice; jitter, species, scale and yaw are pure hashes of its lattice
coordinate. A tree lands in the same spot whichever direction you walked in
from, and there is no seam of doubled or missing trees at a cell edge.

---

## 5. Texturing: how a place decides what it looks like

The recipe declares up to **four surfaces** (`grass`, `sand`, `rock`, `snow`
by default). Biome rules turn (altitude, temperature, moisture, slope) into a
per-vertex `vec4` of weights over those four, and the terrain material blends
them.

Biome rules are **not exclusive**. Each gets a smooth membership from its
windows and the weight vectors are blended by it, so borders are gradients.
Two things follow that are worth knowing:

- **Cover the whole height range.** Where no rule matches, the field falls back
  to the heaviest rule. A gap does not fail loudly; it renders somewhere
  absurd. (The seabed rule exists because without it every ocean floor
  rendered as alpine snow with a hard edge at the waterline.)
- **`heightBlend` is in metres; `blend` is in 0..1 units.** They are separate
  fields for exactly that reason.

Textures are sampled **triplanar**, per layer, at each layer's own world
scale. Not a style choice: marching-cubes terrain has caves and overhangs and
has no UV unwrap to sample with. It also keeps a texture continuous across a
chunk seam for free, since world-space projection knows nothing about cells.

To add textures: drop images in assets/textures/, set map / normalMap / uvScale
on the recipe SURFACES, then run worldgen material <world> to re-emit the
material from them. Two things worth knowing:

- A textured layer is emitted with a WHITE tint so the texture reads as
  painted. The surface colour stays in the recipe as the fallback and as what
  the overview map draws with. Multiplying a green tint over an already-green
  grass texture is the usual reason textured terrain comes out oversaturated.
- FOUR channels is a hard cap (schema and shader). Extra surfaces need the cap
  raised, and each one costs 3 more fragment fetches because the sampling is
  triplanar.

Cost, stated honestly: N textured layers is 3N fragment fetches (triplanar),
doubling with normal maps. Four layers with albedo and normals is 24 fetches.
Fine for ground; never point this material at anything instanced.

---

## 6. The worldgen CLI

```bash
pnpm -F playground worldgen init <world> --project <name> --scene   # continents + zones (--classic for the old endless noise)
pnpm -F playground worldgen continents <world> # re-lay the landmasses, islands, land floor, limit
pnpm -F playground worldgen rivers <world>   # HYDROLOGY: fill, flow, channels, lakes, waterfalls
pnpm -F playground worldgen towns  <world>   # flat, low, water-adjacent pads
pnpm -F playground worldgen roads  <world>   # least-cost routes graded on the dense route, cut-biased
pnpm -F playground worldgen trails <world>   # footpaths from the roads up to the peaks
pnpm -F playground worldgen pois   <world>   # peaks, cliffs, coves
pnpm -F playground worldgen caves  <world>   # find mouths, MEASURE fit, carve them open
pnpm -F playground worldgen map    <world>   # PNG overview
pnpm -F playground worldgen stats  <world>   # tris/cell, ms/cell, biome mix
pnpm -F playground worldgen all    <world>   # everything, in order
```

Two of these deserve a note.

**`map`** renders a PNG of the whole world — biomes, hillshade, water, rivers,
roads, towns, POIs. A world you cannot look at is a world you cannot tune, and
opening the browser to ask "did the rivers reach the sea" is slow. It is also
how an agent checks its own work: generate the file, read it back.

**`stats`** meshes real cells and reports per-cell triangle count and
milliseconds, after a discarded warm-up round (the first few cells pay JIT for
the whole noise stack and read ~50% slow, which would make every number a lie
about what the running game pays). Per-cell build time is what a chunk
crossing pays in one synchronous lump, so this is the number that matters.

---

## 7. Performance

Measured on the default recipe (48 m cells, 24 voxels, 2 m voxel size):
**~2,700 tris and ~6 ms per cell to mesh, ~1.5 ms to scatter**, streaming at
~95-110 fps in the browser on WebGPU with ~650 cells resident across the
rings.

That took a 4x optimisation pass from where it started (45 ms/cell). What
mattered, in order:

1. **Cave noise was 75% of sampling.** It is evaluated for most of a cell's
   volume, and almost all of that volume is solid. Fixed by an early-out (the
   first noise band alone rejects the overwhelming majority) plus evaluating
   it on a coarser *global* lattice with smoothstep interpolation. Global is
   load-bearing: a block-relative lattice would put a seam in every cave.
   `terrain.caves.sampleStep` is the knob.
2. **`slope()` was four extra `height()` calls per column.** The bulk sampler
   now takes heights on a lattice one ring wider than the block and derives
   slope from neighbours it already paid for. The extra ring is not an
   optimisation detail — differencing against a clamped edge neighbour would
   make two chunks disagree about the overhang mask on a shared column.
3. **`verticalRange.below` hits twice**: it multiplies both the sampled volume
   and the cave surface the mesher has to triangulate. It is the vertical cost
   knob.
4. **`Math.hypot` in the per-vertex normal path.** It is variadic and does
   overflow-safe scaling; plain `sqrt` is several times faster and the inputs
   are finite differences that cannot overflow.
5. **Splat and tint were two attribute passes** resolving the same biome
   memberships twice per vertex. Now one.

Two related fixes worth remembering because both failed *silently*:

- Voxel terrain must not opt into **static draw-call batching**. The merge
  strips per-vertex attributes, which would delete the splat weights the
  material reads and render the terrain as one flat layer. `static-batch.ts`
  now refuses any geometry carrying custom attributes rather than stripping
  them.
- **HLOD proxies** re-mesh the cell at a coarser lattice (rather than merging
  full-detail geometry, which would fix draw calls and nothing else) and keep
  the splat attributes within their own all-terrain bucket.

---

## 8. Open items

- **Deep caves need vertical chunk sections.** Today a cell meshes one
  vertical band around the surface (`verticalRange`), so tunnels below it are
  capped rather than streamed. Sections are the fix; the mesh source already
  takes an explicit `yRange` for it.
- **LOD crack at the HLOD boundary — fixed 2026-09-02 with skirts.** Every
  cell hangs a strip three lattice steps deep from each boundary edge (`addSkirts`
  in mesh.ts): the higher side's strip covers the crack, the lower side's is
  buried. Both sides emit unconditionally because a cell does not know its
  neighbour's step; in the simulation ring every neighbour is full detail, so
  the strip is inside rock and physics never meets it. A test walks the shared
  plane between a fine cell and a 4x-coarser one and checks the higher skirt
  reaches below the lower surface at every sample.
- **Generation now runs in a worker pool.** (Was: "meshing is on the main
  thread ... a worker would remove it from the frame budget entirely"; done
  2026-09-02.) `voxelChunkProvider` hands cells to a pool of
  `apps/playground/src/voxel-worker.ts` and returns a Promise —
  `ChunkProvider.get` always allowed one. The worker rebuilds its own
  `WorldField` from the recipe, which is what makes this cheap: the field is a
  pure function of recipe + seed, so no state has to be shipped or kept in
  sync. Only the recipe crosses on init and one plain-JSON `ChunkDoc` per cell
  comes back. `assetExists` is a closure and cannot be cloned, so the main
  thread sends the ANSWERS (the list of scatter assets that resolve today)
  rather than the question.

  Why it mattered more than the "~6 ms/cell" figure suggests: an HLOD supercell
  bake calls `readCell` for up to 16 member cells, so one bake could generate
  sixteen cells inside a single task. A CDP profile of a 1200-unit flight put
  `fbm2` alone at 14.5% of all main-thread self time and produced 800-1000 ms
  `long-task` stalls with a 2003 ms worst frame; after the move the same
  flight's worst long task is under 100 ms.

  **Two things to know when reading a profile now.** The `chunk.load` and
  `hlod.supercell` spans are wall-clock and now INCLUDE waiting on the worker,
  so a 1.4 s span is latency, not a stall — read `gapMs`/`long-task` for
  stalls. And the pool falls back to generating inline when `Worker` is absent
  (headless tooling, tests), so a slow world there is expected, not a bug.
- **Merging is still on the main thread.** `buildHlodProxy`'s `prepForMerge`
  (`toNonIndexed` + clone + `applyMatrix4` per source geometry) plus
  `mergeGeometries` measured ~4 s across that same flight — comparable to what
  generation cost before it moved — and is what is left of the streaming
  hitch. It is the next thing to move or time-slice.
- **Terrain editing.** The field is generated; there is no brush yet. The
  `features.blobs` list is the escape hatch (add/remove spheres), and it is
  what a sculpt tool would write into.
- **Rivers do not carry water.** They carve a channel; the ocean plane is a
  separate mesh. A river surface would be a `path` mesh along the same
  polyline with the water material.

---

## 9. Caves, mouths, and the voxel-resolution trap

Added 2026-09-01. Two separate problems, and the second is the one that will
catch you again. (Town paths kept an uncapped last rung a few hours longer; it is gone
too — see the next section.)

**Caves were sealed.** `caves.minDepth` held everywhere, so the tunnel network
never reached the surface — a cave system nobody could enter. Entrances are now
slope-driven (`caves.entrances`): steep ground relaxes the depth requirement to
a NEGATIVE value, so tunnels push out through cliff faces and mountainsides,
while flat meadows keep the full depth and never open a pit underfoot.

**The field can describe a passage the mesh cannot contain.** This is the trap.
Marching cubes on a 2 m lattice cannot represent a hole much narrower than one
voxel, so a tunnel the field says is 1.2 m across is silently pinched shut in
the mesh — and therefore in the collider cooked from it. Measured directly:
`worldgen caves` reported bottlenecks of 1.2–2.0 m and passages reaching 45 m
in; sweeping a 0.45 m sphere through those same mouths against the **cooked
collider** was blocked 2–8 m in, every one of the first six.

So a field-level measurement is not evidence. `worldgen caves` now also carves
each confirmed mouth explicitly, as a chain of `features.blobs` spheres at a
radius above the voxel size (`--mouth`, default `max(2.6, voxel × 1.5)`).
Re-measured against the collider afterwards: 9 of 10 mouths pass a 0.45 m
sphere the full sweep into a roofed system. `voxel.test.ts` pins the underlying
rule — a carve at 0.4× the voxel size adds essentially no triangles, one at
1.6× opens a real chamber.

**The general lesson: verify against the geometry that ships**, not against the
function that generated it. The field, the mesh and the collider are three
different things, and only the last one is what a player collides with.

## 10. Roads must be simplified in 3D, not in plan

Roads came out as dead-level causeways. The cause was RDP simplification of the
route in XZ only: a road that runs straight across rolling hills is, in plan, a
straight line, so it collapsed to its two endpoints and the height profile
sampled at those points became one linear ramp from town to town. Simplifying
in three dimensions (`simplify3`, with a `heightWeight` converting metres of
height error into grid units) keeps a control point at every rise and dip, and
still discards points along a genuinely straight, level run.

Two smaller contributors: three passes of a `[1,2,1]` smoothing kernel over an
already-sparse polyline pulled the profile toward its mean (now one pass — the
grade clamp is what keeps a road drivable, not the smoothing), and the grade
clamp itself was doing the rest of the flattening. Roads now climb to 42 m with
grades up to 11%, deviating 1.3–3.3 m from natural ground — which is what a
graded road's cut and fill should look like.

## 11. Climate: keep `lapseRate` small

The default was 0.006 temperature units per metre of altitude, which is roughly
40× too strong: a 50 m hill came out 0.3 colder than the shore, dropping it
into the polar band and putting snow on modest green hills next to meadows at
the same latitude. Now 0.0015. Snow on genuine peaks is the `alpine` biome's
height window doing its job; the lapse rate only tilts the odds. Mean snow
coverage on land went from dominant to 2.1%.

## 12. Backends: Firefox has no WebGPU here

Measured on the same scene, standing still, identical draw calls and triangles:

| | backend | frame p50 | js/frame |
|---|---|---|---|
| Chrome | webgpu | 7 ms | 4.8 ms |
| Firefox | **webgl2** | 12–13 ms | 10.6 ms |

Firefox reports `WebGPU is disabled by blocklist` and three falls back to
WebGL2, which costs roughly 2× the CPU per frame for the same content —
WebGL2 re-validates and re-binds far more per draw call. Setting
`dom.webgpu.enabled` / `gfx.webgpu.ignore-blocklist` did not lift it in
Playwright's Firefox build. This is a browser/driver decision, not an engine
bug; the HUD's `backend:` line is the first thing to read when a machine feels
slow. Fewer draw calls help WebGL2 disproportionately, which is the main
engine-side lever.

## 13. Caves are dug, not noised

Replaced the noise-carved caves with **tunnels**: `features.tunnels`, a 3D
polyline with a radius, carved as a tube — the same shape of thing as a river
or a road, and generated by the same kind of pass. `terrain.caves.enabled` is
now **false by default**.

Three reasons, in order:

1. **Control.** A noise threshold gives you a Swiss cheese or nothing, with no
   way to say "one system, here, running that way". A polyline is data you can
   place, inspect, edit and version.
2. **Cost.** Noise caves were the single most expensive thing in the generator,
   because the noise had to be evaluated for every voxel of rock in the world
   on the chance a passage ran through it. A tunnel is evaluated only near the
   tunnel (segments are bucketed by XZ footprint). Measured: **5.9 → 3.6 ms per
   cell to mesh, and 2,659 → 1,351 triangles per cell** — half the geometry,
   most of which was underground surface nobody would ever see.
3. **They actually work.** 10/10 mouths admit a 0.45 m sphere the full sweep
   into a roofed system, against the cooked collider (§9 explains why that is
   the only measurement that counts).

`worldgen caves` now digs: it picks steep faces with enough hillside behind
them, then walks a main passage inward and downward with a couple of branches,
wandering deterministically. Knobs: `--length`, `--branches`, `--mouth`
(radius), `--count`, `--separation`.

## 14. What the LOD tooling is and is not doing

Asked and measured, because "we have LOD" is not the same as "LOD is running".

- **HLOD supercells: yes.** Distant cells merge into one proxy per supercell,
  re-meshed at a coarser lattice (§7).
- **Static batching: yes**, per streamed cell (added in the streaming pass).
- **Foliage/instanced LOD: NO — `foliage near/mid/far = 0/0/0`.** The system is
  running and finding nothing to do. `renderMode: "instanced"` (and the
  distance-proxy tiers that hang off it) only applies to `mesh.source.kind:
  "asset"` — glTF models. The scatter placeholders are *prefabs made of
  primitives*, which cannot instance, so every tree is its own geometry.

  What the far tier IS, when it runs: `buildLodProxyGeometry` makes a
  **cross-billboard — two intersecting planes** — for tall props and a box for
  squat ones; when an impostor bake is available it is instead a single
  camera-facing quad sampling an octahedral atlas (`impostor.ts`). There is a
  decimated **mid** tier in between for models heavy enough to earn one.

  The ChunkManager to FoliageLodSystem wiring is correct — `onInstancedBatch`
  is passed in its build options. What is missing is a qualifying ASSET.
  Verified rather than assumed:

  - prefab-of-primitives (what the placeholders are) cannot instance at all,
    so they get no LOD and no proxy;
  - the only GLBs in this project are skinned characters, and the instanced
    path skips those outright — confirmed in the console with
    `[render] skipping skinned submesh`.

  A **static prop GLB** is therefore the untested case, and the one worth
  trying: drop one in, point a scatter rule at it via `model:`, and the
  `foliage near/mid/far` counters should go non-zero. Until that has actually
  been measured, "real tree GLBs will fix it" is a hypothesis, not a fact.

- **Supercell props (hlod + far rings): impostors, since 2026-09-04.** A
  scattered model whose rule leaves `lod` on becomes one batch of octahedral
  impostor quads per species per supercell — the same atlas the near ring
  swaps to past its far threshold — instead of its full geometry merged into
  the proxy. `lod: false` props (rocks, stumps, mushrooms) still merge as
  geometry in the hlod ring and are dropped from the far ring when under 4 m
  tall. The far ring also groups on a 2x wider supercell grid than the hlod
  ring, every species of a supercell shares one impostor draw (the baker
  pages all atlases onto one texture), and the near rings pool their
  instanced props world-wide instead of per cell. Read docs/performance-lessons.md ("Draw-count pass") before touching
  either; the boundary rules there are what keep the two grids from
  double-drawing.

### What props actually cost

Measured by spinning the camera in place on a settled world (no streaming), so
this is pure render cost:

| | draws | tris | render self |
|---|---|---|---|
| props + shadows | 139 | 1.01 M | 8.12 ms |
| props, sun shadows off | 120 | 826 K | 5.04 ms |
| no props at all | 33 | 310 K | 3.59 ms |

So props cost ~4.5 ms, of which **~3.1 ms is having shadows on at all** — and
that is *not* caster count: restricting which chunks cast shadows recovered
only 0.4 ms, while disabling the sun's shadow recovered 3.1 ms. The cost is the
cascade pass plus per-fragment shadow sampling across a screen full of terrain,
not the submission of caster draws. Shadow map size, cascade count and
`shadowSize` are therefore the levers, not caster culling. (A ring-tiered
"only near cells cast shadows" change was written, measured at 0.4 ms, and
reverted as not worth the pop risk.)

## 15. Zones: one palette, and biomes that exclude what does not belong

The four-channel limit was never the right shape. What a world needs is not
four textures — it is that *which* surfaces appear varies by region. The
palette is now up to **eight** (`MAX_SURFACES`), and every biome names weights
over that one palette, so a zone excludes what does not belong there simply by
weighting it zero:

```text
blight    grass 0   sand 0   dirt 0.15  blightedgrass 0.55  blighteddirt 0.30
beach     grass 0.12  sand 0.78  dirt 0.10
alpine    snow 0.80  icyrock 0.20        (cliffs: icyrock 0.85, snow 0.15)
```

Nothing special-cases a zone. A "blighted region" is an ordinary biome rule
whose window happens to be hot-and-dry with a height floor keeping it off the
shoreline, plus weights that carry no grass and no sand. Any number can be
added without touching the mesher, the shader or the streamer — and because
biome membership is smooth, its edges blend instead of stopping at a line.
Scatter rules take biome filters too, so the blight has no pines in it for the
same reason it has no grass.

Two mechanics this needs:

- **Two vertex attributes.** A vertex attribute is four components, so eight
  weights ride in `splatWeight` + `splatWeight2`. The upper half is emitted
  ALWAYS for an eight-surface palette, even where every weight in it is zero —
  `mergeGeometries` requires every input in an HLOD supercell to declare the
  same attributes, and skipping the empty one made a supercell spanning one
  blighted cell and one ordinary cell fail to merge. It failed loudly in the
  console and silently on screen, as a missing distant proxy.
- **`climate.contrast`.** Raw fBm clusters hard around the middle (measured
  0.23..0.65 for temperature), so the schema's documented 0..1 semantics were a
  lie and any window written in honest terms never fired — the biome silently
  did not exist anywhere. Contrast spreads the noise across the real range.
  This is why the default world had 0% desert for so long.

Cost, measured: eight textured layers is 24 triplanar fetches per fragment and
still renders at ~111 fps with `render` self at 5.9 ms. Past eight, the answer
is a texture ARRAY with per-vertex layer indices rather than more fixed
channels — same idea, one sample per active layer instead of one per palette
entry.

## 16. Pixel art needs `filter: "nearest"`

`material.filter` (and `recipe.textureFilter`, which `worldgen material` emits
onto the terrain material) switches magnification to nearest so pixel-art
textures stay chunky instead of being smeared smooth up close.

Minification still mipmaps — `NearestMipmapLinearFilter`, not plain
`NearestFilter`. Nearest minification of a tiling texture across a hillside
shimmers badly as texels alias against pixels, which is the usual reason "I set
nearest and the distance got worse". Nearest *within* the mip keeps the chunk;
blending *between* mips keeps it stable. Anisotropy is skipped in nearest mode
for the same reason.

Filtering is a property of the texture OBJECT and the loader shares one object
per key, so the filter is part of the cache key — otherwise the first material
to ask for a texture would silently decide how every other material saw it.

## 17. Borders: three scales, not one

A biome window on smooth low-frequency noise produces a border that is an
iso-contour of that noise — a clean arc of blight sweeping across a meadow.
The window's `blend` softens it into a *gradient*, which is a different
artifact, not a fix: it reads as an airbrush.

Real borders are ragged at every scale, so `climate.edge` supplies three:

| knob | scale | what it does |
| --- | --- | --- |
| `warp` (90 m) | hundreds of metres | domain-warps the climate field, so a zone reaches peninsulas and strands islands |
| `strength` (0.11) | metres | jitters temperature/moisture directly, dissolving the last few metres into speckle |
| `heightJitter` (4 m) | metres | jitters the ground height that HEIGHT windows are tested against — the snowline and the beach |

Set `warp` and `strength` to 0 for the old behaviour. Two things to know:

- The jitter is applied **after** `climate.contrast`, so `strength` means what
  it says in final 0..1 climate units instead of being multiplied by contrast.
- `heightJitter` reuses the moisture jitter's noise field rather than sampling
  its own. It costs nothing extra and is uncorrelated with the temperature
  that decides the snow, which is all it needs to be.

## 18. Patches: the scale between biome and texel

Biome rules are hundreds of metres across by construction, so on their own a
meadow is a sheet of grass to the horizon. `recipe.patches` is the second
scale — bare dirt worn through grass, rock breaking a desert, the mottling
that makes blighted ground read as diseased rather than merely recoloured.

Each patch is a lerp between two already-normalized weight vectors, so the
splat still sums to 1 however many stack. The **biome gate is checked before
the noise**, which is what makes this affordable: a patch confined to the
blight evaluates no noise at all across the other 99% of the world.

A patch naming a surface or a biome that does not exist is dropped, not
thrown — a recipe legitimately names things before they are added, and losing
a blotch pattern must never cost you the world.

## 19. Roads are painted as well as graded

Grading alone is invisible. Grass mown flat is still grass, and every road in
the first build was a subtle crease in a green field. `road.surface` (default
`"dirt"`) names a palette surface painted along the roadway, `road.surfaceEdge`
its verge; set `surface: ""` to grade without painting, which is what a paved
town square wants.

Two things that matter more than they look:

- **The verge is noise-perturbed.** Without it the dirt ends on a
  mathematically perfect offset curve, which is the single clearest tell that
  a road was generated rather than worn.
- **Painting is bucketed by SEGMENT, not by road.** `nearestOnPolyline` walks
  every control point, which is fine once per column in `applyFeatures` and
  ruinous once per mesh vertex: a 200-point road cost 200 distance tests per
  vertex to discover 198 were nowhere near. Measured 0.9 ms/cell before the
  fix, ~0 after. This is the same lesson the tunnels taught.

## 20. A zone needs a landform and a silhouette

Weights alone make a recolour, not a place. Two more things do:

- **Its own landform.** `terrain.dunes` is a ridged, stretched band added to
  the heightfield only where the climate matches — the same window the desert
  biome uses, so the sand and the dunes arrive together. `stretch` (3.5) is
  what makes them long parallel ridges instead of lumps; `angle` is the wind.
  It is off by default because it costs a climate lookup per column, and the
  pattern generalises: any biome that should have its own landform gets a
  masked band like this one.
- **Its own silhouette.** `worldgen monoliths` raises rock pillars — one
  `features.blobs` line each, `height > 0` making the blob a vertical capsule
  and `scaleX`/`scaleZ` squashing it in plan so it reads as a weathered slab.
  They are authored data rather than another noise band because a pillar is a
  landmark: you want to see the list, move one, delete one, and let a later
  stage reason about where they are.

Two traps, both found the hard way:

- **`heightRange` must know about additive blobs.** It feeds the mesher's
  vertical band, and it used to see only the heightfield — so a 30 m monolith
  was sliced off at the terrain's own 14 m of headroom and rendered as a mesa
  with an open top.
- **The map cannot see them.** The overview samples `height()`, which is the
  heightfield; blobs are 3D density. `worldgen map` now plots additive blobs
  explicitly, or a stage that raised forty pillars looks like a stage that did
  nothing. `--cx/--cz` centre the map so a single zone can be inspected at a
  scale where dunes are visible at all.

Bare rock on genuinely steep ground is a separate mechanism again: the `crag`
biome rule has a slope window and no height window, so it applies in every
biome at every altitude. Each biome's own `cliff` weights are a judgement
about *its* slopes; `crag` is the physical fact that nothing stays on a
near-vertical face. Above the snowline the remainder goes to icy rock rather
than snow, which is correct.

Measured cost of everything in §17–§20 together: **5.75 → 6.6 ms/cell** to
mesh (41 cells across the demo world, warm), against a 16 ms budget.

### A cover rule must not name the place

`crag` is the first biome rule that is **cover only**, and it exposed a
sharp edge in the model: `biome().id` is the strongest rule by membership, and
everything that asks "which biome is this" reads it — `scatter.biomes` above
all. Left labelling, `crag` renamed every slope in the world, and the pines
filtered to `"meadow"` silently stopped appearing on hillsides. The blight's
dead trees never spawned at all.

So a biome rule carries `label` (default true). Set it false and the rule
still paints, but the place keeps its own name. Two details:

- Where **no** labelling rule matches at all (0.63% of land in the demo world
  — a genuine gap in the rule set, or ground so steep only the cover rule
  applies), `biome().id` falls back to the strongest rule of any kind. Naming
  the first labelled rule instead reported `"seabed"` on clifftops, which is a
  lie with consequences.
- The symptom to watch for is scatter, not colour. The ground looked right
  the whole time.

## 21. Your texture budget

`MAX_SURFACES` is **16**, and the honest framing is that you pay for what you
use, not for the cap:

- The mesher's per-vertex splat is exactly `surfaces.length` wide.
- The geometry emits `ceil(length / 4)` vec4 attributes (`splatWeight`,
  `splatWeight2`, …), all of them always, because HLOD's `mergeGeometries`
  needs every cell of a world to declare the same attributes.
- The shader blends `length` layers.

So a six-surface world costs exactly what a six-surface world cost when the
cap was six. What the cap protects is the FRAGMENT shader, where the real cost
lives: sampling is triplanar, so each active albedo layer is **three** texture
fetches, and a normal map doubles it.

| palette | albedo fetches | with normal maps |
| --- | --- | --- |
| 4 | 12 | 24 |
| 8 | 24 | 48 |
| 12 | 36 | 72 |
| 16 | 48 | 96 |

Measured on this box, eight textured layers renders at ~110 fps with `render`
self at 5.9 ms. Twelve is a reasonable place to stop and measure; sixteen is a
lot of texturing to ask for on ground.

**Past sixteen the answer is not a bigger number here.** It is a texture ARRAY
plus per-vertex layer INDICES: each vertex names the three or four layers it
actually blends, the shader samples only those, and the palette can then be
hundreds deep at a *lower* per-fragment cost than eight fixed channels. The
constraint that buys is that every terrain texture must share one size and
format.

Practical shape of the budget for adding cliff walls, ice flats, canyon
strata: eight more surfaces fit today with no code change — add them to
`recipe.surfaces`, weight them in the biomes that want them, re-run
`worldgen material`. Watch the profiler's `render` self time as you go; that
is the number that decides, not the count.

## 22. The altitude ladder has to be tall AND wide

Two separate mistakes make a mountain read as a painted cone:

- **Too short.** A range whose peaks land in the same band as ordinary green
  hills produces the worst possible reading of a world: everything the same
  height, some of it inexplicably white. `terrain.mountains.amplitude` is 900
  in the default world and the ridged band delivers roughly 55–75% of it, so
  peaks reach ~700 m against 60 m hills. Raise `maxY` with it (900) or the
  vertical march clips the summits flat.
- **Too narrow.** Passing through green, rock, tundra and snow in the last
  40 m is the same failure at a different scale. The rungs — `highland`
  (58–190), `montane` (170–330), `alpine` (310+) — overlap by design, each with
  a `heightBlend` of 20–35 m, and `montane` exists specifically because a
  mountain that goes meadow-green to white in one step reads as a decal rather
  than as an altitude.

`worldgen stats` will not catch this; a test will (`climbs the altitude ladder
without skipping a rung`), and so will the biome histogram from a coarse
sweep. Aim for a couple of percent of land above the snow line, not a
fraction of one.

Cost of raising the mountains from 400 to 900: **+18% triangles per cell**
(1576 → 1852) and about +1 ms/cell to mesh. That is the price of the
silhouette.

## 23. Sea cliffs: steepen the profile, don't add a cliff

A height-band beach rule on a uniformly gentle coastline rings the whole world
in one unbroken strip of sand. `terrain.coast` fixes the *land*, not the rule:
near sea level the profile is remapped `dh -> dh * k` with k > 1 at the
waterline, tapering back to 1 by `band`, where a low-frequency noise says the
coast is rugged.

Everything else follows for free — the beach biome's window is crossed in two
metres of ground instead of forty, so sand survives only in the gentle bays;
`crag` paints the face rock; the sea floor drops away below a headland instead
of shelving.

Three things worth knowing:

- **The coastline does not move.** The remap is monotonic through zero, so land
  stays land and sea stays sea, everywhere — which is what makes it safe to
  switch on in a world whose rivers and towns are already sited. There is a
  test for exactly that.
- **The thresholds sit BELOW the middle** (0.40/0.56). Raw fBm clusters around
  0.5 — the same trap `climate.contrast` exists for — and an honest-looking
  0.5/0.75 window gave 6% cliff coastline, which reads as broken rather than
  as subtle. 0.40/0.56 gives 17%.
- It found a **latent field bug**. The mesher skipped the 3D overhang term
  outside a band around the ground, `density()` applied it everywhere; the
  signs agreed so the surface was fine, but the two were not the same
  function. Steep coasts opened the overhang mask at sea level and the
  invariant test caught 2.4 world units of disagreement. Both paths now share
  one `overhangReach` constant. **Two implementations of one field must be one
  function, not two that happen to agree where you last looked.**

## 24. Canyons and needles: a zone's silhouette

- **`worldgen canyons`** cuts terraced gorges. Two things it does differently
  from a river, both learned the hard way:
  - It descends at the **gentlest** available gradient, not the steepest.
    Steepest descent is right for a river, which is trying to reach the sea;
    it runs a canyon off the edge of the plateau within a few grid steps and
    plunges. Every canyon traced that way came out six points long. Following
    the smallest positive drop wanders across the high country the way a gorge
    actually does.
  - It stops where it can no longer be a canyon: you cannot cut a fifty-metre
    gorge into twenty metres of land. Trimming by DEPTH rather than by an
    absolute altitude keeps each one exactly as long as it is deep. Before
    that, three of four canyons came out with their floor and their rim both
    at 2 m, which is not a canyon, it is a ditch.

  The wall profile is `terrace()` — a quantized, eased ramp. `steps` is the
  stratigraphy and `stepSharpness` slides continuously from a smooth chute to
  vertical risers with flat treads.

- **`worldgen monoliths`** raises spires. A spire is defined by its **aspect
  ratio**, not its width: pick height and radius independently and the tall
  ones come out as fat mesas and the short ones as posts. Height first
  (45–150 m), then `radius = height / aspect` with aspect 7–12, then
  `topRadius` at 42–72% of the base so it tapers. Separation is barely wider
  than the tallest one is tall, because a spire alone is a curiosity and a
  hundred within sight of each other is a landscape.

## 25. Nothing scatters onto a road — or into a monolith

`scatter.clearance` is metres from the feature's EDGE, and `featureClearance`
now measures rivers, **canyons**, roads, towns **and additive blobs**. The last
is the one that is easy to forget: scatter stands props on the HEIGHTFIELD,
and a monolith is not in the heightfield at all — it is 3D density — so
without it every spire gets a ring of boulders buried inside it.

A boulder in the middle of the highway is the single most obvious way a
generated world announces that nothing was thought about. Defaults: boulders
3.5 m, shrubs 2.5 m, trees 4 m.

## 26. Yes, slope picks the texture — and it was measuring the wrong angle

There are three slope-driven mechanisms, and they were all reading a number
that was not the number they were authored against.

The mechanisms:

- **`biome.cliff`** — per-biome cover for steep ground, faded in between
  `cliffStart` and `cliffEnd`.
- **The `crag` rule** — bare rock on genuinely steep ground in *every* biome at
  *every* altitude, a slope window with no height window (§20).
- **`patch.slope`** — restricts a surface patch to a steepness band (scree on
  slopes, worn dirt on the flat).

The bug: `slope()` and the mesher's column slope both report **sin(angle)**.
The per-vertex path — the one that actually textures the mesh — computed
`1 - |ny|`, which is **1 − cos(angle)**. A different curve entirely:

| angle | 1 − cos | sin |
| --- | --- | --- |
| 30° | 0.13 | 0.50 |
| 45° | 0.29 | 0.71 |
| 60° | 0.50 | 0.87 |

So a `cliffStart` of 0.55 meant 33° to the author and **63°** to the mesh. A
50° cliff face reported 0.36, never reached its cliffStart, and textured as
whatever the biome puts on FLAT ground — grass, or sand. No amount of tuning
the biome weights would have found it, because the number being compared was
the wrong number.

Fixed to `sqrt(1 - ny²)`, with a test that the vertex path and the point path
return identical splat weights for the same angle. **Two ways of measuring one
quantity is the same failure as two implementations of one field (§23) — the
units have to be the same or the thresholds silently mean something else.**

Because the thresholds had been tuned *against the broken values*, they were
re-set from the physics afterwards: cover holds to ~35° (`cliffStart` 0.57),
bare rock by ~55° (`cliffEnd` 0.82), `crag` from 51°. That is the angle of
repose, which is the real reason soil and sand stop staying put.

## 27. A zone has to be big enough to be somewhere

The desert was 4.5% of land, which is a patch you walk past, not a region you
travel through. It is now **~25%** — window widened to temperature 0.42+,
moisture below 0.55, height ceiling 200 m so it climbs into the hills.

Two knock-on effects worth knowing:

- **Widening a zone eats its neighbours in climate space.** The blight shares
  the hot, dry corner with the desert and fell from 1.1% to 0.4% on its own;
  its `weight` had to go 2.2 → 3.2 to hold its ground.
- **The landform window has to follow.** `terrain.dunes` masks itself on the
  same climate axes, so widening the desert without widening the dune window
  leaves a quarter of the world sandy and flat.

And the spires are now a **field**, not a sprinkle. `worldgen monoliths` picks
its centre by candidate DENSITY (the deepest part of the zone), places
everything within `--radius` of it, and thins toward the rim so the edge fades
instead of stopping. Spread evenly across every desert instead, they read as
scenery scattered by a machine — one lone pillar here, two there, no reason
for any of them. A field has a middle, an edge and a silhouette you can
navigate by, and it gets a `spire-field` POI so it is findable.

## 28. Ground cover: textured billboards on generated terrain

The `grass` component was already the right machine — a camera-relative
InstancedMesh sliding over the terrain, wind sway anchored at the base,
distance and camera-height fades. Two things were added rather than a second
system built:

- **`texture`** turns each instance from a procedural coloured triangle into
  `crossQuads` intersecting textured quads with an **alpha cutout**. Cutout,
  not blending: a tuft is mostly empty, and alpha-blending a hundred thousand
  overlapping quads means sorting them, which is expensive and wrong.
  `alphaTest` discards the empty fragments so depth still writes and the layer
  needs no sort order. Two quads is the standard cross; one disappears edge-on
  as you walk around it.
- **`surfaces` / `minSurface` / `slopeMax`** gate where a layer grows. The
  gate is asked per LAYER — the sampler receives the layer's own data — so
  dense grass and sparse bramble are two entities, not one compromise.

**Gate on the surface, not the biome.** A layer names `grass` or `sand`, and
the host asks the field what the ground there actually blends to. That makes
cover agree with what you can *see*: a worn dirt patch inside a meadow grows
no grass, a cliff face inside a meadow grows none either, and bramble reaches
into the desert because `sand` is in its list — all without one biome name
anywhere, and all of it following automatically when a patch or a biome
changes.

Two things to get right or nothing renders:

- **Texture asset ids include the extension** — `mmo/Grass.png`, not
  `mmo/Grass`. A miss resolves to nothing, the cutout discards every fragment
  because the placeholder texture's alpha is zero, and the layer is *silently
  invisible* while still costing its full instance count. The console warns;
  read it.
- **Nearest magnification, mipmapped minification** — same rule as the terrain
  (§16). Un-mipmapped nearest across a hundred thousand tufts is a field of
  crawling static.

Measured on the demo world: grass at 2.8/m² over a 42 m radius (~15,500
instances, one draw call) plus bramble at 0.055/m² over 62 m (~660) costs
about **2 ms of render time**, ~82 fps in a meadow. Density is the lever, and
it is steep — 9/m² read as a solid textured carpet rather than as tufts, which
is both slower and worse-looking than 3/m².

### Two ways scattered cover betrays itself

Both were live in the first cut, and both are worth knowing because every
scatter system grows them:

- **Floating on slopes.** A billboard is a VERTICAL card standing on one
  sampled point, but it has width — so on a gradient its downhill edge lifts
  off the terrain and the tuft hovers. The fix is to sink each instance by the
  drop across its own half-width, `halfWidth * tan(angle)`, which buries the
  uphill edge instead; nobody can see that. The sampler is not told which
  instance is asking, so it sinks for the LARGEST scale the jitter produces:
  over-sinking a small tuft costs a centimetre of its base, under-sinking a
  large one floats it, and only one of those is visible.

- **Swimming when you turn.** The patch recenters as the camera moves, and
  placement was `centre + polar(hash(instanceIndex))` — an offset from wherever
  the patch happened to be, so every recenter teleported every tuft. In the
  editor this is constant, because orbiting sweeps the camera POSITION in a
  circle (the same property that used to re-stream chunks while rotating, §
  performance-lessons). The fix is a jittered grid **anchored to the world**:
  position, yaw, size, wind phase and tint are all functions of the grid cell,
  so recentering only changes which cells are in range.

  The wind phase and tint had to move with it. Keyed off `instanceIndex` they
  reshuffled on every recenter and the whole field twitched and re-shaded at
  once; they are now a per-instance `vec2` attribute written from the same cell
  hash.

  One consequence to keep: the scan walks rows **outward from the centre**. The
  buffer can legitimately fill before the disc is covered (a dense layer
  clamped at `MAX_BLADES`), and filling it in raster order leaves the far half
  of the patch empty behind a straight edge across the middle of the view.
  Outward order puts any shortfall at the rim, where the distance fade is
  already dissolving it.

## 29. Tiling: break the grid, don't chase a better texture

A tiled texture reads as tiled because the **same pattern recurs on a fixed
grid**, so the eye stops seeing ground and starts seeing the grid. That is a
property of the repetition, not of the art — a more detailed or more neutral
texture repeats just as visibly, which is why "find a better grass" is the one
fix that never works.

`splat.macroNoise` answers it by multiplying gradient noise over the whole
blended result — one overlay across every layer, applied after the blend and
before the per-biome vertex tint. Set it on the RECIPE (`recipe.macroNoise`),
not on the material: the material is derived data and `worldgen material`
re-emits it whole the next time the palette changes.

**Two bands, because they fix different distances.** One band alone leaves the
other range untouched and reads as a stain rather than as ground:

| band | scale | fixes |
| --- | --- | --- |
| `scale` | ~5-15x the tile (80-140) | "the same hillside forever" out to the horizon |
| `detailScale` | ~2-3 tiles (10-20) | the visible grid underfoot |

Keep both well clear of any layer's `uvScale`, and clear of each other. A band
that lands *on* a tile multiple reinforces the grid instead of hiding it, which
is the one way to make this actively worse.

`strength` around 0.2-0.25 is a visible but natural mottle; past ~0.4 it stops
reading as light and shade over the ground and starts reading as dirt painted
on it. `roughnessStrength` is worth a small value (0.05-0.1) only if the
terrain tiles in SPECULAR under a low sun — a flat-lit world does not need it.

**Cost is two noise evaluations and zero texture fetches**, so it is far
cheaper than the other standard answer (stochastic or hex-grid sampling, which
triples the fetch count — on an eight-layer palette that is 24 fetches becoming
72, per § "Your texture budget"). Measured on voxel-demo at eight textured
layers: no change in `render` self time that survives the noise between runs.

It is not a substitute for `patches`. Patches change WHICH surface is on the
ground and are gated by biome and slope; `macroNoise` only varies brightness,
knows nothing about the world, and cannot break up a place that is genuinely
one flat colour. Use both — the patch decides it is scree, the noise stops the
scree from tiling.

## 15. Cliffs: shape the ground, then dress it

Added 2026-09-02. Two features that only work as a pair, because each one
alone fails in a way that is easy to misread as the other's fault.

### The ground: `terrain.cliffs`

fBm has a bounded gradient. No amount of tuning amplitudes and frequencies
makes it produce a sheer face — turn them up and you get taller rounded
bubbles, which is exactly what this world looked like. Measured on the demo
world: **5.8% of meshed triangle area was steeper than 0.93** (68°), and what
little there was came from the coast-cliff remap, not the mountains.

`terrain.cliffs` remaps altitude within bands of `step` metres so most of each
band is spent in a short riser and the rest flattens into a tread. It is the
same trick as `coast.cliff` — a monotonic remap of the profile in place, so the
terrain stays a function and nothing can fold — applied to altitude instead of
to distance from the shoreline.

Three decisions are load-bearing:

**It shapes the MOUNTAIN band's relief, not the finished height.** That
self-gates: the mountain mask is already zero over meadows, so terracing cannot
turn a field into a wedding cake. It also means no slope test is needed — and
none is possible. `slope()` is defined as a difference of `height()`, so a
slope gate *inside* `height()` either recurses or costs four more evaluations
of the most-called function in the generator.

**The treads are not level.** Continent and hills are added after terracing, so
every ledge rides the larger landform. Perfectly level treads read as a contour
map; tilted ones read as strata.

**`mask` is not optional in practice.** Terracing every mountain uniformly
produces a **ziggurat** — a stepped pyramid, base to summit, and it looks
exactly as wrong as it sounds. This was built, looked at, and rejected on
sight. A range is mostly smooth flank with cliff bands breaking out here and
there, and the mask is the whole of that difference. Measured on the demo
world:

| | near-vertical area | median slope | tris/cell |
| --- | --- | --- | --- |
| off | 5.8% | 0.53 | 3513 |
| terraced everywhere | 29.3% | **0.40** | 3700 |
| masked (0.44–0.58) | **13.0%** | 0.53 | 3518 |

The median is the tell. Terracing everywhere drags it down because every flank
becomes tread-and-riser; masked, the world at large is untouched and only the
cliff bands change. Cost is nil either way — one extra noise evaluation, inside
the mountain branch, and +5% triangles.

**Setting the mask window: measure, do not guess.** Raw fBm clusters hard
around the middle (the `spread()` comment in `field.ts` has the numbers), so a
window of 0.56–0.78 — which reads like "the top fifth" — fires almost nowhere
and the feature silently does nothing. That happened here first. Sweep
candidate windows and measure meshed triangle area, which is what a player
sees.

### The dressing: `scatter[].cliff`, and why this world does not use it

Steeper ground alone is still bare ground, so a `scatter` rule can take a
`cliff` block: instead of standing one prop on the surface it walks DOWN the
face from the clifftop, bedding a prop into it at each step.

It needs its own mode because the ordinary scatter lattice is a **plan
projection**. A sheer face occupies almost no ground area seen from above, so
it collects almost no props however high the density is set — that is the real
reason a cliff reads as painted texture. Three things the flat path cannot do,
each of which was a visible failure before it was a feature:

- **`embed`**, in model units, multiplied by the instance scale like
  `yOffset`. A prop merely *placed on* a face reads as bolted on.
- **`lean`**, radians tipping the prop back into the face. A cliff recedes as
  it rises, so an upright prop bedded at its base has its top hanging in open
  air — measured at 8.7 m of daylight on a 65° face, and it looked like a field
  of planted menhirs. `alignToNormal` is NOT this: it lays a prop *onto* a
  slope, which on a cliff leans it further out.
- **No XZ occupancy test.** That map is a plan-view spacing test, and a stack is
  by construction several props at nearly one (x, z) — it would reject its own
  second rock. Cliff rules sit on ground steeper than anything else scatters
  on, so there is nothing there to space against.

**It was built, shipped, looked at, and then not used here.** With a single
rock model, a dressed face still reads as one model repeated rather than as
rock, and the demo world went instead to large boulders on flat ground — the
ordinary scatter path with `slopeMax` low and a `height` floor, which puts
them at the feet of mountains and on their benches. That is a judgement about
one piece of art, not about the mechanism: the mode is tested and stays. Reach
for it when a face is worth dressing and there is more than one rock to dress
it with.

`slopeMin` (new, on every rule, cliff mode or not) is what makes a rule
steep-only; pair it with the world's `cliffStart` so props arrive exactly
where the cliff texture does. A stack terminates when `faceAtHeight` marches
past `search` without finding a crossing — on terraced ground that happens at
every tread, which is correct and also means terracing cuts the props per
column. Carry the count with `density`, not with a bigger `stack`. Keep
`search` well under a quarter of `cellSize`: it is how far a prop can end up
from the lattice point that owns it, and a prop far from its owner pops when
that cell unloads while the one it visually sits in stays resident.

### The far tier will quietly replace your rock with a box

The single biggest visual problem in this whole exercise was not placement. It
was that `scatter` never emitted `mesh.lod`, which defaults to **true**, so
every scattered model swapped to its distance proxy past 100 m. Without a baked
impostor that proxy is a **cross-billboard for a tall prop and a BoxGeometry
for a squat one** — so every rock in the middle distance was a brown box. Read
as "the rocks look like bubbles", which is exactly right and points nowhere
near the scatter code.

The model is **168 triangles**. The proxy saves ~156 of them and costs you the
rock. `lod` is now a scatter-rule field, and the rule for setting it is
simply: if the model is cheap, turn it off. The far tier exists to stop a
30,000-triangle tree being drawn 900 times, and it has nothing to offer
anything an order of magnitude below that.

Check it from the HUD: `foliage LOD: N near · N mid · N far`. A far count that
is most of your props at a distance you can still make out shapes at means you
are looking at proxies.

### Two traps worth naming

**`field.slope()` is not what you see, but here it agrees.** Given §9's warning
it is natural to assume a face the field calls vertical is smoothed away by the
2 m lattice. Measured directly — triangle normals from `voxelMesh` against
`field.slope()` at the same points — they track within 1.5 points at every
percentile. A face that *looks* like a ramp in a screenshot is usually the
camera looking down-slope, which flattens pitch; move to the base and look up.

**Screenshots need a vetted camera.** Poses guessed from the surface normal
land inside hills and in the middle of forests. Require the camera to be ≥14 m
above ground and sample the ray to the target for occlusion before shooting;
`POST /__hitreg/camera` is the mechanism, and its first command after page load
is routinely dropped while the tab streams its initial rings — retry until it
acknowledges.

## 16. What terracing actually does to a slope — and the tiling fix

Added 2026-09-02, after § 15 was tried on a real world and mostly rejected.

### Terracing trades middle slope for flat + vertical

§ 15 reported "near-vertical area 5.8% → 13%" and read that as "more cliffs".
That number is true and the reading was wrong. Terracing replaces a lot of
**moderately-steep** ground with a little vertical riser and a lot of flat
tread. Whether the sheer *fraction* goes up or down therefore depends entirely
on how steep the ground already was:

| ground | terracing does |
| --- | --- |
| gentle to moderate (foothills) | sheer fraction rises — a lot |
| already near-vertical (real mountains) | sheer fraction **falls** |

Measured on the demo world, split by altitude:

| | low (<60 m) | foothill (60–140 m) | mountain (>140 m) |
| --- | --- | --- | --- |
| off | 2.2% | 4.5% | 28.4% |
| terraced | 2.2% | 7.1% | 29.5% |

So the whole of the headline gain was in the **foothills** — which is exactly
the ground that got reported as "too drastic when not on mountains" and
"really really harsh". The mountains were already 28% near-vertical and had
nothing to gain. `terrain.cliffs` is therefore **off in the demo world**. It is
for a world whose mountains are smooth; this one's are not.

The test that pins this asserts the *distribution*, not the sheer fraction:
terracing must empty out the middle of the slope histogram and add to both
tails. That is what terracing is, and it is true whichever way the sheer
fraction happens to move.

### Three gates, and why the product must be sharpened

`terrain.cliffs` now fades out on three axes: the noise `mask` (where), the
**mountain mask** (terracing must fade in with the mountains it belongs to),
and `minBands` (a place needs a couple of `step` bands of relief before it can
carry a terrace at all). The second and third exist because of the same
failure: at the *edge* of the mountain band, ground with one band's worth of
relief was getting full-strength terracing and turning into a single enormous
step — which reads far harsher than the mountain does, because there is no
mountain around it to explain it, and it is the first thing you see from a
distance.

The non-obvious part is that the three gates are multiplied **and then run
through a smoothstep**. Used raw, a product of three fades spends most of its
range near a half — and a half-applied terrace is worse than either end. It
flattens the treads without ever steepening the risers to vertical, so a world
blended at 0.5 measures *less* sheer ground than one never terraced at all.
The blend wants to be mostly 0 or mostly 1 with a narrow transition.

### Tiling: three things you can do, in order of what they cost

"Everything looks the same, especially the texture tiles" turned out to be two
separate complaints that want different fixes. Ranked by what actually moved
the picture, on a fixed camera looking at a large rock face:

**1. Make the tile bigger. Free, and the biggest single win.** `clif` was
tiling every 9 m, so a 200 m face showed roughly 22 repeats of one motif and
read as stamped. At 20 m it reads as vertical strata and fissures — like rock
that happens to be self-similar, which real rock is. `rock` went 6 → 11 m for
the same reason. Before reaching for any shader work, ask whether the tile is
simply too small for the surface it is being seen on. Terrain tiles that look
right underfoot are frequently far too small on a cliff face.

**2. A per-CHANNEL noise multiply — `macroNoise.colorStrength`.** The existing
overlay could only swing brightness, and a large area varying in brightness
alone still reads as one material under uneven light. Letting the three
channels drift apart slightly — warmer here, greyer there — is what reads as
the ground itself being different from place to place. One vec3 noise
evaluation, no texture fetches. `colorScale` around 85 m gives per-hillside
variation; 190 m was too broad to notice and 0.4 strength goes tie-dye. 0.15 at
85 m is a natural mottle.

**3. Warping the projection — `macroNoise.warp`. Implemented, and turned OFF.**
It genuinely does remove the grid (A/B on one camera: no warp gives countable
rows and columns; tile-scale warp gives none), and if you use it, keep
`warpScale` near twice the tile size — a coarse warp slides whole tiles around
and leaves the motif inside each one intact. But it distorts the art to do it,
and on this world it read as smearing rather than as variation. It is off
(`warp: 0`) and should stay off unless the texture is noisy enough to hide the
distortion.

The distinction worth carrying: **an overlay multiply cannot remove tile
repetition at all** — it does not change what is sampled, only how bright or
what colour the result is. It buys regional variation, which is a different
and also-necessary thing. Only (1) and (3) touch the repetition itself, and (1)
is free.

If the repetition still shows after all three, the remaining lever is a second
sample of the same texture at a much larger scale blended by noise, which adds
three fetches per layer to a material already doing 24.

The warp displaces the sampling position only — the blend weights still come
from the true geometric normal. Warping the normal too would make the triplanar
seams crawl, which looks worse than the tiling it is fixing.

What it does *not* fix is a texture whose own motif is strongly self-similar;
past this point the remaining lever is a second sample of the same texture at a
much larger scale, blended by noise, and that doubles the fetch count.

## 30. Worldgen v2: a world that makes sense

Added 2026-09-02, after the first real look at the demo world as a place to
walk around in rather than a set of features that each worked. The verdict was
blunt and correct: land fragmented into islands, mountains dotted about like
polka dots, five-point rivers plunging from a summit into the sea, roads on
mounds, a desert the size of a field, blight in patches, ocean in every inland
hollow. Each of those had a single cause, and each cause is now a layer.

### The height function, in order

```text
zone            which kind of place (x, z) is, and its landform multipliers
noise bands     continent, hills, mountains x relief, mesas, dunes, detail
ceiling         soft compression toward a common summit line
bounds          the shore profile, the land floor, the world limit
coast cliffs    steepen whatever profile crosses sea level where rugged
features        canyons -> lakes -> rivers -> towns -> roads
```

Every one of these is a monotone, continuous remap or an additive band, so
the terrain stays a function and the invariants of §4 hold unchanged.

### Zones (`climate.zones`)

Climate from smooth noise gives patches at every scale, because that is what
the middle of a noise field looks like. A world you travel through wants
regions you can be *in*. So the plane is cut into jittered Voronoi cells of
`size` metres (1.5–2.4 km), each cell draws ONE anchor — tundra, taiga,
mountains, highlands, grassland, forest, swamp, jungle, desert, badlands,
blight — and only the `border` between cells is blended. Every site within
`border` of the nearest fades in by distance, not just the runner-up: a
two-site blend jumps at a triple junction when the runner-up changes identity.

An anchor is a climate (temperature, moisture) **and a landform**: `relief`
multiplies the mountain band, `hills` the hill band, `dunes` and `mesas`
switch on their bands, `flatten` pulls a swamp down to the waterline. That is
what makes a mountain zone *have* mountains and a badland be tables and buttes
rather than the same hills in a different colour. Biome rules gate to zones
with `zones: [...]`, so blight and badlands can both be hot-and-dry without
fighting over a climate corner; the altitude ladder (highland / montane /
alpine) and `crag` stay ungated so a peak in any zone reads as a peak.

Two things learned building it:

- **Which anchor a zone draws is a draw.** The first demo world drew no desert
  and no badlands at all. `zones.seed` re-rolls the layout without moving a
  hill, and the demo's generator sweeps it until every anchor covers land and
  none swallows it (`projects/voxel-demo/tools/gen-world.mts`).
- **Every consumer must read the zone through the same warp.** The landform,
  the biome rules and the public `zone()` all go through the climate edge
  warp; the first version read the landform unwarped and a tool asked for
  "meadow" where the ground was being shaped as marsh.

### Bounds: continents that are not circles, and no ocean inland

`bounds.continents[]` are discs with an exact shore distance — that is what
the shore profile and the "no ocean inland" guarantee are built on — but a
disc reads as a disc. Three things fix that without losing the distance:

- **Lobes.** A continent is the smooth union (`lobes`, `lobeBlend`) of
  several discs. Two or three make a crescent, an L, a peninsula and a gulf.
  The union is a smooth max, and the sign of its blend was inverted the first
  time — it computed the intersection and the world was 2% land. There is a
  test for the saddle between two lobes now.
- **Two warps.** The lobe-scale warp (`warpScale`) frays the rim into
  headlands and bays; a second warp at the landmass's own scale bends the
  whole outline.
- **Coast variation.** `coastVariation` varies the falloff around the coast,
  so one stretch descends steeply (cliffs, relief reaching the water) and the
  next gently (a beach). Beach on one side of an island, cliffs on the other,
  from one knob.

`landFloor` (> 0) switches the continent from a height blend to a **shore
profile**: the ground rises from `oceanFloor` through the waterline at a
beach grade to the land floor, slope-continuous across the shoreline, and the
terrain's own relief fades in on top of it inland. The coastline is then
exactly the warped outline and nowhere else — an inland hollow can no longer
fall below sea level, so standing water inland is only ever a **lake** at its
own level. `limit` is the world boundary: beyond it there is ocean floor,
the streamer skips the cells, the ocean plane is sized to it, and nothing is
placed past it. Keep `terrain.base` well above the floor (55 in the preset)
or half the interior clamps to a level plain.

### Ceiling and erosion: mountains that are tall without being jagged

`terrain.ceiling` compresses everything above `height - softness` toward
`height` on an exponential: the mountain band can have a big amplitude for
tall steep flanks, no summit is sliced flat at `maxY`, and every peak in the
world approaches one summit line. The demo reaches 500 m against a 520 m
ceiling.

`erosion` on any fBm band weights each octave by the slope accumulated over
the octaves *below* it, so fine detail is damped where the ground is already
steep — valleys smooth and walkable, ridgelines crisp. The first version
weighted the base octave by its own gradient and flattened every range by a
third before a single detail octave was added; there is a test that the base
band keeps its relief and the fine detail is calmed more on steep ground than
on flat. Overhangs are also gated to genuinely steep faces now
(`slopeStart` 0.62): on every 20° slope they read as lumps, and lumps are
what "jagged" looks like up close.

### Hydrology: rivers, lakes and waterfalls that are derived

`worldgen rivers` no longer walks downhill from the highest points. It
samples the world on a 16 m grid and computes drainage the standard way
(`tools/worldgen-hydrology.mts`): priority-flood depression filling from the
sea, D8 flow on the filled surface, rain-weighted accumulation (a desert cell
contributes little, a swamp cell a lot), channels above a catchment threshold
traced from each outlet up the largest contributor for the main stem and then
recursively for tributaries — so a network is a trunk plus branches that end
where they join.

- **Lakes** are the depressions the fill had to raise, at exactly the level
  they spill (`features.lakes`, a polygon outline traced from the cell mask).
  A basin bigger than `--max-lake` is DRAINED: its surface is lowered to a
  few metres over its floor and the outlet river is cut down through the sill
  to match, so an inland sea the size of a province becomes a lake with a
  gorge leaving it.
- **River beds** are the filled surface less a depth that grows with
  catchment, forced monotone downstream, running just under a lake's surface
  through it. **Waterfalls** are simply where the bed drops a cliff's worth in
  one grid step; they are marked as `falls` POIs and nothing smooths them.
- **Water is emitted per cell** (`recipe.waterMaterial`): a `path` ribbon
  per river channel crossing the cell, a flat `poly` sheet per lake clipped
  to the cell. Per cell, not per lake, so water never vanishes when the cell
  holding the centre unloads while the shore stays; neighbouring sheets share
  their clipped edge exactly. HLOD defers both kinds rather than merging them.
  Scatter reads `field.waterY()` and grows nothing under any of it.

Two traps: the `pois` stage used to replace *every* POI and wiped the
waterfalls the river stage had marked (stages now replace only their own
kinds); and streamed transparent meshes must sit out the render precompile —
a water pipeline built off-frame binds a placeholder depth texture whose
sample count never matches the multisampled scene pass, and every later frame
fails validation (6,400 errors per probe, and no water drawn). They compile on
first draw, as the ocean plane always has.

### Roads that follow the ground, and trails up the peaks

Two causes of the mounds, both in the CLI (`tools/worldgen-routing.mts`):
the profile was solved at a handful of simplified control points and became
one straight ramp above the ground between them, and the 3D simplifier's
height weight was divided by the grid step, which allowed ~5 m of profile
error between points. The profile is now solved on the DENSE route (every
grid step) by alternating projections — grade clamp both ways, then fill
capped at ~1 m and cut at ~5 m, repeat — so the road hugs the terrain and digs
into the uphill side. Control points keep every half-metre of profile change.

The route search costs grade far above distance (a slope is switchbacked,
not climbed), treats the sea and lakes as walls, charges a toll that grows
with a river's width (a brook is crossed anywhere, a broad river only where a
bridge is worth it, and running *along* a river pays every step), and
multiplies swamp cells. Wide rivers were walls once and a town on a peninsula
behind one became unreachable.

`worldgen trails` routes a footpath from the nearest point of the road
network — on the SAME landmass — up to each peak POI, allowed a steeper grade
and a narrower cut. That is what makes a mountain climbable on purpose: the
ridge you can walk is the one the trail found, and the faces it avoided stay
cliffs.

### Scatter that respects size

`footprint` (model units, scaled per instance) and `spacing` on every rule:
two props come no closer than the sum of their footprints plus spacing, rules
are solved largest-footprint first whatever the array order, and candidates
from a margin around the cell are solved too (and discarded) so a prop just
over the border claims its ground here as well. Both cells evaluate the same
neighbours in the same global order; a dependency chain longer than the
margin can, rarely, cost a prop at a seam — it never doubles one.

### Reading the result without a browser

`worldgen map` now draws water at every level, the world limit, trails,
waterfalls, and `--zones` colours by zone; `worldgen stats` sweeps the land
for the zone and biome mix, the height percentiles and the feature counts, and
meshes real land cells spread across the world. On the demo (13.2 km across,
2 m voxels): 8.6 ms/cell to mesh, 8.6 ms to scatter with 18 props/cell — the
scatter cost roughly doubled with the margin and the water check, and it runs
in the worker pool.

### Rivers, second pass: cut, painted, tapered, clipped

The first walk along a river found four things at once, and each is now a
recipe field or a rule rather than a number somebody remembers:

- **Not sunken.** The bed was 60–100% of a 1.6–6 m depth below the FILLED
  surface with a bank blend of `width x 1.8`, which is a dish. Depth is now
  2.4–8 m, the full depth from the first point, and the bank is `width x 0.9`:
  a channel that is cut, with a bank you can see.
- **Grass in the water.** The grass billboards gate on the grass SURFACE, and
  a channel cut through grassland is still grass to the splat. Rivers now
  paint their bed and banks (`river.surface`, default sand) through the same
  segment-bucketed painter roads use, and the cover sampler also refuses any
  point under `field.waterY()`. Two fixes because they answer two questions:
  what the ground is, and whether it is dry.
- **Starting at full size in a field.** `river.taper` grows the head from a
  trickle over its first metres (220 in the demo): width, bank and cut all
  scale with one smoothstep of distance along the channel, and the water
  ribbon starts half-way through the taper so it never overhangs the trickle.
  The along-distance rides on the segment buckets, so it costs nothing.
- **Trees cut into the bank.** `featureClearance` for a river was measured
  from the bed's edge; a 4 m clearance put a tree on the bank slope. It is
  now measured from the bank's foot.

And the z-fighting: each cell's ribbon carried one control point PAST the
cell edge for tangent continuity, so two cells drew overlapping transparent
strips at one height. Ribbons are now clipped exactly to the cell
(`clipPolylineToRect`), ending on the border at the same interpolated point
the neighbour's run starts on.

### The in-game map (M)

`worldgen map` also writes the overview into the project's `assets/maps/`,
and the playground draws it full-screen on **M** with the recipe's towns
labelled, peaks and waterfalls marked, a 1 km scale bar, the nearest town's
distance, and the player's position and heading (`src/world-map.ts`). It is
the same picture an agent reads, put in front of the person walking the
world, so "the river north of town-9" means one thing to both. Re-run
`worldgen map` after any stage that moves a feature; the overlay reads the
PNG and the recipe fresh each time it opens.

The map is navigable and it is a dev-mode fast-travel: the wheel zooms
about the cursor (to 32×; POIs get their names from 8×), drag pans, `0`
resets, and a **click travels there** — the player body in play mode, the
editor camera otherwise, with the status line reporting the cursor's world
coordinates and its distance from you. The ground height comes from the
recipe field, and in play mode the body is pinned a couple of metres above
it until a raycast finds the destination cell's collider (streamed on
demand, usually within a frame or two, 8 s timeout): a dynamic body dropped
into a cell that has no collider yet falls straight through the world, the
same trap as a buried spawn. Travel is refused, with the reason on the map,
outside the world limit and when a dedicated server owns your position.
The PNG's own resolution bounds what zoom can show — `worldgen map --size
1800` is the default the demo ships with, 12 m per pixel.

### POIs at open-world density, and a bigger, more varied world

The first POI stage found summits and little else, so the map's markers all
sat in the mountains. `worldgen pois` now reads twenty-odd KINDS off the
terrain where each naturally occurs — saddle, overlook, ridge, cove,
lakeshore, oasis, bog, spring, ford, bridge-site, glade, grove, hollow,
dune-field, mesa-top, meadow, canyon-floor — plus SITE kinds for prefabs to
come (ruin-site on a hilltop, camp-site beside a road, watchtower-site on a
hill near a road, mine-site at a cliff foot). Each kind has a quota, a score
and its own separation; `--per-km2` (default 9, about Skyrim's 24 per
square mile) sets the total. Kinds other stages own (falls, cave,
spire-field) are kept. Tags carry the zone and the reason (`cliff-edge`,
`near-road`, `crossing`, ...), so a later prefab stage can filter on them.
Trails now cap at the highest `--max` peaks; a trail to every one of 140
summits would be a road network.

Zones grew from eleven kinds to sixteen: `peaks` (relief 1.35, colder),
`foothills` (0.55), `moor` (heath highlands), `fen` (cold wetland) and
`savanna` (hot dry grass), with heavier mountain weighting so each region
gets its own ranges. Swamp and fen lakes carry their own water material
(`lake.material`, written by the river stage as `<waterMaterial>-swamp`:
murky, near-opaque, no depth fade, no foam), because a bog pool you can see
the bottom of is a tarn. Towns default to one per ~3 km² of land.

The demo world is now a 21 km circle: three continents and three islands,
42.5 sq mi of land, 39 towns, ~1,050 POIs, 65 rivers, 44 waterfalls. At
that size the hydrology grid is 1,340² cells and the whole pipeline runs in
about four minutes; meshing cost is unchanged per cell (the world is bigger,
not denser), though a cell crossed by several rivers now pays for their
segments and the worst cell measured 34 ms.

### Rounded crests, a turning radius, and embankments

Three complaints from walking the first v2 world, each one a crease the
generator was drawing and the mesh could not hide:

**Every ridgeline was a knife edge.** The demo's mountains are a *ridged*
band, and the ridged fold `1 - |n|` has a slope discontinuity at every crest
of every octave — the base octave gives the summit line a corner, the fine
octaves give every shoulder a row of them. `terrain.cliffs` was off, so
this, not terracing, was "the cliffs coming to a sharp edge at the top".
`FbmSpec.crest` (recipe field on any band; `continentalWorldRecipe` sets 0.2
on the mountains) swaps |n| for the smooth absolute value
`sqrt(n² + c²) - c`, so each crest arrives on a curve. Two properties are
worth knowing: the rounded band is never *below* the sharp one (the fold is
opened outward), and it still touches the same value at the crest itself, so
the ceiling and the summit line do not move. The eroded path carries the
change through its derivative, so erosion weights stay consistent. Cost is
one square root per octave. Terracing had the same disease in its own
clamp — a riser met its tread at a corner — and `cliffs.rounding` (default
0.25) eases each riser into the tread over a quarter of its height with a C1
soft clamp; the test measures the worst second difference along a transect
and the sheer fraction, which must stay put.

**Roads looped.** The route search was cell-only, so it could reverse
direction between two adjacent 16 m cells for free, and a steep climb came
out as a stack of hairpins — 587 vertices bending more than 135° across the
demo's roads, 31 places turning 300°+ inside 120 m. Smoothing does not
un-loop a route, so the fix is in the search: `turnWeight` makes A* carry a
**heading** per cell (`(cell, heading)` states, 8× the memory, reused
between roads) and allows at most `maxTurn` × 45° of bend per cell. The
minimum radius that falls out is `step / (π/4)` ≈ 20 m on the 16 m grid; a
hairpin is four bends over four cells and costs `4 × turnWeight`, so it is
taken only where the grade would cost more. The heuristic stays admissible
(every step costs at least its run), so this is the optimal route for the
new cost, not a rounded version of the old one. The cure for *trails* was
the same radius as roads: two bends per cell was tried first and every
remaining loop in the world was a footpath corkscrewing up a peak. After:
0 sharp vertices, 0 hairpins, 0 loops, worst 120 m window 221° (a rounded
switchback), network +4% longer. Each search still runs in well under a
second. The dense route is then rounded in plan (`smoothRoute`, two
`[1 2 1]` passes, points kept if the rounded position is a wall) *before*
the profile is solved, so heights are taken where the road actually runs,
and the 3D simplifier's plan tolerance dropped from 0.45 to 0.25 cells so a
curve keeps enough points to read as one at road width.

**The ground beside a road stayed jagged.** The shoulder used to blend the
road height into whatever crinkle the noise had put there, so a road across
rough ground was a notch in jagged terrain. Blurring the natural height per
vertex would have cost 4× the dominant term in a road cell (`height()` is
~4.6 µs), so the smoothing is done at generation time instead: `worldgen
roads` samples the (five-tap blurred) ground at the outer edge of a
`smooth` band on each side of every control point and writes it into the
doc as `leftY`/`rightY`. The field then regrades the ground from the road
edge out to `shoulder + smooth` as one S-curve from the road surface to the
side height — a cut slope uphill, a fill slope downhill — and lets the
natural roughness back in only over the outer half of the band, where it
blends between two heights that already nearly agree. Zero extra height
evaluations per vertex; measured 12.2 → 12.4 ms/cell, same triangles.
"Left" is the positive cross-product side of the travel direction, and the
generator and the field agree on that by test. A doc without the two edge
arrays gets the old shoulder blend, so existing worlds are unchanged.

### Water and roads, from nine screenshots

Derek walked the world and sent photographs; each one was a rule the
generator was breaking. In the order the fixes matter:

**Fins along every climbing trail, and a wall down every switchback.** The
carve interpolates a road's per-point heights along whichever segment is
nearest, and on the *inside* of a bend two segments are equally near along
the bisector. Their projections sit on different parts of the road, so the
interpolated values differ — by about `2·d·sin(θ/2)·grade` at distance `d`
from a bend of `θ`, i.e. 4 m at 14 m out on a 20 % trail turning 90° — and
the hard switch between them was a vertical crack in the ground growing
with distance from the road: a row of triangular blades on every
switchbacking climb (the "sawtooth mountain"). The same seam between a
switchback's two legs — one leg's *left* embankment height against the
other's *right* — was the sheer wall between them. `nearestPerOwner` now
keeps the runner-up segment per feature and blends values toward the mean
where the two are within a span of each other; the span grows with distance
from the feature (so does the crack) and with the size of the disagreement
(so the blended bank stays walkable). Straight runs are untouched: the
runner-up is far behind. Test: a transect across the bisector at 14 m, worst
step under 0.5 m where it was 4.

**A 57 m corridor for a 7 m road.** Shoulder was `1.25w + 2` and the
embankment band `1.5w + 4`, so the "clean slope from road edge to sampled
side height" was, on any hillside, a planar cut face thirty metres tall
with the dune texture on it — the giant smooth wall in the river photos.
Now `0.5w + 1` and `w + 2` (a 15 m corridor for the default 6 m road, 9 m
for a 2.4 m trail; `--width` on `roads`/`trails`). Roads are a bit narrower
because Derek asked, and because the band scales from the width.

**Cut-throughs.** The route cost only *penalised* grade, so wherever a
detour cost more than the penalty the search took the steep step and the
profile solve then trenched through the spur (5 m cut cap, but the final
grade clamp wins). `RouteOptions.hardGrade` is a wall, not a cost:
`routeWithGradeCap` tries 1.5× the design grade, then 2.5×, 4×, then none,
and logs a road that needed relaxing. The ENDS are exempt (`hardGradeExempt`:
town pads plus their ramps, and 2 cells round a road's ends / 4 round a
trail's), because a pad edge is a 17 % step on a 16 m grid and a summit's
last cone is steeper than any trail — without the exemption the cap failed
on 39 of 40 trails and 23 of 39 roads and every one of them fell back to
uncapped. With it: 15 of 39 roads route at 1.5×, 24 need 2.5× or 4× (a
ridge with no pass gentler than that between the two towns — the log names
them), none is uncapped; 36 of 40 trails route capped. Road points cut
deeper than 8 m went from 646 to 32 (worst 302 m → 14 m). A town centre is
always made passable first: a pad the widened waterline had wetted was a
wall the search could not step into, and the road was silently missing. Contouring a cone at a fixed grade *is* a spiral, which is the
"follow the outside of the mountain up" Derek wanted; it falls out of the
cap plus the existing turning radius, nothing is drawn. Trails had a
second, worse cut-through of their own: the profile solve's LAST pass is
the grade clamp, and a summit cone is steeper than 22 %, so every one of
the demo's forty trails ended in a trench 100-300 m deep dug into its peak
so the last leg could stay at grade. `solveProfile` now takes `finalClamp:
"cut"` (trails use it): the cut/fill clamp wins at the end and the footpath
simply steepens into a scramble where the ground does.

**Roads next to and across water.** Three separate bugs. (1) The embankment
band reached into lakes and rivers and *raised* the water's bed toward the
road's side height — a pale triangle of lake floor standing out of the
water beside every lakeside road, and river banks regraded into beaches.
`applyFeatures` now tracks `wet` (1 inside a lake outline or a river's
waterline, fading up the bank) and towns and the road band beyond the
shoulder are weighted by `1 - wet`; the roadway and shoulder are kept, which
is what a ford is. (2) A road crossing a river followed the carved channel
down (fill capped at 1.2 m, cut allowed 5 m) and crossed under two metres
of water, sand strips disappearing into the river. `solveProfile` takes
per-point pins (`pinned.at`) and `roadFrom` pins every submerged point to
`waterY - 0.4` — the water is sampled a few metres around each point so the
drowned part of the bank counts too. A crossing is now a wadeable bar with
the river's own bed either side of it. Bridges are content, not terrain, and
still to come. (3) Roads ran along river banks because bank cells cost
nothing extra; `routeGridFor` marks cells within `width/2 + bank` of a
channel at ×1.6, so a road keeps off the bank unless it is crossing.

**Rivers stepping *up* into lakes and the sea.** Every bed is monotone (the
check counts uphill steps: 0 of ~950), but the *surface* is `bed + 0.7 ×
depth`, and through a lake the bed ran a full depth under the lake level,
so the river's surface arrived 0.3 × depth *below* the lake it was flowing
into; at the sea mouth the bed went to `seaLevel - depth - 1` and the sea
stood 1–3 m above the river; at every confluence the shallower tributary's
surface sat a metre above the trunk's. Now the *surface* is what meets the
receiving water: through a lake the bed is `level - 0.7·depth - 0.15`, at
the sea `seaLevel - 0.7·depth - 0.3`, and a tributary's last point is set
from its parent's bed and depth (`bedOf`/`depthOf` per cell; parents are
always traced before their tributaries). The 15–30 cm is so the ribbon slips
under the receiving sheet instead of z-fighting it.

**Rivers were the D8 walk.** Straight runs joined by 45° corners, at one
width. `meanderChannel` swings the traced cells sideways on a wave along the
arc length (wavelength `max(140, 11 × width)`, the classic ratio, plus a
shorter wave so no two bends match; `--meander` in channel widths, default
3, capped at 60 m), perpendicular to the smoothed tangent, damped where a
river would not meander — steep grade (a torrent cuts straight; fades
between 3 % and 12 %, wider than the textbook because this world's rivers
drop 5-7 % over most of their length and the textbook window left only the
last reach before the sea bending), the tapered head, the last cells before
the mouth, inside a lake. The bed heights are *not* moved (they came from
the filled surface and stay monotone), so a swing into a hillside is a
deeper cut — an outer-bank bluff; each offset is halved until the ground
there is within `--bluff` depths of the bed (3.5), and two `[1 2 1]` passes
round the grid corners. The stage prints what share of the requested swing
survived the hillside check (83 % on the demo). Widths are now per
point (`widths`, interpolated by the carve, the clearance and the ribbon):
they grow with the catchment (`0.55 + 0.45·√(acc/mouth)`), swell 12 % at the
apex of each bend, wander 14 %; `width` stays the widest, because the field
sizes the carve's reach from it.

**The water sheet stopped short of the shore.** The ribbon was `1.25 ×
width` — the flat bed plus a little — but the bank rises over `bank` metres
and the surface (0.7 of the depth up) crosses it about 0.63 of the way out,
so the sheet ended in mid-air over a dry strip of sand and the waterline
was a hard straight edge. It is now cut to the waterline: `bed width + 1.3
× bank` per point (the `path` mesh source takes `widths`, interpolated by
control-point parameter, so a ribbon can vary along its length), clipped
across cell seams with the width interpolated too. Past the waterline the
bank hides the sheet, which is the shoreline for free. `waterY` reports
water out to the same line, so scatter and the ford pins see the drowned
bank as water.

**Lakes with straight sides.** `simplifyLoop` capped a lake's outline at 56
points and let the tolerance climb to reach it — dozens of cells on a big
lake — so the polygon cut straight across bays and headlands, and everything
inside it was carved to the water: a hillside truncated by a wall where the
real shore curved away (the dark cliff behind the first lake photo). Cap is
now 160 (`--lake-points`) at 0.6 cells. `lakeDistance` is bucketed per lake,
so the cost is only paid in cells the lake's bounds touch.

**The sheet still stopped short of the shore** (second screenshot, standing
on a tarn at 240 m: the ground went under the lake level 14 m out, the
sheet began at 24). A basin's cells were the ones holding at least
`minDepth` (1.2-1.5 m) of water, so on any gentle shelf the outline stopped
where the water was still knee-deep, and the footprint of a drained basin
stopped 0.3 m under its surface. `extractBasins` now grows each basin
through the SHALLOWS (neighbouring cells the same surface covers by 0.2 m or
more that are not deep cells of any basin — a small basin spilling into a big
drained one shares its surface level, and walking into the big one's deep
cells re-flooded the emptied bowl at the spill level, nine metres over a town
that had been sited on its dry floor) before tracing the outline — `Basin.deep` keeps the deep-cell count,
which is what the drain test sizes by, or every lake with a shelf would have
been drained — and `chunk.ts` pushes the outline out by half a bank
(`offsetPolygon`, mitre-capped) so the carve's own rise through the surface
hides the edge. `waterY` reports a lake over the same half-bank band; its
callers all compare the ground against it, so the dry part of the band stays
dry — the route grid included, which walls only cells whose ground is under
the reported surface (walling the whole band cut six lakeside towns off). After: the sheet begins 13 m out, the ground goes under at 14.

Still open from the same photos: the jagged white staircase where the lake
sheet meets the voxel bank is the marching-cubes resolution itself and wants
a shoreline fade in the water material, not a carve change; wide rivers
would rather have a bridge prefab than a ford; and towns/POIs were re-sited
after the rivers moved, so any hand-placed spawn near water wants
`place-spawn` re-run.

### The full palette, and props from one grouped export

Derek's texture and prop drop (2026-09-03): eight ground textures to fill
the sixteen slots, and one glTF holding every prop on a shelf. What it took
to fold them in:

**One file per prop.** `tools/split-gltf.mjs <group.gltf> <outdir> [--skip
A,B] [--rename Old=New]` cuts a grouped export apart along its root nodes.
Each output carries only the meshes, accessors, buffer views, materials,
textures and images its node touches, re-packed into a fresh embedded buffer
(4-byte aligned), with the root's translation zeroed so the prop stands at
its own origin — the group's layout was a shelf, not authoring. It prints
each model's bounds, which are what a scatter rule's `footprint` and
`colliderSize` want. Skinned nodes are refused (props only). Eleven props
came out of the first grouping; `RockClif` was renamed to the `RockCliff`
the scatter rules already used.

**Wind by name.** The ask was "anything with Leaves in it sways".
`wind.materials` (mesh component and scatter rule alike) moves only
materials whose own name, or whose colour texture's name, contains the
string, and skips the canopy height test for them — the leaves are chosen
by name. The trap: Blockbench exports an unnamed pasted texture as literally
`pasted`, and that is what every texture in this drop is called, so
`materials: "leaves"` matched nothing. Name the texture (or the material)
in Blockbench before export; until then the canopy height rule is what
moves a tree, and a rule that sets `materials` gets no wind at all on an
unnamed model — deliberately, because silently falling back to height would
hide the naming mistake.

**Sixteen surfaces.** The demo palette is now the full `MAX_SURFACES`:
`drygrass`, `gravel`, `moss`, `leaflitter`, `peat`, `wetsand` after the
preset's ten, `mud` and `redrock` finally on their own textures. The
preset's biome rows are ten wide and the field pads them, so widening the
palette breaks nothing; `gen-world.mts` then REPLACES the ground row of the
biomes that want the new layers, by name (`groundByBiome` → `weights()`).
Rivers paint `gravel` and lakes paint `wetsand` on their beds and a ragged
`shore` band (`LakeDoc.surface`/`shore`, painted like a road verge) — the
rivers stage picks the first of `gravel`/`sand` and `wetsand`/`sand` the
palette has, so a world without them still paints something. Cost: mesh
14.0 → 15.6 ms/cell; the fragment side is 48 triplanar fetches, which the
budget section above says to watch in the profiler rather than predict.

**Sixteen bindings do not fit.** The first headless run with the full palette
failed the terrain pipeline outright: `The number of sampled textures (20)
in the Fragment stage exceeds the maximum per-stage limit`. WebGPU
guarantees 16 sampled textures AND 16 samplers per stage; this adapter
allows 48 textures but still only 16 samplers, so asking for higher limits
does not help. The answer §21 already named is now built: past
`SPLAT_ARRAY_THRESHOLD` (8) albedo maps, `terrain-splat.ts` resamples every
layer to one square size (largest edge present, capped at 1024) through a
canvas and stacks them into a `DataArrayTexture` — one binding, one sampler
however deep — and `sampleTriplanarLayer` fetches a slice by index. Fetch
count per fragment is unchanged; binding count is what this fixes. Normal
maps keep the per-map path, so a deep palette cannot also carry them. If
packing throws (no canvas) it warns and binds separately, which will fail
the pipeline the old way rather than silently render nothing. The packed path COMPILED and props streamed, but the ground rendered BLACK:
a probe of the terrain material found no texture nodes in its colour graph
at all, with no warning logged, and the cause was not found before the
session ran out. `SPLAT_ARRAY_THRESHOLD` is therefore 12, and the demo palette is ELEVEN —
twelve separate maps measured 17 sampled textures in the fragment stage
(shadow map, noise and the rest take five), so eleven is the true cap for
the per-map path — with drygrass in the never-weighted `ice` slot so the
preset's positional rows still line up. Cut: peat, leaf
litter, moss and the borrowed wet sand are out until the array path is
debugged. Next step for whoever picks it up: `loadLayerTextures` never
reaches `wireSplat` with textures when packing is on (the `[render] packed`
info line never printed), so instrument from the `requests` list down.

**Seven scatter rules** for the new props (dead dried tree, dry brush,
stump, root, mushroom, palm, hoodoo), sized from the printed bounds, zoned
by biome id. Scatter went 10.7 → 16.8 ms/cell — that is cell LOAD time, not
frame time, but it is the number to trim next (the margin solve and
`waterY` per candidate, as before).

### Water that connects: seams, lakes, outlets and a current

Four complaints from walking the demo after the previous round, and what
each turned out to be. Verify a world with `worldgen rivers` and the audit
pattern at the end of this section before believing a screenshot.

**Gaps along every cell seam of every sheet.** The water shader phased its
waves by the mesh's LOCAL x/y and lifted vertices along local z. That is
right for the one big ocean plane (rotated flat, local z = world up) and
wrong for every per-cell lake sheet and river ribbon, which are authored
flat in local XZ: their "local y" is constant and their "local z" is
HORIZONTAL, so every sheet slid sideways by its own phase and two
neighbouring cells slid by different amounts. Waves are now phased in
WORLD space and applied along the surface's own normal (`normalLocal`), so
sheets streamed in separate cells agree to the millimetre along a shared
edge, and a falling ribbon is displaced across its face instead of through
it. The analytic normal is built in world space and taken into view space
through `cameraViewMatrix` — `normalNode` is a VIEW-space normal, and the
old code fed it a local one.

River ribbons had a second seam of their own: each cell's run was clipped
exactly to the cell, so the Catmull-Rom tangent at the run's end was
extrapolated from that cell's points alone, and the two ribbons met at one
point with two side vectors — edge vertices up to half a width apart. The
`path` source now takes `trim: [start, end]`, spans left undrawn whose
control points still shape the curve, and `voxelChunkDoc` hands every run
the point beyond each of its ends as a phantom (`clipPolylineToRect`
reports the segment each run starts and ends on). The end samples are
evaluated at the control-point PARAMETER (`getPoint(k / spans)` is exactly
`points[k]`), so two pieces share the point, the neighbours and hence the
tangent, width and side vector. `test/path.test.ts` welds two pieces of a
bending river to three decimals.

**Rivers not connecting to lakes.** Three separate faults:

- *A drained lake could sit below the lake it drains into.* Draining
  lowered a big basin to `floor + lakeFill` regardless of what waited
  downstream; where that floor was under the next lake's spill level the
  river between them ran uphill (one arrived 24 m under the surface of the
  lake it entered). Levels are settled downstream-first
  (`receivingBasin`/`settleLevel`): a drained lake sits at least 1.5 m over
  the lake or sea its outlet reaches. The stage prints how many were held
  up. Consequence: lakes that used to be drained into a puddle are lakes
  again, and towns sited on their old dry floors are under water until
  `worldgen towns` (and then roads/pois/trails) is re-run. **Always re-run
  the town chain after rivers; check `waterY` at every town centre.**
- *Tributary mouths missed their parent by up to 60 m.* A tributary was
  traced to the grid cell its parent flowed through, but the parent had
  since been swung sideways by its meander. The last point is now moved
  onto the nearest point of the parent's swung polyline and its bed read
  off the parent's there (`nearestOnSwung`).
- *Outlets started as a trickle out in the water.* A channel whose source
  cell lies under (or one cell beside — the polygon is refined onto the
  real shoreline, which runs through that ring) a lake is that lake's
  outlet: it is trimmed to start one cell inside the shore, at full width
  (`taper: 0`), at the lake's surface.

Beds are now solved from the MOUTH upward — each bed is at least the one
below it — so a river approaching a lake across a flat arrives flush with
it instead of sliding in a metre under (solving downward could only lower
a bed, never lift the approach). From the first cell under drawn water
onward the bed is CAPPED at that lake's flush level, which is what cuts a
drained basin's outlet down through its sill; without the cap the
mouth-first solve lifted the whole lake reach up to the sill. Inside a
drained basin's dry bowl, upstream of the water, the bed follows the
ground down instead of dropping to the lake in one step at the basin's
edge. The audit after the rewrite: 0 uphill bed steps, every confluence
within 5 m of its parent and 0.2 m under its surface, every inlet and
outlet within 0.3 m of the lake, no dangling mouths.

**Strange geometry around lakes.** The polygon is an outline traced on a
16 m grid and simplified, right to within a cell or two — and the field
carved FROM it: everything inside dug to `depth`, a bank outside pulled
down to the waterline. Where the outline overshot onto a hillside that was
a crater with a vertical wall at the polygon edge and a terrace at water
level beside it. Two changes:

- `worldgen rivers` slides every outline vertex along its outward normal to
  where the field actually crosses the water level (`refineShoreline`,
  bounded by a cell and half the distance to each neighbour), so the
  polygon is the shoreline of THIS terrain.
- Lakes it writes carry `carve: false`: the terrain already holds the
  basin the hydrology found, so the field only DEEPENS ground that is at or
  under the surface (blended over two banks into a bowl, minimum 0.6 m of
  water at the shore) and leaves anything standing more than a metre and a
  half above it alone — an island, or an outline that strayed uphill; the
  sheet is drawn half a bank past the outline and buries itself in it.
  Nothing outside the outline is carved any more. Hand-placed lakes keep
  `carve: true` (the default) and dig the basin outright, because an author
  who drops a lake on a plateau means a lake there.

**Brush standing in the water.** Scatter refuses ground under `waterY`; it
now also refuses the 35 cm above it, and the refined outline means the wet
band (`waterY` reports half a bank past the polygon) follows the real
shore. The ground-cover layers already kept 25 cm.

**Bright sheets of water hanging in a dark sky** with no land under them
(the screenshot that opened this round) were not missing terrain — every
far-ring supercell carried its terrain, checked from a headless probe. The
scene's height fog dissolves distant hills into the sky colour, and the
water's fresnel rim was a fixed near-white, so at dusk the sheets glowed
where the land had gone dark. The rim is now multiplied by
`horizonTint` (atmosphere.ts), a uniform the fog system sets to the fog
colour: a reflection of the sky it is supposed to be.

**A current.** `riverMaterial` on the recipe names a second water material
that `worldgen rivers` writes beside the standing one:
`<waterMaterial>-river`, `flowMode: "channel"`, a `<Name>Flowing` sibling of
the base texture when the project has one, at a 7 m tile. River ribbons
carry `flowSpeed` (0.9 m/s on the flat, up to 3 on a steep reach, from the
bed grade), `uvMetres` and `uvAlong` (distance along the whole river, so
the texture is continuous across cell pieces), and the ribbon builder
emits a per-vertex `flow` attribute — tangent times speed. In channel mode
the shader measures its waves along the ribbon's metre uv and scrolls
texture and foam down it at the vertex's own speed: the water runs
downstream, round the bends and over the falls. Standing water keeps
`drift` mode. Do not put a channel material on geometry without the
attribute (three warns and substitutes zeros; the editor's material
thumbnails do exactly that, harmlessly).

**Draw calls.** A lake is emitted as one sheet per streamed cell, and the
far ring used to render every one of them un-merged — a hundred transparent
draw calls for a big lake. Single-material poly meshes now merge into the
HLOD proxy like polygons (the world-space shader makes merged sheets shade
exactly as separate ones); polys with material slots or face colours still
defer.

Audit pattern (a scratch tsx over the recipe with `createWorldField`): for
each river, classify its last point — sea (natural ground under sea
level), lake (inside a polygon: surface vs `waterY`), confluence (within
12 m of another river: surface vs the parent's), else DANGLING; count
uphill `bedY` steps; for each river starting inside a polygon compare its
first surface with the lake; for each town compare `waterY` at the centre
with `groundY`. Every number in this section came from that script.

### Rivers first: the network decides the land

Six rounds of patching water onto a noise heightfield ended with a world
where 41 of 57 rivers ran straight to the sea, 5 ended in a lake, and 45
of 64 lakes had no river at all — ponds the drainage never visited, every
one of them 10–13 m wide. The audit that produced those numbers is now a
command (`worldgen audit`), and the pipeline was turned round: **the
channel network is computed first and everything else answers to it.**
This is the hydrology-first approach from Génevaux et al. (2013) adapted
to a recipe-as-truth engine — the recipe still stores features, not a
raster, and the field still derives the ground from them.

**Lakes are nodes on the tree.** `worldgen rivers` still fills depressions
and traces channels above a catchment threshold (now 0.12 km², so brooks
exist), but a depression becomes a lake ONLY if a traced channel runs
through its cells. The outlet channel leaves it, so every lake written has
a river leaving it, and most have one arriving. The biggest `--lakes` (48)
of those are kept as water. Every other depression on the network is
written as a **fill** (`features.fills`): its outline at its spill level,
and the field RAISES the ground inside to that level (never lowers it), so
the river cuts its channel through a flat valley floor instead of a chain
of ponds. Depressions the network never crosses stay what they were, dry
hollows in the ground. The stage prints the split: "316 depressions, 135 on
the channel network", "48 lakes, 87 filled to valley floors".

**A river builds as well as cuts.** The field used to hold "a river cuts, it
does not build", and wherever a bed ran above the ground — across a hollow
the fill had raised, along a slope the meander swung it onto — the ribbon
floated over a pit with dry ground under the waterline. Inside the channel
and its banks the ground is now pulled UP to the bed too (`RIVER_MAX_BUILD`
= 10 m caps it: sediment fills a hollow, nothing builds a dam), taking the
LOWEST bed among overlapping channels so a tributary never builds a sill
across the river it joins, and never under a lake's sheet. Fills yield to
lakes the same way: two basins' shallows can overlap, and a fill raised
inside the neighbouring lake stood out of the water as a grey sliver.

**One width law for the whole tree.** Width at every channel cell is
`2.5 + 6.5·√(catchment km²)` clamped to 2.5–30 m, depth `0.9 + 0.2·width`
clamped to 1–6.5 m, both written per point (`widths`, and the new
`depths`). A brook at the threshold is 5 m wide and a metre and a half deep;
the trunk draining sixteen square kilometres is thirty metres and six deep;
width jumps at every confluence by exactly what the tributary brought. The
bank follows the LOCAL width — `riverBank()` in field.ts, `min(bank,
0.7·width + 3)`, used by the carve, `waterY`, `featureClearance` and the
ribbon alike — because a 3 m stream must not get the banks of the river it
becomes. The water surface sits 0.7 of the local depth over the bed
everywhere the depth is read (field, chunk ribbon, audit).

**Drained lakes sit on their river.** A basin over `--max-lake` is still
drained to `floor + lake-fill`, but the floor is now the lowest ground the
CHANNEL crosses inside the basin and the wet footprint is grown from that
cell (`basinFootprint(…, seed)`), not from the basin's deepest side bowl —
16 drained lakes had water where no river ran. A drained level is bounded
below by the filled surface at its outlet's mouth (`outletMouthFilled`): the
outlet's bed is solved from that mouth upward, so a lake lowered under its
confluence got an outlet that left it fourteen metres above the water. And
never above its own spill level: a lake that cannot drain below what waits
downstream simply is not drained.

**Roads cross on bridges.** In `roadFrom`, every dense route point within
the waterline of a river at least `--bridge-min` (6 m) wide is a crossing;
each run of them, extended one point onto each bank, is a **bridge**: the
profile over it is pinned to a deck height (the lower bank, at least 1.2 m
over the water), the road doc is SPLIT at the two abutments (`road-a-b`,
`road-a-b.2`, …) and a `features.bridges` entry records abutments, width,
`deckY`, `waterY` and the river. The water underneath is untouched — a road
carve there keeps the roadway and shoulder even in water (that is a ford),
and over a real river that is a dam. Streamed cells emit a placeholder deck
(a `path` slab with a trimesh collider, in `recipe.bridgeMaterial`, a plain
timber colour written by the stage) and box piers every eight metres down
to the bed, so the crossing is walkable the moment it streams in; the WFC
bridge builder replaces them by reading the feature — the abutments and
`deckY` are its contract. A crossing at either end of a route (a town on
the bank), or a run longer than eight points (the road following the bank,
not crossing), stays a ford. Narrow brooks stay fords. Trails get
footbridges by the same rule.

**Ribbons stop at the shore.** Where a river runs through a lake its ribbon
used to run under the sheet — a second water surface a hand below the first,
and the two wave patterns crossing drew a bright line along every sheet
edge. `waterEntities` now cuts the line into pieces at the sheet's edge
(the outline plus half a bank, found by bisection along the entering
segment) and ends each piece two and a half metres under the sheet.

**Stage order and the audit.** `all` now runs canyons BEFORE rivers, so the
hydrology drains through the gorges; cut after, a canyon floor under a lake
outline flooded 90 m deep. The rivers stage samples the world WITHOUT
towns, roads and bridges (they are re-run once the water moves; sampling
drainage over the old embankments made every re-run drift). After rivers,
ALWAYS re-run towns → roads → pois → trails; the stage says so when any
town is under water. `worldgen audit <world>` (exit 1 on findings,
`--verbose` for per-river/per-lake detail) checks: every river ends in the
sea, a lake, or its parent within 12 m; every lake has the network within
a bank of its outline (or reaches the sea — a lagoon); beds only descend;
outlets leave flush; no town centre under water; no road point under more
than a ford's depth; every bridge has a road ending at each abutment. The
rivers and roads stages print its one-line summary. Two things it had to
learn: a stream falling from a tarn into the lake below starts inside BOTH
outlines (pick the lake whose level matches the river's surface), and a
lake thirty metres from the coast has a thirty-metre outlet (two-point
rivers are rivers now).

**Reading the result.** `worldgen map --plain` draws terrain and water
only, rivers at their real width, no markers — at world scale the POI
squares bury the network; `--cx/--cz --extent 2200` is the scale at which
a drainage tree is legible. What the demo looked like after this round:
about a hundred rivers (55 to the sea, the rest into lakes or each other,
0 dangling), 48 lakes on the network, ~88 bridges, 0 uphill bed steps, 0
towns or roads under water.

**Cost of an outline per column.** A lake outline is up to 160 vertices, and
the field used to run point-in-polygon AND nearest-segment over all of them
for every column inside the lake's bounding box, twice (the carve and
`waterY`), plus the same again for every fill. `polygon-index.ts` rasterises
each outline once at about a hundred cells across into OUTSIDE / INSIDE /
BAND, and only band cells (within two banks of the shore) carry the handful
of segment indices that reach them; a column deep in the water or far from
the shore is one array read. The sign in the band comes from the side of
the nearest segment (outlines normalised counter-clockwise; at a vertex
the more perpendicular of the two nearest decides), and a band cell whose
point is beyond the band falls back to the cell's own inside flag rather
than trusting a partial segment list. Discs stay analytic. On the fixed
`worldgen stats` sample: 14.9 → 12.9 ms/cell to mesh, 19.4 → 16.0 to
scatter; cells at a big lake's shore gain far more. `test/polygon-index.test.ts`
checks it against the exact answer on a concave outline.

**Seeing far.** "I cannot see far, and that breaks the wish to go there." Two
settings agreed on ~650 m: `rings.farTerrain` 14 cells (672 m) and height fog
density 0.0032 (85 % opaque at 600 m). The far ring is now meshed TWICE as
coarse as the hlod ring — `FAR_VOXEL_COARSEN` 6 in the chunk manager, passed
to `buildHlodProxy` as `hlodVoxelCoarsen` for supercells whose every member
is in the far ring — so it reaches twice as far for the same triangle and
bake budget: the voxelWorld default is 24 cells (1.15 km), the demo scene 28
(1.34 km) with fog density 0.0014 (85 % at 1.35 km). Keep the two matched:
a ring ending in clear air is a cliff of missing world. And check the CAMERA:
the editor camera had a 500 m far plane (the play camera has 4000), so in edit
mode nothing past half a kilometre could draw whatever the streamer held —
the first "after" screenshot from the highest peak was pure fog for that
reason alone. It is 4000 now. In far-ring proxies the deferred water is
thinned too: river ribbons under 12 m wide and bridge decks are skipped
(`hlod-proxy.ts`, when `hlodVoxelCoarsen` is above the hlod default) — out
there a brook is narrower than its voxels, and every ribbon was a draw call. The next step, when
"a mountain five kilometres away" is wanted, is a fourth tier — one
heightfield mesh per 1-2 km tile sampled straight from `field.height`, no
marching cubes — not a longer far ring; the supercell count grows with the
square of the radius.

### Lowland water: only gentle reaches carry a sheet

Derek's two screenshots after the rivers-first round were the same fault:
a river on a 6 % slope drawn as a tilted sheet, the current streaked down
it, its straight edges hanging over the bank, and where it reached a lake
it arrived above the lake's level. The topology was right; the LAND was
wrong for rivers. This landform drops 5–7 % over most of its length, so
nearly every channel was a mountain torrent, and a water sheet on a torrent
is a wall of water. Real rivers live on floodplains under 1 %.

So `worldgen rivers` now writes one document per WET or DRY run of each
channel: a reach carries a water sheet (`water: true`) only where the bed
grade over its neighbouring points is at or under `--wet-grade` (0.02);
steep reaches are written `water: false` — carved exactly the same, painted
gravel, no ribbon, `waterY` null. Points under or beside a lake and the two
cells at a sea mouth are always wet so water visibly leaves and arrives,
and a wet run away from any lake or the sea must be three points long or
it is a puddle on a slope and is dried. Neighbouring runs share their
boundary point so the carve is continuous; only the head piece tapers. On
the demo: 198 wet reaches, 161 dry gullies, 37 mouths wet to the sea.

Lakes: `--lakes` now defaults to 16 (was 48; inland water 14 % → 10 % of
land), the rest of the on-network hollows become fills. The sheet is drawn a
FULL bank past the outline (was half): an inlet's river carve lowers the
bank band beyond the traced shore, and a sheet that stopped short of that
drew its foam edge in mid-air over water-level ground. `waterY` reports
over the same band.

The river material is softer (`waveAmplitude` 0.03, three foam steps): the
two-step foam along a ribbon's edge read as a painted white rectangle.

**Fog, actually visible.** Height fog with `heightFalloff` 0.02 was a
quarter of its base density at 60 m and nothing at all up a hill: "I don't
see fog on any geometry" was correct. The demo runs `density` 0.0018 with
`heightFalloff` 0.004 now — 85 % opaque at the 1.3 km ring from player
height, and still there on the ridges — and far-ring proxies skip scatter
props under 4 m tall (`hlod-proxy.ts`), which is where the rocks went:
prefabs of primitives cannot instance, so every rock was merging into the
far proxies as static triangles.

Still open, and honest about it: the water SHADER itself. The channel mode
streaks its texture along the ribbon on any slope and the foam is a
contour band; a proper pass wants flow-map style two-phase sampling and
depth-fade foam, iterated against screenshots. The lowland rule keeps the
sheets flat enough that the current shader is not embarrassing; it does
not make it good.

**Banks, berms and still vertices (the next two screenshots).** Water
sheets were hanging in the air over ground below the water level: on a
side slope a channel's downhill bank is naturally under its own surface,
and the carve only ever cut, so the ribbon's outer edge floated over dry
ground; a lake's refined outline sat at the waterline until a later carve
(an inlet's banks, a road) lowered the shore beyond it. The river build
target is now the channel's CROSS-SECTION — bed inside the half-width,
rising to a natural levee (surface plus 0.4 m) by the waterline at 0.63 of
the bank and held to 0.85 — under wet reaches only; the ribbon ends at 0.75
of the bank, inside the levee. Lakes hold a berm at water plus 0.4 m over
the outer half of the bank, only for lifts under 3 m (a shelf metres under
the water is something the sheet should cover, not a wall to build); the
sheet and `waterY` reach 0.75 of the bank. And the faceted streaks across
sheets were the wave DISPLACEMENT: a lake is one polygon fan and a ribbon
is two vertices wide, so lifting the few vertices tilts whole triangles.
Water materials carry `displace` now; `worldgen rivers` writes
`<water>-lake` and `<water>-river` with it off (wave normals still move,
the geometry does not) and points `recipe.waterMaterial` at the lake twin;
the ocean plane keeps the base material. Meander default 4.5 widths,
wavelength `max(110, 9·width)`.

**Bends have a minimum radius.** A sine of amplitude A and wavelength L
has a minimum radius of L²/(4π²A); a channel folds over itself when that
drops under about twice its width, and 4.5 widths of swing on a 126 m
wavelength made every tributary a zigzag of rhombus-shaped sheets at a
confluence. The wavelength is now `max(160, 14·width)` and the amplitude is
capped at 0.9 of the curvature bound, so the bends are long and sweeping —
which is what "rivers need to bend more" meant — and a ribbon never
overlaps itself.

### Rivers that bend, and rivers you draw

**Sine-generated meanders.** "They just look like straight lines" was
exactly right: a traced corridor is a run of cell centres, and offsetting
it by a sine can never make a real bend — capped so the ribbon does not
fold, a sine offset has a sinuosity of about 1.1. `meanderSine` in
worldgen.mts is the Langbein–Leopold sine-generated curve: the channel's
HEADING swings like a sine along its arc length (`--swing`, 1.05 rad, about
60°) and the position is integrated from it, in a frame that rides the
smoothed corridor (`corridor(u) + normal(u)·v`). That gives proper loops
with a bend radius of a couple of widths and a sinuosity of 1.3–1.8, and it
cannot self-intersect below a swing of ~110°. A weak spring pulls the
lateral offset back to the corridor so the bluff damping's drift never
carries the channel off; the swing damps on steep reaches, grows from the
head, holds its line into the mouth and goes straight through a lake. The
polyline is RESAMPLED (6 m steps) rather than offset, so bed, depth, width
and cell are re-read off the corridor at each point's fractional index.

**Drawn rivers.** `features.riverPaths` is authoring input: a centreline
from the editor's path tool (`worldgen river-path <world> --from-scene
<scene> --entity <id>`), from a hand-typed list (`--points "x,z;x,z;…"
--width 18`), or from an agent writing the JSON directly. The rivers stage
turns each into a channel of its own — densified to half a grid cell,
snapped to cells so every lookup works, counted for lake selection — and
solves it like a traced one, with two differences: it is left exactly as
drawn (no meander, no outlet trim), and its bed is a running MIN from the
head (a drawn river cuts down through whatever it crosses; a ridge becomes
a gorge) before the mouth rule. Width ramps from half at the head to the
author's width at the mouth unless `widths` are given. Re-running the
stage re-solves the path; the path is never touched.

**Cut banks at a slope limit.** A channel cut six metres into a hillside
eased back to the ground over the same one bank width as a channel cut a
metre into a meadow — a canal with a cliff for a bank, the "carved side
cliff a real river would never have". The cut band is now the larger of
the bank and 2.5× the cut height (capped at three banks, which is the
bucket reach), so a deep cut is a valley side at about 22°.

### Rivers are authored: lakes from the hydrology, rivers from a hand

Five rounds of traced rivers — rivers-first hydrology, lowland-only
sheets, sine-generated meanders, drawn paths — and Derek's verdict on the
result was still "not fixed". The call (2026-09-04): **take the rivers out
of the generator, keep the lakes, and have an agent carve and path the
water**, editing the world directly rather than regenerating it. The
hydrology is good at one thing — deciding which hollows hold water and
which are valley floors — and bad at the thing a level designer does by
eye: choosing where a river is worth having and what shape it takes.

**What the generator does now.** `worldgen rivers` computes the channel
tree as before, uses it to pick the lakes (a basin is a lake only if the
tree runs through it) and to fill the other hollows to their spill level,
and writes NO rivers. `--trace` carves the traced network the old way;
`features.riverPaths` still solves into rivers for anyone who wants the
path tool's output solved by the stage. Rivers already in the recipe that
carry no `bedY` are hand-written and survive every re-run untouched.

**What a hand-written river is.** A `features.rivers` entry with `points`
(head first), `width`, optional `widths`/`depths` ramps, `depth`, `bank`,
`maxGrade`, `water: true`, a `surface` — and NO `bedY`. The field solves
the bed when it is created (`solveRiverBeds` in field.ts), so the recipe
edit is the whole change: save the file with the dev server running and
the world carves, banks and waters the river in place. The rules:

- the points are resampled along a centripetal Catmull-Rom spline through
  them (the curve the ribbon draws), a few metres apart, so a river written
  as thirty control points carves as a curve, not a polygon;
- the bed is the ground the river crosses (canyons, fills, lakes and every
  river solved before it applied; towns and roads NOT — a river cuts a
  road, the road does not lift the river) less the local depth;
- from the first point within a bank of a lake onward it is capped at that
  lake's flush level, and held AT it inside the lake band: an outlet
  leaves flush with its lake, an inlet arrives flush;
- on a river already solved it is flush with THAT surface: a tributary
  listed after its trunk arrives at the trunk's level, not a channel depth
  under the trunk's bottom (the first version cut a hole in the trunk);
- running MIN from the head — a drawn river is a decision, it cuts a ridge
  in its way rather than climbing it — then the mouth: a hair under the
  sea (every point whose ground is under the sea targets the same level,
  so an offshore tail is where the ribbon slips under the ocean plane and
  not a reason to chase the seabed twenty metres down);
- then `maxGrade`, mouth up: wherever the bed would drop faster than the
  limit (5 % by default) the reach ABOVE is cut down to it, never under a
  lake. This is what turns the coastal scarp every continent here ends in
  into a gorge instead of a slide.

That last rule is the honest trade. This world's shore profile is a
40–50 m cliff on every coast, so every river has to lose that height in
its last few hundred metres; the traced generator dodged it with dry
gullies to the sea. A 5 % limit makes the last ~900 m of a river a gorge
whose walls reach 25–40 m at the cliff — a water sheet tilted at 5 %, fast
current, which is what rapids through a gorge look like. 2 % would be a
2 km canyon. Whoever draws the river decides; the schema describes both.

**The author's tools.** `worldgen descend --from-lake <id>` (or `--from
x,z`) walks the hydrology's downstream chain from a lake to the sea or the
next lake and prints the valley floor as a table and a `--points` string;
`worldgen profile --points "…"` samples ground, grade and the ground a
bank width to either side along a candidate (`steep`, `side slope`,
`UPHILL`, `under water` flags and a summary); `worldgen profile --river
<id>` reads the SOLVED bed of a river in the recipe the same way. The
loop that produced the three demo rivers: descend → pick the corridor →
write control points that follow it loosely with bends of a few widths
(cut the grid's corners, keep off the hillside side of a valley) →
profile → adjust → `audit`. A lake with no river is a note, not a finding,
in a world whose rivers are all hand-written.

**Roads.** A hand-written river across an existing road is a ford (the
roadway is kept even in water) — a 50 m wall of road across a gorge until
`roads` is re-run, which splits the road and writes the bridge. So the
chain is still: rivers (yours) → towns → roads → pois → trails.

**What the first three rivers showed.** lake-4 → west coast (2.4 km),
lake-8 → into it (2.6 km, the confluence), lake-7 → south coast (2.8 km).
Lake outlets on this terrain are lips — the drained lakes sit perched a
few metres over the plateau outside — so an outlet is a short cascade
where the bed leaves the lake band, then a level pool through the notch.
The grade limit's gorges are the dominant landform on the lower reaches.

### Paths, not roads — and a trail that stops below the summit

Added 2026-09-04, from walking the demo: the 6 m graded roads looked like
earthworks — a 15 m corridor of embankment on every hillside — while the
2.4 m trails cut for the peaks looked like the world had been walked in. So
the roads are gone. `worldgen paths` (`roads` is an alias) builds the
town-to-town links the way `trails` builds a climb: 2.4 m wide, a 0.18
design grade, cut-only profile (`finalClamp: "cut"` — the path steepens on
a spur instead of trenching through it), `path-<a>-<b>` ids. Bridges,
fords, the audit, `pois`' `near-path` tag and the trail network all read
`features.roads` exactly as before; only the documents in it changed.
Nothing in the engine still needs a "road" a path does not provide.

**Trail ends were cliffs.** The last four cells up to a summit are exempt
from the hard grade cap (a peak's final cone is steeper than any trail, and
without the exemption the cap failed on 39 of 40 trails). Exempt meant
UNCAPPED: the search walked straight up the cone and `finalClamp: "cut"`
kept the tread on the ground, so forty trails in the demo finished with a
300-500 % wall — 78 m of rise in 14 m on one of them. That is the "a bit
steep in places". The exemption now has its own cap
(`RouteOptions.exemptGrade`, 4× the design grade = an 88 % hands-on climb;
`--scramble`), and when no capped route reaches the summit at all the
search returns the route to the best reachable cell instead of null
(`partial: true` — least height still to climb, plan distance as a light
tie-breaker, so a shoulder just under the peak beats a cell at its foot;
an A* that cannot reach its goal spends its budget on cheap ground far
away, so `partialRadius` floods a 40-cell disc round the summit
exhaustively before choosing): the trail ends on the highest walkable
point below the peak, and the log says by how much. The UNCAPPED rung of
the cap ladder is gone for trails — 4× (88 %) is the last, because the
voxel summits are terraced crags: probing six of them, a 55 % step cap
tops out 90-340 m below the summit and an 88 % cap reaches summit height
on most, so a hands-on climb is what a peak trail is. Town paths stop at
4× too (see below: the uncapped rung once joined two towns up a cliff).

**Gravel across the snow.** A dirt track over a snowfield reads as mud.
`RoadDoc.surfaceByBiome` maps biome id → palette surface; the painter
blends the swap by biome membership (the same weights that pick the
ground's own cover), so it fades over the biome boundary. Both stages
write it: every biome whose heaviest ground surface is `snow` gets
`gravel` when the palette has one (`alpine`, `tundra` in the demo);
`--surface-by-biome alpine=gravel,tundra=rock` names the swaps by hand and
`--surface` sets the base.

**Props on the path.** `featureClearance` measured a path from the edge of
its TREAD (1.2 m out on a footpath), and the shoulder beyond it — regraded
flat, painted dirt, ragged verge — is what reads as the path. A mushroom
with a 1.5 m clearance stood on the verge. Clearance is now from the
shoulder's edge (3.4 m on a trail, 7 m on the old roads). Two smaller
traps fixed with it: the carve's segment buckets stop at the embankment's
edge, so a boulder rule asking from 9 m out was told "no path here" and
placed 8 m from the centreline (a second, wider bucket set answers the
clearance query; the carve pays nothing); and `scatter.clearance` had a
schema default of 0, which put any rule that forgot it on the path — the
default is 1.5 m. A live path edit re-cooks the cells out to the shoulder,
the embankment AND a scatter margin (`featureFootprint`), since the props
it just invalidated are as much a part of the edit as the ground it
re-shaped.

### "Thorns" along the paths: cross-slope, cut walls, and the voxel grid

Added 2026-09-04, from four screenshots of the first path-only world: rows of
triangular spikes beside every climbing trail, a herringbone staircase in a
rock cut, a washboard along a straight climb. Three causes, measured on
`trail-peak-3` where the player was standing (heightfield transects at 0.5 m):

- **The path was traversing a 65° face.** The route search caps the grade
  ALONG each step and never looked at the ground across it, so a trail was
  free to contour a cliff at a comfortable 20 %. At the point measured the
  ground rose 17 m in the 7.8 m from the tread to the corridor's outer
  edge; the bench cut into that face was a 200 % wall, and the 2 m voxel
  mesh draws a diagonal wall as a staircase — the thorns. Fix:
  `RouteGrid.gradX/gradZ` (the larger one-sided difference per axis, so a
  cliff inside one cell is not halved) and `RouteOptions.maxCross` — the
  gradient's component perpendicular to the step, a wall above `--max-cross`
  (1.0 = 45°, exactly the 1:1 bank the corridor can hold, twice that in the
  exempt end cells) and a cost multiplier below it (`crossWeight` 3). Paths
  and trails both use it. The price: the demo's summits are crags, and a
  trail that cannot reach one without a traverse now ends below it (the
  partial route) rather than beside a wall — 1 of 35 reaches its summit at
  1.0, 4 of 37 at 1.2, 24 of 41 with no cap, and the third of those was the
  world in the screenshots. 0.8 sent trails 17 km round the hills for no
  gain.
- **The band could hold any side height.** The generator samples the ground
  at the corridor's outer edge and the field draws an S-curve to it, whatever
  it is. Now the face is clamped to what a bench cut looks like: a cut no
  steeper than 1:1, a fill at 0.8 (`applyFeatures`, roads). Where a path
  still skirts a cliff, the bank stops at that and the cliff above stays a
  cliff — the seam moved out to the band's edge instead of standing beside
  the tread.
- **The corridor was finer than the voxel grid.** A 2.2 m shoulder on a 2 m
  voxel mesh is a one-sample feature; along a diagonal path the samples fall
  alternately on tread, shoulder and bank, which is the washboard. `roadFrom`
  now sizes the shoulder and smooth band to at least 1.5 and 2.5 voxels
  (`cellSize / resolution`), so the blends are something the mesh can
  reproduce; the painted tread stays 2.4 m. There is no smoothing pass to
  "slap on" after the fact: the mesh is already a linear reconstruction of
  the heightfield at voxel spacing, and a feature narrower than two voxels
  aliases no matter how it is filtered afterwards — the fix is to author
  nothing narrower than that.

How to check without the browser: sample `field.height` across the path at
0.5 m (a bench is tread, S-curve, natural ground; a wall is 10+ m inside the
band), and compare a hillshade of the heightfield at 0.5 m with one sampled
at the voxel size — if the second is ragged where the first is smooth, the
feature is under the grid's Nyquist.

### The teeth were a blend, the briars were cover

Same day, two more screenshots. Rows of pointed teeth along the bank of a
climbing path, and a hillside path carpeted in brambles.

**The teeth were the seam blend.** Sampling the field across the bank of
`path-town-1-town-27` at 0.1 m: the height flipped between two values by
three metres every half metre, and the same flip ran along the bank on the
locus where the path's two neighbouring segments are equidistant. The
runner-up blend in `nearestPerOwner` (the fix for fins at bends) widens its
span with the DISAGREEMENT between the nearest and runner-up values — meant
for a bend, where the two are near and disagree by a metre. On a path
climbing at 150 %, adjacent segments disagree by thirty metres at any point
between them, so the span grew until a segment twelve metres further away
than the nearest was mixed in, and on the equidistant locus the runner-up
alternated between the segment before and the one after. The disagreement
term is now capped at 4 m: a runner-up not within a few metres of being
the nearest is not the feature here. Test: a straight three-point path at
150 % has a monotone bank across and along. The transect that found it is
the diagnostic — hillshades hide a 0.5 m-period flip completely.

**That path was climbing a cliff at all** because town paths kept an
uncapped last rung in the cap ladder ("two towns must connect"). A link
that only exists as a 150 % scramble up a cliff is worse than no link; the
ladder for paths now stops at 4× like trails, and an unroutable pair is
logged as left unlinked.

**The briars were ground cover, not scatter.** Every prop audit said no
scatter instance lay in any corridor, and that was true: the "briars" are
the scene's `bramble-cover` grass layer, allowed on the `dirt` surface —
and to the splat a dirt track IS dirt. The host's cover sampler
(`voxel-ground.ts`) now refuses any point with `featureClearance < 0.5`,
so no cover layer grows on a tread, its shoulder, a town pad or a river's
bank foot whatever surfaces it lists. Lesson: when the data says the props
are not there, ask what ELSE draws a plant — there are two systems.

**What is left** after all of it, measured as the deviation of a 2 m voxel
reconstruction from the true heightfield (edge midpoints, by distance from
the path): natural ground 0.01 m rms; the bank of a path 0.13-0.19 m rms,
worst 0.5-1 m at the doc points, where `leftY`/`rightY` and the profile
are piecewise-linear and kink. That is the honest residue of a 2 m mesh
drawing a 9 m corridor; a Catmull-Rom or moving-average pass over the
per-point side heights would take it down further if it still shows.
