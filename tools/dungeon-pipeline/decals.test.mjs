// decals gate (quality.mjs gateDecals): a dungeon's decal set is its own (owner ruling 2026-10-13). A decal another
// dungeon uses (same file, byte copy, perceptual near copy) fails; one decal over 40% fails; decals are optional.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dHash, hamming, runGate, setDry } from "./quality.mjs";
import { encodePng } from "../texture-intake/png.mjs";

/** A 32 x 32 RGBA splat: a dark blob at (cx, cy) radius r on transparent. */
function splat(cx, cy, r, tone = 20) {
  const W = 32, data = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, inside = Math.hypot(x - cx, y - cy) < r;
    data[i] = data[i + 1] = data[i + 2] = tone; data[i + 3] = inside ? 255 : 0;
  }
  return { width: W, height: W, data };
}

function dungeon(projects, id, decals) {
  const root = path.join(projects, id);
  for (const d of ["authoring", "assets/scenes", "assets/textures"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "authoring/plan.json"), JSON.stringify({ spaces: [] }));
  fs.writeFileSync(path.join(root, "authoring/pipeline.mjs"), "");
  const entities = {};
  let n = 0;
  for (const [tex, count, img] of decals) {
    if (img) { fs.mkdirSync(path.dirname(path.join(root, "assets/textures", tex)), { recursive: true }); fs.writeFileSync(path.join(root, "assets/textures", tex), encodePng(img.width, img.height, img.data)); }
    for (let k = 0; k < count; k++) entities[`d${n++}`] = { components: { transform: {}, decal: { texture: tex } } };
  }
  fs.writeFileSync(path.join(root, `assets/scenes/${id}.scene.json`), JSON.stringify({ entities }));
  return root;
}

test("dHash: the same picture hashes the same, a different one far off", () => {
  const a = dHash(splat(10, 10, 6)), b = dHash(splat(10, 10, 6)), c = dHash(splat(24, 22, 5));
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.ok(hamming(a, c) > 6, `distance ${hamming(a, c)}`);
});

test("a decal copied from another dungeon fails; one decal over 40% fails; no decals passes", async () => {
  setDry(true);
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "decals-"));
  dungeon(projects, "a-dungeon", [["a-dungeon/soot.png", 4, splat(10, 10, 6)], ["a-dungeon/moss.png", 4, splat(24, 22, 5)]]);
  const b = dungeon(projects, "b-dungeon", [["b-dungeon/stain.png", 2, splat(10, 10, 6)], ["b-dungeon/drip.png", 8, splat(5, 26, 3)]]);
  const r = await runGate("decals", b);
  const checks = r.failures.map((f) => f.check);
  assert.ok(checks.includes("decalReused"), JSON.stringify(r.failures));
  assert.ok(r.failures.some((f) => /b-dungeon\/stain\.png is a byte copy of a-dungeon/.test(f.what)));
  assert.ok(r.failures.some((f) => f.check === "decalShare" && /drip/.test(f.what)));
  assert.ok(checks.includes("decalSet")); // no authoring/decals/set.json
  const c = dungeon(projects, "c-dungeon", []);
  assert.equal((await runGate("decals", c)).passed, true);
});

test("a decal made through the dungeon's own set manifest passes the set check", async () => {
  setDry(true);
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "decals-set-"));
  const d = dungeon(projects, "d-dungeon", [["d-dungeon/ash.png", 2, splat(12, 12, 7)], ["d-dungeon/gouge.png", 2, splat(20, 8, 4)], ["d-dungeon/drip.png", 2, splat(4, 26, 3)]]);
  fs.mkdirSync(path.join(d, "authoring/decals"), { recursive: true });
  fs.writeFileSync(path.join(d, "authoring/decals/set.json"), JSON.stringify({ brief: "x", images: [
    { id: "d-dungeon-decal-ash", target: "projects/d-dungeon/assets/textures/d-dungeon/ash.png", ref: "projects/d-dungeon/authoring/concept/a.png", alpha: true, prompt: "ash" },
    { id: "d-dungeon-decal-drip", target: "projects/d-dungeon/assets/textures/d-dungeon/drip.png", ref: ["projects/d-dungeon/authoring/concept/a.png"], prompt: "drip" },
    { id: "gouge", target: "projects/d-dungeon/assets/textures/d-dungeon/gouge.png", prompt: "gouge" },
  ] }));
  const r = await runGate("decals", d);
  assert.deepEqual(r.failures.map((f) => f.check), ["decalSet"]);
  assert.match(r.failures[0].what, /gouge.*prefixed "d-dungeon-"/);
});
