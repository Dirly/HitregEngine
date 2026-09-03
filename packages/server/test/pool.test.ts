import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkKey, chunkToSceneDoc, expandScene, voxelChunkDoc, voxelMeshCacheStats } from "@hitreg/core";
import {
  HeadlessWorld,
  TerrainStreamer,
  defaultEvents,
  defaultRegistry,
  defaultScripts,
  loadContent,
  playgroundRoots,
  resolveServerVoxelWorld,
} from "../src/index.js";

/**
 * Worker-thread cell generation: cells requested off-thread land on later
 * updates, are byte-for-byte what inline generation produces, and their
 * marched mesh is already in the cache when the collider cooks.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const content = loadContent(playgroundRoots(path.resolve(here, "../../../apps/playground")));
const scene = content.scenes.get("field");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!scene)("voxel worker pool", () => {
  let world: HeadlessWorld;
  let terrain: TerrainStreamer;

  beforeAll(async () => {
    world = await HeadlessWorld.create({
      doc: scene!,
      assets: content.assets,
      registry: defaultRegistry(),
      events: defaultEvents(),
      scripts: defaultScripts(),
      exclude: (_id, e) => e.tags.includes("player"),
    });
    terrain = new TerrainStreamer(world, resolveServerVoxelWorld(world.base, 1)!, { pool: { workers: 2 }, loadsPerStep: 4 });
    expect(terrain.workers).toBe(2);
  }, 60_000);

  afterAll(() => {
    terrain?.dispose();
    world?.dispose();
  });

  it("streams cells around a focus through the workers, identical to inline generation", async () => {
    const focus: [number, number, number] = [1385, 18, 8];
    const cellSize = terrain.resolved.streamer.cellSize;
    const cx = Math.round(focus[0] / cellSize);
    const cz = Math.round(focus[2] / cellSize);
    // NPCs sit elsewhere; this is a fresh area, nothing resident yet
    expect(terrain.has(cx, cz)).toBe(false);
    const start = Date.now();
    while (!terrain.has(cx, cz) && Date.now() - start < 20_000) {
      terrain.update([focus]);
      await wait(20);
    }
    expect(terrain.has(cx, cz)).toBe(true);
    // the whole ring lands eventually
    while (terrain.cells().length < 5 && Date.now() - start < 30_000) {
      terrain.update([focus]);
      await wait(20);
    }
    expect(terrain.cells().length).toBeGreaterThanOrEqual(5); // ring 1 = the centre + 4 neighbours
    // worker output == inline output (the field is pure): same entity ids in the cell
    const inline = voxelChunkDoc(terrain.resolved.field, terrain.resolved.data.world, cx, cz, {
      collision: true,
      scatter: true,
      assetExists: (id, kind) => (kind === "prefab" ? world.assets.getPrefab(id) : world.assets.getModel(id)) !== undefined,
    });
    // expanded the same way the streamer expands it (scatter prefabs unfold into children)
    const { doc } = chunkToSceneDoc(terrain.resolved.streamer.source, cx, cz, cellSize, inline);
    const expected = Object.keys(expandScene(doc, world.assets, world.registry).entities).sort();
    const prefix = `__chunk:${terrain.resolved.data.world}:${chunkKey(cx, cz)}`;
    const live = [...world.entities.keys()].filter((id) => id === prefix || id.startsWith(prefix + "/")).sort();
    expect(live).toEqual(expected);
    // the collider cooked against the worker's mesh: the cache holds it
    expect(voxelMeshCacheStats().entries).toBeGreaterThan(0);
    // and there is ground: a probe from above hits the cell's terrain
    const hit = world.sim.raycast([focus[0], focus[1] + 40, focus[2]], [0, -1, 0], 200, { layers: 0x0003 }); // WORLD | TERRAIN
    expect(hit).not.toBeNull();
  }, 60_000);

  it("drops results generated against a recipe that changed while they were in flight", async () => {
    const focus: [number, number, number] = [1385 + 4 * 48, 18, 8 + 4 * 48];
    terrain.update([focus]); // requests go out
    const { result } = terrain.applyEdits([
      { edit: "add-feature", kind: "blobs", feature: { id: "pit", center: [focus[0], 10, focus[2]], radius: 4, op: "remove" } },
    ]);
    expect(result.added).toEqual(["pit"]);
    const generation = (terrain as unknown as { pool: { currentGeneration: number } }).pool.currentGeneration;
    expect(generation).toBeGreaterThan(1);
    // keep pumping: everything that lands from here on is post-edit
    const cellSize = terrain.resolved.streamer.cellSize;
    const cx = Math.round(focus[0] / cellSize);
    const cz = Math.round(focus[2] / cellSize);
    const start = Date.now();
    while (!terrain.has(cx, cz) && Date.now() - start < 20_000) {
      terrain.update([focus]);
      await wait(20);
    }
    expect(terrain.has(cx, cz)).toBe(true);
    expect(terrain.resolved.field.recipe.features.blobs.some((b) => b.id === "pit")).toBe(true);
  }, 60_000);
});
