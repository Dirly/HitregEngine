/**
 * Stop a child's whole process tree, SYNCHRONOUSLY: when this returns the tree is gone.
 *
 * Tools that start their own vite and call `process.exit` right after stopping it must not use an async
 * `spawn("taskkill", ...)`: the exit races it and the dev server lives on (portal-play leaked one vite per run,
 * 2026-10-31 — `npx.cmd` under `shell: true` is cmd.exe -> npx -> vite, and only taskkill /t reaches the vite).
 * Elsewhere: the process group when the child was spawned `detached` (a group leader), else the child itself.
 */
import { spawnSync } from "node:child_process";

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
}
