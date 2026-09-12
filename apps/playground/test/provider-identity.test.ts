import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { chunkStreamerSchema } from "@hitreg/core";
import { ChunkManager } from "../src/chunk-manager.js";

// A scene rebuild hands the manager a FRESH provider object for the same
// world — on every non-reconcilable edit and every asset live-sync. Comparing
// the objects unloaded the whole streamed world each time: a profiler snapshot
// of the MMO caught the chunk counter going 2,693 -> 1 while the player stood
// still, which from inside the game is the terrain vanishing under the town.
function fixture() {
  const manager = new ChunkManager(null as any, null as any, {} as any) as any;
  manager.scene = new THREE.Scene();
  manager.streamer = chunkStreamerSchema.parse({ source: "w", cellSize: 1, keepPadding: 0,
    hlodSupercellFactor: 4, rings: { simulation: 1, fullRender: 2, hlod: 4, farTerrain: 8 } });
  manager.disposeGroup = (group: THREE.Object3D) => group.removeFromParent();
  return manager;
}

function resident(manager: any): void {
  manager.loaded.set("0_0", { group: new THREE.Group(), expanded: { version: 1, entities: {} },
    entityCount: 0, objects: new Map(), rep: "simulation", simulated: true, batch: null, poolOwner: {} });
  manager.loadedSupercells.set("1_1", { group: new THREE.Group(), parts: [], cellKeys: new Set(["4_4"]), entityCount: 0, far: false });
}

const provider = (key?: unknown) => ({ key, has: () => true, get: () => null });

test("a rebuilt provider for the same world keeps the streamed world", () => {
  const manager = fixture();
  const identity = { world: "voxel-demo" }; // the field+options token voxelChunkProvider hands out
  manager.setProvider(provider(identity));
  resident(manager);
  manager.setProvider(provider(identity)); // a scene rebuild: new object, same cells
  assert.equal(manager.loaded.size, 1, "full-detail cells were dropped by a rebuild");
  assert.equal(manager.loadedSupercells.size, 1, "HLOD proxies were dropped by a rebuild");
});

test("a provider whose cells would differ re-streams the world", () => {
  const manager = fixture();
  manager.setProvider(provider({ world: "voxel-demo" }));
  resident(manager);
  manager.setProvider(provider({ world: "voxel-demo" })); // a DIFFERENT token: recipe edited
  assert.equal(manager.loaded.size, 0);
  assert.equal(manager.loadedSupercells.size, 0);
});

test("a provider with no identity keeps the old, cautious behaviour", () => {
  const manager = fixture();
  manager.setProvider(provider());
  resident(manager);
  manager.setProvider(provider());
  assert.equal(manager.loaded.size, 0);
});

test("clearing the provider always unloads", () => {
  const manager = fixture();
  const identity = {};
  manager.setProvider(provider(identity));
  resident(manager);
  manager.setProvider(null);
  assert.equal(manager.loaded.size, 0);
  assert.equal(manager.loadedSupercells.size, 0);
});
