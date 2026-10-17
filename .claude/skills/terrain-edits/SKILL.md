---
name: terrain-edits
description: Shape the ground of a site or route in a voxel world and prove it clean — height patches (auto-feathered edges, filter, maxSlope), the `worldgen lips` and `worldgen seated` gates, road maxCut/maxFill, region vegetation and clearings (`worldgen vegetation`), floating plants (`worldgen scatter-float`) and mesher holes/blades (`voxel-blades`). Use before installing any POI or trail that writes patches, roads, carves or clearings, when the `terrain-lips` row fails, or when terrain shows teeth, rims, earth banks, floating trees or pale blades.
---

# terrain-edits

Sources: `docs/voxel-worlds.md` "Height-patch edges", section 31 "What grows in a region, and clearings", 25b
"Plants over a carve"; `docs/zone-creation.md` phase 2 (vegetation by place mood). Run from `apps/playground`.

**Paths are ribbons; never carve a path into the terrain**: a route is a `path` operator (docs/voxel-worlds.md "Path ribbons"), never a road band, carve boxes or a hand patch.

**Never write raw carve boxes (passages, narrow patches, blobs) for landforms: call an operator** (`features.operators`,
`worldgen op`, previewed with `worldgen op-preview` and approved by the owner first; docs/voxel-worlds.md "Landform
operators"). Anything under 6 m in its smallest dimension fails `worldgen fine` (the 6 m rule) — that is a kit/hero piece.
**A natural ledge system on a cliff is the `ledges` operator** (landmark mode: stacked rock masses baked by `tools/ledge-landmark.mts`, one triplanar cliff material); prove reach on its collider, not the field, and keep brows to single-band lips (docs/voxel-worlds.md "Landform operators").
**Any hero shape (arch, tower, spire) is the `landmark` operator** (CSG spec / Blender / generator -> DC bake by `tools/landmark.mts`, bury/pad blend >= 6 m, shells >= 3 voxels); bake, then run op --check, fine, lips, float near it (docs/voxel-worlds.md "Landmark stamp").
**A stepped hillside (town site, farm) is the `terrace` operator**: contour shelves + kit-walled risers + spanning-tree ramps; `op-preview` it on the gentler slope first, then check `unlinked` = [] and `tallRiserCells` = 0 in its report.

## Commands
```
npx tsx tools/worldgen.mts op-preview <world> --project <p> --op op.json [--near x,z,r]   # map PNG + three.js page, before/after
npx tsx tools/worldgen.mts op <world> --project <p> --apply op.json | --remove <id> | --undo <inverse.json> | --check
npx tsx tools/worldgen.mts fine <world> --project <p> [--near x,z,r] [--out f.json]          # the 6 m gate
npx tsx tools/worldgen.mts lips <world> --project <p> [--near x,z,r] [--list] [--json] [--allow ids]
npx tsx tools/worldgen.mts seated <world> --project <p> --slab x,z,halfX,halfZ,yawDeg,baseY | --slabs file.json
npx tsx tools/worldgen.mts terrace-place <world> --project <p> --spec terrace.json | --id x --path "x,z x,z" --height m [--insert stair-turn@4:0] ; --refit --all ; --check --all
npx tsx tools/worldgen.mts vegetation <world> --project <p> --region <id> --set <json|file> [--dry-run]
npx tsx tools/worldgen.mts vegetation <world> --project <p> --clearings <file> | --remove-clearings <owner|ids> | --at x,z
npx tsx tools/worldgen.mts scatter-float <world> --project <p> [--near x,z,r] [--list]
npx tsx tools/worldgen.mts landform-calm <world> --project <p>   # after adding a place/patch/track in a world with anchor landform profiles
pnpm -F playground exec tsx tools/voxel-blades.mts <recipe.json> --sites --caves [--box x0,z0,x1,z1]
```

## Height patches
- Edge feather is automatic (`blend` is a minimum; `feather` overrides); the raster is prefiltered (`filter`, default
  one voxel step; 0 = raw). Nothing narrower than the 2 m lattice can be drawn.
- `maxSlope` (opt-in) turns low risers (bench edges, pit rims) into talus; on a tall riser it swallows the tier below:
  a tall tier wall is architecture: a terrace wall (`terrace-place`: kit walls, levelled pad, its own lips/seated/riser
  gates; docs/voxel-worlds.md "Terrace walls") or a DC wall, then `--allow` the patch.
- `weights` (0..1 per sample) makes a patch MASKED: where 0 the ground beneath shows through instead of a frozen copy.
  Terrace walls write them; use them for any patch whose box covers ground something else edits later.
- A town's risers share ground: never refit one alone by hand-ordering. `terrace-place --refit --id <town>-riser-n`
  refits the whole town bottom-up; after `worldgen terrace` run `worldgen paths`, then `--refit --all`, then `--check --all`.
  A riser that cannot pass is shortened, then left a graded voxel riser by the stage (it says which gate failed).
- Roads: `maxCut` / `maxFill` cap tread, shoulder and band against the ground, so a trail rides the slope; the
  centreline `--max-cut` alone still cuts a wall beside it.

## Gates: failure -> fix
- `lips` `alias` (sawtooth), `step` (wall), `lip` (rim/slot) -> widen feather, set `filter`, `maxSlope` on low risers,
  `maxCut/maxFill` on roads; build tall risers as geometry. Run with `--near` before installing; zonegen row `terrain-lips`.
- `seated` `gap` > 0.25 m (hangs) / `clip` > 0.6 m (terrain through) -> lower/raise the slab or patch under it. It reads the
  REAL solid (cuts and formations are ground; `--drawn` = the old heightfield reading). Props and rocks: `worldgen float`.
  Installers that place walls/platforms on terrain run it.
- `scatter-float` > 0.35 m -> a clearing over the edit, or let the engine re-seat; never bury additive blobs to kill foliage.
- `voxel-blades` skirt ends in air / open edges > 0 -> a mesher seam fault: report it with coordinates (engine work);
  "blades" from field shape (MC interpolation, a step in `height()`) are the height source, not the mesher.
- Walk gate catches plants on routes -> clearings must cover every walked route and ramp, not only structures.

## Vegetation (all plants come from the foliage system)
- A place sets `regions[].vegetation` (allow/deny, density, `rules`, `replace` e.g. pine -> dead tree, `lean`) and keeps
  footprints bare with `features.clearings` (`feather`, `keep`, `owner`). Never plant pieces as props.
- `allow` only filters what the biome grows: swap species with `replace`. Coastal zones set `margin` (~80 m) so the beach
  is governed. A place cannot re-allow what its zone denies.
- Towns keep vegetation off each plot, street and door path (clearings owned by the town id, `excludeScatter: false`).

## Judgment
- Land is shaped in the terrain; docks, walls, stairs and quays are built geometry.
- Layout fits the terrain, not terrain the layout: a terrace levelled to a road shows as an earth bank from below.
- Trails: few, deliberate, wide hairpins following edges; sawtooth zig-zags and deep cuts into low ridges are faults.
  A trail leaving a walled town starts at a gate; long trails get a clearing strip before the walk.
- Walked pool rims and dais tiers <= 0.3 m; built stairs walk as one ramp collider; plank decks walk a hidden box.
- Route tunnels >= 2.2 m clear (a 3.2 m kit cell preferred); creature-size holes are dressing only.
- Rock formations are crafted DC rock placements (`fall-crafting`), never primitive boulders.
- A rock is its place's stone and wears the ground's cap: `worldgen rock-skins --near x,z,r` before install (a fault is a slice off the cliff's tone, or a cap the ground beside it lacks).
- Ground under a fall moves its water: re-run `worldgen water-edges --near x,z,r` after any cut, terrace, gorge or formation near a lip — the curtain follows the measured lip by itself, but a ledge or slot between lip and pool makes it land on rock (fill it, or make it a real tier).
