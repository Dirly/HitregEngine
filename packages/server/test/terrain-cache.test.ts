import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AssetLibrary,
  buildVoxelMesh,
  defaultWorldRecipe,
  registerVoxelWorld,
  voxelChunkDoc,
  voxelWorldSchema,
  worldRecipeSchema,
  type SceneDoc,
  type WorldRecipe,
} from "@hitreg/core";
import { HeadlessWorld, TerrainStreamer, defaultEvents, defaultRegistry, defaultScripts, resolveServerVoxelWorld } from "../src/index.js";
import {
  TerrainCacheReader,
  bakeCells,
  cellSource,
  cleanupTerrainCache,
  decodeCell,
  encodeCell,
  prepareTerrainCache,
  serverCellOptions,
  terrainCacheKey,
  type TerrainCacheInputs,
} from "../src/terrain-cache.js";

/**
 * The baked terrain-collision cache: its key moves with everything that changes a cell and with nothing
 * else, and a cell read back from disk collides exactly like the cell cooked on the spot.
 */

const WORLD = "terrain-cache-test";
// a tiny island: bounds.limit 10 m + 30 m falloff at 48 m cells → a few dozen in-world cells
function recipe(overrides: Partial<WorldRecipe> = {}): WorldRecipe {
  const base = defaultWorldRecipe();
  return worldRecipeSchema.parse({
    ...base,
    cellSize: 48,
    resolution: 16,
    bounds: { continents: [{ center: [0, 0], radius: 30, falloff: 20 }], limit: 10, limitFalloff: 30 },
    scatter: [],
    ...overrides,
  });
}
const data = voxelWorldSchema.parse({ world: WORLD });
const none = (): boolean => false;
const inputs = (r: WorldRecipe, extra: Partial<TerrainCacheInputs> = {}): TerrainCacheInputs => ({ world: WORLD, recipe: r, data, assetExists: none, ...extra });

describe("terrain cache key", () => {
  it("is stable: same inputs (and key order) hash the same", () => {
    const a = recipe();
    const b = worldRecipeSchema.parse(JSON.parse(JSON.stringify(a)));
    // reversed key order at the top level must not matter
    const reversed = Object.fromEntries(Object.entries(b).reverse()) as WorldRecipe;
    expect(terrainCacheKey(inputs(a), "code")).toBe(terrainCacheKey(inputs(reversed), "code"));
    expect(terrainCacheKey(inputs(a), "code")).toMatch(/^[0-9a-f]{24}$/);
  });

  it("changes with the recipe, the mesher, the world id, present assets and the code", () => {
    const base = terrainCacheKey(inputs(recipe()), "code");
    expect(terrainCacheKey(inputs(recipe({ seed: 4242 })), "code")).not.toBe(base);
    expect(terrainCacheKey(inputs(recipe(), { data: voxelWorldSchema.parse({ world: WORLD, mesher: "dc" }) }), "code")).not.toBe(base);
    expect(terrainCacheKey(inputs(recipe(), { world: "other" }), "code")).not.toBe(base);
    expect(terrainCacheKey(inputs(recipe(), {}), "code2")).not.toBe(base);
    const withRule = recipe({ scatter: [{ id: "rock", model: "rock.glb", density: 0.01 }] as WorldRecipe["scatter"] });
    expect(terrainCacheKey(inputs(withRule), "code")).not.toBe(terrainCacheKey(inputs(withRule, { assetExists: () => true }), "code"));
  });
});

describe("terrain cache bake + read", () => {
  let root: string;
  let r: WorldRecipe;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-terrain-cache-"));
    r = recipe();
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("encodes and decodes a cell losslessly", () => {
    const field = registerVoxelWorld(WORLD, r);
    const doc = voxelChunkDoc(field, WORLD, 0, 0, serverCellOptions(data, none));
    const source = cellSource(doc)!;
    const mesh = buildVoxelMesh(field, source);
    const back = decodeCell(encodeCell(doc, mesh));
    expect(back.doc).toEqual(doc);
    expect(back.mesh!.positions).toEqual(mesh.positions);
    expect(back.mesh!.indices).toEqual(mesh.indices);
    expect(back.mesh!.triangleCount).toBe(mesh.triangleCount);
  });

  it("bakes once, a second prepare is warm, and cached cells equal cooked ones", async () => {
    const first = prepareTerrainCache({ root, inputs: inputs(r), mode: "auto", workers: 2, log: () => {} });
    expect(first.reader).toBeNull();
    expect(first.baking).toBe(true);
    // a second process meanwhile: the lock is held, so it waits instead of baking too
    const second = prepareTerrainCache({ root, inputs: inputs(r), mode: "auto", pollMs: 50, log: () => {} });
    expect(second.baking).toBe(false);
    const reader = await first.ready;
    expect(reader).not.toBeNull();
    const waited = await second.ready;
    expect(waited?.meta.hash).toBe(first.hash);
    waited?.close();
    expect(reader!.size).toBe(bakeCells(r)!.length);

    const warm = prepareTerrainCache({ root, inputs: inputs(r), mode: "auto", log: () => {} });
    expect(warm.reader).not.toBeNull();
    warm.reader!.close();

    const field = registerVoxelWorld(WORLD, r);
    for (const [cx, cz] of [[0, 0], [-1, 0], [1, -1], [-2, 1]] as const) {
      const cooked = voxelChunkDoc(field, WORLD, cx, cz, serverCellOptions(data, none));
      const source = cellSource(cooked);
      const mesh = source ? buildVoxelMesh(field, source) : null;
      const sync = reader!.readSync(cx, cz)!;
      const async = (await reader!.read(cx, cz))!;
      for (const hit of [sync, async]) {
        expect(hit.doc).toEqual(cooked);
        expect(hit.mesh?.triangleCount ?? 0).toBe(mesh?.triangleCount ?? 0);
        if (mesh && hit.mesh) {
          expect(Array.from(hit.mesh.positions)).toEqual(Array.from(mesh.positions));
          expect(Array.from(hit.mesh.indices)).toEqual(Array.from(mesh.indices));
        }
      }
    }
    reader!.close();
  }, 120_000);

  it("collides the same through a streamer reading the cache as through one cooking", async () => {
    const doc: SceneDoc = {
      version: 1,
      name: "terrain-cache-test",
      entities: { world: { name: "world", parent: null, tags: [], components: { voxelWorld: { world: WORLD } } } },
    };
    registerVoxelWorld(WORLD, r);
    const make = async (): Promise<{ world: HeadlessWorld; terrain: TerrainStreamer }> => {
      const world = await HeadlessWorld.create({ doc, assets: new AssetLibrary(), registry: defaultRegistry(), events: defaultEvents(), scripts: defaultScripts() });
      const terrain = new TerrainStreamer(world, resolveServerVoxelWorld(world.base, 1)!, { pool: false });
      return { world, terrain };
    };
    const cooked = await make();
    const cached = await make();
    const prepared = prepareTerrainCache({ root, inputs: cached.terrain.cacheInputs(), mode: "read", log: () => {} });
    expect(prepared.reader).not.toBeNull(); // baked by the test above
    expect(cached.terrain.useCache(prepared.reader!)).toBe(true);
    cooked.terrain.ensureAround(10, 10, 1);
    cached.terrain.ensureAround(10, 10, 1);
    expect(cached.terrain.counters.cacheHits).toBeGreaterThan(0);
    expect(cooked.terrain.counters.cacheHits).toBe(0);
    expect(cached.terrain.cells().sort()).toEqual(cooked.terrain.cells().sort());
    for (const [x, z] of [[0, 0], [12, -20], [-30, 25], [40, 40]] as const) {
      const a = cooked.world.sim.raycast([x, 400, z], [0, -1, 0], 1000);
      const b = cached.world.sim.raycast([x, 400, z], [0, -1, 0], 1000);
      expect(b?.distance ?? null).toBe(a?.distance ?? null);
      if (x === 0) expect(a).not.toBeNull(); // there is ground on the island
    }
    for (const t of [cooked, cached]) {
      t.terrain.dispose();
      t.world.dispose();
    }
  }, 120_000);

  it("cleanup keeps the current cache and the most recent other one", () => {
    const worldDir = path.join(root, WORLD);
    for (const name of ["aaa", "bbb", "ccc"]) {
      fs.mkdirSync(path.join(worldDir, name), { recursive: true });
      fs.writeFileSync(path.join(worldDir, name, "meta.json"), "{}");
    }
    fs.mkdirSync(path.join(worldDir, "ddd.partial"), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(worldDir, "aaa", "meta.json"), old, old);
    const keep = fs.readdirSync(worldDir).find((n) => /^[0-9a-f]{24}$/.test(n))!;
    const removed = cleanupTerrainCache(root, WORLD, keep, 2);
    expect(removed).toContain("ddd.partial");
    expect(removed).toContain("aaa");
    const left = fs.readdirSync(worldDir).sort();
    expect(left).toContain(keep);
    expect(left.filter((n) => ["aaa", "bbb", "ccc"].includes(n)).length).toBe(1);
  });
});
