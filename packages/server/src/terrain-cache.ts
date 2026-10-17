/**
 * Terrain-collision cache — the world's cells cooked ONCE per content hash, on disk.
 *
 * A layer used to cook every cell it needed (field sample + scatter + march, ~40 ms MC, more for DC) on
 * demand, and every layer process cooked the same cells again. Here one process bakes every cell the sim
 * can stand in (inside `bounds.limit + limitFalloff`, what TerrainStreamer calls in-world) on the worker
 * pool, and writes it under `<playground>/.hitreg/terrain-cache/<world>/<hash>/`:
 *
 *   cells.bin    concatenated deflated cell records (see encodeCell)
 *   index.json   { "<cx>,<cz>": [offset, length] }
 *   meta.json    hash, world, cell count, bytes, bake ms, format — written last; its presence = complete
 *
 * A cell record is exactly what the worker pool hands TerrainStreamer: the cell DOC (scatter instances,
 * POI prefabs, the terrain entity — expanded on the reader's thread like a fresh one, so scatter-prop
 * primitive colliders come out of the same path as before) plus the terrain trimesh's positions and
 * indices (the only parts of the mesh the physics cook and placement read). Same bytes in → same
 * collision out as the cooked path.
 *
 * The KEY hashes everything that changes those bytes: the parsed recipe (features, patches, regions…),
 * the world id, the chunk options the server cooks with (mesher, collider LOD, scatter…), which scatter /
 * POI assets exist, a format constant, and the source of core's voxel code (a mesher change rebakes).
 *
 * Who bakes: whoever gets `<hash>.lock` first (main, normally — it bakes in the background at boot; the
 * layers it starts are told `--terrain-bake read`). Everyone else polls for meta.json and switches over
 * when it lands; until then they cook on demand as before. Readers hold only the index (a few hundred KB)
 * and read cells with positioned async reads, inflated on libuv's pool — never the whole world.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { promisify } from "node:util";
import {
  chunkKey,
  voxelChunkOptionsFrom,
  voxelWorldSchema,
  type ChunkDoc,
  type VoxelChunkOptions,
  type VoxelMesh,
  type VoxelMeshSource,
  type VoxelWorldData,
  type WorldRecipe,
} from "@hitreg/core";
import { VoxelPool } from "./voxel-pool.js";

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

/** Bump when the record layout or what a cell holds changes. */
export const TERRAIN_CACHE_FORMAT = 1;

/** `--terrain-bake`: auto = use / bake if nobody is / wait for whoever is; read = never bake here; force = rebake; off = no cache. */
export type TerrainBakeMode = "auto" | "read" | "force" | "off";

export function parseBakeMode(value: string | undefined, fallback: TerrainBakeMode = "auto"): TerrainBakeMode {
  return value === "auto" || value === "read" || value === "force" || value === "off" ? value : fallback;
}

export interface TerrainCacheInputs {
  /** World recipe asset id (the voxelWorld component's `world`). */
  world: string;
  /** The PARSED recipe (getVoxelRecipe / field.recipe). */
  recipe: WorldRecipe;
  /** The scene's voxelWorld component (parsed here, so raw and expanded docs hash alike). */
  data: VoxelWorldData;
  /** Does a prefab / model exist (scatter rules and POIs naming a missing one are skipped by the cook). */
  assetExists: (id: string, kind: "prefab" | "model") => boolean;
}

/** The chunk options the server cooks with — TerrainStreamer's, so cooked and cached cells agree. */
export function serverCellOptions(data: VoxelWorldData, assetExists: TerrainCacheInputs["assetExists"]): VoxelChunkOptions {
  return { ...voxelChunkOptionsFrom(data), collision: true, assetExists };
}

/** The scatter / POI assets that exist (what crosses to a worker instead of the `assetExists` closure). */
export function presentAssetsFor(recipe: WorldRecipe, assetExists: TerrainCacheInputs["assetExists"]): string[] {
  const present: string[] = [];
  for (const rule of recipe.scatter) {
    const id = rule.prefab ?? rule.model;
    if (id && assetExists(id, rule.prefab ? "prefab" : "model")) present.push(id);
  }
  for (const poi of recipe.features.pois) {
    if (poi.prefab && assetExists(poi.prefab, "prefab")) present.push(poi.prefab);
  }
  return present;
}

/** JSON with object keys sorted, so the hash never depends on key order. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableJson(v))).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

let codeFingerprint: string | null = null;
/**
 * A hash of core's voxel sources (field, meshers, scatter, chunk docs): a change to the code that cooks
 * cells rebakes, the same as a recipe change. "" when the sources are not beside this package (a bundle).
 */
export function voxelCodeFingerprint(): string {
  if (codeFingerprint !== null) return codeFingerprint;
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../core/src/voxel");
  try {
    const h = crypto.createHash("sha256");
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
      h.update(name);
      h.update(fs.readFileSync(path.join(dir, name)));
    }
    codeFingerprint = h.digest("hex").slice(0, 16);
  } catch {
    codeFingerprint = "";
  }
  return codeFingerprint;
}

/** The content hash a cache directory is named by (24 hex chars). */
export function terrainCacheKey(inputs: TerrainCacheInputs, code = voxelCodeFingerprint()): string {
  const data = voxelWorldSchema.parse(inputs.data);
  const { assetExists: _closure, ...options } = serverCellOptions(data, inputs.assetExists);
  const h = crypto.createHash("sha256");
  h.update(
    stableJson({
      format: TERRAIN_CACHE_FORMAT,
      code,
      world: inputs.world,
      options,
      present: presentAssetsFor(inputs.recipe, inputs.assetExists).sort(),
      recipe: inputs.recipe,
    }),
  );
  return h.digest("hex").slice(0, 24);
}

/** Cells past this radius (in cells, from the origin) are open sea floor nobody stands on — TerrainStreamer's rule. */
export function limitCellsOf(recipe: WorldRecipe): number {
  const limit = recipe.bounds?.limit ?? Infinity;
  return limit === Infinity ? Infinity : (limit + (recipe.bounds?.limitFalloff ?? 600)) / recipe.cellSize + 2;
}

/** Every in-world cell, nearest the origin first; null for an unbounded world (nothing finite to bake). */
export function bakeCells(recipe: WorldRecipe): Array<[number, number]> | null {
  const r = limitCellsOf(recipe);
  if (!Number.isFinite(r)) return null;
  const out: Array<[number, number]> = [];
  const n = Math.ceil(r);
  for (let cz = -n - 1; cz <= n; cz++) {
    for (let cx = -n - 1; cx <= n; cx++) if (Math.hypot(cx + 0.5, cz + 0.5) <= r) out.push([cx, cz]);
  }
  out.sort((a, b) => Math.hypot(a[0] + 0.5, a[1] + 0.5) - Math.hypot(b[0] + 0.5, b[1] + 0.5));
  return out;
}

// ---------------------------------------------------------------- records

export interface CachedCell {
  doc: ChunkDoc;
  /** The terrain entity's mesh source, or null (no terrain entity in the cell). */
  source: VoxelMeshSource | null;
  /** Collision-only mesh: positions + indices + bounds; normals / splat / tint are empty (nothing renders here). */
  mesh: VoxelMesh | null;
}

/** The terrain entity's mesh source in a cell doc (what the worker marches). */
export function cellSource(doc: ChunkDoc): VoxelMeshSource | null {
  const terrain = doc.entities["terrain"];
  return (terrain?.components["mesh"] as { source?: VoxelMeshSource } | undefined)?.source ?? null;
}

/**
 * [u32 docBytes][doc utf8][u8 hasMesh] then, with a mesh:
 * [u32 vertexCount][u32 triangleCount][u32 surfaceCount][u32 indexBytes(2|4)][f32×6 min,max][f32 positions][u16|u32 indices]
 */
export function encodeCell(doc: ChunkDoc, mesh: VoxelMesh | null): Buffer {
  const docBytes = Buffer.from(JSON.stringify(doc), "utf8");
  if (!mesh) {
    const out = Buffer.alloc(4 + docBytes.length + 1);
    out.writeUInt32LE(docBytes.length, 0);
    docBytes.copy(out, 4);
    out.writeUInt8(0, 4 + docBytes.length);
    return out;
  }
  const wide = mesh.vertexCount > 0xffff;
  const idxW = wide ? 4 : 2;
  const head = 4 + docBytes.length + 1;
  const fixed = 16 + 24;
  const out = Buffer.alloc(head + fixed + mesh.positions.byteLength + mesh.indices.length * idxW);
  out.writeUInt32LE(docBytes.length, 0);
  docBytes.copy(out, 4);
  out.writeUInt8(1, head - 1);
  let o = head;
  out.writeUInt32LE(mesh.vertexCount, o);
  out.writeUInt32LE(mesh.triangleCount, o + 4);
  out.writeUInt32LE(mesh.surfaceCount, o + 8);
  out.writeUInt32LE(idxW, o + 12);
  o += 16;
  for (const v of [...mesh.min, ...mesh.max]) {
    out.writeFloatLE(v, o);
    o += 4;
  }
  Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength).copy(out, o);
  o += mesh.positions.byteLength;
  const idx = wide ? mesh.indices : Uint16Array.from(mesh.indices);
  Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength).copy(out, o);
  return out;
}

export function decodeCell(buf: Buffer): CachedCell {
  const docLen = buf.readUInt32LE(0);
  const doc = JSON.parse(buf.toString("utf8", 4, 4 + docLen)) as ChunkDoc;
  const source = cellSource(doc);
  let o = 4 + docLen;
  if (buf.readUInt8(o) === 0) return { doc, source, mesh: null };
  o += 1;
  const vertexCount = buf.readUInt32LE(o);
  const triangleCount = buf.readUInt32LE(o + 4);
  const surfaceCount = buf.readUInt32LE(o + 8);
  const idxW = buf.readUInt32LE(o + 12);
  o += 16;
  const b: number[] = [];
  for (let i = 0; i < 6; i++, o += 4) b.push(buf.readFloatLE(o));
  // copied into fresh (aligned) buffers: a record sits at any byte offset
  const positions = new Float32Array(vertexCount * 3);
  new Uint8Array(positions.buffer).set(buf.subarray(o, o + positions.byteLength));
  o += positions.byteLength;
  const count = triangleCount * 3;
  let indices: Uint32Array;
  if (idxW === 4) {
    indices = new Uint32Array(count);
    new Uint8Array(indices.buffer).set(buf.subarray(o, o + count * 4));
  } else {
    const narrow = new Uint16Array(count);
    new Uint8Array(narrow.buffer).set(buf.subarray(o, o + count * 2));
    indices = Uint32Array.from(narrow);
  }
  const mesh: VoxelMesh = {
    positions,
    normals: new Float32Array(0),
    indices,
    splat: new Float32Array(0),
    surfaceCount,
    tint: new Float32Array(0),
    min: [b[0]!, b[1]!, b[2]!],
    max: [b[3]!, b[4]!, b[5]!],
    vertexCount,
    triangleCount,
  };
  return { doc, source, mesh };
}

// ---------------------------------------------------------------- reading

export interface TerrainCacheMeta {
  format: number;
  hash: string;
  world: string;
  cells: number;
  bytes: number;
  rawBytes: number;
  bakeMs: number;
  workers: number;
  bakedAt: string;
}

export class TerrainCacheReader {
  readonly meta: TerrainCacheMeta;
  readonly dir: string;
  private readonly index: Map<string, [number, number]>;
  private fd: number | null;
  /** Reads served (diagnostics). */
  reads = 0;

  private constructor(dir: string, meta: TerrainCacheMeta, index: Map<string, [number, number]>, fd: number) {
    this.dir = dir;
    this.meta = meta;
    this.index = index;
    this.fd = fd;
  }

  /** Open a COMPLETE cache directory (meta.json present), or null. */
  static open(dir: string): TerrainCacheReader | null {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as TerrainCacheMeta;
      if (meta.format !== TERRAIN_CACHE_FORMAT) return null;
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as Record<string, [number, number]>;
      const fd = fs.openSync(path.join(dir, "cells.bin"), "r");
      try {
        // touch: cleanup keeps the most recently USED caches
        const now = new Date();
        fs.utimesSync(path.join(dir, "meta.json"), now, now);
      } catch {
        // read-only cache dir: fine
      }
      return new TerrainCacheReader(dir, meta, new Map(Object.entries(raw)), fd);
    } catch {
      return null;
    }
  }

  get size(): number {
    return this.index.size;
  }

  has(cx: number, cz: number): boolean {
    return this.index.has(chunkKey(cx, cz));
  }

  /** The cell, read and inflated off this thread; null when it is not in the cache. */
  async read(cx: number, cz: number): Promise<CachedCell | null> {
    const at = this.index.get(chunkKey(cx, cz));
    if (!at || this.fd === null) return null;
    const buf = Buffer.allocUnsafe(at[1]);
    await new Promise<void>((resolve, reject) => {
      fs.read(this.fd!, buf, 0, at[1], at[0], (error, n) => (error ? reject(error) : n !== at[1] ? reject(new Error("short read")) : resolve()));
    });
    this.reads++;
    return decodeCell(await inflateRaw(buf));
  }

  /** The cell, synchronously (spawn-time ensures). */
  readSync(cx: number, cz: number): CachedCell | null {
    const at = this.index.get(chunkKey(cx, cz));
    if (!at || this.fd === null) return null;
    const buf = Buffer.allocUnsafe(at[1]);
    if (fs.readSync(this.fd, buf, 0, at[1], at[0]) !== at[1]) throw new Error("short read");
    this.reads++;
    return decodeCell(zlib.inflateRawSync(buf));
  }

  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

// ---------------------------------------------------------------- baking

export function worldCacheDir(root: string, world: string): string {
  return path.join(root, world.replace(/[^A-Za-z0-9._-]/g, "_"));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take `<hash>.lock` (atomic create); a lock whose holder is gone is taken over. */
function tryLock(file: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: { pid?: number; host?: string } | null = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; host?: string };
      } catch {
        holder = null; // half-written, or gone: treat as stale only if it is old
        try {
          if (Date.now() - fs.statSync(file).mtimeMs < 10_000) return false;
        } catch {
          continue;
        }
      }
      if (holder && holder.host === os.hostname() && typeof holder.pid === "number" && pidAlive(holder.pid)) return false;
      if (holder && holder.host !== os.hostname()) return false; // another machine's bake on a shared disk: wait for it
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

export interface BakeResult {
  dir: string;
  meta: TerrainCacheMeta;
}

export interface BakeOptions {
  root: string;
  inputs: TerrainCacheInputs;
  hash?: string;
  /** Worker threads (default min(8, cpus - 1)). Each holds its own copy of the field. */
  workers?: number;
  log?: (line: string) => void;
  /** Set to abort: the pool is disposed and the bake rejects. */
  signal?: { aborted: boolean; onAbort?: () => void };
}

/** Bake every in-world cell into `<root>/<world>/<hash>/`. The caller holds the lock. */
export async function bakeTerrainCache(opts: BakeOptions): Promise<BakeResult> {
  const { inputs } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const hash = opts.hash ?? terrainCacheKey(inputs);
  const cells = bakeCells(inputs.recipe);
  if (!cells) throw new Error(`world "${inputs.world}" has no bounds.limit — nothing finite to bake`);
  const worldDir = worldCacheDir(opts.root, inputs.world);
  const final = path.join(worldDir, hash);
  const partial = `${final}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  const workers = Math.max(1, opts.workers ?? Math.min(8, os.cpus().length - 1));
  const data = voxelWorldSchema.parse(inputs.data);
  const options = serverCellOptions(data, inputs.assetExists);
  const pool = new VoxelPool({ workers, idleSeconds: 5 });
  if (opts.signal) opts.signal.onAbort = () => pool.dispose();
  pool.init(inputs.recipe, inputs.world, options, presentAssetsFor(inputs.recipe, inputs.assetExists));
  const fd = fs.openSync(path.join(partial, "cells.bin"), "w");
  const index: Record<string, [number, number]> = {};
  let offset = 0;
  let rawBytes = 0;
  let done = 0;
  let nextReport = 0.1;
  const started = performance.now();
  log(`[terrain-cache] baking "${inputs.world}" ${hash}: ${cells.length} cells on ${workers} worker(s)`);
  try {
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < cells.length) {
        if (opts.signal?.aborted) throw new Error("bake aborted");
        const [cx, cz] = cells[next++]!;
        const cell = await pool.cell(cx, cz);
        const raw = encodeCell(cell.doc, cell.mesh);
        const packed = await deflateRaw(raw, { level: 1 });
        // offsets assigned at write time on this one thread: records land in completion order
        fs.writeSync(fd, packed, 0, packed.length, offset);
        index[chunkKey(cx, cz)] = [offset, packed.length];
        offset += packed.length;
        rawBytes += raw.length;
        done++;
        if (done / cells.length >= nextReport) {
          log(`[terrain-cache]   ${Math.round((done / cells.length) * 100)}% (${done}/${cells.length}, ${((performance.now() - started) / 1000).toFixed(0)} s)`);
          nextReport += 0.1;
        }
      }
    };
    // two cells in flight per thread keeps every thread busy while the last result is being written
    await Promise.all(Array.from({ length: workers * 2 }, lane));
  } finally {
    fs.closeSync(fd);
    pool.dispose();
  }
  const meta: TerrainCacheMeta = {
    format: TERRAIN_CACHE_FORMAT,
    hash,
    world: inputs.world,
    cells: cells.length,
    bytes: offset,
    rawBytes,
    bakeMs: Math.round(performance.now() - started),
    workers,
    bakedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(partial, "index.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(partial, "meta.json"), JSON.stringify(meta, null, 2));
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(partial, final);
  log(`[terrain-cache] baked "${inputs.world}" ${hash}: ${cells.length} cells, ${(offset / 1048576).toFixed(1)} MB (raw ${(rawBytes / 1048576).toFixed(1)} MB) in ${(meta.bakeMs / 1000).toFixed(1)} s`);
  return { dir: final, meta };
}

/**
 * Drop stale caches of a world: keep `keep` complete ones (most recently used first, `except` always),
 * remove partial bakes and lock files nobody alive holds.
 */
export function cleanupTerrainCache(root: string, world: string, except: string, keep = 2): string[] {
  const dir = worldCacheDir(root, world);
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  const lockHeld = (hash: string): boolean => {
    const file = path.join(dir, `${hash}.lock`);
    if (!fs.existsSync(file)) return false;
    try {
      const h = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; host?: string };
      return h.host !== os.hostname() || (typeof h.pid === "number" && pidAlive(h.pid));
    } catch {
      return true;
    }
  };
  const complete: Array<{ name: string; used: number }> = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    if (name.endsWith(".partial")) {
      if (!lockHeld(name.slice(0, -".partial".length))) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(name);
      }
      continue;
    }
    if (name.endsWith(".lock")) {
      if (!lockHeld(name.slice(0, -".lock".length))) fs.rmSync(full, { force: true });
      continue;
    }
    if (name === except) continue;
    try {
      complete.push({ name, used: fs.statSync(path.join(full, "meta.json")).mtimeMs });
    } catch {
      if (!lockHeld(name)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(name);
      }
    }
  }
  complete.sort((a, b) => b.used - a.used);
  for (const { name } of complete.slice(Math.max(0, keep - 1))) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export interface PrepareOptions {
  /** Cache root (default `<playground>/.hitreg/terrain-cache`). */
  root: string;
  inputs: TerrainCacheInputs;
  mode: TerrainBakeMode;
  workers?: number;
  /** How often a reader waiting on someone else's bake looks for it (default 5000 ms). */
  pollMs?: number;
  /** Complete caches kept per world (default 2: this one and the previous). */
  keep?: number;
  log?: (line: string) => void;
}

export interface PreparedCache {
  hash: string;
  dir: string;
  /** Open now (a warm boot), else null. */
  reader: TerrainCacheReader | null;
  /** Resolves with the reader once the cache is complete (this process's bake, or another's); null for off / failed. */
  ready: Promise<TerrainCacheReader | null>;
  /** True while THIS process bakes. */
  readonly baking: boolean;
  /** Stop polling / abort a bake in progress (releases the lock). */
  dispose(): void;
}

/** Use, bake or wait for a world's terrain cache — the boot path for main and for a layer. */
export function prepareTerrainCache(opts: PrepareOptions): PreparedCache {
  const log = opts.log ?? ((line: string) => console.log(line));
  const hash = terrainCacheKey(opts.inputs);
  const worldDir = worldCacheDir(opts.root, opts.inputs.world);
  const dir = path.join(worldDir, hash);
  const lockFile = path.join(worldDir, `${hash}.lock`);
  let disposed = false;
  let baking = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const signal: { aborted: boolean; onAbort?: () => void } = { aborted: false };
  const handle: PreparedCache = {
    hash,
    dir,
    reader: null,
    ready: Promise.resolve(null),
    get baking() {
      return baking;
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      if (baking) {
        signal.aborted = true;
        signal.onAbort?.();
      }
    },
  };
  if (opts.mode === "off") return handle;
  if (!bakeCells(opts.inputs.recipe)) {
    log(`[terrain-cache] "${opts.inputs.world}" is unbounded (no bounds.limit): no cache, cells cook on demand`);
    return handle;
  }
  if (opts.mode !== "force") {
    const reader = TerrainCacheReader.open(dir);
    if (reader) {
      log(`[terrain-cache] "${opts.inputs.world}" ${hash}: warm (${reader.size} cells, ${(reader.meta.bytes / 1048576).toFixed(1)} MB)`);
      handle.reader = reader;
      handle.ready = Promise.resolve(reader);
      return handle;
    }
  }
  fs.mkdirSync(worldDir, { recursive: true });
  const bake = async (): Promise<TerrainCacheReader | null> => {
    baking = true;
    try {
      await bakeTerrainCache({ root: opts.root, inputs: opts.inputs, hash, ...(opts.workers !== undefined ? { workers: opts.workers } : {}), log, signal });
      try {
        const removed = cleanupTerrainCache(opts.root, opts.inputs.world, hash, opts.keep ?? 2);
        if (removed.length) log(`[terrain-cache] removed stale: ${removed.join(", ")}`);
      } catch (error) {
        log(`[terrain-cache] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return disposed ? null : TerrainCacheReader.open(dir);
    } catch (error) {
      log(`[terrain-cache] bake failed: ${error instanceof Error ? error.message : String(error)} — cells cook on demand`);
      return null;
    } finally {
      baking = false;
      fs.rmSync(lockFile, { force: true });
    }
  };
  const wait = (): Promise<TerrainCacheReader | null> =>
    new Promise((resolve) => {
      timer = setInterval(() => {
        if (disposed) {
          clearInterval(timer!);
          return resolve(null);
        }
        const reader = TerrainCacheReader.open(dir);
        if (reader) {
          clearInterval(timer!);
          log(`[terrain-cache] "${opts.inputs.world}" ${hash}: ready (${reader.size} cells)`);
          return resolve(reader);
        }
        // the baker died: an auto process takes it over
        if (opts.mode !== "read" && tryLock(lockFile)) {
          clearInterval(timer!);
          void bake().then(resolve);
        }
      }, opts.pollMs ?? 5000);
      (timer as { unref?: () => void }).unref?.();
    });
  if (opts.mode !== "read" && tryLock(lockFile)) {
    if (opts.mode === "force") fs.rmSync(dir, { recursive: true, force: true });
    handle.ready = bake();
  } else {
    log(
      opts.mode === "read"
        ? `[terrain-cache] "${opts.inputs.world}" ${hash}: not baked yet — cooking on demand until it is`
        : `[terrain-cache] "${opts.inputs.world}" ${hash}: another process is baking — cooking on demand until it lands`,
    );
    handle.ready = wait();
  }
  return handle;
}
