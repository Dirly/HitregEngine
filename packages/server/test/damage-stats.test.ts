import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { armorReduction } from "../../../apps/playground/projects/voxel-demo/scripts/lib/damage-math.js";
import { eventLog } from "./event-log.js";

/**
 * Package S of voxel-demo's combat model (docs/combat-plan.md "Damage maths"):
 * World of Warcraft's crit and armour, wired into the one damage path
 * (scripts/combat-actor.ts), over real sockets on the `field` scene.
 *
 * The formulas themselves are pinned in damage-math.test.ts; this file proves
 * the AUTHORITY applies them, in WoW's order (crit, rear bonus, armour, guard),
 * from the numbers bodies publish under combat/<id>.level|armor|crit|spellCrit.
 *
 * The crit roll is pinned through the actor's seam (`critRoll` on the
 * registered class), so no outcome here is left to chance. The attacker is a
 * bare id with its numbers written straight into netState: the damage path
 * only ever reads what an attacker PUBLISHED, so that is all it needs.
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
  console.warn("damage-stats test skipped:", error instanceof Error ? error.message : error);
}

type Info = { kind?: "physical" | "magic"; attackClass?: string; from?: [number, number]; abilityId?: string; element?: string; crit?: boolean };

describe.skipIf(!layer)("crit and armour on the authority", { timeout: 60_000 }, () => {
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
  /** Pin the next rolls: below the chance crits, at or above it does not. */
  const roll = (r: number): void => {
    Actor!.critRoll = () => r;
  };

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
  const guard = (id: string): number => numOf(`combat/${id}.guard`);
  const heal = (id: string): void => {
    net().set(`combat/${id}.hp`, numOf(`combat/${id}.maxHp`));
  };
  const settle = () => wait(220);

  const body = "player:sam";
  /** A stand-in attacker: only its published numbers exist. */
  const foe = "test-foe";
  const stats = (id: string, s: { level?: number; armor?: number; crit?: number; spellCrit?: number }): void => {
    for (const [k, v] of Object.entries(s)) net().set(`combat/${id}.${k}`, v);
  };
  const side = (id: string, s: "front" | "rear"): [number, number] => {
    const o = layer!.world.objects.get(id)!;
    const e = o.matrixWorld.elements;
    const f = { x: Math.sin(o.rotation.y), z: Math.cos(o.rotation.y) };
    const k = s === "front" ? 2 : -2;
    return [e[12]! + f.x * k, e[14]! + f.z * k];
  };
  const melee = (s: "front" | "rear" = "front", crit?: boolean): Info => ({
    kind: "physical",
    attackClass: "light",
    from: side(body, s),
    ...(crit ? { crit } : {}),
  });
  const spell = (crit?: boolean): Info => ({
    kind: "magic",
    attackClass: "spell",
    from: side(body, "front"),
    abilityId: "firebolt",
    element: "destruction",
    ...(crit ? { crit } : {}),
  });
  /** Deal `amount` to the body and return what it lost. */
  const lost = async (amount: number, info: Info): Promise<number> => {
    heal(body);
    await settle();
    const before = hp(body);
    bus().emit("combat.damage", { targetId: body, sourceId: foe, amount, control: 0, point: [0, 1, 0], ...info });
    await settle();
    return before - hp(body);
  };
  // every delivered event of a name (./event-log.ts: never index into the 64-entry trace ring)
  const log = eventLog(() => bus());
  const crits = () => log.payloads<{ actorId: string; sourceId: string; amount: number; kind: string }>("combat.crit");

  it("publishes a player's level, armour and crit chances from its character sheet", async () => {
    roll(0.999); // nothing crits unless a test says so
    const a = join("sam");
    await until(() => a.spawned.length === 1, 10_000, "spawn");
    await until(() => hp(body) > 0, 10_000, "bars");
    // Without a sheet a body keeps its params (the field scene's player carries
    // no character-sheet script): level 1, no armour, everyone's 5%.
    expect(numOf(`combat/${body}.level`)).toBe(1);
    expect(numOf(`combat/${body}.armor`)).toBe(0);
    expect(numOf(`combat/${body}.crit`)).toBe(5);
    // What the character-sheet builtin mirrors onto the body (derivedStats of
    // netState character/<bodyId>; its own tests pin that), and the actor
    // follows it whenever it changes.
    const obj = layer!.world.objects.get(body)!;
    obj.userData["character"] = { level: 7, stats: { armor: 120, crit: 9.5, spellCrit: 6.5 } };
    await until(() => numOf(`combat/${body}.crit`) === 9.5, 5000, "sheet stats");
    expect(numOf(`combat/${body}.level`)).toBe(7);
    expect(numOf(`combat/${body}.armor`)).toBe(120);
    expect(numOf(`combat/${body}.spellCrit`)).toBe(6.5);
    obj.userData["character"] = { level: 8, stats: { armor: 140, crit: 10, spellCrit: 6.5 } };
    await until(() => numOf(`combat/${body}.level`) === 8, 5000, "a level up");
    expect(numOf(`combat/${body}.armor`)).toBe(140);
  });

  it("armour takes its share off a physical hit and nothing off a magic one", async () => {
    stats(foe, { level: 1, crit: 0, spellCrit: 0 });
    stats(body, { level: 1, armor: 1000 });
    const r = armorReduction(1000, 1); // 1000 / (1000 + 400 + 85) = 67%
    expect(await lost(40, melee())).toBeCloseTo(40 * (1 - r), 1);
    expect(await lost(40, spell())).toBeCloseTo(40, 1);
  });

  it("a higher-level attacker gets through more of the same armour", async () => {
    stats(body, { armor: 1000 });
    stats(foe, { level: 1 });
    const low = await lost(40, melee());
    stats(foe, { level: 10 });
    const high = await lost(40, melee());
    expect(high).toBeGreaterThan(low);
    expect(high).toBeCloseTo(40 * (1 - armorReduction(1000, 10)), 1); // 1000 / 2250 = 44%
  });

  it("a forced crit doubles a physical hit and adds half to a spell", async () => {
    stats(foe, { level: 1, crit: 0, spellCrit: 0 });
    stats(body, { level: 1, armor: 0 });
    const seen = crits().length;
    expect(await lost(30, melee("front", true))).toBeCloseTo(60, 1);
    expect(await lost(30, spell(true))).toBeCloseTo(45, 1);
    expect(await lost(30, melee())).toBeCloseTo(30, 1); // the roll is pinned high: no crit unless forced
    // both crits were announced, to the victim and from the attacker
    expect(crits().slice(seen)).toEqual([
      { actorId: body, sourceId: foe, amount: 60, kind: "physical" },
      { actorId: body, sourceId: foe, amount: 45, kind: "magic" },
    ]);
  });

  it("keeps WoW's order with a shield up: crit, armour, THEN the block", async () => {
    stats(foe, { level: 1 });
    stats(body, { level: 1, armor: 500 });
    net().set(
      `combat/${body}.loadout`,
      JSON.stringify({ set: 0, lmb: "", rmb: "@block", weapon1: "", weapon2: "", trinket1: "", trinket2: "", trait: "", consumables: [], guard: { kind: "block" } }),
    );
    heal(body);
    bus().emit("combat.guard.request", { casterId: body, on: true });
    await until(() => guard(body) > 0, 3000, "guard up");
    await wait(500); // past the parry window: a held block
    const before = hp(body);
    bus().emit("combat.damage", { targetId: body, sourceId: foe, amount: 50, control: 0, point: [0, 1, 0], ...melee("front", true) });
    await settle();
    const r = armorReduction(500, 1);
    const blockPower = 34; // the actor's default; this loadout names none
    // 50 x 2 = 100, armour leaves 49.2, the block absorbs 34: 15.2 lands.
    // Blocking first would have let (100 - 34) x 0.49 = 32.5 through.
    expect(before - hp(body)).toBeCloseTo(100 * (1 - r) - blockPower, 1);
    const defended = log.payloads<{ actorId: string; outcome: string; absorbed: number }>("combat.defended").at(-1);
    expect(defended).toMatchObject({ actorId: body, outcome: "blocked", absorbed: blockPower });
    bus().emit("combat.guard.request", { casterId: body, on: false });
    await settle();
    // and from behind the shield does nothing: crit, rear bonus, armour, all of it lands
    expect(await lost(20, melee("rear", true))).toBeCloseTo(20 * 2 * 1.5 * (1 - r), 1);
    net().set(`combat/${body}.loadout`, "");
  });

  it("a shield's blockPower is a share of the hit, not points (E1: a heater absorbed 0.7 of 16)", async () => {
    stats(foe, { level: 1 });
    stats(body, { level: 1, armor: 0 });
    net().set(
      `combat/${body}.loadout`,
      JSON.stringify({ set: 0, lmb: "", rmb: "@block", weapon1: "", weapon2: "", trinket1: "", trinket2: "", trait: "", consumables: [], guard: { kind: "block", blockPower: 0.7 } }),
    );
    heal(body);
    bus().emit("combat.guard.request", { casterId: body, on: true });
    await until(() => guard(body) > 0, 3000, "guard up");
    await wait(500); // past the parry window: a held block
    const before = hp(body);
    bus().emit("combat.damage", { targetId: body, sourceId: foe, amount: 40, control: 0, point: [0, 1, 0], ...melee("front") });
    await settle();
    expect(before - hp(body)).toBeCloseTo(40 * 0.3, 1);
    const defended = log.payloads<{ outcome: string; absorbed: number }>("combat.defended").at(-1);
    expect(defended).toMatchObject({ outcome: "blocked", absorbed: 28 });
    bus().emit("combat.guard.request", { casterId: body, on: false });
    await settle();
    net().set(`combat/${body}.loadout`, "");
  });

  it("the level gap shifts the chance a pinned roll is judged against", async () => {
    stats(body, { armor: 0 });
    stats(foe, { level: 5, crit: 5 });
    roll(0.045); // under 5%, over 4%
    stats(body, { level: 5 });
    expect(await lost(20, melee())).toBeCloseTo(40, 1); // even levels: 5%, a crit
    stats(body, { level: 6 });
    expect(await lost(20, melee())).toBeCloseTo(20, 1); // a level above: 4%, no crit
    roll(0.055); // over 5%, under 5.8%
    stats(body, { level: 5 });
    expect(await lost(20, melee())).toBeCloseTo(20, 1);
    stats(body, { level: 1 }); // four levels below: 5% + 4 x 0.2%
    expect(await lost(20, melee())).toBeCloseTo(40, 1);
    // spells read the attacker's spellCrit, not its crit
    stats(foe, { crit: 100, spellCrit: 0 });
    expect(await lost(20, spell())).toBeCloseTo(20, 1);
    roll(0.999);
  });
});
