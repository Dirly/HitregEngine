// A stage whose report says it is waiting on something outside the dungeon (portal play before the world's door is
// built: portal-play writes { passed: false, waiting: "world door" }) shows WAITING, not FAILED; a plain failure stays FAILED.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "./pipeline.mjs";

test("a waiting report is WAITING, a failed one FAILED, a passed one ok", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-waiting-"));
  const put = (f, j) => fs.writeFileSync(path.join(root, f), JSON.stringify(j));
  put("a.json", { passed: false, waiting: "world door" });
  put("b.json", { passed: false });
  put("c.json", { passed: true, waiting: "stale note" });
  const rows = evaluate(root, ["a", "b", "c"].map((n) => ({ name: n, out: `${n}.json`, report: `${n}.json`, inputs: [] })));
  assert.deepEqual(rows.map((r) => r.status), ["WAITING", "FAILED", "ok"]);
  fs.rmSync(root, { recursive: true, force: true });
});
