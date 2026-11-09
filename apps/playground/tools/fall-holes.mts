/**
 * FALL-HOLES — floor a player can see and walk onto with nothing solid under it (a mesh scene's fall-through gate).
 *
 *   npx tsx tools/fall-holes.mts <project> [--scene <id>] [--eyes <points.json>] [--route <walk.json>] [--step 0.5]
 *        [--climb 0.6] [--sink 0.35] [--out f.json] [--allow 0]
 *
 * The voxel-world gate (tools/holes.mts) boots the server; a hand-built mesh scene (a kit dungeon: render pieces + box
 * colliders) is checked here from its own data. Every upward-facing drawn surface (render triangles, not water, fx or
 * decals) is sampled on a `--step` lattice; a sample is STANDABLE when 1.8 m above it is clear of drawn geometry. The
 * standable samples a body can REACH are flooded from the eyes (`--eyes`: a JSON list of [x, y, z] eye points, 1.6 m
 * over floors, and the walk route's legs; and every surface within 1 m over a pool, where a swimmer climbs out): a
 * neighbour on the lattice is reached when its height differs by <= `--climb` and no drawn wall stands between them;
 * a sample inside a collider (a drawn wall's cavity) holds no body.
 * A reached sample FALLS when no collider top lies within `--sink` below it (nothing to stand on: the body drops through
 * a floor it can see). Colliders: every box collider in the scene, plus the drawn triangles of prefab instances whose
 * prefab carries a collider (statues, props). Falls are clustered into sites (8-connected on the lattice) with their
 * area, centre, height and the piece that draws the floor there, so the fix goes to the builder that left the gap.
 * Exit 1 when the fallen area exceeds `--allow` m^2. Born 2026-11-01 (Derek on the Weeping Sun Tombs: "there is still a
 * lot of geometry we can fall through").
 */
import fs from "node:fs";
import path from "node:path";
import { sceneGeometry, type SceneEntityGeometry } from "./_prop-geometry.mts";
import { PROJECTS } from "./_closure.mjs";

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const project = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!project) { console.error("usage: fall-holes.mts <project> [--scene id] [--eyes f] [--route walk.json] [--step 0.5] [--climb 0.6] [--sink 0.35] [--out f] [--allow 0]"); process.exit(2); }
const root = path.join(PROJECTS, project), assets = path.join(root, "assets");
const sceneId = opt("scene") ?? project;
const sceneFile = path.join(assets, "scenes", `${sceneId}.scene.json`);
const doc = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
const STEP = Number(opt("step") ?? 0.5), CLIMB = Number(opt("climb") ?? 0.6), SINK = Number(opt("sink") ?? 0.35), HEAD = 1.8;
const SKIP_MAT = /water|banner|fx|fire|smoke|mist|haze|shaft|ray-soft|daylight|glint|veil|throat|sky|decal|blood/i;
const notDrawn = (id: string, e: any): boolean => !!(e?.components?.water || e?.tags?.includes?.("water") || e?.tags?.includes?.("npc") || e?.tags?.includes?.("player") || e?.tags?.includes?.("decal") || e?.tags?.includes?.("vfx") || /veil/i.test(id));
const colliderOnly = (e: any): boolean => !!e?.components?.collider && !e?.components?.prefab && !e?.components?.mesh;

// ---- soups ----
class Soup {
  T: number[] = []; src: string[] = []; grid = new Map<string, number[]>(); C = 2;
  add(g: SceneEntityGeometry, keep: (t: number) => boolean = () => true): void {
    for (let t = 0; t < g.world.length / 9; t++) {
      if (!keep(t)) continue;
      const i = this.src.length; this.src.push(g.prefabId ?? g.name ?? g.id);
      const o = t * 9; for (let k = 0; k < 9; k++) this.T.push(g.world[o + k]!);
      const lo = [0, 2].map((k) => Math.min(g.world[o + k]!, g.world[o + 3 + k]!, g.world[o + 6 + k]!)), hi = [0, 2].map((k) => Math.max(g.world[o + k]!, g.world[o + 3 + k]!, g.world[o + 6 + k]!));
      for (let x = Math.floor(lo[0]! / this.C); x <= Math.floor(hi[0]! / this.C); x++) for (let z = Math.floor(lo[1]! / this.C); z <= Math.floor(hi[1]! / this.C); z++) {
        const key = `${x},${z}`; const b = this.grid.get(key); if (b) b.push(i); else this.grid.set(key, [i]);
      }
    }
  }
  /** heights (and triangle ids) where the vertical line at x,z crosses the soup */
  column(x: number, z: number): Array<[number, number]> {
    const out: Array<[number, number]> = []; const T = this.T;
    for (const i of this.grid.get(`${Math.floor(x / this.C)},${Math.floor(z / this.C)}`) ?? []) {
      const o = i * 9; const ax = T[o]!, az = T[o + 2]!, bx = T[o + 3]!, bz = T[o + 5]!, cx = T[o + 6]!, cz = T[o + 8]!;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      out.push([l1 * T[o + 1]! + l2 * T[o + 4]! + l3 * T[o + 7]!, i]);
    }
    return out;
  }
  /** does a drawn triangle cross the horizontal segment a -> b (a wall between two lattice samples)? */
  blocks(ax: number, ay: number, az: number, bx: number, bz: number): boolean {
    const T = this.T, dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); const ux = dx / L, uz = dz / L;
    const keys = new Set([`${Math.floor(ax / this.C)},${Math.floor(az / this.C)}`, `${Math.floor(bx / this.C)},${Math.floor(bz / this.C)}`]);
    for (const k of keys) for (const i of this.grid.get(k) ?? []) {
      const o = i * 9;
      const e1x = T[o + 3]! - T[o]!, e1y = T[o + 4]! - T[o + 1]!, e1z = T[o + 5]! - T[o + 2]!, e2x = T[o + 6]! - T[o]!, e2y = T[o + 7]! - T[o + 1]!, e2z = T[o + 8]! - T[o + 2]!;
      const px = -e2y * uz, py = uz * e2x - ux * e2z, pz = ux * e2y;
      const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det, sx = ax - T[o]!, sy = ay - T[o + 1]!, sz = az - T[o + 2]!;
      const u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (ux * qx + uz * qz) * inv; if (v < 0 || u + v > 1) continue;
      const d = (e2x * qx + e2y * qy + e2z * qz) * inv; if (d > 0 && d < L) return true;
    }
    return false;
  }
  ny(i: number): number { const T = this.T, o = i * 9; const ax = T[o + 3]! - T[o]!, ay = T[o + 4]! - T[o + 1]!, az = T[o + 5]! - T[o + 2]!, bx = T[o + 6]! - T[o]!, by = T[o + 7]! - T[o + 1]!, bz = T[o + 8]! - T[o + 2]!; const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; return ny / (Math.hypot(nx, ny, nz) || 1); }
}
const render = new Soup(), solid = new Soup(), boxes = new Soup(); // boxes: the closed box colliders (the inside test)
const hasCollider = new Map<string, boolean>();
const prefabHasCollider = (id: string): boolean => {
  if (hasCollider.has(id)) return hasCollider.get(id)!;
  let yes = false;
  for (const proj of fs.readdirSync(PROJECTS)) { const f = path.join(PROJECTS, proj, "assets/prefabs", `${id}.json`); if (fs.existsSync(f)) { yes = /"collider"\s*:/.test(fs.readFileSync(f, "utf8")); break; } }
  hasCollider.set(id, yes); return yes;
};
for (const g of sceneGeometry(assets, doc, (id, e) => notDrawn(id, e))) {
  const e = doc.entities[g.id];
  if (colliderOnly(e)) { if (!e.components.collider.isTrigger) { solid.add(g); boxes.add(g); } continue; }
  render.add(g, (t) => !SKIP_MAT.test(g.draws[t] ?? ""));
  if (g.prefabId && prefabHasCollider(g.prefabId)) solid.add(g);
}
// water surfaces: a floor under the water is swum over, not walked (the body is held up by the water)
const waters: Array<{ y: number; x0: number; z0: number; x1: number; z1: number }> = [];
for (const e of Object.values(doc.entities) as any[]) {
  if (!e?.components?.water || !e.components.transform) continue;
  const [ox, oy, oz] = e.components.transform.position; const src = e.components.mesh?.source;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  if (src?.positions) for (let i = 0; i < src.positions.length; i += 3) { x0 = Math.min(x0, src.positions[i] + ox); x1 = Math.max(x1, src.positions[i] + ox); z0 = Math.min(z0, src.positions[i + 2] + oz); z1 = Math.max(z1, src.positions[i + 2] + oz); }
  else if (src?.size) { x0 = ox - src.size[0] / 2; x1 = ox + src.size[0] / 2; z0 = oz - src.size[2] / 2; z1 = oz + src.size[2] / 2; }
  waters.push({ y: oy, x0, z0, x1, z1 });
}
const underWater = (x: number, y: number, z: number): boolean => waters.some((w) => y < w.y - 0.05 && x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1);

/** is the point inside a closed box collider? parity of box surfaces above it on its vertical line (mesh colliders such
 * as a cavern vault are open shells and are not judged by parity) */
const insideSolid = (x: number, y: number, z: number): boolean => {
  const ys = boxes.column(x, z).map(([h]) => Math.round(h * 1000)).filter((h) => h > y * 1000);
  return new Set(ys).size % 2 === 1;
};
// ---- standable samples on the lattice ----
let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
for (let i = 0; i < render.T.length; i += 3) { x0 = Math.min(x0, render.T[i]!); x1 = Math.max(x1, render.T[i]!); z0 = Math.min(z0, render.T[i + 2]!); z1 = Math.max(z1, render.T[i + 2]!); }
type S = { x: number; y: number; z: number; tri: number; i: number; j: number };
const samples: S[] = []; const at = new Map<string, number[]>();
const NI = Math.ceil((x1 - x0) / STEP), NJ = Math.ceil((z1 - z0) / STEP);
for (let i = 0; i <= NI; i++) for (let j = 0; j <= NJ; j++) {
  const x = x0 + i * STEP, z = z0 + j * STEP;
  const col = render.column(x, z).sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < col.length; k++) {
    const [y, tri] = col[k]!;
    if (render.ny(tri) < 0.7 || underWater(x, y, z)) continue;
    const above = col.slice(k + 1).find((c) => c[0] > y + 0.05);
    if (above && above[0] - y < HEAD) continue;
    // inside a solid (the cavity of a drawn wall whose collider is a closed box): no body stands there
    if (insideSolid(x, y + 1, z)) continue;
    const id = samples.length; samples.push({ x, y, z, tri, i, j });
    const key = `${i},${j}`; const b = at.get(key); if (b) b.push(id); else at.set(key, [id]);
  }
}
// ---- reach: flood from the eyes over the lattice ----
const eyes: number[][] = opt("eyes") ? JSON.parse(fs.readFileSync(opt("eyes")!, "utf8")) : [];
const routeFile = opt("route") ?? path.join(root, "reports/walk.json");
if (fs.existsSync(routeFile)) for (const l of JSON.parse(fs.readFileSync(routeFile, "utf8")).legDetail ?? []) { const a = l.from as number[]; if (a?.length === 3) eyes.push([a[0]!, a[1]! + 0.7, a[2]!]); }
const reached = new Uint8Array(samples.length); const queue: number[] = []; const parent = new Int32Array(samples.length).fill(-1);
for (const e of eyes) {
  const i = Math.round((e[0]! - x0) / STEP), j = Math.round((e[2]! - z0) / STEP);
  for (const id of at.get(`${i},${j}`) ?? []) { const s = samples[id]!; if (Math.abs(s.y - (e[1]! - 1.6)) < 1 && !reached[id]) { reached[id] = 1; queue.push(id); } }
}
// a swimmer climbs out wherever drawn ground stands within 1 m over a pool's surface: those samples are reached too
for (let id = 0; id < samples.length; id++) { const t = samples[id]!; if (!reached[id] && waters.some((w) => t.y >= w.y - 0.3 && t.y <= w.y + 1 && t.x >= w.x0 && t.x <= w.x1 && t.z >= w.z0 && t.z <= w.z1)) { reached[id] = 1; queue.push(id); } }
while (queue.length) {
  const s = samples[queue.pop()!]!;
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const id of at.get(`${s.i + di!},${s.j + dj!}`) ?? []) {
    const n = samples[id]!;
    if (reached[id] || Math.abs(n.y - s.y) > CLIMB) continue;
    // a wall between them (drawn geometry crossing the step at knee or chest height) stops the body
    const hy = Math.max(s.y, n.y);
    if (render.blocks(s.x, hy + 0.7, s.z, n.x, n.z) || render.blocks(s.x, hy + 1.4, s.z, n.x, n.z)) continue;
    reached[id] = 1; parent[id] = samples.indexOf(s); queue.push(id);
  }
}
// --trace x,y,z: how the flood reached the sample nearest that point (debugging a leak onto a roof)
if (opt("trace")) {
  const q = opt("trace")!.split(",").map(Number); let best = -1, bd = Infinity;
  for (let id = 0; id < samples.length; id++) if (reached[id]) { const t = samples[id]!; const d = Math.hypot(t.x - q[0]!, t.y - q[1]!, t.z - q[2]!); if (d < bd) { bd = d; best = id; } }
  const chain: number[][] = []; for (let id = best; id >= 0; id = parent[id]!) { const t = samples[id]!; chain.push([t.x, t.y, t.z].map((v) => Math.round(v * 100) / 100)); }
  console.log("trace (sample -> seed):", chain.filter((_, k) => k % 4 === 0 || k === chain.length - 1).map((c) => c.join(",")).join("  "));
}
// ---- support ----
// a reached sample with no collider top within --sink under it is either a GHOST (a collider 0.35-1.5 m down: the body
// walks INTO drawn decor, a plinth, a sill, a parapet, and stands on the floor inside it), a SWIM (water under it: the body
// drops into the pool), or a FALL (nothing, or > 1.5 m down: the body drops through a floor it can see). Falls fail.
const falls: number[] = [], ghosts: number[] = []; let nReached = 0, swims = 0;
const waterBelow = (x: number, y: number, z: number): boolean => waters.some((w) => y >= w.y - 0.05 && y - w.y < 4 && x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1);
for (let id = 0; id < samples.length; id++) {
  if (!reached[id]) continue; nReached++;
  const s = samples[id]!;
  const tops = solid.column(s.x, s.z).map(([y]) => y).filter((y) => y <= s.y + 0.6);
  if (tops.some((y) => y >= s.y - SINK)) continue;
  const below = tops.length ? Math.max(...tops) : -Infinity;
  if (below >= s.y - 1.5) ghosts.push(id);
  // over water: a surface AT the waterline is swum over; a deck above the water with nothing under it drops the body in
  else if (waterBelow(s.x, s.y, s.z) && waters.some((w) => s.y - w.y < 0.3 && s.x >= w.x0 && s.x <= w.x1 && s.z >= w.z0 && s.z <= w.z1)) swims++;
  else falls.push(id);
}
// ---- sites ----
function clusters(list: number[]): any[] {
const fallSet = new Set(list), seen = new Set<number>(); const sites: any[] = [];
for (const f of list) {
  if (seen.has(f)) continue;
  const members: number[] = []; const st = [f]; seen.add(f);
  while (st.length) { const s = samples[st.pop()!]!; members.push(samples.indexOf(s)); for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const id of at.get(`${s.i + di},${s.j + dj}`) ?? []) if (fallSet.has(id) && !seen.has(id) && Math.abs(samples[id]!.y - s.y) <= CLIMB) { seen.add(id); st.push(id); } }
  const ms = members.map((m) => samples[m]!); const c = [0, 1, 2].map((k) => ms.reduce((n, s) => n + [s.x, s.y, s.z][k]!, 0) / ms.length);
  const pieces = new Map<string, number>(); for (const s of ms) pieces.set(render.src[s.tri]!, (pieces.get(render.src[s.tri]!) ?? 0) + 1);
  const under = solid.column(c[0]!, c[2]!).map(([y]) => y).filter((y) => y < c[1]! + 0.6).sort((a, b) => b - a)[0];
  sites.push({ area: Math.round(ms.length * STEP * STEP * 10) / 10, centre: c.map((v) => Math.round(v * 100) / 100), from: [Math.min(...ms.map((s) => s.x)), Math.min(...ms.map((s) => s.z))], to: [Math.max(...ms.map((s) => s.x)), Math.max(...ms.map((s) => s.z))], floor: [...pieces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p), colliderBelow: under === undefined ? "none" : Math.round((c[1]! - under) * 100) / 100 });
}
sites.sort((a, b) => b.area - a.area);
return sites;
}
const sites = clusters(falls), ghostSites = clusters(ghosts);
const fallen = falls.length * STEP * STEP, ALLOW = Number(opt("allow") ?? 0);
const report = { tool: "fall-holes", scene: path.relative(root, sceneFile), at: new Date().toISOString(), step: STEP, samples: samples.length, reached: nReached, fallenArea: Math.round(fallen * 10) / 10, ghostArea: Math.round(ghosts.length * STEP * STEP * 10) / 10, swimArea: Math.round(swims * STEP * STEP * 10) / 10, allow: ALLOW, passed: fallen <= ALLOW, sites, ghosts: ghostSites };
const out = opt("out") ?? path.join(root, "reports/fall-holes.json");
fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
console.log(`fall-holes ${project}: ${samples.length} standable samples, ${nReached} reached; FALL ${Math.round(fallen)} m2 in ${sites.length} site(s), ghost (walk-through decor) ${report.ghostArea} m2 in ${ghostSites.length}, over water ${report.swimArea} m2 -> ${path.relative(process.cwd(), out)}`);
for (const s of ghostSites.slice(0, 15)) console.log(`  ghost ${String(s.area).padStart(6)} m2  at ${JSON.stringify(s.centre)}  floor ${s.floor.join(", ")}  collider ${s.colliderBelow} m below`);
for (const s of sites.slice(0, 40)) console.log(`  FALL  ${String(s.area).padStart(6)} m2  at ${JSON.stringify(s.centre)}  ${JSON.stringify(s.from)}..${JSON.stringify(s.to)}  floor ${s.floor.join(", ")}  collider below: ${s.colliderBelow}`);
process.exit(report.passed ? 0 : 1);
