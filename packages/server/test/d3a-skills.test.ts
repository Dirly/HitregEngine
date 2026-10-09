import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import type { EntityDoc } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { arcOf } from "../../../apps/playground/projects/foundation/scripts/lib/combat-rules.js";
import { eventLog } from "./event-log.js";

/**
 * Package D3a of the foundation's combat model (docs/combat-build/D3a-skill-library.md):
 * the wider grammar applied where a hit lands (combat-actor) and the new ways
 * to land (combat-caster), over real sockets on the `field` scene with the
 * game's scripts. A representative dozen-and-a-bit of the roster, every new
 * payoff at least once:
 *
 *   shatterWard  wardbreaker on a warded body           stealWard  spirit rend
 *   knockback    shield shove (a real cast)             pull       chain hook (a real thrown hook)
 *   slow, root   hamstring from behind                  silence    garrote from behind
 *   cooldownReset finishing cut on a body near death    lifesteal  vampiric strike
 *   chain        ricochet knife                         detonate   venom rupture on a burning body
 *   haste        sprint (a real cast)
 *
 * and the movement family for real: a charge that stops at the first body and
 * pays its after-charge stagger, a backstep, a blink (and one refused through
 * a wall), a step-behind. The crit roll is pinned to "never".
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
  console.warn("d3a skills test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

type Side = "front" | "rear";

describe.skipIf(!layer)("D3a skills: the wider grammar and the movement family", { timeout: 120_000 }, () => {
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
  const maxHp = (id: string) => numOf(`combat/${id}.maxHp`);
  const mana = (id: string) => numOf(`combat/${id}.mana`);
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
  const dist = (a: string, b: string): number => {
    const [ax, az] = xz(a);
    const [bx, bz] = xz(b);
    return Math.hypot(bx - ax, bz - az);
  };
  const side = (id: string, s: Side = "front"): [number, number] => {
    const o = world().objects.get(id)!;
    const [x, z] = xz(id);
    const f = { x: Math.sin(o.rotation.y), z: Math.cos(o.rotation.y) };
    const k = s === "front" ? 2 : -2;
    return [x + f.x * k, z + f.z * k];
  };
  /** A blow as an ability's hit would arrive; the actor resolves its skill from `abilityId`. */
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
    await until(() => numOf(`combat/${id}.staggerUntil`) < nowS(), 6000, `${id} standing`);
    await until(() => numOf(`combat/${id}.castingUntil`) === 0 && net().get(`cast/${id}`) === undefined, 6000, `${id} not casting`);
    net().set(`combat/${id}.hp`, numOf(`combat/${id}.maxHp`));
    net().set(`combat/${id}.mana`, numOf(`combat/${id}.maxMana`));
    net().set(`combat/${id}.stamina`, numOf(`combat/${id}.maxStamina`));
    net().set(`combat/${id}.stability`, numOf(`combat/${id}.maxStability`));
    for (const k of ["slow", "root", "haste", "mark", "dot", "riposte", "wardPerfect"]) net().set(`combat/${id}.${k}`, 0);
    for (const s of ["destruction", "nature", "holy", "shadow"]) net().set(`combat/${id}.lock.${s}`, 0);
    await wait(700);
  };
  const control = (what: string, target: string) => events("combat.control").filter((e) => e.what === what && e.targetId === target);
  const loadout = (id: string, guard: Record<string, unknown> | null): void => {
    net().set(`combat/${id}.loadout`, guard ? JSON.stringify({ set: 0, lmb: "", rmb: "@ward", weapon1: "", weapon2: "", trinket1: "", trinket2: "", trait: "", consumables: [], guard }) : "");
  };

  let ana = "";
  let bo = "";
  const foe = "foe";
  const brute = "brute";
  let y = 0;
  /** Put `id` `d` metres from `of` on ground level with it (the field is hilly; shots fly level). */
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
  const place = (id: string, dx: number, dz: number): void => {
    const [ax, az] = xz(ana);
    world().sim.setPosition(id, [ax + dx, y, az + dz]);
  };

  it("sets up: two players and two bodies that do nothing of their own", async () => {
    ana = await join("ana");
    bo = await join("bram");
    await until(() => hp(ana) > 0 && hp(bo) > 0, 10_000, "bars");
    y = world().objects.get(ana)!.position.y + 0.3;
    // the field's fighting heroes lie down: nothing stray lands inside a measurement
    for (const h of ["hero0", "hero1", "hero2"]) net().set(`combat/${h}.dead`, true);
    const subtree = (): Record<string, EntityDoc> => {
      const out: Record<string, EntityDoc> = {};
      for (const id of ["hero0", "hero0-visual", "hero0-combat", "hero0-caster"]) out[id] = structuredClone(world().expanded.entities[id]!) // the authored doc: the server builds no drawing-only children;
      return out;
    };
    layer!.npcs.register("d3a-dummy", subtree());
    const [ax, az] = xz(ana);
    expect(layer!.npcs.spawn("d3a-dummy", [ax + 1.6, y, az], { id: foe })).not.toBeNull();
    expect(layer!.npcs.spawn("d3a-dummy", [ax + 1.6, y, az + 30], { id: brute })).not.toBeNull();
    await until(() => hp(foe) > 0 && hp(brute) > 0, 10_000, "test bodies' bars");
    place(bo, -40, 0);
    await settle();
  });

  it("wardbreaker shatters a raised ward, hits harder, and keeps it down", async () => {
    await ready(foe);
    place(foe, 1.6, 0);
    loadout(foe, { kind: "ward", school: "holy" });
    await settle();
    bus().emit("combat.guard.request", { casterId: foe, on: true });
    await until(() => numOf(`combat/${foe}.guard`) > 0, 3000, "ward up");
    const before = hp(foe);
    hit(foe, ana, "wardbreaker", 11, 10);
    await settle();
    expect(numOf(`combat/${foe}.guard`)).toBe(0);
    expect(hp(foe)).toBeCloseTo(before - 11 * 1.3, 1);
    expect(control("shatter", foe).length).toBeGreaterThan(0);
    // shattered for 3 s: it cannot be raised again yet
    bus().emit("combat.guard.request", { casterId: foe, on: false });
    bus().emit("combat.guard.request", { casterId: foe, on: true });
    await settle();
    expect(numOf(`combat/${foe}.guard`)).toBe(0);
    // on a body with no ward it is a plain hit
    const plain = hp(foe);
    hit(foe, ana, "wardbreaker", 11, 10);
    await settle();
    expect(hp(foe)).toBeCloseTo(plain - 11, 1);
  });

  it("spirit rend breaks a ward and takes its mana", async () => {
    await wait(3000); // past the shatter
    await ready(foe);
    await ready(ana);
    bus().emit("combat.guard.request", { casterId: foe, on: true });
    await until(() => numOf(`combat/${foe}.guard`) > 0, 3000, "ward up");
    net().set(`combat/${foe}.mana`, 100);
    net().set(`combat/${ana}.mana`, 20);
    hit(foe, ana, "spiritRend", 9, 6);
    await settle();
    expect(numOf(`combat/${foe}.guard`)).toBe(0);
    expect(mana(foe)).toBeLessThanOrEqual(78); // 25 taken (and the held ward's drain)
    expect(mana(ana)).toBeGreaterThanOrEqual(44);
    expect(control("steal", foe).at(-1)).toMatchObject({ sourceId: ana, amount: 25 });
    bus().emit("combat.guard.request", { casterId: foe, on: false });
    loadout(foe, null);
  });

  it("shield shove (a real cast) knocks what is in front back and slows it", async () => {
    await ready(foe);
    await ready(ana);
    place(foe, 1.6, 0);
    await settle();
    const gap = dist(ana, foe);
    cast(ana, "shieldShove", aimAt(ana, foe));
    await until(() => control("knockback", foe).length > 0, 3000, "shoved");
    await wait(500);
    expect(dist(ana, foe)).toBeGreaterThan(gap + 2.5);
    expect(numOf(`combat/${foe}.slow`)).toBeGreaterThan(nowS());
  });

  it("chain hook (a real thrown hook) drags its catch to the thrower, and no closer than the stop", async () => {
    await ready(foe);
    await ready(ana);
    await placeLevel(foe, ana, 8);
    cast(ana, "chainHook", aimAt(ana, foe));
    await until(() => control("pull", foe).length > 0, 3000, "pulled");
    await wait(500);
    const d = dist(ana, foe);
    expect(d).toBeLessThan(5);
    expect(d).toBeGreaterThan(1.2);
  });

  it("hamstring slows from the front; from behind it roots, and a rooted body does not move", async () => {
    await ready(foe);
    hit(foe, ana, "hamstring", 7, 6, side(foe, "front"));
    await settle();
    expect(numOf(`combat/${foe}.slow`)).toBeGreaterThan(nowS() + 3);
    expect(numOf(`combat/${foe}.root`)).toBe(0);
    hit(foe, ana, "hamstring", 7, 6, side(foe, "rear"));
    await settle();
    expect(numOf(`combat/${foe}.root`)).toBeGreaterThan(nowS() + 1);
    expect(world().objects.get(foe)!.userData["speedMult"]).toBe(0);
  });

  it("garrote from behind silences every school: no spell starts until it ends", async () => {
    await ready(foe);
    hit(foe, ana, "garrote", 6, 4, side(foe, "rear"));
    await settle();
    for (const s of ["destruction", "nature", "holy", "shadow"]) expect(numOf(`combat/${foe}.lock.${s}`)).toBeGreaterThan(nowS() + 2);
    expect((net().get(`badge/${foe}`) as Array<{ id: string }>).some((b) => b.id === "silence")).toBe(true);
    cast(foe, "meteor");
    await settle();
    expect(numOf(`combat/${foe}.castingUntil`)).toBe(0);
    // a physical swing is not a spell: it still goes
    cast(foe, "strike", [1, 0]);
    await until(() => events("combat.cast.accepted").some((e) => e.casterId === foe && e.abilityId === "strike"), 3000, "a swing while silenced");
    await wait(6200); // the garrote's bleed runs out before anything below measures health
  });

  it("finishing cut on a body near death hits x1.8 and is ready again at once", async () => {
    await ready(foe);
    await ready(ana);
    place(foe, 1.6, 0);
    await settle();
    // a healthy body: the cooldown stands
    cast(ana, "finishingCut", aimAt(ana, foe));
    await until(() => events("combat.cast.accepted").some((e) => e.casterId === ana && e.abilityId === "finishingCut"), 3000, "cut 1");
    await settle();
    expect(numOf(`cooldown/${ana}.finishingCut`)).toBeGreaterThan(nowS() + 5);
    // near death: x1.8 and the cooldown comes back
    await wait(1000);
    net().set(`combat/${foe}.hp`, maxHp(foe) * 0.3);
    const before = hp(foe);
    // the earlier cast's cooldown is still running on the authority, so this one is a hit as the blow lands
    hit(foe, ana, "finishingCut", 12, 6);
    await settle();
    expect(hp(foe)).toBeCloseTo(before - 12 * 1.8, 1);
    expect(numOf(`cooldown/${ana}.finishingCut`)).toBe(0);
  });

  it("vampiric strike heals the attacker for a share of what landed", async () => {
    await ready(foe);
    await ready(ana);
    net().set(`combat/${ana}.hp`, maxHp(ana) - 50);
    const seen = events("combat.healed").length;
    hit(foe, ana, "vampiricStrike", 10, 6);
    await until(() => events("combat.healed").slice(seen).some((e) => e.targetId === ana), 3000, "lifesteal");
    expect(events("combat.healed").slice(seen).find((e) => e.targetId === ana)!.amount).toBeCloseTo(4, 1);
  });

  it("a ricochet knife jumps to the next body within six metres at 60%, once", async () => {
    await ready(foe);
    await ready(brute);
    place(foe, 1.6, 0);
    place(brute, 1.6, 4);
    await settle();
    const before = hp(brute);
    hit(foe, ana, "ricochetKnife", 9, 4, side(foe), { attackClass: "ranged" });
    await settle();
    expect(hp(brute)).toBeCloseTo(before - 9 * 0.6, 1);
    expect(control("chain", foe).length).toBeGreaterThan(0);
    expect(control("chain", brute).length).toBe(0); // a jump never jumps again
    place(brute, 1.6, 30);
  });

  it("venom rupture sets off a burning body's poison for a burst, and ends it", async () => {
    await ready(foe);
    hit(foe, ana, "brandStrike", 9, 6); // dot 4 a second for 6 s
    await until(() => numOf(`combat/${foe}.dot`) > nowS(), 2000, "burning");
    await wait(1200); // a tick or so gone
    const before = hp(foe);
    hit(foe, ana, "venomRupture", 8, 6);
    await settle();
    const took = before - hp(foe);
    // 8 + 10 + what the poison had left (four or five ticks of 4)
    expect(took).toBeGreaterThanOrEqual(8 + 10 + 16 - 0.5);
    expect(took).toBeLessThanOrEqual(8 + 10 + 24 + 0.5);
    expect(numOf(`combat/${foe}.dot`)).toBe(0);
    expect(control("detonate", foe).length).toBeGreaterThan(0);
    const after = hp(foe);
    await wait(1300);
    expect(hp(foe)).toBeCloseTo(after, 1); // no tick after it
  });

  it("sprint (a real cast) speeds the caster up 40% for five seconds", async () => {
    await ready(ana);
    const base = world().objects.get(ana)!.userData["speedMult"] as number;
    cast(ana, "sprintBurst");
    await until(() => numOf(`combat/${ana}.haste`) > nowS(), 3000, "hasted");
    await wait(200);
    expect(world().objects.get(ana)!.userData["speedMult"] as number).toBeCloseTo(base * 1.4, 2);
  });

  it("shield charge (a real cast) runs at the first body in its path, stops in front of it and staggers it", async () => {
    await ready(foe);
    await ready(ana);
    await placeLevel(foe, ana, 8);
    const start = xz(ana);
    cast(ana, "shieldCharge", aimAt(ana, foe));
    await until(() => events("combat.damage").some((e) => e.sourceId === ana && e.targetId === foe && e.abilityId === "shieldCharge"), 4000, "charge lands");
    const dmg = events("combat.damage").filter((e) => e.sourceId === ana && e.abilityId === "shieldCharge").at(-1)!;
    expect(dmg["charged"] as number).toBeGreaterThanOrEqual(5);
    const [x, z] = xz(ana);
    expect(Math.hypot(x - start[0], z - start[1])).toBeGreaterThan(5);
    expect(numOf(`combat/${foe}.staggerUntil`)).toBeGreaterThan(nowS());
  });

  it("backstep (a real cast) hops the caster three and a half metres back", async () => {
    await ready(ana);
    await wait(300);
    const start = xz(ana);
    cast(ana, "backstep", [0, 1]); // aim +Z: the hop goes -Z
    await wait(700);
    const [x, z] = xz(ana);
    expect(start[1] - z).toBeGreaterThan(2.5);
    expect(Math.abs(x - start[0])).toBeLessThan(0.6);
  });

  it("blink (a real cast) puts the caster on the spot; through a wall it is refused and costs nothing", async () => {
    await ready(ana);
    const [ax, az] = xz(ana);
    cast(ana, "blink", [1, 0], { target: [ax + 6, az] });
    await until(() => Math.hypot(xz(ana)[0] - (ax + 6), xz(ana)[1] - az) < 0.8, 3000, "blinked");
    // a wall between: refused, the mana stays
    await ready(ana);
    const [bx, bz] = xz(ana);
    layer!.server.spawn({
      "d3a-wall": {
        name: "d3a wall",
        parent: null,
        tags: [],
        components: { transform: { position: [bx + 3, y + 1, bz], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, collider: { shape: "box", size: [0.4, 4, 6] } },
      } as unknown as EntityDoc,
    });
    await settle();
    const m = mana(ana);
    const accepted = events("combat.cast.accepted").filter((e) => e.casterId === ana && e.abilityId === "blink").length;
    cast(ana, "blink", [1, 0], { target: [bx + 6, bz] });
    await wait(600);
    expect(events("combat.cast.accepted").filter((e) => e.casterId === ana && e.abilityId === "blink").length).toBe(accepted);
    expect(mana(ana)).toBeGreaterThanOrEqual(m - 0.01);
    expect(Math.hypot(xz(ana)[0] - bx, xz(ana)[1] - bz)).toBeLessThan(0.8);
    layer!.server.despawn(["d3a-wall"]);
    await settle();
  });

  it("step behind (a real cast) puts the caster at the back of the enemy it names", async () => {
    await ready(ana);
    await ready(foe);
    await placeLevel(foe, ana, 6);
    cast(ana, "stepBehind", aimAt(ana, foe), { targetId: foe });
    await wait(700);
    const o = world().objects.get(foe)!;
    const f = { x: Math.sin(o.rotation.y), z: Math.cos(o.rotation.y) };
    const [fx, fz] = xz(foe);
    const [x, z] = xz(ana);
    // behind: the caster is on the side the foe's back faces
    expect((x - fx) * f.x + (z - fz) * f.z).toBeLessThan(-0.5);
    expect(arcOf({ x: fx, z: fz }, f, { x, z })).toBe("rear"); // where a backstab wants to be
    expect(Math.hypot(x - fx, z - fz)).toBeLessThan(2.2);
  });
});
