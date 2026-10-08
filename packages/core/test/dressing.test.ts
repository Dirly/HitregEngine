import { describe, expect, it } from "vitest";
import {
  dressingPlanSchema,
  dressingSchema,
  dressingSetSchema,
  defaultMinItems,
  circulate,
  placeableFloor,
  roomBudget,
  standStretches,
  describeSetShape,
  DEFAULT_LANE_WIDTH,
  resolveDressing,
  socketMapSchema,
  type DressingData,
  type DressingInput,
  type DressingPlanInput,
  type DressingResolveResult,
  type DressingSet,
} from "../src/index.js";

/*
 * Synthetic space, 8 x 6 m at 0.25 m cells (32 columns x 24 rows), one level:
 *   room A (index 0): x 0.25..4.0, z 0.25..5.75, 3 m ceiling; outside door in the south wall at x 1..2
 *   room B (index 1): x 4.25..7.75, z 0.25..5.75, 5.5 m ceiling; stair along the east wall at z 3.5..5.75
 *   a doorway through the dividing wall (x 4.0..4.25) at z 2.5..3.5
 */
const STEP = 0.25, COLS = 32, ROWS = 24;
function buildMap() {
  const cells: string[] = [], head: string[] = [], room: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    let c0 = "", h0 = "", r0 = "";
    for (let c = 0; c < COLS; c++) {
      let ch = ".", rm = ".";
      const border = r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1;
      if (border) ch = r === 0 && c >= 4 && c <= 7 ? "E" : "#";
      else if (c === 16) ch = r >= 10 && r <= 13 ? "D" : "#";
      else if (c < 16 && c >= 4 && c <= 7 && r <= 2) ch = "E";
      else if (c >= 27 && r >= 14) ch = "S";
      if (ch === "." || ch === "S") rm = c < 16 ? "0" : "1";
      c0 += ch;
      r0 += rm;
      h0 += ch === "#" ? "." : c < 16 ? "c" : "m";
    }
    cells.push(c0);
    head.push(h0);
    room.push(r0);
  }
  return socketMapSchema.parse({
    id: "zt-house",
    entry: { position: [1.5, 0], facing: [0, 1] },
    levels: [
      {
        level: 0,
        floorY: 0,
        origin: [0, 0],
        step: STEP,
        columns: COLS,
        rows: ROWS,
        cells,
        head,
        room,
        rooms: [
          { id: "A", index: 0, area: 20, centre: [2.1, 3], bbox: [0.25, 4, 0.25, 5.75], minHead: 3, maxHead: 3 },
          { id: "B", index: 1, area: 17, centre: [6, 3], bbox: [4.25, 7.75, 0.25, 5.75], minHead: 5.5, maxHead: 5.5 },
        ],
        walls: [
          { id: "A.S", room: "A", a: [0.25, 0.25], b: [4, 0.25], normal: [0, 1], spans: [[0, 0.75], [1.75, 3.75]], height: 3 },
          { id: "A.N", room: "A", a: [0.25, 5.75], b: [4, 5.75], normal: [0, -1], spans: [[0, 3.75]], height: 3 },
          { id: "A.W", room: "A", a: [0.25, 0.25], b: [0.25, 5.75], normal: [1, 0], spans: [[0, 5.5]], height: 3 },
          { id: "A.E", room: "A", a: [4, 0.25], b: [4, 5.75], normal: [-1, 0], spans: [[0, 2.25], [3.25, 5.5]], height: 3 },
          { id: "B.S", room: "B", a: [4.25, 0.25], b: [7.75, 0.25], normal: [0, 1], spans: [[0, 3.5]], height: 5.5 },
          { id: "B.N", room: "B", a: [4.25, 5.75], b: [7.75, 5.75], normal: [0, -1], spans: [[0, 2.5]], height: 5.5 },
        ],
      },
    ],
    anchors: [{ id: "hearth", kind: "hearth", position: [0.6, 0, 3.8], yaw: 90, mount: "floor" }],
  });
}
const MAP = buildMap();

const P: Record<string, DressingInput> = {
  table: { mount: "floor", size: [1.2, 0.75, 0.8], against: "free", provides: [{ id: "top", kind: "surface", position: [0, 0.75, 0], size: [1.1, 0.7], capacity: 6 }] },
  desk: { mount: "floor", size: [1.0, 0.8, 0.6], provides: [{ id: "top", kind: "surface", position: [0, 0.8, 0], size: [0.9, 0.5] }] },
  chair: { mount: "floor", size: [0.45, 0.9, 0.45] },
  paper: { mount: "surface", size: [0.3, 0.01, 0.21], fits: ["paper"] },
  dresser: {
    mount: "floor",
    against: "wall",
    size: [1.0, 0.9, 0.5],
    provides: [
      { id: "top", kind: "surface", position: [0, 0.9, 0], size: [0.9, 0.4] },
      { id: "bay", kind: "slot", position: [0, 0.5, 0.05], accepts: ["drawer"] },
    ],
  },
  drawer: { mount: "slot", slotKind: "drawer", size: [0.8, 0.2, 0.4] },
  wardrobe: { mount: "floor", against: "wall", size: [1.2, 2.0, 0.6], clearance: 0.6 },
  crate: { mount: "floor", size: [0.6, 0.6, 0.6] },
  "long-crate": { mount: "floor", size: [1.6, 1.0, 0.6] },
  chandelier: { mount: "ceiling", size: [1.0, 0.8, 1.0], chain: "chain-link", fire: true },
  "chain-link": { mount: "part", size: [0.05, 1, 0.05] },
  painting: { mount: "wall", size: [0.8, 0.6, 0.05] },
};
const PROPS = new Map<string, DressingData>(Object.entries(P).map(([k, v]) => [k, dressingSchema.parse(v)]));
const SETS = new Map<string, DressingSet>([
  [
    "desk-set",
    dressingSetSchema.parse({
      id: "desk-set",
      footprint: [1.0, 1.2],
      items: [
        { id: "desk", prop: "desk", place: { kind: "floor", at: [0, 0] } },
        { id: "chair", prop: "chair", place: { kind: "floor", at: [0, 0.5], yaw: 180 } },
        { id: "letter", prop: "paper", place: { kind: "on", item: "desk" } },
      ],
    }),
  ],
]);

function run(items: DressingPlanInput["items"], minItems = (_: number) => 0): DressingResolveResult {
  const plan = dressingPlanSchema.parse({ id: "zt", map: "zt-house", rooms: { A: { role: "office" }, B: { role: "hall" } }, items });
  return resolveDressing({ plan, map: MAP, prop: (id) => PROPS.get(id), set: (id) => SETS.get(id), options: { minItems } });
}
const codes = (r: DressingResolveResult, item: string) => r.violations.filter((v) => v.item === item).map((v) => v.code);
const wcodes = (r: DressingResolveResult, item: string) => r.warnings.filter((v) => v.item === item).map((v) => v.code);
const at = (r: DressingResolveResult, id: string) => r.placements.find((p) => p.id === id)!;

describe("resolveDressing", () => {
  it("puts paper on a table top at the table's height", () => {
    const r = run([
      { id: "t", prop: "table", place: { kind: "floor", at: [2, 3] } },
      { id: "p", prop: "paper", place: { kind: "on", item: "t" } },
    ]);
    expect(codes(r, "p")).toEqual([]);
    expect(codes(r, "t")).toEqual([]);
    const p = at(r, "p");
    expect(p.position[1]).toBeCloseTo(0.75);
    expect(p.position[0]).toBeCloseTo(2);
    expect(p.position[2]).toBeCloseTo(3);
    expect(p.room).toBe("A");
  });

  it("refuses paper on the floor", () => {
    const r = run([{ id: "p", prop: "paper", place: { kind: "floor", at: [2, 3] } }]);
    expect(codes(r, "p")).toContain("mount-mismatch");
    expect(r.placements.find((x) => x.id === "p")).toBeUndefined();
  });

  it("accepts a loose drawer only in a dresser's slot", () => {
    const r = run([
      { id: "d", prop: "dresser", place: { kind: "wall", wall: "A.W", t: 3 } },
      { id: "t", prop: "table", place: { kind: "floor", at: [2.5, 1.8] } },
      { id: "in-dresser", prop: "drawer", place: { kind: "on", item: "d" } },
      { id: "on-table", prop: "drawer", place: { kind: "on", item: "t" } },
      { id: "on-floor", prop: "drawer", place: { kind: "floor", at: [2, 4.5] } },
    ]);
    expect(codes(r, "in-dresser")).toEqual([]);
    expect(codes(r, "on-table")).toContain("no-socket");
    expect(codes(r, "on-floor")).toContain("mount-mismatch");
    // Dresser back on x = 0.25 facing +X; its slot is 0.05 m in front of its foot, 0.5 m up.
    const dr = at(r, "in-dresser");
    expect(dr.position[0]).toBeCloseTo(0.25 + 0.25 + 0.05);
    expect(dr.position[1]).toBeCloseTo(0.5);
    expect(dr.position[2]).toBeCloseTo(3.25);
    expect(dr.yaw).toBeCloseTo(Math.PI / 2);
  });

  it("refuses a wall-backed wardrobe in open floor and lands it flush on a wall span", () => {
    const open = run([{ id: "w", prop: "wardrobe", place: { kind: "floor", at: [2, 3] } }]);
    expect(codes(open, "w")).toContain("needs-wall");
    expect(open.violations.find((v) => v.code === "needs-wall")!.message).toMatch(/kind: "wall"/);
    const ok = run([{ id: "w", prop: "wardrobe", place: { kind: "wall", wall: "A.N", t: 1.5 } }]);
    expect(codes(ok, "w")).toEqual([]);
    const w = at(ok, "w");
    expect(w.position[0]).toBeCloseTo(1.75);
    expect(w.position[2]).toBeCloseTo(5.75 - 0.3); // back flush to z = 5.75
    expect(Math.abs(w.yaw)).toBeCloseTo(Math.PI); // faces -Z, into the room
    const span = run([{ id: "w", prop: "wardrobe", place: { kind: "wall", wall: "A.S", t: 1.2 } }]);
    expect(codes(span, "w")).toContain("no-span");
  });

  it("refuses an item 0.4 m from a stair and warns at 0.9 m", () => {
    const near = run([{ id: "c", prop: "crate", place: { kind: "floor", at: [6.05, 4.5] } }]);
    expect(codes(near, "c")).toContain("stair-buffer");
    expect(near.violations.find((v) => v.code === "stair-buffer")!.message).toMatch(/0\.40 m/);
    const mid = run([{ id: "c", prop: "crate", place: { kind: "floor", at: [5.55, 4.5] } }]);
    expect(codes(mid, "c")).toEqual([]);
    expect(wcodes(mid, "c")).toContain("stair-buffer");
  });

  it("hangs a chandelier on a chain and emits links up to the ceiling, the last scaled", () => {
    const r = run([{ id: "ch", prop: "chandelier", place: { kind: "ceiling", at: [5.5, 2], drop: 1.5 } }]);
    expect(codes(r, "ch")).toEqual([]);
    const ch = at(r, "ch");
    expect(ch.position[1]).toBeCloseTo(5.5 - 1.5); // top origin at the drop
    const links = r.placements.filter((p) => p.id.startsWith("ch/chain-"));
    expect(links.map((l) => l.prop)).toEqual(["chain-link", "chain-link"]);
    expect(links[0]!.position[1]).toBeCloseTo(4); // `part` -> foot origin
    expect(links[0]!.scale).toBeUndefined();
    expect(links[1]!.position[1]).toBeCloseTo(5);
    expect(links[1]!.scale).toEqual([1, 0.5, 1]);
    const flush = run([{ id: "c", prop: "crate", place: { kind: "ceiling", at: [5.5, 2] } }]);
    expect(codes(flush, "c")).toContain("mount-mismatch");
  });

  it("expands a set and lands its paper on its own desk", () => {
    const r = run([{ id: "study", set: "desk-set", place: { kind: "floor", at: [2, 2.5] } }]);
    expect(r.violations.filter((v) => v.item.startsWith("study"))).toEqual([]);
    expect(r.placements.map((p) => p.id)).toEqual(["study/desk", "study/chair", "study/letter"]);
    const desk = at(r, "study/desk"), letter = at(r, "study/letter"), chair = at(r, "study/chair");
    expect(letter.position[0]).toBeCloseTo(desk.position[0]);
    expect(letter.position[2]).toBeCloseTo(desk.position[2]);
    expect(letter.position[1]).toBeCloseTo(0.8);
    expect(chair.position[2]).toBeCloseTo(3.0);
    expect(Math.abs(chair.yaw)).toBeCloseTo(Math.PI);
  });

  it("reports the item that seals a doorway", () => {
    const r = run([{ id: "plug", prop: "long-crate", place: { kind: "floor", at: [4.6, 3], yaw: 90 } }]);
    const route = r.violations.filter((v) => v.code === "blocks-route");
    expect(route.length).toBeGreaterThan(0);
    expect(route.every((v) => v.item === "plug")).toBe(true);
    expect(route.some((v) => /room B/.test(v.message))).toBe(true);
    const free = run([{ id: "c", prop: "crate", place: { kind: "floor", at: [6, 1.5] } }]);
    expect(free.violations.filter((v) => v.code === "blocks-route")).toEqual([]);
  });

  it("finds an empty room and an under-furnished one", () => {
    const r = run([{ id: "t", prop: "table", place: { kind: "floor", at: [2, 3] } }], () => 2);
    expect(codes(r, "B")).toEqual(["room-empty"]);
    expect(codes(r, "A")).toEqual(["room-sparse"]);
  });

  it("checks sockets, overlap, clearance, wall heights, anchors and flames", () => {
    const r = run([
      { id: "w", prop: "wardrobe", place: { kind: "wall", wall: "A.N", t: 1.5 } },
      { id: "c", prop: "crate", place: { kind: "floor", at: [1.75, 4.8] } }, // in the wardrobe's door swing
      { id: "t", prop: "table", place: { kind: "floor", at: [2.5, 2] } },
      { id: "t2", prop: "table", place: { kind: "floor", at: [2.9, 2.2] } }, // overlaps t
      { id: "pic", prop: "painting", place: { kind: "wall", wall: "A.N", t: 1.5, height: 1.5 } }, // over the wardrobe
      { id: "pic2", prop: "painting", place: { kind: "wall", wall: "A.W", t: 1, height: 2.6 } }, // above the wall's top
      { id: "h", prop: "crate", place: { kind: "anchor", anchor: "hearth" } },
      { id: "loop1", prop: "paper", place: { kind: "on", item: "loop2" } },
      { id: "loop2", prop: "paper", place: { kind: "on", item: "loop1" } },
      { id: "ghost", prop: "paper", place: { kind: "on", item: "nothing" } },
      ...[0, 1, 2, 3, 4, 5, 6].map((i) => ({ id: `ch${i}`, prop: "chandelier", place: { kind: "ceiling" as const, at: [4.75 + (i % 4) * 0.8, 1 + Math.floor(i / 4) * 1.2] as [number, number] } })),
    ]);
    expect(codes(r, "c")).toContain("clearance");
    expect(codes(r, "t2")).toContain("overlap");
    expect(codes(r, "pic")).toContain("overlap");
    expect(codes(r, "pic2")).toContain("wall-height");
    expect(codes(r, "h")).toEqual([]);
    expect(at(r, "h").position).toEqual([0.6, 0, 3.8]);
    expect(codes(r, "loop1")).toContain("cycle");
    expect(codes(r, "ghost")).toContain("no-host");
    expect(r.violations.some((v) => v.code === "flame-budget")).toBe(true);
  });

  it("is deterministic", () => {
    const items: DressingPlanInput["items"] = [
      { id: "study", set: "desk-set", place: { kind: "floor", at: [2, 2.5] } },
      { id: "t", prop: "table", place: { kind: "floor", at: [6, 2] } },
      { id: "a", prop: "paper", place: { kind: "on", item: "t" } },
      { id: "b", prop: "paper", place: { kind: "on", item: "t" } },
    ];
    expect(JSON.stringify(run(items))).toBe(JSON.stringify(run(items)));
    const r = run(items);
    expect(at(r, "a").position[0]).toBeLessThan(at(r, "b").position[0]); // arranged left to right
  });
});

describe("wall faces inside the raster's wall cells", () => {
  // 4 x 3 m room, 0.25 m cells; the true inner faces sit 0.15 m (north) and 0.2 m (west) inside the '#' cells.
  const C = 16, R = 12;
  const cells: string[] = [], head: string[] = [], room: string[] = [];
  for (let r = 0; r < R; r++) {
    let a = "", h = "", m = "";
    for (let c = 0; c < C; c++) {
      const wall = r === 0 || c === 0 || r === R - 1 || c === C - 1;
      const entry = r === R - 1 && c >= 6 && c <= 9;
      a += entry ? "E" : wall ? "#" : ".";
      h += wall && !entry ? "." : "c";
      m += wall ? "." : "0";
    }
    cells.push(a);
    head.push(h);
    room.push(m);
  }
  const map = socketMapSchema.parse({
    id: "zt-inset",
    entry: { position: [2, 3], facing: [0, -1] },
    levels: [
      {
        level: 0, floorY: 0, origin: [0, 0], step: 0.25, columns: C, rows: R, cells, head, room,
        rooms: [{ id: "R", index: 0, area: 10, centre: [2, 1.5], bbox: [0.25, 3.75, 0.25, 2.75], minHead: 3, maxHead: 3 }],
        walls: [
          { id: "R.N", room: "R", a: [0.25, 0.1], b: [3.75, 0.1], normal: [0, 1], spans: [[0, 3.5]], height: 3 },
          { id: "R.W", room: "R", a: [0.05, 2.75], b: [0.05, 0.25], normal: [1, 0], spans: [[0, 2.5]], height: 3 },
        ],
      },
    ],
  });
  const go = (items: DressingPlanInput["items"], rooms: DressingPlanInput["rooms"] = { R: { role: "bedroom" } }) =>
    resolveDressing({ plan: dressingPlanSchema.parse({ id: "zt", map: "zt-inset", rooms, items }), map, prop: (id) => PROPS.get(id), set: (id) => SETS.get(id) });

  it("lands wall places flush to the true face without not-free or headroom", () => {
    const r = go([
      { id: "w", prop: "wardrobe", place: { kind: "wall", wall: "R.N", t: 1.5 } },
      { id: "d", prop: "dresser", place: { kind: "wall", wall: "R.W", t: 1.2 } },
      { id: "pic", prop: "painting", place: { kind: "wall", wall: "R.N", t: 3, height: 1.5 } },
    ]);
    for (const id of ["w", "d", "pic"]) expect(codes(r, id)).toEqual([]);
    expect(at(r, "w").position[2]).toBeCloseTo(0.1 + 0.3);
    expect(at(r, "d").position[0]).toBeCloseTo(0.05 + 0.25);
    expect(at(r, "pic").room).toBe("R");
  });

  it("stays strict for floor places and for cells deeper in the wall", () => {
    const r = go([{ id: "c", prop: "crate", place: { kind: "floor", at: [2, 0.35] } }]);
    expect(codes(r, "c")).toContain("not-free");
  });

  it("accepts props tagged for a room's `also` roles", () => {
    const decl = dressingSchema.parse({ mount: "floor", size: [0.6, 0.6, 0.6], rooms: ["kitchen"] });
    PROPS.set("zt-pot", decl);
    const items: DressingPlanInput["items"] = [{ id: "p", prop: "zt-pot", place: { kind: "floor", at: [2, 0.9] } }];
    expect(wcodes(go(items), "p")).toContain("room-role");
    expect(wcodes(go(items, { R: { role: "hall", also: ["kitchen", "storage"] } }), "p")).toEqual([]);
  });

  it("warns about the room role only for floor, wall and ceiling props", () => {
    PROPS.set("zt-cup", dressingSchema.parse({ mount: "surface", size: [0.08, 0.1, 0.08], rooms: ["kitchen"] }));
    const r = go([
      { id: "t", prop: "table", place: { kind: "floor", at: [2, 1.4] } },
      { id: "cup", prop: "zt-cup", place: { kind: "on", item: "t" } },
    ]);
    expect(codes(r, "cup")).toEqual([]);
    expect(wcodes(r, "cup")).toEqual([]);
  });

  it("asks a believable minimum of a room, not padding", () => {
    expect([4, 9, 14, 30, 83, 300].map(defaultMinItems)).toEqual([2, 2, 2, 2, 5, 6]);
    // a 2.4 m² alcove cut off by a pillar holds one piece (Rime Hall hide hall), not two
    expect([0.5, 2.4, 3.9].map(defaultMinItems)).toEqual([1, 1, 1]);
  });
});

describe("hearth clearance ('H' cells)", () => {
  // room A's west wall gets a hearth: the floor x 0.25..1.75, z 3.0..4.5 is kept clear in front of it
  const lv = MAP.levels[0]!;
  const cells = lv.cells.map((row, r) => (r >= 12 && r <= 17 ? row.slice(0, 1) + "H".repeat(6) + row.slice(7) : row));
  const map = socketMapSchema.parse({ ...MAP, id: "zt-hearth", levels: [{ ...lv, cells }] });
  const props = new Map(PROPS);
  props.set("rug", dressingSchema.parse({ mount: "floor", size: [1.2, 0.02, 0.8], solid: false }));
  const go = (items: DressingPlanInput["items"]) =>
    resolveDressing({ plan: dressingPlanSchema.parse({ id: "zt", map: "zt-hearth", rooms: { A: { role: "office" }, B: { role: "hall" } }, items }), map, prop: (id) => props.get(id), set: (id) => SETS.get(id), options: { minItems: () => 0 } });

  it("refuses a solid prop on the clearance and lets a rug lie there", () => {
    const r = go([
      { id: "c", prop: "crate", place: { kind: "floor", at: [1.0, 3.75] } },
      { id: "rug", prop: "rug", place: { kind: "floor", at: [1.0, 3.75] } },
    ]);
    expect(codes(r, "c")).toContain("hearth-clearance");
    expect(codes(r, "c")).not.toContain("not-free");
    expect(codes(r, "rug")).toEqual([]);
  });

  it("warns a solid prop close to it and is silent further away", () => {
    const near = go([{ id: "c", prop: "crate", place: { kind: "floor", at: [2.45, 3.75] } }]);
    expect(codes(near, "c")).toEqual([]);
    expect(wcodes(near, "c")).toContain("hearth-clearance");
    const far = go([{ id: "c", prop: "crate", place: { kind: "floor", at: [3.0, 3.75] } }]);
    expect(wcodes(far, "c")).not.toContain("hearth-clearance");
  });

  it("refuses a wall-backed piece in front of the hearth wall", () => {
    const r = go([{ id: "w", prop: "wardrobe", place: { kind: "wall", wall: "A.W", t: 3.5 } }]);
    expect(codes(r, "w")).toContain("hearth-clearance");
  });
});

describe("a lane the real player fits through", () => {
  const props = new Map(PROPS);
  props.set("stool", dressingSchema.parse({ mount: "floor", size: [0.45, 0.5, 0.45], category: "furniture" }));
  props.set("box", dressingSchema.parse({ mount: "floor", size: [0.6, 0.6, 0.6], category: "storage" }));
  props.set("hearth-fire", dressingSchema.parse({ mount: "floor", size: [0.6, 0.2, 0.6], solid: false, fire: true, anchorKinds: ["hearth"] }));
  props.set("sconce-fire", dressingSchema.parse({ mount: "wall", size: [0.12, 0.3, 0.12], solid: false, fire: true, anchorKinds: ["sconce"] }));
  const go = (items: DressingPlanInput["items"], opts: { laneWidth?: number; map?: typeof MAP; roles?: [string, string] } = {}) =>
    resolveDressing({
      plan: dressingPlanSchema.parse({ id: "zt", map: (opts.map ?? MAP).id, rooms: { A: { role: opts.roles?.[0] ?? "office" }, B: { role: opts.roles?.[1] ?? "hall" } }, items }),
      map: opts.map ?? MAP,
      prop: (id) => props.get(id),
      set: (id) => SETS.get(id),
      options: { minItems: () => 0, ...(opts.laneWidth ? { laneWidth: opts.laneWidth } : {}) },
    });

  it("defaults to the 0.8 m player capsule plus comfort, measured against the real footprint", () => {
    expect(DEFAULT_LANE_WIDTH).toBeCloseTo(0.9);
    // a long crate 0.8 m out from room B's west wall, across the doorway: the only way on is that gap
    const gap = (g: number) => [{ id: "plug", prop: "long-crate", place: { kind: "floor" as const, at: [4.25 + g + 0.3, 3] as [number, number], yaw: 90 } }];
    const tight = go(gap(0.8));
    const cut = tight.violations.filter((v) => v.code === "blocks-route" && /stair/.test(v.message));
    expect(cut.length).toBeGreaterThan(0);
    expect(cut[0]!.item).toBe("plug");
    expect(cut[0]!.message).toMatch(/move plug \(long-crate\)/);
    expect(go(gap(0.8), { laneWidth: 0.75 }).violations.filter((v) => v.code === "blocks-route")).toEqual([]); // the old lane let it pass
    expect(go(gap(1.0)).violations.filter((v) => v.code === "blocks-route")).toEqual([]);
  });

  it("requires a body to reach furniture a person uses, naming what to move", () => {
    const r = go([
      { id: "seat", prop: "stool", place: { kind: "floor", at: [0.6, 5.4] } },
      { id: "b1", prop: "box", place: { kind: "floor", at: [1.4, 5.4] } },
      { id: "b2", prop: "box", place: { kind: "floor", at: [0.6, 4.6] } },
      { id: "b3", prop: "box", place: { kind: "floor", at: [1.4, 4.6] } },
    ], { roles: ["storage", "hall"] });
    const v = r.violations.find((x) => x.code === "unreachable");
    expect(v).toBeDefined();
    expect(v!.message).toMatch(/nobody can get to seat/);
    expect(["b1", "b2", "b3"]).toContain(v!.item);
    const open = go([
      { id: "seat", prop: "stool", place: { kind: "floor", at: [0.6, 5.4] } },
      { id: "b2", prop: "box", place: { kind: "floor", at: [0.6, 4.6] } },
    ]);
    expect(open.violations.filter((x) => x.code === "unreachable")).toEqual([]);
  });

  it("caps how much floor solid props cover and how many loose containers stand on it", () => {
    const tables = [0.9, 2.1, 3.3].flatMap((z, i) => [
      { id: `t${i}a`, prop: "table", place: { kind: "floor" as const, at: [5.0, z] as [number, number] } },
      { id: `t${i}b`, prop: "table", place: { kind: "floor" as const, at: [6.5, z - 0.3] as [number, number] } },
    ]);
    expect(codes(go(tables), "B")).toContain("too-dense");
    const boxes = [1.0, 2.0, 3.0].map((x, i) => ({ id: `box${i}`, prop: "box", place: { kind: "floor" as const, at: [x, 2.0] as [number, number] } }));
    const office = go(boxes);
    expect(codes(office, "A")).toContain("floor-clutter");
    expect(office.violations.find((v) => v.code === "floor-clutter")!.message).toMatch(/budget is 1/);
    expect(codes(go(boxes, { roles: ["storage", "hall"] }), "A")).not.toContain("floor-clutter");
  });

  it("refuses a crate in a stair approach and keeps a lane to it", () => {
    const lv = MAP.levels[0]!;
    // the stair (x >= 6.75, z >= 3.5) is approached from the north: z 2.5..3.5 in front of it is its approach
    const cells = lv.cells.map((row, r) => (r >= 10 && r <= 13 ? row.slice(0, 27) + "AAAA" + row.slice(31) : row));
    const map = socketMapSchema.parse({ ...MAP, id: "zt-stair", levels: [{ ...lv, cells }], anchors: [...MAP.anchors, { id: "foot", kind: "stair-foot", position: [7.25, 0, 3.0], mount: "floor" }] });
    const r = go([{ id: "crate", prop: "crate", place: { kind: "floor", at: [7.25, 3.0] } }], { map });
    expect(codes(r, "crate")).toContain("stair-clearance");
    expect(codes(r, "crate")).not.toContain("not-free");
    const onMark = go([{ id: "crate", prop: "crate", place: { kind: "anchor", anchor: "foot" } }], { map });
    expect(codes(onMark, "crate")).toContain("stair-clearance");
    // beside it, the crate is legal but seals the approach: the route names it
    const beside = go([{ id: "wall-of-crates", prop: "long-crate", place: { kind: "floor", at: [6.4, 3.0] } }], { map });
    expect(beside.violations.some((v) => v.code === "blocks-route" && /stair approach/.test(v.message) && v.item === "wall-of-crates")).toBe(true);
  });

  it("puts a flame-only fixture only on an anchor of its kind", () => {
    const ok = go([{ id: "fire", prop: "hearth-fire", place: { kind: "anchor", anchor: "hearth" } }]);
    expect(codes(ok, "fire")).toEqual([]);
    const floor = go([{ id: "fire", prop: "hearth-fire", place: { kind: "floor", at: [2, 2] } }]);
    expect(codes(floor, "fire")).toEqual(["anchor-only"]);
    expect(floor.placements.find((p) => p.id === "fire")).toBeUndefined();
    const wall = go([{ id: "torch", prop: "sconce-fire", place: { kind: "wall", wall: "A.W", t: 1, height: 1.5 } }]);
    expect(codes(wall, "torch")).toEqual(["anchor-only"]);
    expect(wall.violations[0]!.message).toMatch(/no sconce anchor/);
    const wrongKind = go([{ id: "torch", prop: "sconce-fire", place: { kind: "anchor", anchor: "hearth" } }]);
    expect(codes(wrongKind, "torch")).toEqual(["anchor-only"]);
    expect(() => dressingSchema.parse({ mount: "surface", size: [0.1, 0.1, 0.1], anchorKinds: ["sconce"] })).toThrow();
  });
});

describe("circulation mask ('x' walking paths)", () => {
  const { map: CIRC, notes } = circulate(MAP);
  const props = new Map(PROPS);
  props.set("rug", dressingSchema.parse({ mount: "floor", size: [1.2, 0.02, 0.8], solid: false }));
  const go = (map: typeof MAP, items: DressingPlanInput["items"], rooms: Record<string, { role: string }> = { A: { role: "office" }, B: { role: "hall" } }) =>
    resolveDressing({ plan: dressingPlanSchema.parse({ id: "zt", map: map.id, rooms, items }), map, prop: (id) => props.get(id), set: (id) => SETS.get(id), options: { minItems: () => 0 } });
  const lv = CIRC.levels[0]!;
  /** Centre of the first path cell in room A away from the entry lane. */
  const pathCell = (() => {
    for (let r = 4; r < lv.rows; r++)
      for (let c = 0; c < 16; c++) if (lv.cells[r]![c] === "x") return [(c + 0.5) * STEP, (r + 0.5) * STEP] as [number, number];
    throw new Error("no path cell in room A");
  })();

  it("reserves a lane-wide path from the door to the doorway and the stair, named for what it serves", () => {
    expect(lv.cells.join("")).toContain("x");
    const names = lv.paths.map((p) => p.name);
    expect(names.some((n) => /^the way from the door to the doorway between A and B$/.test(n))).toBe(true);
    expect(names.some((n) => /the stair/.test(n))).toBe(true);
    expect(lv.paths.every((p) => p.width === DEFAULT_LANE_WIDTH)).toBe(true);
    // keep-clear cells keep their code; nothing else of the map changes
    expect(lv.cells.join("").replaceAll("x", ".")).toBe(MAP.levels[0]!.cells.join(""));
    expect(notes.some((n) => /placeable/.test(n))).toBe(true);
    expect(socketMapSchema.safeParse(CIRC).success).toBe(true);
  });

  it("refuses a solid prop on a path, naming the path and a free place", () => {
    const r = go(CIRC, [{ id: "c", prop: "crate", place: { kind: "floor", at: pathCell } }]);
    const v = r.violations.find((x) => x.item === "c" && x.code === "on-path");
    expect(v?.message).toMatch(/stands on the way from the door to /);
    expect(v?.message).toMatch(/nearest free place: \{ kind: "floor", at: \[/);
    expect(codes(r, "c")).not.toContain("not-free");
  });

  it("lets a rug lie on a path", () => {
    const r = go(CIRC, [{ id: "rug", prop: "rug", place: { kind: "floor", at: pathCell } }]);
    expect(codes(r, "rug")).toEqual([]);
  });

  it("leaves nothing placeable in a room whose only free floor is path, and says so", () => {
    // A 1.25 m corridor (5 cells) from the door to a doorway into a shallow alcove: the 0.9 m lane's body covers it all.
    const C = 7, R = 24, cells: string[] = [], head: string[] = [], room: string[] = [];
    for (let r = 0; r < R; r++) {
      let c0 = "", h0 = "", r0 = "";
      for (let c = 0; c < C; c++) {
        const wall = c === 0 || c === C - 1 || r === R - 1;
        const ch = wall ? "#" : r <= 2 ? "E" : r === 19 ? "D" : ".";
        c0 += ch;
        h0 += ch === "#" ? "." : "c";
        r0 += ch === "." ? (r < 19 ? "0" : "1") : ".";
      }
      cells.push(c0), head.push(h0), room.push(r0);
    }
    const narrow = socketMapSchema.parse({
      id: "zt-corridor",
      entry: { position: [0.875, 0], facing: [0, 1] },
      levels: [{ level: 0, floorY: 0, origin: [0, 0], step: STEP, columns: C, rows: R, cells, head, room, walls: [],
        rooms: [
          { id: "A", index: 0, area: 5, centre: [0.875, 2.75], bbox: [0.25, 1.5, 0.75, 4.75], minHead: 3, maxHead: 3 },
          { id: "B", index: 1, area: 1.25, centre: [0.875, 5.5], bbox: [0.25, 1.5, 5, 5.75], minHead: 3, maxHead: 3 },
        ] }],
    });
    const out = circulate(narrow);
    const floor = placeableFloor(out.map.levels[0]!);
    expect(floor.find((f) => f.room === "A")!.placeable).toBe(0);
    expect(out.notes.some((n) => /room A: NOTHING placeable/.test(n))).toBe(true);
    const r = go(out.map, [{ id: "p", prop: "painting", place: { kind: "floor", at: [0.875, 2.5] } }], { A: { role: "hall" }, B: { role: "storage" } });
    expect(wcodes(r, "A")).toContain("no-placeable-floor");
    const crate = go(out.map, [{ id: "c", prop: "crate", place: { kind: "floor", at: [0.875, 2.5] } }], { A: { role: "hall" }, B: { role: "storage" } });
    expect(codes(crate, "c")).toContain("on-path");
  });

  it("is deterministic and idempotent", () => {
    const again = circulate(MAP).map;
    expect(JSON.stringify(again)).toBe(JSON.stringify(CIRC));
    expect(JSON.stringify(circulate(CIRC).map)).toBe(JSON.stringify(CIRC));
    // the input map is not changed
    expect(MAP.levels[0]!.cells.join("")).not.toContain("x");
  });
});

describe("placement by intent (auto places)", () => {
  SETS.set(
    "table-side",
    dressingSetSchema.parse({
      id: "table-side",
      footprint: [2.2, 0.8],
      items: [
        { id: "table", prop: "table", place: { kind: "floor", at: [0, 0] } },
        { id: "chair", prop: "chair", place: { kind: "floor", at: [-0.9, 0], yaw: 90 } },
      ],
    }),
  );

  it("puts a wall-backed prop flush on a free wall stretch and reports the spot it chose", () => {
    const r = run([{ id: "w", prop: "wardrobe", place: { kind: "auto", room: "A" } }]);
    expect(r.violations.filter((v) => v.item !== "B")).toEqual([]);
    expect(r.auto?.[0]?.item).toBe("w");
    expect(r.auto?.[0]?.place.kind).toBe("wall");
    expect(at(r, "w").room).toBe("A");
  });

  it("places a free-standing set in the open of the named room, clear of everything", () => {
    const r = run([
      { id: "d", prop: "desk", place: { kind: "floor", at: [2, 4.5] } },
      { id: "s", set: "desk-set", place: { kind: "auto", room: "A", prefer: "open" } },
    ]);
    expect(r.violations.filter((v) => v.item !== "B")).toEqual([]);
    expect(r.auto?.[0]?.place.kind).toBe("floor");
    expect(at(r, "s/desk").room).toBe("A");
  });

  it("lets earlier items win; a later one that cannot fit says how much room was left", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, prop: "long-crate", place: { kind: "auto" as const, room: "A" } }));
    const r = run(items);
    expect(codes(r, "c0")).toEqual([]);
    const fail = r.violations.find((v) => v.code === "auto-no-room");
    expect(fail).toBeDefined();
    expect(fail!.message).toMatch(/cover ceiling|left:/);
  });

  it("never stands a solid auto item on a reserved walking path", () => {
    const map = structuredClone(MAP);
    const lv = map.levels[0]!;
    lv.cells = lv.cells.map((row, r) => (r >= 8 && r <= 15 ? row.split("").map((ch, c) => (c >= 1 && c <= 15 && ch === "." ? "x" : ch)).join("") : row));
    const plan = dressingPlanSchema.parse({ id: "zt", map: "zt-house", rooms: { A: { role: "office" }, B: { role: "hall" } }, items: [{ id: "t", prop: "table", place: { kind: "auto", room: "A", prefer: "open" } }] });
    const r = resolveDressing({ plan, map, prop: (id) => PROPS.get(id), set: (id) => SETS.get(id), options: { minItems: () => 0 } });
    expect(r.violations.filter((v) => v.item === "t")).toEqual([]);
    const z = at(r, "t").position[2];
    expect(z < 2 || z > 4).toBe(true);
  });

  it("refuses an auto place in a room the map does not have, naming the rooms", () => {
    const r = run([{ id: "w", prop: "wardrobe", place: { kind: "auto", room: "Q" } }]);
    expect(codes(r, "w")).toContain("auto-room");
  });

  it("mirror swaps a set's left and right", () => {
    const plain = run([{ id: "s", set: "table-side", place: { kind: "floor", at: [2, 3] } }]);
    const mirrored = run([{ id: "s", set: "table-side", mirror: true, place: { kind: "floor", at: [2, 3] } }]);
    expect(at(plain, "s/chair").position[0]).toBeCloseTo(1.1);
    expect(at(mirrored, "s/chair").position[0]).toBeCloseTo(2.9);
    expect(dressingPlanSchema.safeParse({ id: "x", map: "m", items: [{ id: "a", prop: "chair", mirror: true, place: { kind: "floor", at: [0, 0] } }] }).success).toBe(false);
  });

  it("measures the cover ceiling against placeable floor", () => {
    expect(roomBudget(20, "", 10).maxCoverM2).toBe(3);
    expect(roomBudget(20, "").maxCoverM2).toBe(6);
  });

  it("lists a wall's stand stretches only where solid wall and placeable floor meet, left to right", () => {
    const lv = MAP.levels[0]!, wall = lv.walls.find((w) => w.id === "A.S")!;
    const st = standStretches(lv, wall);
    expect(st.length).toBeGreaterThan(0);
    for (const [a, b] of st) {
      expect(wall.spans.some(([s0, s1]) => a >= s0 - 1e-6 && b <= s1 + 1e-6)).toBe(true);
      expect(a <= 1.2 && b >= 1.2).toBe(false);
    }
  });

  it("says where a set's members fall, in words", () => {
    const text = describeSetShape(SETS.get("table-side")!, (id) => PROPS.get(id));
    expect(text).toMatch(/chair on the left/);
    expect(describeSetShape(SETS.get("desk-set")!, (id) => PROPS.get(id))).toMatch(/chair in front/);
  });
});
