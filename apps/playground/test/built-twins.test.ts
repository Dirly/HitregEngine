import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropTwinFaces } from "../tools/_built-twins.mts";

const quad = (pts: number[][], flip: boolean) => ({ positions: Float32Array.from(pts.flat()), indices: Uint32Array.from(flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]), triangleCount: 2 });

describe("dropTwinFaces (coincident end caps)", () => {
  const cap = [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]];
  it("drops a back-to-back pair across two groups (different materials)", () => {
    const r = dropTwinFaces([quad(cap, false), quad(cap, true)]);
    assert.equal(r.dropped, 4);
    assert.deepEqual(r.groups.map((g) => g.triangleCount), [0, 0]);
  });
  it("keeps a lone face, and a duplicate facing the SAME way (not interior)", () => {
    const top = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]];
    const r = dropTwinFaces([quad(top, false), quad(cap, false), quad(cap, false)]);
    assert.equal(r.dropped, 0);
    assert.deepEqual(r.groups.map((g) => g.triangleCount), [2, 2, 2]);
  });
});
