// A byte-identical Blender re-export (same sha256 as the dc-bake report's sourceSha256) leaves dc-bake fresh; a
// changed stamp, or a report with no digest, makes it STALE by mtime as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate, fileSha256 } from "./pipeline.mjs";

test("dc-bake stays ok after a byte-identical re-export, goes STALE on a changed one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-digest-"));
  const stamp = path.join(root, "stamp.json"), report = path.join(root, "dc-bake.json");
  const age = (f, s) => fs.utimesSync(f, new Date(s * 1000), new Date(s * 1000));
  fs.writeFileSync(stamp, '{"meshes":[1]}');
  fs.writeFileSync(report, JSON.stringify({ passed: true, sourceSha256: fileSha256(stamp) }));
  const stage = { name: "dc-bake", out: "dc-bake.json", report: "dc-bake.json", inputs: ["stamp.json"], digests: { "stamp.json": "sourceSha256" } };
  age(report, 1000); age(stamp, 2000);                       // re-exported later, same bytes
  assert.equal(evaluate(root, [stage])[0].status, "ok");
  assert.equal(evaluate(root, [{ ...stage, digests: undefined }])[0].status, "STALE"); // without a digest: mtime rules
  fs.writeFileSync(stamp, '{"meshes":[2]}'); age(stamp, 2000); // a real change
  assert.equal(evaluate(root, [stage])[0].status, "STALE");
  fs.writeFileSync(report, JSON.stringify({ passed: true })); age(report, 1000); // report without the field
  assert.equal(evaluate(root, [stage])[0].status, "STALE");
  fs.rmSync(root, { recursive: true, force: true });
});
