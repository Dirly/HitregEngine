/**
 * portal-cover --scene <id> [--project <p>] [--portal <id>[,<id>]] [--fit] [--profile] [--quiet]
 * portal-cover --scene <id> --undo <reports/portal-cover/<scene>.fit-inverse.<t>.json>      takes a fit back
 *
 * Does each walk-through portal (the `portal` builtin, mode "trigger") actually cover its entrance?
 *
 * The scene is booted the way the server sees it (PortalHarness: HeadlessWorld colliders + the voxel ground streamed
 * around the portal), and every measurement is a ray against SOLID_WORLD (WORLD | TERRAIN: rock, masonry, floors).
 * In the portal's own frame (local z = the way through, y up):
 *
 *  1. OPENING. At cross-sections every 0.25 m along the passage (4 m each side of the box), from the passage centre:
 *     a ray down (floor) and up (ceiling, capped at 14 m), rows of rays left/right every 0.2 m of height (the width at
 *     each height), and a 5-degree fan (the outline). A section whose sides miss within 30 m below 4 m is OPEN (the
 *     plane stands outside the mouth). The narrowest closed section is the one the player must squeeze through.
 *  2. TRIGGER. A body (the player capsule: 0.4 m radius, centre 0.9 m over its feet, a jump lifts it ~2 m more) must
 *     not be able to cross the passage without its centre entering the box. Passes when, at some closed section inside
 *     the box's depth, every point the body centre can occupy lies inside the box's width x height.
 *  3. VEIL. From viewpoints on the approach side (eye height and a third-person camera height, 2.5-9 m out), a grid
 *     on the veil's plane: a GAP is a visible point of the opening outside the veil; a PROTRUSION is a visible point of
 *     the veil more than 0.15 m outside the opening with rock within 1.5 m behind it (showing over rock). Pass = no gap larger
 *     than 0.05 m^2, no protrusion.
 *
 * --fit: the box is resized to the narrowest closed section near the anchor (its full walkable width and the body's
 * reach, 0.3 m into the rock all round) and the veil to that section's whole visible opening plus 0.3 m (the rock clips
 * it), choosing among the sections inside the box the one whose veil has no gap and no protrusion. Both are written to
 * <project>/authoring/portal-veils.json (so tools/portal-veil.mts re-applies them after a rebuild) and to the scene as
 * ONE applyOps batch, the inverse saved under <project>/reports/portal-cover/; then the check runs again.
 *
 * Report: <project>/reports/portal-cover/<scene>.json ({ passed, portals: [...] }); exit 1 when any portal fails.
 * The approach side is the portal's `returnAnchor` (an entering portal) or the nearest `instance-entry` anchor (a
 * return portal). Limits: render-only meshes without a collider are invisible to it; it does not look from the far side.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { applyOps, ComponentRegistry, registerChunkComponents, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";
import { loadContent, playgroundRoots, PortalHarness } from "../../../packages/server/src/index.ts";
import { portalDigest, portalVeilOps, readStated, statedFileOf, triggerOf, veilOf, walkThroughPortals, type StatedFile, type V3 } from "./_portal-veil-ops.mts";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(n);
const sceneId = arg("--scene");
if (!sceneId) { console.error("usage: portal-cover --scene <id> [--project <p>] [--portal <id>[,<id>]] [--fit] [--quiet]"); process.exit(2); }
const project = arg("--project") ?? fs.readdirSync(path.join(PG, "projects")).find((p) => fs.existsSync(path.join(PG, "projects", p, "assets", "scenes", `${sceneId}.scene.json`)));
if (!project) { console.error(`portal-cover: no project holds scenes/${sceneId}.scene.json`); process.exit(2); }
const sceneFile = path.join(PG, "projects", project, "assets", "scenes", `${sceneId}.scene.json`);
const statedFile = statedFileOf(PG, project);
const reportDir = path.join(PG, "projects", project, "reports", "portal-cover");
const only = arg("--portal")?.split(",").filter(Boolean);
const quiet = flag("--quiet");
const log = (s: string) => { if (!quiet) console.log(s); };

// ---- the body and the tolerances -------------------------------------------------------------------------------------
const BODY_R = 0.4, BODY_HALF = 0.9, JUMP_RISE = 2.0;
const CAP = 14, SIDE_MAX = 30, ROW = 0.2, SECTION_STEP = 0.25, SCAN = 4;
const WALK_BAND = 4; // sides must close below this height for a section to count as inside the passage
const GRID = 0.15, PROTRUDE = 0.15, GAP_AREA = 0.05;
const MASK = (1 << 0) | (1 << 1); // SOLID_WORLD: WORLD | TERRAIN
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- boot the world the server sees ----------------------------------------------------------------------------------
let content = loadContent(playgroundRoots(PG));
const docNow = (): SceneDoc => JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
let doc = docNow();
let portals = walkThroughPortals(doc).filter(([id]) => !only || only.includes(id));
if (only) for (const id of only) if (!portals.some(([p]) => p === id)) { console.error(`portal-cover: ${id} is not a walk-through portal in ${sceneId}`); process.exit(2); }
if (!portals.length) { log(`portal-cover: no walk-through portal in ${sceneId}`); writeReport([]); process.exit(0); }

interface Row { y: number; L: number; R: number; openL: boolean; openR: boolean }
interface Section { s: number; floor: number; ceil: number | null; rows: Row[]; fan: [number, number][]; closed: boolean; why?: string }

type H = Awaited<ReturnType<typeof PortalHarness.start>>;
let h!: H;
async function boot(): Promise<void> {
  content = loadContent(playgroundRoots(PG)); // scenes are read lazily: a fresh load sees the file as written
  // the body starts beside the first portal (its ground is made around it) and is never stepped: no script runs
  const first = poseOf(portals[0]![0]);
  h = await PortalHarness.start({ content, scene: sceneId!, at: [first.pos.x, first.pos.y + 40, first.pos.z], projectScripts: false });
}

function poseOf(id: string): { pos: THREE.Vector3; quat: THREE.Quaternion } {
  // composed up the parent chain of the authored doc (before the world exists) or the live object (after)
  const o = h?.world.objects.get(id);
  if (o) { o.updateWorldMatrix(true, false); const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); o.matrixWorld.decompose(p, q, s); return { pos: p, quat: q }; }
  const chain: string[] = [];
  for (let k: string | null | undefined = id; k; k = doc.entities[k]?.parent) chain.unshift(k);
  const m = new THREE.Matrix4();
  for (const k of chain) {
    const t = (doc.entities[k]!.components["transform"] ?? {}) as { position?: number[]; rotation?: number[]; scale?: number[] };
    m.multiply(new THREE.Matrix4().compose(new THREE.Vector3(...((t.position ?? [0, 0, 0]) as V3)), new THREE.Quaternion(...((t.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])), new THREE.Vector3(...((t.scale ?? [1, 1, 1]) as V3))));
  }
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { pos: p, quat: q };
}

class Frame {
  constructor(readonly pos: THREE.Vector3, readonly quat: THREE.Quaternion) {}
  w(l: V3): V3 { const v = new THREE.Vector3(...l).applyQuaternion(this.quat).add(this.pos); return [v.x, v.y, v.z]; }
  d(l: V3): V3 { const v = new THREE.Vector3(...l).applyQuaternion(this.quat); return [v.x, v.y, v.z]; }
  local(world: V3): V3 { const v = new THREE.Vector3(...world).sub(this.pos).applyQuaternion(this.quat.clone().invert()); return [v.x, v.y, v.z]; }
  /** distance along a local ray to the first solid hit, or null */
  cast(o: V3, dir: V3, max: number): number | null {
    const hit = h.world.sim.raycast(this.w(o), this.d(dir), max, { layers: MASK as never, exclude: [h.bodyId] });
    return hit ? hit.distance : null;
  }
  /** a clear line between two local points */
  clear(a: V3, b: V3): boolean {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...d);
    if (len < 1e-3) return true;
    const t = this.cast(a, d, len);
    return t === null || t >= len - 0.03;
  }
}

function section(f: Frame, s: number, yRef: number): Section {
  let floor: number | null = null;
  for (const y0 of [yRef, yRef + 1, 0.6, 2, 3.5]) {
    const d = f.cast([0, y0, s], [0, -1, 0], y0 + 8);
    if (d !== null && d > 0.02) { floor = y0 - d; break; }
  }
  if (floor === null) return { s, floor: NaN, ceil: null, rows: [], fan: [], closed: false, why: "no floor under the centre" };
  const up = f.cast([0, floor + 0.3, s], [0, 1, 0], CAP);
  const ceil = up === null ? null : floor + 0.3 + up;
  const top = Math.min(ceil ?? floor + CAP, floor + CAP);
  const rows: Row[] = [];
  for (let y = floor + 0.1; y < top - 0.04; y += ROW) {
    const l = f.cast([0, y, s], [-1, 0, 0], SIDE_MAX), r = f.cast([0, y, s], [1, 0, 0], SIDE_MAX);
    rows.push({ y: r2(y), L: l === null ? -SIDE_MAX : -l, R: r === null ? SIDE_MAX : r, openL: l === null, openR: r === null });
  }
  const fan: [number, number][] = [];
  const c: V3 = [0, Math.min(floor + 1.2, (floor + top) / 2), s];
  for (let a = 0; a < 360; a += 5) {
    const dir: V3 = [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180), 0];
    const t = f.cast(c, dir, SIDE_MAX) ?? SIDE_MAX;
    fan.push([r2(dir[0] * t), r2(c[1] + dir[1] * t)]);
  }
  const low = rows.filter((r) => r.y <= floor! + WALK_BAND);
  const open = low.filter((r) => r.openL || r.openR);
  const closed = low.length > 0 && open.length === 0;
  return { s, floor, ceil, rows, fan, closed, why: closed ? undefined : low.length === 0 ? "no headroom" : `open to the ${open.some((r) => r.openL) ? "left" : "right"} at ${r2(open[0]!.y - floor)} m` };
}

const rowAt = (sec: Section, y: number): Row | undefined => {
  let best: Row | undefined, bd = ROW / 2 + 1e-6;
  for (const r of sec.rows) { const d = Math.abs(r.y - y); if (d <= bd) { bd = d; best = r; } }
  return best;
};
function describe(sec: Section) {
  const at = (hgt: number) => { const r = rowAt(sec, sec.floor + hgt); return r ? r2(r.R - r.L) : 0; };
  const low = sec.rows.filter((r) => r.y <= sec.floor + WALK_BAND);
  const wide = low.length ? low.reduce((a, r) => (r.R - r.L > a.R - a.L ? r : a)) : null;
  return {
    s: r2(sec.s), closed: sec.closed, ...(sec.why ? { why: sec.why } : {}), floor: r2(sec.floor),
    height: sec.ceil === null ? `>${CAP}` : r2(sec.ceil - sec.floor),
    width: { "0.5": at(0.5), "1.5": at(1.5), "2.5": at(2.5), "3.5": at(3.5) },
    widest: wide ? { width: r2(wide.R - wide.L), at: r2(wide.y - sec.floor), from: r2(wide.L), to: r2(wide.R) } : null,
    area: r2(low.reduce((a, r) => a + (r.R - r.L) * ROW, 0)),
  };
}

/** the points the body CENTRE can occupy at a section (capsule radius off the walls, feet on the floor, a jump's reach) */
function bodyPoints(sec: Section): [number, number][] {
  const cols = new Map<number, { lo: number; hi: number }>();
  for (const r of sec.rows) for (let x = Math.ceil(r.L / 0.1) * 0.1; x <= r.R; x += 0.1) {
    const k = Math.round(x * 10), c = cols.get(k);
    if (!c) cols.set(k, { lo: r.y, hi: r.y }); else { c.lo = Math.min(c.lo, r.y); c.hi = Math.max(c.hi, r.y); }
  }
  const pts: [number, number][] = [];
  for (const r of sec.rows) {
    for (let x = Math.ceil((r.L + BODY_R) / 0.1) * 0.1; x <= r.R - BODY_R + 1e-6; x += 0.1) {
      const c = cols.get(Math.round(x * 10));
      if (!c || c.hi + ROW / 2 - (c.lo - ROW / 2) < 2 * BODY_HALF) continue; // no standing room in this column
      if (r.y < c.lo - ROW / 2 + BODY_HALF - 0.15 || r.y > Math.min(c.hi + ROW / 2 - BODY_HALF, c.lo - ROW / 2 + BODY_HALF + JUMP_RISE)) continue;
      pts.push([r2(x), r.y]);
    }
  }
  return pts;
}

interface Trig { halfExtents: V3; offset: V3 }
function checkTrigger(f: Frame, trig: Trig, sections: Section[]) {
  const [hx, hy, hz] = trig.halfExtents, [ox, oy, oz] = trig.offset;
  const inside = sections.filter((sec) => sec.s >= oz - hz - 1e-6 && sec.s <= oz + hz + 1e-6);
  const closed = inside.filter((s) => s.closed);
  let best: { sec: Section; miss: [number, number][] } | null = null;
  for (const sec of closed) {
    const miss = bodyPoints(sec).filter(([x, y]) => x < ox - hx || x > ox + hx || y < oy - hy || y > oy + hy);
    if (!best || miss.length < best.miss.length) best = { sec, miss };
  }
  const gaps: string[] = [];
  if (!inside.length) gaps.push("no cross-section inside the box (box outside the scanned passage)");
  else if (!closed.length) gaps.push(`the passage is open at every section inside the box (${inside[0]!.why}): a body can walk round it`);
  else if (best!.miss.length) {
    const m = best!.miss, fl = best!.sec.floor;
    const left = m.filter(([x]) => x < ox - hx), right = m.filter(([x]) => x > ox + hx), over = m.filter(([, y]) => y > oy + hy), under = m.filter(([, y]) => y < oy - hy);
    if (left.length) gaps.push(`past the LEFT side: body centre reaches x ${r2(Math.min(...left.map((p) => p[0])))}, box ends ${r2(ox - hx)}`);
    if (right.length) gaps.push(`past the RIGHT side: body centre reaches x ${r2(Math.max(...right.map((p) => p[0])))}, box ends ${r2(ox + hx)}`);
    if (over.length) gaps.push(`OVER the top: body centre reaches ${r2(Math.max(...over.map((p) => p[1])) - fl)} m above the floor (a jump), box top ${r2(oy + hy - fl)} m`);
    if (under.length) gaps.push(`UNDER the bottom: body centre as low as ${r2(Math.min(...under.map((p) => p[1])) - fl)} m above the floor, box bottom ${r2(oy - hy - fl)} m`);
  }
  // the box swallowing a landing spot: an arrival stands in it (harmless, it must walk out first) but it reads as a bug
  return { pass: gaps.length === 0, gaps, at: best ? r2(best.sec.s) : null, size: [r2(2 * hx), r2(2 * hy), r2(2 * hz)], offset: trig.offset.map(r2) };
}

function viewpoints(f: Frame, sec: Section, side: number): V3[] {
  const out: V3[] = [];
  const c: V3 = [0, sec.floor + 1.3, sec.s];
  const half = Math.max(1, Math.min(3, (describe(sec).widest?.width ?? 2) / 2));
  for (const d of [2.5, 5, 9]) for (const x of [0, -half, half]) {
    const z = sec.s + side * d;
    // ground under the spot: from just above the opening's floor height, else from the centre height
    let g: number | null = null;
    for (const y0 of [sec.floor + 3, sec.floor + 1.5, sec.floor + 6]) { const t = f.cast([x, y0, z], [0, -1, 0], 12); if (t !== null && t > 0.05) { g = y0 - t; break; } }
    if (g === null) continue;
    for (const eye of [1.6, 3.0]) {
      const p: V3 = [x, g + eye, z];
      if (f.clear(p, c)) out.push(p);
    }
  }
  return out;
}

/**
 * The opening on one plane as the cells a body of air joins to the passage centre: a flood over a GRID-metre grid
 * where two neighbouring cells join when the short segment between them hits nothing. Arches, bumps and hollows the
 * centre rows cannot see are found; a region reaching the grid's side or bottom edge means the plane is outside the mouth.
 */
interface Plane { s: number; floor: number; x0: number; y0: number; nx: number; ny: number; cell: Uint8Array; dist: Uint16Array; open: string[]; bbox: { x0: number; x1: number; y0: number; y1: number } }
const SIDE_GRID = 16;
function opening(f: Frame, sec: Section): Plane {
  const x0 = -SIDE_GRID, y0 = sec.floor - 1, nx = Math.round((2 * SIDE_GRID) / GRID) + 1, ny = Math.round((CAP + 1) / GRID) + 1;
  const cell = new Uint8Array(nx * ny);
  const at = (i: number, j: number): V3 => [x0 + i * GRID, y0 + j * GRID, sec.s];
  const si = Math.round(-x0 / GRID), sj = Math.round((Math.min(1.0, ((sec.ceil ?? sec.floor + CAP) - sec.floor) / 2) + 1) / GRID);
  const q: number[] = [si + sj * nx];
  cell[q[0]!] = 1;
  const open = new Set<string>();
  while (q.length) {
    const k = q.pop()!, i = k % nx, j = (k - i) / nx;
    if (i === 0) open.add("left"); if (i === nx - 1) open.add("right"); if (j === 0) open.add("below"); if (j === ny - 1) open.add("above");
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const n = a + b * nx;
      // both ways: a mesh face is solid from its front only, so a one-way ray can leave the rock through its skin
      if (cell[n] || !f.clear(at(i, j), at(a, b)) || !f.clear(at(a, b), at(i, j))) continue;
      cell[n] = 1;
      q.push(n);
    }
  }
  // cells from the opening (4-neighbour steps), for how far a veil point stands outside it
  const dist = new Uint16Array(nx * ny).fill(65535);
  const bq: number[] = [];
  const bbox = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (let k = 0; k < cell.length; k++) if (cell[k]) {
    dist[k] = 0; bq.push(k);
    const i = k % nx, j = (k - i) / nx, x = x0 + i * GRID, y = y0 + j * GRID;
    bbox.x0 = Math.min(bbox.x0, x); bbox.x1 = Math.max(bbox.x1, x); bbox.y0 = Math.min(bbox.y0, y); bbox.y1 = Math.max(bbox.y1, y);
  }
  for (let h = 0; h < bq.length; h++) {
    const k = bq[h]!, i = k % nx, j = (k - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const n = a + b * nx;
      if (dist[n] !== 65535) continue;
      dist[n] = dist[k]! + 1; bq.push(n);
    }
  }
  return { s: sec.s, floor: sec.floor, x0, y0, nx, ny, cell, dist, open: [...open], bbox };
}

function checkVeil(f: Frame, veil: { size: [number, number]; at: V3 }, side: number, yRef: number, given?: { sec: Section; plane: Plane }) {
  const sec = given?.sec ?? section(f, veil.at[2], yRef), plane = given?.plane;
  const vx0 = veil.at[0] - veil.size[0] / 2, vx1 = veil.at[0] + veil.size[0] / 2, vy0 = veil.at[1] - veil.size[1] / 2, vy1 = veil.at[1] + veil.size[1] / 2;
  const gaps: string[] = [];
  if (!sec.rows.length) return { pass: false, gaps: [`no opening at the veil's plane (z ${r2(veil.at[2])}): ${sec.why}`], opening: null, size: veil.size, at: veil.at.map(r2), gapArea: 0, protrusion: 0, views: 0 };
  const vps = viewpoints(f, sec, side);
  if (!vps.length) gaps.push("no viewpoint on the approach side sees the opening");
  const pl = plane ?? opening(f, sec);
  if (pl.open.some((o) => o !== "above")) gaps.push(`the veil's plane (z ${r2(sec.s)}) is outside the passage: its opening runs out to the ${pl.open.join(", ")} (the veil hangs in front of the mouth)`);
  const seen = (p: V3) => vps.some((v) => f.clear(v, p));
  const gapCells: [number, number][] = [], proCells: [number, number, number][] = [];
  let vis = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (let j = 0; j < pl.ny; j++) for (let i = 0; i < pl.nx; i++) {
    const k = i + j * pl.nx, x = pl.x0 + i * GRID, y = pl.y0 + j * GRID;
    const inVeil = x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;
    if (pl.cell[k]) {
      if (!seen([x, y, sec.s])) continue;
      vis = { x0: Math.min(vis.x0, x), x1: Math.max(vis.x1, x), y0: Math.min(vis.y0, y), y1: Math.max(vis.y1, y) };
      if (!inVeil) gapCells.push([x, y]);
    } else if (inVeil) {
      const out = pl.dist[k]! * GRID;
      if (out > PROTRUDE && seen([x, y, sec.s])) proCells.push([x, y, out]);
    }
  }
  const gapArea = gapCells.length * GRID * GRID;
  if (gapArea > GAP_AREA) {
    const where: string[] = [];
    const L = gapCells.filter(([x]) => x < vx0), R = gapCells.filter(([x]) => x > vx1), T = gapCells.filter(([, y]) => y > vy1), B = gapCells.filter(([, y]) => y < vy0);
    if (L.length) where.push(`left of the veil (to x ${r2(Math.min(...L.map((p) => p[0])))}, veil edge ${r2(vx0)})`);
    if (R.length) where.push(`right of the veil (to x ${r2(Math.max(...R.map((p) => p[0])))}, veil edge ${r2(vx1)})`);
    if (T.length) where.push(`above the veil (to ${r2(Math.max(...T.map((p) => p[1])) - sec.floor)} m over the floor, veil top ${r2(vy1 - sec.floor)} m)`);
    if (B.length) where.push(`below the veil (veil bottom ${r2(vy0 - sec.floor)} m over the floor)`);
    gaps.push(`GAP ${r2(gapArea)} m^2 of opening shows past the veil: ${where.join("; ")}`);
  }
  const protrusion = proCells.length ? Math.max(...proCells.map((p) => p[2])) : 0;
  if (proCells.length) {
    const far = proCells.reduce((a, p) => (p[2] > a[2] ? p : a));
    gaps.push(`PROTRUSION: the veil shows ${r2(protrusion)} m outside the opening (${proCells.length} visible cells, worst at x ${r2(far[0])}, ${r2(far[1] - sec.floor)} m over the floor)`);
  }
  return {
    pass: gaps.length === 0, gaps, size: veil.size.map(r2), at: veil.at.map(r2), gapArea: r2(gapArea), protrusion: r2(protrusion), views: vps.length,
    opening: Number.isFinite(vis.x0) ? { width: r2(vis.x1 - vis.x0 + GRID), height: r2(vis.y1 - vis.y0 + GRID), from: [r2(vis.x0), r2(vis.y0)], to: [r2(vis.x1), r2(vis.y1)] } : null,
  };
}

function approachSide(f: Frame, id: string, params: Record<string, unknown>, sz: number): { side: number; from: string } {
  const ref = typeof params["returnAnchor"] === "string" && doc.entities[params["returnAnchor"] as string] ? (params["returnAnchor"] as string) : null;
  let pick = ref, from = ref ? `returnAnchor ${ref}` : "";
  if (!pick) {
    let best = Infinity;
    for (const [eid, e] of Object.entries(doc.entities)) {
      if (eid === id || !(e.tags ?? []).includes("instance-entry")) continue;
      const d = poseOf(eid).pos.distanceTo(f.pos);
      if (d < best) { best = d; pick = eid; }
    }
    if (pick) from = `nearest instance-entry ${pick}`;
  }
  if (pick) { const l = f.local([poseOf(pick).pos.x, poseOf(pick).pos.y, poseOf(pick).pos.z]); return { side: l[2] >= sz ? 1 : -1, from }; }
  return { side: -1, from: "none found: assumed local -z" };
}

interface Result {
  id: string; status: "PASS" | "FAIL"; approach: string;
  narrowest: ReturnType<typeof describe> | null; atBox: ReturnType<typeof describe> | null;
  trigger: ReturnType<typeof checkTrigger>; veil: ReturnType<typeof checkVeil>;
  notes: string[]; digest: string;
}

function measure(id: string, params: Record<string, unknown>, stated: StatedFile): { r: Result; sections: Section[]; f: Frame; side: number } {
  const pose = poseOf(id), f = new Frame(pose.pos, pose.quat);
  const trig = triggerOf(params);
  const veil = veilOf(params, stated[sceneId!]?.[id]);
  h.teleport([pose.pos.x, pose.pos.y + 40, pose.pos.z]); // makes the ground around the portal; the body stays out of every ray
  const yRef = Math.max(0.6, trig.offset[1]);
  const sections: Section[] = [];
  for (let s = trig.offset[2] - SCAN; s <= trig.offset[2] + SCAN + 1e-6; s += SECTION_STEP) sections.push(section(f, r2(s), yRef));
  const { side, from } = approachSide(f, id, params, trig.offset[2]);
  const closed = sections.filter((s) => s.closed && Math.abs(s.s - trig.offset[2]) <= 3 && bodyPoints(s).length > 0);
  const narrow = closed.length ? closed.reduce((a, s) => (describe(s).area < describe(a).area ? s : a)) : null;
  const atBox = sections.reduce((a, s) => (Math.abs(s.s - trig.offset[2]) < Math.abs(a.s - trig.offset[2]) ? s : a));
  const t = checkTrigger(f, trig, sections);
  const v = checkVeil(f, veil, side, yRef);
  const notes: string[] = [];
  if (veil.at[2] < trig.offset[2] - trig.halfExtents[2] - 0.5 || veil.at[2] > trig.offset[2] + trig.halfExtents[2] + 0.5) notes.push(`the veil stands ${r2(veil.at[2] - trig.offset[2])} m along the passage from the box: a traveller meets one well before the other`);
  for (const ref of [params["returnAnchor"], ...Object.entries(doc.entities).filter(([, e]) => (e.tags ?? []).includes("instance-entry")).map(([k]) => k)]) {
    if (typeof ref !== "string" || !doc.entities[ref]) continue;
    const p = poseOf(ref).pos, l = f.local([p.x, p.y + BODY_HALF, p.z]);
    if (Math.abs(l[0] - trig.offset[0]) <= trig.halfExtents[0] && Math.abs(l[1] - trig.offset[1]) <= trig.halfExtents[1] && Math.abs(l[2] - trig.offset[2]) <= trig.halfExtents[2]) notes.push(`${ref} (a landing spot) stands inside the box`);
  }
  const r: Result = { id, status: t.pass && v.pass ? "PASS" : "FAIL", approach: `${side > 0 ? "+z" : "-z"} (${from})`, narrowest: narrow ? describe(narrow) : null, atBox: describe(atBox), trigger: t, veil: v, notes, digest: portalDigest(doc, id) };
  return { r, sections, f, side };
}

function print(r: Result): void {
  log(`\n${r.id}: ${r.status}   (approach ${r.approach})`);
  const n = r.narrowest;
  if (n) log(`  opening   narrowest at z ${n.s}: ${n.widest?.width ?? "?"} m widest (at ${n.widest?.at} m), ${n.width["0.5"]} / ${n.width["1.5"]} / ${n.width["2.5"]} / ${n.width["3.5"]} m wide at 0.5/1.5/2.5/3.5 m, ${n.height} m high`);
  else log(`  opening   no closed cross-section within 3 m of the box (${r.atBox?.why ?? "?"})`);
  log(`  trigger   ${r.trigger.size.join(" x ")} m at [${r.trigger.offset.join(", ")}]  ${r.trigger.pass ? "covers it" : "DOES NOT cover it"}`);
  for (const g of r.trigger.gaps) log(`            - ${g}`);
  log(`  veil      ${r.veil.size.join(" x ")} m at [${r.veil.at.join(", ")}]; visible opening ${r.veil.opening ? `${r.veil.opening.width} x ${r.veil.opening.height} m` : "none"} (${r.veil.views} viewpoints)  ${r.veil.pass ? "covers it" : "DOES NOT cover it"}`);
  for (const g of r.veil.gaps) log(`            - ${g}`);
  for (const nn of r.notes) log(`  note      ${nn}`);
}

function writeReport(results: Result[], extra: Record<string, unknown> = {}): string {
  fs.mkdirSync(reportDir, { recursive: true });
  const file = path.join(reportDir, `${sceneId}.json`);
  // a --portal run updates its rows in the scene's report and keeps the others
  let prev: Result[] = [];
  if (only && fs.existsSync(file)) try { prev = (JSON.parse(fs.readFileSync(file, "utf8")) as { portals: Result[] }).portals.filter((p) => !results.some((r) => r.id === p.id)); } catch { prev = []; }
  const all = [...prev, ...results];
  fs.writeFileSync(file, JSON.stringify({ tool: "portal-cover", scene: sceneId, project, at: new Date().toISOString(), passed: all.every((p) => p.status === "PASS"), portals: all, ...extra }, null, 1) + "\n");
  return file;
}

// ---- fit ---------------------------------------------------------------------------------------------------------------
function fit(id: string, params: Record<string, unknown>, m: ReturnType<typeof measure>): { trigger: Trig; size: [number, number]; at: V3; note: Record<string, unknown> } | null {
  const trig = triggerOf(params);
  // walkable closed sections within 1.5 m of the box (the passage the author meant; further out is the porch or the hall)
  const near = m.sections.filter((s) => s.closed && Math.abs(s.s - trig.offset[2]) <= 1.5 && bodyPoints(s).length > 0);
  if (!near.length) return null;
  // the narrowest of them, unless it is no more than 5% narrower than the section the box stands on (a uniform passage)
  const here = near.reduce((a, s) => (Math.abs(s.s - trig.offset[2]) < Math.abs(a.s - trig.offset[2]) ? s : a));
  const least = near.reduce((a, s) => (describe(s).area < describe(a).area ? s : a));
  const narrow = describe(least).area < 0.95 * describe(here).area ? least : here;
  const hz = Math.max(0.75, trig.halfExtents[2]);
  const inBox = m.sections.filter((s) => s.closed && Math.abs(s.s - narrow.s) <= hz + 1e-6);
  // trigger: every section inside the box covered (the widest of them), full walkable width and the body's reach
  let x0 = Infinity, x1 = -Infinity, yb = Infinity, yt = -Infinity;
  for (const sec of inBox) {
    for (const r of sec.rows) if (r.y <= sec.floor + BODY_HALF + JUMP_RISE + BODY_HALF) { x0 = Math.min(x0, r.L); x1 = Math.max(x1, r.R); }
    const pts = bodyPoints(sec);
    yb = Math.min(yb, sec.floor);
    yt = Math.max(yt, ...pts.map((p) => p[1]), sec.floor + 2.6);
  }
  const trigger: Trig = {
    halfExtents: [r2((x1 - x0) / 2 + 0.3), r2((yt - yb) / 2 + 0.3), r2(hz)],
    offset: [r2((x0 + x1) / 2), r2((yb + yt) / 2), r2(narrow.s)],
  };
  // veil: a section inside the box, the whole visible opening + 0.3 m; the first with no gap and no protrusion wins
  const cands = inBox.slice().sort((a, b) => Math.abs(a.s - narrow.s) - Math.abs(b.s - narrow.s));
  let chosen: { size: [number, number]; at: V3; v: ReturnType<typeof checkVeil> } | null = null;
  for (const sec of cands) {
    const plane = opening(m.f, sec);
    if (plane.open.some((o) => o !== "above")) continue;
    const { x0: vx0, x1: vx1, y0: vy0, y1: vy1 } = plane.bbox;
    const size: [number, number] = [r2(vx1 - vx0 + 0.6), r2(vy1 - vy0 + 0.6)];
    const at: V3 = [r2((vx0 + vx1) / 2), r2((vy0 + vy1) / 2), r2(sec.s)];
    const v = checkVeil(m.f, { size, at }, m.side, Math.max(0.6, trig.offset[1]), { sec, plane });
    const score = (c: ReturnType<typeof checkVeil>) => (c.pass ? 0 : 1000) + c.gapArea * 10 + c.protrusion * 100;
    if (!chosen || score(v) < score(chosen.v)) chosen = { size, at, v };
    if (v.pass) break;
  }
  if (!chosen) return null;
  return { trigger, size: chosen!.size, at: chosen!.at, note: { narrowest: describe(narrow), sectionsInBox: inBox.length, veilAt: chosen!.at[2], at: new Date().toISOString() } };
}

// ---- run -----------------------------------------------------------------------------------------------------------------
// --undo <inverse file>: a fit taken back the way it went in (one applyOps batch; the stated sizes it replaced restored)
const undo = arg("--undo");
if (undo) {
  const rec = JSON.parse(fs.readFileSync(path.resolve(undo), "utf8")) as Op[] | { ops: Op[]; stated?: Record<string, unknown> };
  const ops = Array.isArray(rec) ? rec : rec.ops;
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  registerChunkComponents(reg);
  const res = applyOps(docNow(), ops, reg);
  fs.writeFileSync(sceneFile, JSON.stringify(res.doc, null, 2) + "\n");
  if (!Array.isArray(rec) && rec.stated) {
    const st = readStated(statedFile);
    st[sceneId] ??= {};
    for (const [id, prev] of Object.entries(rec.stated)) { if (prev) st[sceneId]![id] = prev as StatedFile[string][string]; else delete st[sceneId]![id]; }
    fs.writeFileSync(statedFile, JSON.stringify(st, null, 2) + "\n");
  }
  fs.renameSync(path.resolve(undo), path.resolve(undo).replace(/\.json$/, `.undone-${Date.now()}.json`));
  console.log(`portal-cover: undid ${ops.length} op(s) in ${project}/${sceneId}${Array.isArray(rec) ? " (this inverse has no stated sizes: restore portal-veils.json by hand)" : ""}`);
  process.exit(0);
}

await boot();
let stated = readStated(statedFile);
let results = portals.map(([id, params]) => measure(id, params, stated));
for (const m of results) print(m.r);
if (flag("--profile")) for (const m of results) {
  log(`
${m.r.id}: sections (z: closed, floor, height, width at 0.5/1.5/2.5/3.5 m, standing points)`);
  for (const sec of m.sections) { const d = describe(sec); log(`  z ${String(d.s).padStart(5)} ${sec.closed ? "closed" : "OPEN  "} floor ${d.floor} h ${d.height} w ${d.width["0.5"]}/${d.width["1.5"]}/${d.width["2.5"]}/${d.width["3.5"]} pts ${bodyPoints(sec).length}${sec.why ? " " + sec.why : ""}`); }
}

if (flag("--fit")) {
  const before = results.map((m) => m.r);
  const fits: Record<string, ReturnType<typeof fit>> = {};
  for (const [id, params] of portals) {
    const m = results.find((x) => x.r.id === id)!;
    const ft = fit(id, params, m);
    if (!ft) { log(`\n${id}: cannot fit (no closed cross-section within 3 m of the box)`); continue; }
    fits[id] = ft;
    log(`\n${id}: fitted trigger ${ft.trigger.halfExtents.map((v) => r2(2 * v)).join(" x ")} m at [${ft.trigger.offset.join(", ")}], veil ${ft.size.join(" x ")} m at [${ft.at.join(", ")}]`);
  }
  if (Object.keys(fits).length) {
    // stated data first (a rebuild re-applies it through portal-veil), then the scene as one batch with its inverse
    stated = readStated(statedFile);
    stated[sceneId] ??= {};
    const statedBefore = Object.fromEntries(Object.keys(fits).map((id) => [id, stated[sceneId]![id] ?? null]));
    for (const [id, ft] of Object.entries(fits)) stated[sceneId]![id] = { ...stated[sceneId]![id], size: ft!.size, at: ft!.at, trigger: ft!.trigger, fit: ft!.note };
    fs.writeFileSync(statedFile, JSON.stringify(stated, null, 2) + "\n");
    const fresh = docNow(); // the editor autosaves: build on the file as it is now
    const { ops } = portalVeilOps(fresh, sceneId, stated, { only: new Set(Object.keys(fits)) });
    const reg = new ComponentRegistry();
    registerCoreComponents(reg);
    registerChunkComponents(reg);
    const res = applyOps(fresh, ops as Op[], reg);
    fs.mkdirSync(reportDir, { recursive: true });
    const inv = path.join(reportDir, `${sceneId}.fit-inverse.${Date.now()}.json`);
    fs.writeFileSync(inv, JSON.stringify({ tool: "portal-cover --fit", scene: sceneId, ops: res.inverse, stated: statedBefore }, null, 1) + "\n");
    fs.writeFileSync(sceneFile, JSON.stringify(res.doc, null, 2) + "\n");
    log(`\nportal-cover: ${ops.length} op(s) applied to ${project}/${sceneId}; inverse ${path.relative(PG, inv)}; stated sizes in ${path.relative(PG, statedFile)}`);
    // re-check on the scene as written
    await h.close();
    doc = docNow();
    portals = walkThroughPortals(doc).filter(([id]) => !only || only.includes(id));
    await boot();
    results = portals.map(([id, params]) => measure(id, params, stated));
    log("\n---- after the fit ----");
    for (const m of results) print(m.r);
    const file = writeReport(results.map((m) => m.r), { before: before.map((b) => ({ id: b.id, status: b.status, trigger: b.trigger, veil: { size: b.veil.size, at: b.veil.at, gaps: b.veil.gaps } })) });
    log(`\nreport ${path.relative(PG, file)}`);
  }
} else {
  const file = writeReport(results.map((m) => m.r));
  log(`\nreport ${path.relative(PG, file)}`);
}
const failed = results.filter((m) => m.r.status !== "PASS").map((m) => m.r.id);
console.log(failed.length ? `portal-cover: FAIL ${failed.join(", ")} in ${sceneId}` : `portal-cover: PASS ${results.length} portal(s) in ${sceneId}`);
await h.close();
process.exit(failed.length ? 1 : 0);
