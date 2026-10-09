# Handoff: making a crafted waterfall look good (2026-09-27)

For a fresh session. Read this, then `rivers-and-falls.md` (the rules; about 24
of them, plus the "Crafting a fall" section). Nothing below is committed; the
whole river/fall stack is uncommitted work on `feat/ai-native-tweakability`.

## Where things stand

The procedural river pipeline mostly works:

- Water is clipped from the terrain.
- Rivers start at lakes.
- Each river runs gently and has one fall per river.
- Rivers solve as a network.
- Banks keep freeboard.
- A lip line decides every question at a fall.
- Lakes flood out to their real shore.
- Steep faces are painted cliff.
- Falls get mist, splash and foam.

The mmo world was rebuilt with `worldgen all mmo --project proving --trace
--catchment 0.6 --lakes 20 --terrace-share 0.75`. `worldgen status` is green
except zone names.

**The target.** The lake fall on river-15 near Highland Keep (town-1), about
(5358, -3860). It is crafted as a 3-tier cascade: `features.fallSites` id
`site-river-15-21`, plus 34 `features.blobs` whose id starts with that site id.
Derek likes the concept of three falls, but the result looks awful.

What Derek sees there:

1. **Floating rocks.** Scatter-rule rock props placed by `at`/`lift` don't sit on
   the carved ground.
2. **Wonky geometry.** The procedurally carved gorge is a straight, smooth 50 m
   deep slot. The crafter's blobs, 3–4 m across, can't reshape it and read as
   lumps.
3. **Lake water past its bounds at the top of the falls.** The lake flood
   (`lakeFlood`, field.ts) and the lip line / top tier disagree, so the lake
   sheet spreads over the ground at the head of the cascade.
4. **A pale flat "shard" at the middle step.** It shows in every front view;
   the judge calls it torn geometry. It is probably the middle pool's surface
   or rim seen edge-on (a lip-straddle piece in chunk.ts `straddledLip`). It is
   still unfixed.

## What the review loop taught us

Loop: a crafter agent writes the site doc and blobs; `_apply-site.mts`
installs them; `_site-views.mts` makes 5 fixed views; a judge agent scores
them.

Scores (overall out of 10): 3 at baseline, then 4, 4, 4, 3. It never passed.
Pass means every category is at least 7.

- **Scale mismatch is the core problem.** Dressing with 3–4 m blobs cannot fix a
  50 m machine-cut slot. The fix has to reshape the gorge at site scale, or
  cover the walls densely.
- **The judge is noisy.** Near-identical frames scored 4, then 3. Once it
  called two falls "one drop". Give it a reference "good" image and use two
  judges, or fall back to numeric checks.
- **Engine fixes the loop needed**, all in, in `packages/core/src/voxel/field.ts`:
  - `FALL_NARROW` 1.5 m. Pools were being held to the channel's width, so the
    water didn't reach the banks.
  - `course` on a fall site, which splices a redrawn centreline into the river
    (`spliceCourses`). Needed because the channel was a straight canal.
  - `paintSiteRocks`. Site add-blobs, and the steep faces within 45–70 m of a
    site, paint the `rock` surface. The mmo `cliff` texture is brown and reads
    as dirt.
- Only the rock rules allowed in the local biome may be used. This site is
  forest, so only `rock-medium`; sandstone looked wrong.
- Screenshots need a FRESH dev server on another port. The running server's
  terrain worker serves stale core code. Check that the port really is free
  first, or you shoot old code.

## Suggested approach (Derek's ideas, first two first)

1. **Dense rock scatter embedded in the cliff walls** along both sides of each
   falling sheet. Many instances of the biome rock rule, sunk a third to half
   into the wall, following the wall's normal, bigger at the base. Instanced,
   so there are no extra draws. This needs a placement mode that snaps to the
   wall face (surfaceCast, or a raycast against the density field sideways),
   not `ground height + lift`. That is also the floating-rock fix.
2. **DC voxel rock formations.** The mesh-dc / dual-contouring tools
   (docs/blender-dc-authoring.md) make crisp rock that the smooth marching-cubes
   terrain can't. A small kit of rock-stack pieces could be stamped at the fall
   edges and painted with the same splat.
3. **A site-scale gorge template.** Before any dressing, the site reshapes its
   whole span into stepped rock bowls around each pool, with walls that step
   back irregularly instead of one straight slot.
4. **Fix the lake overflow at the top lip.** `lakeFlood` must stop at the top
   tier's lip line; check `waterSurface` against it.
5. **Fix the middle-step shard.**

## Tools (apps/playground/tools, untracked scratch)

- `_site-snapshot.mts [river] [siteId]`: the crafter's context. A 40×40 grid
  at 2.5 m of ground, natural ground and water; the allowed rock rules; the
  current doc and blobs. About 20 KB.
- `_site-views.mts [river]`: JSON for the 5 review views, fed to the scratchpad
  Playwright script `river-shots2.mjs`.
- `_apply-site.mts site.json blobs.json`: installs a site with guard rails
  (blobs within 60 m, radius at most 12, at most 40).
- `worldgen fall-site <world> --list | --fall N --snapshot | --template cascade`.
- Audits: `worldgen status`, `worldgen audit`, `_water-check.mts`,
  `_river-gaps.mts`, `_river-crossings.mts`, `_falls.mts`.
- The briefs from this round, for reuse: `craft-brief-v2.md` and
  `judge-brief.md` in the previous session's scratchpad. They are copied into
  this doc's "Briefs" section below.

## Working rules Derek set

- Subagents get a compact written brief, never a fork of a long session. Forks
  burned about 2M tokens in 10 minutes.
- Blocks of about 5 agents at most.
- Draw calls first: repeated visuals must be instanced.
- World-creation rules are getting long. Split them per stage (terrain,
  rivers, falls, paths, towns); rivers-and-falls.md is the first candidate.
- Once a fall passes review, write the formula (brief, order of work, pitfalls,
  rubric, token budget) as the playbook for future river-building subagents.

## Briefs

**Crafter (summary):** The inputs are the snapshot, the 5 current screenshots
and the judge's findings. The outputs are a site doc (`id`, `at`, `template`,
`tiers[{share,pool}]`, `course[[x,z]]`, `rocks[{rule,at,lift,yaw,scale}]`) and
a blobs array (`{id,center:[x,y,z] world,radius,op,falloff,height,topRadius,
scaleX,scaleZ}`). Blob rules:

- Stay within 60 m of the site, and use 40 blobs at most.
- Keep "add" blobs at least half the channel width plus 1 m off the
  centreline.
- Never cut a "remove" blob below the local water level.

Style: grey stone only, asymmetric, nothing floating.

**Judge (summary):** Score WATER FIT, GEOMETRY, ROCK DRESSING, READS AS A
CASCADE and OVERALL, 1–10 each; PASS only if every score is at least 7. Return
3–6 fixes, each tagged with its view and marked "engine" when dressing can't fix
it.
