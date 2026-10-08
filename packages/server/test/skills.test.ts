import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MOB_EVENTS } from "@hitreg/core";
import type { EntityDoc } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";

/**
 * Package D1 of voxel-demo's combat model (docs/combat-build/D1-skills.md):
 * the skill grammar's payoffs, applied by combat-actor where the hit lands,
 * over real sockets on the `field` scene with the game's scripts.
 *
 *   - a pummel on a casting body cancels the cast and locks its school; on a
 *     body that is not casting it is a plain light hit;
 *   - a creature (mob-brain + mob-combat-bridge) casting a spell is stopped
 *     the same way, and its brain is told;
 *   - a kidney punch gives stamina back only when the target was casting;
 *   - a parry opens a riposte: the next landed hit crits, once;
 *   - mend heals the ally under the crosshair, never an enemy (the caster
 *     instead), never above max;
 *   - taunt turns a creature off the player it was fighting;
 *   - a mark set by one player is cashed in by another (backstab crits).
 *
 * The crit roll is pinned to "never" (CombatActor.critRoll), so every crit
 * seen here is a forced one. Two test bodies are spawned through the NPC
 * manager from the scene's own hero0 subtree: `foe`, a caster with no brain
 * (nothing it does is its own idea), and `brute`, the same body with an
 * engine mob-brain that never walks.
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
  console.warn("skills test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

type Side = "front" | "rear";

describe.skipIf(!layer)("skills: interrupts, riposte, support verbs", { timeout: 90_000 }, () => {
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
  const stamina = (id: string) => numOf(`combat/${id}.stamina`);
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

  /** World XZ of a body (the matrix, as the actor reads it). */
  const xz = (id: string): [number, number] => {
    const e = world().objects.get(id)!.matrixWorld.elements;
    return [e[12]!, e[14]!];
  };
  /** A point 2 m from `id` on one side, as combat-actor judges arcs (characters face local +Z). */
  const side = (id: string, s: Side = "front"): [number, number] => {
    const o = world().objects.get(id)!;
    const [x, z] = xz(id);
    const f = { x: Math.sin(o.rotation.y), z: Math.cos(o.rotation.y) };
    const k = s === "front" ? 2 : -2;
    return [x + f.x * k, z + f.z * k];
  };
  /** A blow as an ability's hit would arrive: the actor resolves its skill from `abilityId`. */
  const hit = (targetId: string, sourceId: string, abilityId: string, amount: number, control = 0, from: [number, number] = side(targetId)): void => {
    bus().emit("combat.damage", { targetId, sourceId, amount, control, point: [0, 1, 0], kind: "physical", attackClass: "light", abilityId, from });
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
  /** Not casting, not on the floor, pools full. */
  const ready = async (id: string): Promise<void> => {
    await until(() => numOf(`combat/${id}.staggerUntil`) < nowS(), 6000, `${id} standing`);
    await until(() => numOf(`combat/${id}.castingUntil`) === 0 && net().get(`cast/${id}`) === undefined, 6000, `${id} not casting`);
    net().set(`combat/${id}.mana`, numOf(`combat/${id}.maxMana`));
    net().set(`combat/${id}.stamina`, numOf(`combat/${id}.maxStamina`));
    net().set(`combat/${id}.stability`, numOf(`combat/${id}.maxStability`));
    await wait(700); // past any recovery
  };
  const startCast = async (id: string, abilityId: string): Promise<void> => {
    await ready(id);
    cast(id, abilityId);
    await until(() => numOf(`combat/${id}.castingUntil`) > nowS(), 3000, `${id} casting ${abilityId}`);
  };

  let ana = "";
  let bo = "";
  const foe = "foe";
  const brute = "brute";
  let y = 0;
  const place = (id: string, dx: number, dz: number): void => {
    const [ax, az] = xz(ana);
    world().sim.setPosition(id, [ax + dx, y, az + dz]);
  };

  it("sets up: two players, a brainless caster and a creature that never walks", async () => {
    ana = await join("ana");
    bo = await join("bram");
    await until(() => hp(ana) > 0 && hp(bo) > 0, 10_000, "bars");
    y = world().objects.get(ana)!.position.y + 0.3;
    // the scene's hero0 subtree, as the NPC manager spawns any template
    const subtree = (withBrain: boolean): Record<string, EntityDoc> => {
      const out: Record<string, EntityDoc> = {};
      for (const id of ["hero0", "hero0-visual", "hero0-combat", "hero0-caster"]) out[id] = structuredClone(world().expanded.entities[id]!) // the authored doc: the server builds no drawing-only children;
      if (withBrain) {
        const brain = structuredClone(world().entities.get("hero0-brain")!);
        brain.components["script"] = {
          name: "mob-brain",
          params: { actor: "hero0", faction: "enemy", hostileTo: "player", aggroRange: 0, hearRadius: 0, attackInterval: 60, abilities: "mobClaw", leash: 500, roam: 0, speed: 0, roamSpeed: 0 },
        };
        out["hero0-brain"] = brain;
      }
      return out;
    };
    layer!.npcs.register("d1-caster", subtree(false));
    layer!.npcs.register("d1-brute", subtree(true));
    const [ax, az] = xz(ana);
    expect(layer!.npcs.spawn("d1-caster", [ax + 1.6, y, az], { id: foe })).not.toBeNull();
    expect(layer!.npcs.spawn("d1-brute", [ax - 5, y, az], { id: brute })).not.toBeNull();
    // the join between the brain and combat (the field scene has none of its own)
    layer!.server.spawn({
      "d1-bridge": {
        name: "d1 bridge",
        parent: null,
        tags: [],
        components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, script: { name: "mob-combat-bridge", params: {} } },
      } as EntityDoc,
    });
    await until(() => hp(foe) > 0 && hp(brute) > 0, 10_000, "test bodies' bars");
    place(bo, 0, 4);
    await settle();
  });

  it("pummel on a casting body cancels the cast and locks its school", async () => {
    place(foe, 1.6, 0);
    await ready(ana);
    await startCast(foe, "meteor"); // destruction, 1.2 s wind-up
    const before = hp(foe);
    const at = nowS();
    cast(ana, "pummel", aimAt(ana, foe)); // the real skill: request, volume, hit, payoff
    await until(() => events("combat.interrupted").some((e) => e.targetId === foe && e.sourceId === ana), 3000, "interrupted");
    const ev = events("combat.interrupted").filter((e) => e.targetId === foe).at(-1)!;
    expect(ev).toMatchObject({ abilityId: "meteor", school: "destruction" });
    expect(numOf(`combat/${foe}.lock.destruction`)).toBeCloseTo(at + 4, 0);
    expect(numOf(`combat/${foe}.castingUntil`)).toBe(0);
    expect(hp(foe)).toBeLessThan(before); // and the jab itself landed
  });

  it("pummel on a body that is not casting is a plain light hit", async () => {
    await ready(foe);
    const seen = events("combat.interrupted").length;
    const before = hp(foe);
    hit(foe, ana, "pummel", 5, 8);
    await settle();
    expect(hp(foe)).toBeCloseTo(before - 5, 1);
    expect(events("combat.interrupted").length).toBe(seen);
    for (const school of ["nature", "holy", "shadow"]) expect(numOf(`combat/${foe}.lock.${school}`)).toBe(0);
  });

  it("a creature casting a spell is interrupted through the same plumbing, and its brain is told", async () => {
    await ready(brute);
    bus().emit(MOB_EVENTS.attack, { mobId: brute, targetId: ana, distance: 5, abilityId: "mobShadowBolt", aim: [1, 0] }); // the bridge turns it into a cast
    await until(() => numOf(`combat/${brute}.castingUntil`) > nowS(), 3000, "creature casting");
    hit(brute, ana, "pummel", 5, 8, side(brute));
    await until(() => events("combat.interrupted").some((e) => e.targetId === brute), 3000, "creature interrupted");
    expect(events("combat.interrupted").filter((e) => e.targetId === brute).at(-1)).toMatchObject({ sourceId: ana, abilityId: "mobShadowBolt", school: "shadow" });
    expect(numOf(`combat/${brute}.lock.shadow`)).toBeGreaterThan(nowS() + 3);
    expect(events(MOB_EVENTS.interrupt).some((e) => e.mobId === brute && e.seconds === 0.5)).toBe(true);
  });

  it("kidney punch gives stamina back only when the target was casting", async () => {
    // not casting: a plain hit, nothing back
    await ready(foe);
    net().set(`combat/${ana}.stamina`, 40);
    net().set(`combat/${ana}.spentAt`, nowS()); // regen waits a second
    hit(foe, ana, "kidneyPunch", 9, 10);
    await settle();
    expect(stamina(ana)).toBeCloseTo(40, 0);
    // casting (nature: destruction is still locked from the pummel)
    await startCast(foe, "mobBlight");
    net().set(`combat/${ana}.stamina`, 40);
    net().set(`combat/${ana}.spentAt`, nowS());
    const seen = events("combat.interrupted").length;
    hit(foe, ana, "kidneyPunch", 9, 10);
    await settle();
    expect(stamina(ana)).toBeCloseTo(54, 0); // +14
    expect(events("combat.interrupted").slice(seen).some((e) => e.targetId === foe && e.school === "nature")).toBe(true);
  });

  it("a parry opens a riposte: the next landed hit crits, and only that one", async () => {
    await ready(ana);
    await ready(foe);
    net().set(`combat/${ana}.loadout`, JSON.stringify({ set: 0, lmb: "", rmb: "@parry", weapon1: "", weapon2: "", trinket1: "", trinket2: "", trait: "", consumables: [], guard: { kind: "parry" } }));
    await settle();
    bus().emit("combat.guard.request", { casterId: ana, on: true });
    await until(() => numOf(`combat/${ana}.guard`) > 0, 3000, "parry up");
    hit(ana, foe, "strike", 20, 0, side(ana, "front"));
    await until(() => events("combat.defended").some((e) => e.actorId === ana && e.outcome === "parried"), 3000, "parried");
    expect(numOf(`combat/${ana}.riposte`)).toBeGreaterThan(nowS() + 2);
    const crits = () => events("combat.crit").filter((e) => e.sourceId === ana && e.actorId === foe).length;
    const seen = crits();
    let before = hp(foe);
    hit(foe, ana, "strike", 10);
    await settle();
    expect(crits()).toBe(seen + 1);
    expect(hp(foe)).toBeCloseTo(before - 20, 1); // x2, a weapon crit
    expect(numOf(`combat/${ana}.riposte`)).toBe(0);
    before = hp(foe);
    hit(foe, ana, "strike", 10);
    await settle();
    expect(crits()).toBe(seen + 1); // not twice
    expect(hp(foe)).toBeCloseTo(before - 10, 1);
    net().set(`combat/${ana}.loadout`, "");
  });

  it("mend heals the ally under the crosshair, never above max", async () => {
    await ready(ana);
    place(bo, 0, 4);
    net().set(`combat/${bo}.hp`, maxHp(bo) - 100);
    const seen = events("combat.healed").length;
    cast(ana, "mend", [0, 1], { targetId: bo });
    await until(() => events("combat.healed").slice(seen).some((e) => e.targetId === bo), 3000, "bo healed");
    expect(events("combat.healed").slice(seen).find((e) => e.targetId === bo)).toMatchObject({ sourceId: ana, amount: 40, abilityId: "mend" });
    expect(hp(bo)).toBeLessThanOrEqual(maxHp(bo));
  });

  it("mend aimed at an enemy heals the caster instead, clamped to max", async () => {
    await ready(bo);
    net().set(`combat/${bo}.hp`, maxHp(bo) - 10);
    const foeHp = hp(foe);
    const seen = events("combat.healed").length;
    cast(bo, "mend", [1, 0], { targetId: foe });
    await until(() => events("combat.healed").length > seen, 3000, "a heal");
    const healed = events("combat.healed").slice(seen);
    expect(healed.some((e) => e.targetId === foe)).toBe(false);
    // 10 landed of the 40: the clamp. (hp itself is not compared to max: the
    // field's live hero0 may land a blow on bo inside this window.)
    expect(healed.find((e) => e.targetId === bo)).toMatchObject({ sourceId: bo, amount: 10 });
    expect(hp(bo)).toBeLessThanOrEqual(maxHp(bo));
    expect(hp(foe)).toBeLessThanOrEqual(foeHp);
  });

  it("taunt turns a creature off the player it was fighting", async () => {
    const brain = `${brute}/brain`;
    const ai = () => world().scripts.debugOf(brain) as { target: string; taunted: string } | undefined;
    await ready(brute);
    hit(brute, bo, "strike", 40); // bo earns the creature's attention
    await until(() => ai()?.target === bo, 5000, "brute on bo");
    await ready(ana);
    place(brute, -5, 0);
    cast(ana, "taunt");
    await until(() => ai()?.taunted === ana, 3000, "taunted");
    await until(() => ai()?.target === ana, 3000, "brute on ana");
    expect(events("combat.threat").some((e) => e.targetId === brute && e.sourceId === ana && e.taunt === 4)).toBe(true);
  });

  it("a mark set by one player is cashed in by another", async () => {
    await ready(ana);
    place(foe, 1.6, 0);
    await settle();
    cast(ana, "markTarget", aimAt(ana, foe)); // a thrown marker: the real projectile, no harm
    await until(() => numOf(`combat/${foe}.mark`) > nowS(), 3000, "marked");
    expect(net().get(`combat/${foe}.markBy`)).toBe(ana);
    expect(events("combat.marked").some((e) => e.targetId === foe && e.sourceId === ana)).toBe(true);
    const crits = (target: string) => events("combat.crit").filter((e) => e.sourceId === bo && e.actorId === target).length;
    const seen = crits(foe);
    hit(foe, bo, "backstab", 12); // from the front: only the mark can make it crit
    await settle();
    expect(crits(foe)).toBe(seen + 1);
    // an unmarked creature takes the same backstab plain
    const plain = crits(brute);
    hit(brute, bo, "backstab", 12, 0, side(brute));
    await settle();
    expect(crits(brute)).toBe(plain);
  });
});
