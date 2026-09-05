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
  — `init` writes a complete recipe (continents in a bounded sea, cut into
  large single-purpose ZONES with their own landforms) + terrain and water
  materials + scene, then `canyons`, `rivers` (real hydrology — depression
  fill, flow accumulation, a channel tree — used to pick the LAKES: a lake
  exists only where the tree runs through a depression, the other hollows
  are FILLED to valley floors; it writes NO rivers unless `--trace`),
  `towns`, `paths` (2.4 m footpaths between the towns, routed on the
  dense route with a hard grade cap so they follow the ground; SPLIT at any
  river ≥ 6 m wide with a `bridge` feature + placeholder deck between the
  pieces, fords over brooks; dirt, gravel across snow biomes — there are no
  wide roads any more, `roads` is an alias), `trails` (footpaths from that
  network up the peaks, a capped scramble for the last leg, stopping below
  a summit no scramble reaches), `pois` each compute from the CURRENT terrain and
  write a few lines back into the recipe's `features`, so every stage stays
  readable and hand-editable. **Rivers are AUTHORED — by you or an agent —
  not generated**: write `{ id, points, width, widths?, depth, bank, water:
  true, surface }` into `features.rivers` with NO `bedY` and the field
  solves a descending bed through the points (flush with the lakes it
  leaves and enters, flush with the river it joins, a gorge through any
  drop steeper than `maxGrade`), carving, banking and watering it live in
  the running scene — no regeneration. Route one with `descend --from-lake
  <id>` (the valley floor as `--points`) and `profile --points "x,z;…"`
  (ground, grade, bank heights; `--river <id>` reads the solved bed).
  **After changing rivers, re-run towns → paths → pois → trails** (a path a
  river now crosses is a wall across it until `paths` writes the bridge).
  `map` renders a PNG overview (`--plain` for water only, at real river
  widths — this is how you or an agent check the result without opening the
  browser); `stats` reports tris and ms per cell against the frame budget;
  `river-path` records a path-tool entity or typed points as
  `features.riverPaths` for the stage to solve (the older route); `audit`
  checks every river ends somewhere, beds descend, nothing is under water,
  every bridge has its paths (exit 1 on findings — run it before believing
  a screenshot). **Procedure for altering a live world by hand — rivers
  first, ~4 per world, more feature kinds to come: docs/world-editing/.**
  Judgment + the invariants that will break silently: docs/voxel-worlds.md.
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
- **WFC building kits** (modelled parts → generated structures): a kit is a
  folder of one-part-per-file GLBs (`floor*`, `wall*`, `door*`, `stair*`…,
  origin at the cell's bottom centre, a wall on one edge with its thickness
  inside the cell) plus `examples/*.glb` built FROM those parts on the cell
  grid, rotated about Y only. `pnpm -F playground wfc import <kitDir>
  --project <name> --cell 4,3,4 [--atlas town]` pulls every embedded texture
  into one PROJECT atlas page (content-deduped, islands never move, every
  module on the page is re-emitted when it changes; `wfc pack <propsDir>
  --atlas town --out models/props` puts plain props on the same page so a
  whole town is one texture), rewrites the parts onto it, composes a prefab per distinct cell (floor + walls on which edges,
  up to rotation — nobody models corners) and LEARNS the allowed face pairs
  from what touched what in the examples; `wfc solve --kit <id> --name
  generated/house-01 --size 6,1,6` writes an enclosed layout prefab, and
  `wfc inspect <file>` prints what the importer sees. Two invariants: an
  example only teaches pairings it contains (a missing one is a contradiction,
  not an error), and floor textures stay straight across rotated cells via a
  per-instance UV counter-rotation (`mesh.source.uvRotation`, written by the
  solver from the grid variant, honoured on instanced meshes, rotation
  centre from the part's second UV set) — so floor islands must be square and
  no face may rely on UV wrap. **tools/wfc-3d/README.md** before touching it;
  the modeller-facing rules are **docs/wfc-kit-authoring.md**.
- **Animated characters** (an FBX animation library onto a differently-rigged
  character): `pnpm -F playground retarget --mesh Char.fbx --anim Lib.fbx --out
  <name>.glb` bakes one self-contained GLB — skeleton maps are data in
  `tools/rig-map.mjs`, never a change to the retarget math. Two traps make the
  difference between working and subtly broken: the two rigs' REST poses
  usually differ (T-pose library, A-pose auto-rigged character — copying
  rotations, three's `SkeletonUtils.retarget` included, welds the arms to the
  sides), and a library shipping both in-place and `_RM` variants wants the
  **in-place** one, because the controller drives movement by physics velocity.
  A character is always TWO entities — body with the script, model on a child
  with `mesh` + `animator` — because the sim owns a rigidbody's rotation.
  Locomotion clips carry an authored ground speed (a walk cycle is often ~1 m/s
  while a run is ~6) — tell the controller via `clipSpeeds` or the feet skate by
  the ratio; `retarget` measures and prints them. Free-hanging cloth is the
  `clothSway` component: a vertex-shader lag whose panels are found by SHAPE,
  because auto-riggers bind skirts to the thigh bones and skin weights cannot
  tell a tabard from a trouser leg.
  **docs/character-animation.md** before touching character rigs, gaits or cloth.
- **Spells and VFX** (generated, not authored): a `spell` data asset
  (`assets/spells/<id>.json`) is an element + an archetype (kind / shape /
  radius / range / windup / duration…) + timed phases (telegraph, charge,
  cast, travel, impact, tick, linger, end), each a list of schema-registered
  VFX modules (sprite, particles, ring, shell, column, beam, bolt, light, mesh,
  trail, telegraph, shake, sound). `generateSpell({ seed, element, archetype,
  catalog })` in `@hitreg/core` composes one from a hand-authored preset
  library sized off the archetype's radius; `auditSpell` enforces budget /
  readability / lifetime; scripts play them with `ctx.vfx.playSpell(id, frame)`.
  Iterate in combat-demo's `fx-lab` scene (Randomize, schema-driven knobs,
  Save). Sprites are picked by ROLE from a project catalog, never by name —
  the engine ships no sheets. **docs/vfx-architecture.md** before touching any
  of it; two traps: sizes are multiples of the archetype radius (a preset that
  hard-codes metres is a bug), and lights are a fixed slot pool (toggling
  lights recompiles every lit shader).
- **Dedicated server** (`@hitreg/server`): `pnpm -F @hitreg/server serve --scene <name>`
  hosts any project scene headless — same sim, no renderer — and every tab
  opened with `?server=ws://host:port` becomes its client (no P2P election).
  Players are server-spawned entity docs, casts are validated against
  netState ownership, NPCs respawn, and `curl -s http://127.0.0.1:8787/admin/status`
  (`/admin/npcs`, `/admin/spawn`, `/admin/netstate`) is how an agent reads and
  edits the live population. **docs/dedicated-server.md** before touching it.
- **Tools are plugins, games are repos.** `tools/` is an install directory:
  each tool is its own git repo cloned in, and only the first-party three
  (`atlas/`, `wfc-3d/`, `texture-intake/`) are tracked by the engine. Each
  project under `apps/playground/projects/<name>/` is its own git repo too,
  and declares what it needs in `project.json` (`name` — must match the
  folder — plus `engine` and a `tools` list of registered tool ids with
  repo/version/reason). The dev server validates each manifest at boot and
  warns about declared-but-missing tools; `curl -s
  http://localhost:5173/__hitreg/projects` returns that resolution as data.
  **Check it before concluding a project's generator is broken** — "the tool
  was never installed" and "the tool did nothing" look identical otherwise.
  Conventions: `tools/README.md`, `apps/playground/projects/README.md`.
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
