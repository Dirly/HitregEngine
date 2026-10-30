---
name: grand-entrance
description: Make a dungeon entrance or hero landmark GRAND — a built structure that reads from 300 m+ and makes the player want to go in: concept frames first, sized so the interior is believable, man-made parts as BUILT landmarks (real meshes, unique carved textures) and rock as the natural stamp, carved + painted approach track, stair and plaza, flanking statues, one light bucket, vfx fire, a portal veil, judged in four fixed shots and five gates. Use when designing, building or reviewing any dungeon entrance, gatehouse, temple front, tower or other landmark.
---

# grand-entrance

One owner, about 1% of the week's target. Pair with `site-standards` (the site), `terrain-edits` (ground),
`statue-maker` (statues), `portals` (the door), `site-dressing` (loose props). Format: `docs/voxel-worlds.md`
"Landmark stamp" and "Built landmarks".

## 1. Concept first
- Paint the concept frames ON THE SITE before any geometry: `node node_modules/tsx/dist/cli.mjs tools/zonegen.mts concept <world> --project <p> --zone <z> --poi <id>` (apps/playground)
  renders the bare site (approach at player height, far view from >= 300 m), Codex repaints each with the ground fixed,
  and the sheet prints the face height under the door, the apron and the read distance. A front taller than the
  measured face does not fit: move the site (`zonegen sites` needs) rather than paint a taller cliff. Text-only
  frames are refused by gate 16 (Wristgate 2026-10-29).
- Judge every later picture against these frames. Name them in the report.

## 2. Size
- Size the exterior from the concept and from the interior: the shell must plausibly hold the instance. The interior
  may be bigger (it can go down or sideways); the outside may never look smaller than one room of it.
- Measure against the nearest natural mass (butte, ridge, tree line): the landmark must not be dwarfed by it.
- Make the door monumental: opening >= 3x player height, a recess >= its width deep.

## 3. Built or stamped
- Man-made parts (walls, gates, towers, stairs, plinths, columns, panels): `landmark` operator `kind: "built"`.
- A long wall, curtain, quarry face lining, quay or causeway ramp up to the door: the `wall` operator (a swept profile along a line with coping, footing, buttresses, parapet, gates, stair flights; `variant: ramp` for the approach), never boxes in a row; `scale: giant` for giant work, with a giant-block texture.
- Rock and landforms (cliffs, roots, arches of stone, mounds): the natural stamp (`kind: "stamp"`, natural roles).
- A built gate set into a rock face: ONE built operator; give the rock parts natural roles (rock/cliff), the baker
  stamps them into the same prefab. Use two operators only when the rock is shared by several structures.
- Never give a built part a natural role, and never give rock a cut-stone role.

## 4. Cut stone, simple masses, strong textures
- Every built part reads as cut stone or brick: ashlar, banded courses, carved trim, paving. Never natural rock.
- Model big simple masses (boxes, lathes, extrudes, arches); put the detail in the texture, EverQuest/WoW style.
- Model an opening as pieces around a gap or as an `arch`; use a `sub` only when it is convex (box, cylinder) and cuts
  convex walls (it builds the reveal); a cut through a lathe leaves a hole.
- One role per texture: `ashlar` (walls), `trim` (cornices, bands, caps), `paving` (stairs, plaza), `relief`
  (carved panels), `lintel` (the door's crown panel). Panels are built parts with `uvRegion`, not scene slabs.
- Generate the role set in one session: `node tools/built-textures.mjs gen <set.json>` (concept as reference,
  PSX, 40 texels/m, tiles and bands seamless, ids prefixed by project), then `check` must pass.
- Name the materials per role in the operator; leave `tile` out (the baker derives it from the texture size).
- Iterate shape in seconds: `tools/landmark.mts --spec <file> --kind built [--glb-only page.html]`.

## 5. Grandeur cues (all of them, unless the concept says otherwise)
- A carved + painted approach TRACK (`worldgen road`, never a ribbon: removed 2026-10-30) from open ground >= 150 m out, ending at the plaza foot.
- A stair (0.25 m risers, landings every 12 steps, cheek walls) up to a terrace, and a plaza at its foot.
- A flanking statue pair from `statue-maker` (kit body + ubermesh hood/robe/staff parts, a real animation frame),
  in the place's stone, big enough to read at 150 m; check its facing in a picture.
- Fire only through catalogued vfx prefabs (brazier, standing-torch, bonfire); lights from ONE bucket.
- A portal veil in the recess (`portal-veil`), fitted with `portal-cover --fit`.
- `tools/art-check.mts <job>` must pass (job.mjs gate 15): rock at the terrain's own texel scale, no surface outside the zone ground's L* band or near-black (lift dark masks with tint + emissive), several materials, a door with a portal or declared sealed in handoff.json `doors`, bevelled blocks (`bevel`), no repeated hero copies, giant-scale courses for giant work.

## 6. Judge (play mode, readable hour, after a dev-server restart)
- Four shots: 300-400 m on the approach; 150 m; the gate from the plaza; the portal from the stair top.
- Lay them beside the concept frames in one sheet. Fix what reads worse than the concept before any detail work.
- The 300 m shot must show the silhouette and the door's position; the 150 m shot the statues and the stair.
- Lost in the zone fog at 300 m? Give the `landmark` operator `fog: { fogReach: <metres>, silhouette: 0.6 }` and
  recompile (no re-bake; a hand-placed POI: a `landmark` component on its shell root) — docs/culling.md: it reads as a
  darker shape out to `fogReach` while the ground keeps the zone fog.

## 7. Gates (all must pass)
- `portal-cover` PASS; `worldgen float --near` 0 floaters; `see-through.mts` 0 holes on the scene near it;
  `flat-art.mts check <project>` 0 flipped/mirrored; the walk (`approach-walk.mts`) from the path start up the stair
  into the portal.
- After a built bake: `worldgen op --check` clean and the bake's `reach` lines all ok.
