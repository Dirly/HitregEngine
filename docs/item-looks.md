# Item looks: equipped gear, glow and effects

How an item LOOKS when a character holds or wears it: which parts of a modular
model it shows, which theme it wears, how it glows, and what effects it trails.
One item file says all of it; the engine draws every holder of one model in
**one draw call**. The weapon side of how that model and its textures are made
(unwrap, key, generator, atlas) is **docs/weapon-atlas.md**; this doc starts
where that one ends, at a finished ubermesh and its theme atlases.

Worked example throughout: the longsword in the MMO project (voxel-demo).

## The rule everything here serves: draw calls

A draw call is one (geometry, material) pair. Three.js is draw-bound long
before it is triangle-bound, so with low-poly art each extra pair costs far
more than its triangles. So nothing about an item's look may be a material or
a mesh of its own:

| what varies per item | carried as | draws it costs |
| --- | --- | --- |
| which parts (blade, guard, pommel…) | a part MASK, per instance; hidden parts collapse in the vertex stage | 0 |
| which theme (iron, rust, steel…) | a TILE of one packed page baked into the model, per instance | 0 |
| glow, its moving overlay, its fade | per-instance values in the same batch | 0 |
| particle effects | standing `vfx` plays; particles are batched by LOOK across every emitter in the scene | one per particle look, shared by all items |
| an effect's light | a point light in the scene's light budget | 0 draws (a budget slot) |

Measured on six mannequins: six held swords cost 4 draws (1 main + 3 shadow
cascades) against 24 when each was its own mesh. Two magic swords with glow
and three emitters added one draw.

## The item file

```json
{
  "name": "Venomfang",
  "slots": ["primary", "secondary"],
  "appearance": {
    "model": "weapons/longsword-uber.glb",
    "parts": ["Handle", "Blade1", "CrossGuard1", "CrossFlavor1", "Pummel1"],
    "texture": "weapons/longsword-steel.png",
    "glow": {
      "color": "#46e62a", "intensity": 0.7, "parts": ["Blade1"],
      "noise": { "amount": 0.8, "scale": 96, "flow": -0.04, "threshold": 0.4, "churn": 0.2, "frameRate": 6 },
      "fade": { "from": 0.62, "to": 0.9 }
    },
    "effects": [
      { "vfx": "items/poison-drip", "material": "fx/poison",
        "anchor": { "part": "Blade1", "at": [0.5, 0.86, 0.5] }, "fit": [0.5, 0.22, 0.8] }
    ]
  }
}
```

Every field's range, default and meaning is in the item schema
(`packages/core/src/character/items.ts`, mirrored in `spec.json` under the
`item` data type). What follows is what the schema cannot say.

- **Parts and themes are NAMES.** Part names come from the model's own part
  table and theme ids are texture asset ids. The engine resolves both against
  tables baked into the model's glTF extras (`parts`, `tiles`), so an item never
  carries a bit mask or a UV rectangle, and neither goes stale when the model is
  re-cut.
- **One of each family, plus the grip.** Nothing enforces which blade fits
  which guard yet. The recipe's `combos` are the only vetted assemblies; a free
  mix can clip.

## Baking the model: `weapon-page`

Held gear is drawn from ONE model that carries ONE packed page of every theme.
Adding a theme means re-baking; it never means adding a material:

```
pnpm -F playground weapon-page --recipe longsword --project voxel-demo --themes iron-common iron-rusted steel
```

It seam-blends each theme on its own, packs a page, bakes it into the
ubermesh, writes the `parts` + `tiles` tables, installs the model and the
theme sheets into the project, and puts back the key files `unwrap-weapon`
rewrites as a side effect. The order is load-bearing: seam blending reads the
KEY's layout, so blending the packed page instead writes into the wrong texels.
Last, it re-renders the inventory icon of every item drawn from the model
(`item-icon.mjs --model`), so icons follow the bake.

**Every new item gets its icon when it is written**, not later: render it from
the model with `item-icon.mjs --item <id>` (**docs/item-icons.md**). Icons
borrowed from another item are how six shields ended up wearing the buckler's.

## Wiring a character (once)

- An entity under the body's model: `mesh: { source: { kind: "asset", assetId:
  "weapons/longsword-uber.glb", textureFilter: "pixel", partMask: 0 },
  renderMode: "instanced", moving: true }`, plus a `bone-socket` script on the
  hand bone.
- A child of it running the `equipment-look` builtin (`actor` = the body, `slot`
  = `primary`). It watches the character sheet and calls `ctx.setModelLook`.

**A hand that holds more than one weapon TYPE gets one socket per model.**
The longsword and the greataxe both sit on the right hand, each its own
entity with its own `equipment-look` on `primary`. A look shows only on the
entity whose mesh is the item's `appearance.model`, so equipping the axe
hides the sword. Each model's socket is fitted separately (a 1.5 m axe is not
held like a sword); pose-sheet applies the same model rule.

`moving: true` is what makes it one batch that follows every hand. `partMask:
0` hides the ubermesh until the sheet says what to show. `textureFilter:
"pixel"` matters, because `"nearest"` still mipmaps, and a blade is minified
across its width even at arm's length, so it blurs.

For the CC human rig: `CC_Base_R_Hand`, scale `0.019`, `rotationDeg [90, 0,
0]`, `offset [-0.03, 0.085, -0.093]`. The hand is a mitten (fingers +Y, thumb
+Z, palm −X), so the blade leaves the thumb side of the fist. The MMO's
`projects/voxel-demo/authoring/player-sword.mts` writes it.

## Glow: an overlay on named parts

`glow` adds emissive light to the parts it names. For a weapon, name the BLADE
only. The moving `noise` is the fire ember-bed's recipe: two scrolling noise
copies, sampled in cells, stepped in time, posterised into 4 bands. The knobs
and what they are for:

| knob | fire | poison | sparkle | notes |
| --- | --- | --- | --- | --- |
| `intensity` | 0.8 | 0.7 | 1.6 | above ~1 the texture washes out to a flat colour |
| `noise.amount` | 0.85 | 0.8 | 1 | 0 = a flat glow |
| `noise.scale` | 128 | 96 | 128 | cells across the WHOLE sheet: use the sheet's texel count. At 28 a blade got 1–2 cells |
| `noise.flow` | 0.45 | -0.04 | 0.08 | + runs toward the tip, − toward the guard |
| `noise.threshold` | 0.3 | 0.4 | 0.58 | high = sparse glints |
| `noise.churn` | 1 | 0.2 | 1 | how fast the pattern evolves in place; low = slow, oily |
| `noise.frameRate` | 12 | 6 | 12 | steps per second; low = choppier, slower-looking |
| `fade` | — | 0.62 → 0.9 | — | along the item's length, 0 = base, 1 = tip; `to` < `from` fades toward the tip |

**Measure motion instead of eyeballing a still.** Two screenshots 0.4 s apart,
then the share of pixels that changed on each blade: fire 59%, the first
poison 32%. That is how "slower" becomes a number.

## Effects: anchored on the item

Each effect is an ordinary `vfx` asset (the same format as torches and
spells) played for as long as the item is shown. The asset decides WHAT: which
particles, their sprite or texture, size and opacity curves, colour, rate,
lifetime, plus rings, shells, beams or a light. The item decides WHERE and HOW
BIG. `material` recolours one asset through a palette (`color` → primary,
`emissive` → glow).

**The item's frame.** With `orient: "item"` (the default), a module's offsets,
emitter volume and `direction` are in the MODEL's axes and turn with every
swing. On the longsword:

- **+Y runs up the blade**, toward the tip;
- **±Z points out of the two edges**;
- **±X points off the flats**.

Gravity stays world-down: drips fall and flames rise whatever the pose.

**Pinpointing the emitter.** `anchor.part` + `anchor.at` resolve against the
part's box, read from the geometry: `"tip"`, `"base"` (the ends of the longest
axis), `"center"`, or `[x, y, z]` fractions of the box. `offset` nudges it in
metres. **`fit`** sizes the emitter's volume to that box, so particles are born
along the whole blade and not at its centre. `[x, y, z]` scales each axis:
`[0.5, 0.22, 0.8]` at `at: [0.5, 0.86, 0.5]` is the top fifth of the blade.

The placements that work (assets in voxel-demo `vfx/items/`):

| look | anchor | fit | emitter |
| --- | --- | --- | --- |
| flame along the blade | blade centre | [0.4, 0.9, 0.7] | flame-lick flipbook, speed 0, `gravity` -0.7 (rises), quads ~0.3 m |
| embers running up the blade | guard centre | — | `direction` [0, 1, 0], speed 0.9–1.5, tiny squares |
| poison drip at the tip | blade [0.5, 0.86, 0.5] | [0.5, 0.22, 0.8] | drops: `gravity` 3, `drag` 1.4, size grows then falls; faint rising vapour |
| sparks out of both edges | blade centre | [0.3, 0.9, 1] | two modules, `direction` [0, 0, ±1], short life, `drag` 3; twinkles on the flat |

**Light.** Give an effect a `light` module and it is a real point light in the
scene budget: intensity 0.6–1.4, range 2.5–3.5. At 3 it floods the holder in
its colour.

**Particle size.** Square sprites 0.012–0.02 m read as PSX specks at arm's
length. The flame-lick art fills only the middle of its cell, so its quads
need ~0.3 m to show a flame at all; at 0.11 m it was invisible.

## Traps (each cost a round trip)

- **The part-mask bit test needs `floor`**: `fract(floor(mask / 2^i) * 0.5) >
  0.25`. Without it the lower bits leak in and a sword with one guard draws
  three.
- **Read the part index in the VERTEX stage.** Read in the fragment stage, the
  value tracked the texture and every grip's leather bands glowed. Decide per
  vertex and pass it as a varying.
- **Pass a fade UNCLAMPED, clamp per fragment.** A low-poly blade has vertices
  only at its base and near its point; a value clamped per vertex smears the
  fade over most of the blade.
- **WebGPU guarantees 8 vertex buffers.** Position, normal, uv, uv1, the matrices
  and the uber mask already take six. The glow is ONE interleaved buffer; three
  separate ones made nine, and the pipeline silently failed to build.
- **A restored save ignores `startingItems`.** Saves live in
  `apps/playground/.hitreg/player-data/<scene>/local/character.json`. Use
  `/give <itemId> [qty]` in the dev console, or add items through the core
  reducers (`addItem`/`equip`) and back the file up first.
- **An open tab saves on every inventory change** and overwrites an edited
  save. Edit it only while nobody is moving items, then reload.
- **Emitter volumes are HALF-extents.** `fit` already halves the part box.
- **A held blade is thin at distance.** Judge the overlay up close, and judge
  a light's spill with the light switched off once.

## Seeing it

- **The lab:** voxel-demo **Item FX lab**
  (`projects/voxel-demo/authoring/item-fx-lab.mts`). The swords standing large
  and held by idle mannequins, at night, driven exactly as in play.
- **One part at a time:** before trusting a new glow or mask change, line up
  swords that each glow ONE part (grip, blade, guard, pommel). Every glow bug
  above showed up as a wrong part lighting.
- **Draw counts:** the stats HUD, with and without the items. The difference
  should be one draw per model (+ shadow cascades) and one per particle look.
