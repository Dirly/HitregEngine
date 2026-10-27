import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// React 19 dev logs each render's prop diff to performance.measure; with the scene doc as a prop that cloned a 23 MB
// world per edit and killed the tab (SHOTS-FIX 2026-10-21). boot.ts must turn it off BEFORE react-dom loads.
test("boot.ts removes console.timeStamp before the app (and react-dom) is imported", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "boot.ts"), "utf8");
  const off = src.indexOf("timeStamp = undefined");
  const app = src.indexOf('import("./main.js")');
  assert.ok(off > 0, "boot.ts no longer removes console.timeStamp");
  assert.ok(app > off, "console.timeStamp must be removed before main.js is imported");
  // nothing boot.ts imports statically may pull React in ahead of it
  for (const m of src.matchAll(/^import .* from "(\.[^"]+)";/gm)) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", m[1]!.replace(/\.js$/, ".ts"));
    assert.ok(!/from "react|@hitreg\/editor/.test(fs.readFileSync(file, "utf8")), `${m[1]} imports React before the switch`);
  }
});
