import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { budgetEdgeFade, LightBudgetSystem } from "../src/light-budget.js";

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

describe("LightBudgetSystem glow, pools and fog lamps", () => {
  it("halos every live light, pools only the ones past the budget, and feeds the nearest to the fog", async () => {
    const { fogLamps } = await import("../src/atmosphere.js");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const budget = new LightBudgetSystem(2);
    const lights = [2, 4, 6, 8, 10].map((x) => {
      const light = new THREE.PointLight(0xffaa66, 8, 10);
      light.position.x = x;
      scene.add(light);
      budget.register(light, 1);
      return light;
    });
    lights[4]!.userData["lightGlow"] = 0;
    budget.update(scene, camera);
    const stats = budget.stats();
    expect(stats.active).toBe(2);
    expect(stats.glows).toBe(4); // the glow-0 light has none
    expect(stats.pools).toBe(3); // 5 live - 2 budgeted
    expect(fogLamps.position[0]!.value.x).toBeCloseTo(2);
    expect(fogLamps.color[0]!.value.r).toBeGreaterThan(0);
    expect(fogLamps.color[4 - 1]!.value.r).toBeGreaterThan(0);

    // night lights by day: no halo, no pool, no fog glow
    for (const light of lights) light.userData["lightWhen"] = "night";
    budget.update(scene, camera);
    expect(budget.stats()).toMatchObject({ glows: 0, pools: 0 });
    expect(fogLamps.color[0]!.value.r).toBe(0);
    budget.dispose();
  });
});

describe("light.glowReach (far beacons)", () => {
  it("keeps a beacon's halo past 140 m and lets a plain light's fade", async () => {
    const { LightGlows } = await import("../src/light-glow.js");
    const g = new LightGlows();
    const light = new THREE.PointLight("#ff9a48", 90, 36);
    const at = new THREE.Vector3();
    g.begin(); g.add(light, at, 243, 4, 1); expect(g.stats()).toBe(0);
    g.begin(); g.add(light, at, 243, 4, 1, 450); expect(g.stats()).toBe(1);
    g.begin(); g.add(light, at, 460, 4, 1, 450); expect(g.stats()).toBe(0);
    g.dispose();
  });
});

describe("halo wash (Red Dial 2026-10-30)", () => {
  /** the queued halo's radius and red strength, read back from the instance buffer */
  const halo = (g: any) => ({ radius: g.data[3] as number, red: g.data[4] as number });
  it("caps glow, shrinks by day and holds a far beacon to a few pixels", async () => {
    const { LightGlows, MAX_HALO_GLOW, FAR_HALO_ANGLE } = await import("../src/light-glow.js");
    const g = new LightGlows();
    const light = new THREE.PointLight("#ffffff", 90, 36);
    const at = new THREE.Vector3();
    g.begin(); g.add(light, at, 20, 4, 1, undefined, 0); const night4 = halo(g);
    g.begin(); g.add(light, at, 20, MAX_HALO_GLOW, 1, undefined, 0); const nightCap = halo(g);
    expect(night4).toEqual(nightCap); // glow 4 draws as the cap
    g.begin(); g.add(light, at, 20, 4, 1, undefined, 1); const noon = halo(g);
    expect(noon.red).toBeLessThan(nightCap.red * 0.25);
    expect(noon.radius).toBeLessThan(nightCap.radius * 0.6);
    // a far beacon: never wider than its fixed angle once past the near size, never growing faster than distance
    g.begin(); g.add(light, at, 450, 4, 1, 800, 0); const far = halo(g);
    expect(far.radius).toBeCloseTo(450 * FAR_HALO_ANGLE, 5);
    expect(far.radius / 450).toBeLessThan(0.006);
    g.dispose();
  });
});

describe("budgetEdgeFade", () => {
  it("is full well inside the list, fades to nothing at the line, and never fades when every light fits", () => {
    expect(budgetEdgeFade(10, 100)).toBe(1);
    expect(budgetEdgeFade(75, 100)).toBeCloseTo(0.5);
    expect(budgetEdgeFade(100, 100)).toBe(0);
    expect(budgetEdgeFade(100, null)).toBe(1);
  });
});

describe("light presence (Bell Strand 2026-11-08: lights popped as rooms were culled and revealed)", () => {
  it("fades a light out over LIGHT_PRESENCE_FADE_S when its room hides, instead of dropping it in one frame", async () => {
    const { LIGHT_PRESENCE_FADE_S } = await import("../src/light-budget.js");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const room = new THREE.Group();
    const light = new THREE.PointLight(0xffffff, 4, 10);
    room.add(light);
    scene.add(room);
    const budget = new LightBudgetSystem(2);
    budget.register(light);
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const slotIntensity = () => litPointLights(scene).reduce((a, l) => a + l.intensity, 0);
    budget.update(scene, camera);
    // first sight: where it should be, no fade-in from nothing at load
    expect(slotIntensity()).toBeCloseTo(4);
    room.visible = false;
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) {
      now += 50;
      budget.update(scene, camera);
      seen.push(slotIntensity());
    }
    // gone within the fade, and every step on the way is small
    expect(seen[0]!).toBeGreaterThan(3);
    expect(seen[seen.length - 1]).toBe(0);
    for (let i = 1; i < seen.length; i++) expect(Math.abs(seen[i]! - seen[i - 1]!)).toBeLessThan(4 * (0.05 / LIGHT_PRESENCE_FADE_S) * 1.6);
    // and back
    room.visible = true;
    now += 50;
    budget.update(scene, camera);
    expect(slotIntensity()).toBeLessThan(1);
    clock.mockRestore();
    budget.dispose();
  });

  it("ranks a light that is fading in behind the lights already lit, so it does not shove them out of their slots", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const budget = new LightBudgetSystem(1);
    const lit = new THREE.PointLight(0xff0000, 4, 10);
    lit.position.x = 5;
    const room = new THREE.Group();
    room.visible = false;
    const near = new THREE.PointLight(0x00ff00, 4, 10);
    near.position.x = 1;
    room.add(near);
    scene.add(lit, room);
    budget.register(lit);
    budget.register(near);
    budget.update(scene, camera);
    room.visible = true; // the nearer room is revealed: its light starts at presence ~0
    budget.update(scene, camera);
    const slot = litPointLights(scene)[0]!;
    expect(slot.color.getHex()).toBe(0xff0000);
    budget.dispose();
  });
});

describe("interior light confine (light-confine.ts)", () => {
  it("measures a turned structure in its own frame and says how far a point is outside it", async () => {
    const { structureConfine, confineOutside } = await import("../src/light-confine.js");
    const house = new THREE.Group();
    house.position.set(100, 0, 50);
    house.rotation.y = Math.PI / 4;
    const shell = new THREE.Mesh(new THREE.BoxGeometry(6, 8, 18), new THREE.MeshBasicMaterial());
    shell.position.y = 4;
    house.add(shell);
    const c = structureConfine(house, 0)!;
    expect(c.half.x).toBeCloseTo(3);
    expect(c.half.y).toBeCloseTo(4);
    expect(c.half.z).toBeCloseTo(9);
    // a point 1 m beyond the long wall, along the house's own +x
    const out = new THREE.Vector3(4, 2, 0).applyEuler(house.rotation).add(house.position);
    expect(confineOutside(c, out)).toBeCloseTo(1);
    const inside = new THREE.Vector3(2, 2, 8).applyEuler(house.rotation).add(house.position);
    expect(confineOutside(c, inside)).toBeLessThan(0);
  });

  it("hands a confined light's box to the pool and holds its halo on the lamp from outside", async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(20, 1, 0);
    const house = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 6), new THREE.MeshBasicMaterial());
    house.position.y = 2;
    scene.add(house);
    const lamp = new THREE.PointLight(0xffffff, 4, 6);
    lamp.position.set(2.5, 1, 0);
    scene.add(lamp);
    const budget = new LightBudgetSystem(0); // everything goes to pools
    budget.register(lamp, 1, () => ({ structure: house }));
    budget.update(scene, camera);
    const pools = (budget as any).pools.data as Float32Array;
    expect(pools[12]).toBeCloseTo(3); // half x of the house box
    const halos = (budget as any).glows.data as Float32Array;
    expect(halos[7]).toBe(0); // camera outside the box: no nudge through the wall
    camera.position.set(0, 1, 0);
    budget.update(scene, camera);
    expect(((budget as any).glows.data as Float32Array)[7]).toBe(1);
    budget.dispose();
  });
});
