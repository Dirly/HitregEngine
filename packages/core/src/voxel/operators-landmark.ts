/**
 * `landmark` — the GENERAL LANDMARK STAMP: any shape (a CSG spec, a Blender stamp, or a code generator), baked at a
 * fine DC voxel like a dungeon, standing in the overworld with its own trimesh collider and a terrain blend.
 *
 * Compiles to `landmarks` `op:<id>:landmark` (the baked prefab `landmarks/<id>-<digest>`, placed at the foot) plus,
 * unless `blend.mode` is `none`, one masked height patch `op:<id>:ground` (bury mound / pad apron, >= 6 m wide).
 * The spec format and the compile live in landmark-stamp.ts; `tools/landmark.mts` bakes (multi-material, one draw
 * per material), runs the collider-reach loop for declared `targets`/`openings`, and writes a `--glb-only` page.
 */
import { z } from "zod";
import { registerOperator, type OperatorFieldReader, type OperatorOutput, type OperatorPiece } from "./operator-registry.js";
import {
  compileLandmarkSpec, landmarkBlendSchema, landmarkFootprint, landmarkGenerator, landmarkGround, landmarkOpeningSchema,
  landmarkSpecSchema, registerLandmarkGenerator, type CompiledLandmark, type LandmarkSpec,
} from "./landmark-stamp.js";
import { ledgeLandmarkGround, ledgeLandmarkVolume } from "./ledge-landmark.js";
import { ledgesOperatorSchema, landmarkOptions, landmarkPrefabId, solveLedges } from "./operators-ledges.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);
const xyz = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

export const landmarkSourceSchema = z.union([
  z.object({
    csg: landmarkSpecSchema.describe("The CSG spec (landmark-stamp.ts `landmarkSpecSchema`)."),
    file: z.string().optional().describe("Provenance: the project-relative spec file `worldgen op --apply` inlined into `csg`."),
  }).strict(),
  z.object({
    file: z.string().describe("Project-relative CSG spec JSON. `worldgen op --apply` INLINES it into `csg` (keeping `file`), so the recipe always carries the solids."),
  }).strict(),
  z.object({
    blender: z.string().describe("Project-relative .blend or Blender build .py: closed solids with roles from object names/collections, exported headless through tools/mesh-dc (export_blender.py)."),
    resolved: z.object({
      digest: z.string(),
      min: xyz, max: xyz,
      footprint: z.array(xz).describe("Spec-local foot cells [x, z] (1 m)."),
    }).optional().describe("Written by `tools/landmark.mts --resolve`: the exported solids' digest and extent (core cannot read a .blend)."),
  }).strict(),
  z.object({
    generator: z.string().describe("A registered landmark generator (`ledges`: the ledges solve as a landmark)."),
    args: z.record(z.string(), z.unknown()).default({}).describe("The generator's own params (for `ledges`: the `ledges` operator params)."),
  }).strict(),
]);

export const landmarkOperatorSchema = z.object({
  at: xz.describe("World XZ of the spec's origin (its footprint centre)."),
  y: z.number().finite().optional().describe("World Y of spec y 0 (the foot). Omit: from `blend` (bury: lowest footprint ground - depth; pad: median; none: ground at `at`)."),
  yaw: z.number().default(0).describe("Degrees about +Y (spec +Z turns toward +X for positive yaw)."),
  scale: z.number().min(0.25).max(4).default(1).describe("Uniform scale of every spec length."),
  voxel: z.number().min(0.25).max(0.5).default(0.5).describe("DC voxel, metres (0.5 for big rock; 0.25 for fine masonry). Shells must be >= 3 voxels."),
  source: landmarkSourceSchema.describe("The shape: `{ csg }` / `{ file }` (CSG spec), `{ blender }` (mesh-dc stamp), or `{ generator, args }`."),
  materials: z.record(z.string(), z.string()).default({}).describe("Role -> `zone` (default: the zone's cliff stone on faces, its ground cover on tops, triplanar terrain material, ONE draw shared by every zone role), `zone-stone` (stone everywhere), `surface:<palette name>`, or a material asset id (its own draw)."),
  blend: landmarkBlendSchema.prefault({}).describe("How the terrain meets the foot. Every terrain piece is >= 6 m wide (FINE_MIN)."),
  openings: z.array(landmarkOpeningSchema).max(16).default([]).describe("Named doorways/portals kept CLEAR (carved after every part) and noise-free; each is also a reach target."),
  targets: z.array(z.object({ name: z.string(), at: xyz.describe("Spec-local walkable point.") })).max(32).default([]).describe("Walkable points the BAKED collider must reach from the ground around (tools/landmark.mts reach loop). None and no openings = no reach loop."),
  seed: z.number().int().default(1).describe("Noise seed (combined with the world seed)."),
});
export type LandmarkOperatorParams = z.infer<typeof landmarkOperatorSchema>;

/** The salt the digest folds in: materials and voxel are part of the bake. */
const saltOf = (p: LandmarkOperatorParams) => JSON.stringify({ m: Object.entries(p.materials).sort(), v: p.voxel });

/** The spec + placement a doc resolves to (generators run here). Throws for an un-inlined `file` source. */
export function landmarkSpecOf(p: LandmarkOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): { spec: LandmarkSpec; at: [number, number]; footY?: number; ground?: OperatorPiece | null; raw: boolean } | null {
  const src = p.source as Record<string, unknown>;
  if ("csg" in src) return { spec: src.csg as LandmarkSpec, at: p.at, raw: false };
  if ("generator" in src) {
    const gen = landmarkGenerator(String(src.generator));
    if (!gen) throw new Error(`landmark "${ctx.id}": no generator "${String(src.generator)}"`);
    const out = gen((src.args ?? {}) as Record<string, unknown>, reader, ctx);
    return { spec: out.spec, at: out.at ?? p.at, footY: out.footY, ground: out.ground, raw: true };
  }
  if ("blender" in src) return null;
  throw new Error(`landmark "${ctx.id}": source.file "${String(src.file)}" is not inlined (apply with \`worldgen op <world> --apply\`, which reads it into source.csg)`);
}

/** Compile the doc's solids (the baker and the preview call this too). */
export function compileLandmarkOperator(p: LandmarkOperatorParams, reader: OperatorFieldReader, ctx: { id: string }, opts: { skipThin?: boolean } = {}): { compiled: CompiledLandmark; at: [number, number]; footY?: number; ground?: OperatorPiece | null } | null {
  const s = landmarkSpecOf(p, reader, ctx);
  if (!s) return null;
  const compiled = compileLandmarkSpec(s.spec, {
    voxel: p.voxel, yaw: s.raw ? 0 : p.yaw, scale: s.raw ? 1 : p.scale, seed: (reader.seed * 7919 + p.seed * 104729) | 0,
    openings: p.openings, salt: saltOf(p), skipThin: s.raw || opts.skipThin,
  });
  return { compiled, at: s.at, footY: s.footY, ground: s.ground };
}

function compileLandmark(p: LandmarkOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const src = p.source as Record<string, unknown>;
  if ("blender" in src) {
    const res = src.resolved as { digest: string; min: number[]; max: number[]; footprint: [number, number][] } | undefined;
    if (!res) return { features: {}, report: { unresolved: `run tools/landmark.mts --resolve for "${ctx.id}" (exports the Blender solids)` } };
    const cosY = Math.cos((p.yaw * Math.PI) / 180), sinY = Math.sin((p.yaw * Math.PI) / 180);
    const cells = res.footprint.map(([x, z]) => [p.at[0] + (x * cosY + z * sinY) * p.scale, p.at[1] + (-x * sinY + z * cosY) * p.scale] as [number, number]);
    return place(p, reader, ctx, cells, p.at, res.digest, Math.hypot(res.max[0]! - res.min[0]!, res.max[2]! - res.min[2]!) / 2 * p.scale, undefined, undefined, { source: "blender" });
  }
  const c = compileLandmarkOperator(p, reader, ctx)!;
  const { cells } = landmarkFootprint(c.compiled, c.at);
  const radius = Math.max(Math.hypot(c.compiled.min[0], c.compiled.min[2]), Math.hypot(c.compiled.max[0], c.compiled.max[2]));
  return place(p, reader, ctx, cells, c.at, c.compiled.digest, radius, c.footY, c.ground, {
    nodes: c.compiled.nodes.length, tiles: c.compiled.tiles.length, voxel: c.compiled.voxel, min: c.compiled.min, max: c.compiled.max,
    roles: [...new Set(c.compiled.roles)], thinSamples: c.compiled.thin.samples, thinSpots: c.compiled.thin.spots.slice(0, 5),
  });
}

function place(p: LandmarkOperatorParams, reader: OperatorFieldReader, ctx: { id: string }, cells: [number, number][], at: [number, number], digest: string, radius: number,
  footOverride: number | undefined, groundOverride: OperatorPiece | null | undefined, extra: Record<string, unknown>): OperatorOutput {
  const g = landmarkGround(cells, at, p.blend, reader, footOverride ?? p.y);
  const patch = groundOverride !== undefined ? groundOverride : g.patch;
  const prefab = landmarkPrefabId(ctx.id, digest);
  return {
    features: {
      ...(patch ? { heightPatches: [patch] } : {}),
      landmarks: [{ id: "landmark", prefab, position: [at[0], g.footY, at[1]], radius: Math.round(radius * 100) / 100, digest }],
    },
    report: { prefab, footY: g.footY, ground: g.ground, footprintCells: cells.length, blend: p.blend.mode, ...extra },
  };
}

// bounds without a full compile (no thin gate): cached per params object
const boundsCache = new WeakMap<object, { x0: number; z0: number; x1: number; z1: number }>();
function landmarkBounds(raw: LandmarkOperatorParams) {
  const hit = boundsCache.get(raw); if (hit) return hit;
  const parsed = landmarkOperatorSchema.safeParse(raw);
  if (!parsed.success) return { x0: (raw.at?.[0] ?? 0) - 60, z0: (raw.at?.[1] ?? 0) - 60, x1: (raw.at?.[0] ?? 0) + 60, z1: (raw.at?.[1] ?? 0) + 60 };
  const p = parsed.data;
  let r = 40;
  const src = p.source as Record<string, unknown>;
  try {
    if ("csg" in src) {
      const c = compileLandmarkSpec(src.csg, { voxel: p.voxel, yaw: p.yaw, scale: p.scale, skipThin: true });
      r = Math.max(Math.hypot(c.min[0], c.min[2]), Math.hypot(c.max[0], c.max[2]));
    } else if ("blender" in src && src.resolved) { const res = src.resolved as { min: number[]; max: number[] }; r = Math.hypot(res.max[0]! - res.min[0]!, res.max[2]! - res.min[2]!) / 2 * p.scale; }
    else if ("generator" in src && (src.args as { radius?: number })?.radius) r = Number((src.args as { radius: number }).radius);
  } catch { /* compile reports it */ }
  const m = r + p.blend.feather + (p.blend.mode === "pad" ? p.blend.apron : 0);
  const b = { x0: p.at[0] - m, z0: p.at[1] - m, x1: p.at[0] + m, z1: p.at[1] + m };
  boundsCache.set(raw, b);
  return b;
}

// ---- the ledges solve as a generator: raw nodes (absolute y, origin = the solve's area centre) + its own ground
registerLandmarkGenerator("ledges", (args, reader, ctx) => {
  const lp = ledgesOperatorSchema.parse({ ...args, mode: "landmark" });
  const grid = solveLedges(lp, reader, ctx).grid;
  const lm = ledgeLandmarkVolume(grid, landmarkOptions(lp, reader));
  return {
    spec: { version: 1, roles: {}, parts: lm.nodes.map((node) => ({ node, role: "rock" })) },
    at: [lm.origin[0], lm.origin[2]], footY: 0, ground: ledgeLandmarkGround(grid, lp.inset, lp.riserSlope),
  };
});

registerOperator<LandmarkOperatorParams>({
  op: "landmark",
  description: "The general LANDMARK STAMP: any shape — a CSG spec (box/sphere/ellipsoid/cylinder/cone/capsule/torus/extrude/lathe/arch parts applied in order with add/sub/intersect + smooth blend, per-part roles and role noise), a Blender stamp (tools/mesh-dc) or a generator (`ledges`) — baked at a fine DC voxel (0.25-0.5 m; shells >= 3 voxels unless `thinOk`), one draw per material, own trimesh collider. Compiles to `landmarks` `op:<id>:landmark` + (bury/pad) one masked height patch `op:<id>:ground` >= 6 m wide. Bake: tools/landmark.mts.",
  schema: landmarkOperatorSchema,
  compile: compileLandmark,
  bounds: landmarkBounds,
  outline: (p) => { const b = landmarkBounds(p); return [[[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]]]; },
});
