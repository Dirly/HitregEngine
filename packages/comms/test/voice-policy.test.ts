import { describe, expect, it } from "vitest";
import { VoiceGate, isOfferer, proximityGain, rms, voiceTargets } from "../src/index.js";
import { staticMembership } from "../src/index.js";

describe("voiceTargets", () => {
  const membership = staticMembership({ teams: { a: "red", b: "red", c: "blue" } });
  const positions: Record<string, [number, number, number]> = { a: [0, 0, 0], b: [2, 0, 0], c: [50, 0, 0] };
  const ctx = {
    teamOf: (id: string) => membership.teamOf(id),
    partyOf: (id: string) => membership.partyOf(id),
    positionOf: (id: string) => positions[id] ?? null,
  };

  it("never includes self, follows the shared routing rule", () => {
    expect([...voiceTargets("a", "team", ["a", "b", "c"], ctx, 25)]).toEqual(["b"]);
    expect([...voiceTargets("a", "proximity", ["a", "b", "c"], ctx, 25)]).toEqual(["b"]);
    expect([...voiceTargets("a", "global", ["a", "b", "c"], ctx, 25)].sort()).toEqual(["b", "c"]);
  });

  it("is empty when the channel is unavailable (no party)", () => {
    expect(voiceTargets("a", "party", ["a", "b"], ctx, 25).size).toBe(0);
  });
});

describe("proximityGain", () => {
  it("is 1 inside the full-volume radius, 0 at/after the radius, monotonic between", () => {
    expect(proximityGain(0, 20, 5)).toBe(1);
    expect(proximityGain(5, 20, 5)).toBe(1);
    expect(proximityGain(20, 20, 5)).toBe(0);
    expect(proximityGain(25, 20, 5)).toBe(0);
    const mid = proximityGain(12.5, 20, 5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(proximityGain(8, 20, 5)).toBeGreaterThan(proximityGain(16, 20, 5));
  });
  it("tolerates degenerate config", () => {
    expect(proximityGain(1, 0, 0)).toBe(0);
    expect(proximityGain(1, 10, 50)).toBe(1); // fullRadius clamped to radius
  });
});

describe("isOfferer", () => {
  it("exactly one side of every pair offers", () => {
    expect(isOfferer("a", "b")).toBe(true);
    expect(isOfferer("b", "a")).toBe(false);
    expect(isOfferer("p-1", "p-1")).toBe(false);
  });
});

describe("rms / VoiceGate", () => {
  it("rms measures loudness", () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
  });

  it("opens on speech, holds through short pauses, closes after the hold time", () => {
    const gate = new VoiceGate(0.02, 300);
    expect(gate.update(0.001, 0)).toBe(false);
    expect(gate.update(0.05, 10)).toBe(true);
    expect(gate.update(0.0, 100)).toBe(true); // pause, within hold
    expect(gate.update(0.0, 300)).toBe(true);
    expect(gate.update(0.0, 401)).toBe(false); // hold elapsed
    expect(gate.isOpen()).toBe(false);
    // a level between the close and open thresholds keeps an open gate open
    gate.update(0.05, 500);
    expect(gate.update(0.015, 900)).toBe(true);
    expect(gate.update(0.015, 2000)).toBe(true);
  });
});
