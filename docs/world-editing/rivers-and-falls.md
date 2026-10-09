# Rivers and waterfalls: the rules

These are the rules a voxel world's water follows, whether a river was traced
by `worldgen rivers --trace` or written by hand. They are Derek's calls from
the 2026-09-24/25 rounds (docs/voxel-worlds.md, "River water is clipped from
the terrain" and its rounds 2–4 hold the measurements behind each one). Read
this before regenerating a world, before changing a river rule in
`packages/core/src/voxel/field.ts`, and before writing a river by hand
(docs/world-editing/rivers.md is the hand procedure).

## What a river should look like

1. **Every river starts at a lake.** A traced channel begins at the shore of
   the first kept lake it runs through; everything upstream of that lake is
   land, and a channel that runs through no lake is not written
   (`--lake-heads 1`, the default). Tributaries follow the same rule: one is
   kept only if it runs through a lake of its own. Split-fall branches start
   in their parent river. A river from coast to coast is fine but is written
   by hand (hydrology channels only run downhill from a lake or a peak, so the
   tracer never makes one). `worldgen status` fails the rivers stage on any
   traced river whose head is not at a lake. Because fewer channels qualify,
   rebuild with more lakes (`--lakes 20`). Heads that are not at a lake still
   follow the lowland rule: the head moves to where the bed falls under 4 %
   over the next 200 m (`--lowland-grade`) and lies within 6 m of the ground
   (`--head-depth`), and under 300 m of lowland is not written (`--min-river`).
2. **Every reach carries water.** There are no dry gullies between wet
   reaches (`--wet-grade` defaults to Infinity). A river is one continuous
   surface from its head to its mouth.
3. **Water runs gently.** It follows the land at no more than 3 %
   (`RIVER_RUN_GRADE`): level on the flat, a gentle slope where the valley
   falls. It is never held in flat pools stepping down in ledges. Derek
   rejected that as odd.
4. **One waterfall per river, and only a real one.** Each river keeps at most
   ONE fall, at the sharpest drop along it: the most height lost within 60 m
   (`RIVER_FALL_WINDOW`), and only when that is at least 6 m
   (`RIVER_FALL_MIN`). Every other drop is carved away: the channel is cut
   down into a gorge so the water can keep running. Waterfalls must feel
   unique. A fall every fifty metres was rejected as a staircase. On the mmo
   world this gives 30 falls, a median of 23 m, and most are the plunge off
   the coastal scarp.
5. **A fall is a cliff, not a ramp.** The bed and the water drop over a 3 m
   lip (`RIVER_FALL_LIP`), wider than one lattice square so a diagonal fall
   does not zigzag. The foot is cut into a plunge pool a quarter of the drop
   deep (at most 2.5 m). The face uses the falling-water texture
   (`fallTexture`), and mist rises off the pool.
6. **Water sits in banks.** The level stands at least 1.5 m
   (`RIVER_FREEBOARD`) under the lower of the two banks, measured with no
   river carved and smoothed along the river. The channel is carved as a
   flat bed with one bank slope that passes the waterline and meets the land.
   At three-quarters of a bank out the land stands about 2 m over the water.
7. **Water is at least 3 m deep** (`MIN_WATER_VOXELS`, 1.5 voxels). A
   shallower channel cannot survive marching cubes: the bed pokes through the
   water, and the water hangs off the edges.
8. **Rivers are a network.** A tributary runs INTO its trunk. The trunk may
   not stand higher at the confluence than the tributary arriving, so it is
   lowered from the confluence down, repeated until nothing moves.
   Tributaries grade down to their trunk's level instead of falling into it.
   A river flowing into or through a lake is flush with the lake.
9. **Rivers never cross.** A course that crosses another river's channel is
   captured: it ends there, joined to the river with the lower bed, and the
   rest of its course is dropped.

10. **A fall pours through a notch between cliffs.** From 10 m above the lip
    to most of the drop past it, the ground beside the channel (off the bed,
    out to about two banks) is built up to 1 m over the UPPER water, up to
    30 m (`fallWalls` in field.ts). It is full height at the lip and eases
    away downstream and outward, so the rock shoulders back into the land.
    Near a fall the water is held to the bed's width, never the bank reach,
    so the upper pool cannot drape over the ground beside the lip.
11. **No fall right at a lake.** A fall may not be within three samples
    (about 24 m) of a lake. A lake spilling straight over a cliff put a calm
    sheet and a falling one against each other at a hard seam.
12. **One water material.** Rivers and plain lakes share the river material,
    so where they meet they are one mesh and one surface. Only a lake that
    names its own water (a swamp) keeps it.
13. **Every fall has mist, splash and foam.** Three emitters at the foot, all
    sized by the drop: mist (the dust bank's soft noise puffs in white),
    splash (white pixel droplets thrown up and pulled back by gravity) and
    foam (rings spreading on the pool).

14. **A river carries water from its head.** A traced river starts where its
    valley flattens AND its bed is within 6 m of the ground (`--head-depth`).
    A wet head is cut to its solved bed; the taper only narrows it. Before,
    the taper cut heads shallow while the water was solved from the deep bed,
    and every head was a dry trench.
15. **Lakes are still, rivers flow, and each fades into the next.** Rivers and
    plain lakes share one material. It shows `stillTexture` (the lake's tile,
    drifting like the sea) where the current is slow and the flowing texture
    where it runs. The current is 0 on a lake, ramps up over the first 40 m of
    a river leaving one, and quickens over the last 30 m before a fall's lip.
    A river leaving a lake descends from the lake's level at the run grade (up
    to 6 m over its bank cap), and never steps down at the shore.
16. **A waterfall is a curtain.** The falling water is its own mesh
    (`fallCurtain` in chunk.ts): a sheet from the lip line across the channel
    plus 1.5 m into the rock each side, arcing out as it drops and ending under
    the pool. The terrain-clipped water is cut exactly on the lip line, flat at
    the upper level before it and at the pool's after it. Drawing the fall from
    lattice squares gave sawtooth faces and fins at every angle. A steep face
    shows the fall texture, not depth-banded water.
17. **Some falls split.** At about 40 % of falls at least 12 m high
    (`--split-falls`, `--split-min`), worldgen writes a branch river
    (`<river>-split`, points only, `maxGrade` 0). It leaves the river 45 m
    above the lip, runs along the cliff top 14–30 m to one side, pours over the
    same scarp as its own fall, and rejoins 40 m below. The field solves its
    head flush with the river it leaves, and the fall walls never block
    another river's bed. Branches are rewritten from the current falls on
    every `rivers` run.
18. **Every drop is a fall, and a fall holds its level to the lip.** Any drop
    of 1 m or more gets a lip point 3 m before it, whenever its step is longer
    than that. The upper water holds its level to the lip: never clamped to
    the bank beside it, since at a cliff edge that bank falls away, and the
    clamp put a sloped step before every fall. The fall walls stand over the
    upper water either side. A lake that must drop to its river spills
    straight over its cliff as a fall (it may be a river's second fall). The
    flat pieces cut at the lip line are clipped against the ground like all
    water, or they hang out over the rock beside the lip.
19. **An end cap applies only at the end.** The plane across a river's head
    or mouth applies only when that end is the nearest point of the river. As
    a free half-space it cut away the water of every stretch that curled back
    past it.

20. **Steep faces are cliff rock, even at the water.** River, lake and road
    paint fade out between 40 and 53 degrees (PAINT_STEEP_START/END in field.ts),
    so fall walls, gorge sides and cut banks keep the biome's cliff surface.
    Only gentle beds and banks take the gravel, sand or mud.
21. **A fall is decided by one lip line.** Every question near a fall (the
    carve, the water level, the lake's reach, the rims, the mesh) asks which
    side of the fall's lip line a point is on. Upstream means the upper bed
    and level; past it means the lower ones. The gorge below is a slot: steep
    walls for about the drop's length, then normal banks. Fall walls stand
    upstream of the line only, never more than 4 m over the ground. No lake
    rim is built past a lip line, and a lake's reach ends at it. Asking for
    the nearest segment instead blended the two levels across the lip, which
    caused the notch, the dirt towers and the sawtooth edge.

22. **Water sits IN the land; nothing is built to hold it.** No berm ring
    around lakes. Banks beside lakes and rivers are raised at most 1.2 m
    (SHORE_MAX_BUILD), and only outside the water's own reach. A river bed may
    still be built up under water. Where more would be needed, the water level
    or the shore gives way instead.
23. **A lake reaches its real shore.** Its water floods every cell whose ground
    is below the lake's level, up to 2 banks past the traced outline
    (lakeFlood), and never past a fall's lip line or into a lower river
    channel.
24. **No blades, no cliff edges from fades.** A cut too deep to slope back to
    the land steepens its bank to meet it (at most BANK_MAX_RISE, 1.6, about
    58 degrees) instead of fading out as a one-voxel cliff. Gorge walls below a
    fall are FALL_GORGE_RISE 1.6. Near a fall, any column standing more than
    3 m above both neighbours 4 m away (a knife ridge between two cuts) is
    trimmed (unblade), unless it holds water back.

## How the water is drawn (do not undo these)

- The water surface is one function, `field.waterSurface(x, z)`: the lake
  inside a lake's sheet, otherwise the solved level of the channel the point
  is in. Each streamed cell samples it and the ground on the terrain's own
  2 m lattice, and keeps water wherever it stands above the ground. The edge
  is cut 0.35 m under the bank. **The shoreline is where the ground meets the
  water. No mesh width ever decides it.** Ribbons and lake sheets with
  formula widths were tried for six rounds and never fit.
- A lattice square whose water spans more than 1.5 m (a fall face) is drawn
  whole or not at all, never clipped against the gorge walls. A whole square
  splits along the diagonal whose ends are closest in height: across a lip
  (three corners up, one down) the other diagonal folds the face into teeth.
- Shoreline foam comes from the water depth, and a fall face stands a hand in
  front of its rock, so the foam fades out with steepness. Otherwise every fall
  paints solid white and the fall texture never shows.
- The texture is laid out in world metres and advected along the current
  (`flowMode: "field"`; the current rides in the mesh's uv). A steep face
  switches to `fallTexture`, which is sampled down world Y and scrolls
  downward.
- The mist is a `particles` emitter per fall, in the weather dust bank's
  configuration (big soft upright noise quads) in spray white. It is emitted
  into the chunk that holds the plunge pool, near cells only, and every
  fall's mist shares one draw.
- A last pass, `containWater`, holds the ground above the water at the edge
  of every river's and lake's reach, unless another body of water owns the
  point.

## Rebuilding a world

The order is `worldgen all` (continents → canyons → rivers → towns → terrace →
zones → paths → barriers → pois → trails → barriers → caves → map), then
`worldgen spawn <world> --scene <scene>` and
`projects/proving/tools/place-spawn.mts --world <w> --scene <s>`. The mmo
world is built with:

```
cd apps/playground
npx tsx tools/worldgen.mts all mmo --project proving --trace --catchment 0.6 --lakes 20 --terrace-share 0.75
npx tsx tools/worldgen.mts spawn mmo --project proving --scene mmo
npx tsx projects/proving/tools/place-spawn.mts --world mmo --scene mmo
```

**Any change to a water rule in field.ts makes towns, paths and trails
stale.** They were solved against the old water. `worldgen status` checks the
built world and says so: it flags paths and trails under the water, and river
reaches perched over their valley. Rebuild from `all`; it takes about 4
minutes.

Then check, in this order:

1. `worldgen status <world>`: every procedural stage ok.
2. `worldgen audit <world>`: 0 towns under water, 0 road points submerged,
   and no uphill WATER steps beyond a few at lake inlets. Beds do climb out
   of plunge pools.
3. `tools/_river-crossings.mts`: 0 crossings.
4. `tools/_falls.mts` (untracked scratch): falls about one per river. If
   there are many more, rule 1 or 4 has been broken.
5. `tools/_water-check.mts`: shoreline vertices under the bank
   (p10 ≈ +0.35 m). Hanging vertices are at waterfall lips and sea mouths.
6. Screenshots on a FRESH dev server (`npx vite --port 5199 --force`). A
   running one's terrain worker can keep old core code.

## Changing the look, not the rules

- The water texture, river tile size (river `textureScale` 7 vs lake 26),
  foam width and the fall texture are material settings in
  `materials/terrain/<world>-water-river.json` and `-lake.json`.
  `worldgen rivers` rewrites the river material from the lake one every run.
  It picks up `<Name>Fall.png` beside the base texture as `fallTexture`.
- New art comes from the image tool (docs/image-generation.md). Generate at
  256 px, then downsample nearest-neighbour to 128 px for the PSX look.
- More waterfalls are a per-river decision (write a river by hand across a
  scarp), never a denser rule.

## Crafting a fall (agent pass)

**The current process is docs/world-editing/fall-crafting.md** (the fall-crafting skill wraps it). The notes below describe the site mechanism.

Procedural worldgen places the falls; an agent makes some of them places. A
**fall site** (`features.fallSites`, schema in `voxel/fall-sites.ts`) names one
solved fall by its foot and reshapes only that fall's span. It never edits voxel
data. The field splits the drop into tiers with level pools between them, raises
a bounded rock ledge under each pool (the river cuts its channel back into it),
and every tier then gets the normal lip line, curtain, mist and splash.
Rocks are instances of the world's own scatter rules, so they batch with that
rule's other instances and add no draw call.

```
worldgen fall-site <world> --list                          # falls by index
worldgen fall-site <world> --fall 8 --snapshot             # ~2k tokens of context
worldgen fall-site <world> --fall 8 --template cascade --tiers 3 --pool 16
```

The snapshot gives the agent the fall's levels and direction, a 32 × 32 grid
(2 m) of ground height relative to the lip, a water mask, and the rock rules.
From it the agent can write or adjust the site doc directly: tier `share`s,
`pool` lengths, and `rocks` with `rule`, `at`, `lift`, `yaw` and `scale`. Keep
every tier at least 3 m. A site is re-solved live and follows its fall if the
river is re-solved. Re-run `paths` if a path crosses the site, because a bridge
solved against the single fall will cross mid-cascade.

**Crafted pools fill their bowls.** A crafted pool is the channel with its bed
widened `gorge.bowl` times. Its water reaches the bowl's waterline plus an apron,
and it reads that from the same shape the gorge carves (`siteBowlShape`), so the
carve and the water can't disagree. The containWater rim moves out with it. The
bowl is shut at both necks, each measured from its own lip line, so every
curtain spans only the channel's water. Never cap a bowl to the river's water
reach: that cap is why `bowl` once did nothing.
