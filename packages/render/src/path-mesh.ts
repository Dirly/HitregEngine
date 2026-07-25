import * as THREE from "three/webgpu";

export interface PathMeshSource {
  points: Array<[number, number, number]>;
  closed: boolean;
  crossSection: "ribbon" | "tube";
  width: number;
  radius: number;
  radialSegments: number;
  segmentsPerSpan: number;
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
  return ribbonGeometry(curve, segments, source.width, source.closed);
}

/**
 * Flat strip along the curve, width `width`. Uses world-up (not Frenet
 * frames) to pick the side vector — Frenet frames twist/flip unpredictably
 * on straight or near-vertical spans, which reads as a visibly warped road;
 * world-up stays stable for the road/river/fence use case (mostly-horizontal
 * curves), falling back to the last valid side vector on a near-vertical
 * tangent instead of degenerating to a zero-length cross product.
 */
function ribbonGeometry(
  curve: THREE.CatmullRomCurve3,
  segments: number,
  width: number,
  closed: boolean,
): THREE.BufferGeometry {
  const sampleCount = segments + 1;
  const positions = new Float32Array(sampleCount * 2 * 3);
  const uvs = new Float32Array(sampleCount * 2 * 2);
  const worldUp = new THREE.Vector3(0, 1, 0);
  let side = new THREE.Vector3(1, 0, 0);
  let arcLength = 0;
  let prevPoint: THREE.Vector3 | null = null;

  for (let i = 0; i < sampleCount; i++) {
    const t = i / segments;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    if (prevPoint) arcLength += point.distanceTo(prevPoint);
    prevPoint = point;

    const candidate = new THREE.Vector3().crossVectors(tangent, worldUp);
    if (candidate.lengthSq() > 1e-6) side = candidate.normalize();
    // else: tangent nearly parallel to world-up (near-vertical span) — keep
    // the last valid side vector rather than flip through a degenerate cross product

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
  const indices = new Uint32Array(quadCount * 6);
  for (let i = 0; i < quadCount; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % sampleCount) * 2;
    const d = c + 1;
    const base = i * 6;
    indices[base + 0] = a;
    indices[base + 1] = c;
    indices[base + 2] = b;
    indices[base + 3] = b;
    indices[base + 4] = c;
    indices[base + 5] = d;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}
