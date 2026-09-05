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
import { recipeEditSchema, type PlayerDataBackend } from "@hitreg/core";
import { loadContent, playgroundRoots } from "./assets.js";
import { loadProjectScripts, type ScriptLoadReport } from "./scripts.js";
import { HeadlessWorld, defaultEvents, defaultRegistry, defaultScripts } from "./world.js";
import { TerrainStreamer, resolveServerVoxelWorld } from "./terrain.js";
import { GameServer, type PlayerIdentity, type PlayerPersistence } from "./server.js";
import { extractPlayerTemplate } from "./players.js";
import { NpcManager } from "./npcs.js";
import { SpawnAreaManager } from "./spawn-areas.js";
import { handleAdmin } from "./admin.js";
import { ClusterLink } from "./cluster/link.js";
import { PlayerStore } from "./cluster/player-store.js";
import { verifyTicket } from "./cluster/ticket.js";
import type { ServerKind } from "./cluster/protocol.js";

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
  /** Called when the process should exit (an idle instance, a finished drain). Default: process.exit(0). */
  onExit?: (why: string) => void;
}

export interface ServeHandle {
  world: HeadlessWorld;
  server: GameServer;
  npcs: NpcManager;
  spawnAreas: SpawnAreaManager;
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
  /**
   * Move a character to another server: waits for a legal moment, commits,
   * mints a ticket through main (or signs one locally when standalone),
   * hands the client over. Resolves true when the client was told to go.
   */
  moveOut(characterId: string, to: { srv: string; url: string }, reason: string): Promise<boolean>;
  close(): Promise<void>;
}

export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const started = Date.now();
  const content = loadContent(playgroundRoots(opts.playground));
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

  const world = await HeadlessWorld.create({
    doc,
    assets: content.assets,
    registry,
    events,
    scripts,
    ...(opts.fixedHz ? { fixedHz: opts.fixedHz } : {}),
    exclude: (_id, e) => e.tags.includes("player"),
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
  const secret = opts.secret;

  const httpServer = http.createServer();
  const transport = new WebSocketHostTransport({
    server: httpServer,
    trace: (event, detail) => {
      if (event === "ws-peer" || event === "ws-peer-gone" || event === "ws-reject") log(`[serve] ${event} ${detail ?? ""}`);
    },
    ...(secret
      ? {
          authenticate: (hello) => {
            if (!hello.ticket) return { reject: "a ticket is required — join through the gateway" };
            const v = verifyTicket(secret, hello.ticket, { srv: serverId });
            if (!v.ok) return { reject: v.reason };
            identities.set(v.claims.chr, {
              playerId: v.claims.sub,
              characterId: v.claims.chr,
              name: v.claims.name,
              ...(v.claims.rev ? { rev: v.claims.rev } : {}),
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
        load: (identity, scene) => store.load(identity.playerId, scene, identity.rev ?? {}),
        commit: (identity, input) => store.commit(identity.playerId, input),
      };
    }
  }
  if (secret && !persistence) log("[serve] tickets required but no persistence configured — characters will not be saved");

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
    ...(opts.snapshotEvery ? { snapshotEvery: opts.snapshotEvery } : {}),
    ...(opts.maxPlayers !== undefined ? { maxPlayers: opts.maxPlayers } : {}),
    ...(opts.reconnectGraceSeconds !== undefined ? { reconnectGraceSeconds: opts.reconnectGraceSeconds } : {}),
    onPlayerJoined: (player) => {
      if (player.identity) link?.playerJoined({ characterId: player.identity.characterId, playerId: player.identity.playerId, name: player.name, position: world.positionOf(player.bodyId) });
      lastPopulatedAt = Date.now();
    },
    onPlayerLeft: (player, reason) => {
      if (player.identity) link?.playerLeft(player.identity.characterId, reason === "transfer" ? "transfer" : reason === "grace" ? "grace" : reason === "replaced" ? "replaced" : "leave");
      identities.delete(player.peerId);
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
  const npcs = new NpcManager(server, { respawnSeconds: opts.respawnSeconds ?? 20 });
  spawnAreas = new SpawnAreaManager(server, npcs);
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
    return signTicket(secret, { sub: identity.playerId, chr: identity.characterId, name: identity.name, srv, rev, reason });
  };

  const moveOut = async (characterId: string, to: { srv: string; url: string }, reason: string): Promise<boolean> => {
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
    return server.handoff(peerId, { url: to.url, ticket, reason, srv: to.srv });
  };

  if (link) {
    link.onTransferBegin((m) => {
      void moveOut(m.characterId, { srv: m.srv, url: m.url }, m.reason).catch((error: unknown) => {
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
        status: () => ({
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
    terrain,
    transport,
    httpServer,
    link,
    port,
    url,
    serverId,
    scripts: report,
    identities,
    moveOut,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(statusTimer);
        if (idleTimer) clearInterval(idleTimer);
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
