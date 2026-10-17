# See-through: holes you can see through the map

Mesh audits (DC bake audits, open edges, `voxel-blades`) check mesh data. They miss gaps that only exist on screen:

- a **thin DC shell**: a source wall thinner than about two voxels falls between DC samples, and the baked surface comes
  out closed (zero boundary edges, every audit passes) but perforated. The 2026-10-13 sweep found these along vault springings
  in First King's Barrow and Wreck Hole, where the walls are 0.01-0.4 m thick at a 0.12 m voxel;
- a **seam** between two baked groups that do not overlap;
- a **single-sided** face seen from behind;
- a group **culled** while it is still in sight (`culling.interior` reveal shorter than the sight line);
- a decimated or simplified tier (**open-mesh**) that pinches open.

The see-through gate looks at the screen instead.

## How it works

`packages/render/src/see-through.ts` (pure functions unit-tested in `packages/render/test/see-through.test.ts`) and
`apps/playground/tools/see-through.mts` (the runner):

1. **Sentinel.** The live scene is drawn into small offscreen targets with a pure magenta background. During that one
   synchronous block, the sky dome, particles, sprites, lines and skinned characters are hidden, and the post chain is
   bypassed. Fog is left alone: changing it recompiles every material, and fog never paints a surface magenta. Cluster-LOD
   meshes are re-cut for each view. Everything is restored before the next game frame. This is a debug and test switch
   only, and normal play never runs it.
2. **Route.** Scene mode walks the real player route, in play mode at a pinned hour (`/time 12`, frozen, where the scene has
   a clock). For dungeons the route is the walk gate's legs (`reports/walk.json`, the server-side body's path). For POIs
   it is `--route <walk-route*.json>`, whose 2-D points get their floor from a downward ray, kept continuous along the
   route. A sample is taken every 3.5 m, de-duplicated where routes double back. From player eye height, each sample
   draws six 90° views at 128 px: ±x, ±z, up and down.
3. **Rule.** Magenta pixels are grouped into 4-connected clusters. A cluster is a hole from 6 counted pixels upward.
   - **indoor** (scenes without a `voxelWorld`): every sentinel pixel counts, except rays through an allowed opening.
   - **outdoor** (voxel worlds, POIs): the sky is a legitimate background, so a pixel counts only where a surface must
     be. That means either:
     - its ray is below the horizon and the analytic ground says it meets the ground within 80 m (holes in terrain,
       cliff edges, gaps under built pieces); or
     - its cluster is **enclosed** (it touches no border of the view) and small (at most 4% of the view): a slit
       through a wall, roof, arch or overhang.

     Big enclosed sky, such as an archway, does not count.
   - **enclosed** (prop mode): only enclosed clusters count, at any size. This is light through a hull.
4. **Allowed openings.** Walk-through portal triggers (the `portal` script's box, grown by 1.5 m) are always allowed. List
   real openings (a cave mouth to the outside, a skylight) in `<project>/authoring/see-through-openings.json` as
   `[{ "name", "min": [x,y,z], "max": [x,y,z] }]` or `{ "name", "center", "half" }`. A ray through one of these boxes,
   within 60 m, does not count.
5. **Cause.** Every hole is explained from the scene itself, by ray casts against every surface mesh. Each mesh is tested
   double-sided for the moment of the cast, and hidden meshes are included.
   - The first surface IN the hole decides when there is one (within 1.3× the rim depth):
     - **single-sided**: a back face of a one-sided material;
     - **culled**: a hidden mesh;
     - **cutout**: a drawn front face, from alpha test or sub-pixel slivers.
   - With no surface in the hole, the rim decides. Rays through the nearest surfaces around the hole give the world
     estimate (`at`, `depth`):
     - **seam**: the rim spans two or more entities;
     - **open-mesh**: the rim is one entity's mesh open there;
     - **void**: nothing at all.
6. **Report.** One physical hole is seen from many samples, so holes within 1.5 m merge into a *site*. The output is
   `reports/see-through.json` (`ok`/`passed`, counts by cause, sites with the worst view's eye, direction, depth and
   crop), plus the crops and a `sheet.png` contact sheet of the 24 worst sites. Results are cached by an inputs hash
   (scene file, the project's models, route, openings, options, the tool and the probe), so a re-run with nothing changed
   is instant.

## Commands

The commands run from `apps/playground`. They need Playwright with system Chrome; set `HITREG_PLAYWRIGHT` to the playwright
package dir. The runner starts its own vite on port 5284 (`--port` changes it, `--url` reuses a dev app).

```
node node_modules/tsx/dist/cli.mjs tools/see-through.mts scene <dungeon> --batch 1/3     # then 2/3, 3/3: each < 4 min
node node_modules/tsx/dist/cli.mjs tools/see-through.mts scene <preview> --route <job>/walk-route.json --out <job>/reports/see-through.json
node node_modules/tsx/dist/cli.mjs tools/see-through.mts prop <scene> --entity <id> --out <project>/authoring/prop-reviews/see-through/<id>.json
```

These diagnosis switches only change the cache key:

- `--samples i,j`: just those samples;
- `--dump <entityId>`: what the runtime drew for that entity, and every hit along each hole's ray;
- `--lod-near`: hold every instanced batch at full detail;
- `--lod-full`: cluster LOD at full detail.

Run times on 2026-10-13:

- a dungeon of about 200 samples takes 3 × 2.5-3.5 min;
- a prop review takes about 1.5 min.

## Where it is wired

- **Dungeon pipeline:** the `see-through` stage, after `compare` and before loading art / portal play
  (`tools/dungeon-pipeline/pipeline.mjs`).
- **POI jobs:** `tools/poi-review/job.mjs` **gate 8**. A job whose delivered scene ops add any `mesh` component (built
  structures) needs a passing `reports/see-through.json` that is newer than its ops.
- **Prop catalogue:** `tools/poi-review/catalog-check.mjs`. A catalogued prop at least 8 m on a side, whose model is a DC
  bake (its glTF generator says DC), needs `authoring/prop-reviews/see-through/<id>.json`. That report must be ok and
  newer than the model.

## Fixing what it finds

| cause | fix class |
| --- | --- |
| open-mesh on a DC group, thin there | Thicken the source wall to at least 3 voxels: the vault's outer skin, the arch springing, the hull planking. Alternatively, bake that group at a finer voxel. `node tools/mesh-dc/thin-walls.mjs <stamp.json> --voxel <v> [--plan plan.json]` lists every source wall under the limit, with where it is, before the bake. |
| seam | Overlap the two groups' solids by at least 2 voxels across the joint. Make sure the bake boxes do not clip a cavity. |
| single-sided | Close the mesh, or give the material `side: double`. |
| culled | Raise the scene's `cullingProfile.interiorReveal` (or `"auto"`) past the sight line (docs/culling.md). |
| cutout | Check the alpha-tested material, or a sliver too thin to raster. |
