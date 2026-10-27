import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstExisting } from "../tools/_closure.mjs";

test("a closure file is found in whichever project keeps it, own project first", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closure-file-"));
  const world = path.join(tmp, "world"), kit = path.join(tmp, "kit");
  fs.mkdirSync(path.join(kit, "authoring/poi-props"), { recursive: true });
  fs.mkdirSync(path.join(world, "authoring"), { recursive: true });
  fs.writeFileSync(path.join(kit, "authoring/poi-props/dressing.json"), "{}");
  fs.writeFileSync(path.join(world, "authoring/own.json"), "{}");
  fs.writeFileSync(path.join(kit, "authoring/own.json"), "{}");
  try {
    // a world's props status reads the kit's sidecar (it used to stat it inside the world: ENOENT)
    assert.equal(firstExisting([world, kit], "authoring/poi-props/dressing.json"), path.join(kit, "authoring/poi-props/dressing.json"));
    assert.equal(firstExisting([world, kit], "authoring/own.json"), path.join(world, "authoring/own.json"));
    assert.equal(firstExisting([world, kit], "authoring/none.json"), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
