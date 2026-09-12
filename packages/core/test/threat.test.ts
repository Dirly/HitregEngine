import { describe, expect, it } from "vitest";
import { ThreatTable } from "../src/index.js";

describe("ThreatTable", () => {
  it("holds on whoever it hates most, not whoever acted last", () => {
    // The whole reason the table exists: a tank keeps a boar by having earned
    // it, so one late poke from someone else does not steal the fight.
    const t = new ThreatTable({ halfLife: 0 });
    t.add("tank", 100, 0);
    t.add("mage", 10, 0);
    expect(t.top(0)).toBe("tank");
    t.add("mage", 30, 0);
    expect(t.top(0)).toBe("tank");
    t.add("mage", 100, 0);
    expect(t.top(0)).toBe("mage");
  });

  it("decays on a half-life, and only when read", () => {
    const t = new ThreatTable({ halfLife: 10 });
    t.add("tank", 80, 0);
    expect(t.get("tank", 0)).toBe(80);
    expect(t.get("tank", 10)).toBeCloseTo(40);
    expect(t.get("tank", 20)).toBeCloseTo(20);
  });

  it("lets a latecomer overtake once the old threat has decayed", () => {
    const t = new ThreatTable({ halfLife: 5 });
    t.add("tank", 100, 0);
    t.add("mage", 20, 20); // tank is down to 6.25 by now
    expect(t.top(20)).toBe("mage");
  });

  it("never decays with a half-life of 0", () => {
    const t = new ThreatTable({ halfLife: 0 });
    t.add("tank", 10, 0);
    expect(t.get("tank", 10_000)).toBe(10);
  });

  it("forgets entries that have decayed to nothing", () => {
    const t = new ThreatTable({ halfLife: 1, forgetBelow: 0.5 });
    t.add("mage", 4, 0);
    t.add("tank", 100, 0);
    expect(t.size).toBe(2);
    // At t=5 the mage is down to 0.125 (gone) and the tank to 3.125 (kept).
    t.top(5); // reading is what prunes
    expect(t.size).toBe(1);
    expect(t.get("mage", 5)).toBe(0);
  });

  it("takes a taunt seriously: top of the table AND forced, for a while", () => {
    const t = new ThreatTable({ halfLife: 0 });
    t.add("mage", 500, 0);
    t.taunt("tank", 0, 3);
    expect(t.forcedTarget(0)).toBe("tank");
    expect(t.top(0)).toBe("tank");
    // The window closes, but the threat it granted is still there — that is
    // what stops the mob turning away the instant the taunt ends.
    expect(t.forcedTarget(4)).toBeNull();
    expect(t.top(4)).toBe("tank");
  });

  it("does not honour a taunt from a target that is no longer valid", () => {
    // A forced target that walked off is not a target; a mob that kept
    // charging would run itself off its leash on a three-second promise.
    const t = new ThreatTable({ halfLife: 0 });
    t.add("mage", 50, 0);
    t.taunt("tank", 0, 3);
    expect(t.top(1, (id) => id !== "tank")).toBe("mage");
  });

  it("skips invalid targets when picking the top", () => {
    const t = new ThreatTable({ halfLife: 0 });
    t.add("dead-guy", 900, 0);
    t.add("mage", 10, 0);
    expect(t.top(0, (id) => id !== "dead-guy")).toBe("mage");
  });

  it("set replaces, add accrues, negative amounts drop threat", () => {
    const t = new ThreatTable({ halfLife: 0 });
    expect(t.add("mage", 40, 0)).toBe(40);
    expect(t.add("mage", 10, 0)).toBe(50);
    expect(t.set("mage", 5, 0)).toBe(5);
    expect(t.add("mage", -3, 0)).toBe(2);
  });

  it("reports the table angriest first, for a debug readout", () => {
    const t = new ThreatTable({ halfLife: 0 });
    t.add("mage", 10, 0);
    t.add("tank", 90, 0);
    t.add("healer", 40, 0);
    expect(t.list(0).map((e) => e.id)).toEqual(["tank", "healer", "mage"]);
  });

  it("clears — which is what makes a leash a real escape", () => {
    const t = new ThreatTable({ halfLife: 0 });
    t.add("tank", 100, 0);
    t.taunt("tank", 0, 10);
    t.clear();
    expect(t.top(0)).toBeNull();
    expect(t.forcedTarget(1)).toBeNull();
    expect(t.size).toBe(0);
  });

  it("forgets one source without disturbing the rest", () => {
    const t = new ThreatTable({ halfLife: 0 });
    t.add("tank", 100, 0);
    t.add("mage", 10, 0);
    t.taunt("tank", 0, 10);
    t.forget("tank");
    expect(t.forcedTarget(1)).toBeNull();
    expect(t.top(0)).toBe("mage");
  });

  it("is empty and quiet before anything happens", () => {
    const t = new ThreatTable();
    expect(t.top(0)).toBeNull();
    expect(t.get("nobody", 0)).toBe(0);
    expect(t.list(0)).toEqual([]);
  });
});
