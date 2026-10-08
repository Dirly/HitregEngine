import { describe, expect, it } from "vitest";
import {
  cultureFits,
  dressingPlanSchema,
  dressingSchema,
  mergeVocabulary,
  resolveDressing,
  scaleFits,
  socketMapSchema,
  type DressingData,
  type DressingInput,
  type DressingPlanInput,
  type DressingResolveResult,
} from "../src/index.js";

/*
 * One 16 x 16 m hall at 0.5 m cells (34 x 34 incl. the wall ring), 6 m ceiling, walls N/S/E/W with full spans.
 * A walking path ('x') runs north-south along x = 2.0..2.5 when `withPath` is set.
 */
const STEP = 0.5, N = 34;
function hall(withPath = false) {
  const cells: string[] = [], head: string[] = [], room: string[] = [];
  for (let r = 0; r < N; r++) {
    let c0 = "", h0 = "", r0 = "";
    for (let c = 0; c < N; c++) {
      const wall = r === 0 || c === 0 || r === N - 1 || c === N - 1;
      const ch = wall ? "#" : withPath && c === 5 ? "x" : ".";
      c0 += ch;
      h0 += wall ? "." : "o"; // base 36: 24 quarter metres = 6 m
      r0 += wall ? "." : "0";
    }
    cells.push(c0);
    head.push(h0);
    room.push(r0);
  }
  const lo = STEP, hi = (N - 1) * STEP;
  return socketMapSchema.parse({
    id: "hall",
    levels: [
      {
        level: 0, floorY: 0, origin: [0, 0], step: STEP, columns: N, rows: N, cells, head, room,
        rooms: [{ id: "H", index: 0, area: 256, centre: [8.5, 8.5], bbox: [lo, hi, lo, hi], minHead: 6, maxHead: 6 }],
        walls: [
          { id: "H.S", room: "H", a: [lo, lo], b: [hi, lo], normal: [0, 1], spans: [[0, 16]], height: 6 },
          { id: "H.N", room: "H", a: [hi, hi], b: [lo, hi], normal: [0, -1], spans: [[0, 16]], height: 6 },
          { id: "H.W", room: "H", a: [lo, hi], b: [lo, lo], normal: [1, 0], spans: [[0, 16]], height: 6 },
          { id: "H.E", room: "H", a: [hi, lo], b: [hi, hi], normal: [-1, 0], spans: [[0, 16]], height: 6 },
        ],
        paths: withPath ? [{ id: "p", name: "the walk down the hall", width: 0.5, points: [[2.75, 0.5], [2.75, 16.5]] }] : [],
      },
    ],
  });
}

const decl = (d: DressingInput): DressingData => dressingSchema.parse(d);
const PROPS: Record<string, DressingData> = {
  "giant/bench": decl({ mount: "floor", size: [4, 1.5, 1.4], against: "either", scale: "giant", cultures: ["giant"] }),
  "giant/bonfire": decl({ mount: "floor", size: [3, 2, 3], against: "free", scale: "giant", cultures: ["giant"], centrepiece: true }),
  "giant/rack": decl({ mount: "floor", size: [2, 3, 1], against: "free", scale: "giant", cultures: ["giant"] }),
  "human/grindstone": decl({ mount: "floor", size: [1, 1, 1], against: "either", scale: "human", cultures: ["rural"] }),
  "human/lantern": decl({ mount: "floor", size: [0.4, 2, 0.4], against: "either", scale: "human", cultures: ["civic", "rural"] }),
  "any/bones": decl({ mount: "floor", size: [1.5, 0.4, 1.2], against: "either", scale: "any", cultures: ["any"] }),
  "rural/sack": decl({ mount: "floor", size: [0.8, 0.7, 0.6], against: "either", scale: "human", cultures: ["rural"], loose: false }),
  "plain/box": decl({ mount: "floor", size: [1, 1, 1], against: "either" }),
  "giant/hide": decl({ mount: "wall", size: [3, 3, 0.2], wallHeight: [0.5, 2], scale: "giant", cultures: ["giant"] }),
};
const GIANT = { kind: "dungeon" as const, scale: "giant", cultures: ["giant"] };

function run(items: DressingPlanInput["items"], extra: Partial<DressingPlanInput> = {}, opts: { withPath?: boolean; decals?: Parameters<typeof resolveDressing>[0]["decals"] } = {}): DressingResolveResult {
  const plan = dressingPlanSchema.parse({ id: "t", map: "hall", rooms: { H: { role: "hall" } }, items, ...extra });
  return resolveDressing({ plan, map: hall(opts.withPath), prop: (id) => PROPS[id], set: () => undefined, options: { minItems: () => 1 }, ...(opts.decals ? { decals: opts.decals } : {}) });
}
const codes = (r: DressingResolveResult) => r.violations.map((v) => v.code);

describe("prop scale classes and cultures", () => {
  it("the vocabulary is data: a project adds a class and its own acceptance", () => {
    const v = mergeVocabulary({ scales: [{ id: "colossal", height: 9, accepts: ["giant"], note: "titans" }], cultures: [{ id: "frogkin", note: "", accepts: ["wild"] }] });
    expect(v.scales.map((s) => s.id)).toEqual(expect.arrayContaining(["small", "human", "large", "giant", "colossal", "any"]));
    expect(scaleFits(v, "colossal", "giant")).toBe(true);
    expect(scaleFits(v, "giant", "human")).toBe(false);
    expect(scaleFits(v, "giant", "any")).toBe(true);
    expect(cultureFits(v, ["frogkin"], ["wild"])).toBe(true);
    expect(cultureFits(v, ["giant"], ["civic", "rural"])).toBe(false);
    expect(cultureFits(v, ["bandit"], ["rural"])).toBe(true); // a bandit camp uses stolen rural goods
    expect(cultureFits(v, [], ["civic"])).toBe(true);
  });

  it("a giant place refuses human-scale and wrong-culture props, takes giant and any", () => {
    const r = run(
      [
        { id: "bench", prop: "giant/bench", place: { kind: "wall", wall: "H.S", t: 4 } },
        { id: "grind", prop: "human/grindstone", place: { kind: "wall", wall: "H.S", t: 10 } },
        { id: "lamp", prop: "human/lantern", place: { kind: "wall", wall: "H.W", t: 4 } },
        { id: "bones", prop: "any/bones", place: { kind: "wall", wall: "H.N", t: 4 } },
      ],
      { space: GIANT },
    );
    const bad = r.violations.filter((v) => v.code === "wrong-scale" || v.code === "wrong-culture");
    expect(bad.map((v) => `${v.item}:${v.code}`).sort()).toEqual(["grind:wrong-culture", "grind:wrong-scale", "lamp:wrong-culture", "lamp:wrong-scale"]);
    expect(r.review!.find((x) => x.room === "H")).toMatchObject({ scaleViolations: 2, cultureViolations: 2 });
  });

  it("undeclared props are warned, not refused; a room may override the space", () => {
    const r = run([{ id: "box", prop: "plain/box", place: { kind: "wall", wall: "H.S", t: 4 } }], { space: GIANT });
    expect(codes(r)).not.toContain("wrong-scale");
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["scale-undeclared", "culture-undeclared"]));
    const r2 = run([{ id: "sack", prop: "rural/sack", place: { kind: "wall", wall: "H.S", t: 4 } }], {
      space: GIANT,
      rooms: { H: { role: "storage", scale: "human", cultures: ["bandit"] } } as never,
    });
    expect(codes(r2)).not.toContain("wrong-scale");
    expect(codes(r2)).not.toContain("wrong-culture");
  });
});

describe("placement rules: walls first, middle clear", () => {
  it("a dungeon room refuses a solid prop in its keep-clear centre unless it is a centrepiece or set piece", () => {
    const r = run([{ id: "rack", prop: "giant/rack", place: { kind: "floor", at: [8.5, 8.5], yaw: 0 } }], { space: GIANT });
    expect(codes(r)).toContain("centre-clutter");
    const rv = r.review![0]!;
    expect(rv.centreM2).toBeGreaterThan(20);
    expect(rv.centreItems).toEqual(["rack"]);
    expect(rv.centreClutter).toBeGreaterThan(50);
    expect(codes(run([{ id: "fire", prop: "giant/bonfire", place: { kind: "floor", at: [8.5, 8.5], yaw: 0 } }], { space: GIANT }))).not.toContain("centre-clutter");
    expect(codes(run([{ id: "rack", prop: "giant/rack", setPiece: true, place: { kind: "floor", at: [8.5, 8.5], yaw: 0 } }], { space: GIANT }))).not.toContain("centre-clutter");
  });

  it("a building leaves the centre to the designer but the review still scores it", () => {
    const r = run([{ id: "rack", prop: "giant/rack", place: { kind: "floor", at: [8.5, 8.5], yaw: 0 } }]);
    expect(codes(r)).not.toContain("centre-clutter");
    expect(r.review![0]).toMatchObject({ keepCentre: false, centreItems: ["rack"] });
  });

  it("auto 'open' in a dungeon hugs the room edge instead of the middle", () => {
    const r = run([{ id: "rack", prop: "giant/rack", place: { kind: "auto", room: "H", prefer: "open" } }], { space: GIANT });
    expect(r.violations).toEqual([]);
    const p = r.placements[0]!;
    const edge = Math.min(p.position[0] - 0.5, 16.5 - p.position[0], p.position[2] - 0.5, 16.5 - p.position[2]);
    expect(edge).toBeLessThan(2);
    expect(r.review![0]!.wallShare).toBe(1);
    // the same plan in a building takes the most open spot: the middle
    const b = run([{ id: "rack", prop: "giant/rack", place: { kind: "auto", room: "H", prefer: "open" } }]);
    expect(Math.hypot(b.placements[0]!.position[0] - 8.5, b.placements[0]!.position[2] - 8.5)).toBeLessThan(3);
  });

  it("dungeon walk lines keep a margin; a building only forbids standing on them", () => {
    const at: [number, number] = [3.6, 8]; // 1.2 m across x: edge at 3.0 where the path cells end
    const items = [{ id: "box", prop: "any/bones", place: { kind: "floor" as const, at, yaw: 90 } }];
    expect(codes(run(items, { space: GIANT }, { withPath: true }))).toContain("path-margin");
    expect(codes(run(items, {}, { withPath: true }))).not.toContain("path-margin");
  });
});

describe("overlap with placed geometry and decals", () => {
  it("no prop overlaps placed geometry, and auto places avoid it", () => {
    const obstacles = [{ id: "statue-1", at: [4.5, 1.5] as [number, number], size: [2, 2] as [number, number], height: 5, note: "frozen dead" }];
    const r = run([{ id: "bench", prop: "giant/bench", place: { kind: "wall", wall: "H.S", t: 4 } }], { obstacles } as never);
    expect(codes(r)).toContain("overlaps-geometry");
    const a = run([{ id: "bench", prop: "giant/bench", place: { kind: "auto", room: "H", prefer: "wall", wall: "H.S" } }], { obstacles } as never);
    expect(a.violations).toEqual([]);
  });

  it("a decal is never under a prop: floor decal under a bench, wall decal over a hung hide", () => {
    const decals = [
      { id: "blood", position: [4.5, 0.2, 1.2] as [number, number, number], direction: [0, -1, 0] as [number, number, number], size: [1.5, 1.5] as [number, number], depth: 0.8, label: "blood" },
      { id: "soot", position: [0.7, 2.5, 4.5] as [number, number, number], direction: [-1, 0, 0] as [number, number, number], size: [3, 3] as [number, number], depth: 1.6, label: "soot" },
    ];
    const r = run(
      [
        { id: "bench", prop: "giant/bench", place: { kind: "wall", wall: "H.S", t: 4 } },
        { id: "hide", prop: "giant/hide", place: { kind: "wall", wall: "H.W", t: 12, height: 1 } },
        { id: "far", prop: "giant/bench", place: { kind: "wall", wall: "H.N", t: 8 } },
      ],
      {},
      { decals },
    );
    expect(r.violations.filter((v) => v.code === "decal-overlap").map((v) => v.item).sort()).toEqual(["bench", "hide"]);
  });
});
