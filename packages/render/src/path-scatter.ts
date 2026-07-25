import * as THREE from "three/webgpu";

export interface PathScatterData {
  points: Array<[number, number, number]>;
  closed: boolean;
  prop:
    | { kind: "primitive"; shape: string; size: [number, number, number] }
    | { kind: "asset"; assetId: string; node?: string };
  material?: string;
  spacing: number;
  offset: number;
  alignToTangent: boolean;
  heightOffset: number;
  sideOffset: number;
  scaleJitter: number;
  rotationJitter: number;
  seed: number;
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface PathPlacement {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
}

/** Deterministic per-index hash in [0,1) — same style as core/terrain.ts's noise hash. */
function hash(i: number, seed: number): number {
  const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * Placements along the curve at even world-space spacing (arc-length
 * parametrized via CatmullRomCurve3.getPointAt, not the raw [0,1] curve
 * parameter — otherwise spacing would bunch up on tight turns). Side vector
 * uses the same stable world-up frame as path-mesh's ribbon, for the same
 * reason: Frenet frames flip unpredictably on straight/near-vertical spans.
 */
export function pathScatterPlacements(data: PathScatterData): PathPlacement[] {
  if (data.points.length < 2) return [];
  const points = data.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(points, data.closed);
  const length = curve.getLength();
  if (length <= 0) return [];

  const worldUp = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3(0, 0, 1);
  let side = new THREE.Vector3(1, 0, 0);
  const placements: PathPlacement[] = [];

  // +epsilon: an open curve whose length is an exact multiple of spacing
  // should still place at the far endpoint, not drop it to float drift.
  const limit = data.closed ? length : length + 1e-6;
  let index = 0;
  for (let d = data.offset; d <= limit; d += data.spacing, index++) {
    // closed curves wrap (one full lap == back to the start); open curves
    // clamp instead — d % length would wrongly wrap an exact-endpoint d
    // (e.g. d === length) back to the START rather than the curve's end.
    const wrapped = data.closed ? d % length : Math.min(d, length);
    const u = THREE.MathUtils.clamp(wrapped / length, 0, 1);
    const point = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u);

    const candidate = new THREE.Vector3().crossVectors(tangent, worldUp);
    if (candidate.lengthSq() > 1e-6) side = candidate.normalize();

    const position = point.clone().addScaledVector(side, data.sideOffset);
    position.y += data.heightOffset;

    let quaternion = new THREE.Quaternion();
    if (data.alignToTangent) quaternion.setFromUnitVectors(forward, tangent);
    if (data.rotationJitter > 0) {
      const yaw = (hash(index, data.seed) - 0.5) * 2 * Math.PI * data.rotationJitter;
      quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(worldUp, yaw));
    }

    const scale = data.scaleJitter > 0 ? 1 + (hash(index, data.seed + 1000) - 0.5) * 2 * data.scaleJitter : 1;
    placements.push({ position, quaternion, scale: Math.max(0.05, scale) });
  }
  return placements;
}
