---
name: scene-authoring
description: Author or modify HitReg Engine scene documents, prefabs, and data assets. Use when creating/editing scenes, adding entities or components, defining prefabs with props, or building ops batches — in this repo or any project using @hitreg/core.
---

# Scene Authoring

The full reference lives in the tool-neutral doc **docs/scene-authoring.md**
(shared with non-Claude agents) — read it now, then follow it. Key reminders:

- Every scene mutation is an ops batch (`applyOps`) or a complete, valid
  file Write — never a partial edit that leaves invalid JSON on disk.
- While `pnpm dev` runs, saved asset/scene files live-sync into the running
  browser; `GET /__hitreg/context` shows what the user currently sees.
- For exact component/event/data-type/script fields, `GET /__hitreg/spec`
  (generated from the live schemas — ground truth, never drifts) or read the
  committed `spec.json` at the repo root. Don't guess field names from memory.
- Working examples: `apps/playground/assets/scenes/*.scene.json`.
