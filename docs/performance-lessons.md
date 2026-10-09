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

**Postscript (2026-09-10):** the path is gone for any rigged play camera.
`ThirdPersonCameraRig` resolves the boom with one `sim.spherecast` against a
layer-masked physics world instead — 0.05 ms/frame measured in Ashenhold,
against the 70% of frame time the mesh path cost — and `colliderMeshes` is
left empty whenever a rig is driving. `camera-controls` still owns the
editor's free camera and rigless scenes, where the list is distance-limited
as above. See docs/camera.md.

**Postscript (2026-09-19):** the rig now makes up to six sweeps a frame while
the character moves (a pivot guard, the boom, a forecast path and three
forecast booms — the look-ahead that turns a doorway's jump cut into a
dolly-in) and one at rest. Measured running through Ashenhold with the engine
profiler: 0.08 ms/frame average, 0.2 ms p95. Still nothing next to the mesh
path, because every one of them is a layer-masked broadphase query.

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

## The first cast of every spell stalled: per-emitter shaders and cold VFX pipelines

Found 2026-09-03 chasing "the two saved spells chug" in the spell lab, with a
headless probe that wrapped `GPUDevice.createRenderPipeline` and counted per
play. The steady state was innocent (p95 8 ms with both pulses running); the
FIRST play of any spell created 10–12 pipelines on the main thread — a
265–739 ms hitch — and the same spell played again created none. Two causes:

- **Every particle emitter compiled its own shader**, even two with
  identical settings. Diffing the WGSL of two identical emitters showed only
  the instance buffer's name differed (`NodeBuffer_<node id>`): three's
  `InstancedMesh` path bakes that name and the capacity into the code, so
  program caching by code text can never hit. Same disease the foliage had
  (§ above); same cure — the emitter is now an `InstancedProps` with the
  matrices and per-particle colour as instanced geometry attributes, and all
  emitters of a look share one program. A new emitter now costs 0 compiles;
  a new *variant* (blend mode, soft fade, sub-UV) still costs one, once.
- **Everything else compiled on first draw**, which for a spell is the first
  cast. `VfxSystem.warmup()` plays an invisible sampler of every module kind
  and variant far below the world and hands the VFX root to
  `EngineRenderer.precompileGroup` (the context-borrowing one), on the app's
  first frame. First-cast stalls went from 265–739 ms to 28–132 ms; what is
  left is per-variant particle pipelines and first-use texture uploads.

Cheap guard for next time: play the effect twice and compare pipeline
counts — if the second play is zero, it was compile, not the effect.

## Particles: sharing a program is not sharing a draw — batch emitters by look

Found 2026-09-13 on a seven-fire test scene that drew **94 draw calls**. The
section above made every emitter of a look share one *program*, but each
emitter was still its own mesh, so each was still its own draw. Worse, each
was drawn **twice**: three renders a transparent `DoubleSide` material as a
back-face pass then a front-face pass. Hiding the 33 emitter meshes dropped
the frame to 28 draws — the particles alone were 66.

Fix (`packages/render/src/particles.ts`): emitters only simulate; a
`ParticleBatch` per look (texture or procedural sprite, blending, sub-UV grid,
soft-fade distance, filter) owns ONE `InstancedProps` mesh, and every member
emitter writes its world-space instances into it back to back each frame.
Batch materials set `forceSinglePass` (billboards face the camera; the second
pass drew nothing new). Result: **94 → 31**, particles 66 draws → 3, and a
new torch adds zero draws. The mesh grows by powers of two as emitters join
and never shrinks, so a streamed dungeon does not reallocate per torch.

Two things this changes: sorting is per batch, not per emitter (invisible for
additive layers); and batch meshes live in the scene (or a host, e.g.
`vfx.root`), not under the entity — code that looked for an emitter's mesh
under its group must use `ParticleSystem.drawOf(id)`. Measure with
`renderer.info.render.drawCalls` with the particle meshes hidden and shown in
one page session.

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

## A capped bake queue needs a refill, or a wide far ring never finishes

Found 2026-09-04 while pushing `rings.farTerrain` from 14 to 28 cells. The
HLOD supercell queue is capped at 64 entries (a long flight enqueues the
whole far ring, and the tail is stale by the time it runs — that cap is
right). But the only thing that refilled it was the residency pass, and the
residency pass runs only when the focus crosses a cell. Stand still on a
peak with 175 supercells in the ring: 64 bake, the queue drains, and the
other 109 stay "desired" forever — the far ring is simply absent, and no
warning says so (`__hitreg.chunkManager`: desired 175, loaded 66, queue 0,
in flight 0). With a 14-cell ring the whole disc was under the cap and the
bug never showed.

`pumpSupercellQueue` now forces the next `update()` to re-run residency
when the queue and the in-flight set are both empty and desired supercells
remain unbaked — guarded by "only while each refill made progress", so a
supercell whose cells all fail cannot re-queue every frame. The general
lesson: any bounded work queue fed by an event (a cell crossing) needs a
second feeder for the case where the event stops but the work does not.

## One queue, or the big job wins: an HLOD bake starved the ground under the player

A profiler snapshot of the MMO scene had a p50 frame of 12 ms and a p95 of
409 ms — fine most of the time, catastrophic in bursts. Every one of the
fourteen events the ring buffer had kept was an `hlod.supercell` span, and the
worst two were **3,576 ms and 2,308 ms, each for a 64-cell far block**. Nothing
else was even recorded. Two independent causes, and they compound:

**1. The bake fetched its member cells one at a time.** `loadSupercell` had a
plain `for (const key of members) { await this.readCell(...) }`. Sixty-four
sequential worker round-trips on a pool of six, so five workers were idle for
the whole span and the wall-clock was simply 64 × the per-cell latency. They
are independent; fetch them together (bounded — see
`SUPERCELL_FETCH_CONCURRENCY`). One caution: the results now arrive out of
order, and a bake's origin must not depend on arrival order, so sort back to
member order before assembling.

**2. The generation pool had no queue, so it had no priorities.** Requests were
posted straight to the next worker round-robin, which means each worker's own
message queue *was* the queue: FIFO, per worker, and unjumpable. That is
survivable only while nothing asks for many cells at once — and the moment
fix 1 landed, one bake would deal 64 jobs across six workers and the near
ring's next cell would queue behind a dozen of them. **The ground arriving
late in front of a running player is a hole they fall into**, which is a worse
failure than any bake being slow.

So the pool now holds one priority queue and keeps at most **one** job
outstanding per worker. Cap of one is the point: two would hide a little
dispatch latency and cost a near cell an extra job's wait, and that wait is
the entire thing being protected. Callers say what they are
({@link ChunkUrgency}) — `inline` (simulation ring, generated on the calling
thread because a collider is about to be stood on), `near` (a render ring you
can see), `bulk` (one of up to 64 members of a bake that cannot publish until
it has them all).

Two traps in the queue itself:

- **A worker that errors must free its slot.** `worker.onerror` used to only
  warn. With a per-worker in-flight cap, a leaked busy slot is a permanently
  smaller pool, and enough of them deadlock streaming outright — a world that
  stops loading is far worse than one lost cell.
- **`dispose()` must reject the QUEUE as well as the in-flight map.** A queued
  job whose workers were terminated never settles, and a `readCell` that never
  settles holds a load slot for the rest of the session.


## Draw-count pass on the voxel demo (2026-09-04): two three.js traps and the far ring

Reported as "443 draw calls with nothing but terrain in the scene, ~45 fps".
Measured headless (1280×720, WebGPU) at the spawn, looking south, with the
in-session A/B probe (toggle a category of renderables, read the profiler):

```
                                   draws   JS ms   GPU ms   fps
start                               455    27.3     7.5     35
+ shadow-material fix               455    20.0     4.4     48
+ frozen-subtree fix + impostors    430    16.7     5.9     58
+ far-ring supercell grid           354    14.6     4.9     66
```

The frame was CPU-bound throughout — GPU never above 8 ms — and the CPU
profile said where: 14% `updateMatrixWorld`, 11% `getMaterialCacheKey` +
`customProgramCacheKey`, 8% `_projectObject`, then per-draw submission. Four
separate causes, in the order they mattered:

**1. Three's shared shadow-pass material invalidated every caster every
frame** (`packages/render/src/shadow-pass-material.ts`). The A/B that found it
made no sense on its own: hiding the ONE skinned player mesh saved 6 ms. The
mechanism: in a shadow pass the renderer draws every caster with one override
material per light and copies each caster's `alphaTest` onto it first, so leaf
cards cut holes in their shadows. `Material`'s `alphaTest` setter bumps
`version` whenever the value crosses zero, and the render-object cache
compares each shadow render object's version against THAT material's. A
caster list mixing alpha-tested foliage with opaque rocks, trunks and one
character flips the version several times per pass, and every shadow render
object that sees a new version recomputes its whole cache key (a walk over
every material property plus `customProgramCacheKey`) to conclude nothing
changed. The fix is a targeted patch of the `alphaTest` setter that skips the
bump on `isShadowPassMaterial` materials only — each shadow render object's
key already encodes its own caster's cutout class, so nothing can change
underneath it. A live material edit that crosses zero calls
`bumpShadowPassMaterials()` to re-key on demand. Diagnosis tip: a
shadow-pass `NodeMaterial` whose `version` climbs by 2 every few frames.

**2. Frozen subtrees were not pruned — and could not be by honouring
`force`** (`packages/render/src/static-transforms.ts`). Three r185's
`updateMatrixWorld` recurses into every child whatever
`matrixWorldAutoUpdate` says (the r15x child test is gone), so
`freezeStaticSubtree` was clearing a flag that pruned nothing: 2,352 calls a
frame over 2,345 objects. The first fix — an own `updateMatrixWorld` on the
frozen root that returns unless `force` — ALSO pruned nothing, because every
`matrixAutoUpdate` object (the Scene included) calls `updateMatrix()` on the
way down, which sets its own `matrixWorldNeedsUpdate`, which turns `force`
on for all its children: the walk reaches every frozen root forced, every
frame. What actually matters is whether the parent moved, and that is
answerable directly — keep the parent's world matrix as of the last layout
and compare 16 floats. Calls per frame 2,352 → 1,069, none under a frozen
root. A unit test pins all four behaviours (pruned, ancestor moved, refresh,
thaw). Verify a change like this with the call count, not the profile: the
first version looked plausible in code and did nothing.

**3. Supercell props were merged full geometry** — in the hlod ring AND the
far ring, out to 1.3 km. A 354-triangle tree merged 1,416 vertices per
instance into a proxy that reads as a few pixels, every (species, submesh)
was its own bucket, and glTF props skipped the "under 4 m tall is invisible
out there" filter the primitive path already had (mushrooms were baked into
the far ring). Now: LOD-able props (`mesh.lod !== false`) become one
`InstancedProps` batch of impostor quads per species per supercell, from the
same octahedral atlas the near ring already bakes (`impostorBatchFor` in
scene-builder.ts, shared cache), so a tree looks the same across the ring
boundary; `lod: false` props keep merging (a rock has no atlas and needs
none); the far ring drops clutter for glTF too; and merged buckets key by
what the material DRAWS with (texture object + cutout/side/blend classes),
so props packed onto one project atlas (`wfc pack --atlas`) collapse into one
bucket per supercell.

**4. One supercell grid served both rings.** The far ring was 164 supercells
of ~2.5 meshes — every one walked per pass, frustum-tested, and a draw when in
view. The far ring now groups on a grid `FAR_SUPERCELL_MULTIPLIER` (2×) wider
than the hlod ring's, in its own key space (`f<scx>_<scz>`): 164 → 54 far
supercells. The boundary rule that keeps it honest: a far block never bakes a
cell an hlod block currently holds (so moving away never double-draws), and
once an hlod block takes one of a far block's cells the far block is re-baked
WITHOUT it as a replace — never a drop, which would open a hole on the
horizon for the length of a bake. An hlod publish that overlaps a far block
nudges residency (`lastFocus = null`), since residency otherwise runs only on
a cell crossing.

Not done, in order of what is left (354 draws at rest, ~55 µs of CPU each):
near-ring instanced batches are per CELL, so 29 near chunks × species × tiers
is ~90 draws (72 of them shadow cascades) that a world-level pool per asset
would make ~25; `cascades: 3` triples every near caster; clutter
(`castShadow: true` on mushrooms, roots, shrubs) is a draw per cascade for
something no shadow shows. And pixelate at 480 lines (the "nearest neighbour"
look) is purely a GPU saving — with the frame CPU-bound it changes nothing
either way, so it is not a suspect.

### Same day, second pass: pool the near ring, page the impostors

```
                                   draws   JS ms   fps
after the far-ring grid (above)     354    14.6     66
+ world prop pool                   166    10.2     93
+ shared impostor page              155    10.0     95
```

**5. Near-ring batches were per CELL** (`packages/render/src/prop-pool.ts`).
`buildScene` runs once per streamed cell, so every cell had its own near/mid/
far `InstancedProps` per species: 29 resident cells × 8 species × tiers, each
near tier drawn again in three shadow cascades — ~90 draws for a few thousand
triangles. The pool keeps one PAGE of tiers per (model, node, shadow/LOD
flags) that every cell adds its instances to and releases on unload; the page
is an ordinary batch to `FoliageLodSystem`, just a `dynamic` one (logical
slots come and go, `addInstance`/`removeInstance`, a live mask the round-robin
skips). Three things that had to be right: ownership is a TOKEN per load, not
the cell key, because a cell's batch lands in a glTF promise continuation
that can resolve after the cell unloaded; an added instance is classified
against the last camera immediately, or a freshly streamed cell's trees wait
up to ten frames for the round-robin; and the LOD system now applies each
submesh's own `localMatrix` when it writes near/mid slots — it never had,
which was a latent misplacement for any model whose meshes carry a node
transform (the demo's do not, so it never showed). Entries with a
`uvRotation` and builds without an owner (the base scene) keep per-build
batches.

**6. Every species had its own impostor atlas, so every species was its own
draw** in every supercell. The baker (`apps/playground/src/impostor-bake.ts`)
now renders each model's 576² block into a shared 4096² PAGE — same two
render targets, 49 models per page — and reports the block as
`ImpostorAtlas.region`. `impostorPageMaterial` reads region, radius and
bounds-centre per instance, so a supercell's every species is one
`InstancedProps` (`impostorPageBatchFor`); per-species materials keep working
on a page-backed atlas by folding the region in as constants. The near ring's
far tiers stay per species: the LOD compaction owns one far mesh per batch.

Left after this pass (155 draws at the spawn, JS 10 ms headless): the near
ring's 7 species × (near submeshes × 4 passes + far) ≈ 60 draws is now the
largest bucket, and only `cascades: 2` or fewer species would shrink it;
far/hlod terrain proxies ≈ 40; base scene ≈ 30.

### Reuse frame transforms across shadow passes

The main pass and three shadow cascades were each walking the entire scene
graph. `EngineRenderer` now updates world matrices once, after lighting refits,
and disables automatic scene updates only for the synchronous render boundary.
The original policy is restored even on failure; manually managed scenes stay
manually managed. Animated bones still update on every new frame. Inactive
editor transform helpers are also detached, removing 156 otherwise-hidden
objects from the playing scene's matrix traversal.

An alternating old/new/new/old policy probe in a settled MMO scene measured
JS frame time of 9.07/8.10/7.91/8.86 ms (about 11% lower with reuse). This was
headless Chrome/WebGPU at a 2560×1440 viewport with the authored pixelation
setting: the actual render canvas was **853×480**, not native 1440p. Streaming
was idle; animation caused minor draw-count variation. These numbers isolate
the transform optimization, not a guaranteed player FPS or a traversal test.
Profiler reports now include browser, visibility, backend, canvas dimensions
and device pixel ratio so unlike sessions are not compared as equivalent.

### Terrain handoffs must retire coverage, not intent

The September 9 MMO snapshot showed missing terrain while supercell replacement
bakes took 2.3–2.7 seconds. Two synchronous retirement paths exposed that delay:
full-detail cells unloaded on demotion before their proxy existed, and promoting
one cell disposed an entire merged part, including neighbours still needing it.
Keep demoted cells as render-only fallbacks; replace merged blocks add-first,
and validate that publication preserves every still-needed cell. A failed or
stale partial bake must not erase the last good coverage. Publication must
invalidate residency even when the player stops moving.

A retiring HLOD block must also stop excluding its cells from the far-tier bake
queue, or waiting for replacement coverage deadlocks. Regression tests exercise
these transitions in `apps/playground/test/chunk-handoff.test.ts` without a GPU.
Map travel now masks arrival until nearby full-detail cells, distant coverage,
and landing collision are present. An elapsed timeout is never evidence that ground exists: keep the
body held and report slow loading, with map re-travel or stopping play available.
These changes address terrain continuity, not the snapshot's unexplained
45 ms/frame off-loop cost; that still needs a browser-level trace.

### Asset browsing must not pre-render the entire library

The September 10 editor session had 3,811 prefabs and 3,931 models. Thumbnail
generation visited all of them at boot and after asset changes, even with their
folders closed. Yielding between bakes did not bound the total model loading,
shader compilation or memory use. The asset dock now browses direct children,
searches descendants explicitly, and pages across all asset kinds. Only the
current page requests baked previews; leaving it cancels queued work before
the next bake. Hiding the editor clears that demand too.

Do not attribute every freeze to the browser grid: the same cave scene recorded
`scene.build` at 34 seconds and `scene.batch` at 1 ms after demand-driven previews
landed. Its CSG volume still meshes synchronously on a cold cache. Moving that
work off-thread must preserve the shared render/physics/placement mesh and keep
the previous geometry and collision valid until replacement is ready. The
`editor.thumbnail`, `scene.build`, and `scene.batch` spans distinguish these
paths in subsequent profiler captures.

### Firefox upload stalls: DynamicDrawUsage is an unconditional upload

The September 10 Firefox trace showed CanvasRenderer consuming 96% of a CPU
core; 83% of its samples included WebGPU buffer writes and 73% included staging
buffer allocation. The content thread repeatedly waited for painting, while
GC slices totalled only about 0.4 seconds in an 82-second recording. This was
CPU-side upload processing, despite short GPU timestamp measurements.

Three r185's common `Attributes.update` treats `DynamicDrawUsage` as a request
to upload on EVERY use, even with an unchanged version. It is not just a driver
allocation hint. Grass placements, impostor attributes and cluster indices now
use explicit `needsUpdate` version changes; particle/bolt/trail data use the
version-gated `StreamDrawUsage` hint. Wind and billboard facing still run in the
shader. Grass commits upload the live prefix instead of unused capacity.

Node uniform arrays also repeat across submeshes and shadow passes. The renderer
compares full CPU-owned node-uniform bytes against the last successful write to
the actual GPU buffer. Identical writes skip; changed poses upload immediately.
Partial writes invalidate the mirror, newly created buffers cannot inherit one,
and GPU-writable storage is excluded. Do not replace this with "once per frame":
different passes can legitimately need different values in the same frame.

Moving-camera uniform groups can also generate hundreds of tiny, separated
writes. Upload their enclosing range once, preserving Three's cached range
objects and restoring the getter-only updateRanges array in place. Assigning
that property throws in the real renderer even if a plain-object test passes.

Grass coverage and upload cost are separate concerns. A completed placement
can expand the coverage-based fade radius in one frame and reveal a ring of
grass. Ease outward expansion over time, clamping long frame intervals; keep
contraction inside available coverage so the mesh edge stays hidden.

Queue-level instrumentation reports actual `gpuUploadCalls`/`gpuUploadBytes`
per frame in the profiler. `perf.uploads` breaks down lifetime per-frame averages
by source, and `perf.uniformUploads` counts reuse. These are upload metrics, not
GPU time. Compare like-for-like camera/gameplay and exclude cold scene builds
before claiming an FPS improvement. Tests exercise the installed Three.js
attribute updater so a future dependency change cannot silently undo the policy.

## Unloaded chunks stayed alive: shared materials pin three's render objects

Long editor sessions on the MMO scene grew until the tab froze. Idle and
standing still in play were flat; **streaming** leaked. Every out-and-back
camera sweep left about 1,050 `Object3D`s, 300 `BufferGeometry`s and 280 GPU
uniform buffers alive, detached from the scene: unloaded `chunk:x_z` groups,
`hlod-proxy` groups and `hlod-supercell` groups.

The retainer is three r185's `RenderObject`. The renderer keeps one per
(object, material, context, lights) it has drawn, holding that object's bind
groups (an object-scope uniform buffer included). The object leaving the
scene frees nothing, and `geometry.dispose()` only clears the attribute
cache. The ONLY release is the material's `dispose` event, and every render
object subscribes to it. This engine deliberately never disposes materials
(they are shared across chunks; see "cache shared GPU resources" above).
So the material's listener array held every render object ever drawn with
it, each render object held its mesh, and each mesh's `parent` held its
whole unloaded group.

The fix is `packages/render/src/render-object-sweep.ts`, run from
`EngineRenderer.render()`. It records every render object three creates,
and every 120 frames it disposes the ones whose object's root was not passed
to `renderer.render()` during the last two sweeps. That is the same
`dispose()` a material disposal runs. Doing this with a live shared material
is safe: shared bind groups, node-builder states and pipelines are
reference-counted and freed only with their last user. A culled object inside
the drawn scene is never touched, because its root is the scene. The fix is
generic, so it also covers editor scene rebuilds and one-off bake scenes, not
only chunk unloads.

Measure it with `apps/playground/tools/leak-probe.mjs` (`stream`, `idle`,
`play`). It forces a GC before every sample and counts live objects by
prototype, which is the only way to see detached-but-retained objects:
`renderer.info` and the scene graph both looked healthy throughout.
Before/after, over 10 minutes of streaming: `Object3D` 2,173 → 8,601 versus
2,141 → 2,336, and uniform buffers 381 → 2,117 versus 347 → 479. Watch
`renderObjectSweep.stats` on the renderer.

## Matrix arrays went generic: every matrix write allocated (three patched to Float64Array)

Play mode on the MMO allocated ~120 MB/s, and about 45% of that was billed to
three's matrix code (`multiplyMatrices`, `updateMatrix`, `compose`). Those
functions only write numbers into existing arrays. The cause was V8 elements
kinds. `Matrix4.elements` is a plain `Array`, and once play started, 21,714 of
27,274 matrix arrays were `HOLEY_ELEMENTS` (generic storage) even though every
value in them was a number. In a generic array, each double written is boxed
as a new heap number.

No code wrote a bad value. A trap on every `Matrix4` method found no
non-number and no reassigned `elements`. The arrays were born as normal double
arrays (for example in GLTFLoader's `new Mesh`) and later flipped inside
ordinary three calls. The flip is contagious: re-packing 4,406 arrays into
clean double arrays saw 3,247 of them go generic again within seconds, because
the keyed-store feedback in the shared matrix code upgrades each array that
passes through it. Chasing V8's heuristics is not a fix.

The fix is `patches/three@0.185.1.patch` (pnpm `patchedDependencies`).
`Matrix2`/`Matrix3`/`Matrix4` construct `elements` as a `Float64Array`, which
has one fixed element type and full double precision, so it can never become
generic. Two call sites needed `Array.from` because they relied on a real
Array: TSL's constant-matrix codegen (`elements.map(generateConst)` would
coerce the generated strings back to numbers) and `GLTFExporter`'s
`nodeDef.matrix` (a typed array serializes to JSON as an object). Measured in
one A/B on the same scene: 118–128 MB/s down to 67–90 MB/s, and frame
p50/p95/p99/max went from 12.4/21.7/29.3/44.1 ms to 10.3/14.4/17.9/24.3 ms,
with identical draws and triangles. Our own code reads `elements` only as
`ArrayLike`. **When three is upgraded, re-create the patch.**

Two traps from the same investigation:

- **Don't use a micro-benchmark's allocation inside the running app as
  evidence.** While the app keeps the compiler busy, the benchmark loop runs
  unoptimized, and unoptimized code boxes every intermediate double. A plain
  `{x,y}` object "allocated" 22 MB per million writes that way. That briefly
  looked like `Vector3` itself was poisoned; in a three-only page it allocates
  nothing. `%HasObjectElements`/`%HasHoleyElements`
  (`--js-flags=--allow-natives-syntax`) are the evidence, together with an A/B
  of the real frame.
- **Chrome on Windows prints nothing from V8's `--trace-*` flags or
  `%DebugPrint`**, even with `--single-process`. Use the natives that return
  values (`%HaveSameMap`, `%HasFastProperties`, the elements-kind predicates)
  and report through `console.log`.

The other allocation sources were plain O(n) scans over every streamed
entity: `ScriptRuntime.findByTag` spread the whole entity map on every call
(now a tag index), and `localPlayerId` / the particle `entityByTag` ran
`Object.entries` over the expanded doc per frame or per raindrop (now cached
and re-validated). Allocation went from 127 to 55 MB/s. The rest is terrain
height/water queries (rain drop births, grass, swim checks) and the particle
writer. In steady play the GC'd heap moves about 30 MB, which is roughly
V8's young generation. Large swings come from garbage left by world loading
and streaming, and V8 frees it with a concurrent major GC.

## Streaming garbage: the worker meshed nothing the main thread used

Flying across the MMO in the editor allocated **202 MB/s** (15.5 GB in 77 s).
The streaming profile (sampling heap profiler, collected objects included, a
scripted camera flight in edit mode) split it into four causes. All four were
fixed, which brought it down to about 32 MB/s. Frame p95 went from 19.2 to
~9 ms and the worst frame from 28.5 to ~14 ms.

- **Near cells were marched twice.** The voxel worker generated each cell's
  doc, then `buildScene` asked `voxelMesh()` for the terrain. The cache was
  empty (only the dedicated server ever called `primeVoxelMesh`), so every
  visible cell ran marching cubes synchronously on the main thread: 169
  misses in two flight legs. The worker's `cell` job now meshes the cell's
  voxel sources and transfers the buffers, and the pool primes core's cache
  before resolving the doc, which took the misses to 0. Only
  `near`-priority jobs do this. HLOD bakes read member cells with `bulk`
  urgency and re-mesh them coarser themselves, so full-resolution meshes for
  them would waste worker time the far ring is waiting on. The `inline`
  simulation ring still builds on the main thread, so spawns never fall
  through.
- **Grass evaluated the terrain once per blade.** The probe lattice already
  cached slope and surface mix at 2 m, but blade height was an exact
  `field.height()` call, kept exact on the theory that an interpolated blade
  floats. Measured against the terrain collider, the reverse is true: the
  drawn ground IS the 2 m lattice interpolated. Exact height is 3.3 cm off
  on average (107 cm worst); bilinear on the lattice is 1.1 cm (28.8 cm
  worst). Height now comes off the probe lattice, and lattice heights are
  shared between neighbouring probes. That second change is exact: `slope()`
  is a central difference at ±voxelSize, which are the neighbouring lattice
  points.
- **Per-frame whole-doc scans in edit mode.** `socket-preview` ran two
  `Object.entries/values` scans over the expanded doc per held-item socket
  every frame. It now indexes once per doc and re-derives looks only when the
  doc or the selection changes.
- **Every cell crossing rebuilt everything in reach.** At a 28-cell far ring
  that is ~3,500 keys. A crossing cost 2.2 MB and 5.6 ms; after these
  changes it is 0.9 MB and 2.8 ms:
  - `computeChunkStates` walks the grid by integer instead of building and
    regex-parsing a Set of keys;
  - `parseChunkKey` is hand-parsed, with a parity test against the old regex;
  - `hasCell`/coordinates are memoized per provider;
  - Map walks use `forEach` (an entries walk allocates a pair per cell);
  - a quadratic hlod/far overlap loop now checks membership per key.

Also: the hierarchy dock re-rendered its entire entity tree on every
streamed-cell publish, because the chunk list lived in the same component.
It is now its own subscriber.

Measuring traps from this pass:

- Time-to-ready A/Bs are worthless while another session edits the repo:
  vite reloads every open probe page on each change (count `framenavigated`).
- Check for stray background processes before timing anything. A forgotten
  `find /` had used 10,000 CPU-seconds.

## Resident memory: the tab built every world and volume in the index (2026-09-26)

Chrome showed the MMO editor tab at 2.6 GB. A headless load (1600x900, 20 s
after streaming settled) measured the game's renderer process at 1.42 GB
private; a V8 heap snapshot and a Chrome memory-infra dump (see
"Measuring" below) split it:

- **Six world fields for one world.** `loadWorldRecipes` built a field for
  every `assets/worlds/*.json`, and voxel-demo ships six (older versions,
  a preview, a test field). The unused five held about 110 MB of the main
  heap. `registerVoxelRecipe` now stores the parsed recipe and
  `getVoxelWorld` builds on first use. The dev-server and live-sync paths
  use it; a recipe edit to a world nothing streams no longer re-streams.
- **Every project's volumes, compiled.** The asset index lists volumes from
  every project folder: 187 dungeon rooms and passages. Parsing a volume
  compiles its triangle solids (the schema's `superRefine` builds the BVH),
  so the MMO tab held ~130 MB of triangle objects for dungeons it never
  draws. `registerVolumeDoc` defers the compile to the first
  `getVolume`/`csgMesh`.
- **One Int32Array per shore cell.** `PolygonIndex` kept each band cell's
  segment list as its own typed array, about 140 bytes of object overhead
  per cell, 100 MB over the six fields. The lists are now packed into a
  single offsets + segments pair: 2.9 MB.

Result, same probe: main heap 386 → ~155 MB, each voxel worker 54 → 42 MB
(they hold the same field, packed now), 300 MB less JS in total.

Still resident and deliberate: six workers at ~42 MB each (one field per
worker); the core mesh cache (128 MB budget); `buffer`-partition strings, most
of which are dev-mode module sources and inline source maps (~135 MB, gone in
a published build). The CSG triangle compiler still stores a JS object per
triangle, so a dungeon scene pays ~1 KB per triangle it uses; packing it into
typed arrays is the next lever there.

Measuring:

- The OS "private bytes" of the renderer swings ±100 MB between identical
  runs, because freed V8 pages are not returned promptly. Compare
  `Runtime.getHeapUsage` per target (main + each worker via
  `Target.setAutoAttach`), not the process total.
- **Playwright enables the Network domain on every page**, and Chrome then
  keeps response bodies (up to ~200 MB) for the inspector. That inflated the
  `partition_alloc/buffer` partition by ~90 MB. An open DevTools window does
  the same thing to a real tab. For allocator-level numbers, launch Chrome
  with `--remote-debugging-port` and use raw CDP: `Tracing.start` with
  `disabled-by-default-memory-infra`, then `Tracing.requestMemoryDump`.
- A 400 MB heap makes a 1 GB `.heapsnapshot`; `JSON.parse` cannot take it.
  Parse the `nodes`/`edges` arrays as numbers straight from the buffer.

## Ground cover at 25 layers: pay per layer that grows, not per layer that exists (2026-09-27)

Adding 23 biome- and water-gated cover layers (`recipe.cover`, see
`docs/world-editing/ground-cover.md`) to the MMO world's two scene layers. The
render side was never the problem — an A/B inside one page session (world
cover group hidden in alternate 2.5 s windows) measured the same median frame
at every spot, jungle 20.8 ms both ways, for +4-5 draw calls. The cost is
CPU PLACEMENT on each recenter, amortised at 2 ms a frame, so it shows up as
cover arriving late while running, never as fps. Three findings, measured with
`projects/proving/tools/cover-bench.mts` (median of nine recenters):

- **`field.waterY` costs a whole height evaluation (6 us).** It answers the
  sea question by computing the ground, which the gate had already done. The
  shared sampler called it per blade to keep grass out of lakes; that made
  the scene's EXISTING grass layer ~2.5x slower per recenter. Now a 0.15 us
  `waterNear` bucket test rejects dry country and only candidates near water
  ask `waterSurface`. Anything per-blade that says "water" deserves this
  check: the expensive answer is almost never needed.
- **A layer outside its place still walked its whole disc.** A gated layer
  pays per CELL, not per blade placed: a wheat layer walked 50,000-130,000
  cells per recenter in grassland with no wheat patch in reach and placed
  none. `GrassSystem.regionTest` asks the host once per placement whether the
  layer can grow ANYWHERE in the disc (biome weights on a 32 m lattice, a
  16 m clump-mask lattice for `floor: 0` layers, lake/river buckets for water
  layers); a "no" commits an empty field without sampling, and an empty layer
  sets `mesh.visible = false` so it costs no draw either. 93 -> 60 ms per
  recenter at the jungle spot, and without it 175.
- **Ring searches belong on the probe lattice.** A shore layer's water line is
  a 13-query ring; per blade that was 3 us and 40,000 blades beside a lake the
  reeds never reached. Cached per 2 m probe (reach widened by the probe's
  half-diagonal so nothing the exact test accepts is lost): 1.6 us.

Net at the worst spots: all 25 layers ~52-69 ms per recenter against ~26-38
for the two base layers alone — which is what the two base layers cost before
this pass. The bench is noisy between runs on a loaded machine (±40%); compare
configurations inside one run.

## Culling behind terrain: measure where the frame goes before expecting a win (2026-09-30)

Built horizon occlusion, screen-size culling and POI interiors
(`docs/culling.md`). On the MMO world it removes 3–5% of draw calls on
average and 12–16% in hilly views, and changes GPU time by nothing — because
the GPU was never the cost: 2–4 ms against 15–30 ms frames. Three things
worth knowing before the next pass at "draw less":

- **Hide by layer, not `visible`.** `visible` has four writers already
  (visibility component, static batching, scripts, the editor). A culled
  renderable moves to `OCCLUDED_LAYER`; shadow cameras are given that layer
  explicitly (three syncs a shadow camera's layers to the main camera's only
  while it has no layer beyond 0), so a tree behind a crest keeps its shadow.
- **Merged blocks cannot be partly hidden.** The largest main-pass bucket at a
  hilly site was 99 HLOD meshes; each is a 4x4 or 8x8-cell merge, hidden only
  when the whole block sits below the horizon. Finer HLOD parts would cull
  better and draw more — decide with the draw count, not the cull count.
- **Async models arrive after registration.** The first use of a glTF lands
  after its cell was built, so a unit re-walks its subtree (two units a
  frame) and adopts late meshes; until then they are never hidden, which is
  the safe direction.

## Animated bounds and thumbnail readback (2026-09-30)

The MMO snapshot `2026-09-30T23-49-22-mmo.json` contained two different
problems: three startup intervals totaling about 20 seconds, and sustained
CPU rendering cost after pending cell loads reached zero. GPU time was only
3.4 ms on average. Do not call the whole report a startup artifact, or compare
its 15 FPS aggregate directly to the older 93–95 FPS spawn benchmark: the
camera, scene content, canvas, and loading state differ.

**Skinned models bypassed every frustum.** All 35 loaded character meshes
drew in the main pass and all three shadow cascades, regardless of location.
Their bind-pose sphere is unsafe for animation, so merely switching
`frustumCulled` on is not a fix. `skinned-bounds.ts` caches source-space
influence boxes, transforms them with the current bones, and includes morph
delta intervals. It evaluates lazily after the complete scene matrix walk
(sibling bones must not be a frame behind), reusing results across passes.
An explicit EngineRenderer render scope avoids repeating bone comparisons in
every cascade; outside it, tools and raycasts still check dependencies. The
affine box transform uses center/extents rather than eight transformed corners.
Index changes, morph weights, teleports, scales, bind matrices and skeleton
replacement invalidate the relevant cached result. Unknown shader deformation
or invalid active morphs fail open. Inactive incomplete morphs do not prevent
culling; the imported MMO body has one with fewer vertices than its body mesh.

In a private WebGPU editor A/B at the human snapshot's position, looking toward
town, toggling only skinned culling reduced draws **564 to 447** in both pairs.
That exploratory probe retained the dynamic bounds getter in its baseline, so
its timings are not a faithful pre-change comparison. The final gameplay
probe restores the original plain `boundingSphere` property and disables
culling for its baseline. Two paired comparisons measured **777 to 678/679
draws**, median intervals **27.0 to 25.2 ms** and **27.2 to 25.1 ms**, with p95
**33.2 to 31.0 ms** and **34.4 to 30.4 ms**. This is about a 7% frame-time gain,
not a return to 89 FPS. Before the per-render cache, animated bounds actually
cancelled the draw savings; do not accept draw count alone as success.
The original snapshot did not record
orientation, so this is a controlled regression probe, not its exact replay.
67,437 indexed character vertices were checked against the world bounds with
zero escapes, and 79,011 in the gameplay close-view probe. An initial manual
image comparison reused Three's cached PassNode output: identical screenshots
are not visual evidence unless its frame epoch advances. When freezing RAF
for a same-pose comparison, advance Three's NodeFrame before each manual draw.
The corrected close-view test shows all three NPCs and their shadows retained.
Mean channel difference on/off was 0.39 of 255, versus 0.78 between the two
culled captures separated by twice the time (moving shader effects). The
images and `skinned-close-pixel-diff.json` are saved beside the probe report.
Unit tests cover blended poses, attached/detached rigs, morph
extrapolation, nonuniform scale/shear, teleports, index edits and safe fallbacks.
Probe and reports: the voxel-demo project's
`authoring/purchased-assets/profile-draw-regression.mjs` and `review/`.

**Async PNG encoding can still block before it starts.** A cold private
editor CPU trace attributed 8.8 seconds of a 60.9-second capture to the
synchronous `canvas.toBlob` call in `thumbnails.ts`. The 96px thumbnail
already had CPU pixels from an async GPU readback, but a default 2D canvas
could upload those pixels again, then stall waiting for GPU work when making
the PNG snapshot. Requesting `{ willReadFrequently: true }` keeps this
temporary canvas in software. In the instrumented cold run, seven synchronous
toBlob calls took 0–0.1 ms each, with the earlier multi-second self-time gone.
This does not change the rendering canvas or thumbnail art. It also does not
prove thumbnails caused the human's particular nine-second gap: that snapshot
did not contain thumbnail spans. Keep loading stalls and steady-state frame
cost separate when validating further fixes.

## Imported furnishings: batch arrival and prune source hierarchies (2026-10-01)

The expanded Brinehold furnishings added about 900 meshes sharing only three
materials. They were submitted separately: their placements did not opt into
static batching, the glTF load path ignored that flag, and the host's initial
batch pass ran before asynchronous models arrived. In the busy-town gameplay
probe this contributed roughly 800 draws even with room culling enabled.

Honor `mesh.static` after model assembly, then coalesce late base-scene model
arrivals into one batch rebuild after outstanding glTF loads finish. Preserve
culling-unit boundaries: a room's furniture must never merge with another room
or the building shell. In this project the fixed furnishing placements opt in
through prefab overrides; shared prop prefabs remain usable for moving objects.

Draw merging alone left most of the CPU cost. Hide a fully merged model root
so projection skips its exported groups, and freeze the fixed model subtree so
matrix traversal skips them too. Freeze the model, not its containing entity:
an edited entity transform must still propagate through the parent-matrix check.
Do not prune roots containing lights or unbatched parts, and restore source
visibility/matrix settings on batch disposal. Animated/skinned/morphing models
remain unfrozen; world-space batching also rejects vertex-displacement shaders
and custom attributes. Hidden source parts must never become batch candidates.

Fresh-load WebGPU validation at 1440x1000 automatically produced 36 furnishing
batches from 899 meshes. Two paired warm comparisons in one gameplay session
measured median intervals **34.9 -> 25.5 ms** and **33.4 -> 25.0 ms**, p95
**40.1 -> 30.8 ms** and **40.8 -> 30.2 ms**, draws **1345/1346 -> 536**.
The baseline restores separate submissions and ordinary source matrix walks;
the scene, camera, materials, room culling and GPU settings stay the same.
This is a 25-27% frame-time reduction, not a return to the older 89 FPS scene.
An interior comparison retained the furniture, with mean RGB error 0.006/255
(4985 pixels differed in a 1440x1000 frame); the two batched captures matched
exactly. Manual captures advance Three's frame epoch, as described above.
Tests cover async arrival, face ownership, parent movement after rebatching,
matrix-walk pruning, lights/hidden parts, and deformation exclusions.

Project evidence: `authoring/purchased-assets/review/furniture-batch-final.json`
and `furniture-interior-*.png`. The reversible placement installer is
`authoring/purchased-assets/batch-town-furnishings.mjs` (`--apply` to install).

## Foliage CPU work and streaming-distance experiments (2026-10-01)

An atlas does not make every plant one draw. Near tree bark/leaves remain
separate submesh batches; distant impostors share atlas pages. Grass layers
share texture pages but retain separate placement/draw batches. Reducing
textures, instances and draw submissions are different optimizations.

**Reuse the camera-ground query across grass layers.** All 27 layers asked
for the same camera height for altitude fading. Cache that sample within a
single `GrassSystem.update`, while keeping placement samples and next-frame
terrain edits independent. Paired loaded-machine measurements reduced the
grass scope from 1.72/2.17 ms to 0.21/0.27 ms. Do not extrapolate the whole
frame gain from these runs: another editor was loading POI scenes concurrently.

**An empty instance buffer can still cost CPU.** Three projects zero-instance
batches and prepares render objects/uniforms before issuing zero GPU draws.
Hide empty leaf batches only during the synchronous render, restoring their
visibility in `finally`. Do not hide batches containing child lights/content,
or overwrite authored visibility between frames. A private cached-list probe
saved about 1 ms with 26 empty batches out of 116; production uses a fresh
visible-tree traversal so dynamic additions and removals cannot go stale.
The integration test checks render failures and repopulation on the next frame.
The production whole-frame speedup still needs a quiet-machine measurement.

**Check retained assets' LOD flags after an art rollback.** The MMO retained
fern scatter rule still had `lod: false`, keeping all 250 pooled ferns in
near geometry at the town probe. Enabling the existing LOD path left 18 near
and 232 in atlas impostors without changing art, density or scale. Near and
distant screenshots were reviewed against full geometry. The catalog and
restoration recipe now record the intended LOD behavior. Logs/stumps remain
separate retained assets. The original six tree scatter rules were already
restored; the older world backup also contained the same 25 ground-cover layers.

**Shorter streaming rings are a tradeoff, not an established fix.** At this
48 m-cell town view, reducing the full-detail radius from 3 to 2 cells reduced
full cells from 29 to 13 and pooled instances from 413 to 142, but draws only
from 531 to 528. Also reducing HLOD 7 to 5 and far terrain 28 to 20 gave 502
draws. The restored baseline was 530. Timing order was inconsistent while
the other preview loaded, so no reliable FPS gain can be claimed. Live ring
distances and cell size remain unchanged. Do not shrink voxel cells merely
to load less: finer cells can increase submissions and streaming overhead.

Evidence lives in voxel-demo `authoring/purchased-assets/review/`:
`foliage-cpu-final.json`, `streaming-distance-comparison.json`,
`streaming-fern-lod.json`, and `fern-lod-{near,far,far-full}.png`.
The private harness blocks authoring POSTs and uses frozen fixture JSON;
close its browser after testing so it does not compete with the human's game.

## Audio: isolate playback, late scripts and resource lifetime (2026-10-01)

The human reported a large historical loss when audio was introduced. At the
current warmed town camera, the native AudioContext was confirmed running
with two non-positional ambience loops. A private same-view sequence suspended
the audio graph, then also bypassed soundscape/emitter updates, footstep/weather
audio helpers and playback requests. Repeated normal intervals were 23.2,
22.3 and 22.0 ms median; bypassed intervals were 23.3 and 23.0 ms. Draw counts
stayed at 532-533. The first normal sample was slower (26.1 ms), so comparing
only that first sample with the first suspended one would incorrectly suggest
a large gain. Listener transform writes remained active during suspension and
cost only a few hundredths of a millisecond per frame in the instrumented run.
Soundscape late work averaged about 0.08-0.09 ms per frame, with individual
sampling peaks up to 1.6 ms. This does not reproduce the historical regression,
nor test a long session or an area with many positional emitters.

**The old profiler hid late audio work inside animations.** Its per-script
scopes covered fixed updates only, where soundscape does essentially nothing.
The host now separates animation, late scripts and cloth; ScriptRuntime
attributes late updates by script name and closes the scope even on a failure.
Use those scopes in new snapshots instead of treating the old fixed soundscape
number as its total cost.

**Scene removal does not disconnect Web Audio nodes.** AudioSystem now
disconnects source/panner/gain paths on natural completion, eviction, loop
replacement and stop. Its completion handler preserves Three's playback-state
bookkeeping. A generation token prevents a pending decode from starting an
old-session sound after Stop. Repeated identical loop volumes no longer enqueue
gain automation; changed volumes still update and pending loops retain their
latest gain. These are lifecycle and redundant-work fixes, not evidence that
audio caused the reported FPS loss. Offline tests cover each release path and
pending loads; a native Chrome AudioContext check verifies the operations with
real audio nodes, 24-voice eviction, natural endings and stop/restart handling.

Project evidence: `authoring/purchased-assets/review/audio-comparison.json`
and `audio-lifecycle-native.json`; replay scripts are `compare-audio.js` and
`audio-smoke.mjs` in the parent directory. `HITREG_PERF_AUDIO=1` enables browser
autoplay in the private benchmark harness so a suspended baseline cannot
silently masquerade as active audio.

## Town characters: duplicate transforms and distant pose scheduling (2026-10-01)

Bone sockets explicitly updated a bone, then called position/quaternion getters
that each walked its ancestors again. Parent conversion repeated the work.
Read the freshly updated matrices directly: one decomposition supplies the bone
pose and the already-current parent supplies the inverse transform. This retains
scaled-parent behavior and both fixed/late refreshes. Cached numeric parameters
replace JSON stringify/parse in the hot path. Tests check moving, rotated and
scaled ancestors and one ancestor refresh for a single-bone socket.

Animation pose LOD is opt-in through the `animator` schema (`poseLod` in the
generated spec). Town generation and the installed 25 Brinehold residents use
full-rate poses nearby, 20 evaluations/second from 40 m, and 10 from 100 m.
Only stable loops qualify. One-shots, layers, held blends and transitions stay
full-rate; the camera-followed entity is protected through its visual delegate.
Both hosts supply their render camera; omitting it preserves the old behavior.
Physics and AI retain their original schedules.

Skipped evaluations accumulate elapsed time. Phase queries include that debt,
and clip/rate changes flush it against the OLD action before changing state.
Returning to the near range evaluates the current pose immediately. Stable
per-entity phases spread distant crowd work across frames instead of producing
a synchronized animation hitch. Tests cover near/mid/far rates, parent delegates,
camera teleports, playback phase, attack completion, layers, fades, speed changes,
stop/restart and crowd scheduling.

No live benchmark was run: the owner authorized established optimization work
while reserving their GPU for another game. Functional checks establish behavior,
not an FPS gain. The project installer and reversible scene ops are in voxel-demo
`authoring/purchased-assets/enable-town-pose-lod.mjs` and
`review/town-pose-lod-*.json`. House shells already opt into static batching;
further exterior draw reduction requires material or spatial changes, not simply
reapplying that flag.

## Moving equipment: omit hidden holders, retain unchanged uploads (2026-10-01)

Moving item batches skipped the draw when every holder was hidden, but drew
every registered holder as soon as one was visible. A zero part mask collapsed
the hidden copies without avoiding their vertex shader work. A character can
have sockets registered for several weapon types and unworn clothing, so most
holders in an otherwise visible batch can be inactive.

`MovingInstanceSystem` now packs only holders with a nonzero part mask and a
visible ancestor chain. Registration and entity-level effect anchor queries
stay independent of packed GPU indices. A slot move or buffer rebuild uploads
all attributes together; retaining only the matrix would give the incoming item
the previous occupant's glow, texture or hang placement.

Shown holders compare current world and hang matrices with their last uploaded
double-precision snapshots. Unchanged poses skip buffer writes and upload flags;
hidden holders skip transform work altogether and refresh on reveal. Do not
compare a double-precision world matrix against its float32 GPU copy: rounding
alone would make an unchanged item look dirty forever. This also lets reduced
NPC pose evaluation avoid repeated equipment uploads between pose changes.

Functional tests cover hidden mixed batches, stationary upload versions, ancestor
movement, visibility restoration, swap removal, re-registration, growth, appearance,
glow and changing/removed hang transforms. No live FPS benchmark was requested.

## Flat ocean cells: collapse geometry, preserve seams and edits (2026-10-01)

The world stores its recipe, temporary density samples and cached surface meshes;
it does not retain a dense voxel volume for every loaded cell. There is still
waste in a perfectly flat sea-floor cell: MC emits its full interior grid.
`flatCellMesh` in the shared voxel mesher now collapses a proven uniform surface,
with the full boundary lattice and skirts retained. All padded density columns
must match, with one upward crossing, and surface attributes must match at every
original vertex. Slopes, caves, blobs, raster edits, multiple surfaces and paint
variation fall back to ordinary MC. No depth cutoff removes undersea content.

An offline geometry audit of four deep-ocean cells in the current MMO recipe
produced 289 vertices / 288 triangles / 26,576 mesh-array bytes per cell. The
ordinary 24x24 flat MC grid plus skirts is 817 / 1,344 / 81,488: about 79% fewer
triangles and 67% fewer retained array bytes, excluding GPU/physics overhead.
That is a geometry count, not an FPS measurement. The full density block is
still sampled to establish the proof; this is not a sampling-memory reduction.

Tests compare boundary samples, normals and attributes with ordinary MC, check
LOD joins and fallbacks, and drop physics bodies onto collapsed interiors, edges
and four-cell corners. The HLOD generator version is bumped so persisted bakes
do not keep the older dense geometry. Project evidence:
`authoring/purchased-assets/review/flat-seafloor-geometry.json`.

## Prune non-rendering branches before the shadow passes (2026-10-01)

A clean MMO CPU profile spent about 20% of sampled time in Three's
`_projectObject`. The visible graph contained 2,755 bones and 4,397 groups;
the main view and three cascades walked them all. Bone-only rigs, empty
equipment holders and groups containing only hidden content cannot contribute
a draw, but still paid those visits. This was CPU work: the GPU took about
3 ms while the whole frame took over 20 ms.

The renderer's existing empty-instance pruning now also prunes entire empty
branches after updating world matrices. It restores visibility in `finally`.
Zero-layer content can be pruned; layer 29 cannot, because shadow cameras see
it. Attached meshes/lights keep their ancestor paths alive. LOD and bundle
subtrees retain their own per-camera policies. Bone-only structural results
use a weak cache invalidated by child attachment/removal/reparent events;
visibility verdicts are recalculated every frame. Animation, physics and
matrix updates keep their original schedules.

Alternating baseline/optimized/optimized/baseline runs in one isolated Chrome
WebGPU session measured 23.30 -> 20.09 ms average frame arrival facing town
(about 43 -> 50 FPS). A warmed full camera rotation measured 24.79 -> 21.87 ms;
the first rotation compiled newly visible content and is not a steady-state
comparison. The viewport was 1440x1000 with the authored pixelation setting
(692x480 canvas), GPU timestamps enabled. Frozen before/after/before images
were byte-identical in two headings, with identical draw/triangle counts.
This removes traversal work; it does not reduce draw distance or geometry.

Project evidence and replay probes: `authoring/purchased-assets/oct1-*.js`
and `review/oct1-{isolated.cpu,prune-final-ab,town-ab,rotation-ab}.json`.
The visual reports are `oct1-visual-parity.json` and
`oct1-town-visual-parity.json`. An experimental transform cache was slower
and was not installed. Remaining CPU costs include per-draw submission and
the world-matrix walk; lower texture resolution is not the lever this profile
points to.

## Town overview: preserve silhouettes with authored 3D proxies (2026-10-01)

An overhead town view sees most buildings at once; frustum culling cannot remove
visible roofs. Brinehold's base-scene district assets were outside the streamed
HLOD path and retained 28 material primitives over 96,394 triangles. Texture
sharing alone does not collapse those draws. The atlas/bake policy is in
`docs/town-baking.md`.

The static instanced path now accepts an authored single-mesh/material far proxy
and a per-asset distance (mesh schema/spec). Different distance/shadow policies
split into separate batches, including pooled assets. Invalid proxy loads retain
detail, and a delayed load must respect the owner's release. Distance hysteresis
remains active; neither physics nor the source model is replaced.

An isolated two-district fixture compared actual source and proxy output from a
hill and above, then approached the buildings. Camera-facing district impostors
saved draws but changed the roofs too much and were rejected. A simplified 3D
proxy, retaining source coordinates with averaged source-material vertex colours,
kept the skyline at the reviewed distance. Installed at 450 m, with return to
geometry inside the existing hysteresis band. Trees were not changed.

Measured fixture counts: town geometry 28 -> 2 material draws, 96,394 -> 69,508
triangles. Including the fixture's two other draws: 30 -> 4. This is **not** a
whole-world FPS measurement; the rest of the scene, shadows and CPU work still
matter. The proxy is primarily a material/submission saving, not an aggressive
triangle collapse. Source hashes invalidate derived proxies after rebuilding.

The same audit found fully height-faded grass still being submitted. Its shader
alpha was zero but its mesh remained visible. Hide that layer until descent,
retaining placements; empty layers must remain hidden too. Density is separate:
MMO's added fern layer overlapped the original shrubs. Its placement rebalance
reduced sampled ferns 580 -> 129 and shrubs 135 -> 93, while sampled tree placements
were identical. Ground-cover density was reduced 20%; the 25 cover layers still
use three atlas sheets, with a draw per occupied compatible layer, not one draw
for the entire atlas. Near imported plants/rocks still have separate material
batches; distant foliage uses shared impostor pages.

Project evidence (archived 2026-10-08 to `projects-archive/restructure-2026-10-08/voxel-demo-authoring/`): `authoring/towns/distant-town-solid-review/`,
`authoring/towns/brinehold-lod-catalog.json`, and
`authoring/purchased-assets/review/{clutter-draw-audit,clutter-rebalance}.json`.

## Atlas-backed POIs still drew one prop at a time (2026-10-01)

The town-overview complaint persisted after the district proxy: the live view
reported 638 draws with no streaming loads. A matching private overview had 633;
Packers' Meadow contributed 130 and the cemetery 85 main-pass submissions. Their
prefab children still declared `mesh.static: false`. The earlier furniture pass
covered town interiors, not the newer outdoor placements. Both used existing
atlases, but that did not make them enter the static batcher.

The project installer `authoring/purchased-assets/batch-fixed-world-dressing.mjs`
marks fixed placement meshes and prefab children static through scene ops. It
rejects animated/skinned models, behavior-bearing ancestors, nested/behavioral
prefabs, wind and moving meshes; batching itself preserves shader/deformation
exclusions and culling-unit boundaries. Original transforms, colliders, effects,
materials and asset files are retained, with inverse ops for the 503 placements.
The catalog check also exposed two older uncatalogued variants; their existing
sources and manifests were registered before installing.

A clean-load comparison at the same camera reduced **631 to 361 draws**. Both
loads retained 6,278 instances in the distant foliage pages. Main geometry stayed
essentially unchanged (1.2253M vs 1.2257M submitted triangles); a batch may retain
a few formerly individually culled triangles. Overview and close meadow images
were reviewed. This is a private editor reproduction, not a promised player FPS.
Do not sample immediately after a structural ops rebuild: one attempted sample
had zero profiler frames and captured rebuild counters. Require a real sampling
window and use a clean load when validating the installed output.

## Distant foliage: preserve per-instance metadata and placed bounds (2026-10-01)

An interleaved impostor page had become ordinary vertex attributes in
`instancedGeometryFrom`: `InterleavedBufferAttribute.clone()` without a clone
context de-interleaves into a plain `BufferAttribute`, losing the instance
divisor. Quad corners then read different trees' atlas metadata; splitting the
metadata also negates the shared vertex-buffer layout. The symptom is malformed
or missing distant trees even though scatter counts and LOD distances never
changed. Preserve the already per-batch `InstancedInterleavedBuffer` attributes,
just as the ordinary instanced attributes are preserved. Tests must inspect the
FINAL `InstancedProps` geometry, not just the page geometry before wrapping it.

`Box3.expandByObject` also needs object-level bounds for custom instancing:
the base vertices omit placements, and impostor-page vertices are all zero.
Instanced props now supply placed boxes, and pages explicitly union each canopy's
bounds. Union complete instance spheres as well; merely copying the first centre
into an empty sphere left its negative radius intact and could omit that tree.
Regression tests cover single/multiple trees, translated parents, canopy heights
and retained per-instance buffer semantics. No tree draw distance was shortened.

Evidence: voxel-demo `authoring/purchased-assets/review/` files
`overview-draw-audit.json`, `poi-batch-probe.json`, `fixed-dressing-browser.json`,
`fixed-dressing-*.png`, and `fixed-world-dressing.json`.

## Town residents: skinned bodies, their shadows and held poses (2026-10-02)

"Performance halved when the people came in" (Tidewell, 25 residents, scene `proving`). Scene-copy
A/B and in-session toggles at the spawn: the residents cost 3.4-4.8 ms of a CPU-bound frame (GPU
~2.5 ms), almost all of it the 25 SKINNED BODIES (hiding only the bodies saved as much as hiding
the residents; heads, hair and gear already batch to ~15 draws). Each body draw cost ~50 us against
~17 us for a static draw (bounds, bone upload, bindings), and its shadow draws were roughly half of
that. The bone matrix walk added 0.85 ms; furnished interiors and their five unshadowed lights were
small by comparison.

Three contained savings, each switchable for an A/B:
- `EngineRenderer.skinnedShadowDistance` (default 40 m, `skinned-shadows.ts`): a skinned mesh's
  `castShadow` reads false inside a render frame beyond that distance (2 m hysteresis); outside a
  frame it reads as authored. At the boundary a resident's ground shadow switches off at once.
- `AnimationSystem.holdBones` (default on): on frames pose LOD skips, the skeleton's matrix walk is
  skipped too (parent-matrix comparison, like static-transforms), and `character-look` skips socket
  upkeep while the model's `userData.poseVersion` and its parent's world matrix are unchanged.
  Off: every frame walks and attachments recompute, as before.
- `tools/town-npcs.mts` gives each resident `culling.minScreenPx: 6`, and parents a resident with
  `place.inside` under that building's interior unit.

Measured with the machine busy with other work (frame medians noisy; counters are not):
shadow draws 381 -> 365, `render/matrices` 1.74 -> 1.38 ms, `character-look` 0.59 -> 0.36 ms,
`render/draw` 16.5 -> 15.9 ms. The real fix is an instanced skinned-body path (not built).
Probe: `apps/playground/tools/town-perf.mjs --scene proving [--legacy]` writes a JSON report keyed by
the scene hash (frame p50/p95, draws, triangles, shadow draws, animated bodies, lights).

## Proving unplayable: a load-everything boot, an 11 s precompile, and a frame spent on objects nobody can see (2026-10-07)

"Opening the engine takes 15 minutes and freezes; walking 10 minutes and the page dies." Measured
on `proving` (dedicated server, 81 mobs), dev client, headless Chrome with real WebGPU, 1600×900.

**Boot.** The editor's `/__hitreg/assets-index` (and the server's `playgroundRoots`) listed EVERY
project under `projects/` — 22 of them, ~5,400 JSON files and 200+ MB parsed at boot — when
proving reaches ~1,100. Projects now declare `project.json` `dependsOn`; the index is scoped with
`?scene=` to the owning project's closure (same rule on the server), and switching the editor to an
out-of-scope project reloads the page. Vite also watched every non-`assets/` file under `projects/`
(one handle per folder; it is what blocked moving a project folder on Windows) — it now watches only
`projects/*/scripts`. Ten orphaned agent dev servers (each a recursive watcher on the 8 GB tree) were
part of the "freezes" too: stop stale servers before believing any measurement.

**The 11 s freeze.** `rebuildStaticBatch` called `renderer.precompile(scene)` — "deliberately not
awaited", but the shader codegen inside `compileInSceneContext` is synchronous per render object, so
the whole scene was one 10.7 s main-thread block, repeated on every re-batch. Precompile is now
time-sliced (≤6 ms per frame, subtree units of ~300 objects, after the post chain's first frame), and
a re-batch compiles only the new batch group. The total compile work is unchanged; it just no longer
stops the tab.

**The frame (24 → ~57 fps at the spawn, work 40 → ~15.5 ms):** in order of what each was worth —
- *A screen-size cull* (`EngineRenderer.minScreenRadiusPx`, default 2.5 px of radius, in
  `hideNonRenderingBranches`): ~250 of 310 main-pass draws were objects >250 m away at <10 px.
  Hidden per frame only (restored with the empty branches), also skipping shadow passes; static
  subtrees are culled whole from cached bounds keyed on the frozen root's version. TRAP: an instanced
  mesh's geometry sphere is ONE instance — judging a forest by it hid every distant tree. Instanced/
  batched objects are judged only by their own instance-covering sphere, else never culled.
- *Implicit static* (`BuildOptions.autoStatic`, host rule `STILL_COMPONENTS` in main.ts): an entity
  whose own and ancestors' components can never move it (no script/rigidbody/animator/billboard…)
  batches and freezes like `mesh.static`. In play mode whole still subtrees are frozen
  (`freezeStaticSubtree`), refreshed when a model lands inside, thawed on stop. Batches also prune
  fully-merged still entity groups so no pass walks a town of empty groups.
- *Default pose LOD* (`AnimationSystem.defaultPoseLod = CROWD_POSE_LOD`): no prefab had opted in, so
  all 81 mobs posed at full rate at any distance (−2.4 ms A/B). Same guards as authored poseLod.
- *Shadow passes skip caster-free branches* (three's ShadowNode walks and frustum-tests the whole
  scene, filtering castShadow only afterwards): hidden around `render(scene, shadowCamera)` only;
  lights stay so the light set (pipeline keys) never changes.
- *Per-frame `getWorldPosition` on frozen objects* (ambient VFX, light budget) re-derived every
  ancestor matrix; `readWorldPosition` reads `matrixWorld` when a frozen root owns it.
  `bone-socket` skips when the pose version, parent matrix and offsets are unchanged.
- *Town kits re-embed the same textures*: 55 town GLBs carried 658 images, 37 distinct. Embedded
  images are now named by content at load (`gltf-dedupe.ts`, scoped by asset folder) so
  `shareNamedTextures` applies; identical materials share one object (681 → 252 textures). Batches
  of POI-tagged shells now merge per 256 m cell instead of per building (each building used every
  material once, so per-building buckets never merged); authored `culling` units keep their own.
- Profiler: script loops opened a scope per INSTANCE (two clock reads each, even for scripts with no
  handler). Skipping non-implementers and one scope per run of same-named scripts: 0.6 → 0.3 ms.

**Measuring.** Headless rAF looked capped at 60 fps with the profiler off; read FRAME WORK instead
(sum of time inside rAF callbacks — wrap `requestAnimationFrame` in the page) and keep 70 fps = ≤14.3
ms. Client cost depends on server state: a fresh server (mobs at their spawns, near the player) cost
~2 ms more than one that had run for an hour. Start a fresh server per measurement, and never run two
game servers beside the client. The time-sliced precompile occupies the first minute after load —
settle ~60 s before reading steady state. A/B inside one page session (runtime switches:
`renderer.minScreenRadiusPx`, `renderer.skipShadowless`, `animations.poseLodEnabled`,
`__hitreg.freezeStatic(on)`, `__hitreg.rebatch()`).

**Still open** (≈15.5 ms work at proving's spawn; ≈14.5 with the settings below):
- `proving`'s own settings: `voxelWorld.rings.farTerrain` 28 → 18 and `hlod` 7 → 5 (fog hides most
  of that range; 2,453 → 1,009 chunks, 64 HLOD draws shrink) plus sun `shadow.cascades` 3 → 2 measured
  ~1.1–1.7 ms together. A content decision, not applied.
- Per-draw cost in three's WebGPU renderer (~25–40 µs: bindings `_update`, `updateForRender`) is now
  the floor: ~200 main-pass draws. Fewer requires a town material ATLAS (one material per kit, not per
  Blender material) or render bundles (three re-records only on version bumps, so culling/visibility
  changes need care), or the instanced skinned-body path for crowds.

### Tried and reverted: three's render bundles for static batches (2026-10-07)

`THREE.BundleGroup` records a group's draws once and replays them, but in three r185 replay still
runs `updateForRender` for every render object whose nodes need a refresh — and every object's
model-view/normal matrices are camera-dependent, so that is every object, every frame. The bindings
`_update` cost (the largest per-draw cost left) is NOT skipped. A bundle is also recorded with
whatever frustum culling applied at record time, so it has to be recorded unculled (members
`frustumCulled = false`) or re-recorded on every camera turn; unculled, the 269 merged meshes all
drew where ~23 were visible. In-session A/B: 25.5 ms bundled vs 21.4 ms ordinary. Do not retry
without a renderer path that keeps per-object uniforms out of the per-frame loop.

Town atlas (`tools/town-atlas.mjs`, see docs/town-baking.md) + farTerrain 28→18: main-pass draws at
the proving spawn 202 → 142, frame work ~1.1 ms lower.

### Opening the editor on proving: 0.5 fps for a minute and a half (2026-10-07)

Measured as an fps timeline after `?scene=proving` loads (edit mode, editor UI visible). Before:
1 fps with single frames of 17.8 s for the first ~45 s, steady 60 fps only at ~110 s. Causes:
- **Shader codegen.** proving holds 430 materials → 561 NodeBuilder runs (≈40 ms of JS each) that
  collapse to only 175 distinct GPU programs: three keys its builder cache on node IDENTITY, so two
  identical-looking materials with their own uniform nodes both build. The VFX system makes one
  material per module instance (101 for the town's torches/braziers), primitives/data materials
  ~107, world cover 25. The first draw builds everything visible synchronously (the 13–18 s frame).
  OPEN: share VFX/cover materials per look with per-instance values as attributes or object-scope
  uniforms — the same cure the particle emitters already got (§ "first cast of every spell").
- **Precompile units too big.** The time-sliced precompile checks its budget between units; a
  300-object unit held several new materials and ran for seconds. Units are now ≤24 objects.
- **`validateScene` was O(n²)** (it rebuilt the doc's key array per entity) — ~2.3 s of every
  rebuild on the expanded 12k-entity world, and a rebuild runs whenever an agent writes the scene.
- **Hierarchy panel**: `childrenOf` per row is O(n) — O(n²) per render; now an index per doc version.
- Noted, not changed: `applyOps` `structuredClone`s the whole doc per batch — on a 2 MB scene that
  alone can exceed the 50 ms data-op budget.
After: steady 60 fps at ~80 s, worst frame 12.9 s. Probe: an rAF fps timeline from page load in
edit mode (play-mode probes that wait 60 s for "settle" never see any of this).
