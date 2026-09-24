---
name: item-icons
description: Make the small inventory icon for an item (~40 px, cropped, hard alpha, matched to the existing mmo-ui icons). Renders items that have a model (weapons, shields, any ubermesh gear) straight from their own mesh, parts and theme, with no image generator; generates one picture and shrinks it for items with no model (trash loot, ore, potions, quest junk). Use when an item is added, when its theme, parts or model change, or when an item shows a placeholder or someone else's icon.
---

# Item icons

The full reference is the tool-neutral doc **docs/item-icons.md**. Read it,
then follow this order.

## Order of operations

1. **Does the item have `appearance.model`?** Then it is rendered. Check that
   the model has a framing line in `projects/<p>/authoring/item-icons.json`
   (`from` / `up` / `roll` in model axes). Add one for a new model: swords
   diagonal with the tip at the top right (roll 45), shields facing the camera.
2. **Render with a contact sheet first**, `--dry`:
   `node tools/item-icon.mjs --project <p> --item <id…> --dry --sheet <scratch>/icons.png`
   (run from `apps/playground`). Look at the sheet next to a few existing
   `assets/textures/mmo-ui/` icons at the same zoom. Right parts? Right theme?
   Same size and angle as its neighbours?
3. **Write it for real** (drop `--dry`). The item's `icon` now points at
   `icons/<id>.png`; the inventory live-syncs.
4. **No model?** Generate ONE picture: 512x512, pure white ground, one object
   centred, three-quarter view, lit from the upper left, no text
   (`image-request.mjs gen`, prompt rules in the doc). Then
   `--item <id> --from-image <that.png>`. Look at the sheet the same way.

## What not to skip

- **Render before you generate.** Anything with a model is rendered; the
  generator is only for items with no model to render.
- **Re-run after a re-bake** (`weapon-page`), a new theme or changed parts.
  The icon is a picture of the item, so it goes stale with it.
- **Never ship a 40 px PNG you only looked at unzoomed.** Use `--sheet`.
- **Nothing near-white on generated art**, and no backdrop or shadow: the ground
  is removed by flooding in from the border through near-white.
