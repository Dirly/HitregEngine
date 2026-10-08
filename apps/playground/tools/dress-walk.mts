/**
 * dress-walk — the real-body gate for a FURNISHED building (`dress walk`, tools/dress.mts).
 *
 * Boots the scene headless exactly as the dedicated server does (HeadlessWorld + TerrainStreamer: the building's
 * trimesh, every installed prop prefab's collider, the terrain outside), spawns the player body from the scene's
 * player template and drives it with the server's own PlayerDriver — the machinery of tools/town-walk.mts, copied
 * here in its minimum form (town-walk is a script, not a module).
 *
 * Routes are PLANNED on the building's socket map (walls from its cells; the installed props' footprints read from
 * the scene, grown by the body's radius), then walked:
 *   ground:<room>        from 3 m outside the front door to the room's centre (nearest open floor to it)
 *   ground:<stair-foot>  from the door to the stair's approach, then its foot (the step a player gets on at)
 *   upper:<room>         the same, up each stair (matched by marker number) to a room on that floor. The flight is walked
 *                        on the FOOT marker's centreline (its yaw), each point at the height the flight has reached there
 *                        (foot floor -> head floor), to the head's landing and 0.6 m off it in the head marker's yaw
 * When no path clears the furniture, the route is planned through it (flagged `through furniture`) and walked
 * anyway, so the stuck point names the prop in the way. A point on an upper floor only counts as reached when the
 * body's FEET are at that floor's height: progress on the map alone never proves a climb.
 *
 * The gate (exit 1) is every floor: ground routes and the routes up the stairs to the upper rooms (`ok`; `groundOk` and
 * `upperOk` say which part failed).
 */
import fs from "node:fs";
import path from "node:path";
import type { SocketMap, DressingData } from "@hitreg/core";

type P2 = [number, number];
type P3 = [number, number, number];
type Quat = [number, number, number, number];

export interface WalkArgs {
  playground: string;
  projectDir: string;
  planId: string;
  map: SocketMap;
  scene: string;
  /** A prop's dressing declaration (sizes of the installed props). */
  prop: (id: string) => DressingData | undefined;
  body: { radius: number; height: number; laneWidth: number };
  out: string;
  /** Drive speed in m/s (default: the controller's run speed x 0.6, a jog indoors). */
  speed?: number;
}
export interface WalkStuck { at: P3; along: number; jumped: boolean; nearestProp: string; touching: string[] }
export interface WalkRoute { id: string; kind: "ground" | "upper"; target: string; planned: "clear" | "through furniture" | "none"; metres: number; finished: boolean; reached: number; feetY: number; wantY: number; stuck: WalkStuck[]; seconds: number; note?: string }
export interface WalkReport { plan: string; scene: string; building: string; at: P3; yaw: number; laneWidth: number; capsule: { radius: number; height: number }; props: number; routes: WalkRoute[]; groundOk: boolean; upperOk: boolean; ok: boolean; speed: number; walkedAt: string }

// ---- transforms ---------------------------------------------------------------
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function qrot(q: Quat, v: P3): P3 {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
interface Xf { p: P3; q: Quat; s: P3 }
type SceneDoc = { entities: Record<string, { parent: string | null; name?: string; tags?: string[]; components: Record<string, any> }> };
function worldOf(doc: SceneDoc, id: string): Xf {
  const chain: string[] = [];
  for (let e: string | null = id; e; e = doc.entities[e]?.parent ?? null) chain.unshift(e);
  let xf: Xf = { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  for (const e of chain) {
    const t = doc.entities[e]!.components.transform ?? {};
    const lp: P3 = t.position ?? [0, 0, 0], lq: Quat = t.rotation ?? [0, 0, 0, 1], ls: P3 = t.scale ?? [1, 1, 1];
    const sp = qrot(xf.q, [lp[0] * xf.s[0], lp[1] * xf.s[1], lp[2] * xf.s[2]]);
    xf = { p: [xf.p[0] + sp[0], xf.p[1] + sp[1], xf.p[2] + sp[2]], q: qmul(xf.q, lq), s: [xf.s[0] * ls[0], xf.s[1] * ls[1], xf.s[2] * ls[2]] };
  }
  return xf;
}
const yawOfQ = (q: Quat): number => Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));

// ---- the plan grid --------------------------------------------------------------
const WALKABLE = new Set([".", "o", "D", "E", "S", "H", "A", "x"]); // "x" = a reserved walking path (dress-sockets): the most walkable cell there is
interface Foot { id: string; prefab: string; level: number; cx: number; cz: number; hw: number; hd: number; yaw: number }
function rectDist(f: Foot, x: number, z: number): number {
  const dx = x - f.cx, dz = z - f.cz, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - f.hw, 0), Math.max(Math.abs(lz) - f.hd, 0));
}

/** A* over one level's cells (8-neighbour), keeping `radius` from walls (cell disc) and, when `feet` is given, from props (exact). */
function planOn(lv: SocketMap["levels"][number], from: P2, to: P2, radius: number, feet: Foot[] | null): P2[] | null {
  const C = lv.columns, R = lv.rows, N = C * R, st = lv.step;
  const cellOf = (x: number, z: number): P2 => [Math.floor((x - lv.origin[0]) / st), Math.floor((z - lv.origin[1]) / st)];
  const centre = (c: number, r: number): P2 => [lv.origin[0] + (c + 0.5) * st, lv.origin[1] + (r + 0.5) * st];
  const ch = (c: number, r: number) => (c < 0 || r < 0 || c >= C || r >= R ? " " : (lv.cells[r]?.[c] ?? " "));
  const n = Math.max(1, Math.floor(radius / st));
  const ok = new Uint8Array(N);
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      let good = WALKABLE.has(ch(c, r));
      for (let dr = -n; dr <= n && good; dr++) for (let dc = -n; dc <= n && good; dc++) if (Math.hypot(dc, dr) * st <= radius + 1e-9 && !WALKABLE.has(ch(c + dc, r + dr))) good = false;
      if (good && feet) { const [x, z] = centre(c, r); for (const f of feet) if (rectDist(f, x, z) < radius) { good = false; break; } }
      ok[r * C + c] = good ? 1 : 0;
    }
  // snap both ends to the nearest open cell within 1.5 m
  const snap = (p: P2): number => {
    const [c0, r0] = cellOf(p[0], p[1]), m = Math.ceil(1.5 / st);
    let best = -1, bd = Infinity;
    for (let dr = -m; dr <= m; dr++) for (let dc = -m; dc <= m; dc++) { const c = c0 + dc, r = r0 + dr; if (c < 0 || r < 0 || c >= C || r >= R || !ok[r * C + c]) continue; const d = dc * dc + dr * dr; if (d < bd) [best, bd] = [r * C + c, d]; }
    return best;
  };
  const s = snap(from), g = snap(to);
  if (s < 0 || g < 0) return null;
  const cost = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const open: number[] = [s];
  cost[s] = 0;
  const h = (k: number) => Math.hypot((k % C) - (g % C), Math.floor(k / C) - Math.floor(g / C));
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (cost[open[k]!]! + h(open[k]!) < cost[open[bi]!]! + h(open[bi]!)) bi = k;
    const cur = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (cur === g) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cc = cur % C, cr = (cur - cc) / C;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const nc = cc + dc, nr = cr + dr, k = nr * C + nc;
      if (nc < 0 || nr < 0 || nc >= C || nr >= R || !ok[k] || closed[k]) continue;
      if (dc && dr && (!ok[cr * C + nc] || !ok[nr * C + cc])) continue; // no corner cutting
      const v = cost[cur]! + (dc && dr ? Math.SQRT2 : 1);
      if (v < cost[k]!) { cost[k] = v; came[k] = cur; open.push(k); }
    }
  }
  if (g !== s && came[g] === -1) return null;
  const out: P2[] = [];
  for (let k = g; k !== -1; k = came[k]!) out.push(centre(k % C, (k - (k % C)) / C));
  out.reverse();
  // keep every 2nd point (0.5 m), plus the end
  return out.filter((_, i) => i % 2 === 0 || i === out.length - 1);
}

// ---- the walk -------------------------------------------------------------------
export async function walkPlan(a: WalkArgs): Promise<WalkReport> {
  const t0 = Date.now();
  const server = await import("../../../packages/server/src/index.ts");
  const content = server.loadContent(server.playgroundRoots(a.playground));
  const doc = content.scenes.get(a.scene) as unknown as SceneDoc | undefined;
  if (!doc) throw new Error(`no scene ${a.scene}`);
  // ---- where the plan is installed: its entities, the building frame, the props' footprints
  const prefix = `dress-${a.planId.replace(/\//g, "--")}-`;
  const mine = Object.entries(doc.entities).filter(([id, e]) => id.startsWith(prefix) && (e.tags ?? []).includes(`dress:${a.planId}`));
  if (!mine.length) throw new Error(`plan ${a.planId} is not installed in scene ${a.scene} (no ${prefix}* entities): dress apply it first`);
  const group = mine.find(([, e]) => !e.components.prefab)!;
  const host = doc.entities[group[0]]!.parent;
  if (!host) throw new Error(`${group[0]} has no parent: walk needs the plan applied with --parent <building interior>`);
  // map-local -> host frame: apply's --at/--yaw, recovered from one placement against the resolved plan report
  const reportFile = path.join(a.projectDir, "authoring/dressing/plans", `${a.planId}.report.json`);
  const resolved = fs.existsSync(reportFile) ? (JSON.parse(fs.readFileSync(reportFile, "utf8")).placements as { id: string; position: P3; yaw: number }[]) : [];
  let at: P3 = [0, 0, 0], yaw0 = 0;
  for (const [id, e] of mine) {
    const p = resolved.find((r) => prefix + r.id.replace(/\//g, "--") === id);
    if (!p || !e.components.prefab) continue;
    const ey = yawOfQ(e.components.transform.rotation ?? [0, 0, 0, 1]);
    yaw0 = ey - p.yaw;
    const c = Math.cos(yaw0), s = Math.sin(yaw0), [lx, ly, lz] = p.position, P = e.components.transform.position as P3;
    at = [P[0] - (lx * c + lz * s), P[1] - ly, P[2] - (-lx * s + lz * c)];
    break;
  }
  const hostXf = worldOf(doc, host);
  const yawQ = (y: number): Quat => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
  const frame: Xf = { p: qrot(hostXf.q, at).map((v, i) => v + hostXf.p[i]!) as P3, q: qmul(hostXf.q, yawQ(yaw0)), s: hostXf.s };
  const toWorld = (x: number, y: number, z: number): P3 => { const r = qrot(frame.q, [x, y, z]); return [frame.p[0] + r[0], frame.p[1] + r[1], frame.p[2] + r[2]]; };
  const toLocal = (w: P3): P3 => { const inv: Quat = [-frame.q[0], -frame.q[1], -frame.q[2], frame.q[3]]; return qrot(inv, [w[0] - frame.p[0], w[1] - frame.p[1], w[2] - frame.p[2]]); };
  const levelOfY = (y: number): number => { let best = 0, bd = Infinity; for (const l of a.map.levels) { const d = Math.abs(y - l.floorY); if (d < bd) [best, bd] = [l.level, d]; } return best; };
  const feet: Foot[] = [];
  for (const [id, e] of mine) {
    const pf = e.components.prefab?.prefabId as string | undefined;
    const d = pf ? a.prop(pf) : undefined;
    if (!pf || !d || d.mount !== "floor" || !d.solid) continue;
    const w = worldOf(doc, id), l = toLocal(w.p), y = yawOfQ(w.q) - yawOfQ(frame.q);
    feet.push({ id, prefab: pf, level: levelOfY(l[1]), cx: l[0], cz: l[2], hw: d.size[0] / 2, hd: d.size[2] / 2, yaw: y });
  }
  // ---- boot the world as the server does
  const events = server.defaultEvents();
  const world = await server.HeadlessWorld.create({ doc: doc as never, assets: content.assets, registry: server.defaultRegistry(), events, scripts: server.defaultScripts(events), exclude: (_id: string, e: { tags: string[] }) => e.tags.includes("player") });
  const voxel = server.resolveServerVoxelWorld(world.base);
  const terrain = voxel ? new server.TerrainStreamer(world, voxel, { pool: false }) : null;
  const template = server.extractPlayerTemplate(world.expanded);
  if (!template) throw new Error(`scene ${a.scene} has no player template`);
  const centre = toWorld(0, 0, 0);
  terrain?.ensureAround(centre[0], centre[2], 1);
  world.step();
  const players = new Map<string, any>();
  const driver = new server.PlayerDriver(world, players, template.controller, {});
  world.beforeStep.add(driver.step);
  const RUN = typeof template.controller["speed"] === "number" ? (template.controller["speed"] as number) : 6.5;
  const SPEED = a.speed ?? RUN * 0.6; // indoors at a jog
  console.log(`booted ${a.scene} in ${Date.now() - t0} ms; ${mine.length - 1} installed entities, ${feet.length} solid floor props; building ${host} at (${frame.p.map((v) => v.toFixed(2)).join(", ")})`);

  // ---- routes (map-local, each point with the level it is on)
  /** A route point; `y` (map-local height) overrides the level's floor, for points on a flight. */
  type RP = { x: number; z: number; level: number; y?: number };
  const lv = (n: number) => a.map.levels.find((l) => l.level === n)!;
  const lowest = Math.min(...a.map.levels.map((l) => l.level));
  const entry = a.map.entry;
  if (!entry) throw new Error(`map ${a.map.id} has no entry door`);
  const outside: P2 = [entry.position[0] - entry.facing[0] * 3, entry.position[1] - entry.facing[1] * 3];
  const inside: P2 = [entry.position[0] + entry.facing[0] * 1.0, entry.position[1] + entry.facing[1] * 1.0];
  const r = a.body.laneWidth / 2;
  let throughFurniture = false;
  const leg = (level: number, from: P2, to: P2): RP[] | null => {
    const feetHere = feet.filter((f) => f.level === level);
    let p = planOn(lv(level), from, to, r, feetHere);
    if (!p) { p = planOn(lv(level), from, to, r, null); if (p) throughFurniture = true; }
    if (!p) p = planOn(lv(level), from, to, a.body.radius, null);
    return p ? p.map(([x, z]) => ({ x, z, level })) : null;
  };
  const anchors = a.map.anchors;
  const num = (id: string) => /-(\d+)$/.exec(id)?.[1] ?? "";
  const feetOf = (level: number) => anchors.filter((x) => x.kind === "stair-foot" && x.level === level);
  const headFor = (foot: (typeof anchors)[number]) => anchors.find((x) => x.kind === "stair-head" && x.level === foot.level + 1 && num(x.id) === num(foot.id));
  const approachFor = (foot: (typeof anchors)[number]) => anchors.find((x) => x.kind === "stair-approach" && x.level === foot.level && num(x.id) === num(foot.id));
  const xz = (p: { position: [number, number, number] }): P2 => [p.position[0], p.position[2]];
  /** From the door to standing on `level` (at the stair head), or null. */
  const reachLevel = (level: number): { pts: RP[]; via: string } | null => {
    if (level === lowest) {
      const doorIn: RP[] = [{ x: outside[0], z: outside[1], level }, { x: entry.position[0], z: entry.position[1], level }, { x: inside[0], z: inside[1], level }];
      return { pts: doorIn, via: "the front door" };
    }
    const foot = feetOf(level - 1).find((f) => headFor(f)?.level === level);
    if (!foot) return null;
    const below = reachLevel(level - 1);
    if (!below) return null;
    const head = headFor(foot)!, appr = approachFor(foot);
    const last = below.pts.at(-1)!;
    const toFoot = leg(level - 1, [last.x, last.z], appr ? xz(appr) : xz(foot));
    if (!toFoot) return null;
    const extra = appr ? leg(level - 1, xz(appr), xz(foot)) ?? [] : [];
    // the flight itself, as a player climbs it: up the foot marker's centreline (its yaw) to the head's landing, each
    // point at the height the flight has reached there (so the body's FEET are checked against the stair, not against
    // the floor it left), then 0.6 m off the landing in the head marker's yaw, on the upper floor
    const dir = (deg: number): P2 => [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];
    const [fx, fz] = xz(foot), [ux, uz] = dir(foot.yaw), [hx, hz] = xz(head), [ox, oz] = dir(head.yaw);
    const run = Math.max(0.5, (hx - fx) * ux + (hz - fz) * uz), steps = Math.max(2, Math.ceil(run / 0.5));
    const y0 = lv(level - 1).floorY, y1 = lv(level).floorY;
    const flight: RP[] = [];
    for (let k = 1; k <= steps; k++) flight.push({ x: fx + (ux * run * k) / steps, z: fz + (uz * run * k) / steps, level: k === steps ? level : level - 1, y: y0 + ((y1 - y0) * k) / steps });
    flight.push({ x: fx + ux * run + ox * 0.6, z: fz + uz * run + oz * 0.6, level });
    return { pts: [...below.pts, ...toFoot, ...extra, ...flight], via: `${below.via}, ${foot.id} -> ${head.id}` };
  };
  interface Plan { id: string; kind: "ground" | "upper"; target: string; pts: RP[] | null; planned: WalkRoute["planned"] }
  const plans: Plan[] = [];
  for (const l of a.map.levels) {
    const kind = l.level === lowest ? "ground" : "upper";
    const goals: { id: string; at: P2 }[] = l.rooms.map((rm) => ({ id: rm.id, at: rm.centre as P2 }));
    if (kind === "ground") for (const f of feetOf(l.level)) goals.push({ id: f.id, at: xz(f) });
    for (const g of goals) {
      throughFurniture = false;
      const base = reachLevel(l.level);
      if (!base) { plans.push({ id: `${kind}:${g.id}`, kind, target: g.id, pts: null, planned: "none" }); continue; }
      const last = base.pts.at(-1)!;
      const appr = anchors.find((x) => x.id === g.id) ? approachFor(anchors.find((x) => x.id === g.id)!) : undefined;
      const legs = appr ? [leg(l.level, [last.x, last.z], xz(appr)), leg(l.level, xz(appr), g.at)] : [leg(l.level, [last.x, last.z], g.at)];
      const pts = legs.some((x) => !x) ? null : [...base.pts, ...legs.flatMap((x) => x!)];
      plans.push({ id: `${kind}:${g.id}`, kind, target: g.id, pts, planned: pts ? (throughFurniture ? "through furniture" : "clear") : "none" });
    }
  }

  // ---- the walker (town-walk's, with the height rule)
  const PEER = "furnish-walker", bodyId = `player:${PEER}`;
  const half = a.body.height / 2;
  let seq = 0;
  const nearestProp = (w: P3): string => {
    const l = toLocal(w), level = levelOfY(l[1] - half);
    let best = "", bd = Infinity;
    for (const f of feet) { if (f.level !== level) continue; const d = rectDist(f, l[0], l[2]); if (d < bd) [best, bd] = [`${f.id} (${f.prefab}) ${d.toFixed(2)} m away`, d]; }
    return best || "none on this floor";
  };
  const walk = (p: Plan): WalkRoute => {
    const empty: WalkRoute = { id: p.id, kind: p.kind, target: p.target, planned: p.planned, metres: 0, finished: false, reached: 0, feetY: NaN, wantY: NaN, stuck: [], seconds: 0 };
    if (!p.pts) return { ...empty, note: "no route on the socket map even through furniture (map geometry or a missing stair mark)" };
    const pts = p.pts.map((q) => ({ w: toWorld(q.x, q.y ?? lv(q.level).floorY, q.z), level: q.level }));
    for (const q of pts) terrain?.ensureAround(q.w[0], q.w[2], 1);
    if (world.entities.has(bodyId)) world.removeEntities(world.subtree(bodyId), { silent: true });
    players.clear();
    const s0 = pts[0]!.w;
    const spawned = server.instantiatePlayer(template, PEER, [s0[0], s0[1] + 1.4, s0[2]], 0);
    world.addEntities({ ...world.base, entities: spawned.server });
    const record = { peerId: PEER, name: PEER, bodyId, ids: Object.keys(spawned.server), input: null, appliedSeq: 0, disconnectedAt: null, identity: null, rev: {}, commitPhase: 0, committing: null, transferring: null } as any;
    players.set(PEER, record);
    for (let i = 0; i < 30; i++) world.step();
    const along: number[] = [0];
    for (let k = 1; k < pts.length; k++) along.push(along[k - 1]! + Math.hypot(pts[k]!.w[0] - pts[k - 1]!.w[0], pts[k]!.w[2] - pts[k - 1]!.w[2]));
    const total = along.at(-1)!;
    let best = 0, bestAt = 0, side = 0, sideUntil = 0, sidesTried = 0, jumps = 0, t = 0;
    let pending: WalkStuck | null = null;
    const stuck: WalkStuck[] = [];
    const dt = world.fixedDt, maxSeconds = (total / RUN) * 4 + 20;
    let feetY = NaN;
    for (; t < maxSeconds; t += dt) {
      const q = world.positionOf(bodyId);
      if (!q) break;
      feetY = q[1] - half;
      // a point counts only when the body is within 0.8 m of it on the map AND its feet are on that point's floor
      for (let k = best + 1; k < Math.min(pts.length, best + 10); k++) {
        const P = pts[k]!;
        if (Math.hypot(q[0] - P.w[0], q[2] - P.w[2]) < 0.8 && Math.abs(feetY - P.w[1]) < 0.6) {
          if (k > best + 1 || (stuck.length && along[k]! > stuck.at(-1)!.along + 1)) { sidesTried = 0; pending = null; }
          best = k; bestAt = t; jumps = 0;
        }
      }
      if (best >= pts.length - 1) break;
      const aim = pts[Math.min(pts.length - 1, best + 2)]!.w;
      let dx = aim[0] - q[0], dz = aim[2] - q[2];
      const l = Math.hypot(dx, dz) || 1;
      const speed = SPEED;
      dx = (dx / l) * speed; dz = (dz / l) * speed;
      let jump = false;
      if (side !== 0 && t < sideUntil) { const sx = -dz * side, sz = dx * side; dx = sx * 0.9 + dx * 0.3; dz = sz * 0.9 + dz * 0.3; } else side = 0;
      if (t - bestAt > 1.5 && side === 0 && sidesTried < 2) {
        if (sidesTried === 0) {
          const near = world.sim.overlapSphere([q[0], q[1], q[2]], 0.9).filter((id: string) => !id.startsWith(bodyId));
          const touching = near.map((id: string) => { const e = world.entities.get(id) as { prefab?: string } | undefined; return e ? `${id}${e.prefab ? ` (${e.prefab})` : ""}` : id; });
          pending = { at: [+q[0].toFixed(2), +q[1].toFixed(2), +q[2].toFixed(2)], along: +along[best]!.toFixed(1), jumped: false, nearestProp: nearestProp(q as P3), touching };
        }
        side = sidesTried === 0 ? 1 : -1; sideUntil = t + 1.0; sidesTried++; bestAt = t;
      }
      if (t - bestAt > 1.5 && side === 0 && sidesTried >= 2) {
        if (jumps === 0 && pending) { stuck.push(pending); pending = null; }
        if (jumps < 2) { jump = true; jumps++; bestAt = t - 0.3; } else break;
      }
      record.input = { v: [dx, dz], jump, vy: 0, yaw: Math.atan2(dx, dz), seq: ++seq, at: Date.now() };
      world.step();
    }
    const finished = best >= pts.length - 1;
    const end = world.positionOf(bodyId);
    if (!finished && end && !(stuck.length && stuck.at(-1)!.along >= along[best]! - 0.5)) {
      const near = world.sim.overlapSphere([end[0], end[1], end[2]], 0.9).filter((id: string) => !id.startsWith(bodyId));
      stuck.push({ at: [+end[0].toFixed(2), +end[1].toFixed(2), +end[2].toFixed(2)], along: +along[best]!.toFixed(1), jumped: false, nearestProp: nearestProp(end as P3), touching: near.map((id: string) => { const e = world.entities.get(id) as { prefab?: string } | undefined; return e ? `${id}${e.prefab ? ` (${e.prefab})` : ""}` : id; }) });
    }
    for (const s of stuck) s.jumped = finished || along[best]! > s.along + 1.5;
    return { ...empty, metres: +total.toFixed(1), finished, reached: +along[best]!.toFixed(1), feetY: +feetY.toFixed(2), wantY: +pts.at(-1)!.w[1].toFixed(2), stuck, seconds: +t.toFixed(1) };
  };
  const routes: WalkRoute[] = [];
  for (const p of plans) {
    const res = walk(p);
    routes.push(res);
    const tag = !res.finished ? "FAIL" : res.stuck.length ? "JUMP" : "ok  ";
    console.log(`  ${tag} ${res.id.padEnd(28)} ${String(res.reached).padStart(5)} / ${res.metres} m  feet y ${res.feetY} (floor ${res.wantY})  route ${res.planned}${res.note ? `  ${res.note}` : ""}`);
    for (const s of res.stuck) console.log(`       stuck at ${s.along} m [${s.at.join(", ")}] ${s.jumped ? "(got past)" : "(no way past)"}; nearest prop ${s.nearestProp}; touching ${s.touching.join("; ") || "nothing"}`);
  }
  terrain?.dispose();
  world.dispose();
  const clean = (x: WalkRoute) => x.finished && x.stuck.length === 0 && x.planned === "clear";
  const groundOk = routes.filter((x) => x.kind === "ground").every(clean), upperOk = routes.filter((x) => x.kind === "upper").every(clean);
  const report: WalkReport = { plan: a.planId, scene: a.scene, building: host, at: frame.p.map((v) => +v.toFixed(3)) as P3, yaw: +yawOfQ(frame.q).toFixed(4), laneWidth: a.body.laneWidth, capsule: { radius: a.body.radius, height: a.body.height }, props: feet.length, routes, groundOk, upperOk, ok: groundOk && upperOk, speed: +SPEED.toFixed(2), walkedAt: new Date().toISOString() };
  fs.writeFileSync(a.out, JSON.stringify(report, null, 1) + "\n");
  return report;
}
