import test from "node:test";
import assert from "node:assert/strict";
import { checkFrame, farCamera, FAR_MAX_M, FAR_MIN_M, FAR_WATER_MAX } from "../tools/_far-camera.mts";

// a round island r 600 (ground 30 m at the centre falling to -20 m at r 700), sea level 0
const ground = (x: number, z: number): number => 30 - (Math.hypot(x, z) / 600) * 30 - Math.max(0, Math.hypot(x, z) - 600) * 0.2;

test("a coastal candidate's far camera stands on land, 300-400 m out, and sees the pad (redstrand siting sheet)", () => {
  // the candidate near the east shore; its open (lowest) side is the sea to the east
  const at: [number, number] = [450, 0];
  const cam = farCamera({ at, y: ground(450, 0), view: 90, ground, seaLevel: 0 });
  assert.ok(cam, "a camera");
  const [x, , z] = cam.camera;
  assert.ok(ground(x, z) > 2, `camera on land (ground ${ground(x, z).toFixed(1)})`);
  const d = Math.hypot(x - at[0], z - at[1]);
  assert.ok(d >= FAR_MIN_M - 1 && d <= FAR_MAX_M + 1, `distance ${d}`);
  assert.ok(cam.check.visible && cam.check.water <= FAR_WATER_MAX, JSON.stringify(cam.check));
  // the old placement (420 m out on the open side = over the sea, looking back) is what the check refuses when it
  // looks out to sea: a camera on the shore aimed away from the island over open water
  const seaward = checkFrame([560, 12, 0], [1100, -40, 0], ground, 0);
  assert.ok(!seaward.ok && seaward.water > FAR_WATER_MAX, JSON.stringify(seaward));
});

test("a pad hidden behind a ridge fails the frame check", () => {
  const ridge = (x: number, z: number): number => (Math.abs(x - 150) < 20 ? 80 : 10) + 0 * z;
  const c = checkFrame([0, 20, 0], [300, 14, 0], ridge, 0);
  assert.equal(c.visible, false);
  assert.equal(c.ok, false);
});

test("an islet candidate with no land 300-400 m out gets no camera rather than a frame of the sea", () => {
  const islet = (x: number, z: number): number => 10 - Math.hypot(x - 2000, z) * 0.2;
  assert.equal(farCamera({ at: [2000, 0], y: 10, view: 0, ground: islet, seaLevel: 0 }), null);
});

test("a generated world scene carries the environment: day-night clock, weather, zone-mood (light-shots /time /weather /mood)", async () => {
  const { withEnvironment } = await import("../tools/worldgen-scene-env.mts");
  const entities: Record<string, { name: string; parent: string | null; tags: string[]; components: Record<string, unknown> }> = {
    world: { name: "World", parent: null, tags: ["world"], components: { voxelWorld: { world: "w", mesher: "auto" } } },
    sky: { name: "Sky", parent: null, tags: [], components: { sky: { preset: "day" } } },
  };
  const added = withEnvironment(entities, "projects/proving/assets/scenes/proving.scene.json");
  assert.deepEqual(added.sort(), ["day-night", "weather", "zone-mood"]);
  assert.equal((entities.sky!.components.script as { name: string }).name, "day-night");
  assert.equal((entities.world!.components.script as { name: string }).name, "weather");
  assert.equal((entities["zone-mood"]!.components.script as { name: string }).name, "zone-mood");
  // idempotent
  assert.deepEqual(withEnvironment(entities), []);
});

test("town candidates stand on the main landmass, never on an islet (redstrand siting: towns on offshore islets)", async () => {
  const { mainLandOf } = await import("../tools/worldgen-site-needs.mts");
  // main island r 1000 at the origin, an islet r 120 at x 1600
  const g = { sea: 0, height: (x: number, z: number) => (Math.hypot(x, z) < 1000 || Math.hypot(x - 1600, z) < 120 ? 20 : -10) };
  const on = mainLandOf(g, 2000);
  assert.equal(on(0, 0), true);
  assert.equal(on(900, 0), true);
  assert.equal(on(1600, 0), false);
  assert.equal(on(0, 1500), false);
});

test("a frame across a lake counts the lake as water", () => {
  const flat = () => 20;
  const lake = (x: number) => x > 50 && x < 1000;
  const c = checkFrame([0, 30, 0], [600, 20, 0], flat, 0, { wet: (x) => lake(x) });
  assert.ok(c.water > FAR_WATER_MAX, JSON.stringify(c));
  assert.ok(checkFrame([0, 30, 0], [600, 20, 0], flat, 0).ok);
});

test("a camera at the foot of a cliff is refused", async () => {
  const { cameraClear } = await import("../tools/_far-camera.mts");
  const wall = (x: number) => (x > 15 ? 100 : 5);
  assert.equal(cameraClear([0, 25, 0], wall), false);
  assert.equal(cameraClear([0, 25, 0], () => 5), true);
});
