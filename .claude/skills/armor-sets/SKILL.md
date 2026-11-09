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

## Kit or instance: decide first

- **Dungeon loot is an `instance` set** (the default for any dungeon): ONE theme, 1-2 MIXED body sheets (each region
  its own weight: plate chest, leather legs, cloth hands…), ONE helm and ONE shoulder sheet painted part by part in
  several weights (`helmPaint` / `shoulderPaint`), and NAMED pieces from a loot plan. Never four full kits for one
  dungeon (Derek 2026-10-29; the four shackle-* kits were retired for this).
- **A `kit`** (one weight, one item per slot per tier) is only for a town, faction or vendor outfit.
- **Loot plan first** for an instance: `armor loot-plan <dungeon> --set <id> --input <sources.json>` (or
  `--bestiary <file> --area <poi>`) writes the skeleton from the dungeon's sources; name every piece after its
  source (EQ style: a bloodstained tunic off the crypt ghouls), give each its sheet and parts, then re-run it to lint:
  all four weights, every slot in 2+ weights, no two pieces with the same look, rarity within the level band,
  ornaments rare+, every source a real mob and area. A SET appears only when a `lootRules` rule fires (large/hard
  dungeon, or a zone-spread set) and the plan names it.
- **Every kit ships 2-4 helm pieces and 2-4 shoulder pieces** (`helms[]` / `shoulders[]`), each a full part pick
  with its own name and tiers, chosen for the set's character (cloth: hoods, cowls, bandanas; leather: caps, hoods
  over coifs; mail: coifs, nasal helms; plate: closed and great helms; rare: crowns and ornaments). The sheets paint
  every part, so more pieces cost no art. `armor picks` shows every set's pieces and fails identical picks across
  sets; spread bases.

## Order

1. `node --import tsx tools/armor.mts brief new <id> --project foundation` (from `apps/playground`), fill
   every TODO: the SUBJECT, materials, palette, back ornament, tiers, the helm and shoulder pieces and looks
   (an instance: `kind: "instance"`, `bodies`, `helmPaint`, `shoulderPaint`, `loot`; then its loot plan).
2. `armor run <id> --project foundation`: brief lint, gen (Codex), import + gates, bake, items, review.
   It stops at the first failing gate with the stage kept; fix the cause (usually the brief's words), re-run.
   Several sets: `armor queue <ids…>`. Where it stands: `armor status`.
3. **Look at** `authoring/armor-sets/review/<id>.png` (a row per helm and per shoulder piece, both sexes, plus a
   3/4 close-up; an instance adds a row per body sheet) and the creator before calling the set done.
4. A set going away: `armor retire <id> …` (tiles off the pages, re-baked square; items, icons, art; prints the ids).

### Manual fallback (what each stage does)

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
- **Read "Not built yet" in the doc** before promising anything it lists.
