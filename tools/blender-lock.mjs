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
 * Waiting: up to HITREG_BLENDER_LOCK_WAIT_MIN minutes (default 60); then it throws, naming the holder. A lock whose
 * pid is dead on this host, or older than 6 h, is stale and broken. Re-entrant within a process. Released in a finally
 * and on process exit (a crashed holder leaves a dead pid: stale on the next take).
 *
 * FIFO queue (2026-10-31: polling waiters starved -- one waited 60+ min, another gave up at 90 while others took the
 * lock again and again): a waiter drops a ticket `<lock>.queue/<ms>-<host>-<pid>.json` {pid, host, label, at}
 * (O_EXCL, one file per waiter, so there is no shared read-modify-write) and only the oldest live ticket may take the
 * lock. A waiter touches its ticket every poll; a ticket whose pid is dead on this host, or untouched for 5 min, is
 * dropped by whoever sees it. Giving up (timeout) or exiting removes the ticket. A waiter without a ticket (older code
 * still running, the Python launcher) may still take a free lock; the head ticket simply waits for it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BLENDER_LOCK = process.env.HITREG_BLENDER_LOCK ?? path.join(ROOT, ".hitreg", "blender.lock");
export const BLENDER_LOCK_QUEUE = `${BLENDER_LOCK}.queue`;
const STALE_MS = 6 * 3600e3;
const TICKET_STALE_MS = 5 * 60e3;
let depth = 0;
let ticket = null; // this process's queue ticket while it waits

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
/** The queue, oldest first: [{ file, pid, host, label, at, touched, dead }]. Dead tickets are listed (marked), not removed. */
export function blenderLockQueue(queueDir = BLENDER_LOCK_QUEUE) {
  let names = [];
  try { names = fs.readdirSync(queueDir).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(queueDir, n);
    let t = null, touched = 0;
    try { touched = fs.statSync(file).mtimeMs; t = JSON.parse(fs.readFileSync(file, "utf8")); } catch { if (!touched) continue; } // vanished, or half-written
    t ??= { pid: Number(n.match(/-(\d+)\.json$/)?.[1] ?? 0), host: "?", label: "unreadable", at: new Date(touched).toISOString() };
    const dead = Date.now() - touched > TICKET_STALE_MS || (t.host === os.hostname() && t.pid > 0 && t.pid !== process.pid && !alive(t.pid));
    out.push({ file, ...t, touched, dead });
  }
  return out;
}
const dropTicket = () => { if (ticket) { try { fs.rmSync(ticket, { force: true }); } catch {} ticket = null; } };
process.on("exit", dropTicket);
const age = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`; };

const release = () => { if (depth > 0) { depth = 0; try { const h = blenderLockHolder(); if (h?.pid === process.pid) fs.rmSync(BLENDER_LOCK, { force: true }); } catch {} } };
process.on("exit", release);

/** Take the lock (blocking, re-entrant). Throws after `waitMin` minutes naming the holder. */
export function takeBlenderLock(label = path.basename(process.argv[1] ?? "blender"), waitMin = Number(process.env.HITREG_BLENDER_LOCK_WAIT_MIN ?? 60)) {
  if (depth > 0) { depth++; return; }
  fs.mkdirSync(BLENDER_LOCK_QUEUE, { recursive: true });
  const t0 = Date.now();
  const me = { pid: process.pid, host: os.hostname(), label, at: new Date(t0).toISOString() };
  ticket = path.join(BLENDER_LOCK_QUEUE, `${String(t0).padStart(15, "0")}-${me.host}-${me.pid}.json`);
  fs.writeFileSync(ticket, JSON.stringify(me), { flag: "wx" });
  let told = "";
  try {
    for (;;) {
      // keep our ticket fresh (re-create it in place if someone dropped it) and clear dead tickets
      try { fs.utimesSync(ticket, new Date(), new Date()); } catch { try { fs.writeFileSync(ticket, JSON.stringify(me)); } catch {} }
      const q = blenderLockQueue();
      for (const t of q) if (t.dead && t.file !== ticket) { try { fs.rmSync(t.file, { force: true }); } catch {} }
      const live = q.filter((t) => !t.dead || t.file === ticket);
      const pos = Math.max(1, live.findIndex((t) => t.file === ticket) + 1);
      if (pos === 1) {
        try {
          fs.writeFileSync(BLENDER_LOCK, JSON.stringify({ ...me, at: new Date().toISOString() }), { flag: "wx" });
          depth = 1;
          return;
        } catch (e) {
          if (e?.code !== "EEXIST") throw e;
        }
      }
      const h = blenderLockHolder();
      if (h && stale(h)) { try { fs.rmSync(BLENDER_LOCK, { force: true }); } catch {} continue; }
      const ahead = live.slice(0, pos - 1).map((t) => `pid ${t.pid} (${t.label})`).join(", ");
      if (Date.now() - t0 > waitMin * 60e3) throw new Error(`blender-lock: waited ${waitMin} min at queue position ${pos}/${live.length}; ${h ? `held by pid ${h.pid} (${h.label}) on ${h.host} since ${h.at}` : "free"}${ahead ? `; ahead: ${ahead}` : ""} (${BLENDER_LOCK})`);
      const msg = `queue position ${pos}/${live.length}${h ? `; held by pid ${h.pid} (${h.label}) since ${h.at}` : ""}`;
      if (msg !== told) { console.error(`blender-lock: ${label} waiting, ${msg}`); told = msg; }
      sleep(pos === 1 ? 500 : 2000); // the head polls faster, so a waiter running older (ticketless) code rarely beats it
    }
  } finally {
    dropTicket();
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
    console.log(h ? `held by pid ${h.pid} (${h.label}) on ${h.host} since ${h.at} (${age(Date.now() - Date.parse(h.at))})${stale(h) ? " — STALE (broken on the next take)" : ""}` : "free");
    const q = blenderLockQueue();
    if (!q.length) console.log("queue: empty");
    else {
      console.log(`queue (${q.length}, oldest first; only the head may take the lock):`);
      q.forEach((t, i) => console.log(`  ${i + 1}. pid ${t.pid} (${t.label}) on ${t.host}, waiting ${age(Date.now() - Date.parse(t.at))}${t.dead ? " — DEAD (dropped on the next poll)" : ""}`));
    }
  } else if (argv[0] === "run") {
    const dd = argv.indexOf("--");
    if (dd < 0 || !argv[dd + 1]) { console.error("usage: node tools/blender-lock.mjs run [--label l] [--wait-min m] -- <blender.exe> <args...>"); process.exit(2); }
    const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && i < dd ? argv[i + 1] : undefined; };
    const exe = argv[dd + 1].replace(/^"|"$/g, "");
    takeBlenderLock(opt("label") ?? `run ${argv.slice(dd + 2).find((a) => /\.py$/.test(a)) ?? ""}`.trim(), Number(opt("wait-min") ?? process.env.HITREG_BLENDER_LOCK_WAIT_MIN ?? 60));
    const r = spawnSync(exe, argv.slice(dd + 2), { stdio: "inherit" });
    releaseBlenderLock();
    // no shell: on Windows `npx` (a .cmd) never starts (ENOENT) -- name the reason instead of exiting silently
    if (r.error) console.error(`blender-lock run: could not start ${exe}: ${r.error.message}${process.platform === "win32" && !/\.(exe|com)$/i.test(exe) ? " (no shell here: run node/blender by path, e.g. node node_modules/tsx/dist/cli.mjs <script>)" : ""}`);
    process.exit(r.status ?? 1);
  } else {
    console.error("usage: node tools/blender-lock.mjs status | run [--label l] [--wait-min m] -- <blender.exe> <args...>");
    process.exit(2);
  }
}
