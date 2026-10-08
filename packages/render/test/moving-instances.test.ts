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

async function setup(partMask = 1) {
  const system = new MovingInstanceSystem({ resolveModel: () => "mem://sword.glb" });
  const scene = new THREE.Scene();
  scene.add(system.root);
  const holders = [0, 1, 2].map((i) => {
    const group = new THREE.Group();
    group.position.set(i * 2, 1, 0);
    scene.add(group);
    system.add("sword", { id: `e${i}`, group, partMask, castShadow: true, receiveShadow: true });
    return group;
  });
  await new Promise((r) => setTimeout(r, 0)); // the model "loads"
  system.update();
  const mesh = () => system.root.children[0] as Props;
  return { system, scene, holders, mesh };
}

describe("MovingInstanceSystem", () => {
  it("draws every moving instance of an asset as ONE batch that follows its entities", async () => {
    const { system, holders, mesh } = await setup(0);
    expect(system.root.children).toHaveLength(1);
    expect(mesh().instanceCount).toBe(0);
    // every instance shows nothing yet (partMask 0): the batch skips its draw altogether
    expect(system.stats()).toEqual({ batches: 1, instances: 3, draws: 0 });
    expect(mesh().visible).toBe(false);
    system.setLook("e0", { parts: ["Handle"] });
    system.update();
    expect(system.stats()).toEqual({ batches: 1, instances: 3, draws: 1 });
    expect(mesh().instanceCount).toBe(1);
    system.setLook("e1", { parts: ["Blade1"] });
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
    expect(mesh().instanceCount).toBe(2);
    holders[1]!.removeFromParent();
    system.update();
    expect(mesh().instanceCount).toBe(1);
    // Only e2 is visible; it carries its own look AND placement into packed slot 0.
    expect(uberOf(mesh(), 0)).toEqual([0, 0, 0.5, 0b10]);
    expect(new THREE.Vector3().setFromMatrixPosition(mesh().getMatrixAt(0, new THREE.Matrix4())).toArray()).toEqual([4, 1, 0]);
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

  it("gives each part its own tile per instance (groups), still ONE draw", async () => {
    const { system, mesh } = await setup();
    const before = mesh().material;
    system.setLook("e1", { groups: [{ parts: ["Handle"], texture: "weapons/iron.png" }, { parts: ["Blade1"], texture: "weapons/steel.png" }] });
    system.update();
    // the batch switched to its appearance material once, and is still one batch
    expect(system.root.children).toHaveLength(1);
    expect(mesh().material).not.toBe(before);
    expect(mesh().hasAppearance).toBe(true);
    expect(uberOf(mesh(), 1)[3]).toBe(0b11); // shown = the groups' union
    const buf = (mesh().geometry.getAttribute("instanceAppearance0") as THREE.InterleavedBufferAttribute).data.array;
    // part 0 → code 1 (iron), part 1 → code 2 (steel): 1 + 2*256 in the first float
    expect(buf[16]).toBe(1 + 2 * 256);
    // an instance with no groups keeps code 0 everywhere = its uber tile, as before
    expect(Array.from(buf.slice(0, 16))).toEqual(new Array(16).fill(0));
    system.setLook("e1", { groups: null });
    system.update();
    expect(buf[16]).toBe(0);
  });

  it("survives equipping and unequipping a worn piece over and over (character-look's messages)", async () => {
    const { system, mesh } = await setup();
    // exactly what character-look sends a helm: a fresh skinSheets [] every time
    const worn = () => ({ parts: ["Handle", "Blade1"], groups: [{ parts: ["Handle", "Blade1"], texture: "weapons/steel.png" }], skinTint: null, skinSheets: [] });
    const bare = () => ({ parts: [], groups: [], skinTint: null, skinSheets: [] });
    system.setLook("e0", worn());
    system.update();
    const first = mesh();
    for (let i = 0; i < 6; i++) {
      system.setLook("e0", bare());
      system.update();
      expect(mesh().instanceCount).toBe(2);
      system.setLook("e0", worn());
      system.update();
      expect(system.root.children).toHaveLength(1);
      expect(mesh().visible).toBe(true);
      expect(mesh().instanceCount).toBe(3);
      expect(uberOf(mesh(), 0)[3]).toBe(0b11);
    }
    // a look change re-encodes one slot; it never rebuilds the batch
    expect(mesh()).toBe(first);
  });

  it("does not rewrite or upload stationary holders, including looks and hang transforms", async () => {
    const { system, holders, mesh } = await setup();
    holders[0]!.userData["hangDelta"] = new THREE.Matrix4().makeTranslation(0, 0.25, 0);
    system.update();
    const batch = mesh();
    const matrix = vi.spyOn(batch, "setMatrixAt"), hang = vi.spyOn(batch, "setHangAt"), uber = vi.spyOn(batch, "setUberAt");
    const hangBuffer = (batch.geometry.getAttribute("instanceHangOffset") as THREE.InterleavedBufferAttribute).data;
    const matrixVersion = batch.instanceMatrix.version, hangVersion = hangBuffer.version;
    for (let i = 0; i < 12; i++) system.update();
    expect(matrix).not.toHaveBeenCalled(); expect(hang).not.toHaveBeenCalled(); expect(uber).not.toHaveBeenCalled();
    expect(batch.instanceMatrix.version).toBe(matrixVersion); expect(hangBuffer.version).toBe(hangVersion);
    // A hang can change without moving its socket (or mutating the matrix object identity).
    holders[0]!.userData["hangDelta"].makeTranslation(0, 0.5, 0);
    system.update(); expect(hang).toHaveBeenCalledTimes(1); expect(matrix).not.toHaveBeenCalled();
    expect(Array.from(hangBuffer.array.slice(4, 7))).toEqual([0, 0.5, 0]);
    delete holders[0]!.userData["hangDelta"];
    system.update(); expect(Array.from(hangBuffer.array.slice(0, 7))).toEqual([0, 0, 0, 1, 0, 0, 0]);
  });

  it("uploads only the moved holder and follows moving or scaled ancestors", async () => {
    const { system, scene, holders, mesh } = await setup();
    const parent = new THREE.Group(); scene.add(parent); parent.add(holders[1]!);
    const batch = mesh(), write = vi.spyOn(batch, "setMatrixAt");
    parent.position.set(10, 2, 3); parent.scale.set(2, 3, 4); parent.rotation.y = 0.5;
    system.update();
    expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0]![0]).toBe(1);
    const actual = batch.getMatrixAt(1, new THREE.Matrix4()).elements;
    actual.forEach((value, i) => expect(value).toBeCloseTo(holders[1]!.matrixWorld.elements[i]!, 5));
    // Sub-float32 movement must not cause unchanged subsequent frames to upload forever.
    holders[1]!.position.x += 1e-9; system.update(); write.mockClear(); system.update();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps hidden holders out of the buffer and restores current transforms and looks when revealed", async () => {
    const { system, scene, holders, mesh } = await setup();
    const parent = new THREE.Group(); scene.add(parent); parent.add(holders[0]!); parent.visible = false;
    system.setLook("e1", { parts: [] }); system.update();
    expect(mesh().instanceCount).toBe(1);
    const hiddenUpdate = vi.spyOn(holders[0]!, "updateWorldMatrix");
    holders[0]!.position.x = 80; system.setLook("e0", { parts: ["Blade1"], texture: "weapons/steel.png" });
    system.update(); expect(hiddenUpdate).not.toHaveBeenCalled();
    parent.visible = true; system.update();
    expect(mesh().instanceCount).toBe(2);
    expect(uberOf(mesh(), 0)).toEqual([0.5, 0, 0.5, 2]);
    expect(new THREE.Vector3().setFromMatrixPosition(mesh().getMatrixAt(0, new THREE.Matrix4())).x).toBe(80);
    expect(new THREE.Vector3().setFromMatrixPosition(mesh().getMatrixAt(1, new THREE.Matrix4())).x).toBe(4);
    system.setLook("e0", { parts: [] }); system.setLook("e2", { parts: [] }); system.update();
    expect(mesh().instanceCount).toBe(0); expect(mesh().visible).toBe(false);
    // Entity-level effect anchors still resolve even though the item has no GPU slot.
    expect(system.anchorOf("e0", { part: "Blade1", at: "center" })?.toArray()).toEqual([0.5, 0.5, 1]);
  });

  it("compacts every glow and hang attribute along with the holder's transform", async () => {
    const { system, holders, mesh } = await setup();
    system.setLook("e2", { parts: ["Blade1"], texture: "weapons/steel.png", glow: { color: "#ff0000", intensity: 2 } });
    holders[2]!.userData["hangDelta"] = new THREE.Matrix4().makeTranslation(0, 0.75, 0);
    system.update(); system.setLook("e0", { parts: [] }); system.setLook("e1", { parts: [] }); system.update();
    const batch = mesh();
    expect(batch.instanceCount).toBe(1); expect(uberOf(batch, 0)).toEqual([0.5, 0, 0.5, 2]);
    const glow = (batch.geometry.getAttribute("instanceGlow") as THREE.InterleavedBufferAttribute).data.array;
    const hang = (batch.geometry.getAttribute("instanceHangOffset") as THREE.InterleavedBufferAttribute).data.array;
    expect(Array.from(glow.slice(0, 3))).toEqual([2, 0, 0]);
    expect(Array.from(hang.slice(4, 7))).toEqual([0, 0.75, 0]);
    // Re-registering an entity forces a fresh placement even at the same packed index.
    holders[2]!.position.x = 42;
    system.add("sword", { id: "e2", group: holders[2]!, partMask: 1, castShadow: true, receiveShadow: true });
    system.update(); expect(new THREE.Vector3().setFromMatrixPosition(mesh().getMatrixAt(0, new THREE.Matrix4())).x).toBe(42);
  });

  it("preserves per-part appearance when compacting or rebuilding the buffer", async () => {
    const { system, scene, mesh } = await setup();
    system.setLook("e2", { groups: [{ parts: ["Blade1"], texture: "weapons/steel.png" }] });
    system.setLook("e0", { parts: [] }); system.setLook("e1", { parts: [] }); system.update();
    const appearance = () => (mesh().geometry.getAttribute("instanceAppearance0") as THREE.InterleavedBufferAttribute).data.array;
    expect(appearance()[0]).toBe(2 * 256); expect(mesh().instanceCount).toBe(1);
    const old = mesh();
    for (let i = 3; i < 12; i++) {
      const group = new THREE.Group(); group.position.x = i; scene.add(group);
      system.add("sword", { id: `e${i}`, group, partMask: 0, castShadow: true, receiveShadow: true });
    }
    system.update(); expect(mesh()).not.toBe(old);
    expect(mesh().instanceCount).toBe(1); expect(appearance()[0]).toBe(2 * 256);
    expect(new THREE.Vector3().setFromMatrixPosition(mesh().getMatrixAt(0, new THREE.Matrix4())).x).toBe(4);
    const version = mesh().instanceMatrix.version; system.update(); expect(mesh().instanceMatrix.version).toBe(version);
  });
});
