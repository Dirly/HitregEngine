import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killTree } from "../tools/_kill-tree.mts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// portal-play 2026-10-31: stopVite fired an async `spawn("taskkill")` and exited at once, so every run left its vite
// listening. killTree must have killed the whole tree (the shell, its child and grandchild) by the time it returns.
test("killTree stops a child and its grandchild before it returns (no race with process.exit)", async () => {
  const grand = "setInterval(() => {}, 1000)";
  const mid = `const c = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grand)}], { stdio: ["ignore", "ignore", "ignore"] }); console.log(c.pid); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", mid], { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
  const grandPid = await new Promise<number>((res, rej) => {
    const t = setTimeout(() => rej(new Error("no grandchild pid")), 10000);
    child.stdout!.once("data", (b: Buffer) => { clearTimeout(t); res(Number(b.toString().trim())); });
  });
  assert.ok(alive(child.pid!) && alive(grandPid), "the tree is up");
  killTree(child.pid);
  // synchronous on Windows (taskkill /t has returned); a signal elsewhere lands within moments
  const deadline = Date.now() + (process.platform === "win32" ? 0 : 2000);
  while ((alive(child.pid!) || alive(grandPid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(child.pid!), false, "the child is gone");
  assert.equal(alive(grandPid), false, "the grandchild is gone");
});

test("killTree ignores a missing pid", () => {
  assert.doesNotThrow(() => killTree(undefined));
});
