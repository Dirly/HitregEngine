/**
 * Proof for `zonegen populate` on a scratch scene the batch was installed into (never the live scene):
 *   npx tsx tools/zonegen/commands/_populate-prove.mts --project voxel-demo --scene zt-populate-proof --zone zone-5 [--pack <regex>] [--min 2] [--out <json>]
 *
 * --pack picks the pack by its templates' ids (default the timber wolves, ^pop-wolf-timber); a dressed-human pack is
 * e.g. --pack ^pop-wrecker (populate's body "human" templates). --min is the smallest pack size accepted (default 2).
 * --player-hp raises the prover's maxHp (test only, recorded in the result): a camp where several templates stand
 * beside the spawned pack can out-damage a 220 hp player before one body dies, which proves balance, not wiring.
 *
 * Boot is tools/quest-play.mts' (serve() minus sockets and saves; the real server-side player body over a loopback
 * client); the fight is its kill path (steer at the victim, send `combat.cast.request` strike as a client does).
 *  1. every populate area in the zone is woken once: each spawned body checked against sanctuaries and roads, then slept;
 *     plus SpawnAreaManager.borderWarnings;
 *  2. the player walks up to the nearest real-body pack matching --pack (default wolves): asleep outside, awake inside;
 *  3. the pack fights (the player's hp drops), and the player kills one (combat.killed with the player as killer).
 */
import fs from "node:fs";
import path from "node:path";
import {
  GameServer, HeadlessWorld, NpcManager, SpawnAreaManager, TerrainStreamer, defaultEvents, defaultRegistry, defaultScripts,
  extractPlayerTemplate, loadContent, loadProjectScripts, playgroundRoots, resolveServerVoxelWorld,
} from "../../../../../packages/server/src/index.ts";
import { LoopbackHub, RoomClient } from "@hitreg/net";
import { sanctuariesFromPois, SANCTUARIES_KEY, type RegionDoc, type SanctuaryCircle } from "@hitreg/core";

type P3 = [number, number, number];
const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] ?? d : d);
const sceneName = opt("scene", "");
const zone = opt("zone", "");
if (!sceneName.startsWith("zt-populate")) throw new Error("--scene must be a zt-populate-* scratch copy");
const projectDir = path.resolve("projects", opt("project", "voxel-demo"));
const t0 = Date.now();

// ---- boot (quest-play's) -----------------------------------------------------------------------------------------
const content = loadContent(playgroundRoots(path.resolve(".")));
const doc = content.scenes.get(sceneName);
if (!doc) throw new Error(`no scene ${sceneName}`);
const events = defaultEvents();
const scripts = defaultScripts(events);
await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
const world = await HeadlessWorld.create({ doc, assets: content.assets, registry: defaultRegistry(), events, scripts, exclude: (_id, e) => e.tags.includes("player") });
const voxel = resolveServerVoxelWorld(world.base);
const terrain = voxel ? new TerrainStreamer(world, voxel, { pool: false }) : null;
const template = extractPlayerTemplate(world.expanded);
if (!template || !terrain) throw new Error("scene needs a player template and a voxel world");
const playerHp = Number(opt("player-hp", "0"));
if (playerHp > 0)
  for (const e of Object.values(template.entities)) {
    const sc = e.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
    if (sc?.name === "combat-actor") sc.params = { ...sc.params, maxHp: playerHp };
  }
const hub = new LoopbackHub({ manualFlush: true });
let spawnAt: P3 = [0, 50, 0];
const server = new GameServer({ world, transport: hub.connect("host"), terrain, scene: sceneName, playerTemplate: template, spawnPoint: () => spawnAt, snapshotEvery: 600, reconnectGraceSeconds: 0 });
const npcs = new NpcManager(server, { respawnSeconds: 20 });
const spawnAreas = new SpawnAreaManager(server, npcs);
const recipe = terrain.resolved.field.recipe;
const sanct: SanctuaryCircle[] = sanctuariesFromPois(recipe.features.pois);
for (const region of recipe.regions as ReadonlyArray<RegionDoc>) {
  if (!region.tags.includes("safe")) continue;
  const [cx, cz] = region.hub;
  let r = 0;
  for (const [x, z] of region.polygon) r = Math.max(r, Math.hypot(x - cx, z - cz));
  if (r > 0) sanct.push([cx, cz, r, terrain.groundHeight(cx, cz)]);
}
world.netState.set(SANCTUARIES_KEY, sanct);
const PEER = "populate-prover";
const BODY = `player:${PEER}`;
const client = new RoomClient(hub.connect(PEER), "host");
client.join("Populate Prover");
const flushAsync = async (): Promise<void> => { for (let i = 0; i < 4; i++) { hub.flush(); await new Promise((r) => setTimeout(r, 0)); } };
const tick = (n = 1): void => { for (let i = 0; i < n; i++) { hub.flush(); server.tick(); } hub.flush(); };
for (let i = 0; i < 20 && !world.entities.has(BODY); i++) { await flushAsync(); server.tick(); await flushAsync(); }
if (!world.entities.has(BODY)) throw new Error("the loopback player never joined");
tick(60);
const net = world.netState;
const pos = (): P3 => world.positionOf(BODY)!;
const dead = (id: string): boolean => net.get(`combat/${id}.dead`) === true;
const hp = (id: string): number => Number(net.get(`combat/${id}.hp`) ?? NaN);
let seq = 0;
const send = (input: unknown): void => client.sendCommand(input);
const stepWith = (v: [number, number]): void => { send({ t: "input", seq: ++seq, v, jump: false, vy: 0, yaw: Math.atan2(v[0], v[1]) }); tick(); };
const teleport = (p: P3): void => { terrain.ensureAround(p[0], p[2], 1); tick(); world.sim.setPosition(BODY, p); tick(30); };
const kills: Array<{ victimId: string; killerId: string | null }> = [];
world.eventBus.on("combat.killed", (p) => kills.push(p as { victimId: string; killerId: string | null }));
const seenEvents: Record<string, number> = {};
for (const name of ["mob.attack", "combat.cast.request", "combat.cast", "combat.cast.accepted", "combat.defended", "combat.stagger", "combat.fx", "combat.damage", "combat.hit", "mob.alert"]) world.eventBus.on(name, (p) => { const who = (p as { casterId?: string; mobId?: string; sourceId?: string }); const mob = String(who.casterId ?? who.mobId ?? who.sourceId ?? ""); if (mob !== BODY) seenEvents[name] = (seenEvents[name] ?? 0) + 1; if (process.env.POP_DEBUG && name === "combat.cast.rejected") console.log("  rejected", JSON.stringify(p)); });
const RUN = typeof template.controller["speed"] === "number" ? (template.controller["speed"] as number) : 6.5;
console.log(`booted ${sceneName} in ${Date.now() - t0} ms: ${npcs.list().length} managed NPCs, ${spawnAreas.areas.size} spawn areas`);

// ---- 1. wake every populate area of the zone once; check every spawned body ---------------------------------------
const mine = [...spawnAreas.areas.values()].filter((a) => world.entities.get(a.id)?.tags.includes("populate") && world.entities.get(a.id)?.tags.includes(`zone:${zone}`));
const roads = recipe.features.roads;
const roadDist = (x: number, z: number): { d: number; id: string } => {
  let best = { d: Infinity, id: "" };
  for (const r of roads)
    for (let k = 1; k < r.points.length; k++) {
      const [ax, az] = r.points[k - 1]!;
      const [bx, bz] = r.points[k]!;
      const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2));
      const d = Math.hypot(x - (ax + vx * u), z - (az + vz * u)) - r.width / 2;
      if (d < best.d) best = { d, id: r.id };
    }
  return best;
};
const violations: string[] = [];
let spawned = 0;
let minRoad = Infinity;
let minSanct = Infinity;
for (const a of mine) {
  if (a.data.spawns.length === 0) continue;
  spawnAreas.wake(a);
  for (const id of a.npcIds) {
    const p = world.positionOf(id);
    if (!p) continue;
    spawned++;
    const rd = roadDist(p[0], p[2]);
    minRoad = Math.min(minRoad, rd.d);
    if (rd.d < 0) violations.push(`${id} on road ${rd.id} (${rd.d.toFixed(1)} m)`);
    for (const [sx, sz, sr] of sanct) {
      const d = Math.hypot(p[0] - sx, p[2] - sz) - sr;
      minSanct = Math.min(minSanct, d);
      if (d < 0) violations.push(`${id} inside a sanctuary (${d.toFixed(1)} m)`);
    }
  }
  spawnAreas.sleep(a);
}
const border = spawnAreas.borderWarnings(recipe.regions, 20).filter((w) => mine.some((a) => a.id === w.id));
console.log(`1. woke ${mine.length} areas: ${spawned} bodies; nearest to a road edge ${minRoad.toFixed(1)} m, to a sanctuary edge ${minSanct.toFixed(1)} m; ${violations.length} violations; ${border.length} border warnings`);
for (const v of violations.slice(0, 10)) console.log(`   ${v}`);

// ---- 2. approach a real wolf pack ----------------------------------------------------------------------------------
const tplOf = (a: (typeof mine)[number]): string[] => a.data.spawns.map((s) => s.template);
const packRe = new RegExp(opt("pack", "^pop-wolf-timber"));
const minPack = Number(opt("min", "2"));
const isWolf = (t: string): boolean => packRe.test(t) && !world.entities.get(t)?.tags.includes("placeholder");
const fresh = mine.filter((a) => a.wokeCount === 1 && tplOf(a).some(isWolf) && a.data.spawns.reduce((n, s) => n + s.count, 0) >= minPack);
// a pack that woke in step 1 resumes in place: pick the one nearest Tidewell
const hubXZ = recipe.regions.find((r) => r.id === zone)!.hub;
fresh.sort((a, b) => Math.hypot(a.position[0] - hubXZ[0], a.position[2] - hubXZ[1]) - Math.hypot(b.position[0] - hubXZ[0], b.position[2] - hubXZ[1]));
const pack = fresh[0];
if (!pack) throw new Error(`no real-body pack matching ${packRe} with >= ${minPack} spawns`);
const [px, , pz] = pack.position;
const ground = (x: number, z: number): number => terrain.groundHeight(x, z);
const off = pack.data.radius + 40;
teleport([px + off, ground(px + off, pz) + 1.2, pz]);
tick(40);
const asleepOutside = !pack.awake;
// walk in, as a client does
let walked = 0;
for (let t = 0; t < 60 * 30 && !pack.awake; t++) {
  const p = pos();
  const dx = px - p[0], dz = pz - p[2], l = Math.hypot(dx, dz) || 1;
  stepWith([(dx / l) * RUN, (dz / l) * RUN]);
  walked = Math.hypot(p[0] - px - off, p[2] - pz);
}
const wokeAt = Math.hypot(pos()[0] - px, pos()[2] - pz);
console.log(`2. ${pack.id} [${Math.round(px)}, ${Math.round(pz)}] ${pack.data.spawns.map((s) => `${s.count}x ${s.template}`).join(" + ")}: asleep at ${off} m = ${asleepOutside}; woke when the walking player was ${wokeAt.toFixed(1)} m away (radius ${pack.data.radius}); ${pack.npcIds.length} bodies`);

// ---- 3. the fight (quest-play's kill path) -------------------------------------------------------------------------
tick(30);
const hp0 = hp(BODY);
const wolves = pack.npcIds.filter((id) => world.entities.has(id) && !dead(id));
let victim = wolves.sort((a, b) => Math.hypot(...([0, 2].map((k) => world.positionOf(a)![k]! - pos()[k]!) as [number, number])) - Math.hypot(...([0, 2].map((k) => world.positionOf(b)![k]! - pos()[k]!) as [number, number])))[0]!;
let minHp = hp0;
let won = false;
let died = false;
const vhp0 = hp(victim);
// first stand in the pack without striking: the pack must hurt a player who does nothing (up to 25 s)
for (let t = 0; t < 60 * 25 && minHp >= hp0 && !dead(BODY); t++) {
  const p = pos();
  const v = world.positionOf(victim);
  if (!v) break;
  const dx = v[0] - p[0], dz = v[2] - p[2], l = Math.hypot(dx, dz) || 1;
  stepWith(l > 3 ? [(dx / l) * RUN, (dz / l) * RUN] : [0, 0]);
  minHp = Math.min(minHp, hp(BODY));
  if (process.env.POP_DEBUG && t % 180 === 0) { const keys = [`combat/${victim}.hp`, `combat/${victim}.faction`, `combat/${victim}.dead`, `combat/${BODY}.faction`, `combat/${BODY}.hp`, `landing/${BODY}`, `mob/${victim}.state`, `mob/${victim}.target`].map((k) => `${k.split("/")[0]}/..${k.slice(k.lastIndexOf("."))}=${JSON.stringify(net.get(k))}`); console.log(`  t=${(t / 60).toFixed(0)}s d=${l.toFixed(1)} player=${p.map((n) => n.toFixed(1))} wolf=${v.map((n) => n.toFixed(1))} ${keys.join(" ")}`); }
}
for (let t = 0; t < 60 * 60 && !won; t++) {
  if (dead(BODY)) { died = true; break; }
  minHp = Math.min(minHp, hp(BODY));
  const p = pos();
  const v = world.positionOf(victim);
  if (!v) break;
  const dx = v[0] - p[0], dz = v[2] - p[2], l = Math.hypot(dx, dz) || 1;
  if (l < 2.3 && t % 20 === 0) send({ t: "event", name: "combat.cast.request", payload: { casterId: BODY, abilityId: "strike", aim: [dx / l, dz / l] } });
  stepWith(l > 1.6 ? [(dx / l) * RUN, (dz / l) * RUN] : [0, 0]);
  won = kills.some((k) => k.victimId === victim && k.killerId === BODY);
  if (process.env.POP_DEBUG && t % 120 === 0) console.log(`  fight t=${(t / 60).toFixed(0)}s d=${l.toFixed(1)} player hp ${hp(BODY).toFixed(0)} victim hp ${hp(victim).toFixed(0)}`);
}
tick(20);
const result = {
  scene: sceneName, zone, at: new Date().toISOString(),
  sweep: { areas: mine.length, bodies: spawned, minRoadEdge: +minRoad.toFixed(1), minSanctuaryEdge: +minSanct.toFixed(1), violations, borderWarnings: border },
  approach: { area: pack.id, spawns: pack.data.spawns, asleepAt: off, asleepOutside, wokeAtDistance: +wokeAt.toFixed(1), radius: pack.data.radius, bodies: pack.npcIds },
  fight: { playerMaxHpOverride: playerHp || null, victim, victimHp: vhp0, victimHpEnd: hp(victim), playerHp: hp0, playerMinHp: minHp, packHitPlayer: minHp < hp0, playerDied: died, killedByPlayer: won, kills: kills.filter((k) => k.killerId === BODY) },
};
if (process.env.POP_DEBUG) console.log("  events not from the player:", JSON.stringify(seenEvents));
console.log(`3. fight with ${victim} (hp ${vhp0}): player hp ${hp0} -> min ${minHp} (pack hit back: ${minHp < hp0}); killed by the player's strikes: ${won}${died ? " (player died)" : ""}`);
const out = opt("out", path.join(projectDir, "authoring", "zonegen", "proving", "zones", zone, "reports", "populate-proof.json"));
fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), out)}`);
process.exit(violations.length || !asleepOutside || !pack.awake || !won || !(minHp < hp0) ? 1 : 0); // a pack that cannot hurt an idle player is a failure
