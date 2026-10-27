import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * Spawn-area respawn timers keep running while the area's mobs are asleep (ScriptRuntime MobSleepRule): the sleep
 * gates script steps only, so a slot killed before the player walked off is back on its feet when the player
 * returns — not respawning on arrival.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await wait(15);
  }
}

let handle: ServeHandle | null = null;
try {
  handle = await serve({ playground, scene: "field", port: 0, respawnSeconds: 2, reconnectGraceSeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("mob-sleep-respawn test skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!handle)("respawn while asleep", () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await handle?.close();
  });

  it("a slot killed before the player left is respawned by the time the player returns", async () => {
    const h = handle!;
    const transport = new WebSocketClientTransport(h.url, { peerId: "p-ann" });
    const client = new RoomClient(transport, WS_HOST_ID);
    let self = "";
    client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "spawn" && msg.self) self = msg.self;
    });
    transport.onPeer((peer, s) => {
      if (peer === WS_HOST_ID && s === "connected") client.join("p-ann");
    });
    transports.push(transport);
    clients.push(client);
    await until(() => !!self, 10_000, "the player's body");
    const home = h.world.positionOf(self)!;
    const move = (at: [number, number, number]) => {
      h.terrain?.ensureAround(at[0], at[2], 1);
      h.world.sim.setPosition(self, at);
    };
    // a mob template: the field's hero0 with its dummy brain swapped for a `mob-brain` (what makes a body a mob)
    const hero = (h.npcs as unknown as { templates: Map<string, { entities: Record<string, { components: Record<string, unknown> }> }> }).templates.get("hero0")!;
    const entities = structuredClone(hero.entities);
    entities["hero0-brain"]!.components["script"] = { name: "mob-brain", params: { leash: 20, roam: 0 } };
    h.npcs.register("sleeper", entities as never);
    // an area 12 m off, kept AWAKE across the whole walk (sleepRadius past it): only the mob sleep is in play
    const origin: [number, number, number] = [home[0] + 12, home[1], home[2] + 4];
    h.world.addEntities({
      ...h.world.base,
      entities: {
        camp: {
          name: "camp", parent: null, tags: [],
          components: {
            transform: { position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            spawnArea: { radius: 30, sleepRadius: 1000, idleSeconds: 600, spawns: [{ template: "sleeper", count: 1, spread: 0 }], leash: 20, roam: 0 },
          },
        },
      },
    });
    const area = h.spawnAreas.adopt("camp", h.world.entities.get("camp")!)!;
    await until(() => area.awake && area.npcIds.length === 1, 10_000, "the pack");
    const [mob] = area.npcIds as [string];
    await until(() => h.world.scripts.mobBand(mob) === "full", 5000, "the mob awake beside the player");

    // killed, then the player walks 300 m off: the mob sleeps (the area stays awake)
    h.world.netState.set(`combat/${mob}.dead`, true);
    move([home[0] + 300, home[1] + 1, home[2]]);
    await until(() => h.world.scripts.mobBand(mob) === "asleep", 5000, "the mob asleep");
    expect(area.awake).toBe(true);
    expect(h.server.paused.has(mob)).toBe(false);

    // past the respawn time, still away: back on its feet while asleep
    await until(() => h.world.netState.get(`combat/${mob}.dead`) !== true, 8000, "the respawn while away");
    // the respawned body is banded on the next step: asleep, the player being away
    await until(() => h.world.scripts.mobBand(mob) === "asleep", 2000, "the respawned mob asleep");

    // the player returns: the mob is there already, alive, and wakes
    move([home[0], home[1] + 1, home[2]]);
    expect(h.world.entities.has(mob)).toBe(true);
    expect(h.world.netState.get(`combat/${mob}.dead`)).not.toBe(true);
    await until(() => h.world.scripts.mobBand(mob) === "full", 3000, "the mob awake again");
  }, 40_000);
});
