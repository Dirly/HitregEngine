import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type SceneDoc } from "@hitreg/core";
import { registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type LiveSkyOptions, type RegionAt } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

function world(region: () => RegionAt | null, ground: (x: number, z: number) => number, pool?: { surfaceY: number }) {
  const doc: SceneDoc = applyOps(
    createScene("t"),
    [
      { op: "add-entity", id: "mood", entity: { name: "mood", parent: null, tags: [], components: { script: { name: "zone-mood", params: { blendSeconds: 1 } } } } },
      { op: "add-entity", id: "player", entity: { name: "player", parent: null, tags: ["player"], components: { transform: {} } } },
    ],
    coreRegistry,
  ).doc;
  const objects = new Map<string, THREE.Object3D>();
  for (const id of Object.keys(doc.entities)) objects.set(id, new THREE.Object3D());
  const skies: LiveSkyOptions[] = [];
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  const runtime = new ScriptRuntime({
    doc,
    objects,
    registry,
    sim: { getLinvel: () => [0, 0, 0], setLinvel: () => {}, applyImpulse: () => {} },
    input: { isDown: () => false },
    biomeAt: (x, z) => ({ id: "swamp", zone: "t", weights: { swamp: 1 }, ground: ground(x, z), temperature: 0.5, moisture: 0.5, slope: 0 }),
    waterAt: (x, y, z) => (pool && pool.surfaceY > ground(x, z) ? { surfaceY: pool.surfaceY, depth: pool.surfaceY - y, floorY: ground(x, z), swim: true, current: [0, 0] } : null),
    regionAt: () => region(),
    setSky: (o) => skies.push(o),
    setPostFx: () => {},
  });
  runtime.start();
  const step = (s: number) => {
    for (let t = 0; t < s * 30; t++) runtime.fixedUpdate(1 / 30);
  };
  return { step, skies, player: objects.get("player")!, runtime };
}

const bog: RegionAt = {
  id: "bog",
  name: "Bog",
  tags: [],
  mood: { amount: 0.5, lightScale: 1, fogDensity: 1, mist: 1.2, saturation: 1, contrast: 1, temperature: 0, mistTop: 3, mistThickness: 4 },
};

describe("zone-mood: ground-relative mist", () => {
  it("puts the mist top a zone's mistTop above the local low ground, whatever the altitude", () => {
    // a high bog: ground at 80 m, a pool 20 m off whose surface is at 78.5
    const w = world(() => bog, (x) => (Math.abs(x - 20) < 4 ? 77 : 80), { surfaceY: 78.5 });
    w.step(6);
    const mood = w.skies.at(-1)!.mood!;
    expect(mood.mistLocal).toBeGreaterThan(0.95);
    expect(mood.mistTop).toBeCloseTo(78.5 + 3, 0);
    expect(mood.mistThickness).toBeCloseTo(4, 1);
    w.runtime.dispose();
  });

  it("a zone without mistTop keeps the scene's absolute mist", () => {
    const plain: RegionAt = { ...bog, mood: { ...bog.mood!, mistTop: undefined, mistThickness: undefined } };
    const w = world(() => plain, () => 80);
    w.step(6);
    expect(w.skies.at(-1)!.mood!.mistLocal ?? 0).toBe(0);
    w.runtime.dispose();
  });

  it("eases back to the absolute mist after leaving the zone", () => {
    let inside = true;
    const w = world(() => (inside ? bog : { id: "plain", name: "Plain", tags: [] }), () => 40);
    w.step(6);
    expect(w.skies.at(-1)!.mood!.mistLocal).toBeGreaterThan(0.9);
    inside = false;
    w.step(6);
    expect(w.skies.at(-1)!.mood!.mistLocal ?? 0).toBeLessThan(0.05);
    w.runtime.dispose();
  });
});
