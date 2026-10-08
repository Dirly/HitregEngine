import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";

/**
 * voxel-demo package X1 (docs/combat-build/X1-downed-revive.md), over real
 * sockets on the `field` scene: a PLAYER at 0 health goes DOWN, not dead (no
 * blow lands on it, no heal either); it dies when it bleeds out (credited to
 * the player who downed it, even past the 10 s last-hit window), when it
 * releases (its owner only), or when an enemy player's finisher channel
 * completes (credited to the finisher; a landed blow on the finisher breaks it;
 * a friend is refused). The `revive` skill stands a downed friend up with 30 %
 * and the landing grace; it is refused on a standing friend, out of range and
 * on a dead body, and a blow on the caster stops it.
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
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", respawnSeconds: 0, reconnectGraceSeconds: 1, log: () => undefined });
} catch (error) {
  console.warn("X1 downed test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

describe.skipIf(!layer)("X1: downed, finisher and revive, over real sockets", { timeout: 120_000 }, () => {
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
  const log = eventLog(() => bus());
  const events = <T = Record<string, unknown>>(name: string) => log.payloads<T>(name);
  const now = () => world().timeMs / 1000;
  const downed = (id: string) => (net().get(`combat/${id}.downed`) as number | undefined) ?? 0;
  const dead = (id: string) => net().get(`combat/${id}.dead`) === true;
  const hp = (id: string) => net().get(`combat/${id}.hp`) as number;
  const maxHp = (id: string) => net().get(`combat/${id}.maxHp`) as number;
  const hit = (targetId: string, sourceId: string, amount: number): void => {
    bus().emit("combat.damage", { targetId, sourceId, amount, control: 0, point: [0, 1, 0] });
  };
  /** A request from a body's own client (meta.from = its peer). */
  const send = (fromBody: string, name: string, payload: Record<string, unknown>): void =>
    clients.get(fromBody)!.sendCommand({ t: "event", name, payload });
  const posOf = (id: string): [number, number, number] => {
    const e = world().objects.get(id)!.matrixWorld.elements;
    return [e[12]!, e[13]!, e[14]!];
  };
  let spawnAt: [number, number, number] = [0, 0, 0];
  const standAt = (id: string, dx: number, dz = 0): void => world().sim.setPosition(id, [spawnAt[0] + dx, spawnAt[1] + 1, spawnAt[2] + dz]);
  const killsOf = (victim: string) => events<{ victimId: string; killerId: string | null }>("combat.killed").filter((k) => k.victimId === victim);

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

  let ana = "";
  let bo = "";
  let cy = "";
  let dee = "";
  it("sets up: four players; ana and bo are PvP enemies, cy and dee are everyone's friends", async () => {
    ana = await join("ana");
    bo = await join("bram");
    cy = await join("cyd");
    dee = await join("dee");
    await until(() => [ana, bo, cy, dee].every((id) => typeof hp(id) === "number"), 5000, "bars");
    // the field's heroes fight on their own; out of the way (they still serve as an NPC source)
    for (const h of ["hero0", "hero1", "hero2"]) net().set(`combat/${h}.dead`, true);
    for (const id of [ana, bo]) bus().emit("combat.pvp.request", { casterId: id, on: true });
    await until(() => net().get(`combat/${ana}.pvp`) === true && net().get(`combat/${bo}.pvp`) === true, 3000, "pvp flags");
    spawnAt = posOf(ana);
    standAt(bo, 1.5);
    standAt(cy, 0, 1.5);
    standAt(dee, 0, -1.5);
    await wait(300);
  });

  it("a player at 0 health goes DOWN, not dead: no blow and no heal land on it; its owner releases (a stranger may not) and a creature's down is credited to the creature", async () => {
    hit(cy, "hero0", 100_000);
    await until(() => downed(cy) > 0, 3000, "cy down");
    expect(dead(cy)).toBe(false);
    expect(hp(cy)).toBe(0);
    expect(downed(cy) - now()).toBeGreaterThan(55); // DOWNED.bleedSeconds 60
    expect(net().get(`combat/${cy}.crawl`)).toBe(8);
    expect(events<{ victimId: string; byId: string | null }>("combat.downed").find((e) => e.victimId === cy)?.byId).toBe("hero0");
    // the badge every client's nameplate draws
    expect((net().get(`badge/${cy}`) as Array<{ id: string }>).some((b) => b.id === "downed")).toBe(true);
    hit(cy, "hero0", 100_000);
    hit(cy, ana, 100_000);
    bus().emit("combat.heal", { targetId: cy, sourceId: dee, amount: 500 });
    await wait(300);
    expect(hp(cy)).toBe(0);
    expect(dead(cy)).toBe(false);
    // a release request from somebody else's client is refused
    send(ana, "combat.release.request", { casterId: cy });
    await wait(400);
    expect(dead(cy)).toBe(false);
    send(cy, "combat.release.request", { casterId: cy });
    await until(() => dead(cy), 3000, "cy released");
    expect(downed(cy)).toBe(0);
    expect(killsOf(cy).at(-1)).toMatchObject({ killerId: "hero0", xp: 0 });
    expect((net().get(`badge/${cy}`) as Array<{ id: string }> | undefined)?.some((b) => b.id === "downed") ?? false).toBe(false);
  });

  it("bleeding out kills, credited to the PLAYER who downed it even past the 10 s last-hit window", async () => {
    hit(bo, ana, 100_000);
    await until(() => downed(bo) > 0, 3000, "bo down");
    expect(events<{ victimId: string; byId: string | null }>("combat.downed").filter((e) => e.victimId === bo).at(-1)?.byId).toBe(ana);
    await wait(10_500);
    expect(dead(bo)).toBe(false);
    net().set(`combat/${bo}.downed`, now() + 0.2); // the clock runs out now
    await until(() => dead(bo), 3000, "bo bled out");
    expect(killsOf(bo).at(-1)?.killerId).toBe(ana);
  });

  it("the finisher: a friend is refused; a landed blow breaks the channel; done, the victim dies credited to the finisher", async () => {
    // bo back up (the actor's own respawn, respawnSeconds 8), then down again by ana
    await until(() => !dead(bo), 15_000, "bo respawned");
    standAt(bo, 1.5);
    await wait(300);
    hit(bo, ana, 100_000);
    await until(() => downed(bo) > 0, 3000, "bo down again");
    // dee is nobody's enemy: no channel
    standAt(dee, 1.5, 1);
    await wait(200);
    send(dee, "combat.finish.request", { casterId: dee, targetId: bo });
    await wait(400);
    expect(net().get(`combat/${dee}.finishing`) ?? 0).toBe(0);
    // ana starts, takes a blow at 1 s: broken, bo still down
    send(ana, "combat.finish.request", { casterId: ana, targetId: bo });
    await until(() => typeof net().get(`combat/${ana}.finishing`) === "object", 3000, "finishing");
    expect((net().get(`cast/${ana}`) as { id?: string } | undefined)?.id).toBe("finish");
    await wait(1000);
    hit(ana, "hero0", 5);
    await until(() => net().get(`combat/${ana}.finishing`) === 0, 2000, "channel broken");
    await wait(1500);
    expect(dead(bo)).toBe(false);
    expect(downed(bo)).toBeGreaterThan(0);
    // again, uninterrupted
    send(ana, "combat.finish.request", { casterId: ana, targetId: bo });
    await until(() => dead(bo), 5000, "bo finished");
    expect(killsOf(bo).at(-1)?.killerId).toBe(ana);
  });

  it("revive: refused on a standing friend, out of range and on the dead; a blow on the caster stops it; done, the friend stands with 30 % and the grace", async () => {
    const cast = (caster: string, targetId: string): void =>
      send(caster, "combat.cast.request", { casterId: caster, abilityId: "revive", aim: [0, 1], targetId });
    const accepted = () => events<{ casterId: string; abilityId: string }>("combat.cast.accepted").filter((e) => e.abilityId === "revive").length;
    const resetCooldown = (id: string) => bus().emit("combat.cooldown.set", { casterId: id, abilityId: "revive", until: 0 });
    // cy back up and in reach of dee
    await until(() => !dead(cy), 15_000, "cy respawned");
    standAt(cy, 0, 1.5);
    standAt(dee, 0, -0.5);
    await wait(300);

    // a standing friend: nothing to revive
    let before = accepted();
    cast(dee, cy);
    await wait(500);
    expect(accepted()).toBe(before);
    // a dead body (bo, finished above, and an enemy of nobody's here): refused
    cast(dee, bo);
    await wait(500);
    expect(accepted()).toBe(before);

    hit(cy, "hero0", 100_000);
    await until(() => downed(cy) > 0, 3000, "cy down");
    // out of range
    standAt(dee, 0, -5);
    await wait(300);
    cast(dee, cy);
    await wait(500);
    expect(accepted()).toBe(before);

    // in range, then a blow on dee at 1 s: interrupted, cy still down
    standAt(dee, 0, -0.5);
    await wait(300);
    cast(dee, cy);
    await until(() => accepted() === before + 1, 3000, "revive accepted");
    await wait(1000);
    hit(dee, "hero0", 5);
    await until(() => events<{ targetId: string; abilityId: string }>("combat.interrupted").some((e) => e.targetId === dee && e.abilityId === "revive"), 2000, "revive interrupted");
    await wait(2500);
    expect(downed(cy)).toBeGreaterThan(0);

    // again, left alone: up with 30 % and a 2.5 s grace
    resetCooldown(dee);
    await wait(100);
    before = accepted();
    cast(dee, cy);
    await until(() => accepted() === before + 1, 3000, "revive accepted again");
    await until(() => downed(cy) === 0, 5000, "cy up");
    expect(dead(cy)).toBe(false);
    expect(hp(cy)).toBe(Math.round(maxHp(cy) * 0.3));
    expect((net().get(`landing/${cy}`) as number) - world().timeMs).toBeGreaterThan(1500);
    expect(events<{ targetId: string; sourceId: string }>("combat.revived").at(-1)).toEqual({ targetId: cy, sourceId: dee });
    // and the cooldown is the skill's
    expect((net().get(`cooldown/${dee}.revive`) as number) - now()).toBeGreaterThan(100);
  });
});
