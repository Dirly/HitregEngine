/**
 * town-layout — stage 3 of the town pipeline: the plan's lots become world placements, checked against the ground.
 *
 *   npx tsx tools/town-layout.mts --project proving --town brinehold [--no-map]
 *
 * Reads authoring/towns/<town>-plan.json. Each building sits on a terrace (or the town pad) at `u` metres
 * along the terrace's centreline, on the `east` (+v, the terrace's left) or `west` side of the street that
 * runs there — the town's own road where one crosses that stretch, else the centreline — with its FRONT on
 * the street, `setback` metres back from the road edge. Footprints are the WFC request's size in 3.2 m cells
 * (width along the street, depth away from it).
 *
 * Checks (exit 1 on any): the footprint is on its shelf (inside radius), the ground under it is flat
 * (<= 0.8 m spread on the topmost solid), it is dry, it keeps 0.5 m off every road's edge, it keeps 1 m
 * off every other lot (so jetties, dormers and chimneys have air), every resident's home and work exist,
 * and the plan covers every required service.
 *
 * Writes authoring/towns/<town>-layout.json (per building: centre, yaw, groundY, corners, door) and
 * authoring/towns/survey/<town>-plan.png (the survey map with the lots drawn and labelled; needs Playwright).
 */
import fs from "node:fs";
import path from "node:path";
import { createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const projectName = opt("project", "");
const townName = opt("town", "");
if (!projectName || !townName) {
  console.error("usage: town-layout --project <p> --town <name>");
  process.exit(2);
}
const CELL = 3.2;
const projectDir = path.resolve("projects", projectName);
const townsDir = path.join(projectDir, "authoring/towns");
const townDoc = JSON.parse(fs.readFileSync(path.join(townsDir, `${townName}.json`), "utf8"));
const plan = JSON.parse(fs.readFileSync(path.join(townsDir, `${townName}-plan.json`), "utf8"));
const recipeFile = path.join(projectDir, "assets/worlds", `${townDoc.world}.json`);
const recipeRaw = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
// EARTHWORKS: --terrace "id=radius[:groundY],…" widens (or re-levels) shelves in memory; --write-earthworks persists
// them to the world recipe (validated) once the lots fit. The program decides how much flat ground a town needs.
// "id=radius[:groundY][@dx;dz]" — @ moves the whole shelf (e.g. seaward onto filled ground)
const earthworks = opt("terrace", "").split(",").filter(Boolean).map((spec) => {
  const [id, rest] = spec.split("=");
  const [dims, move] = rest!.split("@");
  const [r, y] = dims!.split(":").map(Number);
  const [dx, dz] = (move ?? "0;0").split(";").map(Number);
  return { id: id!, radius: r!, groundY: y, dx: dx!, dz: dz! };
});
for (const e of earthworks) {
  const t = recipeRaw.features.towns.flatMap((tw: { terraces: { id: string }[] }) => tw.terraces).find((t: { id: string }) => t.id === e.id);
  if (!t) throw new Error(`no terrace ${e.id}`);
  t.radius = e.radius;
  if (Number.isFinite(e.groundY)) t.groundY = e.groundY;
  if (e.dx || e.dz) t.points = t.points.map((q: [number, number]) => [Math.round((q[0] + e.dx) * 100) / 100, Math.round((q[1] + e.dz) * 100) / 100]);
}
const recipe: WorldRecipe = worldRecipeSchema.parse(recipeRaw);
const field = createWorldField(recipe);
const town = recipe.features.towns.find((t) => t.id === townDoc.town);
if (!town) throw new Error(`no town ${townDoc.town}`);

type P = [number, number];
const ground = (x: number, z: number): number => {
  const h = field.height(x, z);
  return field.surfaceCast(x, z, h + 40, h - 40) ?? h;
};
function distToPolyline(pts: P[], x: number, z: number): number {
  let best = Infinity;
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1]!;
    const [bx, bz] = pts[k]!;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  if (pts.length === 1) best = Math.hypot(x - pts[0]![0], z - pts[0]![1]);
  return best;
}

// door paths (town-ground doors) are painted AFTER the lots are placed and run to each door: they are neither a street a lot
// fronts nor an obstacle to keep clear of. Treating them as roads made a re-run of this tool move installed lots.
const isDoorPath = (id: string): boolean => id.startsWith(`${town.id}-door-`);
const ownRoads = recipe.features.roads.filter((r) => r.id.startsWith(`${town.id}-`) && !isDoorPath(r.id));
// the town's own lanes are DRAWN from the lots (--write-lanes), so they are not obstacles to them
const allRoads = recipe.features.roads.filter((r) => !isDoorPath(r.id) && !r.id.startsWith(`${town.id}-lane-`) && r.points.some((p) => Math.hypot(p[0] - town.center[0], p[1] - town.center[1]) < town.radius + 150));

interface Placed {
  id: string;
  name: string;
  district: string;
  terrace: string;
  size: [number, number];
  centre: P;
  groundY: number;
  /** Radians about +Y that turn the building's local +Z (its front) toward the street. */
  yaw: number;
  facing: P;
  corners: P[];
  /** What the built building occupies below ~2 m (steps, stair wings, plinths): walking and roads are judged on it. */
  ground: P[];
  /** Everything, roofs and eaves included: buildings may not intersect each other's. */
  full: P[];
  door: P;
  problems: string[];
}
/** Measured by MMO/WFC/wfc/measure_envelopes.py: extents beyond the requested footprint, in cells. */
type Ext = { left: number; right: number; front: number; back: number };
const envFile = path.join(townsDir, `${townName}-envelopes.json`);
const measured = fs.existsSync(envFile) ? (JSON.parse(fs.readFileSync(envFile, "utf8")) as Record<string, { full: Ext; ground: Ext }>) : {};
const DEFAULT_EXT = { full: { left: 0.45, right: 0.45, front: 0.75, back: 0.55 }, ground: { left: 0.4, right: 0.4, front: 0.55, back: 0.55 } };
const extOf = (id: string): { full: Ext; ground: Ext } => measured[`bh_${id.replace(/-/g, "_")}`] ?? measured[id] ?? DEFAULT_EXT;
/** Blender Rz (radians) that turns a building so its door wall faces its local front (-y): a side door becomes the front. */
const PRE_ROT: Record<string, number> = { "-y": 0, "+x": -Math.PI / 2, "+y": Math.PI, "-x": Math.PI / 2 };
/** The measured extents as seen after that turn (the side that becomes the front takes its extent with it). */
function rotExt(e: Ext, door: string): Ext {
  if (door === "+x") return { front: e.right, left: e.front, back: e.left, right: e.back };
  if (door === "-x") return { front: e.left, right: e.front, back: e.right, left: e.back };
  if (door === "+y") return { front: e.back, back: e.front, left: e.right, right: e.left };
  return e;
}
/** A lot may reuse another building's model (`model`: its id): the town fills out with the houses already built. */
const buildOf = (id: string): { request: { size: [number, number] } } | undefined => (plan.buildings as { id: string; request: { size: [number, number] } }[]).find((q) => q.id === id);
function nearestOn(pts: P[], x: number, z: number): P {
  let best: P = pts[0]!;
  let bd = Infinity;
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1]!;
    const [bx, bz] = pts[k]!;
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const q: P = [ax + dx * t, az + dz * t];
    const d = Math.hypot(q[0] - x, q[1] - z);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
// lot vs lot: 1 m of air between footprints (separating axis on the rectangles, grown by 0.5 m each)
function overlaps(p: P[], q: P[], gap = 1): boolean {
  const axes = [p, q].flatMap((poly) => [0, 1].map((k) => { const a = poly[k]!; const b = poly[k + 1]!; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l] as P; }));
  for (const ax of axes) {
    const proj = (poly: P[]): [number, number] => { const s = poly.map((c) => c[0] * ax[0] + c[1] * ax[1]); return [Math.min(...s) - gap / 2, Math.max(...s) + gap / 2]; };
    const [a0, a1] = proj(p);
    const [b0, b1] = proj(q);
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}
/** A building's ground outline grown by m metres (the player's radius). */
function grownEnvelope(p: Placed, m: number): P[] {
  const cx = p.ground.reduce((a, q) => a + q[0], 0) / 4;
  const cz = p.ground.reduce((a, q) => a + q[1], 0) / 4;
  return p.ground.map(([x, z]) => { const dx = x - cx; const dz = z - cz; const l = Math.hypot(dx, dz) || 1; return [x + (dx / l) * m * 1.42, z + (dz / l) * m * 1.42] as P; });
}
const envelopeOf = (p: Placed): P[] => p.ground;
/** Most ground variation a lot may have. With --pads each building gets its own flattened foundation pad (the
 * town-20 approach), so a lot only needs to be roughly level (default 3 m); without, the shelf itself must be flat. */
const PADS = argv.includes("--pads");
const MAX_SPREAD = Number(opt("max-spread", PADS ? "3" : "0.8"));
const problems: string[] = [];
const placed: Placed[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evaluate(b: any, bu: number, sideName: string, setback: number, terraceId: string): Placed | null {
  const terrace = town!.terraces.find((t) => t.id === terraceId);
  if (!terrace) return null;
  b = { ...b, u: bu, side: sideName, setback, terrace: terraceId };
  const a = terrace.points[0] as P;
  const e = terrace.points.at(-1) as P;
  const len = Math.hypot(e[0] - a[0], e[1] - a[1]) || 1;
  const u: P = [(e[0] - a[0]) / len, (e[1] - a[1]) / len];
  const v: P = [-u[1], u[0]];
  const at = (uu: number, vv: number): P => [a[0] + u[0] * uu + v[0] * vv, a[1] + u[1] * uu + v[1] * vv];
  // the street across this stretch: the building's LANE (plan.lanes: a road, or a line at shelf height `v` off
  // the centreline), else the nearest town road whose frame-u passes b.u, else the centreline
  let streetV = 0;
  let streetHalf = 3;
  const lane = (plan.lanes ?? []).find((l: { id: string }) => l.id === b.street) as { road?: string; terrace?: string; v?: number; width?: number } | undefined;
  const laneRoads = lane?.road ? ownRoads.filter((r) => r.id === lane.road) : lane ? [] : ownRoads;
  if (lane && lane.v !== undefined) { streetV = lane.v; streetHalf = (lane.width ?? 4) / 2; }
  for (const r of laneRoads) {
    const pts = r.points as P[];
    for (let k = 1; k < pts.length; k++) {
      const toF = (p: P): P => [(p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1], (p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]];
      const p0 = toF(pts[k - 1]!);
      const p1 = toF(pts[k]!);
      if ((p0[0] - b.u) * (p1[0] - b.u) > 0 || p0[0] === p1[0]) continue;
      const t = (b.u - p0[0]) / (p1[0] - p0[0]);
      const vv = p0[1] + (p1[1] - p0[1]) * t;
      // only a road actually on this shelf counts as its street
      if (Math.abs(vv) <= terrace.radius) { streetV = vv; streetHalf = r.width / 2; }
    }
  }
  const side = b.side === "east" ? 1 : -1;
  // the building's REAL door wall (read from its build): a side door turns the building so that wall is its front
  const model = (b.model as string | undefined) ?? b.id;
  const raw = extOf(model) as { full: Ext; ground: Ext; door?: string };
  const doorSide = raw.door ?? "-y";
  const turn = PRE_ROT[doorSide] ?? 0;
  const ext = { full: rotExt(raw.full, doorSide), ground: rotExt(raw.ground, doorSide) };
  const [w0, d0] = (buildOf(model)?.request.size ?? b.request.size) as [number, number];
  const [w, d] = doorSide === "+x" || doorSide === "-x" ? [d0, w0] : [w0, d0];
  const W = w * CELL;
  const D = d * CELL;
  // the lot's front edge sits far enough back that the building's own front steps stay off the street
  const setbackUsed = Math.max(b.setback ?? 1, ext.ground.front * CELL + 0.5);
  const frontV = streetV + side * (streetHalf + setbackUsed);
  const centreV = frontV + side * (D / 2);
  const centre = at(b.u, centreV);
  // face the STREET, not the shelf axis: toward the nearest point of the street road (buildings follow its curve)
  let facing: P = [-v[0] * side, -v[1] * side];
  const streetRoad = lane?.road ? ownRoads.find((r) => r.id === lane.road) : undefined;
  if (streetRoad) {
    const q = nearestOn(streetRoad.points as P[], centre[0], centre[1]);
    const l = Math.hypot(q[0] - centre[0], q[1] - centre[1]);
    if (l > 1e-3) {
      const f: P = [(q[0] - centre[0]) / l, (q[1] - centre[1]) / l];
      // keep to the same side of the street (never swing more than 60° off the shelf-square facing)
      if (f[0] * facing[0] + f[1] * facing[1] > 0.866) facing = f;
    }
  }
  // not everything squared (Derek): a small fixed turn per building, up to ±6°, seeded by its id
  {
    let hsh = 0;
    for (const ch of b.id as string) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    const jit = (((hsh % 1000) / 1000) * 2 - 1) * (6 * Math.PI / 180);
    const c_ = Math.cos(jit), s_ = Math.sin(jit);
    facing = [facing[0] * c_ - facing[1] * s_, facing[0] * s_ + facing[1] * c_];
  }
  const yaw = Math.atan2(facing[0], facing[1]);
  // building-local: `right` is the kit's +x as the engine sees it after the yaw (front = facing)
  const right: P = [facing[1], -facing[0]];
  const local = (ra: number, fw: number): P => [centre[0] + right[0] * ra + facing[0] * fw, centre[1] + right[1] * ra + facing[1] * fw];
  const rect = (x: Ext | null): P[] => {
    const e = x ?? { left: 0, right: 0, front: 0, back: 0 };
    return [local(-W / 2 - e.left * CELL, D / 2 + e.front * CELL), local(W / 2 + e.right * CELL, D / 2 + e.front * CELL), local(W / 2 + e.right * CELL, -D / 2 - e.back * CELL), local(-W / 2 - e.left * CELL, -D / 2 - e.back * CELL)];
  };
  const corners = rect(null);
  const groundRect = rect(ext.ground);
  const fullRect = rect(ext.full);
  // the door point is where a visitor stands: clear of the front steps
  const door = local(0, D / 2 + ext.ground.front * CELL + 2.5);
  const [gw0, gw1] = [-W / 2 - ext.ground.left * CELL, W / 2 + ext.ground.right * CELL];
  const [gd0, gd1] = [-D / 2 - ext.ground.back * CELL, D / 2 + ext.ground.front * CELL];
  const mine: string[] = [];
  // ground under the footprint, on a 1 m lattice
  let lo = Infinity;
  let hi = -Infinity;
  let off = 0;
  let wet = 0;
  let road = "";
  for (let i = 0; i <= Math.ceil(gw1 - gw0); i++)
    for (let j = 0; j <= Math.ceil(gd1 - gd0); j++) {
      const p = local(Math.min(gw0 + i, gw1), Math.min(gd0 + j, gd1));
      // everything the building stands on must be flat, on the shelf, dry and off the roads
      const g = ground(p[0], p[1]);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
      if (distToPolyline(terrace.points as P[], p[0], p[1]) > terrace.radius + 0.5) off++;
      const water = field.waterY(p[0], p[1]);
      if (g < recipe.seaLevel + 0.2 || (water !== null && water > g)) wet++;
    }
  for (let i = 0; i <= Math.ceil(gw1 - gw0); i++)
    for (let j = 0; j <= Math.ceil(gd1 - gd0); j++) {
      const p = local(Math.min(gw0 + i, gw1), Math.min(gd0 + j, gd1));
      for (const r of allRoads) if (!road && distToPolyline(r.points as P[], p[0], p[1]) < r.width / 2 + 0.3) road = r.id;
    }
  if (hi - lo > MAX_SPREAD) mine.push(`ground spread ${(hi - lo).toFixed(2)} m (${lo.toFixed(1)}..${hi.toFixed(1)})`);
  if (off) mine.push(`${off} sample(s) off the ${terrace.id} shelf`);
  if (wet) mine.push(`${wet} sample(s) in water`);
  if (road) mine.push(`footprint within 0.5 m of road ${road}`);
  return { id: b.id, name: b.name, district: b.district, terrace: b.terrace, size: [w, d], centre, groundY: terrace.groundY, yaw, facing, corners, ground: groundRect, full: fullRect, door, problems: mine, model, preRot: turn } as Placed;
}

// ---- door access: a 1 m walk grid of the town's ground (topmost solid, dry, <= the player's 50° climb); a
// building's ENVELOPE (+0.4 m of player) is solid. A lot is only valid if every placed door — its own included — is
// reachable from the first gate. The walker (town-walk --doors) then proves it on the real physics.
const gate0 = town.gates[0]?.at as P | undefined;
const GX0 = Math.floor(town.center[0] - town.radius - (town.falloff ?? 0) - 40);
const GZ0 = Math.floor(town.center[1] - town.radius - (town.falloff ?? 0) - 40);
const GN = Math.ceil((town.radius + (town.falloff ?? 0) + 40) * 2);
const GH = new Float32Array(GN * GN);
const GOK = new Uint8Array(GN * GN);
for (let j = 0; j < GN; j++)
  for (let i = 0; i < GN; i++) {
    const x = GX0 + i;
    const z = GZ0 + j;
    const g = ground(x, z);
    GH[i + j * GN] = g;
    const water = field.waterY(x, z);
    GOK[i + j * GN] = g >= recipe.seaLevel + 0.2 && !(water !== null && water > g + 0.3) ? 1 : 0;
  }
/** The same rules as town-walk's planner: routes under 40°, and a cell is open only with its neighbours open (a body's width). */
const CLIMB = Math.tan((40 * Math.PI) / 180);
function insidePoly(poly: P[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
function blockedBy(list: Placed[]): Uint8Array {
  const blocked = new Uint8Array(GN * GN);
  for (let k = 0; k < GN * GN; k++) if (!GOK[k]) blocked[k] = 1;
  for (const q of list) {
    const env = grownEnvelope(q, 0.4);
    const xs = env.map((c) => c[0]);
    const zs = env.map((c) => c[1]);
    for (let z = Math.floor(Math.min(...zs)); z <= Math.ceil(Math.max(...zs)); z++)
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        const i = x - GX0;
        const j = z - GZ0;
        if (i >= 0 && j >= 0 && i < GN && j < GN && insidePoly(env, x, z)) blocked[i + j * GN] = 1;
      }
  }
  // shoulders: grow every blocked cell by one (dry-land edges and building outlines alike)
  const grown = blocked.slice();
  for (let j = 1; j < GN - 1; j++)
    for (let i = 1; i < GN - 1; i++) {
      const k = i + j * GN;
      if (!blocked[k]) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) grown[k + di + dj * GN] = 1;
    }
  return grown;
}
/** Doors of `list` NOT reachable from the gate. */
function unreachableDoors(list: Placed[]): Placed[] {
  if (!gate0) return [];
  const blocked = blockedBy(list);
  const seen = new Uint8Array(GN * GN);
  const q = new Int32Array(GN * GN);
  let h = 0;
  let t = 0;
  const cell = (p: P): number => { const i = Math.round(p[0] - GX0); const j = Math.round(p[1] - GZ0); return i < 0 || j < 0 || i >= GN || j >= GN ? -1 : i + j * GN; };
  const s0 = cell(gate0);
  if (s0 < 0) return [];
  seen[s0] = 1;
  q[t++] = s0;
  while (h < t) {
    const c = q[h++]!;
    const ci = c % GN;
    const cj = (c - ci) / GN;
    for (const [di, dj, run] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]] as const) {
      const ii = ci + di;
      const jj = cj + dj;
      if (ii < 0 || jj < 0 || ii >= GN || jj >= GN) continue;
      const k = ii + jj * GN;
      if (seen[k] || !GOK[k] || blocked[k]) continue;
      if (Math.abs(GH[k]! - GH[c]!) / run > CLIMB) continue;
      seen[k] = 1;
      q[t++] = k;
    }
  }
  return list.filter((p) => {
    // the door cell or any cell within 1.5 m of it (the door point is 3.2 m out; the envelope stops 0.8 m short)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const k = cell([p.door[0] + dx, p.door[1] + dz]);
        if (k >= 0 && seen[k]) return false;
      }
    return true;
  });
}

if (process.env.LAYOUT_DEBUG) { const probe: Placed = { id: "probe", name: "", district: "", terrace: "", size: [1, 1], centre: [0, 0], groundY: 0, yaw: 0, facing: [0, 1], corners: [[0,0],[0,0],[0,0],[0,0]], ground: [[0,0],[0,0],[0,0],[0,0]], full: [[0,0],[0,0],[0,0],[0,0]], door: (process.env.LAYOUT_PROBE ? process.env.LAYOUT_PROBE.split(",").map(Number) : [town.center[0], town.center[1]]) as P, problems: [] }; const bl = blockedBy([]); let nb = 0; for (let k = 0; k < GN * GN; k++) nb += bl[k]!; const g = gate0!; const gi = Math.round(g[0] - GX0) + Math.round(g[1] - GZ0) * GN; console.log("DEBUG grid", GN, "blocked", nb, "gate blocked", bl[gi], "GOK", GOK[gi], "H", GH[gi], "centre reachable", unreachableDoors([probe]).length === 0); for (let dz = -3; dz <= 3; dz++) { let row = ""; for (let dx = -3; dx <= 3; dx++) { const k = gi + dx + dz * GN; row += (bl[k] ? "#" : ".") + GH[k]!.toFixed(1).padStart(5); } console.log(row); } }
// The solver: each building, in plan order, takes the nearest valid spot to the one asked for — same
// terrace first (any u, either side, setback 0.5..4 m), then the other shelves — never overlapping one
// already placed. A building nothing fits is placed where asked and reported.
const solve = !argv.includes("--no-solve");
let whyCount = 0;
// biggest first (by measured ground outline): the large halls take the lots they need, the small houses fill the gaps
const areaOf = (b: { id: string; request: { size: [number, number] } }): number => { const e = extOf(b.id).ground; return (b.request.size[0] + e.left + e.right) * (b.request.size[1] + e.front + e.back); };
for (const b of [...plan.buildings].sort((p, q) => (Number(!!(p as { optional?: boolean }).optional) - Number(!!(q as { optional?: boolean }).optional)) || areaOf(q) - areaOf(p))) {
  const asked = evaluate(b, b.u, b.side, b.setback ?? 1, b.terrace);
  if (!asked) { problems.push(`${b.id}: no terrace ${b.terrace}`); continue; }
  const clash = (c: Placed): boolean => placed.some((q) => overlaps(c.ground, q.ground, 1) || overlaps(c.full, q.full, 0));
  // judged on THIS lot: its own door must be reachable and it may not cut off a door that was reachable before it
  // (a building that already failed must not poison every lot after it)
  const before = new Set(unreachableDoors(placed).map((q) => q.id));
  const reachable = (c: Placed): boolean => unreachableDoors([...placed, c]).every((q) => before.has(q.id));
  if (!solve || (asked.problems.length === 0 && !clash(asked) && reachable(asked))) { placed.push(asked); continue; }
  const laneOf = (plan.lanes ?? []).find((l: { id: string }) => l.id === b.street) as { terrace?: string } | undefined;
  const shelves = laneOf?.terrace ? [laneOf.terrace] : [b.terrace, ...town.terraces.map((t) => t.id).filter((id) => id !== b.terrace)];
  let found: Placed | null = null;
  for (const shelf of shelves) {
    const t = town.terraces.find((x) => x.id === shelf)!;
    const len = Math.hypot(t.points.at(-1)![0] - t.points[0]![0], t.points.at(-1)![1] - t.points[0]![1]);
    const cands: [number, string, number][] = [];
    for (let du = 0; du <= len + 20; du += 1)
      for (const uu of du === 0 ? [b.u] : [b.u + du, b.u - du])
        for (const side of [b.side, b.side === "east" ? "west" : "east"])
          for (const sb of [b.setback ?? 1, 0.5, 2, 3, 4]) cands.push([uu, side, sb]);
    for (const [uu, side, sb] of cands) {
      if (uu < -10 || uu > len + 10) continue;
      const ln_ = (plan.lanes ?? []).find((l: { id: string }) => l.id === b.street) as { uMin?: number; uMax?: number } | undefined;
      if (ln_ && ((ln_.uMin !== undefined && uu < ln_.uMin) || (ln_.uMax !== undefined && uu > ln_.uMax))) continue;
      const c = evaluate(b, uu, side, sb, shelf);
      if (process.env.LAYOUT_WHY === b.id && c && whyCount++ < 12) console.log("WHY", uu, side, sb, c.problems.join(";"), "clash", clash(c), "reach", c.problems.length ? "-" : reachable(c), "door", c.door.map((v) => v.toFixed(1)).join(","));
      if (c && c.problems.length === 0 && !clash(c) && reachable(c)) { found = c; break; }
    }
    if (found) break;
  }
  if (found) { if (found.terrace !== b.terrace || Math.abs(found.centre[0] - asked.centre[0]) + Math.abs(found.centre[1] - asked.centre[1]) > 0.1) console.log(`  moved ${b.id}: ${b.terrace} u ${b.u} ${b.side} -> ${found.terrace} (${found.problems.length ? "?" : "valid"})`); placed.push(found); }
  else if ((b as { optional?: boolean }).optional) console.log(`  skipped ${b.id} (optional; no lot left)`);
  else { asked.problems.push("no valid lot anywhere on the town's shelves"); placed.push(asked); }
}
for (let i = 0; i < placed.length; i++)
  for (let j = i + 1; j < placed.length; j++)
    if (overlaps(placed[i]!.ground, placed[j]!.ground, 1) || overlaps(placed[i]!.full, placed[j]!.full, 0)) placed[i]!.problems.push(`too close to ${placed[j]!.id} (ground outlines < 1 m apart, or roofs intersect)`);
for (const p of unreachableDoors(placed)) p.problems.push("door not reachable from the gate");

// residents: homes/works exist; required services covered
const ids = new Set(placed.map((p) => p.id));
const nonBuildings = new Set(["quay", "none", ...((plan.structures ?? []) as { id: string }[]).map((x) => x.id)]);
for (const r of plan.residents) {
  for (const k of ["home", "work"] as const) if (!ids.has(r[k]) && !nonBuildings.has(r[k])) problems.push(`resident ${r.id}: ${k} "${r[k]}" is not a building in the plan`);
}
const services = new Set(plan.residents.flatMap((r: { services?: string[] }) => r.services ?? []));
for (const need of plan.required) if (!services.has(need)) problems.push(`no resident provides required service "${need}"`);
for (const p of placed) for (const m of p.problems) problems.push(`${p.id}: ${m}`);
// an ocean-coastal town must have a dock (Derek's rule): the survey says whether the sea is at the town
try {
  const survey = JSON.parse(fs.readFileSync(path.join(townsDir, "survey", `${townName}.json`), "utf8"));
  const docks = ((plan.structures ?? []) as { kind: string }[]).filter((x) => x.kind === "dock");
  if (survey.coastal && docks.length === 0) problems.push("ocean-coastal town without a dock: add a structure { kind: \"dock\" } (the landmark stage builds it until a WFC dock exists)");
} catch { /* no survey yet */ }

const round = (v: number): number => Math.round(v * 100) / 100;
const out = {
  town: townName,
  townId: town.id,
  cell: CELL,
  buildings: placed.map((p) => ({
    ...p,
    centre: p.centre.map(round),
    yaw: round(p.yaw),
    facing: p.facing.map(round),
    corners: p.corners.map((c) => c.map(round)),
    ground: p.ground.map((c) => c.map(round)),
    full: p.full.map((c) => c.map(round)),
    door: p.door.map(round),
    residents: plan.residents.filter((r: { home: string; work: string }) => r.home === p.id || r.work === p.id).map((r: { id: string; home: string; work: string }) => ({ id: r.id, home: r.home === p.id, work: r.work === p.id })),
  })),
};
fs.writeFileSync(path.join(townsDir, `${townName}-layout.json`), `${JSON.stringify(out, null, 1)}\n`);
for (const p of placed) console.log(`  ${p.problems.length ? "FAIL" : "ok  "} ${p.id.padEnd(22)} ${p.size.join("x")} at [${p.centre.map((v) => v.toFixed(1))}] y ${p.groundY.toFixed(1)} faces ${(p.yaw * 180 / Math.PI).toFixed(0)}°${p.problems.length ? "  — " + p.problems.join("; ") : ""}`);

// ---- the plan map: the survey picture with the lots drawn and labelled (SVG -> PNG through Playwright) ----
if (!argv.includes("--no-map")) {
  const surveyJson = JSON.parse(fs.readFileSync(path.join(townsDir, "survey", `${townName}.json`), "utf8"));
  const { x0, z0, n, scale } = surveyJson.map as { x0: number; z0: number; n: number; scale: number };
  const px = (p: P): string => `${((p[0] - x0) * scale).toFixed(1)},${((p[1] - z0) * scale).toFixed(1)}`;
  const png = fs.readFileSync(path.join(townsDir, "survey", `${townName}.png`)).toString("base64");
  // crop to the lots + 45 m, drawn at 2.5x
  const allPx = placed.flatMap((p) => p.corners.map((c) => px(c).split(",").map(Number) as [number, number]));
  const padPx = 45 * scale;
  const bx0 = Math.max(0, Math.min(...allPx.map((q) => q[0])) - padPx);
  const by0 = Math.max(0, Math.min(...allPx.map((q) => q[1])) - padPx);
  const bw = Math.min(n * scale - bx0, Math.max(...allPx.map((q) => q[0])) + padPx - bx0);
  const bh = Math.min(n * scale - by0, Math.max(...allPx.map((q) => q[1])) + padPx - by0);
  const VW = Math.round(bw * 2.5);
  const VH = Math.round(bh * 2.5);
  const colour = (d: string): string => (d === "high" ? "#e9c46a" : d === "low" ? "#8ecae6" : "#cdb4db");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VW}" height="${VH}" viewBox="${bx0} ${by0} ${bw} ${bh}" font-family="ui-monospace,monospace">`,
    `<image href="data:image/png;base64,${png}" width="${n * scale}" height="${n * scale}"/>`,
    ...placed.map((p) => {
      const [cx, cy] = px(p.centre).split(",").map(Number) as [number, number];
      const [dx, dy] = px(p.door).split(",").map(Number) as [number, number];
      const bad = p.problems.length > 0;
      return [
        `<polygon points="${p.corners.map(px).join(" ")}" fill="${colour(p.district)}" fill-opacity="0.75" stroke="${bad ? "#ff2d55" : "#111"}" stroke-width="${bad ? 3 : 1.5}"/>`,
        `<polygon points="${envelopeOf(p).map(px).join(" ")}" fill="none" stroke="#ff9f1c" stroke-width="0.8" stroke-dasharray="2 1.5"/>`,
        `<circle cx="${dx}" cy="${dy}" r="1.6" fill="#fff" stroke="#111"/>`,
        `<text x="${cx}" y="${cy}" font-size="4.6" text-anchor="middle" dominant-baseline="middle" fill="#111" font-weight="700">${p.name.replace(/&/g, "&amp;")}</text>`,
      ].join("");
    }),
    `<g transform="translate(${bx0 + 6},${by0 + bh - 34}) scale(0.5)"><rect width="250" height="60" fill="#000" fill-opacity="0.6" rx="4"/>`,
    `<rect x="10" y="10" width="14" height="14" fill="#e9c46a"/><text x="30" y="22" font-size="12" fill="#fff">high town (upper shelf)</text>`,
    `<rect x="10" y="32" width="14" height="14" fill="#8ecae6"/><text x="30" y="44" font-size="12" fill="#fff">lower town; white dot = door</text></g>`,
    `</svg>`,
  ].join("\n");
  const svgFile = path.join(townsDir, "survey", `${townName}-plan.svg`);
  fs.writeFileSync(svgFile, svg);
  try {
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE ??
        "file:///C:/Users/Derek/AppData/Local/Temp/claude/D--Users-Derek-Desktop-HitRegStudios-Engine/29863f0b-4711-4d4d-aeda-fe4ad134b25a/scratchpad/node_modules/playwright/index.mjs"
    );
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: VW, height: VH } });
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.screenshot({ path: path.join(townsDir, "survey", `${townName}-plan.png`) });
    await browser.close();
    console.log(`wrote authoring/towns/survey/${townName}-plan.png`);
  } catch (error) {
    console.log(`plan map not rendered (${String(error).split("\n")[0]}); the SVG is at ${svgFile}`);
  }
}
// LANES: --write-lanes turns every plan lane that is a line at shelf height (not an existing road) into a town
// road `<town>-lane-<id>`: gravel, flat at the shelf's height, spanning its buildings' frontage + 4 m, and joined
// at its nearer end to the nearest other town road so the lane is on the walkable network (and painted).
if (argv.includes("--write-lanes")) {
  const roadsRaw = recipeRaw.features.roads as { id: string; points: P[] }[];
  const written: string[] = [];
  for (const lane of (plan.lanes ?? []) as { id: string; terrace: string; v?: number; width?: number; road?: string }[]) {
    if (lane.road || lane.v === undefined || (lane as { placementOnly?: boolean }).placementOnly) continue;
    const t = town.terraces.find((x) => x.id === lane.terrace);
    const onIt = placed.filter((q) => (plan.buildings as { id: string; street?: string }[]).find((b) => b.id === q.id)?.street === lane.id);
    if (!t || onIt.length === 0) continue;
    const a = t.points[0] as P;
    const e = t.points.at(-1) as P;
    const len = Math.hypot(e[0] - a[0], e[1] - a[1]) || 1;
    const u: P = [(e[0] - a[0]) / len, (e[1] - a[1]) / len];
    const v: P = [-u[1], u[0]];
    const toU = (q: P): number => (q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1];
    const us = onIt.flatMap((q) => q.corners.map(toU));
    const u0 = Math.min(...us) - 4;
    const u1 = Math.max(...us) + 4;
    const at = (uu: number): P => [a[0] + u[0] * uu + v[0] * lane.v!, a[1] + u[1] * uu + v[1] * lane.v!];
    const pts: P[] = [at(u0), at(u1)];
    const ys = [t.groundY, t.groundY];
    // join the nearer end to the nearest point of another town road (not a lane of this pass)
    let best: { end: 0 | 1; q: P; d: number } | null = null;
    for (const r of recipe.features.roads.filter((r) => r.id.startsWith(`${town.id}-`) && !r.id.startsWith(`${town.id}-lane-`))) {
      const rp = r.points as P[];
      for (let k = 1; k < rp.length; k++)
        for (const end of [0, 1] as const) {
          const [px, pz] = pts[end]!;
          const [ax2, az2] = rp[k - 1]!;
          const [bx2, bz2] = rp[k]!;
          const dx = bx2 - ax2;
          const dz = bz2 - az2;
          const l2 = dx * dx + dz * dz || 1;
          const tt = Math.max(0, Math.min(1, ((px - ax2) * dx + (pz - az2) * dz) / l2));
          const q: P = [ax2 + dx * tt, az2 + dz * tt];
          const d = Math.hypot(q[0] - px, q[1] - pz);
          if (!best || d < best.d) best = { end, q, d };
        }
    }
    if (best && best.d < 60) {
      const qy = field.height(best.q[0], best.q[1]);
      if (best.end === 0) { pts.unshift(best.q); ys.unshift(qy); } else { pts.push(best.q); ys.push(qy); }
    }
    const id = `${town.id}-lane-${lane.id}`;
    const doc = { id, points: pts.map((q) => q.map(round) as P), width: lane.width ?? 4, shoulder: 1.5, smooth: 3, surfaceY: ys.map(round), flatten: 1, surface: "gravel", surfaceEdge: 1.5 };
    const i = roadsRaw.findIndex((r) => r.id === id);
    if (i >= 0) roadsRaw[i] = doc as never; else roadsRaw.push(doc as never);
    written.push(`${id} (${Math.round(u1 - u0)} m${best && best.d < 60 ? `, joined ${best.d.toFixed(0)} m` : ""})`);
  }
  worldRecipeSchema.parse(recipeRaw);
  fs.writeFileSync(recipeFile, `${JSON.stringify(recipeRaw, null, 2)}
`);
  console.log(`lanes written: ${written.join(", ") || "none"}`);
}
// PADS: --write-pads writes one foundation pad per building into the town (a terrace along the depth of the building,
// as wide as its ground outline + 1.5 m, at the shelf height), replacing earlier pads. Written only when the layout passes.
if (PADS && argv.includes("--write-pads")) {
  if (problems.length) console.log("pads NOT written: the layout still fails");
  else {
    const tw = recipeRaw.features.towns.find((t: { id: string }) => t.id === town.id);
    tw.terraces = tw.terraces.filter((t: { id: string }) => !t.id.startsWith(`${town.id}-pad-`));
    for (const q of placed) {
      const g = q.ground;
      const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const front = mid(g[0]!, g[1]!), back = mid(g[2]!, g[3]!);
      const halfW = Math.hypot(g[1]![0] - g[0]![0], g[1]![1] - g[0]![1]) / 2;
      tw.terraces.push({ id: `${town.id}-pad-${q.id}`, points: [front.map(round), back.map(round)], radius: round(halfW + 1.5), falloff: 3, groundY: q.groundY, flatten: 1, tags: ["building-foundation"] });
    }
    worldRecipeSchema.parse(recipeRaw);
    fs.writeFileSync(recipeFile, `${JSON.stringify(recipeRaw, null, 2)}\n`);
    console.log(`pads written: ${placed.length} (re-run road-regrade over the town, then town-survey)`);
  }
}
if (earthworks.length && argv.includes("--write-earthworks")) {
  // Written even while lots still fail: the roads' banks were sampled from the OLD ground and only a
  // road-regrade over the new shelves (run next) can show what the shelves really give.
  if (problems.length) console.log("earthworks written although the layout still fails — regrade the roads, then re-run");
  { fs.writeFileSync(recipeFile, `${JSON.stringify(recipeRaw, null, 2)}
`); console.log(`earthworks written to ${path.relative(process.cwd(), recipeFile)}: ${earthworks.map((e) => `${e.id} r ${e.radius}`).join(", ")} — re-run road-regrade, town-survey and town-walk`); }
}
if (problems.length) {
  console.log(`LAYOUT FAILED (${problems.length}):`);
  for (const p of problems) console.log(`  ! ${p}`);
  process.exit(1);
}
console.log("LAYOUT OK");
