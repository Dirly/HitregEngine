import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MOB_EVENTS, castBarProgress, readBadges, readCastBar } from "@hitreg/core";
import type { ScriptContext } from "@hitreg/scripting";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { SCHOOL_COLOR } from "../../../apps/playground/projects/foundation/scripts/lib/combat-rules.js";
import MobCombatBridge from "../../../apps/playground/projects/foundation/scripts/mob-combat-bridge.js";
import { eventLog } from "./event-log.js";

/**
 * Package W of the foundation's combat model (docs/combat-build/W-schools.md):
 * what a cast bar is fed, and interrupts, over real sockets on the `field`
 * scene with the game's scripts. The ward wheel's outcomes are pinned in
 * defence.test.ts (socket) and defence-rules.test.ts (pure).
 *
 *   - every accepted cast with a wind-up publishes `cast/<body>` (core
 *     castBarSchema): label, school, colour, start and end; a physical one
 *     is published with `show: false`; it clears when the cast ends;
 *   - `combat.interrupt` during a MAGIC wind-up cancels the hit, marks the bar
 *     interrupted, and locks the cast's school; it does nothing to a body
 *     that is not casting, nor to a physical swing;
 *   - a locked school refuses a cast and unlocks on time;
 *   - the mob bridge turns an interrupt into `mob.interrupt` and drops a
 *     locked school's move (a fake ctx: the field scene has no creatures).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 10_000, what = ""): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting ${what}`);
    await wait(10);
  }
}

let layer: ServeHandle | null = null;
try {
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", respawnSeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("schools-cast test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

describe.skipIf(!layer)("cast bars and interrupts", { timeout: 60_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
  });

  const net = () => layer!.world.netState;
  const bus = () => layer!.world.eventBus;
  const nowS = () => layer!.world.timeMs / 1000;
  const numOf = (key: string): number => (net().get(key) as number) ?? 0;
  // every delivered event of a name (./event-log.ts: never index into the 64-entry trace ring)
  const log = eventLog(() => bus());
  const events = (name: string) => log.payloads(name);
  let body = "";

  const cast = (abilityId: string): void => {
    bus().emit("combat.cast.request", { casterId: body, abilityId, aim: [1, 0] });
  };
  const interrupt = (targetId: string, lockSeconds?: number): void => {
    bus().emit("combat.interrupt", { targetId, sourceId: "hero0", ...(lockSeconds !== undefined ? { lockSeconds } : {}) });
  };
  const accepted = (abilityId: string) => events("combat.cast.accepted").filter((e) => e.casterId === body && e.abilityId === abilityId).length;
  /** Ready to cast again: not staggered, full mana, the last cast's lockout over. */
  const ready = async (): Promise<void> => {
    await until(() => numOf(`combat/${body}.staggerUntil`) < nowS(), 6000, "standing");
    await until(() => numOf(`combat/${body}.castingUntil`) === 0 && net().get(`cast/${body}`) === undefined, 6000, "no cast");
    net().set(`combat/${body}.mana`, 120);
    net().set(`combat/${body}.stamina`, 100);
    net().set(`combat/${body}.stability`, 100);
    await wait(700); // past any recovery
  };

  it("publishes a magic cast for its bar: label, school (frost = destruction), colour, start and end; cleared at the end", async () => {
    const transport = new WebSocketClientTransport(layer!.url, { peerId: "wren" });
    const client = new RoomClient(transport, WS_HOST_ID);
    const spawned: string[] = [];
    client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "spawn" && msg.self) spawned.push(msg.self);
    });
    transport.onPeer((peer, s) => {
      if (peer === WS_HOST_ID && s === "connected") client.join("wren");
    });
    transports.push(transport);
    clients.push(client);
    await until(() => spawned.length === 1, 10_000, "spawn");
    body = spawned[0]!;
    await until(() => numOf(`combat/${body}.hp`) > 0, 10_000, "bars");
    await ready();

    cast("frostNova"); // water element, 0.8 s wind-up
    await until(() => net().get(`cast/${body}`) !== undefined, 3000, "cast published");
    const bar = readCastBar(net().get(`cast/${body}`))!;
    expect(bar).toMatchObject({ id: "frostNova", label: "Frost Nova", school: "destruction", color: SCHOOL_COLOR.destruction, tag: "DESTRUCTION" });
    expect(bar.show).toBeUndefined();
    expect(bar.end - bar.start).toBeCloseTo(0.8, 2);
    expect(numOf(`combat/${body}.castingUntil`)).toBeCloseTo(bar.end, 3);
    expect(castBarProgress(bar, bar.start + 0.4).fill).toBeCloseTo(0.5, 2);
    await until(() => net().get(`cast/${body}`) === undefined, 3000, "cast cleared");
    expect(numOf(`combat/${body}.castingUntil`)).toBe(0);
  });

  it("publishes a physical wind-up with no bar, and an interrupt does nothing to it", async () => {
    await ready();
    const seen = events("combat.interrupted").length;
    cast("cleave"); // physical heavy, 0.6 s
    await until(() => net().get(`cast/${body}`) !== undefined, 3000, "cast published");
    expect(readCastBar(net().get(`cast/${body}`))).toMatchObject({ id: "cleave", show: false });
    expect(readCastBar(net().get(`cast/${body}`))!.school).toBeUndefined();
    const until0 = numOf(`combat/${body}.castingUntil`);
    interrupt(body);
    await wait(100);
    expect(events("combat.interrupted").length).toBe(seen);
    expect(numOf(`combat/${body}.castingUntil`)).toBe(until0); // still swinging
    expect(readCastBar(net().get(`cast/${body}`))?.interruptedAt).toBeUndefined();
  });

  it("does nothing to a body that is not casting", async () => {
    await ready();
    const seen = events("combat.interrupted").length;
    interrupt(body);
    await wait(150);
    expect(events("combat.interrupted").length).toBe(seen);
    expect(numOf(`combat/${body}.lock.destruction`)).toBe(0);
    expect(net().get(`cast/${body}`)).toBeUndefined();
  });

  it("an interrupt during a magic wind-up cancels the hit, marks the bar and locks the school", async () => {
    await ready();
    const fxBefore = events("combat.spell").filter((e) => e.casterId === body && e.phase === "impact").length;
    cast("meteor"); // destruction, 1.2 s wind-up
    await until(() => numOf(`combat/${body}.castingUntil`) > 0, 3000, "winding up");
    await wait(200);
    const at = nowS();
    interrupt(body); // default lock: 4 s
    await until(() => events("combat.interrupted").some((e) => e.targetId === body && e.abilityId === "meteor"), 3000, "interrupted");
    const ev = events("combat.interrupted").at(-1)!;
    expect(ev).toMatchObject({ targetId: body, sourceId: "hero0", abilityId: "meteor", school: "destruction" });
    expect(ev.lockUntil as number).toBeCloseTo(at + 4, 0);
    expect(numOf(`combat/${body}.castingUntil`)).toBe(0);
    expect(numOf(`combat/${body}.lock.destruction`)).toBeCloseTo(ev.lockUntil as number, 3);
    // the lock is shown over the body for as long as it holds (nameplates draws badge/<id>)
    expect(readBadges(net().get(`badge/${body}`), nowS())).toEqual([
      { id: "lock.destruction", text: "✕ DESTRUCTION LOCKED", color: SCHOOL_COLOR.destruction, until: ev.lockUntil },
    ]);
    const bar = readCastBar(net().get(`cast/${body}`))!;
    expect(bar.interruptedAt).toBeGreaterThan(bar.start);
    expect(castBarProgress(bar, bar.interruptedAt! + 0.1)).toMatchObject({ visible: true, interrupted: true });
    // the meteor never lands, and the marked bar clears on its own
    await wait(1400);
    expect(events("combat.spell").filter((e) => e.casterId === body && e.phase === "impact").length).toBe(fxBefore);
    expect(net().get(`cast/${body}`)).toBeUndefined();
  });

  it("a locked school refuses a cast, another school is free, and the lock runs out on time", async () => {
    // still destruction-locked from above (4 s)
    expect(numOf(`combat/${body}.lock.destruction`)).toBeGreaterThan(nowS());
    net().set(`combat/${body}.mana`, 120);
    const before = accepted("meteor");
    cast("meteor");
    await wait(250);
    expect(accepted("meteor")).toBe(before);
    expect(numOf(`combat/${body}.mana`)).toBeGreaterThan(115); // nothing was spent
    // nature is not locked
    const miasma = accepted("miasma");
    cast("miasma");
    await until(() => accepted("miasma") > miasma, 3000, "miasma accepted");
    await ready();
    // a short lock on another school: interrupt a shadow bolt for 1 s, then shadow is free again
    cast("mobShadowBolt"); // shadow, 0.85 s wind-up, 2.5 s cooldown
    await until(() => numOf(`combat/${body}.castingUntil`) > 0, 3000, "winding up");
    interrupt(body, 1);
    await until(() => numOf(`combat/${body}.lock.shadow`) > nowS(), 3000, "shadow locked");
    const lockedAt = accepted("mobShadowBolt");
    await wait(300);
    cast("mobShadowBolt");
    await wait(250);
    expect(accepted("mobShadowBolt")).toBe(lockedAt);
    expect(readBadges(net().get(`badge/${body}`), nowS()).map((b) => b.id)).toContain("lock.shadow");
    await until(() => numOf(`combat/${body}.lock.shadow`) <= nowS(), 3000, "shadow unlocks");
    await until(() => !readBadges(net().get(`badge/${body}`), nowS()).some((b) => b.id === "lock.shadow"), 1000, "shadow badge gone");
    await ready();
    await wait(1200); // its own 2.5 s cooldown from the first cast
    cast("mobShadowBolt");
    await until(() => accepted("mobShadowBolt") > lockedAt, 3000, "shadow bolt accepted after the lock");
  });
});

describe("mob-combat-bridge and interrupts", () => {
  function bridge(netValues: Record<string, unknown> = {}) {
    const handlers = new Map<string, Array<(p: unknown) => void>>();
    const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const ctx = {
      entityId: "bridge",
      params: { fallbackAbility: "cleave", healThreat: 0.5 },
      now: () => 10_000,
      netState: {
        isAuthority: () => true,
        get: (k: string) => netValues[k],
        set: (k: string, v: unknown) => ((netValues[k] = v), true),
        keys: () => Object.keys(netValues),
        increment: () => null,
        delete: () => true,
        onChange: () => () => undefined,
      },
      events: {
        on: (name: string, fn: (p: unknown) => void) => {
          handlers.set(name, [...(handlers.get(name) ?? []), fn]);
          return () => undefined;
        },
        emit: (name: string, payload: Record<string, unknown>) => {
          emitted.push({ name, payload });
          for (const fn of handlers.get(name) ?? []) fn(payload);
        },
      },
    } as unknown as ScriptContext;
    const script = new MobCombatBridge();
    script.ctx = ctx;
    script.onStart();
    return { emit: (name: string, payload: Record<string, unknown>) => ctx.events!.emit(name, payload), emitted };
  }

  it("an interrupted mob drops its move and pauses", () => {
    const b = bridge();
    b.emit("combat.interrupted", { targetId: "ghost", sourceId: "p", abilityId: "mobShadowBolt", school: "shadow", lockUntil: 14 });
    expect(b.emitted.find((e) => e.name === MOB_EVENTS.interrupt)?.payload).toEqual({ mobId: "ghost", seconds: 0.5 });
  });

  it("a move of a locked school is not cast; the brain is told to choose again", () => {
    const b = bridge({ "combat/ghost.lock.shadow": 14 }); // now = 10 s
    b.emit(MOB_EVENTS.attack, { mobId: "ghost", abilityId: "mobShadowBolt", aim: [1, 0] });
    expect(b.emitted.some((e) => e.name === "combat.cast.request")).toBe(false);
    expect(b.emitted.find((e) => e.name === MOB_EVENTS.interrupt)?.payload).toEqual({ mobId: "ghost", seconds: 0 });
    // its claw (physical) and a spell of an unlocked school still go through
    b.emit(MOB_EVENTS.attack, { mobId: "ghost", abilityId: "mobClaw", aim: [1, 0] });
    b.emit(MOB_EVENTS.attack, { mobId: "ghost", abilityId: "mobBlight", aim: [1, 0] });
    expect(b.emitted.filter((e) => e.name === "combat.cast.request").map((e) => e.payload.abilityId)).toEqual(["mobClaw", "mobBlight"]);
  });

  it("an expired lock no longer holds", () => {
    const b = bridge({ "combat/ghost.lock.shadow": 9 });
    b.emit(MOB_EVENTS.attack, { mobId: "ghost", abilityId: "mobShadowBolt", aim: [1, 0] });
    expect(b.emitted.some((e) => e.name === "combat.cast.request")).toBe(true);
  });
});
