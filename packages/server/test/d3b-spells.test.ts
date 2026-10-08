import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { addItem, createSheet, equip, itemSchema, type CharacterSheet, type EntityDoc, type Item } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { serializeLoadout } from "../../../apps/playground/projects/voxel-demo/scripts/lib/combat-rules.js";
import { deriveLoadout } from "../../../apps/playground/projects/voxel-demo/scripts/lib/loadout.js";
import { eventLog } from "./event-log.js";

/**
 * Package D3b of voxel-demo's combat model (docs/combat-build/D3b-spells-twists.md),
 * over real sockets on the `field` scene with the game's scripts: one spell of
 * each school doing what it says, cast for real (frost slows, roots hold, a
 * curse ticks, a heal lands on the friend under the crosshair) plus a smite
 * on a marked body; then a TWISTED item: the same pyre staff twice, one
 * instance carrying "of the Leech" on its basic bolt. The twisted copy's bolt
 * heals its caster where the hit resolves; the plain copy's does not; and a
 * twisted skill the body's items do not give is refused. The crit roll is
 * pinned to "never".
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const ITEMS = path.join(playground, "projects/voxel-demo/assets/items");
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
  console.warn("d3b spells test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

describe.skipIf(!layer)("D3b: spells of every school and a twisted item, cast for real", { timeout: 120_000 }, () => {
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
  const accepted = (caster: string, ability: string) => events("combat.cast.accepted").filter((e) => e.casterId === caster && e.abilityId === ability);

  let ana = "";
  let bo = "";
  const foe = "foe";
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

  it("sets up: two players and a body that does nothing of its own", async () => {
    ana = await join("ana");
    bo = await join("bram");
    await until(() => hp(ana) > 0 && hp(bo) > 0, 10_000, "bars");
    y = world().objects.get(ana)!.position.y + 0.3;
    for (const h of ["hero0", "hero1", "hero2"]) net().set(`combat/${h}.dead`, true);
    const subtree = (): Record<string, EntityDoc> => {
      const out: Record<string, EntityDoc> = {};
      for (const id of ["hero0", "hero0-visual", "hero0-combat", "hero0-caster"]) out[id] = structuredClone(world().expanded.entities[id]!) // the authored doc: the server builds no drawing-only children;
      return out;
    };
    layer!.npcs.register("d3b-dummy", subtree());
    const [ax, az] = xz(ana);
    expect(layer!.npcs.spawn("d3b-dummy", [ax + 1.6, y, az], { id: foe })).not.toBeNull();
    await until(() => hp(foe) > 0, 10_000, "the dummy's bars");
    place(bo, -40, 0);
    await settle();
  });

  it("destruction (frost): a frost shard flies, plays its generated spell, hits and slows", async () => {
    await ready(foe);
    await ready(ana);
    await placeLevel(foe, ana, 6);
    const before = hp(foe);
    cast(ana, "frostShard", aimAt(ana, foe));
    await until(() => control("slow", foe).length > 0, 4000, "slowed");
    expect(hp(foe)).toBeLessThan(before);
    expect(numOf(`combat/${foe}.slow`)).toBeGreaterThan(nowS());
    // the generated spell (assets/spells/frost-shard.json) is what presents it
    expect(events("combat.spell").some((e) => e.abilityId === "frostShard" && e.phase === "cast")).toBe(true);
  });

  it("nature: entangling roots on a placed spot hold the body there", async () => {
    await ready(foe);
    await ready(ana);
    await placeLevel(foe, ana, 8);
    cast(ana, "entangle", aimAt(ana, foe), { target: xz(foe) });
    await until(() => control("root", foe).length > 0, 4000, "rooted");
    expect(numOf(`combat/${foe}.root`)).toBeGreaterThan(nowS() + 1.5);
    // applied on the body's next fixed step
    await until(() => world().objects.get(foe)!.userData["speedMult"] === 0, 1000, "held still");
  });

  it("shadow: agony is a damage over time — barely a hit, then a tick a second", async () => {
    await wait(2600); // the root lets go
    await ready(foe);
    await ready(ana);
    await placeLevel(foe, ana, 6);
    const seen = events("combat.dot").length;
    const before = hp(foe);
    cast(ana, "agony", aimAt(ana, foe));
    await until(() => numOf(`combat/${foe}.dot`) > nowS(), 4000, "cursed");
    await until(() => events("combat.dot").slice(seen).filter((e) => e.targetId === foe && e.sourceId === ana).length >= 2, 4000, "two ticks");
    const ticks = events("combat.dot").slice(seen).filter((e) => e.targetId === foe);
    expect(ticks[0]!.amount).toBe(6);
    expect(before - hp(foe)).toBeGreaterThanOrEqual(4 + 12 - 0.5);
    await wait(5000); // let it run out
  });

  it("holy: radiant mend heals the friend under the crosshair (the second player)", async () => {
    await ready(ana);
    await ready(bo);
    place(bo, 4, 0);
    await settle();
    net().set(`combat/${bo}.hp`, maxHp(bo) - 60);
    const seen = events("combat.healed").length;
    cast(ana, "radiantMend", aimAt(ana, bo), { targetId: bo });
    await until(() => events("combat.healed").slice(seen).some((e) => e.targetId === bo), 4000, "healed");
    expect(events("combat.healed").slice(seen).find((e) => e.targetId === bo)).toMatchObject({ sourceId: ana, amount: 45, abilityId: "radiantMend" });
    expect(hp(bo)).toBeCloseTo(maxHp(bo) - 15, 1);
    place(bo, -40, 0);
  });

  it("holy: a smite on a body your side marked lands half again as hard", async () => {
    await ready(foe);
    const hitIt = (): void => {
      const [fx, fz] = xz(foe);
      bus().emit("combat.damage", { targetId: foe, sourceId: ana, amount: 12, control: 5, point: [fx, y, fz], kind: "magic", attackClass: "spell", abilityId: "smite", element: "holy" });
    };
    let before = hp(foe);
    hitIt();
    await settle();
    const plain = before - hp(foe);
    net().set(`combat/${foe}.mark`, nowS() + 6);
    net().set(`combat/${foe}.markBy`, bo);
    before = hp(foe);
    hitIt();
    await settle();
    expect(before - hp(foe)).toBeCloseTo(plain * 1.5, 1);
  });

  // --- a twisted item ---------------------------------------------------------------
  const items: Record<string, Item> = {};
  const catalog = (id: string): Item | undefined => (items[id] ??= itemSchema.parse(JSON.parse(readFileSync(path.join(ITEMS, `${id}.json`), "utf8"))));
  /** A body holding a pyre staff whose instance carries `twists`, its bar derived as combat-loadout would. */
  const wield = (bodyId: string, twists: string[]): string => {
    const sheet: CharacterSheet = createSheet();
    for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
    const r = addItem(sheet, "pyre-staff", 1, { catalog });
    if (!r.ok) throw new Error(r.error);
    if (twists.length) r.sheet.items[r.uids[0]!]!.twists = twists;
    const e = equip(r.sheet, r.uids[0]!, "primary", { catalog });
    if (!e.ok) throw new Error(e.error);
    const loadout = deriveLoadout({ sheet: e.sheet, catalog, set: 0, trait: "" });
    net().set(`combat/${bodyId}.loadout`, serializeLoadout(loadout));
    return loadout.lmb;
  };

  it("a twisted pyre staff's bolt carries its twist (of the Leech) where the hit resolves; a plain copy's does not", async () => {
    expect(wield(ana, ["emberBolt+leech"])).toBe("emberBolt+leech");
    expect(wield(bo, [])).toBe("emberBolt");
    await ready(foe);
    await ready(ana);
    await placeLevel(foe, ana, 6);
    net().set(`combat/${ana}.hp`, maxHp(ana) - 40);
    let seen = events("combat.healed").length;
    const dmgSeen = events("combat.damage").length;
    const foeBefore = hp(foe);
    cast(ana, "emberBolt+leech", aimAt(ana, foe));
    await until(() => events("combat.healed").slice(seen).some((e) => e.targetId === ana && e.abilityId === "emberBolt+leech"), 4000, "the leech's heal");
    // what landed (after the arc, the burn's x1.25 and armour): the first burn tick is a second away
    const landed = foeBefore - hp(foe);
    const blow = events("combat.damage").slice(dmgSeen).find((e) => e.targetId === foe && e.abilityId === "emberBolt+leech");
    expect(blow).toBeDefined();
    const healed = events("combat.healed").slice(seen).find((e) => e.targetId === ana)!;
    expect(healed.amount as number).toBeGreaterThan(0);
    expect(healed.amount as number).toBeCloseTo(0.15 * landed, 1);
    // the base still does what it did: the burn
    expect(numOf(`combat/${foe}.dot`)).toBeGreaterThan(nowS());

    // the second copy of the same staff, without the twist
    await wait(6200);
    await ready(foe);
    await ready(bo);
    await placeLevel(bo, foe, 6);
    net().set(`combat/${bo}.hp`, maxHp(bo) - 40);
    seen = events("combat.healed").length;
    const before = hp(foe);
    cast(bo, "emberBolt", aimAt(bo, foe));
    await until(() => hp(foe) < before, 4000, "the plain bolt lands");
    await settle();
    expect(events("combat.healed").slice(seen).filter((e) => e.targetId === bo)).toEqual([]);
    expect(hp(bo)).toBeCloseTo(maxHp(bo) - 40, 1);
  });

  it("a twisted skill the body's own items do not give is refused (no cost, nothing cast)", async () => {
    await wait(1500);
    await ready(bo);
    const mana = numOf(`combat/${bo}.mana`);
    cast(bo, "emberBolt+leech", aimAt(bo, foe));
    cast(bo, "emberBolt+breaker", aimAt(bo, foe));
    await settle();
    expect(accepted(bo, "emberBolt+leech")).toEqual([]);
    expect(accepted(bo, "emberBolt+breaker")).toEqual([]);
    expect(numOf(`combat/${bo}.mana`)).toBe(mana);
  });
});
