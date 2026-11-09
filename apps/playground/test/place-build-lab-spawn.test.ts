// place-build lab-spawn (tools/place-build.mts): the command is dispatched (it once fell through to "STOP: usage" because
// it was missing from ID_CMDS), it says what is missing on a lab that does not exist, and on a real lab --dry-run reports
// where the lab starts without writing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (args: string[]) => spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tools/place-build.mts", "lab-spawn", ...args], { cwd: PG, encoding: "utf8", timeout: 600_000 });

test("lab-spawn is a command: a missing lab is named, never a usage error", () => {
  const r = run(["no-such-world", "--project", "no-such-world", "--zone", "zone-1", "--location", "nowhere", "--lab", "no-such-lab"]);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.doesNotMatch(out, /usage/i);
  assert.match(out, /no lab scene/);
});

const labScene = path.join(PG, "projects", "pb-red-dial", "assets", "scenes", "pbreddial.scene.json");
test("lab-spawn --dry-run on a real lab: where it starts, nothing written", { skip: !fs.existsSync(labScene) && "no pb-red-dial lab on this machine" }, () => {
  const before = fs.readFileSync(labScene, "utf8");
  const r = run(["redstrand", "--project", "redstrand", "--zone", "zone-1", "--location", "red-dial", "--dry-run"]);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /lab pb-red-dial.*: starts at -?\d/);
  assert.match(out, /dry run: nothing written/);
  assert.equal(fs.readFileSync(labScene, "utf8"), before);
});

// Derek 2026-10-31: every lab starts at its place, a --whole-world lab too (its scene is a lab's, not the world's)
const wholeLab = path.join(PG, "projects", "pb-strand-farm");
test("a --whole-world lab (no lab-box.json) starts at its place too", { skip: (!fs.existsSync(path.join(wholeLab, "assets", "scenes", "pbstrandfarm.scene.json")) || fs.existsSync(path.join(wholeLab, "lab-box.json"))) && "no whole-world pb-strand-farm lab on this machine" }, () => {
  const r = run(["redstrand", "--project", "redstrand", "--zone", "zone-1", "--location", "strand-farm", "--dry-run"]);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /lab pb-strand-farm \(whole world\): starts at -?\d/);
  assert.match(out, /strand-farm: where its approach arrives, facing its centre/);
});
