/**
 * ONE way for a tool to write a scene file or a world recipe: read-modify-write under a lock file next to it.
 *
 * Why (2026-10-21): widows-arch lost 551 world features when a rock-skins install and a place install both
 * read-modify-wrote the same world files at once — each wrote back the doc it had read before the other wrote.
 *
 * `updateJsonFile(file, edit)`:
 *  - takes `<file>.lock` (O_EXCL create; holds {pid, host, label, at}); waits up to `waitMs` (120 s) for another
 *    holder, and breaks a lock whose pid is dead on this host (stale), or one older than `staleMs` (30 min);
 *  - RE-READS the file under the lock and hands that fresh doc to `edit` (so an ops batch is applied to what is on disk
 *    now, never to a copy read minutes ago);
 *  - refuses the write when the counted items (scene entities / recipe features) drop by more than the edit declared:
 *    `edit` returns `{ doc, removed }` (ids it removes on purpose, e.g. the remove-entity ops of the batch), or the
 *    caller passes `allowRemovals: true` (the explicit `--allow-removals` of a tool);
 *  - writes atomically (tmp + rename, retried on Windows sharing errors).
 * Re-entrant within one process (a tool that holds the lock may call it again).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LockInfo { pid: number; host: string; label: string; at: string }
export interface WriteOptions {
  /** Who holds the lock (shown to waiters). */
  label?: string;
  /** How long to wait for another holder (ms). Default 120 000. */
  waitMs?: number;
  /** A lock older than this is stale even when its pid lives (ms). Default 30 min. */
  staleMs?: number;
  /** Removals are expected (an explicit --allow-removals): skip the count guard. */
  allowRemovals?: boolean;
  /** JSON indent of the written file. Default 2. */
  indent?: number;
  /** Text appended after the JSON. Default "\n". */
  trailer?: string;
  /** Count function for the guard. Default: countItems (scene entities or recipe features). */
  count?: (doc: any) => number;
}
export interface EditResult<T> { doc: T; /** ids removed on purpose; the count may drop by this many */ removed?: readonly string[] | number }

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(sleepBuf, 0, 0, ms);
const held = new Map<string, number>();

export const lockFileOf = (file: string) => path.resolve(file) + ".lock";

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Is a lock record stale (holder dead on this host, or older than staleMs)? */
export function lockIsStale(info: Partial<LockInfo> | null, now = Date.now(), staleMs = 30 * 60_000, alive: (pid: number) => boolean = pidAlive): boolean {
  if (!info || typeof info.pid !== "number") return true;
  const age = now - (Date.parse(info.at ?? "") || 0);
  if (age > staleMs) return true;
  if ((info.host ?? os.hostname()) === os.hostname() && !alive(info.pid)) return true;
  return false;
}

function readLock(lf: string): LockInfo | null {
  try { return JSON.parse(fs.readFileSync(lf, "utf8")); } catch { return null; }
}

/** Run `fn` while holding the lock of `file`. */
export function withFileLock<R>(file: string, fn: () => R, opts: WriteOptions = {}): R {
  const lf = lockFileOf(file), key = lf.toLowerCase();
  if (held.get(key)) { held.set(key, held.get(key)! + 1); try { return fn(); } finally { held.set(key, held.get(key)! - 1); } }
  const waitMs = opts.waitMs ?? 120_000, staleMs = opts.staleMs ?? 30 * 60_000, t0 = Date.now();
  const me: LockInfo = { pid: process.pid, host: os.hostname(), label: opts.label ?? path.basename(process.argv[1] ?? "tool"), at: new Date().toISOString() };
  let told = false;
  for (;;) {
    try {
      const fd = fs.openSync(lf, "wx");
      fs.writeSync(fd, JSON.stringify(me));
      fs.closeSync(fd);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
      const info = readLock(lf);
      // a lock file that is not readable yet may be mid-write by its creator: give it a moment before calling it stale
      if (lockIsStale(info, Date.now(), staleMs) && (info || Date.now() - (fs.statSync(lf, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 2000)) {
        try { fs.rmSync(lf, { force: true }); } catch { /* raced: retry */ }
        continue;
      }
      if (Date.now() - t0 > waitMs) throw new Error(`scene-write: ${path.basename(file)} is locked by ${info?.label ?? "?"} (pid ${info?.pid ?? "?"}, since ${info?.at ?? "?"}) for more than ${Math.round(waitMs / 1000)} s: ${lf}`);
      if (!told) { console.log(`scene-write: waiting for ${path.basename(file)} (held by ${info?.label ?? "?"} pid ${info?.pid ?? "?"})`); told = true; }
      sleep(50 + Math.random() * 100);
    }
  }
  held.set(key, 1);
  try { return fn(); } finally {
    held.delete(key);
    const info = readLock(lf);
    if (info?.pid === process.pid) fs.rmSync(lf, { force: true });
  }
}

/** The guard's count: entities of a scene doc, features (every kind) of a world recipe, else top-level keys. */
export function countItems(doc: any): number {
  if (doc && typeof doc.entities === "object" && doc.entities) return Object.keys(doc.entities).length;
  if (doc && typeof doc.features === "object" && doc.features) return Object.values(doc.features).reduce((n: number, v: any) => n + (Array.isArray(v) ? v.length : 0), 0);
  return doc && typeof doc === "object" ? Object.keys(doc).length : 0;
}

/** Write text atomically: tmp next to the file, then rename (retried: Windows refuses a rename onto a file a watcher holds). */
export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e: any) {
      if (i >= 40 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) { fs.rmSync(tmp, { force: true }); throw e; }
      sleep(25 + i * 10);
    }
  }
}

/** Read-modify-write a JSON file under its lock (see the file header). Returns what `edit` returned. */
export function updateJsonFile<T = any, X extends EditResult<T> = EditResult<T>>(file: string, edit: (fresh: T | null) => X, opts: WriteOptions = {}): X {
  return withFileLock(file, () => {
    const fresh: T | null = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const count = opts.count ?? countItems, before = fresh == null ? 0 : count(fresh); // before the edit: it may mutate `fresh`
    const out = edit(fresh);
    if (!out || out.doc == null) throw new Error(`scene-write: the edit of ${path.basename(file)} returned no doc (nothing written)`);
    if (fresh != null && !opts.allowRemovals) {
      const after = count(out.doc);
      const allowed = typeof out.removed === "number" ? out.removed : (out.removed?.length ?? 0);
      if (before - after > allowed) throw new Error(`scene-write: refusing to write ${path.basename(file)}: ${before} -> ${after} items (${before - after} lost, ${allowed} removal(s) declared). Another writer changed it, or the removals were not declared (--allow-removals)`);
    }
    writeAtomic(file, JSON.stringify(out.doc, null, opts.indent ?? 2) + (opts.trailer ?? "\n"));
    return out;
  }, opts);
}

// ---- whole-doc writers (a stage that read the file, computed for a while, and writes its whole doc back) -------------
const readDigests = new Map<string, string>();
const keyOf = (file: string) => path.resolve(file).toLowerCase();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Remember what this process read of `file` (its digest), so `writeJsonFile` can tell whether another tool wrote since. */
export function noteRead(file: string, text: string): void { readDigests.set(keyOf(file), digest(text)); }

/** Read + parse a JSON file and remember its digest (see `writeJsonFile`). */
export function readJsonTracked<T = any>(file: string): T {
  const text = fs.readFileSync(file, "utf8");
  noteRead(file, text);
  return JSON.parse(text);
}

/**
 * Write a whole doc under the file's lock. When this process read the file through `readJsonTracked`/`noteRead`, the
 * write is REFUSED if the file changed on disk since (another tool wrote meanwhile: re-run, never clobber). When it
 * did not, the item-count guard runs against the file on disk (a drop must be declared: `removed` or allowRemovals).
 */
export function writeJsonFile(file: string, doc: unknown, opts: WriteOptions & { removed?: readonly string[] | number } = {}): void {
  withFileLock(file, () => {
    const exists = fs.existsSync(file), text = exists ? fs.readFileSync(file, "utf8") : null;
    const seen = readDigests.get(keyOf(file));
    if (text != null && seen && digest(text) !== seen && !opts.allowRemovals) throw new Error(`scene-write: ${path.basename(file)} changed on disk since this tool read it (another tool wrote it meanwhile); nothing written — re-run`);
    if (text != null && !seen && !opts.allowRemovals) {
      const count = opts.count ?? countItems, before = count(JSON.parse(text)), after = count(doc);
      const allowed = typeof opts.removed === "number" ? opts.removed : (opts.removed?.length ?? 0);
      if (before - after > allowed) throw new Error(`scene-write: refusing to write ${path.basename(file)}: ${before} -> ${after} items (${before - after} lost, ${allowed} removal(s) declared)`);
    }
    const out = JSON.stringify(doc, null, opts.indent ?? 2) + (opts.trailer ?? "\n");
    writeAtomic(file, out);
    noteRead(file, out);
  }, opts);
}

/** Ids an ops batch removes on purpose (remove-entity ops; their subtrees count too when `doc` is given). */
export function removalsOf(ops: readonly any[], doc?: { entities: Record<string, any> } | null): string[] {
  const ids = new Set<string>();
  for (const o of ops) if (o && o.op === "remove-entity" && typeof o.id === "string") ids.add(o.id);
  if (doc?.entities) {
    let grew = true;
    while (grew) { grew = false; for (const [id, e] of Object.entries(doc.entities)) if (!ids.has(id) && e?.parent && ids.has(e.parent)) { ids.add(id); grew = true; } }
  }
  return [...ids];
}

/**
 * Several batches computed one after another on a copy (a tool that applies, measures, re-seats, skins): re-applied in
 * order onto the FRESH file under its lock. Returns the final doc and the combined inverse (last batch's undo first).
 */
export function applyBatchesToSceneFile<Op = any>(file: string, batches: readonly (readonly Op[])[], apply: (doc: any, ops: Op[]) => { doc: any; inverse: Op[] }, opts: WriteOptions = {}): { doc: any; inverse: Op[] } {
  let out!: { doc: any; inverse: Op[] };
  updateJsonFile(file, (fresh) => {
    if (!fresh) throw new Error(`scene-write: no scene at ${file}`);
    let doc = fresh, inverse: Op[] = [];
    for (const b of batches) { if (!b.length) continue; const r = apply(doc, [...b]); doc = r.doc; inverse = [...r.inverse, ...inverse]; }
    out = { doc, inverse };
    return { doc, removed: removalsOf(batches.flat() as any[], fresh) };
  }, opts);
  return out;
}

/** Apply an ops batch to a scene file under its lock: fresh read, `apply`, guard (removals = the batch's own), write. */
export function applyOpsToSceneFile<R extends { doc: any; inverse?: unknown }>(file: string, ops: readonly any[], apply: (doc: any, ops: any[]) => R, opts: WriteOptions = {}): R {
  let res!: R;
  updateJsonFile(file, (fresh) => {
    if (!fresh) throw new Error(`scene-write: no scene at ${file}`);
    res = apply(fresh, ops as any[]);
    if (!res?.doc) throw new Error(`scene-write: the ops no longer apply to ${path.basename(file)} as it is on disk`);
    return { doc: res.doc, removed: removalsOf(ops, fresh) };
  }, opts);
  return res;
}

/**
 * A scene BUILT in several steps (a dungeon's build-scene: write the doc, then portal-return, portal-veil, every dressing
 * plan through child tools) touches the live scene only when every step succeeded: the steps run on a staging copy,
 * `assets/scenes/staging/<id>.scene.json` (scene id `staging/<id>` for child tools that take `--scene <id>`; a nested
 * folder is never listed as a scene), seeded from the live file; on success the staging text replaces the live file
 * under its lock (atomic), on any failure (a throw or `false`) the staging copy is deleted and the live file is as it was.
 */
export function stagingSceneOf(liveFile: string): { file: string; id: string } {
  const base = path.basename(liveFile).replace(/\.scene\.json$/, "");
  return { file: path.join(path.dirname(liveFile), "staging", `${base}.scene.json`), id: `staging/${base}` };
}

export function stagedSceneBuild(liveFile: string, build: (staging: { file: string; id: string }) => boolean | void, opts: WriteOptions = {}): boolean {
  const staging = stagingSceneOf(liveFile);
  const cleanup = () => { fs.rmSync(staging.file, { force: true }); try { fs.rmdirSync(path.dirname(staging.file)); } catch { /* not empty / gone */ } };
  fs.mkdirSync(path.dirname(staging.file), { recursive: true });
  if (fs.existsSync(liveFile)) fs.copyFileSync(liveFile, staging.file); else fs.rmSync(staging.file, { force: true });
  let ok = false;
  try { ok = build(staging) !== false && fs.existsSync(staging.file); }
  finally { if (!ok) cleanup(); }
  if (!ok) return false;
  const text = fs.readFileSync(staging.file, "utf8");
  JSON.parse(text); // a half-written staging scene never reaches the live file
  withFileLock(liveFile, () => writeAtomic(liveFile, text), { label: "staged scene build", ...opts });
  cleanup();
  return true;
}
