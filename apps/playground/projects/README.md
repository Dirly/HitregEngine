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
  "multiplayer": "server",
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
`multiplayer` says how the game is played together: `"p2p"` (the default)
keeps the engine's peer rooms — a tab hosts, fine wherever a cheating host
costs nobody; `"server"` means dedicated/layered servers ONLY, so the
playground never forms a peer room for this project's scenes and a tab with
no server plays alone (a persistent MMO declares this; `?p2p=1` overrides
for a two-tab engine experiment).
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

## The scene menu

The toolbar's scene button (`project / scene`) opens the scene browser: a
search box over the projects, each collapsible with a caret. Search matches
scene labels, ids and notes, and project names; Enter opens the highlighted
scene. Which projects are expanded is remembered per browser. `project.json` shapes both menus:

```json
{
  "name": "my-game",
  "title": "My Game",
  "group": "Games",
  "menuOrder": 10,
  "scenes": [
    { "id": "world", "label": "World", "note": "The shipped scene." },
    { "id": "combat-lab", "label": "Combat lab" },
    { "id": "keep", "variants": ["keep-undercoat", "keep-blockout"] }
  ]
}
```

- `title` is the project's name in the picker; `group` puts projects under
  one heading, and `menuOrder` sorts projects and groups, lowest first.
- `scenes` is the scene menu in order, and the first entry is the main scene.
  A scene id is its file path under `assets/scenes/` without `.scene.json`.
- `variants` are pipeline stages or alternates of one scene. They list
  indented under it, labelled by what their id adds (`undercoat`, `blockout`).
- A scene file that no entry names still shows, under **other**, so a scene an
  agent just wrote is never hidden. A listed scene with no file is left out.

The toolbar's **+** opens **New scene**: pick the project, whether it is its own
entry or a stage under an existing scene, a name, and whether to start empty or
from a copy of the scene you're in. It writes the scene file into the project
and adds the entry to `project.json`, so the new scene lists where you put it.

`GET /__hitreg/scene-menu` returns the built menu; `POST` adds an entry
(`{ project, id, label?, note?, variantOf? }`). **The file is a scene's
identity.** The editor sets a loaded doc's `name` to its file id, so saves,
pins and switching all go back to that file whatever the doc called itself.

A project that is finished with goes to an archive folder outside the engine
checkout, not into a menu group nobody opens. Before moving one, check that no
other project's assets, tool README or skill still points into it.

Author scenes/materials/prefabs under `assets/` (namespace subfolders keep
ids collision-free the same way `heli-island/` does today), scripts under
`scripts/`. A script that needs its own gameplay events (a to-authority
request/response contract, etc.) should declare them on itself via the
static `events` field (see `@hitreg/scripting`'s `ScriptEventDecl`) rather
than editing the shared `main.ts` bootstrap — they self-register when the
script loads.

## New files

An existing file is written wherever it lives. A **brand-new** file goes into
the project named by the write's `project` field, which the editor fills
with the current scene's project, so a new scene lands beside its siblings.
Without `project`, a new file goes where exactly one project already has
that folder, else to the flat `assets/` tree.
