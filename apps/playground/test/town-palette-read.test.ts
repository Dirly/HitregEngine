import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFindings, separated, styleTiles, luma, hueSat } from "../tools/town-palette.mts";

// k-kit2 (2026-10-29): redstrand's first palette passed the adjacency check with stone, render and roof all one orange
const stone = { r: 97, g: 62, b: 40 }, oldRender = { r: 108, g: 69, b: 39 }, oldRoof = { r: 91, g: 60, b: 46 };
const limeRender = { r: 196, g: 178, b: 150 }, darkRoof = { r: 62, g: 50, b: 44 };

test("redstrand's first palette fails the read gate: one orange for both walls and the roofs", () => {
  const f = readFindings([
    { style: "badland-stone", wall: stone, roof: oldRoof, material: "stone" },
    { style: "badland-render", wall: oldRender, roof: oldRoof, material: "stucco" },
  ]);
  assert.equal(f.length, 3);
  assert.match(f[0]!, /walls of badland-stone .* and badland-render .* read as one material/);
  assert.ok(f.some((x) => x.startsWith("badland-stone: roof")));
  assert.ok(f.some((x) => x.startsWith("badland-render: roof")));
});

test("pale lime render over red rubble with dark roofs passes", () => {
  assert.deepEqual(readFindings([
    { style: "badland-stone", wall: stone, roof: darkRoof, material: "stone" },
    { style: "badland-render", wall: limeRender, roof: darkRoof, material: "stucco" },
  ]), []);
});

test("hue alone separates two saturated walls of one value; pattern walls are not held to the wall rule", () => {
  const red = { r: 160, g: 60, b: 50 }, green = { r: 70, g: 120, b: 60 };
  assert.ok(Math.abs(luma(red) - luma(green)) / luma(green) < 0.25);
  assert.ok(separated(red, green, 0.25).ok);
  assert.ok(hueSat(red).h < 10 && hueSat(green).h > 90);
  const timber = { r: 117, g: 99, b: 72 }, stucco = { r: 140, g: 119, b: 85 }, roof = { r: 60, g: 55, b: 50 };
  assert.deepEqual(readFindings([
    { style: "t", wall: timber, roof, material: "timber-frame" },
    { style: "s", wall: stucco, roof, material: "stucco" },
  ]), []);
});

test("styleTiles follows theme.map and the wall material, theme folder before the kit root", () => {
  const wfc = fs.mkdtempSync(path.join(os.tmpdir(), "palette-read-"));
  const styles = path.join(wfc, "styles"), theme = path.join(styles, "themes", "t");
  fs.mkdirSync(theme, { recursive: true });
  for (const f of ["StuccoWall", "Roofing", "RoofingRender"]) fs.writeFileSync(path.join(theme, `${f}.png`), "");
  fs.writeFileSync(path.join(wfc, "Stone.png"), "");
  fs.writeFileSync(path.join(styles, "default.json"), JSON.stringify({ name: "default", walls: { material: "timber-frame" } }));
  fs.writeFileSync(path.join(styles, "a.json"), JSON.stringify({ name: "a", walls: { material: "stone" }, theme: { folder: "styles/themes/t" } }));
  fs.writeFileSync(path.join(styles, "b.json"), JSON.stringify({ name: "b", extends: "a", walls: { material: "stucco" }, theme: { map: { Roofing: "RoofingRender" } } }));
  try {
    assert.deepEqual(styleTiles("a", styles), { wall: path.join(wfc, "Stone.png"), roof: path.join(theme, "Roofing.png") });
    assert.deepEqual(styleTiles("b", styles), { wall: path.join(theme, "StuccoWall.png"), roof: path.join(theme, "RoofingRender.png") });
  } finally { fs.rmSync(wfc, { recursive: true, force: true }); }
});
