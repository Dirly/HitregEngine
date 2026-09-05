#!/usr/bin/env tsx
/**
 * hitreg-main — login, placement, persistence and the layer pool, in one process.
 *
 *   pnpm -F @hitreg/server main --scene mmo --secret change-me --public-host 192.168.1.20
 *   pnpm -F @hitreg/server main --scene mmo --secret … --database postgres://user:pw@host/db
 *
 * Options
 *   --scene <name>          the world scene every layer hosts
 *   --secret <s>            cluster secret (signs tickets, admits layers) — or HITREG_SECRET
 *   --admin-token <s>       bearer for /admin/* (default: the secret) — or HITREG_ADMIN_TOKEN
 *   --port <n>              gateway http + cluster ws port (default 8780)
 *   --host <addr>           bind address (default 0.0.0.0)
 *   --public-host <name>    what CLIENTS dial to reach the layers (this box's public name / LAN ip; default 127.0.0.1)
 *   --public-scheme ws|wss  scheme in the layer urls (wss behind a TLS proxy; default ws)
 *   --ports <from-to>       port range for layers/instances (default 8801-8899)
 *   --layer-host <addr>     bind address for layers (default 0.0.0.0)
 *   --data <dir>            file persistence root (default <playground>/.hitreg/data) — ignored with --database
 *   --database <url>        Postgres connection string — or HITREG_DATABASE_URL
 *   --experience <id>       persistence scope (default: the scene name)
 *   --cap <n>               players per layer (default 40)
 *   --headroom <n>          free slots to keep before starting a layer (default 5)
 *   --min <n> / --max <n>   layers to keep / at most (default 1 / 4)
 *   --retire <seconds>      retire a layer empty this long (default 300)
 *   --instance-idle <s>     an empty instance exits after this (default 90)
 *   --instance-scenes a,b   scenes that may be instanced (default: any)
 *   --no-supervisor         do not start layers here (docker compose / systemd start them)
 *   --playground <dir>      playground checkout (default: this repo's)
 *   --child-args "…"        extra args for every layer (e.g. "--workers 2 --hz 30")
 *
 * Clients: open the playground with `?gateway=http://<public-host>:8780` and sign in.
 * Admin:   curl -s -H "Authorization: Bearer <secret>" http://127.0.0.1:8780/admin/status
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent, playgroundRoots } from "../src/assets.js";
import { FileAccountStore, FilePlayerDataBackend } from "../src/persistence/file.js";
import { PostgresStore } from "../src/persistence/postgres.js";
import { Supervisor } from "../src/main/supervisor.js";
import { startMain } from "../src/main/main.js";

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
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const scene = arg("scene");
  const secret = arg("secret", process.env["HITREG_SECRET"]);
  if (!scene || !secret) {
    console.error("usage: hitreg-main --scene <name> --secret <s> [--public-host <name>] [--database <url>]");
    process.exit(2);
  }
  const playground = path.resolve(arg("playground", path.resolve(here, "../../../apps/playground"))!);
  const port = num("port") ?? 8780;
  const host = arg("host", "0.0.0.0")!;
  const publicHost = arg("public-host", "127.0.0.1")!;
  const database = arg("database", process.env["HITREG_DATABASE_URL"]);
  const dataDir = path.resolve(arg("data", path.join(playground, ".hitreg", "data"))!);
  const [from, to] = (arg("ports", "8801-8899")!.split("-").map(Number) as [number, number]);

  let accounts;
  let playerData;
  let db: PostgresStore | null = null;
  if (database) {
    db = new PostgresStore(database);
    await db.migrate();
    accounts = db.accounts;
    playerData = db.playerData;
    console.log(`[main] persistence: postgres`);
  } else {
    accounts = new FileAccountStore(dataDir);
    playerData = new FilePlayerDataBackend(dataDir);
    console.log(`[main] persistence: files under ${dataDir}`);
  }

  const content = loadContent(playgroundRoots(playground));
  if (!content.scenes.has(scene)) {
    console.error(`scene "${scene}" not found. Known: ${[...content.scenes.keys()].join(", ") || "(none)"}`);
    process.exit(2);
  }
  const mainUrl = `ws://127.0.0.1:${port}`;
  const supervisor = flag("no-supervisor")
    ? null
    : new Supervisor({
        playground,
        mainUrl,
        secret,
        publicHost,
        publicScheme: arg("public-scheme") === "wss" ? "wss" : "ws",
        bindHost: arg("layer-host", "0.0.0.0")!,
        ports: { from, to },
        extraArgs: (arg("child-args") ?? "").split(/\s+/).filter(Boolean),
        log: (line) => console.log(line),
      });

  const handle = await startMain({
    port,
    host,
    secret,
    ...(arg("admin-token", process.env["HITREG_ADMIN_TOKEN"]) ? { adminToken: arg("admin-token", process.env["HITREG_ADMIN_TOKEN"])! } : {}),
    experienceId: arg("experience", scene)!,
    accounts,
    playerData,
    world: {
      scene,
      cap: num("cap") ?? 40,
      headroom: num("headroom") ?? 5,
      min: num("min") ?? 1,
      max: num("max") ?? 4,
      retireAfterSeconds: num("retire") ?? 300,
    },
    instances: {
      idleExitSeconds: num("instance-idle") ?? 90,
      ...(arg("instance-scenes") ? { scenes: arg("instance-scenes")!.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    },
    supervisor,
    worldFiles: content.worldFiles,
  });
  console.log(`[main] gateway ${handle.url} · layers dial ${mainUrl}/cluster · clients will be sent to ${publicHost}:${from}-${to}`);

  const shutdown = (): void => {
    console.log("[main] shutting down");
    void (async () => {
      await supervisor?.closeAll();
      await handle.close();
      await db?.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
