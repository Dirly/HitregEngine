import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";

const loading = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../src/scene-builder.js", async (original) => ({
  ...await original<typeof import("../src/scene-builder.js")>(),
  loadGltf: loading.load,
}));
const { MovingInstanceSystem } = await import("../src/moving-instances.js");
const { cachedInstancedMaterial, cachedMergedMaterial, invalidateModelRenderCaches } = await import("../src/scene-builder.js");

function model(reimported = false) {
  const geometry = new THREE.BufferGeometry();
  const count = reimported ? 3 : 2;
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(Array.from({ length: count }, (_, i) => [0, 0, i, 1, 0, i, 0, 1, i]).flat(), 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Array(count * 6).fill(0), 2));
  geometry.setAttribute("uv1", new THREE.Float32BufferAttribute(Array.from({ length: count }, (_, i) => [i, 0, i, 0, i, 0]).flat(), 2));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.userData.parts = { Hood: 0, Crown: 1, ...(reimported ? { NativeMask: 2 } : {}) };
  mesh.userData.tiles = { bronze: [0, 0, 0.5], ...(reimported ? { mask: [0.5, 0.5, 0.25] } : {}) };
  const scene = new THREE.Group(); scene.add(mesh);
  return { scene, animations: [] };
}

describe("model reimports", () => {
  it("reloads the changed moving model's parts and atlas without disturbing other batches", async () => {
    let revision = 0;
    loading.load.mockImplementation((url: string) => Promise.resolve(model(url.includes("rev=1"))));
    const system = new MovingInstanceSystem({ resolveModel: (id) => `mem://${id}?rev=${revision}` });
    const scene = new THREE.Scene(); scene.add(system.root);
    const helm = new THREE.Group(), sword = new THREE.Group(); scene.add(helm, sword);
    const entry = (id: string, group: THREE.Group) => ({ id, group, castShadow: true, receiveShadow: true });
    system.add("reimport-helm", entry("helm", helm));
    system.add("reimport-sword", entry("sword", sword));
    await new Promise((resolve) => setTimeout(resolve, 0));
    system.setLook("helm", { parts: ["Hood"], texture: "bronze" }); system.update();
    const oldHelm = system.root.children.find((o) => o.name.startsWith("moving:reimport-helm")) as THREE.Mesh;
    const oldSword = system.root.children.find((o) => o.name.startsWith("moving:reimport-sword"));
    const oldMaterial = oldHelm.material;
    const disposed = vi.fn(); (oldMaterial as THREE.Material).addEventListener("dispose", disposed);
    revision = 1;
    invalidateModelRenderCaches(["reimport-helm"]);
    system.invalidateModels(["reimport-helm"]);
    expect(system.has("helm")).toBe(false);
    expect(system.has("sword")).toBe(true);
    expect(oldHelm.parent).toBeNull();
    expect(disposed).not.toHaveBeenCalled();
    system.add("reimport-helm", entry("helm", helm));
    system.setLook("helm", { parts: ["NativeMask"], texture: "mask" });
    await new Promise((resolve) => setTimeout(resolve, 0)); system.update();
    const fresh = system.root.children.find((o) => o.name.startsWith("moving:reimport-helm")) as THREE.Mesh;
    const data = fresh.geometry.getAttribute("instanceUber") as THREE.BufferAttribute;
    expect(Array.from(data.array.slice(0, 4))).toEqual([0.5, 0.5, 0.25, 4]);
    expect(fresh.material).not.toBe(oldMaterial);
    expect(system.root.children).toContain(oldSword);
  });

  it("invalidates exact model cache prefixes while keeping resources held by other consumers alive", () => {
    const old = new THREE.MeshStandardMaterial({ color: "red" });
    const fresh = new THREE.MeshStandardMaterial({ color: "blue" });
    const oldCopy = cachedInstancedMaterial("helm#moving#0", old) as THREE.Material;
    const oldMerged = cachedMergedMaterial("helm#merged#0", old) as THREE.Material;
    const neighbor = cachedInstancedMaterial("helmet#moving#0", old);
    const disposed = vi.fn(); oldCopy.addEventListener("dispose", disposed); oldMerged.addEventListener("dispose", disposed);
    invalidateModelRenderCaches(["helm"]);
    expect(cachedInstancedMaterial("helm#moving#0", fresh)).not.toBe(oldCopy);
    expect(cachedMergedMaterial("helm#merged#0", fresh)).not.toBe(oldMerged);
    expect(cachedInstancedMaterial("helmet#moving#0", fresh)).toBe(neighbor);
    expect(disposed).not.toHaveBeenCalled();
  });
});
