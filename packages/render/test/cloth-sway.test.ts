import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { markClothVertices, ClothSwaySystem, DEFAULT_CLOTH_SWAY } from "../src/cloth-sway.js";

/**
 * Build a mesh out of separate, non-touching boxes — the shape a character
 * actually arrives in: a body, and some panels hanging off a belt. Each box is
 * its own connected island, which is exactly what the selection keys on.
 */
function meshOf(boxes: Array<{ w: number; h: number; d: number; x?: number; y: number }>): THREE.Mesh {
  const merged: number[] = [];
  for (const b of boxes) {
    const geo = new THREE.BoxGeometry(b.w, b.h, b.d).toNonIndexed();
    geo.translate(b.x ?? 0, b.y, 0);
    const pos = geo.getAttribute("position");
    for (let i = 0; i < pos.count; i++) merged.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(merged, 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** A humanoid: torso+legs as one block, two thin panels hanging from the belt. */
function character(): THREE.Mesh {
  return meshOf([
    { w: 0.45, h: 1.8, d: 0.3, y: 0.9 }, // body, floor to head
    { w: 0.15, h: 0.6, d: 0.02, x: -0.2, y: 0.68 }, // panel, belt (0.98) to knee
    { w: 0.15, h: 0.6, d: 0.02, x: 0.2, y: 0.68 }, // the other panel
  ]);
}

const HEIGHT = 1.8;

describe("cloth panel selection", () => {
  it("finds the hanging panels and leaves the body alone", () => {
    const mesh = character();
    expect(markClothVertices(mesh, 0, HEIGHT, DEFAULT_CLOTH_SWAY)).toBe(true);

    const weights = mesh.geometry.getAttribute("clothWeight");
    const position = mesh.geometry.getAttribute("position");
    expect(weights).toBeDefined();

    let bodyMoved = 0;
    let panelMoved = 0;
    for (let i = 0; i < weights.count; i++) {
      const w = weights.getX(i);
      // the body block is the only geometry wider than 0.3 in z
      const isBody = Math.abs(position.getZ(i)) > 0.05;
      if (w > 0.01) (isBody ? (bodyMoved += 1) : (panelMoved += 1));
    }
    expect(bodyMoved).toBe(0); // a swaying torso is worse than no cloth at all
    expect(panelMoved).toBeGreaterThan(0);
  });

  it("pins each panel at its top and frees it at the hem", () => {
    const mesh = character();
    markClothVertices(mesh, 0, HEIGHT, DEFAULT_CLOTH_SWAY);
    const weights = mesh.geometry.getAttribute("clothWeight");
    const position = mesh.geometry.getAttribute("position");

    let topWeight = 1;
    let hemWeight = 0;
    for (let i = 0; i < weights.count; i++) {
      if (Math.abs(position.getZ(i)) > 0.05) continue; // body
      if (position.getY(i) > 0.97) topWeight = Math.min(topWeight, weights.getX(i));
      if (position.getY(i) < 0.39) hemWeight = Math.max(hemWeight, weights.getX(i));
    }
    expect(topWeight).toBeCloseTo(0, 2); // attached at the belt, so it cannot slide
    expect(hemWeight).toBeCloseTo(1, 2);
  });

  it("reports no cloth on a character that has none", () => {
    const bare = meshOf([{ w: 0.45, h: 1.8, d: 0.3, y: 0.9 }]);
    expect(markClothVertices(bare, 0, HEIGHT, DEFAULT_CLOTH_SWAY)).toBe(false);
    expect(bare.geometry.getAttribute("clothWeight")).toBeUndefined();
  });

  it("ignores a limb: thin and long, but it does not hang from the waist", () => {
    // a dangling arm is the shape most likely to be mistaken for a panel
    const mesh = meshOf([
      { w: 0.45, h: 1.8, d: 0.3, y: 0.9 },
      { w: 0.12, h: 0.6, d: 0.05, x: -0.3, y: 1.25 }, // attaches at the shoulder
    ]);
    expect(markClothVertices(mesh, 0, HEIGHT, DEFAULT_CLOTH_SWAY)).toBe(false);
  });

  it("ignores a belt: attached in the right place, but far too short to swing", () => {
    const mesh = meshOf([
      { w: 0.45, h: 1.8, d: 0.3, y: 0.9 },
      { w: 0.5, h: 0.08, d: 0.02, y: 0.98 },
    ]);
    expect(markClothVertices(mesh, 0, HEIGHT, DEFAULT_CLOTH_SWAY)).toBe(false);
  });

  it("widening the panel bounds is what rescues a panel the defaults miss", () => {
    // a stubby panel, below the default minimum length
    const boxes = [
      { w: 0.45, h: 1.8, d: 0.3, y: 0.9 },
      { w: 0.15, h: 0.2, d: 0.02, x: -0.2, y: 0.88 },
    ];
    expect(markClothVertices(meshOf(boxes), 0, HEIGHT, DEFAULT_CLOTH_SWAY)).toBe(false);
    expect(
      markClothVertices(meshOf(boxes), 0, HEIGHT, { ...DEFAULT_CLOTH_SWAY, panelMinLength: 0.05 }),
    ).toBe(true);
  });
});

describe("cloth spring", () => {
  /** A character-shaped mesh parented under a mover, so it can be walked around. */
  function rig() {
    const mover = new THREE.Group();
    mover.add(character());
    mover.updateMatrixWorld(true);
    return mover;
  }

  it("trails behind the direction of travel, and settles when the body stops", () => {
    const system = new ClothSwaySystem();
    const mover = rig();
    // flutter off: this is about the SPRING settling, and an idle shimmer that
    // never settles is the whole point of the flutter, so it would mask it
    const opts = { ...DEFAULT_CLOTH_SWAY, flutter: 0 };
    expect(system.register("hero", mover, opts)).toBe(1);

    const dt = 1 / 60;
    system.update(dt); // first tick only seeds the previous position

    // walk steadily along +x for half a second
    for (let i = 0; i < 30; i++) {
      mover.position.x += 4 * dt;
      mover.updateMatrixWorld(true);
      system.update(dt);
    }
    const moving = system.swayOf("hero")!.clone();
    // cloth streams BEHIND, so the offset opposes travel
    expect(moving.x).toBeLessThan(-0.02);
    expect(Math.abs(moving.y)).toBeLessThan(1e-6); // horizontal only

    // stop dead and let it hang
    for (let i = 0; i < 240; i++) {
      mover.updateMatrixWorld(true);
      system.update(dt);
    }
    expect(system.swayOf("hero")!.length()).toBeLessThan(0.01);
  });

  it("keeps a standing character's cloth alive with the idle flutter", () => {
    const system = new ClothSwaySystem();
    const mover = rig();
    system.register("hero", mover, { ...DEFAULT_CLOTH_SWAY, flutter: 0.02 });
    const dt = 1 / 60;
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      mover.updateMatrixWorld(true); // never moves
      system.update(dt);
      seen.push(system.swayOf("hero")!.length());
    }
    // it breathes rather than sitting at zero, and stays small
    expect(Math.max(...seen)).toBeGreaterThan(0.005);
    expect(Math.max(...seen)).toBeLessThan(0.05);
  });

  it("reports nothing to drive on a character with no cloth", () => {
    const system = new ClothSwaySystem();
    const bare = new THREE.Group();
    bare.add(meshOf([{ w: 0.45, h: 1.8, d: 0.3, y: 0.9 }]));
    bare.updateMatrixWorld(true);
    expect(system.register("bare", bare, DEFAULT_CLOTH_SWAY)).toBe(0);
    expect(system.size).toBe(0); // and costs nothing per frame thereafter
  });
});
