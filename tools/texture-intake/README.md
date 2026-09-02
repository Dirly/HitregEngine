# Texture Intake (`hitreg.texture-intake`)

The on-ramp from stylized image-generator output to a game-ready, tileable
texture family plus a theme data-asset slot. Installed editor tool, same
pattern as `tools/atlas`: the dev host discovers `tool.json`, validates
inputs against `packages/core/src/tools.ts`, and calls
`run({ runDir, writeAsset }, inputs)` from `run.mjs`. Self-contained pure
node — local `png.mjs` codec (copied from `tools/atlas` and shared zlib), no
npm deps, deterministic.

## What one run produces

- `assets/textures/<name>.png` — the processed colour map.
- `assets/textures/<name>-normal.png` — light tangent-space normal map
  (OpenGL +Y), when `normalFromLuma` is on.
- `assets/themes/<theme>.json` — created or updated in place when `theme` is
  set and `slot` is not `none`: `slots[<slot>] = { map, uvScale:
  [metresPerTile, metresPerTile], normalMap }`, all other slots and any
  hand-tuned slot extras (color/roughness/metalness) preserved.
- A 3x3 tiled 384px preview in `toolResult.previews`, so remaining seams are
  visible in the dialog before anything ships.

## Seamless pass (`makeSeamless`, default on)

Offset-wrap + cross-blend. The image is sampled shifted by half its
width/height with wrap — that shifted copy is perfectly continuous across
the tile boundary by construction (its edges were adjacent interior pixels)
but carries the old seams as a cross through its centre. A feathered band
(~12% of the smaller dimension, smoothstep falloff on distance-to-edge)
blends the shifted copy in near the borders; the untouched original covers
the centre, hiding the shifted copy's cross. At the border the result is
100% shifted copy, so wrap continuity is exact; ghosting is confined to the
feather band. Image-gen output is never seamless — leave this on.

## Normal map (`normalFromLuma` + `normalStrength`)

Rec.709 luminance -> 3x3 Sobel gradients with wrap addressing (the normal
map tiles exactly like its colour map) -> `normalize(-gx, +gy, k)` encoded
OpenGL-style (+Y green, what three.js and `themeSlotSchema.normalMap`
expect). Strength 1 is deliberately light: a full black-to-white hard edge
maps to a 45-degree tilt; painterly gradients read as gentle relief.

## Theme wiring caveat

`uvScale` is **metres per texture tile** (world-UV), not a repeat count —
see the counting-stones rule in `packages/core/src/theme.ts`. The tool
warns which required theme slots are still unfilled after each run.

> **Not yet wired:** the `themes` asset kind is not consumed by the runtime
> asset loader yet. This tool writes valid theme docs (bare payload, id
> derived from the file path, per `registerThemeAssetType`); wiring the
> loader/`materialsForTheme` integration is a separate task.

## Self-test

```
node tools/texture-intake/self-test.mjs
```

No vitest — tools are self-contained. The test builds a deliberately
non-tileable 128px gradient PNG (RGB, Sub-filtered rows, to exercise the
decoder), runs the tool against a stub host, and asserts: wrap-seam deltas
are large without `makeSeamless` and near-zero with it, the normal map and
tiled preview decode as valid PNGs, and the theme doc gains the new slot
while preserving existing ones. Exit 0 = green.
