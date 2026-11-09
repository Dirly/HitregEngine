/**
 * Where a siting FAR render stands, and whether its frame can judge the site.
 *
 * redstrand 2026-10-29: the propose tool put every far camera `read` metres out on the bearing whose ground 300 m out
 * was LOWEST — on a coastal site that is the sea, so most cameras stood over open water looking at empty sea or a
 * distant strip of coast, and some framed an islet instead of the candidate. A far camera now stands ON LAND
 * FAR_MIN_M-FAR_MAX_M from the candidate (the open side first: the bearing nearest the site's view), at a raised eye
 * over that ground, with a clear line of sight to the pad, and its frame is checked before it is used:
 *   - `water`: the share of the frame's centre region (the middle 40 % x 40 %) whose rays land on the sea, a lake or a river (or run off
 *     into the sky) must be <= FAR_WATER_MAX;
 *   - `visible`: the pad's target point is in frame and not hidden by the ground in between.
 * A candidate with no camera passing both says so (no frame is better than a frame of the sea).
 */

export type V2 = [number, number];
export type V3 = [number, number, number];

export const FAR_MIN_M = 300;
/** The nearest a far camera may stand when nothing 300-400 m out works. */
export const FAR_NEAR_M = 180;
/** Eye heights over the camera's ground tried in turn. */
export const FAR_EYES_M = [30, 45, 60];
/** Clearance the sight line keeps over the bare ground (scatter rocks and trees stand on it). */
export const SIGHT_CLEAR_M = 6;
export const FAR_MAX_M = 400;
/** Max share of the frame's centre region that may be sea or sky. */
export const FAR_WATER_MAX = 0.7;
/** light-shots: 1280 x 720, the scene camera's vertical fov 65 deg. */
export const FRAME_FOV_DEG = 65;
export const FRAME_ASPECT = 1280 / 720;

export interface FarCameraInput {
  at: V2;
  /** Ground height at the candidate. */
  y: number;
  /** Bearing of the open side (compass degrees, 0 = north/-Z): tried first. */
  view: number;
  ground: (x: number, z: number) => number;
  seaLevel: number;
  /** Standing water on land (lakes, rivers): counted as water in the frame check like the sea. */
  wet?: (x: number, z: number) => boolean;
  min?: number;
  max?: number;
}

export interface FarCamera {
  camera: V3;
  target: V3;
  /** Bearing the camera stands on, seen from the candidate. */
  bearing: number;
  distance: number;
  check: FrameCheck;
}

export interface FrameCheck {
  /** Share of the centre region's rays that end on the sea or in the sky. */
  water: number;
  /** The target point is in front of the camera, inside the frame, and not hidden by the ground. */
  visible: boolean;
  ok: boolean;
  why: string;
}

const dirOf = (b: number): V2 => [Math.sin((b * Math.PI) / 180), -Math.cos((b * Math.PI) / 180)];
const r1 = (v: number) => Math.round(v * 10) / 10;
const angDist = (a: number, b: number) => { const d = Math.abs(((a - b) % 360) + 360) % 360; return d > 180 ? 360 - d : d; };

/** The ground between two points stays under the straight line (the last `skipEnd` m round the target excepted). */
export function lineClear(from: V3, to: V3, ground: (x: number, z: number) => number, skipEnd = 30, clear = SIGHT_CLEAR_M): boolean {
  const len = Math.hypot(to[0] - from[0], to[2] - from[2]);
  const n = Math.max(8, Math.ceil(len / 4));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (len * (1 - t) < skipEnd) break;
    const x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t, y = from[1] + (to[1] - from[1]) * t;
    if (ground(x, z) > y - clear * (1 - t)) return false; // full clearance at the camera, none at the target
  }
  return true;
}

/** Judges one frame from its camera: the centre region's water/sky share and the target's visibility. */
export function checkFrame(camera: V3, target: V3, ground: (x: number, z: number) => number, seaLevel: number, o: { fovDeg?: number; aspect?: number; reach?: number; wet?: (x: number, z: number) => boolean } = {}): FrameCheck {
  const fov = ((o.fovDeg ?? FRAME_FOV_DEG) * Math.PI) / 180, aspect = o.aspect ?? FRAME_ASPECT, reach = o.reach ?? 2000;
  // camera basis
  let fx = target[0] - camera[0], fy = target[1] - camera[1], fz = target[2] - camera[2];
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl; // right = forward x up
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy; // up = right x forward
  const th = Math.tan(fov / 2), tw = th * aspect;
  let wet = 0, total = 0;
  const N = 7;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    // the middle 40 % x 40 % of the frame
    const sx = (-0.4 + (0.8 * i) / (N - 1)) * tw, sy = (-0.4 + (0.8 * j) / (N - 1)) * th; // NDC +-0.4
    let dx = fx + rx * sx + ux * sy, dy = fy + uy * sy, dz = fz + rz * sx + uz * sy;
    const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
    total++;
    let hit: "land" | "sea" | "sky" = "sky";
    for (let s = 4; s <= reach; s += 4) {
      const x = camera[0] + dx * s, y = camera[1] + dy * s, z = camera[2] + dz * s;
      const g = ground(x, z);
      if (y <= Math.max(g, seaLevel)) { hit = g > seaLevel && !o.wet?.(x, z) ? "land" : "sea"; break; }
    }
    if (hit !== "land") wet++;
  }
  const water = wet / total;
  // the target: in front and inside the frame by construction of the aim; hidden only by the ground between
  const visible = lineClear(camera, target, ground);
  const ok = visible && water <= FAR_WATER_MAX;
  const why = ok ? "" : [!visible ? "the pad is hidden by the ground in between" : "", water > FAR_WATER_MAX ? `centre ${Math.round(water * 100)} % sea/sky (max ${Math.round(FAR_WATER_MAX * 100)} %)` : ""].filter(Boolean).join("; ");
  return { water: Math.round(water * 100) / 100, visible, ok, why };
}

/** No ground within CAMERA_CLEAR_R_M of the camera stands over its eye (redstrand 2026-10-29: a camera on a beach at the
 *  foot of a 100 m sea cliff showed half a frame of cliff wall). */
export const CAMERA_CLEAR_R_M = 40;
export function cameraClear(camera: V3, ground: (x: number, z: number) => number): boolean {
  for (const r of [8, 16, 28, CAMERA_CLEAR_R_M])
    for (let b = 0; b < 360; b += 30) { const [dx, dz] = dirOf(b); if (ground(camera[0] + dx * r, camera[2] + dz * r) > camera[1] - 3) return false; }
  return true;
}

/** The far camera for a candidate: on land, 300-400 m out, nearest the open side, eye raised only as far as needed. */
export function farCamera(c: FarCameraInput): FarCamera | null {
  const min = c.min ?? FAR_MIN_M, max = c.max ?? FAR_MAX_M;
  const target: V3 = [c.at[0], r1(c.y + 4), c.at[1]];
  const bearings = Array.from({ length: 24 }, (_, k) => k * 15).sort((a, b) => angDist(a, c.view) - angDist(b, c.view));
  const dists = [Math.round((min + max) / 2), min, max];
  // a site on a narrow cape or under a face looking out to sea has no dry land 300-400 m out: a nearer ring (>= FAR_NEAR_M) is
  // tried last (redstrand foot-23 on the SE cape spine had no far frame)
  dists.push(FAR_NEAR_M, Math.round((FAR_NEAR_M + min) / 2));
  // two passes: a frame at most half water anywhere round the site first, then up to FAR_WATER_MAX
  for (const waterMax of [0.5, FAR_WATER_MAX]) for (const b of bearings) {
    const [dx, dz] = dirOf(b);
    for (const d of dists) {
      const x = c.at[0] + dx * d, z = c.at[1] + dz * d;
      const g = c.ground(x, z);
      if (g < c.seaLevel + 2 || c.wet?.(x, z)) continue; // on dry land only (redstrand: a camera stood on a lake)
      // a raised eye (30-60 m: over the scatter and the tree tops — a 20 m eye stood inside pine canopies on redstrand s110/s111/s129, the pad read as ground not as a horizon line); redstrand 2026-10-29: an 8 m
      // eye stood behind a scatter rock and a rise and showed neither the pad nor its flanks
      for (const eye of FAR_EYES_M) {
        const camera: V3 = [r1(x), r1(g + eye), r1(z)];
        if (!cameraClear(camera, c.ground)) continue;
        const check = checkFrame(camera, target, c.ground, c.seaLevel, { wet: c.wet });
        if (check.ok && check.water <= waterMax) return { camera, target, bearing: b, distance: d, check };
      }
    }
  }
  return null;
}

/**
 * Luma spread (standard deviation, 0-255) of the lower 40 % of a rendered frame, where the ground is. Under
 * GROUNDLESS_STD the terrain never streamed in: the frame is sky over the flat sea plane or a horizon impostor
 * (2026-10-29 redstrand w6: after a few long teleports the propose's light-shots page drew 5 of 14 far frames with no
 * ground and then crashed; the frames looked like an open sea and could be mistaken for a sea view). Real ground,
 * even a flat plain, measures 13-27; the groundless frames 4.4-5.4.
 */
export const GROUNDLESS_STD = 8;
/** `from`: the top of the band measured, as a fraction of the height (0.6: the lower frame; a SEA view, whose lower frame is
 *  water by design, measures from 0.3: the shore and cliff band). */
export function groundSpread(img: { width: number; height: number; data: Uint8Array }, from = 0.6): number {
  const { width: w, height: h, data } = img;
  const ch = data.length / (w * h);
  let s = 0, q = 0, n = 0;
  for (let y = Math.floor(h * from); y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      const o = (y * w + x) * ch;
      const v = data[o]! * 0.3 + data[o + 1]! * 0.59 + data[o + 2]! * 0.11;
      s += v; q += v * v; n++;
    }
  return n ? Math.sqrt(Math.max(0, q / n - (s / n) ** 2)) : 0;
}
