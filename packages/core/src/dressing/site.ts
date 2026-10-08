/**
 * Outdoor site socket maps: a POI's camps, yards, cave mouths and shores measured into the same socket-map format a
 * building uses, so a dresser places props there by NAME (`dress check` / `dress apply`, `props menu --map --room`).
 *
 * One LEVEL per area (its room id is the area id), on its own grid round the area, in WORLD coordinates. Cells:
 *   'o' open ground a prop may stand on       'x' kept clear: walking routes (+ margin), doorways, portal passages,
 *   '#' built / too steep (a wall's far side)      quest spots and creature-pack clearings (walkable, walk-over props only)
 *   'H' fire clearance round a hearth         'E' where a path enters the area (the route check starts there)
 *   ' ' outside the area, standing water
 * Each level carries a `ground` raster so a floor prop stands on the terrain under it. Walls are the faces of built
 * things (tents, buildings, rocks: their footprint sides) and straight runs of '#' (a cliff or bank edge). Anchors are
 * named pitches by intent (hearth seats, door sides, cave flanks, path sides, clearing edges, water edges), each kept
 * only when its whole disc is open ground. Pure: the caller samples the ground (tools/site-sockets.mts boots the scene).
 */
import { GROUND_STEP, GROUND_ZERO, type SocketAnchor, type SocketLevel, type SocketMap, type SocketWall } from "./schema.js";

type V2 = [number, number];
export interface SiteArea { id: string; role: string; centre: V2; radius: number }
/** A point the owner names. `facing` points OUT of a door or cave (toward where a visitor stands). */
export interface SiteAnchorIn { id: string; kind: "hearth" | "door" | "cave-mouth" | "water-edge" | string; at: V2; facing?: V2; radius?: number }
/** Kept clear: a route (polyline + width) or a disc (doorway, portal, quest spot, pack clearing). */
export interface SiteKeep { id: string; why: string; points: V2[]; width?: number; radius?: number }
/** Something built standing on the ground: an oriented footprint rectangle (half extents along its local X/Z). */
export interface SiteBlocker { id: string; centre: V2; half: V2; yaw: number }
export interface SiteSampler {
  ground(x: number, z: number): number | null;
  /** Highest solid surface (raycast from above); above ground + 0.35 = something built. */
  top?(x: number, z: number): number | null;
  water?(x: number, z: number): number | null;
}
export interface SiteInput { id: string; source?: string; areas: SiteArea[]; anchors: SiteAnchorIn[]; keep: SiteKeep[]; blockers: SiteBlocker[]; step?: number }
export interface SiteReport { area: string; level: number; open: number; refused: Record<string, number>; anchors: Record<string, number> }

const PATH_MARGIN = 0.6, BLOCK_MARGIN = 0.3, MAX_GRADE = 0.45, BUILT = 0.35;
const segD = (p: V2, a: V2, b: V2): number => {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
};
const lineD = (p: V2, pts: V2[]): number => (pts.length === 1 ? Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]) : Math.min(...pts.slice(1).map((b, i) => segD(p, pts[i]!, b))));
const inRect = (p: V2, b: SiteBlocker, m: number): boolean => {
  const dx = p[0] - b.centre[0], dz = p[1] - b.centre[1], c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return Math.abs(dx * c - dz * s) <= b.half[0] + m && Math.abs(dx * s + dz * c) <= b.half[1] + m;
};
const yawDeg = (d: V2): number => +((Math.atan2(d[0], d[1]) * 180) / Math.PI).toFixed(1);
const norm = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

export function buildSiteSocketMap(input: SiteInput, sample: SiteSampler): { map: SocketMap; report: SiteReport[] } {
  const step = input.step ?? 0.25;
  const levels: SocketLevel[] = [], anchors: SocketAnchor[] = [], report: SiteReport[] = [];
  input.areas.forEach((area, li) => {
    const R = area.radius, ox = area.centre[0] - R, oz = area.centre[1] - R, C = Math.ceil((2 * R) / step), N = C * C;
    const cell = new Array<string>(N).fill(" "), gy = new Float64Array(N).fill(NaN), blockerCell = new Uint8Array(N);
    const refused: Record<string, number> = {}, no = (why: string): void => void (refused[why] = (refused[why] ?? 0) + 1);
    const at = (k: number): V2 => [ox + ((k % C) + 0.5) * step, oz + (Math.floor(k / C) + 0.5) * step];
    const hearths = input.anchors.filter((a) => a.kind === "hearth");
    for (let k = 0; k < N; k++) {
      const p = at(k);
      if (Math.hypot(p[0] - area.centre[0], p[1] - area.centre[1]) > R) continue;
      const g = sample.ground(p[0], p[1]);
      if (g === null) { no("no ground"); continue; }
      gy[k] = g;
      const w = sample.water?.(p[0], p[1]);
      if (w != null && w > g - 0.05) { no("standing water"); continue; }
      if (input.blockers.some((b) => inRect(p, b, BLOCK_MARGIN))) { cell[k] = "#"; blockerCell[k] = 1; no("built footprint"); continue; }
      const top = sample.top?.(p[0], p[1]);
      if (top != null && top > g + BUILT) { cell[k] = "#"; no("something built stands here"); continue; }
      let lo = g, hi = g;
      for (const [dx, dz] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]] as const) { const h = sample.ground(p[0] + dx, p[1] + dz); if (h !== null) { lo = Math.min(lo, h); hi = Math.max(hi, h); } }
      if (hi - lo > MAX_GRADE) { cell[k] = "#"; no("slope"); continue; }
      const keep = input.keep.find((q) => lineD(p, q.points) < (q.radius ?? (q.width ?? 0) / 2 + PATH_MARGIN));
      if (keep) { cell[k] = "x"; no(keep.why); continue; }
      const fire = hearths.find((h) => Math.hypot(p[0] - h.at[0], p[1] - h.at[1]) < (h.radius ?? 2) + 1.2);
      cell[k] = fire ? "H" : "o";
    }
    // where a route enters the area: its 'x' cells on the rim are the way in; with none, the open rim is
    const rim = (k: number): boolean => Math.hypot(at(k)[0] - area.centre[0], at(k)[1] - area.centre[1]) > R - 0.6;
    let entries = 0;
    for (let k = 0; k < N; k++) if (cell[k] === "x" && rim(k) && input.keep.some((q) => q.width && lineD(at(k), q.points) < q.width / 2 + PATH_MARGIN)) { cell[k] = "E"; entries++; }
    if (!entries) for (let k = 0; k < N; k++) if (cell[k] === "o" && rim(k)) cell[k] = "E";
    const floorCells: number[] = [];
    for (let k = 0; k < N; k++) if (cell[k] !== " " && cell[k] !== "#" && Number.isFinite(gy[k])) floorCells.push(k);
    const ys = floorCells.map((k) => gy[k]!).sort((a, b) => a - b);
    const floorY = ys.length ? ys[Math.floor(ys.length / 2)]! : 0;
    for (const k of floorCells) {
      const d = Math.round((gy[k]! - floorY) / GROUND_STEP) + GROUND_ZERO;
      if (d < 0 || d > 35) { cell[k] = "#"; no("too far above/below the area's floor"); }
    }
    const open = cell.filter((c) => c === "o").length;
    const row = (f: (k: number) => string): string[] => Array.from({ length: C }, (_, r) => Array.from({ length: C }, (_, c) => f(r * C + c)).join(""));
    const walkable = (k: number): boolean => cell[k] !== " " && cell[k] !== "#";
    const walls: SocketWall[] = [];
    const openAt = (x: number, z: number): boolean => { const c = Math.floor((x - ox) / step), r = Math.floor((z - oz) / step); return c >= 0 && r >= 0 && c < C && r < C && cell[r * C + c] === "o"; };
    const addWall = (id: string, mid: V2, n: V2, len: number): void => {
      const side: V2 = [n[1], -n[0]], a: V2 = [mid[0] + (side[0] * len) / 2, mid[1] + (side[1] * len) / 2], b: V2 = [mid[0] - (side[0] * len) / 2, mid[1] - (side[1] * len) / 2];
      const spans: [number, number][] = [];
      let s = -1;
      for (let t = 0; t <= len + 1e-6; t += step) {
        const x = a[0] + ((b[0] - a[0]) * t) / len + n[0] * 0.3, z = a[1] + ((b[1] - a[1]) * t) / len + n[1] * 0.3;
        if (openAt(x, z)) { if (s < 0) s = t; } else if (s >= 0) { if (t - step - s >= 0.5) spans.push([+s.toFixed(2), +(t - step).toFixed(2)]); s = -1; }
      }
      if (s >= 0 && len - s >= 0.5) spans.push([+s.toFixed(2), +len.toFixed(2)]);
      if (spans.length) walls.push({ id, room: area.id, a: [+a[0].toFixed(2), +a[1].toFixed(2)], b: [+b[0].toFixed(2), +b[1].toFixed(2)], normal: [+n[0].toFixed(4), +n[1].toFixed(4)], spans, height: 4 });
    };
    // faces of built things (back a prop against a tent or a wall)
    for (const b of input.blockers) {
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw), ux: V2 = [c, -s], uz: V2 = [s, c];
      for (const [tag, n, half, along] of [["N", uz, b.half[1], b.half[0]], ["S", [-uz[0], -uz[1]] as V2, b.half[1], b.half[0]], ["E", ux, b.half[0], b.half[1]], ["W", [-ux[0], -ux[1]] as V2, b.half[0], b.half[1]]] as const) {
        const mid: V2 = [b.centre[0] + n[0] * (half + BLOCK_MARGIN), b.centre[1] + n[1] * (half + BLOCK_MARGIN)];
        if (Math.hypot(mid[0] - area.centre[0], mid[1] - area.centre[1]) > R + along) continue;
        addWall(`${area.id}.${b.id}.${tag}`, mid, n as V2, 2 * along);
      }
    }
    // straight runs of '#' that is not a footprint (a cliff, a bank, a raycast-built thing): axis-aligned faces
    for (const [tag, dc, dr] of [["n", 0, -1], ["s", 0, 1], ["w", -1, 0], ["e", 1, 0]] as const) {
      let n = 0;
      for (let i = 0; i < C; i++) {
        let run = -1;
        for (let j = 0; j <= C; j++) {
          const [c, r] = dr ? [j, i] : [i, j], k = r * C + c, c2 = c + dc, r2 = r + dr;
          const ok = j < C && cell[k] === "o" && c2 >= 0 && r2 >= 0 && c2 < C && r2 < C && cell[r2 * C + c2] === "#" && !blockerCell[r2 * C + c2];
          if (ok && run < 0) run = j;
          if (!ok && run >= 0) {
            if ((j - run) * step >= 1.5) {
              const len = (j - run) * step, m = (run + j) / 2;
              const mid: V2 = dr ? [ox + m * step, oz + (i + (dr > 0 ? 1 : 0)) * step] : [ox + (i + (dc > 0 ? 1 : 0)) * step, oz + m * step];
              addWall(`${area.id}.edge-${tag}${++n}`, mid, [-dc, -dr], len);
            }
            run = -1;
          }
        }
      }
    }
    // named pitches, kept only when their whole disc is open ground
    const kinds: Record<string, number> = {};
    const pitch = (kind: string, p: V2, face: V2, r: number): void => {
      for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * Math.PI * 2, q: V2 = i === 8 ? p : [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r];
        if (!openAt(q[0], q[1])) return;
      }
      if (anchors.some((x) => x.level === li && Math.hypot(x.position[0] - p[0], x.position[2] - p[1]) < r + 0.8)) return;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      const y = sample.ground(p[0], p[1]) ?? floorY;
      anchors.push({ id: `${area.id}/${kind}-${kinds[kind]}`, kind, level: li, position: [+p[0].toFixed(2), +y.toFixed(2), +p[1].toFixed(2)], yaw: yawDeg(face), mount: "floor", outdoor: true, size: [+(r * 2).toFixed(1), 3, +(r * 2).toFixed(1)] });
    };
    const inArea = (p: V2, pad = 0): boolean => Math.hypot(p[0] - area.centre[0], p[1] - area.centre[1]) <= R + pad;
    for (const a of input.anchors) {
      if (!inArea(a.at, 2)) continue;
      // the owner's point itself, so `near: "<kind>"` finds it
      anchors.push({ id: `${area.id}/${a.id}`, kind: a.kind, level: li, position: [a.at[0], sample.ground(a.at[0], a.at[1]) ?? floorY, a.at[1]], yaw: a.facing ? yawDeg(a.facing) : 0, mount: "floor", outdoor: true });
      const f = norm(a.facing ?? [area.centre[0] - a.at[0], area.centre[1] - a.at[1]]), sd: V2 = [-f[1], f[0]];
      if (a.kind === "hearth") {
        const rr = (a.radius ?? 2) + 2.0;
        for (let i = 0; i < 8; i++) { const t = (i / 8) * Math.PI * 2, d: V2 = [Math.sin(t), Math.cos(t)]; pitch("hearth-seat", [a.at[0] + d[0] * rr, a.at[1] + d[1] * rr], [-d[0], -d[1]], 0.7); }
        pitch("spit-side", [a.at[0] + f[0] * rr, a.at[1] + f[1] * rr], [-f[0], -f[1]], 0.9);
        pitch("firewood-side", [a.at[0] - f[0] * (rr + 1.2), a.at[1] - f[1] * (rr + 1.2)], f, 1.2);
      } else if (a.kind === "door") {
        for (const s of [1, -1]) for (const out of [1.5, 3]) pitch(s > 0 ? "door-left" : "door-right", [a.at[0] + f[0] * out + sd[0] * 2.6 * s, a.at[1] + f[1] * out + sd[1] * 2.6 * s], f, 0.7);
      } else if (a.kind === "cave-mouth") {
        pitch("cave-inside", [a.at[0] - f[0] * 3, a.at[1] - f[1] * 3], f, 0.9);
        for (const s of [1, -1]) pitch("cave-flank", [a.at[0] + f[0] * 1.5 + sd[0] * 4 * s, a.at[1] + f[1] * 1.5 + sd[1] * 4 * s], f, 0.9);
      }
    }
    for (const q of input.keep) {
      if (!q.width || q.points.length < 2) continue;
      let acc = 0;
      for (let i = 0; i + 1 < q.points.length; i++) {
        const a = q.points[i]!, b = q.points[i + 1]!, l = Math.hypot(b[0] - a[0], b[1] - a[1]), u = norm([b[0] - a[0], b[1] - a[1]]), n: V2 = [-u[1], u[0]];
        for (let t = (10 - acc) % 10; t < l; t += 10) for (const s of [1, -1]) {
          const off = q.width / 2 + PATH_MARGIN + 1.2, p: V2 = [a[0] + u[0] * t + n[0] * off * s, a[1] + u[1] * t + n[1] * off * s];
          if (inArea(p)) pitch("path-side", p, [-n[0] * s, -n[1] * s], 0.8);
        }
        acc = (acc + l) % 10;
      }
    }
    const ringN = Math.max(6, Math.round((2 * Math.PI * (R - 2)) / 8));
    for (let i = 0; i < ringN; i++) { const t = (i / ringN) * Math.PI * 2, d: V2 = [Math.sin(t), Math.cos(t)]; pitch("edge", [area.centre[0] + d[0] * (R - 2), area.centre[1] + d[1] * (R - 2)], [-d[0], -d[1]], 1.0); }
    // water edges: open ground beside standing water, every ~8 m
    if (sample.water) for (let k = 0; k < N; k += 4) {
      if (cell[k] !== "o") continue;
      const p = at(k);
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]] as V2[]) {
        const w = sample.water(p[0] + d[0] * 1.5, p[1] + d[1] * 1.5), g = sample.ground(p[0] + d[0] * 1.5, p[1] + d[1] * 1.5);
        if (w != null && g != null && w > g - 0.05 && !anchors.some((x) => x.kind === "water-edge" && x.level === li && Math.hypot(x.position[0] - p[0], x.position[2] - p[1]) < 8)) { pitch("water-edge", p, d, 0.7); break; }
      }
    }
    levels.push({
      level: li, floorY: +floorY.toFixed(3), origin: [ox, oz], step, columns: C, rows: C,
      cells: row((k) => cell[k]!),
      head: row((k) => (walkable(k) ? "z" : ".")),
      room: row((k) => (walkable(k) ? "0" : ".")),
      ground: row((k) => (walkable(k) && Number.isFinite(gy[k]) ? Math.max(0, Math.min(35, Math.round((gy[k]! - floorY) / GROUND_STEP) + GROUND_ZERO)).toString(36) : ".")),
      rooms: [{ id: area.id, index: 0, area: +(open * step * step).toFixed(1), centre: area.centre, bbox: [ox, ox + C * step, oz, oz + C * step], minHead: 8.75, maxHead: 8.75 }],
      walls, paths: [],
    });
    report.push({ area: area.id, level: li, open: +(open * step * step).toFixed(1), refused, anchors: kinds });
  });
  return { map: { id: input.id, source: { model: input.source ?? "", sha256: "" }, levels, anchors }, report };
}
