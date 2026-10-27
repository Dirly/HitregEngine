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
  MOUNT_CLEAR,
  MOUNT_WALL,
  expandRoomRoles,
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
  notice: { mount: "wall", size: [0.5, 0.7, 0.002] },
  pew: { mount: "floor", size: [1.2, 0.9, 0.5] },
  candlestand: { mount: "floor", size: [0.4, 1.5, 0.4] },
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
    expect(p.position[1]).toBeCloseTo(0.75 + MOUNT_CLEAR); // thin paper held off the board
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
    expect(letter.position[1]).toBeCloseTo(0.8 + MOUNT_CLEAR);
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

describe("dresser follow-ups (2026-10-20)", () => {
  it("honours prefer wall for a free-standing piece (a lectern, a vat)", () => {
    const r = run([{ id: "t", prop: "table", place: { kind: "auto", room: "A", prefer: "wall" } }]);
    expect(codes(r, "t")).toEqual([]);
    expect(r.auto?.find((a) => a.item === "t")?.place.kind).toBe("wall");
  });

  it("lines pews up in rows facing the item they are near", () => {
    const pews = Array.from({ length: 4 }, (_, i) => ({ id: `pew${i}`, prop: "pew", place: { kind: "auto" as const, room: "A", prefer: "row" as const, near: "altar" } }));
    const r = run([{ id: "altar", prop: "desk", place: { kind: "wall", wall: "A.N", t: 1.9 } }, ...pews]);
    for (const p of pews) expect(codes(r, p.id)).toEqual([]);
    const altarZ = at(r, "altar").position[2];
    const placed = pews.map((p) => at(r, p.id));
    // all face the altar (+z: yaw 0) and stand wholly in front of it
    for (const p of placed) {
      expect(Math.abs(Math.sin(p.yaw))).toBeLessThan(1e-6);
      expect(Math.cos(p.yaw)).toBeGreaterThan(0);
      expect(p.position[2]).toBeLessThan(altarZ - 0.5);
    }
    // more than one row, the rows one behind another with room to sit between them
    const rows = [...new Set(placed.map((p) => p.position[2].toFixed(2)))].map(Number).sort((a, b) => b - a);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]! - rows[1]!).toBeGreaterThanOrEqual(0.5 + 0.45 - 1e-6);
  });

  it("asks for `near` with prefer row", () => {
    const r = run([{ id: "p", prop: "pew", place: { kind: "auto", room: "A", prefer: "row" } }]);
    expect(codes(r, "p")).toContain("auto-near");
  });

  it("never hangs two ceiling props in one spot", () => {
    const r = run([
      { id: "c1", prop: "chandelier", place: { kind: "auto", room: "B", prefer: "open" } },
      { id: "c2", prop: "chandelier", place: { kind: "auto", room: "B", prefer: "open" } },
    ]);
    expect(codes(r, "c1")).toEqual([]);
    expect(codes(r, "c2")).toEqual([]);
    const [a, b] = [at(r, "c1"), at(r, "c2")];
    expect(Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2])).toBeGreaterThanOrEqual(1.4);
    const same = run([
      { id: "c1", prop: "chandelier", place: { kind: "ceiling", level: 0, at: [6, 2], drop: 0 } },
      { id: "c2", prop: "chandelier", place: { kind: "ceiling", level: 0, at: [6.2, 2], drop: 0 } },
    ]);
    expect(codes(same, "c2")).toContain("overlap");
  });

  it("holds wall props off the wall and thin coverings off the floor (no coplanar faces)", () => {
    const r = run([
      { id: "pic", prop: "painting", place: { kind: "wall", wall: "A.W", t: 2, height: 1.5 } },
      { id: "note", prop: "notice", place: { kind: "wall", wall: "A.W", t: 4, height: 1.5 } },
      { id: "t", prop: "table", place: { kind: "floor", at: [2, 3] } },
      { id: "p", prop: "paper", place: { kind: "on", item: "t" } },
    ]);
    expect(at(r, "pic").position[0]).toBeCloseTo(0.25 + MOUNT_WALL, 4);
    expect(at(r, "note").position[0]).toBeCloseTo(0.25 + MOUNT_CLEAR, 4);
    expect(at(r, "p").position[1]).toBeCloseTo(0.75 + MOUNT_CLEAR, 4);
    expect(at(r, "t").position[1]).toBeCloseTo(0, 6);
  });

  it("tells a standing prop put `on` a table to use a surface prop", () => {
    const r = run([
      { id: "t", prop: "table", place: { kind: "floor", at: [2, 3] } },
      { id: "c", prop: "candlestand", place: { kind: "on", item: "t" } },
    ]);
    expect(r.violations.find((v) => v.item === "c")?.message).toMatch(/only `surface` props go on/);
  });

  it("expands mixed room roles (cottage, guardroom, living)", () => {
    expect(expandRoomRoles(["cottage"])).toEqual(["cottage", "hall", "bedroom", "kitchen"]);
    expect(expandRoomRoles(["guardroom", "storage"])).toEqual(["guardroom", "hall", "bedroom", "storage"]);
    expect(expandRoomRoles(["living", "hall"])).toEqual(["living", "hall"]);
  });
});

describe("hearth comfort (2026-10-20)", () => {
  const map = structuredClone(MAP);
  const lv = map.levels[0]!;
  // a hearth clearance on the west wall of room A: x 0.25..1.0, z 3.0..4.5
  lv.cells = lv.cells.map((row, r) => (r >= 12 && r <= 17 ? row.split("").map((ch, c) => (c >= 1 && c <= 3 ? "H" : ch)).join("") : row));
  const go = (items: DressingPlanInput["items"]) =>
    resolveDressing({ plan: dressingPlanSchema.parse({ id: "zt", map: "zt-house", rooms: { A: { role: "hall" }, B: { role: "hall" } }, items }), map, prop: (id) => PROPS.get(id), set: (id) => SETS.get(id), options: { minItems: () => 0 } });

  it("seats fireside furniture at the clearance's edge without a hearth warning", () => {
    const r = go([{ id: "seat", set: "table-side", place: { kind: "auto", room: "A", prefer: "near", near: "hearth" } }]);
    expect(r.violations.filter((v) => v.item.startsWith("seat"))).toEqual([]);
    expect(r.warnings.filter((w) => w.code === "hearth-clearance")).toEqual([]);
    const t = at(r, "seat/table").position;
    expect(Math.hypot(t[0] - 0.6, t[2] - 3.8)).toBeLessThan(2.0);
  });

  it("keeps other pieces out of the hearth's comfort buffer while the room has room", () => {
    const r = go([{ id: "w", prop: "wardrobe", place: { kind: "auto", room: "A", prefer: "wall" } }]);
    expect(codes(r, "w")).toEqual([]);
    expect(wcodes(r, "w")).not.toContain("hearth-clearance");
    expect(wcodes(r, "w")).not.toContain("auto-tight");
    // only the hearth's own wall allowed: it stands at the best spot left and says so, with what to do
    const tight = go([{ id: "w", prop: "wardrobe", place: { kind: "auto", room: "A", prefer: "wall", wall: "A.W" } }]);
    expect(codes(tight, "w")).toEqual([]);
    expect(tight.warnings.find((x) => x.code === "auto-tight")?.message).toMatch(/Accept it, or/);
  });
});

describe("owner rulings (2026-10-20)", () => {
  const R: Record<string, DressingInput> = {
    altar: { mount: "floor", size: [1.4, 1.0, 0.7], against: "free", category: "sacred", tags: ["altar"], centrepiece: true },
    "pew-t": { mount: "floor", size: [1.2, 0.9, 0.5], against: "free", use: ["seat"], tags: ["pew"] },
    lectern: { mount: "floor", size: [0.6, 1.2, 0.5], against: "free", use: ["table"], tags: ["lectern"], neverInDoorLine: true },
    "book-up": { mount: "surface", size: [0.06, 0.29, 0.26], fits: ["book"], tags: ["book"], pose: { surface: "flat", shelf: "upright" } },
    "book-bare": { mount: "surface", size: [0.06, 0.29, 0.26], fits: ["book"], tags: ["book"] },
    shelf: { mount: "floor", against: "wall", size: [1.0, 1.8, 0.4], use: ["shelf"], provides: [{ id: "b1", kind: "surface", position: [0, 1.0, 0], size: [0.9, 0.35], clearHeight: 0.4, capacity: 4 }] },
    dining: { mount: "floor", size: [1.2, 0.75, 0.8], against: "free", use: ["table"], provides: [{ id: "top", kind: "surface", position: [0, 0.75, 0], size: [1.1, 0.7], capacity: 6 }] },
    "cand-stand": { mount: "floor", size: [0.5, 1.5, 0.3], against: "either", use: ["light"], tags: ["candelabra"] },
    sign: { mount: "wall", size: [0.6, 1.0, 0.8], tags: ["sign"] },
    "sign-out": { mount: "wall", size: [0.18, 1.2, 1.28], tags: ["sign", "projecting"] },
    "sign-post": { mount: "floor", size: [0.14, 2.4, 1.27], against: "free", tags: ["sign", "post"] },
    "chandelier-t": { mount: "ceiling", size: [1.0, 0.8, 1.0], use: ["light"], tags: ["chandelier"] },
  };
  const ALL = new Map<string, DressingData>([...PROPS, ...Object.entries(R).map(([k, v]) => [k, dressingSchema.parse(v)] as const)]);
  const go = (items: DressingPlanInput["items"], rooms: Record<string, { role: string }> = { A: { role: "office" }, B: { role: "hall" } }, map = MAP) =>
    resolveDressing({ plan: dressingPlanSchema.parse({ id: "zt", map: "zt-house", rooms, items }), map, prop: (id) => ALL.get(id), set: (id) => SETS.get(id), options: { minItems: () => 0 } });
  const chapel = { A: { role: "chapel" }, B: { role: "storage" } };

  it("warns a chapel with no altar and no pews in rows", () => {
    const r = go([{ id: "c", prop: "chair", place: { kind: "floor", at: [2, 3] } }], chapel);
    expect(wcodes(r, "A")).toEqual(expect.arrayContaining(["chapel-altar", "chapel-pews"]));
    expect(r.warnings.find((w) => w.code === "chapel-altar")?.message).toMatch(/"near": "back-wall"/);
  });

  it("stands the altar at the back wall facing the nave, pews in rows facing it: no chapel warning", () => {
    const pews = Array.from({ length: 4 }, (_, i) => ({ id: `pew${i}`, prop: "pew-t", place: { kind: "auto" as const, room: "A", prefer: "row" as const, near: "altar" } }));
    const r = go([{ id: "altar", prop: "altar", place: { kind: "auto", room: "A", near: "back-wall" } }, ...pews], chapel);
    expect(r.violations.filter((v) => v.item === "altar" || v.item.startsWith("pew"))).toEqual([]);
    const a = at(r, "altar");
    // the door is in the south wall (z 0), facing +z: the back wall is z 5.75; the altar's far edge within 1 m of it, facing -z
    expect(a.position[2] + 0.35).toBeGreaterThan(5.75 - 1.0);
    expect(Math.cos(a.yaw)).toBeLessThan(-0.7);
    expect(wcodes(r, "A")).not.toContain("chapel-altar");
    expect(wcodes(r, "A")).not.toContain("chapel-pews");
    expect(wcodes(r, "altar")).not.toContain("chapel-altar");
    // an altar with no `near` in a chapel goes to the back wall by itself
    const d = go([{ id: "altar", prop: "altar", place: { kind: "auto", room: "A" } }], chapel);
    expect(at(d, "altar").position[2] + 0.35).toBeGreaterThan(5.75 - 1.0);
  });

  it("warns an altar in the middle of the nave", () => {
    const r = go([{ id: "altar", prop: "altar", place: { kind: "floor", at: [2.5, 2.5], yaw: 180 } }], chapel);
    expect(wcodes(r, "altar")).toContain("chapel-altar");
  });

  it("refuses a lectern in a door line and keeps auto lecterns out of them", () => {
    const entry = go([{ id: "l", prop: "lectern", place: { kind: "floor", at: [1.5, 2.5] } }]);
    expect(codes(entry, "l")).toContain("door-line");
    const doorway = go([{ id: "l", prop: "lectern", place: { kind: "floor", at: [3.0, 3.0] } }]);
    expect(codes(doorway, "l")).toContain("door-line");
    const side = go([{ id: "l", prop: "lectern", place: { kind: "floor", at: [3.2, 4.8] } }]);
    expect(codes(side, "l")).toEqual([]);
    const auto = go([{ id: "l", prop: "lectern", place: { kind: "auto", room: "A", prefer: "open" } }]);
    expect(codes(auto, "l")).toEqual([]);
  });

  it("lays a book flat on a table, upright on a shelf; a book standing on a table is refused", () => {
    const r = go([
      { id: "t", prop: "dining", place: { kind: "floor", at: [2.5, 4.5] } },
      { id: "s", prop: "shelf", place: { kind: "wall", wall: "A.W", t: 2 } },
      { id: "flat", prop: "book-up", place: { kind: "on", item: "t" } },
      { id: "up", prop: "book-up", place: { kind: "on", item: "s" } },
      { id: "bare", prop: "book-bare", place: { kind: "on", item: "t" } },
    ]);
    expect(codes(r, "flat")).toEqual([]);
    expect(codes(r, "up")).toEqual([]);
    expect(codes(r, "bare")).toContain("book-upright");
    const flat = at(r, "flat");
    expect(flat.tilt?.map((v) => +v.toFixed(4))).toEqual([0, 0, 0.7071, 0.7071]);
    expect(flat.position[1]).toBeCloseTo(0.75 + 0.03, 4); // lifted by half its thickness
    expect(at(r, "up").tilt).toBeUndefined();
  });

  it("refuses a standing candelabra beside a table unless it was put on a wall or in a corner", () => {
    const beside = go([
      { id: "t", prop: "dining", place: { kind: "floor", at: [2, 3] } },
      { id: "c", prop: "cand-stand", place: { kind: "floor", at: [2, 4.1] } },
    ]);
    expect(codes(beside, "c")).toContain("candelabra-table");
    expect(beside.violations.find((v) => v.code === "candelabra-table")?.message).toMatch(/LOW candelabra/);
    const near = go([
      { id: "t", prop: "dining", place: { kind: "floor", at: [2, 3] } },
      { id: "c", prop: "cand-stand", place: { kind: "auto", room: "A", prefer: "near", near: "t" } },
    ]);
    expect(codes(near, "c")).toContain("candelabra-table");
    const wall = go([
      { id: "t", prop: "dining", place: { kind: "floor", at: [2, 3] } },
      { id: "c", prop: "cand-stand", place: { kind: "auto", room: "A", prefer: "corner" } },
    ]);
    expect(codes(wall, "c")).toEqual([]);
  });

  it("refuses a sign inside a room and hangs an auto sign on a door-sign anchor", () => {
    const inside = go([{ id: "s", prop: "sign", place: { kind: "wall", wall: "A.W", t: 2 } }]);
    expect(codes(inside, "s")).toContain("sign-indoors");
    const map = structuredClone(MAP);
    map.anchors.push({ id: "door-sign-zt", kind: "door-sign", level: 0, position: [1.5, 2.6, -0.1], yaw: 180, mount: "wall", outdoor: true });
    const out = go([{ id: "s", prop: "sign", place: { kind: "auto", room: "A" } }], undefined, map);
    expect(codes(out, "s")).toEqual([]);
    // the anchor is the sign's BOTTOM edge (lintel + 0.3 m): a 1.0 m sign with a back origin hangs its centre 0.5 m above it
    expect(at(out, "s").position[1]).toBeCloseTo(3.1);
  });

  it("sign-over-door: centred over the door, under the eave, clear of windows and other wall props", () => {
    const map = structuredClone(MAP);
    map.anchors.push({ id: "door-sign-zt", kind: "door-sign", level: 0, position: [1.5, 2.6, -0.1], yaw: 180, mount: "wall", outdoor: true, size: [1.2, 1.5, 1] });
    const ok = go([{ id: "s", prop: "sign", place: { kind: "anchor", anchor: "door-sign-zt" } }], undefined, map);
    expect(codes(ok, "s")).toEqual([]);
    // a sign hung from a point 0.8 m along the wall from the door's centre
    const side = structuredClone(map);
    side.anchors.push({ id: "door-l", kind: "door-side", level: 0, position: [2.3, 3.1, -0.1], yaw: 180, mount: "wall", outdoor: true });
    const off = go([{ id: "s", prop: "sign", place: { kind: "anchor", anchor: "door-l" } }], undefined, side);
    expect(off.violations.find((v) => v.item === "s" && v.code === "sign-over-door")?.message).toMatch(/0.80 m along the wall/);
    // the eave leaves 0.6 m over the anchor: a 1.0 m sign runs into it
    const low = structuredClone(map);
    low.anchors.find((x) => x.id === "door-sign-zt")!.size = [1.2, 0.6, 1];
    expect(go([{ id: "s", prop: "sign", place: { kind: "anchor", anchor: "door-sign-zt" } }], undefined, low).violations.find((v) => v.code === "sign-over-door")?.message).toMatch(/eave/);
    // a window beside the door, 0.4 m from it at sign height: the 0.6 m sign covers its edge
    const win = structuredClone(map);
    win.anchors.push({ id: "window-1", kind: "window", level: 0, position: [2.2, 3.0, -0.1], yaw: 180, mount: "wall", outdoor: true, size: [1.0, 1.2, 0.1] });
    expect(go([{ id: "s", prop: "sign", place: { kind: "anchor", anchor: "door-sign-zt" } }], undefined, win).violations.find((v) => v.code === "sign-over-door")?.message).toMatch(/window window-1/);
    const far = structuredClone(map);
    far.anchors.push({ id: "window-1", kind: "window", level: 0, position: [3.4, 3.0, -0.1], yaw: 180, mount: "wall", outdoor: true, size: [1.0, 1.2, 0.1] });
    expect(codes(go([{ id: "s", prop: "sign", place: { kind: "anchor", anchor: "door-sign-zt" } }], undefined, far), "s")).toEqual([]);
  });

  it("sign-over-door: no room over the door, a PROJECTING sign hangs beside it, as high as the lintel allows", () => {
    const map = structuredClone(MAP);
    map.anchors.push(
      { id: "door-sign-zt", kind: "door-sign", level: 0, position: [1.5, 2.6, -0.1], yaw: 180, mount: "wall", outdoor: true, size: [1.2, 0.4, 1] },
      { id: "door-sign-zt-l", kind: "door-sign-beside", level: 0, position: [2.5, 2.1, -0.1], yaw: 180, mount: "wall", outdoor: true, prefer: 0.3, size: [0.2, 1.5, 1.3] },
      { id: "door-sign-zt-r", kind: "door-sign-beside", level: 0, position: [4.0, 2.1, -0.1], yaw: 180, mount: "wall", outdoor: true, prefer: 0.3, size: [0.2, 1.5, 1.3] },
    );
    const at0 = (anchor: string, prop = "sign-out") => go([{ id: "s", prop, place: { kind: "anchor", anchor } }], undefined, map);
    expect(at0("door-sign-zt", "sign").violations.find((v) => v.code === "sign-over-door")?.message).toMatch(/beside the door/);
    const ok = at0("door-sign-zt-l");
    expect(codes(ok, "s")).toEqual([]);
    // bottom 2.1 + min(prefer 0.3, clear 1.5 - 1.2) = 2.4; a back-origin sign's origin is its middle
    expect(at(ok, "s").position[1]).toBeCloseTo(3.0);
    expect(at0("door-sign-zt-l", "sign").violations.find((v) => v.code === "sign-over-door")?.message).toMatch(/PROJECTING/);
    expect(at0("door-sign-zt-r").violations.find((v) => v.code === "sign-over-door")?.message).toMatch(/1.90 m from the edge/);
    // an auto projecting sign takes the beside anchor, a flat one the door-sign
    expect(go([{ id: "s", prop: "sign-out", place: { kind: "auto", room: "A" } }], undefined, map).auto?.[0]?.place).toEqual({ kind: "anchor", anchor: "door-sign-zt-l" });
  });

  it("sign-over-door: a low eave and no wall for a board: a freestanding sign POST 1.0-1.5 m beside the door, clear of windows", () => {
    const map = structuredClone(MAP);
    map.anchors.push(
      { id: "door-sign-zt", kind: "door-sign", level: 0, position: [1.5, 2.6, -0.1], yaw: 180, mount: "wall", outdoor: true, size: [1.2, 0.2, 1] },
      { id: "door-sign-zt-post-l", kind: "door-sign-post", level: 0, position: [3.35, 0, -0.7], yaw: 180, mount: "floor", outdoor: true },
      { id: "far-post", kind: "door-sign-post", level: 0, position: [4.6, 0, -0.7], yaw: 180, mount: "floor", outdoor: true },
    );
    const post = (anchor: string, m = map) => go([{ id: "s", prop: "sign-post", place: { kind: "anchor", anchor } }], undefined, m);
    expect(codes(post("door-sign-zt-post-l"), "s")).toEqual([]);
    expect(post("far-post").violations.find((v) => v.code === "sign-over-door")?.message).toMatch(/2.50 m from the edge of door door-sign-zt/);
    // a ground-floor window on that side: the post goes to the window-free side
    const win = structuredClone(map);
    win.anchors.push({ id: "window-1", kind: "window", level: 0, position: [3.4, 1.4, -0.1], yaw: 180, mount: "wall", outdoor: true, size: [1.0, 1.2, 0.1] });
    expect(post("door-sign-zt-post-l", win).violations.find((v) => v.code === "sign-over-door")?.message).toMatch(/window window-1/);
    // an auto sign post takes the post anchor, not the wall door-sign
    expect(go([{ id: "s", prop: "sign-post", place: { kind: "auto", room: "A" } }], undefined, map).auto?.[0]?.place).toEqual({ kind: "anchor", anchor: "door-sign-zt-post-l" });
  });

  it("asks a tall-roofed room for a chandelier and hangs it at the ridge centre", () => {
    const map = structuredClone(MAP);
    map.levels[0]!.rooms[1]!.area = 25;
    const none = go([{ id: "c", prop: "chair", place: { kind: "floor", at: [5, 1.5] } }], undefined, map);
    expect(wcodes(none, "B")).toContain("no-chandelier");
    expect(none.review?.find((x) => x.room === "B")?.chandelier).toBe(false);
    const hung = go([{ id: "ch", prop: "chandelier-t", place: { kind: "auto", room: "B" } }], undefined, map);
    expect(wcodes(hung, "B")).not.toContain("no-chandelier");
    expect(hung.review?.find((x) => x.room === "B")?.chandelier).toBe(true);
    const p = at(hung, "ch").position;
    expect(Math.hypot(p[0] - 6, p[2] - 3)).toBeLessThan(0.3);
    // a low room is never asked, nor a tall workshop (chapels, halls and taverns are)
    expect(wcodes(none, "A")).not.toContain("no-chandelier");
    const shop = go([{ id: "c", prop: "chair", place: { kind: "floor", at: [5, 1.5] } }], { A: { role: "office" }, B: { role: "workshop" } }, map);
    expect(wcodes(shop, "B")).not.toContain("no-chandelier");
  });
});

describe("long halls (2026-10-21): pew rows along the nave, a chandelier line, flames by area, high sconces", () => {
  /*
   * One long chapel, 8 x 24 m at 0.25 m cells: x 0.25..8.25, z 0.25..24.25, walls 6 m, a 7 m ridge down x 3.75..4.75.
   * The entry is in the south wall at x 3.5..5 (z 0), leading +z; the back wall (the altar's) is z 24.25.
   */
  const C = 34, R = 98;
  function hall() {
    const cells: string[] = [], head: string[] = [], room: string[] = [];
    for (let r = 0; r < R; r++) {
      let c0 = "", h0 = "", r0 = "";
      for (let c = 0; c < C; c++) {
        const border = r === 0 || r === R - 1 || c === 0 || c === C - 1;
        const ch = border ? (r === 0 && c >= 14 && c <= 19 ? "E" : "#") : r <= 2 && c >= 14 && c <= 19 ? "E" : ".";
        c0 += ch;
        r0 += ch === "." ? "0" : ".";
        h0 += ch === "#" ? "." : c >= 15 && c <= 18 ? "s" : "o";
      }
      cells.push(c0);
      head.push(h0);
      room.push(r0);
    }
    return socketMapSchema.parse({
      id: "zt-hall",
      entry: { position: [4.25, 0], facing: [0, 1] },
      levels: [
        {
          level: 0, floorY: 0, origin: [0, 0], step: 0.25, columns: C, rows: R, cells, head, room,
          rooms: [{ id: "N", index: 0, area: 192, centre: [4.25, 12.25], bbox: [0.25, 8.25, 0.25, 24.25], minHead: 6, maxHead: 7 }],
          walls: [
            { id: "N.W", room: "N", a: [0.25, 0.25], b: [0.25, 24.25], normal: [1, 0], spans: [[0, 24]], height: 6 },
            { id: "N.E", room: "N", a: [8.25, 24.25], b: [8.25, 0.25], normal: [-1, 0], spans: [[0, 24]], height: 6 },
            { id: "N.N", room: "N", a: [8.25, 24.25], b: [0.25, 24.25], normal: [0, -1], spans: [[0, 8]], height: 6 },
          ],
        },
      ],
      anchors: [],
    });
  }
  const HALL = hall();
  const R2: Record<string, DressingInput> = {
    altar: { mount: "floor", size: [1.4, 1.0, 0.7], against: "free", category: "sacred", tags: ["altar"], centrepiece: true },
    "pew-t": { mount: "floor", size: [1.2, 0.9, 0.5], against: "free", use: ["seat"], tags: ["pew"] },
    "chandelier-t": { mount: "ceiling", size: [1.0, 0.8, 1.0], use: ["light"], tags: ["chandelier"], fire: true, chain: "chain-link" },
    sconce: { mount: "wall", size: [0.3, 0.4, 0.2], use: ["light"], fire: true, wallHeight: [1.4, 1.8] },
    picture: { mount: "wall", size: [0.6, 0.5, 0.05] },
  };
  const ALL = new Map<string, DressingData>([...PROPS, ...Object.entries(R2).map(([k, v]) => [k, dressingSchema.parse(v)] as const)]);
  const go = (items: DressingPlanInput["items"], map = HALL) =>
    resolveDressing({ plan: dressingPlanSchema.parse({ id: "zt", map: map.id, rooms: { N: { role: "chapel" } }, items }), map, prop: (id) => ALL.get(id), set: () => undefined, options: { minItems: () => 0 } });
  const altar = { id: "altar", prop: "altar", place: { kind: "auto" as const, room: "N", near: "back-wall" } };
  const pews = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `pew${i}`, prop: "pew-t", place: { kind: "auto" as const, room: "N", prefer: "row" as const, near: "altar" } }));

  it("spreads the plan's pews in rows 1.1-1.3 m apart from the altar step back down the nave, a centre aisle, never into the door line", () => {
    const t0 = performance.now();
    const r = go([altar, ...pews(50)]);
    const ms = performance.now() - t0;
    expect(r.violations).toEqual([]);
    expect(wcodes(r, "N")).not.toContain("chapel-pews");
    const ps = r.placements.filter((p) => p.id.startsWith("pew"));
    expect(ps.length).toBe(50);
    const rows = [...new Set(ps.map((p) => +p.position[2].toFixed(2)))].sort((a, b) => b - a);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]! - rows[i]!).toBeGreaterThanOrEqual(1.1 - 1e-6), expect(rows[i - 1]! - rows[i]!).toBeLessThanOrEqual(1.3 + 1e-6);
    // the rows fill from the altar back: the front row just before the altar, the last short of the door line (z 0.75 + 3)
    const alt = at(r, "altar").position[2];
    expect(alt - rows[0]!).toBeLessThan(1.6);
    expect(Math.min(...rows) - 0.25).toBeGreaterThan(0.75 + 3 - 0.01);
    // pews face the altar (+z) and leave a 1.2 m aisle down the middle
    for (const p of ps) expect(Math.cos(p.yaw)).toBeGreaterThan(0.99);
    const front = ps.filter((p) => Math.abs(p.position[2] - rows[2]!) < 0.01).map((p) => p.position[0]).sort((a, b) => a - b);
    const inner = front.filter((x) => x < 4.25).pop()!, innerR = front.find((x) => x > 4.25)!;
    expect(innerR - inner - 1.2).toBeGreaterThanOrEqual(1.2 - 1e-6);
    expect(ms).toBeLessThan(1000);
  });

  it("refuses a block of pews at one end of a long nave, with the measured share", () => {
    const r = go([altar, ...pews(8)]);
    const v = r.violations.find((x) => x.code === "chapel-pews");
    expect(v?.message).toMatch(/cover [\d.]+ m of its [\d.]+ m nave \(\d+%/);
  });

  it("hangs a long hall's chandeliers in a line under the ridge, 6-8 m apart, the first centred", () => {
    const one = go([altar, ...pews(50), { id: "ch1", prop: "chandelier-t", place: { kind: "auto", room: "N", near: "ceiling-centre" } }]);
    expect(one.warnings.find((w) => w.item === "N" && w.code === "no-chandelier")?.message).toMatch(/line of 3/);
    const three = go([altar, ...pews(50), ...[1, 2, 3].map((i) => ({ id: `ch${i}`, prop: "chandelier-t", place: { kind: "auto" as const, room: "N", near: "ceiling-centre" } }))]);
    expect(wcodes(three, "N")).not.toContain("no-chandelier");
    const zs = [1, 2, 3].map((i) => at(three, `ch${i}`).position);
    for (const p of zs) expect(p[0]).toBeGreaterThan(3.9), expect(p[0]).toBeLessThan(4.6); // under the ridge
    // let down on its chain toward 4 m over the floor, not left 1 m under a 7 m ridge
    for (const c of three.auto!.filter((x) => x.item.startsWith("ch"))) expect(c.place.kind === "ceiling" && c.place.drop).toBe(2);
    for (const p of zs) expect(p[1]).toBeCloseTo(5, 1); // its top: the bottom hangs 4.2 m over the floor
    expect(Math.abs(zs[0]![2] - 12.25)).toBeLessThan(0.5);
    const s = zs.map((p) => p[2]).sort((a, b) => a - b);
    expect(s[1]! - s[0]!).toBeGreaterThanOrEqual(6 - 0.3);
    expect(s[2]! - s[1]!).toBeLessThanOrEqual(8 + 0.3);
  });

  it("allows a flame per 12 m² of floor (at least 6), and a sconce up to 2.4 m on a wall over 4 m", () => {
    const lights = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, prop: "sconce", place: { kind: "wall" as const, wall: i % 2 ? "N.W" : "N.E", t: 1 + Math.floor(i / 2) * 1.4, height: 2.3 } }));
    const ok = go(lights(16)); // 192 m2 -> 16
    expect(ok.violations).toEqual([]);
    expect(go(lights(17)).violations.some((v) => v.code === "flame-budget")).toBe(true);
    // the small house keeps its floor of 6
    const house = (n: number) => resolveDressing({ plan: dressingPlanSchema.parse({ id: "zt", map: "zt-house", items: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, prop: "chandelier-t", place: { kind: "ceiling", at: [4.75 + (i % 4) * 0.8, 1 + Math.floor(i / 4) * 1.2] } })) }), map: MAP, prop: (id) => ALL.get(id), set: () => undefined });
    expect(house(6).violations.filter((v) => v.code === "flame-budget")).toEqual([]);
    expect(house(7).violations.filter((v) => v.code === "flame-budget")).not.toEqual([]);
    // a picture is not a light: its own band holds; a sconce on a 3 m wall keeps its own band too
    expect(codes(go([{ id: "p", prop: "picture", place: { kind: "wall", wall: "N.W", t: 2, height: 2.3 } }]), "p")).toContain("wall-height");
    const low = resolveDressing({ plan: dressingPlanSchema.parse({ id: "zt", map: "zt-house", items: [{ id: "s", prop: "sconce", place: { kind: "wall", wall: "A.W", t: 2, height: 2.3 } }] }), map: MAP, prop: (id) => ALL.get(id), set: () => undefined });
    expect(codes(low, "s")).toContain("wall-height");
  });
});

describe("opening-clear (owner walk 2026-10-21): nothing in front of a doorway or hallway mouth", () => {
  it("refuses a solid prop within 1.2 m in front of a doorway, and auto places keep out of it", () => {
    // the doorway A|B: x 4.0..4.25, z 2.5..3.5; a crate's near edge 0.75 m into room B in front of it
    expect(codes(run([{ id: "c", prop: "crate", place: { kind: "floor", at: [5.3, 3.0] } }]), "c")).toContain("opening-clear");
    // beside it (not in front): no opening fault
    expect(codes(run([{ id: "c", prop: "crate", place: { kind: "floor", at: [5.3, 1.2] } }]), "c")).not.toContain("opening-clear");
    // auto crates in room B: none lands in front of the doorway
    const r = run(Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, prop: "crate", place: { kind: "auto" as const, room: "B", prefer: "open" as const } })));
    expect(r.violations.filter((v) => v.code === "opening-clear")).toEqual([]);
  });
});
