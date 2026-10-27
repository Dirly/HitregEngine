import { describe, expect, it } from "vitest";
import { CHIMNEY_SMOKE, checkSmoke, chimneyPlume, measurePlume, parseVfxEffect, smokeCaps, smokeLayers } from "../src/index.js";

const smoke = (emitter: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseVfxEffect({
    ...extra,
    modules: [{ kind: "particles", id: "smoke", stream: true, color: "#8c8985", colorEnd: "#a9a6a2", blend: "normal", anchor: { at: "origin", offset: [0, 1, 0] }, emitter: { blending: "normal", space: "world", ...emitter } }],
  });

// the old landmark column (Ravenstacks 2026-10-22): ~60 m tall, dark, opaque, no wind, no night dim
const OLD_COLUMN = { rate: 3.4, max: 90, lifetime: [20, 26], shape: "sphere", shapeSize: [2.5, 0.5, 2.5], direction: [0.28, 1, 0.1], speed: [2.6, 3], spread: 6, turbulence: 0.35, turbulenceSpeed: 0.12, sizeCurve: [[0, 14], [0.3, 30], [1, 64]], opacityCurve: [[0, 0], [0.05, 0.85], [0.7, 0.55], [1, 0]] };
const THIN = { rate: 1.2, lifetime: [6, 7], shape: "sphere", shapeSize: [0.5, 0.3, 0.5], direction: [0, 1, 0], speed: [0.95, 1.15], spread: 3, turbulence: 0.08, turbulenceSpeed: 0.3, windDrift: 0.35, nightDim: 0.8, drag: 0.12, sizeCurve: [[0, 1], [0.5, 1.8], [1, 2.6]], opacityCurve: [[0, 0], [0.1, 0.3], [0.6, 0.15], [0.85, 0.04], [1, 0]] };
const PYRE = { height: 3.5, width: 5 };

describe("smoke standard", () => {
  it("measures a plume by running the particle integrator: a fast long-lived column is tall and wide", () => {
    const old = measurePlume((smoke(OLD_COLUMN).modules[0] as any).emitter, 4.5);
    expect(old.top).toBeGreaterThan(60);
    expect(old.width).toBeGreaterThan(40);
    const thin = measurePlume((smoke(THIN).modules[0] as any).emitter, 3);
    expect(thin.top).toBeLessThan(10);
    expect(thin.width).toBeLessThan(5);
  });

  it("fails the old castle column on every rule and passes the standard pyre column", () => {
    const rules = new Set(checkSmoke(smoke({ ...OLD_COLUMN, colorStart: "#232120" }, { smoke: "pyre" }), PYRE).map((f) => f.rule));
    for (const r of ["height", "width", "opacity", "colour", "night", "wind"]) expect(rules.has(r as never)).toBe(true);
    expect(checkSmoke(smoke(THIN, { smoke: "pyre" }), PYRE)).toEqual([]);
  });

  it("caps by source class: a pyre column may not stand over a torch", () => {
    expect(checkSmoke(smoke(THIN, { smoke: "pyre" }), { height: 1.7, width: 0.15 }).map((f) => f.rule)).toContain("height");
    expect(smokeCaps("pyre", PYRE).top).toBeCloseTo(10.5, 1);
    expect(smokeCaps("chimney", { height: 30, width: 2 }).width).toBe(1.5);
  });

  it("resolves material colours through the palette slot", () => {
    const fx = parseVfxEffect({ modules: [{ kind: "particles", id: "smoke", color: "primary", colorEnd: "glow", blend: "normal", emitter: { ...THIN, blending: "normal", space: "world" } }] });
    const dark = checkSmoke(fx, PYRE, (s) => (s === "primary" ? "#232120" : "#5e5852"), "pyre");
    expect(dark.filter((f) => f.rule === "colour")).toHaveLength(2);
    expect(checkSmoke(fx, PYRE, () => "#8a8682", "pyre")).toEqual([]);
  });

  it("only smoke layers count: mist banks and flames are not smoke", () => {
    const mist = parseVfxEffect({ modules: [{ kind: "particles", id: "bank", blend: "normal", emitter: { blending: "normal" } }, { kind: "particles", id: "smoke-ish", blend: "additive", emitter: {} }] });
    expect(smokeLayers(mist)).toHaveLength(0);
  });

  it("the chimney batch is a thin column inside the chimney class for a 4 m and a 10 m chimney", () => {
    expect(chimneyPlume(4).faults).toEqual([]);
    expect(chimneyPlume(10).faults).toEqual([]);
    expect(CHIMNEY_SMOKE.sizeStart + CHIMNEY_SMOKE.sizeGrow + CHIMNEY_SMOKE.lean).toBeLessThanOrEqual(1.5);
  });
});
