/**
 * LANDMARK STAMP — any hero shape, built the way the dungeons are, standing in the overworld.
 *
 * A landmark spec is an ordered list of PARTS in a local frame (origin = footprint centre at the foot, +Y up, +Z the
 * front): primitives (box, sphere, ellipsoid, cylinder, cone/frustum, capsule, torus, extruded polygon, lathe profile,
 * arch), groups (a shared frame/role), and raw core CSG nodes (generators). Parts apply IN ORDER like every CSG volume:
 * `add` unions, `sub` carves air out of everything before it, `intersect` clips; `blend` is a smooth union/carve. Every
 * part carries a ROLE (rock, masonry, trim...): the role picks the noise (natural rock gets outward-only noise, masonry
 * stays crisp) and, at the bake, the material (the zone's stone through the world palette = one draw, or a named
 * material asset = one draw more).
 *
 * `compileLandmarkSpec` flattens the spec into core CSG nodes (yaw and scale baked in, lathes as closed meshes, arches
 * as extruded outlines, openings carved last and noise-protected), checks the THIN-WALL rule on the noise-free solids
 * (every shell >= 3 voxels unless a part is `thinOk`) and returns the nodes, their roles, lattice-aligned tiles and a
 * digest. `landmarkFootprint` / `landmarkGround` turn it into the terrain blend (`bury` mound, `pad` apron, `none`),
 * every piece >= 6 m wide (FINE_MIN). The operator (`operators-landmark.ts`) places the bake through
 * `features.landmarks` (ledge-landmark.ts schema); `tools/landmark.mts` bakes it.
 */
import { z } from "zod";
import { createVolume, type CsgNode } from "./csg.js";
import { landmarkDigest } from "./ledge-landmark.js";
import { FINE_MIN, type OperatorFieldReader, type OperatorPiece } from "./operator-registry.js";

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const landmarkNoiseSchema = z.object({
  amount: z.number().min(0).max(4).describe("Peak displacement, metres."),
  scale: z.number().positive().describe("Feature size of the first octave, metres."),
  octaves: z.number().int().min(1).max(5).optional(),
  grow: z.boolean().default(true).describe("Outward only (default): the noise never thins a wall."),
  seed: z.number().int().optional(),
});

const SHAPES = ["box", "sphere", "ellipsoid", "cylinder", "cone", "capsule", "torus", "extrude", "lathe", "arch", "group"] as const;

export interface LandmarkPart {
  name?: string; op?: "add" | "sub" | "intersect"; shape?: (typeof SHAPES)[number];
  at?: [number, number, number]; rot?: [number, number, number]; role?: string; blend?: number; round?: number; thinOk?: boolean;
  noise?: z.infer<typeof landmarkNoiseSchema> | null;
  size?: [number, number, number]; r?: number; h?: number; R?: number; top?: number;
  polygon?: [number, number][]; profile?: [number, number][]; segments?: number;
  span?: number; rise?: number; legs?: number; thickness?: number; depth?: number;
  parts?: LandmarkPart[]; node?: CsgNode;
}

export const landmarkPartSchema: z.ZodType<LandmarkPart> = z.lazy(() =>
  z.object({
    name: z.string().optional().describe("Label (thin-wall faults and reports name it)."),
    op: z.enum(["add", "sub", "intersect"]).optional().describe("`add` (default) unions; `sub` carves air out of EVERYTHING BEFORE it in the list; `intersect` clips everything before it."),
    shape: z.enum(SHAPES).optional().describe("Primitive or `group`. Omit only with `node`."),
    at: vec3.optional().describe("Position in the parent frame: the CENTRE of box/sphere/ellipsoid/torus, the BASE centre of cylinder/cone/capsule/extrude/lathe/arch and a group's origin."),
    rot: vec3.optional().describe("Degrees, Euler XYZ (R = Rz*Ry*Rx)."),
    role: z.string().optional().describe("Material/noise role (inherited from the group; default `rock`)."),
    blend: z.number().min(0).max(8).optional().describe("Smooth-min radius against everything before it (smooth union / smooth carve), metres."),
    round: z.number().min(0).max(4).optional().describe("Rounded edges, metres."),
    thinOk: z.boolean().optional().describe("Exempt from the thin-wall rule (a railing, a fin, a spire tip)."),
    noise: landmarkNoiseSchema.nullable().optional().describe("Overrides the role's noise; null = crisp."),
    size: vec3.optional().describe("box / ellipsoid full extents [w, h, d]."),
    r: z.number().positive().optional().describe("Radius: sphere, cylinder, cone base, capsule; torus TUBE radius."),
    h: z.number().positive().optional().describe("Height: cylinder, cone, capsule (total), extrude."),
    R: z.number().positive().optional().describe("Torus ring radius."),
    top: z.number().min(0).optional().describe("Cone top radius (a frustum; compiled as a lathe)."),
    polygon: z.array(xz).min(3).max(128).optional().describe("Extrude outline [x, z] (no repeated closing vertex)."),
    profile: z.array(xz).min(2).max(128).optional().describe("Lathe profile [radius, y] bottom to top (radius >= 0)."),
    segments: z.number().int().min(6).max(64).optional().describe("Lathe / arch subdivisions (default 24 / 16)."),
    span: z.number().positive().optional().describe("Arch opening width (X)."),
    rise: z.number().positive().optional().describe("Arch opening height above the springing."),
    legs: z.number().min(0).optional().describe("Arch springing height (straight jambs below the curve)."),
    thickness: z.number().positive().optional().describe("Arch ring band (>= 3 voxels)."),
    depth: z.number().positive().optional().describe("Arch depth through the opening (Z)."),
    parts: z.array(landmarkPartSchema).optional().describe("Group children, in the group's frame."),
    node: z.unknown().optional().describe("A raw core CSG node passed through (generators); its position/rotation are in the parent frame."),
  }).strict(),
) as z.ZodType<LandmarkPart>;

export const landmarkSpecSchema = z.object({
  version: z.literal(1),
  roles: z.record(z.string(), z.object({ noise: landmarkNoiseSchema.nullable().optional() }).strict()).default({}).describe("Per-role defaults. `rock` (and any role named rock/cliff/stone-natural) gets outward rock noise unless set; every other role is crisp."),
  parts: z.array(landmarkPartSchema).min(1).describe("Applied IN ORDER (the CSG rule)."),
}).describe("A landmark shape in its LOCAL frame: origin = footprint centre at the foot (y 0 = where the ground meets it), +Y up, +Z the front.");
export type LandmarkSpec = z.infer<typeof landmarkSpecSchema>;

export const landmarkOpeningSchema = z.object({
  name: z.string(),
  at: vec3.describe("Spec-local FLOOR centre of the doorway."),
  width: z.number().min(1).max(30),
  height: z.number().min(1.8).max(40),
  depth: z.number().min(0.5).max(40).default(3).describe("Through-depth along the opening's facing."),
  yaw: z.number().default(0).describe("Degrees; 0 = the opening passes along Z."),
});
export type LandmarkOpening = z.infer<typeof landmarkOpeningSchema>;

/** Natural-rock roles: outward noise by default, triplanar zone stone by default. */
export const isNaturalRole = (role: string) => /^(rock|cliff|boulder|natural|stone-natural|scree)/i.test(role);
export const DEFAULT_ROCK_NOISE = { amount: 0.45, scale: 2.4, octaves: 3, grow: true } as const;

// ---- small math: R = Rz*Ry*Rx row-major (csg.ts eulerMatrix)
type M3 = number[];
const D2R = Math.PI / 180;
function euler(rx: number, ry: number, rz: number): M3 {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}
const mul = (a: M3, b: M3): M3 => { const o: M3 = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!); return o; };
const apply = (m: M3, v: number[]): [number, number, number] => [m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!, m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!, m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!];
const applyT = (m: M3, v: number[]): [number, number, number] => [m[0]! * v[0]! + m[3]! * v[1]! + m[6]! * v[2]!, m[1]! * v[0]! + m[4]! * v[1]! + m[7]! * v[2]!, m[2]! * v[0]! + m[5]! * v[1]! + m[8]! * v[2]!];
function toEuler(m: M3): [number, number, number] {
  const sy = -m[6]!;
  if (Math.abs(sy) > 0.99999) { const s = Math.sign(sy); return [Math.atan2(m[1]! * s, m[4]!), (s * Math.PI) / 2, 0]; }
  return [Math.atan2(m[7]!, m[8]!), Math.asin(sy), Math.atan2(m[3]!, m[0]!)];
}
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface Frame { R: M3; t: [number, number, number]; s: number; role: string }

/** A closed lathe solid (profile [radius, y] bottom->top) as a core triangle mesh: rings + caps, outward winding. */
export function latheMesh(profile: [number, number][], segments: number): { positions: number[]; indices: number[] } {
  const prof = profile.filter((p, i) => i === 0 || p[0] !== profile[i - 1]![0] || p[1] !== profile[i - 1]![1]);
  const positions: number[] = [], indices: number[] = [];
  const ring: number[] = []; // first vertex index of each profile ring (or a single vertex when radius 0)
  for (const [rad, y] of prof) {
    ring.push(positions.length / 3);
    if (rad <= 1e-6) { positions.push(0, y, 0); continue; }
    for (let k = 0; k < segments; k++) { const a = (2 * Math.PI * k) / segments; positions.push(r4(rad * Math.cos(a)), y, r4(-rad * Math.sin(a))); }
  }
  const single = (i: number) => prof[i]![0] <= 1e-6;
  const v = (i: number, k: number) => (single(i) ? ring[i]! : ring[i]! + (k % segments));
  for (let i = 0; i < prof.length - 1; i++) for (let k = 0; k < segments; k++) {
    const a = v(i, k), b = v(i, k + 1), c = v(i + 1, k + 1), d = v(i + 1, k);
    if (!single(i)) indices.push(a, b, c);
    if (!single(i + 1)) indices.push(a, c, d);
  }
  return { positions, indices };
}

/** Arch outline in X/Y (opening span x rise over `legs` jambs, ring `thickness`), as a CCW polygon. */
export function archOutline(span: number, rise: number, legs: number, thickness: number, segments: number): [number, number][] {
  const out: [number, number][] = [], inner: [number, number][] = [];
  const a = span / 2, A = a + thickness, B = rise + thickness;
  out.push([A, 0]);
  for (let k = 0; k <= segments; k++) { const t = (Math.PI * k) / segments; out.push([r4(A * Math.cos(t)), r4(legs + B * Math.sin(t))]); }
  out.push([-A, 0], [-a, 0]);
  for (let k = segments; k >= 0; k--) { const t = (Math.PI * k) / segments; inner.push([r4(a * Math.cos(t)), r4(legs + rise * Math.sin(t))]); }
  const poly = [...out, ...inner, [a, 0] as [number, number]];
  // drop consecutive duplicates (legs 0 makes the springing points coincide)
  return poly.filter((p, i) => { const q = poly[(i + poly.length - 1) % poly.length]!; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6; });
}

export interface CompiledLandmark {
  nodes: CsgNode[];
  /** Role of each node (index-for-index with `nodes`); openings are `opening`. */
  roles: string[];
  /** Part name of each node (faults name it). */
  names: string[];
  min: [number, number, number];
  max: [number, number, number];
  tiles: { min: [number, number, number]; max: [number, number, number] }[];
  voxel: number;
  digest: string;
  thin: { refused: boolean; spots: { part: string; at: [number, number, number]; thickness: number; samples: number }[]; samples: number };
}

export interface LandmarkCompileOptions {
  voxel: number; yaw?: number; scale?: number; seed?: number;
  openings?: LandmarkOpening[];
  /** Extra text folded into the digest (the materials map: a material change is a new bake). */
  salt?: string;
  /** Skip the thin-wall gate (raw generator nodes own their rules). */
  skipThin?: boolean;
}

export class LandmarkThinWallError extends Error {
  constructor(readonly spots: CompiledLandmark["thin"]["spots"], voxel: number) {
    super(`landmark thin walls (< 3 voxels = ${3 * voxel} m; flag a deliberate thin part "thinOk"): ${spots.slice(0, 6).map((s) => `${s.part} ${s.thickness} m at ${s.at.join(",")} (${s.samples} samples)`).join("; ")}`);
  }
}

/** Flatten the spec into core CSG nodes in the landmark's local frame (yaw + scale baked in). Pure, deterministic. */
export function compileLandmarkSpec(input: unknown, o: LandmarkCompileOptions): CompiledLandmark {
  const spec = landmarkSpecSchema.parse(input);
  const nodes: CsgNode[] = [], roles: string[] = [], names: string[] = [], thinOk: boolean[] = [];
  const s0 = o.scale ?? 1;
  const root: Frame = { R: euler(0, (o.yaw ?? 0) * D2R, 0), t: [0, 0, 0], s: s0, role: "rock" };
  const noiseFor = (part: LandmarkPart, role: string): LandmarkPart["noise"] => {
    if (part.noise !== undefined) return part.noise;
    const r = spec.roles[role];
    if (r && r.noise !== undefined) return r.noise;
    return isNaturalRole(role) ? { ...DEFAULT_ROCK_NOISE } : null;
  };
  let seq = 0;
  const push = (f: Frame, part: LandmarkPart, local: { shape: CsgNode["shape"]; at: number[]; R: M3 }, extra: Record<string, unknown>) => {
    const R = mul(f.R, local.R);
    const p = apply(f.R, local.at.map((v) => v * f.s));
    const role = part.role ?? f.role;
    const nz = noiseFor(part, role);
    const name = part.name ?? `${part.shape}-${seq}`;
    nodes.push({
      id: `${name}#${seq++}`, op: part.op ?? "add", shape: local.shape,
      position: [r4(p[0] + f.t[0]), r4(p[1] + f.t[1]), r4(p[2] + f.t[2])], rotation: toEuler(R).map(r4) as [number, number, number],
      round: r4((part.round ?? 0) * f.s), blend: r4((part.blend ?? 0) * f.s),
      ...(nz && nz.amount > 0 ? { noise: { amount: r4(Math.min(4, nz.amount * f.s)), scale: r4(nz.scale * f.s), seed: ((o.seed ?? 1) * 31 + (nz.seed ?? seq)) | 0, ...(nz.octaves ? { octaves: nz.octaves } : {}), ...(nz.grow !== false ? { grow: true } : {}) } } : {}),
      ...extra,
    } as unknown as CsgNode);
    roles.push(role); names.push(name); thinOk.push(!!part.thinOk);
  };
  const need = (part: LandmarkPart, k: keyof LandmarkPart) => { const v = part[k]; if (v === undefined) throw new Error(`landmark part "${part.name ?? part.shape}": ${part.shape} needs \`${String(k)}\``); return v as number; };
  const walk = (parts: LandmarkPart[], f: Frame) => {
    for (const part of parts) {
      const at = part.at ?? [0, 0, 0], rot = part.rot ?? [0, 0, 0];
      const Rl = euler(rot[0]! * D2R, rot[1]! * D2R, rot[2]! * D2R);
      const s = f.s, up = (dy: number) => apply(Rl, [0, dy, 0]); // base-anchored shapes: centre = at + R*(0, h/2, 0)
      const base = (h: number) => { const u = up(h / 2); return [at[0]! + u[0], at[1]! + u[1], at[2]! + u[2]]; };
      if (part.node) {
        const n = part.node as CsgNode;
        const R = mul(f.R, euler(n.rotation?.[0] ?? 0, n.rotation?.[1] ?? 0, n.rotation?.[2] ?? 0));
        const p = apply(f.R, (n.position ?? [0, 0, 0]).map((v) => v * f.s));
        nodes.push({ ...n, id: `${n.id ?? "node"}#${seq++}`, position: [r4(p[0] + f.t[0]), r4(p[1] + f.t[1]), r4(p[2] + f.t[2])], rotation: toEuler(R).map(r4) as [number, number, number] } as CsgNode);
        roles.push(part.role ?? f.role); names.push(part.name ?? String(n.id ?? "node")); thinOk.push(true);
        continue;
      }
      switch (part.shape) {
        case "group": {
          const R = mul(f.R, Rl), p = apply(f.R, at.map((v) => v * f.s));
          walk(part.parts ?? [], { R, t: [p[0] + f.t[0], p[1] + f.t[1], p[2] + f.t[2]], s: f.s, role: part.role ?? f.role });
          break;
        }
        case "box": case "ellipsoid": {
          const sz = need(part, "size") as unknown as number[];
          push(f, part, { shape: part.shape, at, R: Rl }, { size: sz.map((v) => r4(v * s)) });
          break;
        }
        case "sphere": push(f, part, { shape: "sphere", at, R: Rl }, { radius: r4(need(part, "r") * s) }); break;
        case "torus": push(f, part, { shape: "torus", at, R: Rl }, { radius: r4(need(part, "R") * s), height: r4(need(part, "r") * s) }); break;
        case "cylinder": { const h = need(part, "h"); push(f, part, { shape: "cylinder", at: base(h), R: Rl }, { radius: r4(need(part, "r") * s), height: r4(h * s) }); break; }
        case "capsule": {
          const h = need(part, "h"), r = need(part, "r");
          if (h < 2 * r) throw new Error(`landmark part "${part.name ?? "capsule"}": capsule h (total) must be >= 2r`);
          push(f, part, { shape: "capsule", at: base(h), R: Rl }, { radius: r4(r * s), height: r4((h - 2 * r) * s || 0.001) });
          break;
        }
        case "cone": {
          const h = need(part, "h"), r = need(part, "r");
          if (part.top && part.top > 0) { const m = latheMesh([[0, 0], [r * s, 0], [part.top * s, h * s], [0, h * s]], part.segments ?? 24); push(f, part, { shape: "mesh", at, R: Rl }, { mesh: m }); }
          else push(f, part, { shape: "cone", at: base(h), R: Rl }, { radius: r4(r * s), height: r4(h * s) });
          break;
        }
        case "extrude": {
          const h = need(part, "h"), poly = part.polygon; if (!poly) throw new Error(`landmark part "${part.name ?? "extrude"}": extrude needs \`polygon\``);
          push(f, part, { shape: "prism", at: base(h), R: Rl }, { polygon: poly.map(([x, z]) => [r4(x * s), r4(z * s)]), height: r4(h * s) });
          break;
        }
        case "lathe": {
          const prof = part.profile; if (!prof) throw new Error(`landmark part "${part.name ?? "lathe"}": lathe needs \`profile\``);
          const closed: [number, number][] = [...(prof[0]![0] > 0 ? [[0, prof[0]![1]] as [number, number]] : []), ...prof, ...(prof[prof.length - 1]![0] > 0 ? [[0, prof[prof.length - 1]![1]] as [number, number]] : [])];
          push(f, part, { shape: "mesh", at, R: Rl }, { mesh: latheMesh(closed.map(([rr, y]) => [rr * s, y * s]), part.segments ?? 24) });
          break;
        }
        case "arch": {
          const span = need(part, "span"), rise = need(part, "rise"), th = need(part, "thickness"), depth = need(part, "depth"), legs = part.legs ?? 0;
          // the outline lies in X/Y; a prism extrudes along its local Y, Rx(-90) maps local (x, y, z) -> (x, z, -y): the
          // polygon's second coordinate becomes height and the extrusion (centred on `at`) runs along Z
          const outline = archOutline(span * s, rise * s, legs * s, th * s, part.segments ?? 16);
          const R = mul(Rl, euler(-Math.PI / 2, 0, 0));
          push(f, part, { shape: "prism", at, R }, { polygon: outline, height: r4(depth * s) });
          break;
        }
        default: throw new Error(`landmark part "${part.name ?? "?"}": unknown shape ${String(part.shape)}`);
      }
    }
  };
  walk(spec.parts, root);
  // openings: carved LAST (kept clear whatever was added) and protected from every noised node
  for (const op of o.openings ?? []) {
    const Ry = euler(0, op.yaw * D2R, 0);
    const c = [op.at[0], op.at[1] + op.height / 2, op.at[2]];
    push(root, { name: `opening:${op.name}`, op: "sub", noise: null, role: "opening" }, { shape: "box", at: c, R: Ry }, { size: [r4(op.width * s0), r4(op.height * s0), r4(op.depth * s0)] });
    const wc = apply(root.R, c.map((v) => v * s0)), rad = (Math.max(op.width, op.height) / 2 + 0.3) * s0;
    for (const n of nodes) if (n.noise) {
      const R = euler(n.rotation[0]!, n.rotation[1]!, n.rotation[2]!);
      const a = applyT(R, [wc[0] - n.position[0]!, wc[1] - n.position[1]!, wc[2] - n.position[2]!]).map(r3) as [number, number, number];
      (n.noise as { protect?: unknown[] }).protect = [...((n.noise as { protect?: unknown[] }).protect ?? []), { a, radius: r3(rad), fade: 1 }];
    }
  }
  const vol = createVolume({ voxelSize: o.voxel, nodes, palette: ["stone"] });
  const min = vol.min.map(r3) as [number, number, number], max = vol.max.map(r3) as [number, number, number];
  const f = o.voxel, snapDown = (v: number) => Math.floor(v / f) * f, snapUp = (v: number) => Math.ceil(v / f) * f;
  const TILE = 32, tiles: CompiledLandmark["tiles"] = [];
  const lo = [snapDown(min[0] - f * 2), snapDown(min[1] - f * 2), snapDown(min[2] - f * 2)], hi = [snapUp(max[0] + f * 2), snapUp(max[1] + f * 2), snapUp(max[2] + f * 2)];
  for (let z = lo[2]!; z < hi[2]!; z += TILE) for (let x = lo[0]!; x < hi[0]!; x += TILE)
    tiles.push({ min: [r3(x), r3(lo[1]!), r3(z)], max: [r3(Math.min(hi[0]!, x + TILE)), r3(hi[1]!), r3(Math.min(hi[2]!, z + TILE))] });
  const thin = o.skipThin ? { refused: false, spots: [], samples: 0 } : thinWallCheck(nodes, names, thinOk, f);
  if (thin.refused) throw new LandmarkThinWallError(thin.spots, f);
  const digest = landmarkDigest(JSON.stringify({ f, nodes, roles, salt: o.salt ?? "" }));
  return { nodes, roles, names, min, max, tiles, voxel: f, digest, thin };
}

/**
 * THIN-WALL GATE on the noise-free solids: every surface sample (a solid lattice point at `voxel` with an air
 * neighbour) marches inward along the field gradient; leaving the solid within 3 voxels is a thin wall. Spots on a
 * `thinOk` part's own surface are exempt. Refuses when any part has > 3 thin samples (one stray sample is lattice noise).
 */
export function thinWallCheck(nodes: CsgNode[], names: string[], thinOk: boolean[], voxel: number, minVoxels = 3): CompiledLandmark["thin"] {
  const plain = nodes.map((n) => { const { noise: _n, ...rest } = n as CsgNode & { noise?: unknown }; return rest as CsgNode; });
  // padded bounds: outside its bounds a volume reads as far air (1e9), which would wreck the gradients at the edge
  const v0 = createVolume({ voxelSize: voxel, nodes: plain, palette: ["stone"] });
  const pad = voxel * 6, bounds = { min: v0.min.map((v) => v - pad) as [number, number, number], max: v0.max.map((v) => v + pad) as [number, number, number] };
  const vol = createVolume({ voxelSize: voxel, nodes: plain, palette: ["stone"], bounds });
  const one = (n: CsgNode) => createVolume({ voxelSize: voxel, nodes: [{ ...n, op: "add", blend: 0 }], palette: ["stone"], bounds });
  const own = plain.map((n) => (n.op === "add" ? one(n) : null));
  const subOwn = plain.map((n) => (n.op !== "add" ? one(n) : null));
  const h = voxel, limit = minVoxels * voxel - h * 0.35, d = (x: number, y: number, z: number) => vol.density(x, y, z);
  const nx = Math.ceil((vol.max[0] - vol.min[0]) / h) + 2, ny = Math.ceil((vol.max[1] - vol.min[1]) / h) + 2, nz = Math.ceil((vol.max[2] - vol.min[2]) / h) + 2;
  const x0 = vol.min[0] - h, y0 = vol.min[1] - h, z0 = vol.min[2] - h;
  const D = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) D[(k * ny + j) * nx + i] = d(x0 + i * h, y0 + j * h, z0 + k * h);
  const at = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 1 : D[(k * ny + j) * nx + i]!);
  const byPart = new Map<string, { part: string; at: [number, number, number]; thickness: number; samples: number }>();
  let samples = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (at(i, j, k) >= 0) continue;
    if (at(i + 1, j, k) < 0 && at(i - 1, j, k) < 0 && at(i, j + 1, k) < 0 && at(i, j - 1, k) < 0 && at(i, j, k + 1) < 0 && at(i, j, k - 1) < 0) continue;
    // the field is narrow-band (far air = 1e9 outside a node's box): normals from the lattice, outside clamped to h
    const x = x0 + i * h, y = y0 + j * h, z = z0 + k * h, C = (ii: number, jj: number, kk: number) => Math.min(at(ii, jj, kk), h);
    let gx = C(i + 1, j, k) - C(i - 1, j, k), gy = C(i, j + 1, k) - C(i, j - 1, k), gz = C(i, j, k + 1) - C(i, j, k - 1);
    const gl = Math.hypot(gx, gy, gz); if (gl < 1e-9) continue;
    gx /= gl; gy /= gl; gz /= gl;
    // from this inside sample (|d0| under the surface) march inward until the solid is left
    const d0 = -at(i, j, k), sx = x + gx * d0, sy = y + gy * d0, sz = z + gz * d0;
    let exit = -1;
    for (let t = h * 0.25; t + d0 < limit; t += h * 0.25) if (d(x - gx * t, y - gy * t, z - gz * t) >= 0) { exit = t + d0; break; }
    if (exit < 0) continue;
    // which part owns this surface: the add node nearest its own surface (or the sub node carving it)
    let best = -1, bd = Infinity;
    for (let q = 0; q < plain.length; q++) { const v = own[q] ?? subOwn[q]; if (!v) continue; const dd = Math.abs(v.density(sx, sy, sz)); if (dd < bd) { bd = dd; best = q; } }
    // exempt when a thinOk part's surface bounds this wall (within its thickness + a voxel): a fin, a railing, a shell
    if (plain.some((_, q) => thinOk[q] && Math.abs((own[q] ?? subOwn[q])!.density(sx, sy, sz)) < exit + voxel)) continue;
    samples++;
    const part = best >= 0 ? names[best]! : "?";
    const cur = byPart.get(part);
    if (cur) { cur.samples++; if (exit < cur.thickness) { cur.thickness = r3(exit); cur.at = [r3(sx), r3(sy), r3(sz)]; } }
    else byPart.set(part, { part, at: [r3(sx), r3(sy), r3(sz)], thickness: r3(exit), samples: 1 });
  }
  const spots = [...byPart.values()].sort((a, b) => b.samples - a.samples);
  return { refused: spots.some((s) => s.samples > 3), spots, samples };
}

/** The foot outline: the spec-local solid cells (1 m, y 0..3 above the foot) as world XZ points, given the placement. */
export function landmarkFootprint(c: CompiledLandmark, at: [number, number]): { cells: [number, number][]; cell: number } {
  const plain = c.nodes.map((n) => { const { noise: _n, ...rest } = n as CsgNode & { noise?: unknown }; return rest as CsgNode; });
  const vol = createVolume({ voxelSize: 1, nodes: plain, palette: ["stone"] });
  const cells: [number, number][] = [], g = 1;
  for (let z = Math.floor(c.min[2]); z <= Math.ceil(c.max[2]); z += g) for (let x = Math.floor(c.min[0]); x <= Math.ceil(c.max[0]); x += g)
    if ([0.25, 1.25, 2.5].some((y) => vol.density(x, y, z) < 0)) cells.push([x + at[0], z + at[1]]);
  return { cells, cell: g };
}

export const landmarkBlendSchema = z.object({
  mode: z.enum(["bury", "pad", "none"]).default("bury").describe("`bury`: spec y 0 sinks `depth` under the LOWEST ground of the footprint and a mound feathers the terrain up over the foot. `pad`: a flat apron at the foot level. `none`: spec y 0 = ground at `at`, no terrain edit."),
  depth: z.number().min(1).max(12).default(1.5).describe("bury: metres the foot sinks under the lowest ground of the footprint (>= 1)."),
  mound: z.number().min(0).max(4).default(0.8).describe("bury: metres the terrain rises against the foot (hides the cut line), fading out over `feather`."),
  feather: z.number().min(FINE_MIN).max(40).default(8).describe("Metres over which the edit fades back to the natural ground (>= 6: the FINE_MIN rule)."),
  apron: z.number().min(FINE_MIN).max(60).default(6).describe("pad: flat apron width around the foot (>= 6)."),
});
export type LandmarkBlend = z.infer<typeof landmarkBlendSchema>;

/** Foot level (world y of spec y 0) and the terrain height patch for the blend (null for `none`). */
export function landmarkGround(cells: [number, number][], at: [number, number], blend: LandmarkBlend, reader: OperatorFieldReader, y?: number): { footY: number; patch: OperatorPiece | null; ground: { min: number; median: number } } {
  const gs = cells.length ? cells.map(([x, z]) => reader.height(x, z)).sort((a, b) => a - b) : [reader.height(at[0], at[1])];
  const ground = { min: r3(gs[0]!), median: r3(gs[gs.length >> 1]!) };
  const footY = r3(y ?? (blend.mode === "bury" ? ground.min - blend.depth : blend.mode === "pad" ? ground.median : reader.height(at[0], at[1])));
  if (blend.mode === "none" || !cells.length) return { footY, patch: null, ground };
  const g = reader.voxelSize, reach = (blend.mode === "pad" ? blend.apron : 0) + blend.feather + g;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of cells) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  x0 = Math.floor((x0 - reach) / g) * g; z0 = Math.floor((z0 - reach) / g) * g; x1 = Math.ceil((x1 + reach) / g) * g; z1 = Math.ceil((z1 + reach) / g) * g;
  const cols = Math.round((x1 - x0) / g) + 1, rows = Math.round((z1 - z0) / g) + 1;
  // distance to the footprint (coarse buckets keep it linear-ish)
  const B = 4, buckets = new Map<string, [number, number][]>();
  for (const p of cells) { const k = `${Math.floor(p[0] / B)},${Math.floor(p[1] / B)}`; (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(p); }
  const dist = (x: number, z: number) => {
    let best = Infinity; const R = Math.ceil(reach / B) + 1, bx = Math.floor(x / B), bz = Math.floor(z / B);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) for (const p of buckets.get(`${bx + dx},${bz + dz}`) ?? []) best = Math.min(best, Math.hypot(p[0] - x, p[1] - z));
    return best;
  };
  const sm = (a: number, b: number, t: number) => { const u = Math.max(0, Math.min(1, (t - a) / (b - a))); return u * u * (3 - 2 * u); };
  const heights: number[] = [], weights: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c * g, z = z0 + r * g, s = dist(x, z), h0 = reader.height(x, z);
    let hgt = h0, w = 0;
    if (blend.mode === "bury") { const u = 1 - sm(0, blend.feather, s); hgt = h0 + blend.mound * u; w = s <= blend.feather + g ? 1 : 0; }
    else { const u = sm(blend.apron, blend.apron + blend.feather, s); hgt = footY + (h0 - footY) * u; w = s <= blend.apron + blend.feather + g ? 1 : 0; }
    heights.push(Math.round(hgt * 100) / 100); weights.push(w);
  }
  const patch: OperatorPiece = { id: "ground", origin: [x0, z0], size: [(cols - 1) * g, (rows - 1) * g], columns: cols, rows, heights, weights, blend: 2 * g, ...(blend.mode === "pad" ? { maxSlope: 1 } : {}) };
  return { footY, patch, ground };
}

/** Generators: a name -> a spec (raw core nodes allowed) built from args and the ground. `ledges` registers in operators-landmark.ts. */
export type LandmarkGenerator = (args: Record<string, unknown>, reader: OperatorFieldReader, ctx: { id: string }) => { spec: LandmarkSpec; at?: [number, number]; footY?: number; ground?: OperatorPiece | null };
const GENERATORS = new Map<string, LandmarkGenerator>();
export function registerLandmarkGenerator(name: string, gen: LandmarkGenerator): void { GENERATORS.set(name, gen); }
export function landmarkGenerator(name: string): LandmarkGenerator | undefined { return GENERATORS.get(name); }
export function landmarkGeneratorNames(): string[] { return [...GENERATORS.keys()].sort(); }
