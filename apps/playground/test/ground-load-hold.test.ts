import { test } from "node:test";
import assert from "node:assert/strict";
import { GroundLoadHold } from "../src/ground-load-hold.js";

test("a hidden client stays at its spawn height over thousands of fixed steps without a rendered frame", () => {
  let position: [number, number, number] = [10, 84, 20];
  let velocity: [number, number, number] = [2, 0, 3];
  let loaded = false;
  const sim = {
    getPosition: () => [...position] as [number, number, number],
    setTranslation: (_id: string, p: [number, number, number]) => { position = p; },
    getLinvel: () => [...velocity] as [number, number, number],
    setLinvel: (_id: string, v: [number, number, number]) => { velocity = v; },
  };
  const hold = new GroundLoadHold();
  const update = () => hold.update(sim, "player", () => loaded);
  update();
  for (let i = 0; i < 3600; i++) {
    velocity[1] -= 9.81 / 60;
    position[1] += velocity[1] / 60;
    update();
  }
  assert.deepEqual(position, [10, 84, 20]);
  assert.deepEqual(velocity, [2, 0, 3]);
  loaded = true;
  position[1] = 83.9;
  velocity[1] = -1;
  update();
  assert.equal(position[1], 83.9);
  assert.equal(velocity[1], -1);
  // Another play session must not inherit a hold from the previous scene.
  hold.reset(); loaded = false; position[1] = 4;
  update();
  assert.equal(position[1], 4);
  position[1] = 100; // authoritative teleport while the ground is loading
  update(); position[1] = 99; update();
  assert.equal(position[1], 100);
});
