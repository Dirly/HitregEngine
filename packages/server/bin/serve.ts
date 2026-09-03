#!/usr/bin/env tsx
/**
 * hitreg-serve — host a project scene on a dedicated server.
 *
 *   pnpm -F @hitreg/server serve --scene field
 *   pnpm -F @hitreg/server serve --scene field --port 8787 --host 0.0.0.0
 *
 * Options
 *   --scene <name>        scene to host (a `<name>.scene.json` under any project's assets/scenes)
 *   --port <n>            game socket + admin HTTP port (default 8787)
 *   --host <addr>         bind address (default 127.0.0.1; 0.0.0.0 to serve the LAN)
 *   --playground <dir>    playground checkout to read projects from (default: this repo's)
 *   --hz <n>              sim rate (default 60)
 *   --snapshot-every <n>  ticks per snapshot (default 3)
 *   --respawn <seconds>   NPC respawn delay, 0 disables (default 20)
 *   --grace <seconds>     keep a dropped player's body this long for a reconnect (default 30)
 *   --terrain-radius <n>  simulated cells around each player (default: the scene's rings.simulation)
 *   --max-players <n>
 *   --no-persist          do not write terraformed recipes back to their file
 *
 * Clients: open the playground with `?server=ws://<host>:<port>` and press play.
 * Admin:   curl -s http://<host>:<port>/admin/status
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../src/serve.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
function num(name: string): number | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const scene = arg("scene");
  if (!scene) {
    console.error("usage: hitreg-serve --scene <name> [--port 8787] [--host 127.0.0.1]");
    process.exit(2);
  }
  const handle = await serve({
    playground: path.resolve(arg("playground", path.resolve(here, "../../../apps/playground"))!),
    scene,
    port: num("port") ?? 8787,
    host: arg("host", "127.0.0.1")!,
    fixedHz: num("hz"),
    snapshotEvery: num("snapshot-every"),
    respawnSeconds: num("respawn"),
    reconnectGraceSeconds: num("grace"),
    terrainRadius: num("terrain-radius"),
    maxPlayers: num("max-players"),
    persistRecipe: !process.argv.includes("--no-persist"),
  });
  const tickLog = setInterval(() => {
    const s = handle.server.stats() as { players: unknown[]; terrainCells: number; tick: number };
    console.log(`[serve] tick ${s.tick} · players ${s.players.length} · cells ${s.terrainCells} · npcs ${handle.npcs.npcs.size}`);
  }, 30_000);
  const shutdown = (): void => {
    clearInterval(tickLog);
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
