import * as THREE from "three/webgpu";

export interface PathMeshSource {
  points: Array<[number, number, number]>;
  closed: boolean;
  crossSection: "ribbon" | "tube";
  width: number;
  radius: number;
  radialSegments: number;
  segmentsPerSpan: number;
  /** ribbon only: extrude UP off the curve into a slab this thick (0 = flat sheet). */
  thickness?: number;
  /** ribbon only, flat sheet: also emit the underside so it renders from below. */
  doubleSided?: boolean;
}

/**
 * Curve-following geometry for `mesh.source.kind: "path"` — roads/rivers/
 * fences (flat ribbon) or vines/cables/rope (round tube), from Catmull-Rom
 * control points in entity-local space.
 */
export function pathGeometry(source: PathMeshSource): THREE.BufferGeometry {
  const points = source.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(points, source.closed, "catmullrom", 0.5);
  const spans = source.closed ? points.length : points.length - 1;
  const segments = Math.max(1, source.segmentsPerSpan * spans);

  if (source.crossSection === "tube") {
    return new THREE.TubeGeometry(curve, segments, source.radius, source.radialSegments, source.closed);
  }
  const thickness = source.thickness ?? 0;
  if (thickness > 0) return slabGeometry(curve, segments, source.width, thickness, source.closed);
  return ribbonGeometry(curve, segments, source.width, source.closed, source.doubleSided ?? false);
}

interface RibbonFrame {
  point: THREE.Vector3;
  side: THREE.Vector3;
  arcLength: number;
}

/**
 * Samples the curve into (point, side, arc-length) frames. Uses world-up
 * (not Frenet frames) to pick the side vector — Frenet frames twist/flip
 * unpredictably on straight or near-vertical spans, which reads as a visibly
 * warped road; world-up stays stable for the road/river/fence use case
 * (mostly-horizontal curves), falling back to the last valid side vector on
 * a near-vertical tangent instead of degenerating to a zero-length cross
 * product. `side` = tangent x up, so it points to the curve's RIGHT when
 * looking along the direction of travel with +Y up.
 */
function sampleFrames(curve: THREE.CatmullRomCurve3, segments: number): RibbonFrame[] {
  const worldUp = new THREE.Vector3(0, 1, 0);
  let side = new THREE.Vector3(1, 0, 0);
  let arcLength = 0;
  let prevPoint: THREE.Vector3 | null = null;
  const frames: RibbonFrame[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    if (prevPoint) arcLength += point.distanceTo(prevPoint);
    prevPoint = point;
    const candidate = new THREE.Vector3().crossVectors(tangent, worldUp);
    if (candidate.lengthSq() > 1e-6) side = candidate.normalize();
    frames.push({ point, side, arcLength });
  }
  return frames;
}

/**
 * Flat strip along the curve, width `width`. Vertex pairs are (left, right)
 * per sample; triangles wind so the face normal is +Y (a road is seen from
 * above — the previous winding pointed every normal DOWN, so with backface
 * culling the sheet only rendered from underneath). `doubleSided` appends a
 * reverse-wound copy of the triangles over the same vertices so the
 * underside draws too, without touching the shared, cached material's
 * `side`; the normal attribute stays +Y for both copies, which is what a
 * lit road seen from below wants anyway (the sun is still above it).
 */
function ribbonGeometry(
  curve: THREE.CatmullRomCurve3,
  segments: number,
  width: number,
  closed: boolean,
  doubleSided: boolean,
): THREE.BufferGeometry {
  const frames = sampleFrames(curve, segments);
  const sampleCount = frames.length;
  const positions = new Float32Array(sampleCount * 2 * 3);
  const uvs = new Float32Array(sampleCount * 2 * 2);

  for (let i = 0; i < sampleCount; i++) {
    const { point, side, arcLength } = frames[i]!;
    const left = point.clone().addScaledVector(side, -width / 2);
    const right = point.clone().addScaledVector(side, width / 2);
    const base = i * 2 * 3;
    positions[base + 0] = left.x;
    positions[base + 1] = left.y;
    positions[base + 2] = left.z;
    positions[base + 3] = right.x;
    positions[base + 4] = right.y;
    positions[base + 5] = right.z;
    const uvBase = i * 2 * 2;
    uvs[uvBase + 0] = 0;
    uvs[uvBase + 1] = arcLength;
    uvs[uvBase + 2] = 1;
    uvs[uvBase + 3] = arcLength;
  }

  const quadCount = closed ? sampleCount : sampleCount - 1;
  const frontCount = quadCount * 6;
  const indices = new Uint32Array(frontCount * (doubleSided ? 2 : 1));
  for (let i = 0; i < quadCount; i++) {
    const a = i * 2; // left, this sample
    const b = a + 1; // right, this sample
    const c = ((i + 1) % sampleCount) * 2; // left, next sample
    const d = c + 1; // right, next sample
    const base = i * 6;
    // side = tangent x up points RIGHT, so (c - a) x (b - a) = tangent x side
    // points DOWN; wind (a, b, c) so the face normal is +Y
    indices[base + 0] = a;
    indices[base + 1] = b;
    indices[base + 2] = c;
    indices[base + 3] = b;
    indices[base + 4] = d;
    indices[base + 5] = c;
    if (doubleSided) {
      const back = frontCount + i * 6;
      indices[back + 0] = a;
      indices[back + 1] = c;
      indices[back + 2] = b;
      indices[back + 3] = b;
      indices[back + 4] = c;
      indices[back + 5] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  // computeVertexNormals over BOTH copies would sum +Y and -Y faces to zero:
  // compute from the front copy only, then install the full index
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, frontCount), 1));
  geometry.computeVertexNormals();
  if (doubleSided) geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

/**
 * Ribbon extruded UP by `thickness` into a closed slab: the curve is the
 * underside (the path tool samples it off terrain, so the slab sits ON the
 * ground like a raised road or curb) and the drivable surface is `thickness`
 * above it — extruding down instead would bury the whole slab in the terrain
 * that the curve was traced over. Top, bottom and the
 * two side walls (plus end caps on an open path) each get their own
 * vertices so the crease between them shades hard instead of averaging
 * into a rounded-looking edge. Wall UVs keep v = arc length like the top so
 * a tiled road material stays continuous around the edge.
 */
function slabGeometry(
  curve: THREE.CatmullRomCurve3,
  segments: number,
  width: number,
  thickness: number,
  closed: boolean,
): THREE.BufferGeometry {
  const frames = sampleFrames(curve, segments);
  const sampleCount = frames.length;
  const quadCount = closed ? sampleCount : sampleCount - 1;
  const capCount = closed ? 0 : 2;
  // 4 faces (top, bottom, left wall, right wall), each 2 verts per sample
  const faceVerts = sampleCount * 2;
  const vertexCount = faceVerts * 4 + capCount * 4;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const stripIndices = quadCount * 6;
  const indices = new Uint32Array(stripIndices * 4 + capCount * 6);
  const wallU = thickness / width; // same texel density as the top face

  const setVertex = (index: number, p: THREE.Vector3, u: number, v: number): void => {
    positions[index * 3 + 0] = p.x;
    positions[index * 3 + 1] = p.y;
    positions[index * 3 + 2] = p.z;
    uvs[index * 2 + 0] = u;
    uvs[index * 2 + 1] = v;
  };

  const TOP = 0;
  const BOTTOM = faceVerts;
  const LEFT = faceVerts * 2;
  const RIGHT = faceVerts * 3;
  const CAPS = faceVerts * 4;

  for (let i = 0; i < sampleCount; i++) {
    const { point, side, arcLength } = frames[i]!;
    const bl = point.clone().addScaledVector(side, -width / 2);
    const br = point.clone().addScaledVector(side, width / 2);
    const tl = bl.clone().setY(bl.y + thickness);
    const tr = br.clone().setY(br.y + thickness);
    setVertex(TOP + i * 2, tl, 0, arcLength);
    setVertex(TOP + i * 2 + 1, tr, 1, arcLength);
    setVertex(BOTTOM + i * 2, bl, 0, arcLength);
    setVertex(BOTTOM + i * 2 + 1, br, 1, arcLength);
    setVertex(LEFT + i * 2, tl, 0, arcLength);
    setVertex(LEFT + i * 2 + 1, bl, wallU, arcLength);
    setVertex(RIGHT + i * 2, tr, 0, arcLength);
    setVertex(RIGHT + i * 2 + 1, br, wallU, arcLength);
  }

  // Each face is a strip of (first, second) vertex pairs per sample. With
  // pairs (left, right) the unflipped winding faces +Y (see ribbonGeometry);
  // with pairs (top, bottom) it faces +side. `flip` reverses it.
  const strip = (faceBase: number, indexBase: number, flip: boolean): void => {
    for (let i = 0; i < quadCount; i++) {
      const a = faceBase + i * 2;
      const b = a + 1;
      const c = faceBase + ((i + 1) % sampleCount) * 2;
      const d = c + 1;
      const base = indexBase + i * 6;
      if (flip) {
        indices[base + 0] = a;
        indices[base + 1] = c;
        indices[base + 2] = b;
        indices[base + 3] = b;
        indices[base + 4] = c;
        indices[base + 5] = d;
      } else {
        indices[base + 0] = a;
        indices[base + 1] = b;
        indices[base + 2] = c;
        indices[base + 3] = b;
        indices[base + 4] = d;
        indices[base + 5] = c;
      }
    }
  };
  strip(TOP, 0, false); // +Y
  strip(BOTTOM, stripIndices, true); // -Y
  strip(LEFT, stripIndices * 2, true); // -side (outward on the left edge)
  strip(RIGHT, stripIndices * 3, false); // +side

  if (!closed) {
    // end caps: quad (tl, tr, br, bl) at the first and last sample
    const capQuad = (capIndex: number, frame: RibbonFrame, facingBackward: boolean): void => {
      const v = CAPS + capIndex * 4;
      const bl = frame.point.clone().addScaledVector(frame.side, -width / 2);
      const br = frame.point.clone().addScaledVector(frame.side, width / 2);
      setVertex(v + 0, bl.clone().setY(bl.y + thickness), 0, 0);
      setVertex(v + 1, br.clone().setY(br.y + thickness), 1, 0);
      setVertex(v + 2, br, 1, wallU);
      setVertex(v + 3, bl, 0, wallU);
      const base = stripIndices * 4 + capIndex * 6;
      // (tr - tl) x (br - tl) = side x -Y = +tangent, so (0,1,2)(0,2,3)
      // faces along the curve — right for the END cap; the START cap faces
      // back the other way
      const order = facingBackward ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (let k = 0; k < 6; k++) indices[base + k] = v + order[k]!;
    };
    capQuad(0, frames[0]!, true);
    capQuad(1, frames[sampleCount - 1]!, false);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}
