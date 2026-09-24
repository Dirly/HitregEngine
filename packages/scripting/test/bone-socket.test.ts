import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type Op } from "@hitreg/core";
import { registerBuiltinScripts, ScriptRegistry, ScriptRuntime } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

/** A character with a forearm and a hand bone, and a shield socketed to it. */
function harness(params: Record<string, unknown>) {
  const ops: Op[] = [
    { op: "add-entity", id: "char", entity: { name: "char", parent: null, tags: [], components: { transform: {} } } },
    {
      op: "add-entity",
      id: "shield",
      entity: { name: "shield", parent: "char", tags: [], components: { transform: {}, script: { name: "bone-socket", params } } },
    },
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const char = new THREE.Object3D();
  const forearm = new THREE.Object3D();
  forearm.name = "Forearm";
  forearm.position.set(0, 1, 0);
  const hand = new THREE.Object3D();
  hand.name = "Hand";
  hand.position.set(0, 0.3, 0);
  hand.rotation.set(0, 0, Math.PI / 2); // a bent wrist: the two bones disagree
  forearm.add(hand);
  char.add(forearm);
  const shield = new THREE.Object3D();
  char.add(shield);
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  const runtime = new ScriptRuntime({
    doc,
    objects: new Map([
      ["char", char],
      ["shield", shield],
    ]),
    sim: null,
    registry,
    input: { isDown: () => false },
  });
  runtime.start();
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60);
  };
  return { char, shield, step, runtime };
}

describe("bone-socket second pose", () => {
  const params = {
    bone: "Forearm",
    offset: [0.05, 0.2, 0],
    rotationDeg: [0, 0, 0],
    altBone: "Hand",
    altOffset: [0, 0.1, 0],
    altRotationDeg: [90, 0, 0],
    altWhen: "guarding",
    altBlend: 0.25,
  };

  it("carries on the main bone, eases to the second pose off ITS bone while the flag holds, and back", () => {
    const h = harness(params);
    h.step();
    expect(h.shield.position.toArray().map((v) => +v.toFixed(3))).toEqual([0.05, 1.2, 0]);
    expect(h.shield.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 5);

    h.char.userData["guarding"] = true;
    h.step(3); // part-way: somewhere between the two, not snapped
    const mid = h.shield.position.clone();
    expect(mid.distanceTo(new THREE.Vector3(0.05, 1.2, 0))).toBeGreaterThan(0.001);

    h.step(30);
    // the hand sits at (0, 1.3, 0) rotated 90° about Z: its +Y offset points along -X
    expect(h.shield.position.x).toBeCloseTo(-0.1, 3);
    expect(h.shield.position.y).toBeCloseTo(1.3, 3);
    const want = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, 0, Math.PI / 2))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
    expect(h.shield.quaternion.angleTo(want)).toBeCloseTo(0, 3);

    h.char.userData["guarding"] = false;
    h.step(30);
    expect(h.shield.position.y).toBeCloseTo(1.2, 3);
  });

  it("a time flag counts while it is in the future — how combatUntil works", () => {
    const h = harness({ ...params, altWhen: "combatUntil", altBlend: 0 });
    h.char.userData["combatUntil"] = 1e9;
    h.step();
    expect(h.shield.position.y).toBeCloseTo(1.3, 3);
    h.char.userData["combatUntil"] = 0;
    h.step();
    expect(h.shield.position.y).toBeCloseTo(1.2, 3);
  });

  it("follows params patched into it while running — an inspector nudge during play", () => {
    const h = harness({ bone: "Forearm", offset: [0, 0, 0], rotationDeg: [0, 0, 0] });
    h.step();
    expect(h.shield.position.y).toBeCloseTo(1, 5);
    expect(h.runtime.updateParams("shield", "bone-socket", { bone: "Hand", offset: [0, 0.1, 0], rotationDeg: [0, 90, 0] })).toBe(true);
    h.step();
    // now off the hand (1.3 up, turned 90° about Z so its +Y offset runs along -X)
    expect(h.shield.position.x).toBeCloseTo(-0.1, 3);
    expect(h.shield.position.y).toBeCloseTo(1.3, 3);
    const want = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, 0, Math.PI / 2))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)));
    expect(h.shield.quaternion.angleTo(want)).toBeCloseTo(0, 3);
    // a different script is not a param edit
    expect(h.runtime.updateParams("shield", "equipment-look", {})).toBe(false);
  });

  it("re-seats on the bone after animation (lateUpdate), not a fixed tick behind", () => {
    const h = harness({ bone: "Forearm", offset: [0, 0, 0], rotationDeg: [0, 0, 0] });
    h.step();
    const forearm = h.char.getObjectByName("Forearm")!;
    forearm.position.set(0.5, 1, 0); // the animator moved the arm this frame
    forearm.updateMatrixWorld(true);
    expect(h.shield.position.x).toBeCloseTo(0, 5); // still where the last tick left it
    h.runtime.lateUpdate(1 / 60);
    expect(h.shield.position.x).toBeCloseTo(0.5, 5);
  });
});
