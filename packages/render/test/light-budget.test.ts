import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { LightBudgetSystem } from "../src/light-budget.js";

/** The lights the renderer would actually see: visible, in the scene. */
function litPointLights(scene: THREE.Scene): THREE.PointLight[] {
  const found: THREE.PointLight[] = [];
  scene.traverseVisible((o) => {
    if ((o as THREE.PointLight).isPointLight) found.push(o as THREE.PointLight);
  });
  return found;
}

/**
 * The renderer's light cache key, reproduced: three's `LightsNode.customCacheKey()`
 * hashes `light.id` per light, so this string changing between frames is exactly
 * what forces every lit material to recompile.
 */
function lightSetKey(scene: THREE.Scene): string {
  return litPointLights(scene)
    .map((l) => `${l.id}:${l.castShadow ? 1 : 0}`)
    .join(",");
}

describe("LightBudgetSystem", () => {
  it("lights the highest-ranked candidates, by distance weighted with importance", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const budget = new LightBudgetSystem(2);
    const near = new THREE.PointLight(0xff0000, 5, 30);
    const important = new THREE.PointLight(0x00ff00, 7, 40);
    const far = new THREE.PointLight(0x0000ff, 9, 50);
    near.position.x = 2;
    important.position.x = 20;
    far.position.x = 10;
    scene.add(near, important, far);
    budget.register(near, 1);
    budget.register(important, 100);
    budget.register(far, 1);

    budget.update(scene, camera);

    // the winners reach the renderer through the slots, carrying their values
    const lit = litPointLights(scene).filter((l) => l.intensity > 0);
    expect(lit).toHaveLength(2);
    expect(lit.map((l) => l.color.getHex()).sort()).toEqual([0x00ff00, 0xff0000].sort());
    expect(lit.map((l) => l.position.x).sort((a, b) => a - b)).toEqual([2, 20]);
    expect(lit.map((l) => l.distance).sort((a, b) => a - b)).toEqual([30, 40]);
    expect(budget.stats()).toMatchObject({ active: 2, budget: 2 });
  });

  it("keeps the light set IDENTICAL as the camera moves — the recompile fix", () => {
    // The regression this guards: hiding/showing authored lights changed the
    // renderer's light cache key on nearly every frame of camera movement,
    // recompiling every lit material inside render() (2296ms/frame on a real
    // dungeon, vs 18ms when the set was stable).
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const budget = new LightBudgetSystem(4);
    for (let i = 0; i < 40; i++) {
      const light = new THREE.PointLight(0xffffff, 3, 12);
      light.position.set(i * 7 - 140, 0, 0);
      scene.add(light);
      budget.register(light);
    }

    const keys = new Set<string>();
    const winners = new Set<string>();
    for (let step = 0; step < 40; step++) {
      camera.position.set(step * 7 - 140, 0, 0);
      camera.updateMatrixWorld(true);
      budget.update(scene, camera);
      keys.add(lightSetKey(scene));
      winners.add(
        litPointLights(scene)
          .filter((l) => l.intensity > 0)
          .map((l) => l.position.x)
          .sort((a, b) => a - b)
          .join(","),
      );
    }

    // one cache key across the whole sweep...
    expect(keys.size).toBe(1);
    // ...while the lighting genuinely followed the camera
    expect(winners.size).toBeGreaterThan(10);
  });

  it("never lights anything under an authored-hidden entity", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const hidden = new THREE.Group();
    hidden.visible = false;
    const light = new THREE.PointLight(0xffffff, 4, 10);
    hidden.add(light);
    scene.add(hidden);
    const budget = new LightBudgetSystem(8);
    budget.register(light);

    budget.update(scene, camera);

    expect(light.visible).toBe(false);
    expect(litPointLights(scene).filter((l) => l.intensity > 0)).toHaveLength(0);
    expect(budget.stats().active).toBe(0);
  });

  it("respects runtimeEnabled", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const light = new THREE.PointLight(0xffffff, 4, 10);
    scene.add(light);
    const budget = new LightBudgetSystem(8);
    budget.register(light);
    light.userData["runtimeEnabled"] = false;

    budget.update(scene, camera);

    expect(litPointLights(scene).filter((l) => l.intensity > 0)).toHaveLength(0);
    expect(budget.stats().active).toBe(0);
  });

  it("leaves shadow-casting point lights alone rather than proxying them", () => {
    // A shadow map belongs to its light; a proxy would have to re-render it,
    // and re-aiming one per frame invalidates the map it just drew.
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const caster = new THREE.PointLight(0xffffff, 6, 40);
    caster.castShadow = true;
    caster.position.x = 500; // far away: would lose any distance contest
    const near = new THREE.PointLight(0xffffff, 2, 10);
    scene.add(caster, near);
    const budget = new LightBudgetSystem(1);
    budget.register(caster);
    budget.register(near);

    budget.update(scene, camera);

    expect(caster.visible).toBe(true);
    expect(caster.castShadow).toBe(true);
    // and it did not consume the pool's single slot
    expect(budget.stats().active).toBe(1);
  });

  it("drops lights detached from the scene", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const light = new THREE.PointLight(0xffffff, 4, 10);
    scene.add(light);
    const budget = new LightBudgetSystem(8);
    budget.register(light);
    budget.update(scene, camera);
    expect(budget.stats().registered).toBe(1);

    light.removeFromParent();
    budget.update(scene, camera);

    expect(budget.stats().registered).toBe(0);
  });

  it("adds exactly `budget` slot lights, once, however many updates run", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const budget = new LightBudgetSystem(3);
    for (let i = 0; i < 10; i++) {
      const light = new THREE.PointLight(0xffffff, 1, 5);
      scene.add(light);
      budget.register(light);
    }
    for (let i = 0; i < 5; i++) budget.update(scene, camera);

    expect(litPointLights(scene)).toHaveLength(3);
    budget.dispose();
    expect(litPointLights(scene)).toHaveLength(0);
  });
});
