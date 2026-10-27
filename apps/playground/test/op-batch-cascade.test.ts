import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { applyOperator, defaultWorldRecipe, registerOperator, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { commandOp, operatorReader } from "../tools/worldgen-operators.mts";

// A raise that refuses ground already higher than `max` (like a scree whose apexDrop no longer fits the new ground).
registerOperator({
  op: "test-batch-raise",
  description: "test only",
  schema: z.object({ at: z.tuple([z.number(), z.number()]), by: z.number(), max: z.number().default(1e9) }) as never,
  compile: (p: { at: [number, number]; by: number; max: number }, reader) => {
    const g = reader.height(p.at[0], p.at[1]);
    if (g > p.max) throw new Error(`ground ${g.toFixed(1)} over max ${p.max}`);
    const heights: number[] = [];
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) heights.push(Math.round((reader.height(p.at[0] - 20 + i * 10, p.at[1] - 20 + j * 10) + p.by) * 100) / 100);
    return { features: { heightPatches: [{ id: "g", origin: [p.at[0] - 20, p.at[1] - 20], size: [40, 40], columns: 5, rows: 5, heights, blend: 4 }] }, report: {} };
  },
  bounds: (p: { at: [number, number] }) => ({ x0: p.at[0] - 20, z0: p.at[1] - 20, x1: p.at[0] + 20, z1: p.at[1] + 20 }),
});

describe("worldgen op --apply of a batch", () => {
  it("cascades into a later operator of the same batch from its NEW doc, not the installed one", () => {
    let r: WorldRecipe = worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24 });
    const A = { id: "a", op: "test-batch-raise", at: [0, 0], by: 2 };
    r = applyOperator(r, A, operatorReader(r, "a")).recipe;
    const g = operatorReader(r, "b").height(5, 5);
    // B installed with a max that only fits the current ground
    r = applyOperator(r, { id: "b", op: "test-batch-raise", at: [5, 5], by: 1, max: g + 1 }, operatorReader(r, "b")).recipe;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-batch-"));
    const batch = path.join(dir, "batch.json");
    // A rises by 8: the installed B (max g+1) no longer fits; the batch's B (max g+20) does
    fs.writeFileSync(batch, JSON.stringify([{ ...A, by: 10 }, { id: "b", op: "test-batch-raise", at: [5, 5], by: 1, max: g + 20 }]));
    let written: WorldRecipe | null = null;
    const log = console.log;
    console.log = () => {};
    try {
      commandOp({
        argv: ["--apply", batch], project: "",
        loadRecipe: () => ({ recipe: r, file: path.join(dir, "w.json") }),
        writeRecipe: (rec) => { written = rec; },
        fail: (m: string) => { throw new Error(m); },
      });
    } finally { console.log = log; }
    assert.ok(written);
    const ops = (written as WorldRecipe).features.operators!;
    assert.deepEqual(ops.map((o) => o.id), ["a", "b"]);
    assert.ok(Math.abs((ops[1] as unknown as { max: number }).max - (g + 20)) < 1e-6);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
