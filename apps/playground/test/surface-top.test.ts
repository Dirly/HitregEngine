import { test } from "node:test";
import assert from "node:assert/strict";
import { boxTris, surfaceTopUnder, trs, type PropGeometry, type Tri } from "../tools/_prop-geometry.mts";

// a crate 0.8 x 0.6 x 0.6 (foot origin) with a shelf board 0.4 m above its lid (the next board must not be taken)
const crate = (): PropGeometry => {
  const tris: Tri[] = [];
  boxTris([0.8, 0.6, 0.6], trs([0, 0.3, 0]), tris);
  boxTris([0.8, 0.03, 0.6], trs([0, 1.0, 0]), tris);
  return { tris } as unknown as PropGeometry;
};

test("a surface socket's height is the mesh top at it, whatever was declared", () => {
  for (const declared of [0.45, 0.6, 0.72]) {
    const top = surfaceTopUnder(crate(), { position: [0, declared, 0], size: [0.7, 0.4] });
    assert.ok(top !== null && Math.abs(top - 0.6) < 1e-6, `declared ${declared}: top ${top}`); // the lid, not the board above
  }
  const board = surfaceTopUnder(crate(), { position: [0, 1.0, 0], size: [0.7, 0.4] });
  assert.ok(board !== null && Math.abs(board - 1.015) < 1e-6, `board ${board}`);
  assert.equal(surfaceTopUnder(crate(), { position: [3, 0.6, 3], size: [0.2, 0.2] }), null); // off the mesh
});
