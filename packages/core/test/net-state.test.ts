import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NetStateStore } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NetStateStore", () => {
  it("authority writes, reads, increments, deletes", () => {
    const store = new NetStateStore();
    expect(store.set("enemyHp/wolf-1", 80)).toBe(true);
    expect(store.get("enemyHp/wolf-1")).toBe(80);
    expect(store.increment("enemyHp/wolf-1", -30)).toBe(50);
    expect(store.increment("score/kills")).toBe(1); // missing = 0
    expect(store.keys("enemyHp/")).toEqual(["enemyHp/wolf-1"]);
    expect(store.delete("enemyHp/wolf-1")).toBe(true);
    expect(store.get("enemyHp/wolf-1")).toBeUndefined();
  });

  it("peers are read-only replicas — writes warn and no-op", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new NetStateStore();
    store.setAuthority(false);
    expect(store.set("taken/crystal-1", true)).toBe(false);
    expect(store.increment("score/kills")).toBeNull();
    expect(store.delete("anything/x")).toBe(false);
    expect(store.get("taken/crystal-1")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("validates against defined namespace schemas; rejects bad keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new NetStateStore();
    store.define("enemyHp", z.number().min(0).max(500));
    expect(store.set("enemyHp/wolf-1", 80)).toBe(true);
    expect(store.set("enemyHp/wolf-1", "dead")).toBe(false); // schema
    expect(store.set("enemyHp/wolf-1", 9999)).toBe(false); // schema range
    expect(store.get("enemyHp/wolf-1")).toBe(80); // untouched by rejects
    expect(store.set("no-slash", 1)).toBe(false); // key shape
    expect(() => store.define("enemyHp", z.string())).toThrow(/already defined/);
    expect(warn).toHaveBeenCalled();
  });

  it("tracks deltas: takeDelta drains sets and removals", () => {
    const store = new NetStateStore();
    expect(store.takeDelta()).toBeNull(); // clean store
    store.set("a/x", 1);
    store.set("a/y", 2);
    store.delete("a/y");
    expect(store.takeDelta()).toEqual({ set: { "a/x": 1 }, removed: ["a/y"] });
    expect(store.takeDelta()).toBeNull(); // drained
    store.set("a/x", 3);
    expect(store.takeDelta()).toEqual({ set: { "a/x": 3 }, removed: [] });
  });

  it("applyRemote: deltas merge, full syncs replace (dropping absent keys)", () => {
    const replica = new NetStateStore();
    replica.setAuthority(false);
    replica.applyRemote({ full: { "a/x": 1, "a/y": 2 } });
    expect(replica.get("a/x")).toBe(1);
    replica.applyRemote({ delta: { set: { "a/x": 5 }, removed: ["a/y"] } });
    expect(replica.get("a/x")).toBe(5);
    expect(replica.get("a/y")).toBeUndefined();
    // a later full sync is authoritative about what EXISTS
    replica.applyRemote({ full: { "b/z": 9 } });
    expect(replica.get("a/x")).toBeUndefined();
    expect(replica.get("b/z")).toBe(9);
  });

  it("onChange fires for local writes, replicated changes, and deletions", () => {
    const store = new NetStateStore();
    const seen: Array<[string, unknown]> = [];
    const off = store.onChange((k, v) => seen.push([k, v]));
    store.set("a/x", 1);
    store.set("a/x", 1); // primitive no-op — no event
    store.applyRemote({ delta: { set: { "a/x": 2 }, removed: [] } });
    store.delete("a/x");
    off();
    store.set("a/x", 7); // unsubscribed
    expect(seen).toEqual([
      ["a/x", 1],
      ["a/x", 2],
      ["a/x", undefined],
    ]);
  });

  it("migration: a promoted replica keeps its contents as authoritative state", () => {
    const replica = new NetStateStore();
    replica.setAuthority(false);
    replica.applyRemote({ full: { "enemyHp/wolf-1": 40, "quest/kills": 3 } });
    // host left — this tab is promoted
    replica.setAuthority(true);
    expect(replica.get("enemyHp/wolf-1")).toBe(40); // inherited, not reset
    expect(replica.increment("quest/kills")).toBe(4); // and now writable
    expect(replica.snapshot()).toEqual({ "enemyHp/wolf-1": 40, "quest/kills": 4 });
  });

  it("exports JSON Schema per defined namespace", () => {
    const store = new NetStateStore();
    store.define("enemyHp", z.number());
    expect(Object.keys(store.jsonSchemas())).toEqual(["enemyHp"]);
  });
});
