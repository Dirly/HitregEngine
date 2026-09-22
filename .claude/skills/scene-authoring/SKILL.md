---
name: scene-authoring
description: Author or modify HitReg Engine scene documents, prefabs, and data assets. Use when creating/editing scenes, adding entities or components, defining prefabs with props, or building ops batches — in this repo or any project using @hitreg/core.
---

# Scene Authoring

The reference lives in the tool-neutral doc **docs/scene-authoring.md**
(shared with non-Claude agents). Read its opening ops rules and **Pitfalls**,
then the sections relevant to the change: Components, Prefabs, Script context,
Data assets, Events, Placement, or Lighting interiors. Day/night and Weather
are needed only when working on those systems. Reuse that context during the
task; do not load the whole reference on each invocation. Key reminders:

- Construct every scene mutation through an ops batch (`applyOps`), then write
  the complete valid result. Never leave invalid JSON on disk.
- While `pnpm dev` runs, saved asset/scene files live-sync into the running
  browser; `GET /__hitreg/context` shows what the user currently sees.
- For exact component/event/data-type/script fields, `GET /__hitreg/spec`
  (generated from the live schemas — ground truth, never drifts) or read the
  committed `spec.json` at the repo root. Don't guess field names from memory.
- Working game examples live in `apps/playground/projects/<name>/assets/`;
  the flat `apps/playground/assets/` directory is for throwaway experiments.
