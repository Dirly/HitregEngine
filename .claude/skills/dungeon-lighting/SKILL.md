---
name: dungeon-lighting
description: Light an instanced dungeon so it reads — the shared readability floor (tools/dungeon-pipeline/lighting.json + lighting.mts hemisphere fill, fog to fill tone, vignette cap), the readability, matte and culling gates, the interior cullingProfile, light buckets for fixtures and the floor-tile luma rule. Use at the pipeline's lighting stage, when a dungeon is "lights on black", too flat, too dark, shiny, or pops in, or when choosing fixtures.
---

# dungeon-lighting

Sources: `tools/dungeon-pipeline/README.md` "Lighting stage" and the gate table; `docs/culling.md` "Interior scenes";
`apps/playground/tools/light-buckets.json` (its `about` is the rule). Building the dungeon: `dungeon-build`.

## Commands (from apps/playground unless noted)
```
npx tsx ../../tools/dungeon-pipeline/lighting.mts --project projects/<id> [--dry]   # one applyOps batch, inverse in reports/lighting.json
node ../../../../tools/dungeon-pipeline/quality.mjs readability|matte|culling      # from projects/<id>
node ../../../../tools/dungeon-pipeline/quality.mjs readability --dry --metrics     # calibrate without writing reports
```
`lighting.mts` applies the shared `lighting.json` merged with the project's `authoring/lighting.json` (only the keys
it changes, each with a why): ONE hemisphere fill intensity for every dungeon (`light.groundColor`: sky tone above,
darker below), toned warm/cold/neutral by the dominant bucket; fog and sky dome to the fill tone (never black);
exposure 1, vignette <= 0.25; the interior `cullingProfile`.

## Gates: failure -> fix
- `readability` near-black (a view > 90%, or median > 50%) = lights on black -> rerun the lighting stage; check a
  project `lighting.json` is not lowering the fill; lighten dark floor/ceiling tiles. Never add fixtures to fix dark.
- `readability` mean outside the band -> too dark or blown out: the fill, not the fixtures.
- `readability` p10 too high = flat fill, no pools -> fixtures need room to pool: 2-5 visible sources per room,
  spaced; do not raise the fill.
- Views older than the light (checked-in views predating it) -> re-shoot (`views` stage) before trusting a fail.
- `matte` -> roughness >= 0.9, metalness 0 except metal (>= 0.6) in `materials.mjs` / own materials / GLBs; an
  intended shine (ice, water) is an exception with a why.
- `culling` pop-in > 2 m inside a room -> `cullingProfile` missing or reveal too short; rerun the lighting stage.
- `recipe` light lines (visible sources outside 2-5; a point/spot light with no fixture prop beside it; a long
  passage unlit) -> place fixtures through the dressing plan; "unlit" in the plan for a deliberate dark run.
- `dress check` `LIGHTS:` line -> a fixture from another bucket, or lights that fit no single bucket.

## Judgment
- Mood is tone and fixtures, never darkness, and never so flat there are no pools.
- One place, one light bucket (tomb, manor, delve, camp, street); several kinds from it are wanted. Candles carry a barrow.
- Big rooms take floor tiles of at least ~50 luma: dark tiles read dark at any fill.
- Lights match the scale/culture: a giant room needs giant fixtures (a torch or fire bowl of its own), not human lanterns.
- A window the player cannot see through is not drawn as open.
- Calibrate on projects you must not touch with `--dry --metrics`: a normal gate run writes reports into the dungeon.
