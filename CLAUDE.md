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
  future inspector UI, and the AI-facing JSON Schema spec.
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

Use the `scene-authoring` skill when creating or editing scene/prefab documents.

## AI workflow (file-first)

The primary AI channel is **direct file editing** — no MCP required:

- Scenes: `apps/playground/assets/scenes/*.scene.json` (SceneDoc format).
  Prefabs: `assets/prefabs/*.json`. Materials: `assets/materials/*.json`.
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

## Design Context

UI work (editor overlay, panels, future graph editors) follows PRODUCT.md
(register: product / platform: web / personality: precise, fast, quietly
confident — Linear/Vercel lineage) and DESIGN.md (dark-first token set).
Accessibility bar: WCAG AA + colorblind-safe (meaning never by color alone).
Use `/impeccable` commands for design passes; they read both files.
