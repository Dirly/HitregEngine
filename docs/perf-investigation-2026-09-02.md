# Voxel-demo performance investigation — 2026-09-02

Status at time of writing: **~70 fps standing still, drops and stutters while
moving or rotating the camera.** Terrain still visibly pops in.

> **Update, later the same day (§8):** the rotation stall was three generating
> shader code per `InstancedMesh` object, and the background precompile was
> compiling for the wrong render context. Both fixed; cold rotation worst
> frame 235 ms → 14 ms, streaming flight 0 frames over 50 ms.

That split is the single most important fact in this document. Steady-state
rendering is fine. Everything that remains is **transition cost** — work paid
when content streams in, changes LOD, or first enters the frustum.

---

## 1. Where it started

First profile snapshot (editor, play mode):

```
16 fps · frame p50 33ms / p95 165ms / worst 2210ms
render/draw 38.69ms self  (main-thread JS)   vs 13.58ms GPU
draw calls 500-627 · triangles 3,597,840
```

## 2. What was measured and FIXED (with numbers)

| change | effect | how verified |
| --- | --- | --- |
| `mergeModelSubmeshes` — merge a model's same-material submeshes at load | draw calls **776 → 294** | one kit house was 89 submeshes / 726 tris = **356 of 732 draw calls**, because each costs a call in the main pass *and* every shadow cascade |
| HLOD far-ring props stop casting shadows | **−26% triangles** | the same function already did this for far-ring *terrain*, with a comment saying cascades don't reach the far ring, then contradicted itself two blocks later |
| Voxel cell generation → worker pool | long-task **833/1026ms → 72/102ms** | `fbm2` was 14.5% of all main-thread self time |
| HLOD coarse meshing → worker | (no measurable change alone; kept, the merge builds on it) | |
| Supercell mesh+merge → worker (`mergeVoxelMeshes`, pure typed-array) | worst-frame JS **1323 → 890ms** | merging was ~3.9s of a 30s flight, larger than the meshing it followed |
| Grass: recenter hysteresis + bounded sample cache + amortised placement | worst-frame `update/grass` **93.6 → 6.6ms** | the patch centre snapped to a grid with **no hysteresis**, so orbiting a stationary player flipped cells continuously |
| Frame-budgeted cell integration (2.5ms/frame, nearest-first) | spreads publish cost | the old cap of 3 concurrent loads was written when loading was synchronous; after the worker move it capped *waiting*, throttling 6 workers to 3 requests |
| Supercell publish frame-budgeted (1/frame) | targets off-loop | publish built geometry, reparented, and disposed 15 cells of GPU objects in a promise continuation — invisible to scope timers |
| HLOD prop merge rewrite | fewer copies, no de-indexing, no redundant bounds | `prepForMerge(x.clone())` cloned *every* attribute then de-indexed at 3-6x vertex count, then deleted the extras |
| Sun shadow cascades **3 → 2** | draw CPU **−22%**, 6 passes → 5 | every draw call is paid once per pass |
| `HLOD_VOXEL_COARSEN` 2 → 4 | vertex memory **291 → 247MB** | |
| Bush scatter density 0.03 → 0.012 | triangles **1.79M → 1.01M**, foliageFar 304 → 186 | bushes were 3x the tree density and 12x the boulders |
| **LOD handoff bug** — proxy dropped on *intent*, not arrival | fixes terrain holes showing ocean | `nearOwned` was built from the DESIRED tier, so a promoted cell's merged proxy was disposed while the real cell still had a queue + worker round-trip + frame budget to clear |
| Editor: stop publishing the streamed-cell list during play | targets editor off-loop | the hierarchy rendered **one unvirtualised DOM row per resident cell (720)** and re-published on *every* load and unload |
| Voxel worker pool leak | 6 workers leaked per scene rebuild | `activePool` was replaced without terminating the old one |

## 3. What was tried and REJECTED (do not redo without reading why)

- **`compileAsync` precompile of streamed groups.** Measured **+15% on pure
  rotation** but took `programs` 263 → 1006 and never validated during
  streaming; was disabled pending measurement. Gating `scene.add` on
  it dropped the player through the world **twice** (see §5). **§8: it was
  compiling for the wrong render context; fixed and re-enabled.**
- **`cullSmallShadowCasters`** — sat after `batchStaticMeshes` where it could
  cull nothing; `mergeModelSubmeshes` solves the real problem.
- **Tighter rings (`farTerrain` 14→9, `hlod` 7→5)** — *worse* draw CPU despite
  40% fewer triangles, almost certainly re-streaming churn at the boundary.
- **`hlodSupercellFactor` 4 → 8** — −19% draws but **+42% triangles** (coarser
  culling granularity). Bad trade.
- **`HLOD_VOXEL_COARSEN` 4 alone** — barely moved CPU; frustum culling already
  discards most far-ring geometry before submission. Kept for the memory win.
- **`hlod-proxy` per-bake material cache → module-level.** Correct and kept,
  but produced **no measurable improvement**.

## 4. Measured but NOT applied (needs a judgement call)

**`cellSize` 48 → 96 with `resolution` 24 → 48** (identical 2m voxels, rings
halved to cover the same distance):

```
                    draw CPU   calls   tris    geometries   chunks
48 / 24 (current)     9.20ms     221   1.27M      515         613
96 / 48               5.95ms     143   2.12M      277         149
```

**−35% draw calls, −35% draw CPU, −76% resident chunks**, at the cost of
**+67% triangles** (a 96m cell is culled as one unit). Trades CPU for GPU.

## 5. Invariants learned the hard way

- **Never delay `scene.add(group)` for a streamed chunk, and never delay
  `sim.addEntities`.** Streamed terrain's collider is cooked from the BUILT
  objects, so anything postponing the add postpones the ground and the player
  falls through the world. Hit three times: once via async generation, twice
  via precompile-before-add. Attaching physics first does not help —
  `sim.addEntities` needs the same objects.
- **`gapMs = interval − the PREVIOUS frame's JS.`** Sorting spike frames by
  wall-clock interval therefore shows the frames *after* each stall, which all
  look innocent. Sort by JS-in-frame.
- **Check `drawCalls`/`triangles` before believing any win.** A change once
  reported 129 fps / 3.14ms — because the player had fallen through the world
  and the frustum was empty.
- **Do not measure on a machine that is also running the probes.** Killing four
  stale dev servers moved the app from 21.9 → 37.9 fps on its own.

## 6. What is still wrong

Standing still is ~70 fps. The remaining cost is entirely transitional:

1. **First-draw cost.** WebGPU compiles a pipeline per material/geometry pair
   on first *draw*, inside `render()`. Rotating reveals cells that are loaded
   but never drawn. Isolated test (nothing streaming, chunk counts identical
   before and after): **517ms worst frame from rotation alone**, with
   `render/draw` at 351ms of it. `programs` climbs 269 → ~1000 over a flight.
2. **Off-loop dominance in the editor.** A snapshot read **js 20.5ms / GPU
   13.7ms / off-loop 62.1ms**. Off-loop is invisible to every scope timer.
   Candidates: GC, shader compilation, promise continuations, blocked GPU
   queue, and (editor only) React/DOM.
3. **Terrain still pops in**, and the frame drop coincides with the LOD swap to
   higher resolution — i.e. exactly when new geometry is first drawn.

## 7. Instrumentation available

- **Editor**: Shift+P profiler, snapshots to `apps/playground/.hitreg/profiles/`.
- **Published build** (`node tools/publish.mjs voxel-demo voxel-demo.scene.json`,
  serve `dist/voxel-demo/`): stats HUD top-right, **F3** hide, **F4** GPU
  timestamps. Same `Profiler` as the editor, so numbers are directly comparable.
- `window.__hitreg` in dev builds: `{renderer, chunkManager, profiler, controls,
  scene(), info(), graphStats()}`.

---

## 8. Resolution — later the same day

The isolated question in §6.1 has an answer, and it was neither of the two
candidates. Per-function timing inside `render()` (`tools/perf-probe.mjs`,
which wraps three's `Nodes`, `Pipelines`, `Bindings`, `Geometries` and the raw
WebGPU device/queue methods per frame):

```
pure rotation, 613 chunks, loading 0, one 360° lap (90 frames)
  three.nodes.getForRender      2640ms x211    <- shader CODE GENERATION (JS)
  gpu.writeBuffer                150ms x203789 <- per-object uniforms, steady-state
  three.geometries.update         98ms
  three.backend.createAttribute   18ms x537    <- first-draw geometry upload
  gpu.createShaderModule / createRenderPipeline  < 1ms per frame
```

Every spike frame was 3-5 node-builder runs at ~60 ms each. Not pipeline
compilation, not buffer upload: **three generating WGSL on the main thread.**

Why it never settled: three keys a node-builder state by `object.uuid` for
every `THREE.InstancedMesh` (`RenderObject.getMaterialCacheKey`), so each
instanced prop batch — one per (cell, prop, submesh, LOD tier) — is generated
from scratch on first draw. 49 of the 57 builds in a lap were instanced meshes
over 7 materials. And the uniform-buffer instancing path bakes the batch
CAPACITY into the WGSL, which is what multiplied `programs`.

Why the precompile never helped: `compileAsync` resolves a RenderContext for
the canvas at nesting depth 0, while the post chain draws the scene into its
MRT pass at depth 1. Contexts are part of the cache key. It compiled states
nobody used.

### Fixes (both in `packages/render`)

1. **`InstancedProps`** (`src/instancing.ts`): prop batches are a plain `Mesh`
   over an `InstancedBufferGeometry` carrying the instance matrices as four
   interleaved `vec4` geometry attributes; `applyInstancedProps` installs the
   transform as a position node on the cached per-asset material. One shader
   per material per pass. Same API as the LOD system used (`setMatrixAt`,
   `instanceCount`, `instanceMatrix.needsUpdate`, per-instance raycast).
2. **`EngineRenderer.compileInSceneContext`** (`src/renderer.ts`): the
   background precompile borrows the scene pass's render target + MRT node and
   forces the call depth for `compileAsync`'s synchronous prologue, so its
   states are the ones the frame uses; shaders build with three's yields and
   pipelines with `createRenderPipelineAsync`. The editor hook is re-enabled;
   supercell publishes go through it too. The collider did NOT need decoupling
   — add-first still holds, the compile simply runs after the add.

### Numbers (published build, headless Chrome, WebGPU)

```
                                 rotation lap 0 (cold)              30 s streaming flight
                          js sum  p50   p95   max   builds   >50ms  max js  max gap  builds
before                     3685  11.1  215.6  234.8   57        (unmeasured: 517 ms frames)
InstancedProps             1221  13.5   18.6   71.4    1        2      82     623       3
+ context-correct precompile 786   8.2   12.4   14.4    0        0      41      68       0
```

Draw calls (224-262) and triangles (~1.29 M) identical across all three; the
player stayed on the ground (target y 11.4 throughout). Second laps were
already clean before, which is what pinned it on first-draw cost.

Node states at settle 135 → 49, programs 146 → 55 and flat over a flight.
`gpu.writeBuffer` calls per lap also fell 200 K → 60 K (the uniform-array
instancing path wrote each batch's whole matrix array every frame).

### Two things the context borrowing had to get right

- **Shader code is generated from live renderer state.** Three reads
  `getRenderTarget()`, `getMRT()` and `isOutputTarget` while building, and
  `compileAsync` builds in a later task — after the frame loop has put the
  canvas back. Built then, a fragment shader has one output where the scene
  pass's MRT target has two, and every pipeline fails with "Color target has
  no corresponding fragment stage output". So the precompile generates the
  code synchronously inside the borrowed window (one build per genuinely new
  material variant) and leaves only the async GPU pipeline to `compileAsync`.
- **The scene pass's nesting depth is a host property.** The play build draws
  it at depth 1; the editor, which renders from inside a `render()` of its
  own, at depth 2. `EngineRenderer.render()` measures it every frame instead
  of assuming. The pass also finalises its MSAA sample count on its first
  frame, so a whole-scene precompile waits for that frame.
- **A pipeline that fails validation off-frame is a silent hole**, not a
  warning: three leaves it null and never draws the object in that context.
  Materials whose bindings depend on a render being in progress (the water's
  depth-based foam, soft particles) can trip this, so the precompile disposes
  any render object whose pipeline errored and lets the real frame rebuild it
  — `precompileStats.healed` counts them, and three's own error lines are
  followed by a one-line "[render] precompile: N pipeline(s) ... will build on
  first draw" so they read as what they are. The published voxel demo heals
  nothing; the editor heals 1-6 per load and still shows 2-3 first-draw builds
  in a rotation for exactly those materials (worst frame ~85 ms there, vs 25 ms
  in the published build).

### Measure it again

`apps/playground/tools/perf-probe.mjs` is the instrument used above:
`rotate` (two 360° laps in place) and `walk` (a 30 s straight-line flight
that teleport-steps the player's body along the camera's forward vector,
because keyboard input does not reach the controller from a headless page).
It attributes each frame's JS to three's stages and counts shader builds, so
"is the stall codegen, pipeline creation or upload?" is a number, not a
theory. The published build exposes `window.__hitreg` for it, and
`?precompile=0` on the URL is the A/B switch.

### Still open

- `draw` self time is now ~9-12 ms steady with 250 draw calls, almost all of
  it three's per-object per-pass bookkeeping (`geometries.update`,
  `pipelines.getForRender`, `bindings` — ~330 render objects per frame across
  main + 2 shadow cascades). That is the next lever if 70 fps is not enough.
- Shadow-pass shaders are not precompiled (they build inside the light's
  shadow render); they are ~2 ms each and were never a visible spike.
- §4's cellSize trade is unchanged and still a judgement call.
