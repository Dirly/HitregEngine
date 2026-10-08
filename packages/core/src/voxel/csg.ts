import { z } from "zod";
import { dualContour } from "./dual-contouring.js";
import { perlin3 } from "./noise.js";
import type { VoxelMesh } from "./mesh.js";
import { csgTriangleMeshSchema, compileTriangleMesh, type CompiledTriangleMesh } from "./triangle-mesh.js";

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

/** One region where a node's noise fades out: a capsule (segment a..b, or a point when b is omitted) or a box. */
const csgNoiseProtectSchema = z.union([
  z.object({
    a: vec3.describe("Capsule start, node-local metres (for an imported stamp: entrance-anchor frame, Y up)."),
    b: vec3.optional().describe("Capsule end. Omit for a sphere at `a`."),
    radius: z.number().min(0).default(0).describe("Inside this distance of the segment the noise is zero."),
    fade: z.number().positive().default(1).describe("Over this further distance the noise ramps (smoothstep) back to full."),
  }).strict(),
  z.object({
    min: vec3.describe("Box minimum corner, node-local metres."),
    max: vec3.describe("Box maximum corner, node-local metres."),
    fade: z.number().positive().default(1).describe("Outside the box the noise ramps (smoothstep) back to full over this distance."),
  }).strict(),
  z.object({
    floors: z.object({
      origin: z.tuple([z.number(), z.number()]).describe("Grid corner [x, z], node-local metres."),
      cell: z.number().positive().describe("Cell size in metres (square cells in X/Z)."),
      columns: z.number().int().positive().max(4096),
      rows: z.number().int().positive().max(4096),
      spans: z.array(z.array(z.number())).describe("One entry per cell (row-major, columns along X): flat [lo, hi, lo, hi, ...] floor-height ranges in that cell; [] = no floor."),
    }).describe("Walkable floor heights on a grid. tools/mesh-dc noise.mjs derives it from the stamp's own exposed up-facing faces, dilated past the floor edge so wall feet are covered."),
    above: z.number().min(0).default(0.6).describe("Up to this height above a floor the noise is zero (wall feet meet the floor clean and vertical)."),
    below: z.number().min(0).default(0.2).describe("Down to this depth below a floor the noise is zero."),
    fade: z.number().positive().default(0.4).describe("Beyond the band the noise ramps (smoothstep, vertically) back to full over this distance."),
  }).strict().describe("Floor band: noise fades to zero in a band around each walkable floor, so noised rock walls meet the floor crisp and leave dressable floor."),
]);

export const csgNoiseSchema = z.object({
  amount: z.number().min(0).max(4).describe("Peak displacement in metres. The surface never moves farther than this."),
  scale: z.number().positive().describe("Feature size in metres of the first octave (frequency = 1/scale)."),
  seed: z.number().int().default(1),
  octaves: z.number().int().min(1).max(5).optional().describe("Perlin octaves, each 2.7x the frequency and 1/3 the weight of the last. Omitted = 2 (the original formula)."),
  grow: z.boolean().optional().describe("Displace OUTWARD only: the solid grows by 0..amount and never thins, so a wall thinner than 2 x amount cannot open a hole. The noise is stretched so the relief spans the full 0..amount (peak-to-peak = amount)."),
  protect: z.array(csgNoiseProtectSchema).max(4096).optional().describe("Regions where the noise fades to zero: doorways, stair treads, the walk lane along a route. Distances are measured in the node's local frame."),
}).describe("Geometry noise for one CSG node.");
export type CsgNoise = z.infer<typeof csgNoiseSchema>;

/** Palette indices for the three faces a surface can be, chosen per vertex by normal. */
export const csgSurfaceSchema = z.object({
  floor: z.number().int().min(0).default(0).describe("Palette index for upward-facing surfaces."),
  wall: z.number().int().min(0).default(0).describe("Palette index for vertical surfaces."),
  ceiling: z.number().int().min(0).default(0).describe("Palette index for downward-facing surfaces."),
});

// ---------------------------------------------------------------------------
// Heightfield samples: base64 float32, hand-rolled
// ---------------------------------------------------------------------------
//
// Core has one dependency and it is Zod, and it runs in Node and in a browser
// tab from the same build — so neither `Buffer` nor `atob` is assumed here.
// Sixteen lines of codec is cheaper than either assumption failing in one of
// the two hosts. Little-endian float32 explicitly, via DataView, so a document
// written on one machine reads the same on every other.

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Bytes of a base64 string, or null if it is not base64 at all. Whitespace and padding are ignored. */
function base64Bytes(text: string): Uint8Array | null {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 61 /* '=' */) continue;
    if (c > 127 || BASE64_REVERSE[c]! < 0) return null;
    count++;
  }
  if (count % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((count * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) continue;
    const v = BASE64_REVERSE[c]!;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 255;
    }
  }
  return out;
}

/** Heights as the compact `values` form: base64 of little-endian float32. */
export function encodeHeightfieldValues(values: Float32Array | readonly number[]): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i]!, true);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const word = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      BASE64_ALPHABET[(word >>> 18) & 63]! +
      BASE64_ALPHABET[(word >>> 12) & 63]! +
      (i + 1 < bytes.length ? BASE64_ALPHABET[(word >>> 6) & 63]! : "=") +
      (i + 2 < bytes.length ? BASE64_ALPHABET[word & 63]! : "=");
  }
  return out;
}

/** The inverse of `encodeHeightfieldValues`. Throws on anything that is not whole float32s of base64. */
export function decodeHeightfieldValues(text: string): Float32Array {
  const bytes = base64Bytes(text);
  if (!bytes) throw new TypeError("heightfield values are not valid base64");
  if (bytes.byteLength % 4 !== 0) throw new TypeError("heightfield values are not a whole number of float32s");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * A sampled height surface, thickened into a slab.
 *
 * This is the one CSG node whose shape is DATA rather than a formula: a
 * scanned floor, a sculpted cavern roof, a vault profile solved elsewhere. It
 * exists because the alternative — approximating a measured surface with a
 * hundred boxes — is both worse looking and slower to evaluate. Core decodes
 * numbers and nothing else: an image is somebody else's problem, so heights
 * arrive as an array or as base64 float32, never as a PNG.
 */
export const csgHeightfieldSchema = z
  .object({
    width: z
      .number()
      .int()
      .min(2)
      .max(2048)
      .describe("Samples across local X, both edges included. Spacing is size[0]/(width-1) metres."),
    depth: z
      .number()
      .int()
      .min(2)
      .max(2048)
      .describe("Samples across local Z, both edges included. Spacing is size[2]/(depth-1) metres."),
    values: z
      .union([z.array(z.number().finite()), z.string()])
      .describe(
        "width*depth heights in LOCAL metres, relative to the node's own origin. Row-major with X fastest: index 0 is the -x/-z corner, index width*depth-1 the +x/+z one. Either a plain number array or a base64 string of little-endian float32 of exactly that length — see `encodeHeightfieldValues`.",
      ),
    mode: z
      .enum(["floor", "ceiling"])
      .default("floor")
      .describe(
        "Which side of the sampled surface the slab hangs on. `floor` is solid from h-size[1] up to h (ground you stand on); `ceiling` is solid from h up to h+size[1] (a vault you walk under).",
      ),
  })
  .describe(
    "Heights sampled on a regular grid and thickened into a slab. The footprint is size[0] x size[2] in local X/Z centred on the origin, size[1] is the slab THICKNESS, and heights are bilinear between samples and clamped at the edges. Nothing outside the footprint is solid, so the node has a real boundary. Its distance field is an APPROXIMATION (exact under a flat patch, an under-estimate on a slope), which is why it disables distance-based block rejection the way `noise` does.",
  )
  .superRefine((hf, ctx) => {
    const wanted = hf.width * hf.depth;
    if (typeof hf.values === "string") {
      const bytes = base64Bytes(hf.values);
      if (!bytes) {
        ctx.addIssue({ code: "custom", message: "heightfield.values is not valid base64", path: ["values"] });
        return;
      }
      if (bytes.byteLength !== wanted * 4)
        ctx.addIssue({
          code: "custom",
          message: `heightfield.values decodes to ${bytes.byteLength} bytes (${bytes.byteLength / 4} float32); width*depth is ${wanted}, i.e. ${wanted * 4} bytes`,
          path: ["values"],
        });
      return;
    }
    if (hf.values.length !== wanted)
      ctx.addIssue({
        code: "custom",
        message: `heightfield.values has ${hf.values.length} entries; width*depth is ${wanted}`,
        path: ["values"],
      });
  });

export const csgNodeSchema = z.object({
  id: z.string().default("node"),
  op: z
    .enum(["add", "sub", "intersect"])
    .default("add")
    .describe("`add` unions this shape into the solid, `sub` carves it out as air, `intersect` clips the solid to it."),
  shape: z
    .enum(["box", "sphere", "ellipsoid", "cylinder", "capsule", "cone", "torus", "wedge", "prism", "heightfield", "mesh"])
    .default("box"),
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
  noise: csgNoiseSchema.optional().describe("Bounded displacement of this primitive in local metres (|displacement| <= amount). Use on cave cuts and on the natural-rock ROLE nodes of an imported stamp (tools/mesh-dc role noise); leave masonry, trim and treads unperturbed. On a primitive it disables distance-based block rejection; a volume made only of mesh nodes keeps block culling with a margin of 2 x the largest amount."),
  heightfield: csgHeightfieldSchema.optional().describe("Required by, and only read by, `shape: \"heightfield\"`: the sampled surface this node thickens into a slab. Its footprint and thickness come from `size`."),
  mesh: csgTriangleMeshSchema.optional().describe("Required by shape mesh: closed indexed local triangle solids, unioned and sampled by the shared CSG/DC path. Node position/rotation apply; size is ignored. Triangle palette assignments remain repaintable with volume paint."),
}).superRefine((node, ctx) => {
  // A heightfield node with no heights would silently contribute nothing,
  // which is exactly the kind of failure this module refuses to have.
  if (node.shape === "heightfield" && !node.heightfield)
    ctx.addIssue({ code: "custom", message: 'shape "heightfield" needs a `heightfield` block', path: ["heightfield"] });
  if (node.shape === "mesh" && !node.mesh)
    ctx.addIssue({ code: "custom", message: 'shape "mesh" needs a `mesh` block', path: ["mesh"] });
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
  tint: z.tuple([z.number().min(0).max(2),z.number().min(0).max(2),z.number().min(0).max(2)]).optional().describe("Optional RGB vertex tint blended in with the same coverage as the layer, e.g. the biome grass tint so painted grass tops match the terrain around them."),
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
  tint: z.tuple([z.number().min(0).max(2),z.number().min(0).max(2),z.number().min(0).max(2)]).optional().describe("RGB vertex tint the whole volume is multiplied by (the terrain-splat material's tintByVertexColor). Omit for white. Set it to the terrain's biome tint where a volume must match the ground it is fused with."),
}).superRefine((doc, ctx) => {
  for (let i = 0; i < doc.nodes.length; i++) {
    const materials = doc.nodes[i]!.mesh?.triangleMaterials;
    if (materials?.some((index) => index >= doc.palette.length)) ctx.addIssue({ code: "custom", path: ["nodes", i, "mesh", "triangleMaterials"], message: "mesh.triangleMaterials must reference an existing volume palette entry" });
  }
});

export type VolumePaint = z.infer<typeof volumePaintSchema>;
/** Blend one stroke into a vertex's splat weights; returns the coverage it applied (0 when it misses). */
export function blendVolumePaint(stroke: VolumePaint, x: number, y: number, z: number, weights: Float32Array, offset: number, count: number, normal: readonly number[] = [0,1,0]): number {
  if (stroke.layer >= count) return 0;
  if(stroke.normal){const length=Math.hypot(...stroke.normal)*Math.hypot(...normal);if(length<1e-9)return 0;const dot=stroke.normal.reduce((s,v,i)=>s+v*normal[i]!,0)/length;if(dot+1e-7<Math.cos(stroke.maxAngle*Math.PI/180))return 0;}
  const t = Math.max(0, 1 - Math.hypot(x-stroke.center[0], y-stroke.center[1], z-stroke.center[2])/stroke.radius);
  const amount = (stroke.fill?(t>0?1:0):t*t*(3-2*t))*stroke.strength;
  if (!amount) return 0;
  for(let i=0;i<count;i++) weights[offset+i] = weights[offset+i]!*(1-amount)+(i===stroke.layer?amount:0);
  return amount;
}

export type CsgSurface = z.infer<typeof csgSurfaceSchema>;
export type CsgHeightfield = z.infer<typeof csgHeightfieldSchema>;
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
  mesh?: CompiledTriangleMesh;
  /** Compiled `noise`: displacement at a local point given the node's base distance. */
  noise?: (lx: number, ly: number, lz: number, ds: number) => number;
  /**
   * Hard-union mesh nodes only: world box around the UNPADDED triangles and the
   * most this node's field can sit below the distance to that box (round +
   * noise). A sample whose current union distance is already below that bound
   * cannot be changed by this node, so skipping it is exact.
   */
  union?: { min: [number, number, number]; max: [number, number, number]; slack: number };
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

/**
 * Decoded heights for one heightfield block, plus the range they span.
 *
 * Keyed on the block object itself, so re-parsing a document reads the string
 * once and every sample after that reads numbers. A million-sample field in a
 * document is a base64 string; decoding it per density query would make the
 * node unusable, and decoding it eagerly in the schema would put a typed array
 * in a document that is supposed to be JSON.
 */
interface HeightfieldSamples {
  values: Float32Array;
  min: number;
  max: number;
}
const heightfieldCache = new WeakMap<object, HeightfieldSamples>();

function heightfieldSamples(hf: CsgHeightfield): HeightfieldSamples {
  const hit = heightfieldCache.get(hf);
  if (hit) return hit;
  const values = typeof hf.values === "string" ? decodeHeightfieldValues(hf.values) : Float32Array.from(hf.values);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! < min) min = values[i]!;
    if (values[i]! > max) max = values[i]!;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }
  const entry = { values, min, max };
  heightfieldCache.set(hf, entry);
  return entry;
}

/**
 * Nodes whose field is an APPROXIMATION of distance rather than the thing
 * itself. Their sign is right everywhere; their magnitude is not a bound. Any
 * shortcut that skips work because "the surface is at least d away" must not
 * be taken for these — the same rule `noise` has always carried, and the
 * reason `prepare` pads their AABB instead of trusting the field.
 */
function isApproximateField(node: CsgNode): boolean {
  return node.noise !== undefined || node.shape === "heightfield";
}

/** Local half-extent of a shape before rounding, used for both the AABB and the SDF. */
function localExtent(node: CsgNode): [number, number, number] {
  switch (node.shape) {
    case "mesh": {
      const mesh = compileTriangleMesh(node.mesh!);
      return [0, 1, 2].map((a) => Math.max(Math.abs(mesh.min[a]!), Math.abs(mesh.max[a]!))) as [number, number, number];
    }
    case "heightfield": {
      if (!node.heightfield) return [node.size[0]! / 2, node.size[1]! / 2, node.size[2]! / 2];
      const { min: low, max: high } = heightfieldSamples(node.heightfield);
      const bottom = node.heightfield.mode === "ceiling" ? low : low - node.size[1]!;
      const top = node.heightfield.mode === "ceiling" ? high + node.size[1]! : high;
      // Extents are measured from the node ORIGIN, which a heightfield's slab
      // need not straddle — so the half-extent is the farther end, not half
      // the span.
      return [node.size[0]! / 2, Math.max(Math.abs(bottom), Math.abs(top)), node.size[2]! / 2];
    }
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
  const mesh = node.shape === "mesh" ? compileTriangleMesh(node.mesh!) : undefined;
  const center: [number, number, number] = mesh ? [0, 1, 2].map((a) => (mesh.min[a]! + mesh.max[a]!) / 2) as [number, number, number] : [0, 0, 0];
  const e = mesh ? [0, 1, 2].map((a) => (mesh.max[a]! - mesh.min[a]!) / 2) : localExtent(node);
  const pad = node.round + node.blend + (node.noise?.amount ?? 0);
  // A rotated box's world AABB is the rotated extent, per axis the sum of
  // |R[axis][k]| * extent[k] — the standard conservative bound.
  const half: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    half[a] =
      Math.abs(rot[a * 3]!) * e[0]! + Math.abs(rot[a * 3 + 1]!) * e[1]! + Math.abs(rot[a * 3 + 2]!) * e[2]! + pad;
  }
  const worldCenter = [0, 1, 2].map((a) => node.position[a]! + rot[a * 3]! * center[0] + rot[a * 3 + 1]! * center[1] + rot[a * 3 + 2]! * center[2]);
  return {
    node,
    inv,
    mesh,
    union: mesh && node.op === "add" && node.blend === 0 ? unionBound(mesh, rot, node, center, e) : undefined,
    noise: node.noise ? compileNoise(node.noise, mesh, mesh ? [0, 1, 2].map((a) => mesh.min[a]! - pad) : undefined, mesh ? [0, 1, 2].map((a) => mesh.max[a]! + pad) : undefined) : undefined,
    surface: node.surface ?? fallback,
    min: [worldCenter[0]! - half[0]!, worldCenter[1]! - half[1]!, worldCenter[2]! - half[2]!],
    max: [worldCenter[0]! + half[0]!, worldCenter[1]! + half[1]!, worldCenter[2]! + half[2]!],
  };
}

/** World box of a mesh node's triangles (rotated extent, no padding) and its field slack. */
function unionBound(mesh: CompiledTriangleMesh, rot: Float64Array, node: CsgNode, center: [number, number, number], e: number[]): PreparedNode["union"] {
  const lo: [number, number, number] = [0, 0, 0], hi: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const h = Math.abs(rot[a * 3]!) * e[0]! + Math.abs(rot[a * 3 + 1]!) * e[1]! + Math.abs(rot[a * 3 + 2]!) * e[2]!;
    const c = node.position[a]! + rot[a * 3]! * center[0] + rot[a * 3 + 1]! * center[1] + rot[a * 3 + 2]! * center[2];
    lo[a] = c - h; hi[a] = c + h;
  }
  void mesh;
  return { min: lo, max: hi, slack: node.round + (node.noise?.amount ?? 0) };
}

/**
 * The displacement a node's `noise` adds to its distance at a local point.
 * Without octaves/grow/protect this is the original two-frequency formula,
 * clamped to [-amount, amount] so the bound the mesher relies on is exact.
 * On a MESH node (an exact distance field) samples farther than
 * `amount + 0.5 m` from the surface skip the noise: the sign cannot change
 * there and dual contouring never interpolates across them (a crossing edge
 * has both ends within one voxel of the surface), so the mesh is unchanged.
 */
const GROW_SPAN = 0.55;

function compileNoise(noise: CsgNoise, mesh: CompiledTriangleMesh | undefined, lo?: number[], hi?: number[]): (lx: number, ly: number, lz: number, ds: number) => number {
  const { amount, scale, seed } = noise;
  const octaves = noise.octaves ?? 2;
  const weights: number[] = [];
  let total = 0;
  for (let o = 0; o < octaves; o++) { weights.push(Math.pow(1 / 3, o)); total += weights[o]!; }
  for (let o = 0; o < octaves; o++) weights[o] = weights[o]! / total;
  const grow = noise.grow === true;
  // Keep only protect regions that reach the node's padded box; each carries a reach box for a six-compare reject.
  type Zone = { cap: boolean; a: number[]; d: number[]; dd: number; min: number[]; max: number[]; radius: number; fade: number; lo: number[]; hi: number[] };
  const zones: Zone[] = [];
  for (const zone of noise.protect ?? []) {
    if ("floors" in zone) continue; // floor bands are compiled below
    const cap = "a" in zone;
    const reach = (cap ? zone.radius : 0) + zone.fade;
    const end = cap ? (zone.b ?? zone.a) : undefined;
    const zmin = cap ? [0, 1, 2].map((k) => Math.min(zone.a[k]!, end![k]!)) : [...zone.min];
    const zmax = cap ? [0, 1, 2].map((k) => Math.max(zone.a[k]!, end![k]!)) : [...zone.max];
    const zlo = zmin.map((v) => v - reach), zhi = zmax.map((v) => v + reach);
    if (lo && hi && [0, 1, 2].some((k) => zhi[k]! < lo[k]! || zlo[k]! > hi[k]!)) continue;
    const d = cap ? [end![0]! - zone.a[0]!, end![1]! - zone.a[1]!, end![2]! - zone.a[2]!] : [0, 0, 0];
    zones.push({ cap, a: cap ? [...zone.a] : [], d, dd: d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!, min: zmin, max: zmax,
      radius: cap ? zone.radius : 0, fade: zone.fade, lo: zlo, hi: zhi });
  }
  type Band = { ox: number; oz: number; cell: number; cols: number; rows: number; spans: number[][]; above: number; below: number; fade: number };
  const bands: Band[] = [];
  for (const zone of noise.protect ?? []) {
    if (!("floors" in zone)) continue;
    const f = zone.floors;
    if (f.spans.length !== f.columns * f.rows) throw new Error(`noise floor band: spans has ${f.spans.length} cells, expected ${f.columns} x ${f.rows}`);
    bands.push({ ox: f.origin[0], oz: f.origin[1], cell: f.cell, cols: f.columns, rows: f.rows, spans: f.spans, above: zone.above, below: zone.below, fade: zone.fade });
  }
  const far = mesh ? amount + 0.5 : Infinity;
  return (x, y, z, ds) => {
    if (ds > far || ds < -far) return 0;
    let w = 1;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]!;
      const ci = Math.floor((x - b.ox) / b.cell), cj = Math.floor((z - b.oz) / b.cell);
      if (ci < 0 || cj < 0 || ci >= b.cols || cj >= b.rows) continue;
      const sp = b.spans[cj * b.cols + ci]!;
      for (let k = 0; k + 1 < sp.length; k += 2) {
        const lo = sp[k]! - b.below, hi = sp[k + 1]! + b.above;
        const dist = y < lo ? lo - y : y > hi ? y - hi : 0;
        const t = Math.min(1, dist / b.fade);
        w = Math.min(w, t * t * (3 - 2 * t));
        if (w === 0) return 0;
      }
    }
    for (let i = 0; i < zones.length; i++) {
      const q = zones[i]!;
      if (x < q.lo[0]! || x > q.hi[0]! || y < q.lo[1]! || y > q.hi[1]! || z < q.lo[2]! || z > q.hi[2]!) continue;
      let dist: number;
      if (q.cap) {
        const px = x - q.a[0]!, py = y - q.a[1]!, pz = z - q.a[2]!;
        const t = q.dd > 0 ? Math.max(0, Math.min(1, (px * q.d[0]! + py * q.d[1]! + pz * q.d[2]!) / q.dd)) : 0;
        dist = Math.hypot(px - t * q.d[0]!, py - t * q.d[1]!, pz - t * q.d[2]!) - q.radius;
      } else {
        const ex = Math.max(q.min[0]! - x, 0, x - q.max[0]!), ey = Math.max(q.min[1]! - y, 0, y - q.max[1]!), ez = Math.max(q.min[2]! - z, 0, z - q.max[2]!);
        dist = Math.hypot(ex, ey, ez);
      }
      const t = Math.max(0, Math.min(1, dist / q.fade));
      w = Math.min(w, t * t * (3 - 2 * t));
      if (w === 0) return 0;
    }
    let n = 0;
    for (let o = 0, f = 1 / scale; o < octaves; o++, f *= 2.7) n += weights[o]! * perlin3(x * f, y * f, z * f, seed + 17 * o);
    if (grow) {
      // Perlin rarely leaves +-0.55; stretch that span over the whole 0..amount relief so the
      // silhouette actually reaches `amount` (measured: unstretched, relief stayed ~0.3 x amount).
      n = n / GROW_SPAN;
      n = n < -1 ? -1 : n > 1 ? 1 : n;
      return w * amount * ((n - 1) / 2);
    }
    n = n < -1 ? -1 : n > 1 ? 1 : n;
    return w * amount * n;
  };
}

/** Signed distance to one primitive, in its own frame. Negative inside. */
function shapeDistance(node: CsgNode, x: number, y: number, z: number): number {
  const r = node.round;
  switch (node.shape) {
    case "mesh":
      return compileTriangleMesh(node.mesh!).distance(x, y, z) - r;
    case "heightfield": {
      // Sampled surface, thickened into a slab, clipped to its footprint.
      //
      // The field is the VERTICAL distance to the bilinear patch, rescaled by
      // cos(tilt) of that patch — 1/sqrt(1+|grad h|^2). That is exact under a
      // flat patch and an UNDER-estimate on a slope, which is the safe
      // direction (it never claims more clearance than there is), but it is
      // still an approximation and `isApproximateField` says so. The slab's
      // other face is the same surface offset vertically, so it shares the
      // scale; `max` against it and against the footprint box is the usual
      // convex-intersection composition the box and wedge use.
      const hf = node.heightfield;
      if (!hf) return SOLID_OUTSIDE;
      const { values } = heightfieldSamples(hf);
      const w = node.size[0]!;
      const d = node.size[2]!;
      const thickness = node.size[1]!;
      const cellX = w / (hf.width - 1);
      const cellZ = d / (hf.depth - 1);
      // clamped at the edges: a sample off the footprint reads the rim, and
      // the footprint box below is what actually ends the shape there
      const u = Math.min(hf.width - 1, Math.max(0, (x + w / 2) / Math.max(cellX, 1e-12)));
      const v = Math.min(hf.depth - 1, Math.max(0, (z + d / 2) / Math.max(cellZ, 1e-12)));
      const i0 = Math.min(hf.width - 2, Math.floor(u));
      const k0 = Math.min(hf.depth - 2, Math.floor(v));
      const fu = u - i0;
      const fv = v - k0;
      const row = k0 * hf.width + i0;
      const h00 = values[row]!;
      const h10 = values[row + 1]!;
      const h01 = values[row + hf.width]!;
      const h11 = values[row + hf.width + 1]!;
      const lo = h00 + (h10 - h00) * fu;
      const hi = h01 + (h11 - h01) * fu;
      const h = lo + (hi - lo) * fv;
      const gx = ((h10 - h00) * (1 - fv) + (h11 - h01) * fv) / (cellX || 1e-12);
      const gz = ((h01 - h00) * (1 - fu) + (h11 - h10) * fu) / (cellZ || 1e-12);
      const scale = 1 / Math.sqrt(1 + gx * gx + gz * gz);
      const ceiling = hf.mode === "ceiling";
      const top = ceiling ? h + thickness : h;
      const bottom = ceiling ? h : h - thickness;
      const slab = Math.max(y - top, bottom - y) * scale;
      const qx = Math.abs(x) - w / 2;
      const qz = Math.abs(z) - d / 2;
      const foot = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
      return Math.max(slab, foot) - r;
    }
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
  /**
   * True when any node's field only APPROXIMATES distance (`noise`, a
   * `heightfield`). The sign is still right everywhere; the magnitude is not a
   * bound, so a caller must not skip a region because the distance at its
   * centre looks large. Meshing already samples every candidate block for
   * unrelated reasons; this is for anyone who would rather not.
   */
  readonly approximate: boolean;
  /** Signed density at a point. Negative is solid, matching the rest of the voxel path. */
  density(x: number, y: number, z: number): number;
  /** The same field restricted to a region, with unreachable nodes dropped. */
  sampler(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
  ): (x: number, y: number, z: number) => number;
  /** Splat weights for a vertex, from the node that owns the surface there and the vertex normal. */
  surfaceAt(x: number, y: number, z: number, ny: number, out: Float32Array, offset: number, nx?: number, nz?: number): void;
  /** Exact source-face normal where an unrounded/unblended triangle node owns the boundary. */
  surfaceNormalAt?(x: number, y: number, z: number, out: Float64Array): boolean;
  /**
   * False when no `add` node can reach the region: nodes apply over empty
   * space and only `add` puts solid in, so such a region is air throughout
   * and the mesher skips it without sampling a single point.
   */
  solidMayReach?(min: readonly [number, number, number], max: readonly [number, number, number]): boolean;
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
      if (!p.mesh && (x < p.min[0]! - margin || x > p.max[0]! + margin || y < p.min[1]! - margin || y > p.max[1]! + margin || z < p.min[2]! - margin || z > p.max[2]! + margin)) {
        if (node.op !== "intersect") continue;
      }
      // Exact skip: a hard-union mesh node at least `d` away (box distance minus
      // slack is a lower bound of its field) cannot lower d, and an unchanged d
      // keeps the previous owner. Role-split stamps lean on this: without it
      // every role node pays a triangle query at every sample.
      const u = p.union;
      if (u && d < SOLID_OUTSIDE) {
        const ex = x < u.min[0] ? u.min[0] - x : x > u.max[0] ? x - u.max[0] : 0;
        const ey = y < u.min[1] ? u.min[1] - y : y > u.max[1] ? y - u.max[1] : 0;
        const ez = z < u.min[2] ? u.min[2] - z : z > u.max[2] ? z - u.max[2] : 0;
        if (ex * ex + ey * ey + ez * ez > 0 && Math.sqrt(ex * ex + ey * ey + ez * ez) - u.slack >= d) continue;
      }
      const px = x - node.position[0]!;
      const py = y - node.position[1]!;
      const pz = z - node.position[2]!;
      const m = p.inv;
      const lx = m[0]! * px + m[1]! * py + m[2]! * pz;
      const ly = m[3]! * px + m[4]! * py + m[5]! * pz;
      const lz = m[6]! * px + m[7]! * py + m[8]! * pz;
      // A hard-union mesh node only matters where it is nearer than the current d (plus its slack).
      let ds = u && p.mesh && d < SOLID_OUTSIDE ? p.mesh.distance(lx, ly, lz, d + u.slack) - node.round : shapeDistance(node, lx, ly, lz);
      if (p.noise) ds += p.noise(lx, ly, lz, ds);
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
  /**
   * Surface (owner) queries run once per mesh VERTEX over every node, which
   * on a document of hundreds of small nodes cost more than the lattice
   * itself. A coarse grid over the bounds lists, per cell, the nodes whose box
   * (plus the owner margin `evaluate` uses) reaches it — exactly the ones
   * `evaluate` would not skip there — so the answer is unchanged. Built on
   * first use; small documents keep the plain list.
   */
  let ownerGrid: { cell: number; n: [number, number, number]; lists: PreparedNode[][] } | null = null;
  const ownerNodes = (x: number, y: number, z: number): PreparedNode[] => {
    if (prepared.length < 32) return activeAll;
    if (!ownerGrid) {
      const cell = Math.max(doc.voxelSize * 8, 4);
      const margin = doc.voxelSize * 2;
      const n: [number, number, number] = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a]! - min[a]!) / cell))) as [number, number, number];
      if (n[0] * n[1] * n[2] > 200000) return activeAll;
      const lists: PreparedNode[][] = [];
      for (let k = 0; k < n[2]; k++)
        for (let j = 0; j < n[1]; j++)
          for (let i = 0; i < n[0]; i++) {
            const c0 = [min[0] + i * cell - margin, min[1] + j * cell - margin, min[2] + k * cell - margin];
            const c1 = [min[0] + (i + 1) * cell + margin, min[1] + (j + 1) * cell + margin, min[2] + (k + 1) * cell + margin];
            lists.push(prepared.filter((p) => p.mesh !== undefined || p.node.op === "intersect" || (p.max[0]! >= c0[0]! && p.min[0]! <= c1[0]! && p.max[1]! >= c0[1]! && p.min[1]! <= c1[1]! && p.max[2]! >= c0[2]! && p.min[2]! <= c1[2]!)));
          }
      ownerGrid = { cell, n, lists };
    }
    const g = ownerGrid;
    const i = Math.floor((x - min[0]) / g.cell), j = Math.floor((y - min[1]) / g.cell), k = Math.floor((z - min[2]) / g.cell);
    if (i < 0 || j < 0 || k < 0 || i >= g.n[0] || j >= g.n[1] || k >= g.n[2]) return activeAll;
    return g.lists[i + j * g.n[0] + k * g.n[0] * g.n[1]]!;
  };
  const sourceNormal = new Float64Array(3);

  return {
    doc,
    surfaceCount: doc.palette.length,
    approximate: prepared.some((p) => isApproximateField(p.node)),
    min,
    max,
    density: (x, y, z) => evaluate(x, y, z, null, activeAll),
    solidMayReach: (lo, hi) =>
      prepared.some(
        (p) =>
          p.node.op === "add" &&
          (p.mesh !== undefined ||
            (p.max[0]! >= lo[0]! && p.min[0]! <= hi[0]! && p.max[1]! >= lo[1]! && p.min[1]! <= hi[1]! && p.max[2]! >= lo[2]! && p.min[2]! <= hi[2]!)),
      ),
    surfaceNormalAt: (x, y, z, out) => {
      evaluate(x, y, z, ownerScratch, activeAll);
      const p = ownerScratch[0]! >= 0 ? prepared[ownerScratch[0]!] : undefined;
      if (!p?.mesh || p.node.noise || p.node.round || p.node.blend) return false;
      const px = x - p.node.position[0], py = y - p.node.position[1], pz = z - p.node.position[2], m = p.inv;
      p.mesh.normalAt(m[0]! * px + m[1]! * py + m[2]! * pz, m[3]! * px + m[4]! * py + m[5]! * pz, m[6]! * px + m[7]! * py + m[8]! * pz, sourceNormal);
      const direction = p.node.op === "sub" ? -1 : 1;
      for (let a = 0; a < 3; a++) out[a] = direction * (m[a]! * sourceNormal[0]! + m[a + 3]! * sourceNormal[1]! + m[a + 6]! * sourceNormal[2]!);
      return true;
    },
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
          // Mesh fields stay exact outside their bounds. Dropping a positive
          // distant term would preserve signs but break sampler/density
          // agreement and the Lipschitz guarantee used by mesh block culling.
          p.mesh !== undefined ||
          p.node.op === "intersect" ||
          (p.max[0]! >= lo[0]! && p.min[0]! <= hi[0]! && p.max[1]! >= lo[1]! && p.min[1]! <= hi[1]! && p.max[2]! >= lo[2]! && p.min[2]! <= hi[2]!),
      );
      // The same filter again per sub-cell (SUB^3 of them), so a sample loops
      // only over the nodes whose boxes reach ITS corner of the region. This is
      // exactly what `evaluate` would skip anyway — a node is dropped only
      // where every sample is outside its box — so the field is unchanged; on
      // a document of many small nodes (generated rock formations: hundreds)
      // the per-sample loop, not the distance functions, was the cost. Each
      // cell is padded by a voxel so the contourer's gradient taps just past a
      // lattice point still read the full set.
      const SUB = 4;
      if (active.length < 24) return (x, y, z) => evaluate(x, y, z, null, active);
      const pad = doc.voxelSize;
      const cs = [0, 1, 2].map((a) => Math.max(1e-9, (hi[a]! - lo[a]!) / SUB));
      const lists: PreparedNode[][] = [];
      for (let k = 0; k < SUB; k++)
        for (let j = 0; j < SUB; j++)
          for (let i = 0; i < SUB; i++) {
            const c0 = [lo[0]! + i * cs[0]! - pad, lo[1]! + j * cs[1]! - pad, lo[2]! + k * cs[2]! - pad];
            const c1 = [lo[0]! + (i + 1) * cs[0]! + pad, lo[1]! + (j + 1) * cs[1]! + pad, lo[2]! + (k + 1) * cs[2]! + pad];
            lists.push(
              active.filter(
                (p) =>
                  p.mesh !== undefined ||
                  p.node.op === "intersect" ||
                  (p.max[0]! >= c0[0]! && p.min[0]! <= c1[0]! && p.max[1]! >= c0[1]! && p.min[1]! <= c1[1]! && p.max[2]! >= c0[2]! && p.min[2]! <= c1[2]!),
              ),
            );
          }
      return (x, y, z) => {
        const fx = (x - lo[0]!) / cs[0]!, fy = (y - lo[1]!) / cs[1]!, fz = (z - lo[2]!) / cs[2]!;
        // outside the region by more than the pad: the full list, never a wrong one
        if (fx < -pad / cs[0]! || fy < -pad / cs[1]! || fz < -pad / cs[2]! || fx > SUB + pad / cs[0]! || fy > SUB + pad / cs[1]! || fz > SUB + pad / cs[2]!) return evaluate(x, y, z, null, active);
        const i = Math.min(SUB - 1, Math.max(0, Math.floor(fx)));
        const j = Math.min(SUB - 1, Math.max(0, Math.floor(fy)));
        const k = Math.min(SUB - 1, Math.max(0, Math.floor(fz)));
        return evaluate(x, y, z, null, lists[i + j * SUB + k * SUB * SUB]!);
      };
    },
    surfaceAt: (x, y, z, ny, out, offset, nx=0, nz=0) => {
      // the owner index is into the list evaluated, which is the grid cell's, not `prepared`
      const candidates = ownerNodes(x, y, z);
      evaluate(x, y, z, ownerScratch, candidates);
      const owning = ownerScratch[0]! >= 0 ? candidates[ownerScratch[0]!]! : undefined;
      const surface = owning?.surface ?? doc.surface;
      let triangleMaterial: number | undefined;
      if (owning?.mesh && owning.node.mesh?.triangleMaterials) {
        const px = x - owning.node.position[0], py = y - owning.node.position[1], pz = z - owning.node.position[2], m = owning.inv;
        triangleMaterial = owning.mesh.materialAt(m[0]! * px + m[1]! * py + m[2]! * pz, m[3]! * px + m[4]! * py + m[5]! * pz, m[6]! * px + m[7]! * py + m[8]! * pz);
      }
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
      if (triangleMaterial !== undefined) add(triangleMaterial, 1);
      else {
        add(surface.floor, up);
        add(surface.ceiling, down);
        add(surface.wall, wall);
      }
      // tint: the material multiplies by it; a volume has no biome, so it is
      // the document's own (white unless set) and whatever strokes blend in
      const base = doc.tint ?? [1, 1, 1];
      out[offset + count] = base[0];
      out[offset + count + 1] = base[1];
      out[offset + count + 2] = base[2];
      for (const stroke of doc.paint) {
        // outside the stroke's sphere it paints nothing: skip before the facing test
        const ex = x - stroke.center[0], ey = y - stroke.center[1], ez = z - stroke.center[2];
        if (ex * ex + ey * ey + ez * ez >= stroke.radius * stroke.radius) continue;
        const amount = blendVolumePaint(stroke, x, y, z, out, offset, count, [nx,ny,nz]);
        if (amount > 0 && stroke.tint) for (let c = 0; c < 3; c++) out[offset + count + c] = out[offset + count + c]! * (1 - amount) + stroke.tint[c]! * amount;
      }
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
  // Triangle fields remain exact outside their AABB. A mesh-only sampler is
  // therefore 1-Lipschitz, including ordered hard/smooth CSG, and its centre
  // distance safely proves a whole padded block homogeneous. Keep the older
  // primitive/heightfield path's conservative behavior unchanged.
  // Noise on a MESH node is a bounded perturbation (|term| <= amount) of an
  // exact field, and hard/smooth min/max are non-expansive, so the composed
  // field still satisfies |f(q) - f(c)| <= |q - c| + 2 * maxAmount: cull with
  // that margin instead of giving culling up (role-noised stamps rely on it).
  const canCullBlocks = volume.doc.nodes.length > 0 && volume.doc.nodes.every((node) => node.shape === "mesh");
  const cullMargin = 2 * Math.max(0, ...volume.doc.nodes.map((node) => node.noise?.amount ?? 0));
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
        const lattice = { origin: volume.min, offset: [bx - PAD, by - PAD, bz - PAD] as [number, number, number] };
        // Evaluate a shared integer sample through the same arithmetic in
        // every block. blockOrigin + localIndex * step is not interchangeable
        // in floating point, particularly on a symmetric imported ridge.
        const xs = Float64Array.from({ length: nx }, (_, i) => volume.min[0] + (lattice.offset[0] + i) * step);
        const ys = Float64Array.from({ length: ny }, (_, i) => volume.min[1] + (lattice.offset[1] + i) * step);
        const zs = Float64Array.from({ length: nz }, (_, i) => volume.min[2] + (lattice.offset[2] + i) * step);
        const blockMax: [number, number, number] = [xs[nx - 1]!, ys[ny - 1]!, zs[nz - 1]!];
        // no solid can reach this block: it is air throughout, nothing to mesh
        if (volume.solidMayReach && !volume.solidMayReach(origin, blockMax)) continue;
        const density = volume.sampler(origin, blockMax);
        if (canCullBlocks) {
          const rx = (nx - 1) * step / 2, ry = (ny - 1) * step / 2, rz = (nz - 1) * step / 2;
          if (Math.abs(density(origin[0] + rx, origin[1] + ry, origin[2] + rz)) > Math.hypot(rx, ry, rz) + cullMargin) continue;
        }
        const values = new Float32Array(nx * ny * nz);
        for (let k = 0; k < nz; k++) {
          const wz = zs[k]!;
          for (let j = 0; j < ny; j++) {
            const wy = ys[j]!;
            const row = j * nx + k * nx * ny;
            for (let i = 0; i < nx; i++) {
              values[row + i] = density(xs[i]!, wy, wz);
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
            if (volume.surfaceNormalAt?.(x, y, z, out)) return;
            const a = density(x + g, y - g, z - g);
            const b = density(x - g, y - g, z + g);
            const c = density(x - g, y + g, z - g);
            const d = density(x + g, y + g, z + g);
            out[0] = a - b - c + d;
            out[1] = -a - b + c + d;
            out[2] = -a + b - c + d;
          },
        };
        const result = dualContour({ values, nx, ny, nz, origin, step }, { pad: PAD, attributes, hermite, lattice });
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
/**
 * Registered but not yet compiled. The asset index lists every project's
 * volumes (187 dungeon rooms and passages at the time of writing), and
 * compiling one builds its triangle BVHs: doing that for all of them at load
 * held ~130 MB in a tab that streams none. `getVolume`/`csgMesh` compile on
 * first use.
 */
const pendingVolumes = new Map<string, unknown>();
/** Compiling threw: warned once, resolves to null until re-registered. */
const failedVolumes = new Set<string>();

function resolveVolume(id: string): Volume | null {
  const built = volumes.get(id);
  if (built) return built;
  if (!pendingVolumes.has(id)) return null;
  const doc = pendingVolumes.get(id);
  pendingVolumes.delete(id);
  try {
    const volume = createVolume(doc);
    volumes.set(id, volume);
    return volume;
  } catch (error) {
    failedVolumes.add(id);
    console.warn(`[csg] volume "${id}" is invalid:`, error);
    return null;
  }
}

/** Register a volume document WITHOUT compiling it; the first `getVolume`/`csgMesh` does. */
export function registerVolumeDoc(id: string, doc: unknown): void {
  volumes.delete(id);
  failedVolumes.delete(id);
  pendingVolumes.set(id, doc);
  invalidateVolume(id);
}

/** Whether anything has asked for this volume (compiled, or tried and failed). */
export function isVolumeInUse(id: string): boolean {
  return volumes.has(id) || failedVolumes.has(id);
}

export function registerVolume(id: string, doc: VolumeDoc | unknown): Volume {
  const volume = createVolume(doc);
  const previous = volumes.get(id);
  const paintOnly = previous && JSON.stringify({...previous.doc,paint:[]}) === JSON.stringify({...volume.doc,paint:[]});
  pendingVolumes.delete(id);
  failedVolumes.delete(id);
  volumes.set(id, volume);
  if(paintOnly){
    for(const [key,mesh] of volumeMeshes){
      if(!key.startsWith(id+":"))continue;
      const weights=new Float32Array(mesh.surfaceCount+3);
      for(let i=0;i<mesh.vertexCount;i++){
        const p=i*3;
        volume.surfaceAt(mesh.positions[p]!,mesh.positions[p+1]!,mesh.positions[p+2]!,mesh.normals[p+1]!,weights,0,mesh.normals[p]!,mesh.normals[p+2]!);
        mesh.splat.set(weights.subarray(0,mesh.surfaceCount),i*mesh.surfaceCount);
        if(mesh.tint.length===mesh.vertexCount*3)mesh.tint.set(weights.subarray(mesh.surfaceCount,mesh.surfaceCount+3),p);
      }
    }
  }else invalidateVolume(id);
  return volume;
}

export function getVolume(id: string): Volume | null {
  return resolveVolume(id);
}

export function volumeIds(): string[] {
  return [...new Set([...volumes.keys(), ...pendingVolumes.keys()])];
}

export function invalidateVolume(id: string): void {
  for (const key of [...volumeMeshes.keys()]) {
    if (key === id || key.startsWith(`${id}:`)) volumeMeshes.delete(key);
  }
}

export function clearVolumes(): void {
  volumes.clear();
  pendingVolumes.clear();
  failedVolumes.clear();
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
  const volume = resolveVolume(source.volume);
  if (!volume) return EMPTY_VOLUME_MESH;
  const mesh = buildVolumeMesh(volume, lodStep);
  volumeMeshes.set(key, mesh);
  return mesh;
}
