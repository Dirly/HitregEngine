/**
 * holes <world> --project <p> [--zone <id> | --rect x0,z0,x1,z1 | --near x,z,r] [--coarse 4] [--fine 1] [--list] [--json]
 *
 * THE fall-through gate: can a body fall through ground the player can SEE? Boots the world exactly as the dedicated
 * server does (tools/_server-boot.mts: the scene's project closure, the server's statics radius and voxel ring,
 * GameServer + one loopback body) and sweeps the area block by block (2 x 2 map cells): the body is held at the
 * block's corner until the server's own ring around it is resident — what a player standing there has, no more — and
 * every sample point of the block is cast straight down against the PHYSICS (sim.raycast: terrain cells, landmark
 * collider tiles, ribbons, kit/town pieces, props), next to the ground the player sees: the recipe field's surface
 * (what the terrain mesh draws) and every landmark's RENDER mesh (its baked GLBs). The lattice is `--coarse` (4 m)
 * over the area and `--fine` (1 m) on places (landmarks, POIs, towns: their radius + 20 m) and along roads (4 m each
 * side). Faults (tools/_holes.mts classifyColumn):
 *
 *   no-collider      nothing under ground the player sees: the body falls through the earth
 *   deep             the collider is > 3 m under the field surface (listed: the band or lattice did not mesh a thin field feature, or a mesh hole)
 *   landmark-render  a landmark surface is drawn with nothing to stand on at its height (collider tile missing/offset)
 *   sink             the collider is 1-3 m under the seen ground (knee-deep; a step the body cannot climb back)
 *   arrival          a portal arrival spot (anchor + landing lift, and the queue spots) with no floor within 2.5 m, or in rock
 *
 * Falls (no-collider, landmark-render, arrival) fail the gate; deep and sink are listed. Also reported: cells the server ring did not make resident
 * in time (a block that could not be checked fails too). With --zone the report goes to
 * <project>/authoring/zonegen/<world>/zones/<zone>/reports/holes.json (zonegen status's `holes` row reads it; it is
 * STALE once the recipe or the scene changes). Heavy: run it under the shared lock. Exit 1 on any fall.
 *
 * Run from apps/playground:  node node_modules/tsx/dist/cli.mjs tools/holes.mts skelmorrow --project skelmorrow --zone hagsheer
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootServerBody } from "./_server-boot.mts";
import { PORTAL_LANDING_LIFT, portalArrivalSpot } from "@hitreg/core";
import { FALLS, TriangleGrid, classifyArrival, classifyColumn, clusterFaults, inPolygon, samplePoints, type HoleFault } from "./_holes.mts";
// @ts-expect-error plain JS module
import { readGltf } from "../../../tools/wfc-3d/gltf.mjs";
// @ts-expect-error plain JS module
import { gltfTriangles } from "../../../tools/wfc-3d/collider.mjs";

const PLAYGROUND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const WORLD = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
const PROJECT = opt("project") ?? WORLD;
const ZONE = opt("zone");
if (!WORLD) { console.error("usage: holes.mts <world> --project <p> [--zone <id> | --rect x0,z0,x1,z1 | --near x,z,r] [--coarse 4] [--fine 1] [--list] [--json]"); process.exit(2); }
const JSON_OUT = argv.includes("--json");
const log = (s: string) => { if (!JSON_OUT) console.log(s); else console.error(s); };

const projectDir = path.join(PLAYGROUND, "projects", PROJECT);
const recipeFile = path.join(projectDir, "assets", "worlds", `${WORLD}.json`);
const sceneFile = path.join(projectDir, "assets", "scenes", `${WORLD}.scene.json`);
type P2 = [number, number];
const recipe = JSON.parse(fs.readFileSync(recipeFile, "utf8")) as {
  cellSize: number;
  regions?: Array<{ id: string; polygon?: P2[] }>;
  towns?: Array<{ id: string; center: P2; radius: number }>;
  features: {
    landmarks?: Array<{ id: string; prefab: string; position: [number, number, number]; radius: number }>;
    pois?: Array<{ id: string; position: [number, number, number]; radius?: number; zone?: string }>;
    roads?: Array<{ id: string; points: P2[]; width?: number }>;
    towns?: Array<{ id: string; center: P2; radius: number }>;
  };
};
const stamp = (f: string): string => (fs.existsSync(f) ? `${fs.statSync(f).size}:${fs.statSync(f).mtimeMs}` : "-");
const KEY = `${stamp(recipeFile)}|${stamp(sceneFile)}`;

// ---- the area
let polygon: P2[] | undefined;
let rect: [number, number, number, number];
if (ZONE) {
  polygon = recipe.regions?.find((r) => r.id === ZONE)?.polygon;
  if (!polygon?.length) { console.error(`zone ${ZONE} has no polygon in the recipe regions`); process.exit(2); }
  const xs = polygon.map((q) => q[0]), zs = polygon.map((q) => q[1]);
  rect = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
} else if (opt("rect")) rect = opt("rect")!.split(",").map(Number) as typeof rect;
else if (opt("near")) { const [x, z, r] = opt("near")!.split(",").map(Number) as [number, number, number]; rect = [x - r, z - r, x + r, z + r]; }
else { console.error("give --zone, --rect or --near"); process.exit(2); }
const inArea = (x: number, z: number) => x >= rect[0] && x <= rect[2] && z >= rect[1] && z <= rect[3] && (!polygon || inPolygon(x, z, polygon));

// ---- places and roads (fine lattice) and the owners faults are named after
const owners: Array<{ id: string; x: number; z: number }> = [];
const discs: Array<{ x: number; z: number; r: number }> = [];
const towns = [...(recipe.towns ?? []), ...(recipe.features.towns ?? [])];
for (const t of towns) { owners.push({ id: `town ${t.id}`, x: t.center[0], z: t.center[1] }); discs.push({ x: t.center[0], z: t.center[1], r: t.radius + 60 }); }
for (const p of recipe.features.pois ?? []) {
  if (!inArea(p.position[0], p.position[2])) continue;
  owners.push({ id: `poi ${p.id}`, x: p.position[0], z: p.position[2] });
  discs.push({ x: p.position[0], z: p.position[2], r: (p.radius ?? 20) + 20 });
}
const landmarks = (recipe.features.landmarks ?? []).filter((l) => {
  const [x, , z] = l.position;
  return x + l.radius >= rect[0] && x - l.radius <= rect[2] && z + l.radius >= rect[1] && z - l.radius <= rect[3];
});
for (const l of landmarks) { owners.push({ id: `landmark ${l.id}`, x: l.position[0], z: l.position[2] }); discs.push({ x: l.position[0], z: l.position[2], r: l.radius + 20 }); }
const lines = (recipe.features.roads ?? []).map((r) => ({ points: r.points, halfWidth: (r.width ?? 4) / 2 + 4 }));
for (const r of recipe.features.roads ?? []) { const m = r.points[Math.floor(r.points.length / 2)]; if (m) owners.push({ id: `road ${r.id}`, x: m[0], z: m[1] }); }

// portal arrival anchors (portalAnchor component) in the area: where a body is PUT, not where it walks
const sceneDoc = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as { entities: Record<string, { parent: string | null; components: Record<string, any> }> };
const anchors: Array<{ id: string; p: [number, number, number]; yaw: number; corridor: number; queue?: (number | null)[] }> = [];
for (const [id, e] of Object.entries(sceneDoc.entities)) {
  if (!e.components["portalAnchor"]) continue;
  const p: [number, number, number] = [0, 0, 0];
  for (let q: typeof e | undefined = e; q; q = q.parent ? sceneDoc.entities[q.parent] : undefined) { const t = q.components["transform"]?.position ?? [0, 0, 0]; for (let k = 0; k < 3; k++) p[k]! += t[k]; }
  if (!inArea(p[0], p[2])) continue;
  const r = e.components["transform"]?.rotation ?? [0, 0, 0, 1];
  anchors.push({ id, p, yaw: 2 * Math.atan2(r[1], r[3]), corridor: Number(e.components["portalAnchor"].corridor ?? 0), queue: e.components["portalAnchor"].queue });
  owners.push({ id: `anchor ${id}`, x: p[0], z: p[2] });
}
const coarse = Number(opt("coarse") ?? 4);
const fine = Number(opt("fine") ?? 1);
const points = samplePoints({ polygon, rect, coarse, fine, discs, lines });
log(`[holes] ${WORLD}${ZONE ? ` zone ${ZONE}` : ""}: ${points.length} columns (${coarse} m lattice, ${fine} m on ${discs.length} places and ${lines.length} roads), ${landmarks.length} landmark(s)`);

// ---- the render side: landmark render meshes (the prefab's mesh entities), world space
const render = new TriangleGrid(2);
const assetFile = (id: string): string | null => {
  for (const dir of [projectDir, ...fs.readdirSync(path.join(PLAYGROUND, "projects")).map((d) => path.join(PLAYGROUND, "projects", d))]) {
    const f = path.join(dir, "assets", "models", id);
    if (fs.existsSync(f)) return f;
  }
  return null;
};
const missingRender: string[] = [];
for (const l of landmarks) {
  const pf = path.join(projectDir, "assets", "prefabs", `${l.prefab}.json`);
  if (!fs.existsSync(pf)) { missingRender.push(`${l.id}: prefab ${l.prefab} not found`); continue; }
  const doc = JSON.parse(fs.readFileSync(pf, "utf8")) as { entities: Record<string, { components: { transform?: { position?: number[] }; mesh?: { source?: { assetId?: string } }; visibility?: { visible?: boolean } } }> };
  for (const e of Object.values(doc.entities)) {
    const id = e.components.mesh?.source?.assetId;
    if (!id || e.components.visibility?.visible === false) continue;
    const f = assetFile(id);
    if (!f) { missingRender.push(`${l.id}: model ${id} not found`); continue; }
    const t = e.components.transform?.position ?? [0, 0, 0];
    for (const tri of gltfTriangles(readGltf(f)) as number[][]) {
      const w = tri.slice();
      for (let k = 0; k < 9; k += 3) { w[k] = w[k]! + l.position[0] + t[0]!; w[k + 1] = w[k + 1]! + l.position[1] + t[1]!; w[k + 2] = w[k + 2]! + l.position[2] + t[2]!; }
      render.add(w);
    }
  }
}
log(`[holes] landmark render: ${render.size} triangles${missingRender.length ? `; missing: ${missingRender.join("; ")}` : ""}`);

// ---- the server
const started = Date.now();
const b = await bootServerBody({ playground: PLAYGROUND, scene: WORLD, peer: "holes-gate", log, terrainCache: !argv.includes("--no-cache") });
log(`[holes] server booted in ${Math.round((Date.now() - started) / 1000)} s`);
const field = b.terrain.resolved.field;
const cs = b.ring.cellSize;
const block = 2 * cs;
const byBlock = new Map<string, P2[]>();
for (const a of anchors) { const key = `${Math.floor(a.p[0] / block)},${Math.floor(a.p[2] / block)}`; if (!byBlock.has(key)) byBlock.set(key, []); }
for (const p of points) {
  const key = `${Math.floor(p[0] / block)},${Math.floor(p[1] / block)}`;
  let a = byBlock.get(key);
  if (!a) byBlock.set(key, (a = []));
  a.push(p);
}
// serpentine order: each hold streams one new strip of cells
const keys = [...byBlock.keys()].map((k) => k.split(",").map(Number) as P2).sort((a, c) => a[1] - c[1] || (a[1] % 2 ? c[0] - a[0] : a[0] - c[0]));
const JITTER: ReadonlyArray<readonly [number, number]> = [[0.07, 0.03], [-0.05, 0.07], [0.03, -0.07], [-0.07, -0.04]];
const faults: HoleFault[] = [];
const unchecked: string[] = [];
let done = 0;
for (const [bx, bz] of keys) {
  const pts = byBlock.get(`${bx},${bz}`)!;
  const cx = (bx + 1) * block - cs, cz = (bz + 1) * block - cs; // the corner the block's 2 x 2 cells share
  const g = field.surfaceCast(cx, cz) ?? field.height(cx, cz);
  // the server's own residency pass for one body standing here (TerrainStreamer.update + statics streaming, as
  // GameServer.tick runs them), repeated until the ring is resident and the cells it left behind are dropped — the
  // scripts and NPCs need not tick for that
  const want = b.ringCells(cx, cz);
  const focus: [number, number, number] = [cx, g + 1, cz];
  const isIn = () => want.every((k) => { const [x, z] = k.split("_").map(Number) as P2; return b.terrain.has(x, z); });
  let held = 0;
  for (; held < 1800 && !isIn(); held++) { b.terrain.update([focus]); b.world.sim.updateStatics([focus]); }
  for (let i = 0; i < 8; i++) { b.terrain.update([focus]); b.world.sim.updateStatics([focus]); }
  // a body standing at any point of the block has every static within a quarter radius of it cooked (the
  // unbudgeted "must" band of PhysicsSim.streamStatics): build them, or a collider tile still queued reads as a hole
  b.world.sim.ensureStaticsAround(cx, cz);
  b.world.sim.setPosition(b.bodyId, [cx, g + 40, cz]);
  const absent = want.filter((k) => { const [x, z] = k.split("_").map(Number) as P2; return !b.terrain.has(x, z); });
  if (absent.length) { unchecked.push(`block at (${cx}, ${cz}): cells ${absent.join(" ")} never resident`); continue; }
  for (const [x, z] of pts) {
    const surface = field.surfaceCast(x, z);
    if (surface === null) continue;
    let surfaceMin = surface;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const s = field.surfaceCast(x + dx, z + dz); if (s !== null && s < surfaceMin) surfaceMin = s; }
    const top = render.top(x, z);
    // from above the band's ceiling too: where a 3D cut (a sea cliff) leaves the field's surface under the mesh's band
    // floor, the mesh caps the column at that floor and a ray started under the cap would see nothing
    const from = Math.max(surface, field.height(x, z), top ?? -Infinity) + 30;
    const cast = (px: number, pz: number): number | null => {
      const hit = b.world.sim.raycast([px, from, pz], [0, -1, 0], from - surface + 120, { solid: true, exclude: [b.bodyId] });
      return hit ? hit.point[1] : null;
    };
    const column = { x, z, surface, surfaceMin, render: top, collider: cast(x, z) };
    let f = classifyColumn(column);
    if (f) {
      // a ray down a triangle edge or vertex of a trimesh can slip through where no body could: a fault must hold
      // for rays a few centimetres off the lattice point too (the highest of them is what the body stands on)
      let best = column.collider;
      for (const [dx, dz] of JITTER) { const y = cast(x + dx, z + dz); if (y !== null && (best === null || y > best)) best = y; }
      f = classifyColumn({ ...column, collider: best });
    }
    if (f) faults.push(f);
  }
  // every spot an arrival can be put on: the anchor, then the queue (corridor: along its forward line; open: two rings)
  for (const a of anchors) {
    if (Math.floor(a.p[0] / block) !== bx || Math.floor(a.p[2] / block) !== bz) continue;
    const base: [number, number, number] = [a.p[0], a.p[1] + PORTAL_LANDING_LIFT, a.p[2]];
    const spots: Array<[number, number, number]> = [base];
    for (let i = 0; i < 18; i++) {
      const s = portalArrivalSpot(base, a.yaw, a.corridor, spots, a.queue);
      if (spots.some((q) => q[0] === s[0] && q[2] === s[2])) break;
      spots.push(s);
    }
    for (const s of spots) {
      const hit = b.world.sim.raycast(s, [0, -1, 0], 4, { solid: true, exclude: [b.bodyId] });
      const f = classifyArrival(s, hit ? hit.point[1] : null, field.density(s[0], s[1], s[2]) < 0);
      if (f) faults.push(f);
    }
  }
  done++;
  if (done % 25 === 0) log(`[holes] ${done}/${keys.length} blocks, ${faults.length} faulty columns, ${Math.round((Date.now() - started) / 1000)} s`);
}

const clusters = clusterFaults(faults, owners);
const falls = clusters.filter((c) => FALLS.has(c.kind));
const sinks = clusters.filter((c) => !FALLS.has(c.kind));
const counts = { columns: points.length, blocks: keys.length, falls: falls.length, fallColumns: faults.filter((f) => FALLS.has(f.kind)).length, sinks: sinks.length, unchecked: unchecked.length };
const ok = falls.length === 0 && unchecked.length === 0;
const report = { tool: "holes", world: WORLD, zone: ZONE ?? null, rect, key: KEY, ok, counts, seconds: Math.round((Date.now() - started) / 1000), falls, sinks: sinks.slice(0, 200), unchecked, missingRender };
if (ZONE) {
  const out = path.join(projectDir, "authoring", "zonegen", WORLD, "zones", ZONE, "reports", "holes.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  log(`[holes] wrote ${path.relative(PLAYGROUND, out)}`);
}
if (JSON_OUT) console.log(JSON.stringify(report));
else {
  console.log(`[holes] ${ok ? "OK" : "FAILED"}: ${counts.falls} fall site(s) (${counts.fallColumns} columns), ${counts.sinks} sink site(s), ${counts.unchecked} unchecked block(s), ${report.seconds} s`);
  const show = argv.includes("--list") ? clusters : falls.slice(0, 20);
  for (const c of show) console.log(`  ${c.kind.padEnd(15)} (${c.x}, ${c.z}) x${c.count}  seen ${c.seen.toFixed(1)} collider ${c.collider === null ? "none" : c.collider.toFixed(1)}  drop ${Number.isFinite(c.worstDrop) ? c.worstDrop.toFixed(1) : "inf"}  near ${c.near}`);
}
b.server.close();
b.terrain.dispose();
b.world.dispose();
process.exit(ok ? 0 : 1);
