---
name: item-looks
description: Make an equipped item LOOK like something — pick its parts and theme on a modular model, give it a glow with a moving overlay (fire climbing a blade, poison creeping to the tip, glints), and anchor particle effects and a light on it (flames along the edge, drips off the point, sparks out of both edges). Use when adding or restyling a weapon, a piece of armour or any held/worn item, when a new theme or model has to become equippable, or when an item's glow or effects look wrong.
---

# Item looks

The full reference is the tool-neutral doc **docs/item-looks.md**. Read it now,
then follow it. This skill is the order of operations and what not to skip.
Making the model and its theme atlases is **docs/weapon-atlas.md** (the
`weapon-unwrap` skill); this starts at a finished ubermesh.

## The one rule

**Draw calls first.** Nothing about an item's look may be its own material or
mesh. Parts are a mask, a theme is a tile of one page, glow is per-instance
data: all of it stays in the model's single batch. Particles batch by look.
Report the draw count before and after on anything you add.

## Order of operations

1. **Bake the held model** whenever a theme is added:
   `pnpm -F playground weapon-page --recipe <recipe> --project <project> --themes <a> <b> …`.
   Never pack or blend by hand. Seam blending must run per theme, BEFORE
   packing. The bake re-renders the icon of every item already on the model.
2. **Write the item** (`assets/items/<id>.json`). Fill `appearance` with part
   NAMES (one per family, plus the grip) and a theme sheet id. Look up field
   meanings in the schema (`spec.json` → `item`), not here.
   **Then give it its icon, in the same step**: `node tools/item-icon.mjs
   --project <project> --item <id> --dry --sheet <scratch>/icon.png`, look,
   then run it without `--dry` (from `apps/playground`). The icon is rendered
   from the item's own model, parts and theme (`item-icons` skill). An item
   is not finished while its `icon` is a placeholder borrowed from another.
3. **Glow: blade only.** Start from the doc's knob table (fire / poison /
   sparkle columns), and change one knob at a time.
4. **Effects: a `vfx` asset for WHAT, the item for WHERE.** Author in the
   item's frame: +Y up the blade, ±Z out of the edges, ±X off the flats.
   Anchor with `part` + `at` and use `fit` so particles come from the whole
   part. Give each effect a small `light` (intensity 0.6–1.4).
5. **Look in the lab** (voxel-demo "Item FX lab", `authoring/item-fx-lab.mts`):
   standing AND held, at night.
6. **Give it to the player.** `startingItems` only seeds a fresh sheet. Use
   `/give <id>`, or add it through `addItem`/`equip` after backing up the save.

## What not to skip

- **After any change to the glow shader or the part mask**, line up swords that
  each glow ONE part before believing it. All three glow bugs so far (the
  missing `floor`, the fragment-stage part index, the per-vertex fade clamp)
  showed as the wrong part lighting.
- **Measure motion, don't eyeball a still.** Two frames 0.4 s apart, then the
  share of changed pixels per blade.
- **Check a light's spill with the light switched off once.** Lit steel looks
  like glow.
- **Keep the vertex-buffer budget.** A new per-instance value goes into the
  existing interleaved glow buffer, never a new attribute buffer. WebGPU
  guarantees 8, and the batch already uses seven.
- **Tune in the files.** The items, the `vfx/items/` assets and the
  `materials/fx/` palettes are all data and live-sync; no code change is
  needed to restyle an item.
