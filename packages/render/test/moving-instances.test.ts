import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";

// A two-part ubermesh with its part and tile tables, as unwrap-weapon + the page bake write it.
function ubermeshGltf() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  geometry.setAttribute("uv1", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0], 2));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.userData["parts"] = { Handle: 0, Blade1: 1 };
  mesh.userData["tiles"] = { "weapons/iron.png": [0, 0, 0.5], "weapons/steel.png": [0.5, 0, 0.5] };
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, animations: [] };
}

vi.mock("../src/scene-builder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scene-builder.js")>();
  return { ...actual, loadGltf: () => Promise.resolve(ubermeshGltf()) };
});

const { MovingInstanceSystem } = await import("../src/moving-instances.js");
type Props = import("../src/instancing.js").InstancedProps;

const uberOf = (mesh: Props, i: number): number[] =>
  Array.from((mesh.geometry.getAttribute("instanceUber") as THREE.BufferAttribute).array.slice(i * 4, i * 4 + 4));

async function setup() {
  const system = new MovingInstanceSystem({ resolveModel: () => "mem://sword.glb" });
  const scene = new THREE.Scene();
  scene.add(system.root);
  const holders = [0, 1, 2].map((i) => {
    const group = new THREE.Group();
    group.position.set(i * 2, 1, 0);
    scene.add(group);
    system.add("sword", { id: `e${i}`, group, partMask: 0, castShadow: true, receiveShadow: true });
    return group;
  });
  await new Promise((r) => setTimeout(r, 0)); // the model "loads"
  system.update();
  const mesh = () => system.root.children[0] as Props;
  return { system, scene, holders, mesh };
}

describe("MovingInstanceSystem", () => {
  it("draws every moving instance of an asset as ONE batch that follows its entities", async () => {
    const { system, holders, mesh } = await setup();
    expect(system.root.children).toHaveLength(1);
    expect(mesh().instanceCount).toBe(3);
    expect(system.stats()).toEqual({ batches: 1, instances: 3, draws: 1 });
    holders[1]!.position.set(5, 6, 7);
    system.update();
    const m = mesh().getMatrixAt(1, new THREE.Matrix4());
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([5, 6, 7]);
  });

  it("resolves part names and theme sheets against the model's own tables", async () => {
    const { system, mesh } = await setup();
    expect(system.setLook("e2", { parts: ["Handle", "Blade1"], texture: "weapons/steel.png" })).toBe(true);
    system.update();
    expect(uberOf(mesh(), 2)).toEqual([0.5, 0, 0.5, 0b11]);
    system.setLook("e2", { parts: ["Handle"] });
    system.update();
    expect(uberOf(mesh(), 2)).toEqual([0.5, 0, 0.5, 0b01]);
    expect(system.setLook("not-moving", { parts: [] })).toBe(false);
  });

  it("hides a hidden entity's parts and drops an entity that left the scene", async () => {
    const { system, holders, mesh } = await setup();
    system.setLook("e0", { parts: ["Handle"] });
    system.setLook("e2", { parts: ["Blade1"], texture: "weapons/iron.png" });
    holders[0]!.visible = false;
    system.update();
    expect(uberOf(mesh(), 0)[3]).toBe(0);
    holders[1]!.removeFromParent();
    system.update();
    expect(mesh().instanceCount).toBe(2);
    // e2 was swapped into e1's slot and carries its own look there
    expect(uberOf(mesh(), 1)).toEqual([0, 0, 0.5, 0b10]);
  });

  it("grows past its first capacity without losing looks", async () => {
    const { system, scene, mesh } = await setup();
    system.setLook("e0", { parts: ["Blade1"] });
    for (let i = 3; i < 20; i++) {
      const group = new THREE.Group();
      scene.add(group);
      system.add("sword", { id: `e${i}`, group, castShadow: true, receiveShadow: true });
    }
    system.update();
    expect(mesh().instanceCount).toBe(20);
    expect(mesh().capacity).toBeGreaterThanOrEqual(20);
    expect(uberOf(mesh(), 0)[3]).toBe(0b10);
  });

  it("glows only the named parts, per instance, in the same batch", async () => {
    const { system, mesh } = await setup();
    system.setLook("e1", { parts: ["Handle", "Blade1"], glow: { color: "#ff0000", intensity: 2, parts: ["Blade1"], pulse: { speed: 1, min: 0.5 } } });
    system.update();
    const buf = (mesh().geometry.getAttribute("instanceGlow") as THREE.InterleavedBufferAttribute).data.array;
    const glow = Array.from(buf.slice(16, 20));
    const pulse = Array.from(buf.slice(20, 24));
    expect(glow).toEqual([2, 0, 0, 0b10]);
    expect(pulse).toEqual([1, 0.5, 0, 128]); // speed, min, noise amount (none), noise scale
    // its neighbours stay unlit
    expect(Array.from(buf.slice(0, 4))).toEqual([0, 0, 0, 0]);
    system.setLook("e1", { glow: null });
    system.update();
    expect(Array.from(buf.slice(16, 20))).toEqual([0, 0, 0, 0]);
    expect(system.root.children).toHaveLength(1);
  });

  it("fades the glow along the glowing part's length (model +Y)", async () => {
    const { system, mesh } = await setup();
    // Blade1 runs y 0..1: from 0.5 to 1 = heights 0.5 → 1
    system.setLook("e0", { parts: ["Handle", "Blade1"], glow: { color: "#00ff00", intensity: 1, parts: ["Blade1"], fade: { from: 0.5, to: 1 } } });
    system.update();
    const buf = (mesh().geometry.getAttribute("instanceGlow") as THREE.InterleavedBufferAttribute).data.array;
    expect(Array.from(buf.slice(10, 12))).toEqual([0.5, 1]);
    expect(Array.from(buf.slice(12, 14))).toEqual([1, 12]); // churn, frameRate defaults
    // no fade = equal ends
    system.setLook("e1", { glow: { color: "#00ff00", intensity: 1 } });
    system.update();
    expect(Array.from(buf.slice(26, 28))).toEqual([0, 0]);
  });

  it("resolves an effect anchor to a point on a part", async () => {
    const { system } = await setup();
    // Blade1 is the triangle (0,0,1) (1,0,1) (0,1,1): its box runs x 0..1, y 0..1 at z 1
    expect(system.anchorOf("e0", { part: "Blade1", at: "center" })?.toArray()).toEqual([0.5, 0.5, 1]);
    expect(system.anchorOf("e0", { part: "Blade1", at: [0.5, 1, 0.5] })?.toArray()).toEqual([0.5, 1, 1]);
    expect(system.anchorOf("e0", { part: "Nope" })).toBeNull();
    expect(system.anchorOf("not-moving", { part: "Blade1" })).toBeNull();
  });
});
