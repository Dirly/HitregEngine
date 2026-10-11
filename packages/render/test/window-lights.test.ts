import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SEED_STRIDE, findWindows, seedWindowGlass, windowCardGeometry } from "../src/window-lights.js";

/** A pane: a w x h quad facing +X (or -X) at x, centred on (y, z). */
function pane(x: number, y: number, z: number, w: number, h: number, facing: 1 | -1): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateY((facing * Math.PI) / 2);
  g.translate(x, y, z);
  return g;
}

describe("window light cards", () => {
  // a wall at x = 5 with two windows: one of two panes split by a mullion
  // (glass on both faces), and a single pane 3 m along
  const glass = mergeGeometries([
    pane(5, 2, 0, 0.4, 1, 1),
    pane(5, 2, 0.5, 0.4, 1, 1),
    pane(4.98, 2, 0, 0.4, 1, -1),
    pane(4.98, 2, 0.5, 0.4, 1, -1),
    pane(5, 2, 3.5, 0.6, 1, 1),
  ])!;

  it("groups panes a mullion apart into one window and faces it away from the building", () => {
    const windows = findWindows(glass, new THREE.Vector3(0, 2, 0));
    expect(windows).toHaveLength(2);
    for (const w of windows) {
      expect(w.normal.x).toBeCloseTo(1);
      expect(w.centre.x).toBeCloseTo(5);
    }
    const wide = windows.find((w) => w.centre.z < 1)!;
    expect(wide.width).toBeCloseTo(0.9);
    expect(wide.height).toBeCloseTo(1);
    expect(wide.vertices.length).toBeGreaterThanOrEqual(16);
  });

  it("writes each window's seed into its glass UVs and its cards", () => {
    const g = glass.clone();
    const windows = findWindows(g, new THREE.Vector3(0, 2, 0));
    const before = (g.getAttribute("uv") as THREE.BufferAttribute).clone();
    expect(seedWindowGlass(g, windows)).toBe(true);
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    for (const w of windows) {
      for (const v of w.vertices) {
        expect(Math.floor((uv.getX(v) + SEED_STRIDE / 2) / SEED_STRIDE)).toBe(w.seed);
        expect(uv.getX(v) - before.getX(v)).toBeCloseTo(w.seed * SEED_STRIDE);
      }
    }
    // a second pass would push UVs out of range: refused, nothing changed
    expect(seedWindowGlass(g, windows)).toBe(false);

    const cards = windowCardGeometry(windows)!;
    // four shaft faces + a halo per window, position/normal/uv only (static batching merges it)
    expect(Object.keys(cards.attributes).sort()).toEqual(["normal", "position", "uv"]);
    expect(cards.index!.count).toBe(windows.length * 5 * 6);
    const cuv = cards.getAttribute("uv");
    const seeds = new Set<number>();
    for (let i = 0; i < cuv.count; i++) seeds.add(Math.floor((cuv.getX(i) + SEED_STRIDE / 2) / SEED_STRIDE));
    expect([...seeds].sort()).toEqual([...new Set(windows.map((w) => w.seed))].sort());
    // shafts reach outward (+X) and fall
    cards.computeBoundingBox();
    expect(cards.boundingBox!.max.x).toBeGreaterThan(6.5);
    expect(cards.boundingBox!.min.y).toBeLessThan(1.5);
  });

  it("ignores roof lights and slivers", () => {
    const roof = new THREE.PlaneGeometry(1, 1);
    roof.rotateX(-Math.PI / 2);
    roof.translate(0, 6, 0);
    expect(findWindows(roof, new THREE.Vector3())).toHaveLength(0);
    expect(findWindows(pane(5, 2, 0, 0.05, 0.3, 1), new THREE.Vector3())).toHaveLength(0);
  });
});
