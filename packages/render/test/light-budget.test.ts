import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { LightBudgetSystem } from "../src/light-budget.js";

describe("LightBudgetSystem", () => {
  it("keeps only the highest-ranked visible point lights active", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const budget = new LightBudgetSystem(2);
    const near = new THREE.PointLight();
    const important = new THREE.PointLight();
    const far = new THREE.PointLight();
    near.position.x = 2;
    important.position.x = 20;
    far.position.x = 10;
    scene.add(near, important, far);
    budget.register(near, 1);
    budget.register(important, 100);
    budget.register(far, 1);

    budget.update(scene, camera);

    expect(near.visible).toBe(true);
    expect(important.visible).toBe(true);
    expect(far.visible).toBe(false);
    expect(budget.stats()).toMatchObject({ active: 2, budget: 2 });
  });

  it("never re-enables a light under an authored-hidden entity", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const hidden = new THREE.Group();
    hidden.visible = false;
    const light = new THREE.PointLight();
    hidden.add(light);
    scene.add(hidden);
    const budget = new LightBudgetSystem(8);
    budget.register(light);

    budget.update(scene, camera);

    expect(light.visible).toBe(false);
    expect(budget.stats().active).toBe(0);
  });
});
