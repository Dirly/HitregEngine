/**
 * _upstairs — the R80 clear-upstairs measure (k-kit2, Derek 2026-11-03 on Bell Strand: "the fireplace is in the way, the
 * walkway up top is very very tight, if that was your house you couldn't even have room up there"), on an EXPORTED model.
 *
 * For every upper floor a stair reaches (a `stair-head` marker, its y = the floor), on a 0.1 m plan raster:
 *   room     the floor's rooms: flood from the stair head through the slice 1.6 m over the floor, inside the exterior
 *            envelope (the pixels an outside flood of the 2.6 m slice never reaches: exterior walls are continuous over
 *            door and window heads, so a balcony door cannot leak the room outside); `gross` = the room plus the pockets
 *            it surrounds (the flue column, a partition's core), never an exterior wall's cavity.
 *   clear    room pixels with floor under them (an up-facing face at the floor +-0.12 m: a stair hole has none) and no
 *            triangle crossing them at 0.3 / 0.9 / 1.6 m over the floor (flue, rails, posts, walls), connected to the stair
 *            head. `share` = clear / gross.
 *   walk     the distance field of the clear pixels; the widest path from the stair head to every 1.6 m tile that holds a
 *            1.2 m disc of clear floor (a place a bed or a person fits); the tile's walk = twice the path's narrowest
 *            half-width. `walk` = the worst tile's: the narrowest squeeze between the stair head and any room.
 * R80 fails a floor with walk < 1.2 m or share < 0.60.
 */
import type { glbTriangles } from "./dress-sockets.mts";

type Soup = ReturnType<typeof glbTriangles>;
export type UpMarker = { kind: string; position: number[]; yaw?: number; size?: number[]; level?: number };
export type UpFloor = { level: number; y: number; gross: number; clear: number; share: number; walk: number; worst: [number, number] | null; tiles: number };

export const R80_WALK = 1.2;
export const R80_SHARE = 0.6;
const PX = 0.1;

/** Segments where the plane y = Y cuts the soup's triangles: [x0, z0, x1, z1][]. */
function slice(soup: Soup, Y: number): number[][] {
  const p = soup.pos, n = p.length / 9, out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 9, pts: number[][] = [];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
      const ya = p[o + a * 3 + 1]! - Y, yb = p[o + b * 3 + 1]! - Y;
      if ((ya < 0) === (yb < 0) || ya === yb) continue;
      const t = ya / (ya - yb);
      pts.push([p[o + a * 3]! + t * (p[o + b * 3]! - p[o + a * 3]!), p[o + a * 3 + 2]! + t * (p[o + b * 3 + 2]! - p[o + a * 3 + 2]!)]);
    }
    if (pts.length >= 2) out.push([pts[0]![0]!, pts[0]![1]!, pts[1]![0]!, pts[1]![1]!]);
  }
  return out;
}

export function upstairsFloors(soup: Soup, markers: UpMarker[], dump?: (rows: string[]) => void): UpFloor[] {
  const heads = markers.filter((m) => m.kind === "stair-head");
  if (!heads.length) return [];
  const p = soup.pos;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]!); x1 = Math.max(x1, p[i]!); z0 = Math.min(z0, p[i + 2]!); z1 = Math.max(z1, p[i + 2]!); }
  x0 -= 0.5; z0 -= 0.5; x1 += 0.5; z1 += 0.5;
  const W = Math.ceil((x1 - x0) / PX), H = Math.ceil((z1 - z0) / PX), N = W * H;
  const ix = (x: number) => Math.floor((x - x0) / PX), iz = (z: number) => Math.floor((z - z0) / PX);
  const cx = (i: number) => x0 + (i + 0.5) * PX, cz = (j: number) => z0 + (j + 0.5) * PX;
  const raster = (segs: number[][], into: Uint8Array) => {
    for (const [ax, az, bx, bz] of segs) {
      const L = Math.hypot(bx! - ax!, bz! - az!), k = Math.max(1, Math.ceil(L / 0.03));
      for (let s = 0; s <= k; s++) { const t = s / k, i = ix(ax! + t * (bx! - ax!)), j = iz(az! + t * (bz! - az!)); if (i >= 0 && j >= 0 && i < W && j < H) into[j * W + i] = 1; }
    }
  };
  const flood = (seeds: number[], pass: (q: number) => boolean): Uint8Array => {
    const seen = new Uint8Array(N), st: number[] = [];
    for (const s of seeds) if (pass(s) && !seen[s]) { seen[s] = 1; st.push(s); }
    while (st.length) {
      const q = st.pop()!, i = q % W, j = (q - i) / W;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const r = b * W + a; if (!seen[r] && pass(r)) { seen[r] = 1; st.push(r); }
      }
    }
    return seen;
  };
  const border: number[] = [];
  for (let i = 0; i < W; i++) border.push(i, (H - 1) * W + i);
  for (let j = 0; j < H; j++) border.push(j * W, j * W + W - 1);

  const levels = new Map<number, UpMarker[]>();
  for (const h of heads) { const y = Math.round(h.position[1]! * 100) / 100; levels.set(y, [...(levels.get(y) ?? []), h]); }
  const out: UpFloor[] = [];
  for (const [y, hs] of [...levels].sort((a, b) => a[0] - b[0])) {
    const shell = new Uint8Array(N); raster(slice(soup, y + 2.6), shell);
    const outside = flood(border, (q) => !shell[q]);
    const wall16 = new Uint8Array(N); raster(slice(soup, y + 1.6), wall16);
    const obst = new Uint8Array(N); for (const h of [0.3, 0.9, 1.6]) raster(slice(soup, y + h), obst);
    // floor: up-facing faces at the floor height
    const floor = new Uint8Array(N);
    for (let t = 0; t < p.length / 9; t++) {
      const o = t * 9, ys = [p[o + 1]!, p[o + 4]!, p[o + 7]!];
      if (ys.some((v) => Math.abs(v - y) > 0.12)) continue;
      const ax = p[o]!, az = p[o + 2]!, bx = p[o + 3]!, bz = p[o + 5]!, qx = p[o + 6]!, qz = p[o + 8]!;
      const ny = (bz - az) * (qx - ax) - (bx - ax) * (qz - az);          // y of (b-a) x (c-a)
      if (Math.abs(ny) < 1e-9) continue;
      for (let j = Math.max(0, iz(Math.min(az, bz, qz))); j <= Math.min(H - 1, iz(Math.max(az, bz, qz))); j++)
        for (let i = Math.max(0, ix(Math.min(ax, bx, qx))); i <= Math.min(W - 1, ix(Math.max(ax, bx, qx))); i++) {
          const px = cx(i), pz = cz(j);
          const d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax), d2 = (qx - bx) * (pz - bz) - (qz - bz) * (px - bx), d3 = (ax - qx) * (pz - qz) - (az - qz) * (px - qx);
          if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) floor[j * W + i] = 1;
        }
    }
    // stair-head seeds: the marker's rectangle (size x across, z along, turned by yaw), else its centre pixel
    const seedsOf = (pass: (q: number) => boolean): number[] => {
      const s: number[] = [];
      for (const h of hs) {
        const [hx, , hz] = h.position as [number, number, number], sx = (h.size?.[0] ?? 1) / 2, sz = (h.size?.[2] ?? 1) / 2, r = ((h.yaw ?? 0) * Math.PI) / 180;
        const c = Math.cos(r), sn = Math.sin(r);
        for (let j = iz(hz - 2); j <= iz(hz + 2); j++) for (let i = ix(hx - 2); i <= ix(hx + 2); i++) {
          if (i < 0 || j < 0 || i >= W || j >= H) continue;
          const dx = cx(i) - hx, dz = cz(j) - hz, lx = c * dx - sn * dz, lz = sn * dx + c * dz;
          if (Math.abs(lx) <= sx && Math.abs(lz) <= sz && pass(j * W + i)) s.push(j * W + i);
        }
      }
      return s;
    };
    const room = flood(seedsOf((q) => !outside[q] && !wall16[q]), (q) => !outside[q] && !wall16[q]);
    const notRoom = flood(border, (q) => !room[q]);
    let gross = 0; for (let q = 0; q < N; q++) if (!notRoom[q]) gross++;
    const isClear = (q: number) => !!room[q] && !!floor[q] && !obst[q];
    const clear = flood(seedsOf(isClear), isClear);
    let nClear = 0; for (let q = 0; q < N; q++) if (clear[q]) nClear++;
    // distance field (capped 1.0 m) to the nearest pixel that is not clear
    const R = 10, d = new Float32Array(N);
    for (let q = 0; q < N; q++) {
      if (!clear[q]) continue;
      const i = q % W, j = (q - i) / W; let best = R * PX;
      for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
        const r = Math.hypot(a, b) * PX; if (r >= best) continue;
        const u = i + a, v = j + b; if (u < 0 || v < 0 || u >= W || v >= H || !clear[v * W + u]) best = r;
      }
      d[q] = best;
    }
    // widest path from the head (max-min), bucket queue on 0.1 m steps of d
    const B = new Float32Array(N).fill(-1), buckets: number[][] = Array.from({ length: R + 2 }, () => []);
    const bk = (v: number) => Math.min(R + 1, Math.max(0, Math.round(v / PX)));
    for (const s of seedsOf(isClear)) { if (clear[s] && d[s]! > B[s]!) { B[s] = d[s]!; buckets[bk(d[s]!)]!.push(s); } }
    for (let k = R + 1; k >= 0; k--) {
      const bq = buckets[k]!;
      while (bq.length) {
        const q = bq.pop()!, i = q % W, j = (q - i) / W, bv = B[q]!;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= W || b >= H) continue;
          const r = b * W + a; if (!clear[r]) continue;
          const nv = Math.min(bv, d[r]!); if (nv > B[r]! + 1e-6) { B[r] = nv; buckets[bk(nv)]!.push(r); }
        }
      }
    }
    // rooms: 1.6 m tiles over the gross plan that hold a 1.2 m disc of clear floor
    let walk = Infinity, worst: [number, number] | null = null, tiles = 0;
    const T = 16;
    for (let tj = 0; tj < H; tj += T) for (let ti = 0; ti < W; ti += T) {
      let md = 0, mb = 0, at: [number, number] = [0, 0];
      for (let j = tj; j < Math.min(H, tj + T); j++) for (let i = ti; i < Math.min(W, ti + T); i++) {
        const q = j * W + i; if (!clear[q]) continue;
        md = Math.max(md, d[q]!); if (B[q]! > mb) { mb = B[q]!; at = [cx(i), cz(j)]; }
      }
      if (md < R80_WALK / 2 - 1e-6) continue;
      tiles++;
      // the path squeezes before the tile (mb under the tile's own widest disc): that squeeze; else the tile's disc
      const w = mb < md - 0.05 ? 2 * mb : 2 * R * PX;
      if (w < walk) { walk = w; worst = at; }
    }
    if (dump) {
      const rows: string[] = [];
      for (let j = 0; j < H; j += 2) { let r = ""; for (let i = 0; i < W; i++) { const q = j * W + i; r += clear[q] ? (B[q]! < 0.6 ? "-" : ".") : room[q] ? (floor[q] ? "#" : " ") : notRoom[q] ? (outside[q] ? " " : "~") : "o"; } rows.push(r); }
      dump(rows);
    }
    const level = hs[0]!.level ?? Math.round(y / 3.2);
    out.push({ level, y, gross: gross * PX * PX, clear: nClear * PX * PX, share: gross ? nClear / gross : 0, walk: Number.isFinite(walk) ? walk : 0, worst, tiles });
  }
  return out;
}

/** R80 findings for one model: a tight walk or a cluttered floor fails. */
export function upstairsFindings(floors: UpFloor[]): string[] {
  const f: string[] = [];
  for (const u of floors) {
    if (u.walk < R80_WALK - 1e-6) f.push(`R80 storey ${u.level} (floor ${u.y.toFixed(1)} m): the walk from the stair head narrows to ${u.walk.toFixed(2)} m (< ${R80_WALK} m)${u.worst ? ` reaching (${u.worst[0].toFixed(1)}, ${u.worst[1].toFixed(1)})` : ""}`);
    if (u.share < R80_SHARE - 1e-6) f.push(`R80 storey ${u.level} (floor ${u.y.toFixed(1)} m): only ${(u.share * 100).toFixed(0)} % of the upper floor is clear (${u.clear.toFixed(1)} of ${u.gross.toFixed(1)} m2; < ${R80_SHARE * 100} %)`);
  }
  return f;
}
