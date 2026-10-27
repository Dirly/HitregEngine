/** A child tool run with a hard wall-clock cap (place-build shots: a run once hung ~60 min holding the heavy slot). */
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

/** `tool` with a hard wall-clock cap: past `ms` the child's whole process tree is killed (taskkill /t on Windows, the
 *  process group elsewhere) and the run returns status 124 with a TIMEOUT line in its log. */
export function runCapped(argv: string[], ms: number, logFile?: string): Promise<{ status: number; out: string; timedOut: boolean; s: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const c = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "", timedOut = false;
    if (logFile) fs.writeFileSync(logFile, `$ ${argv.join(" ")}
`);
    const add = (d: any) => { out += d; if (logFile) fs.appendFileSync(logFile, d); }; // live: a long run shows where it is
    c.stdout!.on("data", add); c.stderr!.on("data", add);
    const timer = setTimeout(() => { timedOut = true;
      try { if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/t", "/f"]); else process.kill(-c.pid!, "SIGKILL"); } catch { /* gone */ } }, ms);
    c.on("close", (code) => { clearTimeout(timer); resolve({ status: timedOut ? 124 : code ?? 1, out: timedOut ? `${out}\nTIMEOUT: killed after ${Math.round(ms / 1000)} s (process tree)` : out, timedOut, s: Math.round((Date.now() - t0) / 1000) }); });
  });
}

/** L (Exiles' Bell 2026-10-24: one stalled spot ran a 9-view shot run into the flat 15 min cap and lost every picture):
 *  the whole run's cap grows with its spots, max(15 min, spots x 2 times x 50 s). */
export const SHOT_SPOT_S = 50, SHOT_SPOT_TIMEOUT_S = 90;
export const shotsCapMs = (spots: number, times = 2, minMin = 15): number => Math.max(minMin * 60_000, spots * times * SHOT_SPOT_S * 1000);
/** A per-spot timeout: resolves `"timeout"` (the spot is skipped) when `work` has not settled within `ms`; a rejection
 *  passes through. The stalled work is left behind (the caller reopens its session). */
export function withSpotTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<"timeout">((res) => { t = setTimeout(() => res("timeout"), ms); });
  return Promise.race([work, timer]).finally(() => clearTimeout(t));
}
