/**
 * approach-walk --project <p> --scene <world scene> --reservations <zones/<z>/reservations.json> [--only <location>]
 *
 * The real-body approach proof for a reserved location no POI owner has proven (a `wild` stretch: populate's creatures,
 * no handoff to record a walk in; or a POI job whose own walk gate — tools/poi-walk.mts, job.mjs gate 14 — has not
 * passed for its current ops). Boots the scene exactly as the dedicated server does (tools/_server-boot.mts: the
 * scene's project closure only, the server's ring, GameServer + one loopback player), sets the body down on the
 * approach's first point (held until the server's own ring is resident: nothing is ensured past it), walks it through
 * every approach point to the location's centre (planner: tools/_quest-walk.mts) and back out to the first point.
 * The planner's walk stops short of each point by up to ~3 m; the last metres are walked straight on the stick
 * (_quest-walk finishAt, as poi-walk finishes its legs). A leg is ok when the body ends within 3 m (XZ) AND within 0.75 m of the ground height there (a fall to the terrain
 * under a deck is not an arrival). Writes <zone dir>/reports/approach-walk.json:
 *   { at, scene, locations: { <location>: { ok, from, legs: [{ to, finished, metres, stuck, endDist }] } } }
 * which `zonegen audit` reads for a location without a POI job. Exit 1 when any walked location fails.
 * A centre under standing water counts as reached within 6 m (a bog's middle is wading, not a place to stand).
 */
import fs from "node:fs";
import path from "node:path";
import { bootServerBody } from "./_server-boot.mts";
import { finishAt, walkTo, type P2, type WalkDeps } from "./_quest-walk.mts";
import { walkBlock } from "../../../tools/poi-review/job.mjs";

const arg = (n: string): string => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1]! : ""; };
const SCENE = arg("--scene"), RES = arg("--reservations"), ONLY = arg("--only");
if (!SCENE || !RES) { console.error("usage: approach-walk --scene <scene> --reservations <reservations.json> [--only <location>]"); process.exit(2); }
interface Reservation { location: string; center: P2; radius: number; approach: { from: string; points: P2[] } }
const reservations = ((JSON.parse(fs.readFileSync(RES, "utf8")) as { reservations: Reservation[] }).reservations).filter((r) => !ONLY || r.location === ONLY);
const zoneDir = path.dirname(RES);
/** A POI job proves its own approaches with poi-walk: skip it only when that gate passed for its current ops. */
const poiDone = (loc: string): boolean => { const dir = path.join(zoneDir, "pois", loc); return fs.existsSync(path.join(dir, "progress.json")) && walkBlock(dir) === null; };
const todo = reservations.filter((r) => (ONLY || !poiDone(r.location)) && r.approach.points.length > 0);
for (const r of reservations) if (!r.approach.points.length && !poiDone(r.location)) console.log(`approach-walk: ${r.location} declares no approach points and has no passing poi-walk — nothing proves it is reachable`);
if (!todo.length) { console.log("approach-walk: every reservation is proven by its POI's walk gate (or has no approach points)"); process.exit(0); }

const t0 = Date.now();
const b = await bootServerBody({ playground: path.resolve("."), scene: SCENE, peer: "approach-walker" });
const { world, terrain } = b;
// creatures would interrupt a walk with fights: a proof of the ground, not of combat (populate's packs are proven by play)
const deps: WalkDeps = { world, terrain, field: terrain.resolved.field as unknown as WalkDeps["field"], bodyId: b.bodyId, runSpeed: b.runSpeed, stepWith: b.stepWith, tick: () => b.tick() };
const fld = terrain.resolved.field as unknown as { height(x: number, z: number): number; waterY(x: number, z: number): number | null };
const wet = (x: number, z: number): boolean => { const w = fld.waterY(x, z); return w != null && w > fld.height(x, z); };
b.calibrate(todo[0]!.approach.points[0]![0], todo[0]!.approach.points[0]![1]);

const out: Record<string, unknown> = {};
let allOk = true;
for (const r of todo) {
  const pts = r.approach.points;
  const start = pts[0]!;
  b.holdAt([start[0], terrain.groundHeight(start[0], start[1]) + 1.2, start[1]]);
  b.tick(30);
  const legs: Array<{ to: P2; finished: boolean; metres: number; stuck: number; endDist: number; endDy: number; ok: boolean }> = [];
  const route: P2[] = [...pts.slice(1), r.center, ...[...pts].reverse()];
  for (const to of route) {
    const w = walkTo(deps, to);
    // the planner stops short of its goal by up to ~3 m (its own stopping distance): finish the last metres on the
    // stick, as poi-walk does, unless it stuck or never planned. A miss stays a miss (no progress = it stops), and the
    // height is still judged (dy)
    const p0 = b.feet();
    if (!w.stuck.length && !w.unplanned && Math.hypot(p0[0] - to[0], p0[2] - to[1]) < 8) finishAt(deps, to);
    const p = b.feet();
    const endDist = +Math.hypot(p[0] - to[0], p[2] - to[1]).toFixed(2);
    const endDy = +(p[1] - terrain.groundHeight(to[0], to[1])).toFixed(2);
    const soaked = wet(to[0], to[1]);
    const reach = to === r.center && soaked ? 6 : 3;
    const ok = endDist <= reach && (soaked || Math.abs(endDy) <= 0.75) && w.stuck.length === 0;
    legs.push({ to, finished: w.finished, metres: w.metres, stuck: w.stuck.length, endDist, endDy, ok });
    console.log(`${ok ? "OK  " : "FAIL"} ${r.location.padEnd(18)} -> [${to.map((v) => Math.round(v)).join(", ")}] metres=${w.metres} dist=${endDist} dy=${endDy} stuck=${w.stuck.length}${w.stuck[0] ? ` first stuck ${JSON.stringify(w.stuck[0])}` : ""}`);
  }
  const ok = legs.every((l) => l.ok);
  allOk &&= ok;
  out[r.location] = { ok, from: r.approach.from, legs };
}
const file = path.join(zoneDir, "reports", "approach-walk.json");
const prev = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { locations?: Record<string, unknown> }).locations ?? {} : {};
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), scene: SCENE, method: "server boot (scene closure, server ring), PlayerDriver body, approach points -> centre -> back; ok = within 3 m XZ and 0.75 m of the ground", locations: { ...prev, ...out } }, null, 1) + "\n");
console.log(`approach-walk: ${allOk ? "ok" : "FAILED"} (${((Date.now() - t0) / 1000).toFixed(0)} s) -> ${path.relative(".", file)}`);
process.exit(allOk ? 0 : 1);
