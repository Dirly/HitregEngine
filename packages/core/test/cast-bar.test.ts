import { describe, expect, it } from "vitest";
import { BADGE_NETSTATE, CAST_NETSTATE, NetStateStore, badgeKey, castBarProgress, castKey, readBadges, readCastBar, registerCharacterNetState } from "../src/index.js";

describe("cast bars (netState cast/<bodyId>)", () => {
  const bar = { id: "frostNova", label: "Frost Nova", tag: "D", color: "#ff6a24", school: "destruction", start: 10, end: 10.8 };

  it("is a validated netState namespace, keyed by body", () => {
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(castKey("b1")).toBe(`${CAST_NETSTATE}/b1`);
    expect(store.set(castKey("b1"), bar)).toBe(true);
    expect(store.set(castKey("b1"), { ...bar, color: "orange" })).toBe(false); // #rrggbb only
    expect(store.jsonSchemas()).toHaveProperty(CAST_NETSTATE);
  });

  it("reads tolerantly", () => {
    expect(readCastBar(bar)).toMatchObject(bar);
    expect(readCastBar({ label: 3 })).toBeNull();
    expect(readCastBar(undefined)).toBeNull();
  });

  it("fills over the wind-up and hides when it is over", () => {
    expect(castBarProgress(bar, 10)).toEqual({ fill: 0, visible: true, interrupted: false });
    expect(castBarProgress(bar, 10.4).fill).toBeCloseTo(0.5);
    expect(castBarProgress(bar, 10.8).visible).toBe(false);
    expect(castBarProgress({ ...bar, show: false }, 10.4).visible).toBe(false);
  });

  it("an interrupted bar holds where it stopped, for the linger only", () => {
    const stopped = { ...bar, interruptedAt: 10.2 };
    expect(castBarProgress(stopped, 10.5, 0.8)).toMatchObject({ visible: true, interrupted: true });
    expect(castBarProgress(stopped, 10.5).fill).toBeCloseTo(0.25);
    expect(castBarProgress(stopped, 11.1, 0.8).visible).toBe(false);
  });
});

describe("overhead badges (netState badge/<bodyId>)", () => {
  const lock = { id: "lock.shadow", text: "✕ SHADOW LOCKED", color: "#a77bff", until: 14 };

  it("is a validated netState namespace, keyed by body", () => {
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(badgeKey("b1")).toBe(`${BADGE_NETSTATE}/b1`);
    expect(store.set(badgeKey("b1"), [lock])).toBe(true);
    expect(store.set(badgeKey("b1"), [{ ...lock, color: "violet" }])).toBe(false);
    expect(store.jsonSchemas()).toHaveProperty(BADGE_NETSTATE);
  });

  it("reads the ones still running, tolerantly", () => {
    expect(readBadges([lock, { ...lock, id: "old", until: 9 }], 10)).toEqual([lock]);
    expect(readBadges([lock], 14)).toEqual([]);
    expect(readBadges("nope", 10)).toEqual([]);
  });

  it("a physical cast may carry a marker for its chip", () => {
    expect(readCastBar({ label: "Slam", start: 1, end: 2, show: false, mark: "■ HEAVY", color: "#ff7a1a" })?.mark).toBe("■ HEAVY");
  });
});
