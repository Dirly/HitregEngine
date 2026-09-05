# Building a WFC kit: the modeller's guide

This is the guide for the person in Blockbench. It says what to model, how to
name it, how to build the examples, and how to hand it over. The tool side
(what the importer does with all this) is in `tools/wfc-3d/README.md`; you
don't need it to make a good kit.

The short version: **you model parts, you build a few example structures out
of those parts, you hand over both.** Everything else — corners, the texture
atlas, the placement rules, the prefabs — is generated from that.

## 1. Pick a cell size and stick to it

A kit lives on a grid of identical cells. Decide the cell before the first
part: width × height × depth in metres, for example `4 × 3 × 4` (a 4 m room
footprint with a 3 m ceiling). Every part in the kit is built for that cell.
Two kits can use different cells; one kit can't mix them.

Write it down. The import needs it (`--cell 4,3,4`) and nothing in the files
says what it was.

## 2. The parts

One part per file. A part is a piece that lives in a cell: a floor, a wall,
a door, a window, a stair, a pillar. It is the only thing you ever model.
You never model a corner, a T-junction or a room — those come out of the
examples.

### Origin and frame

- **Y up, metres, origin at the cell's bottom centre.** The cell spans
  −2..+2 on X and Z for a 4 m cell, and 0..3 on Y for a 3 m cell. The
  importer reads every position relative to this origin, so a part whose
  pivot is in a corner comes out one half-cell off.
- **A floor is centred on the origin** and sits on Y = 0 with its top face
  up. A full floor covers the whole cell footprint edge to edge. A partial
  floor (a balcony, a half slab) is fine, as long as its origin is still the
  cell's bottom centre.
- **A wall sits on ONE cell edge, with its thickness inside the cell**, and
  runs the full edge from corner to corner. Which edge you choose doesn't
  matter, the importer reads it from the geometry, but be consistent so the
  examples are easy to build. Two straight walls in neighbouring cells then
  meet flush; two walls in one cell overlap at the post, which reads fine at
  this style. If you want a real corner post, model one as its own part.
- **Doors and windows are wall parts** with a hole. Same edge rule. If a
  door needs a frame that pokes into the neighbouring cell, don't: keep every
  part inside its own cell.
- **Stairs, pillars, furniture** sit wherever they belong inside the cell,
  with the same origin rule. They keep whatever rotation you place them at in
  the examples.
- **Ceilings and roofs** are face parts like floors, at the top of the cell.

### Naming

The **first word of the file name is the part's role**, and the role
decides how the part behaves:

| First word | Role | Behaviour |
| --- | --- | --- |
| `floor`, `ground` | face (bottom) | texture stays aligned across rotated cells |
| `ceiling`, `roof` | face (top) | same |
| `wall`, `door`, `doorway`, `window`, `arch`, `fence`, `rail`, `gate` | edge | snaps to a cell edge |
| anything else | fill | sits in the cell at its placed rotation |

Then a descriptor: `floor-planks.glb`, `floor-stone.glb`, `wall-plain.glb`,
`wall-window.glb`, `door-arched.glb`, `stair-straight.glb`. Lowercase with
dashes. Avoid a trailing number on a part name (`wall-2`), because that is
what Blockbench appends to copies and the importer strips it.

**Name the material inside the file too.** A Blockbench export that calls
every material "pasted" still works, but the import report is unreadable and
anything that matches materials by name (wind on leaves) can't find them.
The texture's own name doesn't survive atlasing, the material name does.

### Textures

- Embedded in the part, PNG. 128 px per face is fine. Any size works; keep
  it a power of two out of habit.
- **A floor or ceiling texture must be square.** The floor's texture is
  rotated in place to keep planks straight, and a non-square texture skews
  under that rotation. The importer warns if it isn't.
- **No face may rely on UV wrap.** A face whose UVs run 0..3 to repeat a
  texture three times will be clamped, because textures live on a shared
  atlas page that cannot repeat. Either subdivide the face or pre-tile the
  texture. The importer names the part when it finds one.
- Floor UVs are a straight top-down projection of the cell onto the texture,
  which is what Blockbench does by default for a box's top face. A full
  floor uses the whole texture; a half floor uses half of it. Don't stretch
  a half floor over the full texture, or its planks won't line up with the
  neighbouring full floor.
- Flat colours with no texture are fine. They become tiny solid patches on
  the atlas.

### Export

glTF or GLB from Blockbench, one file per part, textures embedded. Nothing
else is needed. If you export a whole shelf of parts as one file, the split
tool cuts it apart along root nodes and each root node's name becomes the
part name, so name the groups.

## 3. The examples

An example is a structure built in Blockbench **out of the parts above**,
exported as one GLB into an `examples/` folder next to the parts. This is
where the kit's rules come from, and it is the part that takes some thought.

### Building one

- Place parts on the cell grid. A part's origin goes at the centre of its
  cell, so cell (2, 0, 1) means position (8, 0, 4) for a 4 × 3 × 4 cell.
  Snap to the grid; a part more than a fifth of a cell off is placed by its
  bounds and reported.
- **Rotate about Y only**, in steps of 90°. Never mirror or flip. The solver
  can rotate a part but it cannot mirror one, so a mirrored wall in an
  example is reported and skipped. If a piece genuinely needs a mirrored
  version, model it as its own part.
- Keep each placed part as a copy of the original with its name. Blockbench
  names copies `wall 2`, `wall.001`, `Wall_3`; all of those are recognised.
  A part with a mangled name is matched by its geometry as a fallback and
  the report says so.
- Build on more than one storey if the kit has more than one. Stacking is
  learned from stacking.
- Don't put anything in the example that isn't a part. Decorative extras
  are reported as unmatched nodes and ignored.

### What the example teaches, and what it doesn't

The importer looks at every cell of the example, plus the empty space one
cell around it, above it and below it. It learns two things:

1. **Which combinations of parts occur in one cell**, up to rotation. Floor
   plus one wall. Floor plus two walls meeting at a corner. Floor plus two
   opposite walls (a corridor). Floor plus a door on one side and a wall on
   the other. Each of these becomes a tile, and the tile's four rotations
   come for free. If you never place a floor with three walls (a dead end),
   the kit will never produce one.
2. **Which faces may touch.** A wall's outer face next to empty space. An
   open floor edge next to another open floor edge. A floor over the ground.
   The sky above an open room. If two things never touch in any example, the
   solver will never put them next to each other.

That second rule is the one to keep in mind: **an example only teaches what
it shows.** The cost of a missing pairing is not an error message, it's a
kit that can't build something you expected, or a solve that gives up with a
contradiction. So one example is rarely enough. A good starting set:

- a plain rectangular room, 3 × 2 cells or so, fully walled;
- an L-shaped room, so the importer sees an inside corner;
- two rooms joined by a door;
- a room with a window on each side;
- if there are stairs: a two-storey piece with a stair and the floor cut out
  above it;
- a corridor, one cell wide, so the two-opposite-walls tile exists.

Weights come from counts: the more often a combination appears across the
examples, the more often the solver picks it. If a kit produces too many of
something, that's adjustable in the generated tileset file afterwards, so
don't distort the examples to tune it.

## 4. Handing it over

A folder per kit:

```
crypt/
  floor-stone.glb
  floor-drain.glb
  wall-plain.glb
  wall-window.glb
  door-iron.glb
  stair-straight.glb
  pillar-round.glb
  examples/
    room-plain.glb
    room-l.glb
    two-rooms-door.glb
    corridor.glb
    stairwell.glb
```

Plus the cell size. That's the whole delivery. Anything outside the repo is
fine (the last drop lived in `HitRegStudios/MMO/`).

Props that aren't kit parts — barrels, carts, signs — go in their own folder
and join the same texture atlas as the kit, so the whole town is one texture.
Same rules for them: one file per prop, origin at the foot, textures
embedded, materials named. No cell to worry about.

## 5. What happens next, and what comes back

```
pnpm -F playground wfc inspect crypt/wall-plain.glb --cell 4,3,4
pnpm -F playground wfc import crypt --project town --cell 4,3,4 --atlas town
pnpm -F playground wfc pack props --project town --atlas town --out models/props
pnpm -F playground wfc solve --project town --kit crypt --name generated/crypt-01 --size 8,2,8
```

`inspect` prints what the importer sees in a file — nodes, positions,
rotations, sizes, materials, whether anything is mirrored — and is the
first thing to run on a new part or example when something looks wrong.

The import writes a report (`assets/wfc/<kit>.kit.json`) that lists every
part with its detected role and edge, every placement in every example with
how it was matched, and every warning. The warnings are the feedback loop.
The ones you'll see:

- **"is outside its cell — is the origin at the cell's bottom centre?"** —
  pivot in the wrong place.
- **"named like a wall but ... thick"** or **"sits in the MIDDLE of the
  cell"** — a wall the importer couldn't put on an edge; it becomes a fill
  part, which is usually not what you meant.
- **"is MIRRORED"** — a flipped copy in an example; skipped.
- **"is rotated 37°, snapped to 0°"** — an example part not on a 90° step.
- **"origin ... is off the cell grid"** — placed by its bounds instead.
- **"relies on texture WRAP"** — a repeating face; clamped.
- **"is not square"** — a floor or ceiling texture that will skew.
- **"match no part by name or geometry"** — example nodes the importer
  couldn't identify.

Re-export, re-import. Nothing is hand-edited on the generated side, so the
loop is cheap: change a part or an example, run the import again, solve
again.

## 6. Things that are fine to do

- A kit with only floors and walls. Three parts make a usable kit.
- Several floor types. Each is its own part; the examples show where each is
  used.
- Partial floors, balconies, floors with holes. Their texture stays aligned
  like a full floor's.
- Overlapping geometry at corners. Two walls meeting in one cell overlap at
  the post by design.
- Reusing a wall between two kits. Import it in both; the texture is shared
  on the atlas either way.

## 7. Things that will bite

- **Copying a wall to the other side of a room by mirroring.** Rotate it
  instead. It's the single most likely thing to go wrong in an example.
- **A part that reaches into the next cell.** A wall's thickness on the far
  side of the edge belongs to the neighbour and will overlap whatever is
  there.
- **Forgetting a combination.** If the solver produces nothing but empty
  space, or fails outright, the first suspect is a tile or a pairing that
  isn't in any example.
- **Textures tiled by UV instead of by geometry.** They'll clamp.
- **Unnamed materials on anything that needs wind, glow, or special
  handling later.** Name them now; it costs nothing.
