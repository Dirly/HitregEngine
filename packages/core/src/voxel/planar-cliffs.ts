/**
 * Planar cliffs: steep ground rebuilt from INTERSECTING PLANES, so a dual
 * contourer (`./dual-contouring.ts`) has sharp features to keep.
 *
 * **Why the old cliffs look smeared under DC.** A cliff here is a heightfield
 * riser: density `y - h(x, z)` with `h` a smooth fBm-and-terrace function. DC
 * can only keep a corner the field HAS, and fed lattice-smoothed normals it
 * rounds even those — so on the old field DC gives MC's shape with a slightly
 * different wobble. The density is also not a distance: on a 70-degree face
 * `|grad|` is ~3, which is what made a 4 m "overhang" bulge move the face by a
 * metre and a half. A vertical push in `y - h` cannot make a feature on a
 * vertical face at all.
 *
 * **What this does instead** (opt-in, `terrain.planarCliffs`). Over steep
 * columns the heightfield is DOMAIN-WARPED sideways: the density at `p` is
 * `y - H(p - push(p) * M(x, z))`, where `M` is the outward (downhill) unit
 * direction times a steepness mask, `H` is the lattice heightfield (bilinear
 * between columns — the same thing the mesher can resolve) and `push` is a
 * piecewise-PLANAR displacement in metres:
 *
 * - **strata**: tilted layer planes (`dip`, `azimuth`); each band is pushed out
 *   by its own hashed offset, with a crisp `lip` at its top and a short ramp to
 *   the next band — so every band boundary is a ledge or an overhang made of
 *   two planes meeting at an edge.
 * - **facets**: a 3D Voronoi over the cliff band; each cell is a tilted plane,
 *   separated from its neighbours by planar V-grooves (`groove` x the exact
 *   distance to the Voronoi border, which is itself piecewise linear).
 *
 * Every term is continuous, seed-stable and a pure function of world position,
 * so chunks agree on shared samples and the server and client build the same
 * ground. The mask and warp direction come from a WIDE central difference of
 * `H` (half-width `R` columns >= the largest push), which is what lets the warp
 * reach the columns in front of a face: a column's own slope is ~0 at the foot
 * of a cliff, and the foot is exactly where the pushed-out rock has to appear.
 *
 * **Exact Hermite data.** The mesher gets, per block, a {@link HermiteSource}
 * that evaluates this same function between lattice points, and an `active`
 * flag per sample marking where the sampled value IS that function (caves,
 * blobs, passages and band cuts clear it). DC then refines crossings and takes
 * true gradients on the planes, and the QEF lands on their intersections.
 *
 * Worlds without `terrain.planarCliffs` never construct any of this.
 */

import { z } from "zod";
import { hash3i, perlin2, smoothstep } from "./noise.js";
import type { HermiteSource } from "./dual-contouring.js";
import type { SeaCliffs, SeaColumn } from "./sea-cliffs.js";
import type { Buttes, ButteColumn } from "./buttes.js";

const num = (d: string) => z.number().optional().describe(d);
/** One zone's overrides of the base planarCliffs (see `planarCliffs.zones`). Unset fields keep the base value. */
export const planarZoneSchema = z
  .object({
    region: z.string().optional().describe("recipe.regions id this entry applies to (blended across zoneGround.band)."),
    anchor: z.string().optional().describe("climate.zones.anchors id this entry applies to (blended by zone membership)."),
    strength: z.number().min(0).max(1).optional().describe("Multiplies the cliff mask here: 0 = no planar rock in this zone, 1 = full."),
    minRelief: num("Zone override of minRelief (metres)."),
    fullRelief: num("Zone override of fullRelief (metres)."),
    slopeStart: num("Zone override of slopeStart (0..1)."),
    slopeEnd: num("Zone override of slopeEnd (0..1)."),
    strata: z
      .object({ thickness: num("Metres per stratum band."), offset: num("Metres a band can stand out."), lip: num("Extra metres a band's top juts out."), dip: num("Radians of strata dip."), azimuth: num("Radians: dip direction."), ramp: num("Metres a band hands over in."), seed: z.number().int().optional() })
      .optional()
      .describe("Strata overrides (planarCliffs.strata fields)."),
    terrace: z
      .object({
        step: num("Typical riser height, metres."),
        cell: num("Wall-plane size, metres."),
        jog: num("Metres a wall plane may stand off the smooth contour."),
        pinchStart: num("Tread pinch threshold (0..1)."),
        pinchScale: num("Metres per pinch-noise cycle."),
        dominant: num("Share of dominant risers (0..1)."),
        levelJitter: num("Tread level wander (fraction of step)."),
        lip: num("Riser lip, metres."),
        talus: num("Scree apron height (fraction of riser)."),
        crackRate: num("Share of joints that open into chimneys."),
        crackDepth: num("Chimney depth, metres."),
        seed: z.number().int().optional(),
      })
      .optional()
      .describe("Terrace overrides (planarCliffs.terrace fields)."),
  })
  .describe("One zone's planar-cliff look. Set exactly one of `region` / `anchor`.");
export type PlanarZoneDoc = z.infer<typeof planarZoneSchema>;

/**
 * Rock built AROUND water instead of faded away from it (`planarCliffs.falls`). Every wall here is cut, never
 * built up: ground between two levels is lowered to the lower one and the wall stands at the contour, so a
 * waterline, a bank's water reach and a road solved on the old ground never sit under new rock.
 */
export const planarFallsSchema = z
  .object({
    lip: z
      .boolean()
      .default(true)
      .describe(
        "At every waterfall, a hard vertical wall ON the lip line (the line that already decides the carve, the water, the " +
          "rims and the chunk cut): upstream of it the ground is the upper bed and its banks carried right to the line, past " +
          "it the plunge pool's floor carried right back to it, so the curtain drops over a sheer face.",
      ),
    foot: z.number().min(0.2).default(0.5).describe("Metres a wall's foot (the rock shelf it stands on) stands over the water beside it. Above the water, so the shoreline stays where the carve put it."),
    bowl: z.number().int().min(1).max(4).default(2).describe("Sheer walls the plunge bowl's sides climb in, from the pool to the upper water (1 = one wall the height of the drop)."),
    gorgeStep: z.number().positive().default(7).describe("Metres per bench of the stepped gorge below a fall."),
    gorgeLength: z.number().min(0).default(1).describe("Gorge (stepped walls) length as a multiple of the drop, before it eases to the banks; capped inside the fall's band."),
    fill: z
      .number()
      .min(0)
      .max(0.5)
      .default(0.3)
      .describe("Share of a bench a wall may stand forward of its tread's contour (rock built up to the tread level). 0 = purely cut: widest shelves at each wall's foot."),
    bankSteps: z.number().int().min(1).max(6).default(1).describe("Benches the bank walls climb in (each `banks` metres): 1 = one low wall, 3+ = a stepped canyon where a river runs deep in cliff country."),
    banks: z.number().min(0).default(4).describe("Height (metres) of the low rock walls a river or lake gets where it cuts through cliff country (where the cliff mask would be, before featureClearance). 0 = none."),
    bankReach: z
      .tuple([z.number().min(0), z.number().min(0)])
      .default([5, 12])
      .describe("Metres from the bank's foot over which the bank walls fade out (full inside the first)."),
  })
  .describe(
    "OPT-IN, 'terrace' profile: waterfalls, plunge bowls, gorges and banks as DC rock instead of fading rock out near " +
      "water (featureClearance still keeps the terrace cliffs off them). Absent = unchanged, byte for byte.",
  );
export type PlanarFallsDoc = z.infer<typeof planarFallsSchema>;

export const planarCliffsSchema = z
  .object({
    slopeStart: z
      .number()
      .min(0)
      .max(1)
      .default(0.6)
      .describe("Steepness (sin of the slope angle, over a wide stencil) where ground starts turning into planar rock. 0.6 is 37 degrees."),
    slopeEnd: z.number().min(0).max(1).default(0.82).describe("Steepness where the planar rock is in full. 0.82 is 55 degrees."),
    overhangSuppress: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Fraction of `terrain.overhang`'s fBm bulge removed where planar rock is in full. The bulge is the 'smeared wall' look; 1 replaces it outright."),
    strata: z
      .object({
        thickness: z.number().positive().default(8).describe("Metres per stratum band, measured along the layer normal. Keep it at least ~4 voxels so each band can hold its own ledge and lip: a feature thinner than a voxel makes the QEF fold triangles over (measured: 0.1% of the area at 5 m on 2 m voxels, 0.01% at 8 m)."),
        dip: z.number().min(0).max(1.2).default(0.15).describe("Radians the layer planes tilt from horizontal. 0 = level ledges (contour-map look); 0.1-0.3 reads as bedded rock."),
        azimuth: z.number().default(0.7).describe("Radians: the compass direction the strata dip toward."),
        offset: z.number().min(0).default(1.6).describe("Metres a band can stand out from the face: each band draws its own push in [0, offset] from a hash, so neighbouring bands make ledges and set-backs."),
        lip: z.number().min(0).default(1).describe("Extra metres the TOP of each band juts out: a crisp overhanging lip with a planar underside. 0 = no lips."),
        lipHeight: z.number().min(0).max(0.5).default(0.3).describe("Fraction of the band's thickness the lip occupies."),
        ramp: z.number().positive().default(1.2).describe("Metres over which one band's push hands over to the next. Short = a sharper ledge edge, but keep it near the voxel size: below it DC folds triangles over the ramp."),
        seed: z.number().int().default(71),
      })
      .prefault({})
      .describe("Tilted strata: the layer planes and the per-band offsets that turn a riser into ledges, set-backs and lips."),
    facets: z
      .object({
        size: z.number().positive().default(12).describe("Metres between Voronoi sites: the typical facet width. Keep it at several voxels or the facets alias."),
        depth: z.number().min(0).default(1.5).describe("Metres a facet stands proud of the face at most. 0 = no facets."),
        groove: z.number().positive().default(0.45).describe("Slope of the V-groove flanks between facets (push per metre of distance to the cell border). Lower = wider, shallower joints."),
        tilt: z.number().min(0).default(0.2).describe("How far each facet's plane tilts off the face (push per metre across the facet)."),
        jitter: z.number().min(0).max(1).default(0.8).describe("How far each site wanders inside its grid cell (0 = a regular grid of facets)."),
        seed: z.number().int().default(173),
      })
      .prefault({})
      .describe("Faceted faces: a 3D Voronoi over the cliff band, one tilted plane per cell, planar grooves between."),
    profile: z
      .enum(["warp", "terrace"])
      .default("warp")
      .describe(
        "How steep ground is rebuilt. 'warp' (v1): the heightfield's own slope, pushed sideways by strata and facets — " +
          "a rough steep hillside. 'terrace' (v2): vertical WALLS — flat treads at quantized heights, risers made of big " +
          "planes (one per Voronoi cell), hard lip and foot, chimney cracks, strata ledges. Use 'terrace' for cliffs.",
      ),
    terrace: z
      .object({
        step: z.number().positive().default(26).describe("Typical riser height in metres; the sequence mixes dominant walls and small steps around it (see dominant). Each tread is flat at its level."),
        levelJitter: z.number().min(0).max(1).default(0.35).describe("How far the tread levels wander (smoothly, over ~140 m), as a fraction of the step, so walls do not share one set of altitudes."),
        cell: z.number().positive().default(16).describe("Metres between the 2D Voronoi sites: the width of one flat plane of wall. Keep it 6-20 m (several voxels)."),
        jitter: z.number().min(0).max(1).default(0.85).describe("How far each site wanders in its grid cell (0 = a regular grid of wall planes)."),
        crackRate: z.number().min(0).max(1).default(0.3).describe("Share of plane-to-plane joints that open into a chimney."),
        crackDepth: z.number().min(0).default(2.5).describe("Metres a chimney cuts back into the wall at its joint."),
        crackWidth: z.number().positive().default(2.2).describe("Half-width in metres of a chimney's V at the face."),
        lip: z.number().min(0).default(1.2).describe("Metres the top of every riser juts out: the overhanging lip under the tread edge."),
        lipHeight: z.number().min(0).default(2.5).describe("Metres below the tread the lip starts."),
        dominant: z.number().min(0).max(1).default(0.35).describe("Share of risers that are DOMINANT walls (0.75-1.65 x step tall); the rest are small steps (0.22-0.47 x step)."),
        pinchStart: z.number().min(0).max(1).default(0.45).describe("Noise level above which a tread pinches out (its riser comes forward to the one below): higher = more continuous rings, lower = more single tall faces."),
        pinchScale: z.number().positive().default(70).describe("Metres per cycle of the pinch noise: how long a tread runs before it ends."),
        talus: z.number().min(0).default(0.28).describe("Scree apron height at a riser's foot, as a fraction of that riser's height (37-degree slope, varied by noise). 0 = none."),
        jog: z.number().min(0).default(3.5).describe("Metres a wall plane may stand off the smooth contour. The joint between two planes is at most twice this: bigger = blockier, smaller = a smoother plan."),
        lipRamp: z.number().positive().default(1.2).describe("Metres over which the lip's underside slopes out (near the voxel size: thinner folds triangles)."),
        seed: z.number().int().default(419),
      })
      .prefault({})
      .describe("The 'terrace' profile's walls: riser height, wall planes, chimneys and lips."),
    minRelief: z
      .number()
      .min(0)
      .default(0)
      .describe(
        "Metres of LOCAL RELIEF (the height range within +-16 m, read on an 8 m lattice) below which steep ground stays " +
          "smooth: planar rock fades in between 0.6x and 1x this. Keeps a small steep hill from turning into one cubic " +
          "block (a 26 m riser on a 20 m knoll). 0 = no relief test (every steep column qualifies).",
      ),
    fullRelief: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Relief (metres) at which wall planes jog in full. Between minRelief and this the plane jog and step-back shrink, " +
          "so a modest hill gets a smoother plan instead of castle blocks. Default 2.5x minRelief; ignored when minRelief is 0.",
      ),
    featureClearance: z
      .tuple([z.number().min(0), z.number().min(0)])
      .default([4, 16])
      .describe(
        "Metres from the nearest river, lake, road or town edge (field.featureClearance) over which planar rock fades in: " +
          "none inside the first, full past the second. Keeps channels, falls, roads and towns on the ground they were " +
          "solved and crafted on (13 of proving's 14 falls stand on cliff-mask ground), and the water sheet clipped by " +
          "the heightfield it was built for. [0, 0] = no fade.",
      ),
    dcMargin: z
      .number()
      .min(0)
      .default(8)
      .describe(
        "voxelWorld.mesher 'auto': a cell is meshed by dual contouring when any planar mask lies within the cell plus this " +
          "many metres, by marching cubes otherwise. The margin is what puts every MC/DC border on smooth ground: at 0 the " +
          "border can fall inside the cliff band and open holes; 8 m (4 voxels) keeps the field on both sides unaltered.",
      ),
    zoneBlend: z
      .number()
      .min(1)
      .default(24)
      .describe(
        "Metres over which one zone's cliff look hands over to the next (region entries). Narrower than zoneGround.band " +
          "on purpose: zone borders follow ridges and cliffs, and inside the band both looks are evaluated (measured: " +
          "the 150 m ground band made cliff chunks ~1.7x dearer; a cliff 12 m from a border still pays ~1.4x at 40 m).",
      ),
    zones: z
      .array(planarZoneSchema)
      .default([])
      .describe(
        "Per-zone variation: each entry overrides riser height, plane size, pinch, strata, strength or relief for one " +
          "REGION (recipe.regions id, blended across zoneGround.band) or one climate ANCHOR (blended by zone membership). " +
          "A region entry wins over an anchor entry. 'terrace' profile only. Empty = one look everywhere.",
      ),
    falls: planarFallsSchema.optional(),
  })
  .describe(
    "OPT-IN, built for the dual-contouring mesher (voxelWorld.mesher 'dc'). profile 'terrace' (v2, the one to use) rebuilds steep ground as vertical walls and flat treads; profile 'warp' (v1): steep ground is domain-warped sideways by a " +
      "piecewise-PLANAR displacement (tilted strata with lips + Voronoi facets), and the mesher gets exact Hermite data " +
      "for it, so cliffs come out as sharp planes meeting at edges instead of smoothed voxel walls. Marching cubes " +
      "meshes the same field but rounds every edge at lattice resolution. Absent = the field is unchanged, byte for byte.",
  );

export type PlanarCliffsDoc = z.infer<typeof planarCliffsSchema>;

const U32 = 4294967296;

export interface PlanarCliffs {
  readonly spec: PlanarCliffsDoc;
  /** Upper bound of `push` in metres — how far rock can move off the heightfield. */
  readonly maxPush: number;
  /** Outward push in metres at a world point (>= 0, <= maxPush). */
  push(x: number, y: number, z: number): number;
  /** The strata term of `push` alone (the terrace profile's ledges). */
  strataPush(x: number, y: number, z: number): number;
  /** Wide-stencil half-width in lattice columns for a lattice of `step` metres. */
  stencil(step: number): number;
  /** Steepness mask from a wide-stencil gradient. */
  mask(gx: number, gz: number): number;
}

export function createPlanarCliffs(spec: PlanarCliffsDoc, worldSeed: number): PlanarCliffs {
  const st = spec.strata, fa = spec.facets;
  const strataOn = st.offset > 0 || st.lip > 0;
  const facetsOn = fa.depth > 0;
  const maxPush = spec.profile === "terrace"
    ? (strataOn ? st.offset + st.lip : 0) + spec.terrace.lip
    : (strataOn ? st.offset + st.lip : 0) + (facetsOn ? fa.depth : 0);
  const nsx = Math.sin(st.dip) * Math.cos(st.azimuth), nsy = Math.cos(st.dip), nsz = Math.sin(st.dip) * Math.sin(st.azimuth);
  const sSeed = (worldSeed + st.seed * 7919) | 0, fSeed = (worldSeed + fa.seed * 104729) | 0;
  const T = st.thickness;
  const rU = Math.min(0.3, st.ramp / T), lH = Math.min(0.5 - rU, st.lipHeight);
  const u1 = 1 - lH - rU, u2 = 1 - lH, u3 = 1 - rU;
  const bandOffset = (b: number): number => st.offset * (hash3i(b, 17, 0, sSeed) / U32);

  function strata(x: number, y: number, z: number): number {
    const s = (x * nsx + y * nsy + z * nsz) / T;
    const b = Math.floor(s), u = s - b;
    const ob = bandOffset(b);
    if (u < u1) return ob;
    if (u < u2) return ob + (st.lip * (u - u1)) / rU;
    if (u < u3) return ob + st.lip;
    const on = bandOffset(b + 1);
    return ob + st.lip + ((on - ob - st.lip) * (u - u3)) / rU;
  }

  const S = fa.size, J = fa.jitter;
  const site = (ix: number, iy: number, iz: number, out: Float64Array, o: number): void => {
    out[o] = ix + 0.5 + (hash3i(ix, iy, iz, fSeed) / U32 - 0.5) * J;
    out[o + 1] = iy + 0.5 + (hash3i(ix, iy, iz, fSeed + 1) / U32 - 0.5) * J;
    out[o + 2] = iz + 0.5 + (hash3i(ix, iy, iz, fSeed + 2) / U32 - 0.5) * J;
  };
  const sq = new Float64Array(3);
  const sx = new Float64Array(27), sy = new Float64Array(27), sz = new Float64Array(27), sd = new Float64Array(27);
  // Sites outside p's 3x3x3 block are at least this far from p (cell units): one whole cell plus the
  // closest a jittered site can sit to its own cell's near face.
  const farSite = 1 + (0.5 - J / 2);
  function facets(x: number, y: number, z: number): number {
    const px = x / S, py = y / S, pz = z / S;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    // pass 1: the 27 sites around p, and the nearest
    let bi = 0, n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++, n++) {
      site(ix + dx, iy + dy, iz + dz, sq, 0);
      sx[n] = sq[0]!; sy[n] = sq[1]!; sz[n] = sq[2]!;
      const ex = sq[0]! - px, ey = sq[1]! - py, ez = sq[2]! - pz;
      sd[n] = ex * ex + ey * ey + ez * ez;
      if (sd[n]! < sd[bi]!) bi = n;
    }
    const bx = sx[bi]!, by = sy[bi]!, bz = sz[bi]!;
    const cx = ix + (bi % 3) - 1, cy = iy + (Math.floor(bi / 3) % 3) - 1, cz = iz + Math.floor(bi / 9) - 1;
    const h0 = hash3i(cx, cy, cz, fSeed + 3) / U32;
    const tx = (hash3i(cx, cy, cz, fSeed + 4) / U32 - 0.5) * 2 * fa.tilt;
    const ty = (hash3i(cx, cy, cz, fSeed + 5) / U32 - 0.5) * 2 * fa.tilt;
    const tz = (hash3i(cx, cy, cz, fSeed + 6) / U32 - 0.5) * 2 * fa.tilt;
    const plane = fa.depth * (0.35 + 0.65 * h0) + ((px - bx) * tx + (py - by) * ty + (pz - bz) * tz) * S;
    if (plane <= 0) return 0;
    // Distance to the cell's border = min over other sites of the distance to their bisector
    // (piecewise LINEAR in p: planar grooves). Exact for the 26 we hold; the rest are bounded below.
    const need = plane / (fa.groove * S);
    let border = Infinity;
    const di2 = sd[bi]!;
    for (let j = 0; j < 27; j++) {
      if (j === bi) continue;
      const ux = sx[j]! - bx, uy = sy[j]! - by, uz = sz[j]! - bz, l = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (l < 1e-9) continue;
      const d = (sd[j]! - di2) / (2 * l);
      if (d < border) border = d;
    }
    const outside = (farSite - Math.sqrt(di2)) / 2;
    if (outside < border && outside < need) {
      // a site beyond the 27 could own the nearest border: check the nearest cell's own ring
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ox = cx + dx - ix, oy = cy + dy - iy, oz = cz + dz - iz;
        if (ox >= -1 && ox <= 1 && oy >= -1 && oy <= 1 && oz >= -1 && oz <= 1) continue; // already held
        site(cx + dx, cy + dy, cz + dz, sq, 0);
        const ux = sq[0]! - bx, uy = sq[1]! - by, uz = sq[2]! - bz, l = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (l < 1e-9) continue;
        const ex = sq[0]! - px, ey = sq[1]! - py, ez = sq[2]! - pz;
        const d = (ex * ex + ey * ey + ez * ez - di2) / (2 * l);
        if (d < border) border = d;
      }
    }
    const v = Math.min(plane, fa.groove * Math.max(0, border) * S);
    return v > fa.depth ? fa.depth : v;
  }

  return {
    spec,
    maxPush,
    strataPush(x, y, z) {
      return strataOn ? strata(x, y, z) : 0;
    },
    push(x, y, z) {
      let v = 0;
      if (strataOn) v += strata(x, y, z);
      if (facetsOn) v += facets(x, y, z);
      return v;
    },
    stencil(step) {
      return Math.max(1, Math.ceil((maxPush + step) / step));
    },
    mask(gx, gz) {
      const g = Math.sqrt(gx * gx + gz * gz);
      return smoothstep(spec.slopeStart, spec.slopeEnd, g / Math.sqrt(1 + g * g));
    },
  };
}


/**
 * The "terrace" profile (v2): steep ground becomes WALLS. The heightfield is
 * replaced, inside the cliff mask, by a union of slabs: slab k is the rock
 * under tread height `b_k` and inside the contour `h = b_k`. Treads are flat
 * planes, risers are vertical, the lip is the tread/riser corner and the foot
 * the riser/lower-tread corner — every one of them an intersection of planes,
 * which is exactly what dual contouring keeps.
 *
 * The contour is made of BIG PLANES: the heightfield is linearised once per 2D
 * Voronoi cell (`cell` metres), so each cell's piece of wall is one flat plane;
 * neighbouring cells' planes jog at the cell border — the vertical joints of a
 * blocky face. A hashed share of those borders open into chimneys (planar
 * V-cracks). Strata (the shared `strata` push) stand out of the walls as
 * irregular ledges, and each riser's top juts out as a lip.
 *
 * The density returned is metric (horizontal distance through walls, vertical
 * through treads), so it blends with a normalised smooth field at the mask's edge.
 */
export interface TerraceCliffs {
  /** Metric signed distance-ish of the terraced rock at a world point (negative = rock). */
  density(x: number, y: number, z: number, h: number, g: number): number;
  /** How far below a column's ground the terraced rock can open up (one riser plus jitter). */
  readonly depth: number;
  /**
   * With features (falls, banks, sea cliffs): the WHOLE planar value at a point, given the lattice height `hb`,
   * the column cosine `cc`, the bilinear cliff-only mask `wc` and a bilinear sampler of the lattice heights `H`
   * (the block's or the point query's — the same numbers). Absent = `dS + w * (density - dS)`.
   */
  blend?(x: number, y: number, z: number, hb: number, cc: number, wc: number, H: (x: number, z: number) => number): number;
  /** With features: the cliff-only mask of a column (the combined one gates the planar path). */
  cliffMask?(x: number, z: number, gx: number, gz: number): number;
  /** With features: the lowest y a column's planar band must reach (an arch opening under a fin, a stack's foot). */
  floorAt?(x: number, z: number): number;
}

export function createTerraceCliffs(
  pc: PlanarCliffs,
  worldSeed: number,
  height: (x: number, z: number) => number,
  /** 0..1 per column: scales the wall-plane jog and step-back (1 = full blockiness). Omit = 1. */
  soften?: (x: number, z: number) => number,
): TerraceCliffs {
  const tc = pc.spec.terrace;
  const F = tc.cell, J = tc.jitter, S = tc.step;
  const seed = (worldSeed + tc.seed * 7907) | 0;
  // per-site cache: [sx, sz, h, gx, gz, level offset]
  const sites = new Map<number, Float64Array>();
  const site = (I: number, K: number): Float64Array => {
    const key = (I + 1048576) * 2097152 + (K + 1048576);
    let s = sites.get(key);
    if (s) return s;
    if (sites.size > 50000) sites.clear();
    s = new Float64Array(6);
    const sx = (I + 0.5 + (hash3i(I, K, 1, seed) / U32 - 0.5) * J) * F;
    const sz = (K + 0.5 + (hash3i(I, K, 2, seed) / U32 - 0.5) * J) * F;
    const e = 2;
    s[0] = sx; s[1] = sz; s[2] = height(sx, sz);
    s[3] = (height(sx + e, sz) - height(sx - e, sz)) / (2 * e);
    s[4] = (height(sx, sz + e) - height(sx, sz - e)) / (2 * e);
    s[5] = (hash3i(I, K, 3, seed) / U32) * S * tc.levelJitter;
    sites.set(key, s);
    return s;
  };
  // The three slow noises (tread pinch and talus per riser, ~70 m and ~60 m; tread level wander, ~140 m) on a
  // cached 4 m lattice, bilinear between nodes: a column change used to pay up to nine perlin evaluations, and
  // the Hermite refinement changes column at nearly every evaluation. A pure function of (x, z) like the rest.
  const NQ = 4, NSLOTS = 1 << 16, NMASK = NSLOTS - 1;
  const slotI = new Int32Array(NSLOTS).fill(-2147483648), slotK = new Int32Array(NSLOTS), slotC = new Int32Array(NSLOTS), slotV = new Float64Array(NSLOTS);
  const nodeNoise = (I: number, K: number, ch: number): number => {
    const h = (Math.imul(I, 73856093) ^ Math.imul(K, 19349663) ^ Math.imul(ch + 7, 83492791)) & NMASK;
    if (slotI[h] === I && slotK[h] === K && slotC[h] === ch) return slotV[h]!;
    const x = I * NQ, z = K * NQ;
    const v = ch === -1 ? perlin2(x / 140, z / 140, seed)
      : ch & 1 ? perlin2(x / 60, z / 60, (seed + (ch >> 1) * 71) | 0)
      : perlin2(x / tc.pinchScale, z / tc.pinchScale, (seed + (ch >> 1) * 131) | 0);
    slotI[h] = I; slotK[h] = K; slotC[h] = ch; slotV[h] = v;
    return v;
  };
  const lowNoise = (x: number, z: number, ch: number): number => {
    const fx = x / NQ, fz = z / NQ, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
    return (nodeNoise(I, K, ch) * (1 - tx) + nodeNoise(I + 1, K, ch) * tx) * (1 - tz) + (nodeNoise(I, K + 1, ch) * (1 - tx) + nodeNoise(I + 1, K + 1, ch) * tx) * tz;
  };
  const crackSeed = (seed + 977) | 0;
  const isCrack = (a: number, b: number, c: number, d: number): boolean => {
    // order-independent pair hash: both cells see the same border
    const lo = a < c || (a === c && b < d) ? [a, b, c, d] : [c, d, a, b];
    return hash3i(lo[0]! * 7919 + lo[1]!, lo[2]! * 7919 + lo[3]!, 5, crackSeed) / U32 < tc.crackRate;
  };
  // the riser sequence: one global, seeded list of tread levels with uneven gaps — mostly small
  // steps, sometimes a dominant wall — so a cliff is one big face plus a few ledges, not rings
  const levels: number[] = [];
  for (let k = -60, b = -400; k <= 60 && b < 1200; k++) {
    levels.push(b);
    const r = hash3i(k, 11, 0, seed) / U32;
    b += r < tc.dominant ? S * (0.75 + (hash3i(k, 12, 0, seed) / U32) * 0.9) : S * (0.22 + (hash3i(k, 13, 0, seed) / U32) * 0.25);
  }
  let cJog = tc.jog, cX = NaN, cZ = NaN, cH = NaN, cG = NaN, cBorder = 0, cG2 = 1, cHpp = 0, cShift = 0, cCrack = 0, cOff = 0, cInv = 1, stamp = 0;
  const wStamp = new Int32Array(levels.length), pStamp = new Int32Array(levels.length);
  const wMemo = new Float64Array(levels.length), pMemo = new Float64Array(levels.length), tMemo = new Float64Array(levels.length);
  const wallAt = (k: number): number => {
    if (wStamp[k] === stamp) return wMemo[k]!;
    const bk = levels[k]! + cOff;
    const smooth = (bk - cH) * cInv, flat = (bk - cHpp) / cG2 + cShift;
    // the cell's plane, held within `jog` of the smooth contour and faded to it over the last
    // 2 m before the joint: big flat planes that turn and step back at joints, continuous there
    const w = smooth + Math.max(-cJog, Math.min(cJog, flat - smooth)) * Math.min(1, cBorder / 2);
    wStamp[k] = stamp; wMemo[k] = w;
    return w;
  };
  const pinchAt = (k: number): number => {
    if (pStamp[k] === stamp) return pMemo[k]!;
    const v = smoothstep(tc.pinchStart, tc.pinchStart + 0.25, lowNoise(cX, cZ, k * 2) * 0.5 + 0.5);
    const t = 0.35 + 0.65 * (lowNoise(cX, cZ, k * 2 + 1) * 0.5 + 0.5);
    pStamp[k] = stamp; pMemo[k] = v; tMemo[k] = t;
    return v;
  };
  const near = new Array<Float64Array>(9), nI = new Int32Array(9), nK = new Int32Array(9), d2 = new Float64Array(9);
  let nearI = NaN, nearK = NaN;
  const farSite = 1 + (0.5 - J / 2);
  return {
    depth: S * (1.65 + tc.levelJitter) + 2,
    density(x, y, z, hSmooth, gSmooth) {
      // Everything but the strata push and the level window depends on (x, z) only, and the
      // callers walk columns (the bulk sampler down j, the gradient at +-e): memo the column.
      if (x !== cX || z !== cZ || hSmooth !== cH || gSmooth !== cG) {
        cX = x; cZ = z; cH = hSmooth; cG = gSmooth; stamp++;
        cJog = soften ? tc.jog * soften(x, z) : tc.jog;
        const px = x / F, pz = z / F, I = Math.floor(px), K = Math.floor(pz);
        let bi = 0, n = 0;
        // consecutive columns mostly share a Voronoi cell: reuse its 3x3 sites instead of nine map lookups
        const same = I === nearI && K === nearK;
        nearI = I; nearK = K;
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++, n++) {
          const st = same ? near[n]! : site(I + di, K + dk);
          if (!same) { near[n] = st; nI[n] = I + di; nK[n] = K + dk; }
          const ex = st[0]! / F - px, ez = st[1]! / F - pz;
          d2[n] = ex * ex + ez * ez;
          if (d2[n]! < d2[bi]!) bi = n;
        }
        const st = near[bi]!;
        // distance to this cell's border (cell units), and whether that border is a crack
        let border = Infinity, crack = false;
        for (let j = 0; j < 9; j++) {
          if (j === bi) continue;
          const o = near[j]!, ux = (o[0]! - st[0]!) / F, uz = (o[1]! - st[1]!) / F, l = Math.sqrt(ux * ux + uz * uz);
          if (l < 1e-9) continue;
          const d = (d2[j]! - d2[bi]!) / (2 * l);
          if (d < border) { border = d; crack = isCrack(nI[bi]!, nK[bi]!, nI[j]!, nK[j]!); }
        }
        border = Math.min(border, (farSite - Math.sqrt(d2[bi]!)) / 2); // bound only matters for the crack test
        cBorder = border * F;
        // the cell's plane of the heightfield
        const gx = st[3]!, gz = st[4]!;
        cG2 = Math.max(0.05, Math.sqrt(gx * gx + gz * gz));
        cHpp = st[2]! + gx * (x - st[0]!) + gz * (z - st[1]!);
        // each wall plane stands a little in front of or behind its neighbours: the face steps back at joints
        cShift = (hash3i(nI[bi]!, nK[bi]!, 7, seed) / U32 - 0.5) * 2 * cJog * 0.8;
        cCrack = crack && cBorder < tc.crackWidth ? tc.crackDepth * (1 - cBorder / tc.crackWidth) : 0;
        // tread levels wander with a smooth, low-frequency noise — continuous, so treads tilt gently
        cOff = (lowNoise(x, z, -1) * 0.5 + 0.5) * S * tc.levelJitter;
        cInv = 1 / Math.max(0.05, gSmooth);
      }
      const borderM = cBorder, g = cG2, hpp = cHpp, cellShift = cShift, off = cOff, inv = cInv;
      // horizontal push out of the wall: strata ledges (+), chimney cracks (-)
      const push = pc.strataPush(x, y, z) - cCrack;
      // which riser y is on: an UNEVEN global sequence (a few dominant walls, more small steps)
      let kc = 0;
      { let lo = 0, hi = levels.length - 1; const v = y - off; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (levels[mid]! <= v) lo = mid; else hi = mid - 1; } kc = lo; }
      let best = Infinity;
      for (let k = Math.max(1, kc - 1); k <= Math.min(levels.length - 2, kc + 2); k++) {
        const b = levels[k]! + off, below = levels[k - 1]! + off;
        // PINCH: where a smooth noise says so, riser k comes forward to riser k-1 and the tread
        // between them vanishes — rings break and end, and some stretches are one tall face
        const pinch = pinchAt(k);
        const wk = wallAt(k), wb = wallAt(k - 1);
        const lip = tc.lip * Math.min(1, Math.max(0, (y - (b - tc.lipHeight)) / tc.lipRamp));
        const wall = wk + (wb - wk) * pinch - push - lip;
        const slab = Math.max(y - b, wall);
        // TALUS: a 37-degree apron of scree at the riser's foot, on the tread below it
        const th = tc.talus * (b - below) * tMemo[k]! * (1 - pinch);
        const talus = th > 0.3 ? Math.max((y - below - th + 0.75 * Math.max(0, wall)) * 0.8, wb - push) : Infinity;
        const t = Math.min(slab, talus);
        if (t < best) best = t;
      }
      return best;
    },
  };
}

/**
 * One block's view of the planar field: the lattice heights it needs (a ring
 * wide enough for the warp and the wide stencil), per-column warp vectors and
 * the per-column y band the warp can matter in.
 */
export interface PlanarBlock {
  /** Ring of extra columns held around the block. */
  readonly ring: number;
  /** Lattice height at block column (i, k); i, k may run `ring` past the block. */
  heightAt(i: number, k: number): number;
  /** Warp mask (0..1) per block column (i + k * nx). */
  readonly m: Float32Array;
  /** Lowest / highest y (inclusive) in which a sample of this column takes the planar value. */
  readonly lo: Float32Array;
  readonly hi: Float32Array;
  /** `y - H(warped)` at a world point inside the block (bilinear warp vector between columns). */
  base(x: number, y: number, z: number): number;
}

export function planarBlock(
  pc: PlanarCliffs,
  height: (x: number, z: number) => number,
  /** The cliff mask at a lattice column from its wide-stencil gradient (see `createPlanarGate`). */
  maskAt: (x: number, z: number, gx: number, gz: number) => number,
  ox: number,
  oz: number,
  nx: number,
  nz: number,
  step: number,
  terr?: TerraceCliffs,
): PlanarBlock {
  const R = pc.stencil(step);
  const reachCols = Math.ceil(pc.maxPush / step) + 1;
  // +1: the mask is also needed one column OUTSIDE the block (the band test below reads true neighbours)
  const ring = Math.max(R, reachCols) + 1;
  const ex = nx + 2 * ring, ez = nz + 2 * ring;
  const H = new Float64Array(ex * ez);
  for (let k = 0; k < ez; k++) {
    const wz = oz + (k - ring) * step;
    for (let i = 0; i < ex; i++) H[i + k * ex] = height(ox + (i - ring) * step, wz);
  }
  const hAt = (i: number, k: number): number => H[i + ring + (k + ring) * ex]!;
  const m = new Float32Array(nx * nz), mx = new Float64Array(nx * nz), mz = new Float64Array(nx * nz), cs = new Float64Array(nx * nz);
  const lo = new Float32Array(nx * nz).fill(Infinity), hi = new Float32Array(nx * nz).fill(-Infinity);
  const inv = 1 / (2 * R * step);
  // features (falls, banks, sea cliffs) can stand on flat ground, and keep a cliff-only mask of their own
  const feat = terr?.blend !== undefined;
  const mc = feat ? new Float32Array(nx * nz) : null;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const gx = (hAt(i + R, k) - hAt(i - R, k)) * inv, gz = (hAt(i, k + R) - hAt(i, k - R)) * inv;
    const c = i + k * nx;
    const g = Math.sqrt(gx * gx + gz * gz);
    const w = g > 1e-9 || feat ? maskAt(ox + i * step, oz + k * step, gx, gz) : 0;
    if (mc) mc[c] = g > 1e-9 ? terr!.cliffMask!(ox + i * step, oz + k * step, gx, gz) : 0;
    m[c] = w;
    cs[c] = 1 / Math.sqrt(1 + g * g);
    // outward = downhill = -grad
    mx[c] = g > 1e-9 ? (-gx / g) * w : 0;
    mz[c] = g > 1e-9 ? (-gz / g) * w : 0;
  }
  const outsideMask = (i: number, k: number): number => {
    const gx = (hAt(i + R, k) - hAt(i - R, k)) * inv, gz = (hAt(i, k + R) - hAt(i, k - R)) * inv;
    return Math.sqrt(gx * gx + gz * gz) > 1e-9 || feat ? maskAt(ox + i * step, oz + k * step, gx, gz) : 0;
  };
  // A sample can take the planar value only where some column within reach is
  // warped; there, the warped height lies within the reach neighbourhood's range.
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const c = i + k * nx;
    let any = false;
    for (let dk = -1; dk <= 1 && !any; dk++) for (let di = -1; di <= 1 && !any; di++) {
      const ii = i + di, kk = k + dk;
      // a neighbour outside the block counts too, as it does for the point query (`planarPoint`'s column):
      // testing only inside the block let two blocks disagree about an edge column and open a seam
      if (ii >= 0 && kk >= 0 && ii < nx && kk < nz ? m[ii + kk * nx]! > 0 : outsideMask(ii, kk) > 0) any = true;
    }
    if (!any) continue;
    let a = Infinity, b = -Infinity;
    for (let dk = -reachCols; dk <= reachCols; dk++) for (let di = -reachCols; di <= reachCols; di++) {
      const h = hAt(i + di, k + dk);
      if (h < a) a = h;
      if (h > b) b = h;
    }
    lo[c] = a - step - (terr ? terr.depth : 0);
    if (terr?.floorAt) lo[c] = Math.min(lo[c]!, terr.floorAt(ox + i * step, oz + k * step));
    hi[c] = b + step + (terr ? pc.maxPush : 0);
  }
  /** Bilinear lattice height at a world point over the ring-extended grid (features sample a few metres off the point). */
  const sampleH = (x: number, z: number): number => {
    const fx = (x - ox) / step + ring, fz = (z - oz) / step + ring;
    let i = Math.floor(fx), k = Math.floor(fz);
    if (i < 0) i = 0; else if (i > ex - 2) i = ex - 2;
    if (k < 0) k = 0; else if (k > ez - 2) k = ez - 2;
    const u = fx - i, v = fz - k, at = i + k * ex;
    return (H[at]! * (1 - u) + H[at + 1]! * u) * (1 - v) + (H[at + ex]! * (1 - u) + H[at + ex + 1]! * u) * v;
  };
  const base = (x: number, y: number, z: number): number => {
    if (terr) {
      const fx = (x - ox) / step, fz = (z - oz) / step;
      let i0 = Math.floor(fx), k0 = Math.floor(fz);
      if (i0 < 0) i0 = 0; else if (i0 > nx - 2) i0 = nx - 2;
      if (k0 < 0) k0 = 0; else if (k0 > nz - 2) k0 = nz - 2;
      const tx = fx - i0, tz = fz - k0, c00 = i0 + k0 * nx;
      const hb = (hAt(i0, k0) * (1 - tx) + hAt(i0 + 1, k0) * tx) * (1 - tz) + (hAt(i0, k0 + 1) * (1 - tx) + hAt(i0 + 1, k0 + 1) * tx) * tz;
      const w = (m[c00]! * (1 - tx) + m[c00 + 1]! * tx) * (1 - tz) + (m[c00 + nx]! * (1 - tx) + m[c00 + nx + 1]! * tx) * tz;
      if (w <= 0) return y - hb;
      const cc = (cs[c00]! * (1 - tx) + cs[c00 + 1]! * tx) * (1 - tz) + (cs[c00 + nx]! * (1 - tx) + cs[c00 + nx + 1]! * tx) * tz, dS = (y - hb) * cc;
      if (mc) {
        const wc = (mc[c00]! * (1 - tx) + mc[c00 + 1]! * tx) * (1 - tz) + (mc[c00 + nx]! * (1 - tx) + mc[c00 + nx + 1]! * tx) * tz;
        return terr.blend!(x, y, z, hb, cc, wc, sampleH);
      }
      return dS + w * (terr.density(x, y, z, hb, Math.sqrt(Math.max(0, 1 / (cc * cc) - 1))) - dS);
    }
    const fx = (x - ox) / step, fz = (z - oz) / step;
    let i0 = Math.floor(fx), k0 = Math.floor(fz);
    if (i0 < 0) i0 = 0; else if (i0 > nx - 2) i0 = nx - 2;
    if (k0 < 0) k0 = 0; else if (k0 > nz - 2) k0 = nz - 2;
    const tx = fx - i0, tz = fz - k0;
    const c00 = i0 + k0 * nx, c10 = c00 + 1, c01 = c00 + nx, c11 = c01 + 1;
    const wx = (mx[c00]! * (1 - tx) + mx[c10]! * tx) * (1 - tz) + (mx[c01]! * (1 - tx) + mx[c11]! * tx) * tz;
    const wz = (mz[c00]! * (1 - tx) + mz[c10]! * tx) * (1 - tz) + (mz[c01]! * (1 - tx) + mz[c11]! * tx) * tz;
    let qx = fx, qz = fz;
    if (wx !== 0 || wz !== 0) {
      const p = pc.push(x, y, z) / step;
      qx -= wx * p;
      qz -= wz * p;
    }
    // bilinear H at the warped point, over the ring-extended grid
    const gi = Math.floor(qx), gk = Math.floor(qz), ux = qx - gi, uz = qz - gk;
    const ii = Math.min(ex - 2, Math.max(0, gi + ring)), kk = Math.min(ez - 2, Math.max(0, gk + ring));
    const at = ii + kk * ex;
    const h = (H[at]! * (1 - ux) + H[at + 1]! * ux) * (1 - uz) + (H[at + ex]! * (1 - ux) + H[at + ex + 1]! * ux) * uz;
    return y - h;
  };
  return { ring, heightAt: hAt, m, lo, hi, base };
}

/**
 * The same function for POINT queries (`density`, `surfaceCast`), on the
 * full-detail lattice (`voxelSize`) so a point query and a full-detail cell
 * agree at every sample. Lattice heights are cached: one query touches ~20.
 */
export interface PlanarPoint {
  /** `y - H(warped)` at a world point, and the warp mask there. */
  base(x: number, y: number, z: number): number;
  mask(x: number, z: number): number;
  /** Highest lattice height within reach of (x, z): rock can stand no higher. */
  top(x: number, z: number): number;
  /** Does any lattice column in [x0, x1] x [z0, z1] carry a cliff mask? (what the 'auto' mesher asks) */
  anyMask(x0: number, z0: number, x1: number, z1: number): boolean;
  /** The cached lattice height at column (I, K) — shared with full-detail blocks, so the mesher's heights and this query's are paid once. */
  heightAt(I: number, K: number): number;
  /** Can the planar value apply anywhere in the lattice square holding (x, z)? False = the plain heightfield is exact here. */
  touches(x: number, z: number): boolean;
  /** [lowest lo, highest hi] of the planar band over the four lattice columns around (x, z): where rock can be. */
  span(x: number, z: number): [number, number];
  /**
   * The y band where the planar value applies, for the lattice column at or
   * below (x, z) — exactly `PlanarBlock.lo/hi` of a full-detail block, so the
   * two paths pick the same function at every sample. [Inf, -Inf] = none.
   */
  range(x: number, z: number): [number, number];
}

export function planarPoint(pc: PlanarCliffs, height: (x: number, z: number) => number, maskAt: (x: number, z: number, gx: number, gz: number) => number, step: number, terr?: TerraceCliffs): PlanarPoint {
  const R = pc.stencil(step);
  const reachCols = Math.ceil(pc.maxPush / step) + 1;
  const cache = new Map<number, number>();
  const hAt = (I: number, K: number): number => {
    const key = (I + 1048576) * 2097152 + (K + 1048576);
    let h = cache.get(key);
    if (h === undefined) {
      if (cache.size > 200000) cache.clear();
      h = height(I * step, K * step);
      cache.set(key, h);
    }
    return h;
  };
  const inv = 1 / (2 * R * step);
  const feat = terr?.blend !== undefined;
  const sampleH = (x: number, z: number): number => {
    const fx = x / step, fz = z / step, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
    return (hAt(I, K) * (1 - tx) + hAt(I + 1, K) * tx) * (1 - tz) + (hAt(I, K + 1) * (1 - tx) + hAt(I + 1, K + 1) * tx) * tz;
  };
  // Per lattice column, cached: [warp x, warp z, mask, band lo, band hi, cos, (features) cliff-only mask]. A point query reads four.
  const cols = new Map<number, Float64Array>();
  const raw = (I: number, K: number): Float64Array => {
    const key = (I + 1048576) * 2097152 + (K + 1048576);
    let c = cols.get(key);
    if (c) return c;
    if (cols.size > 100000) cols.clear();
    c = new Float64Array(feat ? 7 : 6);
    const gx = (hAt(I + R, K) - hAt(I - R, K)) * inv, gz = (hAt(I, K + R) - hAt(I, K - R)) * inv;
    const g = Math.sqrt(gx * gx + gz * gz);
    const w = g > 1e-9 || feat ? maskAt(I * step, K * step, gx, gz) : 0;
    if (feat) c[6] = g > 1e-9 ? terr!.cliffMask!(I * step, K * step, gx, gz) : 0;
    c[0] = g > 1e-9 ? (-gx / g) * w : 0;
    c[1] = g > 1e-9 ? (-gz / g) * w : 0;
    c[2] = w;
    c[5] = 1 / Math.sqrt(1 + g * g);
    c[3] = NaN; // band not resolved yet
    cols.set(key, c);
    return c;
  };
  const column = (I: number, K: number): Float64Array => {
    const c = raw(I, K);
    if (Number.isNaN(c[3]!)) {
      let any = false;
      for (let dk = -1; dk <= 1 && !any; dk++) for (let di = -1; di <= 1 && !any; di++) if (raw(I + di, K + dk)[2]! > 0) any = true;
      if (!any) { c[3] = Infinity; c[4] = -Infinity; }
      else {
        let a = Infinity, b = -Infinity;
        for (let dk = -reachCols; dk <= reachCols; dk++) for (let di = -reachCols; di <= reachCols; di++) { const h = hAt(I + di, K + dk); if (h < a) a = h; if (h > b) b = h; }
        c[3] = a - step - (terr ? terr.depth : 0);
        if (terr?.floorAt) c[3] = Math.min(c[3]!, terr.floorAt(I * step, K * step));
        c[4] = b + step + (terr ? pc.maxPush : 0);
      }
    }
    return c;
  };
  const lerp4 = (x: number, z: number, o: number): number => {
    const fx = x / step, fz = z / step, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
    return (raw(I, K)[o]! * (1 - tx) + raw(I + 1, K)[o]! * tx) * (1 - tz) + (raw(I, K + 1)[o]! * (1 - tx) + raw(I + 1, K + 1)[o]! * tx) * tz;
  };
  return {
    base(x, y, z) {
      if (terr) {
        const fx = x / step, fz = z / step, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
        const hb = (hAt(I, K) * (1 - tx) + hAt(I + 1, K) * tx) * (1 - tz) + (hAt(I, K + 1) * (1 - tx) + hAt(I + 1, K + 1) * tx) * tz;
        const w = lerp4(x, z, 2);
        if (w <= 0) return y - hb;
        const cc = lerp4(x, z, 5), dS = (y - hb) * cc;
        if (feat) return terr.blend!(x, y, z, hb, cc, lerp4(x, z, 6), sampleH);
        return dS + w * (terr.density(x, y, z, hb, Math.sqrt(Math.max(0, 1 / (cc * cc) - 1))) - dS);
      }
      const wx = lerp4(x, z, 0), wz = lerp4(x, z, 1);
      let qx = x / step, qz = z / step;
      if (wx !== 0 || wz !== 0) {
        const p = pc.push(x, y, z) / step;
        qx -= wx * p;
        qz -= wz * p;
      }
      const gi = Math.floor(qx), gk = Math.floor(qz), ux = qx - gi, uz = qz - gk;
      const h = (hAt(gi, gk) * (1 - ux) + hAt(gi + 1, gk) * ux) * (1 - uz) + (hAt(gi, gk + 1) * (1 - ux) + hAt(gi + 1, gk + 1) * ux) * uz;
      return y - h;
    },
    mask(x, z) {
      return lerp4(x, z, 2);
    },
    range(x, z) {
      const c = column(Math.floor(x / step), Math.floor(z / step));
      return [c[3]!, c[4]!];
    },
    heightAt: hAt,
    anyMask(x0, z0, x1, z1) {
      for (let K = Math.floor(z0 / step); K <= Math.ceil(z1 / step); K++) for (let I = Math.floor(x0 / step); I <= Math.ceil(x1 / step); I++) if (raw(I, K)[2]! > 0) return true;
      return false;
    },
    span(x, z) {
      const I = Math.floor(x / step), K = Math.floor(z / step);
      let a = Infinity, b = -Infinity;
      for (let dk = 0; dk <= 1; dk++) for (let di = 0; di <= 1; di++) { const c = column(I + di, K + dk); if (c[3]! < a) a = c[3]!; if (c[4]! > b) b = c[4]!; }
      return [a, b];
    },
    touches(x, z) {
      const I = Math.floor(x / step), K = Math.floor(z / step);
      for (let dk = 0; dk <= 1; dk++) for (let di = 0; di <= 1; di++) if (column(I + di, K + dk)[3]! !== Infinity) return true;
      return false;
    },
    top(x, z) {
      const I = Math.floor(x / step), K = Math.floor(z / step);
      let b = -Infinity;
      for (let dk = -reachCols; dk <= reachCols + 1; dk++) for (let di = -reachCols; di <= reachCols + 1; di++) b = Math.max(b, hAt(I + di, K + dk));
      return b;
    },
  };
}

/**
 * Build the Hermite source for one sampled block: the exact planar value
 * (plus whatever smooth terms the caller adds through `extra`) and its
 * gradient by consistent central differences of that same function.
 */
export function planarHermite(
  value: (x: number, y: number, z: number) => number,
  active: Uint8Array,
  nx: number,
  ny: number,
  step: number,
): HermiteSource {
  const e = step * 0.004;
  const strideZ = nx * ny;
  return {
    value,
    gradient(x, y, z, out) {
      // forward differences from the crossing itself: exact on a plane, four evaluations instead of six.
      // The step is tiny next to a facet, so a crossing lands on one side of a crease and takes that side's plane.
      const f = value(x, y, z);
      out[0] = value(x + e, y, z) - f;
      out[1] = value(x, y + e, z) - f;
      out[2] = value(x, y, z + e) - f;
    },
    activeAt(i, j, k) {
      return active[i + j * nx + k * strideZ] === 1;
    },
  };
}

/** Merge one zone entry over the base spec (unset fields keep the base value). */
function mergeZone(base: PlanarCliffsDoc, o: PlanarZoneDoc): PlanarCliffsDoc {
  const pick = <T extends object>(b: T, over: object | undefined): T => {
    const out = { ...b } as Record<string, unknown>;
    if (over) for (const [k, v] of Object.entries(over)) if (v !== undefined) out[k] = v;
    return out as T;
  };
  return {
    ...base,
    slopeStart: o.slopeStart ?? base.slopeStart,
    slopeEnd: o.slopeEnd ?? base.slopeEnd,
    minRelief: o.minRelief ?? base.minRelief,
    fullRelief: o.fullRelief ?? base.fullRelief,
    strata: pick(base.strata, o.strata),
    terrace: pick(base.terrace, o.terrace),
    zones: [],
  };
}

/** How far a planar spec (all its zones) can move rock: what band limits and rings must allow for. */
export function planarReach(spec: PlanarCliffsDoc, worldSeed: number): { maxPush: number; sink: number } {
  let maxPush = 0, sink = 0;
  for (const s of [spec, ...spec.zones.map((z) => mergeZone(spec, z))]) {
    maxPush = Math.max(maxPush, createPlanarCliffs(s, worldSeed).maxPush);
    if (s.profile === "terrace") sink = Math.max(sink, s.terrace.step * (1.65 + s.terrace.levelJitter));
  }
  return { maxPush, sink };
}

/** Where the zone weights come from (the field supplies them; only read when `zones` is non-empty). */
export interface PlanarZoneSource {
  /** Membership of each named region at (x, z) into out[k] (0..1, nested zones already resolved). */
  regions?: (ids: readonly string[], band: number) => (x: number, z: number, out: Float32Array) => void;
  /** Distance to the nearest river/lake/road/town edge (field.featureClearance), for `featureClearance`. */
  clearance?: (x: number, z: number) => number;
  /** Ids of `climate.zones.anchors`, in order, and their blended weights at (x, z) (sums to 1). */
  anchorIds?: readonly string[];
  anchors?: (x: number, z: number) => Float32Array;
  /** Water and coast features the rock is built around (`planarCliffs.falls`, `terrain.seaCliffs`). */
  features?: PlanarFeatureSource;
}

/** One waterfall lip whose band holds a point (the field's lip line: `rel` metres past it, negative upstream). */
export interface PlanarLipHit {
  rel: number;
  across: number;
  /** Flow direction (unit, xz). */
  dx: number;
  dz: number;
  /** Upper and lower water levels. */
  top: number;
  bottom: number;
  /** Point weight of the fall's rock (0..1, fades out inside the lip band's edges) and the column mask (a little wider). */
  w: number;
  wc: number;
}

export interface PlanarFeatureSource {
  /** Every lip whose band holds (x, z) (`pad` metres more of band for a coarse "anything near?" test). */
  lips?: (x: number, z: number, out: PlanarLipHit[], pad?: number) => number;
  /** The nearest wet river's or lake's level at (x, z) and the distance from its bank's foot; false = none near. */
  bank?: (x: number, z: number, out: { level: number; dist: number }) => boolean;
  /** Distance to the nearest road or town edge (the dry half of featureClearance). */
  dryClearance?: (x: number, z: number) => number;
  /** Sea-cliff stretches (`terrain.seaCliffs`). */
  sea?: SeaCliffs;
  /** Butte fields (`terrain.buttes`). */
  buttes?: Buttes;
  /**
   * Share (0..1) of a height patch holding the column: the sea-cliff and butte walls hand the column back to the
   * (patched) heightfield there, so a pad on a stack or a cliff top levels locally instead of being drawn over.
   */
  hold?: (x: number, z: number) => number;
}

/**
 * Stepped walls round water, cut and never built up beyond `fill`: the ground between level F + (k-1)S and
 * F + kS goes to the lower level, and each wall stands at its tread's contour (moved forward by `fill` of a bench)
 * — vertical faces from a lattice heightfield. Below F the ground is untouched (the channel and its waterline);
 * above F + (K+1)S it is the natural ground again. `g` is the heightfield's slope there (contour distance =
 * height difference / slope), `push` the strata ledge push. Continuous in every argument.
 */
export function wallsDensity(y: number, h: number, g: number, F: number, S: number, K: number, fill: number, push: number): number {
  const inv = 1 / Math.max(0.05, g);
  let d = y - Math.min(h, F);
  for (let k = 1; k <= K; k++) {
    const L = F + k * S;
    d = Math.min(d, Math.max(y - L, (L - fill * S - h) * inv - push));
  }
  const Lt = F + (K + 1) * S;
  return Math.min(d, Math.max(y - h, (Lt - fill * S - h) * inv - push));
}

/**
 * Everything the field needs to evaluate planar cliffs: the combined spec
 * (reach = the widest zone's), the cliff mask per lattice column, and the
 * terrace density (blended across zones by membership). Without `zones` and
 * `minRelief` this is exactly the single-spec path, bit for bit.
 *
 * Zone weights and local relief live on a global 8 m lattice (cached, then
 * bilinear), so a point query, a full-detail block and an HLOD block read the
 * same pure function of (x, z).
 */
export interface PlanarSetup {
  pc: PlanarCliffs;
  terr?: TerraceCliffs;
  maskAt(x: number, z: number, gx: number, gz: number): number;
  /** Local relief (metres) at (x, z), or NaN when no group reads it. */
  relief(x: number, z: number): number;
}

export function createPlanarSetup(
  spec: PlanarCliffsDoc,
  worldSeed: number,
  height: (x: number, z: number) => number,
  calm: (x: number, z: number) => number,
  zoneSource: PlanarZoneSource = {},
): PlanarSetup {
  const base = createPlanarCliffs(spec, worldSeed);
  const terrace = spec.profile === "terrace";
  const zones = terrace ? spec.zones : [];
  const [clear0, clear1] = spec.featureClearance;
  const usesClear = clear1 > 0 && zoneSource.clearance !== undefined;
  const fsrc = terrace ? zoneSource.features : undefined;
  const falls = fsrc ? spec.falls : undefined;
  const sea = fsrc?.sea;
  const bt = fsrc?.buttes;
  const hasFeatures = falls !== undefined || sea !== undefined || bt !== undefined;
  if (zones.length === 0 && spec.minRelief <= 0 && !usesClear && !hasFeatures) {
    return {
      pc: base,
      terr: terrace ? createTerraceCliffs(base, worldSeed, height) : undefined,
      maskAt: (x, z, gx, gz) => base.mask(gx, gz) * calm(x, z),
      relief: () => NaN,
    };
  }
  const specs = [spec, ...zones.map((o) => mergeZone(spec, o))];
  const G = specs.length;
  const pcs = specs.map((s) => createPlanarCliffs(s, worldSeed));
  const maxPush = Math.max(...pcs.map((p) => p.maxPush));
  const pc: PlanarCliffs = { ...base, maxPush, stencil: (step) => Math.max(1, Math.ceil((maxPush + step) / step)) };
  const strength = specs.map((_, g) => (g === 0 ? 1 : zones[g - 1]!.strength ?? 1));
  const minR = specs.map((s) => s.minRelief);
  const fullR = specs.map((s) => s.fullRelief ?? s.minRelief * 2.5);
  const usesRelief = minR.some((m) => m > 0);

  // ---- the 8 m lattice: [relief, w_0..w_{G-1}, clearance, (features) dry fade, cliff country, feature potential] per node
  const L = 8, W = 2;
  const FN = 2 + G, NODE = hasFeatures ? FN + 3 : FN;
  const regionEntries: { id: string; g: number }[] = [];
  zones.forEach((o, i) => { if (o.region !== undefined) regionEntries.push({ id: o.region, g: i + 1 }); });
  const anchorGroup = new Map<number, number>();
  if (zoneSource.anchorIds) zones.forEach((o, i) => {
    if (o.anchor === undefined || o.region !== undefined) return;
    const a = zoneSource.anchorIds!.indexOf(o.anchor);
    if (a >= 0) anchorGroup.set(a, i + 1);
  });
  const regionW = regionEntries.length && zoneSource.regions ? zoneSource.regions(regionEntries.map((e) => e.id), spec.zoneBlend) : null;
  const rScratch = new Float32Array(Math.max(1, regionEntries.length));
  const hCache = new Map<number, number>();
  const nodeH = (I: number, K: number): number => {
    const key = (I + 1048576) * 2097152 + (K + 1048576);
    let h = hCache.get(key);
    if (h === undefined) {
      if (hCache.size > 200000) hCache.clear();
      h = height(I * L, K * L);
      hCache.set(key, h);
    }
    return h;
  };
  const gate = (g: number, r: number): number => (minR[g]! > 0 ? smoothstep(minR[g]! * 0.6, minR[g]!, r) : 1);
  const lipScratch: PlanarLipHit[] = [];
  const bankScratch = { level: 0, dist: 0 };
  const seaNode: SeaColumn | null = sea ? sea.newColumn() : null;
  const btNode: ButteColumn | null = bt ? bt.newColumn() : null;
  const bankR0 = falls ? falls.bankReach[0] : 0, bankR1 = falls ? Math.max(falls.bankReach[0] + 1, falls.bankReach[1]) : 0;
  const nodes = new Map<number, Float32Array>();
  const node = (I: number, K: number): Float32Array => {
    const key = (I + 1048576) * 2097152 + (K + 1048576);
    let n = nodes.get(key);
    if (n) return n;
    if (nodes.size > 100000) nodes.clear();
    n = new Float32Array(NODE);
    n[1 + G] = usesClear ? smoothstep(clear0, Math.max(clear0 + 1e-3, clear1), zoneSource.clearance!(I * L, K * L)) : 1;
    if (usesRelief) {
      let a = Infinity, b = -Infinity;
      for (let dk = -W; dk <= W; dk++) for (let di = -W; di <= W; di++) {
        const h = nodeH(I + di, K + dk);
        if (h < a) a = h;
        if (h > b) b = h;
      }
      n[0] = b - a;
    }
    const x = I * L, z = K * L;
    let rest = 1;
    if (regionW) {
      regionW(x, z, rScratch);
      for (let e = 0; e < regionEntries.length; e++) {
        const w = rScratch[e]!;
        n[1 + regionEntries[e]!.g] = n[1 + regionEntries[e]!.g]! + w;
        rest -= w;
      }
      rest = Math.max(0, rest);
    }
    if (anchorGroup.size && zoneSource.anchors) {
      const aw = zoneSource.anchors(x, z);
      for (let a = 0; a < aw.length; a++) { const gi = 1 + (anchorGroup.get(a) ?? 0); n[gi] = n[gi]! + rest * aw[a]!; }
    } else n[1] = n[1]! + rest;
    if (hasFeatures) {
      // the dry half of featureClearance (roads, towns): water features keep their hands off those too
      n[FN] = fsrc!.dryClearance ? smoothstep(clear0, Math.max(clear0 + 1e-3, clear1), fsrc!.dryClearance(x, z)) : 1;
      // CLIFF COUNTRY: the cliff mask as the 8 m lattice sees it, before featureClearance — where a river cutting
      // through gets rock banks instead of the terrace fading away from it
      const gx = (nodeH(I + 1, K) - nodeH(I - 1, K)) / (2 * L), gz = (nodeH(I, K + 1) - nodeH(I, K - 1)) / (2 * L);
      const gl = Math.hypot(gx, gz), steep = gl / Math.sqrt(1 + gl * gl);
      let m = 0;
      for (let s = 0; s < G; s++) {
        const w = n[1 + s]! * strength[s]!;
        if (w > 1e-6) m += w * gate(s, n[0]!) * smoothstep(specs[s]!.slopeStart * 0.85, specs[s]!.slopeEnd * 0.85, steep);
      }
      n[FN + 1] = m;
      // anything that could put a feature mask within this node's cells (so the exact test runs only near one)
      let pot = 0;
      if (falls && fsrc!.lips && fsrc!.lips(x, z, lipScratch, 12) > 0) pot = 1;
      if (!pot && falls && falls.banks > 0 && fsrc!.bank && fsrc!.bank(x, z, bankScratch) && bankScratch.dist < bankR1 + 14) pot = 1;
      if (!pot && sea && sea.column(x, z, seaNode!) > 0 && (Math.abs(seaNode!.q) < 40 || seaNode!.stackOut < 30 || seaNode!.fin < 30)) pot = 1;
      if (!pot && bt && bt.column(x, z, btNode!) > 0 && btNode!.out < 44) pot = 1;
      n[FN + 2] = pot;
    }
    nodes.set(key, n);
    return n;
  };
  const col = new Float64Array(NODE);
  let colX = NaN, colZ = NaN;
  const column = (x: number, z: number): Float64Array => {
    if (x === colX && z === colZ) return col;
    colX = x; colZ = z;
    const fx = x / L, fz = z / L, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
    const a = node(I, K), b = node(I + 1, K), c = node(I, K + 1), d = node(I + 1, K + 1);
    for (let s = 0; s < NODE; s++) col[s] = (a[s]! * (1 - tx) + b[s]! * tx) * (1 - tz) + (c[s]! * (1 - tx) + d[s]! * tx) * tz;
    return col;
  };
  // small hills: the wall planes jog a quarter as far, so a modest knoll reads as a smoother plan, not castle blocks
  const soft = (g: number) => (x: number, z: number): number =>
    0.25 + 0.75 * smoothstep(minR[g]!, Math.max(minR[g]! + 1e-3, fullR[g]!), column(x, z)[0]!);
  const terrs = terrace ? pcs.map((p, g) => createTerraceCliffs(p, worldSeed, height, minR[g]! > 0 ? soft(g) : undefined)) : null;
  const wts = new Float64Array(G);
  let tX = NaN, tZ = NaN, single = -1;
  const cliffMask = (x: number, z: number, gx: number, gz: number): number => {
    const c = calm(x, z);
    if (c <= 0) return 0;
    const gl = Math.sqrt(gx * gx + gz * gz), steep = gl / Math.sqrt(1 + gl * gl);
    const cl = column(x, z), r = cl[0]!;
    if (cl[1 + G]! <= 0) return 0;
    let m = 0;
    for (let s = 0; s < G; s++) {
      const w = cl[1 + s]! * strength[s]!;
      if (w <= 1e-6) continue;
      m += w * gate(s, r) * smoothstep(specs[s]!.slopeStart, specs[s]!.slopeEnd, steep);
    }
    return m * c * cl[1 + G]!;
  };
  const terr: TerraceCliffs | undefined = terrs
    ? {
        depth: Math.max(...terrs.map((t) => t.depth)),
        density(x, y, z, h, g) {
          if (x !== tX || z !== tZ) {
            tX = x; tZ = z;
            const c = column(x, z);
            single = -1;
            for (let s = 0; s < G; s++) { wts[s] = c[1 + s]!; if (wts[s]! > 0.9999) single = s; }
          }
          if (single >= 0) return terrs[single]!.density(x, y, z, h, g);
          let d = 0, sum = 0;
          for (let s = 0; s < G; s++) {
            const w = wts[s]!;
            if (w > 1e-4) { d += w * terrs[s]!.density(x, y, z, h, g); sum += w; }
          }
          return sum > 0 ? d / sum : terrs[0]!.density(x, y, z, h, g);
        },
      }
    : undefined;
  if (terr && hasFeatures) attachFeatures(terr);
  return {
    pc,
    terr,
    relief: (x, z) => (usesRelief ? column(x, z)[0]! : NaN),
    maskAt: terr?.blend
      ? (x, z, gx, gz) => {
          const m = cliffMask(x, z, gx, gz);
          if (column(x, z)[FN + 2]! <= 0) return m;
          return Math.max(m, featureMask(x, z));
        }
      : cliffMask,
  };

  // ---------------------------------------------------------------- features
  //
  // Per column (memoised on the exact x, z, like the terrace): which lips, banks and sea cliffs reach it, their
  // weights and the heights they read a few metres off the point. Per sample: the walls at that y.
  function featureMask(x: number, z: number): number {
    const cl = column(x, z), dry = cl[FN]!;
    let m = 0;
    if (falls && fsrc!.lips) {
      const n = fsrc!.lips(x, z, lipScratch);
      for (let i = 0; i < n; i++) m = Math.max(m, lipScratch[i]!.wc * dry);
    }
    if (falls && falls.banks > 0 && fsrc!.bank && fsrc!.bank(x, z, bankScratch)) {
      m = Math.max(m, cl[FN + 1]! * (1 - smoothstep(bankR0, bankR1 + 3, bankScratch.dist)) * dry);
    }
    if (sea && sea.column(x, z, seaNode!) > 0) m = Math.max(m, sea.mask(seaNode!));
    if (bt && bt.column(x, z, btNode!) > 0) m = Math.max(m, bt.mask(btNode!));
    return m;
  }

  function attachFeatures(t: TerraceCliffs): void {
    const terrDensity = t.density.bind(t);
    const fo = falls;
    const foot = fo?.foot ?? 0.5, fill = fo?.fill ?? 0.3, banksH = fo?.banks ?? 0;
    // per-column state
    let fX = NaN, fZ = NaN;
    let fb = 0, bankLevel = 0, gP = 0, fl = 0, fs = 0, ft = 0, nLips = 0;
    const btCol: ButteColumn | null = bt ? bt.newColumn() : null;
    const bankK = Math.max(0, (fo?.bankSteps ?? 1) - 1);
    const lips: PlanarLipHit[] = [];
    // per lip: [rel, hA, gA, hB, gB, w, top, bottom]
    const lipCol: Float64Array[] = [];
    const seaCol: SeaColumn | null = sea ? sea.newColumn() : null;
    const grad = (H: (x: number, z: number) => number, x: number, z: number): number => {
      const e = 2;
      const gx = (H(x + e, z) - H(x - e, z)) / (2 * e), gz = (H(x, z + e) - H(x, z - e)) / (2 * e);
      return Math.hypot(gx, gz);
    };
    t.cliffMask = cliffMask;
    if (sea) {
      const fc = sea.newColumn();
      t.floorAt = (x, z) => (sea.column(x, z, fc) > 0 && (fc.fin < 14 || fc.stackOut < 14) ? Math.min(fc.foot, fc.holeA > 0 ? fc.holeY : Infinity) - 4 : Infinity);
    }
    t.blend = (x, y, z, hb, cc, wc, H) => {
      if (x !== fX || z !== fZ) {
        fX = x; fZ = z;
        fb = 0; fl = 0; fs = 0; ft = 0; nLips = 0;
        const cl = column(x, z);
        if (cl[FN + 2]! > 0) {
          const dry = cl[FN]!;
          if (fo && fsrc!.lips) {
            const n = fsrc!.lips(x, z, lips);
            for (let i = 0; i < n; i++) {
              const L0 = lips[i]!;
              const w = L0.w * dry;
              if (w <= 0) continue;
              const row = (lipCol[nLips] ??= new Float64Array(8));
              // upstream of the line: the ground carried forward from 3 m back (all four lattice corners upstream);
              // past it: the plunge floor carried back from 3.2 m on. One line, so the face stands exactly on it.
              const sA = Math.max(0, L0.rel + 3), sB = Math.max(0, 3.2 - L0.rel);
              const ax = x - L0.dx * sA, az = z - L0.dz * sA, bx = x + L0.dx * sB, bz = z + L0.dz * sB;
              row[0] = L0.rel; row[1] = H(ax, az); row[2] = grad(H, ax, az); row[3] = H(bx, bz); row[4] = grad(H, bx, bz);
              row[5] = w; row[6] = L0.top; row[7] = L0.bottom;
              if (w > fl) fl = w;
              nLips++;
            }
          }
          if (fo && banksH > 0 && fsrc!.bank && fsrc!.bank(x, z, bankScratch)) {
            fb = cl[FN + 1]! * (1 - smoothstep(bankR0, bankR1, bankScratch.dist)) * dry;
            bankLevel = bankScratch.level;
          }
          if (fb > 0 || nLips > 0) gP = grad(H, x, z);
          if (sea && sea.column(x, z, seaCol!) > 0) fs = sea.weight(seaCol!);
          if (bt && bt.column(x, z, btCol!) > 0) ft = bt.weight(btCol!);
          // under a height patch the walls give way to the patched heightfield (which already carries their profile)
          if ((fs > 0 || ft > 0) && fsrc!.hold) {
            const keep = 1 - fsrc!.hold(x, z);
            fs *= keep; ft *= keep;
          }
        }
      }
      // the layers, innermost first: the cliffs as they were, the bank walls, the falls, the sea cliffs — each blended
      // over the last by its weight, and a layer under a full-weight one is never evaluated
      if (ft >= 1) return bt!.density(x, y, z, hb, btCol!);
      const seaFull = fs >= 1, fallFull = seaFull || fl >= 1, bankFull = fallFull || fb >= 1;
      let d = 0;
      if (!bankFull) {
        if (wc > 0) {
          const dS = (y - hb) * cc;
          d = dS + wc * (terrDensity(x, y, z, hb, Math.sqrt(Math.max(0, 1 / (cc * cc) - 1))) - dS);
        } else d = y - hb;
        if (fb <= 0 && nLips === 0 && fs <= 0 && ft <= 0) return d;
      }
      if (seaFull) d = sea!.density(x, y, z, hb, seaCol!);
      else {
      const push = pc.strataPush(x, y, z);
      if (fb > 0 && !fallFull) d += fb * (wallsDensity(y, hb, gP, bankLevel + foot, banksH, bankK, fill, push) - d);
      if (nLips > 0) {
        let sum = 0, acc = 0;
        for (let i = 0; i < nLips; i++) {
          const r = lipCol[i]!, rel = r[0]!, top = r[6]!, bottom = r[7]!, drop = Math.max(0.5, top - bottom), w = r[5]!;
          // upstream: the upper bed and its banks, cut off at the lip line
          let A = banksH > 0 ? wallsDensity(y, r[1]!, r[2]!, top + foot, banksH, 0, fill, push) : y - r[1]!;
          A = Math.max(A, rel);
          // downstream: sheer plunge-bowl walls, then the stepped gorge, then low banks — all over the pool's level
          const F = bottom + foot, span = Math.max(1, top + 1 - F);
          const nb = fo!.bowl, Sb = Math.max(2, span / nb);
          const bowl = wallsDensity(y, r[3]!, r[4]!, F, Sb, nb - 1, fill, push);
          const Sg = fo!.gorgeStep, Kg = Math.max(0, Math.floor(span / Sg) - 1);
          const gorge = wallsDensity(y, r[3]!, r[4]!, F, Sg, Kg, fill, push);
          const low = banksH > 0 ? wallsDensity(y, r[3]!, r[4]!, F, banksH, 0, fill, push) : y - r[3]!;
          const g0 = drop * 0.35, gEnd = Math.min(drop * fo!.gorgeLength, drop + 8);
          let B = bowl + (gorge - bowl) * smoothstep(g0, g0 + 10, rel);
          B += (low - B) * smoothstep(gEnd, gEnd + 10, rel);
          B = Math.max(B, -(rel + 0.5));
          acc += w * Math.min(A, B);
          sum += w;
        }
        d += fl * (acc / sum - d);
      }
      if (fs > 0) d += fs * (sea!.density(x, y, z, hb, seaCol!) - d);
      }
      if (ft > 0) d += ft * (bt!.density(x, y, z, hb, btCol!) - d);
      return d;
    };
  }
}
