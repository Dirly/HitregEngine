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
`sharedAssetMaterialCache`, `midTierGeometryCache`, `billboardTextureCache`).
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

## TSL instancing mutates `positionLocal` in place — read `positionGeometry` for the raw local vertex

Three's WebGPU node-material instancing pass does
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
