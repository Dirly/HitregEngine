/**
 * poi-walk <jobDir> [--scene <id>] [--routes <file>] [--only <text>] [--out <file>] [--no-picture]
 *
 * THE real-body walk gate for a POI job (job.mjs gate 14). Boots the scene exactly as the dedicated server does
 * (tools/_server-boot.mts: the scene's project closure only, the server's statics radius and voxel ring, GameServer +
 * one loopback player driven by input commands) and walks, from a COLD start each time (the body parked outside the
 * world until the server has dropped the ground, then held at the start until the server's own ring is resident):
 *
 *   routes   handoff.json `navigation.routes` (REQUIRED: none is a NO-ROUTES fault; `navigation.network` lines are
 *            ways through the place used to reach targets, not walked as routes), every `path` the job lays and
 *            every landmark's targets in declared order, each BOTH ways. Declared routes are walked with the stick held
 *            along the line (jump when stalled, unless the route says `jump: false`); landmark chains use the ground
 *            planner, which reads only what the server holds around the body.
 *   targets  derived from the job (tools/_poi-walk-lib.mts): landmark targets and openings (walked through), every WFC
 *            doorway (4 m out -> the door -> the cell centre), every portal (reach the anchor; it must send), every
 *            dressing area centre, every circular clearing, every quest/interactable entity. An area, clearing or quest
 *            is reached ALONG the navigation graph (declared routes + `navigation.network` polylines, joined where they
 *            meet) from the way in to its nearest graph point, then the last hop; with no graph point within 12 m (and
 *            for the rest) from the nearest route point by the ground planner. Then a body is dropped onto it (something must hold it at the target's height; a target
 *            with no declared height is dropped onto the highest walkable surface of its column and must stand within
 *            0.75 m of it — no free pass).
 *
 * Faults: FALL (> 2 m in 0.5 s with the feet off the ground, not on a declared drop leg: a stair run down is no fall), STUCK (no progress for 3 s after the jumps), MISS (ended
 * > 1 m XZ / 0.75 m Y from the goal; areas and clearings 2 m), ONE-WAY (a route leg good one way only), PORTAL (reached,
 * did not send; a SEALED portal — no scene, a refusal — must refuse with its own words instead),
 * BODY (a visible static mesh crosses the player's body — capsule r 0.4 m, 0.5-1.8 m over the feet — at a
 * walked point: a visual-only board across a passage; _poi-walk-lib.mts bodyClashes), SHADOW (an asset the POI uses has other bytes under the same id in another project), STREAM (a
 * landmark collider surface where a body stands without the server having loaded that collider), NO-ROUTES.
 *
 * Writes <jobDir>/reports/walk.json { ok, faults, routes, targets, ... } and <jobDir>/reports/walk.png (top-down:
 * terrain shade, declared lines white, walked traces green/red, targets as squares, faults as X), prints a table, and
 * exits 1 on any fault. `--routes <file>` adds trial routes (same format as navigation.routes) for an owner drafting
 * them; the gate still wants them in the handoff.
 *
 * Run from apps/playground:  node node_modules/tsx/dist/cli.mjs tools/poi-walk.mts <jobDir>
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PORTAL_EVENTS, QUEST_EVENTS, chunkKey, landmarkEntities, type ChunkDoc, type LandmarkDoc } from "@hitreg/core";
import { bootServerBody, type ServerBody } from "./_server-boot.mts";
import { walkTo, type WalkDeps } from "./_quest-walk.mts";
import {
  WALK_THROUGH_TAGS, bodySkip,
  fellJustNow as fellJustNowLib, AIR_M, FALL_M, STUCK_S, assetRefs, declaredNetwork, declaredRoutes, densifyPts, derivedRoutes, descendants, dropHoldFault, entityTargets, fileTargets, goalSurface, highestWalkable, judgeLeg, MISS_Y, nearestRoutePoint, networkPath,
  oneWayFaults, portalSentAfterReach, bodyClashes, bodyTrail, readJob, reverseRoute, shadowFaults, uncoveredPoints,
  type EntityView, type Fault, type LegResult, type P3, type Pt, type Route, type Sample, type Target,
} from "./_poi-walk-lib.mts";
import { encodePng } from "./_png.mjs";
import { sceneGeometry } from "./_prop-geometry.mts";
let bodyRow: { points: number; meshes: number; clashes: number } | null = null;

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string): boolean => argv.includes(`--${n}`);
const VALUED = new Set(["--scene", "--routes", "--only", "--out"]);
const jobArg = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && VALUED.has(argv[i - 1]!)));
if (!jobArg) { console.error("usage: poi-walk <jobDir> [--scene <id>] [--routes <file>] [--only <text>] [--out <file>] [--no-picture]"); process.exit(2); }
const PLAYGROUND = path.resolve(import.meta.dirname, "..");
const JOB = path.resolve(jobArg);
const t0 = Date.now();
const job = readJob(JOB);
const r2 = (v: number): number => Math.round(v * 100) / 100;
const fmt = (p: readonly (number | null)[]): string => `[${p.map((v) => (v === null ? "~" : (Math.round(v * 10) / 10).toString())).join(", ")}]`;

// ---- which scene: --scene, else the brief project's scene that holds the POI (tagged poi:<id>), else the world scene when installed, else the preview scene
function sceneOf(): string {
  if (flag("scene")) return flag("scene")!;
  const project = String(job.brief?.["project"] ?? "");
  const pj = path.join(PLAYGROUND, "projects", project, "project.json");
  if (project && fs.existsSync(pj)) {
    for (const s of (JSON.parse(fs.readFileSync(pj, "utf8")) as { scenes?: Array<{ id: string }> }).scenes ?? []) {
      const f = path.join(PLAYGROUND, "projects", project, "assets", "scenes", `${s.id}.scene.json`);
      if (fs.existsSync(f) && fs.readFileSync(f, "utf8").includes(`"poi:${job.poiId}"`)) return s.id;
    }
  }
  // the zonegen world's own scene in the project the job lives in (projects/<p>/authoring/zonegen/<world>/...): an
  // INSTALLED job (an install inverse on disk, its entities not tagged poi:<id>) and a job with no brief or preview (a
  // dressing-only small find) are walked there — never in the owner's preview lab, which no longer is the place
  const parts = JOB.split(/[\\/]/), pi = parts.lastIndexOf("projects"), zi = parts.indexOf("zonegen");
  const worldScene = pi >= 0 && zi > pi && parts[zi + 1] && fs.existsSync(path.join(PLAYGROUND, "projects", parts[pi + 1]!, "assets", "scenes", `${parts[zi + 1]}.scene.json`)) ? parts[zi + 1]! : null;
  const installed = ["install-inverse.json", "install.inverse.json"].some((f) => fs.existsSync(path.join(JOB, f)));
  if (worldScene && installed) return worldScene;
  const prev = (job.handoff["preview"] as { scene?: string } | undefined)?.scene ?? "";
  const m = /([\w-]+)\.scene\.json/.exec(prev) ?? /^([\w-]+)/.exec(prev);
  if (m) return m[1]!;
  if (worldScene) return worldScene;
  throw new Error("no scene: pass --scene (the POI is not installed in its brief's project and handoff.preview names no scene)");
}
const SCENE = sceneOf();

// ---- boot like serve.ts
const b: ServerBody = await bootServerBody({ playground: PLAYGROUND, scene: SCENE, peer: "poi-walk" });
const { world, terrain } = b;
const field = terrain.resolved.field as unknown as WalkDeps["field"] & { recipe: { cellSize: number; features: { landmarks?: LandmarkDoc[]; ribbons?: { id: string; samples: number[][] }[] } } };
const dt = world.fixedDt;

// ---- routes and targets
const routes: Route[] = [...declaredRoutes(job.handoff), ...derivedRoutes(job.worldOps, field.recipe.features.ribbons ?? [])];
const trial = flag("routes") ? declaredRoutes({ navigation: JSON.parse(fs.readFileSync(flag("routes")!, "utf8")) }).map((r) => ({ ...r, id: `trial:${r.id}` })) : [];
routes.push(...trial);
const faults: Fault[] = [];
if (!declaredRoutes(job.handoff).length) faults.push({ kind: "NO-ROUTES", what: "handoff.json navigation.routes", detail: "the job declares no walk routes: add navigation.routes [{ id, points: [[x,y,z],...] }] from every approach to every level of the place" });

const sceneIds = job.sceneOps.map((o) => String(o["id"])).filter((id) => world.entities.has(id));
const owned = descendants(world.entities as unknown as Map<string, { parent?: string | null }>, sceneIds);
const views: EntityView[] = [...owned].map((id) => {
  const e = world.entities.get(id)! as unknown as { parent?: string | null; tags: string[]; components: Record<string, unknown> };
  return { id, parent: e.parent ?? null, tags: e.tags, position: world.positionOf(id), quaternion: world.quaternionOf(id), components: e.components };
});
let targets: Target[] = [...fileTargets(job), ...entityTargets(views)];
const ONLY = flag("only");
const onlyRoutes = ONLY ? routes.filter((r) => r.id.includes(ONLY)) : routes;
if (ONLY) targets = targets.filter((t) => t.id.includes(ONLY));
const centreOf = (): [number, number] => {
  const all = [...routes.flatMap((r) => r.points), ...targets.map((t) => t.at)];
  if (!all.length) return [0, 0];
  return [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[2], 0) / all.length];
};
const [CX, CZ] = centreOf();
console.log(`[poi-walk] ${job.poiId} in ${SCENE}: ${routes.length} route(s) (${declaredRoutes(job.handoff).length} declared), ${targets.length} target(s), ${owned.size} owned entities`);

// ---- body helpers
const bodyPeer = b.bodyId.slice("player:".length);
let trace: Sample[] = [];
let clock = 0;
/** Feet height over the first solid under them (Infinity: nothing within 40 m): a drop counts as a fall only airborne. */
const airAt = (f: P3): number => {
  const hit = world.sim.raycast([f[0], f[1] + 0.3, f[2]], [0, -1, 0], 40, { solid: true, exclude: [b.bodyId] });
  return hit ? Math.max(0, f[1] - hit.point[1]) : Infinity;
};
const walked: P3[] = [];   // BODY: every walked feet position on the ground
const sample = (): void => { const f = b.feet(); const s: Sample = { x: f[0], y: f[1], z: f[2], t: clock, air: airAt(f) }; trace.push(s); bodyTrail([s], 0.25, walked); };
const step = (v: [number, number], jump: boolean): void => { b.stepWith(v, jump); clock += dt; sample(); };
const idle = (n: number): void => { for (let i = 0; i < n; i++) { b.tick(); clock += dt; sample(); } };
const wet = (x: number, z: number): boolean => { const w = field.waterY(x, z); return w !== null && w > field.height(x, z) + 0.2; };
const ringResident = (x: number, z: number): boolean => b.ringCells(x, z).some((k) => { const [cx, cz] = k.split("_").map(Number) as [number, number]; return terrain.has(cx, cz); });
/** Park outside the world until the server has dropped the ground around `near` (a cold arrival), then hold at `p`. */
function coldStart(p: P3, near: P3 = p): void {
  const park = b.parkPoint(near[0] || 1, near[2]);
  for (let t = 0; t < 3600; t++) { world.sim.setPosition(b.bodyId, park); b.tick(); if (t > 20 && !ringResident(near[0], near[2])) break; }
  b.holdAt(p);
  trace = [];
  idle(30); // released: the body settles on whatever the server streamed
}
const startY = (p: Pt): number => (p[1] ?? terrain.groundHeight(p[0], p[2])) + 1.2;
/**
 * Where to stand a body at a route point with no declared height: the walkable surface (terrain OR collider) nearest
 * `refY` (the height the walk was at). The terrain height alone put a resumed body UNDER a causeway deck (the deck
 * 2-6 m over the cut ground), where it walked the ground beneath and "fell" into the cut: a gate artefact, not a fault.
 * The point is held first so its ring and statics are resident, then the column is cast top-down.
 */
function standY(p: Pt, refY: number): number {
  if (p[1] !== null) return p[1] + 1.2;
  const g = terrain.groundHeight(p[0], p[2]);
  b.holdAt([p[0], Math.max(g, refY) + 30, p[2]]);
  world.sim.ensureStaticsAround(p[0], p[2]);
  let best = g, top = Math.max(g, refY) + 30;
  for (let i = 0; i < 12; i++) {
    const hit = world.sim.raycast([p[0], top, p[2]], [0, -1, 0], top - Math.min(g, refY) + 8, { solid: true, exclude: [b.bodyId] });
    if (!hit) break;
    if (Math.abs(hit.point[1] - refY) < Math.abs(best - refY)) best = hit.point[1];
    top = hit.point[1] - 0.05;
  }
  return best + 1.2;
}

/** Collider tops in the column (x, z) from 6 m over `refY` down to 6 m under it (statics already resident: the body
 *  stands beside it). */
function columnSurfaces(x: number, z: number, refY: number): number[] {
  world.sim.ensureStaticsAround(x, z);
  const out: number[] = []; let top = refY + 6;
  for (let i = 0; i < 8; i++) {
    const hit = world.sim.raycast([x, top, z], [0, -1, 0], top - refY + 6, { solid: true, exclude: [b.bodyId] });
    if (!hit) break; out.push(hit.point[1]); top = hit.point[1] - 0.05;
  }
  return out;
}
/** The stick held toward `to` until within `arrive` m, or no progress for STUCK_S (jumping after 1 s when allowed). */
function stickTo(to: Pt, jump: boolean, arrive = 0.8): { stuckAt: P3 | null } {
  let best = Infinity, bestT = clock, jumps = 0;
  const t0 = clock;
  const p0 = b.feet();
  const limit = Math.max(20, (Math.hypot(to[0] - p0[0], to[2] - p0[2]) / b.runSpeed) * 4 + 10);
  for (let k = 0; clock - t0 < limit; k++) {
    const p = b.feet();
    const dx = to[0] - p[0], dz = to[2] - p[2], d = Math.hypot(dx, dz);
    if (d < arrive) return { stuckAt: null };
    if (d < best - 0.3) { best = d; bestT = clock; jumps = 0; }
    if (clock - bestT > STUCK_S) return { stuckAt: p };
    const j = jump && clock - bestT > 1 && jumps < 3 && k % 20 === 0;
    if (j) jumps++;
    step([(dx / d) * b.runSpeed, (dz / d) * b.runSpeed], j);
    if (fellJustNow()) { idle(30); return { stuckAt: null }; }
  }
  return { stuckAt: b.feet() };
}
/** The leg stops after a real fall (not on a declared drop leg): _poi-walk-lib fellJustNow. */
let dropLeg = false;
const fellJustNow = (): boolean => fellJustNowLib(trace, dt, dropLeg);
// the input command's `v` is a velocity (m/s), as a client sends it at run speed (PlayerDriver clamps it)
const deps: WalkDeps = { world, terrain, field, bodyId: b.bodyId, runSpeed: b.runSpeed, stepWith: step, tick: () => idle(1) };
function plannerTo(to: Pt): { stuckAt: P3 | null } {
  const w = walkTo(deps, [to[0], to[2]]);
  if (w.stuck[0]) return { stuckAt: w.stuck[0].at };
  // the planner stops a point or two short of its goal: the last metres are the stick, as a player finishes
  const f = b.feet();
  if (Math.hypot(to[0] - f[0], to[2] - f[2]) < 8) return stickTo(to, true, 0.6);
  return { stuckAt: w.unplanned ? f : null };
}

// ---- routes, both ways, cold
interface LegRow extends LegResult { k: number; from: Pt; to: Pt; resumed: boolean; trace: Array<[number, number, number]> }
interface RouteRow { id: string; source: string; dir: "forward" | "back"; ok: boolean; legs: LegRow[] }
const routeRows: RouteRow[] = [];
// [x, z, feet y]: the y says where a body walked ON something (a FALL off a ledge vs a stair run), 2026-10-29
const thin = (s: Sample[]): Array<[number, number, number]> => s.filter((_, i) => i % 6 === 0 || i === s.length - 1).map((q) => [r2(q.x), r2(q.z), r2(q.y)]);
function walkRoute(r: Route, dir: "forward" | "back"): RouteRow {
  const pts = r.points;
  const start = pts[0]!;
  coldStart([start[0], startY(start), start[2]]);
  const legs: LegRow[] = [];
  let resumed = false;
  for (let k = 0; k + 1 < pts.length; k++) {
    const from = pts[k]!, to = pts[k + 1]!;
    if (k > 0) trace = trace.slice(-1);
    dropLeg = r.drops.includes(k);
    let stuckAt: P3 | null = null;
    if (r.driver === "planner") stuckAt = plannerTo(to).stuckAt;
    else {
      const subs = densifyPts([from, to], 6).slice(1);
      for (const [i, sub] of subs.entries()) { const s = stickTo(sub, r.jump, i === subs.length - 1 ? 0.8 : 1.5); if (s.stuckAt) { stuckAt = s.stuckAt; break; } if (fellJustNow()) break; }
    }
    dropLeg = false;
    // the goal at the surface the body arrived on (stairs, ribbon steps, a deck over the declared ground): goalSurface
    let goal: Pt = to;
    const e = trace[trace.length - 1];
    if (e && to[1] !== null && Math.hypot(e.x - to[0], e.z - to[2]) <= 1.5 && Math.abs(e.y - to[1]) > MISS_Y) goal = [to[0], goalSurface(to[1], columnSurfaces(to[0], to[2], e.y), e.y), to[2]];
    const res = judgeLeg(`${r.id} (${dir}) leg ${k}`, trace, goal, { drop: r.drops.includes(k), stuckAt, wet: wet(to[0], to[2]), wadeXZ: 6 });
    legs.push({ ...res, k, from, to, resumed, trace: thin(trace) });
    if (!res.ok) {
      // carry on from the next point (warm: the ring is already around the route) so one run shows every fault, on
      // the surface the walk was on (a deck, not the ground under it)
      b.holdAt([to[0], standY(to, trace[0]?.y ?? terrain.groundHeight(to[0], to[2])), to[2]]);
      trace = [];
      idle(30);
      resumed = true;
    } else resumed = false;
  }
  return { id: r.id, source: r.source, dir, ok: legs.every((l) => l.ok), legs };
}
for (const r of onlyRoutes) {
  const fwd = walkRoute(r, "forward");
  const back = walkRoute(reverseRoute(r), "back");
  routeRows.push(fwd, back);
  const n = r.points.length - 1;
  // back leg j walks forward leg n-1-j
  const backByFwd = Array.from({ length: n }, (_, k) => back.legs.find((l) => l.k === n - 1 - k));
  faults.push(...fwd.legs.flatMap((l) => l.faults), ...back.legs.flatMap((l) => l.faults), ...oneWayFaults(r.id, fwd.legs, backByFwd));
  console.log(`  route ${r.id}: forward ${fwd.ok ? "ok" : "FAIL"}, back ${back.ok ? "ok" : "FAIL"} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

// ---- targets: reach from the nearest route point (or walk through), then a body must be held there
interface TargetRow { id: string; kind: string; at: Pt; from: Pt | null; reach: (LegResult & { trace: Array<[number, number, number]> }) | null; through: LegResult | null; hold: { ok: boolean; feet: P3; surface?: number } | null; portal: { sent: boolean; refusal: string | null } | null; ok: boolean }
const targetRows: TargetRow[] = [];
const travels: unknown[] = [];
const refusals: string[] = [];
world.eventBus.on(PORTAL_EVENTS.travel, (p) => { travels.push(p); });
world.eventBus.on("character.refused", (p) => { const q = p as { actorId?: string; error?: string }; if (q.actorId === b.bodyId && q.error) refusals.push(q.error); });
// the navigation graph: the declared routes and the declared network
const graphLines: Route[] = [...declaredRoutes(job.handoff), ...declaredNetwork(job.handoff)];
/** Walk a navigation-graph path with the stick (6 m legs, as a declared route), then the last hop to the goal: an area
 *  is reached once within its tolerance (`arrive`; its middle may hold a hearth, a bed or a rack a body stops at). */
function alongNetwork(path: Pt[], goal: Pt, arrive = 0.6): { stuckAt: P3 | null } {
  // (its last point closely: a graph line ends in a hut doorway, and a hop cut 1.2 m short of it meets the door jamb)
  const subs = densifyPts(path, 6).slice(1);
  for (const [i, sub] of subs.entries()) { const s = stickTo(sub, true, i === subs.length - 1 ? 0.4 : 1.2); if (s.stuckAt) return s; if (fellJustNow()) return { stuckAt: null }; }
  return stickTo(goal, true, arrive);
}
for (const t of targets) {
  const row: TargetRow = { id: t.id, kind: t.kind, at: t.at, from: null, reach: null, through: null, hold: null, portal: null, ok: true };
  // an area, clearing or quest target is reached ALONG the job's navigation graph (declared routes + navigation.network:
  // decks, stairs, walkways) to its nearest graph point, then the last hop; a straight line from the nearest route point
  // crosses water and climbs between levels no body can (a stilt village). No graph near it: the ground planner.
  const net = !t.from && !t.portal && (t.kind === "area" || t.kind === "clearing" || t.kind === "quest") ? networkPath(graphLines, t.at) : null;
  const from: Pt | null = t.from ?? (net ? net[0]! : nearestRoutePoint(routes, t.at, 260, (x, z) => field.height(x, z)));
  row.from = from;
  // watch from BEFORE the reach: a walk-through portal sends as the reach walks into its box (_poi-walk-lib portalSentAfterReach)
  travels.length = 0; refusals.length = 0;
  if (from) {
    coldStart([from[0], startY(from), from[2]]);
    const s = t.from ? stickTo(t.at, true, 0.6) : net ? alongNetwork(net, t.at, t.tolXZ ?? 0.6) : plannerTo(t.at);
    const res = judgeLeg(`${t.id} reach from ${fmt([from[0], from[2]])}`, trace, t.at, { tolXZ: t.tolXZ, stuckAt: s.stuckAt, wet: wet(t.at[0], t.at[2]), ...(t.wadeXZ ? { wadeXZ: t.wadeXZ } : {}) });
    row.reach = { ...res, trace: thin(trace) };
    faults.push(...res.faults);
    if (t.through && res.ok) {
      trace = trace.slice(-1);
      const s2 = stickTo([t.through[0], t.through[1], t.through[2]], true, 0.8);
      row.through = judgeLeg(`${t.id} through`, trace, [t.through[0], t.through[1], t.through[2]], { tolXZ: 1.2, stuckAt: s2.stuckAt });
      faults.push(...row.through.faults);
    }
    if (t.portal && res.ok) {
      const portal = t.portal;
      // stepping out: 6 m from the anchor toward where the reach came from (clear of the box, past the 1.5 m arming walk)
      const ox = from[0] - t.at[0], oz = from[2] - t.at[2], ol = Math.hypot(ox, oz) || 1;
      const sent = portalSentAfterReach(portal, travels, {
        stepOut: () => { stickTo([t.at[0] + (ox / ol) * 6, null, t.at[2] + (oz / ol) * 6], false, 0.6); },
        walkIn: () => { stickTo(t.at, false, 0.2); },
        interact: () => world.eventBus.injectFromPeer(bodyPeer, [{ name: QUEST_EVENTS.interact, payload: { actorId: b.bodyId, entityId: portal.entityId } }]),
        idle: () => idle(30),
      });
      row.portal = { sent, refusal: refusals[0] ?? null };
      // L (ravenstacks 2026-10-21): a sealed door passes when it refuses with its declared words (and never sends)
      if (portal.sealed !== undefined) { if (row.portal.sent || row.portal.refusal !== portal.sealed) faults.push({ kind: "PORTAL", what: t.id, at: b.feet(), detail: row.portal.sent ? "a SEALED portal sent a traveller" : `a SEALED portal did not refuse with its words (got: ${row.portal.refusal ?? "nothing"})` }); }
      else if (!row.portal.sent) faults.push({ kind: "PORTAL", what: t.id, at: b.feet(), detail: `reached the anchor, the portal did not send${row.portal.refusal ? ` (refused: ${row.portal.refusal})` : ""}` });
    }
  }
  if (t.at[1] !== null) {
    // something must hold a body at the target's height (warm: the body is here, or was just walked here)
    b.holdAt([t.at[0], t.at[1] + 1.5, t.at[2]]);
    trace = [];
    idle(60);
    const f = b.feet();
    const ok = f[1] > t.at[1] - 1 || wet(t.at[0], t.at[2]);
    row.hold = { ok, feet: [r2(f[0]), r2(f[1]), r2(f[2])] };
    if (!ok) faults.push({ kind: "MISS", what: `${t.id} hold`, at: f, detail: `nothing holds a body at y ${r2(t.at[1])}: dropped onto it, it ended at y ${r2(f[1])}` });
  } else {
    // no declared height is no free pass: find the highest walkable surface in the target's column (statics resident),
    // drop the body onto it from above and require it to stand there (tools/_poi-walk-lib.mts dropHoldFault)
    const g = terrain.groundHeight(t.at[0], t.at[2]), top = g + 60;
    b.holdAt([t.at[0], top, t.at[2]]);
    world.sim.ensureStaticsAround(t.at[0], t.at[2]);
    const hits: Array<{ y: number; ny: number }> = [];
    let y0 = top;
    for (let i = 0; i < 12; i++) {
      const hit = world.sim.raycast([t.at[0], y0, t.at[2]], [0, -1, 0], y0 - g + 8, { solid: true, exclude: [b.bodyId] });
      if (!hit) break;
      hits.push({ y: hit.point[1], ny: hit.normal[1] });
      y0 = hit.point[1] - 0.05;
    }
    const surf = highestWalkable(hits, g);
    b.holdAt([t.at[0], surf + 1.5, t.at[2]]);
    trace = [];
    idle(60);
    const f = b.feet();
    const fault = dropHoldFault(t.id, f, surf, wet(t.at[0], t.at[2]));
    row.hold = { ok: !fault, feet: [r2(f[0]), r2(f[1]), r2(f[2])], surface: r2(surf) };
    if (fault) faults.push(fault);
  }
  row.ok = !faults.some((f) => f.what.startsWith(`${t.id} `) || f.what === t.id);
  targetRows.push(row);
}

// ---- STREAM: every landmark collider surface of the job must be loaded wherever a body can stand on it
const opIds = job.worldOps.map((o) => String(o["id"]));
const lms = (field.recipe.features.landmarks ?? []).filter((l) => opIds.some((id) => l.id === `op:${id}:landmark` || l.id.startsWith(`op:${id}:`)));
const assetPresent = (id: string, kind: "prefab" | "model"): boolean => (kind === "prefab" ? world.assets.getPrefab(id) : world.assets.getModel(id)) !== undefined;
const streamRows: Array<{ id: string; radius: number; footprint: number; uncovered: number; worst: P3 | null; carriers: number }> = [];
for (const l of lms) {
  const cs = b.ring.cellSize;
  const carriers = new Set<string>();
  const c0x = Math.floor((l.position[0] - l.radius) / cs), c1x = Math.floor((l.position[0] + l.radius) / cs);
  const c0z = Math.floor((l.position[2] - l.radius) / cs), c1z = Math.floor((l.position[2] + l.radius) / cs);
  for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
    const ents: ChunkDoc["entities"] = {};
    // the server's own asset check (packages/server terrain.ts): without it only the origin cell carries anything and
    // every tiled bake read as a STREAM fault
    landmarkEntities([l], cs, cx, cz, ents, assetPresent);
    if (Object.keys(ents).length) carriers.add(chunkKey(cx, cz));
  }
  const tag = l.id.replace(/^op:/, "").replace(/:landmark$/, "");
  // the collider's walkable top, carrier by carrier: the body held in that cell (the server keeps it), the cell
  // ensured, the statics streamed around the whole disc (the server adds a static only within 96 m of a body)
  const seenFoot = new Map<string, P3>();
  const extra: P3[] = [];
  for (let z = -l.radius; z <= l.radius; z += 80) for (let x = -l.radius; x <= l.radius; x += 80) extra.push([l.position[0] + x, l.position[1], l.position[2] + z]);
  for (const k of carriers) {
    const [cx, cz] = k.split("_").map(Number) as [number, number];
    b.holdAt([(cx + 0.5) * cs, Math.max(field.height((cx + 0.5) * cs, (cz + 0.5) * cs), l.position[1]) + 200, (cz + 0.5) * cs], 600, 2);
    terrain.ensure(cx, cz);
    b.tick(2);
    world.sim.updateStaticsAroundBodies(extra);
    for (let z = l.position[2] - l.radius; z <= l.position[2] + l.radius; z += 3)
      for (let x = l.position[0] - l.radius; x <= l.position[0] + l.radius; x += 3) {
        if (Math.hypot(x - l.position[0], z - l.position[2]) > l.radius || seenFoot.has(`${x},${z}`)) continue;
        const g = field.height(x, z);
        const hit = world.sim.raycast([x, Math.max(g, l.position[1]) + 150, z], [0, -1, 0], 450, { solid: true, exclude: [b.bodyId] });
        // a top under the terrain is buried rock, not a floor (the terrain cell may simply not be loaded here)
        if (hit && hit.entityId.includes(tag) && hit.point[1] > g - 0.3) seenFoot.set(`${x},${z}`, [x, hit.point[1], z]);
      }
  }
  const foot = [...seenFoot.values()];
  const un = uncoveredPoints(foot, carriers, (x, z) => b.ringCells(x, z));
  let worst: P3 | null = null, wd = -1;
  for (const p of un) { const d = Math.hypot(p[0] - l.position[0], p[2] - l.position[2]); if (d > wd) { wd = d; worst = p; } }
  streamRows.push({ id: l.id, radius: r2(l.radius), footprint: foot.length, uncovered: un.length, worst, carriers: carriers.size });
  if (un.length) faults.push({ kind: "STREAM", what: l.id, at: worst!, detail: `${un.length} of ${foot.length} collider points (${Math.round((100 * un.length) / Math.max(1, foot.length))}%) stand where the server has not loaded this collider (it streams in ${carriers.size} cell(s); ring ${b.ring.simulation}); farthest ${Math.round(wd)} m from its origin` });
}

// meshes the body passes through by design or that move with a creature: bodySkip (_poi-walk-lib)
// ---- BODY: no visible static mesh of the scene may cross the walking body (a visual-only lining board, a post)
{
  const sceneRoot = b.roots.find((r) => fs.existsSync(path.join(r, "assets", "scenes", `${SCENE}.scene.json`))) ?? b.roots[0]!;
  const doc = JSON.parse(fs.readFileSync(path.join(sceneRoot, "assets", "scenes", `${SCENE}.scene.json`), "utf8")) as { entities: Record<string, any> };
  const pad = 2, xs = walked.map((p) => p[0]), zs = walked.map((p) => p[2]);
  const box = walked.length ? [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...zs) - pad, Math.max(...zs) + pad] : null;
  const geo = box ? sceneGeometry(path.join(sceneRoot, "assets"), doc, (id) => bodySkip(doc.entities, id)) : [];
  const meshes = geo.filter((g) => { for (let i = 0; i + 2 < g.world.length; i += 3) if (g.world[i]! >= box![0] && g.world[i]! <= box![1] && g.world[i + 2]! >= box![2] && g.world[i + 2]! <= box![3]) return true; return false; });
  const bf = bodyClashes(walked, meshes);
  bodyRow = { points: walked.length, meshes: meshes.length, clashes: bf.length };
  faults.push(...bf);
}

// ---- SHADOW: the POI's assets must be the same bytes in every project that names them
const refs = assetRefs(views.map((v) => v.components));
for (const l of lms) assetRefs({ prefabId: l.prefab }, refs);
for (const r of [...refs.values()]) if (r.kind === "prefabs") {
  const f = b.roots.map((root) => path.join(root, "assets", "prefabs", r.id)).find((p) => fs.existsSync(p));
  if (f) assetRefs(JSON.parse(fs.readFileSync(f, "utf8")), refs);
}
const projectsDir = path.join(PLAYGROUND, "projects");
const allProjects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(projectsDir, d.name));
const fpCache = new Map<string, string | null>();
const fingerprint = (file: string): string | null => {
  if (!fpCache.has(file)) fpCache.set(file, fs.existsSync(file) ? crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex") : null);
  return fpCache.get(file)!;
};
// the job's own delivery (job folder assets/, installed into its home project by its installer) is the pending install, not a shadow
const homeProject = (() => { const parts = JOB.split(path.sep), i = parts.lastIndexOf("projects"); return i >= 0 && parts[i + 1] ? parts.slice(0, i + 2).join(path.sep) : null; })();
faults.push(...shadowFaults(refs.values(), b.roots, allProjects, fingerprint, homeProject ? { home: homeProject, jobAssets: path.join(JOB, "assets") } : undefined));

// ---- report
const counts: Record<string, number> = {};
for (const f of faults) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
const ok = faults.length === 0;
const reportsDir = path.join(JOB, "reports");
fs.mkdirSync(reportsDir, { recursive: true });
const out = flag("out") ? path.resolve(flag("out")!) : path.join(reportsDir, "walk.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
const picture = has("no-picture") ? null : path.join(path.dirname(out), "walk.png");
const report = {
  ok, partial: ONLY ?? null, at: new Date().toISOString(), poi: job.poiId, scene: SCENE, closure: b.roots.map((r) => path.basename(r)), ring: b.ring,
  method: "server boot (scene closure, statics 96 m, the scene's rings.simulation), GameServer + loopback player, cold start per route direction and per target; stick along declared lines, planner (resident colliders only) to derived targets",
  thresholds: { fallM: FALL_M, fallWindowS: 0.5, stuckS: STUCK_S, missXZ: 1, missY: 0.75 },
  opsFiles: job.files, counts, faults, body: bodyRow, routes: routeRows, targets: targetRows, stream: streamRows, trialRoutes: trial.map((r) => r.id), picture: picture ? path.relative(JOB, picture) : null,
  seconds: Math.round((Date.now() - t0) / 1000),
};
fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");

// ---- picture: top-down, terrain shade, white = declared lines, green/red = walked, square = target, X = fault
if (picture) {
  const pts: Array<[number, number]> = [
    ...routes.flatMap((r) => r.points.map((p) => [p[0], p[2]] as [number, number])), ...targets.map((t) => [t.at[0], t.at[2]] as [number, number]),
    ...faults.filter((f) => f.at && Number.isFinite(f.at[0])).map((f) => [f.at![0], f.at![2]] as [number, number]),
  ];
  if (pts.length) {
    const x0 = Math.min(...pts.map((p) => p[0])) - 25, x1 = Math.max(...pts.map((p) => p[0])) + 25;
    const z0 = Math.min(...pts.map((p) => p[1])) - 25, z1 = Math.max(...pts.map((p) => p[1])) + 25;
    const m = Math.max(0.5, Math.max(x1 - x0, z1 - z0) / 900);
    const W = Math.ceil((x1 - x0) / m), H = Math.ceil((z1 - z0) / m);
    const px = new Uint8Array(W * H * 4);
    const S = 3; // shade sampled every S pixels
    for (let j = 0; j < H; j += S) for (let i = 0; i < W; i += S) {
      const x = x0 + i * m, z = z0 + j * m;
      const h = field.height(x, z), hx = field.height(x + m * S, z), hz = field.height(x, z + m * S);
      const shade = Math.max(0, Math.min(1, 0.55 + ((h - hx) + (h - hz)) / (m * S) * 0.35));
      const water = wet(x, z);
      const c = water ? [40, 70, 110] : [Math.round(70 + 110 * shade), Math.round(70 + 105 * shade), Math.round(60 + 90 * shade)];
      for (let dj = 0; dj < S && j + dj < H; dj++) for (let di = 0; di < S && i + di < W; di++) { const k = ((j + dj) * W + i + di) * 4; px[k] = c[0]!; px[k + 1] = c[1]!; px[k + 2] = c[2]!; px[k + 3] = 255; }
    }
    const put = (x: number, z: number, c: number[], r = 0): void => {
      const ci = Math.round((x - x0) / m), cj = Math.round((z - z0) / m);
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= W || j >= H) continue; const k = (j * W + i) * 4; px[k] = c[0]!; px[k + 1] = c[1]!; px[k + 2] = c[2]!; }
    };
    const line = (a: [number, number], q: [number, number], c: number[], r = 0): void => { const n = Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / (m * 0.5)) + 1; for (let s = 0; s <= n; s++) put(a[0] + ((q[0] - a[0]) * s) / n, a[1] + ((q[1] - a[1]) * s) / n, c, r); };
    for (const r of routes) for (let k = 1; k < r.points.length; k++) line([r.points[k - 1]![0], r.points[k - 1]![2]], [r.points[k]![0], r.points[k]![2]], [235, 235, 235]);
    const GOOD = [40, 200, 90], BAD = [235, 50, 40];
    for (const rr of routeRows) for (const l of rr.legs) for (let k = 1; k < l.trace.length; k++) line(l.trace[k - 1]!, l.trace[k]!, l.ok ? GOOD : BAD, 1);
    for (const tr of targetRows) if (tr.reach) for (let k = 1; k < tr.reach.trace.length; k++) line(tr.reach.trace[k - 1]!, tr.reach.trace[k]!, tr.reach.ok ? GOOD : BAD, 0);
    for (const tr of targetRows) { const c = tr.ok ? [60, 200, 230] : BAD; for (let d = -4; d <= 4; d++) { put(tr.at[0] + d * m, tr.at[2] - 4 * m, c); put(tr.at[0] + d * m, tr.at[2] + 4 * m, c); put(tr.at[0] - 4 * m, tr.at[2] + d * m, c); put(tr.at[0] + 4 * m, tr.at[2] + d * m, c); } }
    for (const f of faults) if (f.at && Number.isFinite(f.at[0])) for (let d = -6; d <= 6; d++) { put(f.at[0] + d * m, f.at[2] + d * m, [255, 230, 0], 1); put(f.at[0] + d * m, f.at[2] - d * m, [255, 230, 0], 1); }
    fs.writeFileSync(picture, encodePng(W, H, px));
  }
}

// ---- table
console.log("");
console.log(`kind       what                                                    where                  detail`);
for (const f of faults) console.log(`${f.kind.padEnd(10)} ${f.what.slice(0, 55).padEnd(55)} ${(f.at ? fmt(f.at) : "").padEnd(22)} ${f.detail ?? ""}`);
for (const t of targetRows) if (t.ok) console.log(`ok         ${t.id.slice(0, 55).padEnd(55)} ${fmt(t.at)}`);
console.log(`\npoi-walk ${job.poiId}: ${ok ? "ok" : `FAILED (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")})`} — ${routeRows.length} route walks, ${targetRows.length} targets, ${report.seconds} s -> ${path.relative(process.cwd(), out)}${picture ? ` + ${path.relative(process.cwd(), picture)}` : ""}`);
process.exit(ok ? 0 : 1);
