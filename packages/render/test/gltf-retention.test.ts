import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { GLTF, GLTFParser } from "three/addons/loaders/GLTFLoader.js";
import { nameEmbeddedTextures, retainModel, shareDecodedImages } from "../src/gltf-dedupe.js";
import { shareNamedTextures } from "../src/scene-builder.js";

function model(uri: string, repeat = 1): GLTF {
  const texture = new THREE.Texture();
  texture.repeat.set(repeat, repeat);
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: texture })));
  return { scene, scenes: [scene], animations: [], cameras: [], asset: { version: "2.0" }, userData: {},
    parser: { json: { textures: [{ source: 0 }], images: [{ uri }] },
      getDependency: async () => texture } } as unknown as GLTF;
}

describe("cached model lifetime", () => {
  it("decodes identical embedded images once, while creating independent texture state", async () => {
    let decodes = 0;
    const pixels = { width: 4096, height: 4096 } as ImageBitmap;
    const decoder = { isImageBitmapLoader: true, options: { imageOrientation: "flipY" },
      load: (_url: string, done: (bitmap: ImageBitmap) => void) => { decodes++; queueMicrotask(() => done(pixels)); } };
    const parser = () => ({
      json: { images: [{ uri: "data:image/png;base64,decode-once" }] },
      loadImageSource: async (_index: number, loader: typeof decoder) =>
        new THREE.Texture(await new Promise<ImageBitmap>((resolve) => loader.load("embedded", resolve))),
    } as unknown as GLTFParser);
    const a = parser(), b = parser();
    shareDecodedImages(a); shareDecodedImages(b);
    const [first, second] = await Promise.all([a.loadImageSource(0, decoder as never), b.loadImageSource(0, decoder as never)]);
    expect(decodes).toBe(1);
    expect(first).not.toBe(second);
    expect(first.image).toBe(second.image);
    first.repeat.set(3, 3);
    expect(second.repeat.x).toBe(1);
    const flipped = parser(); shareDecodedImages(flipped);
    await flipped.loadImageSource(0, { ...decoder, options: { imageOrientation: "none" } } as never);
    expect(decodes).toBe(2);
  });

  it("retains scene buffers and animation tracks without retaining parser input or dependency caches", () => {
    const loaded = model("data:image/png;base64,AAA");
    const clip = new THREE.AnimationClip("walk", 1, []);
    loaded.animations.push(clip);
    const cached = retainModel(loaded);
    expect(cached).not.toHaveProperty("parser");
    expect(cached.scene).toBe(loaded.scene);
    expect(cached.animations[0]).toBe(clip);
    expect(loaded.parser).toBeDefined(); // the load-time caller may still finish its work
  });

  it("shares identical embedded data-URI images while retaining different samplers and families", async () => {
    const a = model("data:image/png;base64,AAAA");
    const b = model("data:image/png;base64,AAAA");
    const tiled = model("data:image/png;base64,AAAA", 2);
    const other = model("data:image/png;base64,AAAA");
    await nameEmbeddedTextures(a, "retention-test");
    await nameEmbeddedTextures(b, "retention-test");
    await nameEmbeddedTextures(tiled, "retention-test");
    await nameEmbeddedTextures(other, "other-family");
    expect(shareNamedTextures(a.scene)).toBe(0);
    expect(shareNamedTextures(b.scene)).toBe(1);
    expect(shareNamedTextures(tiled.scene)).toBe(0);
    expect(shareNamedTextures(other.scene)).toBe(0);
    const map = (gltf: GLTF) => ((gltf.scene.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).map;
    expect(map(a)).toBe(map(b));
    expect(map(a)).not.toBe(map(tiled));
    expect(map(a)).not.toBe(map(other));
  });
});
