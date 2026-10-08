import { test } from "node:test";
import assert from "node:assert/strict";
import { interiorUnitFor, placeUnder, RESIDENT_CULLING, worldMatrixOf, type PlacementEntity } from "../tools/town-npc-placement.mts";
import * as THREE from "three";

// a rotated, offset building with its interior unit under it, as the town tools emit them
const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
const entities: Record<string, PlacementEntity> = {
  town: { parent: null, components: { transform: { position: [100, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } },
  tavern: { parent: "town", components: { transform: { position: [10, 2, -5], rotation: [q.x, q.y, q.z, q.w], scale: [1, 1, 1] }, mesh: {} } },
  "tavern-interior": { parent: "tavern", components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, culling: { interior: true, reveal: 12 } } },
  shed: { parent: "town", components: { transform: {} } },
};

test("a resident inside a building resolves to that building's interior unit, by building or by unit", () => {
  assert.equal(interiorUnitFor(entities, "tavern"), "tavern-interior");
  assert.equal(interiorUnitFor(entities, "tavern-interior"), "tavern-interior");
  assert.equal(interiorUnitFor(entities, "shed"), null);
  assert.equal(interiorUnitFor(entities, "nowhere"), null);
});

test("placed under the interior unit, the resident stands at the same world point and facing", () => {
  const world: [number, number, number] = [111, 3, -7];
  const yaw = 0.7;
  const local = placeUnder(entities, "tavern-interior", world, yaw);
  // put the resident into the document and read its world transform back through the chain
  const doc = { ...entities, npc: { parent: "tavern-interior", components: { transform: { ...local, scale: [1, 1, 1] } } } };
  const m = worldMatrixOf(doc, "npc");
  const p = new THREE.Vector3(), r = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, r, s);
  assert.ok(p.distanceTo(new THREE.Vector3(...world)) < 1e-9);
  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  assert.ok(r.angleTo(expected) < 1e-9);
  // the interior unit hides it from outside: its parent chain contains the unit
  assert.equal(doc.npc.parent, "tavern-interior");
});

test("outside, the resident stays in world space and carries the screen-size culling", () => {
  const local = placeUnder(entities, null, [1, 2, 3], 0);
  assert.deepEqual(local.position, [1, 2, 3]);
  assert.equal(RESIDENT_CULLING.minScreenPx > 0, true);
  assert.equal(RESIDENT_CULLING.interior, false);
});
