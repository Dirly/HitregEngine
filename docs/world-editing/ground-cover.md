# Ground cover: flowers, reeds, lily pads and the rest

The small dense stuff — grass tufts, wildflowers, wheat, ferns, cattails,
lily pads — is **cover**, not scatter. Scatter puts props (trees, rocks,
bushes) into chunk data with colliders; cover is camera-following billboards
drawn only within ~50 m, with no colliders and no chunk cost. A world carries
its cover in the recipe's **`cover`** list, so every world the pipeline
generates grows its own. This file is the procedure and the rules; the fields
are in the `grass` component schema (`/__hitreg/spec`), and the mechanics
behind billboards (sinking on slopes, world-anchored placement, the fade) are
in `docs/voxel-worlds.md` §28.

## The pieces

| What | Where |
|---|---|
| Layer data | `recipe.cover[]` = a `grass` component + `id` (+ optional `note`) |
| Rule set for a project | `projects/<p>/authoring/cover-rules.json` (`{ "layers": [...] }`) |
| Art | `projects/<p>/authoring/cover-src/*.png`, generated at 256 px (tall: 256x512) |
| Pages | `assets/textures/cover/cover-{tufts,tall,water}.png` + `.tiles.json` |
| Pack manifest | `projects/<p>/authoring/cover-atlas.json` |
| Sampler (both hosts) | `apps/playground/src/voxel-ground.ts` |
| Gates (shared) | `packages/core/src/voxel/cover.ts` |

## The rules a layer follows

A layer is **one gate and one draw call**. Split layers by *where they grow*,
merge them by *what they look like* (atlas tiles):

1. **`biomes` says which place, `surfaces` says which ground in it.** Wheat is
   `biomes: [grassland, savanna, foothills]` AND `surfaces: [grass, drygrass]`
   — the biome keeps it out of the jungle, the surface keeps it off the dirt
   path through the meadow. Biome ids are the recipe's own; `worldgen cover`
   refuses a name the recipe does not have.
2. **Clump everything.** An unclumped layer is an even carpet, which reads as
   a texture, not a place. `clump` is the same fBm model as `scatter[].clump`:
   `density` is the PEAK inside a patch, `floor` what survives between.
   - landmark stands (wheat fields, bamboo groves): low `frequency`
     (0.005–0.012), high `threshold` (0.25–0.35), small `blend` (0.12) → rare,
     hard-edged, dense;
   - ground layers (heath, forest floor, swamp grass): `threshold` below 0
     and `floor` 0.25–0.35 → nearly continuous, thinned in places;
   - accents (foxglove, thistle): high `frequency` (0.04–0.05), high threshold,
     low density → little colonies.
3. **One layer, many tiles.** Poppies, daisies, lupins, buttercups and clover
   are ONE layer (`tiles: [0,1,2,3,4,4]` — repeat to weight). `tilePatch`
   (0.03–0.06) picks the tile from smooth noise, so the meadow is drifts of
   one flower beside drifts of another instead of confetti. Leave it 0 for a
   mix that should read mixed (a forest floor of fern AND moss).
4. **Water layers name `water`, and nothing else ever grows in water.**
   - `shore`: ground within `level` [min, max] of the nearest lake/river line
     within `reach` metres. A negative `min` lets cattails stand in the
     shallows. Lake banks are steep: give shore layers `slopeMax` ~0.62.
   - `surface` + `orient: "flat"`: floats on water `depth` deep, on rivers only
     below `maxFlow` m/s. Lily pads 0.3–2.2 m, duckweed 0.1–1.6 m.
   - Shore and surface layers skip the town/road clearance on purpose — a
     lake edge IS a feature edge.
   - `bed`: grows on the lake/river bed UNDER the water, `depth` deep, seen
     through the sheet (eelgrass, pondweed). The gate also demands the
     tallest card fit under the surface (`bladeHeight * scaleRange[1] + 0.15`),
     or weed tips poke out of the shallows like reeds.
   - Keep water layers PATCHY: Derek found lily pads at 0.5/m² "almost too
     much" and a cattail ring on every shore monotonous. Lily pads are now
     0.22/m² in `floor: 0` patches (11% of shallows), reeds clump with
     `floor: 0.05` so the shore has open gaps (26% of shore).
5. **Flowers get a tilted cap.** Crossed upright cards go edge-on and thin
   when a third-person camera looks down, so a flowering tuft carries
   `cap`: one extra card leaning `tilt` degrees from horizontal at `height`
   of the tuft, drawing a TOP-DOWN flower-head tile from the same page
   (`cap.tiles` pairs with `tiles` entry by entry; -1 = no cap, e.g. a lupin
   spike). Pack cap art with `{ "file": ..., "orient": "flat" }` so it is
   centred, not grounded on the tile's bottom edge.
6. **Never drift two white things together.** Pale fungus inside the swamp
   grass/cotton-grass drift read as mushrooms mixed into white flowers. A
   look that is not a plant of the same place gets its own layer (the fungus
   is `fungus-clusters`: 0.2 cycles/m, threshold 0.38 — clumps a few metres
   across, dense inside).
7. **Warm and cold versions of a shore.** Cattails/reeds for temperate
   biomes, papyrus for jungle/savanna/desert: two layers with disjoint
   `biomes`, never one layer everywhere.
8. **Desert stays sparse** (Derek: "too much brush in the desert"): 0.035/m²,
   clustered. The jungle is the densest ground in the world.
9. **Sizes are world metres of the CARD** (`bladeWidth` x `bladeHeight`);
   the pack tool fits each plant to its tile, so a low plant (moss, clover)
   occupies the bottom of a square card — size the card, not the plant.

## Verges

Every dry layer keeps off paths, towns and banks by `featureClearance`, and
that edge is RAGGED (`coverEdgeClearance` in core): the required clearance
is the card's half-width plus up to 1.8 m of smooth noise (~4.5 m
wavelength) and per-blade jitter. A single threshold drew grass along the
exact offset curve of every path — a sharp, jagged stencil. Paths and summit
trails are 3.4 m wide (`worldgen paths/trails --width`, was 2.4).

## Draw calls

Each layer is one instanced draw **only while it has instances near the
camera** (`mesh.visible` is off when a placement comes back empty), and the
host's region test (`GrassSystem.regionTest`) answers "can this layer grow
anywhere in this disc?" — from a 32 m biome-weight lattice, a 16 m clump-mask
lattice (layers with `floor: 0`) and the lake/river buckets — before a single
cell is sampled. So 23 layers cost 23 draws nowhere; `worldgen cover` prints
the distribution (MMO world: mean 1.5, p95 4, max 6 recipe layers at one
spot, on top of the scene's own grass/bramble). Adding a layer costs a draw
only where it grows.

Measured on the MMO world: the frame time is the same with world cover on and
off (A/B in one page session, +4-5 draws); what a layer really costs is CPU
PLACEMENT on each recenter, amortised at 2 ms a frame — cover that arrives
late while running, not lower fps. All 25 layers place in ~52-69 ms per
recenter at the heaviest spots. Check a new layer with
`projects/voxel-demo/tools/cover-bench.mts spots.json` (`DETAIL=1` per layer):
a layer with many calls and few hits is walking ground it cannot grow on —
tighten its region (biomes, a `floor: 0` clump) rather than its density.

## Adding a plant

1. **Draw it**: add an entry to a `gen-set` manifest (see
   `docs/image-generation.md`). The brief that worked: *one plant clump, side
   view, orthographic, base on the bottom edge, 6% transparent margin, chunky
   pixel art as if 64 px wide scaled 4x, 12–16 colours, no outline, even
   light, real alpha*, with `--ref assets/textures/mmo/GrassBillboard.png`.
   Floating plants: *seen from directly above, water not drawn*. ~75 s per
   image; six to a set.
2. **Pack it**: append the file to the right page in `cover-atlas.json` —
   **append, never reorder** (layer `tiles` index into that order) — and run
   `node tools/cover-atlas.mjs projects/<p>/authoring/cover-atlas.json --preview <dir>`.
   It crops, fits, area-downsamples (thin stems survive), hardens alpha,
   quantizes to a k-means palette and 15-bit colour (the PSX banding), and
   bleeds colour into the transparent texels so mips do not halo.
3. **Rule it**: add or extend a layer in `cover-rules.json`.
4. **Apply + audit**: `pnpm -F playground worldgen cover <world> --project <p> --apply projects/<p>/authoring/cover-rules.json`.
   It validates, writes `recipe.cover` (stamping the `cover` stage for
   `worldgen status`), then samples the world: which layers grow in each
   biome and how thick, draw calls where a player stands, and what share of
   lake/river shore and shallows carries the water layers. Exit 1 on
   findings (unknown biome/surface, missing page, an empty atlas slot, a
   layer that grows nowhere, a biome with no cover at all).
5. **Look at it**: `tsx projects/voxel-demo/tools/cover-spots.mts <world> --out spots.json`
   finds where each layer is thickest; `cover-probe.mjs` screenshots each
   spot headless with draw counts (header of the file has the commands).

A new world made with `worldgen all <world> --from <world with cover>` takes
the cover with the rest of the look.

## Traps

- **Tile index -> (column, row) must be biased, not `mod`.** The shader took
  `tile mod columns`, which is exact on paper and not on a GPU: division goes
  through an approximate reciprocal, 8 / 4 came out 1.9999999, and tile 8
  landed in column 4 — off the page, where clamp-to-edge smeared the last
  texel column into a curtain of vertical speckle. Every index that is a
  multiple of `columns` (bamboo, clover, moss, frost grass, papyrus…) rendered
  as noise while its neighbours were perfect. It is now
  `row = floor((tile + 0.5) / columns)`. If one tile of a page looks like
  static and the tile next to it does not, suspect index math first, not art.
- **Thin-stalked art at high density turns to static through the 480p
  pixelate** even with correct sampling: a stalk narrower than a pixel breaks
  into fragments. Bamboo lives at 0.3/m², not 1.2.

- **An empty atlas slot is invisible, not an error in the browser** — the
  cutout discards a transparent tile. `worldgen cover` reads the page's
  `.tiles.json` and flags it.
- **The scene still owns the base carpet.** The MMO scene's `grass-cover` and
  `bramble-cover` entities stay where Derek tunes them; recipe cover is the
  variety on top. Do not add a second everywhere-grass layer to the recipe.
- **`--apply` rewrites the recipe through the schema**, which fills defaults
  into older feature docs (a fall site gained its default `walls`/`gorge`
  fields). Same values, bigger diff; every stage does it.
