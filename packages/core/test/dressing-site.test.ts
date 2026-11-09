import { describe, expect, it } from "vitest";
import { buildSiteSocketMap, builtFloorSampler, keepWithoutRooms, readSiteDressing, dressingSchema, resolveDressing, socketMapSchema, type DressingData } from "../src/index.js";

// a flat yard at y 10 with a gentle rise to the east, a tent (built), a hearth, a path and a pack clearing
const sample = { ground: (x: number) => 10 + Math.max(0, x - 6) * 0.05, water: (x: number) => (x < -9 ? 11 : null) };
const site = () =>
  buildSiteSocketMap(
    {
      id: "test-site",
      areas: [{ id: "yard", role: "camp", centre: [0, 0], radius: 12 }],
      anchors: [{ id: "fire", kind: "hearth", at: [0, 0], radius: 1.5 }, { id: "tent-door", kind: "door", at: [0, 7], facing: [0, -1] }],
      keep: [{ id: "path", why: "walking route", points: [[-12, -4], [12, -4]], width: 2 }, { id: "pack", why: "creature pack", points: [[7, 5]], radius: 2 }],
      blockers: [{ id: "tent", centre: [0, 10], half: [4, 3], yaw: 0 }, { id: "fire", centre: [0, 0], half: [1.5, 1.5], yaw: 0 }],
    },
    sample,
  );

describe("site socket maps", () => {
  it("measures one level per area: open ground, kept-clear routes and discs, built footprints, water, ground heights", () => {
    const { map, report } = site();
    expect(() => socketMapSchema.parse(map)).not.toThrow();
    const lv = map.levels[0]!;
    const ch = (x: number, z: number) => lv.cells[Math.floor((z - lv.origin[1]) / lv.step)]![Math.floor((x - lv.origin[0]) / lv.step)];
    expect(ch(5, 3)).toBe("o");
    expect(ch(3, -4)).toBe("x"); // the path band
    expect(ch(7, 5)).toBe("x"); // the pack disc
    expect(ch(0, 9)).toBe("#"); // the tent
    expect(ch(-10, 0)).toBe(" "); // water
    expect(ch(0, 2.3)).toBe("H"); // fire clearance
    expect(lv.cells.join("")).toContain("E"); // the path enters
    expect(report[0]!.open).toBeGreaterThan(100);
    expect(lv.walls.some((w) => w.id === "yard.tent.S")).toBe(true);
    const kinds = new Set(map.anchors.map((a) => a.kind));
    for (const k of ["hearth", "hearth-seat", "door", "door-left", "door-right", "path-side", "edge"]) expect(kinds).toContain(k);
    // nothing kept on a refused cell
    // (features, not pitches: hearths, doors, structures and their fronts, where the route enters)
    for (const a of map.anchors.filter((a) => !["hearth", "door", "structure", "structure-front", "approach-end"].includes(a.kind))) expect(ch(a.position[0], a.position[2])).toBe("o");
  });

  it("resolves auto placements outdoors onto the ground under them, never on a route", () => {
    const { map } = site();
    const crate = dressingSchema.parse({ mount: "floor", size: [1, 1, 1], against: "free", setting: "outdoor", category: "storage", rooms: ["camp"] }) as DressingData;
    const res = resolveDressing({
      map,
      plan: { id: "t", map: "test-site", rooms: { yard: { role: "camp", also: [], owner: "" } }, items: [{ id: "c", prop: "crate", set: "", note: "", place: { kind: "auto", room: "yard", prefer: "near", near: "hearth" } }] },
      prop: (id: string) => (id === "crate" ? crate : undefined),
      set: () => undefined,
    } as never);
    const p = res.placements.find((x) => x.id === "c");
    expect(p, JSON.stringify(res.violations)).toBeTruthy();
    expect(Math.hypot(p!.position[0], p!.position[2])).toBeLessThan(5);
    expect(p!.position[1]).toBeCloseTo(10 + Math.max(0, p!.position[0] - 6) * 0.05, 1);
  });

  it("skips anchors and kept-clear entries that have no coordinates instead of crashing", () => {
    const { map } = buildSiteSocketMap(
      { id: "t2", areas: [{ id: "yard", role: "yard", centre: [0, 0], radius: 6 }], anchors: [{ id: "bare" } as never], keep: [{ id: "bare-keep", why: "x", points: [] }, { id: "lane", why: "x", points: [[0, -6], [0, 6]], width: 2 }], blockers: [] },
      sample,
    );
    const lv = map.levels[0]!;
    const ch = (x: number, z: number) => lv.cells[Math.floor((z - lv.origin[1]) / lv.step)]![Math.floor((x - lv.origin[0]) / lv.step)];
    expect(ch(0, 0)).toBe("x");
    expect(ch(4, 0)).toBe("o");
    expect(map.anchors.some((a) => a.id.endsWith("/bare"))).toBe(false);
  });

  it("room takes one passage id or a comma-separated list", () => {
    const keep = ["a", "b", "c"].map((id) => ({ id, why: "p", points: [[0, 0]] as [number, number][], radius: 1 }));
    expect(keepWithoutRooms(keep, "b").map((k) => k.id)).toEqual(["a", "c"]);
    expect(keepWithoutRooms(keep, "a, c").map((k) => k.id)).toEqual(["b"]);
    expect(keepWithoutRooms(keep).length).toBe(3);
  });
});

describe("handoff siteDressing as owners write it", () => {
  it("takes a bare areas array, [x,y,z] centres (the y declares the floor) and free-text surfaces as notes", () => {
    const r = readSiteDressing([
      { id: "deck", role: "camp", centre: [10, 12, 20], radius: 5, surface: "landmark deck y 12" },
      { id: "yard", role: "yard", centre: [1, 2], radius: 4 },
      { id: "cave", role: "cave-mouth", centre: [0, 0], radius: 6, floorY: -8 },
      { id: "quay", role: "shore", centre: [0, 3, 0], radius: 6, surface: "built" },
    ]);
    expect(r.anchors).toEqual([]);
    expect(r.keepClear).toEqual([]);
    const [deck, yard, cave, quay] = r.areas;
    expect(deck!.centre).toEqual([10, 20]);
    expect(deck!.declaredY).toBe(12);
    expect(deck!.surface).toBeUndefined();
    expect(deck!.surfaceNote).toBe("landmark deck y 12");
    expect(yard!.centre).toEqual([1, 2]);
    expect(yard!.declaredY).toBeUndefined();
    expect(cave!.surface).toBe("cave"); // floorY alone keeps its old meaning
    expect(cave!.declaredY).toBe(-8);
    expect(quay!.surface).toBe("built");
    expect(quay!.declaredY).toBe(3);
  });

  it("takes the object form unchanged", () => {
    const r = readSiteDressing({ areas: [{ id: "a", role: "camp", centre: [0, 0], radius: 3 }], anchors: [{ id: "h", kind: "hearth", at: [0, 0] }], keepClear: [{ id: "k", at: [1, 1], radius: 2 }] });
    expect(r.areas.map((a) => a.id)).toEqual(["a"]);
    expect(r.anchors.length).toBe(1);
    expect(r.keepClear.length).toBe(1);
    expect(readSiteDressing(undefined).areas).toEqual([]);
  });
});

describe("built floors", () => {
  // a deck (top y 7) over water (y 1, bed y 0): a rail along its east edge, a hut standing on it
  type Box = { x: [number, number]; z: [number, number]; y: [number, number] };
  const solids: Box[] = [
    { x: [-3, 3], z: [-6, 6], y: [6.8, 7] },     // the deck
    { x: [2.8, 3], z: [-6, 6], y: [7, 8] },      // the rail
    { x: [-3, -1], z: [2, 5], y: [7, 9.5] },     // the hut
    { x: [-50, 50], z: [-50, 50], y: [-5, 0] },  // the river bed
  ];
  const castDown = (x: number, y: number, z: number, len: number): number | null => {
    let best: number | null = null;
    for (const b of solids) {
      if (x < b.x[0] || x > b.x[1] || z < b.z[0] || z > b.z[1]) continue;
      const h = y >= b.y[0] && y <= b.y[1] ? y : y > b.y[1] && y - len <= b.y[1] ? b.y[1] : null;
      if (h !== null && (best === null || h > best)) best = h;
    }
    return best;
  };
  const water = (): number => 1;
  const deckArea = (surface?: "built") => buildSiteSocketMap(
    { id: "deck", areas: [{ id: "deck", role: "camp", centre: [0, 0], radius: 8, ...(surface ? { surface } : {}) }], anchors: [], keep: [], blockers: [{ id: "stilt-deck", centre: [0, 0], half: [3, 6], yaw: 0 }] },
    surface ? builtFloorSampler(7, castDown, water) : { ground: (x, z) => castDown(x, 0.3, z, 3), top: (x, z) => castDown(x, 30, z, 60), water },
  );

  it("measures the deck's top at its height: open floor, rails and huts as walls' cells, the water off its edge refused", () => {
    const { map, report } = deckArea("built");
    expect(() => socketMapSchema.parse(map)).not.toThrow();
    const lv = map.levels[0]!;
    const ch = (x: number, z: number) => lv.cells[Math.floor((z - lv.origin[1]) / lv.step)]![Math.floor((x - lv.origin[0]) / lv.step)];
    const gd = (x: number, z: number) => lv.ground![Math.floor((z - lv.origin[1]) / lv.step)]![Math.floor((x - lv.origin[0]) / lv.step)];
    expect(lv.floorY).toBeCloseTo(7, 3);
    expect(ch(0, 0)).toBe("o");                  // the deck itself, though its prefab footprint covers it
    expect(gd(0, 0)).toBe((18).toString(36));    // at the floor's height
    expect(ch(6, 0)).toBe(" ");                  // water beside the deck: no floor at this height
    expect(ch(-2.9, 0)).toBe(" ");               // the deck's open edge: a drop, so nothing hangs
    expect(ch(2.9, 0)).toBe("#");                // the rail
    expect(ch(-2, 3.5)).toBe("#");               // the hut
    expect(report[0]!.refused["drop edge (built floor)"]).toBeGreaterThan(0);
    expect(report[0]!.open).toBeGreaterThan(30);
    expect(lv.walls.some((w) => w.id.includes("stilt-deck"))).toBe(false); // the floor is no wall
    expect(lv.cells.join("")).toContain("E");
    for (const a of map.anchors) expect(a.position[1]).toBeCloseTo(7, 3);
  });

  it("on the ground sampler the same deck is refused (what a built floor fixes)", () => {
    const { report } = deckArea();
    expect(report[0]!.open).toBe(0);
  });

  it("seats an auto placement on the deck, not on the water under it", () => {
    const { map } = deckArea("built");
    const crate = dressingSchema.parse({ mount: "floor", size: [1, 1, 1], against: "free", setting: "outdoor", category: "storage", rooms: ["camp"] }) as DressingData;
    const res = resolveDressing({
      map,
      plan: { id: "t", map: "deck", rooms: { deck: { role: "camp", also: [], owner: "" } }, items: [{ id: "c", prop: "crate", set: "", note: "", place: { kind: "auto", room: "deck", prefer: "open" } }] },
      prop: (id: string) => (id === "crate" ? crate : undefined),
      set: () => undefined,
    } as never);
    const p = res.placements.find((x) => x.id === "c");
    expect(p, JSON.stringify(res.violations)).toBeTruthy();
    expect(Math.abs(p!.position[0])).toBeLessThan(3);
    expect(p!.position[1]).toBeCloseTo(7, 2);
  });
});

describe("readSiteDressing anchors and keepClear", () => {
  it("reads [x,y,z] keepClear and anchor positions as [x,z]", () => {
    const r = readSiteDressing({ areas: [], anchors: [{ id: "a", kind: "hearth", at: [1, 2, 3] }], keepClear: [{ id: "k", at: [-2306, 1.6, -1957], radius: 3.5 }, { id: "l", points: [[0, 5, 1], [2, 3]], width: 2 }] });
    expect(r.anchors[0]!.at).toEqual([1, 3]);
    expect(r.keepClear[0]!.at).toEqual([-2306, -1957]);
    expect(r.keepClear[1]!.points).toEqual([[0, 1], [2, 3]]);
  });
});

// owner walk 2026-10-21 (kirk-knowe): "none of these graves are spaced out, they are all clustered in the centre"
describe("graveyards: headstones in rows filling the yard", () => {
  const flat = { ground: () => 10, water: () => null };
  // a 40 m walled-yard-sized disc, a lane N-S through the middle (the walk route in from the south gate), a pack clearing
  const yard = () =>
    buildSiteSocketMap(
      {
        id: "kirkyard",
        areas: [{ id: "yard", role: "ruin", centre: [0, 0], radius: 18 }],
        anchors: [],
        keep: [
          { id: "lane", why: "walk route", points: [[0, -20], [0, 20]], width: 2.4 },
          { id: "pack", why: "creature clearing", points: [[-9, -8]], radius: 4 },
        ],
        blockers: [],
      },
      flat,
    ).map;
  const stone = (w: number) => dressingSchema.parse({ mount: "floor", size: [w, 1.2, 0.15], against: "free", setting: "outdoor", category: "sacred", rooms: ["yard", "ruin"], tags: ["grave"] }) as DressingData;
  const PROPS: Record<string, DressingData> = { "stone-a": stone(0.8), "stone-b": stone(0.6) };
  const go = (items: { id: string; prop: string; place: Record<string, unknown> }[]) => {
    const map = yard();
    return resolveDressing({
      map,
      plan: { id: "g", map: "kirkyard", rooms: { yard: { role: "ruin", also: [], owner: "" } }, items: items.map((i) => ({ set: "", note: "", ...i })) },
      prop: (id: string) => PROPS[id],
      set: () => undefined,
      options: { minItems: () => 0 },
    } as never);
  };
  const graves = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, prop: i % 3 ? "stone-a" : "stone-b", place: { kind: "auto", room: "yard", prefer: "row" } }));

  it("lays the graves in rows 2-2.5 m apart, stones 1.2-1.8 m apart, all facing one way, over the whole yard, the lane kept", () => {
    const t0 = performance.now();
    const r = go(graves(90));
    const ms = performance.now() - t0;
    expect(r.violations, JSON.stringify(r.violations.slice(0, 3))).toEqual([]);
    const ps = r.placements.filter((p) => p.id.startsWith("g"));
    expect(ps.length).toBe(90);
    // one facing
    expect(new Set(ps.map((p) => Math.round(p.yaw * 100))).size).toBe(1);
    // rows: distinct z (the lane runs along z, so rows run across x), 2-2.5 m apart
    const rows = [...new Set(ps.map((p) => +p.position[2].toFixed(2)))].sort((a, b) => a - b);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const gaps = rows.slice(1).map((z, i) => z - rows[i]!), pitch = Math.min(...gaps);
    expect(pitch).toBeGreaterThanOrEqual(2 - 1e-6);
    expect(pitch).toBeLessThanOrEqual(2.5 + 1e-6);
    for (const g of gaps) expect(Math.abs(g / pitch - Math.round(g / pitch))).toBeLessThan(0.01); // on one lattice
    // stones in one row stand on one lattice: neighbours at least 1.2 m apart, every gap a whole number of lattice steps
    for (const z of rows) {
      const xs = ps.filter((p) => Math.abs(p.position[2] - z) < 0.01).map((p) => p.position[0]).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(1.2 - 1e-6);
    }
    // never on the lane (|x| < 1.2 + the stone's half width), spread over the yard: both halves, front and back
    for (const p of ps) expect(Math.abs(p.position[0])).toBeGreaterThan(1.2);
    expect(Math.min(...ps.map((p) => p.position[2]))).toBeLessThan(-10);
    expect(Math.max(...ps.map((p) => p.position[2]))).toBeGreaterThan(10);
    expect(Math.min(...ps.map((p) => p.position[0]))).toBeLessThan(-10);
    expect(Math.max(...ps.map((p) => p.position[0]))).toBeGreaterThan(10);
    // not a clump at the centre
    expect(ps.filter((p) => Math.hypot(p.position[0], p.position[2]) < 2).length).toBeLessThan(5);
    expect(ms).toBeLessThan(15000);
  }, 30_000); // a full settlement dress: ~1.5 s alone, past the 5 s default under a parallel suite

  it("keeps the graves inside a walled yard: none on the ground between the wall and the site's rim", () => {
    const map = buildSiteSocketMap(
      {
        id: "walled",
        areas: [{ id: "yard", role: "ruin", centre: [0, 0], radius: 18 }],
        anchors: [],
        keep: [{ id: "lane", why: "walk route", points: [[0, -20], [0, 20]], width: 2.4 }],
        // a 24 m square drystone wall, gates on the lane
        blockers: [
          { id: "w-w", centre: [-12, 0], half: [0.4, 12], yaw: 0 },
          { id: "w-e", centre: [12, 0], half: [0.4, 12], yaw: 0 },
          { id: "w-s1", centre: [-7, -12], half: [5, 0.4], yaw: 0 },
          { id: "w-s2", centre: [7, -12], half: [5, 0.4], yaw: 0 },
          { id: "w-n1", centre: [-7, 12], half: [5, 0.4], yaw: 0 },
          { id: "w-n2", centre: [7, 12], half: [5, 0.4], yaw: 0 },
        ],
      },
      flat,
    ).map;
    const r = resolveDressing({ map, plan: { id: "g", map: "walled", rooms: { yard: { role: "ruin", also: [], owner: "" } }, items: graves(40).map((i) => ({ set: "", note: "", ...i })) }, prop: (id: string) => PROPS[id], set: () => undefined, options: { minItems: () => 0 } } as never);
    const ps = r.placements.filter((p) => p.id.startsWith("g"));
    expect(ps.length).toBe(40);
    for (const p of ps) expect(Math.max(Math.abs(p.position[0]), Math.abs(p.position[2]))).toBeLessThan(12);
  });

  it("refuses graves clumped in the middle (graveyard-rows) and a yard with too few (graveyard-sparse)", () => {
    const clump = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, prop: "stone-a", place: { kind: "floor", level: 0, at: [2 + (i % 3) * 1.2, -3 + Math.floor(i / 3) * 1.2], yaw: 0 } }));
    const r = go(clump);
    expect(r.violations.map((v) => v.code)).toContain("graveyard-rows");
    expect(r.violations.find((v) => v.code === "graveyard-rows")?.message).toMatch(/span \d+% of the yard/);
    expect(r.violations.map((v) => v.code)).toContain("graveyard-sparse");
  });

  it("a non-grave `row` item still needs `near`", () => {
    PROPS.bench = dressingSchema.parse({ mount: "floor", size: [1.2, 0.5, 0.4], against: "free", setting: "outdoor", rooms: ["yard", "ruin"] }) as DressingData;
    const r = go([{ id: "b", prop: "bench", place: { kind: "auto", room: "yard", prefer: "row" } }]);
    expect(r.violations.map((v) => v.code)).toContain("auto-near");
  });
});

describe("outdoor LAYOUT: vignettes spread over the site, not a square of stuff (owner walk 2026-10-21)", () => {
  const flat = { ground: () => 10, water: () => null };
  // a 16 m camp disc; the approach comes in from the south-west along x = -9, then east to the middle; a fire at (2, 3)
  // r 1; a hut (a structure keep-clear disc) to the north-west
  const camp = () =>
    buildSiteSocketMap(
      {
        id: "camp",
        areas: [{ id: "core", role: "camp", centre: [0, 0], radius: 16 }],
        anchors: [{ id: "fire", kind: "hearth", at: [2, 3], radius: 1 }],
        keep: [
          { id: "approach", why: "walk route", points: [[-9, -20], [-9, -4], [0, -4]], width: 2.4 },
          { id: "hut", why: "structure hut", points: [[-8, 9]], radius: 2.5 },
        ],
        blockers: [],
      },
      flat,
    ).map;
  const D = (o: Record<string, unknown>) => dressingSchema.parse({ mount: "floor", against: "free", setting: "outdoor", rooms: ["camp", "yard"], ...o }) as DressingData;
  const PROPS: Record<string, DressingData> = {
    log: D({ size: [1.4, 0.4, 0.45], use: ["seat"], category: "furniture" }),
    bedroll: D({ size: [0.9, 0.25, 2.0], category: "bedding" }),
    crate: D({ size: [0.7, 0.7, 0.7], category: "storage" }),
    rack: D({ size: [1.6, 1.8, 0.5], category: "tool" }),
    heap: D({ size: [1.2, 0.6, 1.2], category: "decor" }),
    boulder: D({ size: [1, 0.8, 1], category: "decor" }),
  };
  type R = ReturnType<typeof resolveDressing>;
  const go = (plan: Record<string, unknown>, map = camp()): R =>
    resolveDressing({
      map,
      plan: { id: "c", map: map.id, rooms: { core: { role: "camp", also: [], owner: "" } }, space: { kind: "site", cultures: [] }, obstacles: [], arrangements: [], ...plan, items: (plan.items as object[]).map((i) => ({ set: "", note: "", ...i })) },
      prop: (id: string) => PROPS[id],
      set: () => undefined,
    } as never);
  const pos = (r: R, id: string) => r.placements.find((p) => p.id === id)!;
  const faces = (p: { position: number[]; yaw: number }, at: [number, number]): number => {
    const f = [Math.sin(p.yaw), Math.cos(p.yaw)], d = [at[0] - p.position[0]!, at[1] - p.position[2]!], l = Math.hypot(d[0]!, d[1]!);
    return (f[0]! * d[0]! + f[1]! * d[1]!) / l;
  };

  it("exposes the layout anchors: structures, their fronts, the approach end; the routes as lanes", () => {
    const map = camp();
    const ids = map.anchors.map((a) => a.id);
    expect(ids).toContain("core/structure-hut");
    expect(ids).toContain("core/front-hut");
    expect(ids).toContain("core/approach-end");
    expect(map.levels[0]!.paths.map((p) => p.id)).toEqual(["approach"]);
    // the hearth anchor carries its size: the fire's edge is where the seats measure from
    expect(map.anchors.find((a) => a.id === "core/fire")?.size?.[0]).toBe(2);
  });

  it("lays a camp round its fire: seats 1.2-1.8 m off its edge facing in, bedrolls 3-5 m out facing it, the kit beside a bedroll", () => {
    const items = [
      ...[1, 2, 3, 4].map((i) => ({ id: `log-${i}`, prop: "log", place: { kind: "auto", room: "core", arrangement: "camp" } })),
      ...[1, 2].map((i) => ({ id: `bed-${i}`, prop: "bedroll", place: { kind: "auto", room: "core", arrangement: "camp" } })),
      { id: "kit-1", prop: "crate", place: { kind: "auto", room: "core", arrangement: "camp" } },
    ];
    const r = go({ arrangements: [{ id: "camp", kind: "camp", room: "core", anchor: "kind:hearth" }], items });
    // (density by area is its own test: 7-8 props on 700 m² are under the camp floor)
    const vs = r.violations.filter((v) => v.code !== "site-sparse");
    expect(vs, JSON.stringify(vs.slice(0, 3))).toEqual([]);
    const fire: [number, number] = [2, 3];
    const off = (id: string, half: number): number => Math.hypot(pos(r, id).position[0] - fire[0], pos(r, id).position[2] - fire[1]) - 1 - half;
    const seatAng: number[] = [];
    for (const i of [1, 2, 3, 4]) {
      const g = off(`log-${i}`, 0.7);
      expect(g).toBeGreaterThanOrEqual(1.2 - 1e-6);
      expect(g).toBeLessThanOrEqual(1.8 + 1e-6);
      expect(faces(pos(r, `log-${i}`), fire)).toBeGreaterThan(0.7);
      seatAng.push(Math.atan2(pos(r, `log-${i}`).position[2] - fire[1], pos(r, `log-${i}`).position[0] - fire[0]));
    }
    // spread round the fire, not bunched: every pair of seats at least 40 degrees apart
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(Math.abs(Math.atan2(Math.sin(seatAng[i]! - seatAng[j]!), Math.cos(seatAng[i]! - seatAng[j]!)))).toBeGreaterThan((40 * Math.PI) / 180);
    for (const i of [1, 2]) {
      const g = off(`bed-${i}`, 1.0);
      expect(g).toBeGreaterThanOrEqual(3 - 1e-6);
      expect(g).toBeLessThanOrEqual(5 + 1e-6);
      expect(faces(pos(r, `bed-${i}`), fire)).toBeGreaterThan(0.7);
    }
    const kit = pos(r, "kit-1"), beds = [1, 2].map((i) => pos(r, `bed-${i}`));
    expect(Math.min(...beds.map((b) => Math.hypot(b.position[0] - kit.position[0], b.position[2] - kit.position[2])))).toBeLessThan(2.5);
    expect(r.auto?.find((a) => a.item === "log-1")?.note).toMatch(/^camp camp: seat/);
  });

  it("spreads unanchored vignettes over the area, apart from each other and 2 m off the approach lane", () => {
    const items = [
      ...[1, 2, 3].map((i) => ({ id: `rack-${i}`, prop: "rack", place: { kind: "auto", room: "core", arrangement: "work" } })),
      ...[1, 2, 3].map((i) => ({ id: `heap-${i}`, prop: "heap", place: { kind: "auto", room: "core", arrangement: "midden" } })),
      ...[1, 2].map((i) => ({ id: `log-${i}`, prop: "log", place: { kind: "auto", room: "core", arrangement: "camp" } })),
    ];
    const r = go({ arrangements: [{ id: "work", kind: "work-line", room: "core" }, { id: "midden", kind: "midden", room: "core" }, { id: "camp", kind: "camp", room: "core", anchor: "kind:hearth" }], items });
    // (density by area is its own test: 7-8 props on 700 m² are under the camp floor)
    const vs = r.violations.filter((v) => v.code !== "site-sparse");
    expect(vs, JSON.stringify(vs.slice(0, 3))).toEqual([]);
    const centre = (pre: string): [number, number] => {
      const ps = r.placements.filter((p) => p.id.startsWith(pre));
      return [ps.reduce((a, p) => a + p.position[0], 0) / ps.length, ps.reduce((a, p) => a + p.position[2], 0) / ps.length];
    };
    const cs = [centre("rack"), centre("heap"), [2, 3] as [number, number]];
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.hypot(cs[i]![0] - cs[j]![0], cs[i]![1] - cs[j]![1])).toBeGreaterThan(5);
    // the racks stand in a line, 1.5-2.5 m apart, all facing one way
    const racks = [1, 2, 3].map((i) => pos(r, `rack-${i}`));
    expect(new Set(racks.map((p) => Math.round(p.yaw * 100))).size).toBe(1);
    for (let i = 1; i < 3; i++) {
      const g = Math.hypot(racks[i]!.position[0] - racks[i - 1]!.position[0], racks[i]!.position[2] - racks[i - 1]!.position[2]);
      expect(g).toBeGreaterThanOrEqual(1.5 - 1e-6);
      expect(g).toBeLessThanOrEqual(2.5 + 1e-6);
    }
    // the midden stands at the back: farther from where the approach enters than the area's middle
    const entry = camp().anchors.find((a) => a.id === "core/approach-end")!.position;
    expect(Math.hypot(cs[1]![0] - entry[0]!, cs[1]![1] - entry[2]!)).toBeGreaterThan(Math.hypot(entry[0]!, entry[2]!));
    // 2 m off the approach lane's edge (its 1.2 m half width): the lane is x = -9 (z -20..-4), then z = -4 (x -9..0)
    const seg = (x: number, z: number, a: [number, number], b: [number, number]): number => {
      const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
    };
    for (const p of r.placements.filter((q) => /^(rack|heap)/.test(q.id)))
      expect(Math.min(seg(p.position[0], p.position[2], [-9, -20], [-9, -4]), seg(p.position[0], p.position[2], [-9, -4], [0, -4])) - 1.2).toBeGreaterThan(2 - 1e-6);
  });

  it("refuses a heap of loose props in one patch (site-spread, site-clutter) and too few for the area (site-sparse)", () => {
    const heap = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, prop: "boulder", place: { kind: "floor", level: 0, at: [8 + (i % 3) * 1.3, 4 + Math.floor(i / 3) * 1.3], yaw: 0 } }));
    const codes = go({ items: heap }).violations.map((v) => v.code);
    expect(codes).toContain("site-spread");
    expect(codes).toContain("site-clutter");
    expect(go({ items: heap.slice(0, 2) }).violations.map((v) => v.code)).toContain("site-sparse");
  });

  it("keeps the front of a door clear (opening-clear); camp seats face the fire (facing-sense)", () => {
    const map = buildSiteSocketMap(
      { id: "camp", areas: [{ id: "core", role: "camp", centre: [0, 0], radius: 12 }], anchors: [{ id: "tent-door", kind: "door", at: [0, 6], facing: [0, -1] }, { id: "fire", kind: "hearth", at: [0, -2], radius: 1 }], keep: [], blockers: [] },
      flat,
    ).map;
    expect(go({ items: [{ id: "c", prop: "crate", place: { kind: "floor", level: 0, at: [0, 5.3], yaw: 0 } }] }, map).violations.map((v) => v.code)).toContain("opening-clear");
    expect(go({ items: [{ id: "c", prop: "crate", place: { kind: "floor", level: 0, at: [3, 5.3], yaw: 0 } }] }, map).violations.map((v) => v.code)).not.toContain("opening-clear");
    const laid = go({ arrangements: [{ id: "camp", kind: "camp", room: "core", anchor: "kind:hearth" }], items: [1, 2].map((i) => ({ id: `log-${i}`, prop: "log", place: { kind: "auto", room: "core", arrangement: "camp" } })) }, map);
    expect(laid.violations.filter((v) => v.code === "facing-sense" || v.code === "opening-clear")).toEqual([]);
    expect(laid.placements.length).toBe(2);
  });
});

describe("camp rules (Derek 2026-10-31): tents face the fire, gear kept under cover", () => {
  const flat = { ground: () => 10, water: () => null };
  const camp = () => buildSiteSocketMap({ id: "camp", areas: [{ id: "core", role: "camp", centre: [0, 0], radius: 18 }], anchors: [], keep: [], blockers: [] }, flat).map;
  const PROPS: Record<string, DressingData> = {
    fire: dressingSchema.parse({ mount: "floor", size: [1.2, 0.6, 1.2], against: "free", setting: "outdoor", fire: true, rooms: ["camp"] }) as DressingData,
    // a tent whose way in is its local +x side
    tent: dressingSchema.parse({ mount: "floor", size: [4, 3, 4], against: "free", setting: "outdoor", rooms: ["camp"], facesCentre: "+x", shelter: true }) as DressingData,
    jar: dressingSchema.parse({ mount: "floor", size: [0.5, 0.8, 0.5], against: "free", setting: "outdoor", rooms: ["camp"], underCover: true }) as DressingData,
  };
  const go = (items: { id: string; prop: string; place: Record<string, unknown> }[]) =>
    resolveDressing({ map: camp(), plan: { id: "c", map: "camp", rooms: { core: { role: "camp", also: [], owner: "" } }, items: items.map((i) => ({ set: "", note: "", ...i })) }, prop: (id: string) => PROPS[id], set: () => undefined, options: { minItems: () => 0 } } as never);
  const codes = (r: { violations: { code: string; item: string }[] }, code: string) => r.violations.filter((v) => v.code === code).map((v) => v.item);

  it("faces-centre: a tent whose entrance turns from the fire is refused with the yaw to use; one facing it passes", () => {
    // tent 8 m west of the fire: +x must point east (+x world) -> yaw 0 passes; yaw 90 turns +x to -z (90 deg off)
    const ok = go([{ id: "f", prop: "fire", place: { kind: "floor", level: 0, at: [0, 0], yaw: 0 } }, { id: "t", prop: "tent", place: { kind: "floor", level: 0, at: [-8, 0], yaw: 0 } }]);
    expect(codes(ok, "faces-centre")).toEqual([]);
    const bad = go([{ id: "f", prop: "fire", place: { kind: "floor", level: 0, at: [0, 0], yaw: 0 } }, { id: "t", prop: "tent", place: { kind: "floor", level: 0, at: [-8, 0], yaw: 90 } }]);
    expect(codes(bad, "faces-centre")).toEqual(["t"]);
    expect(bad.violations.find((v) => v.code === "faces-centre")!.message).toMatch(/"yaw": 0\b/);
  });

  it("under-cover: a jar in the open is refused; one at the tent's mouth or inside it passes", () => {
    const base = [{ id: "f", prop: "fire", place: { kind: "floor", level: 0, at: [0, 0], yaw: 0 } }, { id: "t", prop: "tent", place: { kind: "floor", level: 0, at: [-8, 0], yaw: 0 } }];
    expect(codes(go([...base, { id: "j", prop: "jar", place: { kind: "floor", level: 0, at: [6, 6], yaw: 0 } }]), "under-cover")).toEqual(["j"]);
    // the mouth: the tent's +x side middle is (-6, 0); 0.5 m outside it is (-5.5, 0); the jar 1.5 m south of that
    expect(codes(go([...base, { id: "j", prop: "jar", place: { kind: "floor", level: 0, at: [-5.5, 1.5], yaw: 0 } }]), "under-cover")).toEqual([]);
    expect(codes(go([{ id: "j", prop: "jar", place: { kind: "floor", level: 0, at: [6, 6], yaw: 0 } }]), "under-cover")).toEqual(["j"]); // no shelter at all
    // in the open ON PURPOSE, with its reason: accepted and warned (in-open)
    const off = go([...base, { id: "j", prop: "jar", inOpen: "an offering at the captive feet", place: { kind: "floor", level: 0, at: [6, 6], yaw: 0 } } as never]);
    expect(codes(off, "under-cover")).toEqual([]);
    expect((off as never as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toContain("in-open");
  });
});
