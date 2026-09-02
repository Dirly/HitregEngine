# HitReg Engine

AI-native game engine on Three.js. **Read ARCHITECTURE.md before structural
work — its decisions are binding.** VISION.md holds the product thesis and
phased roadmap. **Before any performance work on a chunk-streamed,
instancing-heavy, or proximity-loaded (subscene) world, read
`docs/performance-lessons.md`** — concrete bugs already found and fixed
building the first real open-world game on this engine (shared-material/
geometry caching across chunk loads, HLOD supercell wiring, subscene
hysteresis, instanced-LOD buffer compaction, camera-collision raycast cost,
a couple of sneaky main-thread-blocking browser APIs). Skipping it risks
re-discovering the same bugs from scratch.

## Commands

```
pnpm test                        # all package tests
pnpm -F @hitreg/core exec vitest # core tests, watch mode
pnpm -F @hitreg/core demo        # runnable doc-pipeline demo (ops -> prefabs -> undo)
pnpm -F playground dev           # browser playground at :5173
pnpm typecheck                   # all packages
```

## Non-negotiable invariants

- **Every scene mutation is an ops batch** (`applyOps`), never a direct edit of
  a scene doc or a file rewrite. Ops are atomic and return inverse ops (undo).
- **JSON is authoring truth, not runtime state.** Docs compile/expand into
  runtime structures (`expandScene` resolves prefabs; ECS tables come later).
- **Component data is always schema-validated.** New component types register a
  Zod schema in the `ComponentRegistry`; the schema drives validation, the
  future inspector UI, and the AI-facing JSON Schema spec. When adding any
  capability (component, event, endpoint, behavior), keep the engine
  self-describing — see **AGENTS.md → "Extending the engine"** (facts go in
  schemas/`.describe()` → `spec.json`; prose stays judgment-only).
- **Latency budgets are hard**: data-op batch < 50ms, script hot-reload < 1s,
  no compile step in any data path. Don't add synchronous stalls to the AI/editor loop.
- **3D only. Multiplayer-compatible by default**: gameplay state changes belong
  in `fixedUpdate`; nothing in `packages/core` may depend on the DOM (it runs
  headless in Node).

## Layout

- `packages/core` — scene docs, ops protocol, component schemas, prefabs
  (React-style: props/bindings/overrides), data assets (ScriptableObjects),
  fixed-timestep loop. Zero deps beyond Zod; runs headless.
- `packages/render` — Three.js WebGPU adapter (`buildScene`, `EngineRenderer`).
  WebGL fallback is automatic; `init()` reports the backend.
- `packages/comms` — drop-in text chat + VoIP on proximity/global/team/party
  channels, riding the room protocol's `module` message; membership is
  netState (`comms.team/*`, `comms.party/*`). **docs/comms.md** before touching
  chat/voice routing — one rule (`recipientsFor`) governs both media.
- `apps/playground` — dev sandbox (editor + runtime host). Ships with **no
  scene content**: it boots a code-built starter scene and writes the first
  scene file on save. Games and demos live in gitignored
  `apps/playground/projects/<name>/`.

Scene/prefab format reference: **docs/scene-authoring.md** (tool-neutral; the
`scene-authoring` skill wraps it for Claude sessions — non-Claude agents read
the doc directly, plus AGENTS.md).

## AI workflow (file-first)

The primary AI channel is **direct file editing** — no MCP required:

- Scenes: `apps/playground/assets/scenes/*.scene.json` (SceneDoc format; multiple
  scenes supported — the editor toolbar picks; only the ACTIVE scene live-syncs).
  Prefabs: `assets/prefabs/**/*.json`. Materials: `assets/materials/**/*.json`
  (support `map` texture id + `repeat`). Textures: `assets/textures/` (images).
  Audio: `assets/audio/` (wav/mp3/ogg). Models: `assets/models/*.glb|gltf`
  (GLB or self-contained glTF only — external .bin/texture sidecars won't
  resolve; animation clips drive the `animator` component; blending via
  scripts' ctx.setAnimation). Chunks: `assets/chunks/<world>/<cx>_<cz>.chunk.json`
  streamed by a scene's `chunkStreamer` component (runtime-only, never in the
  scene doc). Procedural worlds: `assets/worlds/<id>.json` — one small recipe
  document (noise bands, biome rules, rivers/towns/roads) that a scene streams
  via a `voxelWorld` component; the marching-cubes terrain, colliders and trees
  are all derived from it and never written to disk. **docs/voxel-worlds.md**
  before touching terrain generation.
- While `pnpm dev` runs, any edit to those files **applies to the running
  browser scene in place** (dev-server watcher → websocket), no reload. Invalid
  edits are rejected with a console warning and change nothing — schemas guard
  the pipeline.
- Editor autosaves scene changes back to the same files (500ms debounce), so
  read the file fresh before editing after the user has been clicking around.
- **Runtime context** (what the user sees): `curl -s http://localhost:5173/__hitreg/context`
  → `{ scene, playMode, selection: {id, entity}, camera: {position, target},
  inView: [{id, name, distance}...], focus: {...} }`. Use it to resolve
  "this/the one I'm looking at" references before editing.
  **`focus` is the referent channel** — read it before guessing from `camera`
  or `inView`. `focus.strongest` names which signal to trust
  (`manipulating` > `hover` > `selection` > `asset` > `none`); `focus.hover`
  carries the entity under the cursor *plus* the world point and surface
  normal, so "put a bench here" has a "here"; `focus.mode` says what the user
  is doing (`edit`, `graybox`, `terrain-sculpt`, `mesh-edit:<vertex|edge|face>`,
  `editing-prefab:<id>`, `playing`, …), which is often the difference between a
  sensible edit and a destructive one. In `mesh-edit:*`, `focus.meshEdit`
  lists the selected vertex/edge/face indices of the entity's editable
  `poly` mesh — "bevel these edges" means those indices; edit with the
  poly-mesh ops in `@hitreg/core` and write the mesh back in one op. A stale `selection` with `strongest: "none"` means nobody
  is pointing at anything — ask rather than assume.
  Context is keyed per browser tab: if more than one tab is connected to the
  dev server (e.g. an agent's own Playwright session alongside the user's), the
  response is instead `{ multipleClients: true, clients: [{id, scene, playMode,
  mode, attending, lastSeen}...] }` — pass `?id=<id>` to target one. Don't
  assume a single unlabeled response is "the" session if you might not be the
  only client.
- **The agent inbox** (`curl -s "http://localhost:5173/__hitreg/agent-inbox?scene=<name>&wait=60"`)
  is how a human hands you work *right now*: they press **"send to AI"** on a
  note and it lands here, carrying the pinned entity's full component JSON so
  you can act without a second fetch. Profiler snapshots ride the same channel
  (`profiles: [...]`, each with its file path, the human's note, and the
  plain-English verdict) — same act, same wake-up. `wait` long-polls — block on it and you
  wake within a second of the click instead of polling. Answer by POSTing the
  scene's pins back with your `reply` and `resolved: true`; the reply shows
  up in the editor on the note itself.
- **Pins** (`focus.pins`, and `curl -s http://localhost:5173/__hitreg/pins?scene=<name>`)
  are notes anchored to a world point — the durable half of the focus channel.
  Someone right-clicked a spot and wrote what's wrong with it; unlike selection,
  a pin is actionable with nobody at the keyboard. **Check open pins before
  asking what to work on.** Post back to the same endpoint to answer one
  (`author` yourself, don't pose as `"human"`), and set `resolved: true`
  instead of deleting so the exchange stays readable. They live in
  `.hitreg/pins/` beside the scene, never inside it — a pin is a conversation
  *about* the level, so it must never ship in one. A note with no `sentAt` is
  a private draft, not a request: read it for context, don't act on it.
- **Profiler snapshots** — `apps/playground/.hitreg/profiles/*.json`, newest
  last. The human presses **Shift+P** in the app, then **snapshot → AI**, and one
  lands here; "read the latest profile snapshot" means read that file. It's an
  ordinary file in the repo, so this works with no dev server running.
  Each holds `note` (what they were doing — **read it first**, it's the half
  the numbers can't supply), `digest` (the verdict in plain English: fast
  enough or not, and whether the time goes to JS, GPU, or **off-loop**),
  `report` (p50/p95/**p99 wall-clock**, hottest scopes by *self* time with
  scripts broken out per script name, counters, recent spikes with the spans
  that overlapped them — `chunk.load`, `chunk.build`, `hlod.supercell`,
  `scene.rebuild`, `long-task`), and `full` (the whole ring buffer).
  **Read a snapshot before theorizing about any reported stutter** — it
  usually names the cause outright, and `off-loop` time in particular (GC,
  shader compiles, async chunk parsing) is invisible to every other
  instrument here. Answer one by POSTing `{ file, resolved: true, reply }` to
  `/__hitreg/profile`, exactly like a pin. Live equivalent without a
  snapshot: `context.perf`, or `curl -s http://localhost:5173/__hitreg/profile`.
  Background: `docs/performance-lessons.md`.
- **World generation** (procedural open worlds): `pnpm -F playground worldgen`
  — `init` writes a complete recipe + terrain material + scene, then `rivers`,
  `towns`, `roads`, `pois` each compute from the CURRENT terrain and write a
  few lines back into the recipe's `features`, so every stage stays readable
  and hand-editable. `map` renders a PNG overview of the whole world (this is
  how you — or an agent — check the result without opening the browser);
  `stats` reports tris and ms per cell against the frame budget. Judgment +
  the invariants that will break silently: docs/voxel-worlds.md.
- **Placement toolbox** (settle props instead of eyeballing coordinates): give
  props a `placement` component (spec has the fields) and run
  `pnpm -F playground place snap <scene.json>` — every opted-in entity settles
  onto the ground/ceiling/wall it declares, sunk + seeded-jittered, written
  back to the file (live-syncs if dev is running). `place lint <scene.json>`
  reports floating props and z-fight risks (`--overlap <tol>` adds
  interpenetration, opt-in) with
  world points; exit 1 on findings. In the editor the same solve runs
  automatically on move/duplicate/drop (toolbar "placement assist" toggle).
  Judgment + conventions: docs/scene-authoring.md → "Placement".
- **Capability spec** (what you can build): `curl -s http://localhost:5173/__hitreg/spec`
  → `{ components, dataAssets, events, netState, scripts, tools, ops, prefabs, endpoints }`,
  every field a JSON Schema generated from the live Zod definitions, so it can't
  drift from what validates. Prefer it over prose when you need exact fields for
  a component/script/event. Committed snapshot of the engine surface: `spec.json`
  at the repo root (regenerate with `pnpm spec`); a schema change shows up there
  as a diff.

## Building a full game vs. extending the engine

The engine repo ships **no scene content** — no example scenes, materials,
prefabs, chunks, or gameplay scripts. Generic, reusable behaviors are
builtin scripts in `@hitreg/scripting` (`builtin.ts`); everything with a
game or a demo behind it — a showcase scene, a **complete game** (its own
economy/job loop, many scenes, a dedicated script suite) — does not belong in
the engine repo at all, committed or not — see
`apps/playground/projects/README.md`. It lives entirely under
`apps/playground/projects/<name>/{assets/,scripts/}`, gitignored wholesale
(except that README). Always build there. The flat
`apps/playground/assets/` / `src/scripts/` trees still work (same asset
bridge, same script glob) but are for throwaway local experiments only —
nothing scene-specific gets committed to them. A script needing its own gameplay events declares them on
itself (`static events` — see `ScriptEventDecl` in `@hitreg/scripting`)
instead of editing the shared `apps/playground/src/main.ts` bootstrap; that
file should stay generic across every scene/project it serves.

**Why this matters for you as an AI agent**: a full game's scripts/scenes
read like engine content if left in the flat trees, and a future session
extending a *different* game can mistake its patterns (a specific job
economy, a specific enemy-hit contract) for canonical engine usage. Keeping
games in their own gitignored folder keeps what you see when exploring this
repo scoped to what's actually general-purpose.

## Design Context

UI work (editor overlay, panels, future graph editors) follows PRODUCT.md
(register: product / platform: web / personality: precise, fast, quietly
confident — Linear/Vercel lineage) and DESIGN.md (dark-first token set).
Accessibility bar: WCAG AA + colorblind-safe (meaning never by color alone).
Use `/impeccable` commands for design passes; they read both files.
