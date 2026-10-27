// The browser harnesses resolve playwright from the apps/playground devDependency (no scratchpad install, no env var);
// HITREG_PLAYWRIGHT / PLAYWRIGHT_MODULE still override (tools/_playwright.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS module
import { loadPlaywright, playwrightSource } from "../tools/_playwright.mjs";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("playwright is a pinned devDependency and loads without any env override", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PG, "package.json"), "utf8"));
  assert.match(pkg.devDependencies.playwright, /^\d+\.\d+\.\d+$/, "pinned to an exact version");
  assert.equal(playwrightSource({}).kind, "devDependency");
  const pw = await loadPlaywright({});
  assert.equal(typeof pw.chromium?.launch, "function");
});

test("HITREG_PLAYWRIGHT and PLAYWRIGHT_MODULE override; a bad override fails with the fix", async () => {
  const dir = path.join(PG, "node_modules", "playwright");
  assert.equal(typeof (await loadPlaywright({ HITREG_PLAYWRIGHT: dir })).chromium?.launch, "function");
  assert.equal(typeof (await loadPlaywright({ PLAYWRIGHT_MODULE: path.join(dir, "index.mjs") })).chromium?.launch, "function");
  await assert.rejects(loadPlaywright({ HITREG_PLAYWRIGHT: path.join(PG, "no-such-playwright") }), /pnpm install/);
});

test("no harness points at a scratchpad playwright any more", () => {
  for (const f of fs.readdirSync(path.join(PG, "tools")).filter((x) => /\.m?[jt]s$/.test(x))) {
    const s = fs.readFileSync(path.join(PG, "tools", f), "utf8");
    assert.ok(!/scratchpad\/node_modules\/playwright/.test(s), `${f} names a scratchpad playwright`);
  }
});
