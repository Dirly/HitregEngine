---
name: weapon-unwrap
description: UV-unwrap a modular weapon ubermesh or a MOB/creature body and build its texture atlas — write the unwrap recipe, generate the colour key and slot manifest, register generated artwork onto the mesh, and view the result in the engine. Use when a new weapon (sword, axe, mace, bow…) or a new mob (ogre, wolf, rat…) comes out of Blockbench and needs texturing, when an existing model's parts have changed and its key must be recut, or when an atlas lands wrong on either.
---

# Weapon unwrap

The full reference is the tool-neutral doc **docs/weapon-atlas.md** — read it
now, then follow it. This skill is the order of operations and what not to skip.

**Texturing a CREATURE instead — a mob, a body, anything with a head?** Read
**docs/mob-atlas.md** first and follow that. Same tools, same five steps, but
what a recipe means changes: no families, shells instead of alternatives,
smooth normals instead of flat, `split` for a shell that turns a corner,
`matchTo` to stop a hand reading as a glove, cut-outs only on worn hanging kit
(hems) and ornaments, and `flare` doing most of the work — without it a face
collapses onto a one-texel line and smears over the muzzle as a starburst. The
per-part flare values are tuned by eye against `--debug-slot`; the doc has the
ogre's. Then read **For a NEW mob** below before writing anything.

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
5. to ship a WEAPON, re-run step 1 with `--atlas tools/atlas/out/<set>/<theme>/atlas.png`
   so the mesh carries its own sheet. A MOB ships ONE mesh (`<Mob>-unwrapped.glb`)
   and every theme is a TEXTURE, never another GLB — bake a theme only to look
   at it, with `--out-mesh <scratch>/…`, and use the `atlas-seamblend.png` the
   bake writes.

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

## For a NEW mob — what the ghoul taught

The ghoul (`ghoul` recipe, `sets/ghoul/prompt.md`) took ten generator rounds;
each item below cost at least one. Details and measurements are in
docs/mob-atlas.md.

**The unwrap is yours.** Derek wants every part as ONE connected island with
its edges flared — no floating triangles. A Blockbench file's own UVs
(`uvSource: "file"`) are only usable if the modeller finished them; check for
faces collapsed into a corner or left on default whole-sheet UVs before trusting
it, and project instead when they are there.

- **Survey, then pick per part:** a shell → `plane` down the axis it faces; a
  corner (two faces at ~90°, e.g. an inner arm) → `split` the second face into
  its own slot; a dome or tilted slab (pads, hands) → an oblique `view`; a bent
  tube (ribs, tails, tentacles) or a band (belts) → `tube`, plus `taper: true`
  when it narrows to a point (legs, horns).
- **A head seen from every side** → `method: "sphere", v: "height"`, one strip
  round the skull, with `face: { half, scale }` giving the face ~2x the texels
  (the generator paints faces at its own width, about twice the real face).
  The crown is its OWN top-down island, centred above the strip
  (`{ col: [crown, head], align: "center" }`). Front-view heads mirror the face
  onto the back of the skull; profiles squeeze it; a crown merged into the strip
  wrecks the face.
- **A top strip over a mirrored piece** (hood crown) → `mirror: "z"`, painted
  once for both sides like the profile it sits on. Keep it to the modeller's
  crown mesh — do not split extra faces into it.
- **Worn hanging kit** (robes, tassets) → `transparency`, `cut: "bottom"`,
  `anchor: "top"`, `hem: {…}`; an ornament plate → the armour sheet's ornament
  settings (`cut: true`, `openEnclosed`, `anchor: "bottom"`).
- **Rebalance the layout** every time islands change; `--islands` and a few
  variants usually win back the density.

**Give the generator a key it cannot misread:**
- Hand it `key-labelled.png`. Tall narrow blocks letter on end; a slot `label`
  can be an instruction (`"rib-upper bone"`, `"bare legs-front"`); `labelMax`
  keeps a word off the face.
- **`marks`** — draw the eyes, nose and mouth into the labelled key from world
  points on the model's face. Percentages in the prompt were not enough.
- **Neighbours decide what a block becomes**: hands beside the spine came back as
  bone, ribs beside the belt as belt, a head block under its hood got the hooded
  face. Put pieces next to what they belong to; put the head ABOVE the hood,
  or better, at the other end of the column (the anansi's layout).

**Fix at import what no prompt fixes** (slot options in the recipe, applied by
import-atlas before registration): `flush` (a hood's painted black opening),
`even` + `streak` (bands on a bone — keep texture, narrow the value range;
**never a flat solid colour**, Derek rejected it), `borrow` + `solidFrom:
"<slot>:top"` (a crown takes the painted top band of the piece it caps — only
when the generator paints a face into the crown; see the anansi section),
`boneFrom` (every bone matches the bone painted elsewhere), `clearPaper` (an
ornament drawn on off-white paper). Something drawn OUTSIDE its block (a halo
under the ornament, a buckle by the belt) is moved in by hand; it is not worth a
re-roll.

**Check on the model, not the sheet:** render the head alone and the torso
alone after every import; the flat key-check cannot show a face drawn too wide or
a bone the wrong colour.

## What the anansi added (spider-bodied humanoid, `anansi` recipe)

Four generator rounds. Each item below cost one of them or came from Derek's
review.

**Derek's taste for every mob:**
- **Evil and menacing.** A handsome or friendly face is wrong: gaunt, fanged,
  glowing eyes. Write that into the SUBJECT from the first roll.
- **A hybrid is ONE creature, ONE palette.** The humanoid skin matches the
  animal half, and the join (the waist) is PAINTED as a transition: chitin
  creeping up the bottom fifth of both chest blocks, and the animal's front
  plain at the same value. The bake's seam blend cannot do this, because it
  only blends edges inside one part. Before assuming a join can be blended,
  count the shared vertices between the two meshes; the anansi's torso shares 3
  and just sinks into the body.
- **The crown comes from the generated art.** Try the generator's own crown
  first: ask for the scalp seen from directly above, forehead at the edge that
  touches the face, the same covering as the head strip's top band. Use `borrow`
  / `solidFrom: "head:top"` only when the generator paints a face into the
  crown, as on the ghoul. It copies the top band spatially, so a bare forehead
  between two sides of hair became a bald stripe over the skull.
- **A broad face.** Hair (or a hood shadow) hanging down the sides of the face
  covers the temples and cheeks and leaves a narrow strip on the model. Keep
  hair to the top quarter band and the back of the head (the strip's ends).
  Ask for bare skin about 3x the eye-mark gap wide.

**Unwrap tools that exist now:**
- **`split` works on `sphere`.** A flat cap under the jaw, fanned from the chin
  to the back of the skull, crushes into a sliver running across half the head
  strip. Split it off (`facing: "-y"`) into its own `head-under` island, centred
  under the strip.
- **`taper: true` on `tube`** for anything that narrows to a point (spider legs,
  horns, tails, tentacles). Without it every ring is stretched to the mean
  width, the thin tip is magnified, the generator paints a point into a
  rectangle, and the empty corners smear over the tip ("warped tips"). With it
  the island is the limb's own shape and the tip is one point. Legs dropped from
  12-18% unpainted to 4-6%.
- The patch line now breaks down by slot (`hood 20, belt 8, ...`). Patches on
  caps and kit are expected; patches on a limb's tip mean it wants `taper`.

**The generator:**
- **It can copy the key's lettering and face marks onto the sheet.** One sheet
  came back with every label and the white eye rings printed on it. Put a NO
  TEXT / NO GUIDE MARKS rule at the very START of the prompt and repeat it as a
  final check at the END; the rule in the body alone did not hold.
- **Scan the atlas for near-white texels after import** (alpha > 128 and
  min(r,g,b) > 200). ONE painted cobweb texel on the hood crown showed as white
  specks all along the hood rim. Fix it by averaging its neighbours in
  `atlas.png`, then rebake; re-importing brings it back.

**Looking at it yourself:** bake to scratch with `--out-mesh`, then render the
`-parts.obj` with `_softrender.mjs`'s `renderStrip`: the whole body, the head
alone, and the head inside the hood. `key-check.png` only looks from behind.
**Flip OBJ `vt` (use 1 − v)**: without the flip the torso and legs still looked
right, because the layout happens to put matching parts at mirrored positions,
while the head sampled the arm. A view direction of −X looks at the front.

**Layout:** after any island change, try 3-4 layout variants in a throwaway
loop (write each variant into the recipe, run the tool, read its `px/unit`
line, then restore) and keep the densest one with good neighbours. Anansi:
6.15 → 7.11 px/unit.

## What not to skip

- **Never hand-draw a key.** A Blockbench export has no usable UVs at all, so
  the unwrap and the key must come out of one program, from the mesh itself.
- **Check the three ways, cheapest first**: the tool must print *verified*; then
  `sets/<recipe>/key-check.png` must show every part in ONE flat slot colour; then
  `atlas-view` in the playground. `--debug-slot <name>` when an island looks
  wrong — it is what finds unwrap bugs.
- **Match the texel DENSITY of its class, and re-check after every layout
  change.** Declare `metresPerUnit` (the scale it is placed at in the game) and
  `texelsPerMetre` (held and worn gear: `HELD_GEAR_TEXELS_PER_M`, 109) in the
  recipe. The unwrap prints the density and warns with the `atlas.size` that
  would match. Pick the size from that, not from how big the object is. A shield
  at 1.5x the sword's density read finer-grained in the same hand; adding the
  tower moved it again. docs/weapon-atlas.md → *Texel density*.
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
