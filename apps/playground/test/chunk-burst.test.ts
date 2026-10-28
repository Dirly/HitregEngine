import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { chunkStreamerSchema } from "@hitreg/core";
import { ChunkManager, CELL_INTEGRATION_BUDGET_BURST_MS, CELL_INTEGRATION_BUDGET_MS } from "../src/chunk-manager.js";

// The real drainPendingCells against stubbed integration: each cell "costs" more than the per-frame budget,
// so pacing admits one cell per update while the burst budget admits many.
function fixture(cellMs: number) {
  const manager = new ChunkManager(null as any, null as any, {} as any) as any;
  manager.scene = new THREE.Scene();
  manager.streamer = chunkStreamerSchema.parse({ source: "w", cellSize: 1, keepPadding: 0,
    hlodSupercellFactor: 4, rings: { simulation: 1, fullRender: 2, hlod: 4, farTerrain: 8 } });
  manager.provider = { has: () => true };
  manager.pumpCellQueue = () => {};
  manager.pumpSupercellQueue = () => {};
  manager.drainPendingSupercells = () => {};
  manager.leadStreaming = false;
  const integrated: string[] = [];
  manager.integrateCell = (entry: { key: string }) => {
    const until = performance.now() + cellMs;
    while (performance.now() < until) { /* a cell's synchronous publish */ }
    integrated.push(entry.key);
  };
  for (let i = 0; i < 24; i++) {
    const key = `${i}_0`;
    manager.pending.set(key, { key, cx: i, cz: 0, streamer: manager.streamer });
    manager.desiredCells.set(key, "fullRender");
  }
  return { manager, integrated };
}

test("the per-frame budget admits one over-budget cell per update; the burst budget admits many", () => {
  const cellMs = CELL_INTEGRATION_BUDGET_MS + 1;
  const paced = fixture(cellMs);
  paced.manager.update(0, 0);
  assert.equal(paced.integrated.length, 1, "pacing: the first cell always goes, the rest wait");
  const burst = fixture(cellMs);
  burst.manager.integrationBurst = true;
  burst.manager.update(0, 0);
  // the exact count depends on the machine (a busy-wait under a parallel test run stretches each cell); what is
  // asserted is the shape: several cells against one, and a stop before the whole queue
  assert.ok(burst.integrated.length >= 3, `burst: ${burst.integrated.length} cells in one update (expected several, up to ~${Math.floor(CELL_INTEGRATION_BUDGET_BURST_MS / cellMs)})`);
  assert.ok(burst.integrated.length < 24, "burst still stops at its budget");
  // nearest to the focus first, under both budgets
  assert.equal(paced.integrated[0], "0_0");
  assert.equal(burst.integrated[0], "0_0");
});
