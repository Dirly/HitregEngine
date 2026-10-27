// atlas gate (quality.mjs gateAtlas): one stone colouring per dungeon, plus at most ONE declared accent family
// (plan.json atlas.accent, coordinator ruling 2026-10-17 on the Inverted Spire's slate + rust-red banded stone). Accent
// roles are judged on the accent band; accent-hued pixels inside a main tile (a red course in the ashlar) are left out of
// that tile's mean, so the two colourings never average into a hue no tile has.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGate, setDry } from "./quality.mjs";
import { encodePng } from "../texture-intake/png.mjs";

const SLATE = [44, 50, 64], RED = [120, 62, 44], HOT = [170, 70, 30];
/** 16 x 16 tile: `rows` of colour B every fourth row (a banded course), the rest colour A. */
function tile(a, b = null) {
  const W = 16, data = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const c = b && y % 4 === 0 ? b : a, i = (y * W + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return encodePng(W, W, data);
}

function dungeon(projects, id, { accent, trim }) {
  const root = path.join(projects, id);
  for (const d of ["authoring", "reports", `assets/textures/${id}`, `assets/materials/${id}`]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "authoring/plan.json"), JSON.stringify({ spaces: [], ...(accent ? { atlas: { accent } } : {}) }));
  fs.writeFileSync(path.join(root, "authoring/pipeline.mjs"), "");
  const tiles = { "large-ashlar": tile(SLATE, RED), flagstone: tile([40, 46, 58]), "dressed-trim": tile(trim) };
  const layers = [], roles = [];
  for (const [role, png] of Object.entries(tiles)) {
    fs.writeFileSync(path.join(root, `assets/textures/${id}/${role}.png`), png);
    roles.push({ slot: layers.length, role, painted: true });
    layers.push({ color: "#ffffff", map: `${id}/${role}.png` });
  }
  fs.writeFileSync(path.join(root, `assets/materials/${id}/dc-palette.json`), JSON.stringify({ splat: { layers } }));
  fs.writeFileSync(path.join(root, "reports/materials.json"), JSON.stringify({ roles }));
  return root;
}

test("banded slate + red trim fails one colouring, passes with the trim declared as the accent", async () => {
  setDry(true);
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-"));
  const plain = await runGate("atlas", dungeon(projects, "a-dungeon", { trim: RED }));
  assert.ok(plain.failures.some((f) => f.check === "hue"), JSON.stringify(plain.failures));
  const r = await runGate("atlas", dungeon(projects, "b-dungeon", { trim: RED, accent: { roles: ["dressed-trim"], hue: 14, maxSat: 0.7 } }));
  assert.deepEqual(r.failures, []);
  const ashlar = r.metrics.tiles.find((t) => t.role === "large-ashlar");
  assert.ok(Math.abs(ashlar.hue - 222) < 8, `ashlar hue ${ashlar.hue} keeps its slate hue once the red course is left out`);
  assert.ok(ashlar.accentShare > 0.2 && ashlar.accentShare < 0.3);
  assert.equal(r.metrics.tiles.find((t) => t.role === "dressed-trim").family, "stone-accent");
});

test("the accent is held to its own band: off-hue or over-saturated accent tiles fail", async () => {
  setDry(true);
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-acc-"));
  const hot = await runGate("atlas", dungeon(projects, "c-dungeon", { trim: HOT, accent: { roles: ["dressed-trim"], hue: 14, maxSat: 0.55 } }));
  assert.deepEqual(hot.failures.map((f) => f.check), ["saturation"]);
  const off = await runGate("atlas", dungeon(projects, "d-dungeon", { trim: RED, accent: { roles: ["dressed-trim"], hue: 200 } }));
  assert.ok(off.failures.some((f) => f.check === "hue" && /declared accent/.test(f.what)), JSON.stringify(off.failures));
});
