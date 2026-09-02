import * as THREE from "three/webgpu";

/**
 * Reshape a leaf card's normals so a canopy shades like a MASS, not like a
 * shattered fan of flat plates.
 *
 * The problem, in the form it actually shows up: a tree's canopy is a handful
 * of large alpha-masked quads, and an exporter gives each quad its own flat
 * face normal — pointing in every direction, several of them straight down.
 * Lighting is then per-card and binary. The card angled at the sun blows out;
 * the one beside it, facing away, goes black; there is no gradation across the
 * canopy because there is no variation across a flat quad. Measured on the
 * demo world's maple: 106 distinct normals over 278 vertices, including
 * `(0, -1, 0)`.
 *
 * The fix is the standard one for foliage, and it is a GEOMETRY edit rather
 * than a shader one: point each normal outward from the canopy's centre, so
 * the cards shade as if they were the surface of a ball of leaves. Because the
 * result is baked into the normal attribute it survives instancing, costs
 * nothing per frame, and needs no special material.
 *
 * `blend` mixes back toward the card's real normal. 1 is a pure sphere, which
 * reads best on a rounded canopy; lower values keep some of the card's own
 * facing, which suits a flatter, more stylised tree.
 *
 * This is the same insight the `grass` component already used — its blades
 * force a straight-up normal for exactly this reason. That trick was reachable
 * only from inside that component, which is why grass looked right sitting
 * next to trees that did not.
 */
export interface FoliageNormalOptions {
  /** 0 keeps the authored normals, 1 is a pure outward sphere. */
  blend?: number;
  /**
   * Fraction of the canopy's height to drop the sphere's centre by.
   *
   * A centre at the true middle makes the underside of the canopy point
   * straight down, which is just the original problem rotated: those cards go
   * black again. Lowering it biases every normal upward, so the underside
   * reads as shadowed rather than unlit — which is also what a real canopy
   * does, since its light arrives from above.
   */
  centerDrop?: number;
  /**
   * How far the reshaped normal leans toward straight UP, after the sphere.
   *
   * This is the knob that makes leaves match GRASS. The `grass` component
   * shades its cards with a hard `(0, 1, 0)` — the standard cheap-foliage
   * trick — so a grass field is lit exactly like flat ground and is the
   * brightest thing in any outdoor scene. A canopy shaded as a pure sphere is
   * physically nicer but sits visibly darker beside it, because half its
   * normals face sideways or away from the sun.
   *
   * 1 reproduces the grass treatment exactly. 0 leaves the sphere alone.
   * Around 0.6-0.9 keeps enough of the sphere to give the canopy form while
   * bringing its overall brightness up to the ground cover's.
   */
  up?: number;
}

/** Marks geometry already processed, so a shared glTF is never done twice. */
const FOLIAGE_NORMALS = "foliageNormals";

/**
 * Apply {@link foliageNormals} to every alpha-cutout mesh under `root`.
 *
 * The cutout test scopes this to alpha-masked parts — but do NOT read it as
 * "leaves only". Blockbench exports every material as `alphaMode: "MASK"`, so
 * on those models the trunk is caught too. That is survivable only because the
 * bounds are per-primitive and no normal is allowed below the horizon (both
 * below): a trunk then gets outward-radial normals from its own extent, which
 * is roughly right for a cylinder, instead of a sphere centred on the canopy —
 * which is what made the bottom of every trunk render black.
 *
 * Geometry is shared across every instance of a model by the loader cache, so
 * the edit is done once and tagged. That means foliage normals are in practice
 * a property of the MODEL, not of one entity that uses it — which is the right
 * granularity for "these are leaves", and is why the tag is on the geometry.
 */
export function applyFoliageNormals(root: THREE.Object3D, options: FoliageNormalOptions = {}): number {
  let touched = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cutout = materials.some((m) => m && (m as THREE.MeshStandardMaterial).alphaTest > 0);
    if (!cutout) return;
    if (foliageNormals(mesh.geometry, options)) touched += 1;
  });
  return touched;
}

/**
 * Rewrite one geometry's normals as an outward sphere. Returns false if it was
 * already done, or if the geometry has nothing to work with.
 */
export function foliageNormals(
  geometry: THREE.BufferGeometry,
  options: FoliageNormalOptions = {},
): boolean {
  if (geometry.userData[FOLIAGE_NORMALS]) return false;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || !normal || position.count !== normal.count) return false;

  const blend = Math.min(1, Math.max(0, options.blend ?? 1));
  const centerDrop = options.centerDrop ?? 0.35;
  const upBias = Math.min(1, Math.max(0, options.up ?? 0));

  // Bounds from the vertices this geometry ACTUALLY INDEXES, not from the
  // whole position attribute. glTF primitives routinely share one vertex pool
  // — the demo maple has four primitives over a single 278-vertex buffer — so
  // `computeBoundingBox()` hands back the entire tree for every one of them,
  // and the trunk gets a sphere centred on the canopy.
  const index = geometry.getIndex();
  const used = index ? new Set<number>() : null;
  if (index && used) for (let i = 0; i < index.count; i++) used.add(index.getX(i));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const consider = (i: number): void => {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  if (used) for (const i of used) consider(i);
  else for (let i = 0; i < position.count; i++) consider(i);
  if (!Number.isFinite(minX)) return false;

  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const height = Math.max(1e-4, maxY - minY);
  const cy = (minY + maxY) / 2 - height * centerDrop;

  const apply = (i: number): void => {
    let dx = position.getX(i) - cx;
    let dy = position.getY(i) - cy;
    let dz = position.getZ(i) - cz;
    const length = Math.hypot(dx, dy, dz);
    // a vertex sitting exactly at the centre has no outward direction; leave
    // its authored normal rather than emitting a zero-length one
    if (length < 1e-6) return;
    dx /= length;
    dy /= length;
    dz /= length;
    let nx = normal.getX(i) + (dx - normal.getX(i)) * blend;
    let ny = normal.getY(i) + (dy - normal.getY(i)) * blend;
    let nz = normal.getZ(i) + (dz - normal.getZ(i)) * blend;
    // NEVER let a foliage normal point below the horizon. Anything under the
    // sphere's centre — the underside of a canopy, the bottom of a trunk —
    // otherwise ends up facing the ground, which is zero light from a sun that
    // is above it, and renders BLACK. Flattening the downward component to
    // horizontal keeps those faces shaded rather than unlit, which is also
    // what real foliage does: its light arrives from the sky, never from below.
    if (ny < 0) ny = 0;
    // ...then lean toward straight up, which is how the grass is shaded
    if (upBias > 0) {
      nx += (0 - nx) * upBias;
      ny += (1 - ny) * upBias;
      nz += (0 - nz) * upBias;
    }
    const n = Math.hypot(nx, ny, nz);
    if (n < 1e-6) {
      // straight down and nothing else: point it up instead of leaving zero
      normal.setXYZ(i, 0, 1, 0);
      return;
    }
    normal.setXYZ(i, nx / n, ny / n, nz / n);
  };
  if (used) for (const i of used) apply(i);
  else for (let i = 0; i < position.count; i++) apply(i);
  normal.needsUpdate = true;
  geometry.userData[FOLIAGE_NORMALS] = true;
  return true;
}
