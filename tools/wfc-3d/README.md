# 3D Prefab WFC

`hitreg.wfc-3d` is a registered host tool, parallel to Armor Atlas. It consumes
a JSON prefab tileset and writes one reusable prefab under `assets/prefabs/`.
The output root is an empty bottom anchor; every occupied grid cell is a nested
prefab instance. An input tile without `prefabId` is empty space and emits no
entity.

## Authoring a tileset

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
Touching faces are compatible when their socket strings are exactly equal. A
socket name is semantic rather than geometric: `road`, `solid`, `door-2m`, and
`air` are all ordinary labels. Use distinct labels whenever two profiles must
not connect.

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
face must expose the named socket. Omitted faces are unconstrained. `pins` are
also optional; they force a tile, and optionally a rotation, at a grid cell.
Pins outside the requested output dimensions are rejected.

The collapse is deterministic for the same tileset, dimensions, and seed. A
contradiction retries with another deterministic branch up to `attempts`; an
exhausted run writes nothing and reports which rules to inspect.

## Current scope

This first version is the simple-tiled 3D model: one-cell prefabs, exact socket
matching, Y rotations, weights, boundaries, and pins. It deliberately bakes a
prefab rather than running at play time. Multi-cell "big tiles", learned face
profiles from mesh geometry, global path/connectivity constraints, and an
interactive socket painter can layer onto the same tileset contract later.
