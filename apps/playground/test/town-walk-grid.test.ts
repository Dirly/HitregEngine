import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { walkGridBox } from "../tools/_town-grid.mts";

describe("walkGridBox (town-layout door-access grid)", () => {
  it("covers the pad with a 40 m margin when the town has no terraces", () => {
    assert.deepEqual(walkGridBox({ center: [0, 0], radius: 24, falloff: 21.6, terraces: [] }), [-85.6, -85.6, 85.6, 85.6]);
  });
  it("grows to every lot terrace outside the pad (a riverside lot 110 m out stays reachable)", () => {
    const [x0, z0, x1, z1] = walkGridBox({ center: [0, 0], radius: 24, falloff: 21.6, terraces: [{ points: [[40, 110], [44, 112]], radius: 40 }] });
    assert.ok(Math.abs(x0 + 85.6) < 0.005);
    assert.ok(Math.abs(z0 + 85.6) < 0.005);
    assert.equal(x1, 124);
    assert.equal(z1, 192);
  });
});
