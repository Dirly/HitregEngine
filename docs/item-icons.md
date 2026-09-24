# Item icons

The small picture an item shows in an inventory cell (`item.icon`). One
command makes it, from the item itself where it can:

```
cd apps/playground
node tools/item-icon.mjs --project <p> --all                  # every item with an appearance
node tools/item-icon.mjs --project <p> --item steel-heater    # one or a few
node tools/item-icon.mjs --project <p> --item rat-tail --from-image <art.png>
    [--size 40] [--no-backdrop] [--tint #hex] [--outline] [--sheet <zoomed-contact-sheet.png>] [--dry]
```

It writes `assets/textures/icons/<item-id>.png` and points the item's `icon`
field at it (`--dry` writes only the PNG). `--sheet` writes a 6x zoomed strip
of the icons it made on a slot-dark ground. Look at that; a 40 px PNG opened
directly tells you nothing.

## Two routes, one output

**An item with `appearance.model` is RENDERED, never drawn.** The tool loads
the item's own ubermesh, keeps only the parts the item names, samples its theme
sheet, lights it and shrinks it. It needs no image generator, and the icon
always matches what the player holds: a new theme or a new part pick costs one
command, and re-running after a re-bake picks up the change.
The renderer is a small software rasteriser inside the tool, so it runs in Node
with no browser.

**An item with no model** (trash loot, ore, potions, quest junk) has nothing to
render. Generate ONE picture of it and pass it with `--from-image`. The same
crop, shrink and hard-alpha steps then apply, so a generated icon comes out the
same size and edge style as a rendered one. Generating the picture:

```
node tools/image-request.mjs gen --id icon-<item-id> --target <scratch>/<item-id>.png \
  --size 512x512 --purpose "item icon" --prompt-file <prompt.txt>
```

The prompt rules that worked:
- "NO TEXT, NO FRAME. Background pure white #FFFFFF, flat, no shadow, no
  vignette, no floor." The tool floods the ground in from the border through
  near-white (min channel > 235) or transparent pixels. A painted backdrop or
  a cast shadow would be kept as part of the object.
- ONE object, centred, filling ~80% of the canvas, slight three-quarter view,
  lit from the upper left: the same framing and light as the rendered icons.
- Say what it is made of and its colours. Nothing painted near-white, or it
  is eaten as ground; a light highlight is fine, a white label is not.
- Keep the art (`--target`) in scratch or `tools/atlas/art/`; only the icon
  ships.

## Size and style

Matched to the hand-made `mmo-ui` icons: cropped to the object, longest side
40 px (they run 24-36 wide by 32-44 tall). The inventory scales an icon into
its cell with `image-rendering: pixelated`, so edges stay HARD: rendered at 8x
and box-filtered down, and alpha is thresholded at half coverage, never
feathered. With `--no-backdrop` the icon is transparent around the object; `--outline`
then adds the 1 px near-black ring on its own.

## Backdrop

By default every icon sits on an opaque ground so it pops in the cell, the way
the hand-made mmo-ui icons do: three octaves of value noise, a soft glow of the
tint behind the object, a darker rim, posterised to a few painted steps, and
the object outlined 1 px dark. It is seeded by the item id, so an item keeps
the same ground on every re-run. The tint comes from, in order: `--tint #hex`,
the item's `tint`, its rarity colour (uncommon and up, so the ground agrees
with the cell border), and otherwise the muted palette colour whose hue is
furthest from the object's own. That puts grey iron on amber and brown wood on
blue. `--no-backdrop` gives the bare transparent cut-out. The code is
`backdrop()` / `contrastTint()` in `tools/_icon.mjs`.

## Framing: per model, in the project

`projects/<p>/authoring/item-icons.json`:

```json
{
  "models": {
    "weapons/longsword-uber.glb": { "from": [1, 0, 0], "up": [0, 1, 0], "roll": 45 },
    "weapons/shield-uber.glb":    { "from": [1, 0, 0.25], "up": [0, 1, 0], "roll": 0 }
  },
  "items": { "dagger": { "roll": 30 } }
}
```

- `from`: the side of the model the camera looks at, in MODEL axes. Use the
  axes the model is authored in, which item-looks.md lists per model (the
  longsword's flat is ±X, its blade +Y).
- `up`: the model direction that points up the icon before the roll.
- `roll`: degrees, turning the icon. A positive roll puts a sword's tip at
  the top right, the way the hand-made icons lie. A diagonal also gives a long
  thin item the most pixels in a square cell.
- `items` overrides the model's framing for one item.

A new model needs one line here before its first icon. Without it the camera
looks down +X with +Y up.

## Traps

- **glTF counts V from the top, and so do PNG rows**: sample the theme sheet
  at `(u, v)` unflipped. The OBJ exports beside a model count V from the
  bottom; flip only those.
- **The part index is `uv1.x`** on an ubermesh vertex, and the `parts` table
  (name → index) is in the mesh node's glTF extras. An item naming a part that
  is not in the table gets a warning and draws without it.
- **Glow and effects are not in the icon.** A magic sword renders as its steel.
  If rarity must read in the cell, the cell's rarity tint already carries it.
