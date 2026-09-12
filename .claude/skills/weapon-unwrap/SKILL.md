---
name: weapon-unwrap
description: UV-unwrap a modular weapon ubermesh and build its texture atlas — write the unwrap recipe, generate the colour key and slot manifest, register generated artwork onto the mesh, and view the finished weapons in the engine. Use when a new weapon (sword, axe, mace, bow…) comes out of Blockbench and needs texturing, when an existing weapon's parts have changed and its key must be recut, or when an atlas lands wrong on a weapon.
---

# Weapon unwrap

The full reference is the tool-neutral doc **docs/weapon-atlas.md** — read it
now, then follow it. This skill is the order of operations and what not to skip.

## The five steps

```
Blockbench  →  unwrap-weapon  →  generator  →  import-atlas  →  atlas-view
   .obj         key + mesh         art           atlas.png       look at it
```

1. `pnpm -F playground unwrap-weapon --recipe <name>`
2. generate art over `tools/atlas/key-<name>.png` using `prompt-<name>.md`
3. `node tools/atlas/import-atlas.mjs --key … --art … --manifest
   tools/atlas/manifest-<name>.json --out tools/atlas/out-<set> --slices`
4. `pnpm -F playground atlas-view --recipe <name> --atlas
   tools/atlas/out-<set>/atlas.png`
5. to ship it, re-run step 1 with `--atlas tools/atlas/out-<set>/atlas.png` so
   the mesh carries its own sheet

## For a NEW weapon

The only thing you write is a **recipe** at the top of
`apps/playground/tools/unwrap-weapon.mjs`, plus a `prompt-<name>.md` beside the
key. Copy the `longsword` entry and change it. In this order:

1. **Measure the mesh first**, before writing anything:
   `pnpm -F playground unwrap-weapon --survey --in <file.obj>`. It prints, per
   part, how much of its area faces each axis and how much a flat-on view would
   keep. That one number picks the unwrap method — >95% kept is a plane, ~40% is
   a band, a split is plane + rim. `docs/weapon-atlas.md` → *Choosing an
   unwrap method* has the table. Guessing costs a whole round trip.
2. **One slot per part.** Never share an island between two parts. The sheet
   exists to tell four crossguards apart.
3. Lay the islands out, run it, and **look at the key** before going near a
   generator.
4. Write the prompt's region key from the layout you ended up with. The two
   change together.

## What not to skip

- **Never hand-draw a key.** A Blockbench export has no usable UVs at all, so
  the unwrap and the key must come out of one program, from the mesh itself.
- **Check the three ways, cheapest first**: the tool must print *verified*; then
  `key-<recipe>-check.png` must show every part in ONE flat slot colour; then
  `atlas-view` in the playground. `--debug-slot <name>` when an island looks
  wrong — it is what finds unwrap bugs.
- **Sizes in the recipe's `atlas` block are in TEXELS.** Read `bleed` and the
  layout gutter against the size you actually ship (a 60px gutter is 12 texels
  at 256 and 6 at 128), or islands trade colours in the lower mips with no error
  anywhere.
- **Re-read the traps section** before debugging anything that looks like a
  scale, position, or upside-down problem. Blockbench OBJ is 1/100 of Blockbench
  FBX; the engine flips textures and glTF does not; a working Blockbench file
  carries leftovers from previous runs.
- **Give the modeller the MERGED obj** (`<name>-unwrapped.obj`). The per-part
  one beside it is for looking at only.

## When the atlas lands wrong

Work down this list — the cause is nearly always one of them:

1. Artwork drawn at the wrong size or offset → `fit: "contain"` on the slot, and
   tell the prompt to fill the block.
2. A bright edge missing, the piece stretched → near-white was eaten as ground;
   raise `bgLum` and forbid white in the prompt.
3. Paint upside down → the flipY mismatch. Bake into the GLB, or pre-flip.
4. Ornaments solid, or invisible → the cut-out material got flattened by a
   material override, or the slot lost `transparency`/`cut`.
5. An island that is a bowtie, or has wedges missing → an unwrap fault, not an
   art fault. `--debug-slot` it.
