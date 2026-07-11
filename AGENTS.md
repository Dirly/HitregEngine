# HitReg Engine — Agent Onboarding (any AI tool)

This file is the tool-neutral entry point (Codex, Cursor, Gemini, etc. —
Claude sessions get the same content via CLAUDE.md and `.claude/skills/`).

**Read first:**

1. `CLAUDE.md` — commands, non-negotiable invariants, repo layout, and the
   file-first AI workflow (despite the filename, everything in it is
   tool-agnostic except the skill pointers).
2. `docs/scene-authoring.md` — the complete scene/prefab/component format
   reference with pitfalls. This replaces the Claude-only scene-authoring
   skill for non-Claude agents.
3. `ARCHITECTURE.md` — binding technical decisions. `VISION.md` — the thesis.

**The short version of how to work here:**

- Scenes/prefabs/materials are JSON under `apps/playground/assets/`; edit the
  files directly — while `pnpm dev` runs, saves live-sync into the user's
  browser (schema-validated; invalid edits are rejected with a console warning).
- Always write complete, valid JSON files; never leave a file mid-edit.
- Runtime context (what the user sees, selection, camera, kit model contents):
  `curl -s http://localhost:5173/__hitreg/context`.
- Capability spec (every component/data-type/event/script + the ops protocol,
  as JSON Schema generated from the live schemas — plus the full endpoint list):
  `curl -s http://localhost:5173/__hitreg/spec`. This is ground truth for what
  you can build; the committed `spec.json` (repo root, `pnpm spec`) mirrors the
  engine surface for offline reading and drift-as-diff.
- Client-side errors from the running app appear in the dev server's log.
- Verify with `pnpm test` and `pnpm typecheck` before finishing.

**Extending the engine — keep it self-describing (so docs can't drift):**

- The AI-facing surface is generated from the Zod schemas that validate. A new
  component/event/data-type/net-state = register its schema; put non-obvious
  meaning or footguns in `.describe()` on the field (it rides into the spec),
  not in prose. Run `pnpm spec` so the committed `spec.json` diff shows it.
- A new dev-bridge endpoint = add it to `BRIDGE_ENDPOINTS` (apps/playground/
  vite.config.ts) so `/__hitreg/spec` self-lists it. A new behavior/script =
  register it (name + params surface automatically); document only its runtime
  `ctx` API in `docs/scene-authoring.md` — that's not a schema.
- Prose (this file, CLAUDE.md, `docs/`) is for judgment only: invariants, mental
  models, pitfalls. Never re-list fields the spec already defines — point at it.
  A new subsystem gets a `docs/` doc, linked from "Read first" if foundational.
