import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssetLibrary, createScene, registerCoreAssetTypes, type CharacterSheet } from "@hitreg/core";
import { defaultEvents, defaultRegistry, defaultScripts, HeadlessWorld } from "../src/index.js";

/**
 * The server's scripts must see the loaded data assets (ctx.getDataAsset): the
 * character sheet's item catalog, its progression and creation rules live on
 * the authority, which is here. Without them every sheet on the server knew no
 * items and ignored every creation build.
 */
describe("HeadlessWorld data assets", () => {
  it("hands the asset library to scripts: a sheet grants and equips its starting items", async () => {
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    assets.addDataAsset({ id: "cap", type: "item", name: "cap", data: { name: "Cap", slots: ["helm"] } });
    const doc = createScene("t");
    doc.entities["hero"] = {
      name: "hero",
      parent: null,
      tags: [],
      components: {
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        script: { name: "character-sheet", params: { persist: false, startingItems: [{ itemId: "cap", equip: true }] } },
      },
    };
    const events = defaultEvents();
    const world = await HeadlessWorld.create({ doc, assets, registry: defaultRegistry(), events, scripts: defaultScripts(events, assets) });
    world.step();
    const sheet = world.netState.get("character/hero") as CharacterSheet;
    expect(Object.values(sheet.items).map((s) => s.itemId)).toEqual(["cap"]);
    expect(sheet.equipment.helm).toBeDefined();
    world.dispose();
  });
});

/** One-quad GLB (2x2 at y=0 in node space) with the node placed in world space. */
function quadGlb(translation: [number, number, number]): Uint8Array {
  const bin = new Uint8Array(48 + 12);
  new Float32Array(bin.buffer, 0, 12).set([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1]);
  new Uint16Array(bin.buffer, 48, 6).set([0, 2, 1, 1, 2, 3]);
  const json = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 12 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-1, 0, -1], max: [1, 0, 1] },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
    ],
  };
  const raw = new TextEncoder().encode(JSON.stringify(json));
  const text = new Uint8Array(Math.ceil(raw.length / 4) * 4).fill(0x20);
  text.set(raw);
  const out = new Uint8Array(20 + text.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  dv.setUint32(20 + text.length, bin.length, true);
  dv.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);
  return out;
}

/**
 * A trimesh collider on an asset mesh must exist on the AUTHORITY, cooked from
 * the model file. It used to fall back to a 1 m box at the entity origin, so a
 * baked rock formation (world-space vertices, identity transform) was missing
 * on the server while every client stood on it — the server's corrections then
 * dragged players down into the rock.
 */
describe("HeadlessWorld asset-mesh colliders", () => {
  it("cooks a trimesh from the model file, where the render mesh is", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-glb-"));
    const file = path.join(dir, "rock.glb");
    fs.writeFileSync(file, quadGlb([5360, 40, -3900]));
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    assets.addModel({ id: "rock.glb", name: "rock.glb", url: file });
    const doc = createScene("t");
    doc.entities["rock"] = {
      name: "rock",
      parent: null,
      tags: [],
      components: {
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { source: { kind: "asset", assetId: "rock.glb" }, static: true },
        collider: { shape: "trimesh", size: [1, 1, 1], offset: [0, 0, 0], friction: 0.5, restitution: 0, density: 1, isTrigger: false },
      },
    };
    const events = defaultEvents();
    const world = await HeadlessWorld.create({ doc, assets, registry: defaultRegistry(), events, scripts: defaultScripts(events, assets) });
    world.step();
    const hit = world.sim.raycast([5360.5, 100, -3899.5], [0, -1, 0], 200);
    expect(hit?.entityId).toBe("rock");
    expect(hit!.point[1]).toBeCloseTo(40, 4);
    expect(world.sim.raycast([0, 5, 0], [0, -1, 0], 10)).toBeNull(); // no fallback box at the origin
    world.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
