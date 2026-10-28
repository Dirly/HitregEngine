import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The engine repo must test green on a bare checkout: projects/ is gitignored, games come and go. A test may name only
 * the always-shipped closure projects (foundation, world-kit), a placeholder (x, world) or a fixture; anything else
 * (a live world such as skelmorrow, firstshore, proving) belongs in a generated fixture
 * (test/fixtures/rock-skins/build.mts is the model, HITREG_PROJECTS_ROOT the hook in tools/_closure.mjs).
 */
const ALLOWED = new Set(["foundation", "world-kit", "x", "world", "fixtures", "fixture-world"]);
const SEP = String.raw`[\/]`;
const PROJECT_PATH = new RegExp(String.raw`projects${SEP}+([A-Za-z0-9_-]+)${SEP}`, "g");

test("no test reads a live game project: every project path is foundation, world-kit, a placeholder or a fixture", () => {
  const dir = import.meta.dirname;
  const bad: string[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".test.ts") && n !== "no-live-projects.test.ts")) {
    fs.readFileSync(path.join(dir, f), "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(PROJECT_PATH)) if (!ALLOWED.has(m[1] ?? "")) bad.push(f + ":" + (i + 1) + " projects/" + m[1]);
    });
  }
  assert.deepEqual(bad, [], "tests must not depend on a live game project; generate a fixture instead");
});
