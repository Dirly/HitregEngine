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
 *   GET  /admin/npcs            every managed NPC with position / hp / dead / ai (what each
 *                               brain is thinking: state, target, threat table)
 *   GET  /admin/templates       spawnable template names
 *   GET  /admin/netstate        the whole replicated session state
 *   GET  /admin/events          the event bus trace ring (last 64 delivered events)
 *   POST /admin/spawn           { template, at: [x,y,z], yaw?, id?, params? }
 *   POST /admin/despawn         { id }
 *   POST /admin/terraform       { edits: RecipeEdit[] } → { inverse, added, touchedCells, reloaded }
 *                               (see RECIPE_EDIT_SPECS in @hitreg/core; POST the inverse back to undo)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { recipeEditSchema, type RecipeEdit } from "@hitreg/core";
import type { GameServer } from "./server.js";
import type { NpcManager } from "./npcs.js";
import type { SpawnAreaManager } from "./spawn-areas.js";
import type { TransferTarget } from "./cluster/protocol.js";

export interface AdminDeps {
  server: GameServer;
  npcs: NpcManager | null;
  spawnAreas?: SpawnAreaManager | null;
  /** Terrain streamer, so a teleport can make ground under the body first. */
  terrain?: { ensureAround(x: number, z: number, radius?: number): void } | null;
  /** Extra fields for /admin/status (scene name, uptime …). */
  status?: () => Record<string, unknown>;
  /** In a cluster: ask main for a destination and move the character there. */
  transfer?: ((characterId: string, target: TransferTarget) => Promise<{ srv: string; url: string; sent: boolean }>) | null;
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
    if (req.method === "GET" && p === "/admin/spawn-areas") {
      send(res, 200, { areas: deps.spawnAreas?.list() ?? [] });
      return true;
    }
    if (req.method === "POST" && p === "/admin/transfer") {
      if (!deps.transfer) {
        send(res, 400, { ok: false, error: "not in a cluster — no main to place the character" });
        return true;
      }
      const body = (await readJson(req)) as { characterId?: unknown; scene?: unknown; srv?: unknown; party?: unknown } | null;
      if (!body || typeof body.characterId !== "string") {
        send(res, 400, { ok: false, error: "expected { characterId, scene? | srv?, party? }" });
        return true;
      }
      const target: TransferTarget =
        typeof body.scene === "string"
          ? { kind: "instance", scene: body.scene, ...(body.party === true ? { party: true } : {}) }
          : { kind: "layer", ...(typeof body.srv === "string" ? { layerId: body.srv } : {}), ...(body.party === true ? { party: true } : {}) };
      try {
        send(res, 200, { ok: true, ...(await deps.transfer(body.characterId, target)) });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "GET" && p === "/admin/players") {
      // who is here and where: what an agent reads to check a crossing landed in place
      const players = [...server.players.values()].map((pl) => ({
        peerId: pl.peerId,
        name: pl.name,
        bodyId: pl.bodyId,
        characterId: pl.identity?.characterId ?? null,
        position: server.world.positionOf(pl.bodyId),
        connected: pl.disconnectedAt === null,
        transferring: pl.transferring !== null,
      }));
      send(res, 200, { players });
      return true;
    }
    if (req.method === "POST" && p === "/admin/teleport") {
      // move a player body outright (a probe walking a pass, an admin unsticking someone)
      const body = (await readJson(req)) as { peerId?: unknown; position?: unknown } | null;
      const player = body && typeof body.peerId === "string" ? server.players.get(body.peerId) : undefined;
      if (!player || !isVec3(body?.position)) {
        send(res, 400, { ok: false, error: "expected { peerId, position: [x, y, z] } for a player on this server" });
        return true;
      }
      deps.terrain?.ensureAround(body.position[0], body.position[2], 1);
      server.world.sim.setPosition(player.bodyId, body.position);
      send(res, 200, { ok: true, bodyId: player.bodyId, position: body.position });
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
    if (req.method === "GET" && p === "/admin/events") {
      send(res, 200, { tick: server.world.tick, events: server.world.eventBus.trace() });
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
    if (req.method === "POST" && p === "/admin/terraform") {
      const body = (await readJson(req)) as { edits?: unknown } | null;
      if (!body || !Array.isArray(body.edits) || body.edits.length === 0) {
        send(res, 400, { ok: false, error: "expected { edits: RecipeEdit[] }" });
        return true;
      }
      const edits: RecipeEdit[] = [];
      for (const raw of body.edits) {
        const parsed = recipeEditSchema.safeParse(raw);
        if (!parsed.success) {
          send(res, 400, { ok: false, error: `bad edit: ${parsed.error.issues[0]?.message ?? "schema error"}` });
          return true;
        }
        edits.push(parsed.data);
      }
      try {
        send(res, 200, { ok: true, ...server.terraform(edits) });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    send(res, 404, { ok: false, error: `no such admin route: ${req.method} ${p}` });
    return true;
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
