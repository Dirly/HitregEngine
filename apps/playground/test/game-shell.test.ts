import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOps, ComponentRegistry, registerChunkComponents, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";
import { loadShell, planShell, poolEntities, shellGaps } from "../tools/_game-shell.mjs";
import { worldSpawn, yawQuat } from "../tools/_world-spawn.mts";

// a throwaway projects root: a "game" that owns assets/game-shell.json (+ a soundscape table it points at) and a
// "world" that depends on it, so the closure lookup is the real one
const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-shell-"));
process.env.HITREG_PROJECTS_ROOT = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (rel: string, v: unknown) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify(v));
};
write("game/project.json", { name: "game" });
write("game/authoring/spots.json", { "*": { day: "spot/crow" } });
write("game/assets/game-shell.json", {
  player: { id: "player", tags: ["player"], prefab: "characters/player", replaces: ["player-controller"] },
  camera: { id: "camera", camera: { fov: 68, far: 4000, active: true, rig: { mode: "follow", targetTag: "player", distance: 7.5, collision: true } } },
  systems: {
    hud: { name: "HUD", components: { script: { name: "mmo-hud", params: {} } } },
    fx: { name: "FX", components: { transform: { position: [0, 0, 0] }, script: { name: "fx-pool", params: {} } } },
    soundscape: { name: "Soundscape", components: { transform: {}, script: { name: "soundscape", params: {} } }, paramsFrom: { spots: "authoring/spots.json" } },
  },
  pools: { parent: "fx", fps: 22, flipbooks: [{ name: "rune", count: 2, frames: 8 }], particles: [{ kind: "sparks", count: 1, data: { rate: 0, max: 10 } }] },
});
write("world/project.json", { name: "world", dependsOn: ["game"] });

const registry = new ComponentRegistry();
registerCoreComponents(registry);
registerChunkComponents(registry);

/** worldgen init's dev scene: a capsule player, a bare camera, a spawn, the environment. */
const devScene = (): SceneDoc => ({
  entities: {
    world: { name: "World", parent: null, tags: ["world"], components: { script: { name: "weather", params: {} } } },
    player: { name: "Player", parent: null, tags: ["player"], components: { transform: { position: [5, 60, 7] }, script: { name: "player-controller", params: {} } } },
    camera: { name: "Camera", parent: null, tags: [], components: { transform: { position: [0, 0, 0] }, camera: { active: true, fov: 65, far: 4000, rig: { mode: "follow", targetTag: "player", distance: 7, height: 3 } } } },
    spawn: { name: "Spawn", parent: null, tags: ["spawn"], components: { transform: { position: [5, 58, 7] } } },
  },
} as unknown as SceneDoc);

test("the shell comes through the closure, and paramsFrom is read from the owning project", () => {
  const loaded = loadShell("world");
  assert.ok(loaded, "found through dependsOn");
  const plan = planShell(loaded!, devScene());
  const sound = plan.ops.find((o) => o.op === "add-entity" && o["id"] === "soundscape") as { entity: { components: { script: { params: { spots: unknown } } } } } | undefined;
  assert.deepEqual(sound?.entity.components.script.params.spots, { "*": { day: "spot/crow" } });
  assert.equal(loadShell("nowhere"), null);
});

test("a dev capsule becomes the player prefab in place; camera, systems and pools added; one valid batch", () => {
  const loaded = loadShell("world")!;
  const doc = devScene();
  const plan = planShell(loaded, doc);
  const { doc: after } = applyOps(doc, plan.ops as Op[], registry);
  const p = after.entities["player"]!;
  assert.deepEqual((p.components["prefab"] as { prefabId: string }).prefabId, "characters/player");
  assert.deepEqual((p.components["transform"] as { position: number[] }).position, [5, 60, 7], "same position");
  assert.equal(p.components["script"], undefined, "the capsule controller is gone");
  assert.equal((after.entities["camera"]!.components["camera"] as { rig: { distance: number } }).rig.distance, 7.5);
  for (const id of ["hud", "fx", "soundscape", "fx-rune-0", "fx-rune-1", "pfx-sparks-0"]) assert.ok(after.entities[id], id);
  assert.equal(after.entities["fx-rune-0"]!.parent, "fx");
  // the environment is not the shell's
  assert.equal(Object.values(after.entities).filter((e) => (e.components["script"] as { name?: string } | undefined)?.name === "weather").length, 1);
  // and installing again changes nothing
  assert.deepEqual(shellGaps(loaded, after), []);
  assert.equal(planShell(loaded, after).ops.length, 0);
});

test("never doubles: a script already running under another id is skipped, the pools go under that dispatcher", () => {
  const loaded = loadShell("world")!;
  const doc = devScene();
  doc.entities["my-fx"] = { name: "Own FX", parent: null, tags: [], components: { script: { name: "fx-pool", params: {} } } } as never;
  doc.entities["my-sound"] = { name: "Own sound", parent: null, tags: [], components: { script: { name: "soundscape", params: {} } } } as never;
  const plan = planShell(loaded, doc);
  const ids = plan.ops.filter((o) => o.op === "add-entity").map((o) => o["id"]);
  assert.ok(!ids.includes("fx") && !ids.includes("soundscape"));
  const pool = plan.ops.find((o) => o["id"] === "fx-rune-0") as unknown as { entity: { parent: string } };
  assert.equal(pool.entity.parent, "my-fx");
});

test("a custom player is kept and reported; prefab markers outside the player are reported", () => {
  const loaded = loadShell("world")!;
  const doc = devScene();
  (doc.entities["player"]!.components as Record<string, unknown>)["script"] = { name: "my-controller", params: {} };
  doc.entities["rain"] = { name: "rain", parent: null, tags: ["weather-rain"], components: {} } as never;
  const prefabDoc = { entities: { player: { tags: ["player"] }, "weather-rain": { tags: ["weather-rain"] } } };
  const plan = planShell(loaded, doc, { prefabDoc });
  assert.ok(!plan.ops.some((o) => o["id"] === "player"));
  assert.ok(plan.findings.some((f) => f.includes("custom body running my-controller")));
  assert.ok(plan.findings.some((f) => f.startsWith("rain carries weather-rain")));
  assert.ok(planShell(loaded, doc, { replacePlayer: true }).ops.some((o) => o.op === "remove-entity" && o["id"] === "player"));
});

test("pool ids and lifetimes", () => {
  const e = poolEntities({ fps: 22, flipbooks: [{ name: "impact_spark", count: 1, frames: 5 }], meshes: [{ id: "drop-rock", count: 2, mesh: {} }] }, "fx");
  assert.deepEqual(Object.keys(e), ["drop-rock-0", "drop-rock-1", "fx-impact_spark-0"]);
  const params = (e["fx-impact_spark-0"]!.components["script"] as { params: { lifetime: number } }).params;
  assert.ok(Math.abs(params.lifetime - (5 / 22 + 0.15)) < 1e-9);
});

test("the world spawn: the starter town's gate street, past the gate court, facing up it", () => {
  const dir = path.join(root, "world");
  write("world/authoring/towns/t-design.json", {
    gate: { at: [100, 0], facing: [1, 0] },
    streets: [{ id: "gate-street", kind: "main", points: [[100, 0], [40, 0]] }, { id: "out", kind: "lane", points: [[100, 0], [160, 0]] }],
    squares: [{ id: "court", kind: "gate", polygon: [[100, -3], [94, -3], [94, 3], [100, 3]] }],
  });
  const recipe: Parameters<typeof worldSpawn>[0] = { features: { towns: [{ id: "first", center: [0, 500] }, { id: "t", center: [60, 0], tags: ["starter"], program: { source: "authoring/towns/t-design.json" } }] } };
  const ws = worldSpawn(recipe, dir)!;
  assert.equal(ws.town, "t");
  assert.deepEqual(ws.at, [90, 0], "6 m court + 4 m in from the gate");
  assert.deepEqual(ws.facing, [-1, 0]);
  // no design: the town centre, facing in from its gate
  const plain = worldSpawn({ features: { towns: [{ id: "p", center: [5, 5], gates: [{ at: [5, 50], facing: [0, 1] }] }] } }, dir)!;
  assert.deepEqual([plain.at, plain.facing], [[5, 5], [-0, -1]]);
  assert.equal(worldSpawn({ features: { towns: [] } }, dir), null);
});

test("with a world spawn: the replaced player, a kept player, the spawn marker and the camera all go there", () => {
  const loaded = loadShell("world")!;
  const spawn = { position: [90, 21.1, 0] as [number, number, number], rotation: yawQuat([-1, 0]), from: "t" };
  const doc = devScene();
  const { doc: after } = applyOps(doc, planShell(loaded, doc, { spawn }).ops as Op[], registry);
  assert.deepEqual((after.entities["player"]!.components["transform"] as { position: number[] }).position, [90, 21.1, 0]);
  assert.deepEqual((after.entities["spawn"]!.components["transform"] as { position: number[] }).position, [90, 20, 0]);
  const cam = (after.entities["camera"]!.components["transform"] as { position: number[] }).position;
  assert.ok(Math.abs(cam[0]! - 97) < 0.01 && Math.abs(cam[2]!) < 0.01, `camera 7 m behind: ${cam}`);
  assert.deepEqual(shellGaps(loaded, after, { spawn }), []);
  // a kept (already prefab) player that stands elsewhere is moved; within 4 m it is left alone
  const far = { ...spawn, position: [300, 21.1, 0] as [number, number, number] };
  assert.ok(planShell(loaded, after, { spawn: far }).added.some((a) => a.includes("moved to the world spawn")));
  assert.equal(planShell(loaded, after, { spawn: { ...spawn, position: [92, 21.1, 1] } }).ops.length, 0);
});
