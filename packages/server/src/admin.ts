/**
 * Admin HTTP surface — the same process, the same port as the game socket.
 *
 * This is the AI-facing side of the server (ARCHITECTURE §2: the running
 * state is structured text): an agent — or the dungeon master, later — reads
 * players, NPCs and session state as JSON and spawns/despawns population
 * with one POST. No auth yet: bind to localhost or put it behind something.
 *
 *   GET  /health
 *   GET  /admin/status          players, entity counts, terrain cells
 *   GET  /admin/npcs            every managed NPC with position / hp / dead
 *   GET  /admin/templates       spawnable template names
 *   GET  /admin/netstate        the whole replicated session state
 *   POST /admin/spawn           { template, at: [x,y,z], yaw?, id?, params? }
 *   POST /admin/despawn         { id }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GameServer } from "./server.js";
import type { NpcManager } from "./npcs.js";

export interface AdminDeps {
  server: GameServer;
  npcs: NpcManager | null;
  /** Extra fields for /admin/status (scene name, uptime …). */
  status?: () => Record<string, unknown>;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.end(JSON.stringify(body, null, 2));
}

const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Returns true when the request was handled (false = not an admin route). */
export async function handleAdmin(deps: AdminDeps, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (p === "/health") {
    send(res, 200, { ok: true, tick: deps.server.world.tick });
    return true;
  }
  if (!p.startsWith("/admin/")) return false;
  try {
    const { server, npcs } = deps;
    if (req.method === "GET" && p === "/admin/status") {
      send(res, 200, { ...server.stats(), npcs: npcs?.npcs.size ?? 0, ...(deps.status?.() ?? {}) });
      return true;
    }
    if (req.method === "GET" && p === "/admin/npcs") {
      send(res, 200, { npcs: npcs?.list() ?? [] });
      return true;
    }
    if (req.method === "GET" && p === "/admin/templates") {
      send(res, 200, { templates: npcs ? [...npcs.templates.keys()] : [] });
      return true;
    }
    if (req.method === "GET" && p === "/admin/netstate") {
      send(res, 200, server.world.netState.snapshot());
      return true;
    }
    if (req.method === "POST" && p === "/admin/spawn") {
      if (!npcs) {
        send(res, 400, { ok: false, error: "no NPC manager" });
        return true;
      }
      const body = (await readJson(req)) as { template?: unknown; at?: unknown; yaw?: unknown; id?: unknown; params?: unknown } | null;
      if (!body || typeof body.template !== "string" || !isVec3(body.at)) {
        send(res, 400, { ok: false, error: "expected { template: string, at: [x,y,z] }" });
        return true;
      }
      const record = npcs.spawn(body.template, body.at, {
        ...(typeof body.yaw === "number" ? { yaw: body.yaw } : {}),
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(body.params && typeof body.params === "object" ? { params: body.params as Record<string, unknown> } : {}),
      });
      if (!record) {
        send(res, 400, { ok: false, error: `unknown template or id taken: ${body.template}` });
        return true;
      }
      send(res, 200, { ok: true, npc: record });
      return true;
    }
    if (req.method === "POST" && p === "/admin/despawn") {
      if (!npcs) {
        send(res, 400, { ok: false, error: "no NPC manager" });
        return true;
      }
      const body = (await readJson(req)) as { id?: unknown } | null;
      if (!body || typeof body.id !== "string") {
        send(res, 400, { ok: false, error: "expected { id: string }" });
        return true;
      }
      send(res, 200, { ok: npcs.despawn(body.id), id: body.id });
      return true;
    }
    send(res, 404, { ok: false, error: `no such admin route: ${req.method} ${p}` });
    return true;
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
