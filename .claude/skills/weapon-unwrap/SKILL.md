---
name: weapon-unwrap
description: UV-unwrap a modular weapon ubermesh or a MOB/creature body and build its texture atlas — write the unwrap recipe, generate the colour key and slot manifest, register generated artwork onto the mesh, and view the result in the engine. Use when a new weapon (sword, axe, mace, bow…) or a new mob (ogre, wolf, rat…) comes out of Blockbench and needs texturing, when an existing model's parts have changed and its key must be recut, or when an atlas lands wrong on either.
---

# Weapon unwrap

The full reference is the tool-neutral doc **docs/weapon-atlas.md** — read it
now, then follow it. This skill is the order of operations and what not to skip.

**Texturing a CREATURE instead — a mob, a body, anything with a head?** Read
**docs/mob-atlas.md** first and follow that. Same tools, same five steps, but
what a recipe means changes: no families and no cut-outs, shells instead of
alternatives, smooth normals instead of flat, `split` for a shell that turns a corner, `matchTo` to stop a hand reading
as a glove, and `flare` doing most of the work — without it a face collapses
onto a one-texel line and smears over the muzzle as a starburst. The per-part
flare values are tuned by eye against `--debug-slot`; the doc has the ogre's.

## Where it all lives

`tools/atlas/sets/<set>/` — key, manifest, check render, prompt (committed).
`tools/atlas/art/<set>/<theme>.png` — the generator sheet (gitignored).
`tools/atlas/out/<set>/<theme>/` — the atlas (gitignored).
Put a generated sheet at `art/<set>/<theme>.png` and the importer takes two
words: `--set <set> --theme <theme>`. `node tools/atlas/tidy.mjs` reports what
is disposable; `--slices --art` deletes it.

## The five steps

```
Blockbench  →  unwrap-weapon  →  generator  →  import-atlas  →  atlas-view
   .obj         key + mesh         art           atlas.png       look at it
```

1. `pnpm -F playground unwrap-weapon --recipe <name>`
2. generate art over `tools/atlas/sets/<name>/key.png` using `sets/<name>/prompt.md`
3. `node tools/atlas/import-atlas.mjs --key … --art … --manifest
   tools/atlas/sets/<name>/manifest.json --out tools/atlas/out/<set>/<theme> --slices`
4. `pnpm -F playground atlas-view --recipe <name> --project <project> --atlas
   tools/atlas/out/<set>/<theme>/atlas.png` (`--project` puts the carousel in that
   project's scene menu)
5. to ship it, re-run step 1 with `--atlas tools/atlas/out/<set>/<theme>/atlas.png` so
   the mesh carries its own sheet

## For a NEW weapon

The only thing you write is a **recipe** at the top of
`apps/playground/tools/unwrap-weapon.mjs`, plus a `sets/<name>/prompt.md` beside the
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
  `sets/<recipe>/key-check.png` must show every part in ONE flat slot colour; then
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

## Where a new weapon's sheet goes

**One atlas page per WEAPON TYPE — never one per dungeon, zone or drop table.**
A page is only reachable by instances that share the ubermesh, so a draw call is
the pair (ubermesh, page): splitting longswords over two pages buys nothing and
costs a second draw. A dungeon that invents six swords adds six TILES to the
longsword page.

One 4096 page holds **784** looks at the 128px export size (196 on a 2048);
4096 is the portable ceiling. When a page fills, add a page — +1 draw, only
while both are in frame — rather than shrinking the sheet, which costs detail on
every weapon forever. Two silent limits: **24 parts** per ubermesh (the mask is
float-exact only below 2^24), and **one sheet size per page** (the tile carries a
single `scale`; `atlas-pack` prints `! skipped` for each mismatch — read
those lines, they are how a theme vanishes). Full table and reasoning:
docs/weapon-atlas.md → *How many weapons fit, and how to bucket them*.

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
6. Every weapon in the viewer wearing every part at once → they are STACKED,
   not unmasked. An entity drawn `instanced` is parented to the scene, so
   `visibility` and a parent transform never reach it; give each one its own
   position.
