# Procedural voxel worlds (marching cubes)

**Status:** built and verified in-browser (WebGPU) 2026-09-01. Terrain,
streaming, biome texturing, collision, scatter and the worldgen CLI all work
end to end. Open items are listed at the bottom.

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
pnpm -F playground worldgen init <world> --project <name> --scene
pnpm -F playground worldgen rivers <world>   # trace downhill, carve channels
pnpm -F playground worldgen towns  <world>   # flat, low, water-adjacent pads
pnpm -F playground worldgen roads  <world>   # least-cost graded routes
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
- **LOD crack at the HLOD boundary.** Coarse cells weld to each other exactly,
  but there is a resolution mismatch where the coarse ring meets the full-detail
  ring. Skirts are the usual fix.
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
catch you again.

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
