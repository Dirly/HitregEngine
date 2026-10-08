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
 *   --grace <seconds>     keep a dropped player's body this long for a reconnect (default 60)
 *   --terrain-radius <n>  simulated cells around each player (default: the scene's rings.simulation)
 *   --max-players <n>
 *   --no-persist          do not write terraformed recipes back to their file
 *   --workers <n>         cell-generation worker threads (default min(4, cpus-1); 0 = inline)
 *   --compress            permessage-deflate on the game socket (off by default: see WebSocketHostTransportOptions.compress)
 *   --profile             profile every tick for GET /admin/profile (phases, per-script rows, spikes)
 *   --interest <m>        send each player what moves within this many metres (default 250; 0 = everything to everyone)
 *   --no-state-interest   netState/events to everyone (default: about an entity only to those who see it)
 *   --state-every <n>     OFF by default: ship netState + events every n ticks (3 = with the 20 Hz snapshot)
 *   --state-hz <f=hz,…>   OFF by default: deliver these fields at most hz/s, e.g. stamina=10,mana=10,stability=10
 *   --far <m>:<n>         OFF by default: entities beyond m metres every n-th snapshot, e.g. 40:2
 *   --zones <a,b>         load only these zones (+ --zone-load-band m, default 200): what main starts a dedicated copy with
 *   --statics-radius <m>  build prop/building mesh colliders only this near players and awake bodies (default 96; 0 = all at boot)
 *
 * Hosting (docs/hosting.md) — a layer in a cluster is started by main, but by hand:
 *   --secret <s>          require gateway tickets (or HITREG_SECRET); --id <serverId> what they are bound to
 *   --main <ws-url>       register with main; --kind layer|instance; --public-url <ws://host:port> what clients dial
 *   --instance-of <key>   (instances) the key main started it for; --idle-exit <s> exit when empty this long
 *   --commit-every <s>    periodic save interval; --experience <id> persistence scope when standalone
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
    workers: num("workers"),
    profile: process.argv.includes("--profile"),
    compress: process.argv.includes("--compress"),
    ...(process.argv.includes("--no-state-interest") ? { stateInterest: false } : {}),
    ...(num("state-every") !== undefined ? { stateEvery: num("state-every")! } : {}),
    ...(arg("state-hz") ? { stateHz: Object.fromEntries(arg("state-hz")!.split(",").map((kv) => kv.split("=")).map(([k, v]) => [k!.trim(), Number(v)])) } : {}),
    ...(arg("far") ? { farSend: { beyond: Number(arg("far")!.split(":")[0]), every: Number(arg("far")!.split(":")[1] ?? 2) } } : {}),
    ...(arg("zones") ? { zones: arg("zones")!.split(",").map((z) => z.trim()).filter(Boolean) } : {}),
    ...(num("zone-load-band") !== undefined ? { zoneLoadBand: num("zone-load-band")! } : {}),
    ...(num("interest") !== undefined ? { interestRadius: num("interest")! } : {}),
    ...(num("statics-radius") !== undefined ? { staticsRadius: num("statics-radius")! } : {}),
    // hosting (docs/hosting.md): a secret makes tickets mandatory; --main joins a cluster
    ...(arg("secret", process.env["HITREG_SECRET"]) ? { secret: arg("secret", process.env["HITREG_SECRET"])! } : {}),
    ...(arg("id") ? { serverId: arg("id")! } : {}),
    ...(arg("kind") === "instance" ? { kind: "instance" as const } : {}),
    ...(arg("main") ? { mainUrl: arg("main")! } : {}),
    ...(arg("public-url") ? { publicUrl: arg("public-url")! } : {}),
    ...(arg("instance-of") ? { instanceOf: arg("instance-of")! } : {}),
    ...(num("idle-exit") !== undefined ? { idleExitSeconds: num("idle-exit")! } : {}),
    ...(num("commit-every") !== undefined ? { commitEverySeconds: num("commit-every")! } : {}),
    ...(arg("experience") ? { experienceId: arg("experience")! } : {}),
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
