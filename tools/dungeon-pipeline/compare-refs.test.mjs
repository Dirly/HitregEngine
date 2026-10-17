// compare gate references (quality.mjs referenceSheets): a reference sheet that moved between the views stage's two homes
// (reports/views/sheet.png, authoring/views/sheet.png) is still found.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { referenceSheets } from "./quality.mjs";

test("a reference sheet is found in either views home", () => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "refs-"));
  fs.mkdirSync(path.join(projects, "fieldfast-hall/reports/views"), { recursive: true });
  fs.writeFileSync(path.join(projects, "fieldfast-hall/reports/views/sheet.png"), "x");
  const refs = referenceSheets({ projects, id: "some-dungeon" });
  const hall = refs.find((r) => r.id === "fieldfast-hall");
  assert.equal(hall.file, path.join(projects, "fieldfast-hall/reports/views/sheet.png"));
  const barrow = refs.find((r) => r.id === "fieldfast-barrow");
  assert.ok(barrow.file.endsWith(path.join("fieldfast-barrow", "reports/views/sheet.png")), "a missing one keeps its declared path");
});
