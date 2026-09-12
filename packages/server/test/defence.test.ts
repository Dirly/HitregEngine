import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * The Valheim-flavoured defensive layer, over real sockets, with voxel-demo's
 * scripts on the `field` scene.
 *
 * This is the half of combat that cannot be checked by reading the code: guard,
 * parry and dodge are all TIMING against the authority's clock, and the whole
 * point of resolving them server-side is that a client cannot talk its way into
 * a parry. So the test drives the same events a client would and reads the
 * authority's netState back.
 *
 * The rules being pinned down (lib/defence.ts):
 *   - a raised guard absorbs `blockPower` and charges stamina for it;
 *   - a guard raised inside `parryWindow` negates the hit ENTIRELY and staggers
 *     the attacker instead;
 *   - blocking with an empty bar breaks the guard: full damage AND a stagger;
 *   - i-frames beat everything, and swinging drops your own guard.
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
  console.warn("defence test skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!layer)("guard, parry and dodge", { timeout: 60_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
  });

  function join(peerId: string) {
    const transport = new WebSocketClientTransport(layer!.url, { peerId });
    const client = new RoomClient(transport, WS_HOST_ID);
    const spawned: string[] = [];
    client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "spawn" && msg.self) spawned.push(msg.self);
    });
    transport.onPeer((peer, s) => {
      if (peer === WS_HOST_ID && s === "connected") client.join(peerId);
    });
    transports.push(transport);
    clients.push(client);
    return { client, spawned };
  }

  const net = () => layer!.world.netState;
  const bus = () => layer!.world.eventBus;
  const numOf = (key: string): number => (net().get(key) as number) ?? 0;
  const hp = (id: string): number => numOf(`combat/${id}.hp`);
  const stamina = (id: string): number => numOf(`combat/${id}.stamina`);
  const guard = (id: string): number => numOf(`combat/${id}.guard`);
  const hit = (targetId: string, sourceId: string, amount: number, control = 0): void => {
    bus().emit("combat.damage", { targetId, sourceId, amount, control, point: [0, 1, 0] });
  };
  const raise = (id: string, on: boolean): void => {
    bus().emit("combat.guard.request", { casterId: id, on });
  };
  const defends = () =>
    bus()
      .trace()
      .filter((e) => e.name === "combat.defended")
      .map((e) => e.payload as { actorId: string; outcome: string; absorbed: number });
  /** Wait for the sim to drain the event queue and apply the results. */
  const settle = () => wait(220);

  const body = "player:dana";

  it("takes a clean hit with no guard up", async () => {
    const a = join("dana");
    await until(() => a.spawned.length === 1, 10_000, "spawn");
    await until(() => hp(body) > 0, 10_000, "bars");
    const before = hp(body);
    hit(body, "hero0", 40);
    await settle();
    expect(hp(body)).toBe(before - 40);
    expect(guard(body)).toBe(0);
  });

  it("blocks: absorbs blockPower, charges stamina for it, and lets the rest through", async () => {
    // Raise the guard and let the parry window LAPSE, so this is an ordinary
    // block rather than the timed answer.
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "guard up");
    await wait(500); // past parryWindow (0.28s)
    const beforeHp = hp(body);
    const beforeStam = stamina(body);
    const seen = defends().length;
    hit(body, "hero0", 50); // blockPower is 34, so 16 should land
    await settle();
    expect(defends().length).toBeGreaterThan(seen);
    expect(hp(body)).toBeCloseTo(beforeHp - 16, 1);
    expect(stamina(body)).toBeLessThan(beforeStam); // the block was paid for
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "blocked", absorbed: 34 });
    raise(body, false);
    await settle();
    expect(guard(body)).toBe(0);
  });

  it("parries: a guard raised as the blow lands negates it and staggers the attacker", async () => {
    await until(() => stamina(body) > 20, 12_000, "stamina back");
    const beforeHp = hp(body);
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "guard up");
    // Inside the window this time — no wait before the hit.
    const seen = defends().length;
    hit(body, "hero0", 60);
    await settle();
    expect(defends().length).toBeGreaterThan(seen);
    expect(hp(body)).toBe(beforeHp); // nothing got through at all
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "parried" });
    // The attacker is the one on the floor now. That is the reward, and the
    // only reason to time a parry instead of holding block.
    expect(numOf("combat/hero0.staggerUntil")).toBeGreaterThan(layer!.world.timeMs / 1000);
    raise(body, false);
    await settle();
  });

  it("does not re-arm the parry window while the guard is already up", async () => {
    // The exploit this shape has to be immune to: spamming the block key to
    // make every incoming hit land inside a fresh window.
    await until(() => stamina(body) > 40, 12_000, "stamina back");
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "guard up");
    const raisedAt = guard(body);
    await wait(500);
    raise(body, true); // spam it
    await settle();
    expect(guard(body)).toBe(raisedAt); // same stamp: still a block, not a parry
    const beforeHp = hp(body);
    hit(body, "hero0", 50);
    await settle();
    expect(hp(body)).toBeLessThan(beforeHp);
    expect(defends().at(-1)!.outcome).toBe("blocked");
    raise(body, false);
    await settle();
  });

  it("breaks the guard when there is not enough stamina to pay for the block", async () => {
    // Enough to hold the shield up, nowhere near enough to absorb a hit with
    // it — and below `parryStamina`, so the parry branch refuses too. Being out
    // of stamina must never become the strongest defence in the game.
    //
    // Note the timing: no long wait here, because a guard held with a nearly
    // empty bar drains to 0 and drops ITSELF within a second. That is correct
    // behaviour (a dropped guard is a fairer punishment than a broken one),
    // and it is why this window is narrow.
    net().set(`combat/${body}.stamina`, 5);
    const seen = defends().length;
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "guard up");
    const beforeHp = hp(body);
    hit(body, "hero0", 40);
    await settle();
    expect(hp(body)).toBeCloseTo(beforeHp - 40, 1); // all of it
    expect(defends().length).toBeGreaterThan(seen); // a NEW verdict, not a stale one
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "guard-broken" });
    expect(numOf(`combat/${body}.staggerUntil`)).toBeGreaterThan(layer!.world.timeMs / 1000);
    // and being staggered drops the guard, so you cannot turtle through it
    expect(guard(body)).toBe(0);
  });

  it("ignores damage entirely during a roll's i-frames", async () => {
    await until(() => numOf(`combat/${body}.staggerUntil`) < layer!.world.timeMs / 1000, 6000, "stagger over");
    net().set(`combat/${body}.stamina`, 100);
    const beforeHp = hp(body);
    net().set(`combat/${body}.invulnUntil`, layer!.world.timeMs / 1000 + 1);
    const seen = defends().length;
    hit(body, "hero0", 999);
    await settle();
    expect(defends().length).toBeGreaterThan(seen);
    expect(hp(body)).toBe(beforeHp);
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "dodged" });
  });
});
