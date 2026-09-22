# HitReg Engine — Agent Onboarding (any AI tool)

This file is the tool-neutral entry point (Codex, Cursor, Gemini, etc. —
Claude sessions get the same content via CLAUDE.md and `.claude/skills/`).

**Read first:** `CLAUDE.md` — shared commands, invariants, and the task-specific
reading route (tool-neutral despite its filename). Follow that route rather
than loading every subsystem manual. Read references once per relevant task;
revisit them when the task or implementation changes.

For dungeon work, start with the installed `hitreg-dungeon-authoring` skill,
its quickstart, the existing kit README, and the current project's plan/notes.
Reference images, measured layouts, applicable stamp/carving tools, and the
validation stages remain required by that workflow. A smaller context means
loading the relevant material, not omitting design or verification stages.

`docs/scene-authoring.md` remains the scene/prefab reference; `ARCHITECTURE.md`
contains binding engine decisions; `VISION.md` explains product direction;
`docs/tools.md` covers registered tools; `docs/voxel-worlds.md` covers procedural
worlds and extraction invariants; `docs/image-generation.md` covers getting any
image drawn (`image-request.mjs gen` drives the Codex CLI headlessly and verifies
the result). Consult each when its subsystem is involved.
The detailed live-editor and gameplay command reference is
`docs/agent-workflow.md`.

**The short version of how to work here:**

- Scenes/prefabs/materials are JSON under a project's
  `apps/playground/projects/<name>/assets/` (or the flat
  `apps/playground/assets/` for throwaway experiments); edit the files directly — while `pnpm dev` runs, saves live-sync into the user's
  browser (schema-validated; invalid edits are rejected with a console warning).
- Always write complete, valid JSON files; never leave a file mid-edit.
- Runtime context (what the user sees, selection, camera, kit model contents):
  `curl -s http://localhost:5173/__hitreg/context`. Its `focus` block is the
  referent channel — `focus.strongest` ranks manipulating/hover/selection/asset
  so "this one" resolves to an entity id (and `focus.hover.point`, a world
  position) instead of a guess; `focus.mode` says what the user is doing.
  `focus.pins` lists notes a human anchored to a world point — standing
  requests that need nobody at the keyboard. Read them before asking what to
  do; answer via `/__hitreg/pins` (set `resolved: true`, don't delete).
- Capability spec (every component/data-type/event/script/tool + the ops protocol,
  as JSON Schema generated from the live schemas — plus the full endpoint list):
  `curl -s http://localhost:5173/__hitreg/spec`. This is ground truth for what
  you can build; the committed `spec.json` (repo root, `pnpm spec`) mirrors the
  engine surface for offline reading and drift-as-diff.
- Performance reports ("it hitches", "it's choppy near X"): read a profiler
  snapshot before theorizing. They are plain files in
  `apps/playground/.hitreg/profiles/*.json` (newest last) — the human presses
  **Shift+P** in the app, then **snapshot → AI**. Start with the snapshot's `note`
  (what they were doing) and `digest` (the verdict in plain English), then
  `report` for p50/p95/p99 wall-clock, the JS / GPU / off-loop split, the
  hottest scopes by self time, and the worst frames kept whole with the spans
  that overlapped them. `off-loop` — GC, shader compiles, async chunk parsing —
  is where the time usually goes and is invisible to every other instrument.
  Answer one by POSTing `{ file, resolved: true, reply }` to
  `/__hitreg/profile`, exactly like a pin. Live equivalent: `context.perf`.
  See `docs/performance-lessons.md`.
- Client-side errors from the running app appear in the dev server's log.
- Verify with `pnpm test` and `pnpm typecheck` before finishing.

**Building a game vs. extending the engine — keep the two apart:**

- The engine repo ships no scene content. Anything you build — a demo scene,
  a showcase, a *complete game* — goes under
  `apps/playground/projects/<name>/{assets/,scripts/}`: gitignored,
  self-contained, see `apps/playground/projects/README.md`. The flat
  `apps/playground/assets/` / `src/scripts/` trees are for throwaway local
  experiments only; nothing scene-specific gets committed there. Generic,
  reusable behaviors belong in `@hitreg/scripting`'s builtins instead.
  Don't ask whether to commit a game; it isn't meant to be.
- A project's own gameplay events are declared on the owning script itself
  (`static events`, see `ScriptEventDecl` in `@hitreg/scripting`), not added
  to the shared `apps/playground/src/main.ts` bootstrap.

**Extending the engine — keep it self-describing (so docs can't drift):**

- The AI-facing surface is generated from the Zod schemas that validate. A new
  component/event/data-type/net-state = register its schema; put non-obvious
  meaning or footguns in `.describe()` on the field (it rides into the spec),
  not in prose. Run `pnpm spec` so the committed `spec.json` diff shows it.
- A new dev-bridge endpoint = add it to `BRIDGE_ENDPOINTS` (apps/playground/
  vite.config.ts) so `/__hitreg/spec` self-lists it. A new behavior/script =
  register it (name + params surface automatically); document only its runtime
  `ctx` API in `docs/scene-authoring.md` — that's not a schema.
- A script that owns world state declares its own console commands
  (`static commands` + `onCommand` — see `ScriptCommandDecl`), so `/help` is
  generated rather than written twice. Never add a command table to a host.
- Prose (this file, CLAUDE.md, `docs/`) is for judgment only: invariants, mental
  models, pitfalls. Never re-list fields the spec already defines — point at it.
  A new subsystem gets a `docs/` doc, linked from "Read first" if foundational.
