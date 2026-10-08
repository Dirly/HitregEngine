import { test } from "node:test";
import assert from "node:assert/strict";
import { collectMapData, worldPositions, zoneAt } from "../src/map-layers.js";

const square = (cx: number, cz: number, r: number): [number, number][] => [[cx - r, cz - r], [cx + r, cz - r], [cx + r, cz + r], [cx - r, cz + r]];
const recipe = {
  name: "t",
  bounds: { limit: 1000 },
  regions: [
    { id: "zone-1", name: "The Shelf", polygon: square(0, 0, 500), hub: [0, 0] as [number, number] },
    { id: "town-1-zone", name: "Tidewell", within: "zone-1", polygon: square(100, 100, 50), hub: [100, 100] as [number, number] },
  ],
  features: {
    towns: [{ id: "town-1", center: [100, 100] as [number, number], tier: "town" }],
    roads: [{ id: "path-a", points: [[0, 0], [100, 100]] }],
    pois: [{ id: "camp-site-1", kind: "camp-site", position: [10, 0, 20] as [number, number, number] }],
  },
};
const scene = {
  entities: {
    "poi-mound": { name: "The Mound", tags: ["poi", "poi:mound"], components: { transform: { position: [200, 0, 0] } } },
    // child of a POI root rotated 90 degrees about +Y: local +Z becomes world +X
    door: { parent: "poi-mound", components: { transform: { position: [0, 0, 10] }, script: { name: "portal", params: { name: "the Barrow", scene: "barrow" } } } },
    kell: { name: "Kell", components: { transform: { position: [50, 0, 50] }, script: { name: "npc", params: { name: "Kell Ashby" } } } },
    "pop-1": { tags: ["spawn-area", "populate", "creature:wolf", "level:6"], components: { transform: { position: [300, 0, 300] }, spawnArea: { radius: 60, spawns: [{ template: "wolf", count: 2 }] } } },
  },
};
scene.entities["poi-mound"].components.transform = { position: [200, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } as never;

test("map data names towns by their town zone and reads the scene's places, portals, givers and spawns", () => {
  const data = collectMapData(recipe, scene, { world: "t", questGivers: ["kell"], reservations: [{ id: "mound", site: "x", x: 200, z: 0, radius: 70 }] });
  const by = (kind: string) => data.markers.filter((m) => m.kind === kind);
  assert.equal(by("town")[0]!.name, "Tidewell");
  assert.equal(by("place")[0]!.name, "The Mound");
  const portal = by("dungeon")[0]!;
  assert.equal(portal.name, "The Barrow");
  assert.ok(Math.abs(portal.x - 210) < 1e-6 && Math.abs(portal.z) < 1e-6, `portal at ${portal.x},${portal.z}`);
  assert.equal(by("quest")[0]!.name, "Kell Ashby");
  assert.deepEqual([by("spawn")[0]!.name, by("spawn")[0]!.level, by("spawn")[0]!.radius], ["wolf ×2", 6, 60]);
  assert.equal(by("reservation")[0]!.radius, 70);
  assert.equal(data.extent, 1200);
  assert.deepEqual(zoneAt(data, 100, 100), { zone: "The Shelf", town: "Tidewell" });
  assert.deepEqual(zoneAt(data, 900, 0), { zone: null, town: null });
});

test("world positions compose parent scale", () => {
  const at = worldPositions({ entities: { a: { components: { transform: { position: [1, 0, 0], scale: [2, 2, 2] } } }, b: { parent: "a", components: { transform: { position: [1, 1, 1] } } } } });
  assert.deepEqual(at("b"), [3, 2, 2]);
});
