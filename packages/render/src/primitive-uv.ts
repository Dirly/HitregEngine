import * as THREE from "three/webgpu";

/**
 * World-space (metre-sized) UVs for primitives.
 *
 * A primitive's `size` is its authored dimension, and three's generators map
 * one texture tile across each face whatever that dimension is. So a 2m wall
 * and a 40m wall built from the same box and the same material do not match:
 * the long one's texture is stretched 20x. Content built by resizing boxes —
 * which is what graybox level geometry and every generated dungeon shell is —
 * therefore reads as smeared the moment two pieces of different length meet.
 *
 * `mesh.source.uv = { mode: "world", scale: [u, v] }` fixes it by generating
 * the UVs in METRES instead: `scale` is metres per texture tile, so the texture
 * holds its real size no matter how the box is resized, and neighbours line up.
 *
 * Why this and not the material's `triplanar`:
 *
 * | | world UV | triplanar |
 * |---|---|---|
 * | cost | free (baked into the buffer once) | 3x texture fetches per map |
 * | space | OBJECT — survives instancing and moving the entity | WORLD — texture swims when the mesh moves |
 * | fit | flat, axis-aligned, resized geometry | organic rock with no sane unwrap |
 *
 * They are complementary, not competing: shell boxes want this, sculpted cave
 * rock still wants triplanar.
 *
 * Exactness: box/wedge/plane get a true per-face planar projection along the
 * face normal, so the metre scale is exact on every face including a wedge's
 * slope. Round shapes keep their existing seams and simply rescale their UVs by
 * the real circumference/height, which is what removes the resize-stretch.
 */

/** Metres per texture tile, [u, v]. */
export type UvScale = readonly [number, number];

const EPS = 1e-6;

/** Shapes whose faces are flat, so a planar projection is exact for them. */
const PLANAR = new Set(["box", "wedge", "plane"]);

/**
 * Rewrite `geometry`'s uv attribute in world-metre units. Mutates and returns
 * the same geometry. A geometry with no uv attribute (nothing to map) or a
 * non-positive scale is left untouched.
 */
export function applyWorldUv(
  geometry: THREE.BufferGeometry,
  shape: string,
  size: readonly [number, number, number],
  scale: UvScale,
): THREE.BufferGeometry {
  let uv = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
  if (!uv) {
    // `wedge` is hand-built from raw positions and ships NO uv attribute, so a
    // textured wedge samples one texel across its whole surface today. The
    // planar projection below can supply real coordinates, so make room for
    // them rather than bailing out. Round shapes have nothing to rescale
    // without their generator's uvs, so those still bail.
    if (!PLANAR.has(shape)) return geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!position) return geometry;
    uv = new THREE.BufferAttribute(new Float32Array(position.count * 2), 2);
    geometry.setAttribute("uv", uv);
  }
  const su = Math.abs(scale[0]) > EPS ? Math.abs(scale[0]) : 1;
  const sv = Math.abs(scale[1]) > EPS ? Math.abs(scale[1]) : 1;
  const [x, y, z] = size;

  switch (shape) {
    case "box":
    case "wedge":
      projectPlanar(geometry, su, sv);
      return geometry;
    case "plane":
      // PlaneGeometry is built in XY (the scene builder lays it flat with a
      // -90deg X rotation afterwards), so its own axes are the surface axes.
      scaleUv(uv, x / su, z / sv, 0, 0);
      return geometry;
    case "cylinder":
      // groups: [torso, top cap, bottom cap]. The caps are a disc mapped into
      // 0..1, so they rescale about their centre rather than from a corner.
      scaleGroup(geometry, 0, (Math.PI * x) / su, y / sv, 0, 0);
      scaleGroup(geometry, 1, x / su, x / sv, 0.5, 0.5);
      scaleGroup(geometry, 2, x / su, x / sv, 0.5, 0.5);
      return geometry;
    case "cone":
      // groups: [torso, bottom cap] — a cone has no top.
      scaleGroup(geometry, 0, (Math.PI * x) / su, Math.hypot(y, x / 2) / sv, 0, 0);
      scaleGroup(geometry, 1, x / su, x / sv, 0.5, 0.5);
      return geometry;
    case "sphere":
      scaleUv(uv, (Math.PI * x) / su, (Math.PI * x) / 2 / sv, 0, 0);
      return geometry;
    case "capsule":
      // CapsuleGeometry(radius = x/2, length = y - x): v spans the whole height.
      scaleUv(uv, (Math.PI * x) / su, Math.max(y, x) / sv, 0, 0);
      return geometry;
    case "torus":
      // TorusGeometry(radius = x/2, tube = y/4): u runs the major circumference,
      // v the minor one.
      scaleUv(uv, (Math.PI * x) / su, (Math.PI * y) / 2 / sv, 0, 0);
      return geometry;
    default:
      projectPlanar(geometry, su, sv);
      return geometry;
  }
}

/**
 * Per-vertex planar projection along the face normal, in object space.
 *
 * The naive version of this picks the normal's dominant axis and projects onto
 * that axis plane, which is exact for an axis-aligned face but COMPRESSES a
 * slanted one by cos(tilt) — a wedge's slope would tile visibly tighter than
 * the floor it rises from. Building a tangent basis from the normal instead
 * keeps the metre scale exact on every face, whatever its angle, and is
 * continuous within a face because every vertex of a flat face shares one
 * normal.
 */
function projectPlanar(geometry: THREE.BufferGeometry, su: number, sv: number): void {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  if (!normal) return;

  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    n.fromBufferAttribute(normal, i);
    if (n.lengthSq() < EPS) {
      uv.setXY(i, p.x / su, p.z / sv);
      continue;
    }
    n.normalize();
    if (Math.abs(n.y) > 0.999) {
      // A floor or ceiling: keep the world XZ axes so every horizontal surface
      // in a level shares one grid and adjacent slabs line their tiles up.
      tangent.set(1, 0, 0);
      bitangent.set(0, 0, n.y > 0 ? -1 : 1);
    } else {
      tangent.crossVectors(up, n).normalize();
      bitangent.crossVectors(n, tangent).normalize();
    }
    uv.setXY(i, p.dot(tangent) / su, p.dot(bitangent) / sv);
  }
  uv.needsUpdate = true;
}

/** uv = (uv - centre) * factor + centre, componentwise. */
function scaleUv(
  uv: THREE.BufferAttribute,
  fu: number,
  fv: number,
  cu: number,
  cv: number,
  start = 0,
  count = uv.count,
): void {
  const end = Math.min(uv.count, start + count);
  for (let i = start; i < end; i++) {
    uv.setXY(i, (uv.getX(i) - cu) * fu + cu, (uv.getY(i) - cv) * fv + cv);
  }
  uv.needsUpdate = true;
}

/**
 * Rescale only the vertices reached by draw group `groupIndex` — how a
 * cylinder's curved side gets circumference-based UVs while its caps get
 * disc-based ones. Vertices are read through the index buffer because a group
 * addresses indices, not vertices; each of three's cylinder/cone groups owns a
 * disjoint vertex run, so no vertex is scaled twice.
 */
function scaleGroup(
  geometry: THREE.BufferGeometry,
  groupIndex: number,
  fu: number,
  fv: number,
  cu: number,
  cv: number,
): void {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const group = geometry.groups[groupIndex];
  if (!group) return;
  const index = geometry.getIndex();
  if (!index) {
    scaleUv(uv, fu, fv, cu, cv, group.start, group.count);
    return;
  }
  const end = Math.min(index.count, group.start + group.count);
  // Indices repeat a shared vertex once per triangle that uses it; scaling is
  // not idempotent, so a vertex touched twice would tile twice as tight.
  const seen = new Uint8Array(uv.count);
  for (let i = group.start; i < end; i++) {
    const v = index.getX(i);
    if (seen[v]) continue;
    seen[v] = 1;
    uv.setXY(v, (uv.getX(v) - cu) * fu + cu, (uv.getY(v) - cv) * fv + cv);
  }
  uv.needsUpdate = true;
}
