import { describe, expect, it } from "vitest";
import { hiddenFromAll, pickHiddenPoint, pickRoutePoint, pointOnRoute, populationOf, resolveSpawnArea, rollMix, spawnTable, type MixRow } from "../src/spawn-areas.js";

/** The pure halves of roaming spawn areas: the table, the roll, the spot. */

/** A seeded stream (mulberry32), so a distribution test is the same every run. */
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

describe("spawnArea defaults (backward compatible)", () => {
  it("an old pack area parses to placement pack and behaves as before", () => {
    const d = resolveSpawnArea({ spawns: [{ template: "boar", count: 3 }] });
    expect(d.placement).toBe("pack");
    expect(d.mix).toEqual([]);
    expect(d.leash).toBe(25);
    expect(d.roam).toBe(10);
    expect(d.spawns[0]!.spread).toBe(6);
    expect(d.temperament).toBeUndefined();
    expect(populationOf(d)).toBe(3);
  });

  it("population defaults by placement", () => {
    expect(populationOf(resolveSpawnArea({ placement: "anywhere", mix: [{ template: "a" }] }))).toBe(6);
    expect(populationOf(resolveSpawnArea({ placement: "anywhere", spawns: [{ template: "a", count: 2 }, { template: "b", count: 3 }] }))).toBe(5);
    expect(populationOf(resolveSpawnArea({ placement: "anywhere", population: 9, mix: [{ template: "a" }] }))).toBe(9);
    expect(populationOf(resolveSpawnArea({ placement: "route", patrol: [[0, 0, 0]], unique: true, population: 4, spawns: [{ template: "r" }] }))).toBe(1);
    expect(populationOf(resolveSpawnArea({ placement: "pack", spawns: [{ template: "a", count: 2 }], mix: [{ template: "b" }, { template: "c" }] }))).toBe(4);
  });

  it("the spawns become the table when there is no mix: weighted by count, one per roll", () => {
    const t = spawnTable(resolveSpawnArea({ placement: "anywhere", spawns: [{ template: "a", count: 3 }, { template: "b", count: 1 }] }));
    expect(t).toEqual([
      { template: "a", weight: 3, count: [1, 1], near: 4 },
      { template: "b", weight: 1, count: [1, 1], near: 4 },
    ]);
  });
});

describe("rollMix", () => {
  const table: MixRow[] = [
    { template: "deer", weight: 3, count: [1, 2], near: 4 },
    { template: "boar", weight: 1, count: [1, 1], near: 4 },
  ];

  it("draws rows by weight", () => {
    const rand = seeded(7);
    const n = { deer: 0, boar: 0 } as Record<string, number>;
    for (let i = 0; i < 4000; i++) n[rollMix(table, rand)!.row.template]!++;
    expect(n["deer"]! / 4000).toBeGreaterThan(0.7);
    expect(n["deer"]! / 4000).toBeLessThan(0.8);
  });

  it("rolls counts across [min, max], and clips to the cap", () => {
    const rand = seeded(3);
    const counts = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const r = rollMix(table, rand)!;
      if (r.row.template === "deer") counts.add(r.count);
      else expect(r.count).toBe(1);
    }
    expect([...counts].sort()).toEqual([1, 2]);
    for (let i = 0; i < 100; i++) expect(rollMix(table, rand, 1)!.count).toBe(1);
  });

  it("an empty or weightless table rolls nothing", () => {
    expect(rollMix([])).toBeNull();
  });
});

describe("anywhere placement", () => {
  const flat = (): number => 5;
  it("never picks a spot within hiddenFrom of any player, and stays inside the disc", () => {
    const rand = seeded(11);
    const players: Array<[number, number, number]> = [[0, 0, 0], [40, 0, 10]];
    for (let i = 0; i < 300; i++) {
      const p = pickHiddenPoint([0, 0, 0], 100, players, 30, flat, rand)!;
      expect(p).not.toBeNull();
      expect(hiddenFromAll(p[0], p[2], players, 30)).toBe(true);
      expect(Math.hypot(p[0], p[2])).toBeLessThanOrEqual(100);
      expect(p[1]).toBe(5);
    }
  });

  it("gives up (null) when the whole area is in sight, and skips ground that is not walkable", () => {
    expect(pickHiddenPoint([0, 0, 0], 20, [[0, 0, 0]], 60, flat, seeded(1))).toBeNull();
    // only the east half is ground
    const rand = seeded(5);
    for (let i = 0; i < 100; i++) {
      const p = pickHiddenPoint([0, 0, 0], 50, [], 0, (x) => (x > 0 ? 1 : null), rand);
      if (p) expect(p[0]).toBeGreaterThan(0);
    }
  });
});

describe("route placement", () => {
  const route: Array<[number, number, number]> = [[0, 0, 0], [100, 10, 0], [100, 10, 100]];
  it("finds the point a fraction of the way along, by length", () => {
    expect(pointOnRoute(route, 0)).toEqual([0, 0, 0]);
    expect(pointOnRoute(route, 0.25)).toEqual([50, 5, 0]);
    expect(pointOnRoute(route, 0.75)).toEqual([100, 10, 50]);
    expect(pointOnRoute(route, 1)).toEqual([100, 10, 100]);
  });

  it("spawns along the route, never in its first 10 %, out of sight", () => {
    const rand = seeded(9);
    const players: Array<[number, number, number]> = [[100, 0, 100]];
    for (let i = 0; i < 200; i++) {
      const p = pickRoutePoint(route, players, 40, (_x, _z, y) => y, rand)!;
      const along = p[2] > 0 ? 100 + p[2] : p[0];
      expect(along).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(Math.hypot(p[0] - 100, p[2] - 100)).toBeGreaterThanOrEqual(40);
    }
  });
});
