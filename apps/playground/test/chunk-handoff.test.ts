import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { chunkStreamerSchema } from "@hitreg/core";
import { ChunkManager } from "../src/chunk-manager.js";

// Exercise the real residency/publish code with asynchronous IO paused.
function fixture() {
  const manager = new ChunkManager(null as any, null as any, {} as any) as any;
  manager.scene = new THREE.Scene();
  manager.streamer = chunkStreamerSchema.parse({ source: "w", cellSize: 1, keepPadding: 0,
    hlodSupercellFactor: 4, rings: { simulation: 1, fullRender: 2, hlod: 4, farTerrain: 8 } });
  manager.provider = { has: () => true };
  manager.drainPendingCells = () => {};
  manager.drainPendingSupercells = () => {};
  manager.pumpCellQueue = () => {};
  manager.pumpSupercellQueue = () => {};
  const queued: any[] = [];
  manager.queueSupercell = (...args: any[]) => queued.push(args);
  manager.disposeGroup = (group: THREE.Object3D) => group.removeFromParent();
  manager.unload = (key: string) => manager.loaded.delete(key);
  return { manager, queued };
}

function proxy(manager: any, key: string, cells: string[], far = false) {
  const part = { group: new THREE.Group(), cellKeys: new Set(cells), entityCount: cells.length, far };
  const group = new THREE.Group();
  group.add(part.group);
  manager.scene.add(group);
  const block = { group, cellKeys: new Set(cells), parts: [part], entityCount: cells.length, far };
  manager.loadedSupercells.set(key, block);
  return block;
}

test("demoted full-detail terrain survives until its proxy is published", () => {
  const { manager } = fixture();
  manager.loaded.set("3_0", { rep: "fullRender", simulated: false });
  manager.update(0, 0);
  assert.ok(manager.loaded.has("3_0"));
  proxy(manager, "0_0", ["3_0"]);
  manager.lastFocus = null;
  manager.update(0, 0);
  assert.equal(manager.loaded.has("3_0"), false);
});

test("promotion keeps merged neighbours visible and queues an atomic replacement", () => {
  const { manager, queued } = fixture();
  const old = proxy(manager, "0_0", ["2_0", "3_0"]);
  manager.loaded.set("2_0", { rep: "fullRender", simulated: false });
  manager.update(0, 0);
  assert.equal(old.parts.length, 1);
  assert.ok(old.group.parent);
  const replacement = queued.find(([key, , mode]) => key === "0_0" && mode === "replace");
  assert.ok(replacement);
  assert.ok(replacement[1].has("3_0"));
  assert.equal(replacement[1].has("2_0"), false);
});

test("a block with no desired proxy membership waits for unloaded near cells", () => {
  const { manager } = fixture();
  const target = new Map([["0_0", "simulation"]]);
  assert.equal(manager.canRetire(new Set(["0_0"]), target, "0_0"), false);
  manager.loaded.set("0_0", {});
  assert.equal(manager.canRetire(new Set(["0_0"]), target, "0_0"), true);
});

test("partial replacement cannot erase old coverage; complete publication swaps atomically", () => {
  const { manager } = fixture();
  const old = proxy(manager, "0_0", ["2_0", "3_0"]);
  manager.desiredCells = new Map([["2_0", "fullRender"], ["3_0", "hlod"]]);
  manager.supercellEpoch.set("0_0", 1);
  const part = { group: new THREE.Group(), cellKeys: new Set(["3_0"]), entityCount: 1, far: false };
  manager.publishSupercell("0_0", part, "replace", 1);
  assert.equal(old.parts[0].cellKeys.size, 2);
  manager.loaded.set("2_0", {});
  manager.publishSupercell("0_0", part, "replace", 1);
  assert.equal(old.parts[0], part);
  assert.ok(part.group.parent);
  assert.equal(manager.lastFocus, null);
});

test("landing readiness requires published local cells, not an empty work queue", () => {
  const { manager } = fixture();
  manager.update(0, 0);
  assert.equal(manager.isLandingReady(0, 0), false);
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) manager.loaded.set(`${x}_${z}`, {});
  assert.equal(manager.isLandingReady(0, 0), true);
  assert.equal(manager.isLandingReady(100, 100), false);
});

test("departing HLOD block does not starve its far-tier successor", () => {
  const { manager, queued } = fixture();
  const old = proxy(manager, "0_0", ["0_0"]);
  manager.update(8, 0);
  assert.ok(old.group.parent);
  assert.ok(queued.some(([key, cells]) => key.startsWith("f") && cells.has("0_0")));
});

test("replacement preserves another promoted cell that has not loaded yet", () => {
  const { manager, queued } = fixture();
  proxy(manager, "0_0", ["1_0", "2_0", "3_0"]);
  manager.loaded.set("2_0", { rep: "fullRender", simulated: false });
  manager.update(0, 0);
  const replacement = queued.find(([key, , mode]) => key === "0_0" && mode === "replace");
  assert.ok(replacement[1].has("1_0"));
  assert.ok(replacement[1].has("3_0"));
});

test("arrival waits for distant coverage even when the landing pad is ready", () => {
  const { manager } = fixture();
  manager.lastFocus = [0, 0];
  manager.desiredCells = new Map([["0_0", "simulation"], ["5_0", "far"]]);
  manager.loaded.set("0_0", {});
  assert.equal(manager.isLandingReady(0, 0), true);
  assert.equal(manager.isViewReady(), false);
  proxy(manager, "f0_0", ["5_0"], true);
  assert.equal(manager.isViewReady(), true);
});

test("an HLOD bake fetches its member cells together, and marks them bulk", async () => {
  // The bake used to `await` them one at a time: 64 sequential worker
  // round-trips for one far block, measured at 3.6s, with the near ring queued
  // behind every one of them. They are independent — and the urgency they ask
  // with is what keeps them behind the cells the player is walking onto.
  const { manager } = fixture();
  let live = 0;
  let peak = 0;
  const urgencies: string[] = [];
  const releases: Array<() => void> = [];
  manager.readCell = (_key: string, _cx: number, _cz: number, _raw: unknown, urgency: string) => {
    urgencies.push(urgency);
    live++;
    peak = Math.max(peak, live);
    // null: every member "fails", so the bake returns after the fetch phase
    // rather than entering a merge this fixture has no assets for
    return new Promise((resolve) => releases.push(() => { live--; resolve(null); }));
  };
  const members = new Set<string>();
  for (let i = 0; i < 24; i++) members.add(`${i}_0`);

  let done = false;
  const bake = manager.loadSupercell("0_0", members, "replace", true).then(() => { done = true; });
  for (let guard = 0; guard < 200 && !done; guard++) {
    while (releases.length > 0) releases.shift()!();
    await Promise.resolve();
  }
  await bake;

  assert.ok(peak > 1, `member fetches ran one at a time (peak ${peak})`);
  assert.ok(peak <= members.size, `unbounded fan-out (peak ${peak})`);
  assert.equal(urgencies.length, members.size, "every member cell asked for exactly once");
  assert.ok(
    urgencies.every((u) => u === "bulk"),
    `member cells must be requested at bulk urgency, saw ${[...new Set(urgencies)].join(", ")}`,
  );
});
