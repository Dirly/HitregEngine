/**
 * `serve()` — boot everything: content, scripts, world, terrain, the
 * WebSocket host, the NPC manager and the admin HTTP surface, on one port.
 * The CLI (`bin/serve.ts`) is argument parsing around this; tests call it
 * directly on port 0.
 *
 * Three ways to run it (docs/hosting.md):
 *
 *   open          no `secret`: anyone connects, nothing persists — the dev loop
 *   standalone    `secret` + `playerData`: tickets required, saves through the
 *                 given backend, no main (one process is the whole world)
 *   in a cluster  `secret` + `mainUrl`: registers with main as a LAYER or an
 *                 INSTANCE; every durable thing goes through main; main can
 *                 move players here and away
 */

import fs from "node:fs";
import http from "node:http";
import { WebSocketHostTransport } from "@hitreg/net/server";
import {
  getVoxelWorld,
  pointInPolygon,
  polygonEdgeDistance,
  recipeEditSchema,
  regionAt,
  sanctuariesFromPois,
  SANCTUARIES_KEY,
  type PlayerDataBackend,
  type PoiDoc,
  type RegionDoc,
  type SanctuaryCircle,
} from "@hitreg/core";
import { loadContent, playgroundRoots } from "./assets.js";
import { loadProjectScripts, type ScriptLoadReport } from "./scripts.js";
import { HeadlessWorld, defaultEvents, defaultRegistry, defaultScripts } from "./world.js";
import { TerrainStreamer, resolveServerVoxelWorld } from "./terrain.js";
import { GameServer, type PlayerIdentity, type PlayerPersistence } from "./server.js";
import { extractPlayerTemplate } from "./players.js";
import { NpcManager } from "./npcs.js";
import { SpawnAreaManager } from "./spawn-areas.js";
import { mountLayerChat, type LayerChat } from "./chat.js";
import { handleAdmin } from "./admin.js";
import { ClusterLink } from "./cluster/link.js";
import { PlayerStore } from "./cluster/player-store.js";
import { mountItemsLog } from "./moderation/items-log.js";
import { muteLine } from "./moderation/sanctions.js";
import { verifyTicket } from "./cluster/ticket.js";
import { SOCIAL_MODULE, socialLine, type PortalHop, type ServerKind, type TransferTarget } from "./cluster/protocol.js";
import { Profiler } from "@hitreg/core";
import { CHARACTER_EVENTS, PORTAL_EVENTS, portalDeparture, portalKey, portalRecordSchema, type PortalTravel } from "@hitreg/core";

export interface ServeOptions {
  /** Playground checkout whose projects/ supply the content. */
  playground: string;
  scene: string;
  port?: number;
  host?: string;
  fixedHz?: number;
  snapshotEvery?: number;
  /** NPC respawn delay in seconds; 0 disables. Default 20. */
  respawnSeconds?: number;
  terrainRadius?: number;
  maxPlayers?: number;
  reconnectGraceSeconds?: number;
  /** Write terraformed recipes back to their file (default true — the recipe is the save). In a cluster main writes instead. */
  persistRecipe?: boolean;
  /** Cell-generation worker threads (default min(4, cpus-1); 0 = inline). */
  workers?: number;
  /** Profile every tick (phases + per-script rows) for GET /admin/profile. Off by default. */
  profile?: boolean;
  /** permessage-deflate on the game socket (default false: it starves under an overloaded tick; WebSocketHostTransportOptions.compress). */
  compress?: boolean;
  /**
   * Metres around players and awake bodies within which static prop/building
   * mesh colliders are built (released 25% further out). Default 96 (two 48 m
   * terrain cells); 0 builds every one at boot, as before.
   */
  staticsRadius?: number;
  /** NPCs no spawn area owns sleep when no player is near (NpcManagerOptions.dormancy; default on). false keeps every one awake. */
  npcDormancy?: { sleepRadius?: number; wakeRadius?: number; idleSeconds?: number } | false;
  /** Metres within which each player is sent what moves around it (GameServerOptions.interestRadius; default 250, 0 = everything to everyone). */
  interestRadius?: number;
  /** GameServerOptions.stateInterest / stateEvery / stateHz / farSend (the last three OFF by default: owner decisions). */
  stateInterest?: boolean;
  stateEvery?: number;
  stateHz?: Record<string, number>;
  farSend?: { beyond: number; every: number };
  log?: (line: string) => void;

  // -- hosting ------------------------------------------------------------------
  /** Cluster secret. Set = tickets are REQUIRED on every hello. */
  secret?: string;
  /** This server's id (what tickets are bound to). Default "layer-1". */
  serverId?: string;
  kind?: ServerKind;
  /** Main's http(s)/ws(s) url. Set = register there and route persistence through it. */
  mainUrl?: string;
  /** What clients dial to reach this process (reported to main). Default ws://<host>:<port>. */
  publicUrl?: string;
  /** For instances: the key main spawned it for (a party code, a character id). */
  instanceOf?: string;
  /** Instances: exit after being empty this long (seconds; 0 = never). */
  idleExitSeconds?: number;
  /** Seconds between periodic saves (main's value wins when clustered). */
  commitEverySeconds?: number;
  /** Persistence scope when standalone (default: the scene name). */
  experienceId?: string;
  /** Standalone persistence backend (tickets still required — see `secret`). */
  playerData?: PlayerDataBackend;
  /** Full control over load/commit (tests). Overrides `playerData` and main. */
  persistence?: PlayerPersistence;
  /** Extra veto on moving a player (default: no awake spawn area within 60 m). */
  transferGate?: (peerId: string) => boolean;
  /**
   * Load only these zones (a copy main started for them): placed things — anything with a mesh, a collider,
   * a body, a spawn area or a portal — whose root stands outside every one of these zones by more than
   * `zoneLoadBand` metres are not loaded at all. World-wide entities (the voxel world, water, sky, scripts
   * with nothing placed) always are. Unset: the whole scene, as before.
   */
  zones?: string[];
  /**
   * Metres past a loaded zone's border that still load (default 200): what a player can still reach here —
   * the border band before a crossing (20), a fight that holds a body on this copy for 12 s after the last
   * hit (~115 m at a sprint) — plus what it can see from there.
   */
  zoneLoadBand?: number;
  /** Zones to use instead of the recipe's `regions` (a flat test scene given borders). */
  regions?: RegionDoc[];
  /** POIs to use instead of the recipe's (a flat test scene given a sanctuary). */
  pois?: PoiDoc[];
  /**
   * Metres a player must be INSIDE a zone this layer does not host before a
   * border transfer is asked for (default 20) — the band where nothing is
   * spawned on either side, so the swap happens out of sight.
   */
  zoneBand?: number;
  /** Seconds a freshly spawned body is `landing/<bodyId>` (default 5; 0 disables). */
  landingSeconds?: number;
  /** Called when the process should exit (an idle instance, a finished drain). Default: process.exit(0). */
  onExit?: (why: string) => void;
}

export interface ServeHandle {
  world: HeadlessWorld;
  server: GameServer;
  npcs: NpcManager;
  spawnAreas: SpawnAreaManager;
  /** Text chat host for this layer (zone/global bridged through main when clustered). */
  chat: LayerChat;
  terrain: TerrainStreamer | null;
  transport: WebSocketHostTransport;
  httpServer: http.Server;
  link: ClusterLink | null;
  /** Bound port (useful with port 0). */
  port: number;
  url: string;
  serverId: string;
  scripts: ScriptLoadReport;
  /** Identities of authenticated peers (peer id = character id). */
  identities: Map<string, PlayerIdentity>;
  /** Zone lookup this layer uses (recipe regions, or the `regions` option). */
  zoneAt(x: number, z: number): RegionDoc | null;
  /** The sanctuary circles published as `sanctuaries/list` at boot. */
  readonly sanctuaries: readonly SanctuaryCircle[];
  /** Zones main places players here for ("all" when standalone or until main says otherwise). */
  hostedZones(): "all" | string[];
  /**
   * Move a character to another server: waits for a legal moment, commits,
   * mints a ticket through main (or signs one locally when standalone),
   * hands the client over. Resolves true when the client was told to go.
   */
  moveOut(characterId: string, to: { srv: string; url: string; scene?: string }, reason: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Components that make an entity PLACED (it matters where it stands), and ones that make it world-wide. */
const PLACED = ["mesh", "collider", "rigidbody", "spawnArea", "portalAnchor", "particles"];
const WORLDWIDE = ["voxelWorld", "water", "sky", "postfx"];

/**
 * The exclude predicate for a copy that loads only some zones (ServeOptions.zones): a ROOT whose subtree is
 * placed and not world-wide, standing more than `band` metres outside every loaded zone, is left out (its
 * descendants go with it). Null when the zones cannot be found (everything loads, with a warning).
 */
function zoneFilter(
  doc: import("@hitreg/core").SceneDoc,
  zones: string[],
  band: number,
  override: RegionDoc[] | undefined,
  log: (line: string) => void,
): ((id: string, e: import("@hitreg/core").EntityDoc, entities: Readonly<Record<string, import("@hitreg/core").EntityDoc>>) => boolean) | null {
  let regions: ReadonlyArray<RegionDoc> = override ?? [];
  if (!override) {
    for (const e of Object.values(doc.entities)) {
      const world = (e.components["voxelWorld"] as { world?: string } | undefined)?.world;
      if (world) regions = getVoxelWorld(world)?.recipe.regions ?? [];
    }
  }
  const polygons = regions.filter((r) => zones.includes(r.id)).map((r) => r.polygon);
  if (polygons.length === 0) {
    log(`[serve] --zones ${zones.join(", ")}: no such zones in this world — loading everything`);
    return null;
  }
  const near = (x: number, z: number): boolean => polygons.some((poly) => pointInPolygon(x, z, poly) || polygonEdgeDistance(x, z, poly) <= band);
  let children: Map<string, string[]> | null = null;
  return (id, e, entities) => {
    if (e.parent !== null) return false; // roots decide for their subtree
    const p = (e.components["transform"] as { position?: number[] } | undefined)?.position;
    if (!p || p.length < 3 || near(p[0]!, p[2]!)) return false;
    if (!children) {
      children = new Map();
      for (const [cid, c] of Object.entries(entities)) {
        if (c.parent === null) continue;
        const list = children.get(c.parent);
        if (list) list.push(cid);
        else children.set(c.parent, [cid]);
      }
    }
    let placed = false;
    const stack = [id];
    while (stack.length > 0) {
      const cid = stack.pop()!;
      const cur = entities[cid];
      if (!cur) continue;
      const keys = Object.keys(cur.components);
      if (keys.some((k) => WORLDWIDE.includes(k))) return false;
      if (keys.some((k) => PLACED.includes(k))) placed = true;
      for (const child of children.get(cid) ?? []) stack.push(child);
    }
    return placed;
  };
}

/**
 * This process's cost for /admin/status: CPU as a share of ONE core since the
 * previous call (a load driver polling every few seconds reads a rolling
 * figure), resident and heap memory.
 */
let lastCpu: { at: number; usage: NodeJS.CpuUsage } | null = null;
function processStats(): { cpuPct: number | null; rssMb: number; heapUsedMb: number; externalMb: number } {
  const usage = process.cpuUsage();
  const at = performance.now();
  let cpuPct: number | null = null;
  if (lastCpu && at > lastCpu.at) {
    const us = usage.user - lastCpu.usage.user + (usage.system - lastCpu.usage.system);
    cpuPct = Math.round((us / 1000 / (at - lastCpu.at)) * 1000) / 10;
  }
  lastCpu = { at, usage };
  const mem = process.memoryUsage();
  const mb = (n: number): number => Math.round(n / 1048576);
  return { cpuPct, rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), externalMb: mb(mem.external) };
}

export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const started = Date.now();
  const content = loadContent(playgroundRoots(opts.playground, opts.scene));
  const doc = content.scenes.get(opts.scene);
  if (!doc) {
    throw new Error(`scene "${opts.scene}" not found. Known: ${[...content.scenes.keys()].join(", ") || "(none)"}`);
  }
  const registry = defaultRegistry();
  const events = defaultEvents();
  const scripts = defaultScripts(events);
  const report = await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
  log(`[serve] scripts: ${report.registered.length} registered${report.skipped.length ? `, ${report.skipped.length} skipped` : ""}`);
  for (const s of report.skipped) log(`  - ${s.file}: ${s.reason}`);

  // a copy for some zones loads only what stands in them (plus a band): see ServeOptions.zones
  const outsideZones = opts.zones && opts.zones.length > 0 ? zoneFilter(doc, opts.zones, opts.zoneLoadBand ?? 200, opts.regions, log) : null;
  // 600 ticks = 10 s at 60 Hz; a tick past 8 ms (half the 60 Hz budget) is kept whole as a spike
  const profiler = opts.profile ? Object.assign(new Profiler({ historyFrames: 600, spikeMs: 8 }), { enabled: true }) : null;
  const staticsRadius = opts.staticsRadius ?? 96;
  const world = await HeadlessWorld.create({
    doc,
    ...(staticsRadius > 0 ? { streamStatics: { radius: staticsRadius } } : {}),
    ...(profiler ? { profiler } : {}),
    assets: content.assets,
    registry,
    events,
    scripts,
    ...(opts.fixedHz ? { fixedHz: opts.fixedHz } : {}),
    exclude: (id, e, entities) => e.tags.includes("player") || (outsideZones !== null && outsideZones(id, e, entities)),
  });
  const voxel = resolveServerVoxelWorld(world.base, opts.terrainRadius);
  const terrain = voxel
    ? new TerrainStreamer(world, voxel, opts.workers === undefined ? {} : { pool: opts.workers > 0 ? { workers: opts.workers } : false })
    : null;
  log(
    `[serve] scene "${opts.scene}": ${world.entities.size} entities` +
      (voxel ? `, voxel world "${voxel.data.world}" (cell ${voxel.streamer.cellSize}m, ring ${voxel.streamer.rings!.simulation}, ${terrain!.workers} generation worker(s))` : ", no voxel world"),
  );

  const serverId = opts.serverId ?? "layer-1";
  const kind: ServerKind = opts.kind ?? "layer";
  const identities = new Map<string, PlayerIdentity>();
  /** Characters main banned while they stood here: their tickets are refused until then (epoch ms) and why. */
  const refused = new Map<string, { until: number; text: string }>();
  const secret = opts.secret;

  const httpServer = http.createServer();
  const transport = new WebSocketHostTransport({
    server: httpServer,
    compress: opts.compress ?? false,
    trace: (event, detail) => {
      if (event === "ws-peer" || event === "ws-peer-gone" || event === "ws-reject") log(`[serve] ${event} ${detail ?? ""}`);
    },
    ...(secret
      ? {
          authenticate: (hello) => {
            if (!hello.ticket) return { reject: "a ticket is required — join through the gateway" };
            const v = verifyTicket(secret, hello.ticket, { srv: serverId });
            if (!v.ok) return { reject: v.reason };
            const ban = refused.get(v.claims.chr);
            if (ban && ban.until > Date.now()) return { reject: ban.text };
            identities.set(v.claims.chr, {
              playerId: v.claims.sub,
              characterId: v.claims.chr,
              ...(v.claims.saveId ? { saveId: v.claims.saveId } : {}),
              name: v.claims.name,
              ...(v.claims.rev ? { rev: v.claims.rev } : {}),
              ...(v.claims.build ? { build: v.claims.build } : {}),
            });
            return { peerId: v.claims.chr, name: v.claims.name };
          },
        }
      : {}),
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 8787, host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? 8787);
  const url = `ws://${host}:${port}`;
  const publicUrl = opts.publicUrl ?? url;

  // -- cluster link (before the GameServer: persistence needs the experience id) --
  let link: ClusterLink | null = null;
  let experienceId = opts.experienceId ?? opts.scene;
  let commitEverySeconds = opts.commitEverySeconds;
  if (opts.mainUrl) {
    if (!secret) throw new Error("--main needs --secret (the cluster secret)");
    link = new ClusterLink({
      mainUrl: opts.mainUrl,
      secret,
      id: serverId,
      kind,
      url: publicUrl,
      scene: opts.scene,
      cap: opts.maxPlayers ?? 40,
      ...(opts.instanceOf ? { instanceOf: opts.instanceOf } : {}),
      log,
    });
    const registered = await link.connect();
    experienceId = registered.experienceId;
    commitEverySeconds ??= registered.commitEverySeconds;
  }
  let persistence: PlayerPersistence | undefined = opts.persistence;
  if (!persistence) {
    const backend = link ? link.backend : opts.playerData;
    if (backend) {
      const store = new PlayerStore(backend, experienceId);
      persistence = {
        load: (identity, scene) => store.load(identity.saveId ?? identity.playerId, scene, identity.rev ?? {}),
        commit: (identity, input) => store.commit(identity.saveId ?? identity.playerId, input),
      };
    }
  }
  if (secret && !persistence) log("[serve] tickets required but no persistence configured — characters will not be saved");
  // the item log (docs/moderation.md §4): diffs the sheets and vaults this authority writes; its entries go to main
  // from inside every commit, so they ride the periodic save and a leave, and reach main before a transfer ticket
  const itemsLog = link ? mountItemsLog({ netState: world.netState, assets: world.assets, link, serverId, log }) : null;
  if (itemsLog && persistence) {
    const inner = persistence;
    persistence = {
      load: (identity, scene) => inner.load(identity, scene),
      commit: (identity, input) => {
        void itemsLog.flush();
        return inner.commit(identity, input);
      },
    };
  }

  const template = extractPlayerTemplate(world.expanded);
  const authored = (template?.entities[template.rootId]?.components["transform"] as { position?: number[] } | undefined)?.position ?? [0, 2, 0];
  const spawnPoint = (peerId: string): [number, number, number] => {
    // spread joiners around the spawn so two players never share a capsule
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
    const angle = (hash % 360) * (Math.PI / 180);
    const r = 1 + (hash % 7) * 0.35;
    const x = authored[0]! + Math.cos(angle) * r;
    const z = authored[2]! + Math.sin(angle) * r;
    const y = terrain ? Math.max(authored[1]!, terrain.groundHeight(x, z) + 1.2) : authored[1]!;
    return [x, y, z];
  };
  let spawnAreas: SpawnAreaManager | null = null;
  const server = new GameServer({
    world,
    transport,
    terrain,
    scene: opts.scene,
    playerTemplate: template,
    spawnPoint,
    identityOf: (peerId) => identities.get(peerId),
    ...(persistence ? { persistence } : {}),
    ...(commitEverySeconds !== undefined ? { commitEverySeconds } : {}),
    transferGate: opts.transferGate ?? ((peerId) => (spawnAreas ? spawnAreas.clearToTransfer(peerId) : true)),
    ...(opts.landingSeconds !== undefined ? { landingSeconds: opts.landingSeconds } : {}),
    ...(opts.snapshotEvery ? { snapshotEvery: opts.snapshotEvery } : {}),
    ...(opts.interestRadius !== undefined ? { interestRadius: opts.interestRadius } : {}),
    ...(opts.stateInterest !== undefined ? { stateInterest: opts.stateInterest } : {}),
    ...(opts.stateEvery !== undefined ? { stateEvery: opts.stateEvery } : {}),
    ...(opts.stateHz ? { stateHz: opts.stateHz } : {}),
    ...(opts.farSend ? { farSend: opts.farSend } : {}),
    ...(opts.maxPlayers !== undefined ? { maxPlayers: opts.maxPlayers } : {}),
    ...(opts.reconnectGraceSeconds !== undefined ? { reconnectGraceSeconds: opts.reconnectGraceSeconds } : {}),
    ...(profiler ? { profiler } : {}),
    onPlayerJoined: (player) => {
      if (player.identity) link?.playerJoined({ characterId: player.identity.characterId, playerId: player.identity.playerId, name: player.name, position: world.positionOf(player.bodyId) });
      if (player.identity) itemsLog?.track(player.bodyId, player.identity.characterId);
      lastPopulatedAt = Date.now();
      // where they stand NOW is their first zone: a crossing in the next
      // half-second is still a crossing, not a first sight
      const at = world.positionOf(player.bodyId);
      lastZone.set(player.peerId, at ? (zoneAt(at[0], at[2])?.id ?? null) : null);
    },
    onPlayerLeft: (player, reason) => {
      if (player.identity) link?.playerLeft(player.identity.characterId, reason === "transfer" ? "transfer" : reason === "grace" ? "grace" : reason === "replaced" ? "replaced" : "leave");
      itemsLog?.untrack(player.bodyId);
      identities.delete(player.peerId);
      blocks.delete(player.peerId);
      mutes.delete(player.peerId);
      lastPopulatedAt = Date.now();
      if (draining && server.players.size === 0) finish("drained");
    },
    onRecipeChanged: (id, recipe) => {
      if (link) {
        // main is the writer of record; it saves the file and tells the other layers
        void link.rpc({ op: "recipe.changed", id, recipe }).catch((error: unknown) => log(`[serve] recipe fan-out failed: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (opts.persistRecipe === false) return;
      const file = content.worldFiles.get(id);
      if (!file) return;
      // atomic: a crash mid-write must not leave a half recipe as the save
      const tmp = `${file}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(recipe, null, 2) + "\n");
        fs.renameSync(tmp, file);
        log(`[serve] recipe "${id}" saved (${file})`);
      } catch (error) {
        log(`[serve] could not save recipe "${id}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
  const npcs = new NpcManager(server, { respawnSeconds: opts.respawnSeconds ?? 20, ...(opts.npcDormancy !== undefined ? { dormancy: opts.npcDormancy } : {}) });
  spawnAreas = new SpawnAreaManager(server, npcs);
  // text chat routes on the host, and here the host is this process; zone and
  // global lines cross the cluster through main (docs/comms.md, docs/hosting.md)
  // -- zones: which ones this layer hosts, and the border watcher ------------------
  // A layer simulates the world wherever its players stand (spawn areas wake
  // around anyone); the hosted set only says which zones main PLACES players
  // here for. A player who walks deep enough into a zone hosted elsewhere is
  // handed to a copy of that zone — out of combat, clear of packs on both
  // sides (docs/hosting.md → "Crossing a border").
  const regions: ReadonlyArray<RegionDoc> = opts.regions ?? terrain?.resolved.field.recipe.regions ?? [];
  const zoneBand = opts.zoneBand ?? 20;
  const zoneAt = (x: number, z: number): RegionDoc | null => regionAt(regions, x, z);
  const hostsZone = (zone: string): boolean => !link || link.hosted === "all" || link.hosted.includes(zone);
  // block lists, from main: a character never hears anyone it blocked
  const blocks = new Map<string, Set<string>>();
  // mutes, from main (docs/moderation.md §3): a muted character's lines go nowhere
  const mutes = new Map<string, { until: number; reason: string }>();
  const mutedLine = (sender: string): string | null => {
    const m = mutes.get(sender);
    if (!m) return null;
    if (m.until <= Date.now()) {
      mutes.delete(sender);
      return null;
    }
    return muteLine(m.until, m.reason);
  };
  const chat = mountLayerChat({ server, scene: opts.scene, link, regions, serverId, mayHear: (recipient, sender) => !blocks.get(recipient)?.has(sender), muted: mutedLine, log });
  link?.onSanction((characterId, s) => {
    if (s.muteUntil !== null && s.muteUntil > Date.now()) mutes.set(characterId, { until: s.muteUntil, reason: s.reason ?? "moderation" });
    else mutes.delete(characterId);
    if (s.notice && server.players.has(characterId)) chat.chat.announceTo(characterId, s.notice);
  });
  // a ban: tell them, then end the session (a moment later, so the line goes out first) and refuse their tickets
  link?.onKick((characterId, text, refuseUntil) => {
    if (refuseUntil !== undefined) refused.set(characterId, { until: refuseUntil, text });
    if (!server.players.has(characterId)) return;
    chat.chat.announceTo(characterId, text);
    setTimeout(() => {
      if (server.expel(characterId, "banned")) log(`[serve] ${characterId} removed by moderation`);
    }, 250);
  });
  link?.onGuild((characterId, guild) => {
    const key = `comms.guild/${characterId}`;
    if (guild === null) world.netState.delete(key);
    else if (!world.netState.set(key, guild)) log(`[serve] guild "${guild}" for ${characterId} refused by netState`);
  });
  link?.onBlocks((characterId, blocked) => {
    if (blocked.length === 0) blocks.delete(characterId);
    else blocks.set(characterId, new Set(blocked));
  });
  // -- sanctuaries: every safe poi's circle and every safe zone, once, in netState -----
  // (docs/world-editing/barriers.md → "Runtime"): a game's authoritative combat
  // script reads `sanctuaries/list` and refuses player-on-player damage inside
  const pois: ReadonlyArray<PoiDoc> = opts.pois ?? terrain?.resolved.field.recipe.features.pois ?? [];
  const sanctuaries: SanctuaryCircle[] = sanctuariesFromPois(pois);
  for (const region of regions) {
    // a safe ZONE (a town) is a polygon; the list carries circles, so publish
    // the circle round its hub that covers every vertex — a hand past the
    // wall, never short of it
    if (!region.tags.includes("safe")) continue;
    const [cx, cz] = region.hub ?? region.polygon.reduce<[number, number]>((acc, p) => [acc[0] + p[0] / region.polygon.length, acc[1] + p[1] / region.polygon.length], [0, 0]);
    let r = 0;
    for (const [x, z] of region.polygon) r = Math.max(r, Math.hypot(x - cx, z - cz));
    if (r > 0) sanctuaries.push([cx, cz, r, terrain ? terrain.groundHeight(cx, cz) : 0]);
  }
  if (!world.netState.set(SANCTUARIES_KEY, sanctuaries)) log("[serve] sanctuaries/list failed validation — no sanctuaries published");
  else if (sanctuaries.length > 0) log(`[serve] sanctuaries: ${sanctuaries.length} (${sanctuariesFromPois(pois).length} waystations, ${sanctuaries.length - sanctuariesFromPois(pois).length} safe zones)`);

  // -- zone tracking: `zone.entered` + "you are entering …" on every crossing ------
  const lastZone = new Map<string, string | null>();
  const trackZone = (peerId: string, bodyId: string, zone: RegionDoc | null): void => {
    const prev = lastZone.get(peerId);
    const id = zone?.id ?? null;
    if (prev === undefined) {
      lastZone.set(peerId, id); // first sight: where they logged in or landed, no announcement
      return;
    }
    if (prev === id) return;
    lastZone.set(peerId, id);
    if (!zone) return;
    world.eventBus.emit("zone.entered", { bodyId, peerId, zone: zone.id, name: zone.name, from: prev });
    chat.chat.announceTo(peerId, `You are entering ${zone.name}.`);
  };
  const crossing = new Map<string, { zone: string; since: number; waits: number }>();
  const watchBorders = (): void => {
    if (regions.length === 0) return;
    for (const id of lastZone.keys()) if (!server.players.has(id)) lastZone.delete(id);
    const transfers = link !== null && link.hosted !== "all";
    for (const player of server.players.values()) {
      if (player.disconnectedAt !== null || player.transferring !== null) continue;
      const p = world.positionOf(player.bodyId);
      if (!p) continue;
      const zone = zoneAt(p[0], p[2]);
      trackZone(player.peerId, player.bodyId, zone);
      if (!transfers || !link || !player.identity) continue;
      const characterId = player.identity.characterId;
      if (!zone || hostsZone(zone.id) || polygonEdgeDistance(p[0], p[2], zone.polygon) < zoneBand) {
        crossing.delete(characterId);
        continue;
      }
      const state = crossing.get(characterId);
      if (state && Date.now() - state.since < 2000) continue; // one ask per couple of seconds
      if (!server.canTransfer(player.peerId)) continue; // in combat / a pack in view: stay, keep playing here
      const waits = state?.zone === zone.id ? state.waits : 0;
      crossing.set(characterId, { zone: zone.id, since: Date.now(), waits });
      void link
        .rpc<import("./cluster/protocol.js").TransferAnswer>({
          op: "transfer.request",
          characterId,
          target: { kind: "zone", zone: zone.id, position: p, ...(waits >= 15 ? { force: true } : {}) },
        })
        .then(async (answer) => {
          if (answer.wait) {
            const s = crossing.get(characterId);
            if (s) s.waits++;
            return;
          }
          crossing.delete(characterId);
          const sent = await moveOut(characterId, answer, `zone:${zone.id}`);
          if (sent) log(`[serve] ${characterId} crossed into "${zone.name}" → ${answer.srv}`);
        })
        .catch((error: unknown) => log(`[serve] border transfer for ${characterId} failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
  const borderTimer = setInterval(watchBorders, 500);
  link?.onArrivalCheck((requestId, position) => {
    const clear = spawnAreas ? spawnAreas.clearAt(position) : true;
    void link!.rpc({ op: "arrival.result", requestId, clear }).catch(() => undefined);
  });
  // a report: main wants the buffered chat involving the two (docs/moderation.md §2)
  link?.onEvidenceRequest((requestId, q) => {
    const evidence = chat.evidence(q.reporter, q.target, q.minutes);
    void link!.rpc({ op: "evidence.result", requestId, evidence }).catch(() => undefined);
  });
  link?.onZones((hosted) => {
    log(`[serve] hosting zones: ${hosted === "all" ? "all" : hosted.join(", ") || "(none)"}`);
    // a copy that loaded only some zones has nothing placed in the others: say so where it shows
    const loaded = outsideZones !== null ? opts.zones! : null;
    if (loaded && (hosted === "all" || hosted.some((z) => !loaded.includes(z)))) log(`[serve] WARNING: this copy loaded only ${loaded.join(", ")} — asked to host ${hosted === "all" ? "all" : hosted.join(", ")}`);
  });
  // main owns parties: it tells this layer each member's party so the party
  // channel routes here (peer id == character id), and stamps the party on
  // bridged lines itself, so a stale copy here can never misroute one
  link?.onParty((characterId, party) => {
    const key = `comms.party/${characterId}`;
    if (party === null) world.netState.delete(key);
    else if (!world.netState.set(key, party)) log(`[serve] party "${party}" for ${characterId} refused by netState`);
  });
  // friends and party events: main decides, the layer the player stands on
  // delivers — a module message for the social panel, a chat line for everyone
  link?.onSocial((characterId, event) => {
    if (!server.players.has(characterId)) return;
    server.host.sendModule(characterId, SOCIAL_MODULE, event);
    chat.chat.announceTo(characterId, socialLine(event));
  });
  {
    const warnings = spawnAreas.borderWarnings(regions, zoneBand);
    for (const w of warnings) log(`[serve] spawn area "${w.id}" in "${w.zone}" is ${w.distance} m from a border but reaches ${w.reach} m — a swap there can happen in sight of its pack; move it`);
  }
  log(`[serve] npcs: ${npcs.npcs.size} authored, templates: ${[...npcs.templates.keys()].join(", ") || "(none)"}, spawn areas: ${spawnAreas.areas.size}`);

  // -- transfers ------------------------------------------------------------------------
  let draining = false;
  let lastPopulatedAt = Date.now();
  let finished = false;
  const finish = (why: string): void => {
    if (finished) return;
    finished = true;
    log(`[serve] exiting: ${why}`);
    const exit = opts.onExit ?? ((): void => process.exit(0));
    void handle.close().then(() => exit(why));
  };

  const mintTicket = async (identity: PlayerIdentity, srv: string, rev: Record<string, number>, reason: string): Promise<string> => {
    if (link) {
      const r = await link.rpc<{ ticket: string }>({ op: "ticket.mint", playerId: identity.playerId, characterId: identity.characterId, name: identity.name, srv, rev, reason });
      return r.ticket;
    }
    if (!secret) throw new Error("cannot mint a ticket without a secret");
    const { signTicket } = await import("./cluster/ticket.js");
    return signTicket(secret, { sub: identity.playerId, chr: identity.characterId, ...(identity.saveId ? { saveId: identity.saveId } : {}), name: identity.name, srv, rev, reason });
  };

  const moveOut = async (characterId: string, to: { srv: string; url: string; scene?: string }, reason: string): Promise<boolean> => {
    const peerId = characterId;
    const deadline = Date.now() + 60_000;
    while (!server.canTransfer(peerId)) {
      const player = server.players.get(peerId);
      if (!player || player.transferring !== null) return false;
      if (Date.now() > deadline) {
        link?.transferFailed(characterId, "no safe moment within 60 s");
        return false;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const player = server.players.get(peerId);
    if (!player?.identity) return false;
    const rev = await server.commit(peerId);
    const ticket = await mintTicket(player.identity, to.srv, rev, reason);
    return server.handoff(peerId, { url: to.url, ticket, reason, srv: to.srv, ...(to.scene && to.scene !== opts.scene ? { scene: to.scene } : {}) });
  };

  // -- portals (docs/hosting.md → "Portals") ----------------------------------------------
  // The portal builtin checked the traveller and emitted portal.travel on this
  // authority; here the trip becomes a transfer: write the character's portal
  // record (arrival anchor + the way back, saved with the commit moveOut makes),
  // ask main for the instance (or, going back, the layer they came from), go.
  const refusePortal = (actorId: string, error: string): void => {
    world.eventBus.emit(CHARACTER_EVENTS.refused, { actorId, request: "portal", error });
  };
  const recordTrip = (bodyId: string, travel: PortalTravel): void => {
    const next = portalDeparture(world.netState.get(portalKey(bodyId)), travel, { scene: opts.scene, ...(kind === "layer" ? { srv: serverId } : {}) });
    if (!world.netState.set(portalKey(bodyId), next.record)) log(`[serve] portal record for ${bodyId} refused by netState`);
  };
  world.eventBus.on(PORTAL_EVENTS.travel, (payload) => {
    const travel = payload as PortalTravel;
    const peerId = world.netState.get(`owner/${travel.actorId}`);
    const player = typeof peerId === "string" ? server.players.get(peerId) : undefined;
    if (!player || player.transferring !== null) return;
    if (!link || !player.identity) {
      refusePortal(travel.actorId, "This server hosts no instances.");
      log(`[serve] portal ${travel.portalId}: ${player.peerId} cannot travel — no cluster (run under main)`);
      return;
    }
    const characterId = player.identity.characterId;
    const before = portalRecordSchema.safeParse(world.netState.get(portalKey(travel.actorId)) ?? {});
    const backTo = travel.back && before.success ? before.data.return?.srv : undefined;
    recordTrip(travel.actorId, travel);
    const hop: PortalHop = { scene: travel.scene, ...(travel.anchor ? { anchor: travel.anchor } : {}), ...(travel.back ? { back: true } : {}) };
    const target: TransferTarget = travel.back
      ? { kind: "layer", ...(backTo ? { layerId: backTo } : {}), party: travel.party, portal: hop }
      : { kind: "instance", scene: travel.scene, party: travel.party, portal: hop };
    const ask = (t: TransferTarget) => link!.rpc<{ srv: string; url: string; scene?: string }>({ op: "transfer.request", characterId, target: t });
    void ask(target)
      .catch((error: unknown) => {
        // the layer they left is gone: any layer of the world takes them back
        if (target.kind === "layer" && target.layerId) return ask({ ...target, layerId: undefined } as TransferTarget);
        throw error;
      })
      .then(async (dest) => {
        const sent = await moveOut(characterId, dest, travel.back ? "portal:back" : `portal:${travel.scene}`);
        if (sent) log(`[serve] ${characterId} took portal ${travel.portalId} → ${dest.srv} (${dest.scene ?? "?"})`);
        else refusePortal(travel.actorId, "The way will not open right now.");
      })
      .catch((error: unknown) => {
        log(`[serve] portal ${travel.portalId} for ${characterId} failed: ${error instanceof Error ? error.message : String(error)}`);
        refusePortal(travel.actorId, "The way will not open right now.");
      });
  });

  if (link) {
    link.onTransferBegin((m) => {
      // pulled along on a party member's portal trip: record this member's own arrival and way back first
      const bodyId = server.players.get(m.characterId)?.bodyId;
      if (m.portal && bodyId) {
        const at = world.positionOf(bodyId);
        const yaw = world.objects.get(bodyId)?.rotation.y ?? 0;
        recordTrip(bodyId, {
          actorId: bodyId,
          portalId: "party",
          scene: m.portal.scene,
          back: m.portal.back === true,
          party: false,
          ...(m.portal.anchor ? { anchor: m.portal.anchor } : {}),
          ...(at && m.portal.back !== true ? { returnTo: { position: at, yaw } } : {}),
        });
      }
      void moveOut(m.characterId, { srv: m.srv, url: m.url, ...(m.scene ? { scene: m.scene } : {}) }, m.reason).catch((error: unknown) => {
        log(`[serve] transfer of ${m.characterId} failed: ${error instanceof Error ? error.message : String(error)}`);
        link?.transferFailed(m.characterId, error instanceof Error ? error.message : String(error));
      });
    });
    link.onRecipe((id, recipe) => {
      if (!terrain || terrain.resolved.data.world !== id) return;
      const reloaded = terrain.replaceRecipe(recipe);
      server.host.broadcastModule("world", { t: "recipe", id, recipe });
      log(`[serve] recipe "${id}" replaced from main (${reloaded.length} cells re-cooked)`);
    });
    link.onTerraform((requestId, edits) => {
      try {
        const parsed = edits.map((e) => recipeEditSchema.parse(e));
        const result = server.terraform(parsed);
        void link!.rpc({ op: "terraform.result", requestId, ok: true, result });
      } catch (error) {
        void link!.rpc({ op: "terraform.result", requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    link.onDrain(() => {
      if (draining) return;
      draining = true;
      server.accepting = false;
      log(`[serve] draining: moving ${server.players.size} player(s) out`);
      if (server.players.size === 0) {
        finish("drained");
        return;
      }
      for (const player of server.players.values()) {
        if (!player.identity) continue;
        const characterId = player.identity.characterId;
        void link!
          .rpc<{ srv: string; url: string }>({ op: "transfer.request", characterId, target: { kind: "layer" } })
          .then((dest) => moveOut(characterId, dest, "drain"))
          .catch((error: unknown) => log(`[serve] drain: could not move ${characterId}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  // -- admin + status --------------------------------------------------------------------
  httpServer.on("request", (req, res) => {
    void handleAdmin(
      {
        server,
        npcs,
        spawnAreas,
        terrain,
        status: () => ({
          process: processStats(),
          // wire bytes per peer since it connected (after compression): a load driver diffs two polls
          traffic: transport.traffic(),
          scene: opts.scene,
          serverId,
          kind,
          uptimeSeconds: Math.round((Date.now() - started) / 1000),
          cluster: link ? (link.isUp ? "up" : "down") : "standalone",
          auth: secret ? "tickets" : "open",
          persistence: persistence ? "on" : "off",
        }),
        transfer: link
          ? async (characterId, target) => {
              const dest = await link!.rpc<{ srv: string; url: string }>({ op: "transfer.request", characterId, target });
              return { ...dest, sent: await moveOut(characterId, dest, "admin") };
            }
          : null,
      },
      req,
      res,
    ).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("hitreg game server — connect a client over WebSocket, or GET /admin/status");
      }
    });
  });

  server.start();
  log(`[serve] listening on ${url}  (admin: http://${host}:${port}/admin/status)${secret ? " — tickets required" : ""}`);

  const statusTimer = setInterval(() => {
    if (!link) return;
    const s = server.stats() as { tickMs: { p50: number }; entities: number };
    link.status({
      players: [...server.players.values()]
        .filter((p) => p.identity)
        .map((p) => ({ characterId: p.identity!.characterId, playerId: p.identity!.playerId, name: p.name, position: world.positionOf(p.bodyId) })),
      tickMs: s.tickMs.p50,
      entities: s.entities,
      accepting: server.accepting,
    });
  }, 2000);
  const idleExit = opts.idleExitSeconds ?? (kind === "instance" ? 90 : 0);
  // an orphan (main gone for two minutes) with nobody on it exits so a
  // restarted main can start fresh layers on the same ports; one with
  // players keeps serving and re-registers when main returns
  let linkDownSince: number | null = null;
  link?.onLink((up) => {
    linkDownSince = up ? null : Date.now();
  });
  const idleTimer = setInterval(() => {
    if (idleExit > 0 && server.players.size === 0 && Date.now() - lastPopulatedAt >= idleExit * 1000) finish(`idle for ${idleExit}s`);
    if (link && linkDownSince !== null && server.players.size === 0 && server.pendingSaveCount === 0 && Date.now() - linkDownSince >= 120_000) {
      finish("main unreachable for 120s and nobody here");
    }
  }, 1000);

  const handle: ServeHandle = {
    world,
    server,
    npcs,
    spawnAreas,
    chat,
    terrain,
    transport,
    httpServer,
    link,
    port,
    url,
    serverId,
    scripts: report,
    identities,
    zoneAt,
    sanctuaries,
    hostedZones: () => (link ? link.hosted : "all"),
    moveOut,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(statusTimer);
        clearInterval(borderTimer);
        if (idleTimer) clearInterval(idleTimer);
        chat.dispose();
        server.close();
        link?.close();
        transport.close();
        terrain?.dispose();
        world.dispose();
        httpServer.close(() => resolve());
      }),
  };
  return handle;
}
