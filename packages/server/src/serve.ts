/**
 * `serve()` — boot everything: content, scripts, world, terrain, the
 * WebSocket host, the NPC manager and the admin HTTP surface, on one port.
 * The CLI (`bin/serve.ts`) is argument parsing around this; tests call it
 * directly on port 0.
 */

import http from "node:http";
import { WebSocketHostTransport } from "@hitreg/net/server";
import { loadContent, playgroundRoots } from "./assets.js";
import { loadProjectScripts, type ScriptLoadReport } from "./scripts.js";
import { HeadlessWorld, defaultEvents, defaultRegistry, defaultScripts } from "./world.js";
import { TerrainStreamer, resolveServerVoxelWorld } from "./terrain.js";
import { GameServer } from "./server.js";
import { extractPlayerTemplate } from "./players.js";
import { NpcManager } from "./npcs.js";
import { handleAdmin } from "./admin.js";

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
  log?: (line: string) => void;
}

export interface ServeHandle {
  world: HeadlessWorld;
  server: GameServer;
  npcs: NpcManager;
  terrain: TerrainStreamer | null;
  transport: WebSocketHostTransport;
  httpServer: http.Server;
  /** Bound port (useful with port 0). */
  port: number;
  url: string;
  scripts: ScriptLoadReport;
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
  const scripts = defaultScripts();
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
  const terrain = voxel ? new TerrainStreamer(world, voxel) : null;
  log(
    `[serve] scene "${opts.scene}": ${world.entities.size} entities` +
      (voxel ? `, voxel world "${voxel.data.world}" (cell ${voxel.streamer.cellSize}m, ring ${voxel.streamer.rings!.simulation})` : ", no voxel world"),
  );

  const httpServer = http.createServer();
  const transport = new WebSocketHostTransport({
    server: httpServer,
    trace: (event, detail) => {
      if (event === "ws-peer" || event === "ws-peer-gone") log(`[serve] ${event} ${detail ?? ""}`);
    },
  });
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
  const server = new GameServer({
    world,
    transport,
    terrain,
    playerTemplate: template,
    spawnPoint,
    ...(opts.snapshotEvery ? { snapshotEvery: opts.snapshotEvery } : {}),
    ...(opts.maxPlayers !== undefined ? { maxPlayers: opts.maxPlayers } : {}),
    ...(opts.reconnectGraceSeconds !== undefined ? { reconnectGraceSeconds: opts.reconnectGraceSeconds } : {}),
  });
  const npcs = new NpcManager(server, { respawnSeconds: opts.respawnSeconds ?? 20 });
  log(`[serve] npcs: ${npcs.npcs.size} authored, templates: ${[...npcs.templates.keys()].join(", ") || "(none)"}`);

  httpServer.on("request", (req, res) => {
    void handleAdmin(
      {
        server,
        npcs,
        status: () => ({ scene: opts.scene, uptimeSeconds: Math.round((Date.now() - started) / 1000) }),
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
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 8787, host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? 8787);
  server.start();
  const url = `ws://${host}:${port}`;
  log(`[serve] listening on ${url}  (admin: http://${host}:${port}/admin/status)`);

  return {
    world,
    server,
    npcs,
    terrain,
    transport,
    httpServer,
    port,
    url,
    scripts: report,
    close: () =>
      new Promise<void>((resolve) => {
        server.close();
        transport.close();
        world.dispose();
        httpServer.close(() => resolve());
      }),
  };
}
