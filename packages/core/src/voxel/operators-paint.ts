/**
 * `paint` — lay one palette surface over an area of ground: "pale cut stone on this shelf floor", "ash on this camp",
 * "scree on these fans". Splat only: no height change, no new material (the surface is a slice of the world's one
 * terrain texture array on an indexed-splat world, so a hundred paints still draw in the terrain's own draws).
 *
 * Compiles to ONE `features.groundPaints` entry `op:<id>:paint` (ground-paint.ts holds the schema and the field side).
 */
import { z } from "zod";
import { registerOperator, type OperatorFieldReader, type OperatorOutput } from "./operator-registry.js";
import { groundPaintBounds } from "./ground-paint.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const paintOperatorSchema = z
  .object({
    surface: z.string().min(1).describe("Palette surface name to paint (`recipe.surfaces[].name`, e.g. `cut-stone`, `scree-pale`, `skelmorrow-cinderwell-ash`). It must already be in the palette: add a world-kit ground tile (`world-kit/assets/textures/ground/`) as a surface and re-emit the material (`worldgen material`) first."),
    polygon: z.array(xz).min(3).optional().describe("Area outline [x, z]. Give this OR center + radius."),
    center: xz.optional().describe("Disc centre [x, z] (with `radius`)."),
    radius: z.number().min(3).max(400).optional().describe("Disc radius, metres."),
    feather: z.number().min(0).max(40).default(3).describe("Metres outside the outline over which the paint fades out."),
    edgeNoise: z.number().min(0).max(12).default(1.5).describe("Metres the painted edge wanders (~12 m wavelength): never a drawn line."),
    strength: z.number().min(0).max(1).default(1).describe("Opacity at full weight."),
    breakup: z.number().min(0).max(0.9).default(0).describe("Fraction left unpainted in ~10 m noise blotches (0 = solid; 0.3 = worn patches)."),
    slope: z.tuple([z.number().min(0).max(90), z.number().min(0).max(90)]).optional().describe("Only on ground whose slope is inside [min, max] degrees, e.g. [0, 20] = the floor only, [28, 45] = the banks only."),
    height: z.tuple([z.number().finite(), z.number().finite()]).optional().describe("Only on ground inside [minY, maxY] world metres, e.g. a shelf floor's level +-1 m."),
    faces: z.boolean().default(false).describe("Also paint near-vertical faces (default: they keep the zone's cliff stone, like every ground paint)."),
    clear: z.boolean().default(false).describe("Also keep scatter and ground cover off the painted area (a vegetation clearing over the same outline)."),
  })
  .refine((p) => (p.polygon !== undefined) !== (p.center !== undefined && p.radius !== undefined), {
    message: "a paint needs a polygon OR center + radius (not both, not neither)",
  });
export type PaintOperatorParams = z.infer<typeof paintOperatorSchema>;

/** Refuse a surface the world's palette does not have (when the reader knows the palette). */
export function requireSurface(reader: OperatorFieldReader, surface: string, who: string): void {
  if (!reader.surfaces) return;
  const want = surface.trim().toLowerCase();
  if (!reader.surfaces.some((s) => s.toLowerCase() === want)) {
    throw new Error(`${who}: surface "${surface}" is not in this world's palette — add it (world-kit/assets/textures/ground/<tile>.png as a recipe surface, then \`worldgen material\`) before painting with it`);
  }
}

function compilePaint(p: PaintOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  requireSurface(reader, p.surface, `paint "${ctx.id}"`);
  const { clear, ...rest } = p;
  const piece = { id: "paint", ...rest, ...(clear ? { clear: { scatter: true, cover: true } } : {}) };
  const b = groundPaintBounds(p);
  return {
    features: { groundPaints: [piece] },
    report: { surface: p.surface, area: p.polygon ? `polygon ${p.polygon.length} pts` : `disc r ${p.radius}`, bounds: [b.x0, b.z0, b.x1, b.z1].map((v) => Math.round(v)), clear },
  };
}

registerOperator<PaintOperatorParams>({
  op: "paint",
  description:
    "Paint one palette surface (a ground tile) over a polygon or disc, feathered and edge-wobbled, optionally limited to a slope range or a height band (a quarried floor, ash on a camp, scree on fans). Splat only: no height change, no new material or draw. Compiles to `groundPaints` `op:<id>:paint` (+ an optional vegetation clearing).",
  schema: paintOperatorSchema,
  compile: compilePaint,
  bounds: (p) => groundPaintBounds(p),
  outline: (p) => [p.polygon ? p.polygon.map(([x, z]) => [x, z] as [number, number]) : Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [p.center![0] + Math.cos(a) * p.radius!, p.center![1] + Math.sin(a) * p.radius!] as [number, number];
  })],
});
