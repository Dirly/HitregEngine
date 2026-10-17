import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { commandSeated } from "../tools/worldgen-lips.mts";

// `worldgen seated --allow id,id`: a slab proved seated another way is reported, never counted
const recipe = worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24 });
const ground = createWorldField(recipe).height(0, 0);
const run = (argv: string[]) => {
  const lines: string[] = [], log = console.log;
  console.log = (m: unknown) => { lines.push(String(m)); };
  process.exitCode = 0;
  try { commandSeated({ argv, loadRecipe: () => ({ recipe }), fail: (m: string) => { throw new Error(m); } } as never); } finally { console.log = log; }
  const code = process.exitCode; process.exitCode = 0;
  return { lines, code };
};
const hanging = `0,0,1,1,0,${ground + 3}`; // 3 m over the drawn ground: a gap

test("seated fails a hanging slab", () => {
  const r = run(["--slab", hanging]);
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1)!, /^FAIL: 1\/1/);
});
test("seated reports an --allow'ed slab and passes", () => {
  const r = run(["--slab", hanging, "--allow", "slab0"]);
  assert.equal(r.code, 0);
  assert.ok(r.lines.some((l) => /allow slab0/.test(l)));
  assert.match(r.lines.at(-1)!, /OK: 1 slabs seated \(1 allowed/);
});
