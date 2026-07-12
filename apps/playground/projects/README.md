# Playground projects

A **project** is a complete, self-contained game built on this engine — its
own scripts, scenes, prefabs, materials, chunks, terrain. Unlike the small
demo scenes in `../assets/` (which double as scene-authoring showcases and
stay committed), a full game is orthogonal to the engine itself: keeping it
in the engine repo would bloat AI context and risk a future agent mistaking
its game-specific patterns (a job economy, a specific enemy-hit contract,
whatever) for canonical engine usage. So `apps/playground/projects/` is
gitignored wholesale (except this file) — every project here is local-only,
meant to be saved/shared as its own separate git repo.

## Layout

```
projects/<name>/
  assets/
    scenes/*.scene.json
    materials/<namespace>/*.json
    prefabs/<namespace>/*.json
    chunks/<world>/<cx>_<cz>.chunk.json
    terrain/<namespace>/*.json
  scripts/
    *.ts
```

`assets/` mirrors the exact same kind-folders as `apps/playground/assets/` —
the dev server's asset bridge (`vite.config.ts`) merges a project's
`assets/<kind>/` into the same index buckets it builds from the flat
`assets/` tree, so material/prefab/model ids resolve identically either way
(`"heli-island/beacon-glow"` works the same whether that file lives at
`assets/materials/heli-island/beacon-glow.json` or
`projects/heli-island/assets/materials/heli-island/beacon-glow.json`). Live
JSON hot-sync (the websocket bridge that pushes file edits into the running
app with no reload) covers a project's `assets/` the same way it covers the
flat tree.

`scripts/` is deliberately **not** nested inside `assets/` — it's a sibling,
so it falls outside Vite's `"**/assets/**"` watch-ignore pattern and gets
completely normal Vite HMR, exactly like `src/scripts/`. `apps/playground/
src/main.ts` globs both `./scripts/*.ts` and `../projects/*/scripts/*.ts`
at startup and registers every default-exported `Script` class the same way.
No custom hot-reload bridge was needed for this — putting scripts outside
`assets/` sidesteps the problem entirely.

## Starting a new project

```
mkdir -p projects/my-game/assets/{scenes,materials,prefabs,chunks,terrain} projects/my-game/scripts
```

Author scenes/materials/prefabs under `assets/` (namespace subfolders keep
ids collision-free the same way `heli-island/` does today), scripts under
`scripts/`. A script that needs its own gameplay events (a to-authority
request/response contract, etc.) should declare them on itself via the
static `events` field (see `@hitreg/scripting`'s `ScriptEventDecl`) rather
than editing the shared `main.ts` bootstrap — they self-register when the
script loads.

## Known limitation

The write-asset endpoint only knows to target an existing project's
`assets/` tree for files that already exist there. A **brand-new** file
(one that doesn't match any existing physical path yet) defaults to the
flat `assets/` tree even if its namespace matches a project name. If that
happens, just move the file into the project folder by hand.
