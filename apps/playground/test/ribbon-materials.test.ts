import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOperator, createWorldField, defaultWorldRecipe, worldRecipeSchema, type OperatorFieldReader } from "@hitreg/core";
import { missingRibbonMaterials, ribbonMaterialIds, writeRibbonMaterials } from "../tools/_ribbon-materials.mts";
// @ts-expect-error untyped helper module
import { encodePng } from "../tools/_png.mjs";

test("ribbon materials: a path's paving material is reported missing until written, then found (no flat white-grey ribbon)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ribbon-mat-"));
  try {
    const assets = path.join(dir, "projects", "lab", "assets");
    fs.mkdirSync(path.join(assets, "worlds"), { recursive: true });
    fs.mkdirSync(path.join(assets, "textures"), { recursive: true });
    fs.writeFileSync(path.join(assets, "textures", "road.png"), encodePng(4, 4, new Uint8Array(64).fill(128)));
    const base = defaultWorldRecipe({ cellSize: 48 });
    const surfaces = base.surfaces.map((s, i) => (i === 2 ? { ...s, map: "road.png" } : s));
    const recipe0 = worldRecipeSchema.parse({ ...base, surfaces, regions: [{ id: "r", name: "R", polygon: [[-500, -500], [500, -500], [500, 500], [-500, 500]], tags: [], ground: { cliff: surfaces[0]!.name, ground: surfaces[1]!.name, road: surfaces[2]!.name } }] });
    const f0 = createWorldField(recipe0);
    const reader: OperatorFieldReader = { height: (x, z) => f0.height(x, z), voxelSize: 2, seaLevel: recipe0.seaLevel, seed: 1 };
    const { recipe } = applyOperator(recipe0, { id: "lane", op: "path", points: [[-30, 0], [30, 4]], width: 2.4 }, reader);
    const file = path.join(assets, "worlds", "lab.json");
    const ids = ribbonMaterialIds(recipe);
    assert.ok(ids.length >= 1 && ids[0]!.startsWith("ribbon/"), JSON.stringify(ids));
    assert.deepEqual(missingRibbonMaterials(recipe, file), ids);
    const { wrote } = writeRibbonMaterials(recipe, file);
    assert.ok(wrote.some((w) => w.endsWith(".json")));
    assert.deepEqual(missingRibbonMaterials(recipe, file), []);
    // overwritten in place: a second write changes nothing on disk
    const before = fs.readFileSync(path.join(assets, "materials", `${ids[0]}.json`), "utf8");
    writeRibbonMaterials(recipe, file);
    assert.equal(fs.readFileSync(path.join(assets, "materials", `${ids[0]}.json`), "utf8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
