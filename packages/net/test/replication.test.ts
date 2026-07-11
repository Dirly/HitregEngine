import { describe, expect, it } from "vitest";
import { computeView, dueThisTick, type ReplicaEntry } from "../src/index.js";

const entry = (id: string, x: number, over: Partial<ReplicaEntry> = {}): ReplicaEntry => ({
  id,
  p: [x, 0, 0],
  relevancy: "proximity",
  radius: 10,
  sendEvery: 1,
  ...over,
});

describe("computeView (interest management)", () => {
  it("includes proximity entities within radius, excludes beyond", () => {
    const { view, entered, left } = computeView(
      [0, 0, 0],
      [entry("near", 5), entry("far", 50)],
      new Set(),
    );
    expect([...view]).toEqual(["near"]);
    expect(entered).toEqual(["near"]);
    expect(left).toEqual([]);
  });

  it("always-relevancy entities transmit regardless of distance or center", () => {
    const always = entry("global", 9999, { relevancy: "always" });
    expect(computeView([0, 0, 0], [always], new Set()).view.has("global")).toBe(true);
    // no center (peer not playing): only always-entities apply
    const noCenter = computeView(null, [always, entry("near", 1)], new Set());
    expect([...noCenter.view]).toEqual(["global"]);
  });

  it("hysteresis: an in-view entity leaves only past radius + padding", () => {
    const prev = new Set(["e"]);
    // at 12: outside radius 10, inside 10+5 — stays (was in view)
    expect(computeView([0, 0, 0], [entry("e", 12)], prev).view.has("e")).toBe(true);
    // …but a fresh peer at the same distance does NOT enter
    expect(computeView([0, 0, 0], [entry("e", 12)], new Set()).view.has("e")).toBe(false);
    // at 16: beyond padding — leaves
    const gone = computeView([0, 0, 0], [entry("e", 16)], prev);
    expect(gone.view.has("e")).toBe(false);
    expect(gone.left).toEqual(["e"]);
  });

  it("reports entered and left deltas against prev", () => {
    const prev = new Set(["stay", "leaving"]);
    const { entered, left, view } = computeView(
      [0, 0, 0],
      [entry("stay", 3), entry("leaving", 99), entry("fresh", 4)],
      prev,
    );
    expect(entered).toEqual(["fresh"]);
    expect(left).toEqual(["leaving"]);
    expect([...view].sort()).toEqual(["fresh", "stay"]);
  });

  it("uses 3D distance", () => {
    const up = entry("up", 0, { p: [0, 11, 0] });
    expect(computeView([0, 0, 0], [up], new Set()).view.has("up")).toBe(false);
  });
});

describe("dueThisTick (send cadence)", () => {
  it("sendEvery 1 is due every tick", () => {
    for (let t = 0; t < 5; t++) expect(dueThisTick(entry("a", 0), t)).toBe(true);
  });

  it("sendEvery N is due exactly once per N ticks", () => {
    const e = entry("npc-7", 0, { sendEvery: 4 });
    const due = [0, 1, 2, 3, 4, 5, 6, 7].filter((t) => dueThisTick(e, t));
    expect(due.length).toBe(2);
    expect(due[1]! - due[0]!).toBe(4);
  });

  it("staggers phase by id so same-rate entities do not burst together", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const dueAtTick0 = ids.filter((id) => dueThisTick(entry(id, 0, { sendEvery: 4 }), 0));
    expect(dueAtTick0.length).toBeLessThan(ids.length); // not all at once
  });
});
