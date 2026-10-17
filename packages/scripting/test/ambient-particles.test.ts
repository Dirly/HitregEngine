import { describe, expect, it } from "vitest";
import { layerStrength, normalizeLayer, timeWeight, zoneLayer, type AmbientSample } from "../src/ambient-particles.js";

const sample = (over: Partial<AmbientSample>): AmbientSample => ({
  biomes: {},
  region: null,
  daylight: 1,
  water: 0,
  storm: 0,
  ...over,
});

const fireflies = normalizeLayer({ id: "fireflies", biomes: "forest,fen", when: "night", town: "never", waterBoost: 1.5 });
const ash = normalizeLayer({ id: "ash", biomes: "blight", zones: "zone-2", match: "any" });
const moths = normalizeLayer({ id: "moths", when: "night", zones: "town", town: "only" });
const spray = normalizeLayer({ id: "spray", biomes: "beach", needWater: true });

describe("ambient-particles layer rules", () => {
  it("eases day and night across dusk", () => {
    expect(timeWeight("night", 1)).toBe(0);
    expect(timeWeight("night", 0)).toBe(1);
    expect(timeWeight("day", 0.45)).toBeGreaterThan(0.3);
    expect(timeWeight("day", 0.45)).toBeLessThan(0.7);
    expect(timeWeight("always", 0)).toBe(1);
  });

  it("fireflies: forest at night, more near water, none by day or in town", () => {
    const night = sample({ biomes: { forest: 1 }, daylight: 0 });
    expect(layerStrength(fireflies, night)).toBe(1);
    expect(layerStrength(fireflies, { ...night, water: 1 })).toBeCloseTo(2.5);
    expect(layerStrength(fireflies, { ...night, daylight: 1 })).toBe(0);
    expect(layerStrength(fireflies, { ...night, region: { id: "t", name: "T", tags: ["town"] } })).toBe(0);
    // a 10% sliver of forest earns nothing
    expect(layerStrength(fireflies, sample({ biomes: { forest: 0.1, desert: 0.9 }, daylight: 0 }))).toBe(0);
  });

  it("match any: ash in its zone whatever the biome, or in blight anywhere", () => {
    expect(layerStrength(ash, sample({ biomes: { grassland: 1 }, region: { id: "zone-2", name: "Anvil Isle", tags: [] } }))).toBe(1);
    expect(layerStrength(ash, sample({ biomes: { blight: 1 } }))).toBe(1);
    expect(layerStrength(ash, sample({ biomes: { grassland: 1 }, region: { id: "zone-1", name: "x", tags: [] } }))).toBe(0);
  });

  it("zones match ids, names and tags; town only", () => {
    const town = { id: "town-1-zone", name: "Gullhaven", tags: ["town", "safe"] };
    expect(layerStrength(moths, sample({ region: town, daylight: 0 }))).toBe(1);
    expect(layerStrength(moths, sample({ daylight: 0 }))).toBe(0);
    const byName = normalizeLayer({ id: "x", zones: "anvil isle" });
    expect(layerStrength(byName, sample({ region: { id: "zone-2", name: "Anvil Isle", tags: [] } }))).toBe(1);
  });

  it("needWater gates, storm scales", () => {
    expect(layerStrength(spray, sample({ biomes: { beach: 1 } }))).toBe(0);
    expect(layerStrength(spray, sample({ biomes: { beach: 1 }, water: 0.5 }))).toBe(1);
    const leaves = normalizeLayer({ id: "leaves", biomes: "forest", storm: 2 });
    expect(layerStrength(leaves, sample({ biomes: { forest: 1 }, storm: 1 }))).toBe(3);
    const calm = normalizeLayer({ id: "f", storm: -1 });
    expect(layerStrength(calm, sample({ storm: 1 }))).toBe(0);
  });
});

describe("ambient-particles: zone layers from the recipe", () => {
  const spores = { id: "spores", biomes: "", when: "always" as const, town: "never" as const, needWater: false, waterBoost: 0.5, rate: 4, storm: -0.7, wind: 0.4, rise: 0.12, glow: 0.5 };

  it("a zone layer lives wherever its zone is, whatever the biome", () => {
    const layer = zoneLayer(spores);
    const inZone = sample({ biomes: { grassland: 1 }, region: { id: "zone-4", name: "Downs", tags: [], ambient: [spores] } });
    expect(layerStrength(layer, inZone)).toBeGreaterThan(0.9);
  });

  it("its biomes narrow it inside the zone, and town: never keeps it out of town", () => {
    const narrowed = zoneLayer({ ...spores, biomes: "swamp" });
    expect(layerStrength(narrowed, sample({ biomes: { grassland: 1 } }))).toBe(0);
    expect(layerStrength(narrowed, sample({ biomes: { swamp: 1 } }))).toBeGreaterThan(0.9);
    expect(layerStrength(zoneLayer(spores), sample({ region: { id: "t", name: "Town", tags: ["town"] } }))).toBe(0);
  });

  it("the script drives a zone layer's emitter while in the zone, and fades it outside", async () => {
    const THREE = await import("three");
    const { applyOps, ComponentRegistry, createScene, registerCoreComponents } = await import("@hitreg/core");
    const { registerBuiltinScripts, ScriptRegistry, ScriptRuntime } = await import("../src/index.js");
    const reg = new ComponentRegistry();
    registerCoreComponents(reg);
    const doc = applyOps(
      createScene("t"),
      [
        { op: "add-entity", id: "amb", entity: { name: "amb", parent: null, tags: [], components: { script: { name: "ambient-particles", params: { layers: [] } } } } },
        { op: "add-entity", id: "player", entity: { name: "player", parent: null, tags: ["player"], components: { transform: {} } } },
        { op: "add-entity", id: "emit", entity: { name: "emit", parent: null, tags: ["ambient-spores"], components: { transform: {} } } },
      ],
      reg,
    ).doc;
    const objects = new Map<string, InstanceType<typeof THREE.Object3D>>();
    for (const id of Object.keys(doc.entities)) objects.set(id, new THREE.Object3D());
    let inZone = true;
    const rates: number[] = [];
    const registry = new ScriptRegistry();
    registerBuiltinScripts(registry);
    const runtime = new ScriptRuntime({
      doc,
      objects,
      registry,
      sim: { getLinvel: () => [0, 0, 0], setLinvel: () => {}, applyImpulse: () => {} },
      input: { isDown: () => false },
      biomeAt: () => ({ id: "grassland", zone: "t", weights: { grassland: 1 }, ground: 0, temperature: 0.5, moisture: 0.5, slope: 0 }),
      regionAt: () => (inZone ? { id: "zone-4", name: "Downs", tags: [], ambient: [spores] } : { id: "zone-1", name: "Reach", tags: [] }),
      setParticles: (entity, o) => {
        if (entity === "emit") rates.push(o.rate ?? 0);
      },
    });
    runtime.start();
    const step = (s: number) => {
      for (let t = 0; t < s * 30; t++) {
        runtime.fixedUpdate(1 / 30);
        runtime.lateUpdate(1 / 30);
      }
    };
    step(20);
    expect(rates.at(-1)).toBeGreaterThan(3);
    inZone = false;
    step(30);
    expect(rates.at(-1)).toBe(0);
    runtime.dispose();
  });
});
