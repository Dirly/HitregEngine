// node --test tools/mesh-dc/plane-owner.test.mjs
// One mesh owns each plane: two dc_groups whose stone overlaps on a shared plane (a wall built outward from the shared
// room line, two floor slabs both running through a door threshold) z-fight when each bakes its own face. With
// convertMeshStamp's plane ownership the later group is cut by the earlier one's crisp solids: no same-facing
// coplanar overlap is left, and the later group keeps all its stone that nobody else owns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { convertMeshStamp } from "./convert.mjs";
import { ownerCutNode, meshSolids } from "./plane-owner.mjs";

const require = createRequire(new URL("../../apps/playground/package.json", import.meta.url));
const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
const { createVolume, buildVolumeMesh } = await tsImport("../../packages/core/src/voxel/csg.ts", import.meta.url);
const { findZFights } = await tsImport("../../packages/core/src/zfight.ts", import.meta.url);

function addBox(mesh, [x0, y0, z0], [x1, y1, z1]) {
  const o = mesh.positions.length / 3;
  for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) mesh.positions.push(x, y, z);
  const q = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  for (const [a, b, c, d] of q) mesh.indices.push(o + a, o + b, o + c, o + a, o + c, o + d);
  mesh.solidTriangleCounts.push(12);
  mesh.triangleMaterials.push(...Array(12).fill(0));
}
const group = (name, boxes) => { const m = { name, positions: [], indices: [], solidTriangleCounts: [], triangleMaterials: [] }; for (const b of boxes) addBox(m, ...b); return m; };

// "hall" first (the owner), "annex" second. Floors share the top plane y = 0 over x 6..8.4, the threshold; the annex's
// wall sits inside the hall's east wall, sharing its west face x = 8.4 and its top y = 3. Every shared plane is a lattice
// plane at 0.12 (y = 0, x = 8.4 = 70 cells): samples lie exactly on them.
const stamp = () => ({
  version: 1, name: "owner-test", palette: [{ id: "stone", color: "#808080" }],
  meshes: [
    group("hall", [[[0, -0.6, 0], [8.4, 0, 6]], [[8.4, 0, 0], [9.4, 3, 6]]]),
    group("annex", [[[6, -0.6, 0], [14, 0, 6]], [[8.4, 0, 0], [9, 3, 6]]]),
  ],
});

function bake(ownPlanes) {
  const { volumes } = convertMeshStamp(stamp(), { name: "owner-test", voxelSize: 0.12, ownPlanes });
  return volumes.map((v) => {
    const m = buildVolumeMesh(createVolume(v.doc));
    const soup = [];
    for (const i of m.indices) soup.push(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
    return { id: v.name, positions: soup };
  });
}
function upArea(soup) {
  let area = 0;
  for (let t = 0; t < soup.length; t += 9) {
    const e1 = [soup[t + 3] - soup[t], soup[t + 4] - soup[t + 1], soup[t + 5] - soup[t + 2]];
    const e2 = [soup[t + 6] - soup[t], soup[t + 7] - soup[t + 1], soup[t + 8] - soup[t + 2]];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    if (ny > 0) area += ny / 2;
  }
  return area;
}

test("overlapping groups z-fight without plane ownership (the bug the zfight gate found)", () => {
  const report = findZFights(bake(false));
  assert.ok(report.clusters.length >= 2, `expected the floor and the wall fights, got ${report.clusters.length}`);
});

test("with plane ownership no two groups bake the same plane, and the later group keeps its own stone", () => {
  const meshes = bake(true);
  const report = findZFights(meshes);
  assert.equal(report.clusters.length, 0, JSON.stringify(report.clusters.slice(0, 3)));
  // annex floor top: x 8.4..14 = 5.6 x 6 m (under the hall wall it stays, back to back with the wall foot); nothing of
  // the threshold 6..8.4 (the hall owns it) and nothing of its wall (inside the hall wall)
  const annex = meshes.find((m) => m.id === "annex");
  const up = upArea(annex.positions);
  assert.ok(Math.abs(up - 33.6) < 0.5, `annex up-facing area ${up.toFixed(2)} m2, expected 33.6`);
  const hall = meshes.find((m) => m.id === "hall");
  assert.ok(Math.abs(upArea(hall.positions) - (8.4 * 6 + 6)) < 0.5, "hall keeps its floor and wall top");
});

test("no crack where the owner's stone ends and the later group's goes on (a ground ray at the seam hits floor)", () => {
  // the threshold floor without the walls: the hall floor ends at x = 8.4, the annex floor runs on to 14
  const s = stamp();
  s.meshes = [group("hall", [[[0, -0.6, 0], [8.4, 0, 6]]]), group("annex", [[[6, -0.6, 0], [14, 0, 6]]])];
  const meshes = convertMeshStamp(s, { name: "owner-test", voxelSize: 0.12 }).volumes.map((v) => buildVolumeMesh(createVolume(v.doc)));
  const hitDown = (x, z) => meshes.some((m) => {
    for (let t = 0; t < m.indices.length; t += 3) {
      const p = [0, 1, 2].map((k) => [m.positions[m.indices[t + k] * 3], m.positions[m.indices[t + k] * 3 + 2]]);
      const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const q = [x, z], s1 = d(p[0], p[1], q), s2 = d(p[1], p[2], q), s3 = d(p[2], p[0], q);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
    }
    return false;
  });
  for (const dx of [-0.01, -0.001, 0, 0.0005, 0.001, 0.002, 0.004, 0.01]) for (const z of [0.5, 3, 5.5])
    assert.ok(hitDown(8.4 + dx, z), `a ray down at x = ${8.4 + dx}, z = ${z} falls through`);
});

test("the cut only takes earlier groups' solids that reach the group", () => {
  const s = stamp();
  const far = group("far", [[[100, 0, 0], [101, 1, 1]]]);
  const cut = ownerCutNode([{ name: "far", mesh: far }, { name: "hall", mesh: s.meshes[0] }], [6, -0.6, 0], [14, 3, 6], { margin: 0.36 });
  assert.deepEqual(cut.from, [{ group: "hall", solids: 2 }]);
  assert.equal(cut.node.op, "sub");
  // an exact copy of the owner's solid (no growth: a grown cut leaves a crack at the seam)
  const [floor] = meshSolids(cut.node.mesh);
  assert.deepEqual([floor.lo, floor.hi], [[0, -0.6, 0], [8.4, 0, 6]]);
  assert.equal(ownerCutNode([{ name: "far", mesh: far }], [6, -0.6, 0], [14, 3, 6], { margin: 0.36 }), null);
});

test("ownerOrder puts a group first: it keeps every shared plane and the stamp-earlier group is cut instead", () => {
  const { volumes } = convertMeshStamp(stamp(), { name: "owner-test", voxelSize: 0.12, ownerOrder: ["annex"] });
  const hall = volumes.find((v) => v.name === "hall"), annex = volumes.find((v) => v.name === "annex");
  assert.ok(hall.doc.nodes.some((n) => n.op === "sub") && !annex.doc.nodes.some((n) => n.op === "sub"));
  const meshes = volumes.map((v) => { const m = buildVolumeMesh(createVolume(v.doc)); const soup = []; for (const i of m.indices) soup.push(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]); return { id: v.name, positions: soup }; });
  assert.equal(findZFights(meshes).clusters.length, 0);
  assert.throws(() => convertMeshStamp(stamp(), { name: "owner-test", ownerOrder: ["nope"] }), /ownerOrder/);
});
