/**
 * town-exterior — measure a town's OUTDOORS into a socket map of named pitches, so its streets, square and quay are
 * dressed by NAME (`dress check` / `dress apply`), never by a hand-written transform.
 *
 *   npx tsx tools/town-exterior.mts sockets --project voxel-demo --town tidewell [--scene proving]
 *
 * Boots the scene headless as the dedicated server does (HeadlessWorld + TerrainStreamer: terrain, every installed
 * building and quay mesh, scatter colliders) and proposes outdoor floor anchors from the town's own data:
 *   door-<lot>-l / -r   beside each door, 1.3 m out and 2.6 m to the side (crates by a door, a bench, a sign board)
 *   stall-<n>           pitches round the square's edge, facing its middle (stalls, carts, a notice board)
 *   quay-<n>            along the quay deck's landward edge (nets, crates, barrels, a boat on rollers)
 *   street-<road>-<n>   just outside each street's walking band, every ~12 m (a cart, a rack, barrels)
 * Each candidate keeps a clearance radius for its kind and is REFUSED when that disc touches: a street or lane band
 * (half width + 0.4 m), a door path (+0.6 m), a lantern (1.2 m), a building's full footprint, another kept anchor,
 * standing water, a slope (ground under the disc varying more than 0.45 m), or anything built standing on it (a ray
 * from above must land on the ground, or on the quay deck for a quay pitch). The square keeps a 4 m lane through its middle.
 * The map is in WORLD coordinates (apply with --at 0,0,0 --yaw 0); its one level is a stub (outdoor anchors carry their
 * own height). Writes authoring/dressing/sockets/<town>-exterior.json and prints every anchor kept and refused.
 */
import fs from "node:fs";
import path from "node:path";
import {
  HeadlessWorld, TerrainStreamer, defaultEvents, defaultRegistry, defaultScripts, loadContent, loadProjectScripts, playgroundRoots, resolveServerVoxelWorld,
} from "../../../packages/server/src/index.ts";

type P2 = [number, number];
const argv = process.argv.slice(2);
const opt = (n: string, d = ""): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1]! : d; };
if (argv[0] !== "sockets") { console.error("usage: town-exterior sockets --project <p> --town <name> [--scene <scene>]"); process.exit(2); }
const project = opt("project", "voxel-demo"), town = opt("town");
if (!town) { console.error("--town is required"); process.exit(2); }
const proj = path.join("projects", project);
const towns = path.join(proj, "authoring", "towns");
const readJ = <T,>(f: string): T => JSON.parse(fs.readFileSync(f, "utf8")) as T;
const doc = readJ<{ world?: string; scene?: string }>(path.join(towns, `${town}.json`));
const scene = opt("scene", doc.scene ?? doc.world ?? "proving");
interface Lot { id: string; district?: string; full?: P2[]; corners?: P2[]; door?: P2; facing?: P2 }
const layout = readJ<{ townId: string; buildings: Lot[] }>(path.join(towns, `${town}-layout.json`));
const plan = readJ<{ structures?: Array<{ id: string; kind: string; site?: { kind: string; centre: P2; along: P2; length: number; width: number; groundY?: number } }> }>(path.join(towns, `${town}-plan.json`));
const lights = readJ<{ lanterns: Array<{ id: string; at: number[] }> }>(path.join(towns, `${town}-lights.json`)).lanterns;
const recipe = readJ<{ features: { roads: Array<{ id: string; width?: number; points: number[][] }>; towns: Array<{ id: string; center: P2 }> } }>(path.join(proj, "assets", "worlds", `${doc.world ?? scene}.json`));
const tid = layout.townId;
const roads = recipe.features.roads.filter((r) => r.id.startsWith(`${tid}-`)).map((r) => ({ id: r.id, width: r.width ?? 4, pts: r.points.map((p) => [p[0]!, p[p.length - 1]!] as P2) }));
const streets = roads.filter((r) => r.id.startsWith(`${tid}-street-`));
const doorPaths = roads.filter((r) => r.id.startsWith(`${tid}-door-`));
const square = streets.find((r) => /-square-/.test(r.id));
const centre = recipe.features.towns.find((t) => t.id === tid)!.center;

// ---- geometry helpers
const segDist = (p: P2, a: P2, b: P2): number => {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
};
const lineDist = (p: P2, pts: P2[]): number => { let d = Infinity; for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(p, pts[i]!, pts[i + 1]!)); return pts.length === 1 ? Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]) : d; };
const inPoly = (p: P2, poly: P2[]): boolean => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i]!, b = poly[j]!; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const polyDist = (p: P2, poly: P2[]): number => (inPoly(p, poly) ? 0 : Math.min(...poly.map((a, i) => segDist(p, a, poly[(i + 1) % poly.length]!))));
const yawFacing = (dx: number, dz: number): number => +((Math.atan2(dx, dz) * 180) / Math.PI).toFixed(1);

// ---- boot the real ground
const content = loadContent(playgroundRoots(path.resolve(".")));
const sceneDoc = content.scenes.get(scene);
if (!sceneDoc) throw new Error(`no scene ${scene}`);
const events = defaultEvents();
const scripts = defaultScripts(events);
await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
const world = await HeadlessWorld.create({ doc: sceneDoc, assets: content.assets, registry: defaultRegistry(), events, scripts, exclude: (_id, e) => e.tags.includes("player") || e.tags.includes("npc") });
const voxel = resolveServerVoxelWorld(world.base);
if (!voxel) throw new Error("scene has no voxel world");
const terrain = new TerrainStreamer(world, voxel, { pool: false });
terrain.ensureAround(centre[0], centre[1], 4);
for (let i = 0; i < 30; i++) world.step?.();
const fld = terrain.resolved.field as unknown as { height(x: number, z: number): number; waterY(x: number, z: number): number | null };
const topAt = (x: number, z: number): number | null => { const h = world.sim.raycast([x, 200, z], [0, -1, 0], 400, { solid: true }); return h ? h.point[1] : null; };

// ---- candidates
interface Cand { id: string; kind: string; at: P2; face: P2; r: number; deck?: number }
const cands: Cand[] = [];
for (const b of layout.buildings) {
  if (!b.door || !b.facing) continue;
  const out: P2 = [-b.facing[0], -b.facing[1]], side: P2 = [-b.facing[1], b.facing[0]];
  for (const [s, tag] of [[1, "l"], [-1, "r"]] as const)
    cands.push({ id: `door-${b.id}-${tag}`, kind: "door-side", at: [b.door[0] + out[0] * 1.3 + side[0] * 2.6 * s, b.door[1] + out[1] * 1.3 + side[1] * 2.6 * s], face: out, r: 0.6 });
}
if (square && square.pts.length >= 2) {
  const [a, b] = [square.pts[0]!, square.pts[square.pts.length - 1]!];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]), u: P2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], n: P2 = [-u[1], u[0]];
  let k = 0;
  for (const t of [0.2, 0.5, 0.8]) for (const s of [1, -1]) {
    const off = square.width / 2 - 2.2;
    const at: P2 = [a[0] + u[0] * len * t + n[0] * off * s, a[1] + u[1] * len * t + n[1] * off * s];
    cands.push({ id: `stall-${++k}`, kind: "stall", at, face: [-n[0] * s, -n[1] * s], r: 1.8 });
  }
}
for (const st of plan.structures ?? []) {
  const site = st.site;
  if (st.kind !== "dock" || !site || site.kind !== "reserved-rect") continue;
  const u = site.along, n: P2 = [-u[1], u[0]];
  // the landward long edge: the side nearer the town centre
  const s = (centre[0] - site.centre[0]) * n[0] + (centre[1] - site.centre[1]) * n[1] > 0 ? 1 : -1;
  let k = 0;
  for (let t = -site.length / 2 + 5; t <= site.length / 2 - 5; t += 7) {
    const at: P2 = [site.centre[0] + u[0] * t + n[0] * s * (site.width / 2 - 1.3), site.centre[1] + u[1] * t + n[1] * s * (site.width / 2 - 1.3)];
    cands.push({ id: `quay-${++k}`, kind: "quay", at, face: [-n[0] * s, -n[1] * s], r: 0.9, deck: site.groundY });
  }
}
for (const st of streets) {
  if (st === square) continue;
  let acc = 0, k = 0;
  for (let i = 0; i + 1 < st.pts.length; i++) {
    const a = st.pts[i]!, b = st.pts[i + 1]!, l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 0.01) continue;
    const u: P2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], n: P2 = [-u[1], u[0]];
    for (let t = (12 - acc) % 12; t < l; t += 12) for (const s of [1, -1]) {
      const off = st.width / 2 + 1.5;
      cands.push({ id: `street-${st.id.slice(tid.length + 8)}-${++k}`, kind: "street-side", at: [a[0] + u[0] * t + n[0] * off * s, a[1] + u[1] * t + n[1] * off * s], face: [-n[0] * s, -n[1] * s], r: 1.0 });
    }
    acc = (acc + l) % 12;
  }
}

// ---- keep what is clear
const kept: Array<Cand & { y: number }> = [];
const refused: Record<string, number> = {};
const refuse = (why: string): boolean => { refused[why] = (refused[why] ?? 0) + 1; return false; };
const clear = (c: Cand): number | null => {
  const ok = ((): boolean => {
    for (const st of streets) {
      if (st === square && c.kind === "stall") { if (lineDist(c.at, st.pts) < 2 + c.r) return refuse("square middle lane"); continue; }
      if (lineDist(c.at, st.pts) < st.width / 2 + 0.4 + c.r) return refuse("street band");
    }
    for (const d of doorPaths) if (lineDist(c.at, d.pts) < d.width / 2 + (c.kind === "door-side" ? 0.4 : 0.6) + c.r) return refuse("door path");
    for (const l of lights) if (Math.hypot(c.at[0] - l.at[0]!, c.at[1] - l.at[2]!) < 1.2 + c.r) return refuse("lantern");
    for (const b of layout.buildings) { const poly = b.full ?? b.corners; if (poly && polyDist(c.at, poly) < c.r + (c.kind === "door-side" ? 0.05 : 0.3)) return refuse("building"); }
    for (const k of kept) if (Math.hypot(c.at[0] - k.at[0], c.at[1] - k.at[1]) < c.r + k.r + 0.6) return refuse("another pitch");
    return true;
  })();
  if (!ok) return null;
  const g = fld.height(c.at[0], c.at[1]);
  const w = fld.waterY(c.at[0], c.at[1]);
  const top = topAt(c.at[0], c.at[1]);
  if (top === null) { refuse("no ground"); return null; }
  if (c.kind === "quay") {
    if (top < g + 0.2 && w != null && w > top) { refuse("quay deck missing (water)"); return null; }
  } else {
    if (w != null && w > g - 0.05) { refuse("standing water"); return null; }
    if (top > g + 0.35) { refuse("something built stands here"); return null; }
  }
  const ring: number[] = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const y = topAt(c.at[0] + Math.cos(a) * c.r, c.at[1] + Math.sin(a) * c.r); if (y === null) { refuse("no ground"); return null; } ring.push(y); }
  if (Math.max(...ring, top) - Math.min(...ring, top) > 0.45) { refuse("slope or edge under it"); return null; }
  return top;
};
const order = ["quay", "stall", "door-side", "street-side"];
for (const kind of order) for (const c of cands.filter((x) => x.kind === kind)) { const y = clear(c); if (y !== null) kept.push({ ...c, y }); }

const map = {
  id: `${town}-exterior`,
  source: { model: `authoring/towns/${town}-layout.json (outdoors, measured on scene ${scene})`, sha256: "" },
  levels: [{ level: 0, floorY: 0, origin: [centre[0], centre[1]], step: 1, columns: 1, rows: 1, cells: [" "], head: ["."], room: ["."], rooms: [], walls: [], paths: [] }],
  anchors: kept.map((k) => ({ id: k.id, kind: k.kind, level: 0, position: [+k.at[0].toFixed(2), +k.y.toFixed(2), +k.at[1].toFixed(2)], yaw: yawFacing(k.face[0], k.face[1]), mount: "floor", outdoor: true, size: [+(k.r * 2).toFixed(1), 3, +(k.r * 2).toFixed(1)] })),
};
const file = path.join(proj, "authoring", "dressing", "sockets", `${town}-exterior.json`);
fs.writeFileSync(file, JSON.stringify(map, null, 1) + "\n");
const byKind = (k: string): string => kept.filter((x) => x.kind === k).map((x) => x.id.replace(/^(door|street|quay|stall)-/, "")).join(" ");
console.log(`${town}: ${kept.length} of ${cands.length} pitches kept -> ${path.relative(".", file)}`);
for (const k of order) console.log(`  ${k.padEnd(12)} ${kept.filter((x) => x.kind === k).length}  ${byKind(k)}`);
console.log(`  refused: ${JSON.stringify(refused)}`);
process.exit(0);
