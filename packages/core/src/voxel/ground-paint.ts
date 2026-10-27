/**
 * GROUND PAINT — one palette surface laid over an area of terrain, optionally limited to a slope range or a height band.
 *
 * Zone ground blends over 150 m and `recipe.patches` are world-wide noise, so a single place could never say "this shelf
 * floor is pale cut stone" or "these fans are scree". A paint is a `features.groundPaints` entry: a polygon or a disc, a
 * feather, and the name of a surface already in the world's palette. It changes the SPLAT only (no height, no new
 * material, no new draw call): on an indexed-splat world the surface is a slice of the one terrain texture array.
 *
 * Order in the splat: after the biome, its patches and the zone's ground roles (a paint is more specific than all of
 * them), BEFORE lake, river and road paint (a trail through scree is still a trail). Like every feature paint it fades
 * out on near-vertical faces (`faces: true` paints them too). Paints apply in array order: a later one wins.
 *
 * Written by hand-free tools only: the `paint` and `scree` landform operators compile to it (`op:<id>:*`).
 */
import { z } from "zod";
import { fbm2, smoothstep, type FbmSpec } from "./noise.js";
import { PolygonIndex, type OutlineSpec } from "./polygon-index.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const groundPaintSchema = z
  .object({
    id: z.string().default("ground-paint"),
    surface: z.string().min(1).describe("Palette surface name (`recipe.surfaces[].name`) to paint. Must already be in the palette; add a tile with `worldgen material` first if it is not."),
    polygon: z.array(xz).min(3).optional().describe("Outline [x, z] (any simple polygon). Give this OR center + radius."),
    center: xz.optional().describe("Disc centre [x, z] (with `radius`)."),
    radius: z.number().positive().optional().describe("Disc radius, metres."),
    feather: z.number().min(0).max(40).default(3).describe("Metres OUTSIDE the outline over which the paint fades to nothing. 0 = a hard (noisy) edge."),
    edgeNoise: z.number().min(0).max(12).default(1.5).describe("Metres the painted edge wanders in and out (~12 m wavelength), so it never reads as a drawn line."),
    strength: z.number().min(0).max(1).default(1).describe("Paint opacity at full weight (1 = only this surface)."),
    breakup: z.number().min(0).max(0.9).default(0).describe("Fraction of the area left unpainted in noise blotches (~10 m), so a large paint shows the ground through. 0 = solid."),
    slope: z.tuple([z.number().min(0).max(90), z.number().min(0).max(90)]).optional().describe("Only where the ground slope is inside [min, max] degrees (faded over 4 degrees each side)."),
    height: z.tuple([z.number().finite(), z.number().finite()]).optional().describe("Only where the ground is inside [minY, maxY] world metres (faded over 1.5 m each side)."),
    faces: z.boolean().default(false).describe("Also paint near-vertical faces. Default false: like road and lake paint it fades out between 40 and 53 degrees, so a face keeps the zone's cliff stone."),
    clear: z
      .object({
        scatter: z.boolean().default(true).describe("Keep scatter props (trees, bushes, rocks of the world's rules) off the painted area."),
        cover: z.boolean().default(true).describe("Keep ground cover (grass, flowers) off it."),
      })
      .optional()
      .describe("Also a vegetation clearing over the same outline (feathered like the paint). Omit = vegetation untouched (cover still follows the surface it grows on)."),
  })
  .refine((p) => (p.polygon !== undefined) !== (p.center !== undefined && p.radius !== undefined), {
    message: "a ground paint needs a polygon OR center + radius (not both, not neither)",
  })
  .describe("One palette surface painted over an area (polygon or disc, feathered), optionally limited by slope or height. Splat only: no height change, no new material.");
export type GroundPaintDoc = z.infer<typeof groundPaintSchema>;

/** XZ bounds a paint can touch (outline + feather + edge noise). */
export function groundPaintBounds(p: { polygon?: readonly (readonly number[])[]; center?: readonly number[]; radius?: number; feather?: number; edgeNoise?: number }): { x0: number; z0: number; x1: number; z1: number } {
  const pad = (p.feather ?? 3) + (p.edgeNoise ?? 1.5) + 1;
  if (p.polygon && p.polygon.length) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of p.polygon) { x0 = Math.min(x0, q[0]!); z0 = Math.min(z0, q[1]!); x1 = Math.max(x1, q[0]!); z1 = Math.max(z1, q[1]!); }
    return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
  }
  const c = p.center ?? [0, 0], r = (p.radius ?? 0) + pad;
  return { x0: c[0]! - r, z0: c[1]! - r, x1: c[0]! + r, z1: c[1]! + r };
}

const EDGE_SPEC: FbmSpec = { frequency: 1 / 12, amplitude: 1, octaves: 2, lacunarity: 2, gain: 0.5, ridged: false, seed: 2203 };
const BREAK_SPEC: FbmSpec = { frequency: 1 / 10, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 2207 };

/** One compiled paint: what `paint` needs per sample, outline indexed. */
interface PaintRuntime {
  target: number;
  outline: number;
  feather: number;
  edgeNoise: number;
  strength: number;
  breakup: number;
  slope: [number, number, number, number] | null; // sin(angle): outer lo, inner lo, inner hi, outer hi
  height: [number, number] | null;
  faces: boolean;
  bounds: { x0: number; z0: number; x1: number; z1: number };
  salt: number;
}

export interface GroundPainter {
  /** Lerp `out` (a splat vector at `offset`) toward each paint covering (x, z). `steep` = sin(slope); `flat` = the feature-paint face fade.
   *  `facesOnly`: only `faces` paints, on the steep part (weight x (1 - flat)): the re-skin of a wall over a later blanket face paint (a crafted site's gorge stone). */
  paint(x: number, y: number, z: number, steep: number, flat: number, out: Float32Array, offset: number, surfaceCount: number, facesOnly?: boolean): void;
  /** Number of paints that resolved to a palette surface. */
  readonly count: number;
}

const sinDeg = (d: number) => Math.sin((Math.max(0, Math.min(90, d)) * Math.PI) / 180);

/**
 * Compile `features.groundPaints` against the palette. A paint naming a surface that is not in the palette is DROPPED
 * (like `recipe.patches`: a recipe may name a surface before its tile is added; `worldgen op --check` / the operator
 * compile report it). Returns null when nothing paints.
 */
export function createGroundPainter(
  paints: readonly GroundPaintDoc[] | undefined,
  surfaceIndex: (name: string) => number,
  seed: number,
): GroundPainter | null {
  if (!paints || paints.length === 0) return null;
  const specs: OutlineSpec[] = [];
  const list: PaintRuntime[] = [];
  paints.forEach((p, k) => {
    const target = surfaceIndex(p.surface);
    if (target < 0) return;
    const band = p.feather + p.edgeNoise + 2;
    specs.push(p.polygon ? { kind: "polygon", points: p.polygon, band } : { kind: "disc", center: p.center!, radius: p.radius! });
    list.push({
      target,
      outline: specs.length - 1,
      feather: p.feather,
      edgeNoise: p.edgeNoise,
      strength: p.strength,
      breakup: p.breakup,
      slope: p.slope ? [sinDeg(p.slope[0] - 4), sinDeg(p.slope[0]), sinDeg(p.slope[1]), sinDeg(p.slope[1] + 4)] : null,
      height: p.height ? [p.height[0], p.height[1]] : null,
      faces: p.faces,
      bounds: groundPaintBounds(p),
      salt: (k + 1) * 977,
    });
  });
  if (list.length === 0) return null;
  const index = new PolygonIndex(specs);
  return {
    count: list.length,
    paint(x, y, z, steep, flat, out, offset, surfaceCount, facesOnly = false) {
      for (let k = 0; k < list.length; k++) {
        const r = list[k]!;
        const b = r.bounds;
        if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
        if (facesOnly && !r.faces) continue;
        let d = index.signedDistance(r.outline, x, z);
        if (r.edgeNoise > 0) d += fbm2(EDGE_SPEC, x + r.salt, z - r.salt, seed) * r.edgeNoise;
        let w = r.feather > 0 ? 1 - smoothstep(0, r.feather, d) : d <= 0 ? 1 : 0;
        if (w <= 0.002) continue;
        if (!r.faces) w *= flat;
        if (facesOnly) w *= 1 - flat;
        if (r.slope) {
          const [a, b, c, e] = r.slope;
          if (b > 0) w *= smoothstep(a, b, steep);
          if (c < 1) w *= 1 - smoothstep(c, e, steep);
        }
        if (r.height) w *= smoothstep(r.height[0] - 1.5, r.height[0], y) * (1 - smoothstep(r.height[1], r.height[1] + 1.5, y));
        if (r.breakup > 0) {
          const n = fbm2(BREAK_SPEC, x - r.salt, z + r.salt, seed) * 0.5 + 0.5;
          w *= smoothstep(r.breakup - 0.08, r.breakup + 0.08, n);
        }
        w *= r.strength;
        if (w <= 0.002) continue;
        const t = r.target;
        for (let s = 0; s < surfaceCount; s++) {
          const cur = out[offset + s]!;
          out[offset + s] = cur + ((s === t ? 1 : 0) - cur) * w;
        }
      }
    },
  };
}
