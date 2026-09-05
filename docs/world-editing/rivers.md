# Rivers, by hand

You are carving a river into a live voxel world by writing one entry into
the recipe's `features.rivers`. The field solves the bed, cuts the channel,
builds the banks and lays the water; paths get bridges when their stage is
re-run. The generator does not make rivers any more (`worldgen rivers` picks
the lakes and fills the hollows; `--trace` is the old network, don't use it
on an authored world). This is the procedure that produced the first three,
with what went wrong the first time and what a human still saw afterwards.

Read this whole file once. Then work through **Steps** with the commands.

**How many: about four rivers in the whole world, total.** Not one per
lake. The traced network drew hundreds and the world read as a drainage
diagram; a handful of long, deliberate rivers — one per landmass, a trunk
with one tributary on the biggest — is what makes a river a landmark
players steer by. Count the rivers already in `features.rivers` before
adding one; if there are four, you are replacing or extending, not adding.

## What you are writing

```json
{
  "id": "river-a",
  "points": [[3330, 1885], [3250, 1892], ..., [2020, 2590], [1960, 2600]],
  "width": 18,
  "widths": [9, 9.4, ..., 18],
  "depth": 4.2,
  "depths": [2.5, 2.6, ..., 4.2],
  "bank": 15.6,
  "maxGrade": 0.05,
  "water": true,
  "surface": "gravel",
  "surfaceEdge": 3,
  "taper": 0,
  "tags": ["hand"]
}
```

- `points`: world XZ, **head first, mouth last**, 25–40 of them for a 2–3 km
  river, 40–120 m apart. They are resampled along a spline, so write the
  bends, not the wiggles.
- **No `bedY`.** That is the whole trick: a doc without a bed is solved by
  the field (`solveRiverBeds` in `packages/core/src/voxel/field.ts`). A doc
  WITH a bed is taken literally and never re-solved.
- `width` is the widest point; `widths` (one per point) ramps from the head.
  Rule of thumb from the old width law: 2.5 m for a brook, 8–12 for a
  tributary, 15–30 for a trunk reaching the sea. `depth` ≈ 0.9 + 0.2 × width,
  deepest at the mouth, `depths` ramping the same way.
- `bank` ≈ 0.7 × width + 3. It sizes how far the cut and the levee reach.
- `maxGrade` 0.05: any drop steeper than 5 % becomes a gorge cut upstream.
  Lower is gentler water and a longer canyon; 0 disables it (a slide down
  the cliff). See **The coast problem**.
- `surface`: a bed surface the palette has (`recipe.surfaces[].name`) —
  `gravel` if present, else `sand`.
- `taper` 0 when the head is in a lake (a lake outlet is full width from the
  first metre); 80–150 when the head is a spring on a hillside.
- List order matters: **a tributary goes AFTER the river it joins**, because
  rivers are solved in order and a mouth is made flush with whatever river
  is already under it.

## How the field solves it (so you can predict it)

1. Points → centripetal Catmull-Rom spline, one point every `max(6, width/2)` m.
2. Target bed at each point = ground − depth, where ground is the world with
   canyons, fills, lakes and every river solved before this one — towns and
   roads are NOT applied (a river cuts a road; the road never lifts the
   river).
3. Within one bank of a lake: target is held at the lake's flush level
   (`waterY − 0.7·depth − 0.15`), and from the first such point onward the
   bed is CAPPED at it. Water leaving a lake cannot stand above the lake.
4. Under another river's water: target is flush with that surface.
5. Under the sea: target is `seaLevel − 0.7·depth − 0.3`, the same for every
   under-sea point. (First version chased the seabed 16 m down at an
   offshore tail and cut the whole river into a trench. Fixed; keep the
   offshore tail anyway, it is where the ribbon slips under the ocean.)
6. Running MIN from the head — a drawn river cuts a ridge, never climbs it —
   then the mouth rule, then `maxGrade` mouth-up: the reach above a
   too-steep drop is cut down to the limit, never under a lake.

Consequences worth knowing: a hollow along the route is FILLED to the bed
(bounded, 10 m) so the water is not a pond; a sill or ridge is cut into a
gorge; a lake outlet on a perched lake (most drained lakes here sit a few
metres above the plateau outside) is a short cascade where the bed leaves
the lake band.

## Steps

All commands: `pnpm -F playground worldgen <cmd> <world> --project <project>`.
Below, `W="voxel-demo --project voxel-demo"`.

1. **Know the lakes.** Read `features.lakes` from the recipe: id, `center`,
   `waterY`, `radius`, `polygon`. Look at the map:
   `worldgen map $W --plain` writes `projects/<p>/<world>-map-plain.png`
   (900 px, ~24 m/px, world origin at the centre, +z is DOWN the image).
   Read the PNG. Decide which lake should drain where — a long lowland to
   the softest coast, or into another river.
2. **Get the valley floor.** `worldgen descend $W --from-lake lake-4`
   (or `--from x,z`). It walks the hydrology's downstream chain from the
   lake to the sea, a lake or a pit and prints a table (chainage, x, z,
   ground, grade) and a `--points "…"` string. This is the corridor, not the
   river: it is on a 16 m grid and turns at right angles.
3. **Profile the corridor.** `worldgen profile $W --points "<the string>" --width 16`.
   Columns: ground, grade, `left`/`right` ground one bank width to either
   side, notes (`steep` > 2 %, `UPHILL`, `side slope` = one side much higher
   = the route is hugging a hill, `under water`, `sea`). The summary says
   how much of the length is over 2 %, on a side slope, already under water.
   You are choosing a route where the flats are long and the drops are
   short.
4. **Write the points.** Follow the corridor loosely: cut its corners, put
   the bends where the ground is flat both sides (amplitude 30–60 m, one
   bend every 200–300 m for a 15 m river), and where `side slope` flagged a
   hillside, move 20–40 m toward the LOWER side. Start the head 60–100 m
   INSIDE the lake polygon (the ribbon is cut at the lake sheet; a head at
   the shore leaves a gap). End 40–60 m past the shoreline for a sea mouth,
   or exactly ON a control point of the trunk for a tributary. Write the
   doc into `features.rivers` (a small node script is fine; keep `widths`
   and `depths` the same length as `points`).
5. **Read the solved bed.** `worldgen profile $W --river river-a`. Now the
   ground column IS the bed, `under water` shows the surface, and the last
   line prints the solved bed's head, mouth and mean grade. Look for:
   a flush head (surface ≈ `waterY − 0.15` for 60–100 m), a surface that
   only descends, `side slope` only where you meant a gorge, a mouth just
   under the sea or flush with the trunk. Adjust points and repeat.
6. **Re-run the downstream stages**: `towns`, `paths`, `pois`, `trails`, in
   that order. Until `paths` runs, a path your river crosses is a 50 m wall
   of footpath across the channel (the ford rule keeps the tread in
   water) — the audit will not flag it, your eyes will.
7. **Audit and map.** `worldgen audit $W` must exit 0: every wet reach ends
   in the sea, a lake or a river; beds never step uphill; no town or path
   point under water; every bridge has a path at both ends. Lakes with no
   river are listed as notes, not findings, in an authored world. Then
   `map --plain` again and READ it: the river should be a blue line with
   visible bends, joining lakes and coast.
8. **Screenshot it** if you can: with the dev server up, POST
   `{ "position": [x,y,z], "target": [x,y,z], "transitionMs": 0 }` to
   `/__hitreg/camera?id=<client>` (client id from `/__hitreg/context`), wait
   ~15 s for chunks, and capture. Stand on the bank at the water surface
   +6 m looking downstream, and above a lake outlet looking down the river:
   those two views show every fault listed below.

## The coast problem

Every continent in the demo world ends in a 40–50 m scarp. A river must lose
that height in its last few hundred metres, and there are only two shapes:
a slide (a water sheet tilted 20 %, which reads as a wall of water) or a
gorge (`maxGrade`: a 5 % gorge ~900 m long, walls to 40 m at the cliff, the
water fast). The default picks the gorge. Choosing the softest coast on the
landmass (profile the last 300 m of several corridors) matters more than
any other single decision.

## What a human still saw after the first three (open)

Derek's review of river-a/b/c, 2026-09-04 — fix these in the engine or route
around them, and delete each line when it is fixed:

- **Water not quite touching the banks** in places: the ribbon's edge stops
  short of the cut's waterline, so a strip of bare bed shows between the
  sheet and the bank. The ribbon width is `bed + 0.75·bank·(0.35+0.65·grow)`
  per point and the field's waterline is at 0.63 of the bank — they agree on
  paper, so look at bends (a spline's inner bank) and at reaches where
  `widths` change quickly.
- **A path running into the river and under its water near the confluence.**
  Paths are split only at rivers ≥ 6 m wide by the `paths` stage; a path
  piece that ends AT a bank without a bridge, or a path whose ford surface
  was pinned before the river was cut, does this. Check `features.bridges`
  around the spot and re-run `paths`; if it persists, the split needs to
  happen where the path meets the levee, not the ribbon.
- **The head not quite connected to the lake** on one river: the ribbon is
  cut at the lake sheet's edge and the lake's berm holds ground at
  `waterY + 0.4` outside the outline; a head that starts too close to the
  shore leaves that berm between sheet and ribbon. Start deeper inside the
  polygon (step 4) and check the outlet view (step 8).
- **The confluence looks disjointed.** The tributary arrives flush in
  height, but two ribbons overlapping at an angle draw two wave patterns
  and a hard edge. Wants: the tributary's last 1–2 widths trimmed to the
  trunk's waterline, or the two ribbons merged.

Report these to whoever asked for the river; do not paper over them with
extra points.

## Invariants (break silently)

- `widths`/`depths` must match `points` length or they are ignored.
- `width` must be the widest of `widths` (it sizes the carve's reach).
- A tributary listed BEFORE its trunk solves against bare ground and cuts a
  hole in the trunk's bed later.
- Two hand rivers crossing each other are two channels, not a confluence.
- Re-running `worldgen rivers` keeps hand rivers (no `bedY`) and rewrites
  lakes and fills: if the lakes move, your outlet may no longer be in one.
- The recipe is parsed by the schema on load: an invalid doc is rejected
  with a console warning and the world does not change. Check the dev
  server log after saving.

## Worked example (river-a, the first one)

lake-4 (`waterY` 67) to the west coast: descend said 2.6 km with a 9 m step
off the lake's lip, a 57.9 m fill, a 46.6 m fill, then 46.6 → −5 in 200 m
at the scarp. Written as 25 points: head 90 m inside the lake, bends of
±40 m on the two fills, the last two points 60 and 120 m offshore. Solved
bed 65.2 → −3.4 m; the outlet is a 7 m cascade over 50 m then a level pool;
the grade limit cut a gorge from chainage 700 to the sea. river-b (lake-8,
12 m wide) was listed after it and its last point placed on river-a's 17th
control point; its mouth solved 0.2 m under river-a's surface.
