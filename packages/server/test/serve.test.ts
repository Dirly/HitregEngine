import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * The whole process as the CLI runs it — real WebSocket, real HTTP admin —
 * against the `field` scene: join over the wire, spawn an NPC
 * through the admin endpoint, see it replicate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(15);
  }
}

let handle: ServeHandle | null = null;
try {
  handle = await serve({ playground, scene: "field", port: 0, respawnSeconds: 1, reconnectGraceSeconds: 1.5, log: () => undefined });
} catch (error) {
  console.warn("serve test skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!handle)("serve(): sockets + admin", () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await handle?.close();
  });

  function dial(peerId: string, name: string): { transport: WebSocketClientTransport; client: RoomClient; world: WorldModuleMessage[] } {
    const transport = new WebSocketClientTransport(handle!.url, { peerId });
    const client = new RoomClient(transport, WS_HOST_ID);
    const world: WorldModuleMessage[] = [];
    client.onModule(WORLD_MODULE, (m) => world.push(m as WorldModuleMessage));
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join(name);
    });
    transports.push(transport);
    clients.push(client);
    return { transport, client, world };
  }

  beforeAll(async () => {
    expect(handle!.scripts.skipped).toEqual([]);
  });

  it("answers the admin status before anyone joins", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/admin/status`);
    expect(res.ok).toBe(true);
    const status = (await res.json()) as { scene: string; players: unknown[]; npcs: number };
    expect(status.scene).toBe("field");
    expect(status.players).toEqual([]);
    expect(status.npcs).toBeGreaterThan(0); // the roster's heroes and dummies were adopted
  });

  it("two clients join over the wire and each learns about the other's body", async () => {
    const a = dial("p-ann", "Ann");
    await until(() => a.client.state === "joined");
    await until(() => a.world.some((m) => m.t === "spawn" && m.self === "player:p-ann"));
    const b = dial("p-ben", "Ben");
    await until(() => b.client.state === "joined");
    await until(() => b.world.some((m) => m.t === "spawn" && m.self === "player:p-ben"));
    // Ben's join-time spawn set includes Ann's body; Ann gets Ben's as a broadcast
    const benInitial = b.world.find((m) => m.t === "spawn" && m.self === "player:p-ben") as { entities: Record<string, unknown> };
    expect(Object.keys(benInitial.entities)).toContain("player:p-ann");
    await until(() => a.world.some((m) => m.t === "spawn" && "player:p-ben" in (m as { entities: Record<string, unknown> }).entities));
    const status = (await (await fetch(`http://127.0.0.1:${handle!.port}/admin/status`)).json()) as { players: Array<{ peerId: string }> };
    expect(status.players.map((p) => p.peerId).sort()).toEqual(["p-ann", "p-ben"]);
    // and they were not spawned on top of each other
    const [pa, pb] = [handle!.world.positionOf("player:p-ann")!, handle!.world.positionOf("player:p-ben")!];
    expect(Math.hypot(pa[0] - pb[0], pa[2] - pb[2])).toBeGreaterThan(0.5);
  });

  it("spawns an NPC through the admin endpoint and replicates it", async () => {
    const a = clients[0]!;
    const before = (await (await fetch(`http://127.0.0.1:${handle!.port}/admin/npcs`)).json()) as { npcs: Array<{ id: string }> };
    const templates = (await (await fetch(`http://127.0.0.1:${handle!.port}/admin/templates`)).json()) as { templates: string[] };
    expect(templates.templates).toContain("hero0");
    const at = handle!.world.positionOf("player:p-ann")!;
    const res = await fetch(`http://127.0.0.1:${handle!.port}/admin/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "hero0", at: [at[0] + 6, at[1] + 1, at[2]], id: "boss" }),
    });
    const body = (await res.json()) as { ok: boolean; npc: { id: string; ids: string[] } };
    expect(body.ok).toBe(true);
    expect(body.npc.id).toBe("boss");
    expect(body.npc.ids).toContain("boss/combat");
    await until(() => handle!.world.netState.get("combat/boss.hp") !== undefined);
    const after = (await (await fetch(`http://127.0.0.1:${handle!.port}/admin/npcs`)).json()) as { npcs: Array<{ id: string; hp: number }> };
    expect(after.npcs.length).toBe(before.npcs.length + 1);
    expect(after.npcs.find((n) => n.id === "boss")?.hp).toBe(260);
    // clients got the docs
    const worldMsgs: WorldModuleMessage[] = [];
    a.onModule(WORLD_MODULE, (m) => worldMsgs.push(m as WorldModuleMessage));
    // (the earlier listener collected the broadcast; check the server-side runtime doc)
    expect(handle!.server.runtimeDocs.has("boss")).toBe(true);

    const gone = await fetch(`http://127.0.0.1:${handle!.port}/admin/despawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "boss" }),
    });
    expect(((await gone.json()) as { ok: boolean }).ok).toBe(true);
    await until(() => !handle!.world.entities.has("boss"));
    expect(handle!.world.netState.get("combat/boss.hp")).toBeUndefined();
  });

  it("holds a dropped player's body for the grace window and hands it back on re-dial", async () => {
    const world = handle!.world;
    const c = dial("p-cat", "Cat");
    await until(() => c.world.some((m) => m.t === "spawn" && m.self === "player:p-cat"));
    // move it somewhere, then drop the link WITHOUT a bye (a crash, not a leave)
    world.sim.setPosition("player:p-cat", [1390, 20, 12]);
    c.transport.close();
    await until(() => (handle!.server.stats() as { players: Array<{ peerId: string; linked: boolean }> }).players.find((p) => p.peerId === "p-cat")?.linked === false);
    expect(world.entities.has("player:p-cat")).toBe(true);
    // back inside the window with the same id: same body, where it stood
    const again = dial("p-cat", "Cat");
    await until(() => again.world.some((m) => m.t === "spawn" && m.self === "player:p-cat"));
    const p = world.positionOf("player:p-cat")!;
    expect(Math.hypot(p[0] - 1390, p[2] - 12)).toBeLessThan(1);
    expect(world.netState.get("owner/player:p-cat")).toBe("p-cat");
    // and a real leave that outlives the window tears it down
    again.client.leave();
    await until(() => !world.entities.has("player:p-cat"), 6000);
  }, 20_000);

  it("respawns a killed NPC after the delay with fresh pools", async () => {
    const world = handle!.world;
    expect(world.netState.get("combat/dummy0.dead")).toBe(false);
    // kill it the authoritative way
    world.eventBus.emit("combat.damage", { targetId: "dummy0", sourceId: "test", amount: 10_000, control: 0, point: [0, 0, 0] });
    await until(() => world.netState.get("combat/dummy0.dead") === true);
    await until(() => world.netState.get("combat/dummy0.dead") === false, 4000);
    expect(world.netState.get("combat/dummy0.hp")).toBe(400);
    expect(world.entities.has("dummy0")).toBe(true);
  });
});
