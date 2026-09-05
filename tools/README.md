# Engine tools

A **tool** is a plugin: a folder with a validated `tool.json` manifest and an
ES module exporting `run(context, inputs)`. The manifest drives all three
frontends at once — the editor's generated form, the agent-facing JSON Schema
in `/__hitreg/spec`, and the dev host's validation — so contributing a tool is
a data change, not an editor change. The contract is `docs/tools.md`; the
field reference is in the spec, deliberately not duplicated in prose.

This folder is an **install directory**. `.gitignore` ignores `tools/*` and
re-includes only the first-party tools below, so any other tool you clone in
here is its own git repo and stays invisible to the engine repo — the same
arrangement as `apps/playground/projects/`. No submodule, no gitlink.

## First-party (tracked here)

| Folder            | Tool id                | What it does |
| ----------------- | ---------------------- | ------------ |
| `atlas/`          | `hitreg.armor-atlas`   | Registers generated armor art against the character UV key, preserves cyan cutouts, packs a game-ready atlas with bleed. |
| `wfc-3d/`         | `hitreg.wfc-3d`        | 3D wave-function-collapse over a prefab tileset; emits a reusable prefab of nested instances. `kit.mjs` turns a modelled kit (parts + example structures) into atlased modules, cell prefabs and a learned tileset. |
| `texture-intake/` | —                      | Normalizes dropped image sets into the material map channels the renderer expects. |

These are tracked because they are the reference implementations of the
contract and because the engine's own test and spec depend on them: root
`pnpm test` runs `tools/wfc-3d/self-test.mjs`, and
`packages/core/examples/write-spec.ts` composes the atlas and wfc manifests
into the committed `spec.json`.

## Installing a third-party tool

```
git clone <tool-repo> tools/<folder>
```

That is the whole install. The dev server discovers `tools/*/tool.json` at
boot, validates each manifest, and registers it; the editor's "registered
tools" menu and the spec pick it up with no further wiring.

Removing one is `rm -rf tools/<folder>`. Nothing in the engine repo changes
either way.

## Declaring one as a dependency

A game does not silently need a tool. Projects declare theirs in
`projects/<name>/project.json`:

```json
{
  "name": "my-game",
  "tools": [
    {
      "id": "hitreg.wfc-3d",
      "repo": "https://github.com/…/wfc-3d",
      "version": "^1.0",
      "reason": "generates the vault layouts"
    }
  ]
}
```

The dev server resolves that against what is installed and warns at boot,
naming the id and where to get it; `GET /__hitreg/projects` returns the same
resolution as data. Schema: `projectManifest` in the spec.

Nothing is fetched automatically, and that is deliberate — tool entry modules
are trusted code that runs in the host, not in the game runtime (see
`docs/tools.md` → "Trust and permissions"). Installing one is a decision a
person makes.

## Writing a tool

Keep browser-safe metadata in `tool.json` and Node/filesystem work in the
entry module. Write outputs through the context's asset writer — it enforces
the permissions your manifest declares and the same path sandbox as
`/__hitreg/write-asset` — never by writing project paths directly. Ship a
`self-test.mjs` so the tool can be checked without the editor.

Run records and diagnostics land in `apps/playground/.hitreg/tool-runs/`;
they are local derived artifacts and never ship with a game.
