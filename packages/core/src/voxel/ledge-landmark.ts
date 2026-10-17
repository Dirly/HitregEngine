/**
 * LEDGE LANDMARKS — a ledge system built the way the dungeons are: real 3D rock at a fine DC voxel, not 2 m terrain.
 *
 * The 2 m terrain lattice cannot draw a 4 m ledge drop (two voxels: the lip smears into a blocky step) and a height
 * edit has one ground height per point (no overhangs, no brows). So the `ledges` operator (mode "landmark") solves the
 * shelves on the lattice exactly as before (`solveShelves`: bands, stagger, ramps, cave links), then:
 *
 * - `ledgeLandmarkVolume` turns that solve into CSG solids for the DC mesher (`createVolume` / `buildVolumeMesh`):
 *   STACKED ROCK MASSES, one per shelf level (that level's outline with its own ragged noise, battered faces notched
 *   every ~1.5 m, rounded top edges; no brows: an overhung lip read as a floating disc from below), ramps cut as notches between rock cheeks, a few low boulder masses fused into wide shelves,
 *   and the cave links bored through as sub volumes with flared mouths. No pillars. The foot is buried: past the
 *   shelving core the masses sink under the ground they fade into.
 * - `ledgeLandmarkGround` is the terrain under it: the shelf surface eroded and set slightly INSIDE the rock (and
 *   dropped under every cave bore), in >= 6 m features, faded into the slope by the solve's own mask. The seam is
 *   hidden because the terrain is always behind the rock where the rock shows, and over it where the rock is buried.
 * - `features.landmarks` (this file's schema) places the BAKED model: a prefab (merged GLB + trimesh collider, the
 *   world's terrain material, one draw) streamed in the cell its origin stands in, like a kit wall piece. The piece's
 *   prefab id carries the digest of the solids, so a re-run that changes the rock names a new bake and an undo names
 *   the old one again (`tools/ledge-landmark.mts` bakes it; nothing is placed until the bake exists).
 */
import { z } from "zod";
import type { ChunkDoc } from "../chunks.js";
import { encodeHeightfieldValues, type CsgNode, type VolumeDoc } from "./csg.js";
import { fringeShelves, valueNoise, type ShelvingGrid } from "./shelving.js";
import type { OperatorPiece } from "./operator-registry.js";

export const landmarkSchema = z.object({
  id: z.string().describe("`op:<operator id>:landmark` — compiled by a landform operator (`ledges`); never hand-edited."),
  prefab: z.string().describe("Baked landmark prefab (`landmarks/<operator id>-<digest>`): merged DC mesh + trimesh collider. Written by `tools/ledge-landmark.mts`."),
  position: z.tuple([z.number(), z.number(), z.number()]).describe("World origin of the prefab (the landmark's footprint centre at y 0); it streams in the cell this stands in."),
  radius: z.number().positive().describe("Horizontal reach of the solids from `position`, metres (bounds, culling, previews)."),
  digest: z.string().describe("Hash of the CSG solids the prefab must be baked from; a bake with another digest is stale."),
});
export type LandmarkDoc = z.infer<typeof landmarkSchema>;

/** Every landmark whose origin stands in chunk cell (cx, cz), as a collapsed prefab instance. */
export function landmarkEntities(
  landmarks: readonly LandmarkDoc[] | undefined,
  cellSize: number,
  cx: number,
  cz: number,
  entities: ChunkDoc["entities"],
  assetExists?: (assetId: string, kind: "prefab" | "model") => boolean,
): void {
  for (const l of landmarks ?? []) {
    const [x, y, z] = l.position;
    if (Math.floor(x / cellSize) !== cx || Math.floor(z / cellSize) !== cz) continue;
    if (assetExists && !assetExists(l.prefab, "prefab")) continue;
    entities[`lm_${l.id}`] = {
      name: `${l.id} landmark`,
      parent: null,
      tags: ["landmark", l.id],
      components: {
        transform: { position: [x - cx * cellSize, y, z - cz * cellSize] },
        prefab: { prefabId: l.prefab, props: {}, overrides: [] },
      },
    };
  }
}

const smooth = (a: number, b: number, t: number) => { const u = Math.max(0, Math.min(1, (t - a) / (b - a))); return u * u * (3 - 2 * u); };

function blur3(F: Float64Array, cols: number, rows: number): Float64Array {
  const out = new Float64Array(F.length);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let s = 0, w = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const k = dr === 0 && dc === 0 ? 4 : dr === 0 || dc === 0 ? 2 : 1;
      s += F[rr * cols + cc]! * k; w += k;
    }
    out[r * cols + c] = s / w;
  }
  return out;
}

export interface LedgeLandmarkOptions {
  /** DC voxel, metres (0.5: a 4 m drop is 8 voxels, a lip reads as a lip). */
  voxel: number;
  seed: number;
  /** Metres each level's outline wanders (0.5-1.5; a different noise per level). */
  lipNoise: number;
  /** Degrees every rock face leans back from vertical (5-10: a battered face). */
  batter: number;
  /** Metres of rounding on every mass's top edge. */
  chamfer: number;
  /** Low, wide boulder masses fused into the wider shelves, whole site. */
  boulders: number;
  /** Metres the terrain stays under the rock (the operator's `inset`): the reach repair walks that ground in the fade. */
  inset?: number;
  /** Repair ramps the BAKED collider walk asked for (head on the cut-off shelf, foot on reached ground): each is cut
   *  as a wide notch (`REPAIR_HALF`, `REPAIR_CHEEK`) after the solve's own notches. The collider is the truth. */
  reachRepairs?: { from: [number, number, number]; to: [number, number, number] }[];
}

/** Half width of a collider repair ramp's floor (with the lateral noise it never narrows under 2.6 m). */
export const REPAIR_HALF = 1.6;
/** Width of the rock cheeks beside a collider repair ramp: at least LANDMARK_MIN_VOXELS at the 0.5 m voxel. */
export const REPAIR_CHEEK = 1.6;

/** Thinnest wall the solids may have, in voxels (the dungeon kit's MIN_SHELL_VOXELS: a thinner DC shell perforates). */
export const LANDMARK_MIN_VOXELS = 3;
/** Strata: a riser face steps back by NOTCH metres every ~TIER metres of height. */
const TIER = 1.5, NOTCH = 0.3;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

function hash01(seed: number, a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** FNV-1a over a string, 8 hex chars. */
export function landmarkDigest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The shelf level index per cell: the solve's band K (BEFORE ramps raised the target: a worn ramp's shoulders would
 *  otherwise round up into a higher mass and wall off the ramp foot; the ramps are cut back in as notches). */
function cellLevels(grid: ShelvingGrid): Float64Array {
  return Float64Array.from(grid.K, (k) => Math.round(k));
}

function bilinear(F: ArrayLike<number>, grid: ShelvingGrid, x: number, z: number): number {
  const { x0, z0, g, cols, rows } = grid;
  const u = Math.max(0, Math.min(cols - 1.0001, (x - x0) / g)), v = Math.max(0, Math.min(rows - 1.0001, (z - z0) / g));
  const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r, i = r * cols + c;
  const a = F[i]! + (F[i + 1]! - F[i]!) * fu, b = F[i + cols]! + (F[i + cols + 1]! - F[i + cols]!) * fu;
  return a + (b - a) * fv;
}

/**
 * Signed distance (metres, + inside) from each cell centre to the outline of the cells `inside` marks, measured
 * centre-to-centre minus half a cell: bilinear across a straight edge it is the exact distance to the edge midline.
 */
function signedCellDistance(inside: (i: number) => boolean, cols: number, rows: number, g: number, reach: number): Float64Array {
  const D = new Float64Array(cols * rows), R = Math.ceil(reach / g);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const me = inside(r * cols + c);
    let best = R * g;
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || inside(rr * cols + cc) === me) continue;
      best = Math.min(best, Math.hypot(dr, dc) * g);
    }
    D[r * cols + c] = (me ? 1 : -1) * (best - g / 2);
  }
  return D;
}

export interface LedgeLandmarkVolume {
  /** Local frame origin (world): the footprint centre at y 0. */
  origin: [number, number, number];
  radius: number;
  voxel: number;
  nodes: CsgNode[];
  /** Mesh tiles (local bounds), lattice-aligned, so tiles meet exactly. */
  tiles: { min: [number, number, number]; max: [number, number, number] }[];
  digest: string;
  /** The ramp notches (world): foot (ax, az, ay) to head (bx, bz, by), ~2.4 m wide. */
  notches: { ax: number; az: number; ay: number; bx: number; bz: number; by: number }[];
  /** Notch ends with no shelf of their own level within 9 m (world x, y, z): a ramp that leads nowhere. */
  unjoinedEnds: [number, number, number][];
  /** Core shelves the notches and caves left cut off, joined by a REPAIR notch down to the next shelf or the hillside. */
  repairs: { level: number; from: [number, number, number]; to: [number, number, number] }[];
  report: { masses: number; notches: number; unjoined: number; fringe: number; repairs: number; unreachable: number; slabs: number; boulders: number; pillars: 0; caves: number; caveNodes: number; fine: [number, number] };
}

/**
 * The shelving solve as CSG solids (local to `origin`), ready for `createVolume` with the world's palette.
 *
 * STACKED ROCK MASSES: every band k is the rock from shelf level k-1 up to level k inside that level's outline (its
 * own ragged noise), its face battered back a few degrees and notched every ~1.5 m (strata relief), its top edge
 * rounded; all of them are sampled into one heightfield (the max of the masses) at half the voxel. A BROW is the
 * upper mass's lip carried out over the riser below (a flat-topped, rounded prism flush with the shelf, kit-thick,
 * headroom >= 2.6 m), never a plate of its own. Ramps are notches cut between rock cheeks; a few low boulder masses
 * are fused into the wide shelves; the cave links are bored through with flared mouths. No pillars.
 */
export function ledgeLandmarkVolume(grid: ShelvingGrid, o: LedgeLandmarkOptions): LedgeLandmarkVolume {
  const { x0, z0, g, cols, rows, base, bandHeight: h, H, W, T } = grid;
  const f = o.voxel, seed = o.seed | 0;
  const spanX = (cols - 1) * g, spanZ = (rows - 1) * g;
  const cx = x0 + spanX / 2, cz = z0 + spanZ / 2;
  const level = (k: number) => base + k * h;
  const Kc = cellLevels(grid);
  const n = cols * rows;
  const core = (i: number) => W[i]! >= 0.97;
  // FRINGE shelves (`fringeShelves`: more than half in the fade band) are hillside: no rock on them, no landing needed
  let ncomp = 0;
  for (let i = 0; i < n; i++) ncomp = Math.max(ncomp, grid.comp[i]! + 1);
  const fringe = fringeShelves(grid.comp, W, ncomp);
  const F = new Float64Array(n);
  for (let i = 0; i < n; i++) if (grid.comp[i]! >= 0 && fringe[grid.comp[i]!]) F[i] = 1;
  const onFringe = (x: number, z: number) => bilinear(F, grid, x, z) >= 0.5;

  // ---- the masses: per level, the signed distance to its outline (cells at or above it)
  let kLo = Infinity, kHi = -Infinity;
  for (let i = 0; i < n; i++) if (W[i]! > 0.3) { kLo = Math.min(kLo, Kc[i]!); kHi = Math.max(kHi, Kc[i]!); }
  if (!Number.isFinite(kLo)) { kLo = 0; kHi = 0; }
  const masses: { k: number; D: Float64Array; tier: number; seed: number }[] = [];
  for (let k = kLo + 1; k <= kHi; k++) {
    masses.push({ k, D: signedCellDistance((i) => Kc[i]! >= k, cols, rows, g, 10), tier: TIER * (0.85 + 0.3 * hash01(seed + 3, k, 1)), seed: seed + 1009 * k });
  }
  const tanB = Math.tan((Math.max(0, Math.min(20, o.batter)) * Math.PI) / 180), ch = Math.max(0, Math.min(h / 3, o.chamfer));
  /** Height of a mass face above its foot, `e` metres in from the foot: stepped batter, then the rounded top edge. */
  const faceProfile = (tier: number) => {
    const tw = tier * tanB + NOTCH;
    const faceY = (e: number) => { const m = Math.floor(e / tw), r = e - m * tw; return m * tier + Math.min(tier, tanB > 0 ? r / tanB : tier); };
    const eAt = (y: number) => { const m = Math.floor(y / tier); return m * tw + (y - m * tier) * tanB; };
    const eC = eAt(h - ch);
    return (e: number): number => {
      if (e <= 0) return -Infinity;
      let y = Math.min(h, faceY(e));
      if (e > eC) { const d = Math.min(ch, e - eC); y = Math.min(y, h - ch + Math.sqrt(Math.max(0, ch * ch - (ch - d) * (ch - d)))); }
      return y;
    };
  };
  const profiles = masses.map((m) => faceProfile(m.tier));
  const edgeAt = (m: (typeof masses)[number], x: number, z: number) =>
    bilinear(m.D, grid, x, z) + o.lipNoise * (0.65 * valueNoise(x, z, 6.5, m.seed) + 0.35 * valueNoise(x, z, 2.2, m.seed + 1)) + 0.12 * valueNoise(x, z, 0.8, m.seed + 2);

  // ---- ramps: the solve marks whole worn slopes as ramp cells; each ramp becomes ONE notch, a straight path ~2.4 m
  // wide along the solve's own walk line from its foot shelf to its head shelf at an even grade, cut between rock
  // cheeks (the rest of its cells stay rock: the masses already step through them by their rounded level)
  type Notch = { ax: number; az: number; ay: number; bx: number; bz: number; by: number; half?: number; cheek?: number };
  const RAMP_HALF = 1.2, CHEEK = 1.4, CHEEK_RISE = 1.8, RAMP_RUNOUT = 1.5;
  const segDist = (x: number, z: number, ax: number, az: number, bx: number, bz: number) => {
    const dx = bx - ax, dz = bz - az, ll = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / ll));
    return Math.hypot(x - ax - dx * t, z - az - dz * t);
  };
  // one notch per riser stretch: the solve can link two components across the same border (a corner cell touching two
  // upper components picks the same spot, once each way), and two crossing notches cut each other's floors apart
  const notches: Notch[] = [];
  for (const rp of grid.rampPaths ?? []) {
    const nt = { ax: rp.foot[0], az: rp.foot[2], ay: rp.foot[1], bx: rp.head[0], bz: rp.head[2], by: rp.head[1] };
    const clash = notches.some((o) => Math.abs(o.ay - nt.ay) < 0.1 && Math.abs(o.by - nt.by) < 0.1 && [0, 0.25, 0.5, 0.75, 1].some((t) => segDist(nt.ax + (nt.bx - nt.ax) * t, nt.az + (nt.bz - nt.az) * t, o.ax, o.az, o.bx, o.bz) < 2 * (RAMP_HALF + CHEEK)));
    if (!clash) notches.push(nt);
  }
  // ---- landings: each notch end is joined to the nearest point where its own shelf stands at full height and clear of
  // the next mass up (the solve runs a ramp ALONG the riser, so its head is beside the upper shelf, not on it, and the
  // battered face between them is a stair of 1.5 m strata). A 2.6 m path at the end's level, cut or filled, runs there.
  const LAND_HALF = 1.3;
  const fullIn = profiles.map((pf) => { let e = 0; while (e < 12 && pf(e) < h - 0.05) e += 0.05; return e; });
  const massOf = (k: number) => masses.findIndex((m) => m.k === k);
  const onShelf = (k: number, x: number, z: number) => {
    if (bilinear(W, grid, x, z) < 0.97) return false;
    const a = massOf(k), b = massOf(k + 1);
    if (a >= 0 && edgeAt(masses[a]!, x, z) < fullIn[a]! + 0.4) return false;
    if (a < 0 && k > kLo) return false;
    return b < 0 || edgeAt(masses[b]!, x, z) < -0.6;
  };
  const shelfSpot = (k: number, x: number, z: number) => [[0, 0], [1.3, 0], [-1.3, 0], [0, 1.3], [0, -1.3]].every(([dx, dz]) => onShelf(k, x + dx!, z + dz!));
  const landings: { ax: number; az: number; bx: number; bz: number; y: number }[] = [];
  let unjoined = 0;
  const unjoinedEnds: [number, number, number][] = [];
  for (const nt of notches) for (const [ex, ez, ey] of [[nt.bx, nt.bz, nt.by], [nt.ax, nt.az, nt.ay]] as const) {
    const k = Math.round((ey - base) / h);
    if (onFringe(ex, ez)) continue; // a notch end on the hillside meets the slope itself
    let best: [number, number] | null = null, bd = Infinity;
    for (let dz = -9; dz <= 9; dz += 0.5) for (let dx = -9; dx <= 9; dx += 0.5) {
      const d = Math.hypot(dx, dz);
      if (d > 9 || d >= bd || !shelfSpot(k, ex + dx, ez + dz)) continue;
      bd = d; best = [ex + dx, ez + dz];
    }
    if (!best) { unjoined++; unjoinedEnds.push([r2(ex), r2(ey), r2(ez)]); continue; }
    // carry the path 1 m past the spot, onto the shelf
    const l = Math.max(bd, 1e-6), ux = (best[0] - ex) / l, uz = (best[1] - ez) / l;
    landings.push({ ax: ex, az: ez, bx: best[0] + (bd > 0 ? ux : 0), bz: best[1] + (bd > 0 ? uz : 0), y: ey });
  }
  const landingAt = (x: number, z: number): number | null => {
    let y: number | null = null, bd = Infinity;
    for (const ld of landings) { const d = segDist(x, z, ld.ax, ld.az, ld.bx, ld.bz); if (d < bd && d <= LAND_HALF + 0.2 * valueNoise(x, z, 2.5, seed + 151)) { bd = d; y = ld.y; } }
    return y;
  };
  /** [floor height, lateral offset, inside the run (not the run-outs), head level, floor half width, cheek width, a collider repair] of the notch here, or null. */
  const rampAt = (x: number, z: number): [number, number, boolean, number, number, number, boolean] | null => {
    let best: [number, number, boolean, number, number, number, boolean] | null = null;
    for (const nt of notches) {
      const dx = nt.bx - nt.ax, dz = nt.bz - nt.az, len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const along = ((x - nt.ax) * dx + (z - nt.az) * dz) / len;
      if (along < -RAMP_RUNOUT || along > len + RAMP_RUNOUT) continue;
      const lat = Math.abs((x - nt.ax) * dz - (z - nt.az) * dx) / len;
      const half = nt.half ?? RAMP_HALF, cheek = nt.cheek ?? CHEEK;
      // a floor beats a cheek (a wide repair ramp's cheek never walls off another notch's floor), then the nearer centre line
      if (lat > half + cheek + 0.5) continue;
      if (best && (lat <= half ? 0 : 1) * 100 + lat >= (best[1] <= best[4] ? 0 : 1) * 100 + best[1]) continue;
      const t = Math.max(0, Math.min(1, along / len));
      best = [nt.ay + (nt.by - nt.ay) * t, lat, along >= 0 && along <= len, nt.by, half, cheek, nt.half !== undefined];
    }
    return best;
  };

  // ---- one heightfield: the max of the stacked masses, the ramp notches, buried past the core
  const fh = Math.max(f / 2, spanX / 2000, spanZ / 2000);
  const nx = Math.round(spanX / fh) + 1, nz = Math.round(spanZ / fh) + 1;
  const sx = spanX / (nx - 1), sz = spanZ / (nz - 1);
  const L = new Float32Array(nx * nz), rock = new Uint8Array(nx * nz);
  const fillL = () => { for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * sx, z = z0 + j * sz;
    // the fade, and the fringe shelves in it, sink under the hillside
    const s = smooth(0.6, 0.97, bilinear(W, grid, x, z)) * (1 - smooth(0.25, 0.75, bilinear(F, grid, x, z)));
    const buried = bilinear(H, grid, x, z) - 3;
    rock[j * nx + i] = 0;
    if (s <= 0 && !rampAt(x, z) && landingAt(x, z) === null) { L[j * nx + i] = buried; continue; }
    let top = level(kLo);
    for (let m = 0; m < masses.length; m++) {
      const M = masses[m]!;
      if (bilinear(M.D, grid, x, z) < -2.5 * Math.max(0.5, o.lipNoise)) continue;
      top = Math.max(top, level(M.k - 1) + profiles[m]!(edgeAt(M, x, z)));
    }
    top += 0.1 * valueNoise(x, z, 2.8, seed + 107) + 0.05 * valueNoise(x, z, 1.1, seed + 109);
    const rp = rampAt(x, z);
    let onRamp = false;
    if (rp) {
      const half = rp[4] + 0.25 * valueNoise(x, z, 3, seed + 117);
      if (rp[1] <= half) { top = rp[0] + 0.06 * valueNoise(x, z, 1.5, seed + 113); onRamp = true; }
      // a collider repair keeps cheeks only where it is cut INTO rock: across a shelf a cheek would wall off a walkway
      else if (rp[2] && rp[1] <= half + rp[5] && (!rp[6] || top > rp[0] + 0.5)) top = Math.max(top, Math.min(rp[0] + CHEEK_RISE, rp[3]));
    }
    let cut = onRamp;
    if (!onRamp) { const ly = landingAt(x, z); if (ly !== null) { top = ly + 0.06 * valueNoise(x, z, 1.5, seed + 113); cut = true; } }
    // past the core the masses end at a ragged line and sink under the ground (never a smeared lerp slope); a ramp or a
    // landing that runs out into the fade stays, as a causeway over the ground (else it ends in the air at its foot)
    const kept = s >= 1 || s >= 0.55 + 0.25 * valueNoise(x, z, 7, seed + 131);
    L[j * nx + i] = kept ? top : cut ? Math.max(top, buried) : buried;
    rock[j * nx + i] = kept || cut ? 1 : 0;
  } };
  // the collider's own repairs (tools/ledge-landmark.mts --fix-reach): wide notches, foot on reached ground
  for (const rr of o.reachRepairs ?? []) notches.push({ ax: rr.to[0], az: rr.to[2], ay: rr.to[1], bx: rr.from[0], bz: rr.from[2], by: rr.from[1], half: REPAIR_HALF, cheek: REPAIR_CHEEK });
  fillL();

  // ---- REACH REPAIR: every core shelf must be walkable. Flood the rock top (and the hillside where the rock is buried)
  // from the hillside, crossing the cave links mouth to mouth; a core shelf still cut off (the ragged fade can split a
  // level so a notch lands on the wrong piece) gets a REPAIR notch: its landing carried down to the nearest reached
  // shelf or hillside at <= 0.5 grade, cut and filled like any notch.
  // a step a body climbs at this spacing: under ~54 deg plus 5 cm (stricter than a 0.5 m walk grid: the mesher rounds the rock)
  const STEP = Math.max(sx, sz) * 1.35 + 0.05, GRADE = 0.5;
  // the ground where the rock is buried: the landmark's own terrain patch blended into the hill by its weights
  const gp = ledgeLandmarkGround(grid, o.inset ?? 1, 1) as unknown as { heights: number[]; weights: number[] };
  const GR = new Float64Array(n);
  for (let i = 0; i < n; i++) GR[i] = H[i]! + (gp.heights[i]! - H[i]!) * gp.weights[i]!;
  const N2 = nx * nz, GY = new Float32Array(N2);
  for (let c = 0; c < N2; c++) GY[c] = bilinear(GR, grid, x0 + (c % nx) * sx, z0 + Math.floor(c / nx) * sz);
  const yAt = (c: number) => (rock[c] ? L[c]! : GY[c]!);
  const cellOf = (x: number, z: number) => Math.max(0, Math.min(nz - 1, Math.round((z - z0) / sz))) * nx + Math.max(0, Math.min(nx - 1, Math.round((x - x0) / sx)));
  const mouthCells = grid.caves.map((cv) => [cv.floor[0]!, cv.floor[cv.floor.length - 1]!].map((pt) => {
    const out: number[] = [];
    for (let dz = -1; dz <= 1; dz += sz) for (let dx = -1; dx <= 1; dx += sx) { const c = cellOf(pt[0] + dx, pt[2] + dz); if (Math.abs(yAt(c) - pt[1]) < 1.5) out.push(c); }
    return out;
  }));
  const flood = (seeds: number[], seen: Uint8Array, caves: boolean) => {
    const st = seeds.filter((c) => !seen[c]);
    for (const c of st) seen[c] = 1;
    const hit = new Set<number>();
    for (;;) {
      while (st.length) {
        const c = st.pop()!, i = c % nx, y = yAt(c);
        for (const d of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx]) if (d >= 0 && d < N2 && !seen[d] && Math.abs(yAt(d) - y) <= STEP) { seen[d] = 1; st.push(d); }
      }
      if (!caves) return;
      mouthCells.forEach((ends, ci) => {
        if (hit.has(ci)) return;
        const a = ends[0]!.some((q) => seen[q]), b = ends[1]!.some((q) => seen[q]);
        if (a !== b) { hit.add(ci); for (const q of ends[a ? 1 : 0]!) if (!seen[q]) { seen[q] = 1; st.push(q); } }
      });
      if (!st.length) return;
    }
  };
  // one anchor per core shelf: its full cell nearest the centroid (as the solve reports `shelfAnchors`)
  const anchorCells: { c: number; y: number; k: number }[] = [];
  {
    const ax = new Float64Array(ncomp), az = new Float64Array(ncomp), an = new Float64Array(ncomp), bd = new Float64Array(ncomp).fill(Infinity), bi = new Int32Array(ncomp).fill(-1);
    for (let i = 0; i < n; i++) { const k = grid.comp[i]!; if (k < 0 || fringe[k] || W[i]! < 0.999) continue; ax[k] = ax[k]! + (i % cols); az[k] = az[k]! + Math.floor(i / cols); an[k] = an[k]! + 1; }
    for (let i = 0; i < n; i++) { const k = grid.comp[i]!; if (k < 0 || fringe[k] || W[i]! < 0.999) continue; const d = Math.hypot((i % cols) - ax[k]! / an[k]!, Math.floor(i / cols) - az[k]! / an[k]!); if (d < bd[k]!) { bd[k] = d; bi[k] = i; } }
    for (let k = 0; k < ncomp; k++) if (bi[k]! >= 0) { const c = cellOf(x0 + (bi[k]! % cols) * g, z0 + Math.floor(bi[k]! / cols) * g); anchorCells.push({ c, y: L[c]!, k: Kc[bi[k]!]! }); }
  }
  const near = (c: number, r: number, fn: (q: number) => boolean) => {
    const ci = c % nx, cj = Math.floor(c / nx), ri = Math.ceil(r / sx), rj = Math.ceil(r / sz);
    for (let dj = -rj; dj <= rj; dj++) for (let di = -ri; di <= ri; di++) { const i = ci + di, j = cj + dj; if (i >= 0 && j >= 0 && i < nx && j < nz && fn(j * nx + i)) return true; }
    return false;
  };
  const flat = (c: number) => !near(c, 0.6, (q) => Math.abs(yAt(q) - yAt(c)) > 0.35);
  const repairs: LedgeLandmarkVolume["repairs"] = [];
  let unreachable = 0;
  for (let pass = 0; pass < 6; pass++) {
    const seen = new Uint8Array(N2), hill: number[] = [];
    for (let c = 0; c < N2; c++) if (!rock[c]) hill.push(c);
    flood(hill, seen, true);
    const cutOff = anchorCells.filter((a) => !near(a.c, 2, (q) => !!seen[q] && Math.abs(yAt(q) - a.y) < 1.5));
    unreachable = cutOff.length;
    if (!cutOff.length || pass === 5) break;
    let added = 0;
    for (const a of cutOff) {
      // the cut-off piece holding the anchor, then the shortest walkable notch from its top down to reached ground
      const mine = new Uint8Array(N2);
      flood([a.c], mine, false);
      const S: number[] = [], T: number[] = [];
      const ai = a.c % nx, aj = Math.floor(a.c / nx), R = 30;
      for (let j = Math.max(0, aj - Math.ceil(R / sz)); j <= Math.min(nz - 1, aj + Math.ceil(R / sz)); j += 2) for (let i = Math.max(0, ai - Math.ceil(R / sx)); i <= Math.min(nx - 1, ai + Math.ceil(R / sx)); i += 2) {
        const c = j * nx + i;
        if (mine[c]) { if (rock[c] && Math.abs(yAt(c) - a.y) < 0.6 && flat(c)) S.push(c); }
        else if (seen[c] && yAt(c) <= a.y + 0.3 && yAt(c) >= a.y - 2 * h && flat(c)) T.push(c);
      }
      let best: [number, number] | null = null, bdist = Infinity;
      for (const sc of S) for (const tc of T) {
        const d = Math.hypot(((sc % nx) - (tc % nx)) * sx, (Math.floor(sc / nx) - Math.floor(tc / nx)) * sz);
        if (d >= bdist || d < 3 || d < (yAt(sc) - yAt(tc)) / GRADE + 2) continue;
        bdist = d; best = [sc, tc];
      }
      if (!best) continue;
      const P = (c: number): [number, number, number] => [r2(x0 + (c % nx) * sx), r2(yAt(c)), r2(z0 + Math.floor(c / nx) * sz)];
      const hd = P(best[0]), ft = P(best[1]);
      notches.push({ ax: ft[0], az: ft[2], ay: ft[1], bx: hd[0], bz: hd[2], by: hd[1] });
      repairs.push({ level: r2(level(a.k)), from: hd, to: ft });
      added++;
    }
    if (!added) break;
    fillL();
    for (const a of anchorCells) a.y = L[a.c]!;
  }
  const nodes: CsgNode[] = [];
  nodes.push({
    id: "masses", op: "add", shape: "heightfield", position: [0, 0, 0], rotation: [0, 0, 0], size: [r3(spanX), 400, r3(spanZ)], round: 0, blend: 0,
    heightfield: { width: nx, depth: nz, values: encodeHeightfieldValues(L), mode: "floor" },
  } as unknown as CsgNode);

  // keep features off the cave MOUTHS (a boulder in a mouth blocks it)
  const mouths = grid.caves.flatMap((cv) => {
    const fl = cv.floor, out: { x: number; z: number; r: number }[] = [];
    let run = 0;
    for (let k = 0; k < fl.length && run < 10; k++) { out.push({ x: fl[k]![0], z: fl[k]![2], r: cv.radius }); if (k) run += Math.hypot(fl[k]![0] - fl[k - 1]![0], fl[k]![2] - fl[k - 1]![2]); }
    run = 0;
    for (let k = fl.length - 1; k >= 0 && run < 10; k--) { out.push({ x: fl[k]![0], z: fl[k]![2], r: cv.radius }); if (k < fl.length - 1) run += Math.hypot(fl[k]![0] - fl[k + 1]![0], fl[k]![2] - fl[k + 1]![2]); }
    return out;
  });
  const caveClear = (x: number, z: number, pad: number) => mouths.every((m) => Math.hypot(m.x - x, m.z - z) > m.r + pad);
  const rampClear = (x: number, z: number, pad: number) => notches.every((nt) => {
    const dx = nt.bx - nt.ax, dz = nt.bz - nt.az, ll = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - nt.ax) * dx + (z - nt.az) * dz) / ll));
    return Math.hypot(x - nt.ax - dx * t, z - nt.az - dz * t) > RAMP_HALF + CHEEK + RAMP_RUNOUT + pad;
  });
  const local = (x: number, y: number, z: number): [number, number, number] => [r3(x - cx), r3(y), r3(z - cz)];

  // ---- BOULDERS: a few low, wide masses fused into shelves at least ~6 m across
  const cand: number[] = [];
  for (let r = 2; r < rows - 2; r++) for (let c = 2; c < cols - 2; c++) {
    const i = r * cols + c;
    if (!core(i)) continue;
    let ok = true;
    for (let dr = -1; dr <= 1 && ok; dr++) for (let dc = -1; dc <= 1; dc++) { const j = i + dr * cols + dc; if (!core(j) || Kc[j] !== Kc[i]) { ok = false; break; } }
    if (ok) cand.push(i);
  }
  cand.sort((a, b) => hash01(seed + 29, a, 5) - hash01(seed + 29, b, 5));
  const placed: { x: number; z: number }[] = [];
  for (const i of cand) {
    if (placed.length >= o.boulders) break;
    const x = x0 + (i % cols) * g, z = z0 + Math.floor(i / cols) * g;
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 14) || !caveClear(x, z, 6) || !rampClear(x, z, 4)) continue;
    const u = hash01(seed + 31, i, 6), v = hash01(seed + 37, i, 7);
    nodes.push({
      id: `boulder-${placed.length}`, op: "add", shape: "ellipsoid", position: local(x, level(Kc[i]!) + 0.05, z), rotation: [0, r3(Math.PI * u), 0],
      size: [r3(3.4 + 1.4 * u), r3(1.5 + 0.5 * v), r3(2.4 + 0.8 * v)], round: 0, blend: 0.9,
      noise: { amount: 0.35, scale: 1.4, seed: seed + placed.length * 5 + 3, octaves: 3 },
    } as unknown as CsgNode);
    placed.push({ x, z });
  }

  // ---- CAVES: the solve's links, bored through the masses (spheres every ~0.4 r: an even floor), mouths flared
  let caveNodes = 0;
  grid.caves.forEach((cv, ci) => {
    // the bore floor (ellipsoid bottom, 0.9 r under its centre) sits 0.6 m UNDER the solve floor: the solve floor stands
    // ~0.5 m over the shelf at a mouth, and a bore floor above the shelf leaves the riser's first stratum as a lip step
    const r = cv.radius, pts = cv.floor, lift = 0.9 * r - 0.6;
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s]!, b = pts[s + 1]!, len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const m = Math.max(1, Math.ceil(len / (0.4 * r)));
      for (let t = 0; t < m + (s === pts.length - 2 ? 1 : 0); t++) {
        const q = t / m, x = a[0] + (b[0] - a[0]) * q, y = a[1] + (b[1] - a[1]) * q + lift, z = a[2] + (b[2] - a[2]) * q;
        nodes.push({
          id: `cave-${ci}-${caveNodes}`, op: "sub", shape: "ellipsoid", position: local(x, y, z), rotation: [0, 0, 0],
          size: [r3(2 * r), r3(2 * r * 0.9), r3(2 * r)], round: 0, blend: 0,
          noise: { amount: 0.35, scale: 1.8, seed: seed + 41 + ci, octaves: 3 },
        } as unknown as CsgNode);
        caveNodes++;
      }
    }
    if (pts.length < 2) return;
    for (const [e, p] of [[0, 1], [pts.length - 1, pts.length - 2]] as const) {
      const a = pts[e]!, b = pts[p]!, dx = a[0] - b[0], dz = a[2] - b[2], l = Math.hypot(dx, dz) || 1;
      nodes.push({
        id: `mouth-${ci}-${e}`, op: "sub", shape: "ellipsoid", position: local(a[0] + (dx / l) * 0.6 * r, a[1] + 1.15 * r, a[2] + (dz / l) * 0.6 * r), rotation: [0, r3(Math.atan2(dx, dz)), 0],
        size: [r3(2.7 * r), r3(2.3 * r), r3(2.2 * r)], round: 0, blend: 0.6,
        noise: { amount: 0.3, scale: 1.6, seed: seed + 43 + ci, octaves: 3 },
      } as unknown as CsgNode);
      caveNodes++;
    }
  });

  // ---- ramp slabs: where a notch passes a cave mouth, the bore and its flare cut the ramp's floor apart (the solve puts
  // a ramp beside a mouth when no other spot on the border fits). Its floor is laid back AFTER the bores as 1 m steps of
  // a 1 m thick slab (0.3 m risers at the ramp grade; the mesher rounds them), only near the mouths, so the mouth beside
  // it stays open and a bore deep under it is never filled.
  let slabs = 0;
  for (const nt of notches) {
    const len = Math.hypot(nt.bx - nt.ax, nt.bz - nt.az);
    if (len < 1e-6) continue;
    const ux = (nt.bx - nt.ax) / len, uz = (nt.bz - nt.az) / len, yaw = r3(Math.atan2(ux, uz));
    for (let d = 0.5; d < len; d += 1) {
      const x = nt.ax + ux * d, z = nt.az + uz * d, y = nt.ay + ((nt.by - nt.ay) * d) / len;
      const near = grid.caves.some((cv) => cv.floor.some((p) => Math.hypot(p[0] - x, p[2] - z) < cv.radius + RAMP_HALF + 2.5 && p[1] < y + cv.radius));
      if (!near) continue;
      nodes.push({ id: `slab-${slabs++}`, op: "add", shape: "box", position: local(x, y - 0.5, z), rotation: [0, yaw, 0], size: [2 * RAMP_HALF, 1, 1.02], round: 0, blend: 0 } as unknown as CsgNode);
    }
  }

  // ---- tiles: ~32 m columns, y spanning the slab's buried bottom to the highest solid, lattice-aligned
  const TILE = 32, tiles: LedgeLandmarkVolume["tiles"] = [];
  const snapDown = (v: number) => Math.floor(v / f) * f, snapUp = (v: number) => Math.ceil(v / f) * f;
  const extraTop = nodes.filter((nd) => nd.op === "add" && nd.shape !== "heightfield").map((nd) => ({ x: nd.position[0]! + cx, z: nd.position[2]! + cz, y: nd.position[1]! + 4 }));
  for (let tz = 0; tz < spanZ; tz += TILE) for (let tx = 0; tx < spanX; tx += TILE) {
    const ax = x0 + tx, bx = Math.min(x0 + spanX, ax + TILE), az = z0 + tz, bz = Math.min(z0 + spanZ, az + TILE);
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.floor(tz / sz); j <= Math.min(nz - 1, Math.ceil((tz + TILE) / sz)); j++) for (let i = Math.floor(tx / sx); i <= Math.min(nx - 1, Math.ceil((tx + TILE) / sx)); i++) {
      const v = L[j * nx + i]!; lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    for (const cv of grid.caves) for (const p of cv.floor) if (p[0] >= ax - 6 && p[0] <= bx + 6 && p[2] >= az - 6 && p[2] <= bz + 6) lo = Math.min(lo, p[1] - 2);
    for (const e of extraTop) if (e.x >= ax - 6 && e.x <= bx + 6 && e.z >= az - 6 && e.z <= bz + 6) hi = Math.max(hi, e.y);
    let shows = false;
    for (let r = Math.floor((az - z0) / g); r <= Math.min(rows - 1, Math.ceil((bz - z0) / g)) && !shows; r++) for (let c = Math.floor((ax - x0) / g); c <= Math.min(cols - 1, Math.ceil((bx - x0) / g)); c++) if (W[r * cols + c]! > 0.6) { shows = true; break; }
    if (!shows) continue;
    tiles.push({ min: [r3(snapDown(ax - cx)), r3(snapDown(lo - 3)), r3(snapDown(az - cz))], max: [r3(snapUp(bx - cx)), r3(snapUp(hi + 1)), r3(snapUp(bz - cz))] });
  }
  const digest = landmarkDigest(JSON.stringify({ f, nodes, tiles }));
  return {
    origin: [r3(cx), 0, r3(cz)], radius: r2(Math.hypot(spanX, spanZ) / 2), voxel: f, nodes, tiles, digest, notches, unjoinedEnds, repairs,
    report: {
      masses: masses.length, notches: notches.length, unjoined, fringe: fringe.filter(Boolean).length, repairs: repairs.length, unreachable, slabs, boulders: placed.length, pillars: 0, caves: grid.caves.length, caveNodes, fine: [nx, nz],
    },
  };
}

/**
 * The terrain under a landmark: the solved shelves eroded (each cell takes the lowest level within `erode` cells, so
 * a riser's terrain sits at the foot of the rock face), `inset` metres under the rock, dropped under every cave bore,
 * then lightly smoothed. One masked height patch with the solve's own fade, so >= 6 m features by construction.
 */
export function ledgeLandmarkGround(grid: ShelvingGrid, inset: number, riserSlope: number): OperatorPiece {
  const { x0, z0, g, cols, rows, W, T } = grid;
  const n = cols * rows, R = 2;
  const E = new Float64Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let m = Infinity;
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || dr * dr + dc * dc > R * R + 1) continue;
      m = Math.min(m, T[rr * cols + cc]!);
    }
    E[r * cols + c] = m - inset;
  }
  for (const cv of grid.caves) {
    const pad = cv.radius + 3;
    for (let s = 0; s < cv.floor.length - 1; s++) {
      const a = cv.floor[s]!, b = cv.floor[s + 1]!;
      const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - pad - x0) / g)), c1 = Math.min(cols - 1, Math.ceil((Math.max(a[0], b[0]) + pad - x0) / g));
      const q0 = Math.max(0, Math.floor((Math.min(a[2], b[2]) - pad - z0) / g)), q1 = Math.min(rows - 1, Math.ceil((Math.max(a[2], b[2]) + pad - z0) / g));
      const dx = b[0] - a[0], dz = b[2] - a[2], ll = dx * dx + dz * dz || 1;
      for (let r = q0; r <= q1; r++) for (let c = c0; c <= c1; c++) {
        const x = x0 + c * g, z = z0 + r * g;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / ll));
        if (Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t) > pad) continue;
        const i = r * cols + c, y = a[1] + (b[1] - a[1]) * t - 1.5;
        if (y < E[i]!) E[i] = y;
      }
    }
  }
  // a min-preserving smooth: average, but never above the eroded value + 0.3 (the rock must keep covering it)
  const B = blur3(E, cols, rows);
  const heights: number[] = new Array(n), weights: number[] = new Array(n);
  for (let i = 0; i < n; i++) { heights[i] = r2(Math.min(B[i]!, E[i]! + 0.3)); weights[i] = Math.round(W[i]! * 1000) / 1000; }
  return { id: "ground", origin: [x0, z0], size: [(cols - 1) * g, (rows - 1) * g], columns: cols, rows, heights, weights, blend: 2 * g, maxSlope: riserSlope };
}

/** A volume doc for one tile of a landmark (palette and surfaces are the baker's: the world's own). */
export function landmarkTileDoc(v: LedgeLandmarkVolume, tile: number, palette: string[], surface: { floor: number; wall: number; ceiling: number }, tint?: [number, number, number]): VolumeDoc {
  return {
    name: `landmark tile ${tile}`, voxelSize: v.voxel, bounds: v.tiles[tile]!, palette, surface, nodes: v.nodes, paint: [], ...(tint ? { tint } : {}),
  } as unknown as VolumeDoc;
}
