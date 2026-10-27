import { test } from "node:test";
import assert from "node:assert/strict";
import { outrankFindings } from "../tools/_prop-real-size.mts";
import { bbmodelToMesh, placeMesh, sortQuad } from "../tools/bbmodel-export.mjs";

const outranked = new Map([["culture-craft/necro-skull-bone-pile", [{ role: "skull", by: "poi-props/skull" }]]]);
const superseded = new Map([["rocks/boulder", "rock-kit/boulder-m-2"]]);
const pile = { id: "pile-1", prop: "culture-craft/necro-skull-bone-pile", position: [0, 0, 0] };

test("owner-outranks: a painted heap with none of the owner's skulls on or beside it warns", () => {
  assert.deepEqual(outrankFindings([pile], outranked, superseded).map((x) => x.code), ["owner-outranks"]);
});

test("owner-outranks: the owner prop, or a prefab of its mesh, within the radius satisfies it", () => {
  assert.deepEqual(outrankFindings([pile, { id: "s", prop: "poi-props/skull", position: [1, 0, 0.5] }], outranked, superseded), []);
  assert.deepEqual(outrankFindings([pile, { id: "s", prop: "poi-props/skull-surface", position: [0, 0.2, 0] }], outranked, superseded), []);
  assert.equal(outrankFindings([pile, { id: "s", prop: "poi-props/skull", position: [3, 0, 0] }], outranked, superseded).length, 1);
});

test("superseded: a superseded prop placed directly warns", () => {
  assert.equal(outrankFindings([{ id: "b", prop: "rocks/boulder", position: [0, 0, 0] }], outranked, superseded)[0]?.code, "superseded");
});

test("bbmodel-export: a crossed quad is sorted into its rim order", () => {
  const pos: Record<string, number[]> = { a: [0, 0, 0], b: [1, 1, 0], c: [1, 0, 0], d: [0, 1, 0] };
  const k = sortQuad(["a", "b", "c", "d"], pos);
  for (let i = 0; i < 4; i++) {
    const p = pos[k[i]]!, q = pos[k[(i + 1) % 4]]!;
    assert.ok(p[0] === q[0] || p[1] === q[1], `edge ${k[i]}-${k[(i + 1) % 4]} crosses the square`);
  }
});

test("bbmodel-export: element rotation applied, recentred to the foot, scaled to a height", () => {
  const model = {
    resolution: { width: 16, height: 16 },
    textures: [{ name: "T", uv_width: 16, uv_height: 16 }],
    elements: [{
      type: "mesh", name: "Box", origin: [5, 5, 5], rotation: [90, 0, 0],
      vertices: { a: [0, 0, 0], b: [2, 0, 0], c: [2, 0, 4], d: [0, 0, 4] },
      faces: { f: { vertices: ["a", "b", "c", "d"], uv: { a: [0, 0], b: [16, 0], c: [16, 16], d: [0, 16] }, texture: 0 } },
    }],
  };
  const mesh = bbmodelToMesh(model, ["Box"]);
  const size = placeMesh(mesh, { height: 1 });
  assert.ok(Math.abs(size[1] - 1) < 1e-6, "the 4-unit z extent is the height after +90 about X");
  assert.ok(Math.abs(size[0] - 0.5) < 1e-6);
  const ys = mesh.groups[0].positions.filter((_: number, i: number) => i % 3 === 1);
  assert.ok(Math.abs(Math.min(...ys)) < 1e-6);
  assert.throws(() => bbmodelToMesh(model, ["Nope"]), /no mesh element/);
});
