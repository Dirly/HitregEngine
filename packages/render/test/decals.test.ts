import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { flushDecals, reprojectDecalsAround, type DecalData } from "../src/decals.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { buildScene } from "../src/scene-builder.js";

vi.mock("../src/material-maps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/material-maps.js")>();
  return { ...actual,
  loadSharedTexture: async (_url: string, srgb: boolean, anisotropy: number, filter: import("../src/material-maps.js").TextureFilter) => {
    const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 128]), 1, 1);
    return actual.configureTexture(texture, srgb, anisotropy, filter);
  },
}; });

async function project(extra: Partial<DecalData> = {}) {
  const root = new THREE.Group();
  const stone = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.5), new THREE.MeshBasicMaterial());
  stone.userData["entityId"] = "stone";
  root.add(stone);
  const group = new THREE.Group();
  group.position.z = 0.25;
  root.add(group);
  const options = { resolveTexture: () => "test-rune.png" };
  flushDecals(root, [{ id: "rune", group, data: {
    texture: "rune", size: [1, 1], depth: 0.2, rotation: 0,
    direction: [0, 0, -1], opacity: 0.75, color: "#ffffff", fadeDepth: 0.04, ...extra,
  } }], options);
  await vi.waitFor(() => expect((group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>).material.map).not.toBeNull());
  const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  return { root, stone, group, mesh, options };
}

describe("projected decal emission", () => {
  it("keeps existing decals non-emissive and clipped to the receiver", async () => {
    const { mesh } = await project();
    expect(mesh.material.emissive.getHex()).toBe(0);
    expect(mesh.material.opacity).toBe(0.75);
    expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(mesh.geometry.getAttribute("decalFade")).toBeDefined();
  });

  it("uses the alpha-bearing color texture for emission and retains it on receiver reprojection", async () => {
    const { root, stone, group, mesh, options } = await project({ emissive: "#38b8ac", emissiveIntensity: 0.65 });
    const material = mesh.material;
    expect(material.emissive.getHex()).toBe(0x38b8ac);
    expect(material.emissiveIntensity).toBe(0.65);
    expect(material.emissiveMap).toBe(material.map);
    expect(material.emissiveMap?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.map?.wrapS).toBe(THREE.ClampToEdgeWrapping);
    stone.position.z += 0.03;
    reprojectDecalsAround(root, "stone", stone, options);
    const next = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
    expect(next.material).toBe(material);
    expect(next.geometry.getAttribute("decalFade")).toBeDefined();
    const pos = next.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) expect(pos.getZ(i)).toBeCloseTo(0.03, 5);
  });

  it("honors an explicit zero emission intensity", async () => {
    const { mesh } = await project({ emissive: "#38b8ac", emissiveIntensity: 0 });
    expect(mesh.material.emissiveIntensity).toBe(0);
  });

  it("separates sampling modes for decals sharing the same image", async () => {
    const smooth = (await project()).mesh.material.map!;
    const crisp = (await project({ filter: "nearest" })).mesh.material.map!;
    const pixel = (await project({ filter: "pixel" })).mesh.material.map!;
    expect(smooth.magFilter).toBe(THREE.LinearFilter);
    expect(crisp.magFilter).toBe(THREE.NearestFilter);
    expect(crisp.minFilter).toBe(THREE.NearestMipmapLinearFilter);
    expect(crisp.generateMipmaps).toBe(true);
    expect(crisp).not.toBe(smooth);
    expect(pixel.minFilter).toBe(THREE.NearestFilter);
    expect(pixel.generateMipmaps).toBe(false);
    expect(pixel).not.toBe(crisp);
  });

  it("projects onto a static glTF that arrives after the initial scene flush", async () => {
    let deliver!: (value: never) => void;
    const load = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    try {
      const built = buildScene({ version: 1, name: "cold decal", entities: {
        stone: { name: "stone", parent: null, tags: [], components: {
          mesh: { source: { kind: "asset", assetId: "late-stone" } },
        } },
        rune: { name: "rune", parent: null, tags: [], components: {
          transform: { position: [0, 0, 0.25], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          decal: { texture: "rune", size: [1, 1], depth: 0.2, rotation: 0,
            direction: [0, 0, -1], opacity: 0.75, color: "#ffffff", emissive: "#38b8ac" },
        } },
      } }, { resolveModel: () => "test:late-decal-stone", resolveTexture: () => "test-rune.png" });
      const group = built.objects.get("rune")!;
      expect(group.children.filter(c => c.userData["decal"])).toHaveLength(0);
      const model = new THREE.Group();
      model.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.5), new THREE.MeshBasicMaterial()));
      deliver({ scene: model, animations: [] } as never);
      await vi.waitFor(() => expect(group.children.filter(c => c.userData["decal"])).toHaveLength(1));
      const projected = group.children.find(c => c.userData["decal"]) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
      expect(projected.geometry.getAttribute("position").count).toBeGreaterThan(0);
      expect(projected.material.emissive.getHex()).toBe(0x38b8ac);
    } finally { load.mockRestore(); }
  });
});
