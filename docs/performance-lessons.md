# Performance lessons from the first real open-world build

**Status:** Retrospective, not a plan. Concrete bugs found and fixed while
building `heli-island` (a chunk-streamed, prop-dense flying game) on top of
`docs/open-world-streaming-plan.md`'s chunk/HLOD system — the design doc
anticipated several of these risks in the abstract (its §13 test list
already names "representation transitions do not duplicate render or physics
objects" and "hysteresis prevents boundary thrashing"), but the actual
implementation shipped with all of them present, and finding them took a
long debugging session. Read this before building or debugging *any*
chunk-streamed, instancing-heavy, or proximity-loaded (subscene) world, so
you don't re-discover the same bugs from scratch.

## The one that mattered most: cache shared GPU resources across loads, don't recreate them per chunk

A chunk-streamed world calls `buildScene()` (or the HLOD/subscene
equivalents) once per cell, independently, as cells load. If that function
creates fresh `THREE.Material`/`THREE.BufferGeometry` objects for content
that's structurally identical across cells (the same tree asset, the same
terrain-splat material), **every newly-streamed cell forces a brand-new GPU
shader pipeline compile**, even though an identical one was already compiled
for a different cell seconds earlier. On WebGPU specifically this is
expensive — pipeline creation is heavier per-occurrence than WebGL's shader
program compilation in most browsers, so this bug can make WebGPU
*regress relative to* the WebGL fallback, inverting which backend looks
faster.

Measured cost of this bug, live: **39–53% of every frame-time spike during
sustained flight** was WebGPU `build`/`analyze`/`getMaterialCacheKey` self
time (`three_webgpu.js` internals). After fixing it: 0–6% (mean ~2.9%),
consistent across 10 independent CPU profiles.

**The fix, and the trap it creates**: cache materials/geometry at
module-level (or another scope that outlives any single `buildScene()`
call), keyed by stable content identity (asset id, or
`${assetId}#${node}#${submeshIndex}` for per-submesh instancing tiers — see
`packages/render/src/scene-builder.ts`'s `instancedMaterialCache`,
`sharedAssetMaterialCache`, `midTierGeometryCache`, `impostorCache`).
Once a resource is shared across multiple loaded chunks like this, **the
unload path must stop disposing it** — disposing a shared material/geometry
when *one* consumer unloads breaks *every other* chunk/subscene still
referencing that exact object. This project's fix: chunk/subscene managers
never call `material.dispose()` at all anymore (materials are always
potentially shared going forward; the tradeoff is a small, session-bounded
set of never-freed compiled materials, bounded by *unique material count*,
not entity count — a clear win), and skip `geometry.dispose()` specifically
for meshes tagged `userData.sharedGeometry` (the decimated mid-tier cache;
near-tier geometry is still `.clone()`d per instance and stays safely
disposable).

If you add a new caching layer for chunk-streamed content, ask up front:
"when a chunk unloads, does anything else still hold a reference to this
object?" If yes, it must never be disposed by that chunk's own unload path.

## Chunk residency transitions: don't rebuild geometry for a tier change that doesn't need it

`simulation` and `fullRender` tiers render *identical* meshes — the only
real difference is whether physics/scripts are attached. The naive
implementation (unload the cell, reload it fresh) forces a full
fetch+parse+expand+build — including the shader-compile cost above — on
every crossing of that ring boundary, which at normal movement speed can
happen every few seconds of continuous travel. Fix: a `retier()` path that
only calls `sim.addEntities`/`removeEntities` and fires
`onSimulationGained`/`onSimulationLost` lifecycle hooks (script
attach/detach) on the *already-built* objects — see
`apps/playground/src/chunk-manager.ts`. No mesh ever gets touched for this
transition.

## HLOD supercells: `factor` must actually be wired up, not left at 1

`assembleHlodBuildDoc`'s multi-cell merging (`hlodSupercellFactor`) is what
turns "N chunk cells, each spawning its own separate `InstancedMesh` per
asset type" into "one merged batch across all of them." If the call site
hardcodes `factor: 1`, every hlod/far-ring cell is its own one-cell
"supercell" and you get zero aggregation benefit — re-chunking a world into
smaller cells under this condition makes things *worse*, not better,
because you've fragmented one efficient instanced batch into many small
ones with none of the promised draw-call savings. This was tried once
(before the supercell factor was actually wired up) and had to be fully
reverted. Verify supercell membership is genuinely grouping multiple cells
before assuming smaller `cellSize` is a win.

## Proximity-loaded subscenes need the same hysteresis discipline as chunk rings, and don't get it by default

`SubsceneManager` (whole scene files placed as `mode: "proximity"`
entities — used for hub/outpost buildings, not regular chunked props) is
architecturally binary: loaded or not, no intermediate tier, and **no
retier equivalent at all**. A tight `keepPadding` relative to expected
travel speed means the player can cross the load/unload boundary back and
forth within under a second of normal movement, each crossing paying a full
dispose+refetch+rebuild. Symptom: "it tanks hard specifically when I go
near \<location\>" — this is diagnosable and specific, not vague slowness.
Fix applied: widen `keepPadding` generously relative to the subscene's
`radius` and expected approach speed (this project went from `radius: 90,
keepPadding: 20` to `keepPadding: 60`). If a subscene is small/cheap enough
and near the player's normal path, consider `mode: "always"` instead of
proximity loading entirely (this project's `depot` subscene never had this
problem because it's always-loaded).

## Zero-scaling an instance doesn't reduce its GPU cost — compact the buffer

`FoliageLodSystem`-style distance LOD that "hides" an instance by writing a
zero-scale matrix still pays the full vertex-shader cost for that instance
every frame — a GPU instanced draw runs for every index up to
`InstancedMesh.count`, scaled or not. With thousands of props, submitting
every one at "near" tier detail regardless of which ~200 are actually close
is the dominant cost, not the far-tier billboard proxies. Fix: swap-compact
each tier's buffer (active instances packed into `[0, count)`, `count`
updated to match) instead of zero-scaling in place — see
`packages/render/src/foliage-lod.ts` and its test file for the pattern
(O(1) remove-from-tier via swap-with-last-active-slot, O(1) append). This
alone was a confirmed **~21x triangle-submission reduction** (33.8M → 1.6M)
on an already-built, already-shipped scene — it's easy to ship this bug
without noticing, since the visual result (things far away look small/gone)
is correct; only the GPU submission count is wrong.

## `camera-controls`' dolly-collision raycast has no acceleration structure

If a scene uses `camera-controls` with `colliderMeshes` set, its per-frame
collision test is a brute-force triangle raycast against every mesh in that
list — no BVH, no distance culling of its own. Populating it with every
`"static"`-tagged mesh in a scene (all terrain tiles, at full render
resolution) was **70% of total frame time** in one profile. Three
mitigations, all worth doing together:
1. Distance-limit the collider list to what the camera could plausibly
   dolly into right now, not the whole loaded world.
2. Build a separate, coarse (e.g. 16×16 instead of 256×256) collision-only
   proxy geometry for terrain — same height *function*, far fewer triangles
   to raycast, visually irrelevant for "don't clip through the ground."
3. If the camera rig mode makes the collision test structurally pointless
   (e.g. a `chase` rig that writes an exact pose every frame regardless of
   what the collision test would compute), skip it entirely for that mode.

## `SimplifyModifier` throws on glTF geometry using `InterleavedBufferAttribute`

Three.js's `SimplifyModifier` (used to build a decimated mid-LOD tier) calls
`mergeVertices` internally, which throws (`Cannot set properties of
undefined (setting 'NaN')`) on geometry where position/normal/uv are packed
into a shared `InterleavedBuffer` — common for glTF-loaded models. Always
wrap the call in try/catch (a decimation failure must degrade to "no mid
tier for this submesh," never take down the whole build) **and**
de-interleave the geometry into plain `BufferAttribute`s before calling
`.modify()` — copying each attribute out via `.getComponent()` sidesteps the
crash rather than just catching it after the fact.

**Postscript (2026-08):** `SimplifyModifier` is gone from the mid-tier path.
`packages/render/src/mesh-simplify.ts` now wraps meshoptimizer's WASM
simplifier instead — measured 0.3–12 ms per submesh on the nature pack and
the 11k-tri soldier (vs. tens–hundreds of ms before), no topology crashes,
and it reports the geometric **error** of its output, which
`FoliageLodSystem` converts into a per-batch near→mid switch distance
(screen-space error, not a fixed metre count). The attribute-aware quadric
pass barely touches leaf-card canopies (76–100 % of triangles kept — every
card edge is a border), so it falls back to `simplifySloppy` for those; the
lesson above still applies to anything else that hands three.js addons
interleaved glTF attributes. A worker and an on-disk bake cache were
considered and rejected on those numbers — the module-level
`midTierGeometryCache` already makes it once-per-unique-model.

## TSL instancing mutates `positionLocal` in place — read `positionGeometry` for the raw local vertex

(`applyInstancedProps` in `instancing.ts` does the same, deliberately, so the
rule below is unchanged for `InstancedProps` batches.) Three's WebGPU
node-material instancing pass does
`positionLocal.assign(instanceMatrix.mul(positionLocal))` as part of
`setupPosition()`, *before* any custom `material.positionNode` runs. Any
custom vertex node (wind sway, a "how far up this blade/card am I" bend
factor, a fake up-facing normal trick) that needs the geometry's raw,
pre-instance-transform local position must read `positionGeometry`, not
`positionLocal` — the latter has already been overwritten with the
post-instance (effectively world-scale) position by the time a custom node
sees it. Reading `positionLocal` here doesn't error; it silently returns a
value that's off by orders of magnitude (a blade-local Y of "0 to 0.5"
becomes the blade's actual world-space height), producing exactly the kind
of "vertices are correct-shaped but wildly displaced" bug that's easy to
misdiagnose as a math error elsewhere.

## Main-thread-blocking browser APIs will masquerade as "the renderer is slow"

`canvas.toDataURL()` (used for thumbnail baking) is synchronous and can
block the main thread for seconds at a stretch on a cold cache with many
uncached assets — enough to trigger the browser's own "page is
unresponsive" warning. It looked identical to a rendering-performance
problem until CPU-profiled. Fix: `canvas.toBlob()` + `FileReader` instead —
both genuinely async. If something intermittently freezes input/rendering
for multi-second stretches with no obvious per-frame cost in your own
instrumentation, suspect a synchronous browser API in an unrelated system
(baking, encoding, big JSON stringify) before assuming it's the render loop.

## Dev-bridge state must be keyed per client, or multi-tab sessions produce data that looks like impossible corruption

`apps/playground/vite.config.ts`'s `/__hitreg/context` endpoint held state in
one process-wide variable, overwritten by whichever browser tab posted to it
last. With more than one tab connected to the same dev server (trivially
common: a second editor window, or an agent driving its own automated
browser session against the same port), polling this endpoint returns a
nondeterministic blend of two unrelated sessions — which reads exactly like
severe engine corruption (impossible entity counts, frame timers frozen at
identical values across polls) but is a debugging-tool artifact, not an
engine bug. Confirmed by catching a poll whose body belonged to a
completely different tab, in a different scene. Now keyed by a per-tab
session id (`bridgeSessionId`, generated once per page load); with more
than one live client, the endpoint returns `{ multipleClients: true,
clients: [...] }` instead of guessing — pass `?id=<id>` to disambiguate. If
you're debugging via this endpoint (or `/__hitreg/spec`, which has the same
single-shared-variable shape) and something looks impossible, check whether
you're the only connected client before trusting the data.

## The in-engine profiler: reach for it before the CDP profile

`packages/core/src/profiler.ts` + the popup window (**Shift+P** in the app, or the
toolbar's `profiler` button) answer the *engine-shaped* version of "why does
it hitch" that a raw CPU profile answers badly. A CDP profile tells you which
JS functions ran; it does not know what a frame is, so a 40ms stall every two
seconds and a uniformly slow frame look similar in it. The engine profiler
knows both, and the numbers it leads with are the ones that decide what to fix:

- **Frame wall-clock p50/p95/p99, never a mean.** A mean is a machine for
  hiding a hitch — the EMA HUD this replaced showed a calm 8ms while the game
  visibly stuttered, because a spike every 120 frames barely moves an EMA.
- **The JS / GPU / off-loop split.** These three have opposite fixes and are
  routinely confused for each other. `off-loop` is wall-clock between frame
  starts minus the JS the profiler could see — GC, shader compilation, async
  chunk parsing landing in a promise continuation, a blocked GPU queue. **In
  practice this is where the time goes**, and no scope timing can see it,
  which is why the number is computed and displayed explicitly rather than
  left as an unexplained gap. GPU time comes from real timestamp queries
  (`EngineRenderer.setGpuTiming`), which is the only way to distinguish
  fill-rate-bound from CPU-bound — see the `devicePixelRatio` note in
  `main.ts`'s `onResize`, a fix that was found exactly this way.
- **Self time per scope, not inclusive.** The leaf that burned the frame,
  not the parent that contains it. Scripts are timed per script NAME
  (`fixed/scripts/heli-chain-visual`), so "which behavior" is answerable with
  200 NPCs running a handful of behaviors.
- **Spike capture with markers.** Frames over the threshold are kept whole,
  with the spans that overlapped them — `chunk.load`, `chunk.build`,
  `hlod.supercell`, `scene.rebuild`, and `long-task` (PerformanceObserver).
  A spike with `chunk.build` sitting under it on the timeline needs no
  further analysis. Note the deliberate split of `chunk.load` (fetch, mostly
  waiting, harmless) from `chunk.build` (synchronous expand + buildScene +
  collider creation, the part that actually drops a frame) — conflating them
  sends you optimizing network latency that was never the problem.

It runs always-on, so the window opens with ~15 seconds of history already
recorded: you look at the hitch that just happened rather than trying to
reproduce it with the window open.

**Snapshots** are the handoff. The window's **snapshot → AI** button writes
`.hitreg/profiles/<timestamp>-<scene>.json` — a real file in the repo, so an
agent reads it with no dev server running, and it survives the restart that
debugging a perf problem usually involves. Each carries the human's `note`
("choppy flying low over the north shore" — the context numbers can't
supply), a plain-English `digest`, the condensed `report`, and the `full`
ring. Snapshots ride the agent inbox alongside pins, so an agent long-polling
`/__hitreg/agent-inbox` wakes within a second of the click, and are answered
the same way (`{ file, resolved: true, reply }`) rather than deleted.

Escalate to a CDP profile when the profiler says the cost is *inside* a scope
you can't decompose further (three.js internals, Rapier's solver) — its job
is to tell you which 200 lines to profile, not to replace function-level
attribution.

## Methodology: profile before fixing, every time — reasoning got this session's own hypotheses wrong more than once

Every confirmed root cause in this document was found via a real CPU profile
(Chrome DevTools Protocol `Profiler.start()`/`stop()`, parsed for
self-time/total-time by function), not code-reading speculation. Plausible,
well-reasoned hypotheses were wrong multiple times along the way — chunk
disposal and `SimplifyModifier` were both suspected causes of a reported
"page hangs" bug and were confirmed *not* to be it (13ms and 202ms out of a
19-second block) once actually profiled; the real cause turned out to be an
unrelated thumbnail-baking function. If a performance report is specific
("chugs near this one location," "fine standing still, bad while moving"),
that specificity is a gift — it means the cause is findable, not that the
engine is generically slow. Chase it with a profile spanning the exact
reported condition before changing code.

## The LOD toolbox as of 2026-08 (what exists, so you don't rebuild it)

Three mechanisms, each with a headless test suite under `packages/render/test`:

- **Instanced props** (`mesh.renderMode: "instanced"`, `FoliageLodSystem`):
  near = real geometry, mid = meshoptimizer-decimated copy (`mesh-simplify.ts`,
  switch distance derived per batch from the simplifier's reported error and
  the live projection — `screenErrorPx`), far = a hemi-octahedral impostor
  quad (`impostor.ts`; baked app-side by `impostor-bake.ts`, 6×6 views of
  albedo + model-space normals, lit at runtime). Compacted instance buffers
  per tier; per-slot impostor rotation/scale side-buffers.
- **Clustered hero meshes** (`mesh.renderMode: "clustered"`, `cluster-dag.ts`
  + `clustered-mesh.ts`, `ClusterLodSystem`): Nanite-style cluster DAG built
  once per unique asset (~90 ms / 16k tris), crack-free by `LockBorder`
  construction, selected per frame on the CPU by projected error with
  per-cluster frustum culling, drawn as ONE index-buffer rewrite over the
  original vertices. For statues/buildings/scans placed a few times — not
  for thousands of instances (that's what the tiers above are for).
- **HLOD supercells** (`hlod-proxy.ts`): distant static geometry merged per
  cell/supercell — see the `factor` lesson above.

Deliberately not built (WebGPU has no 64-bit atomics, and it would kill the
WebGL fallback): GPU-driven cluster selection, a software rasteriser, a
visibility buffer. Revisit if those platform gaps close.

## The editor's own debug overlays outweighed the level they were drawn over

`showPhysics` and `showLights` used to default to **on**, and each draws one
object per collider and per light — no batching, no culling budget, no
scaling story. On a 2000-entity dungeon (1767 colliders, 98 point lights) the
scene itself batches down to **39 draw calls and ~7 ms/frame**, while the same
scene with the overlays on submits **986 draw calls for ~21 ms** — more than a
thousand of them collider wireframes. The overlay cost 3x the level.

Two things make this hard to spot:

1. `renderer.info.render.drawCalls` counts *every* renderable in every pass,
   including `Line`/`Sprite` objects. A draw-call number that will not
   reconcile with the mesh count is usually an overlay, not geometry — count
   renderables **by type** before concluding batching is broken.
2. Static batching genuinely works (2200 source meshes → 15 merged draws, one
   per material bucket), so the scene JSON and the batch stats both look
   healthy while the frame is dominated by something that is not in either.

Defaults are now off (`packages/editor/src/state.ts`), both still one toolbar
click away. **Flipping the default does not help an existing session** — the
settings are persisted in `localStorage`, so anyone who has already opened the
editor keeps their stored `true` and has to toggle it by hand.

The deeper fix, if these ever need to be on for a large scene, is to merge all
static collider wireframes into a single `LineSegments` buffer (the same trick
`static-batch.ts` uses for meshes) rather than one object each.

## A changing light SET recompiles every lit material (WebGPU)

`LightsNode.customCacheKey()` hashes `light.id` per light, so the renderer's
material cache key changes whenever the set of visible lights changes — even
if the COUNT is identical. A camera-relative light budget that culls by
toggling `light.visible` therefore recompiles every lit material, inside
`renderer.render()`, on nearly every frame of camera movement.

Measured on the dungeon above (98 point lights, budget 8): rotating the camera
in place ran at **18 ms/frame**, while MOVING it — same scene, same frustum
churn, only the position differing — collapsed to **2296 ms/frame**. Forcing
the budget to 0 (a set that cannot change) restored 28 ms.

The fix in `light-budget.ts`: never toggle authored lights. Hide them once and
treat them as data, then keep a fixed pool of slot lights — created once,
always visible, stable identity — and re-aim the pool at whichever lights
currently win. The light set the renderer sees is then constant forever and the
per-frame update writes uniforms only. Shadow casters are excluded (a shadow
map belongs to its light) and left permanently visible.

Diagnosis note: the engine profiler bills this to `render` with a large pile of
**off-loop** time, which is what shader compilation looks like from outside the
JS timeline. The `update/light-budget` scope itself reads as ~0.3 ms — the
system is cheap, its *side effect* is not, and the scope timing actively points
away from the culprit. The A/B that isolates it is rotate-in-place vs
move-through: both churn the frustum identically, only one moves the camera.

## Pipelines compile on first DRAW, so panning somewhere new stalls

WebGPU builds a render pipeline the first time a material/geometry pair is
actually drawn. In a level you fly around, that arrives as a hitch every time
the camera reaches somewhere it has not been, and it never settles because
there is always another corner. `EngineRenderer.precompile()` pays it once
after each scene build (worst frame 560 ms → ~150 ms on the dungeon above).

The catch: `renderer.compileAsync(scene, camera)` alone does **not** do this.
It runs the normal `_projectObject` pass, which frustum-culls, so it only
compiles what the camera can already see — exactly the pipelines that were
about to be built anyway. Clearing `frustumCulled` on every mesh for the
duration of the call is what makes it cover the whole level.

## Shader builds are per InstancedMesh OBJECT, and `compileAsync` compiles for the wrong render context

Resolved 2026-09-02, after a full day on the "it hitches when I turn" report
below. Both halves were invisible to every instrument here until the render
call was taken apart function by function (see `tools/perf-probe.mjs`):
rotating in place with **nothing streaming** spent **2640 ms of a 3685 ms lap
inside three's `Nodes.getForRender`** — shader CODE GENERATION on the main
thread, ~60 ms per lit material — with GPU-side work (`createShaderModule`,
`createRenderPipeline`, buffer uploads) under 1 ms per frame. The `writeBuffer`
suspicion was wrong; the "programs" suspicion was right but for a reason nobody
had named.

**1. Three builds a separate shader for every `THREE.InstancedMesh`.**
`RenderObject.getMaterialCacheKey()` appends `object.uuid` whenever
`object.isInstancedMesh` (or `object.count > 1`), because the instance
matrices reach the shader through nodes bound to that one object's buffers.
So every InstancedMesh runs the node builder once on first draw, however many
identical ones already compiled. A streamed world creates one per (cell, prop,
submesh, LOD tier): 57 builds in one rotation over just 7 materials, and 3-8
builds every time a cell is promoted from HLOD proxy to real content — which is
exactly the stall that coincided with terrain "popping in". On top of that the
uniform-buffer instancing path (any batch under 1024 instances) bakes the
CAPACITY into the WGSL (`array<mat4x4<f32>, 764>`), so the compiled programs
multiplied by capacity too: 102 vertex programs for 9 materials.

Fix: `packages/render/src/instancing.ts`. Prop batches are `InstancedProps` —
a plain `Mesh` over an `InstancedBufferGeometry` whose instance matrices are
four interleaved `vec4` GEOMETRY attributes that the material reads with
`attribute()` nodes (`applyInstancedProps`). Geometry attributes are resolved
per render object at bind time, not at shader-build time, so the builder state
is keyed by material + attribute layout and shared by every batch of the same
prop: one shader per material per pass, ever. The object carries no `count`
and no `isInstancedMesh` — either one puts the uuid back in the key. Result on
the same rotation: **57 shader builds → 1, worst frame 235 ms → 71 ms**, node
states at settle 135 → 49, programs 146 → 50.

**2. A background `compileAsync` compiles for a RenderContext the scene never
draws in.** Three keys each compiled state on its RenderContext, and
`RenderContexts.get()` keys those by render-target attachment state + MRT node
+ **nesting depth**. The post chain draws the scene INSIDE its quad render —
into the scene pass's MRT target, at depth 1 — while `compileAsync` resolves
the canvas at depth 0. So `precompileGroup` compiled ~10 states per scene that
were never used and the real ones still built on first draw: measured 57
builds in a rotation with precompile "on", identical to "off". That is why
the earlier attempts in this file read as "modest win, not worth it".

Fix: `EngineRenderer.compileInSceneContext` borrows the scene pass's render
target and MRT node and forces the depth for the synchronous prologue of
`compileAsync` (the only part that resolves a context). Now a streamed group's
shaders are generated with three's `buildAsync` yields and its pipelines with
`createRenderPipelineAsync`, so neither the codegen nor the ~600 ms
driver-side compile lands on a frame; the cell draws once ready. Result: cold
rotation **worst frame 14 ms, zero builds on the frame**; a 30 s streaming
flight: **0 frames over 50 ms** (before: 82 ms + a 623 ms off-loop gap per new
material).

Two invariants fall out of this, both in `instancing.ts`'s header comment:
never give scene content a `THREE.InstancedMesh` (or a `count > 1`) unless
you want one shader build per object, and never let a precompile target a
different render target / MRT / nesting depth than the pass that will draw
the objects — it will look like it works (states get created) and do nothing.

## Streaming while flying: bound the concurrency, and never re-bake a SHRINKING HLOD supercell

Found 2026-09-01 on the first generated (marching-cubes) world, from a profile
snapshot: 28 fps, worst frame 2596 ms, `peak 53 concurrent loads`, and one
frame carrying **35 in-flight `hlod.supercell` bakes** of up to 2.5 s each.
The four causes, all separate, in the order they mattered:

**1. A supercell was re-baked whenever its membership changed at all.** Merged
geometry can't be patched, so any change meant a full rebuild. Flying forward
changes the membership of nearly every supercell in the ring on every cell
crossing — trailing ones shrink, leading ones grow — so the whole far ring
re-baked continuously, and each rebuild superseded bakes that had not finished.
The fix is to make the rule *asymmetric*: rebuild when a desired cell is
**missing** from the bake (else you get a visible hole), and **keep** a bake
that merely covers cells you no longer want (they are distant scenery, they
draw in the same merged call, and removing them buys nothing you can see).

**2. Nothing bounded concurrency.** Both cell loads and supercell bakes are
mostly *synchronous* main-thread work spread across promise continuations.
Running 53 of them interleaved does not make any finish sooner — it smears one
long stall across every frame in the burst. Small caps (3 cell loads, 2
supercell bakes) plus a newest-first queue, with stale entries dropped at pump
time, made each unit finish promptly. Newest-first matters: the queue is a list
of things you are flying *toward*.

**3. Streamed chunks were never static-batched.** `rebuildStaticBatch` only
ever ran over the base scene document, and in a generated world essentially all
content is streamed — so a cell of 200 scattered props issued 200+ draw calls.
Batching per cell at load time (not globally) keeps it incremental and keeps
per-cell frustum culling. Peak draw calls 1278 → 153.

**4. An entry-counted mesh cache was thrashing.** A full voxel cell is ~110 KB
and a coarsened one ~25 KB, so a fixed entry count budgets wildly different
amounts of memory depending on the mix. With ~650 cells resident the cap sat
just under what the world needed and evicted cells that were about to be asked
for again, so every supercell re-bake re-meshed from scratch. Budget by
**bytes**.

Net on a scripted fly-through: **19 → 40 fps median, frame p95 36 ms → 14 ms,
peak draw calls 1278 → 153, in-flight loads 52 → 5.**

### What did NOT work: precompiling each chunk as it streams in

> **Superseded 2026-09-02** — see "Shader builds are per InstancedMesh
> OBJECT" above: the per-chunk precompile was compiling for a render context
> the scene never drew in, and the per-chunk cost was one shader build per
> InstancedMesh. Both fixed; the per-group precompile is now on.

The residual cost is `render` self-time in bursts of 300–550 ms — first-sight
pipeline compilation (see the section above), which streaming produces forever.
The obvious fix, calling `EngineRenderer.precompile()` on each chunk group
before showing it, made things **worse**: frame p95 went 14 ms → 180 ms while
only halving the worst frame. `compileAsync` carries a large per-call cost, so
paying it once per chunk is worse than paying it lazily once per unique
pipeline amortised across many chunks. Reverted.

Two things to know if you try again. Compiling against a bare staging
`THREE.Scene` is doubly wrong — with no lights in it you compile the *no-lights*
shader variant, and the real one still stalls on first draw; `compileAsync`
takes a third `targetScene` argument for exactly this. And measure p95, not
just the worst frame: this change improved the worst frame and still made the
experience worse.

### Measure it with a scripted fly-through, not by flying manually

`POST /__hitreg/camera` + `GET /__hitreg/context` is enough to sweep the camera
across the world at a fixed rate and sample `perf` at each hop — repeatable,
comparable before and after, and it surfaces `counters` (draw calls, in-flight
loads, chunks) that a screenshot cannot. Flying the same route a *second* time
is the cheap way to separate first-sight cost from recurring cost: here the
return pass ran 30% faster, which is what identified the residual as pipeline
compilation rather than per-chunk work.

## A single glTF prop can be half your draw calls (kit exports and shadow cascades)

Found 2026-09-02 profiling the voxel demo, which was submitting 776 draw calls
a frame. One prop — a kit-built house — accounted for **356 of them**, for 726
triangles of geometry.

The mechanism is multiplicative and easy to miss. A DCC/kit export arrives as
however many submeshes the exporter felt like emitting; this one was **89
separate meshes averaging eight triangles each**, all sharing one material. How
a model splits into submeshes is an artifact of the export, not an authoring
decision — but the renderer pays a draw call per submesh in the main pass AND
in every shadow cascade. With three cascades that is `89 x 4 = 356`.

Measured, by toggling that one entity:

```
control                 draw 8.62ms  calls 732
house: no shadow        draw 7.66ms  calls 465   (-267 = 89 x 3 cascades)
house hidden entirely   draw 7.24ms  calls 376   (-356 = 49% of ALL calls)
```

**The fix** is `mergeModelSubmeshes` in `packages/render/src/static-batch.ts`,
called from the model load path: merge a loaded model's same-material submeshes
into one mesh each, in the model root's local space. It took the demo from 776
to 294 draw calls. It is deliberately not `batchStaticMeshes` — that merges
across ENTITIES and only for ones flagged static, keyed by entity so the editor
can still pick one out of a batch; this merges WITHIN one model instance, where
every submesh already belongs to the same entity.

What it must refuse, because each would be a bug rather than a saving:
skinned meshes (their vertices are driven by a skeleton, and baking them into
the parent's space freezes them at the bind pose); anything under a model with
animation clips (a clip addresses nodes by name, and a merged mesh no longer
has that node); geometry carrying attributes beyond position/normal/uv, for the
same reason `hasCustomAttributes` exists; and multi-material meshes, which
would need draw groups and so save nothing.

**Do not dispose the originals' geometry.** `skeletonClone` shares buffers with
the cached glTF scene, so disposing here corrupts every other instance of the
same model — the same trap as the shared-material caching above. Detach only.

Two corollaries worth internalising:

- **Shadow cascades multiply every per-object cost by `1 + cascades`.** Before
  optimising anything per-object, check what the cascade count is: at
  `cascades: 3` the demo spent 60% of its draw CPU and 68% of its draw calls in
  shadow passes. `renderer.info.render.frameCalls` tells you how many passes
  you are actually paying for (it read 6: three cascades, the main pass, and
  two post passes).
- **Count casters before theorising.** A quick traverse counting
  `mesh.castShadow` by subtree root answered in one run what two rounds of
  guessing had not: 89 of the scene's 194 casters were one prop. The same
  traverse showed far-ring HLOD proxy *props* were set to cast while the
  proxy *terrain* in that identical ring was not — a self-contradiction inside
  one function that cost 26% of all triangles submitted per frame.

## Streaming stalls: what moved off the main thread, and the one that could not

Found 2026-09-02 on the voxel demo. A 1200-unit flight produced 800-1000ms
`long-task` stalls and a 2003ms worst frame. Three separate costs turned out to
be hiding behind the same symptom, and only a profile taken DURING the flight
(not at rest) separated them.

**1. Cell generation.** `fbm2` alone was 14.5% of all main-thread self time.
Moved to a worker pool; `ChunkProvider.get` had always allowed a Promise
return. Result: long tasks 833/1026ms -> 72/102ms, off-loop average 11-28ms ->
5-9ms.

**2. HLOD coarse meshing.** A supercell re-meshes each member cell on a coarser
lattice — a SEPARATE marching-cubes run from the cell's own generation, up to
16 of them in one bake. This is why moving generation shrank the hitch without
removing it. Moved to the same worker (`buildVoxelMesh` bypasses core's mesh
cache, which is what makes the result safe to *transfer*).

**3. The supercell merge.** Transforming every cell's vertices into supercell
space and concatenating them measured ~3.9s across a 30s flight — larger than
the meshing it followed. `mergeVoxelMeshes` (`packages/core/src/voxel/merge.ts`)
does it as pure typed-array arithmetic so the worker can, returning one merged
geometry per material: one transfer per material rather than one per cell.
Merging *voxel* cells specifically is what keeps it simple — every cell of a
world declares identical attributes, because the palette is a property of the
world, so the mismatched-attribute case that makes general merging expensive
cannot arise.

### The one that could not move, and why it is worth knowing

> **Moved 2026-09-02** without decoupling the collider — see "Shader builds
> are per InstancedMesh OBJECT" above. The add-first ordering rule below still
> holds; the precompile just had to run in the right render context.

After all three, single `render/draw` calls of **760-1320ms** remained. That is
WebGPU compiling a pipeline per new material/geometry pair on first DRAW,
inside `render()`, on the frame that first shows a streamed cell.

`compileAsync` before adding the group to the scene is the textbook fix. It was
implemented and reverted **twice**, because both times the player fell through
the world. The reason is structural: **the collider for streamed terrain is
cooked from the BUILT objects, so it does not exist until the group is in the
scene.** Anything that delays `add()` delays the ground. Attaching physics
first does not help either — `sim.addEntities` needs those same built objects.

So the prerequisite for fixing this is decoupling the collider from the scene
graph (cook it from the `ChunkDoc` / the voxel field directly, which the worker
already has). Until then, precompiling only the far HLOD supercells was
measured and **reverted as not worth it**: it took `programs` from 263 to 1006
— compiling off-screen content that may never be drawn — and made `gapMax`
worse (415ms -> 609ms), without touching the near-cell stalls that actually
hurt.

### Reading the profiler when you chase this

`gapMs = interval - the PREVIOUS frame's JS`, so sorting spike frames by
wall-clock interval shows you the frames *after* each stall, all of which look
innocent (`interval 1565ms | js-in-frame 19ms`). Sort by JS-in-frame instead
and the culprit appears immediately. Several hours went into the wrong frames.

## "It hitches when I turn": isolating rotation from streaming

Reported 2026-09-02 as "rotating and moving the character is what causes it",
after the streaming work above had already taken the demo from 16 to 42 fps.

**Build the repro carefully, or you will measure the wrong thing.** In edit mode
the streaming focus is the camera's orbit TARGET (see the comment at
`chunkManager.update` in main.ts). A first attempt swept the target around a
120-unit circle to "rotate", which dragged the focus across cell boundaries and
re-streamed the world — both arms of the A/B came out at ~1.5 fps and neither
finished loading. The honest test holds the TARGET fixed and orbits the EYE, and
asserts the chunk count and `loading` are identical before and after:

```
pure rotation, 616 chunks resident, loading 0 throughout
   fps 57 | p50 11.5 p95 16.4 p99 170.9 MAX 517.8 | over33% 3.2
   worst frames: js 518 (draw 351.6), js 450 (draw 276.7)
```

Half-second frames from turning alone, with nothing loading. So this is a
FIRST-DRAW cost, not a load cost, and no amount of moving generation off-thread
touches it.

### What is actually in those frames

CDP profile of pure rotation:
```
11.1% 2106ms updateMatrixWorld
 8.2% 1560ms fbm2 @ noise.ts          <- field sampling, with nothing streaming
 7.5% 1416ms _projectObject           <- cull traversal, x6 passes
 5.0%  946ms writeBuffer              <- GPU buffer upload on first draw
 3.1%  581ms nearestOnPolyline @ field.ts
 2.6%  495ms build (node material)    <- pipeline compile
```

Two separate causes, and the split matters:

1. **First-draw GPU work** — `writeBuffer` (uploading geometry the first time it
   is drawn) plus pipeline `build`. `compileAsync` on a newly-streamed group
   addresses only the second, which is why `EngineRenderer.precompileGroup`
   measured a real but modest win and no more:
   `fps 57 -> 69.6, p99 171 -> 156ms, worst 518 -> 469ms, over33% 3.2 -> 2.1`.
2. **Field sampling from the grass system.** `sampleFoliageGround` calls
   `field.slope`/`field.height`/`field.splatAt`, and `GrassSystem.update` runs
   every frame against the camera, so an orbiting camera re-places cover and
   re-evaluates the noise field on the main thread. It is cheap on average
   (~0.3ms) and bursts to 80-130ms.

### The ordering rule that keeps biting

Precompiling a streamed group must happen AFTER `scene.add`, never before.
Streamed terrain's collider is cooked from the built objects, so delaying the
add delays the ground and the player falls through the world — hit twice by
awaiting the compile first, and once more by trying to attach physics before the
add (`sim.addEntities` needs those same objects). Add first, compile in the
background, never await.
