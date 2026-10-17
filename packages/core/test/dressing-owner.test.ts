import { describe, expect, it } from "vitest";
import {
  applyOps,
  applyOwnerOverrides,
  ComponentRegistry,
  AssetLibrary,
  registerCoreAssetTypes,
  entityOwnerState,
  inferApplyFrame,
  mapToScene,
  ownerOverridesSchema,
  ownerReasons,
  ownerScaleRange,
  rebaseOwnerOverrides,
  recordOwnerEdit,
  registerCoreComponents,
  sceneOwnerOps,
  sceneToMap,
  type OwnedPlacement,
  type OwnerOverrides,
} from "../src/index.js";

const empty = (): OwnerOverrides => ownerOverridesSchema.parse({ plan: "p", overrides: [] });
const D = Math.PI / 180;
/** What a plan resolves to, every time (the resolver is deterministic): the input of every re-apply. */
const resolved = (): OwnedPlacement[] => [
  { id: "basket", prop: "props/basket", room: "G-1", position: [1, 0.8, 2], yaw: 0 },
  { id: "table", prop: "props/table", room: "G-1", position: [3, 0, 3], yaw: 0 },
  { id: "cup", prop: "props/cup", room: "G-1", position: [3.2, 0.9, 3], yaw: 0 },
  { id: "crate", prop: "props/crate", room: "G-1", position: [5, 0, 1], yaw: 90 * D },
  { id: "sack", prop: "props/sack", room: "G-1", position: [6, 0, 1], yaw: 0 },
];

describe("owner overrides schema", () => {
  it("parses a plan file and a scene file, and is registered as a data type in the spec", () => {
    const f = ownerOverridesSchema.parse({ plan: "a/b", overrides: [{ item: "x", set: { pos: [1, 2, 3] } }] });
    expect(f.frame).toBe("map");
    expect(f.overrides[0]!.by).toBe("owner");
    expect(ownerOverridesSchema.safeParse({ scene: "s", frame: "scene", overrides: [] }).success).toBe(true);
    const lib = new AssetLibrary();
    registerCoreAssetTypes(lib);
    expect(Object.keys(lib.dataTypeJsonSchemas())).toContain("owner-overrides");
  });
  it("refuses bad files", () => {
    expect(ownerOverridesSchema.safeParse({ plan: "p", overrides: [{ item: "o", added: true, set: { pos: [0, 0, 0] } }] }).success).toBe(false); // added without prop
    expect(ownerOverridesSchema.safeParse({ plan: "p", overrides: [{ item: "a" }, { item: "a" }] }).success).toBe(false); // duplicate item
    expect(ownerOverridesSchema.safeParse({ plan: "p", scene: "s", overrides: [] }).success).toBe(false); // both owners
    expect(ownerOverridesSchema.safeParse({ overrides: [] }).success).toBe(false); // no owner
  });
});

describe("recording edits", () => {
  it("keeps the agent's placement as `from` across edits, and classes a move down as floating", () => {
    let f = recordOwnerEdit(empty(), { item: "basket", before: { pos: [1, 0.8, 2], yaw: 0, scale: 1, prop: "props/basket" }, after: { pos: [1, 0, 2], yaw: 0, scale: 1, prop: "props/basket" } }, "t1");
    f = recordOwnerEdit(f, { item: "basket", before: { pos: [1, 0, 2], yaw: 0, scale: 1, prop: "props/basket" }, after: { pos: [1.5, 0, 2], yaw: 30, scale: 1, prop: "props/basket" } }, "t2");
    const o = f.overrides[0]!;
    expect(o.from?.pos).toEqual([1, 0.8, 2]);
    expect(o.set.pos).toEqual([1.5, 0, 2]);
    expect(o.reasons).toEqual(["floating", "moved", "rotated"]);
    expect(o.at).toBe("t2");
  });
  it("an undo back to the agent's placement clears the override; delete + undo restores nothing to keep", () => {
    const placed = { pos: [6, 0, 1] as [number, number, number], yaw: 0, scale: 1, prop: "props/sack" };
    let f = recordOwnerEdit(empty(), { item: "sack", before: placed, after: { ...placed, pos: [7, 0, 1] } });
    expect(f.overrides).toHaveLength(1);
    f = recordOwnerEdit(f, { item: "sack", before: { ...placed, pos: [7, 0, 1] }, after: placed });
    expect(f.overrides).toHaveLength(0);
    f = recordOwnerEdit(f, { item: "sack", before: placed, after: null });
    expect(f.overrides[0]).toMatchObject({ item: "sack", deleted: true, reasons: ["deleted"] });
    f = recordOwnerEdit(f, { item: "sack", before: null, after: placed });
    expect(f.overrides).toHaveLength(0);
  });
  it("owner-added props are kept, and deleting one forgets it", () => {
    let f = recordOwnerEdit(empty(), { item: "owner-a", before: null, after: { pos: [0, 0, 0], yaw: 0, scale: 1, prop: "props/barrel" }, ownerAdded: true, entity: "dress-p-owner-a", room: "G-1" });
    expect(f.overrides[0]).toMatchObject({ added: true, entity: "dress-p-owner-a", room: "G-1", reasons: ["added"] });
    expect(ownerOverridesSchema.safeParse(f).success).toBe(true);
    f = recordOwnerEdit(f, { item: "owner-a", before: { pos: [0, 0, 0], yaw: 0, scale: 1, prop: "props/barrel" }, after: null });
    expect(f.overrides).toHaveLength(0);
  });
  it("classes swaps and scales", () => {
    expect(ownerReasons({ from: { prop: "a", pos: [0, 0, 0], scale: 1 }, set: { prop: "b", pos: [0, 0, 0], scale: 1.2 } })).toEqual(["swapped", "scaled"]);
  });
});

describe("re-apply: plan, then owner, last", () => {
  const owner = (): OwnerOverrides =>
    ownerOverridesSchema.parse({
      plan: "p",
      overrides: [
        { item: "basket", set: { pos: [1, 0.02, 2], yaw: 0, scale: 1, prop: "props/basket" }, from: { pos: [1, 0.8, 2] } },
        { item: "crate", set: { prop: "props/barrel" } },
        { item: "sack", deleted: true },
        { item: "table", set: { pos: [4, 0, 3], yaw: 90 } },
        { item: "owner-x", added: true, set: { prop: "props/stool", pos: [2, 0, 2], yaw: 45 }, room: "G-1" },
        { item: "gone", set: { pos: [0, 0, 0] } },
      ],
    });
  const hostOf = new Map([["cup", "table"]]);

  it("move, delete and swap survive re-apply; owner-added joins; stale is reported", () => {
    const r = applyOwnerOverrides(resolved(), owner(), hostOf);
    const by = new Map(r.placements.map((p) => [p.id, p]));
    expect(by.get("basket")!.position).toEqual([1, 0.02, 2]);
    expect(by.get("crate")!.prop).toBe("props/barrel");
    expect(by.get("crate")!.position).toEqual([5, 0, 1]); // swap only: stays where the plan puts it
    expect(by.has("sack")).toBe(false);
    expect(r.deleted).toEqual(["sack"]);
    expect(by.get("owner-x")).toMatchObject({ prop: "props/stool", room: "G-1", position: [2, 0, 2] });
    expect(by.get("owner-x")!.yaw).toBeCloseTo(45 * D);
    expect(r.stale).toEqual(["gone"]);
    expect([...r.fixed].sort()).toEqual(["basket", "crate", "cup", "owner-x", "table"]);
  });
  it("what stands on a moved host follows it rigidly", () => {
    const cup = applyOwnerOverrides(resolved(), owner(), hostOf).placements.find((p) => p.id === "cup")!;
    // table moved +1 x and turned 90°: the cup's 0.2 m offset along +x turns to -z (three.js yaw about +Y)
    expect(cup.position[0]).toBeCloseTo(4);
    expect(cup.position[1]).toBeCloseTo(0.9);
    expect(cup.position[2]).toBeCloseTo(2.8);
    expect(cup.yaw).toBeCloseTo(90 * D);
  });
  it("a deleted host takes what stands on it", () => {
    const f = ownerOverridesSchema.parse({ plan: "p", overrides: [{ item: "table", deleted: true }] });
    const r = applyOwnerOverrides(resolved(), f, hostOf);
    expect(r.placements.map((p) => p.id)).toEqual(["basket", "crate", "sack"]);
    expect(r.deleted).toEqual(["table", "cup"]);
  });
  it("is idempotent: the plan re-resolved and re-applied gives the same result, and never mutates its input", () => {
    const input = resolved();
    const snapshot = JSON.stringify(input);
    const a = applyOwnerOverrides(input, owner(), hostOf).placements;
    const b = applyOwnerOverrides(resolved(), owner(), hostOf).placements;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(applyOwnerOverrides(input, null).placements).toEqual(input);
  });
});

describe("frames", () => {
  it("scene <-> map round trip", () => {
    const frame = { at: [10, 2, -5] as [number, number, number], yaw: 30 };
    const t = { pos: [1.5, 0.25, -2] as [number, number, number], yaw: 12, prop: "a" };
    const back = sceneToMap(frame, mapToScene(frame, t));
    back.pos!.forEach((v, i) => expect(v).toBeCloseTo(t.pos[i]!, 3));
    expect(back.yaw).toBeCloseTo(12);
  });
  it("re-bases edits onto another install frame without moving them in the scene", () => {
    const inferred = { at: [0, -0.03, 0] as [number, number, number], yaw: 0 };
    const real = { at: [0.06, 0.06, -0.06] as [number, number, number], yaw: 0 };
    const f = ownerOverridesSchema.parse({ plan: "p", installed: inferred, overrides: [{ item: "a", set: { pos: [1, 0, 1], yaw: 10 } }] });
    const r = rebaseOwnerOverrides(f, real);
    const scene = mapToScene(real, r.overrides[0]!.set).pos!;
    [1, -0.03, 1].forEach((v, i) => expect(scene[i]).toBeCloseTo(v, 4));
    expect(r.installed).toEqual(real);
    expect(rebaseOwnerOverrides(r, real).overrides).toEqual(r.overrides);
  });
  it("recovers an unrecorded install frame from placed pairs", () => {
    const frame = { at: [100, 5, 40] as [number, number, number], yaw: -64 };
    const locals: [number, number, number][] = [[0, 0, 0], [4, 0.1, 1], [-2, 0, 6], [3, 0.5, -3]];
    const pairs = locals.map((l, i) => {
      const s = mapToScene(frame, { pos: l, yaw: i * 10 });
      return { local: l, localYaw: i * 10, scene: s.pos!, sceneYaw: s.yaw! };
    });
    const got = inferApplyFrame(pairs)!;
    expect(got.yaw).toBeCloseTo(-64, 2);
    got.at.forEach((v, i) => expect(v).toBeCloseTo(frame.at[i]!, 2));
    expect(inferApplyFrame([])).toBeNull();
  });
});

describe("scene-level overrides (installer props)", () => {
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  const doc = () =>
    ({
      name: "s",
      version: 1,
      entities: {
        lantern: { name: "lantern", parent: null, tags: [], components: { transform: { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, prefab: { prefabId: "fixtures/lantern" } } },
        brazier: { name: "brazier", parent: null, tags: [], components: { transform: { position: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, prefab: { prefabId: "poi-props/brazier" } } },
      },
    }) as never;
  const file = ownerOverridesSchema.parse({
    scene: "s",
    frame: "scene",
    overrides: [
      { item: "lantern", set: { pos: [0, 1.5, 0], yaw: 90 } },
      { item: "brazier", deleted: true },
      { item: "lantern-owner-1", added: true, set: { prop: "fixtures/lantern", pos: [2, 1.5, 0] } },
    ],
  });
  it("brings the scene to the owner's state, idempotently, with an inverse", () => {
    const ops = sceneOwnerOps(doc(), file);
    const res = applyOps(doc(), ops as never, reg);
    const st = entityOwnerState(res.doc.entities["lantern"] as never);
    expect(st.pos).toEqual([0, 1.5, 0]);
    expect(st.yaw).toBeCloseTo(90);
    expect(res.doc.entities["brazier"]).toBeUndefined();
    expect(res.doc.entities["lantern-owner-1"]).toBeDefined();
    expect(sceneOwnerOps(res.doc as never, file)).toEqual([]); // second run: nothing to do
    const undone = applyOps(res.doc, res.inverse, reg).doc;
    expect(entityOwnerState(undone.entities["lantern"] as never)).toEqual(entityOwnerState((doc() as { entities: Record<string, never> }).entities["lantern"]!));
    expect(entityOwnerState(undone.entities["brazier"] as never).prop).toBe("poi-props/brazier");
    expect(undone.entities["lantern-owner-1"]).toBeUndefined();
  });
});

describe("scale range", () => {
  const kinds = { basket: { match: "basket", dim: "h" as const, range: [0.2, 0.6] as [number, number] } };
  it("keeps a kind inside its real size, and gives others a modest band", () => {
    expect(ownerScaleRange("props/basket-a", [0.4, 0.4, 0.4], kinds)).toEqual({ min: 0.5, max: 1.5, kind: "basket" });
    expect(ownerScaleRange("props/thing", [1, 1, 1], kinds)).toEqual({ min: 0.75, max: 1.33, kind: null });
  });
});
