# Registered tools and plugin contributions

Engine tooling is discoverable data. A plugin is an installable container;
tools are one contribution type a plugin can register. Engine-owned registered
tools live under `tools/`, including `hitreg.armor-atlas` and
`hitreg.wfc-3d`.

## Contract

Every tool folder contains a `tool.json` manifest and a host entry module. The
manifest is validated by `ToolRegistry` in `@hitreg/core`; its exact field
surface is published under `tools` in `/__hitreg/spec`, so do not duplicate the
field reference in prose. The declaration supplies all three frontends:

- the editor groups the tool on its declared surfaces and generates a form
  from its input declarations;
- agents discover the same tool and its invocation JSON Schema in the engine
  spec;
- the host validates both callers with the same registry before importing the
  entry module.

The Vite development host discovers `tools/*/tool.json`. `GET
/__hitreg/tools` returns the installed public definitions. `POST
/__hitreg/tools/<id>/run` accepts `{ "inputs": { ... } }` and returns the
standard result: created assets, base64 previews, warnings, an optional report,
and an optional log. File inputs are `{ name, mediaType, data }`, where `data`
is base64 without a data-URL prefix.

## Trust and permissions

Tool entry modules are trusted engine/plugin code and run in the host, never in
the game runtime. The host gives them a narrow execution context rather than
the editor's internals. Ordinary asset writes pass through a path-sandboxed
writer and must match a permission declared in the manifest, such as
`assets.write:textures`; read-only existence checks use the same resolved asset
roots so generators can reject dangling references before writing. A manifest permission is an auditable capability
contract, not a sandbox against malicious Node code; untrusted third-party
plugins will require an isolated worker or service boundary. Tool run records
and diagnostics live under
`apps/playground/.hitreg/tool-runs/`; they are local derived artifacts and do
not ship with a game.

Inputs are schema-validated before an entry module loads, and results are
validated before they reach the editor or an agent. A custom UI may improve a
complex workflow later, but it must call the same registered runner and return
the same result contract.

## Distribution: tools are plugins, `tools/` is an install directory

A tool is its own git repo, and `tools/` is where you clone one. The engine
repo tracks only the first-party set (`atlas/`, `wfc-3d/`, `texture-intake/`)
and ignores everything else under `tools/`, so an installed third-party tool
is invisible to it — no submodule, no gitlink, the same arrangement as
`apps/playground/projects/`. Installing is `git clone <repo> tools/<folder>`;
uninstalling is deleting the folder. Discovery is by folder scan at dev-server
boot, so neither step touches engine code. See `tools/README.md`.

A game declares the tools it needs in its own repo, in
`projects/<name>/project.json`:

```json
{ "name": "my-game", "tools": [
  { "id": "hitreg.wfc-3d", "repo": "https://github.com/…/wfc-3d",
    "version": "^1.0", "reason": "generates the vault layouts" } ] }
```

The dev server resolves that against the registry at boot and warns about
anything missing, naming the id and its repo; `GET /__hitreg/projects`
returns the same resolution as data, and `projectManifest` in the spec is the
schema. This exists because a missing tool is otherwise indistinguishable
from a broken one: the generator simply does nothing.

Resolution never installs anything. Entry modules are trusted host code (see
above), so fetching one is a human decision, not a side effect of opening a
project.

## Adding a tool

Create a folder below `tools/` containing a complete `tool.json` and an ES
module exporting `run(context, inputs)`. Keep browser-safe metadata in the
manifest and Node/filesystem work in the entry module. Use the context's asset
writer for outputs; do not write project paths directly. Add the tool to the
committed spec composition in `packages/core/examples/write-spec.ts` when it is
part of the stable engine distribution, then run `pnpm spec`.

The Armor Atlas adapter deliberately calls the existing CLI importer, keeping
the CLI and registered tool on one implementation. Its final PNG becomes a
texture asset immediately; diagnostic slices, registration output, and reports
remain in the run record.

`hitreg.wfc-3d` under `tools/wfc-3d/` is the prefab-grid generator. Its input
format and authoring judgment live beside the tool in its README. Its output is
a reusable prefab with an empty anchor and nested prefab instances, so placing
the result remains an ordinary scene op and source prefabs continue to
propagate edits.
