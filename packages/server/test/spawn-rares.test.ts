import { describe, expect, it } from "vitest";
import type { EntityDoc, SpawnRare } from "@hitreg/core";
import { SpawnAreaManager, rareKey, resolveSpawnArea, rollRare, type RareState } from "../src/spawn-areas.js";
import type { GameServer } from "../src/server.js";
import type { NpcManager, NpcRecord } from "../src/npcs.js";

/**
 * Placeholder rares (EverQuest placeholders): a rare is never just standing there. Every spawn and respawn of a
 * placeholder's slot rolls its chance; one alive at a time (per area, or per shared id); an optional lockout after it
 * dies; camp slots, roamers and route walkers alike. Driven on a stub server + NPC manager, tick by tick.
 */

/** A seeded stream (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rec = NpcRecord & { params: Record<string, unknown>; props?: Record<string, unknown> };

function harness(seed = 1) {
  const fixedDt = 1 / 60;
  const afterStep = new Set<() => void>();
  const state = new Map<string, unknown>();
  const positions = new Map<string, [number, number, number]>();
  const entities = new Map<string, EntityDoc>();
  const world = {
    tick: 0,
    fixedDt,
    entities,
    afterStep,
    netState: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v), delete: (k: string) => state.delete(k) },
    positionOf: (id: string) => positions.get(id) ?? null,
    sim: { setPosition: (id: string, p: [number, number, number]) => positions.set(id, p) },
  };
  const players = new Map([["p1", { disconnectedAt: null, bodyId: "body:p1" }]]);
  positions.set("body:p1", [0, 0, 0]);
  const server = { world, players, interestRadius: 0, terrain: null, paused: new Set<string>(), resumeRoot: () => true, pauseRoot: () => true };
  const known = new Set(["ph", "ph2", "rare", "rare2", "prefab:mobs/spider"]);
  const npcMap = new Map<string, Rec>();
  const npcs = {
    npcs: npcMap,
    respawnHook: null as ((r: NpcRecord) => boolean) | null,
    templateRoot: () => null,
    spawn(template: string, at: [number, number, number], o: { id?: string; yaw?: number; params?: Record<string, unknown>; props?: Record<string, unknown>; respawn?: boolean } = {}): Rec | null {
      if (!known.has(template)) return null;
      const id = o.id ?? `${template}#${npcMap.size}`;
      const rec: Rec = { id, template, ids: [id], spawnAt: at, yaw: o.yaw ?? 0, deadSince: null, authored: false, params: o.params ?? {}, ...(o.props ? { props: o.props } : {}), ...(o.respawn === false ? { noRespawn: true } : {}) };
      npcMap.set(id, rec);
      positions.set(id, at);
      return rec;
    },
    despawn(id: string): boolean {
      positions.delete(id);
      state.delete(`combat/${id}.dead`);
      return npcMap.delete(id);
    },
  };
  const mgr = new SpawnAreaManager(server as unknown as GameServer, npcs as unknown as NpcManager, { every: 1, settleSeconds: 0, random: seeded(seed) });
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      world.tick++;
      for (const f of afterStep) f();
    }
  };
  const add = (id: string, spawnArea: Record<string, unknown>, at: [number, number, number] = [0, 0, 0]) => {
    entities.set(id, { name: id, parent: null, tags: [], components: { transform: { position: at }, spawnArea } } as EntityDoc);
    positions.set(id, at);
    return mgr.adopt(id, entities.get(id)!)!;
  };
  const kill = (id: string) => state.set(`combat/${id}.dead`, true);
  /** NpcManager's in-place respawn of a dead pack member: the hook first, else back on its feet in place. */
  const respawnDue = (id: string): void => {
    const rec = npcMap.get(id)!;
    if (npcs.respawnHook?.(rec)) return;
    state.delete(`combat/${id}.dead`);
  };
  const tpl = (ids: readonly string[]) => ids.map((id) => npcMap.get(id)!.template);
  return { world, npcs, mgr, step, add, kill, respawnDue, tpl, npcMap, seconds: (s: number) => Math.round(s / fixedDt) };
}

const camp = (rares: unknown[], extra: Record<string, unknown> = {}) => ({ radius: 30, spawns: [{ template: "ph", count: 3, spread: 4 }], temperament: "passive", rares, ...extra });

describe("rollRare", () => {
  const r = (x: Partial<SpawnRare>): SpawnRare => ({ template: "rare", chance: 1, placeholders: [], lockout: [0, 0], ...x });
  const free: RareState = { alive: null, lockedUntil: 0, lockout: [0, 0] };
  it("chance 0 never, chance 1 always", () => {
    const rand = seeded(5);
    for (let i = 0; i < 500; i++) expect(rollRare([r({ chance: 0 })], "ph", () => undefined, 0, rand)).toBeNull();
    for (let i = 0; i < 500; i++) expect(rollRare([r({ chance: 1 })], "ph", () => undefined, 0, rand)?.template).toBe("rare");
  });
  it("only behind its placeholders; never while alive or locked out", () => {
    expect(rollRare([r({ placeholders: ["ph2"] })], "ph", () => undefined, 0)).toBeNull();
    expect(rollRare([r({ placeholders: ["ph2"] })], "ph2", () => undefined, 0)).not.toBeNull();
    expect(rollRare([r({})], "ph", () => ({ ...free, alive: "x" }), 0)).toBeNull();
    expect(rollRare([r({})], "ph", () => ({ ...free, lockedUntil: 100 }), 99)).toBeNull();
    expect(rollRare([r({})], "ph", () => ({ ...free, lockedUntil: 100 }), 100)).not.toBeNull();
  });
  it("a chance is a chance: ~0.2 of rolls", () => {
    const rand = seeded(11);
    let hits = 0;
    for (let i = 0; i < 4000; i++) if (rollRare([r({ chance: 0.2 })], "ph", () => free, 0, rand)) hits++;
    expect(hits / 4000).toBeGreaterThan(0.17);
    expect(hits / 4000).toBeLessThan(0.23);
  });
  it("the schema defaults: any placeholder, no lockout, empty list on old areas", () => {
    expect(resolveSpawnArea({ spawns: [{ template: "a" }] }).rares).toEqual([]);
    const d = resolveSpawnArea({ rares: [{ template: "r", chance: 0.1 }] });
    expect(d.rares[0]).toEqual({ template: "r", chance: 0.1, placeholders: [], lockout: [0, 0] });
    expect(rareKey("a", { template: "r" })).toBe("a/r");
    expect(rareKey("a", { template: "r", id: "z5-rare" })).toBe("z5-rare");
  });
});

describe("placeholder rares in a camp (pack)", () => {
  it("boot roll: chance 1 puts exactly one rare in a slot (one alive), the rest are placeholders", () => {
    const h = harness();
    const a = h.add("camp", camp([{ template: "rare", chance: 1, temperament: "hostile" }]));
    h.step();
    expect(a.npcIds.length).toBe(3);
    expect(h.tpl(a.npcIds).sort()).toEqual(["ph", "ph", "rare"]);
    const rare = h.npcMap.get(a.npcIds.find((id) => h.npcMap.get(id)!.template === "rare")!)!;
    // the slot's home/leash/roam, its own temperament (the passive slot's alertRadius 0 dropped)
    expect(rare.params["home"]).toEqual([0, 0, 0]);
    expect(rare.params["spawnArea"]).toBe("camp");
    expect(rare.params["temperament"]).toBe("hostile");
    expect(rare.params["alertRadius"]).toBeUndefined();
    expect(h.mgr.rares()).toEqual([{ key: "camp/rare", alive: rare.id, lockedFor: 0 }]);
  });

  it("boot roll: chance 0 never; and a mid chance is up on some boots and not others", () => {
    const h0 = harness();
    const a0 = h0.add("camp", camp([{ template: "rare", chance: 0 }]));
    h0.step();
    expect(h0.tpl(a0.npcIds)).toEqual(["ph", "ph", "ph"]);
    let up = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const h = harness(seed);
      const a = h.add("camp", camp([{ template: "rare", chance: 0.15 }]));
      h.step();
      if (h.tpl(a.npcIds).includes("rare")) up++;
    }
    expect(up).toBeGreaterThan(0);
    expect(up).toBeLessThan(40);
  });

  it("chance 0: a placeholder killed over and over never turns into the rare", () => {
    const h = harness();
    const a = h.add("camp", camp([{ template: "rare", chance: 0 }]));
    h.step();
    for (let i = 0; i < 200; i++) {
      const id = a.npcIds[i % 3]!;
      h.kill(id);
      h.step();
      h.respawnDue(id);
      h.step();
    }
    expect(h.tpl(a.npcIds)).toEqual(["ph", "ph", "ph"]);
  });

  it("kill the placeholder: its slot rolls (chance 1) and the rare takes the slot's spot; its death puts the placeholder back", () => {
    const h = harness();
    const a = h.add("camp", camp([{ template: "rare", chance: 0 }]));
    h.step();
    // raise the chance after boot: the next respawn rolls it
    a.data.rares[0]!.chance = 1;
    const ph = a.npcIds[1]!;
    const spot = h.npcMap.get(ph)!.spawnAt;
    h.kill(ph);
    h.step();
    h.respawnDue(ph);
    expect(h.npcMap.has(ph)).toBe(false);
    const rare = a.npcIds[1]!;
    expect(h.npcMap.get(rare)!.template).toBe("rare");
    expect(h.npcMap.get(rare)!.spawnAt).toEqual(spot);
    // a second placeholder dying while the rare is up just respawns (one alive)
    const other = a.npcIds[0]!;
    h.kill(other);
    h.step();
    h.respawnDue(other);
    expect(a.npcIds[0]).toBe(other);
    expect(h.tpl(a.npcIds).filter((t) => t === "rare").length).toBe(1);
    // the rare dies: once its respawn is due the slot rolls again (no lockout, chance 1 -> the rare again, in that slot)
    a.data.rares[0]!.chance = 0;
    h.kill(rare);
    h.step();
    expect(h.mgr.rareStates.get("camp/rare")!.alive).toBeNull(); // a corpse is not alive
    h.respawnDue(rare);
    expect(h.tpl(a.npcIds)).toEqual(["ph", "ph", "ph"]);
    expect(a.npcIds.length).toBe(3);
  });

  it("lockout: no slot rolls it again until its lockout after the death is over", () => {
    const h = harness();
    const a = h.add("camp", camp([{ template: "rare", chance: 1, lockout: [60, 60] }]));
    h.step();
    const rare = a.npcIds.find((id) => h.npcMap.get(id)!.template === "rare")!;
    h.kill(rare);
    h.step();
    h.respawnDue(rare);
    expect(h.tpl(a.npcIds)).toEqual(["ph", "ph", "ph"]); // locked: the slot went back to its placeholder
    const victim = a.npcIds[0]!;
    h.step(h.seconds(30));
    h.kill(victim);
    h.step();
    h.respawnDue(victim);
    expect(h.tpl(a.npcIds)).not.toContain("rare"); // still locked at 30 s
    h.step(h.seconds(31));
    h.kill(victim);
    h.step();
    h.respawnDue(victim);
    expect(h.tpl(a.npcIds).filter((t) => t === "rare").length).toBe(1); // 61 s after the death: rolled up again
  });

  it("placeholders: only the named rows' slots roll", () => {
    const h = harness();
    const a = h.add("camp", { radius: 30, spawns: [{ template: "ph", count: 2 }, { template: "ph2", count: 2 }], rares: [{ template: "rare", chance: 1, placeholders: ["ph2"] }] });
    h.step();
    const rare = a.npcIds.find((id) => h.npcMap.get(id)!.template === "rare")!;
    expect(a.npcIds.indexOf(rare)).toBeGreaterThanOrEqual(2); // one of the ph2 slots
  });

  it("a shared id is one creature across areas: one alive in total", () => {
    const h = harness();
    const a = h.add("a", camp([{ template: "rare", chance: 1, id: "zone-rare" }]));
    const b = h.add("b", camp([{ template: "rare", chance: 1, id: "zone-rare" }]), [10, 0, 0]);
    h.step();
    const all = [...a.npcIds, ...b.npcIds];
    expect(h.tpl(all).filter((t) => t === "rare").length).toBe(1);
    expect([...h.mgr.rareStates.keys()]).toEqual(["zone-rare"]);
  });

  it("a scene template named as a rare is held back: it never stands at its authored spot", () => {
    const h = harness();
    h.npcMap.set("rare", { id: "rare", template: "rare", ids: ["rare"], spawnAt: [5, 0, 5], yaw: 0, deadSince: null, authored: true, params: {} });
    h.add("camp", camp([{ template: "rare", chance: 0 }]));
    expect(h.npcMap.has("rare")).toBe(false);
  });

  it("prefab props reach the rare's spawn (level, hp)", () => {
    const h = harness();
    const a = h.add("camp", camp([{ template: "prefab:mobs/spider", chance: 1, props: { level: 8, maxHp: 640 } }]));
    h.step();
    const rare = h.npcMap.get(a.npcIds.find((id) => h.npcMap.get(id)!.template.startsWith("prefab:"))!)!;
    expect(rare.props).toEqual({ level: 8, maxHp: 640 });
  });
});

describe("placeholder rares among roamers and on a route", () => {
  it("anywhere: one roamer is the rare (its own home and roam); killed, the refill rolls again", () => {
    const h = harness();
    const a = h.add("meadow", { radius: 60, placement: "anywhere", hiddenFrom: 0, population: 4, respawn: [0, 0], roamRange: [20, 30], mix: [{ template: "ph", count: [1, 1], temperament: "passive" }], rares: [{ template: "rare", chance: 1, temperament: "territorial", territory: 12 }] });
    h.step(3);
    expect(a.npcIds.length).toBe(4);
    expect(h.tpl(a.npcIds).filter((t) => t === "rare").length).toBe(1);
    const rare = h.npcMap.get(a.npcIds.find((id) => h.npcMap.get(id)!.template === "rare")!)!;
    expect(rare.params["temperament"]).toBe("territorial");
    expect(rare.params["territory"]).toBe(12);
    expect(rare.params["alertRadius"]).toBeUndefined();
    expect(rare.params["roam"]).toBeGreaterThanOrEqual(20);
    expect(rare.noRespawn).toBe(true); // the area refills it, not the NPC manager
    // killed: corpse cleared, the slot refilled by a fresh roll (chance 1, no lockout -> the rare again, just one)
    h.kill(rare.id);
    h.step(3);
    expect(h.npcMap.has(rare.id)).toBe(false);
    expect(a.npcIds.length).toBe(4);
    expect(h.tpl(a.npcIds).filter((t) => t === "rare").length).toBe(1);
  });

  it("anywhere: chance 0 never, and a lockout keeps the refill a placeholder", () => {
    const h = harness();
    const a = h.add("meadow", { radius: 60, placement: "anywhere", hiddenFrom: 0, population: 3, respawn: [0, 0], mix: [{ template: "ph" }], rares: [{ template: "rare", chance: 1, lockout: [120, 120] }] });
    h.step(3);
    const rare = a.npcIds.find((id) => h.npcMap.get(id)!.template === "rare")!;
    h.kill(rare);
    h.step(3);
    expect(h.tpl(a.npcIds)).toEqual(["ph", "ph", "ph"]);
    const h0 = harness();
    const b = h0.add("meadow", { radius: 60, placement: "anywhere", hiddenFrom: 0, population: 3, respawn: [0, 0], mix: [{ template: "ph" }], rares: [{ template: "rare", chance: 0 }] });
    for (let i = 0; i < 50; i++) {
      h0.step(2);
      h0.kill(b.npcIds[0]!);
    }
    h0.step(2);
    expect(h0.tpl(b.npcIds)).not.toContain("rare");
  });

  it("route: a walker is the rare, on the route with its patrol", () => {
    const h = harness();
    const patrol = [[0, 0, 0], [40, 0, 0], [40, 0, 40]];
    const a = h.add("road", { radius: 100, placement: "route", hiddenFrom: 0, population: 2, patrol, respawn: [0, 0], spawns: [{ template: "ph", count: 1 }], rares: [{ template: "rare", chance: 1 }] });
    h.step(3);
    expect(a.npcIds.length).toBe(2);
    const rare = h.npcMap.get(a.npcIds.find((id) => h.npcMap.get(id)!.template === "rare")!)!;
    expect((rare.params["patrol"] as unknown[]).length).toBe(3);
    expect([1, -1]).toContain(rare.params["patrolDir"]);
  });

  it("the old wandering rare (route + unique, no rares) is unchanged: always its template, one alive", () => {
    const h = harness();
    const a = h.add("old", { radius: 100, placement: "route", unique: true, population: 5, hiddenFrom: 0, patrol: [[0, 0, 0], [50, 0, 0]], respawn: [0, 0], spawns: [{ template: "rare", count: 1 }] });
    h.step(3);
    expect(h.tpl(a.npcIds)).toEqual(["rare"]);
    expect(h.mgr.rareStates.size).toBe(0);
  });
});
