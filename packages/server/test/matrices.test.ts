import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { updateChanged } from "../src/world.js";

/**
 * The server's per-step matrix pass (HeadlessWorld.updateLiveMatrices) skips objects that did not move:
 * it must leave exactly the matrices three's full `updateMatrixWorld(true)` would.
 */
describe("updateChanged: the same matrices as a full pass, without the idle work", () => {
  function tree(seed: number): THREE.Object3D[] {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const all: THREE.Object3D[] = [];
    const root = new THREE.Object3D();
    all.push(root);
    for (let i = 0; i < 40; i++) {
      const o = new THREE.Object3D();
      o.position.set(rnd() * 5, rnd() * 5, rnd() * 5);
      o.quaternion.setFromEuler(new THREE.Euler(rnd(), rnd(), rnd()));
      o.scale.setScalar(1 + rnd() * 0.3);
      all[Math.floor(Math.abs(rnd()) * all.length)]!.add(o);
      all.push(o);
    }
    return all;
  }

  it("matches three after random moves, step after step", () => {
    const a = tree(7);
    const b = tree(7); // the same tree, updated by three
    let s = 99;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let step = 0; step < 30; step++) {
      // move a few objects (root included now and then), the same way in both trees
      for (let k = 0; k < 4; k++) {
        const i = Math.floor(Math.abs(rnd()) * a.length);
        const dx = rnd();
        const yaw = rnd();
        for (const t of [a, b]) {
          t[i]!.position.x += dx;
          t[i]!.rotation.y += yaw;
        }
      }
      updateChanged(a[0]!, false);
      b[0]!.updateMatrixWorld(true);
      for (let i = 0; i < a.length; i++) {
        const ea = a[i]!.matrixWorld.elements;
        const eb = b[i]!.matrixWorld.elements;
        for (let j = 0; j < 16; j++) expect(ea[j]).toBeCloseTo(eb[j]!, 9);
      }
    }
  });
});
