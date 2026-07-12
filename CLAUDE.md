# HitReg Engine

AI-native game engine on Three.js. **Read ARCHITECTURE.md before structural
work — its decisions are binding.** VISION.md holds the product thesis and
phased roadmap.

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
- `apps/playground` — dev sandbox; the street scene doubles as a living example
  of scene authoring.

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
  scene doc).
- While `pnpm dev` runs, any edit to those files **applies to the running
  browser scene in place** (dev-server watcher → websocket), no reload. Invalid
  edits are rejected with a console warning and change nothing — schemas guard
  the pipeline.
- Editor autosaves scene changes back to the same files (500ms debounce), so
  read the file fresh before editing after the user has been clicking around.
- **Runtime context** (what the user sees): `curl -s http://localhost:5173/__hitreg/context`
  → `{ scene, playMode, selection: {id, entity}, camera: {position, target},
  inView: [{id, name, distance}...] }`. Use it to resolve "this/the one I'm
  looking at" references before editing.
- **Capability spec** (what you can build): `curl -s http://localhost:5173/__hitreg/spec`
  → `{ components, dataAssets, events, netState, scripts, ops, prefabs, endpoints }`,
  every field a JSON Schema generated from the live Zod definitions, so it can't
  drift from what validates. Prefer it over prose when you need exact fields for
  a component/script/event. Committed snapshot of the engine surface: `spec.json`
  at the repo root (regenerate with `pnpm spec`); a schema change shows up there
  as a diff.

## Building a full game vs. extending the engine

Small illustrative scenes (`street`, `sumo`, `cube-rpg`, etc.) live under
`apps/playground/assets/` + `apps/playground/src/scripts/` and stay
committed — they double as scene-authoring/scripting examples. A **complete
game** (its own economy/job loop, many scenes, a dedicated script suite) is
different: it does not belong in the engine repo at all, committed or not —
see `apps/playground/projects/README.md`. It lives entirely under
`apps/playground/projects/<name>/{assets/,scripts/}`, gitignored wholesale
(except that README). Default to building there, not under the flat
`assets/`/`src/scripts/` trees, whenever the ask is "build me a game," not
"add an example." A script needing its own gameplay events declares them on
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
