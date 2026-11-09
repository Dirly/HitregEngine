/**
 * CLEAR VIEWS for batch cameras (e-guard 2026-11-03: place-build render-batch / light-shots put iso and read cameras
 * inside tree canopy, trunks and rock faces — gullwrack-cove, redeye-perch, tide-chapel, south-watch, flayers-lee,
 * reedmaw, the ant-picked-wreck hull camera).
 *
 * light-shots, once a spot's world has streamed in, casts a small fan of rays from the camera to the place it must
 * show (the view's own `target` for a fixed camera; the spot's `aim`, the place centre, for a rig camera) against what
 * is drawn (src/line-of-sight.ts: terrain, scene meshes, vegetation instances, faces from both sides). Blocked: it walks
 * these candidate poses NEAREST FIRST — orbit round the aim point, then lift, then pull in towards it — and shoots
 * from the first clear one (recorded on the spot and every frame as `clearView`); none clear: the spot is shot as
 * given and reported `NO CLEAR VIEW` (record `clearView.blocked`), so the sheet says why the frame shows leaves.
 * Pure: the geometry and the ordering; the casting happens in the page.
 */
export type V3 = [number, number, number];

export interface ClearCandidate {
  camera: V3;
  target: V3;
  /** Degrees orbited round the aim (+ = counter-clockwise seen from above). */
  dYawDeg: number;
  /** Degrees lifted on the orbit. */
  dElevDeg: number;
  /** Share of the camera-to-aim distance kept (1 = not pulled in). */
  pull: number;
  cost: number;
}

export const CLEAR_YAWS_DEG = [0, 6, -6, 12, -12, 20, -20, 30, -30, 45, -45];
export const CLEAR_LIFTS_DEG = [0, 5, 10, 18];
export const CLEAR_PULLS = [1, 0.85, 0.7, 0.55];
/** Candidates tested at most per spot (nearest first). */
export const CLEAR_MAX = 60;
/** Highest elevation a lifted camera reaches (deg above the horizon, seen from the aim). */
export const CLEAR_MAX_ELEV_DEG = 75;
/** A candidate camera keeps at least this much air over the ground. */
export const CLEAR_GROUND_M = 1.5;

/** How far a move reads from the pose the owner chose: degrees round + degrees up + pull-in (each 10 % = 6). */
export const clearCost = (dYaw: number, dElev: number, pull: number): number => Math.abs(dYaw) + 1.2 * dElev + 60 * (1 - pull);

/**
 * Candidate poses for a camera at `camera` looking at `target` that must see `aim`, nearest first (the given pose is
 * always first). Each orbits/lifts/pulls the camera about `aim`; the look target turns with it (round `aim` by the same
 * yaw), so a fixed view aimed at its own target keeps looking at it, and a rig view keeps its framing.
 * `groundAt` (optional) drops candidates under the ground.
 */
export function clearViewCandidates(camera: V3, target: V3, aim: V3, o: { groundAt?: (x: number, z: number) => number; max?: number } = {}): ClearCandidate[] {
  const vx = camera[0] - aim[0], vy = camera[1] - aim[1], vz = camera[2] - aim[2];
  const r = Math.hypot(vx, vz), len = Math.hypot(vx, vy, vz);
  const az = Math.atan2(vz, vx), el = Math.atan2(vy, r);
  const out: ClearCandidate[] = [];
  for (const dYaw of CLEAR_YAWS_DEG) for (const dElev of CLEAR_LIFTS_DEG) for (const pull of CLEAR_PULLS) {
    const a = az + (dYaw * Math.PI) / 180;
    const e = Math.min((CLEAR_MAX_ELEV_DEG * Math.PI) / 180, el + (dElev * Math.PI) / 180);
    if (dElev > 0 && e <= el) continue; // already above the cap: lifting changes nothing
    const L = len * pull;
    const cam: V3 = [aim[0] + Math.cos(a) * Math.cos(e) * L, aim[1] + Math.sin(e) * L, aim[2] + Math.sin(a) * Math.cos(e) * L];
    if (o.groundAt && cam[1] < o.groundAt(cam[0], cam[2]) + CLEAR_GROUND_M) continue;
    const cy = Math.cos((dYaw * Math.PI) / 180), sy = Math.sin((dYaw * Math.PI) / 180);
    const tx = target[0] - aim[0], tz = target[2] - aim[2];
    const tgt: V3 = [aim[0] + tx * cy - tz * sy, target[1], aim[2] + tx * sy + tz * cy];
    out.push({ camera: round3(cam), target: round3(tgt), dYawDeg: dYaw, dElevDeg: dElev, pull, cost: clearCost(dYaw, dElev, pull) });
  }
  out.sort((p, q) => p.cost - q.cost);
  return out.slice(0, o.max ?? CLEAR_MAX);
}

/**
 * The rays a pose must get through: to `aim`, then a cross round it (right/left/up/down by `spread` m, spread from the
 * vertical FOV: about a third of the half-frame at the aim's distance, 1..12 m). The first ray must be clear.
 */
export function sightRays(camera: V3, aim: V3, fovDeg: number): V3[] {
  const d: V3 = [aim[0] - camera[0], aim[1] - camera[1], aim[2] - camera[2]];
  const len = Math.hypot(...d) || 1;
  const spread = Math.min(12, Math.max(1, 0.3 * len * Math.tan(((fovDeg || 50) / 2) * Math.PI / 180)));
  const hr = Math.hypot(d[0], d[2]) || 1;
  const right: V3 = [-d[2] / hr, 0, d[0] / hr];
  const f: V3 = [d[0] / len, d[1] / len, d[2] / len];
  const up: V3 = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
  const at = (u: V3, s: number): V3 => round3([aim[0] + u[0] * s, aim[1] + u[1] * s, aim[2] + u[2] * s]);
  return [round3(aim), at(right, spread), at(right, -spread), at(up, spread), at(up, -spread)];
}

/** What a spot's record says about its view (light-shots spots[].clearView and every frame of it). */
export type ClearViewRecord =
  | { ok: true; checked: number }
  | { moved: true; from: V3; to: V3; target: V3; dYawDeg: number; dElevDeg: number; pull: number; blockedBy: string; blockedAtM: number }
  | { blocked: true; by: string; atM: number; tried: number };

/** The camera a frame should have been shot from: the cleared pose when light-shots moved it, else the spot's own. */
export const expectedCamera = (spotCamera: readonly number[] | undefined, clear: ClearViewRecord | undefined): readonly number[] | undefined =>
  clear && "moved" in clear ? clear.to : spotCamera;

const round3 = (p: V3): V3 => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100];

/** A rig view (no fixed camera) is checked against its `aim` only from at least this far (a read view, not a close one). */
export const CLEAR_RIG_MIN_M = 25;
