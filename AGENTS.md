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
- Client-side errors from the running app appear in the dev server's log.
- Verify with `pnpm test` and `pnpm typecheck` before finishing.
