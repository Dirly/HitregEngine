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
    // both of the area's bodies (the scene's own NPCs may be paused too: dormant with nobody near)
    expect(area.npcIds.filter((id) => h.server.paused.has(id)).length).toBe(2);

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

  it("places a pack out of sight before anyone wakes it: settled, paused, standing in its idle", async () => {
    const h = handle!;
    const spawn = h.server.playerTemplate!.entities[h.server.playerTemplate!.rootId]!.components["transform"] as { position: number[] };
    const origin: [number, number, number] = [spawn.position[0]! + 100, spawn.position[1]!, spawn.position[2]!];
    h.world.addEntities({
      ...h.world.base,
      entities: {
        far: {
          name: "far",
          parent: null,
          tags: [],
          components: {
            transform: { position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            spawnArea: { radius: 30, showRadius: 150, sleepRadius: 40, idleSeconds: 0.5, spawns: [{ template: "hero0", count: 1, spread: 0 }], leash: 20, roam: 5 },
          },
        },
      },
    });
    const area = h.spawnAreas.adopt("far", h.world.entities.get("far")!)!;
    const c = dial("p-cat");
    await until(() => c.world.some((m) => m.t === "spawn" && m.self === "player:p-cat"));
    // inside showRadius, outside radius: spawned but never woken, and paused once it has settled
    await until(() => area.npcIds.length === 1);
    expect(area.awake).toBe(false);
    expect(area.wokeCount).toBe(0);
    const [id] = area.npcIds as [string];
    await until(() => h.server.paused.has(id), 6000);
    expect(area.settleUntil).toBeUndefined();
    // a paused body is still in sight: it stands in its controller's idle, not frozen in whatever ran last
    expect(typeof h.world.anims.get(id)).toBe("string");
  }, 30_000);

  /** Positions of every connected player body. */
  function playerSpots(): Array<[number, number, number]> {
    const h = handle!;
    const out: Array<[number, number, number]> = [];
    for (const pl of h.server.players.values()) {
      if (pl.disconnectedAt !== null) continue;
      const p = h.world.positionOf(pl.bodyId);
      if (p) out.push(p);
    }
    return out;
  }
  const params = (id: string) => (handle!.world.entities.get(id)!.components["script"] as { params: Record<string, unknown> }).params;

  it("anywhere: fills to its population out of every player's sight, each with its own home; a death respawns elsewhere, out of sight", async () => {
    const h = handle!;
    const d = dial("p-dee");
    await until(() => d.world.some((m) => m.t === "spawn" && m.self === "player:p-dee"));
    const spawn = h.server.playerTemplate!.entities[h.server.playerTemplate!.rootId]!.components["transform"] as { position: number[] };
    const origin: [number, number, number] = [spawn.position[0]!, spawn.position[1]!, spawn.position[2]!];
    h.world.addEntities({
      ...h.world.base,
      entities: {
        meadow: {
          name: "meadow",
          parent: null,
          tags: [],
          components: {
            transform: { position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            spawnArea: {
              radius: 80,
              sleepRadius: 120,
              placement: "anywhere",
              hiddenFrom: 25,
              population: 4,
              respawn: [0, 0],
              roamRange: [40, 50],
              mix: [
                { template: "hero0", weight: 3, count: [1, 1], temperament: "passive" },
                { template: "hero0", weight: 1, count: [2, 2], temperament: "territorial" },
              ],
              territory: 8,
            },
          },
        },
      },
    });
    const area = h.spawnAreas.adopt("meadow", h.world.entities.get("meadow")!)!;
    expect(area.roaming).toBeDefined();
    await until(() => area.awake && area.npcIds.length === 4, 15_000);
    const players = playerSpots();
    for (const id of area.npcIds) {
      const p = params(id);
      const home = p["home"] as [number, number, number];
      // nobody spawned in sight: every home at least hiddenFrom from every player (bodies start on their home)
      for (const pl of players) expect(Math.hypot(home[0] - pl[0], home[2] - pl[2])).toBeGreaterThanOrEqual(25 - 3); // (a body may have settled a little since)
      expect(Math.hypot(home[0] - origin[0], home[2] - origin[2])).toBeLessThanOrEqual(80 + 4); // inside the disc (+ a pair's near)
      expect(p["roam"]).toBeGreaterThanOrEqual(40);
      expect(p["roam"]).toBeLessThanOrEqual(50);
      expect(p["leash"]).toBeGreaterThanOrEqual((p["roam"] as number) + 20);
      expect(["passive", "territorial"]).toContain(p["temperament"]);
      if (p["temperament"] === "passive") expect(p["alertRadius"]).toBe(0);
      else expect(p["territory"]).toBe(8);
      expect(p["spawnArea"]).toBe("meadow");
    }
    // each its own home, not the area's origin
    const homes = new Set(area.npcIds.map((id) => JSON.stringify(params(id)["home"])));
    expect(homes.size).toBeGreaterThan(1);

    // one dies: its corpse is cleared once its (here 0 s) respawn delay is up and a fresh one appears, out of sight
    const victim = area.npcIds[0]!;
    h.world.netState.set(`combat/${victim}.dead`, true);
    await until(() => !area.npcIds.includes(victim) && area.npcIds.length === 4, 15_000);
    expect(h.npcs.npcs.has(victim)).toBe(false);
    const newest = area.npcIds[area.npcIds.length - 1]!;
    const home = params(newest)["home"] as [number, number, number];
    for (const pl of playerSpots()) expect(Math.hypot(home[0] - pl[0], home[2] - pl[2])).toBeGreaterThanOrEqual(25 - 3);
    // the NPC manager does not ALSO respawn it at its spawn point
    expect(h.npcs.npcs.get(newest)!.noRespawn).toBe(true);

    // an odd population of pairs is never stuck one short: with no corpse to wait for, the last roll is a single
    h.world.addEntities({
      ...h.world.base,
      entities: {
        pairs: {
          name: "pairs",
          parent: null,
          tags: [],
          components: {
            transform: { position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            spawnArea: { radius: 80, placement: "anywhere", hiddenFrom: 25, population: 3, mix: [{ template: "hero0", count: [2, 2] }] },
          },
        },
      },
    });
    const pairs = h.spawnAreas.adopt("pairs", h.world.entities.get("pairs")!)!;
    await until(() => pairs.npcIds.length === 3, 15_000);
  }, 45_000);

  it("route: one unique rare, spawned along its route (never at the start), walking it in a random direction", async () => {
    const h = handle!;
    const spawn = h.server.playerTemplate!.entities[h.server.playerTemplate!.rootId]!.components["transform"] as { position: number[] };
    const origin: [number, number, number] = [spawn.position[0]! + 20, spawn.position[1]!, spawn.position[2]!];
    const patrol: Array<[number, number, number]> = [[0, 0, 0], [60, 0, 0], [60, 0, 60]];
    h.world.addEntities({
      ...h.world.base,
      entities: {
        rare: {
          name: "rare",
          parent: null,
          tags: [],
          components: {
            transform: { position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            spawnArea: { radius: 100, placement: "route", unique: true, population: 5, hiddenFrom: 10, patrol, leash: 20, respawn: [0, 0], spawns: [{ template: "hero0", count: 1 }] },
          },
        },
      },
    });
    const area = h.spawnAreas.adopt("rare", h.world.entities.get("rare")!)!;
    await until(() => area.awake && area.npcIds.length === 1, 10_000);
    await new Promise((r) => setTimeout(r, 400));
    expect(area.npcIds.length).toBe(1); // unique beats population 5
    const p = params(area.npcIds[0]!);
    expect([1, -1]).toContain(p["patrolDir"]);
    expect((p["patrol"] as unknown[]).length).toBe(3);
    const home = p["home"] as [number, number, number];
    // on the route: either the x-leg (z = origin) or the z-leg (x = origin + 60), and not within 10 % of its start
    const onX = Math.abs(home[2] - origin[2]) < 1e-6 && home[0] >= origin[0] && home[0] <= origin[0] + 60;
    const onZ = Math.abs(home[0] - (origin[0] + 60)) < 1e-6 && home[2] >= origin[2] && home[2] <= origin[2] + 60;
    expect(onX || onZ).toBe(true);
    expect(Math.hypot(home[0] - origin[0], home[2] - origin[2])).toBeGreaterThanOrEqual(12 - 1e-6); // 10 % of 120 m
  }, 30_000);
});
