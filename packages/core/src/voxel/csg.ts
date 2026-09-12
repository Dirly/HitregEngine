import { z } from "zod";
import { dualContour } from "./dual-contouring.js";
import { perlin3 } from "./noise.js";
import type { VoxelMesh } from "./mesh.js";

/**
 * VOLUMES — solids authored as CSG, meshed by dual contouring.
 *
 * A world recipe describes smooth ground, and marching cubes is the right
 * mesher for it (`./marching-cubes.ts`). This is the other half: built things
 * — a hall, a stair, a tower shaft, a doorway punched through a wall — where
 * the whole point is that an edge is an EDGE. Those two facts are why the
 * engine has two meshers rather than a winner: MC rounds a corner off at
 * lattice resolution and a dual contour solves for where the planes actually
 * meet, which matters enormously for a room and almost not at all for a hill.
 *
 * The document is the truth and the mesh is a cache, exactly as a world recipe
 * is: a dungeon is a few kilobytes of ordered CSG operations, not a region of
 * stored voxels. That is what makes it editable by hand or by an agent, cheap
 * to diff, and impossible to desync from what physics collides with — render,
 * physics and placement all read the ONE mesh this module caches.
 *
 * **Order matters and is the authoring model.** Nodes apply in sequence over
 * empty space: `add` unions rock in, `sub` carves air out, `intersect` clips.
 * A dungeon is therefore written the way it would be dug — a mountain of
 * stone, then halls cut out of it, then pillars added back, then doorways cut
 * through those. Later nodes win, which is what makes "punch a door through
 * that wall" a one-line edit instead of a re-derivation.
 *
 * **Surfaces are painted by whoever last owned the boundary.** Each node
 * carries a floor/wall/ceiling triple of palette indices; a vertex takes the
 * triple of the node whose surface it is standing on and picks from it by
 * NORMAL. So a hall cut through rock is walled in the hall's stone, and a cave
 * blended into the same hall keeps its own — without anyone assigning a
 * material to a triangle. The palette lines up index-for-index with a
 * `terrain-splat` material's layers, which is triplanar, so a volume needs no
 * UVs and a wall tiles the same as a floor.
 */

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Palette indices for the three faces a surface can be, chosen per vertex by normal. */
export const csgSurfaceSchema = z.object({
  floor: z.number().int().min(0).default(0).describe("Palette index for upward-facing surfaces."),
  wall: z.number().int().min(0).default(0).describe("Palette index for vertical surfaces."),
  ceiling: z.number().int().min(0).default(0).describe("Palette index for downward-facing surfaces."),
});

export const csgNodeSchema = z.object({
  id: z.string().default("node"),
  op: z
    .enum(["add", "sub", "intersect"])
    .default("add")
    .describe("`add` unions this shape into the solid, `sub` carves it out as air, `intersect` clips the solid to it."),
  shape: z.enum(["box", "sphere", "ellipsoid", "cylinder", "capsule", "cone", "torus", "wedge", "prism"]).default("box"),
  polygon: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(3).max(128).default([[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]]).describe("Prism footprint in local X/Z metres, extruded by height along Y. Simple non-self-intersecting boundary, either winding; concave outlines allowed. Do not repeat the closing vertex."),
  position: vec3.default([0, 0, 0]),
  /** Euler XYZ in radians. Uniform scale is deliberately absent: it breaks the distance field. */
  rotation: vec3.default([0, 0, 0]),
  /** box/wedge: full extents [w, h, d]. */
  size: vec3.default([1, 1, 1]),
  /** sphere/capsule/cylinder/cone: radius. torus: ring radius. */
  radius: z.number().positive().default(1),
  /** cylinder/capsule/cone: height along local Y. torus: tube radius. */
  height: z.number().positive().default(1),
  round: z
    .number()
    .min(0)
    .default(0)
    .describe("Radius of a rounded edge on this primitive. 0 keeps the corner sharp, which is the whole reason to mesh a volume with dual contouring."),
  blend: z
    .number()
    .min(0)
    .default(0)
    .describe("Smooth-min radius against everything before it. 0 is a hard boolean; raise it where cut rock should melt into a natural cave."),
  surface: csgSurfaceSchema.optional().describe("Palette indices this node paints. Omit to inherit the document default."),
  noise: z.object({amount:z.number().min(0).max(4),scale:z.number().positive(),seed:z.number().int().default(1)}).optional().describe("Bounded two-frequency displacement of this primitive in local metres. Use on cave cuts; leave masonry cuts unperturbed. Disables distance-based block rejection."),
});

export const volumePaintSchema = z.object({
  id: z.string().min(1),
  center: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  radius: z.number().positive().max(100),
  strength: z.number().min(0).max(1),
  layer: z.number().int().min(0),
  normal: z.tuple([z.number().finite(),z.number().finite(),z.number().finite()]).optional().describe("Optional local-space facing direction for an angle-limited area fill."),
  maxAngle: z.number().min(0).max(180).default(180).describe("Maximum angle in degrees from the chosen normal. 180 paints all facing directions."),
  fill: z.boolean().default(false).describe("Uniform coverage inside radius instead of brush falloff. This is a bounded facing-angle fill, not a connected-component flood fill."),
}).describe("Spherical texture stroke in volume-local metres. Smooth falloff; later strokes blend over earlier ones without changing density or collision.");

export const volumeDocSchema = z.object({
  name: z.string().default("volume"),
  voxelSize: z
    .number()
    .positive()
    .default(0.25)
    .describe("Metres between lattice samples. A dungeon wants 0.2-0.3: fine enough that a 0.4 m step reads as a step, coarse enough to mesh in a second."),
  bounds: z
    .object({ min: vec3, max: vec3 })
    .optional()
    .describe("World-space extent to mesh. Omit and it is derived from the nodes, which is what you want unless a node is deliberately unbounded."),
  palette: z
    .array(z.string())
    .min(1)
    .default(["stone"])
    .describe("Surface names, index-for-index with the `terrain-splat` material's splat layers. Names are for humans; the indices are what the mesh carries."),
  surface: csgSurfaceSchema.prefault({}).describe("Default palette triple, used by any node that declares none."),
  nodes: z.array(csgNodeSchema).default([]).describe("Applied IN ORDER over empty space. Later nodes win."),
  paint: z.array(volumePaintSchema).default([]).describe("Persistent ordered texture strokes, evaluated after the CSG surface palette."),
});

export type VolumePaint = z.infer<typeof volumePaintSchema>;
export function blendVolumePaint(stroke: VolumePaint, x: number, y: number, z: number, weights: Float32Array, offset: number, count: number, normal: readonly number[] = [0,1,0]): void {
  if (stroke.layer >= count) return;
  if(stroke.normal){const length=Math.hypot(...stroke.normal)*Math.hypot(...normal);if(length<1e-9)return;const dot=stroke.normal.reduce((s,v,i)=>s+v*normal[i]!,0)/length;if(dot+1e-7<Math.cos(stroke.maxAngle*Math.PI/180))return;}
  const t = Math.max(0, 1 - Math.hypot(x-stroke.center[0], y-stroke.center[1], z-stroke.center[2])/stroke.radius);
  const amount = (stroke.fill?(t>0?1:0):t*t*(3-2*t))*stroke.strength;
  if (!amount) return;
  for(let i=0;i<count;i++) weights[offset+i] = weights[offset+i]!*(1-amount)+(i===stroke.layer?amount:0);
}

export type CsgSurface = z.infer<typeof csgSurfaceSchema>;
export type CsgNode = z.infer<typeof csgNodeSchema>;
export type VolumeDoc = z.infer<typeof volumeDocSchema>;

/** The `mesh.source` shape for a CSG volume. */
export interface CsgMeshSource {
  kind: "csg";
  /** Volume asset id (assets/volumes/<id>.json, sans extension). */
  volume: string;
  /** Coarsen the lattice by this factor (2 = half the samples per axis). */
  lodStep?: number;
}

// ---------------------------------------------------------------------------
// Signed distance
// ---------------------------------------------------------------------------

interface PreparedNode {
  node: CsgNode;
  /** Inverse rotation, row-major 3x3 — world direction into the node's local frame. */
  inv: Float64Array;
  surface: CsgSurface;
  /** World-space AABB of everything this node can affect, blend and round included. */
  min: [number, number, number];
  max: [number, number, number];
}

function eulerMatrix(rx: number, ry: number, rz: number): Float64Array {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // R = Rz * Ry * Rx, row-major
  return Float64Array.from([
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ]);
}

/** Transpose of a rotation is its inverse — no general inverse needed. */
function transpose(m: Float64Array): Float64Array {
  return Float64Array.from([m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]);
}

/** Local half-extent of a shape before rounding, used for both the AABB and the SDF. */
function localExtent(node: CsgNode): [number, number, number] {
  switch (node.shape) {
    case "prism":
      return [Math.max(...node.polygon.map(p=>Math.abs(p[0]))),node.height/2,Math.max(...node.polygon.map(p=>Math.abs(p[1])))];
    case "box":
    case "wedge":
    case "ellipsoid":
      return [node.size[0] / 2, node.size[1] / 2, node.size[2] / 2];
    case "sphere":
      return [node.radius, node.radius, node.radius];
    case "cylinder":
    case "cone":
      return [node.radius, node.height / 2, node.radius];
    case "capsule":
      return [node.radius, node.height / 2 + node.radius, node.radius];
    case "torus":
      return [node.radius + node.height, node.height, node.radius + node.height];
  }
}

function prepare(node: CsgNode, fallback: CsgSurface): PreparedNode {
  const rot = eulerMatrix(node.rotation[0]!, node.rotation[1]!, node.rotation[2]!);
  const inv = transpose(rot);
  const e = localExtent(node);
  const pad = node.round + node.blend + (node.noise?.amount ?? 0);
  // A rotated box's world AABB is the rotated extent, per axis the sum of
  // |R[axis][k]| * extent[k] — the standard conservative bound.
  const half: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    half[a] =
      Math.abs(rot[a * 3]!) * e[0]! + Math.abs(rot[a * 3 + 1]!) * e[1]! + Math.abs(rot[a * 3 + 2]!) * e[2]! + pad;
  }
  return {
    node,
    inv,
    surface: node.surface ?? fallback,
    min: [node.position[0]! - half[0]!, node.position[1]! - half[1]!, node.position[2]! - half[2]!],
    max: [node.position[0]! + half[0]!, node.position[1]! + half[1]!, node.position[2]! + half[2]!],
  };
}

/** Signed distance to one primitive, in its own frame. Negative inside. */
function shapeDistance(node: CsgNode, x: number, y: number, z: number): number {
  const r = node.round;
  switch (node.shape) {
    case "prism": {
      let inside=false, distanceSquared=Infinity;
      const poly=node.polygon;
      for(let i=0,j=poly.length-1;i<poly.length;j=i++){
        const a=poly[j]!,b=poly[i]!,dx=b[0]-a[0],dz=b[1]-a[1];
        const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/Math.max(dx*dx+dz*dz,1e-20)));
        distanceSquared=Math.min(distanceSquared,(x-a[0]-t*dx)**2+(z-a[1]-t*dz)**2);
        if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
      }
      const horizontal=Math.sqrt(distanceSquared)*(inside?-1:1),vertical=Math.abs(y)-node.height/2;
      return Math.hypot(Math.max(horizontal,0),Math.max(vertical,0))+Math.min(Math.max(horizontal,vertical),0)-r;
    }
    case "box": {
      const qx = Math.abs(x) - (node.size[0]! / 2 - r);
      const qy = Math.abs(y) - (node.size[1]! / 2 - r);
      const qz = Math.abs(z) - (node.size[2]! / 2 - r);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const oz = Math.max(qz, 0);
      return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
    }
    case "sphere":
      return Math.sqrt(x * x + y * y + z * z) - node.radius;
    case "ellipsoid": {
      // There is no non-uniform SCALE anywhere in this module, on purpose:
      // scaling a distance field makes it lie about distance, and the block
      // reject, the blend radius and the QEF are all built on it telling the
      // truth. An ellipsoid is the shape people actually wanted scale for, so
      // it gets its own field instead. This is the standard bounded
      // approximation — exact on the axes, an UNDER-estimate elsewhere, which
      // is the safe direction: it makes the block reject more cautious, never
      // less.
      const rx = node.size[0]! / 2;
      const ry = node.size[1]! / 2;
      const rz = node.size[2]! / 2;
      const k0 = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2);
      if (k0 < 1e-9) return -Math.min(rx, ry, rz) - r;
      const k1 = Math.sqrt((x / (rx * rx)) ** 2 + (y / (ry * ry)) ** 2 + (z / (rz * rz)) ** 2);
      return (k0 * (k0 - 1)) / Math.max(k1, 1e-12) - r;
    }
    case "cylinder": {
      const dxz = Math.sqrt(x * x + z * z) - (node.radius - r);
      const dy = Math.abs(y) - (node.height / 2 - r);
      const ox = Math.max(dxz, 0);
      const oy = Math.max(dy, 0);
      return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dxz, dy), 0) - r;
    }
    case "capsule": {
      const half = node.height / 2;
      const cy = y < -half ? -half : y > half ? half : y;
      const dy = y - cy;
      return Math.sqrt(x * x + dy * dy + z * z) - node.radius;
    }
    case "cone": {
      // base at -h/2 with `radius`, apex at +h/2
      const half = node.height / 2;
      const q = Math.sqrt(x * x + z * z);
      // distance to the lateral surface as a 2D line, plus the base plane
      const t = (y + half) / node.height; // 0 at base, 1 at apex
      const rAt = node.radius * (1 - Math.min(Math.max(t, 0), 1));
      const slope = Math.atan2(node.radius, node.height);
      const lateral = (q - rAt) * Math.cos(slope);
      return Math.max(lateral, Math.abs(y) - half) - r;
    }
    case "torus": {
      const q = Math.sqrt(x * x + z * z) - node.radius;
      return Math.sqrt(q * q + y * y) - node.height - r;
    }
    case "wedge": {
      // A right prism: solid below the ramp that rises along +Z. Built as the
      // intersection of five half-spaces, so `max` of the plane distances is
      // the exact distance outside a convex body and a safe under-estimate in.
      const hx = node.size[0]! / 2;
      const hy = node.size[1]! / 2;
      const hz = node.size[2]! / 2;
      // Ramp plane through (z=-hz, y=-hy) and (z=+hz, y=+hy), solid below it.
      // Written as a unit-normal plane distance so `max` stays a real distance.
      const len = Math.hypot(hy, hz);
      const ramp = (y * hz - z * hy) / len;
      return Math.max(Math.abs(x) - hx, -y - hy, z - hz, ramp) - r;
    }
  }
}

const SOLID_OUTSIDE = 1e9;

/** Smooth minimum — the polynomial one, so a blend never overshoots. */
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

export interface Volume {
  readonly doc: VolumeDoc;
  readonly surfaceCount: number;
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  /** Signed density at a point. Negative is solid, matching the rest of the voxel path. */
  density(x: number, y: number, z: number): number;
  /** The same field restricted to a region, with unreachable nodes dropped. */
  sampler(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
  ): (x: number, y: number, z: number) => number;
  /** Splat weights for a vertex, from the node that owns the surface there and the vertex normal. */
  surfaceAt(x: number, y: number, z: number, ny: number, out: Float32Array, offset: number, nx?: number, nz?: number): void;
}

export function createVolume(input: VolumeDoc | unknown): Volume {
  const doc = volumeDocSchema.parse(input);
  const prepared = doc.nodes.map((node) => prepare(node, doc.surface));

  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  if (doc.bounds) {
    min = [...doc.bounds.min] as [number, number, number];
    max = [...doc.bounds.max] as [number, number, number];
  } else {
    for (const p of prepared) {
      // A `sub` node can only ever remove, so it never enlarges the solid.
      if (p.node.op === "sub") continue;
      for (let a = 0; a < 3; a++) {
        if (p.min[a]! < min[a]!) min[a] = p.min[a]!;
        if (p.max[a]! > max[a]!) max[a] = p.max[a]!;
      }
    }
    if (!Number.isFinite(min[0])) {
      min = [-1, -1, -1];
      max = [1, 1, 1];
    }
    // one voxel of air on every side, so the solid is closed rather than
    // clipped flat against the edge of the lattice
    for (let a = 0; a < 3; a++) {
      min[a] = min[a]! - doc.voxelSize * 3;
      max[a] = max[a]! + doc.voxelSize * 3;
    }
  }

  /** Evaluate the node stack. Returns the distance; writes the owning node's index to `owner`. */
  const evaluate = (x: number, y: number, z: number, owner: Int32Array | null, active: PreparedNode[]): number => {
    let d = SOLID_OUTSIDE;
    let who = -1;
    for (let i = 0; i < active.length; i++) {
      const p = active[i]!;
      const node = p.node;
      // conservative reject: outside the node's padded AABB it cannot change d
      // QEF vertices can sit outside the primitive bounds in their surface
      // cell. Keep nearby boundary owners for material queries (two cells
      // cover the cell diagonal), without changing density/collision sampling.
      const margin = owner ? doc.voxelSize * 2 : 0;
      if (x < p.min[0]! - margin || x > p.max[0]! + margin || y < p.min[1]! - margin || y > p.max[1]! + margin || z < p.min[2]! - margin || z > p.max[2]! + margin) {
        if (node.op !== "intersect") continue;
      }
      const px = x - node.position[0]!;
      const py = y - node.position[1]!;
      const pz = z - node.position[2]!;
      const m = p.inv;
      const lx = m[0]! * px + m[1]! * py + m[2]! * pz;
      const ly = m[3]! * px + m[4]! * py + m[5]! * pz;
      const lz = m[6]! * px + m[7]! * py + m[8]! * pz;
      let ds = shapeDistance(node, lx, ly, lz);
      if(node.noise){const n=node.noise,s=n.scale;ds+=n.amount*(.75*perlin3(lx/s,ly/s,lz/s,n.seed)+.25*perlin3(lx/s*2.7,ly/s*2.7,lz/s*2.7,n.seed+17));}
      const before = d;
      if (node.op === "add") {
        d = smoothMin(d, ds, node.blend);
      } else if (node.op === "sub") {
        d = smoothMax(d, -ds, node.blend);
      } else {
        d = smoothMax(d, ds, node.blend);
      }
      // Whoever MOVED the boundary owns the surface here. Comparing against
      // the previous value rather than asking "is this node's own distance
      // smallest" is what makes a doorway cut through a wall wear the
      // doorway's stone instead of the wall's.
      if (Math.abs(d - before) > 1e-9) who = i;
    }
    if (owner) owner[0] = who;
    return d;
  };

  const activeAll = prepared;
  const ownerScratch = new Int32Array(1);

  return {
    doc,
    surfaceCount: doc.palette.length,
    min,
    max,
    density: (x, y, z) => evaluate(x, y, z, null, activeAll),
    /**
     * An evaluator for one region, with every node that cannot reach it
     * dropped. This is the difference between a dungeon meshing in a second
     * and in a minute: the per-sample AABB test is only six compares, but a
     * hundred-node document pays it a hundred times at every one of millions
     * of samples. Filtering once per block pays it a hundred times per BLOCK.
     * An `intersect` node is never dropped — being outside one is precisely
     * when it has an effect.
     */
    sampler: (lo, hi) => {
      const active = prepared.filter(
        (p) =>
          p.node.op === "intersect" ||
          (p.max[0]! >= lo[0]! && p.min[0]! <= hi[0]! && p.max[1]! >= lo[1]! && p.min[1]! <= hi[1]! && p.max[2]! >= lo[2]! && p.min[2]! <= hi[2]!),
      );
      return (x, y, z) => evaluate(x, y, z, null, active);
    },
    surfaceAt: (x, y, z, ny, out, offset, nx=0, nz=0) => {
      evaluate(x, y, z, ownerScratch, activeAll);
      const surface = ownerScratch[0]! >= 0 ? prepared[ownerScratch[0]!]!.surface : doc.surface;
      const count = doc.palette.length;
      for (let s = 0; s < count; s++) out[offset + s] = 0;
      // Blend across the thresholds rather than switching: a hard swap between
      // floor and wall stone draws a visible ring around every pillar base.
      const up = Math.min(1, Math.max(0, (ny - 0.35) / 0.35));
      const down = Math.min(1, Math.max(0, (-ny - 0.35) / 0.35));
      const wall = Math.max(0, 1 - up - down);
      const add = (index: number, weight: number): void => {
        if (weight <= 0) return;
        const i = Math.min(count - 1, Math.max(0, index));
        out[offset + i] = out[offset + i]! + weight;
      };
      add(surface.floor, up);
      add(surface.ceiling, down);
      add(surface.wall, wall);
      for (const stroke of doc.paint) blendVolumePaint(stroke, x, y, z, out, offset, count, [nx,ny,nz]);
      // tint: the material multiplies by it, and a volume has no biome
      out[offset + count] = 1;
      out[offset + count + 1] = 1;
      out[offset + count + 2] = 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------

/** Cells per meshing block. Bounds peak memory; block boundaries share vertices. */
const BLOCK = 24;
const PAD = 2;

/**
 * Mesh a whole volume.
 *
 * The volume is tiled into blocks and dual-contoured one at a time, then
 * concatenated. That is not an optimisation detail — a 60 m dungeon at 0.25 m
 * would otherwise want a single 250-million-sample lattice, and the per-cell
 * vertex map alongside it. Tiling is free here because `dualContour` already
 * had to solve the neighbour-agreement problem for streamed terrain: two
 * blocks compute a shared cell's vertex identically and exactly one of them
 * emits each face, so concatenating the pieces is the whole join.
 */
export function buildVolumeMesh(volume: Volume, lodStep = 1): VoxelMesh {
  const step = volume.doc.voxelSize * Math.max(1, Math.floor(lodStep));
  // Evaluation clips nodes to their AABBs. Its sign is valid there, but its
  // magnitude outside a cut is NOT a conservative distance to that cut.
  // A centre-distance block reject can therefore erase floors between stacked
  // rooms, even for unblended boxes. Sample all candidate blocks instead.
  const surfaceCount = volume.surfaceCount;
  const cells = [0, 1, 2].map((a) => Math.max(1, Math.ceil((volume.max[a]! - volume.min[a]!) / step)));

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const splat: number[] = [];
  const tint: number[] = [];
  let base = 0;

  const attributes = {
    surface: {
      size: surfaceCount + 3,
      compute: (x: number, y: number, z: number, _nx: number, ny: number, _nz: number, out: Float32Array, offset: number) =>
        volume.surfaceAt(x, y, z, ny, out, offset, _nx, _nz),
    },
  };

  for (let bz = 0; bz < cells[2]!; bz += BLOCK) {
    for (let by = 0; by < cells[1]!; by += BLOCK) {
      for (let bx = 0; bx < cells[0]!; bx += BLOCK) {
        const cx = Math.min(BLOCK, cells[0]! - bx);
        const cy = Math.min(BLOCK, cells[1]! - by);
        const cz = Math.min(BLOCK, cells[2]! - bz);
        const origin: [number, number, number] = [
          volume.min[0]! + (bx - PAD) * step,
          volume.min[1]! + (by - PAD) * step,
          volume.min[2]! + (bz - PAD) * step,
        ];
        const nx = cx + 2 * PAD + 1;
        const ny = cy + 2 * PAD + 1;
        const nz = cz + 2 * PAD + 1;
        const density = volume.sampler(origin, [
          origin[0]! + (nx - 1) * step,
          origin[1]! + (ny - 1) * step,
          origin[2]! + (nz - 1) * step,
        ]);
        const values = new Float32Array(nx * ny * nz);
        for (let k = 0; k < nz; k++) {
          const wz = origin[2]! + k * step;
          for (let j = 0; j < ny; j++) {
            const wy = origin[1]! + j * step;
            const row = j * nx + k * nx * ny;
            for (let i = 0; i < nx; i++) {
              values[row + i] = density(origin[0]! + i * step, wy, wz);
            }
          }
        }

        // Hand the contourer the REAL field, not just this lattice's samples.
        // A CSG solid is the one case where the exact function is cheap enough
        // to ask again, and it is what keeps a corner a corner — see
        // `HermiteSource`. The gradient is a tetrahedron difference (four
        // evaluations rather than six) taken over a fraction of a voxel, so at
        // an edge it returns ONE of the two faces' normals instead of the
        // average of them.
        const g = step * 0.02;
        const hermite = {
          value: density,
          gradient: (x: number, y: number, z: number, out: Float64Array): void => {
            const a = density(x + g, y - g, z - g);
            const b = density(x - g, y - g, z + g);
            const c = density(x - g, y + g, z - g);
            const d = density(x + g, y + g, z + g);
            out[0] = a - b - c + d;
            out[1] = -a - b + c + d;
            out[2] = -a + b - c + d;
          },
        };
        const result = dualContour({ values, nx, ny, nz, origin, step }, { pad: PAD, attributes, hermite });
        if (result.triangleCount === 0) continue;

        const interleaved = result.attributes["surface"];
        const stride = surfaceCount + 3;
        for (let i = 0; i < result.vertexCount; i++) {
          positions.push(result.positions[i * 3]!, result.positions[i * 3 + 1]!, result.positions[i * 3 + 2]!);
          normals.push(result.normals[i * 3]!, result.normals[i * 3 + 1]!, result.normals[i * 3 + 2]!);
          if (interleaved) {
            for (let s = 0; s < surfaceCount; s++) splat.push(interleaved[i * stride + s]!);
            tint.push(interleaved[i * stride + surfaceCount]!, interleaved[i * stride + surfaceCount + 1]!, interleaved[i * stride + surfaceCount + 2]!);
          } else {
            for (let s = 0; s < surfaceCount; s++) splat.push(s === 0 ? 1 : 0);
            tint.push(1, 1, 1);
          }
        }
        for (let i = 0; i < result.indices.length; i++) indices.push(result.indices[i]! + base);
        base += result.vertexCount;
      }
    }
  }

  if (indices.length === 0) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      splat: new Float32Array(0),
      surfaceCount,
      tint: new Float32Array(0),
      min: [0, 0, 0],
      max: [0, 0, 0],
      vertexCount: 0,
      triangleCount: 0,
    };
  }

  const pos = Float32Array.from(positions);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i]! < minX) minX = pos[i]!;
    if (pos[i]! > maxX) maxX = pos[i]!;
    if (pos[i + 1]! < minY) minY = pos[i + 1]!;
    if (pos[i + 1]! > maxY) maxY = pos[i + 1]!;
    if (pos[i + 2]! < minZ) minZ = pos[i + 2]!;
    if (pos[i + 2]! > maxZ) maxZ = pos[i + 2]!;
  }
  return {
    positions: pos,
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    splat: Float32Array.from(splat),
    surfaceCount,
    tint: Float32Array.from(tint),
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    vertexCount: pos.length / 3,
    triangleCount: indices.length / 3,
  };
}

// ---------------------------------------------------------------------------
// Registry + cache — the same contract as the world-cell cache next door:
// one mesh, shared by render, physics and placement, so they cannot drift.
// ---------------------------------------------------------------------------

const volumes = new Map<string, Volume>();
const volumeMeshes = new Map<string, VoxelMesh>();

export function registerVolume(id: string, doc: VolumeDoc | unknown): Volume {
  const volume = createVolume(doc);
  const previous = volumes.get(id);
  const paintOnly = previous && JSON.stringify({...previous.doc,paint:[]}) === JSON.stringify({...volume.doc,paint:[]});
  volumes.set(id, volume);
  if(paintOnly){
    for(const [key,mesh] of volumeMeshes){
      if(!key.startsWith(id+":"))continue;
      const weights=new Float32Array(mesh.surfaceCount+3);
      for(let i=0;i<mesh.vertexCount;i++){
        const p=i*3;
        volume.surfaceAt(mesh.positions[p]!,mesh.positions[p+1]!,mesh.positions[p+2]!,mesh.normals[p+1]!,weights,0,mesh.normals[p]!,mesh.normals[p+2]!);
        mesh.splat.set(weights.subarray(0,mesh.surfaceCount),i*mesh.surfaceCount);
      }
    }
  }else invalidateVolume(id);
  return volume;
}

export function getVolume(id: string): Volume | null {
  return volumes.get(id) ?? null;
}

export function volumeIds(): string[] {
  return [...volumes.keys()];
}

export function invalidateVolume(id: string): void {
  for (const key of [...volumeMeshes.keys()]) {
    if (key === id || key.startsWith(`${id}:`)) volumeMeshes.delete(key);
  }
}

export function clearVolumes(): void {
  volumes.clear();
  volumeMeshes.clear();
}

/** Type guard for the mesh-source union, shared by render and physics. */
export function isCsgSource(source: unknown): source is CsgMeshSource {
  return (
    typeof source === "object" &&
    source !== null &&
    (source as { kind?: unknown }).kind === "csg" &&
    typeof (source as { volume?: unknown }).volume === "string"
  );
}

const EMPTY_VOLUME_MESH: VoxelMesh = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  splat: new Float32Array(0),
  surfaceCount: 1,
  tint: new Float32Array(0),
  min: [0, 0, 0],
  max: [0, 0, 0],
  vertexCount: 0,
  triangleCount: 0,
};

/** Mesh a registered volume, cached. An unknown volume meshes to nothing, never throws. */
export function csgMesh(source: CsgMeshSource): VoxelMesh {
  const lodStep = Math.max(1, Math.floor(source.lodStep ?? 1));
  const key = `${source.volume}:${lodStep}`;
  const hit = volumeMeshes.get(key);
  if (hit) return hit;
  const volume = volumes.get(source.volume);
  if (!volume) return EMPTY_VOLUME_MESH;
  const mesh = buildVolumeMesh(volume, lodStep);
  volumeMeshes.set(key, mesh);
  return mesh;
}


