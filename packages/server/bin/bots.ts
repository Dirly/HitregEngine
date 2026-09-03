#!/usr/bin/env tsx
/**
 * hitreg-bots — N fake players over the real WebSocket transport, for load.
 *
 *   pnpm -F @hitreg/server exec tsx bin/bots.ts --url ws://127.0.0.1:8787 --count 20 --seconds 60
 *
 * Each bot joins, gets a body, wanders (a new heading every couple of
 * seconds, at run speed), and fires a cast request every few seconds with
 * whatever aim it has. Every 5 s it prints the server's own tick cost from
 * /admin/status — the number that says whether N players fit in the budget.
 *
 * Options: --url (default ws://127.0.0.1:8787) --count (10) --seconds (30)
 *          --cast (seconds between casts, 3; 0 disables) --hz (input rate, 20)
 */

import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
const url = arg("url", "ws://127.0.0.1:8787");
const count = Number(arg("count", "10"));
const seconds = Number(arg("seconds", "30"));
const castEvery = Number(arg("cast", "3"));
const inputHz = Number(arg("hz", "20"));
const admin = url.replace(/^ws/, "http");
const ABILITIES = ["strike", "cleave", "firebolt", "meteor", "frostNova"];

interface Bot {
  id: string;
  client: RoomClient;
  transport: WebSocketClientTransport;
  bodyId: string | null;
  heading: number;
  seq: number;
  nextTurn: number;
  nextCast: number;
  pos: [number, number, number];
  snapshots: number;
}

const bots: Bot[] = [];
for (let i = 0; i < count; i++) {
  const id = `bot-${String(i).padStart(3, "0")}`;
  const transport = new WebSocketClientTransport(url, { peerId: id, name: id });
  const client = new RoomClient(transport, WS_HOST_ID);
  const bot: Bot = { id, client, transport, bodyId: null, heading: Math.random() * Math.PI * 2, seq: 0, nextTurn: 0, nextCast: Date.now() + Math.random() * 3000, pos: [0, 0, 0], snapshots: 0 };
  transport.onPeer((peer, state) => {
    if (peer === WS_HOST_ID && state === "connected") client.join(id);
  });
  client.onModule("world", (data) => {
    const m = data as { t?: string; self?: string };
    if (m.t === "spawn" && typeof m.self === "string") bot.bodyId = m.self;
  });
  client.onSnapshot((s) => {
    bot.snapshots++;
    const players = (s.state as { players?: Record<string, { position?: number[] }> } | null)?.players;
    const me = players?.[id]?.position;
    if (me) bot.pos = [me[0]!, me[1]!, me[2]!];
  });
  bots.push(bot);
  await new Promise((r) => setTimeout(r, 25)); // stagger the dials a little
}

const started = Date.now();
const tick = setInterval(() => {
  const now = Date.now();
  for (const bot of bots) {
    if (bot.client.state !== "joined" || !bot.bodyId) continue;
    if (now >= bot.nextTurn) {
      bot.heading += (Math.random() - 0.5) * Math.PI;
      bot.nextTurn = now + 1500 + Math.random() * 2000;
    }
    const speed = 6;
    bot.seq++;
    bot.client.sendCommand({
      t: "input",
      seq: bot.seq,
      v: [Math.cos(bot.heading) * speed, Math.sin(bot.heading) * speed],
      jump: Math.random() < 0.01,
      yaw: Math.atan2(Math.cos(bot.heading), Math.sin(bot.heading)),
      p: bot.pos,
    });
    if (castEvery > 0 && now >= bot.nextCast) {
      bot.nextCast = now + castEvery * 1000 * (0.7 + Math.random() * 0.6);
      bot.client.sendCommand({
        t: "event",
        name: "combat.cast.request",
        payload: { casterId: bot.bodyId, abilityId: ABILITIES[Math.floor(Math.random() * ABILITIES.length)], aim: [Math.cos(bot.heading), Math.sin(bot.heading)] },
      });
    }
  }
}, 1000 / inputHz);

const report = setInterval(async () => {
  const joined = bots.filter((b) => b.client.state === "joined").length;
  const bodies = bots.filter((b) => b.bodyId).length;
  const snaps = bots.reduce((n, b) => n + b.snapshots, 0);
  let status = "";
  try {
    const s = (await (await fetch(`${admin}/admin/status`)).json()) as { tickMs?: { p50: number; p95: number; max: number; budget: number }; players: unknown[]; terrainCells: number; entities: number };
    status = `server: tick p50 ${s.tickMs?.p50}ms p95 ${s.tickMs?.p95}ms max ${s.tickMs?.max}ms (budget ${s.tickMs?.budget}) · players ${s.players.length} · entities ${s.entities} · cells ${s.terrainCells}`;
  } catch (error) {
    status = `admin unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
  console.log(`[bots] t+${Math.round((Date.now() - started) / 1000)}s joined ${joined}/${count} bodies ${bodies} snapshots ${snaps} · ${status}`);
}, 5000);

setTimeout(() => {
  clearInterval(tick);
  clearInterval(report);
  for (const bot of bots) {
    bot.client.leave();
    bot.transport.close();
  }
  console.log("[bots] done");
  setTimeout(() => process.exit(0), 500);
}, seconds * 1000);
