import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createScene, defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { bootServerBody } from "../tools/_server-boot.mts";

test("walk gate leaves distant NPC ground unloaded, then wakes local residents and packs", { timeout: 60_000 }, async () => {
  const playground = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-walk-boot-"));
  const write = (kind: string, file: string, data: unknown): void => {
    const dir = path.join(playground, "assets", kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
  };
  const recipe = worldRecipeSchema.parse({
    ...defaultWorldRecipe(), cellSize: 48, resolution: 16,
    bounds: { continents: [{ center: [0, 0], radius: 30, falloff: 20 }], limit: 10, limitFalloff: 30 },
    scatter: [],
  });
  write("worlds", "walk-boot-test.json", recipe);
  const scene = createScene("walk-boot-test");
  scene.entities["ground"] = { name: "ground", parent: null, tags: [], components: { voxelWorld: { world: "walk-boot-test" } } };
  scene.entities["player"] = {
    name: "player", parent: null, tags: ["player"],
    components: { transform: { position: [0, 2, 0] }, rigidbody: { kind: "dynamic", lockRotations: true }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] } },
  };
  scene.entities["resident"] = {
    name: "resident", parent: null, tags: ["npc", "boot-test-resident"],
    components: { transform: { position: [0, 2, 0] }, rigidbody: { kind: "dynamic", lockRotations: true }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] } },
  };
  scene.entities["pack"] = {
    name: "pack", parent: null, tags: [],
    components: { transform: {}, spawnArea: { spawns: [{ template: "resident", count: 1, spread: 0 }] } },
  };
  write("scenes", "walk-boot-test.scene.json", scene);
  let body: Awaited<ReturnType<typeof bootServerBody>> | undefined;
  try {
    body = await bootServerBody({ playground, scene: "walk-boot-test", peer: "boot-test", log: () => {} });
    assert.ok(body.server.paused.has("resident"), "authored residents must sleep before first-tick terrain priming");
    assert.equal(body.terrain.has(0, 0), false, "an off-world walker must not cook terrain under distant residents");
    const y = body.terrain.groundHeight(0, 0);
    body.holdAt([0, y + 1.5, 0]);
    body.tick(30);
    assert.equal(body.server.paused.has("resident"), false, "nearby residents must wake as on the game server");
    const locals = [...body.world.entities.values()].filter(e => e.tags.includes("boot-test-resident"));
    assert.equal(locals.length, 2, "the walk must include the real local spawn-area population");
  } finally {
    body?.server.close();
    body?.terrain.dispose();
    body?.world.dispose();
    assert.equal(path.dirname(path.resolve(playground)), path.resolve(os.tmpdir()));
    fs.rmSync(playground, { recursive: true, force: true });
  }
});
