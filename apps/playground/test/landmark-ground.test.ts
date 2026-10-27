import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleGround } from "../tools/_landmark-ground.mts";

describe("visibleGround (landmark buried trim reference)", () => {
  // heightfield 124 everywhere; a carve (air) down to 120.5 for x < 0; density > 0 is air
  const field = { height: () => 124, density: (x: number, y: number) => (y > (x < 0 ? 120.5 : 124) ? 1 : -1) };
  it("follows a carve below the heightfield", () => {
    const g = visibleGround(field)(-5, 0);
    assert.ok(Math.abs(g - 120.5) < 0.15, `got ${g}`);
  });
  it("is the heightfield where nothing is carved", () => {
    const g = visibleGround(field)(5, 0); assert.ok(g <= 124 && g > 123.85, `got ${g}`);
  });
  it("never sits above the heightfield (a solid stamp over the ground does not raise the reference)", () => {
    const raised = { height: () => 124, density: (_x: number, y: number) => (y > 130 ? 1 : -1) };
    assert.equal(visibleGround(raised)(0, 0), 124);
  });
});
