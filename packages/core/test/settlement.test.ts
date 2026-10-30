import { describe, expect, it } from "vitest";
import { WALKWAY_END_LIFT, DOCK, stiltHutReach, checkSettlement, needsClearedCover, planSettlement, routeCells, stiltFloorFree, stiltRoutes, walkwayPieces, WALKWAY_HUB_LIFT, WALKWAY_MIN_STRETCH, settlementDressingPlans, settlementSiteDressing, settlementSvg, settlementWorldOps, type SettlementCultureIn, type SettleGround } from "../src/index.js";

type V2 = [number, number];
// a fen at water 6: a big central isle and six hummocks ~90 m out, everything else 0.5 m under water
const isles: { c: V2; r: number }[] = [{ c: [0, 0], r: 24 }, ...Array.from({ length: 6 }, (_, i) => ({ c: [Math.cos(i * 1.047) * 90, Math.sin(i * 1.047) * 90] as V2, r: 15 }))];
const fen: SettleGround = {
  height: (x, z) => { let h = 5.5; for (const s of isles) { const d = Math.hypot(x - s.c[0], z - s.c[1]); if (d < s.r) h = Math.max(h, 6 + 0.8 * (1 - d / s.r)); } return h; },
  water: () => 6,
};
const frogkin: SettlementCultureIn = {
  id: "frogkin", scale: "human", cultures: ["frogkin"], ground: "hummock", minPadArea: 300, onePerPad: true,
  householdSpacing: [60, 150], clusterSpacing: [60, 150],
  dwelling: { kind: "prefab", props: ["frogkin/tent"], footprint: [4.8, 4.4] },
  household: [
    { role: "sleeping", props: ["frogkin/nest"], place: "side" },
    { role: "storage", props: ["frogkin/basket"], place: "back" },
    { role: "light", props: ["frogkin/lamp"], place: "door" },
    { role: "work", props: ["frogkin/trap"], count: 2, place: "water-edge" },
    { role: "boat", props: ["frogkin/raft"], place: "water-edge", faceGathering: true },
  ],
  gathering: { kind: "ring", ring: { props: ["frogkin/totem"], count: 7, radius: 8 }, head: ["frogkin/idol"], radius: 18 },
  work: [{ id: "fishing", where: "water-edge", props: ["frogkin/trap"], count: 3, radius: 6 }],
  paths: { kind: "ford", maxWade: 0.9 },
  creatures: { perCluster: 0, atGathering: 1, radius: 10 },
};

describe("settlement grammar: isle village (the Totem Isles)", () => {
  const plan = planSettlement({ id: "isles", culture: frogkin, households: 6, centre: [0, 0], radius: 130, seed: 3 }, fen);
  it("puts the gathering ring on the biggest isle and one household on each outer isle, all facing it", () => {
    expect(Math.hypot(...plan.gathering.at)).toBeLessThan(15);
    expect(plan.households).toHaveLength(6);
    expect(new Set(plan.households.map((h) => h.pad)).size).toBe(6);
    for (const h of plan.households) expect(Math.hypot(h.dwelling.at[0], h.dwelling.at[1])).toBeGreaterThan(60);
    expect(plan.gathering.items.filter((i) => i.role === "ring")).toHaveLength(7);
  });
  it("crosses the water by fords, clears cover under every dwelling and passes its check", () => {
    expect(plan.paths.some((p) => p.kind === "ford")).toBe(true);
    const r = checkSettlement(plan, frogkin, { households: 6 });
    expect(r.findings.filter((f) => f.code !== "tier-footprint")).toEqual([]);
    expect(r.ok).toBe(true);
    // boats and traps at the water edge
    for (const h of plan.households) { const boat = h.items.find((i) => i.role === "boat")!; expect(fen.height(...boat.at)).toBeLessThan(6.4); }
  });
  it("fails the grass rule when the world keeps cover under a dwelling, and an unreachable household", () => {
    const kept = plan.clearings.map((c) => ({ center: c.center, radius: c.radius, cover: !c.id.startsWith("h1-") }));
    const r = checkSettlement(plan, frogkin, { clearings: kept });
    expect(r.findings.some((f) => f.code === "cover-under-dwelling" && f.ref === "h1")).toBe(true);
    const cut = { ...plan, paths: plan.paths.filter((p) => p.to !== "c1" && p.from !== "c1") };
    expect(checkSettlement(cut, frogkin).findings.some((f) => f.code === "unreachable" && f.ref === "h1")).toBe(true);
  });
  it("writes dressing plans, a siteDressing block, cover-clearing world ops and a picture", () => {
    const plans = settlementDressingPlans(plan, frogkin, "isles");
    expect(plans.find((p) => p.id === "isles-h1")!.items.some((i) => i.prop === "frogkin/tent")).toBe(true);
    expect(settlementSiteDressing(plan, frogkin).areas.length).toBe(plan.areas.length);
    const ops = settlementWorldOps(plan, frogkin, "isles");
    expect(ops.clearings.every((c) => c.cover && c.scatter)).toBe(true);
    expect(ops.tracks).toEqual([]); // fords, not tracks
    expect(settlementSvg(plan)).toContain("<svg");
  });
});

describe("settlement grammar: camp round a fire on dry ground", () => {
  const plain: SettleGround = { height: (x, z) => 40 + x * 0.02 + z * 0.01, water: () => null };
  const ogre: SettlementCultureIn = {
    id: "ogre", scale: "ogre", cultures: ["ogre"], ground: "flat", householdSpacing: [9, 15], clusterSpacing: [30, 60],
    dwelling: { kind: "prefab", props: ["ogre/lodge-a", "ogre/lodge-b"], footprint: [8.6, 6.8] },
    household: [{ role: "sleeping", props: ["ogre/hides"], place: "side" }, { role: "storage", props: ["ogre/sack"], place: "back" }],
    gathering: { kind: "hearth", centre: ["ogre/bonfire"], radius: 10 },
    work: [{ id: "butchery", where: "downwind", props: ["ogre/spit"], radius: 8 }],
    paths: { kind: "track", width: 3 },
    defences: { props: ["ogre/pike"], count: 4 },
  };
  const plan = planSettlement({ id: "scrape", culture: ogre, households: 4, clusters: 1, centre: [0, 0], radius: 80, anchors: { approach: [0, -78] } }, plain);
  it("rings the lodges round the fire, doors in, the approach side open, butchery downwind, pikes across the approach", () => {
    expect(plan.households).toHaveLength(4);
    for (const h of plan.households) { const d = Math.hypot(h.dwelling.at[0] - plan.gathering.at[0], h.dwelling.at[1] - plan.gathering.at[1]); expect(d).toBeGreaterThan(7); expect(d).toBeLessThan(20); }
    expect(plan.work[0]!.at[0]).toBeGreaterThan(plan.gathering.at[0] + 20);
    // the fire stands on the gathering's hearth anchor (its 'H' clearance is the floor round it, not under it)
    const fire = settlementDressingPlans(plan, ogre, "scrape").find((p) => p.id === "scrape-gathering")!.items.find((i) => i.prop === "ogre/bonfire")!;
    expect(fire.place).toEqual({ kind: "anchor", anchor: "gathering/gathering-centre" });
    expect(settlementSiteDressing(plan, ogre).anchors.some((a) => a.id === "gathering-centre" && a.kind === "hearth")).toBe(true);
    // the pikes keep off the lodges (their footprints, 8.6 x 6.8 m) like any other thing
    for (const d of plan.defences) for (const h of plan.households) {
      const ya = (-h.dwelling.yaw * Math.PI) / 180, dx = d.at[0] - h.dwelling.at[0], dz = d.at[1] - h.dwelling.at[1];
      const lx = dx * Math.cos(ya) - dz * Math.sin(ya), lz = dx * Math.sin(ya) + dz * Math.cos(ya);
      expect(Math.abs(lx) > 4.3 || Math.abs(lz) > 3.4).toBe(true);
    }
    expect(plan.defences).toHaveLength(4);
    for (const d of plan.defences) expect(d.at[1]).toBeLessThan(plan.gathering.at[1]);
  });
  it("lays carved + painted tracks (never ribbons) and passes its check, with the tier's creature groups", () => {
    const ops = settlementWorldOps(plan, ogre, "scrape");
    expect(ops.tracks.length).toBeGreaterThan(0);
    expect(ops.tracks[0]).toMatchObject({ width: 3 });
    expect(ops.tracks[0]!.id).toMatch(/^road-settle-scrape-/);
    expect(() => settlementWorldOps(plan, { ...ogre, paths: { ...ogre.paths, kind: "ribbon" as never } }, "scrape")).toThrow(/ribbons were removed 2026-10-30/);
    const r = checkSettlement(plan, ogre, { households: 4, tier: { id: "small", minCreatureGroups: 1, footprintDiameterM: { min: 90, max: 150 } } });
    expect(r.findings.filter((f) => f.code !== "tier-footprint")).toEqual([]);
    expect(plan.clearings.some((c) => c.why === "fire")).toBe(true);
  });
});

describe("settlement grammar: stilt village (core, fringe, walkway network)", () => {
  // fen water at 6, bed at 5 (1 m deep) west of x=110; a dry bank east of it at deck height
  const marsh: SettleGround = { height: (x) => (x > 110 ? 7.5 : 5), water: (x) => (x > 110 ? null : 6) };
  const crockin: SettlementCultureIn = {
    id: "crockin", scale: "crockin", cultures: ["crocodile-kin"], ground: "stilt", householdSpacing: [4, 12], clusterSpacing: [6, 60],
    dwelling: { kind: "wfc", project: "kit", kit: "stilt", cell: [4, 3.5, 4], hutTiles: "^hut", block: [5, 5], communal: [4, 4], landings: 3, stops: 2, frames: ["frame"] },
    household: [{ role: "storage", props: ["croc/hamper"], place: "side" }, { role: "light", props: ["croc/torch"], place: "door" }],
    gathering: { kind: "deck", centre: ["croc/brazier"], radius: 9 },
    work: [{ id: "smoking", where: "water-edge", props: ["croc/rack"], count: 2, radius: 5 }, { id: "hatchery", where: "dry", props: ["croc/basin"], count: 2, radius: 8 }],
    paths: { kind: "walkway", width: 4 },
  };
  const plan = planSettlement({ id: "stilts", culture: crockin, households: 14, centre: [20, 0], radius: 110, seed: 2, anchors: { approach: [140, 0] } }, marsh);
  const s = plan.stilt!, at = new Map(s.cells.map((c) => [`${c.i},${c.j}`, c]));
  const g = plan.gathering.at, dist = (p: V2): number => Math.hypot(p[0] - g[0], p[1] - g[1]);
  it("lays a communal deck, compounds of 1-3 huts, landings and a link to the bank", () => {
    expect(s.deckY).toBe(7.5);
    expect(s.cells.filter((c) => c.kind === "communal")).toHaveLength(16);
    expect(plan.households).toHaveLength(14);
    for (const b of s.blocks) { expect(b.huts.length).toBeGreaterThanOrEqual(1); expect(b.huts.length).toBeLessThanOrEqual(3); }
    expect(new Set(s.blocks.map((b) => b.huts.length)).size).toBeGreaterThan(1); // compounds vary in size
    expect(s.cells.filter((c) => c.kind === "landing").length).toBeGreaterThanOrEqual(3);
    expect(s.dryLink).not.toBeNull();
    expect(plan.work.find((w) => w.id === "hatchery")!.at[0]).toBeGreaterThan(110);
  });
  it("has a core and a fringe: 60% of the households within the core radius, the rest outlying", () => {
    const near = plan.households.filter((h) => dist(h.dwelling.at) <= 60 + 8).length;
    expect(near / plan.households.length).toBeGreaterThanOrEqual(0.6);
    const fringe = s.blocks.filter((b) => dist(b.centre) > 60);
    expect(fringe.length).toBeGreaterThan(0);
    for (const b of fringe) expect(dist(b.centre)).toBeGreaterThan(65);
  });
  it("packs the core: decks edge to edge on two levels, under 15 m of boardwalk per core hut", () => {
    const len = (pts: V2[]): number => pts.slice(1).reduce((t, b, n) => t + Math.hypot(b[0] - pts[n]![0], b[1] - pts[n]![1]), 0);
    const coreHuts = plan.households.filter((h) => dist(h.dwelling.at) <= 60).length;
    const coreWalk = s.walks.filter((w) => w.points.length && w.points.every((p) => dist(p) <= 60)).reduce((t, w) => t + len(w.points), 0);
    expect(coreWalk / coreHuts).toBeLessThan(15);
    expect(s.walks.some((w) => !w.points.length)).toBe(true); // compounds sharing decks
    expect(new Set(s.blocks.map((b) => b.y)).size).toBe(2);
    const near = plan.households.map((h) => Math.min(...plan.households.filter((x) => x !== h).map((x) => Math.hypot(x.dwelling.at[0] - h.dwelling.at[0], x.dwelling.at[1] - h.dwelling.at[1])))).sort((x, y) => x - y);
    expect(near[near.length >> 1]).toBeLessThanOrEqual(8);
  });
  it("joins every deck with ONE walkway network: a tree from the gathering, organic legs round the decks, wide spine, narrow branches", () => {
    const adj = new Map<string, string[]>();
    for (const w of s.walks) { (adj.get(w.from) ?? adj.set(w.from, []).get(w.from)!).push(w.to); (adj.get(w.to) ?? adj.set(w.to, []).get(w.to)!).push(w.from); }
    const seen = new Set(["gathering"]), q = ["gathering"];
    while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    for (const b of s.blocks) expect(seen.has(b.id)).toBe(true);
    expect(seen.has("dry-link")).toBe(true);
    // no ring: about one leg per deck (a tree), a couple of loops at most
    const decks = s.blocks.length + 1 + new Set(s.walks.flatMap((w) => [w.from, w.to]).filter((n) => n.startsWith("stop-") || n === "smoking")).size;
    expect(s.walks.length).toBeLessThanOrEqual(decks + 2);
    // a stop platform or work deck stands on the network between homes
    expect(s.walks.some((w) => /^stop-|^smoking$/.test(w.from) || /^stop-|^smoking$/.test(w.to))).toBe(true);
    // widths: the spine wide, the branches narrow
    expect(s.walks.some((w) => w.width === 2.6 && w.main)).toBe(true);
    expect(s.walks.some((w) => w.width === 1.6 && !w.main)).toBe(true);
    // legs run at free angles (not a grid of straight cell runs)
    const segs = s.walks.flatMap((w) => w.points.slice(1).map((b, n) => [w.points[n]!, b] as const));
    expect(segs.some(([a, b]) => { const t = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; return Math.abs(t - Math.round(t / 90) * 90) > 8; })).toBe(true);
    // no leg crosses a deck: every sample off its two end ports stands outside every deck cell
    for (const w of s.walks) for (const [a, b] of w.points.slice(1).map((q2, n) => [w.points[n]!, q2] as const)) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let t = 0; t <= L; t += 0.5) {
        const p: V2 = [a[0] + ((b[0] - a[0]) * t) / (L || 1), a[1] + ((b[1] - a[1]) * t) / (L || 1)];
        if (Math.hypot(p[0] - w.points[0]![0], p[1] - w.points[0]![1]) < 0.6 || Math.hypot(p[0] - w.points[w.points.length - 1]![0], p[1] - w.points[w.points.length - 1]![1]) < 0.6) continue;
        const c = at.get(`${Math.round((p[0] - s.origin[0]) / s.cell)},${Math.round((p[1] - s.origin[1]) / s.cell)}`);
        if (c) expect(Math.max(Math.abs(p[0] - c.at[0]), Math.abs(p[1] - c.at[1]))).toBeGreaterThan(s.cell / 2 - 0.05);
      }
    }
    // every leg ends on a deck edge whose rail is left open
    for (const w of s.walks.filter((x) => x.points.length)) for (const p of w.to === "dry-link" ? [w.points[0]!] : [w.points[0]!, w.points[w.points.length - 1]!]) {
      expect(s.cells.some((c) => (c.open ?? []).some((f) => { const v = ({ px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] } as const)[f]; return Math.hypot(c.at[0] + (v[0] * s.cell) / 2 - p[0], c.at[1] + (v[1] * s.cell) / 2 - p[1]) < 0.05; }))).toBe(true);
    }
  });
  it("passes its check (deck = water + 1.5, every cluster populated, walkway branches 1.6 m)", () => {
    const r = checkSettlement(plan, crockin);
    expect(r.findings.filter((f) => f.code !== "tier-footprint")).toEqual([]);
  });
  it("builds family compounds: huts on platforms, every door onto a deck cell, a raised one walked into up its ramp", () => {
    for (const b of s.blocks) {
      expect(s.cells.filter((c) => c.ref === b.id && c.kind === "platform").length).toBeGreaterThanOrEqual(2);
      for (const h of b.huts) {
        expect(at.get(h.cell.join(","))?.kind).toBe("hut");
        expect(at.get(h.porch.join(","))?.kind).toBe("platform");
      }
      if (b.y) {
        // the ramp descends out of the compound; a walkway arrives at its foot
        const r = s.cells.find((c) => c.kind === "ramp" && c.ref === `in-${b.id}`)!;
        expect(r).toBeDefined();
        const [vx, vz] = ({ px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] } as const)[r.face!];
        expect(at.get(`${r.i - vx},${r.j - vz}`)?.ref).toBe(b.id);
        const foot = at.get(`${r.i + vx},${r.j + vz}`);
        expect(r.open?.includes(r.face!) || (foot && foot.ref !== b.id && !foot.y)).toBeTruthy();
      }
    }
    // the household kit stands on open deck: on its compound's platforms clear of rails and huts, else stowed inside its
    // own hut or on its own boat dock
    const free = stiltFloorFree(s);
    for (const h of plan.households) for (const it of h.items) expect(free(it.at, 0.5) || free(it.at, 0.3, h.id) || free(it.at, 0.5, DOCK)).toBe(true);
  });
});

describe("settlement grammar: footprints of their own", () => {
  // two isles, a ford between them; every prop has a catalogue size
  const ground: SettleGround = { height: (x, z) => (Math.hypot(x, z) < 40 || Math.hypot(x - 110, z) < 30 ? 8 : 5), water: (x, z) => (Math.hypot(x, z) < 40 || Math.hypot(x - 110, z) < 30 ? null : 6) };
  const camp: SettlementCultureIn = {
    id: "isle", scale: "human", cultures: ["frogkin"], ground: "hummock", householdSpacing: [40, 140], clusterSpacing: [40, 140], onePerPad: true,
    dwelling: { kind: "prefab", props: ["k/hut"], footprint: [5, 5] },
    household: [{ role: "work", props: ["k/trap"], count: 2, place: "water-edge" }, { role: "light", props: ["k/lamp", "k/dish"], place: "door" }],
    gathering: { kind: "ring", ring: { props: ["k/totem"], count: 6, radius: 8 }, radius: 16 },
    paths: { kind: "ford", width: 2.4, maxWade: 1.5 },
  };
  const sizes: Record<string, [number, number, number]> = { "k/hut": [6, 4, 6], "k/trap": [1.8, 1, 0.9], "k/lamp": [0.6, 1.3, 0.6], "k/dish": [1, 0.3, 1.4], "k/totem": [1.2, 3, 0.8] };
  const props = (id: string) => ({ size: sizes[id]!, rooms: id === "k/trap" ? ["shore", "workshop"] : ["camp", "shore"], mount: id === "k/dish" ? "surface" : "floor" });
  const plan = planSettlement({ id: "isles", culture: camp, households: 1, centre: [40, 0], radius: 90, anchors: { gather: [0, 0] }, props }, ground);
  it("keeps every prop on dry ground off the lanes it lays, never a surface prop on the floor", () => {
    const items = plan.areas.flatMap((a) => a.items).filter((i) => i.role !== "dwelling");
    expect(items.length).toBeGreaterThan(4);
    for (const it of items) expect(ground.water(it.at[0], it.at[1])).toBeNull();
    expect(items.some((i) => i.prop === "k/dish")).toBe(false);
    const lanes = plan.paths.filter((p) => p.points.length >= 2);
    const segD = (p: [number, number], a: [number, number], b: [number, number]): number => { const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz); };
    for (const it of items) for (const l of lanes) for (let k = 1; k < l.points.length; k++) expect(segD(it.at, l.points[k - 1]!, l.points[k]!)).toBeGreaterThan(l.width / 2 + 0.6);
    // the dwelling's lane ends in front of its door, not through it
    const h = plan.households[0]!;
    for (const l of lanes) for (let k = 1; k < l.points.length; k++) expect(segD(h.dwelling.at, l.points[k - 1]!, l.points[k]!)).toBeGreaterThan(3);
  });
  it("names area roles every prop declares (also-roles for the rest)", () => {
    const h = plan.areas.find((a) => a.kind === "household")!;
    expect(h.role).toBe("shore");
  });
});

describe("settlement grammar: areas sized to what they hold", () => {
  const marsh: SettleGround = { height: (x) => (x > 110 ? 7.5 : 5), water: (x) => (x > 110 ? null : 6) };
  const sizes: Record<string, [number, number, number]> = { "c/hamper": [1.4, 1.1, 1], "c/net": [1.8, 2.5, 1], "c/trap": [1.3, 1.2, 1], "c/torch": [0.4, 1.9, 0.4], "c/brazier": [1.1, 1.2, 1.1], "c/basin": [2.4, 0.6, 1.7], "c/rack": [2.4, 1.5, 1.1], "c/table": [1.9, 0.9, 1] };
  const props = (id: string) => ({ size: sizes[id]!, rooms: ["camp"], mount: "floor", loose: id === "c/hamper" || id === "c/net" });
  const crockin: SettlementCultureIn = {
    id: "crockin", scale: "crockin", cultures: ["crocodile-kin"], ground: "stilt", householdSpacing: [4, 12], clusterSpacing: [28, 44],
    dwelling: { kind: "wfc", project: "kit", kit: "stilt", cell: [4, 3.5, 4], hutTiles: "^hut", block: [5, 5], communal: [4, 4], landings: 3, hearth: "deck-hearth" },
    household: [{ role: "storage", props: ["c/hamper"], place: "side" }, { role: "light", props: ["c/torch"], place: "door" }, { role: "work", props: ["c/net", "c/trap"], place: "side" }],
    gathering: { kind: "deck", centre: ["c/brazier"], ring: { props: ["c/table"], count: 4, radius: 4.2 }, radius: 9 },
    work: [{ id: "smoking", where: "water-edge", props: ["c/rack"], count: 3, radius: 5 }, { id: "hatchery", where: "dry", props: ["c/basin"], count: 2, radius: 8 }],
    paths: { kind: "walkway", width: 4 },
  };
  const plan = planSettlement({ id: "stilts", culture: crockin, households: 9, clusters: 3, centre: [40, 0], radius: 100, anchors: { approach: [140, 0] }, props }, marsh);
  it("lights the kit hearth instead of standing a brazier on it, ring props clear of its fire", () => {
    expect(plan.gathering.items.some((i) => i.prop === "c/brazier")).toBe(false);
    for (const i of plan.gathering.items.filter((x) => x.role === "ring")) expect(Math.hypot(i.at[0] - plan.gathering.at[0], i.at[1] - plan.gathering.at[1])).toBeGreaterThan(2.8);
  });
  it("keeps one loose container per small household area (the net turns into a trap)", () => {
    for (const h of plan.households) expect(h.items.filter((i) => i.prop === "c/hamper" || i.prop === "c/net").length).toBeLessThanOrEqual(1);
  });
  it("draws every area round its own footprints (rim band kept), a dry yard filled to what its size asks", () => {
    for (const a of plan.areas) for (const it of a.items) {
      const s = sizes[it.prop]; const hd = s ? Math.hypot(s[0], s[2]) / 2 : 0.9;
      expect(Math.hypot(it.at[0] - a.centre[0], it.at[1] - a.centre[1]) + hd).toBeLessThanOrEqual(a.radius - 1.49);
    }
    const yard = plan.areas.find((a) => a.id === "hatchery")!;
    expect(yard.items.length).toBeGreaterThanOrEqual(Math.min(6, Math.max(2, Math.floor((Math.PI * yard.radius ** 2 * 0.8) / 15))));
    // the smoking deck is long enough for its racks
    expect(plan.stilt!.cells.filter((c) => c.ref === "smoking").length).toBeGreaterThanOrEqual(2);
    // two-hut compounds are 3 x 3 (a porch row each side), so the deck fits two of the three racks, never none
    expect(plan.work.find((w) => w.id === "smoking")!.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("settlement helpers", () => {
  it("routes a straight-preferring corridor round an obstacle", () => {
    const wall = (i: number, j: number) => !(i === 3 && j < 4);
    const p = routeCells(8, 8, wall, [[0, 0]], (i, j) => i === 6 && j === 0)!;
    expect(p[p.length - 1]).toEqual([6, 0]);
    expect(p.every(([i, j]) => wall(i, j))).toBe(true);
  });
  it("knows which props need cleared cover", () => {
    expect(needsClearedCover("frogkin-lily-camp/lily-leaf-tent")).toBe("dwelling");
    expect(needsClearedCover("camp-props/bonfire", { fire: true, mount: "floor" })).toBe("fire");
    expect(needsClearedCover("frogkin-lily-camp/reed-pitch-torch", { fire: true })).toBe(null);
    expect(needsClearedCover("rock-kit/boulder-s-1")).toBe(null);
  });
});

describe("settlement grammar: stilt village on levels (stairs, tall decks, routes)", () => {
  const marsh: SettleGround = { height: (x) => (x > 110 ? 7.5 : 5), water: (x) => (x > 110 ? null : 6) };
  const crockin: SettlementCultureIn = {
    id: "crockin", scale: "crockin", cultures: ["crocodile-kin"], ground: "stilt", householdSpacing: [4, 12], clusterSpacing: [6, 60],
    dwelling: {
      kind: "wfc", project: "kit", kit: "stilt", cell: [4, 3.5, 4], hutTiles: "^hut", block: [5, 5], communal: [4, 4], landings: 3, stops: 2, frames: ["frame"],
      levels: { rise: 1.5, core: [1, 2, 1, 2, 0, 2, 1, 0], fringe: [0, 1, 0], floors: ["floor-deck", "floor-deck-raised", "floor-deck-tall"], stairs: [{ part: "stair-up", lo: 0 }], landings: [{ part: "floor-deck-landing", ladder: "ladder", ladderTop: 0 }] },
    },
    household: [{ role: "storage", props: ["croc/hamper"], place: "side" }, { role: "light", props: ["croc/torch"], place: "door" }, { role: "work", props: ["croc/trap"], place: "side" }],
    gathering: { kind: "deck", centre: ["croc/brazier"], radius: 9 },
    work: [{ id: "smoking", where: "water-edge", props: ["croc/rack"], count: 2, radius: 5 }],
    paths: { kind: "walkway", width: 4 },
  };
  const plan = planSettlement({ id: "levels", culture: crockin, households: 14, centre: [20, 0], radius: 110, seed: 2, anchors: { approach: [140, 0] } }, marsh);
  const s = plan.stilt!, at = new Map(s.cells.map((c) => [`${c.i},${c.j}`, c]));
  const F = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] } as const;

  it("stacks compounds on at least three walk levels, a rise apart, each compound's decks at its level", () => {
    const ys = [...new Set(s.blocks.map((b) => b.y))].sort((a, b) => a - b);
    expect(ys.length).toBeGreaterThanOrEqual(3);
    for (const y of ys) expect(Math.abs(y / s.rise! - Math.round(y / s.rise!))).toBeLessThan(1e-6);
    for (const b of s.blocks) for (const [i, j] of b.cells) { const c = at.get(`${i},${j}`); if (c && c.kind !== "stair") expect(c.y ?? 0).toBe(b.y); }
  });

  it("joins levels by stair flights: the head on a deck at its height, the foot one rise below", () => {
    const stairs = s.cells.filter((c) => c.kind === "stair");
    expect(stairs.length).toBeGreaterThan(0);
    const deckAt = (c: (typeof s.cells)[number] | undefined, y: number): boolean => !!c && c.kind !== "hut" && Math.abs((c.y ?? 0) - y) < 1e-6;
    for (const c of stairs) {
      const v = F[c.face!], foot = at.get(`${c.i + v[0]},${c.j + v[1]}`), head = at.get(`${c.i - v[0]},${c.j - v[1]}`);
      expect(deckAt(head, c.y ?? 0)).toBe(true);
      // the foot: a deck cell one rise below, or open water a walkway arrives at (the flight's front left open) — never
      // another flight, never a hut
      expect(foot?.kind).not.toBe("stair");
      if (foot) expect(foot.kind !== "hut" && foot.kind !== "ramp" && Math.abs((foot.y ?? 0) - ((c.y ?? 0) - s.rise!)) < 1e-6).toBe(true);
      else expect(c.open?.includes(c.face!)).toBe(true);
    }
  });

  it("routes the bank to the communal deck and to huts on the highest and the base level, round the props, a rise a step at most", () => {
    const routes = stiltRoutes(plan, 3);
    expect(routes[0]!.id).toBe("bank-to-communal");
    expect(routes.length).toBe(4);
    const top = Math.max(...s.blocks.map((b) => b.y));
    const ends = routes.slice(1).map((r) => r.points[r.points.length - 1]![1] - s.deckY);
    expect(Math.max(...ends)).toBeCloseTo(top, 5);
    expect(Math.min(...ends)).toBeCloseTo(0, 5);
    const things = plan.areas.flatMap((a) => a.items);
    for (const r of routes) for (let n = 1; n < r.points.length; n++) {
      const a = r.points[n - 1]!, b = r.points[n]!;
      expect(Math.abs(b[1] - a[1])).toBeLessThanOrEqual(s.rise! + 1e-6);
      if (n < r.points.length - 2) for (const t of things) expect(Math.hypot(b[0] - t.at[0], b[2] - t.at[1])).toBeGreaterThan(0.5);
    }
  });
});

describe("walkwayPieces", () => {
  it("joins bends without a gap and never lays a hub plank in a run's plane (zfight maxGap 0.02)", () => {
    const pts: V2[] = [[0, 0], [0, 10], [7, 17], [15, 17], [15, 30]];
    for (const width of [1.6, 2.6]) {
      const pcs = walkwayPieces(pts, width);
      const hubs = pcs.filter((p) => p.kind === "hub"), runs = pcs.filter((p) => p.kind === "run");
      expect(hubs.length).toBe(pts.length - 2);
      for (const h of hubs) {
        // the runs either side reach into the hub's square (closed joint) ...
        const near = runs.filter((r) => Math.hypot(r.at[0] - h.at[0], r.at[1] - h.at[1]) - r.length / 2 < width / 2 - 0.05);
        expect(near.length).toBe(2);
        // ... and the hub's planks sit clear of theirs
        for (const r of near) expect(Math.abs(h.y - r.y)).toBeGreaterThan(0.02 + 0.02);
      }
      expect(WALKWAY_HUB_LIFT).toBeLessThan(0.1); // a cross plank, not a step
    }
  });
});

describe("walkwayPieces short stretches", () => {
  it("never squeezes a run between two hubs below WALKWAY_MIN_STRETCH, and runs either side of a hub never meet under it", () => {
    const pts: V2[] = [[0, 0], [0, 8], [0, 11.8], [6, 18]]; // a 3.8 m middle stretch: 1.3 m of run left between the wide hubs
    const w = 2.6, pcs = walkwayPieces(pts, w), runs = pcs.filter((p) => p.kind === "run");
    const mid = runs.find((r) => r.id === "1-0")!;
    expect(mid.scaleZ).toBeGreaterThanOrEqual(WALKWAY_MIN_STRETCH - 1e-3);
    // run 0-0 ends and run 1-0 begins on the straight leg: their extents along z stay apart
    const r0 = runs.find((r) => r.id === "0-0")!;
    expect(r0.at[1] + r0.length / 2).toBeLessThan(mid.at[1] - mid.length / 2);
  });
});

describe("walkwayPieces straight points and tight bends", () => {
  it("lays no hub where the walkway runs straight on, and never two hubs over one another", () => {
    const straight = walkwayPieces([[0, 0], [0, 2.5], [0, 10]], 1.6);
    expect(straight.filter((p) => p.kind === "hub").length).toBe(0);
    // the Gullet's dry-link: two bends 1.7 m apart on a 2.6 m walkway
    const tight = walkwayPieces([[3404, 482], [3406.5, 482], [3408, 482.8], [3408, 480.3]], 2.6);
    const hubs = tight.filter((p) => p.kind === "hub");
    for (const a of hubs) for (const b of hubs) if (a !== b) expect(Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1])).toBeGreaterThan(2.6);
  });
});

describe("walkwayPieces short end legs", () => {
  it("a leg too short to lay even under its hub reaches on past the walk's end, lifted over the deck it lands on", () => {
    // the Gullet's egg-net-deck branch: its last leg is 2.45 m after the hub (squeezed to 0.61 = 51 texels/m before)
    const pcs = walkwayPieces([[3404, 486], [3406.5, 486], [3414, 486], [3418, 482.5], [3418, 480]], 1.6);
    const runs = pcs.filter((p) => p.kind === "run"), hubs = pcs.filter((p) => p.kind === "hub");
    for (const r of runs) expect(r.scaleZ).toBeGreaterThanOrEqual(WALKWAY_MIN_STRETCH - 1e-3);
    const end = runs[runs.length - 1]!;
    expect(end.ext?.[1]).toBeGreaterThan(0.5);
    expect(end.ext?.[0]).toBe(0);
    // it reaches past the last point by ext[1], and stands clear of the deck (0) and of the hub it reaches under
    expect(Math.hypot(end.at[0] - 3418, end.at[1] - 480) + 1e-6).toBeCloseTo(end.length / 2 - end.ext![1], 3);
    expect(end.y).toBe(WALKWAY_END_LIFT);
    for (const h of hubs) expect(Math.abs(end.y - h.y)).toBeGreaterThan(0.02);
    expect(WALKWAY_END_LIFT).toBeLessThan(0.15);
    // a leg long enough keeps its ends and its level
    const plain = walkwayPieces([[0, 0], [0, 10]], 1.6);
    expect(plain.every((p) => !p.ext && p.y === 0)).toBe(true);
  });
});

describe("stilt hut reach (poi-walk BODY: the walk never steps onto a bed or the porch kit)", () => {
  const marsh: SettleGround = { height: (x) => (x > 110 ? 7.5 : 5), water: (x) => (x > 110 ? null : 6) };
  const crockin: SettlementCultureIn = {
    id: "crockin", scale: "crockin", cultures: ["crocodile-kin"], ground: "stilt", householdSpacing: [4, 12], clusterSpacing: [6, 60],
    dwelling: {
      kind: "wfc", project: "kit", kit: "stilt", cell: [4, 3.5, 4], hutTiles: "^hut", block: [5, 5], communal: [4, 4], landings: 3, stops: 2, frames: ["frame"],
      levels: { rise: 1.5, core: [1, 2, 1, 0], fringe: [0, 1, 0], floors: ["floor-deck", "floor-deck-raised", "floor-deck-tall"], stairs: [{ part: "stair-up", lo: 0 }], landings: [{ part: "floor-deck-landing", ladder: "ladder", ladderTop: 0 }] },
    },
    household: [{ role: "sleeping", props: ["croc/bed"], place: "side", required: true }, { role: "storage", props: ["croc/hamper"], place: "side" }, { role: "light", props: ["croc/torch"], place: "door" }],
    gathering: { kind: "deck", centre: ["croc/brazier"], radius: 9 },
    work: [{ id: "smoking", where: "water-edge", props: ["croc/rack"], count: 2, radius: 5 }],
    paths: { kind: "walkway", width: 4 },
  };
  const SIZES: Record<string, [number, number, number]> = { "croc/bed": [1.4, 0.5, 2.2], "croc/hamper": [0.9, 0.8, 0.9], "croc/torch": [0.4, 2, 0.4], "croc/rack": [2.4, 2, 1], "croc/brazier": [1, 1, 1] };
  const size = (id: string): [number, number, number] | undefined => SIZES[id];
  const plan = planSettlement({ id: "reach", culture: crockin, households: 8, centre: [20, 0], radius: 110, seed: 3, anchors: { approach: [140, 0] }, props: (id) => (SIZES[id] ? { size: SIZES[id]! } : undefined) }, marsh);
  const reach = stiltHutReach(plan, size);
  // the walking body: capsule r 0.4 (poi-walk BODY tolerates 0.1 m): its middle at least 0.3 m off a thing's footprint
  const gap = (p: [number, number, number], it: { prop: string; at: [number, number]; yaw: number }): number => {
    const z = size(it.prop) ?? [1.2, 1, 1.2], a = (it.yaw * Math.PI) / 180, dx = p[0] - it.at[0], dz = p[2] - it.at[1];
    const lx = Math.abs(dx * Math.cos(a) - dz * Math.sin(a)) - z[0] / 2, lz = Math.abs(dx * Math.sin(a) + dz * Math.cos(a)) - z[2] / 2;
    return Math.hypot(Math.max(0, lx), Math.max(0, lz)) + Math.min(0, Math.max(lx, lz));
  };
  it("stands just inside every hut, clear of its bed and every household thing", () => {
    expect(reach.size).toBe(plan.households.length);
    const beds = plan.households.filter((h) => h.items.some((i) => i.role === "sleeping")).length;
    expect(beds).toBeGreaterThan(0);
    for (const h of plan.households) {
      const r = reach.get(h.id)!;
      const k = (r.inside[0] - r.door[0]) * r.v[0] + (r.inside[2] - r.door[2]) * r.v[1];
      expect(k).toBeGreaterThanOrEqual(0.3 - 1e-6);
      expect(k).toBeLessThanOrEqual(1.0 + 1e-6);
      for (const it of h.items) expect(gap(r.inside, it)).toBeGreaterThanOrEqual(0.3 - 0.011);
    }
  });
  it("ends hut routes and area routes there, and hands the walk gate 'reach' instead of the footprints' middle", () => {
    const routes = stiltRoutes(plan, 3, size, true);
    const insides = [...reach.values()].map((r) => r.inside);
    const hutRoutes = routes.filter((r) => /^bank-to-h/.test(r.id) || (r.network && /^to-h/.test(r.id)));
    expect(hutRoutes.length).toBeGreaterThan(0);
    for (const r of hutRoutes) {
      const e = r.points[r.points.length - 1]!;
      // the last hop runs straight in from the door: within 0.5 m (the lattice lane) of the reach point, on its floor
      expect(insides.some((p) => Math.hypot(p[0] - e[0], p[2] - e[2]) <= 0.51 && Math.abs(p[1] - e[1]) < 1e-6), `${r.id} ends at ${e}`).toBe(true);
      for (const h of plan.households) for (const it of h.items) expect(gap(e, it)).toBeGreaterThanOrEqual(0.3 - 0.011);
    }
    // every hop of every route (the lattice's diagonals included) keeps a body's room off every household thing
    const things = plan.households.flatMap((h) => h.items.map((it) => ({ it, y: plan.stilt!.deckY + (plan.stilt!.cells.find((c) => c.i === h.dwelling.cell?.[0] && c.j === h.dwelling.cell?.[1])?.y ?? 0) })));
    for (const r of routes) for (let n = 1; n < r.points.length; n++) for (const k of [0.25, 0.5, 0.75]) {
      const a = r.points[n - 1]!, b = r.points[n]!, p: [number, number, number] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      for (const t of things) if (Math.abs(t.y - p[1]) < 1.2) expect(gap(p, t.it)).toBeGreaterThanOrEqual(0.3 - 0.011);
    }
    const sd = settlementSiteDressing(plan, crockin, size);
    const hh = sd.areas.filter((a) => plan.households.some((h) => h.id === a["id"]));
    expect(hh.length).toBe(plan.households.length);
    // the walk target is where the network route to the area stops (never a point it would walk on to from there)
    for (const a of hh) {
      const end = routes.find((r) => r.network && r.id === `to-${a["id"]}`)!.points.at(-1)!;
      expect(a["reach"]).toEqual(end);
      for (const h of plan.households) for (const it of h.items) expect(gap(end, it)).toBeGreaterThanOrEqual(0.3 - 0.011);
    }
    expect(hh.filter((a) => insides.some((p) => { const q = a["reach"] as number[]; return Math.hypot(p[0] - q[0]!, p[2] - q[2]!) <= 0.51; })).length).toBeGreaterThan(0);
  });
});
