import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * Spawn areas: a pack exists only while a player is near. Wake on approach
 * (spawned once, with home/leash/roam handed to the brain), pause in place
 * when everyone leaves (no body in the sim, no terrain focus, no respawn
 * timer), resume where it stood when someone returns — and the transfer
 * gate says no within sight of an awake pack.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(15);
  }
}

let handle: ServeHandle | null = null;
try {
  handle = await serve({ playground, scene: "field", port: 0, respawnSeconds: 0, reconnectGraceSeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("spawn-areas test skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!handle)("spawn areas", () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await handle?.close();
  });

  function dial(peerId: string) {
    const transport = new WebSocketClientTransport(handle!.url, { peerId });
    const client = new RoomClient(transport, WS_HOST_ID);
    const world: WorldModuleMessage[] = [];
    client.onModule(WORLD_MODULE, (m) => world.push(m as WorldModuleMessage));
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join(peerId);
    });
    transports.push(transport);
    clients.push(client);
    return { transport, client, world };
  }

  it("wakes on approach, pauses in place when alone, resumes on return", async () => {
    const h = handle!;
    const spawn = h.server.playerTemplate!.entities[h.server.playerTemplate!.rootId]!.components["transform"] as { position: number[] };
    const origin: [number, number, number] = [spawn.position[0]! + 12, spawn.position[1]!, spawn.position[2]! + 4];
    // an area authored 12 m from the player spawn, with a fast sleep for the test
    h.world.addEntities({
      ...h.world.base,
      entities: {
        camp: {
          name: "camp",
          parent: null,
          tags: [],
          components: {
            transform: { position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            spawnArea: { radius: 30, sleepRadius: 40, idleSeconds: 0.5, spawns: [{ template: "hero0", count: 2, spread: 3 }], leash: 20, roam: 5 },
          },
        },
      },
    });
    const area = h.spawnAreas.adopt("camp", h.world.entities.get("camp")!)!;
    expect(area.awake).toBe(false);
    expect(h.spawnAreas.list()).toEqual([{ id: "camp", position: origin, awake: false, npcs: 0, woke: 0 }]);
    const npcsBefore = h.npcs.npcs.size;

    // a player spawns within radius → the pack appears, replicated to the client
    const a = dial("p-ann");
    await until(() => a.world.some((m) => m.t === "spawn" && m.self === "player:p-ann"));
    await until(() => area.awake && area.npcIds.length === 2);
    expect(h.npcs.npcs.size).toBe(npcsBefore + 2);
    const [n1] = area.npcIds as [string, string];
    expect(n1).toBe("camp#hero0#1");
    const brain = h.world.entities.get(n1)!.components["script"] as { params: Record<string, unknown> };
    expect(brain.params["home"]).toEqual(origin);
    expect(brain.params["leash"]).toBe(20);
    expect(brain.params["spawnArea"]).toBe("camp");
    // ...and so does every OTHER scripted entity in the subtree. An entity
    // carries one script, so a real brain lives on a child of the body — if
    // the spawner only reached the root, a pack would silently ignore the
    // leash its area authored and wander until the fence teleported it back.
    const child = h.world.entities.get(`${n1}/brain`)!.components["script"] as { params: Record<string, unknown> };
    expect(child.params["home"]).toEqual(origin);
    expect(child.params["leash"]).toBe(20);
    expect(child.params["spawnArea"]).toBe("camp");
    await until(() => a.world.some((m) => m.t === "spawn" && n1 in (m as { entities: Record<string, unknown> }).entities));
    expect(h.world.sim.getLinvel(n1)).not.toBeNull();
    // within sight of an awake pack: not a moment to swap layers
    expect(h.spawnAreas.clearToTransfer("p-ann")).toBe(false);
    expect(h.server.canTransfer("p-ann")).toBe(false);

    // the player leaves → after idleSeconds the pack pauses where it stands
    a.client.leave();
    await until(() => !h.server.players.has("p-ann"));
    await until(() => !area.awake && h.server.paused.has(n1), 6000);
    expect(h.world.sim.getLinvel(n1)).toBeNull(); // no body in the sim
    expect(h.world.entities.has(n1)).toBe(true); // but the entity and its doc remain
    expect(h.server.runtimeDocs.has(n1)).toBe(true);
    const where = h.world.positionOf(n1)!; // frozen: nothing moves it while paused
    await wait(200);
    expect(h.world.positionOf(n1)).toEqual(where);
    const stats = h.server.stats() as { paused: number };
    expect(stats.paused).toBe(2);

    // someone comes back → resumed in place, not respawned
    const b = dial("p-ben");
    await until(() => b.world.some((m) => m.t === "spawn" && m.self === "player:p-ben"));
    await until(() => area.awake && !h.server.paused.has(n1));
    expect(area.wokeCount).toBe(2);
    expect(area.npcIds.length).toBe(2);
    expect(h.npcs.npcs.size).toBe(npcsBefore + 2);
    expect(h.world.sim.getLinvel(n1)).not.toBeNull();
    const back = h.world.positionOf(n1)!;
    expect(Math.hypot(back[0] - where[0], back[2] - where[2])).toBeLessThan(1);
    // and it is reported on the admin surface
    const res = (await (await fetch(`http://127.0.0.1:${h.port}/admin/spawn-areas`)).json()) as { areas: Array<{ id: string; awake: boolean; npcs: number }> };
    expect(res.areas).toEqual([{ id: "camp", position: origin, awake: true, npcs: 2, woke: 2 }]);
  }, 30_000);
});
