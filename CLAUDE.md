# HitReg Engine

AI-native game engine on Three.js. **Read ARCHITECTURE.md before structural
engine work — its decisions are binding.** VISION.md holds the product thesis and
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

## Read for the task at hand

These invariants apply to every task. The detailed references below are loaded
when their subsystem is involved; they are not a mandatory reading bundle.
Read the relevant sections once, and revisit them when the task or code changes.

- **Dungeon rooms and tunnels are modeled in Blender** (Blender MCP) and imported
  through the `tools/mesh-dc` bridge; read `docs/blender-dc-authoring.md` first. The
  DC construction tools carve, add stairs and fit portals inside imported stamps.
- **Dungeon construction/refinement:** use the installed `hitreg-dungeon-authoring`
  skill, its quickstart, and the existing kit README. Start with the current
  project's plan and `authoring/NOTES.md` when present. Open tool sources only
  for a concrete question those references do not answer. Reference images
  (plan, vertical section, concept), the measured plan, applicable carving/path/
  portal tools, lint, and the geometry/traversal/visual gates remain part of the
  workflow. A compact handoff carries their paths and current stage, not copies
  of their contents. Templates execute; they need not all be read as context.
- **Dungeon texture requests and theme swaps:** read `docs/dungeon-materials.md`.
  Keep the eight stone roles and add wood, metal and smooth stone: eleven textures
  by default, with stable asset roles for changing themes while reusing geometry.
- **Any picture an agent needs drawn** — texture tiles, prop/gear art, plan,
  section or concept references: read `docs/image-generation.md`.
  `apps/playground/tools/image-request.mjs gen` drives the Codex CLI headlessly
  and verifies size/alpha before installing the PNG, so an agent gets its own
  art inside one turn. Never run `codex exec` by hand in a project folder.
- **Texturing a mob or a weapon:** read `docs/mob-atlas.md` for a creature
  (the unwrap-to-atlas process, what each recipe setting is for, and the prompt
  rules that make artwork land) and `docs/weapon-atlas.md` for a modular
  weapon ubermesh. The `weapon-unwrap` skill wraps both for Claude sessions.
- **Inventory icons:** read `docs/item-icons.md` (the `item-icons` skill wraps
  it). An item with a model is rendered from it; only model-less loot is generated.
- **Equipped items — parts, theme, glow, effects:** read `docs/item-looks.md`
  (the `item-looks` skill wraps it). Every holder of a model is one draw;
  never give an item its own material or mesh.
- **Character clips, weapon stances, grips:** read `docs/character-animation.md`
  (*Libraries on different rigs*, *Weapon stances*). A held item's socket is
  computed with `tools/fit-grip.mjs` and checked with `tools/pose-sheet.mjs`,
  never nudged by eye; a weapon's animations are `<Stance>_<clip>` clips.
- **Scene/prefab/component edits:** read the opening ops rules and Pitfalls in
  `docs/scene-authoring.md`, then the sections for what is being changed. Look up
  only the needed component schemas in the live or committed spec.
- **Engine architecture:** read `ARCHITECTURE.md` before structural engine changes.
  Read `VISION.md` for product direction and roadmap decisions.
- **Voxel worlds, streaming, or voxel extraction changes:** read the relevant
  parts of `docs/voxel-worlds.md`, including the render/physics/placement source,
  seam, and closed-volume invariants. Routine use of the existing dungeon kit
  does not require the entire open-world manual.
- **Registered tool changes:** read `docs/tools.md` and the owning tool manifest.
  Ordinary use starts with that tool's declared inputs and its authoring guide.
- **Other gameplay or live-editor work:** `docs/agent-workflow.md` retains the
  detailed commands and pitfalls, organized by named subsystem. Search for the
  relevant group (world generation, WFC, weapons, animation, VFX, progression,
  mobs, hosting, or live context) before loading it.

## File-first essentials

Content belongs in `apps/playground/projects/<name>/{assets/,scripts/}`. Construct
scene changes with `applyOps`, then write complete valid JSON. Saves live-sync;
read the current file before editing because the editor also autosaves.

Use the existing dev server's port. `GET /__hitreg/context` supplies the current
scene, focus, pins, and camera; with multiple clients, select its explicit id.
Read pins before asking what to change. `GET /__hitreg/spec` is the schema source
of truth; `spec.json` is the committed offline mirror. Filter to the capability
needed rather than loading the whole spec. Inbox/pin replies, camera control,
asset formats, and subsystem commands are in `docs/agent-workflow.md`.

For performance complaints, read the supplied profiler snapshot's note and
digest before theorizing; follow `docs/performance-lessons.md` for diagnosis.
Client errors also appear in the dev-server log. Run `pnpm test` and
`pnpm typecheck` before finishing changes.

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
