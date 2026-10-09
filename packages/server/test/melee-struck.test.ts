import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";

/**
 * Package V of the foundation's combat (docs/combat-build/V-melee-visuals.md): the
 * one replicated signal melee visuals needed. A PHYSICAL blow that lands is
 * announced as `combat.struck` — who, by whom, its class and ability, what the
 * guard made of it, crit, rear — so every client draws the same impact,
 * hit-stop and kick where it landed. A magic hit is not (spells draw their
 * own impact), and a parried blow lands nothing (combat.defended tells it).
 *
 * Driven like damage-stats.test.ts: the authority's own `combat.damage`, a
 * stand-in attacker, the crit roll pinned through the actor's seam.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 10_000, what = ""): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting ${what}`);
    await wait(20);
  }
}

let layer: ServeHandle | null = null;
try {
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", respawnSeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("melee-struck test skipped:", error instanceof Error ? error.message : error);
}

type Struck = { actorId: string; sourceId: string; attackClass?: string; abilityId?: string; outcome?: string; crit?: boolean; rear?: boolean };

describe.skipIf(!layer)("combat.struck: a landed physical blow is announced", { timeout: 60_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  const Actor = layer?.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number } | undefined;
  const realRoll = Actor?.critRoll;
  afterAll(async () => {
    if (Actor && realRoll) Actor.critRoll = realRoll;
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
  });

  const transport = new WebSocketClientTransport(layer?.url ?? "ws://127.0.0.1:1", { peerId: "vic" });
  const client = new RoomClient(transport, WS_HOST_ID);
  const spawned: string[] = [];
  /** What the CLIENT received of combat.struck, over the socket. */
  const received: Struck[] = [];
  client.onModule(WORLD_MODULE, (m) => {
    const msg = m as WorldModuleMessage;
    if (msg.t === "spawn" && msg.self) spawned.push(msg.self);
  });
  client.onEvents((msg) => {
    for (const e of msg.events) if (e.name === "combat.struck") received.push(e.payload as Struck);
  });
  transport.onPeer((peer, s) => {
    if (peer === WS_HOST_ID && s === "connected") client.join("vic");
  });
  transports.push(transport);
  clients.push(client);

  const net = () => layer!.world.netState;
  const bus = () => layer!.world.eventBus;
  const log = eventLog(() => bus());
  const struck = () => log.payloads<Struck>("combat.struck");
  const numOf = (key: string): number => (net().get(key) as number) ?? 0;
  const settle = () => wait(220);
  const body = "player:vic";
  const foe = "test-foe";
  const side = (s: "front" | "rear"): [number, number] => {
    const o = layer!.world.objects.get(body)!;
    const e = o.matrixWorld.elements;
    const f = { x: Math.sin(o.rotation.y), z: Math.cos(o.rotation.y) };
    const k = s === "front" ? 2 : -2;
    return [e[12]! + f.x * k, e[14]! + f.z * k];
  };
  const hit = async (info: Record<string, unknown>): Promise<Struck[]> => {
    net().set(`combat/${body}.hp`, numOf(`combat/${body}.maxHp`));
    await settle();
    const seen = struck().length;
    bus().emit("combat.damage", { targetId: body, sourceId: foe, amount: 10, control: 0, point: [0, 1, 0], ...info });
    await settle();
    return struck().slice(seen);
  };

  it("announces a clean physical hit with its class and ability, and nothing for a spell", async () => {
    Actor!.critRoll = () => 0.999;
    await until(() => spawned.length === 1, 10_000, "spawn");
    await until(() => numOf(`combat/${body}.hp`) > 0, 10_000, "bars");
    net().set(`combat/${foe}.crit`, 0);
    expect(await hit({ kind: "physical", attackClass: "heavy", abilityId: "cleave", from: side("front") })).toEqual([
      { actorId: body, sourceId: foe, attackClass: "heavy", abilityId: "cleave" },
    ]);
    expect(await hit({ kind: "magic", attackClass: "spell", abilityId: "firebolt", element: "destruction", from: side("front") })).toEqual([]);
  });

  it("carries a crit and a rear blow", async () => {
    expect(await hit({ kind: "physical", attackClass: "light", from: side("front"), crit: true })).toMatchObject([{ crit: true }]);
    const rear = await hit({ kind: "physical", attackClass: "light", from: side("rear") });
    expect(rear).toMatchObject([{ rear: true }]);
    expect(rear[0]!.crit).toBeUndefined();
  });

  it("names what a raised guard made of a blow that still landed", async () => {
    bus().emit("combat.guard.request", { casterId: body, on: true });
    await until(() => numOf(`combat/${body}.guard`) > 0, 5000, "guard up");
    await wait(450); // past any parry window: a block, not a parry
    const out = await hit({ kind: "physical", attackClass: "light", from: side("front") });
    bus().emit("combat.guard.request", { casterId: body, on: false });
    // a body with no shield parries only: a parry lands nothing, so either it is announced
    // as blocked, or (parry-only, past the window) as a clean hit; never as a parry
    expect(out.length).toBe(1);
    expect(out[0]!.outcome === undefined || out[0]!.outcome === "blocked").toBe(true);
  });

  it("replicates to the clients", async () => {
    await until(() => received.length > 0, 5000, "a combat.struck on the client");
    expect(received[0]!.actorId).toBe(body);
  });
});
