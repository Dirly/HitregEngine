import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssetLibrary, createScene } from "@hitreg/core";
import { HeadlessWorld } from "../src/index.js";
import { gltfClipNames, modelClipReader } from "../src/model-clips.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-clips-"));

function glb(name: string, json: unknown): string {
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([header, padded]));
  return file;
}

describe("model clips", () => {
  it("reads clip names from a .glb and a .gltf", () => {
    expect(gltfClipNames(glb("a.glb", { animations: [{ name: "Idle" }, { name: "Staff_Idle" }] }))).toEqual(["Idle", "Staff_Idle"]);
    const file = path.join(dir, "b.gltf");
    fs.writeFileSync(file, JSON.stringify({ animations: [{ name: "Walk" }] }));
    expect(gltfClipNames(file)).toEqual(["Walk"]);
    expect(gltfClipNames(glb("c.glb", {}))).toEqual([]);
  });

  it("reads each model once, and an unreadable one has no clips", () => {
    const file = glb("d.glb", { animations: [{ name: "Idle" }] });
    let asked = 0;
    const read = modelClipReader((id) => { asked++; return id === "ok" ? file : path.join(dir, "missing.glb"); });
    expect(read("ok")).toEqual(["Idle"]);
    expect(read("ok")).toEqual(["Idle"]);
    expect(asked).toBe(1);
    expect(read("gone")).toEqual([]);
  });
});

describe("a body's clip table on the server", () => {
  const scene = (file: string) => {
    const assets = new AssetLibrary();
    assets.addModel({ id: "m/body.glb", url: file } as never);
    const doc = createScene("clips");
    doc.entities["body"] = { name: "body", parent: null, tags: [], components: { transform: { position: [0, 0, 0] }, rigidbody: { kind: "dynamic" }, collider: { shape: "box", size: [1, 1, 1] } } } as never;
    doc.entities["visual"] = { name: "visual", parent: "body", tags: [], components: { transform: { position: [0, 0, 0] }, mesh: { source: { kind: "asset", assetId: "m/body.glb" } }, animator: { play: "Idle" } } } as never;
    return { assets, doc };
  };
  const clipsOf = (world: HeadlessWorld, id: string) => (world as unknown as { clipTables: Map<string, string[]> }).clipTables.get(id);

  it("reaches the body through its stripped model child, survives a silent respawn, and goes with a despawn", async () => {
    const { assets, doc } = scene(glb("e.glb", { animations: [{ name: "Staff_Idle" }] }));
    const world = await HeadlessWorld.create({ doc, assets });
    expect(world.entities.has("visual")).toBe(false);
    expect(clipsOf(world, "body")).toEqual(["Staff_Idle"]);
    const body = structuredClone(world.entities.get("body")!);
    world.removeEntities(["body"], { silent: true });
    world.addEntities({ ...world.base, entities: { body } }, { silent: true });
    expect(clipsOf(world, "body")).toEqual(["Staff_Idle"]);
    world.removeEntities(["body"]);
    expect(clipsOf(world, "body")).toBeUndefined();
    world.dispose?.();
  });
});
