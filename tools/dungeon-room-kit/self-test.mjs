// node --test tools/dungeon-room-kit/self-test.mjs
// Builds examples/sample-rooms.json (one room per style) in headless Blender and checks the export:
// every solid closed (the exporter refuses otherwise), one group per room, the noise keys tagged, detail counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT = path.dirname(fileURLToPath(import.meta.url));
const BLENDER = process.env.BLENDER || "P:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe";

test("sample rooms build into closed, grouped, counted solids", { skip: !fs.existsSync(BLENDER) && "no Blender" }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "roomkit-"));
  const r = spawnSync(BLENDER, ["--background", "--factory-startup", "--python-exit-code", "1", "--python", path.join(KIT, "kit/blender_build.py"), "--", path.join(KIT, "examples/sample-rooms.json"), out], { encoding: "utf8" });
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000));
  const audit = JSON.parse(fs.readFileSync(path.join(out, "source-audit.json"), "utf8"));
  assert.equal(audit.passed, true);
  assert.equal(audit.closureFailures.length, 0);
  assert.deepEqual(new Set(audit.objects.map((o) => o.group)), new Set(["crypt", "parlour", "hall", "den", "grotto"]));
  assert.ok(audit.roleNoiseTags.keys.includes("rock-wall") && audit.roleNoiseTags.keys.includes("ice-roof"));
  const rep = JSON.parse(fs.readFileSync(path.join(out, "kit-report.json"), "utf8"));
  for (const room of rep.rooms) assert.ok(room.detail >= 18, `${room.id}: ${room.detail} detail pieces`);
  const kinds = new Set(rep.rooms.flatMap((x) => Object.keys(x.kinds)));
  for (const k of ["pilaster", "voussoir", "rib", "niche", "plinth", "stile", "beam", "rafter", "post-pad", "pillar", "stalactite"]) assert.ok(kinds.has(k), `no ${k}`);
  const stamp = JSON.parse(fs.readFileSync(path.join(out, "sample-rooms.mesh-stamp.json"), "utf8"));
  assert.ok(stamp.noise && stamp.noise.roles["rock-wall"]);
  fs.rmSync(out, { recursive: true, force: true });
});

test("timber hall: no wall post stands in a doorway on a long wall", { skip: !fs.existsSync(BLENDER) && "no Blender" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-posts-"));
  const out = path.join(dir, "posts.json");
  const expr = `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(KIT, "kit").split(path.sep).join("/"))})
import blender_build as k
plan = {"rooms": [{"id": "h", "style": "giant-timber", "x": [0, 30], "y": [0, 33.8], "floor": 0, "height": 13,
  "doors": [{"side": "W", "at": 16.9, "width": 8, "height": 10}]}]}
spec, room = k.plan_rooms(plan)[0]
posts = [min(min(v[0] for v in s.verts), 99) for p in room.pieces if p["kind"] == "post" for s in p["solids"]
         if 16.9 - 6 < sum(v[1] for v in s.verts) / len(s.verts) < 16.9 + 6]
json.dump({"near": posts}, open(${JSON.stringify(out.split(path.sep).join("/"))}, "w"))`;
  const r = spawnSync(BLENDER, ["--background", "--factory-startup", "--python-exit-code", "1", "--python-expr", expr], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const { near } = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(near.every((x) => x > 3), `a post stands in front of the west door: ${JSON.stringify(near)}`);
});
