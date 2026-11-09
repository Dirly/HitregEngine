/**
 * town-walk — the town pipeline's traversal gate, run against the REAL ground.
 *
 *   npx tsx tools/town-walk.mts --project proving --town brinehold [--scene mmo] [--out <dir>]
 *   [--line "x,z[,y];x,z;...|..."]   also walk straight polylines; a first point with a y starts the body there (a wall-walk, a deck)
 *
 * The survey (town-survey.mts) reads the field; this reads what a player
 * actually stands on. It boots the scene headless exactly as the dedicated
 * server does (HeadlessWorld + TerrainStreamer: the terrain trimesh plus the
 * scatter props' colliders), spawns a player body from the scene's player
 * template and drives it with the server's own PlayerDriver — the same
 * movement rules the client predicts with — along each route:
 *
 *   approach:<road>  from 150 m out along a road that ends at a gate, to the gate
 *   in:<gate>        from the gate along the town's own roads (ramps) to the
 *                    centre of every terrace, then to the town centre
 *
 * A body that makes < 0.6 m of progress in 1.5 s is STUCK there; it then
 * tries three jumps. Every stuck point is reported (and whether a jump got
 * past it), with the ground there. Exit 1 when any route cannot be finished
 * at a run, even with jumps — a "needs a jump" is also a failure for a road.
 */
import fs from "node:fs";
import { isTownStreet } from "./_town-streets.mts";
import { glbBoundsInFrame, planBox } from "./_town-wall-clear.mts";
import path from "node:path";
import {
  HeadlessWorld,
  PlayerDriver,
  TerrainStreamer,
  defaultEvents,
  defaultRegistry,
  defaultScripts,
  extractPlayerTemplate,
  instantiatePlayer,
  loadContent,
  playgroundRoots,
  resolveServerVoxelWorld,
  type PlayerRecord,
} from "../../../packages/server/src/index.ts";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);
const projectName = opt("project", "");
const townName = opt("town", "");
if (!projectName || !townName) {
  console.error("usage: town-walk --project <p> --town <name> [--scene <scene>] [--out <dir>]");
  process.exit(2);
}
const playground = path.resolve(".");
const projectDir = path.resolve("projects", projectName);
const townDoc = JSON.parse(fs.readFileSync(path.join(projectDir, "authoring/towns", `${townName}.json`), "utf8"));
const sceneName = opt("scene", townDoc.scene ?? townDoc.world);

type P2 = [number, number];
type P3 = [number, number, number];

const t0 = Date.now();
const content = loadContent(playgroundRoots(playground, sceneName)); // the scene's closure only, as serve.ts loads it
const doc = content.scenes.get(sceneName);
if (!doc) throw new Error(`no scene ${sceneName}`);
const events = defaultEvents();
const world = await HeadlessWorld.create({
  doc,
  assets: content.assets,
  registry: defaultRegistry(),
  events,
  scripts: defaultScripts(events),
  exclude: (_id, e) => e.tags.includes("player"),
});
const voxel = resolveServerVoxelWorld(world.base);
if (!voxel) throw new Error(`scene ${sceneName} has no voxel world`);
const terrain = new TerrainStreamer(world, voxel, { pool: false });
const field = voxel.field;
const recipe = field.recipe;
const town = recipe.features.towns?.find((t) => t.id === townDoc.town);
if (!town) throw new Error(`no town ${townDoc.town}`);
const template = extractPlayerTemplate(world.expanded);
if (!template) throw new Error(`scene ${sceneName} has no player template`);
console.log(`booted ${sceneName} in ${Date.now() - t0} ms`);

// ---- routes -----------------------------------------------------------------
const roads = recipe.features.roads ?? [];
const gates = town.gates ?? [];
const dist = (a: P2, b: P2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
function densify(points: P2[], step: number): P2[] {
  const out: P2[] = [points[0]!];
  for (let k = 1; k < points.length; k++) {
    const [ax, az] = points[k - 1]!;
    const [bx, bz] = points[k]!;
    const steps = Math.max(1, Math.ceil(dist(points[k - 1]!, points[k]!) / step));
    for (let s = 1; s <= steps; s++) out.push([ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps]);
  }
  return out;
}
/** The part of a polyline from `from` metres to its start, walked toward the start. */
function tailToStart(points: P2[], metres: number): P2[] {
  const d = densify(points, 1);
  return d.slice(0, Math.min(d.length, metres + 1)).reverse();
}
interface Route { id: string; points: P2[]; startY?: number }
const routes: Route[] = [];
/** Metres of each approach road walked, from the far end in to the gate (--approach; default 150). */
const APPROACH = Number(opt("approach", "150"));
for (const g of gates) {
  for (const r of roads) {
    const pts = r.points as P2[];
    if (dist(pts[0]!, g.at as P2) < 4) routes.push({ id: `approach:${r.id}`, points: tailToStart(pts, APPROACH) });
    else if (dist(pts.at(-1)!, g.at as P2) < 4) routes.push({ id: `approach:${r.id}`, points: tailToStart([...pts].reverse(), APPROACH) });
  }
}
// in: gate -> each terrace through the town's own roads (a ramp's nearer end first)
// A door path is a dead-end spur from a street to one door. Chained into the tour it made the walker jump from one
// door straight to the next road THROUGH the buildings between them, so spurs are their own routes (street end -> door).
const isDoorPath = (id: string): boolean => id.startsWith(`${town.id}-door-`);
const townRoads = roads.filter((r) => r.id.startsWith(`${town.id}-`) && !isDoorPath(r.id));
for (const r of roads.filter((x) => isDoorPath(x.id))) {
  const p = r.points as P2[];
  if (p.length < 2) continue;
  // the street end is the one nearer to any street; the door end is the other
  const toStreet = (q: P2): number => Math.min(...townRoads.flatMap((t) => (t.points as P2[]).map((x) => dist(q, x))));
  const ordered = toStreet(p[0]!) <= toStreet(p.at(-1)!) ? p : [...p].reverse();
  routes.push({ id: `spur:${r.id.slice(`${town.id}-door-`.length)}`, points: densify(ordered, 1) });
}
// Once buildings are installed a pad is under a house: the tour skips it (footprint plus 3.2 m).
const tourLayout = path.join(projectDir, "authoring/towns", `${townName}-layout.json`);
const tourFootprints: P2[][] = fs.existsSync(tourLayout)
  ? (JSON.parse(fs.readFileSync(tourLayout, "utf8")) as { buildings: { full?: P2[]; corners?: P2[] }[] }).buildings.map((x) => x.full ?? x.corners ?? [])
  : [];
function inBuilding(p: P2): boolean {
  for (const poly of tourFootprints) {
    let inside = false;
    let near = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i]!;
      const [xj, zj] = poly[j]!;
      if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
      const vx = xj - xi;
      const vz = zj - zi;
      const u = Math.max(0, Math.min(1, ((p[0] - xi) * vx + (p[1] - zi) * vz) / (vx * vx + vz * vz || 1)));
      near = Math.min(near, Math.hypot(p[0] - (xi + vx * u), p[1] - (zi + vz * u)));
    }
    if (inside || near < 3.2) return true; // the planner keeps 2.4 m of steps plus the body clear in front of a house
  }
  return false;
}
/**
 * The platform outlines of a designed town (authoring/towns/<town>-design.json, by recipe terrace id `<town>-<id>`):
 * terrace --from-plan records each platform as a band from one end to the other, and a band's end is on the rim.
 */
const designFile = path.join(projectDir, "authoring/towns", `${townName}-design.json`);
const designPads = new Map<string, P2[]>(
  fs.existsSync(designFile) ? ((JSON.parse(fs.readFileSync(designFile, "utf8")) as { town: string; terraces?: { id: string; polygon: P2[] }[] }).terraces ?? []).map((t) => [`${town.id}-${t.id}`, t.polygon] as [string, P2[]]) : [],
);
/** The point of a pad farthest from its rim (a 1 m grid), skipping house footprints; its middle vertex if none is open. */
function deepestPoint(poly: P2[]): P2 {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const cands: { p: P2; d: number }[] = [];
  for (let x = Math.floor(x0); x <= x1; x++) for (let z = Math.floor(z0); z <= z1; z++) {
    if (!insidePoly(poly, x, z) || inBuilding([x, z])) continue;
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, az] = poly[j]!, [bx, bz] = poly[i]!;
      const vx = bx - ax, vz = bz - az;
      const u = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1)));
      d = Math.min(d, Math.hypot(x - ax - vx * u, z - az - vz * u));
    }
    cands.push({ p: [x, z], d });
  }
  // deepest first, skipping a spot something built stands on within 1.5 m (a square's market cross, a well)
  const occupied = (q: P2): boolean => [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]].some(([dx, dz]) => {
    const x = q[0] + dx!, z = q[1] + dz!, g = field.height(x, z);
    const hit = world.sim.raycast([x, g + 8, z], [0, -1, 0], 7.7, { solid: true });
    return !!hit && !hit.entityId.includes("/terrain");
  });
  cands.sort((a, b) => b.d - a.d);
  for (const c of cands.slice(0, 400)) if (!occupied(c.p)) return c.p;
  return cands[0]?.p ?? poly[Math.floor(poly.length / 2)]!;
}
/** A tour's raw waypoints: once the planner exists, every jump between two roads is re-routed round the buildings. */
const tours = new Map<string, P2[]>();
for (const g of gates) {
  const pts: P2[] = [g.at as P2];
  let here = g.at as P2;
  const left = [...townRoads];
  while (left.length) {
    // the town road whose nearer end is closest to where we stand
    left.sort((a, b) => Math.min(dist(here, a.points[0] as P2), dist(here, a.points.at(-1) as P2)) - Math.min(dist(here, b.points[0] as P2), dist(here, b.points.at(-1) as P2)));
    const r = left.shift()!;
    const p = r.points as P2[];
    const ordered = dist(here, p[0]!) <= dist(here, p.at(-1)!) ? p : [...p].reverse();
    pts.push(...ordered);
    here = ordered.at(-1)!;
  }
  for (const t of [...(town.terraces ?? [])].sort((a, b) => dist(here, a.points[0] as P2) - dist(here, b.points[0] as P2))) {
    // the pad's deepest open point (farthest from its rim, off every house). A vertex of a big pad is on its rim, and
    // the rim of a walled town's floor runs under or past its curtain (Bell Strand: the tour was sent into the wall);
    // a curved pad's centroid can lie off it (a strand round a lake: in the water)
    const plat = designPads.get(t.id);
    const ends = t.points as P2[];
    const mid = plat ? deepestPoint(plat) : ends.length === 2 ? ([(ends[0]![0] + ends[1]![0]) / 2, (ends[0]![1] + ends[1]![1]) / 2] as P2) : ends[Math.floor(ends.length / 2)]!;
    if (inBuilding(mid)) continue; // a building stands on this pad now: its door spur is the proof it is reached
    pts.push(mid);
    here = mid;
  }
  if (!inBuilding(town.center as P2)) pts.push(town.center as P2);
  routes.push({ id: `in:${g.id}`, points: densify(pts, 1) });
  tours.set(`in:${g.id}`, pts);
}

// to: --to "x,z;x,z" — places with no road (a quest site, a cache on the beach): a path is PLANNED over the
// ground from the first gate (A* on a 1 m grid of the topmost solid, dry, <= the climb limit, steeper costs more)
// and then walked like any other route. No plan = the place is cut off from the town.
/** Planned routes stay under 40°: the body CAN climb 50° on smooth ground, but raw voxel banks at that pitch stall it. */
const CLIMB_TAN = Math.tan((40 * Math.PI) / 180);
/** Building footprints from authoring/towns/<town>-layout.json — the planner walks round them. */
const layoutFile = path.join(projectDir, "authoring/towns", `${townName}-layout.json`);
const layoutDoc = fs.existsSync(layoutFile) ? (JSON.parse(fs.readFileSync(layoutFile, "utf8")) as { buildings: { id: string; corners: P2[]; door: P2; centre: P2; facing: P2; size: [number, number] }[] }) : null;
function insidePoly(poly: P2[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
/** A footprint grown by m metres about its centre (rectangles: scale each corner out along its diagonal). */
function grow(poly: P2[], m: number): P2[] {
  const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length;
  const cz = poly.reduce((a, q) => a + q[1], 0) / poly.length;
  return poly.map(([x, z]) => { const dx = x - cx; const dz = z - cz; const l = Math.hypot(dx, dz) || 1; return [x + (dx / l) * m * 1.42, z + (dz / l) * m * 1.42] as P2; });
}
/**
 * What a building really occupies: its footprint plus what the kit hangs off it — front steps/porticos/jetties
 * (2.4 m), back (1.8 m), sides (1.4 m) — measured off the WFC output — plus the player's radius (0.4 m).
 */
const ENVELOPE = { front: 2.4, back: 1.8, side: 1.4, body: 0.4 };
function envelope(b: { centre: P2; facing: P2; size?: [number, number]; corners: P2[] }): P2[] {
  const [cx, cz] = b.centre;
  const f = b.facing;
  const r: P2 = [-f[1], f[0]];
  const W = Math.hypot(b.corners[1]![0] - b.corners[0]![0], b.corners[1]![1] - b.corners[0]![1]) / 2 + ENVELOPE.side + ENVELOPE.body;
  const D = Math.hypot(b.corners[2]![0] - b.corners[1]![0], b.corners[2]![1] - b.corners[1]![1]) / 2;
  const front = D + ENVELOPE.front + ENVELOPE.body;
  const back = D + ENVELOPE.back + ENVELOPE.body;
  const at = (a: number, fw: number): P2 => [cx + r[0] * a + f[0] * fw, cz + r[1] * a + f[1] * fw];
  return [at(-W, front), at(W, front), at(W, -back), at(-W, -back)];
}
/**
 * The SHIPPED model's plan box where it exists (assets/models/towns/<town>/<model>.glb, read in the lot's own frame):
 * the kit hangs steps, skirts and towers 0.5-5 m past the layout outline, and a route planned round the outline ran
 * the body into the Bell Watch's skirt (Saltharrow 2026-10-29). Else the layout outline, else the generic envelope.
 */
function shippedBox(b: { id: string; centre: P2; yaw?: number; preRot?: number; model?: string }): P2[] | null {
  const file = path.join(projectDir, "assets", "models", "towns", townName, `${b.model ?? b.id}.glb`);
  if (!fs.existsSync(file) || typeof b.yaw !== "number") return null;
  const yaw = b.yaw + (b.preRot ?? 0);
  const f = glbBoundsInFrame(file, yaw);
  const pb = planBox(b.id, [b.centre[0], 0, b.centre[1]], yaw, f.lo, f.hi);
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const at = (lx: number, lz: number): P2 => [pb.cx + c * lx + sn * lz, pb.cz - sn * lx + c * lz];
  // body radius 0.4 + 0.2 m: with no shoulder margin beside a building (below) the route may hug the outline
  return grow([at(-pb.hx, -pb.hz), at(pb.hx, -pb.hz), at(pb.hx, pb.hz), at(-pb.hx, pb.hz)], 0.6);
}
const obstacles = (layoutDoc?.buildings ?? []).map((b) => shippedBox(b as never) ?? ((b as { ground?: P2[] }).ground ? grow((b as { ground: P2[] }).ground, 0.4) : envelope(b)));
/**
 * A thin built landmark (a palisade, a fence-thin wall operator) can pass BETWEEN the 1 m grid samples, so the planner
 * routed straight through it (Reedholt's 0.6 m palisade, T-D2). A cell whose centre has a landmark collider within the
 * body's reach (0.45 m, 8 directions, at hip height) is blocked: the body (radius 0.4) cannot stand there anyway.
 * Landmarks only: door jambs and stair rails of buildings keep their exact 1 m sampling.
 */
const REACH_DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071]];
function thinLandmarkNear(x: number, foot: number, z: number): unknown {
  for (const [dx, dz] of REACH_DIRS) {
    const hit = world.sim.raycast([x, foot + 1, z], [dx, 0, dz], 0.45, { solid: true });
    if (hit && /landmark|lmc_/.test(hit.entityId)) return hit;
  }
  return null;
}
/**
 * A cell INSIDE a thick mesh collider (a 2.4 m kit curtain): a trimesh has no inside, so the rays from 3 m over the
 * ground and up from the foot both start in it and pass through to the terrain and the open air: the planner routed
 * a tour straight through Bell Strand's curtain. A face overhead with no underside between it and the foot is the top
 * of a solid the cell stands in; an arch, an eave or a stall roof has its underside in between.
 */
function insideSolid(x: number, foot: number, z: number): { entityId: string } | null {
  const over = world.sim.raycast([x, foot + 12, z], [0, -1, 0], 9.5, { solid: true });
  if (!over || over.entityId.includes("/terrain")) return null;
  const under = world.sim.raycast([x, foot + 0.3, z], [0, 1, 0], Math.max(0.05, over.point[1] - foot - 0.35), { solid: true });
  return under ? null : { entityId: `${over.entityId} (inside)` };
}
function plan(from: P2, to: P2): P2[] | null {
  const pad = 60;
  const x0 = Math.floor(Math.min(from[0], to[0]) - pad);
  const z0 = Math.floor(Math.min(from[1], to[1]) - pad);
  const w = Math.ceil(Math.max(from[0], to[0]) + pad) - x0;
  const h = Math.ceil(Math.max(from[1], to[1]) + pad) - z0;
  const H = new Float32Array(w * h);
  const ok = new Uint8Array(w * h);
  /** 1 where the floor is a BUILT surface (a stair, a deck, a floor), not terrain: stairs climb steeper than any slope */
  const built = new Uint8Array(w * h);
  /** 1 where a cell is closed ONLY by a building outline, which is already grown by the body's radius (0.4 m) */
  const byHouse = new Uint8Array(w * h);
  // The grid is sampled from the PHYSICS world the body will walk (terrain + buildings + landmarks + props), not
  // the field: a downward ray from 3 m over the ground finds what a foot lands on (a quay deck, a stair step, a
  // floor), and an upward ray over it finds what a head hits (a wall, a pillar, a tower) — blocked. Without this
  // the planner routed straight up a bank a DC stair had just been built on.
  const cells = new Set<string>();
  for (let cz = Math.floor(z0 / recipe.cellSize); cz <= Math.floor((z0 + h) / recipe.cellSize); cz++)
    for (let cx = Math.floor(x0 / recipe.cellSize); cx <= Math.floor((x0 + w) / recipe.cellSize); cx++)
      if (!cells.has(`${cx},${cz}`)) { cells.add(`${cx},${cz}`); terrain.ensureAround((cx + 0.5) * recipe.cellSize, (cz + 0.5) * recipe.cellSize, 0); }
  world.step(); // colliders of freshly ensured cells join the query world
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = x0 + i;
      const z = z0 + j;
      const g = field.height(x, z);
      const top = field.surfaceCast(x, z, g + 40, g - 40) ?? g;
      // a ray that STARTS inside a solid (the masonry over a gate arch, a lintel, an eave lower than 3 m) hits at once:
      // that is a roof over the ground, not a floor, so cast again from head height under it (Saltharrow's land gate
      // read as a closed wall and no door route could leave it)
      let down = world.sim.raycast([x, top + 3, z], [0, -1, 0], 8, { solid: true });
      if (down && down.point[1] > top + 2.9) down = world.sim.raycast([x, top + 1.9, z], [0, -1, 0], 6.9, { solid: true });
      const foot = down ? down.point[1] : top;
      if (down && !down.entityId.includes("/terrain")) built[i + j * w] = 1;
      const head = world.sim.raycast([x, foot + 0.3, z], [0, 1, 0], 1.5, { solid: true }) ?? thinLandmarkNear(x, foot, z) ?? insideSolid(x, foot, z);
      H[i + j * w] = foot;
      const water = field.waterY(x, z);
      // a building's footprint is closed: its door is open and its floor is walkable, so without this a route to the
      // far side of a house went in at the door and stopped at the back wall
      const housed = obstacles.some((poly) => insidePoly(poly, x, z));
      ok[i + j * w] = !housed && foot >= recipe.seaLevel + 0.2 && !(water !== null && water > foot + 0.3) && !head ? 1 : 0;
      if (housed && foot >= recipe.seaLevel + 0.2 && !head) byHouse[i + j * w] = 1;
      if (process.env.TOWN_WALK_WHY && !ok[i + j * w] && Math.hypot(x - from[0], z - from[1]) < 7 && (i + j) % 3 === 0)
        console.log(`    cell [${x}, ${z}] y ${foot.toFixed(1)}: ${housed ? "housed " : ""}${head ? `head ${(head as { entityId?: string }).entityId ?? "?"} ` : ""}${water !== null && water > foot + 0.3 ? "water" : ""}`);
    }
  // shoulders: a cell is open only if its 8 neighbours are too (about a metre of width for a 0.8 m body)
  const open0 = ok.slice();
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const k = i + j * w;
      if (!open0[k]) continue;
      // a neighbour closed only by a building's grown outline does not narrow the lane again: the outline already
      // carries the body's radius (a 2.4 m passage inside Saltharrow's land gate read as closed by counting it twice)
      for (let dj = -1; dj <= 1 && ok[k]; dj++) for (let di = -1; di <= 1; di++) if (!open0[k + di + dj * w] && !byHouse[k + di + dj * w]) { ok[k] = 0; break; }
    }
  // edges cost more: a cell beside a drop of > 0.5 m (a stair's cheek wall, a quay lip, a bank) is where a body
  // falls off or wedges, so routes keep to the middle of stairs and streets
  const edge = new Float32Array(w * h);
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const k = i + j * w;
      let m = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) m = Math.max(m, Math.abs(H[k + di + dj * w]! - H[k]!));
      edge[k] = m > 0.5 ? 4 : 0;
    }
  const idx = (p: P2): number => Math.round(p[0] - x0) + Math.round(p[1] - z0) * w;
  const start0 = idx(from);
  const goal0 = idx(to);
  // the target and its neighbours stay open: a door sits right beside its own steps and walls, which the shoulder
  // margin would otherwise close — the physics walk is the judge of whether it is really reachable
  for (const k0 of [start0, goal0]) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const k = k0 + di + dj * w; if (k >= 0 && k < w * h && open0[k]) ok[k] = 1; }
  // an end that is itself closed (a road point under a statue, a pad a house now stands on) moves to the nearest
  // open cell within 6 m: the route still has to get THERE on real ground
  const snap = (k0: number): number => {
    if (k0 >= 0 && k0 < w * h && ok[k0]) return k0;
    let best = k0;
    let bd = Infinity;
    for (let dj = -6; dj <= 6; dj++)
      for (let di = -6; di <= 6; di++) {
        const i = (k0 % w) + di;
        const j = Math.floor(k0 / w) + dj;
        if (i < 0 || j < 0 || i >= w || j >= h || !ok[i + j * w]) continue;
        const d = Math.hypot(di, dj);
        if (d < bd) { bd = d; best = i + j * w; }
      }
    return best;
  };
  const start = snap(start0);
  const goal = snap(goal0);
  const g = new Float64Array(w * h).fill(Infinity);
  const came = new Int32Array(w * h).fill(-1);
  const open: number[] = [start];
  const f = new Float64Array(w * h).fill(Infinity);
  g[start] = 0;
  const hx = (k: number): number => Math.hypot((k % w) - (goal % w), Math.floor(k / w) - Math.floor(goal / w));
  f[start] = hx(start);
  const closed = new Uint8Array(w * h);
  /** One step between neighbouring cells by height alone. */
  const stepOk = (c: number, k: number, run: number): boolean => {
    const grade = Math.abs(H[k]! - H[c]!) / run;
    // a flight of stairs (both cells built) may rise ~45° — steps the body autosteps; terrain keeps the 40° cap
    if (grade > (built[k] && built[c] ? 1.5 : CLIMB_TAN)) return false;
    // a ledge onto (or off) a built surface higher than the body's 0.35 m step (a dais, a plinth, a quay lip): the
    // grade rule took a 0.45 m market-cross dais for a slope and sent the tour into it
    return !(built[k] !== built[c] && Math.abs(H[k]! - H[c]!) > 0.35);
  };
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (f[open[k]!]! < f[open[bi]!]!) bi = k;
    const c = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (c === goal) break;
    if (closed[c]) continue;
    closed[c] = 1;
    const ci = c % w;
    const cj = (c - ci) / w;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const ii = ci + di;
      const jj = cj + dj;
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
      const k = ii + jj * w;
      if (!ok[k] || closed[k]) continue;
      const run = di && dj ? Math.SQRT2 : 1;
      const grade = Math.abs(H[k]! - H[c]!) / run;
      if (!stepOk(c, k, run)) continue;
      // a diagonal may not cut a corner: one of its two square-on paths must be walkable too (Bell Strand 10-30: a
      // diagonal down the bank at a retaining wall's end crossed the wall's coping, which the body could not)
      if (di && dj) { const a1 = ci + di + cj * w, a2 = ci + (cj + dj) * w; if (!((ok[a1] && stepOk(c, a1, 1) && stepOk(a1, k, 1)) || (ok[a2] && stepOk(c, a2, 1) && stepOk(a2, k, 1)))) continue; }
      // a wall BETWEEN two open cells (a hollow tower's shell, a curtain's face: a trimesh is open inside, so both
      // cells read clear) or a post thinner than a cell (a market cross's shaft): rays at the body's knee from one cell
      // to the next, down the middle and at both shoulders (0.4 m)
      const ky = Math.max(H[k]!, H[c]!) + 0.6, sx = (-dj / run) * 0.4, sz = (di / run) * 0.4;
      if ([0, 1, -1].some((m) => world.sim.raycast([x0 + ci + sx * m, ky, z0 + cj + sz * m], [di, 0, dj], run, { solid: true }))) continue;
      const cost = g[c]! + run * (1 + 4 * grade * grade + edge[k]!);
      if (cost < g[k]!) { g[k] = cost; came[k] = c; f[k] = cost + hx(k); open.push(k); }
    }
  }
  // a goal ON a ledge's lip (a town centre the street kerb moved a riser face under, Saltharrow 10-29: the open cell at
  // the riser top was an island the shoulder margin cut off, 1 m from the street below it) is reached from the open
  // cell beside it: within 2.5 m the route ends there, and the physics walk judges the rest. Farther is a real fault.
  let goalAt = goal;
  if (came[goal] === -1 && goal !== start) {
    let near = -1, nd = Infinity;
    for (let k = 0; k < w * h; k++) if (closed[k]) { const d = hx(k); if (d < nd) (nd = d), (near = k); }
    if (near >= 0 && nd <= 2.5) { if (process.env.TOWN_WALK_WHY) console.log(`  WHY ${from.map(Math.round)} -> ${to.map(Math.round)}: goal on an island, ending ${nd.toFixed(1)} m short on open ground`); goalAt = near; }
  }
  if (came[goalAt] === -1 && goalAt !== start) {
    if (process.env.TOWN_WALK_WHY) {
      // where the search stalled: the reached cell nearest the goal, and the grid round it (# closed, . open, s/g ends)
      let near = start, nd = Infinity, reached = 0;
      for (let k = 0; k < w * h; k++) if (closed[k]) { reached++; const d = hx(k); if (d < nd) (nd = d), (near = k); }
      console.log(`  WHY ${from.map(Math.round)} -> ${to.map(Math.round)}: ${reached} cells reached; nearest [${x0 + (near % w)}, ${z0 + Math.floor(near / w)}] y ${H[near]!.toFixed(1)}, ${nd.toFixed(0)} m short`);
      for (const [lab, c0] of [["near", near], ["start", start]] as const) for (let dj = -6; dj <= 6; dj++) {
        const near = c0;
        let row = `    ${dj === -6 ? lab.padEnd(6) : "      "}`;
        for (let di = -10; di <= 10; di++) { const k = near + di + dj * w; row += k === near ? "@" : !ok[k] ? "#" : H[k]! - H[near]! > 0.6 ? "^" : H[near]! - H[k]! > 0.6 ? "v" : "."; }
        console.log(row);
      }
    }
    return null;
  }
  const out: P2[] = [];
  for (let k = goalAt; k !== -1; k = came[k]!) out.push([x0 + (k % w), z0 + Math.floor(k / w)]);
  return out.reverse();
}
const unplanned: string[] = [];
// A tour runs each street end to end; where one street's end is not the next one's start (a lane joins a street
// part-way along), the straight line between them can cut through a house. Those jumps are planned over real ground.
for (const [id, pts] of tours) {
  const out: P2[] = [pts[0]!];
  for (let k = 1; k < pts.length; k++) {
    const a = out.at(-1)!;
    const b = pts[k]!;
    const leg = dist(a, b) > 4 ? plan(a, b) : null;
    if (dist(a, b) > 4 && !leg) console.log(`  note ${id}: no planned way from [${a.map(Math.round)}] to [${b.map(Math.round)}]; walking the straight line`);
    out.push(...(leg ? leg.slice(1) : [b]));
  }
  if (process.env.TOWN_WALK_WHY) console.log(`  tour ${id} waypoints: ${pts.map((q) => q.map(Math.round).join(",")).join(" ")}`);
  routes.find((r) => r.id === id)!.points = densify(out, 1);
}
const toOpt = opt("to", "");
if (toOpt && gates.length) {
  for (const spec of toOpt.split(";")) {
    const [x, z] = spec.split(",").map(Number) as P2;
    const path_ = plan(gates[0]!.at as P2, [x, z]);
    if (!path_) { unplanned.push(`to:${x},${z}`); console.log(`  FAIL to:${x},${z} — no walkable ground connects it to ${gates[0]!.id}`); continue; }
    routes.push({ id: `to:${Math.round(x)},${Math.round(z)}`, points: path_ });
  }
}
for (const [n, spec] of opt("line", "").split("|").filter(Boolean).entries()) {
  // a line's first point may carry a third number: the height to start the body at (on a wall-walk, a deck, a roof)
  const pts = spec.split(";").map((q) => q.split(",").map(Number));
  const startY = pts[0]!.length > 2 ? pts[0]![2] : undefined;
  routes.push({ id: `line:${n}`, points: densify(pts.map((q) => [q[0]!, q[1]!] as P2), 1), ...(startY !== undefined ? { startY } : {}) });
}
if (flag("doors") && layoutDoc && gates.length) {
  for (const b of layoutDoc.buildings) {
    // plan to the street 8 m out in front of the door, then walk straight in: the last stretch is the entrance
    const fr = (b as { facing: P2 }).facing;
    // the street in front of the door: on a terrace band the street runs along the brow, and 8 m straight out from a
    // door is down the riser on the band below (Saltharrow 2026-10-29), so the nearest town street point within 10 m wins
    let front: P2 = [b.door[0] + fr[0] * 8, b.door[1] + fr[1] * 8];
    let best = 10;
    for (const r of recipe.features.roads) {
      if (!isTownStreet(r.id, town.id)) continue;
      const pts = r.points as P2[];
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1]!, c = pts[k]!, dx = c[0] - a[0], dz = c[1] - a[1], l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((b.door[0] - a[0]) * dx + (b.door[1] - a[1]) * dz) / l2));
        const q: P2 = [a[0] + dx * t, a[1] + dz * t], d = Math.hypot(q[0] - b.door[0], q[1] - b.door[1]);
        if (d < best) (best = d), (front = q);
      }
    }
    const toFront = plan(gates[0]!.at as P2, front);
    const route = toFront ? [...toFront, ...densify([front, b.door], 1).slice(1)] : null;
    if (!route) { unplanned.push(`door:${b.id}`); console.log(`  FAIL door:${b.id} — no walkable ground connects it to ${gates[0]!.id}`); continue; }
    routes.push({ id: `door:${b.id}`, points: route });
  }
}
if (flag("only-to")) routes.splice(0, routes.length, ...routes.filter((r) => r.id.startsWith("to:") || r.id.startsWith("line:") || r.id.startsWith("door:")));

// ---- the walker ---------------------------------------------------------------
const PEER = "surveyor";
const players = new Map<string, PlayerRecord>();
const driver = new PlayerDriver(world, players, template.controller, {});
world.beforeStep.add(driver.step);
const RUN = typeof template.controller["speed"] === "number" ? (template.controller["speed"] as number) : 6.5;

interface Stuck { at: P3; along: number; ground: number; jumped: boolean; touching: string[] }
interface WalkResult { id: string; metres: number; finished: boolean; reached: number; stuck: Stuck[]; trail: P3[]; seconds: number }

function ensureTerrain(points: P2[]): void {
  const cell = recipe.cellSize;
  const seen = new Set<string>();
  for (const [x, z] of points) {
    const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    terrain.ensureAround(x, z, 1);
  }
}

let seq = 0;
function walk(route: Route): WalkResult {
  ensureTerrain(route.points);
  const [sx, sz] = route.points[0]!;
  const bodyId = `player:${PEER}`;
  if (world.entities.has(bodyId)) world.removeEntities(world.subtree(bodyId), { silent: true });
  players.clear();
  const start: P3 = [sx, (route.startY ?? field.height(sx, sz)) + 1.2, sz];
  const spawned = instantiatePlayer(template!, PEER, start, 0);
  world.addEntities({ ...world.base, entities: spawned.server });
  const record = {
    peerId: PEER, name: PEER, bodyId, ids: Object.keys(spawned.server), input: null, appliedSeq: 0,
    disconnectedAt: null, identity: null, rev: {}, commitPhase: 0, committing: null, transferring: null,
  } as PlayerRecord;
  players.set(PEER, record);
  for (let i = 0; i < 30; i++) world.step(); // settle onto the ground

  const pts = route.points;
  // cumulative distance along the route
  const along: number[] = [0];
  for (let k = 1; k < pts.length; k++) along.push(along[k - 1]! + dist(pts[k - 1]!, pts[k]!));
  const total = along.at(-1)!;
  let best = 0; // index of the furthest route point reached
  let bestAt = 0; // sim seconds when best last advanced
  const stuck: Stuck[] = [];
  const trail: P3[] = [];
  /** The first stuck moment, recorded only if walking round it fails too. */
  let pendingStuck: Stuck | null = null;
  let jumps = 0;
  let jumpedHere = false;
  /** Sidestep in progress: +1 left / -1 right, until this sim time. */
  let side = 0;
  let sideUntil = 0;
  let sidesTried = 0;
  const dt = world.fixedDt;
  const maxSeconds = total / RUN * 3 + 20;
  let t = 0;
  for (; t < maxSeconds; t += dt) {
    const p = world.positionOf(bodyId);
    if (!p) break;
    // advance the route cursor: nearest route point ahead of `best` within 2 m
    for (let k = best; k < Math.min(pts.length, best + 12); k++) {
      if (dist([p[0], p[2]], pts[k]!) < 1.6 && k > best) { if (k > best + 2) { sidesTried = 0; pendingStuck = null; } best = k; bestAt = t; jumps = 0; jumpedHere = false; }
    }
    if (best >= pts.length - 2) break;
    if (Math.round(t / dt) % 15 === 0) trail.push([+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2)]);
    // steer at a point 3 m ahead of the cursor
    const aim = pts[Math.min(pts.length - 1, best + 3)]!;
    let dx = aim[0] - p[0];
    let dz = aim[1] - p[2];
    const l = Math.hypot(dx, dz) || 1;
    dx = (dx / l) * RUN;
    dz = (dz / l) * RUN;
    let jump = false;
    if (side !== 0 && t < sideUntil) {
      // walk round: mostly sideways, a little forward
      const sx = -dz * side;
      const sz = dx * side;
      dx = sx * 0.9 + dx * 0.3;
      dz = sz * 0.9 + dz * 0.3;
    } else side = 0;
    if (t - bestAt > 1.5 && side === 0 && sidesTried < 2) {
      const here: P3 = [+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1)];
      if (sidesTried === 0) {
        const near = world.sim.overlapSphere([p[0], p[1], p[2]], 1.2).filter((id) => !id.startsWith(bodyId));
        const touching = near.map((id) => { const e = world.entities.get(id); return e ? `${id} (${e.name}${e.prefab ? `, ${e.prefab}` : ""})` : id; });
        pendingStuck = { at: here, along: Math.round(along[best]!), ground: +field.height(p[0], p[2]).toFixed(1), jumped: false, touching };
      }
      side = sidesTried === 0 ? 1 : -1;
      sideUntil = t + 1.2;
      sidesTried++;
      bestAt = t;
    }
    if (t - bestAt > 1.5 && side === 0 && sidesTried >= 2) {
      const here: P3 = [+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1)];
      if (jumps === 0 && pendingStuck) { stuck.push(pendingStuck); pendingStuck = null; }
      void here;
      if (jumps < 3) { jump = true; jumps++; jumpedHere = true; bestAt = t - 0.3; }
      else break; // stuck for good
    }
    if (jumpedHere && stuck.length && best > 0 && t - bestAt < dt * 2) stuck.at(-1)!.jumped = true;
    record.input = { v: [dx, dz], jump, vy: 0, yaw: Math.atan2(dx, dz), seq: ++seq, at: Date.now() };
    world.step();
  }
  const finished = best >= pts.length - 2;
  // a stuck point is "jumped" only if the body got past it afterwards
  for (const s of stuck) s.jumped = s.jumped || (finished || along[best]! > s.along + 3);
  return { id: route.id, metres: Math.round(total), finished, reached: Math.round(along[best]!), stuck, trail, seconds: +t.toFixed(1) };
}

const results = routes.map((r) => {
  const res = walk(r);
  const tag = res.finished ? (res.stuck.length ? "JUMP" : "ok  ") : "FAIL";
  console.log(`  ${tag} ${res.id.padEnd(34)} ${String(res.reached).padStart(4)} / ${res.metres} m in ${res.seconds} s`);
  for (const s of res.stuck) console.log(`       stuck at ${s.along} m [${s.at.join(", ")}] ground ${s.ground} — ${s.jumped ? "a jump got past" : "no way past"}; touching: ${s.touching.join("; ") || "nothing but ground"}`);
  return res;
});

const outDir = path.resolve(opt("out", path.join(projectDir, "authoring/towns/survey")));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${townName}-walk.json`), `${JSON.stringify({ town: townName, scene: sceneName, runSpeed: RUN, routes: results }, null, 1)}\n`);
console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, `${townName}-walk.json`))} (${Date.now() - t0} ms)`);
terrain.dispose();
world.dispose();
const failed = [...results.filter((r) => !r.finished || r.stuck.length > 0).map((r) => r.id), ...unplanned];
if (failed.length) {
  console.log(`WALK FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("WALK OK");
process.exit(0);
