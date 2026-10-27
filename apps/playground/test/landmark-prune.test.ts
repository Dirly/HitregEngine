import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pruneSupersededBakes } from "../tools/_landmark-colliders.mts";

describe("pruneSupersededBakes (no iteration files)", () => {
  it("removes only the same op's older digests (prefab, render GLBs, collider tiles), keeping the new bake and the recipe's", () => {
    const into = mkdtempSync(join(tmpdir(), "lm-prune-"));
    try {
      const P = join(into, "prefabs", "landmarks"), M = join(into, "models", "landmarks");
      mkdirSync(P, { recursive: true }); mkdirSync(M, { recursive: true });
      const touch = (dir: string, f: string) => writeFileSync(join(dir, f), "x");
      for (const d of ["3a7c167d", "6f6f44b9", "cc6779a9", "0badf00d"]) {
        touch(P, `spoil-causeway-${d}.json`);
        for (const f of [".b1.glb", ".b2.glb", ".collider.64_-18.glb", ".collider.-1_3.glb", ".glb"]) touch(M, `spoil-causeway-${d}${f}`);
      }
      // other ops: a prefix of the id, an id that extends it, hand-named files
      for (const f of ["spoil-1234abcd.json", "spoil-causeway-west-3a7c167d.json", "spoil-causeway-off.json"]) touch(P, f);
      for (const f of ["spoil-1234abcd.b1.glb", "spoil-causeway-west-3a7c167d.b1.glb", "spoil-causeway-west-3a7c167d.collider.1_1.glb"]) touch(M, f);

      const dry = pruneSupersededBakes(into, "spoil-causeway", ["landmarks/cc6779a9-not-it", "landmarks/spoil-causeway-cc6779a9", "spoil-causeway-0badf00d"], { dryRun: true });
      assert.equal(dry.length, 2 * 6);
      assert.equal(readdirSync(P).length, 4 + 3, "a dry run deletes nothing");

      const gone = pruneSupersededBakes(into, "spoil-causeway", ["landmarks/spoil-causeway-cc6779a9", "landmarks/spoil-causeway-0badf00d"]);
      assert.deepEqual(gone.sort(), dry.sort());
      assert.deepEqual(readdirSync(P).sort(), ["spoil-1234abcd.json", "spoil-causeway-0badf00d.json", "spoil-causeway-cc6779a9.json", "spoil-causeway-off.json", "spoil-causeway-west-3a7c167d.json"]);
      const models = readdirSync(M);
      assert.ok(!models.some((f) => /^spoil-causeway-(3a7c167d|6f6f44b9)\./.test(f)), "the superseded digests' GLBs and collider tiles are gone");
      assert.equal(models.filter((f) => /^spoil-causeway-(cc6779a9|0badf00d)\./.test(f)).length, 10, "the kept bakes keep every file");
      assert.ok(models.includes("spoil-causeway-west-3a7c167d.collider.1_1.glb") && models.includes("spoil-1234abcd.b1.glb"), "other ops untouched");
    } finally {
      rmSync(into, { recursive: true, force: true });
    }
  });
});
