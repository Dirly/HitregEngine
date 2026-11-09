// tools/blender-lock.mjs FIFO queue (2026-10-31: polling waiters starved for 60-90 min while others took the lock again)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LOCK_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tools/blender-lock.mjs");
const until = async (ok: () => boolean, ms = 15000) => {
  const t0 = Date.now();
  while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); }
};
const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blender-lock-"));
  dirs.push(dir);
  const lock = path.join(dir, "render.lock"), queue = `${lock}.queue`, out = path.join(dir, "order.txt");
  return { dir, lock, queue, out, env: { ...process.env, HITREG_BLENDER_LOCK: lock } };
}
/** Hold the lock as this (live) test process. */
const hold = (lock: string, label = "test holder") => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), label, at: new Date().toISOString() }));
const tickets = (queue: string) => (fs.existsSync(queue) ? fs.readdirSync(queue).filter((n) => n.endsWith(".json")).sort() : []);
/** `run` a waiter whose locked command appends its label to `out`. */
function waiter(s: ReturnType<typeof setup>, label: string, waitMin = 1) {
  const code = `require("fs").appendFileSync(${JSON.stringify(s.out)}, ${JSON.stringify(label + "\n")})`;
  const p = spawn(process.execPath, [LOCK_JS, "run", "--label", label, "--wait-min", String(waitMin), "--", process.execPath, "-e", code], { env: s.env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  const done = new Promise<number>((r) => p.on("exit", (c) => r(c ?? 1)));
  return { p, done, err: () => err };
}
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid!;

test("waiters take the lock in arrival order (FIFO) and print their queue position", async () => {
  const s = setup();
  hold(s.lock);
  const ws = [];
  for (const l of ["a", "b", "c", "d"]) { ws.push(waiter(s, l)); const n = ws.length; await until(() => tickets(s.queue).length === n); }
  await until(() => ws[3]!.err().includes("queue position 4/4"));
  fs.rmSync(s.lock);
  assert.deepEqual(await Promise.all(ws.map((w) => w.done)), [0, 0, 0, 0]);
  assert.deepEqual(fs.readFileSync(s.out, "utf8").trim().split("\n"), ["a", "b", "c", "d"]);
  assert.deepEqual(tickets(s.queue), []);
  assert.ok(!fs.existsSync(s.lock));
});

test("a dead ticket (pid gone, or not refreshed for 5 min) is dropped and does not block the queue", async () => {
  const s = setup();
  fs.mkdirSync(s.queue, { recursive: true });
  const old = Date.now() - 60e3;
  fs.writeFileSync(path.join(s.queue, `${String(old).padStart(15, "0")}-${os.hostname()}-${deadPid()}.json`), JSON.stringify({ pid: deadPid(), host: os.hostname(), label: "crashed", at: new Date(old).toISOString() }));
  const far = path.join(s.queue, `${String(old + 1).padStart(15, "0")}-otherbox-4242.json`);
  fs.writeFileSync(far, JSON.stringify({ pid: 4242, host: "otherbox", label: "silent", at: new Date(old).toISOString() }));
  fs.utimesSync(far, new Date(old - 10 * 60e3), new Date(old - 10 * 60e3));
  const w = waiter(s, "live");
  assert.equal(await w.done, 0);
  assert.equal(fs.readFileSync(s.out, "utf8").trim(), "live");
  assert.deepEqual(tickets(s.queue), []);
});

test("a waiter that gives up removes its ticket", async () => {
  const s = setup();
  hold(s.lock);
  const w = waiter(s, "impatient", 0.02); // ~1.2 s
  await until(() => tickets(s.queue).length === 1);
  assert.notEqual(await w.done, 0);
  assert.match(w.err(), /waited 0\.02 min at queue position 1\/1; held by pid \d+ \(test holder\)/);
  assert.deepEqual(tickets(s.queue), []);
  assert.ok(fs.existsSync(s.lock), "the holder's lock is untouched");
});

test("a ticketless (older-code) taker is tolerated: the head ticket waits, then goes", async () => {
  const s = setup();
  hold(s.lock);
  const w = waiter(s, "queued");
  await until(() => tickets(s.queue).length === 1);
  fs.rmSync(s.lock); hold(s.lock, "old code"); // an old waiter grabs it in between
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(!fs.existsSync(s.out), "head ticket did not run while another holds the lock");
  fs.rmSync(s.lock);
  assert.equal(await w.done, 0);
  assert.equal(fs.readFileSync(s.out, "utf8").trim(), "queued");
});

test("status prints the holder and the queue in order with ages", () => {
  const s = setup();
  hold(s.lock);
  fs.mkdirSync(s.queue, { recursive: true });
  const put = (ago: number, pid: number, label: string) => { const t = Date.now() - ago; fs.writeFileSync(path.join(s.queue, `${String(t).padStart(15, "0")}-${os.hostname()}-${pid}.json`), JSON.stringify({ pid, host: os.hostname(), label, at: new Date(t).toISOString() })); };
  put(5 * 60e3 + 3e3, process.pid, "first"); // tickets touched just now, so only the dead pid marks one DEAD
  put(42e3, process.pid, "second");
  put(10e3, deadPid(), "ghost");
  const st = spawnSync(process.execPath, [LOCK_JS, "status"], { env: s.env, encoding: "utf8" }).stdout;
  assert.match(st, /^held by pid \d+ \(test holder\) on .+ since .+ \(\d+s\)\n/);
  assert.match(st, /queue \(3, oldest first[^\n]*\n {2}1\. pid \d+ \(first\) on .+, waiting 5m0[34]s\n {2}2\. pid \d+ \(second\) on .+, waiting 4[23]s\n {2}3\. pid \d+ \(ghost\) on .+, waiting 1[01]s — DEAD/);
  fs.rmSync(s.lock); fs.rmSync(s.queue, { recursive: true });
  assert.match(spawnSync(process.execPath, [LOCK_JS, "status"], { env: s.env, encoding: "utf8" }).stdout, /^free\nqueue: empty/);
});
