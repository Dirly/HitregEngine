import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";

/**
 * The defensive layer of voxel-demo's combat model (docs/combat-plan.md), over
 * real sockets, with the game's scripts on the `field` scene.
 *
 * This is the half of combat that cannot be checked by reading the code: guard,
 * parry and ward are all TIMING against the authority's clock, and the whole
 * point of resolving them server-side is that a client cannot talk its way into
 * a parry. So the test drives the same events a client would and reads the
 * authority's netState back. What each hit BECOMES is pinned without a server
 * in defence-rules.test.ts; this file proves the actor wires it up.
 *
 * The rules being pinned down (lib/defence.ts, scripts/combat-actor.ts):
 *   - a raised shield absorbs `blockPower` and charges stamina for it;
 *   - a guard raised inside `parryWindow` negates a melee blow ENTIRELY and
 *     staggers the attacker instead;
 *   - blocking with an empty bar breaks the guard: full damage AND a stagger;
 *   - re-raising never re-stamps; only a SHIELD blocks (no shield = a press
 *     that opens the parry window alone, drops itself, and has a recovery);
 *   - a shield or blade answers the FRONT only: a rear blow lands with a
 *     bonus, a flank blow lands plain;
 *   - a ward (from the loadout) is the magic guard, paid in mana, judged on
 *     the school wheel with the real staffs' schools (right / plain / wrong),
 *     and it covers every side; it can be thrown onto an ally; an NPC raises
 *     a guard through the same door;
 *   - there is no roll: the old i-frame key protects nothing.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
/** A real item's guard, as deriveLoadout copies it into the loadout. */
const itemGuard = (id: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(path.join(playground, "projects/voxel-demo/assets/items", `${id}.json`), "utf8")) as { skills: { guard: Record<string, unknown> } }).skills.guard;
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
// Every hit here is about something other than a crit: never roll one (package S's
// damage-stats.test.ts pins those through the same seam).
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

type Side = "front" | "flank" | "rear";
type Info = { kind?: "physical" | "magic"; attackClass?: string; from?: [number, number]; abilityId?: string; element?: string };

describe.skipIf(!layer)("guard, parry, ward and direction", { timeout: 60_000 }, () => {
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
  const nowS = () => layer!.world.timeMs / 1000;
  const numOf = (key: string): number => (net().get(key) as number) ?? 0;
  const hp = (id: string): number => numOf(`combat/${id}.hp`);
  const stamina = (id: string): number => numOf(`combat/${id}.stamina`);
  const mana = (id: string): number => numOf(`combat/${id}.mana`);
  const guard = (id: string): number => numOf(`combat/${id}.guard`);
  const heal = (id: string): void => {
    net().set(`combat/${id}.hp`, numOf(`combat/${id}.maxHp`));
  };
  /**
   * A point 2 m from `id` on the given side, read the way the actor reads it
   * (lib/combat.ts worldXZ + facing): the matrix for where, rotation.y for which way.
   */
  const side = (id: string, s: Side): [number, number] => {
    const o = layer!.world.objects.get(id)!;
    const e = o.matrixWorld.elements;
    const x = e[12]!;
    const z = e[14]!;
    // characters face local +Z (the controller's yaw is atan2(x, z) of its heading)
    const f = { x: Math.sin(o.rotation.y), z: Math.cos(o.rotation.y) };
    if (s === "front") return [x + f.x * 2, z + f.z * 2];
    if (s === "rear") return [x - f.x * 2, z - f.z * 2];
    return [x - f.z * 2, z + f.x * 2];
  };
  /** A sword blow from in front, unless told otherwise. */
  const melee = (target: string, s: Side = "front", attackClass = "light"): Info => ({
    kind: "physical",
    attackClass,
    from: side(target, s),
  });
  const spell = (target: string, abilityId = "firebolt", element = "destruction", s: Side = "front"): Info => ({
    kind: "magic",
    attackClass: "spell",
    from: side(target, s),
    abilityId,
    element,
  });
  const hit = (targetId: string, sourceId: string, amount: number, info: Info = melee(targetId), control = 0): void => {
    bus().emit("combat.damage", { targetId, sourceId, amount, control, point: [0, 1, 0], ...info });
  };
  const raise = (id: string, on: boolean, targetId?: string): void => {
    bus().emit("combat.guard.request", { casterId: id, on, ...(targetId ? { targetId } : {}) });
  };
  const loadout = (id: string, g: Record<string, unknown> | null): void => {
    net().set(
      `combat/${id}.loadout`,
      g ? JSON.stringify({ set: 0, lmb: "", rmb: "", heavy: "", trinket1: "", trinket2: "", trait: "", consumables: [], guard: g }) : "",
    );
  };
  // every delivered event of a name (./event-log.ts: never index into the 64-entry trace ring)
  type Defended = { actorId: string; outcome: string; absorbed: number; abilityId?: string; wardBy?: string; element?: string; reward?: string; verdict?: string };
  const log = eventLog(() => bus());
  const defends = () => log.payloads<Defended>("combat.defended");
  /** Wait for the sim to drain the event queue and apply the results. */
  const settle = () => wait(220);
  const standing = (id: string) => until(() => numOf(`combat/${id}.staggerUntil`) < nowS(), 6000, `${id} stagger over`);

  const body = "player:dana";
  /**
   * What `body` holds, as its stance list. On a real client weapon-stance
   * derives it from the equipped items; set here every step so the test does
   * not depend on the scene's starting kit. Blocking needs a shield.
   */
  let stance: string[] = ["SwordShield", "Sword"];
  layer?.world.beforeStep.add(() => {
    const obj = layer!.world.objects.get(body);
    if (obj) obj.userData["stance"] = stance;
  });

  it("takes a clean hit with no guard up", async () => {
    const a = join("dana");
    await until(() => a.spawned.length === 1, 10_000, "spawn");
    await until(() => hp(body) > 0, 10_000, "bars");
    // the attacker these hits name: authored NPCs start dormant and wake (ground first) once a player is near
    await until(() => !layer!.server.paused.has("hero0"), 10_000, "hero0 awake");
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
    expect(numOf("combat/hero0.staggerUntil")).toBeGreaterThan(nowS());
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
    heal(body);
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
    expect(numOf(`combat/${body}.staggerUntil`)).toBeGreaterThan(nowS());
    // and being staggered drops the guard, so you cannot turtle through it
    expect(guard(body)).toBe(0);
  });

  it("without a shield, the key is a timed parry: no block, a recovery, and a miss lands in full", async () => {
    stance = ["GreatSword", "TwoHanded"];
    await standing(body);
    net().set(`combat/${body}.stamina`, 100);
    // A press opens the window and it closes by itself, key held or not.
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "parry up");
    await until(() => guard(body) === 0, 3000, "parry closes itself");
    // Pressing again inside the recovery does nothing: no mashing a wall of windows.
    raise(body, true);
    await settle();
    expect(guard(body)).toBe(0);
    // Nothing up, nothing absorbed: the whole hit, and no "blocked" verdict.
    const beforeHp = hp(body);
    const seen = defends().length;
    hit(body, "hero0", 30);
    await settle();
    expect(hp(body)).toBe(beforeHp - 30);
    expect(defends().length).toBe(seen);
    // Past the recovery a press parries, as a shield's opening beat does.
    await wait(700);
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "parry up again");
    hit(body, "hero0", 60);
    await settle();
    expect(hp(body)).toBe(beforeHp - 30);
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "parried" });
    stance = ["SwordShield", "Sword"];
  });

  it("a guard answers the front only: a rear blow lands with the bonus, a flank blow lands plain", async () => {
    await standing(body);
    heal(body);
    net().set(`combat/${body}.stamina`, 100);
    await settle();
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "guard up");
    await wait(400); // a held block, not a parry
    const seen = defends().length;
    let before = hp(body);
    hit(body, "hero0", 20, melee(body, "rear"));
    await settle();
    expect(hp(body)).toBeCloseTo(before - 30, 1); // rearBonus 1.5, through the shield
    before = hp(body);
    hit(body, "hero0", 20, melee(body, "flank"));
    await settle();
    expect(hp(body)).toBeCloseTo(before - 20, 1);
    expect(defends().length).toBe(seen); // neither was defended
    expect(guard(body)).toBeGreaterThan(0); // and the shield is still up
    raise(body, false);
    await settle();
  });

  it("reads a hit that says nothing as a spell: a shield half-blocks it and never parries it", async () => {
    await until(() => stamina(body) > 60, 12_000, "stamina back");
    heal(body);
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "guard up");
    const before = hp(body);
    hit(body, "hero0", 50, {}); // an old emitter: no kind, class or from
    await settle();
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "blocked", absorbed: 17 });
    expect(hp(body)).toBeCloseTo(before - 33, 1);
    raise(body, false);
    await settle();
  });

  // the training staff's ward is HOLY (holy beats shadow; nature beats holy), reward mana
  const holy = itemGuard("training-staff");
  const wardFresh = async (): Promise<void> => {
    heal(body);
    net().set(`combat/${body}.mana`, 100);
    await settle();
    raise(body, true);
    await until(() => guard(body) > 0, 3000, "ward up");
  };
  const lower = async (): Promise<void> => {
    raise(body, false);
    await settle();
    await until(() => guard(body) === 0, 3000, "ward down");
  };

  it("the right ward (holy vs shadow): cancelled just in time and paid, absorbed for mana later, and a sword goes through", async () => {
    expect(holy).toMatchObject({ kind: "ward", school: "holy", reward: "mana" });
    loadout(body, holy);
    await wardFresh();
    let before = hp(body);
    hit(body, "hero0", 60, spell(body, "mobShadowBolt", "shadow"));
    await settle();
    expect(hp(body)).toBe(before);
    expect(defends().at(-1)).toMatchObject({
      actorId: body,
      outcome: "ward-perfect",
      abilityId: "mobShadowBolt",
      element: "shadow",
      verdict: "right",
      reward: "mana",
    });
    // the "mana" reward: the catch's 5 back plus 0.5 per point of the 60 cancelled, clamped to max (120)
    expect(mana(body)).toBeGreaterThan(115);
    expect(mana(body)).toBeLessThanOrEqual(120);
    await wait(400);
    const manaBefore = mana(body);
    hit(body, "hero0", 60, spell(body, "mobShadowBolt", "shadow"));
    await settle();
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "warded", absorbed: 40, verdict: "right" });
    expect(hp(body)).toBeCloseTo(before - 20, 1);
    expect(mana(body)).toBeLessThan(manaBefore - 20); // 40 x 0.6
    before = hp(body);
    const seen = defends().length;
    hit(body, "hero0", 25); // a sword
    await settle();
    expect(hp(body)).toBeCloseTo(before - 25, 1);
    expect(defends().slice(seen).filter((d) => d.actorId === body && !d.abilityId)).toEqual([]); // (a live hero's own cast may land meanwhile)
    await lower();
  });

  it("a plain ward (holy vs destruction): absorbs, a perfect catch cancels, but pays nothing", async () => {
    await wardFresh();
    const before = hp(body);
    const manaBefore = mana(body);
    hit(body, "hero0", 60, spell(body, "firebolt", "destruction"));
    await settle();
    expect(hp(body)).toBe(before);
    const d = defends().at(-1)!;
    expect(d).toMatchObject({ actorId: body, outcome: "ward-perfect", verdict: "plain" });
    expect(d.reward).toBeUndefined();
    expect(mana(body)).toBeLessThan(manaBefore); // the catch was paid, nothing came back
    await wait(400);
    hit(body, "hero0", 60, spell(body, "frostNova", "water")); // frost is destruction too
    await settle();
    expect(defends().at(-1)).toMatchObject({ outcome: "warded", absorbed: 40, verdict: "plain" });
    await lower();
  });

  it("the wrong ward hurts (holy vs nature): nothing absorbed, the spell lands harder, however well timed", async () => {
    await wardFresh();
    const before = hp(body);
    const manaBefore = mana(body);
    hit(body, "hero0", 60, spell(body, "mobBlight", "nature")); // inside the window, wrong school
    await settle();
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "ward-wrong", element: "nature", verdict: "wrong" });
    expect(defends().at(-1)!.reward).toBeUndefined();
    expect(hp(body)).toBeCloseTo(before - 75, 1); // x1.25
    expect(mana(body)).toBeLessThanOrEqual(manaBefore); // no refund; only the hold's drain
    await lower();
  });

  it("a ward covers every side: a spell from behind is warded with no rear bonus; a wrong ward keeps it", async () => {
    await wardFresh();
    await wait(400); // held, not perfect
    let before = hp(body);
    hit(body, "hero0", 60, spell(body, "mobShadowBolt", "shadow", "rear"));
    await settle();
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "warded", absorbed: 40 });
    expect(hp(body)).toBeCloseTo(before - 20, 1); // not 60 x 1.5 - 40
    before = hp(body);
    hit(body, "hero0", 40, spell(body, "firebolt", "destruction", "flank"));
    await settle();
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "warded", absorbed: 40 });
    expect(hp(body)).toBeCloseTo(before, 1);
    before = hp(body);
    hit(body, "hero0", 40, spell(body, "mobBlight", "nature", "rear"));
    await settle();
    expect(defends().at(-1)).toMatchObject({ actorId: body, outcome: "ward-wrong" });
    expect(hp(body)).toBeCloseTo(before - 40 * 1.5 * 1.25, 1);
    await lower();
    // with no ward up, a rear spell keeps its bonus as built
    heal(body);
    await settle();
    before = hp(body);
    hit(body, "hero0", 40, spell(body, "mobBlight", "nature", "rear"));
    await settle();
    expect(hp(body)).toBeCloseTo(before - 60, 1);
    loadout(body, null);
  });

  it("throws a ward onto a friend in range only with an ally-ward staff, paid by the thrower", async () => {
    const b = join("eve");
    await until(() => b.spawned.length === 1, 10_000, "eve spawn");
    const eve = b.spawned[0]!;
    await until(() => hp(eve) > 0, 10_000, "eve bars");
    const dana = layer!.world.objects.get(body)!.position;
    const place = (dx: number) => layer!.world.sim.setPosition(eve, [dana.x + dx, dana.y + 0.5, dana.z]);
    place(3);
    net().set(`combat/${body}.mana`, 100);
    await settle();

    // a plain ward staff cannot throw (the training staff)
    loadout(body, holy);
    await settle();
    raise(body, true, eve);
    await settle();
    expect(numOf(`combat/${eve}.ward`)).toBe(0);

    // nor can the right staff reach 30 m: the warden staff, a SHADOW ward that throws
    const warden = itemGuard("warden-staff");
    expect(warden).toMatchObject({ kind: "ward", wardAlly: true, school: "shadow" });
    loadout(body, { ...warden, reward: "power" });
    place(30);
    await settle();
    raise(body, true, eve);
    await settle();
    expect(numOf(`combat/${eve}.ward`)).toBe(0);

    // in range: the stamp lands on eve, credited to dana, and dana's own ward is down
    place(3);
    await settle();
    // mana regenerates at 7/s throughout, so each cost is read across one short step
    const beforeThrow = mana(body);
    raise(body, true, eve);
    await until(() => numOf(`combat/${eve}.ward`) > 0, 3000, "ward thrown");
    expect(mana(body)).toBeLessThan(beforeThrow - 4); // the throw costs 6
    expect(net().get(`combat/${eve}.wardBy`)).toBe(body);
    const eveHp = hp(eve);
    const eveMana = mana(eve);
    const beforeCatch = mana(body);
    // frost is destruction, and shadow beats destruction: the thrower's school is the RIGHT one
    hit(eve, "hero0", 50, spell(eve, "frostNova", "water", "rear"));
    await settle();
    expect(hp(eve)).toBe(eveHp);
    expect(defends().at(-1)).toMatchObject({
      actorId: eve,
      outcome: "ward-perfect",
      wardBy: body,
      abilityId: "frostNova",
      verdict: "right",
      reward: "power",
    });
    expect(mana(body)).toBeLessThan(beforeCatch - 3); // the catch (5) comes from the thrower...
    expect(mana(eve)).toBeGreaterThanOrEqual(eveMana); // ...never from the body it saved
    // ...and so does the reward: the "power" boost lands on the WARDER
    expect(numOf(`combat/${body}.power`)).toBe(1.25);
    expect(numOf(`combat/${body}.powerUntil`)).toBeGreaterThan(nowS() + 4);
    expect(numOf(`combat/${eve}.power`)).toBe(0);
    raise(body, true);
    await settle();
    expect(guard(body)).toBe(0); // one ward at a time
    // it lasts about a second, then the stamp clears
    await until(() => numOf(`combat/${eve}.ward`) === 0, 3000, "ward ends");
    loadout(body, null);
  });

  it("has no roll: the old i-frame key protects nothing", async () => {
    await standing(body);
    heal(body);
    const before = hp(body);
    net().set(`combat/${body}.invulnUntil`, nowS() + 5);
    hit(body, "hero0", 30);
    await settle();
    expect(hp(body)).toBe(before - 30);
  });

  it("an NPC raises a guard through the same door: a light is blocked, a heavy breaks it, and it never parries", async () => {
    const npc = "hero0";
    loadout(npc, { kind: "block" });
    await standing(npc);
    heal(npc);
    net().set(`combat/${npc}.stamina`, 100);
    await settle();
    raise(npc, true); // server-side, as a mob brain would
    await until(() => guard(npc) > 0, 3000, "npc guard up");
    // At once: inside what would be a player's parry window. A creature's raise
    // is a shield and nothing more (CREATURE_GUARD), so this is a block.
    let seen = defends().length;
    hit(npc, body, 40, melee(npc, "front", "light"));
    await until(() => defends().slice(seen).some((d) => d.actorId === npc), 3000, "npc light defended");
    expect(defends().slice(seen).find((d) => d.actorId === npc)).toMatchObject({ outcome: "blocked", absorbed: 34 });
    // A heavy beats it outright (docs/combat-plan.md): the blow lands in full and the NPC is staggered.
    if (guard(npc) === 0) raise(npc, true);
    await until(() => guard(npc) > 0, 3000, "npc guard up again");
    const before = hp(npc);
    seen = defends().length;
    hit(npc, body, 40, melee(npc, "front", "heavy"));
    await until(() => defends().slice(seen).some((d) => d.actorId === npc), 3000, "npc heavy defended");
    expect(defends().slice(seen).find((d) => d.actorId === npc)).toMatchObject({ outcome: "guard-broken" });
    await until(() => hp(npc) < before, 3000, "heavy landed");
    expect(hp(npc)).toBeCloseTo(before - 40, 1);
    expect(numOf(`combat/${npc}.staggerUntil`)).toBeGreaterThan(nowS());
    raise(npc, false);
    loadout(npc, null);
  });
});
