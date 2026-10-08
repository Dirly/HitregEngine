/**
 * approach-walk --project <p> --scene <world scene> --reservations <zones/<z>/reservations.json> [--only <location>]
 *
 * The real-body approach proof for a reserved location no POI owner builds (a `wild` stretch: populate's creatures,
 * no handoff to record a walk in). Boots the scene as the dedicated server does (HeadlessWorld + TerrainStreamer with
 * scatter colliders + GameServer, one player over a loopback RoomClient), sets the body down on the approach's first
 * point (on the road it is reached from), walks it through every approach point to the location's centre (planner:
 * tools/_quest-walk.mts) and back out to the first point. Writes <zone dir>/reports/approach-walk.json:
 *   { at, scene, locations: { <location>: { ok, from, legs: [{ to, finished, metres, stuck, endDist }] } } }
 * which `zonegen audit` reads for a location without a POI job. Exit 1 when any walked location fails.
 * A centre under standing water counts as reached within 6 m (a bog's middle is wading, not a place to stand).
 */
import fs from "node:fs";
import path from "node:path";
import {
  GameServer, HeadlessWorld, TerrainStreamer, defaultEvents, defaultRegistry, defaultScripts, extractPlayerTemplate,
  loadContent, loadProjectScripts, playgroundRoots, resolveServerVoxelWorld,
} from "../../../packages/server/src/index.ts";
import { LoopbackHub, RoomClient } from "@hitreg/net";
import { walkTo, type P2, type P3, type WalkDeps } from "./_quest-walk.mts";

const arg = (n: string): string => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1]! : ""; };
const SCENE = arg("--scene"), RES = arg("--reservations"), ONLY = arg("--only");
if (!SCENE || !RES) { console.error("usage: approach-walk --scene <scene> --reservations <reservations.json> [--only <location>]"); process.exit(2); }
interface Reservation { location: string; center: P2; radius: number; approach: { from: string; points: P2[] } }
const reservations = ((JSON.parse(fs.readFileSync(RES, "utf8")) as { reservations: Reservation[] }).reservations).filter((r) => !ONLY || r.location === ONLY);
const zoneDir = path.dirname(RES);
const poiDone = (loc: string): boolean => fs.existsSync(path.join(zoneDir, "pois", loc, "progress.json"));
const todo = reservations.filter((r) => ONLY || !poiDone(r.location));
if (!todo.length) { console.log("approach-walk: every reservation has a POI owner (its handoff records the walk)"); process.exit(0); }

const t0 = Date.now();
const content = loadContent(playgroundRoots(path.resolve(".")));
const doc = content.scenes.get(SCENE);
if (!doc) throw new Error(`no scene ${SCENE}`);
const events = defaultEvents();
const scripts = defaultScripts(events);
await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
const world = await HeadlessWorld.create({ doc, assets: content.assets, registry: defaultRegistry(), events, scripts, exclude: (_id, e) => e.tags.includes("player") });
const voxel = resolveServerVoxelWorld(world.base);
if (!voxel) throw new Error("scene has no voxel world");
const terrain = new TerrainStreamer(world, voxel, { pool: false });
const template = extractPlayerTemplate(world.expanded);
if (!template) throw new Error("no player template");
const first = todo[0]!.approach.points[0]!;
terrain.ensureAround(first[0], first[1], 3);
let spawnAt: P3 = [first[0], terrain.groundHeight(first[0], first[1]) + 1.2, first[1]];
const hub = new LoopbackHub({ manualFlush: true });
const server = new GameServer({ world, transport: hub.connect("host"), terrain, scene: SCENE, playerTemplate: template, spawnPoint: () => spawnAt, snapshotEvery: 600, reconnectGraceSeconds: 0 });
const PEER = "approach-walker", BODY = `player:${PEER}`;
const client = new RoomClient(hub.connect(PEER), "host");
client.join("Approach Walker");
const flushAsync = async (): Promise<void> => { for (let i = 0; i < 4; i++) { hub.flush(); await new Promise((r) => setTimeout(r, 0)); } };
const tick = (n = 1): void => { for (let i = 0; i < n; i++) { hub.flush(); server.tick(); } hub.flush(); };
for (let i = 0; i < 20 && !world.entities.has(BODY); i++) { await flushAsync(); server.tick(); await flushAsync(); }
if (!world.entities.has(BODY)) throw new Error("player never joined");
tick(60);
// creatures would interrupt a walk with fights: a proof of the ground, not of combat (populate's packs are proven by play)
const net = world.netState as unknown as { set(k: string, v: unknown): boolean };
let seq = 0;
const stepWith = (v: [number, number], jump: boolean): void => { client.sendCommand({ t: "input", seq: ++seq, v, jump, vy: 0, yaw: Math.atan2(v[0], v[1]) }); net.set(`combat/${BODY}.hp`, 1e6); tick(); };
const RUN = typeof template.controller["speed"] === "number" ? (template.controller["speed"] as number) : 6.5;
const deps: WalkDeps = { world, terrain, field: terrain.resolved.field as unknown as WalkDeps["field"], bodyId: BODY, runSpeed: RUN, stepWith, tick: () => tick() };
const fld = terrain.resolved.field as unknown as { height(x: number, z: number): number; waterY(x: number, z: number): number | null };
const wet = (x: number, z: number): boolean => { const w = fld.waterY(x, z); return w != null && w > fld.height(x, z); };

const out: Record<string, unknown> = {};
let allOk = true;
for (const r of todo) {
  const pts = r.approach.points;
  const start = pts[0]!;
  terrain.ensureAround(start[0], start[1], 3);
  spawnAt = [start[0], terrain.groundHeight(start[0], start[1]) + 1.2, start[1]];
  world.sim.setPosition(BODY, spawnAt);
  tick(30);
  const legs: Array<{ to: P2; finished: boolean; metres: number; stuck: number; endDist: number; ok: boolean }> = [];
  const route: P2[] = [...pts.slice(1), r.center, ...[...pts].reverse()];
  for (const to of route) {
    const w = walkTo(deps, to);
    const p = world.positionOf(BODY)!;
    const endDist = +Math.hypot(p[0] - to[0], p[2] - to[1]).toFixed(2);
    const reach = to === r.center && wet(to[0], to[1]) ? 6 : 3;
    const ok = endDist <= reach && w.stuck.length === 0;
    legs.push({ to, finished: w.finished, metres: w.metres, stuck: w.stuck.length, endDist, ok });
    console.log(`${ok ? "OK  " : "FAIL"} ${r.location.padEnd(18)} -> [${to.map((v) => Math.round(v)).join(", ")}] metres=${w.metres} dist=${endDist} stuck=${w.stuck.length}`);
  }
  const ok = legs.every((l) => l.ok);
  allOk &&= ok;
  out[r.location] = { ok, from: r.approach.from, legs };
}
const file = path.join(zoneDir, "reports", "approach-walk.json");
const prev = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { locations?: Record<string, unknown> }).locations ?? {} : {};
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), scene: SCENE, method: "server PlayerDriver body, scatter colliders on, approach points -> centre -> back", locations: { ...prev, ...out } }, null, 1) + "\n");
console.log(`approach-walk: ${allOk ? "ok" : "FAILED"} (${((Date.now() - t0) / 1000).toFixed(0)} s) -> ${path.relative(".", file)}`);
process.exit(allOk ? 0 : 1);
