# Playground projects

A **project** is a complete, self-contained game built on this engine — its
own scripts, scenes, prefabs, materials, chunks, terrain. The engine repo
ships no scene content of its own (`../assets/` holds only a README), and
a game is orthogonal to the engine itself: keeping it in the engine repo
would bloat AI context and risk a future agent mistaking its game-specific
patterns (a job economy, a specific enemy-hit contract, whatever) for
canonical engine usage. So `apps/playground/projects/` is gitignored
wholesale (except this file), and **every project is its own git repo** —
`git init` inside the project folder, with its own history, remote and
release cadence. This is where **everything** you build goes, demo scenes
included.

Because the engine repo already ignores `projects/*`, a project's nested
`.git` is invisible to it: no submodule, no gitlink, no `git status` noise
in either direction. Cloning a project into `projects/<name>/` of any engine
working copy is the whole install step. Keep the project's branch on `main`
to match the engine's.

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
cd projects/my-game && git init -b main
```

Give it a `.gitignore` for the derived files — `node_modules/`, `dist/`,
`.hitreg/` (pins and profiler snapshots are a conversation *about* the
level, never part of one), and whatever your generators and worldgen map
renders write.

## Declaring what the project needs

A project is cloned into someone else's engine working copy, which may not
have the tools it was built with. `project.json` at the project root says so
out loud:

```json
{
  "version": 1,
  "name": "my-game",
  "description": "One line about the game.",
  "engine": "^0.1",
  "tools": [
    {
      "id": "hitreg.wfc-3d",
      "repo": "https://github.com/…/wfc-3d",
      "version": "^1.0",
      "reason": "generates the vault layouts",
      "optional": false
    }
  ]
}
```

`name` must match the folder — asset ids namespace by folder name, so a
mismatch silently breaks id resolution and the dev server warns about it.
`tools` names registered tools (see `tools/README.md`); each is its own repo
cloned into the engine's `tools/` folder. Mark a tool `optional` when the
project still runs without it and it only regenerates content.

The dev server validates every `project.json` at boot, resolves the tool list
against what is actually installed, and warns — by id, with the repo to get
it from — rather than letting a missing tool surface later as a generator
that mysteriously does nothing. `GET /__hitreg/projects` returns the same
resolution as data. The schema is `projectManifest` in `/__hitreg/spec`.

Nothing is installed automatically: tool entry modules are trusted code that
runs in the host, so fetching one stays a decision a person makes.

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
