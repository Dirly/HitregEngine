import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { petsOf, readPet, readTarget, type CharacterSheet } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";

/**
 * the foundation's targets, support and pets (2026-10-07), over real sockets on
 * the melee-brawl scene with the game's scripts:
 *
 *   - target/<me>: a primary must be a foe and a secondary a friend
 *     (combat.target.request, judged by combat-caster); a hit landing makes
 *     its target the attacker's primary unless one was picked by hand, and a
 *     body hit with no primary takes its attacker;
 *   - a `mendShare` twist ("of Mending") heals the wielder's chosen friend;
 *   - a trinket's summon calls a pet from a mob prefab (npc.spawn with a
 *     prefab: template, never respawned), which fights its owner's primary;
 *     its kill is its owner's; it dies → its skill waits deathCooldown; the
 *     trinket coming off dismisses it.
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
  layer = await serve({ playground, scene: "melee-brawl", port: 0, host: "127.0.0.1", respawnSeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("targets-pets test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

describe.skipIf(!layer)("targets, support and pets", { timeout: 120_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients = new Map<string, RoomClient>();
  afterAll(async () => {
    for (const c of clients.values()) c.leave();
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
  const log = eventLog(() => bus());
  const events = (name: string) => log.payloads(name);
  const sheet = (id: string) => net().get(`character/${id}`) as CharacterSheet | undefined;
  const uidOf = (id: string, itemId: string): string | undefined => Object.entries(sheet(id)?.items ?? {}).find(([, s]) => s.itemId === itemId)?.[0];

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
    return until(() => spawned.length === 1, 10_000, `${peerId} spawn`).then(() => {
      clients.set(spawned[0]!, client);
      return spawned[0]!;
    });
  }
  /** A request from the body's own client, over its socket. */
  const ask = (bodyId: string, name: string, payload: Record<string, unknown>): void =>
    clients.get(bodyId)!.sendCommand({ t: "event", name, payload });
  const xz = (id: string): [number, number] => {
    const e = world().objects.get(id)!.matrixWorld.elements;
    return [e[12]!, e[14]!];
  };
  const hit = (targetId: string, sourceId: string, amount: number, abilityId = "cleave"): void => {
    const [x, z] = xz(sourceId);
    bus().emit("combat.damage", { targetId, sourceId, amount, control: 0, point: [0, 1, 0], kind: "physical", attackClass: "light", abilityId, from: [x, z] });
  };

  let ana = "";
  let bo = "";
  const foe = "skirmisher";

  it("joins two players and finds a foe", async () => {
    ana = await join("ana-peer");
    bo = await join("bo-peer");
    await until(() => !!sheet(ana) && !!sheet(bo) && hp(foe) > 0, 15_000, "sheets and the foe's bars");
    expect(net().get(`combat/${foe}.faction`)).not.toBe("player");
  });

  it("a primary must be a foe, a secondary a friend; null clears", async () => {
    ask(ana, "combat.target.request", { casterId: ana, primary: foe, manual: true, secondary: bo });
    await until(() => readTarget(net(), ana).primary === foe, 3000, "primary set");
    expect(readTarget(net(), ana)).toEqual({ primary: foe, manual: true, secondary: bo });
    // the wrong sides are refused, field by field
    ask(ana, "combat.target.request", { casterId: ana, primary: bo, secondary: foe });
    await wait(300);
    expect(readTarget(net(), ana)).toEqual({ primary: foe, manual: true, secondary: bo });
    // someone else's client may not choose for ana
    ask(bo, "combat.target.request", { casterId: ana, primary: null });
    await wait(300);
    expect(readTarget(net(), ana).primary).toBe(foe);
    ask(ana, "combat.target.request", { casterId: ana, primary: null, secondary: null });
    await until(() => readTarget(net(), ana).primary === undefined && readTarget(net(), ana).secondary === undefined, 3000, "cleared");
  });

  it("what you hit becomes your primary; what hits you does too when you have none; a hand pick holds", async () => {
    hit(foe, bo, 1);
    await until(() => readTarget(net(), bo).primary === foe, 3000, "bo's auto primary");
    expect(readTarget(net(), bo).manual).toBeUndefined();
    hit(ana, foe, 1);
    await until(() => readTarget(net(), ana).primary === foe, 3000, "ana takes her attacker");
    // a hand-picked primary is not replaced by hitting something else
    ask(bo, "combat.target.request", { casterId: bo, primary: foe, manual: true });
    await until(() => readTarget(net(), bo).manual === true, 3000, "manual");
    hit("warden", bo, 1);
    await wait(300);
    expect(readTarget(net(), bo).primary).toBe(foe);
  });

  it("a weapon of Mending heals the wielder's chosen friend", async () => {
    ask(ana, "combat.target.request", { casterId: ana, secondary: bo });
    await until(() => readTarget(net(), ana).secondary === bo, 3000, "bo chosen");
    net().set(`combat/${bo}.hp`, maxHp(bo) - 60);
    const seen = events("combat.healed").length;
    hit(foe, ana, 50, "cleave+mending");
    await until(() => events("combat.healed").slice(seen).some((e) => e.targetId === bo && e.sourceId === ana), 3000, "bo mended");
    const healed = events("combat.healed").slice(seen).find((e) => e.targetId === bo)!.amount as number;
    expect(healed).toBeGreaterThan(0);
    expect(healed).toBeLessThan(50 * 0.13);
  });

  it("a trinket's summon calls a pet that fights the owner's primary; its kill is the owner's", async () => {
    if (!uidOf(ana, "wolf-eye-charm")) bus().emit("inventory.give", { actorId: ana, itemId: "wolf-eye-charm", qty: 1 });
    await until(() => !!uidOf(ana, "wolf-eye-charm"), 4000, "the wolf charm given");
    const uid = uidOf(ana, "wolf-eye-charm");
    // the earlier blows put ana in combat, and gear does not change in combat
    const outOfCombat = (): void => void net().set(`transferLock/${ana}`, 0);
    outOfCombat();
    bus().emit("inventory.equip", { actorId: ana, uid, slot: "trinket" });
    await until(() => sheet(ana)?.equipment.trinket === uid, 8000, "charm worn").catch((e) => {
      throw new Error(`${(e as Error).message}: refused ${JSON.stringify(events("character.refused").filter((r) => r.actorId === ana))} equipment ${JSON.stringify(sheet(ana)?.equipment)}`);
    });
    await until(() => String(net().get(`combat/${ana}.loadout`) ?? "").includes("summonWolf"), 4000, "summon on the bar");
    bus().emit("combat.cast.request", { casterId: ana, abilityId: "summonWolf", aim: [1, 0] });
    await until(() => petsOf(net(), ana).some((id) => !!world().objects.get(id)), 10_000, "the wolf arrives");
    const wolf = petsOf(net(), ana)[0]!;
    expect(readPet(net(), wolf)).toMatchObject({ owner: ana, source: "summonWolf", stance: "assist", order: "follow" });
    await until(() => net().get(`combat/${wolf}.faction`) === "player", 5000, "on the player's side");

    // assist: the owner's primary is the pet's target (brought inside the pet's leash first)
    const [ax, az] = xz(ana);
    world().sim.setPosition(foe, [ax + 6, world().objects.get(ana)!.position.y + 0.5, az]);
    await wait(300);
    ask(ana, "combat.target.request", { casterId: ana, primary: foe, manual: true });
    await until(() => readTarget(net(), wolf).primary === foe, 8000, "the wolf goes for ana's target").catch((e) => {
      const [ax, az] = xz(ana);
      const [fx, fz] = xz(foe);
      const [wx, wz] = xz(wolf);
      throw new Error(`${(e as Error).message}: ana→foe ${Math.hypot(fx - ax, fz - az).toFixed(1)} m, ana→wolf ${Math.hypot(wx - ax, wz - az).toFixed(1)} m, ana's target ${JSON.stringify(readTarget(net(), ana))}, wolf ai ${JSON.stringify(layer!.npcs.list().find((r) => r.id === wolf)?.ai)}`);
    });

    // the pet's kill is its owner's
    const kills = events("combat.killed").length;
    net().set(`combat/${foe}.hp`, 5);
    hit(foe, wolf, 50, "mobBite");
    await until(() => events("combat.killed").slice(kills).some((e) => e.victimId === foe), 4000, "the foe dies");
    expect(events("combat.killed").slice(kills).find((e) => e.victimId === foe)!.killerId).toBe(ana);
  });

  it("a pet that dies puts its skill on the death cooldown; taking the trinket off dismisses a live one", async () => {
    const wolf = petsOf(net(), ana)[0]!;
    hit(wolf, "warden", 100_000, "cleave");
    await until(() => numOf(`cooldown/${ana}.summonWolf`) > nowS() + 30, 4000, "death cooldown");
    await until(() => !world().objects.get(wolf), 8000, "the corpse removed");

    // a fresh pet (the cooldown cleared by hand), then the trinket comes off
    bus().emit("combat.cooldown.set", { casterId: ana, abilityId: "summonWolf", until: 0 });
    await wait(1500);
    bus().emit("combat.cast.request", { casterId: ana, abilityId: "summonWolf", aim: [1, 0] });
    await until(() => petsOf(net(), ana).some((id) => !!world().objects.get(id)), 10_000, "a second wolf");
    const second = petsOf(net(), ana).find((id) => !!world().objects.get(id))!;
    net().set(`transferLock/${ana}`, 0);
    bus().emit("inventory.unequip", { actorId: ana, slot: "trinket" });
    await until(() => !world().objects.get(second) && petsOf(net(), ana).length === 0, 10_000, "dismissed with its trinket");
  });
});
