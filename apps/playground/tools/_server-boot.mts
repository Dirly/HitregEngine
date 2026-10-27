/**
 * Boot a scene EXACTLY the way the dedicated server does (packages/server/src/serve.ts `serve`), for the real-body
 * walk gates (poi-walk, approach-walk):
 *
 * - assets from the scene's project CLOSURE only (`playgroundRoots(dir, scene)`, serve.ts:269): a lab or scratch
 *   project can never shadow the content the server serves;
 * - HeadlessWorld with the server's statics streaming (`streamStatics: { radius: 96 }`, serve.ts:285);
 * - the voxel ring = the scene's own `rings.simulation` (`resolveServerVoxelWorld(world.base)`, no override);
 * - TerrainStreamer generating inline (pool:false: the same cells and colliders as the worker pool, deterministic);
 * - GameServer + one player over a loopback RoomClient, driven by the same input commands a client sends.
 *
 * Nothing here ensures terrain: the server streams its own ring around the body. `holdAt` parks the body (teleport,
 * velocities zeroed every tick) until the server's ring around it is resident, the way an arriving player has walked
 * into ground that was already streaming.
 */
import path from "node:path";
import {
  GameServer, HeadlessWorld, NpcManager, SpawnAreaManager, TerrainStreamer, defaultEvents, defaultRegistry, defaultScripts, extractPlayerTemplate,
  loadContent, loadProjectScripts, playgroundRoots, prepareTerrainCache, resolveServerVoxelWorld, type LoadedContent,
} from "../../../packages/server/src/index.ts";
import { LoopbackHub, RoomClient } from "@hitreg/net";
import { applyOps, applyRecipeEdits, computeChunkStates, getVoxelWorld, registerVoxelWorld } from "@hitreg/core";

export type P3 = [number, number, number];

/** serve.ts `staticsRadius` default (the server's statics streaming radius, metres). */
export const SERVER_STATICS_RADIUS = 96;

export interface ServerBody {
  playground: string;
  roots: string[];
  content: LoadedContent;
  world: HeadlessWorld;
  terrain: TerrainStreamer;
  server: GameServer;
  bodyId: string;
  runSpeed: number;
  /** Server ring (cells), keepPadding and cell size: what the server streams for one body. */
  ring: { simulation: number; keepPadding: number; cellSize: number; limitCells: number };
  /** Advance n server ticks (flushing the loopback both ways). */
  tick(n?: number): void;
  /** One input command (unit stick, jump) and one tick. The walker is immortal (hp topped up): a proof of ground, not combat. */
  stepWith(v: [number, number], jump: boolean): void;
  /** Feet height of the body (capsule centre minus the calibrated foot offset). */
  feet(): P3;
  /** Teleport, then hold the body there until every cell of the server's ring around it is resident. Returns ticks held. */
  holdAt(p: P3, maxTicks?: number, extraTicks?: number): number;
  /** Cells the server's ring wants around (x, z), cold (no hysteresis). */
  ringCells(x: number, z: number): string[];
  /** A point outside the world disc, in the direction of (x, z): nothing streams there. */
  parkPoint(x: number, z: number): P3;
  /** Measure the capsule-centre-to-floor offset standing on open ground at (x, z) (once, after boot). */
  calibrate(x: number, z: number): void;
}

export async function bootServerBody(opts: { playground: string; scene: string; peer?: string; log?: (s: string) => void; /** read the server terrain cache (.hitreg/terrain-cache) when one matches this recipe: the cells the live server serves, cooked once */ terrainCache?: boolean; /** ops applied to the scene doc in memory before the world is built */ docOps?: unknown[]; /** world recipe edits applied in memory (re-registered) before the terrain streams: a carve not yet installed */ recipeEdits?: unknown[] }): Promise<ServerBody> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const roots = playgroundRoots(opts.playground, opts.scene);
  const content = loadContent(roots);
  let doc = content.scenes.get(opts.scene);
  // a gate trying content BEFORE it is installed (place-build lift gate): the ops applied to the scene in memory only
  if (doc && opts.docOps?.length) doc = applyOps(doc, opts.docOps as never, defaultRegistry()).doc;
  if (!doc) throw new Error(`scene "${opts.scene}" not found in its project closure (${roots.map((r) => path.basename(r)).join(", ")})`);
  const events = defaultEvents();
  const scripts = defaultScripts(events);
  await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
  const world = await HeadlessWorld.create({
    doc, streamStatics: { radius: SERVER_STATICS_RADIUS }, assets: content.assets, registry: defaultRegistry(), events, scripts,
    exclude: (_id, e) => e.tags.includes("player"),
  });
  if (opts.recipeEdits?.length) {
    const vw = Object.values(world.base.entities).map((e) => e.components["voxelWorld"] as { world?: string } | undefined).find(Boolean);
    const field = vw?.world ? getVoxelWorld(vw.world) : null;
    if (!field) throw new Error(`scene ${opts.scene}: no registered voxel world to edit`);
    registerVoxelWorld(vw!.world!, applyRecipeEdits(field.recipe, opts.recipeEdits as never).recipe);
  }
  const voxel = resolveServerVoxelWorld(world.base);
  if (!voxel) throw new Error(`scene ${opts.scene} has no voxel world`);
  const terrain = new TerrainStreamer(world, voxel, { pool: false });
  if (opts.terrainCache) {
    const cache = prepareTerrainCache({ root: path.join(opts.playground, ".hitreg", "terrain-cache"), inputs: terrain.cacheInputs(), mode: "read", log });
    if (cache.reader && terrain.useCache(cache.reader)) log(`[boot] terrain cache in use (${cache.reader.size} cells)`);
    else log("[boot] no terrain cache for this recipe: cooking cells inline");
  }
  const template = extractPlayerTemplate(world.expanded);
  if (!template) throw new Error("no player template in the scene");
  const s = voxel.streamer;
  const limitCells = (terrain as unknown as { limitCells: number }).limitCells;
  const ring = { simulation: s.radius, keepPadding: s.keepPadding ?? 1, cellSize: s.cellSize, limitCells };
  const parkPoint = (x: number, z: number): P3 => {
    const l = Math.hypot(x, z) || 1;
    const r = (limitCells + ring.simulation + ring.keepPadding + 4) * ring.cellSize;
    return [(x / l) * r, 500, (z / l) * r];
  };
  const spawnAt: P3 = parkPoint(1, 0);
  const hub = new LoopbackHub({ manualFlush: true });
  const server = new GameServer({ world, transport: hub.connect("host"), terrain, scene: opts.scene, playerTemplate: template, spawnPoint: () => spawnAt, snapshotEvery: 600, reconnectGraceSeconds: 0 });
  // Match serve(): pause distant authored NPCs before the first tick primes their ground,
  // and wake the actual local packs as the walker reaches them.
  const npcs = new NpcManager(server, { respawnSeconds: 20 });
  new SpawnAreaManager(server, npcs);
  const peer = opts.peer ?? "walk-gate";
  const bodyId = `player:${peer}`;
  const client = new RoomClient(hub.connect(peer), "host");
  client.join(peer);
  const flushAsync = async (): Promise<void> => { for (let i = 0; i < 4; i++) { hub.flush(); await new Promise((r) => setTimeout(r, 0)); } };
  for (let i = 0; i < 20 && !world.entities.has(bodyId); i++) { await flushAsync(); server.tick(); await flushAsync(); }
  if (!world.entities.has(bodyId)) throw new Error("the walker never joined");
  const tick = (n = 1): void => { for (let i = 0; i < n; i++) { hub.flush(); server.tick(); } hub.flush(); };
  const net = world.netState as unknown as { set(k: string, v: unknown): boolean };
  let seq = 0;
  const stepWith = (v: [number, number], jump: boolean): void => {
    client.sendCommand({ t: "input", seq: ++seq, v, jump, vy: 0, yaw: Math.atan2(v[0], v[1]) });
    net.set(`combat/${bodyId}.hp`, 1e6);
    tick();
  };
  const runSpeed = typeof template.controller["speed"] === "number" ? (template.controller["speed"] as number) : 6.5;
  const ringCells = (x: number, z: number): string[] => [...computeChunkStates({ x, z }, s, new Map()).keys()].filter((k) => {
    const [cx, cz] = k.split("_").map(Number) as [number, number];
    return Math.hypot(cx + 0.5, cz + 0.5) <= limitCells;
  });
  const holdAt = (p: P3, maxTicks = 3600, extraTicks = 20): number => {
    let t = 0;
    // the server keeps a player's LAST input command: release the stick, or a body parked after a walk runs on at full
    // speed once the hold ends (poi-walk area holds slid 6 m off the target in their 1 s idle)
    client.sendCommand({ t: "input", seq: ++seq, v: [0, 0], jump: false, vy: 0, yaw: 0 });
    const want = ringCells(p[0], p[2]);
    for (; t < maxTicks; t++) {
      world.sim.setPosition(bodyId, p);
      tick();
      if (want.every((k) => { const [cx, cz] = k.split("_").map(Number) as [number, number]; return terrain.has(cx, cz); })) break;
    }
    for (let i = 0; i < extraTicks; i++) { world.sim.setPosition(bodyId, p); tick(); }
    return t;
  };
  // foot offset: stand on open ground once and measure capsule centre to floor
  let footOffset = 0.9;
  const feet = (): P3 => { const q = world.positionOf(bodyId)!; return [q[0], q[1] - footOffset, q[2]]; };
  const calibrate = (x: number, z: number): void => {
    const g = terrain.groundHeight(x, z);
    holdAt([x, g + 1.5, z]);
    tick(90);
    const q = world.positionOf(bodyId)!;
    const hit = world.sim.raycast([q[0], q[1], q[2]], [0, -1, 0], 5, { solid: true, exclude: [bodyId] });
    if (hit && q[1] - hit.point[1] > 0.3 && q[1] - hit.point[1] < 2) footOffset = q[1] - hit.point[1];
    log(`[boot] foot offset ${footOffset.toFixed(2)} m`);
  };
  const body: ServerBody = { playground: opts.playground, roots, content, world, terrain, server, bodyId, runSpeed, ring, tick, stepWith, feet, holdAt, ringCells, parkPoint, calibrate };
  log(`[boot] scene ${opts.scene}: closure ${roots.map((r) => path.basename(r)).join(", ")}; ring ${ring.simulation} cell(s) of ${ring.cellSize} m (+${ring.keepPadding} keep), statics ${SERVER_STATICS_RADIUS} m`);
  return body;
}
