# Playground assets

This tree is **empty on purpose**. The engine repo ships no scene content —
no example scenes, materials, prefabs, chunks, terrain, or art. Generic,
reusable behaviors are builtin scripts in `@hitreg/scripting`; everything
with a game or a demo behind it lives in a **project** under
`../projects/<name>/{assets/,scripts/}` (gitignored, self-contained — see
`../projects/README.md`).

`pnpm -F playground dev` still runs with nothing here: the app boots a
code-built starter scene (ground + sun + ambient) and writes
`scenes/<name>.scene.json` into this tree on first save.

The dev server's asset bridge reads the same kind-folders from either
location, so files dropped here resolve exactly like a project's:

```
scenes/*.scene.json          materials/<ns>/*.json      prefabs/<ns>/*.json
chunks/<world>/<cx>_<cz>.chunk.json    terrain/<ns>/*.json
models/*.glb|gltf   textures/   audio/       (binary — always gitignored)
```

Treat anything you put directly here as a throwaway local experiment; if it
gets a name, move it into a project. Format reference:
`docs/scene-authoring.md`.
