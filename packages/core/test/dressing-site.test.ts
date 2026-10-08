import { describe, expect, it } from "vitest";
import { buildSiteSocketMap, dressingSchema, resolveDressing, socketMapSchema, type DressingData } from "../src/index.js";

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
    for (const a of map.anchors.filter((a) => a.kind !== "hearth" && a.kind !== "door")) expect(ch(a.position[0], a.position[2])).toBe("o");
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
});
