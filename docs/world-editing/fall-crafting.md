# Crafting a waterfall site

How one solved waterfall becomes a place. Worked out on river-15's three-tier
lake cascade in the mmo world, which Derek (the owner) signed off as "way way
way better" after 12 rounds. Read `rivers-and-falls.md` for the water rules
this builds on. This doc covers only the crafting pass. Everything here is DATA plus
existing commands: **a fall-crafting pass edits no engine code.** If a check
fails because the engine is wrong, stop and report it. Don't patch around it.

## What "good" looks like

Derek's judgement, in the order he raised it:

- **The drop reads as distinct tiers.** For drops over about 30 m, use a
  cascade of 2–3 falls with level plunge pools, each tier at least 3 m.
  A cascade that reads as one drop has failed.
- **The gorge is not a straight slot.** It needs rounded plunge bowls wider
  than the channel, curved headwalls, and side walls that step back in benches
  and wander. A straight machine-cut canal is the most common complaint.
- **Walls are cliff, made of formations, not props.** Faceted DC rock masses
  fused into the wall do the job. Instanced rocks on a steep face read as "a
  field of rocks on the cliff side". Rocks go only where a rock would REST.
- **Nothing floats.** A rock or formation piece rests on the ground or on a
  bigger supported piece, or it is removed. Touching a wall is not support.
- **One colour family.** Walls, formations and scree all read as the cliff
  stone. Grey rock on a brown cliff looks pasted on.
- **Water stays in its bed.** The lake stops at its shore and at the top
  lip. The curtain is welded to the sheet above it with no seam. Its sides fade
  softly and widen toward the bottom, and it lands in white churn.
- **You can stand on it.** Collision matches what's drawn.

## Order of work

Run everything from `apps/playground`. `<river>` is the fall's river id and
`<site>` is the site id the template writes (`site-<river>-<fallIndex>`).
The world file is `projects/voxel-demo/assets/worlds/mmo.json`. **Copy it to
your scratchpad before the first edit.**

1. **Pick and read the fall.** Fall INDICES shift: crafting a site splits
   its fall into tiers, and every later index moves up. Name a fall by its river
   and foot position, and re-run `--list` before using an index.
   - `npx tsx tools/worldgen.mts fall-site mmo --project voxel-demo --list`
     lists every fall by index.
   - `... fall-site mmo --project voxel-demo --fall <i> --snapshot` gives the
     compact context: the fall's levels, flow direction and channel width, plus
     a 32×32 ground grid.
2. **Write the site.**
   - `... --fall <i> --template cascade --tiers <n> --rocks 0`.
   - Tiers: 2 for drops of 20–35 m, 3 for drops of 35–60 m. Over 60 m,
     consider 3 with uneven shares, the biggest drop last.
   - `--rocks 0` because hand-placed rocks are the floating-rock source.
3. **Set the dressing blocks** on that site in mmo.json:
   ```json
   "walls": { "rule": "<the biome's rock scatter rule>" },
   "formations": { "wallSurface": "cliff", "accentSurface": "" }
   ```
   - `gorge` is on by default; leave it out unless tuning.
   - `walls` is scree only: it rests on terrain, never on steep faces.
   - `accentSurface: ""` keeps one colour family. A `rock` accent paints pale
     grey patches on formation tops.
   - `walls.reach` (default 40 m) is how far from the channel scree may go.
     Drop it to about 30 if a rock lands on the plateau above the rim.
   - Use only a rock rule the local biome already scatters. Find it in the
     recipe's scatter rules. The snapshot prints the fall's biome. A forest site uses `rock-medium`; sandstone looks wrong
     there.
4. **Optional: course.** If the channel runs dead straight through the span,
   add `course: [[x,z],…]`. It is a redrawn centreline spliced into the river,
   8–10 points about 8 m apart, bending a few metres side to side.
   **Both ends must sit within 1.5 × width + 10 m of an existing river
   VERTEX** (`spliceCourses` in field.ts). Otherwise the course is silently
   ignored. River vertices can be about 90 m apart, so start and end the
   course on actual vertices. The bake prints the tier count: if it says fewer
   tiers than the site has, the course or the tiers did not take.
   **Use a course on almost every site.** Without one the gorge is a
   dead-straight slot, the most common failure.
5. **Bake the formations:**
   `npx tsx tools/rock-formations.mts voxel-demo mmo <site> --scene mmo`.
   - It writes the volume doc, a baked GLB and the scene entity, and drops
     any piece that fails the support checks.
   - **Re-run it after ANY change** to tiers, gorge, course or formations.
     It measures the gorge it sits in.
6. **Audit:** `npx tsx tools/_site-audit.mts <river> <site>`. All checks must pass:

   | Check | Tests | Usual fix |
   |---|---|---|
   | a water bounds | lake/pool water past a lip or hanging over ground | engine: report it |
   | b rocks | scree unsupported / over the rim / buried | lower `walls.reach`; check the rule |
   | c wall cover | steep wall faces still soil, not stone | re-bake formations; raise `gorge.slope` a little |
   | d lip shards | flat water hovering near a lip | engine: report it |
   | e tiers/pools | tier drops ≥ 3 m, pools ≥ 40 m² | adjust tier `share` / `pool` |
   | f formations | open mesh edges, unsupported pieces | re-bake; if it persists, report it |
7. **Look.**
   - Start your own dev server:
     `npx vite --port <52xx> --force --strictPort`.
     Check the port is free first, and never use 5173 or 5199. The running
     server's terrain worker serves stale core code, so you'd be shooting old
     code.
   - Then run `node tools/_fall-site-shots.mjs http://localhost:<port>/ <scratch>/shots/r1 <river>`.
   - Read `sheet.png` (7 views in one image), then open single views only when
     you need detail. Kill the server when you're done.
8. **Loop until the completion gate passes.** Nobody reviews each fall by hand.
   A world build crafts every fall unattended, so the agent is its own
   reviewer. After each look round, answer the gate below from the sheet. If
   anything fails, change the knob group that fixes it, then go back to step 5.

### Completion gate (all must hold)

- **Audit:** every check a–f is PASS.
- **Tiers** (1-front, 7-hero): each tier reads as its own fall with a level
  pool between.
- **Gorge** (4-above, 1-front): no straight run longer than about 25 m.
  Walls step and wander.
- **Bowls** (4-above): each plunge pool is visibly wider than the channel
  above it.
- **Walls** (1-front, 3-right, 7-hero): the steep faces read as cliff and
  formations, not bare smooth soil and not a field of props.
- **Colour** (any view): no pale or grey patches on the brown cliff; scree
  matches the cliff.
- **Nothing floating** (6-pool-eye, 7-hero): no rock or mesh piece with sky
  or air under it.
- **Water** (5-from-lake, 1-front): the lake ends at its shore, and each
  curtain meets the sheet above without a seam.

**Safety net:** stop after 8 look rounds, or sooner if two rounds in a row
change nothing on the gate. Record the fall as **blocked**, with the failing
gate items and why data can't fix them (for example, bowl width capped by the
water reach is an engine issue). Never call a fall done with a gate item
failing.

### Result record

When done or blocked, append one JSON line to
`projects/voxel-demo/authoring/falls-log.jsonl` (create it if it does not exist):

```json
{"site": "...", "river": "...", "fall": 18, "status": "done | blocked", "rounds": 3,
 "audit": {"a": true, "b": true, "c": true, "d": true, "e": true, "f": true},
 "gate": {"tiers": true, "gorge": true, "bowls": false, "walls": true, "colour": true, "floating": true, "water": true},
 "blockers": ["..."], "sheet": "<path>", "tokens": "<rough count>"}
```

A world build reads this log to know which falls are finished and which are
blocked on engine work.

## Knobs (the full schema is in `voxel/fall-sites.ts` and `spec.json`)

- **`tiers[{share, pool}]`:** how the drop splits into falls and pools. Shares
  are normalised.
- **`gorge`:**
  - `bowl`: pool width ×channel.
  - `step` and `slope`: the wall benches.
  - `wander` and `wavelength`: how far and how often the wall wanders.
  - `curve`: headwall curvature. Smaller opens the pool sides.
  - `reach`: how far out from the channel the gorge extends. Defaults are the
    signed-off look.
- **`walls`:** `reach` (distance from the channel, default 40 m), `max`
  (scree count, default 90) and `scale` [min, max].
- **`formations`:**
  - `spacing`: buttress spacing, default 8 m.
  - `scale`: default 1.
  - `margin`: clearance off the water, default 1.5 m.
  - `seed`: a different, equally valid set.
  - `wallSurface` and `accentSurface`: which surfaces paint the faces.

## Pitfalls that cost rounds on the first site

- **Hand blobs and hand rocks:** small `features.blobs` (3–4 m) can't reshape
  a 50 m gorge. Once the gorge is recut they become floating pillars. Don't add
  site blobs, and don't use `rocks` or `lift`.
- **Scale caps:** big half-buried masses are what a cliff needs. Don't shrink
  everything to hide texture stretch. Formations handle the big scale.
- **Contact metrics:** "within 0.3 m of the ground" passes a rock glued to a
  vertical face. The audit measures SUPPORT. Trust it over your eye for
  floating, and trust your eye over it for "looks like a field of props".
- **Stale renders:** always use a fresh server. Vite HMR can reload the page
  mid-shoot; the shot script stubs it out and re-takes views.
- **Missing collision on the server:** the dedicated server now reads GLB
  collision (`@hitreg/physics` `gltfCollisionGeometry`). A player standing on
  formations needs a restarted server.
- **Paths:** a path crossing the site was solved against the single fall.
  Re-run the worldgen `paths` stage if one crosses the new cascade.
- **The judge:** one model's score is noisy. Near-identical frames scored 4,
  then 3. The audit is the gate; the sheet is for taste.

## Budget

The first site built the tools, so its cost says nothing about later sites.
A later site should take one template, one bake, an audit and 1–3 look
rounds. First measured run (fall 18, river-13, 54 m, a cold agent with only
this doc): about 114k tokens, 3 look rounds, all checks passing. Second run
(river-12, 45 m, under the completion gate): about 103k tokens, 2 rounds, done. Report your token use at the end, so the budget can be set from
real runs.
