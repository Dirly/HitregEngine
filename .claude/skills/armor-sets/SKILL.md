---
name: armor-sets
description: Make a new player ARMOR SET (matching body, helm and shoulder art for both sexes) and break it into wearable items — helm, shoulders, chest, gloves, legs, boots — each naming its parts on the shared human models, with ornaments only on rare+ gear and rendered icons. Use when adding an outfit/armor theme, turning an outfit into items or loot, restyling a set, or when a set's pieces don't match each other.
---

# Armor sets

The full reference is the tool-neutral doc **docs/armor-sets.md**. Read it now,
then follow it. This skill is the order of operations and what not to skip.
Each model's unwrap/key/import steps are **docs/mob-atlas.md** (the
`weapon-unwrap` skill); item looks are **docs/item-looks.md**; icons are
**docs/item-icons.md**.

## Order

1. **Body sheet** over `tools/atlas/sets/human-body/key.png` with
   `tools/atlas/sets/human-body/prompt.md` (write the SUBJECT once — reuse it
   word for word for every later step). Import with `sets/human-body/manifest.json`.
2. **Female chest** with `sets/human-body/prompt-female.md` (man's art as 2nd
   ref, bust marks on `key-female.png`), chest-front island composited onto
   the man's atlas → `<theme>-f`.
3. **Helm and shoulders** with their `key-labelled.png` FIRST and the finished
   body art SECOND (`sets/human-helm/prompt.md`, `sets/human-shoulder/prompt.md`).
4. **Import, measure, bake**: zero opaque texels on ornament / plane-square
   free edges; `reskin --theme` for the body (every set on the page, male and
   `-f`), `weapon-page` for helm and shoulders (every set). Pages are SQUARE
   (the packers enforce it; never pack one any other way — docs/armor-sets.md).
5. **Look** in `/?creator` on both sexes, front and back.
6. **Items**, one per slot, per the table in the doc: male part names + the
   set's sheet; optional parts by the item's design; `Ornate*` and `ChestHalo`
   only at `rare` or better; tag the set.
7. **Icons**: `node tools/item-icon.mjs --project <p> --model <model>` for each
   model the items use.

## What not to skip

- **Never a new material or model for a set.** A set is tiles on the three
  existing pages; adding one re-bakes with every theme.
- **Density**: every sheet at 109 texels/m, nearest; the unwrap prints it.
- **Consistency comes from the words.** Same SUBJECT text for body, helm and
  shoulders; the "match the body" paragraph; the female prompt's carry-over
  rule. When a piece comes back off-style, fix the prompt text for next time —
  Derek is dogfooding the art pipeline, not collecting perfect sheets.
- **Rules live in the models** (`rules`, core `partProblems`): check an item's
  parts against them before writing it.
- **Read "Not built yet" in the doc** before promising mixed sets in game: the
  body shows one tile per character until per-part tiles exist.
