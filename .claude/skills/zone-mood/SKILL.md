---
name: zone-mood
description: Set or change the air and light of a zone or a place (recipe regions[].mood — sky, haze, light, shade, fog, mist, saturation, contrast, temperature) and keep it inside the house band with `zone-mood.mjs lint` / `install`, so moods differ by colour tone and never by brightness. Use in a zone's look phase, when a zone or place reads too dark or washed out, when the `mood` row fails, or before proposing any mood edit.
---

# zone-mood

Sources: `docs/zone-creation.md` phase 2 "Zone mood" / "Place moods"; `regionMoodSchema` in
`packages/core/src/voxel/regions.ts` (fields); the `zone-mood` builtin plays it; the band is `MOOD_BAND` in
`apps/playground/tools/zone-mood.mjs` (data, with its calibration note).

## Commands (from apps/playground)
```
node tools/zone-mood.mjs lint [--world <w>]                       # every region mood vs the band
node tools/zone-mood.mjs install <proposal.json> [--apply|--revert]   # dry by default; prints the one line it changes
```
A proposal is `{ world, region, before: {...mood}, after: {...mood}, why }`; the installer refuses unless the recipe's
mood equals `before` (apply) or `after` (revert), so it is its own inverse. Never hand-edit the recipe mood.

## Gates: failure -> fix
- `lightScale` / `fogDensity` / `mist` / `contrast` outside the band -> "a brightness change, not a tone": move it back
  toward 1 and get the mood from hue (sky, haze, light/shade colour, temperature, saturation).
- `light` / `shade` darkens (relative luminance under the minimum) -> tint the hue, keep the colour light.
- Zone row `mood` MISSING -> zone mood not set, a place mood not applied, or the scene lacks the `zone-mood` entity
  (a fresh world's scene gets it only if `authoring/zonegen/scene-systems.json` copies it).

## Judgment
- The house look is dark and foreboding; a zone shifts its TONE (cold shore, sickly bog), never brightens it into a
  postcard nor darkens it until detail is lost.
- Neighbouring zones' moods differ visibly; borders blend over `blendSeconds`.
- A place whose brief mood breaks its zone's gets a NESTED region (`within` the zone, the place id) with its own mood;
  a nested region without a mood wears its zone's. Nested places are the likeliest to fail the band: lint them too.
- A place mood also sets its vegetation and role tiles (`terrain-edits`); a read that depends on dark or pale ground
  needs that tile in the palette.
