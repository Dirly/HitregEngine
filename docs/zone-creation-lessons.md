# Zone creation: raw lessons log

**This is the raw evidence log only, kept for reference. Do not add new rules here.** A new lesson goes straight into
the task skill that owns it (`.claude/skills/<name>/SKILL.md`: Gates or Judgment) or into a check in its tool; a rule
nobody can check yet goes on the one list, `docs/world-standards/README.md` "Not encoded yet". Index of the skills:
`docs/world-standards/README.md`. Entries below name places; skills never do.

## Ironspur Shore (proving zone-3), 2026-10-05

1. **Generated landmarks can be unreachable.** The cast premise put giants and a watchtower on the Ironspur massif
   (500 m, 80-90 m drops); the designer had to move them. Change: the cast/brief stage should check a premise's
   landmarks against walkable ground (a reach check from the road graph) before a story is written around them.
   Where: cast brief + brief lint.
2. **Nobody measured spread.** The first design left 31% of the zone's land >400 m from any place; the budget was
   padded with dungeon doors and a boundary stone counted as small places. Change: a spread gate in the reserve lint
   (share of land beyond N m from any place, worst point) and pinpoints never count toward small places.
3. **Reservations missed their own features.** Hrimgard's circle left out its strand, its dungeon door and a pool
   that had no water within 400 m. Change: reserve lint checks each place's features/approach points sit inside its
   terrain radius, and a feature that names water must find water (or be declared terrain work).
4. **Places need routes, not approach points.** Three west places had no trail; a landmark seen from no road fails
   Z6. Change: a place without a road/trail within reach must declare the trail to cut as a location need; the map
   gate draws it.
5. **Dungeon doors need rock.** The Keel Gate sat on a 40 m crest, too thin for a door deep in a real passage.
   Change: reserve lint measures solid ground behind a dungeon entrance (depth along its facing).
6. **"Unique" was claimed loosely.** Three "only X" claims were broken by other places. The brief lint only compares
   exact text. Change: the reviewer's Z2 is the real check; consider a keyword overlap warning.
7. **Creature scale vs the player.** Ratkin tunnels at 1.6 m fail a 1.8 m player. Rule: route tunnels >= 2.2 m (kit
   cell 3.2 m preferred); creature-size holes are dressing only. Where: dungeon-standards + site-standards.
8. **Capital residents vs performance.** Planned 63 residents; Tidewell's 25 already halved the frame rate. Coordinator
   capped skinned residents at 25 (provisional, owner to rule); the town lint DEMANDS 60-250 for a capital, so the
   designer split residents into `body: skinned | ambient`. Change: the lint should count skinned bodies against a
   performance budget and accept ambient entries.
9. **Shared files stale other zones.** Adding giants to bestiary.json and the zone-3 cast row staled zone-5's freeze
   (whole-file hashes). Change: digest only the zone's slice (cast row + neighbours; catalogue entries the zone uses).
   Being done in tools/zonegen/lib.mts.
10. **The reserve lint refuses overlap even within one place** (a dungeon door inside its own place). Change: allow
    locations with `place` set to overlap their place.
11. **The return loop works and is cheap.** Review ~85k, fixes ~70k, versus a full re-plan. Keep reviews before the
    freeze.
12. **Making a folder before init hides the init hint.** A coordinator creating `zones/<z>/` (for RUN.md) makes status
    skip `zonegen init`. Change: status checks for brief.json, not the folder.

## The Broad Shelf (zone-5) review via the map, 2026-10-05

13. **The map exposed what reports did not.** The central plateau (~1.5 km) holds nothing; ~200 wildlife circles
    carpet the shelf instead of designed packs. Lesson: the review map (`zonegen map --dev`) belongs in every
    reviewer's inputs (DONE: docs/zone-creation.md, "The reviewer").
14. **Trails nobody owns.** After the fix the west of zone-3 hangs on two tracks to be cut (Aqueduct ~700 m, Strand
    ~1.8 km), and the Strand Track lives only as a `needs` line inside one location. Change: a route a place depends on
    is its own plan row with an owner and a gate (trail cut + walk), not a need. Where: quest graph / reserve + status.
15. **A plan flag no tool reads.** Greyharbour's `body: skinned|ambient` split meets the cap on paper, but town-npcs.mts
    builds a skinned body for every resident. Change: town-npcs skips ambient residents (or the lint refuses more
    skinned than the budget), and one rule for capital size replaces the 60-250 band vs the doc's 10-15.
16. **Second review was cheap** (~25k): a reviewer resumed with its own context re-checks fast. Resume, do not respawn.

## Ironspur Shore look phase

- The recipe has no per-region scatter/cover override: "dead pines / bare spoil" place moods cannot be applied as data today (scatter and cover gate on biome and surface only). Either add a region gate to scatter/cover or stop writing cover asks into look-plans.
- A palette's `accent` replaces the base `sand` surface, so in a coastal zone the accent tile IS the beach. Pick the accent with that in mind (Ironspur's is grey shingle + black spoil grit, which also serves the spoil places).
- A nested place region needs ALL six ground roles if it sets `ground` at all: a role it leaves out falls back to the base palette, not to its parent zone. A place region under ~150 m radius cannot show its own ground anyway (the zone-ground band is 150 m).
- Place regions are real regions to the server (`regionAt` prefers nested): zone chat, `zoneAt` hosting and spawn-area border bands will see e.g. `gnawspur-warren` as a zone. `worldgen zones --towns-only` also drops every nested region that is not a town. Check both before installing place moods world-wide.
- `gen-set` de-duplicates refs across the whole set, so per-image refs that differ renumber "FIRST/SECOND attached". Give every image in a set the same refs. Six ground tiles: one session, 344 s.

## Coordinator notes, look install (2026-10-05)
- **Place moods as nested regions made each place a hosting zone.** The server places layers, zone chat and spawn
  bands by `regionAt`, so a place region would have handed a player to another host at the warren's edge. DONE:
  `regionAt` skips regions tagged `place` unless `{ places: true }` (packages/core/src/voxel/regions.ts, test in
  regions.test.ts); the playground's `ctx.regionAt` reports a place's name + mood with its ZONE's tags; the audit no
  longer flags place regions as too small / townless.
- **`worldgen zones --towns-only` deleted every nested non-town region**, place moods included. DONE: it keeps `place` regions.
- **No per-region scatter/cover override exists**, so "dead pines" / "bare spoil" place moods cannot be data yet.
  Engine gap for site moods (sites.md OPEN line).

## Gnawspur (grey box)

17. **A gravity aqueduct from the lowest water in a basin cannot cross the rim.** The design put an aqueduct head on a tarn
    (61 m) behind a 104 m saddle and asked for Arches "over a dip" with the landmark in view. Change: the design/reserve
    lint should profile a conduit/route a place depends on (source level vs every crossing) before the freeze.
18. **Track length was a guess.** "About 700 m" became ~1.6 km once a 14% grade cap met a 20 m -> 100 m climb. Change:
    the reserve stage measures a declared trail with the same grade-capped A* the owner will use.
19. **A 250k grey-box cap does not cover a large place plus a 1.6 km trail plus a walk + pictures.** Survey and tooling
    reuse took ~half; the walk/picture fix loop did not fit. Change: budget large-place grey boxes at ~400k (as phase 3
    says) or hand the trail to its own small owner.
20. **Reuse the previous owner's harness, but its routes are the cost.** Copying the-undercut's build/walk/audit/plan
    scripts saved most tooling; real-body routes must avoid channels, stair sides and low colliders (conduit slabs > 0.4 m
    block autostep). Grey-box dressing slabs should be collide:false.

## Shelf finish (2026-10-05)
- **The art manifest cried wolf**: 84 "missing" became 16 once it checked scenes, POI jobs and dungeon builds. A gate
  that over-reports gets ignored. DONE (commands/manifest.mts).
- **Proofs rot when the engine moves** (loot bags, NPC dormancy broke the barrow fight proof and quest-play). Proof
  tools need tests of their own, or a smoke run after engine changes.
- **Two story systems overlap**: `worldgen status` wants a zone story doc per zone (`worldgen story`) while zonegen's
  brief already holds the zone's story. Pick one, or have the brief generate the story doc.
- **Exterior shots framed the beach, not the quay**; the agent then reported the quay missing though it exists. A
  picture is evidence only with its camera position stated; check the scene before believing a "missing" from a shot.

## Gnawspur Deeps (grey box)
- **Copying the Fieldfast Barrow toolchain works**: sed the name through bake/dc-bake/import/split-floor/materials/prove,
  keep build.py's pwall/run/room, write the plan and a lean plan-check. A whole grey box went plan -> walk in one session.
- **A wading pool deeper than autostep (0.4 m) is a trap**: the body waded in and could not climb out. Every pool needs
  stepped ledges round its rim (two of ~0.27 m), and a mound or dais needs tiers of <= 0.3 m (DC rounds up to 0.12 m).
- **A walk leg cuts corners**: a waypoint just past a side door aims the body at the jamb. Put a waypoint on the door's
  own axis inside the room before turning (the blender-dc rule "enter and leave a doorway along its axis" holds for routes).
- **Footprint overlap is the cheap check for "no fight over a floor"**: plan-check fails any two space interiors that
  overlap by more than a wall's depth; doing it on the plan saves a bake per mistake.
- **Group cell budgets are bounding boxes**: an L-shaped group of distant rooms blows 15 M cells; split by region and
  join with the room-owns-the-doorway rule (passage cavity 0.25 m wider each side, 0.2 m taller, floor 1 cm lower).

## Hrimgard (grey box)

21. **The reserved Rime Door had no rock behind its reserved facing.** At (2290,-2170) facing west the ground stands only 5-10 m over a
    giant-height floor for 80 m; the massif rises 45 m north of the point. Built the cleft + passage into the arm's north wall at
    (2292,-2203..-2262), 33 m from the reserved centre, portal under ~15-40 m of rock. Change: the reserve lint should profile cover
    along the declared door facing for the creature's door height (lesson 5 again, now with a size), before the freeze.
22. **No way to clear vegetation from a site.** Scatter/cover only keep off rivers, roads, lakes, towns and additive blobs; a hall
    pad, a quarry pit and a cleft all grew maples (one blocked the walk inside the cleft). Stopgap: additive blobs buried >= 20 m
    under the ground (no surface change) as clearings, labelled in world-ops. Change: a real `clearings` feature (polygon, thins or
    clears scatter + cover) - it is also the missing "few wind-bent pines" place-mood override (sites.md OPEN line).
23. **Walk legs cascade.** One blocked straight leg puts every later straight leg in the wrong place (one stake on the drag line
    failed 2 legs, a rock in the hall 5). Put props and stakes off the route lines, run the walk per section (--only) while fixing,
    and print what a crawling (not stuck) body touches.
24. **Giant scale on a sloping corrie needs terrain first.** The hall pad (78 x 26 m) cut 6 m on one side; the strand had to be a
    graded cove (the shore was a 50 % bank) and the boat drag a 23 % cutting. Survey the slopes of every feature footprint at the
    creature's scale before placing the landmark.

## Coordinator, picture review (2026-10-05)
- **Pictures arrive badly framed** (camera behind a mound looking at sky; camera inside geometry; "quay" shot of the
  beach next to the quay). Every owner hit this. Change: a shared shot tool that places the camera from a target +
  standoff, ray-checks that the target is visible and not occluded, and refuses a frame that is mostly sky or solid.
- **Palm trees in Tidewell** on a dark northern shore: the foliage biome rules pick palms by climate, not by the zone's
  look. Change: the zone palette/mood should constrain scatter species (cast palette -> allowed tree set).
- **Shots in edit mode show residents undressed.** Review shots are taken in play mode.
- **Dungeon grey boxes render near black**, so a reviewer cannot judge them. Change: grey-box views use a flat
  review light (or ambient lift) separate from the shipped light bucket.

## Gnawspur Deeps review (coordinator, 2026-10-05)
- **A dungeon builder defaults to the last dungeon's shape.** Rectangles + straight corridors came out again for a
  "gnawed warren". Change: the dungeon brief states the plan SHAPE language per theme (warren: winding runs of varying
  width, necks, side burrows, irregular rooms, several cross-links) and the reviewer compares the plan picture with the
  neighbours' plans first.
- **Builders' counts drift** (127 claimed, 116 real; "patrols" that wander 5 m). Counts in reports come from a tool,
  not the builder's tally; a patrol is a route of >= N m between named points.

## Foliage overrides
- **Zone borders drawn along the waterline leave the beach in no zone**, so a zone's vegetation (and mood) stops at
  the sand: Tidewell's palms stood 0-40 m outside zone-5. Region vegetation has a `margin`; use ~80 m on coastal zones.
- **Species are swapped, not allowed in**: `allow` only filters what the biome already grows. A northern beach keeps
  trees by `replace: { palm: pine }` at a lower rate; a dead wood is `replace: { pine: dead-dried-tree }`.
21. **Long flat stair boxes snag the body.** A Rat-Run climbing 9 m over 70 m (0.4 m steps every 2.9 m) stopped the real
    body dead with nothing in the horizontal rays; 1.4 m treads walked. Same for a 20-box roof stair (0.37 m risers):
    one 36 deg ramp box walked. Rule: passage stairs <= ~1.4 m treads; built stairs as one ramp collider.
22. **The 2 m lattice rounds a steep cut lip UP** (~1.2 m over the floor at the gully edge): a bridge deck flush with the
    floor still met a wall. Carve each bridge landing flat with a short roofless passage box; set the deck flush (-2 cm).
23. **A run deep under a 48 m border can be closed in the mesh while the field is open** (fit audit clean, collider wall
    at 0.45 m). Keep runs and their exits inside one cell where possible; prove every run with the real body.
24. **Scatter stands on cut tiers and ramps** (a boulder blocked the gate ramp, a pine the sluice-house corner).
    flatten-0 "worn path" roads along every route and yard keep them off and paint the tread.
- **Return #1: a copied toolchain copies the layout grammar too.** Rectangles + straight one-width runs read as the
  Barrow whatever the theme. A warren needs its own primitives: polygon caves and centreline burrows (varying width,
  necks, dead ends, a cross-link). Decide the grammar before the first export, not after the review.
- **Mitered burrows twist at bends**: a piece shorter than (half width + wall) x tan(turn/2) at a bend folds into a
  self-intersecting solid that Blender's closure check passes and the mesh-dc importer refuses. Lint the path first
  (`authoring/burrow-lint.cjs`); cut steps as separate tread solids so stairs may run round bends.
- **Grey-box pictures need a review exposure**: shipped light makes basalt rooms near black and the reviewer cannot judge
  set pieces. Build a `-review` scene variant (flat ambient, no creatures but the boss) and shoot that.

## Coordinator, Gnawspur grey box (2026-10-05)
- **ENGINE BUG to fix: collider wall at a 48 m chunk border inside an open passage** (the field says open, the
  real body stops). The Gnawspur run was rerouted to stay inside one cell. Render/physics/placement source
  invariants in docs/voxel-worlds.md need a test for passages crossing chunk borders.
- **Long flat treads (0.4 m steps every 2.9 m) stop the real body** where a clearance check says open; stairs in
  carved runs need short treads (~1.4 m) or ramps. Belongs in the passage-carving tool, not in each owner's head.
- **Pathfinder-held grades make sawtooth trails** that walk but look machine-made. A trail tool should lay deliberate
  switchbacks.
- **DONE (coordinator): mob steering under low ceilings.** Probes started 3 m above the feet, inside any lower roof,
  so mobs refused 2.7 m necks. Now the step probe starts just above the highest climbable rise and the own-floor probe
  1.2 m up (packages/scripting/src/steering.ts, mob-brain.ts; test "under a low ceiling").
25. **Detail pass: clearings must cover every walked ramp, not just the structures.** Swapping the buried blobs for
    `features.clearings` (canopy-footprint rule, no rule clearance) let a rock-big back onto the haul-way and failed 24
    cascading legs. List each walked route as a clearing (or a polygon along it) when converting.
26. **A catalogue prop can roof a giant hall.** 307 keel-up `gull-strand/small-boat` instances (1.0-1.25x so texels stay
    >= 32/m, 4 shingled courses, hash-jittered yaw, a few missing or broken) read as stolen boats where 84 grey boxes read
    as tin seams. Scale is capped by the texel floor, so size the courses to the prop, not the prop to the roof.
27. **Shipped light hides north faces.** A scratch-only `-review` scene (ambient up, zone-mood strength down) helped
    little against the zone light; the dark side of a log hall still reads near black. Frame review shots on lit faces
    or add a real review-exposure switch to town-shots.

## Hrimgard rejected by the owner (2026-10-05) — the most important lesson so far
- **Owner's verdict on the installed Hrimgard: "none of this is acceptable and doesn't match any of the other stuff
  we have made."** Spheres as a boulder line, a box "cauldron", a pond of square blocks, brick-textured boxes as
  quarry benches, a roof of 307 boats ("kinda dumb... a ton of assets unnecessary"). Uninstalled.
- **Cause 1: built from raw primitives.** The owner skipped the methods that made earlier work good (building kit,
  Blender->DC structures, catalogue props wrapped/variant/composed, terrain for land). RULE: nothing visible may be a
  raw primitive; primitives only as hidden colliders.
- **Cause 2: the design was a checklist.** Every line of the place (hall, quarry, whale camp, boulder line, pool,
  cages, door) became an object. RULE: one strong idea per place, executed well; cut anything that only ticks a line.
- **Cause 3: reviews judged against the design, never against our own best work.** RULE: every review shows the
  work side by side with the owner-approved references (Fieldfast Barrow, Fieldfast Hall estate, Old Watch) and
  fails anything below them.
- **Cause 4: I installed before the final review.** RULE: nothing installs before the final quality review passes.
- **Owner on giants: "giants in this are dumb, give them a giant tent or something, bone pits and caves."** Over-
  designed lore (boat roofs, tally-masts, whale camps) is not wanted; simple, readable, strong places are.

## Gnawspur (detail pass)

25. **Raw primitives are not a detail pass.** A full primitive build (stone box house, box Arches, plank boxes, keel
    struts) was purged on the owner's Hrimgard verdict. Brief owners at the start: kit for houses, Blender->DC for
    crafted stone/timber, catalogue props by name, primitives only as hidden colliders; compare against the bar's sheets
    BEFORE building.
26. **The dev server caches world/scene files**: shots after a recipe change showed the old terrain until vite was
    restarted. Restart (or add a cache-bust) before every picture run.
27. **town-shots cannot show the honeycomb**: editor mode runs no day-night script (time is fixed), and a flat ambient
    lights the inside of recesses like the face. A play-mode shot tool with time of day is needed for faces in shade.
28. **No dark palette tile**: zone-3's darkest tile (accent, rgb ~55) reads tan in sun, so "black spoil" cannot be
    painted. A zone needs a spoil/char tile if a place's read depends on black ground.
29. **applyRecipeEdits has no `clearings` kind**: clearings go in a clearings.json installed with
    `worldgen vegetation --clearings` (and removed with `--remove-clearings <owner>`).

## Coordinator, Gnawspur purge (2026-10-05)
- **The shot tool shoots in edit mode with no time of day**, so faces in shade and hole interiors cannot be judged;
  every owner fought it. Build a play-mode shot tool (time of day, exposure, target-visible check) before the next
  zone. Also: the dev server serves stale world/scene files until restarted.
- **An owner past ~400k context should hand off** to a fresh agent with its handoff.json rather than be resumed again.

## Hrimgard v2
- **`ruin-props/boulder` is two primitive spheres**, so a "catalogue" cairn of boulders is still the sphere look the owner rejected. Rocks come from the world's own scatter models (`mmo/nature/GranitRock*.gltf`) through `props compose` (`composite-props/stone-cairn`). The menu should flag primitive-built props.
- **`poi-props/tent`'s door is on its local +X, not +Z** (fowlers-hide turns +Z to the fire). The first walk failed walking "through the door" into a wall. Record the door axis in the tent's declaration, as a socket or a `faces` field.
- **Detail: boss mechanics are engine builtins, the dungeon is data.** `encounter-waves` (packages/scripting) decides
  the waves; scripts cannot spawn, so it asks with `npc.spawn`/`npc.despawn` events that NpcManager answers. Patrols
  are `spawnArea.patrol` + mob-brain `patrol` (leash from the nearest route point). Both are generic and tested.
- **A grey box's set-piece boxes do not survive the detail bar.** Plan set pieces as crafted DC pieces from the start
  (lathe profiles with seeded noise for heaps/bells/plugs, curved timbers for stems and frames) and catalogue props
  (`props menu --search <one word>`: the search takes one term, not a regex).
- **Floor placements by point fight the socket map** (heaps become "stairs", lanes are reserved); resolve plans with a
  check-and-retry loop (`authoring/dress-fix.mjs`: refused point -> auto open -> drop) instead of hand-nudging.
- **A chase test must sit inside the pack's leash**: chasers stop at their leash or at attack range, so stand the player
  just past the neck and inside the leash, and count a chaser under the neck as a pass.
- **Scaling a small prop up 8x does not make a giant one**: the catalogue tent became a quilted box with tiled hides. A giant landmark needs its own silhouette (poles past a smoke hole, sag between poles, ragged hem, guy ropes). Modelling it in Blender headless (`authoring/giant-camp/blender/build_giant_camp.py`) and composing the GLBs took one pass. Map the UVs at 40 texels/m in metres (one 512x1024 sheet = 12.8 x 25.6 m), or `props status` flags HIGH.
- **Shot time drifts**: a play-mode run of 8 views takes about 1.3 game hours, so a "17:00" set ends at dusk. Start readable sets near 11:00, and pin the weather with the `weather` script's `force: clear` in the scratch scene only.

## Gnawspur crafted pieces
- **The kit's `wall_stair` gives a small stone building a walkable roof** (5x3, 1 storey, flat, battlements: 8 s solve), but its foot is solved for a 0.3 m plinth: set on a flat pad the first tread is a 0.5 m lip the body cannot step. Walk every kit stair from the real ground and bridge the lip with a hidden wedge on the stair's own slope.
- **Never give a plank deck a trimesh collider**: jittered/gnawed plank edges snagged the body one way only; draw the planks, walk a hidden box. Play-mode shots need `dayLength` stretched in the scratch scene (7200 s/day turned noon into night over ten shots) and the rig's pitch is + = down; `crafted/play-shots.mjs` in the Gnawspur job folder does play mode with a fresh vite.
- **A terrain-only feature can be invisible at distance**: 34 blind 3 m holes in dark rock vanished beyond a few tens
  of metres even in clear light. The defining read of a place needs contrast (frames, pale spoil, light) and must be
  proven by a clear-weather shot from its stated viewpoint BEFORE detail work. Add a "read shot" to the grey-box gate.
- **Back-wall mouths never read from below**: on contour tiers each lip hides the back wall above it, so enlarging, framing, spoil and lit mouths only read up close. A honeycomb meant to be seen from below needs its mouths on the faces the viewer actually sees. Check sun access over the field first: a western ridge shaded the whole Brow from 15:30 onward.

## Coordinator, Gnawspur loop count (2026-10-05)
- **The Gnawspur took six passes** (grey box, walk fix, detail, purge, crafted pieces, two read fixes) because its one
  defining read was never tested from the viewer's position until the end. A place's read shot (from its stated
  viewpoint, the right hour, clear weather) belongs in the GREY BOX gate; terrain features are placed on faces a
  viewer below can actually see (sight-line check from the viewpoint), not where the cut is easiest.
- **Cap the loop**: after the second failed read fix, the coordinator decides: install with the fault logged, or cut
  the feature. Do not keep paying for the same idea.

## Hrimgard v3
- **`props compose` applies yaw before roll**, so an upright log (roll 90) given a yaw for variety leans 20-30 degrees; uprights take roll only. A horizontal bar above eye level also reads as a leaning beam in a low shot: judge frames from the side they face.
- **Hide cards cut from the landmark's own texture (alpha outline, 40 texels/m) made frames, windbreaks and a re-skinned tent match the tents in one pass**, but at zone light they read black until brightened (scraped hides are paler) and given the tent material's emissive lift; check card materials in a play-mode shot, not the proof render (which shows them grey).

## Gnawspur front mouths
- **A mouth only reads from below if it is lit**: 8 framed holes cut into the sight-lined riser fronts still vanish dark-on-dark in shaded west faces at the one sunlit hour; the single lit one reads from the towpath. Budget lights (or a pale frame/spoil that catches sun) per mouth you need seen, not more holes.
- **Pick mouth spots with a gated search, not by eye** (crafted/brow-c3.mts: sight line from each viewpoint, 6 m cover, both-axis 48 m border check, passage clearance, walked-leg clearance): of ~3,400 candidates only ~50 survived; the gentle T1 face had none (15 m high, 30 deg: no room for a 5 m hole plus 6 m rock).

## Rime Hall (grey box)
- **Giant scale needs a coarser DC voxel.** Giant halls (30 x 48 x 15 m, a 52 m throne hall 22 m high) at the warren's 0.12 m blow the
  15 M cell budget per group; at 0.2 m the whole dungeon is ~70 M cells in 10 groups (largest 13.7 M, the lake + pool). The plan's
  `voxelSize` drives build/import/bake; keep every planned plane on the 0.1 m grid with the 0.05 m grid offset (odd multiples of
  0.05 never land on a 0.2 lattice node).
- **At 0.2 m, steps are a trap: build ramps.** A 0.25 m riser rounds to 0.2 / 0.4 on the lattice (0.4 = the autostep limit). Burrows got
  a `ramp: true` mode (one sloped floor solid per 1.5 m sample, linear `floorProfile`) and caves `ramps` (one sloped solid) and
  `tiers` (ledges, dais rings of 0.3 m); plan-check fails a ramp over 20 %. A ramp solid whose low end meets the floor must start
  below the floor (zero-height edge = degenerate triangle in the closure check).
- **A hub of octagons is the next default shape.** Even with "few, huge spaces" in the brief, three side rooms off one hearth came out
  as equal bubbles. The gallery (kinked, ledged, 90 m) and the lake read; the timber halls need one dominant hall, not three peers.
- **Niches are data shared by geometry and population.** plan.cjs computes niche centres once (`nicheList`); build.py cuts them,
  build-scene stands a statue in each, and the boss's wave mouths are the throne hall's niches 2.6 m inward, so "the frozen ancestors
  crack and step out" is encounter-waves data, no new engine code.
- **statue-maker needs the source models under `--assets/models/`** (`mmo/human-body|head|hair|shoulder|helm.glb`) and the material
  in the same root: build in a scratch root (copies), then copy `models/` + `prefabs/` into the dungeon project.
- **split-floor's ceiling window (1.8-16 m) dropped giant floors to WORLD**: the lake (18 m) and throne hall (22 m) came out with
  ~120 m2 of TERRAIN floor. Widened to 26 m in the rime-hall copy; the shared rule should read the plan's tallest space.
- **A statue in the same ice as its niche is invisible** even under review light. The frozen dead need contrast (grey hoarfrost bodies
  in blue ice); a translucent ice skin is a detail-pass layer, not the grey-box material.
- **A door placed exactly on a polygon vertex cuts only one edge** and the walk stuck there; plan-check should refuse a cave door
  within half its width of a vertex.
- **The generated glacier-ice tile reads as rippling water at 3.2 m** on 15-20 m walls (loud, high-contrast streaks). Ice walls
  want a quieter, darker tile (or two: wall ice and floor ice) in the detail pass.

## Coordinator, Rime Hall grey box (2026-10-05)
- **Generated tiles can wreck the look**: a "glacier ice" tile came out as bright cartoon water ripples on 20 m walls.
  A tile intended for large surfaces gets a contact check at room scale (one test wall) before a whole dungeon is
  skinned with it; the house look (dark, low contrast) goes into every tile prompt.
- **Builders repeat a shape they found convenient** (rectangles, then octagons). The plan check should flag repeated
  outlines (same vertex count and proportions) across halls.

## Rime Hall rework
- **A material theme is a ratio, not a wall role.** "Ice dungeon" became frost-rock walls with dark ice only in `bands` (strata per
  space, cave and burrow walls sliced by z), ice lumps at the wall foot and proud ice frames round each niche of the dead; one quiet
  dark tile (prompt says "low contrast, no ripples, no parallel bands") read cold under flat review light where 20 m of the v1 tile read as a pool.
- **Set-piece blocks stand on the floor, not on the dais ring they happen to cross**, and a walked route must be re-walked after
  dressing a dais: two flanking standing stones put 1 m off the children's-door path stuck the real body (105/110 legs) until moved out.

## Greyharbour (shell)
- **A capital does not fit a 78 m town radius on a 60 m shelf.** 32 kit buildings at gothic-stone sizes (envelopes
  20-34 m with eaves and steps, the church 48 m deep) need ~1 km of street frontage on buildable ground; the shelf above
  the cove held 24 after four layouts. Change: the town design stage measures buildable area (slope < ~20 % inside the
  wall line) against the sum of the planned envelopes BEFORE the freeze, and sizes the program (or the wall) to it.
  Where: zonegen town lint (it knows the plan's requests; envelopes per style type can be tabled).
- **The image generator rescales a crowded key off its registration.** Asked for full-size pads it drew the same town
  1.2-1.3x larger around the centre (gates moved 50-90 px, the quay band in the sea); the first key drew pads at half
  size. A key whose content must sit on fixed gates is cheaper drawn from data: `greyharbour-ground/draw-key.mjs`
  (streets/square/quay/sites/pad markers in world metres + `near:x,z` lot roles, new rule in `_town-ground.mts`).
  Change: make draw-key a `town-ground draw` command; keep the generator for loose villages.
- **Tool fixes made on the way** (tools/town-ground.mts, _town-ground.mts): export crashed on a 360 m site
  (`Math.min(...h)` stack overflow); two roads cut at one gate made two gates (deduped); `request --timeout` passthrough
  (the codex key run hit 900 s); lot roles `farthest-gate` and `near:x,z`; `TOWN_GROUND_SKIP=1` lets a dry build skip
  unplaceable lots and print the map instead of stopping at the first.
- **Reroute cutAt must be within 1 m of an existing road point** or the reroute silently does nothing (the map still
  drew the whole loop). Change: `reroute` should throw when no point is near `cutAt`.
- **Old town roads survive the ground build**: it removes `-stair-/-lane-/-street-` but not `town-3-ramp-*`, which then
  blocks lots in town-layout. Change: remove every `<townId>-` road except its door paths. A peak trail looping
  through the town (trail-peak-10) also blocks lots: list world roads crossing the site at `export`.
- **town-ground build and town-layout disagree on two lots** (counting-house put on the harbour slope at y 7.9 because
  its nearest street front was the harbour street; the church moved off its pad). The ground build should reject a
  front whose pad spread exceeds what town-layout accepts, so a passing build never yields a failing layout.
- **watch-barracks with `arrow_slits` floats fill walls** in gothic-stone on 7x5 and 6x5 steep blocks (3 tries): an
  arrow-slit rule gap in the kit, not a request problem.
- **The town master cap does not cover a capital.** Buildings (~110k) and residents (~157k) went to workers; the
  master's own ~275k went on survey, four layouts, tool fixes and the ground. Budget a capital as two owners: ground +
  layout + install, then walls/quay + lights + walk + pictures.

## Owner pointer (2026-10-05)
- **Use the WFC kit's 6x6 vaults and arcades for man-made dungeon rooms and grand town buildings** (owner: "utilize
  the archway from the 6x6x6 for the WFC"): L6 vaults with transverse arches (make_vault.py) and ArcadeGenerated
  pointed/round bays (KIT-RULES.md section 34). Not for natural caves or ice.

## Greyharbour (layout to walk)
- **A fixed 40 m lot terrace failed every deep building.** town-ground wrote each lot's terrace radius as 40 m from an 8 m
  front segment; the 48 m church was "190 samples off its shelf" wherever it stood. Fixed: radius = the envelope's reach from
  its front (min 40). Lesson: a check that fails with the same count in two places is measuring the rule, not the site.
- **Two streets drawn side by side at different heights read as one narrow street.** The shore street ran 3-7 m beside the
  descending harbour street; each band took its own skeleton height, leaving a cliff between them (survey 0 m wide). End
  the lower street at the junction instead of running it parallel. Change: town-ground build should warn when two street
  skeletons run within ~10 m for > 20 m.
- **A cut road's end cap keeps its old shoulder.** trail-peak-10 (reroute keep head) kept leftY 6.7 m below its surface at the
  new end; the end cap carved a 3 m hole across the coast road just outside the gate (the 147% metre). road-regrade did not
  touch it. Change: `reroute` should reset the new end's leftY/rightY to the surface.
- **Lots with deep front steps cannot front 7 m streets.** The ground build rejects a lot whose envelope comes within width/2
  + 1.5 of a street line; a 2 m step front leaves 1.8 m setback, so on a 7 m street every try fails and the lot hunts 80 m
  away (bakehouse SKIPPED, others displaced). Drawing that street 8 m wide fixed it. Change: setback = front + 2.2 m or the
  check uses the drawn edge.
- **The greedy lot search is chaotic; pin the lots that already pass.** Moving two markers re-shuffled most other lots. Pinning
  the passing ones at `frontCell - facing*7` (pads >= 9 m, smaller pads vanish in the key's open/MIN_AREA) and putting the
  moved ones first made it converge in three builds. Change: a `front:x,z` role that takes an exact front cell.
- **The lantern gate and the lantern planner disagreed on "ground".** Posts are set on the lowest of five samples; the gate
  measured the centre, so a post on a cross-slope failed as "buried 0.34 m". Fixed to the same footing.
- **town-npcs lint blocks bodies until the zone quests exist.** Added `--pending-quests` (missing quest/item refs warn) so a
  town gets its people in the shell stage; re-run without it once quests exist.
- **Play-mode tooling: teleport before the sim exists is silently lost.** The first picture and the perf probe stood at the scene
  spawn (Tidewell). Pictures now wait for the sim and re-apply the stand after settling; town-perf still reports the Tidewell
  camera after the same fix, so its --at is unproven (open).
- **A timber yard straddles the main gate's line** (no wall yet, so nothing caught it): town-layout should know the wall line
  (or at least each gate's line) and reject lots across it.

## Coordinator, systems that existed but were not used (2026-10-05)
- **Owner: "these systems should be in place."** Geometry noise (core csg `noise` with protect zones) and the Noise
  Lab findings (projects/noise-lab/NOTES.md, 2026-09-16) existed; the dungeon skill and my briefs never pointed at them,
  so two dungeons were built flat. Same pattern as the prop placement system (Sonnet + dressing plans) being skipped.
  RULE: before briefing a builder, the coordinator lists the existing systems for that job (skills, tools, labs,
  catalogues) in the brief, and the skill file for the job names them so a fresh agent cannot miss them.

## Dungeon pipeline gates

The quality rules now run as stages of the shared pipeline (`tools/dungeon-pipeline`, gates noise / originality /
atlas / recipe / compare, numbers in `thresholds.json`). Calibrated 2026-10-05 on the two owner-approved dungeons:

- **The references do not meet the per-room numbers of the recipe.** Medians per room: Barrow detail 17, props 3
  (bones, lights, mobs aside), kinds 2, bones 6, light sources 3, decals 0; Hall detail 23, props 6, kinds 5, bones 0,
  light sources 1, decals 0. The recipe's "7 props per room" and "25/35 detail" came from dungeon-wide averages (the
  Barrow's 410 detail solids sit mostly in the gallery and chamber; most of its 198 placed items are bones and
  candles). The numbers stay the owner's ruling: the references are recorded as failing them, not used to lower them.
  Owner decision open: keep the bar above the references, or set the per-room minimums to their medians.
- Fieldfast Barrow: noise, originality, compare pass. Atlas fails 12 (tiles reused under hue-shifting tints:
  dressed-trim, lichen, wood, silt; two roles one image ×3; basalt grey against brown stone). Recipe fails 67: no
  decals anywhere, bones over the cap in 9 spaces (a tomb; the Dressing rule "more bones in a tomb" contradicts the
  4-pile cap), props/kinds under 7/4 in 9 rooms, detail in 8, set piece undetected in 5, 2 rooms over 5 light sources.
- Fieldfast Hall: noise, originality, atlas, compare pass. Recipe fails 141 of 35 rooms: no decals, fill 3.2, one
  light source (one chandelier or hearth) in 21 rooms, set piece undetected in 27 (its rooms read through furniture
  sets, not one made piece), props under 7 in 26, detail in 24.
- Gnawspur Deeps (live): noise fails (no `noise.json`, nothing embedded, flat prism roofs in 9 groups, box `rock`
  lumps in 8 rooms); originality fails (`loculi_holes` copied from the Barrow, `extras` and 88% of
  `warren_burrow.py` shared with rime-hall); atlas fails 5 (shared tinted masonry tiles, basalt saturation off the
  stone band); recipe fails 68 (6 prop kinds in the dungeon, 0 non-bone props in most rooms, bones over the cap in 9,
  one sourceless light, too few lights in 6 rooms and 4 long passages, decals outside 6-12 in 8).
- The noise gate's flat-ceiling measure (share of a group's downward natural faces that are flat) also flags the
  role-noise proof copy's flat burrow roofs: noise on a flat slab still reads as a slab.
- Originality: the Barrow's masonry helpers (`hexa`, `arch`, `spandrels`, `door_holes`, ...) are shared primitives
  by the recipe (3.7); burrow sweeping helpers too. Set-piece builders (`loculi_holes`, `timber_arch`, `hull`,
  `crafted`) are not. A copy of a reference's code fails the copier only.
- Not ported yet: fieldfast-hall (CLI-calibrated), gloomvein-hold; **rime-hall: port to tools/dungeon-pipeline after
  its current pass** (README "Porting a dungeon").

## Rime Hall detail
- **Giant-scale dressing needs indoor declarations**: most giant-camp pieces (drying frames, firewood, whale bones, lanterns) were
  declared `setting: outdoor` and every dungeon plan refused them ("wrong setting"); `fixtures/lantern-glow` is anchor-only and the
  DC socket maps carry no anchors, so the ice rooms had no placeable light. Wrap once (`props wrap --decl '{"setting":"both"}'`,
  here `giant-camp/indoor-*`) before briefing dressers, or they burn rounds discovering it room by room.
- **Props in link passages block the walk**: three props + a torch in a 10 m giant link stopped the real body; dress the rooms, keep
  the links on the route empty. And a raised bench tier reads as a STAIR to the socket map, so the lane from the door to it runs
  through the room centre and refuses a centred hearth fire: decide the fire spot before adding tiers.
- **Owner palette ruling**: one stone colouring for every stone tile (pass the frost-rock tile as `ref` in the gen-set), one
  wood/hide tone, ice in the same grey-blue family; warmth comes from firelight, never from a brown copy of the rock.

## Dungeon room kit
- **Plan in, architecture out** (`tools/dungeon-room-kit`, 2026-10-06): per room, outline/x-y, floor, height, style
  and doorways in `rooms.json`; the rules place pilasters, dressed arched doors, ribbed vaults, 9-sliced carved-library
  wall courses and piers, niches, wainscot, arcades, timber roof bays, or a shaped noised cave. Proof
  (`projects/roomkit-proof/NOTES.md`): three rooms of a copy of the Barrow plan in 8 lines of room data, plan -> stamp
  6.5 s, -> audited DC 214 s, -> playable scene 455 s; real body 18/18 legs; built detail 345 / 19 / 140.
- **An arched doorway's clear height is at its jambs, not its crown.** A round 2.4 m arch with a 3.2 m crown measured
  2.32 m at the samples near the jambs. The kit refuses any arch springing below 2.6 m; prefer segmental heads.
- **Nothing may end flush on a slab edge between solids that only touch along a line**: an open-ended passage whose
  floor stopped exactly under its wall's outer plinth projection extracted 2 non-manifold edges. Slabs now overrun
  walls (and plinths) by 0.15 m; open sides overrun nothing (a neighbour group's floor is there: coplanar = z-fight).
- **Passages join the group of the room they leave** (`group`), and their ends are `openSides`: no wall, slab or vault
  laps into the next room's group. The next room's door reveal meets the passage walls face to face.
- **The carved DC library slices only along its curated bands**, and only its add nodes become bridge solids: arches
  and recessed panels depend on cutters, so the kit draws arches natively. A library piece cannot shrink below its
  fixed regions (a 1.4 m pad stays 1.4 m).
- **Detail counts come easily from rules; dressing does not.** The kit meets the recipe's built-detail floor in every
  masonry and timber room many times over (a natural cave just clears 18); props, lights, decals and a set piece per
  room remain the dungeon's own work through dressing plans. Keep fixtures out of the walk lanes.

## DC role noise floor band

Proved on `projects/gnawspur-rough` (2026-10-06): `tools/mesh-dc/noise.mjs` `floorGrid`/`BAND_DEFAULTS`, csg
`protect` kind `{ floors, above, below, fade }`, docs/blender-dc-authoring.md "DC role noise".

- **Derive protection from the stamp, not from the plan.** The band reads the stamp's own exposed up-facing faces
  (normal y >= 0.6, >= 1 m headroom, 0.5 m grid, dilated past each floor edge by amount + 0.5 m), so a role table
  needs no hand-placed zones and stacked levels resolve themselves. Defaults: zero noise from 0.2 m under to 0.6 m
  over each floor, full again 0.4 m higher. It is on for every noised role except `floor: true` roles.
- **Measured relief on the rock-wall nodes (amount 0.4):** 0.000 m in the band, ~0.07 m mean in the 0.6-1.0 m fade,
  0.14-0.15 m mean and 0.34-0.37 m max above 1 m. The silhouettes stay rough at eye height and above.
- **Stair cells were the noise; wall cells are the shape.** With the band, stray stair cells dropped to the crisp
  map's count (a handful of cells). The remaining socket differences are walls and lanes. The domed and lofted
  natural shapes and the bulges above the band move walls at the mapper's 1.0 m and 1.7 m slices, and the lanes
  re-route around them.
- **Check the plans that actually shipped.** The 4/18 recorded before was measured against template plans that
  `dressing.mjs plans` had rewritten, not the dress-fixed live plans. Against the live plans: 14/18 applied
  unchanged. The rest: chapel-burrow (a bone pile on a wall cell from a bulge) and sump-link (a bone pile on the
  re-routed lane) were dropped by `dress-fix`, and one granary barrel was re-placed. Sump still fails: an
  11.6 m² dome-crown top 4.55 m over the sump floor reads as an upper storey (U1-1). That is the domed roof,
  which was present before the band too, not noise. Result: 17/18 applied in the scene.
- **A wall-auto torch in a noised burrow falls to the floor.** No straight wall span exists, so the torch was placed
  mid-lane and stopped one walk leg (176/177). Pinning it beside the wall restored 177/177 (850.24 m, 27/27 doors).
- **3 cm earth-floor noise is still floor** to the socket classifier (identical maps with and without the new
  6 cm `--floor-relief` tolerance). But the re-bake tilted a few up-facing facets on the burrow roof (ny ~0.5, 1.5-2.2 m
  up), which read as one stair cell and re-routed the bolthole lane. The tread band does not check that a tread
  is reachable from the floor. Earth-floor stays crisp in the copy until it does.

## Rime Hall finish
- **A copied prove script fights the other dungeon.** The Rime Hall's fight "accepted 342 attacks, killed nothing": its
  `prove.mts` was the Deeps' with ids changed, so the chase watched `gd-pack-chapel` behind a Deeps neck and the player
  stood at the Deeps' cistern, 80 m from Asvor. Write the fight section from the dungeon's own plan (its neck, its boss
  room outline) and fail loudly when a pack id prefix matches no NPC.
- **Melee missed every tall body (engine, voxel-demo combat).** A swing's volume is a band 2.2 m either side of the
  ground, judged on the target's CENTRE: a 4-5 m giant's centre sits above it. `volumeContains` now takes the body's
  half-height from its collider (overlap, not point). Test: `projects/foundation/tools/combat-volume.test.ts`.
- **groundY anchored swings on the loft.** It probes down from 40 m and took the first TERRAIN hit: in a timber hall
  that is a tie-beam top split-floor calls floor, so every strike in the door and hearth halls was 10 m up. It now steps
  through hits more than 4 m over the probe's height. Indoor dungeons with storeys above the fight need both fixes.
- **Missing items fail drops silently**: the loot ids in plan.json had no `assets/items/*.json`; every drop is a file.
- **A giant fight takes a long time for the lone test player** (starting gear, ~6 dps): Asvor 6448 hp plus 8 thawed adds
  took ~45 sim minutes; the proof's windows and `--player-hp` are sized to that (60000), not to a human-sized dungeon.
- **The room kit's timber rules collide with a set piece and a route**: aisle posts landed on the hearth ring and a
  route point, and wall posts stood in doorways (fixed in the kit: no post within a door's half-width + 1.3 m). Run the
  walk right after the first kit bake, before dressing.
- **Long noised tunnels can't take wall fixtures**: the socket tool measures one flat floor per map and finds no walls
  on a lofted ramp. Light passages with 4 m window maps every ~15 m and posted lanterns placed by exact floor spots;
  a player-width crawl is honestly `unlit` (its note says why). Prose in the plan no longer re-triggers the export
  (writePlanGeometry leaves notes and names out of the digest).
- **Decimate noised bakes**: 7.6 M -> 1.7 M triangles (tools/mesh-dc/decimate.mjs after the planar merge), one group
  needed the 0.005 error step to stay manifold.
- **A tiny pocket a pillar cuts off a room** (2.4 m², room for one piece) made `dress check` demand two items it could
  not place; `defaultMinItems` now asks one item under 4 m².

## cartbreak-bend
- **A coarse slope survey hides a road shelf**: the 2 m-gradient map showed the whole reservation as >45 % (864 m2 "flat"), but a 6 m height grid showed an 18 m strip at road level north of the east arm and a trough inside the bend; survey heights, not only slope classes, before choosing to terrace.
- **180k for a medium place reaches only the grey box** when the owner must also discover the toolchain (no generic play-shot or walk tool; both are copied per job from hrimgard v2/v3). A shared `tools/site-shots` + `tools/site-walk` would leave the budget for the read shot, walk and dressers.
- **Coordinator (2026-10-06): 180k is not enough for a medium place from scratch**, even with the new tools (Cartbreak reached only the grey box). Budget a medium place at ~300k end to end; a small one ~150k.

## gullet-caves
- **A 180k cap holds a medium place's grey box plus a 1.9 km trail, not the full pass.** Survey, cliff/cave/track terrain, three crafted Blender pieces, scene ops and two play-mode shot runs used the whole cap; dressers, walk and installer did not fit. Budget a medium place + long trail at ~300k, or give the trail its own owner.
- **The reserved viewpoint can be blocked by ground outside the terrain radius**: Wrackmouth's view of the Gullet face is hidden by a natural shoulder at x 750-800 (beyond 100 m). The reserve stage should sight-line a place's stated viewpoint against the natural ground before the freeze.

## Owner review of zone-3 (2026-10-06) — the most detailed feedback so far
Rime Hall:
- Props all over the place: in the way, cluttered in the middle of rooms; HUMAN-scale props (grinding stones) in a GIANT
  dungeon; LANTERNS for giants (wrong culture); giant tanning racks unclear. Owner may doubt Sonnet can place props.
  Needed: props carry a SCALE CLASS and CULTURE, the menu filters by the place's; placement fills walls first, keeps
  room middles and walk lines clear unless a set piece; owner will make large props; giant tents without ropes/stakes.
- Statue hall looks cool BUT statues overlap each other; a random ledge on the left breaks the pattern; one random
  stalactite. Needed: overlap gate for placed geometry/props; pattern-break check in review.
- A decal sprayed over a candle holder: decals go BEFORE props and never over a prop footprint.
- Whiter trim stone + "lights on black": pools of light on black surroundings look wrong. Lighting horrendous.
  Needed: no black voids — a readable ambient floor; lights add warmth; a measured readability gate.
- Materials gained a SHEEN in places: everything matte (roughness ~1, metalness 0) unless intended; gate it.
- Prop pop-in distance too close in dungeons (half a hall before props appear): interiors need their own culling.
- Liked: it feels vastly different from the Barrow and the Deeps.
Gnawspur Deeps:
- Cool, unique rooms; but rock walls had no roughness pass (live version predates noise) -> reads like an EQ dungeon.
- Lighting very bright; an "open window" the player cannot see through is strange.
- A sewer grate beside the boss room is unreadable -> needs designing; the props list must grow.
Gnawspur outside:
- Liked: stepping stones up, the rope bridge, verticality.
- Aqueduct back to town opens a can of worms; rivers were probably never run on this continent.
- It should have been built on the cliffs over the actual lake. The road goes over the ridge only to climb back up
  the ridge; the zig-zag cuts deep into a not-high ridge where a small curved path along the edge would work.
- ~80% of mouth frames are not aligned with their opening; some holes too close together; rough voxel edits leave
  holes in the geometry and spikes along ridges.
Site choice (zone design):
- Road orientation and the player's path must drive location and layout; "even a simple height map would tell you
  what would look cool". The Rime Door should be at the end of its canyon. A dramatic canyon/mountain area (owner:
  "1603, 1820") has nothing planned. Every path that winds up a mountain must lead to something (cave, house, ruin).
- Too few POIs, lots of open space.
- Ironspur Shore's mood is too dark compared with other zones: tone it down (possible != comfortable).
Owner screenshots (2026-10-06):
- "This is all empty" (D:\Users\Derek\Desktop\HitRegStudios\this is all empty.PNG): the Shelf's central plateau holds
  only wildlife spawn circles — no place, no path destination. Site finder must flag large empty landforms.
- Rime Hall arch (Capture.PNG): pale trim ring floats proud of the rough rock with a BLACK VOID band between them
  (noise grows the wall outward, the crisp frame stays on the old outline; no ambient fill makes the gap pure black).
  Frames must fit the noised opening and overlap into the rock.
- A thin pale SPIKE/blade in the air (Capture1.PNG): matches the known mesher trap (a cut crossing a 48 m chunk border
  with thin cover pushes the edge metres up). Avoidance rules failed; fix it in the mesher.
- Jagged snow ledge (FixJaggies.PNG): sawtooth where a height patch meets the slope (raster edge on the 2 m grid) and a
  wall slab clipping through. Patch edges need a smooth falloff + a lip/sawtooth audit before install; built walls
  must be seated on terrain. BUILT 2026-10-06: auto patch feather + raster prefilter, patch `maxSlope`, road
  `maxCut`, `worldgen lips` / `worldgen seated`, zonegen `terrain-lips` row (docs/voxel-worlds.md "Height-patch edges").
Owner on Greyharbour (2026-10-06): "the town you did an amazing job on" — with these faults:
- The wall should have been one heavy custom wall from the mountain to the shoreline closing the gap between natural
  cliffs, not a 900 m ring. Walls are sited from the ground (narrowest gap between cliff and water), not from a brief.
- The harbour quarter looks ABANDONED: style run-down-port is wear 3 (max: holed walls, roofless), but every building
  is inhabited. Wear 3 is for ruins only; inhabited poor quarters use wear 1-2.
- Terrain pokes through some house floors: a "terrain through floor" check (ground sampled inside each footprint vs the
  floor) must run after any ground change, after settle.
- Lantern placement rules are too hard to get right; the owner will make more city props (decision pending on the
  existing lanterns). The owner has fixes for some WFC modules.
- Sonnet placement works for town buildings (floors, rooms); not for dungeons.
Owner notes (2026-10-06), recorded only — "we are dogfooding; none of this stays; it shows what to fix and how":
- Terrain through floors, diagnosed read-only: timber-yard (1338,-2149) — town-settle samples only the lot's `ground`
  outline, but the model is larger; ground under the overhang 24.50 > floor 24.43. Settle must sample the model's FULL
  footprint (`full`). Warden-hall/ferry-office area (1153,-2193): floors clear of the ground under both outlines, so
  the poke there has another cause (not yet found).
- Lanterns: the owner will make lanterns whose direction does not matter (straight vertical, no chains); facing rules
  become unnecessary for those.
- Capitals and larger towns: FILL THE SPACE first, then fit residents into it; not everyone needs a house.
- Capitals and starter towns should have a dungeon close to or tied into them: sewers, a haunted house, an abandoned
  mine, a sunken pirate ship in the harbour.
- Abandoned houses WITH a story are wanted (EverQuest's rats in the basements); basements would be great (feasibility
  unknown: kit has no cellar storey today).
- **Site dressing with 8 m pack clearings and the 6-item minimum fights small areas**: big composites (a tipped cart is 45 m2) exceed a path area's cover ceiling, and the minimum forces filler carts; give roadside set-piece areas a `street` role and 12 m radius, or let the owner place set pieces as structures.

## spoilgate-tower
- **site-sockets treated paint-only strips as walking routes**: a black-spoil apron painted with a `role: "none"` road (flatten 0) refused every cell under it (chute-foot 9 m² open → 97 m² after the fix). Fixed in `tools/site-sockets.mts` (skips `role: "none"`). Also: `compose`/`wrap` re-seat a prop on its bounds foot, so a site-fitted model (a chain built in world-relative coords, a ruin with deep foundations) must be placed by its MODEL origin (child offset compensated) — and `dress apply --parent <root>` double-offsets a world-coordinate site map: apply site plans with no parent.
- **A south-facing canyon foot in this zone's dark mood never reads its black spoil** (read shots at 11:00, 14:00, 15:00): the fan is dark-on-dark from the road; the slung chain on two 4.6 m sheave posts and the tower carry the read. A spoil read needs a pale contrast (lit carts, timber chute) or the dark-tile lesson (28) solved.

## Site finder
Built 2026-10-06 after the owner's zone-3 review ("even a simple height map would tell you what would look cool"):
`zonegen sites <world> --project <p> --zone <z>` (`tools/zonegen/commands/sites.mts`, engine `_site-finder.mts`, test
`test/site-finder.test.ts`). It is the first planning row of `zonegen status`, the freeze requires it, and the brief
(`places[].site`, warned when missing) and reserve (`off-site` error) read its picks. Proved read-only on proving
(`--out` to a scratch folder, ~3.5 s per zone); what it would have proposed:
- **Gnawspur**: the cliff over the lake is s01, a perch 156 m above lake-2 at [356, -1836]. It lies inside the
  warren's 175 m reservation, but the build went over the crest at [551, -1808]. The finder flags that crest as
  `wasted-climb`: the aqueduct track climbs 67 m to it, then drops 33 m. The reservation circle covered the right
  ground and the build still missed it, so a circle is not a site; the `site.at` pick is.
- **Rime Door**: s03 canyon end at [2236, -2180], walled on 15/16 sides, mouth to the E. The back-wall foot is at
  [2220, -2180], facing E. The door is reserved at [2290, -2170], 70 m short of the end.
- **"1603, 1820"** is world [1603, -1820] (the owner reads north as +, world north is -Z): the carved canyon-4 massif
  above Greyharbour. Nothing is reserved there, and nothing lies within 447 m of [1756, -2036]. Found: canyon end s37
  [1740, -1844] (15/16 walled, ~96 m walls, mouth S), mesa s76 [1548, -1852] (4.1 ha, 58 m over its foot), peaks at
  [1444, -1860] and [1868, -2076], and a 40 m cliff neck at [1420, -1684]. No road reaches the area or sees it. It
  needs its own trail, or it is a deliberate hidden find.
- **Shelf plateau (zone-5)**: `empty-landform` error. The plateau is 125 ha at [2484, -644], and only 4% of it is
  near a place. Nothing lies within 825 m of [2236, -740]. Three trails already run onto it and stop at nothing:
  trail-peak-39 at [2208, -768], trail-peak-40 at [3104, -720] and trail-peak-32 at [2672, -976] (68 m climb). Its
  south rim has standable perches 128 m over the lake (s01-s07, seen from 0.9-3.6 km of road).
- **Greyharbour wall**: s06 wall-gap at [1308, -2180] is an 88 m neck between the water and the cliff foot. The coast
  road runs through it, 139 m from the town. The wall line is drawn on the map: one short, heavy wall, not a 900 m
  ring. To the west the ground is open (no neck under 220 m), so a wall on that side is a choice, not a site.
- **Density/paths**: zone-3 has 3.1 places/km2 and zone-5 has 2.86/km2. The floor is set at 4/km2 so that the
  owner's "too few POIs" verdict is a failure. Empty discs are 536 m and 825 m, against a limit of 450 m. Climbing
  trails that stop at nothing: 2 in zone-3 (trail-peak-19, -25) and 4 in zone-5 (trail-peak-3, -29, -32, -35).
  Generated `trail-peak-*` paths end at peak POIs, and a peak POI is not a place, so each needs a place or a cut.
- Traps met building it: a flat plateau top is a "local maximum" everywhere, so peaks need a falling ring at 60 m.
  The cliff-water check needs a perch of at least 500 m2 at the edge, or every knife ridge over a lake wins. An empty
  disc has to be measured over in-zone dry land, or the sea counts as unused space. Usage is counted inside a
  reservation's own radius (not radius + margin), and a wall gap beside a town is that town's wall site, not ground
  the town already uses. Hairpins need a 4 m resample: site paths zig-zag on 10-20 m legs.
- Open: ranking is heuristic. Rim perches on one cliff line crowd the top of the list (only a 160 m separation keeps
  them apart). The sight test uses an 8 m landmark over the 8 m grid. The `sites` gate digest does not cover road
  edits (the recipe projection hashes regions, towns and sites), so re-run it after paths change.

## Prop scale + placement rules
Built 2026-10-06 after the owner's Rime Hall review (props cluttered in the middle and in the way, human grinding stones
and lanterns in a giant dungeon). Dressers did well in town buildings and badly in dungeons because nothing told them
whose place it was and the resolver's `open` preference put free-standing pieces in the MIDDLE of a room.
- Every prop declares a SCALE CLASS (`dressing.scale`: any, tiny, small, human, large, giant) and CULTURES
  (`dressing.cultures`: any, civic, rural, noble, sacred, bandit, crypt, wild, giant, ratkin, frogkin, anansi,
  crocodile-kin, dragonkin, goblin, dwarf). The class and culture lists are DATA (`DRESSING_VOCABULARY` +
  a project's `authoring/dressing/vocabulary.json`, merged by id, each entry with optional `accepts`), not a schema
  enum: a new people gets its entry when its props are made. `centrepiece: true` marks the props that belong in a
  room's middle (hall bonfires, plinths, fountains, the spit frame).
- A plan declares its place: `space: { kind: "dungeon" | "building" | "site", scale, cultures }`; a room may override
  scale/cultures/keepCentre. `props menu --scale/--culture`, or a room menu with `--plan`, offers only matching and
  `any` props (sets only when every member matches; untagged props are hidden). The resolver refuses the rest
  (`wrong-scale`, `wrong-culture`) and warns on untagged ones (`scale-undeclared`).
- Dungeon rooms keep their MIDDLE clear: cells farther from the room edge than max(1.5 m, half the room's inradius)
  are a keep-clear centre (`centre-clutter`), except a centrepiece prop or an item marked `setPiece` (one per room,
  two over 300 m²). Auto `open` in such a room hugs the edge instead of seeking the most open spot, which is what
  emptied the walls and filled the middles before. Dungeons also widen the stair/doorway buffers (1.0 / 1.6 m) and
  keep solid props 0.4 m off walking paths (`path-margin`).
- Nothing overlaps placed geometry (`plan.obstacles`, or `--scene ... --at` reads statues and other plans' props:
  `overlaps-geometry`), and no prop stands in a decal's projection box (`decal-overlap`): decals go on BEFORE props, the
  props keep off them, never the reverse.
- `dress review` (one plan or `--all`) prints per room: wall share (furniture backed on a wall or within 1 m of the
  room edge), centre clutter 0-100, scale/culture violations.
- Re-check of the 18 applied Rime Hall plans, frozen at their old spots, as a giant dungeon with the scene's decals and
  statues: 0 -> 325 violations (108 wrong-scale, 102 wrong-culture, 78 centre-clutter, 20 path-margin, 11 decal-overlap,
  1 statue overlap). Every passage's two `indoor-hanging-lantern`s are refused (a human post lantern).
- Known gaps: noised DC caves have almost no straight wall spans, so `against: "wall"` props (giant hide-bed, wall-hide)
  cannot be placed in them at all; giant/any lights are only the hall bonfires and loose embers (the rime bucket's
  lantern and brazier are human); `giant-camp/indoor-skull-pike`, the ruin masonry (human scale, any culture) and the
  camp bonfires are inferred and want the owner's eye.

## wrackmouth-cove
- Kit `central_hearth` (smoke louvre) z-fights the run-down-port crest at every footprint: a smokehouse in that style needs the louvre piece fitted to the style's crest (kit gap, logged, not hand-fixed). The kit has no roofless option, so "roofless ruins" cannot be asked for; wear 3 gives slipped shingles and boarded windows only.
- The quest-walk planner stops ~2.2 m short of a target, so a straight leg "doorway -> inside" starts off the door axis and catches a 1.2 m kit door jamb; walk doors as "4-5 m out on the axis -> 3 m inside". A dresser's `near: <anchor>` can land a prop ON the anchor point (a barrel inside the well ring); check placements against built anchors.

## Mesher blades
- The pale blades near carved passages were cell-boundary SKIRTS (`addSkirts`, mesh.ts), not the field: every chunk-border edge got a strip a fixed 3 lattice steps (6 m) deep, reversed upward on passage roofs. Under less than 6 m of cover (or under a knife ridge / carved overhang going down) the strip came out the other side. Fixed in the engine 2026-10-06: undersides extrude up, every skirt vertex is clamped to the rock the cell's own lattice shows on that boundary column, no rock means no strip. Builders no longer need to keep cuts off 48 m borders.
- Second seam defect found by the same scan: a tunnel or carve crossing one cell's band floor but not its neighbour's was sealed at two heights, leaving open edges (holes to the void) on the seam. Band floors/ceilings are now a per-column pure function, so both sides seal the same way.
- Check, don't eyeball: `pnpm -F playground exec tsx tools/voxel-blades.mts <recipe.json> --sites --caves` (or `--box x0,z0,x1,z1`). Skirt ends in air and open edges must be 0. Its "blades" column also counts surface vertices a little off a sharp field (MC interpolation, < 2 m) and vertical heightfield cliffs (a 200 m step in `height()` reads as huge "air"); those are field shape, not mesher seams.
- Measured on proving (copy of 2026-10-06): Gnawspur skirt ends in air 2 (4.3 m proud at 628.8,134,-1680) -> 0; cave networks 1-5 open edges 60/21/116/29/116 -> 0 (1 cm weld); skirt ends in air in caves 11/2/6/4/6 -> 0.
- Not fixed here: heightfield discontinuities (e.g. a ~200 m step in `height()` at (-2104, 1134), cave-4) make MC put a wall up to a lattice step off and can read as teeth along a ridge; that is in the height source, not the mesher.

## Lighting floor, matte, interior culling (2026-10-06)
From the owner's zone-3 review ("lights on black", "sheen", "pop-in halfway through a great hall", "Ironspur too dark").
- **Readability floor.** A dungeon's fill was capped at 1.5 by the recipe gate ("the Barrow's 1.15 is the reference")
  while the owner-approved Fieldfast Hall runs 3.2: the cap itself made the lights-on-black. The fill is now ONE
  hemisphere per dungeon (`light.groundColor` on the ambient light: sky tone above, darker tone below, so floors,
  walls and ceilings read apart), intensity 5, tone by the dominant bucket temperature (warm/cold/neutral at equal
  luminance), fog fading to the fill tone (sky dome too, so a culled room seen through a far door is fog, not a
  black hole), vignette <= 0.25. Data: `tools/dungeon-pipeline/lighting.json`; applied by `lighting.mts` (a pipeline
  stage after `scene`). Fixtures add the warm/cold pools on top; never fix darkness with more fixtures.
- **Measure it.** `readability` gate on the shipped-light views (median view <= 50% near-black, mean 14-40, p10 <= 10).
  As they stood: Fieldfast Hall passes (0.47 / 23 / 3); Gnawspur Deeps fails FLAT (p10 14: the darkest tenth is lit,
  no pools; the owner's "very bright"); Rime Hall fails (0.80 / 9); the Barrow's checked-in views fail (0.93 / 6.6:
  re-shoot before trusting them). rime-hall-light (3 rooms): door hall 0.81 -> 0.24 near-black, gallery 0.86 -> 0.50,
  throne 0.95 -> 0.74; median mean 7.1 -> 22.2: PASSES. The throne hall stays darkest: a black-ice floor tile (luma 36)
  and a dark ceiling; dark tiles read dark at any fill, so pick floor tiles >= ~50 luma for big rooms.
- **Matte.** The sheen came from per-project `materials.mjs` layer roughness (rime-hall smooth-stone 0.3, ice 0.35,
  metal 0.5, silt 0.6; frozen-dead 0.5 and ice-skin 0.12 on the statues), smaller ones in every dungeon (dressed-trim
  0.85, wood 0.8) and the material schema default (0.85 / metalness 0.05; now 1 / 0). The `matte` gate fails roles,
  materials and own GLBs under 0.9 (metal 0.6); an intended shine is an exception with a why. Live dungeons fail it
  until their `materials.mjs` is fixed (the copy shows the pass: every layer >= 0.92, metal 0.65).
- **Interior culling.** Per-scene `cullingProfile` (docs/culling.md "Interior scenes"); `culling` gate measures pop-in
  along the route. Rime Hall before: worst room 74.5 m from its door to its dressing, pop-in up to 68 m (gallery,
  frozen lake) or never on the route (children's room); after (profile reveal 80): 0 m everywhere.
- **Zone moods: tone, not brightness** (owner: "lighting must FEEL SIMILAR across zones"). `node tools/zone-mood.mjs
  lint`: lightScale 0.9-1.1, fogDensity 0.8-1.25, mist 0.5-1.5, contrast 0.95-1.06, light/shade multipliers no
  darker than the unflagged neighbours (zone-1/zone-5). zone-3 fails only on contrast 1.08; its nested places fail
  hard (lightScale 0.85, fogDensity up to 1.8, mist up to 2.4) and are the likelier "super dark". Proposal (NOT
  applied): projects/rime-hall-light/proposals/zone-3-mood.json via `zone-mood.mjs install <file> [--apply|--revert]`.
- **Trap:** running a gate on a dungeon writes `reports/quality/<gate>.json` into it; calibrate on projects you must
  not touch with `quality.mjs <gate> --dry --metrics`.
Owner notes (2026-10-06, later):
- Density like Skyrim: "stuff around every corner" — several major POIs per zone PLUS many smaller ones; small finds
  count. Site finder now: >= 8 places/km2 (radius >= 10 m counts), nowhere > 250 m from something.
- A hostile giant camp on the MAIN road between two towns is not player friendly; it belonged in the little canyon at
  the Rime Door. Rule: major hostile places sit off town-to-town roads (a lookout over a road is fine); the site finder
  should flag hostile places on main roads.
- Access devices are content: "wouldn't a kick-ass elevator up there have been cool?" (the massif above Greyharbour).
  Lifts, cliff stairs, rope ways, ladders, hoists make high/remote sites reachable; the site finder should propose one
  where a strong site has no way up.
- Sewer grates belong on the dungeon props list (owner will make them).
- Trial re-dress (one fresh Sonnet dresser, children-room on a scratch copy, new menu + rules): the old plan scored
  32 violations, wall share 13%, centre clutter 85/100 (stools, a human table, lanterns in the middle); the new one
  is 0 scale/culture, wall share 80%, clutter 0/100, its one set piece the drying frame, 1 violation (the 2 m² G-2
  pocket holds 1 of 2 items). Its only light is a pile of loose embers: the hall bonfires
  are too big for the walk-line margins and buffers in that cave. Giant-scale small lights (a giant torch/fire bowl) and a
  giant bed that does not need a straight wall are the props to make next.
Owner on Spoilgate Tower (2026-10-06): "kinda lame". The chain is huge; the plateau the ruin sits on is oddly placed;
the tent is the wrong size; "those props are all one size"; the chain art and the capstan are cool "but why is that
here?". System faults behind it:
- A place's idea must explain itself in the world (a toll needs a barrier people stop at, carts waiting, the
  deserters' shelter), not just be visible. The read shot checks visibility; the reviewer must also answer "why is this
  here?" from the pictures alone (add to the rubric).
- No REAL-SIZE check: props and set pieces are scaled to read from far away or by a group factor, never checked
  against a believable size for their kind (a toll chain waist-high, a tent door ~2 m for its user). Needed: per-kind
  real-size ranges in the catalogue + a check at placement (scale tags alone do not catch it).
- Terrain shaped to fit a layout (a terrace levelled to the road) shows as an earth bank from below; layout should fit
  the terrain (site finder + lip gate).
- **Site dressing was culled as an interior**: `dress apply` gave every site-map room `culling: { interior: true, reveal: 12 }`, so a dressed yard or landing was invisible until the player stood in it (every outdoor site dressed through site sockets had this). Fixed in tools/dress.mts (site maps cull as clutter, minScreenPx 6); re-apply earlier sites' plans.
- **A road does not clear scatter, and a track leaving a walled town must use a gate**: the first Strand Track ran into Greyharbour's wall, and the walk stuck on a low collider on the road at (790,-2242). Start trails at `town.gates`, and give long trails a clearing strip (or a road-side scatter rule) before the walk. Cave chambers needed `floorY`/`room` on site-sockets areas (added).
Owner on Wrackmouth Cove (2026-10-06): "the props with the nets just don't look good; what is the story?" The catalogue
has no fishing props, so the owner reused GIANT hide-drying frames with a code-drawn net card. Rule: when the catalogue
lacks the right object, the place logs a prop request (owner makes it) and leaves the spot for it; it does not
re-purpose a prop made for another culture/scale. The story (abandoned hamlet, family's things, sleeping wolves, dead
gulls) did not show because creatures, interiors, abandonment geometry and gulls were all missing; a place whose read
depends on missing pieces should say so in its handoff as "story not yet visible".
Owner (2026-10-06, later):
- Keepers from the dogfood (exported as OBJ to saved-props-2026-10-06): the wells, giant huts WITHOUT ropes, boats,
  wooden docks, the giant chain + capstan (reuse as something else), the bonfire, the Gnawspur arches, the wooden
  shack, ruins, tanning racks, whale bones. NOT the giant hide-drying frames.
- The "random spheres" at the Gnawspur are the catalogue `boulder`, which is two raw spheres: a bad catalogue entry.
- Some ruins need to feel MUCH larger.
- Islands in lakes are easy, strong POIs (site finder should list them).
- Use DC rock placements around the world, possibly replacing the owner's rock formations; the MMO world's waterfalls
  are the example of DC rocks done well (see fall-crafting skill / docs/world-editing/fall-crafting.md).
Owner (2026-10-06): the Gullet is "a cool idea, but the mechanisms for that wouldn't work" (crane/treadwheel/net hoist
as built). Rule: COMPLEX MECHANISMS (cranes, hoists, treadwheels, lifts, sluices, capstans) are owner-made props;
a place that needs one adds it to the prop request list (prop-lists-by-culture.md) and leaves its spot, instead of
an agent modelling a mechanism that cannot work.
- Road zig-zags: "our road creator makes some of the stupidest zig zags" — e.g. (859,-2184), which is the
  gullet-strand-track (340 points, laid by a place owner to a 15% grade cap). Grade-capped pathfinding on a slope
  yields sawtooth switchbacks; trails need deliberate, few, wide hairpins (or a stair/ramp) and edge-following
  (maxCut/maxFill exist now; the generator itself still needs the fix).
Owner on Cartbreak Bend (2026-10-06): "what are the wheels with cloths up for drying? what is the bed roll? the carts
from the purchased props have wrong textures; what is this odd tower of wheels and cloths; what is Cartbreak Bend
supposed to be?" The agent built story objects (wheel gibbet = trophy pole of wheels + robbed clothes; wheel racks =
stolen goods for sale; hooded plague carts; a bundle) by composing mismatched catalogue parts and code-drawn cards —
none of them readable. The purchased carts (covered-caravan, cargo-wagon, cage-wagon) were flagged LOW/needs-art on
the Shelf and never re-skinned. Rules: (1) a story object that does not exist is a PROP REQUEST, never a composite of
unrelated parts; (2) purchased-pack props flagged LOW or needs-art are not used until re-skinned; (3) the reviewer's
"why is this here?" must be answerable from the picture without the design text.

## Prop reskin
- A purchased pack's "wrong" look is usually palette, not resolution: regrade every texel by colour family onto ONE wood, ONE iron and ONE undyed-cloth reference (keeping its own luminance at reduced contrast), and re-pack under-dense props at the size their UVs need with the town wood grain projected in metres; that fixes both without new art or GPT calls.
- Reskins go under new ids with the old catalog row marked `supersededBy` (the menu then offers only the successor while installed scenes and old dressing plans keep checking); leave glass, food and loot out of a material regrade, because their colour is what they are and the flattened texels read as LOW.

## Portal coverage
- A walk-through portal installed with the default box (2.4 x 2.6 m) or a box sized from a corridor number is sized for
  a doorway nobody measured. Entrances built as tunnels, clefts or giant gates are wider and far taller: the box let a
  body step past at the sides and jump over the top, and the veil (25% over the box) covered the lower third of the
  opening while the passage showed above it. Measure the opening from the rock (`tools/portal-cover.mts`), never the plan.
- The box must catch the body CENTRE, not the feet: 0.9 m over the floor walking, about 2.9 m at a jump's apex, 0.4 m
  off each wall. A 2.6 m box under a 6 m ceiling is jumped over.
- A box (or veil) whose plane stands outside the mouth, where the sections are open to the sides, can be walked round;
  stand both on a closed cross-section, the box within 1.5 m of where the author put the anchor.
- Measuring the opening with rays from the passage centre misses arches and hollows; flood the plane through clear
  short segments, tested in BOTH directions (a mesh face stops a ray from its front only, so a one-way flood leaks out
  through the back of the rock and fills everything).
- Fitted sizes live in the project's `authoring/portal-veils.json` (`size`, `at`, `trigger`), which `portal-veil` re-applies
  after every rebuild; a size written only into a scene is lost on the next build-scene.
- A round trip that passes (`portal-trip`) proves only the line the harness walked down the middle; it says nothing
  about the sides, the top or the veil. The cover check runs first for that reason.
- Pictures of a world portal in local play: the body is held until the ground under its spawn has streamed; wait for
  that before moving it, and place it at the passage floor height, not at the voxel field height (a tunnel's field
  height is the hill on top of it).
- Portal coverage gap (coordinator, 2026-10-06): `portal-cover --fit` only RESIZES trigger and veil where they stand.
  A portal placed behind its doorway (inside a wide hall) cannot be fitted — the fit inflates the veil to the room's
  width and the body still walks round the box. --fit must MOVE the trigger/veil to the narrowest cross-section of the
  passage (it already measures it). The manor door on the Shelf is the open case; its fit was undone.

## Real-client portal test
- A headless round trip (`portal-trip`, PortalHarness) can pass while a player cannot leave. The harness waits out
  the arrival grace before it walks back; a player who arrives and turns straight round does not. The dungeon exits
  stand ~3 m behind the entry anchor, so a body that left at once crossed the WHOLE return box while still in its
  arrival grace (unarmed), then walked on into the dark passage behind the veil with nothing happening. Fixed in the
  `portal` builtin: an arrival that WALKS 1.5 m clear of where it first stood outside is armed, grace or not (the grace
  still stops a body placed in or against a box, or one still holding a key from the trip, from bouncing back).
- The test of a door is a player walking it: `tools/portal-play.mts --dungeon <instance>` drives the dev app in system
  Chrome (local play, W held, camera turned to the goal), walks in through the world door and back out, then opens
  the instance ITSELF (what a page reload inside does: no recorded way back) and walks straight out. It is the last
  stage of every dungeon pipeline (`portal play`) and a `zonegen status` row; both doors are digested, so an edit to
  either makes it STALE. Its failure line says where the body stopped, how far from the box, and any refusal.
- Walk the body with real input, not `sim.setPosition`: a teleport across a box is (rightly) not a walk-in, and only
  a walk meets the collision, the curtain and the scene swap a player meets.
- The dev handle needed for it: `__hitreg.playerId()`, `object(id)`, `travelTo(x, y, z)` (map travel to an exact
  height: a tunnel mouth's field height is the hill on top) and `travelling()`. Settle on: scene name, play mode,
  curtain down, no travel hold, sim and player present, before every step.
- Wait times are long (a trip and a reload ~8-9 min for proving): reuse one vite (`--url`) across dungeons and run them
  one after another, never beside a perf run.
