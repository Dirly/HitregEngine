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
  // focus 0 (corner 0): 1_0 is d=1.08 (fullRender), 2_0 d=2.05 (hlod) — see computeChunkStates
  const old = proxy(manager, "0_0", ["1_0", "2_0"]);
  manager.loaded.set("1_0", { rep: "fullRender", simulated: false });
  manager.update(0, 0);
  assert.equal(old.parts.length, 1);
  assert.ok(old.group.parent);
  const replacement = queued.find(([key, , mode]) => key === "0_0" && mode === "replace");
  assert.ok(replacement);
  assert.ok(replacement[1].has("2_0"));
  assert.equal(replacement[1].has("1_0"), false);
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
  // focus 0 (corner 0): -2_0 and 1_0 are d=1.08 (fullRender), 2_0 d=2.05 (hlod)
  proxy(manager, "0_0", ["-2_0", "1_0", "2_0"]);
  manager.loaded.set("1_0", { rep: "fullRender", simulated: false });
  manager.update(0, 0);
  const replacement = queued.find(([key, , mode]) => key === "0_0" && mode === "replace");
  assert.ok(replacement[1].has("-2_0"));
  assert.ok(replacement[1].has("2_0"));
});

test("complete view readiness waits for distant coverage even when the landing pad is ready", () => {
  const { manager } = fixture();
  manager.lastFocus = [0, 0];
  manager.desiredCells = new Map([["0_0", "simulation"], ["5_0", "far"]]);
  manager.loaded.set("0_0", {});
  assert.equal(manager.isLandingReady(0, 0), true);
  assert.equal(manager.isViewReady(), false);
  proxy(manager, "f0_0", ["5_0"], true);
  assert.equal(manager.isViewReady(), true);
});

test("playable arrival waits for the simulation ring, while distant scenery continues loading", () => {
  const { manager } = fixture();
  manager.lastFocus = [0, 0];
  manager.desiredCells = new Map([["0_0", "simulation"], ["2_0", "simulation"],
    ["3_0", "fullRender"], ["5_0", "far"]]);
  manager.loaded.set("0_0", {});
  assert.equal(manager.isLandingReady(0, 0), true);
  assert.equal(manager.isArrivalReady(0, 0), false);
  manager.loaded.set("2_0", {});
  assert.equal(manager.isArrivalReady(0, 0), true);
  assert.equal(manager.isViewReady(), false);
  manager.loaded.delete("0_0");
  assert.equal(manager.isArrivalReady(0, 0), false, "the landing cell must remain published");
});

test("playable arrival requires a streaming focus and respects intentionally suppressed cells", () => {
  const { manager } = fixture();
  manager.desiredCells = new Map([["0_0", "simulation"], ["2_0", "simulation"]]);
  manager.loaded.set("0_0", {});
  manager.suppressed.add("2_0");
  assert.equal(manager.isArrivalReady(0, 0), false);
  manager.lastFocus = [0, 0];
  assert.equal(manager.isArrivalReady(0, 0), true);
  manager.loaded.set("10_10", {});
  assert.equal(manager.isArrivalReady(10, 10), false, "a teleport needs residency at its new focus");
  manager.streamer = null;
  assert.equal(manager.isArrivalReady(100, 100), true);
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

test("static models that land after a cell's merge are re-merged once they stop arriving", async () => {
  const { STATIC_BATCH_FLAG } = await import("@hitreg/render");
  const { manager } = fixture();
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  for (let i = 0; i < 3; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.position.x = i * 2;
    mesh.userData["entityId"] = `piece-${i}`;
    mesh.userData[STATIC_BATCH_FLAG] = true;
    root.add(mesh);
  }
  const group = new THREE.Group();
  group.add(root);
  manager.scene.add(group);
  const chunk = { group, root, expanded: { entities: {} }, objects: new Map(), rep: "fullRender", simulated: false,
    batch: null, poolOwner: {}, cullRoots: [], cullUnits: [], lateModels: 3 };
  manager.loaded.set("0_0", chunk);
  manager.rebatchAt.set("0_0", 1000);
  assert.equal(manager.pumpRebatches(999), 0, "waits out the coalescing delay");
  assert.equal(manager.pumpRebatches(1000), 1);
  assert.equal(chunk.batch.stats.merged, 3);
  assert.equal(chunk.batch.stats.batches, 1);
  assert.equal(chunk.lateModels, 0);
  assert.equal(manager.rebatchAt.size, 0);
  // an unloaded cell's pending re-merge is dropped, not run
  manager.rebatchAt.set("9_9", 0);
  assert.equal(manager.pumpRebatches(1e9), 0);
});

test("ground coverage: a resident cell or proxy covers its ground, and the version moves only on publish/drop", () => {
  const { manager } = fixture();
  manager.streamer = { ...manager.streamer, cellSize: 48 };
  manager.supercellEpoch.set("0_0", 1);
  const v0 = manager.groundVersion;
  assert.equal(manager.coversGround(10, 10), false); // nothing streamed: placed content here would float
  assert.equal(manager.groundVersion, v0); // asking is free
  // an HLOD part publishes cell 3_0
  const part = { group: new THREE.Group(), cellKeys: new Set(["3_0"]), entityCount: 1, far: false };
  manager.publishSupercell("0_0", part, "append", 1);
  assert.ok(manager.groundVersion > v0);
  assert.equal(manager.coversGround(3 * 48 + 5, 5), true);
  assert.equal(manager.coversGround(10, 10), false);
  // and drops it
  const v1 = manager.groundVersion;
  manager.unloadSupercell("0_0");
  assert.ok(manager.groundVersion > v1);
  assert.equal(manager.coversGround(3 * 48 + 5, 5), false);
  // no cell to stream there (outside the world): nothing to wait for
  manager.provider = { has: (cx: number) => cx < 100 };
  manager.hasCellMemo.clear();
  assert.equal(manager.coversGround(200 * 48, 0), true);
});

test("arrival becomes ready once every scheduled near cell has loaded, on a diagonal too", () => {
  for (const [x, z] of [[0.3, 0.3], [-0.45, 0.49], [0.49, -0.49], [10.7, -3.2]] as const) {
    const { manager } = fixture();
    manager.streamer = chunkStreamerSchema.parse({ source: "w", cellSize: 1, keepPadding: 1,
      hlodSupercellFactor: 4, rings: { simulation: 2, fullRender: 3, hlod: 7, farTerrain: 12 } });
    manager.update(x, z);
    assert.equal(manager.isArrivalReady(x, z), false);
    // load exactly what the residency pass scheduled (queued near cells), nothing more
    const scheduled = [...manager.cellQueue];
    assert.ok(scheduled.length > 0);
    for (const key of scheduled) manager.loaded.set(key, { rep: manager.desiredCells.get(key), simulated: true });
    assert.equal(manager.isArrivalReady(x, z), true, `focus ${x},${z}: scheduled ${scheduled.length}`);
  }
});


test("a promotion re-bake goes ahead of the far ring and gets a bake slot while it is busy", () => {
  // Owner report 2026-11-08: running up to something with an LOD did not swap it until you stopped. The block's
  // re-bake was queued behind every still-missing far-ring bake, and a moving player re-queued those on each pass.
  const { manager } = fixture();
  delete manager.queueSupercell; // the real queue
  delete manager.pumpSupercellQueue;
  const started: Array<[string, boolean]> = [];
  manager.loadSupercell = (key: string, _m: unknown, _mode: unknown, _far: unknown, urgent: boolean) => {
    started.push([key, urgent]);
    manager.inFlightSupercells.add(key);
    return new Promise(() => {}); // never finishes: the slots stay busy
  };
  // the far ring already holds both normal slots
  manager.inFlightSupercells.add("f9_9");
  manager.inFlightSupercells.add("f8_8");
  proxy(manager, "0_0", ["1_0", "2_0"]);
  manager.loaded.set("1_0", { rep: "fullRender", simulated: false });
  manager.update(0, 0);
  // still-missing blocks were queued in the same pass, after the promotion
  assert.ok(manager.supercellQueue.length > 1);
  assert.deepEqual(started, [["0_0", true]], "the promotion re-bake started at once, nothing else did");
  // another pass re-queues the missing ring without starting it
  manager.lastFocus = null;
  manager.update(0, 0);
  assert.equal(started.length, 1);
  assert.ok(manager.supercellQueue.every((entry: { urgent: boolean }) => !entry.urgent));
});

test("urgent supercell entries stay ahead of newer normal ones; the switch restores plain newest-first", () => {
  const { manager } = fixture();
  delete manager.queueSupercell;
  manager.desiredSupercells = new Set(["a", "b", "c"]);
  manager.queueSupercell("a", new Set(), "replace", false, true);
  manager.queueSupercell("b", new Set(), "replace", false);
  manager.queueSupercell("c", new Set(), "replace", false);
  assert.deepEqual(manager.supercellQueue.map((e: { key: string }) => e.key), ["a", "c", "b"]);
  manager.supercellQueue.length = 0;
  manager.urgentPromotions = false;
  manager.queueSupercell("a", new Set(), "replace", false, true);
  manager.queueSupercell("b", new Set(), "replace", false);
  assert.deepEqual(manager.supercellQueue.map((e: { key: string }) => e.key), ["b", "a"]);
});
