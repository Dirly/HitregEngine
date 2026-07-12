# Playground assets

`scenes/`, `materials/`, `chunks/`, and `prefabs/` here are small,
hand-authored JSON — they're tracked in git and double as living examples of
the scene-authoring format (see `docs/scene-authoring.md`).

`models/`, `textures/`, and `audio/` are **not tracked** (see `.gitignore`).
Those are third-party CC0 art packs and would otherwise bloat this repo with
binary blobs. To get a working preview install with the demo scenes'
actual art:

```
git clone https://github.com/Dirly/HitregDemoScene.git /tmp/hitreg-demo-assets
cp -r /tmp/hitreg-demo-assets/assets/* apps/playground/assets/
```

Without that step, `pnpm -F playground dev` still runs — scenes referencing
missing model/texture/audio ids just render without them (console warning,
no crash).

A **complete game** (its own scripts, economy, dozens of scenes/prefabs) is
different from the small showcases above — it doesn't belong in this
tracked tree at all. See `../projects/README.md` (`apps/playground/projects/`,
gitignored) for that convention.
