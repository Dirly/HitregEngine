# 3D Prefab WFC

`hitreg.wfc-3d` is a registered host tool, parallel to Armor Atlas. It consumes
a JSON prefab tileset and writes one reusable prefab under `assets/prefabs/`.
The output root is an empty bottom anchor; every occupied grid cell is a nested
prefab instance. An input tile without `prefabId` is empty space and emits no
entity.

The modeller's side of this — what to build, how to name it, how to build
the examples — is **docs/wfc-kit-authoring.md**.

There are two ways to get a tileset: **learn it from a kit** (parts plus
example structures — the normal route for modelled kits, below) or author it
by hand (the socket model further down, which the editor dialog edits).

## Kits: parts + examples in, everything else derived

```
pnpm -F playground wfc import <kitDir> --project <name> --cell 4,3,4 [--kit <id>] [--atlas <name>]
pnpm -F playground wfc pack   <propsDir> --project <name> --atlas <name> --out models/<folder>
pnpm -F playground wfc solve  --project <name> --kit <id> --name generated/house-01 --size 6,1,6 [--seed 1]
pnpm -F playground wfc inspect <file.glb>  [--cell 4,3,4]      # what the importer sees
```

(`node tools/wfc-3d/kit.mjs …` from the repo root is the same thing.)

### The drop

`<kitDir>/` holds one **part** per file and an `examples/` folder:

- `floor.glb`, `floor-planks.glb`, `wall.glb`, `wall-window.glb`, `door.glb`,
  `stair.glb`, … — every piece anyone models, and the ONLY thing anyone
  models. Authored in its cell's frame: **origin at the cell's bottom
  centre**, Y up, metres. A floor is centred on the origin. A wall sits on
  ONE cell edge with its thickness inside the cell and runs the full edge,
  corner to corner, so two straight walls in neighbouring cells meet flush
  and a two-wall corner in one cell overlaps at the post. Which edge is
  authored doesn't matter; the importer reads it from the bounds.
- The first word of the file name is the part's **role**: `floor`/`ground`
  and `ceiling`/`roof` are face parts (their texture gets counter-rotated, see
  below); `wall`, `door`, `doorway`, `window`, `arch`, `fence`, `rail`, `gate`
  are edge parts; anything else (`stair`, `pillar`, `table`) is a fill part
  that sits in the cell with whatever rotation it was placed at.
- `examples/<name>.glb` — structures **built from those same parts**, placed
  on the cell grid and rotated about Y. Never mirrored: the solver can only
  rotate, and a mirrored node is reported and skipped (hand in a mirrored
  part instead). Each node keeps its part's name; Blockbench's `wall 2` /
  `wall.001` / `Wall_3` suffixes are stripped, and a node with a mangled
  name is matched by geometry as a fallback (the report says which).
- Textures stay embedded in each part, PNG, any size — 128px per face is
  fine. Name materials in the modelling tool (a Blockbench export that calls
  everything "pasted" still atlases, but the report is unreadable).

### What the importer learns

Every cell of an example (plus a one-cell margin of void around it, above
and below too) becomes an observation. A cell is the multiset of parts in it
with their slots — floor, ceiling, `px`/`nx`/`pz`/`nz` edge, fill — and cells
that are the same up to a Y rotation are one **tile**. So you never model a
corner: floor + wall on two adjacent edges is a tile the importer composes
from your floor and your wall, and its four rotations are the four corners.
A full-footprint floor's own rotation is ignored (see alignment); a partial
floor's is kept, because a half square is a different shape when turned.

Each tile face gets a **profile** — the edge part on it, else `open` for a
floor continuing, else `void`; `py`/`ny` carry the ceiling/floor part or
`open-top`/`open-bottom`. The importer records every PAIR of profiles that
touched in the examples, horizontally (unordered) and vertically (lower `py`
over upper `ny`), and that list is the whole adjacency rule. The example
only teaches what it shows: a pairing you never placed is forbidden, which
is how "an open floor never faces the void" and "walls face the void" come
out without anyone typing sockets. Tile weights are observed counts.

### What it writes (under the project's `assets/`)

| Path | What |
| --- | --- |
| `models/wfc/<kit>/<part>.gltf` | the part with UVs remapped onto the kit atlas, self-contained, `TEXCOORD_1` = the UV rotation centre |
| `textures/atlas/<atlas>-<n>.png` + `<atlas>.atlas.json` | the atlas page(s), their island layout, and every module on the page |
| `prefabs/wfc/<kit>/<tile>.json` | one prefab per learned tile: empty anchor root, one child per part (`floor`, `wall-px`, `door-nz`, `fill`…), `renderMode: "instanced"`, box colliders from the part bounds |
| `wfc/<kit>.tileset.json` | the learned tileset — readable, hand-editable (weights, extra pairs) |
| `wfc/<kit>.kit.json` | the import report: roles, slots, placements, which node matched how, every warning |

Re-run the import after any change to parts or examples; the derived files
are regenerated (the prefab folder is replaced wholesale).

### The atlas: one page per project, not per kit

Every texture every module embeds is pulled out, deduplicated by content, and
packed onto one 2048px page (a second page opens only when the first is
full — `--page 4096`/`--pad` change the size and bleed). The page is named
by `--atlas` (default: the kit id) and is a PROJECT resource: a second kit
imported with the same `--atlas` lands on the same page, and plain props —
anything that is not a WFC part, the town's barrels and carts — join it with
`wfc pack <propsDir> --atlas <name> --out models/<folder>` (one module per
file, rewritten to `models/<folder>/<name>.gltf`; the sources stay where
they are, so `--out` cannot be the source folder). Every module on the page
embeds it under the same `hitreg-shared:<hash>` image name, and the
renderer dedupes by that name, so a whole town costs ONE GPU texture.

The layout file records every module on the page. Whenever the page changes
(a new texture arrives), every recorded module is re-emitted with the new
page bytes, so they never drift onto different copies. Islands never move,
so a finished module keeps its UVs; delete the layout to repack from
scratch. Flat material colours become 4x4 solid islands. Source material
NAMES are kept on the rewritten modules (one output material per distinct
source material), so `wind.materials: "Leaves"` still matches after
atlasing — name the material, because the texture name becomes the shared
hash. What the atlas buys is one texture binding and one shader program per
material kind; draw calls stay one per (module, submesh) instanced batch,
which is already the right granularity. Two rules fall out of atlasing:

- A face cannot rely on UV WRAP to repeat a texture: an island can't tile
  inside the page. The importer clamps and warns naming the part. Subdivide
  the face or pre-tile the texture.
- Islands bleed by copying the OPPOSITE edge (wrap bleed), so a floor
  texture that continues from cell to cell samples its own continuation in
  the mip chain, not a neighbouring island.

### Floor texture alignment (why planks stay straight)

A floor-with-wall tile placed at a 90° variant would turn its planks with it.
The importer measures each floor/ceiling part's UV projection (an affine fit
over its up-facing triangles) and records a `factor` (−1 when the projection
preserves handedness, +1 when it mirrors) and the UV of the part's local
origin. The tileset lists those children under `alignUv`; when the solver
places a rotated variant, the generated prefab carries an override on that
child — `mesh.source.uvRotation = factor × rotation` — and the renderer
rotates the texture back, per instance, about the recorded centre, in the
SAME shader every floor of every building shares (an instanced float
attribute; see `packages/render/src/instancing.ts`). Rotating the whole
building rotates every floor with it, because the correction undoes only the
per-cell variant, never world orientation.

Consequences for authoring: a floor's texture island must be **square**
(a 90° turn of a non-square island skews it; the importer warns); a
partial floor (a balcony) is fine, since it's the texture that
counter-rotates, not the geometry; the counter-rotation is only honoured on
`renderMode: "instanced"` meshes, which is what the cell prefabs use.

### Solving

`solve` collapses a grid with the learned tileset and writes
`prefabs/<name>.json` plus a top-down SVG under `.hitreg/wfc/`. Beyond the
grid lies the `void` tile (`outside` in the tileset), so buildings come out
enclosed. The result is an ordinary prefab: place it in a scene with a
`prefab` component at any position and Y rotation, and the source parts
keep propagating edits into it. Weights in the tileset file are the knob for
"more rooms, less void"; pins and boundary sockets work as for hand-authored
tilesets. The registered runner (editor **tools → 3D Prefab WFC**, or an
agent posting the tileset file) accepts a learned tileset unchanged.

## Authoring a tileset by hand

Start from `example.tileset.json`. Each tile occupies exactly one cell of
`cellSize`. Author each source prefab with its root at the cell's bottom-center
contact point, as required by the engine prefab convention.

In the editor, open **tools → 3D Prefab WFC**. Add source prefabs from the
picker, then select any tile to inspect the actual expanded prefab in the 3D
preview. Drag to orbit and use the wheel to zoom. The blue wire box is one WFC
cell; the surrounding floor grid shows how neighboring cells line up. Rotation
buttons preview every Y variant, while the measured size and **fits cell** /
**overflows cell** label make bad modules visible before a solve.

Use **center + ground** to align a source whose authored root is inconvenient.
This records an `offset` on the tile rather than modifying the source prefab.
The offset is baked into every generated nested instance and rotates with its
variant. Existing JSON tilesets can still be imported, and agents continue to
call the exact same registered runner with a JSON file input.

Every tile declares all six sockets: `px`, `nx`, `py`, `ny`, `pz`, `nz`.
Without an `adjacency` block, touching faces are compatible when their socket
strings are exactly equal. A socket name is semantic rather than geometric:
`road`, `solid`, `door-2m`, and `air` are all ordinary labels. Use distinct
labels whenever two profiles must not connect. With `adjacency: { horizontal:
[[a, b], …], vertical: [[lowerPy, upperNy], …] }` (what the kit importer
writes) the listed pairs are the whole rule instead.

`rotations` creates Y-axis variants. The tool rotates the horizontal sockets
and the emitted prefab instance together. A tile's weight is divided across
its rotation variants, so enabling four rotations does not make that tile four
times more common.

`offset: [x, y, z]` is an optional local alignment correction. The editor's
3D preview can calculate it with **center + ground** so the rendered prefab is
centered horizontally in its highlighted cell and rests on the cell floor.
The correction rotates with each Y variant, keeping the prefab centered at all
allowed orientations without modifying the source prefab.

`boundary` is optional and directional. When present, cells on that outside
face must expose the named socket. Omitted faces are unconstrained. `outside`
names a tile that stands beyond every unconstrained boundary face instead.
`pins` are also optional; they force a tile, and optionally a rotation, at a
grid cell. Pins outside the requested output dimensions are rejected.
`alignUv: [{ child, factor }]` on a tile lists prefab children whose
`mesh.source.uvRotation` the emitted instance overrides with `factor ×
rotation`.

The collapse is deterministic for the same tileset, dimensions, and seed. A
contradiction retries with another deterministic branch up to `attempts`; an
exhausted run writes nothing and reports which rules to inspect.

## Self-tests

```
node tools/wfc-3d/self-test.mjs       # solver + registered runner
node tools/wfc-3d/self-test-kit.mjs   # kit import → atlas → learn → solve, on a synthetic kit
```

Both run under root `pnpm test`. The kit test also checks the floor
counter-rotation numerically against three's `rotateUV` formula for both UV
handednesses.

## Current scope

One-cell tiles, exact-socket or learned-pair matching, Y rotations, weights,
boundaries, an outside tile, and pins. It deliberately bakes a prefab rather
than running at play time. Not yet: multi-cell "big tiles", global
path/connectivity constraints (rooms of a target size, corridors that must
connect), and an interactive socket painter.
