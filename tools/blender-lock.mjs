/**
 * blender-lock — ONE headless Blender on this machine at a time (Wristgate 2026-10-29: a prop-codex install and another
 * owner's WFC kit-fit started Blender in the same second; two Blenders on a 64 GB box with RAM faults is the crash risk).
 *
 * The lock is the file `<engine root>/.hitreg/blender.lock` (gitignored), created O_EXCL and holding
 * { pid, host, label, at }. Every Blender launcher takes it around its spawn and waits for a holder with a timeout:
 *
 *   import { runBlender, withBlenderLock } from "<engine>/tools/blender-lock.mjs";
 *   const r = runBlender(BLENDER, args, { encoding: "utf8" }, "prop-codex build");   // spawnSync under the lock
 *   withBlenderLock("label", () => { ... });                                          // any sync body
 *   node tools/blender-lock.mjs run [--label l] [--wait-min 60] -- <blender.exe> <args...>   (shell command strings)
 *   node tools/blender-lock.mjs status                                                (who holds it)
 *   Python launchers (MMO/WFC wfc/blender_lock.py) speak the same file format.
 *
 * Waiting: up to HITREG_BLENDER_LOCK_WAIT_MIN minutes (default 60), polling every 2 s; then it throws, naming the
 * holder. A lock whose pid is dead on this host, or older than 6 h, is stale and broken. Re-entrant within a process.
 * Released in a finally and on process exit (a crashed holder leaves a dead pid: stale on the next take).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BLENDER_LOCK = process.env.HITREG_BLENDER_LOCK ?? path.join(ROOT, ".hitreg", "blender.lock");
const STALE_MS = 6 * 3600e3;
let depth = 0;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}
/** The current holder, or null when free. */
export function blenderLockHolder(file = BLENDER_LOCK) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fs.existsSync(file) ? { pid: 0, host: "?", label: "unreadable", at: new Date(fs.statSync(file).mtimeMs).toISOString() } : null; }
}
function stale(h) {
  if (!h) return true;
  if (Date.now() - Date.parse(h.at ?? 0) > STALE_MS) return true;
  return h.host === os.hostname() && h.pid > 0 && !alive(h.pid);
}
const release = () => { if (depth > 0) { depth = 0; try { const h = blenderLockHolder(); if (h?.pid === process.pid) fs.rmSync(BLENDER_LOCK, { force: true }); } catch {} } };
process.on("exit", release);

/** Take the lock (blocking, re-entrant). Throws after `waitMin` minutes naming the holder. */
export function takeBlenderLock(label = path.basename(process.argv[1] ?? "blender"), waitMin = Number(process.env.HITREG_BLENDER_LOCK_WAIT_MIN ?? 60)) {
  if (depth > 0) { depth++; return; }
  fs.mkdirSync(path.dirname(BLENDER_LOCK), { recursive: true });
  const t0 = Date.now();
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(BLENDER_LOCK, JSON.stringify({ pid: process.pid, host: os.hostname(), label, at: new Date().toISOString() }), { flag: "wx" });
      depth = 1;
      return;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    const h = blenderLockHolder();
    if (stale(h)) { try { fs.rmSync(BLENDER_LOCK, { force: true }); } catch {} continue; }
    if (Date.now() - t0 > waitMin * 60e3) throw new Error(`blender-lock: waited ${waitMin} min; Blender is held by pid ${h.pid} (${h.label}) on ${h.host} since ${h.at} (${BLENDER_LOCK})`);
    if (!told) { console.error(`blender-lock: waiting for pid ${h.pid} (${h.label}) since ${h.at}`); told = true; }
    sleep(2000);
  }
}
export function releaseBlenderLock() {
  if (depth > 1) { depth--; return; }
  release();
}
/** Run a synchronous body under the lock. */
export function withBlenderLock(label, fn) {
  takeBlenderLock(label);
  try { return fn(); } finally { releaseBlenderLock(); }
}
/** spawnSync(exe, args, opts) under the lock. */
export function runBlender(exe, args, opts = {}, label) {
  return withBlenderLock(label ?? `${path.basename(process.argv[1] ?? "node")} ${args.find((a) => /\.py$/.test(a)) ? path.basename(args.find((a) => /\.py$/.test(a))) : ""}`.trim(), () => spawnSync(exe, args, opts));
}

// CLI: run / status
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === "status") {
    const h = blenderLockHolder();
    console.log(h ? `held by pid ${h.pid} (${h.label}) on ${h.host} since ${h.at}${stale(h) ? " — STALE (broken on the next take)" : ""}` : "free");
  } else if (argv[0] === "run") {
    const dd = argv.indexOf("--");
    if (dd < 0 || !argv[dd + 1]) { console.error("usage: node tools/blender-lock.mjs run [--label l] [--wait-min m] -- <blender.exe> <args...>"); process.exit(2); }
    const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && i < dd ? argv[i + 1] : undefined; };
    const exe = argv[dd + 1].replace(/^"|"$/g, "");
    takeBlenderLock(opt("label") ?? `run ${argv.slice(dd + 2).find((a) => /\.py$/.test(a)) ?? ""}`.trim(), Number(opt("wait-min") ?? process.env.HITREG_BLENDER_LOCK_WAIT_MIN ?? 60));
    const r = spawnSync(exe, argv.slice(dd + 2), { stdio: "inherit" });
    releaseBlenderLock();
    process.exit(r.status ?? 1);
  } else {
    console.error("usage: node tools/blender-lock.mjs status | run [--label l] [--wait-min m] -- <blender.exe> <args...>");
    process.exit(2);
  }
}
