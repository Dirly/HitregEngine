import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { materialSchema } from "@hitreg/core";

// Textures resolve only when the test says so — the real-world order, where a
// chunk builds (and the instanced cache copies the material) before the
// material asset's maps have loaded.
const deliveries: Array<() => void> = [];
vi.spyOn(THREE.TextureLoader.prototype, "loadAsync").mockImplementation(
  () => new Promise<THREE.Texture>((resolve) => {
    deliveries.push(() => resolve(new THREE.DataTexture(new Uint8Array([200, 100, 50, 255]), 1, 1)));
  }),
);

const { cachedInstancedMaterial, cachedMergedMaterial, materialForId } = await import("../src/scene-builder.js");
const { applyModelEmissive } = await import("../src/ubermesh.js");

function texturedSource(id: string): THREE.NodeMaterial {
  const data = materialSchema.parse({ color: "#ffffff", map: "masonry" });
  const options = { resolveMaterial: () => data, resolveTexture: () => "masonry.png" };
  return materialForId(id, options, new Map()) as THREE.NodeMaterial;
}

async function deliverAll(): Promise<void> {
  while (deliveries.length) deliveries.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("instanced copies of a material whose maps load late", () => {
  it("picks up the texture wired after the copy was taken, in place and still deduped", async () => {
    const source = texturedSource("late-maps/masonry");
    const copy = cachedInstancedMaterial("late-maps#masonry#0", source) as THREE.NodeMaterial;
    // taken while loading: the flat (white) graph
    expect(source.colorNode ?? null).toBeNull();
    expect(copy.colorNode ?? null).toBeNull();
    const positionBefore = copy.positionNode;
    expect(positionBefore).toBeTruthy(); // the instancing node
    const versionBefore = copy.version;

    await deliverAll();

    expect(source.colorNode).toBeTruthy();
    // the SAME object the batches already hold now samples the texture
    expect(copy.colorNode).toBe(source.colorNode);
    expect(copy.positionNode).toBeTruthy(); // instancing re-applied, not lost to the copy
    expect(copy.version).toBeGreaterThan(versionBefore);
    // the cache still hands every later chunk that one copy
    expect(cachedInstancedMaterial("late-maps#masonry#0", source)).toBe(copy);
  });

  it("does the same for merged (HLOD) copies", async () => {
    const source = texturedSource("late-maps/masonry-merged");
    const copy = cachedMergedMaterial("late-maps#merged#0", source) as THREE.NodeMaterial;
    expect(copy.colorNode ?? null).toBeNull();
    await deliverAll();
    expect(copy.colorNode).toBe(source.colorNode);
    expect(copy.colorNode).toBeTruthy();
  });

  it("copies an already-wired source without waiting", async () => {
    const source = texturedSource("late-maps/ready");
    await deliverAll();
    const copy = cachedInstancedMaterial("late-maps#ready#0", source) as THREE.NodeMaterial;
    expect(copy.colorNode).toBe(source.colorNode);
  });

  it("keeps a creature's late texture when its initial look clears glow", async () => {
    const source = texturedSource("late-maps/creature-clear");
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), source);
    applyModelEmissive(mesh, null);
    await deliverAll();
    expect((mesh.material as THREE.NodeMaterial).colorNode).toBe(source.colorNode);
    expect((mesh.material as THREE.NodeMaterial).colorNode).toBeTruthy();
  });

  it("applies the latest glow after maps arrive without changing the shared source", async () => {
    const source = texturedSource("late-maps/creature-glow") as THREE.MeshStandardNodeMaterial;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
    applyModelEmissive(mesh, { color: "#ff0000", intensity: 1 });
    applyModelEmissive(mesh, { color: "#00ff00", intensity: 2 });
    await deliverAll();
    const material = mesh.material as THREE.MeshStandardNodeMaterial;
    expect(material.colorNode).toBe(source.colorNode);
    expect(material.colorNode).toBeTruthy();
    expect(material.emissive.getHexString()).toBe("00ff00");
    expect(material.emissiveIntensity).toBe(2);
    expect(source.emissive.getHexString()).toBe("000000");
  });

  it("does not apply an old pending glow to a replacement material", async () => {
    const source = texturedSource("late-maps/creature-replaced");
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
    applyModelEmissive(mesh, { color: "#ff0000", intensity: 2 });
    const replacement = new THREE.MeshStandardNodeMaterial();
    mesh.material = replacement;
    await deliverAll();
    expect(mesh.material).toBe(replacement);
    expect(replacement.emissive.getHexString()).toBe("000000");
  });
});
