import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import type { EntityDoc } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";

/**
 * Package D2 of the foundation's combat model (docs/combat-build/D2-stealth-bows-traits.md)
 * over real sockets on the `field` scene with the game's scripts:
 *
 *   - a sneaking body is not noticed by a creature at a range where a walking
 *     one is, moves slower and crouches, and is noticed once it attacks;
 *   - hide makes a creature that was fighting it forget it;
 *   - the opener (ambush) does its large hit only on an unaware target;
 *   - a bow shot is physical ranged: a shield blocks it, a parry does not;
 *   - a steady aim strengthens exactly one shot;
 *   - each birth-trait ability works (ironhide, bullrush, sneak, aimed shot,
 *     venom blade);
 *   - venom's damage-over-time ticks, stops, and ends on death.
 *
 * The crit roll is pinned to "never" (CombatActor.critRoll), so every crit
 * here is forced. The field's three fighting heroes are laid down at the
 * start so no stray blow lands inside a measurement. Creatures are the scene's
 * hero0 subtree with an engine mob-brain that never walks (`lurkA`, `lurkB`),
 * or with no brain at all (`foe`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 10_000, what = ""): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting ${what}`);
    await wait(15);
  }
}

let layer: ServeHandle | null = null;
try {
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", respawnSeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("d2 skills test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

type Side = "front" | "rear";

describe.skipIf(!layer)("D2: stealth, the opener, bows, birth traits", { timeout: 120_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
  });

  const world = () => layer!.world;
  const net = () => world().netState;
  const bus = () => world().eventBus;
  const nowS = () => world().timeMs / 1000;
  const numOf = (key: string): number => (net().get(key) as number) ?? 0;
  const hp = (id: string) => numOf(`combat/${id}.hp`);
  // every delivered event of a name (./event-log.ts: never index into the 64-entry trace ring)
  const log = eventLog(() => bus());
  const events = (name: string) => log.payloads(name);
  const settle = () => wait(220);

  function join(peerId: string): Promise<string> {
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
    return until(() => spawned.length === 1, 10_000, `${peerId} spawn`).then(() => spawned[0]!);
  }

  const xz = (id: string): [number, number] => {
    const e = world().objects.get(id)!.matrixWorld.elements;
    return [e[12]!, e[14]!];
  };
  /** A point `d` metres from `id` on one side, as combat-actor and mob-brain judge it (characters face local +Z). */
  const side = (id: string, s: Side = "front", d = 2): [number, number] => {
    const o = world().objects.get(id)!;
    const [x, z] = xz(id);
    const f = { x: Math.sin(o.rotation.y), z: Math.cos(o.rotation.y) };
    const k = s === "front" ? d : -d;
    return [x + f.x * k, z + f.z * k];
  };
  let y = 0;
  const putAt = (id: string, at: [number, number]): void => world().sim.setPosition(id, [at[0], y, at[1]]);
  const hit = (targetId: string, sourceId: string, abilityId: string, amount: number, control = 0, from: [number, number] = side(targetId), extra: Record<string, unknown> = {}): void => {
    bus().emit("combat.damage", { targetId, sourceId, amount, control, point: [0, 1, 0], kind: "physical", attackClass: "light", abilityId, from, ...extra });
  };
  const cast = (casterId: string, abilityId: string, aim: [number, number] = [1, 0], extra: Record<string, unknown> = {}): void => {
    bus().emit("combat.cast.request", { casterId, abilityId, aim, ...extra });
  };
  const aimAt = (from: string, to: string): [number, number] => {
    const [ax, az] = xz(from);
    const [bx, bz] = xz(to);
    const d = Math.hypot(bx - ax, bz - az) || 1;
    return [(bx - ax) / d, (bz - az) / d];
  };
  const ready = async (id: string): Promise<void> => {
    await until(() => numOf(`combat/${id}.staggerUntil`) < nowS(), 8000, `${id} standing`);
    await until(() => numOf(`combat/${id}.castingUntil`) === 0, 6000, `${id} not casting`);
    net().set(`combat/${id}.mana`, numOf(`combat/${id}.maxMana`));
    net().set(`combat/${id}.stamina`, numOf(`combat/${id}.maxStamina`));
    net().set(`combat/${id}.stability`, numOf(`combat/${id}.maxStability`));
    await wait(1000); // past any recovery
  };
  const stealthed = (id: string) => numOf(`combat/${id}.stealth`) > 0;
  /**
   * Put `id` `d` metres from `of` where the ground is LEVEL with `of`'s: shots
   * fly level at chest height (±2.4 m), and the field is hilly. Tries eight
   * headings and keeps the first whose settled height is within 0.6 m.
   */
  const placeLevel = async (id: string, of: string, d: number): Promise<void> => {
    const [ox, oz] = xz(of);
    const oy = world().objects.get(of)!.position.y;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      world().sim.setPosition(id, [ox + Math.sin(a) * d, oy + 0.5, oz + Math.cos(a) * d]);
      await wait(700);
      if (Math.abs(world().objects.get(id)!.position.y - oy) < 0.6) return;
    }
    throw new Error(`no level ground ${d} m from ${of}`);
  };
  const ai = (mob: string) => world().scripts.debugOf(`${mob}/brain`) as { target: string; threat: Array<{ id: string }> } | undefined;

  let ana = "";
  let bo = "";
  const foe = "foe";
  const lurkA = "lurkA";
  const lurkB = "lurkB";

  it("sets up: two players, a brainless body and two creatures that never walk", async () => {
    ana = await join("ana");
    bo = await join("bram");
    await until(() => hp(ana) > 0 && hp(bo) > 0, 10_000, "bars");
    y = world().objects.get(ana)!.position.y + 0.3;
    // the field's fighting heroes lie down: nothing stray lands inside a measurement
    for (const h of ["hero0", "hero1", "hero2"]) net().set(`combat/${h}.dead`, true);
    // no landing grace: the brains must be free to notice the players at once
    for (const p of [ana, bo]) net().set(`landing/${p}`, 0);
    const subtree = (brain: Record<string, unknown> | null): Record<string, EntityDoc> => {
      const out: Record<string, EntityDoc> = {};
      for (const id of ["hero0", "hero0-visual", "hero0-combat", "hero0-caster"]) out[id] = structuredClone(world().expanded.entities[id]!) // the authored doc: the server builds no drawing-only children;
      if (brain) {
        const e = structuredClone(world().entities.get("hero0-brain")!);
        e.components["script"] = { name: "mob-brain", params: { actor: "hero0", ...brain } };
        out["hero0-brain"] = e;
      }
      return out;
    };
    // sight 12 m in a 70° cone, hearing 4 m; no pack shouts, no walking, no sight rays
    const lurker = {
      faction: "enemy",
      hostileTo: "player",
      aggroRange: 12,
      deaggroRange: 20,
      hearRadius: 4,
      sightAngle: 70,
      requireLineOfSight: false,
      alertRadius: 0,
      attackInterval: 60,
      abilities: "mobClaw",
      leash: 500,
      roam: 0,
      speed: 0,
      roamSpeed: 0,
    };
    layer!.npcs.register("d2-foe", subtree(null));
    layer!.npcs.register("d2-lurker", subtree(lurker));
    const [ax, az] = xz(ana);
    expect(layer!.npcs.spawn("d2-foe", [ax + 40, y, az], { id: foe })).not.toBeNull();
    expect(layer!.npcs.spawn("d2-lurker", [ax, y, az + 40], { id: lurkA })).not.toBeNull();
    expect(layer!.npcs.spawn("d2-lurker", [ax, y, az - 40], { id: lurkB })).not.toBeNull();
    layer!.server.spawn({
      "d2-bridge": {
        name: "d2 bridge",
        parent: null,
        tags: [],
        components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, script: { name: "mob-combat-bridge", params: {} } },
      } as EntityDoc,
    });
    await until(() => hp(foe) > 0 && hp(lurkA) > 0 && hp(lurkB) > 0, 10_000, "test bodies' bars");
    await until(() => ai(lurkA) !== undefined && ai(lurkB) !== undefined, 5000, "brains");
    await settle();
    expect(ai(lurkA)?.target).toBe("");
  });

  it("a sneaking body is not noticed where a walking one is, creeps crouched, and is noticed when it attacks", async () => {
    await ready(ana);
    const ud = () => world().objects.get(ana)!.userData as { speedMult?: number; crouch?: boolean };
    const walkSpeed = ud().speedMult ?? 1;
    cast(ana, "sneak");
    await until(() => stealthed(ana), 3000, "ana sneaking");
    expect(net().get(`notice/${ana}`)).toBe(0.3);
    expect(numOf(`combat/${ana}.stealthUntil`)).toBe(0); // at will
    await settle();
    expect(ud().crouch).toBe(true);
    expect(ud().speedMult ?? 0).toBeCloseTo(walkSpeed * 0.6, 3);
    // 3 m behind a creature that hears 4 m: sneaking, it hears 1.2
    putAt(ana, side(lurkA, "rear", 3));
    putAt(bo, side(lurkB, "rear", 3));
    await until(() => ai(lurkB)?.target === bo, 5000, "the walking body heard");
    await wait(800);
    expect(ai(lurkA)?.target).toBe("");
    expect(numOf(`combat/${lurkA}.engaged`)).toBe(0);
    // a swing into the air gives it away: no blow lands, but the stealth is gone
    await ready(ana);
    const [lx, lz] = xz(lurkA);
    const [px, pz] = xz(ana);
    const d = Math.hypot(px - lx, pz - lz);
    cast(ana, "strike", [(px - lx) / d, (pz - lz) / d]); // facing away from it
    await until(() => !stealthed(ana), 3000, "the stealth broken");
    expect(net().get(`notice/${ana}`)).toBe(1);
    await until(() => ai(lurkA)?.target === ana, 5000, "the attacker heard");
    // and the walking body is let go so it cannot spoil a later test
    putAt(bo, side(lurkB, "front", 40));
  });

  it("the at-will sneak toggles off when pressed again", async () => {
    putAt(ana, side(lurkA, "front", 30));
    await ready(ana);
    cast(ana, "sneak");
    await until(() => stealthed(ana), 3000, "sneaking");
    await wait(600);
    const cooldown = numOf(`cooldown/${ana}.sneak`);
    expect(cooldown).toBeGreaterThan(nowS()); // still cooling down: a toggle does not wait on it
    cast(ana, "sneak");
    await until(() => !stealthed(ana), 3000, "toggled off");
    expect(numOf(`cooldown/${ana}.sneak`)).toBe(cooldown); // and it costs nothing
  });

  it("hide: every creature fighting the hider forgets it, and it is stealthed for a few seconds", async () => {
    await ready(lurkA);
    putAt(ana, side(lurkA, "front", 6));
    hit(lurkA, ana, "strike", 10); // a grudge, whatever it already had
    await until(() => ai(lurkA)?.target === ana && !!ai(lurkA)?.threat.some((t) => t.id === ana), 5000, "lurkA on ana");
    await ready(ana);
    const at = nowS();
    cast(ana, "hide");
    await until(() => stealthed(ana), 3000, "hidden");
    expect(numOf(`combat/${ana}.stealthUntil`)).toBeCloseTo(at + 0.2 + 5, 0);
    expect(events("combat.vanish").some((e) => e.sourceId === ana && e.radius === 15)).toBe(true);
    await until(() => ai(lurkA)?.target === "" && !ai(lurkA)?.threat.some((t) => t.id === ana), 3000, "forgotten");
    await wait(800); // 6 m in front: seen inside 3.6 m only, while hidden
    expect(ai(lurkA)?.target).toBe("");
    await until(() => numOf(`combat/${lurkA}.engaged`) === 0, 3000, "lurkA unaware again");
    putAt(ana, side(lurkA, "front", 30)); // out of its sight before the stealth runs out
  });

  it("the opener: a huge hit and a stagger on an unaware creature, from behind; an ordinary heavy on an aware one", async () => {
    await until(() => !stealthed(ana), 8000, "the hide's stealth over"); // or the sneak below would toggle it off
    for (const id of [lurkA]) {
      net().set(`combat/${id}.maxHp`, 2000);
      net().set(`combat/${id}.hp`, 2000);
    }
    await ready(ana);
    putAt(ana, side(lurkA, "rear", 10));
    cast(ana, "sneak");
    await until(() => stealthed(ana), 3000, "sneaking");
    await ready(ana);
    putAt(ana, side(lurkA, "rear", 2)); // inside the 3 m cone; outside the 1.2 m it hears a sneak at
    await wait(500);
    expect(ai(lurkA)?.target).toBe("");
    const before = hp(lurkA);
    const crits = () => events("combat.crit").filter((e) => e.sourceId === ana && e.actorId === lurkA).length;
    const seen = crits();
    cast(ana, "ambush", aimAt(ana, lurkA)); // 1.2 s wind-up, still sneaking
    await wait(600);
    expect(stealthed(ana)).toBe(true); // it breaks at the release, not the wind-up
    await until(() => hp(lurkA) < before, 4000, "the ambush landed");
    // 36 x 2.5 (unaware) x 2 (crit) x 1.5 (rear arc), no armour
    expect(before - hp(lurkA)).toBeCloseTo(270, 0);
    expect(crits()).toBe(seen + 1);
    expect(numOf(`combat/${lurkA}.staggerUntil`)).toBeGreaterThan(nowS() + 1);
    expect(stealthed(ana)).toBe(false);
    // now it has noticed: the same blow from the front is an ordinary heavy
    await until(() => numOf(`combat/${lurkA}.engaged`) === 1, 3000, "aware");
    await ready(lurkA);
    const aware = hp(lurkA);
    hit(lurkA, ana, "ambush", 36, 0, side(lurkA, "front"), { attackClass: "heavy" });
    await settle();
    expect(aware - hp(lurkA)).toBeCloseTo(36, 1);
  });

  it("a bow shot is physical ranged: a shield blocks it, a parry does not", async () => {
    // the creature shoots the player (two players are one faction: no PvP here)
    putAt(ana, side(lurkA, "front", 60));
    await settle();
    await ready(ana);
    await ready(foe);
    await placeLevel(foe, ana, 5);
    // ana faces the shooter, so the guard's front arc is the side the arrow comes in on
    const [fx, fz] = xz(foe);
    const [ax, az] = xz(ana);
    world().objects.get(ana)!.rotation.y = Math.atan2(fx - ax, fz - az);
    await settle();
    const guarded = (kind: string) =>
      net().set(`combat/${ana}.loadout`, JSON.stringify({ set: 0, lmb: "", rmb: "", weapon1: "", weapon2: "", trinket1: "", trinket2: "", trait: "", consumables: [], guard: { kind } }));
    // a shield: the shot is blocked
    guarded("block");
    await settle();
    bus().emit("combat.guard.request", { casterId: ana, on: true });
    await until(() => numOf(`combat/${ana}.guard`) > 0, 3000, "shield up");
    const seenDef = events("combat.defended").length;
    cast(foe, "bowShot", aimAt(foe, ana));
    await until(() => events("combat.defended").slice(seenDef).some((e) => e.actorId === ana), 3000, "defended");
    expect(events("combat.defended").slice(seenDef).find((e) => e.actorId === ana)).toMatchObject({ outcome: "blocked", kind: "physical", attackClass: "ranged", abilityId: "bowShot" });
    bus().emit("combat.guard.request", { casterId: ana, on: false });
    // a blade: the parry window is open as the arrow arrives, and it goes straight through
    guarded("parry");
    await ready(foe);
    await until(() => numOf(`combat/${ana}.guard`) === 0, 3000, "guard down");
    const seen = events("combat.defended").length;
    const before = hp(ana);
    const spawned = events("combat.projectile.spawn").length;
    cast(foe, "bowShot", aimAt(foe, ana));
    await until(() => events("combat.projectile.spawn").length > spawned, 3000, "shot loosed");
    net().set(`combat/${ana}.guard`, nowS()); // the parry window opens as it flies (5 m at 45 m/s)
    await until(() => hp(ana) < before, 3000, "the arrow landed");
    expect(events("combat.defended").slice(seen).filter((e) => e.actorId === ana)).toEqual([]);
    const dmg = events("combat.damage").filter((e) => e.targetId === ana && e.sourceId === foe).at(-1)!;
    expect(dmg).toMatchObject({ abilityId: "bowShot", kind: "physical", attackClass: "ranged" });
    net().set(`combat/${ana}.loadout`, "");
  });

  it("a steady aim strengthens exactly one shot", async () => {
    await ready(bo);
    await placeLevel(foe, bo, 6);
    const shots = () => events("combat.damage").filter((e) => e.sourceId === bo && e.targetId === foe && e.abilityId === "bowShot");
    const seen = shots().length;
    bus().emit("combat.steady.request", { casterId: bo, on: true });
    await until(() => numOf(`combat/${bo}.steady`) > 0, 3000, "steadying");
    await wait(1100);
    cast(bo, "bowShot", aimAt(bo, foe));
    await until(() => shots().length > seen, 3000, "first shot");
    expect(shots()[seen]!["amount"]).toBeCloseTo(14 * 1.6, 3);
    // straight away again, the key still held: the hold started over at the first shot
    const accepted = () => events("combat.cast.accepted").filter((e) => e.casterId === bo && e.abilityId === "bowShot").length;
    const acc = accepted();
    while (accepted() === acc) {
      cast(bo, "bowShot", aimAt(bo, foe));
      await wait(40);
    }
    await until(() => shots().length > seen + 1, 3000, "second shot");
    expect(shots()[seen + 1]!["amount"]).toBeCloseTo(14, 3);
    expect(numOf(`combat/${bo}.steady`)).toBeGreaterThan(0); // still held
    bus().emit("combat.steady.request", { casterId: bo, on: false });
    await until(() => numOf(`combat/${bo}.steady`) === 0, 3000, "let go");
  });

  it("ironhide: braced, a blow lands at 60%", async () => {
    await ready(ana);
    cast(ana, "ironhide");
    await until(() => numOf(`combat/${ana}.brace`) > nowS(), 3000, "braced");
    expect(numOf(`combat/${ana}.brace`)).toBeGreaterThan(nowS() + 5);
    const before = hp(ana);
    // magic and from nowhere warded: armour and guards are out of it, only the brace counts
    hit(ana, foe, "firebolt", 20, 0, side(ana), { kind: "magic", attackClass: "spell" });
    await settle();
    expect(before - hp(ana)).toBeCloseTo(12, 1);
  });

  it("bullrush: a five-metre charge that staggers what it hits", async () => {
    await ready(ana);
    await ready(foe);
    putAt(ana, side(foe, "front", 30));
    await settle();
    // the volume sits where the charge lands (5 m on), and reaches 2.4 m past it
    const [fx, fz] = xz(foe);
    const [ax, az] = xz(ana);
    const d = Math.hypot(fx - ax, fz - az);
    putAt(ana, [fx - ((fx - ax) / d) * 6, fz - ((fz - az) / d) * 6]);
    await settle();
    const before = hp(foe);
    cast(ana, "bullrush", aimAt(ana, foe));
    await until(() => hp(foe) < before, 3000, "the charge landed");
    expect(numOf(`combat/${foe}.staggerUntil`)).toBeGreaterThan(nowS());
  });

  it("aimed shot: a slow, strong physical shot", async () => {
    await ready(ana);
    await ready(foe);
    await placeLevel(ana, foe, 6);
    const seen = events("combat.damage").filter((e) => e.sourceId === ana && e.abilityId === "aimedShot").length;
    cast(ana, "aimedShot", aimAt(ana, foe));
    await until(() => events("combat.damage").filter((e) => e.sourceId === ana && e.abilityId === "aimedShot").length > seen, 4000, "aimed shot landed");
    expect(events("combat.damage").filter((e) => e.sourceId === ana && e.abilityId === "aimedShot").at(-1)).toMatchObject({
      targetId: foe,
      amount: 30,
      kind: "physical",
      attackClass: "ranged",
    });
  });

  it("venom blade: melee hits poison for 3 a second over 6 s, then it stops", async () => {
    await ready(ana);
    await ready(foe);
    cast(ana, "venomBlade");
    await until(() => numOf(`combat/${ana}.envenom`) > nowS() + 10, 3000, "envenomed");
    const ticks = () => events("combat.dot").filter((e) => e.targetId === foe && e.sourceId === ana);
    const seen = ticks().length;
    // a ranged hit carries nothing; a melee one does
    hit(foe, ana, "bowShot", 5, 0, side(foe), { attackClass: "ranged" });
    await settle();
    expect(numOf(`combat/${foe}.dot`)).toBeLessThanOrEqual(nowS());
    const before = hp(foe);
    hit(foe, ana, "strike", 5);
    await until(() => numOf(`combat/${foe}.dot`) > nowS(), 2000, "poisoned");
    await until(() => ticks().length >= seen + 6, 9000, "six ticks");
    await wait(1600);
    expect(ticks().length).toBe(seen + 6);
    expect(ticks().slice(seen).every((e) => e.amount === 3)).toBe(true);
    expect(before - hp(foe)).toBeCloseTo(5 + 18, 1);
    expect(numOf(`combat/${foe}.dot`)).toBe(0);
  });

  it("a poison ends with its victim", async () => {
    net().set(`combat/${ana}.envenom`, nowS() + 10); // still envenomed, whatever the last test used up
    const ticks = () => events("combat.dot").filter((e) => e.targetId === foe);
    hit(foe, ana, "strike", 1);
    await until(() => numOf(`combat/${foe}.dot`) > nowS(), 2000, "poisoned");
    net().set(`combat/${foe}.hp`, 4); // two ticks
    await until(() => net().get(`combat/${foe}.dead`) === true, 5000, "dead of it");
    const atDeath = ticks().length;
    await wait(2200);
    expect(ticks().length).toBe(atDeath);
    expect(numOf(`combat/${foe}.dot`)).toBe(0);
  });
});
