import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { addCapQuad, crossQuadGeometry, flatQuadGeometry, GrassSystem, pickGrassTile, type GrassData } from "../src/index.js";

/**
 * Cover variety without draw calls: one layer draws many atlas tiles (a
 * meadow of five flowers is ONE instanced mesh), lies flat for lily pads, and
 * skips a whole placement when the host says its biome is nowhere near.
 */
const base: GrassData = {
  bladeColor: "#ffffff",
  tipColor: "#ffffff",
  bladeWidth: 0.6,
  bladeHeight: 0.6,
  texture: "cover/test.png",
  crossQuads: 2,
  alphaTest: 0.35,
  surfaces: [],
  minSurface: 0.5,
  slopeMax: 1,
  density: 1,
  radius: 20,
  windStrength: 0.05,
  windSpeed: 1,
  heightFadeStart: 100,
  heightFadeEnd: 200,
};

/** Place one layer around the origin; returns its mesh. */
function place(data: GrassData, system = new GrassSystem()): { mesh: THREE.InstancedMesh; system: GrassSystem } {
  const group = new THREE.Object3D();
  system.register("layer", group, data);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 40, 0);
  camera.updateMatrixWorld(true);
  system.update(camera, () => 0, () => 0);
  return { mesh: group.children[0] as THREE.InstancedMesh, system };
}

/** The per-instance (phase, tint, tile) attribute. */
function tilesOf(mesh: THREE.InstancedMesh): number[] {
  const attr = mesh.geometry.getAttribute("instanceRandom") as THREE.InstancedBufferAttribute;
  expect(attr.itemSize).toBe(4);
  return Array.from({ length: mesh.count }, (_, i) => attr.getZ(i));
}

describe("atlas tiles", () => {
  it("draws only the tiles a layer names, in roughly the weights it repeats them", () => {
    const { mesh, system } = place({ ...base, atlas: { columns: 4, rows: 8 }, tiles: [0, 0, 0, 5] });
    const tiles = tilesOf(mesh);
    expect(tiles.length).toBeGreaterThan(500);
    expect(new Set(tiles)).toEqual(new Set([0, 5]));
    const share = tiles.filter((t) => t === 0).length / tiles.length;
    expect(share).toBeGreaterThan(0.65);
    expect(share).toBeLessThan(0.85);
    system.clear();
  });

  it("uses every tile on the page when no list is given, and drops indices off the page", () => {
    const all = place({ ...base, atlas: { columns: 2, rows: 2 } });
    expect(new Set(tilesOf(all.mesh))).toEqual(new Set([0, 1, 2, 3]));
    all.system.clear();
    const clipped = place({ ...base, atlas: { columns: 2, rows: 2 }, tiles: [1, 9] });
    expect(new Set(tilesOf(clipped.mesh))).toEqual(new Set([1]));
    clipped.system.clear();
  });

  it("per instance, neighbours disagree; with tilePatch, they form drifts", () => {
    const tiles = [0, 1, 2, 3];
    /** fraction of lattice neighbours drawing the same tile */
    const agreement = (patch: number): number => {
      let same = 0;
      let total = 0;
      for (let gz = 0; gz < 60; gz++)
        for (let gx = 0; gx < 60; gx++) {
          const a = pickGrassTile(tiles, patch, gx, gz, gx, gz);
          const b = pickGrassTile(tiles, patch, gx + 1, gz, gx + 1, gz);
          if (a === b) same++;
          total++;
        }
      return same / total;
    };
    expect(agreement(0)).toBeLessThan(0.35); // ~1/4 by chance
    expect(agreement(0.05)).toBeGreaterThan(0.75); // a 20 m drift, 1 m apart
    // and a drift field still reaches every tile, first and last included
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) seen.add(pickGrassTile(tiles, 0.05, i, i * 7, i * 3.1, i * 5.7));
    expect(seen).toEqual(new Set(tiles));
  });
});

describe("flat cover", () => {
  it("is one horizontal card centred on the origin", () => {
    const g = flatQuadGeometry(1.2);
    const p = g.getAttribute("position");
    expect(p.count).toBe(4);
    for (let i = 0; i < p.count; i++) {
      expect(p.getY(i)).toBe(0);
      expect(Math.abs(p.getX(i))).toBeCloseTo(0.6, 6);
      expect(Math.abs(p.getZ(i))).toBeCloseTo(0.6, 6);
    }
    g.dispose();
  });

  it("a flat layer places flat geometry", () => {
    const { mesh, system } = place({ ...base, orient: "flat", bladeWidth: 1.1 });
    const p = mesh.geometry.getAttribute("position");
    expect(p.count).toBe(4);
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBe(0);
    system.clear();
  });
});

describe("scale range", () => {
  it("jitters instance size inside [min, max]", () => {
    const { mesh, system } = place({ ...base, scaleRange: [0.9, 1.1] });
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      lo = Math.min(lo, s.x);
      hi = Math.max(hi, s.x);
    }
    expect(lo).toBeGreaterThanOrEqual(0.9 - 1e-4);
    expect(hi).toBeLessThanOrEqual(1.1 + 1e-4);
    expect(hi - lo).toBeGreaterThan(0.15);
    system.clear();
  });
});

describe("region pre-test", () => {
  it("skips a whole placement without sampling a cell, and draws nothing", () => {
    const system = new GrassSystem();
    let asked = 0;
    const rects: number[][] = [];
    system.regionTest = (x0, z0, x1, z1) => {
      rects.push([x0, z0, x1, z1]);
      return false;
    };
    const group = new THREE.Object3D();
    system.register("layer", group, base);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 40, 0);
    camera.updateMatrixWorld(true);
    system.update(camera, () => 0, () => {
      asked++;
      return 0;
    });
    const mesh = group.children[0] as THREE.InstancedMesh;
    expect(asked).toBe(0);
    expect(mesh.count).toBe(0);
    // an empty layer costs no draw call
    expect(mesh.visible).toBe(false);
    // the rectangle covers the whole placement disc (radius padded)
    const [x0, z0, x1, z1] = rects[0]!;
    expect(x1! - x0!).toBeGreaterThanOrEqual(2 * base.radius);
    expect(z1! - z0!).toBeGreaterThanOrEqual(2 * base.radius);
    system.clear();
  });

  it("a passing region places normally and is visible", () => {
    const system = new GrassSystem();
    system.regionTest = () => true;
    const { mesh } = place(base, system);
    expect(mesh.count).toBeGreaterThan(500);
    expect(mesh.visible).toBe(true);
    system.clear();
  });
});

describe("flower caps", () => {
  it("adds one tilted quad at the cap height, flagged 1, body flagged 0", () => {
    const g = addCapQuad(crossQuadGeometry(0.6, 0.6, 2), 0.5, 0.4, 30);
    const p = g.getAttribute("position");
    const flag = g.getAttribute("coverCap");
    expect(p.count).toBe(12);
    const capY: number[] = [];
    for (let i = 0; i < p.count; i++) {
      expect(flag.getX(i)).toBe(i >= 8 ? 1 : 0);
      if (i >= 8) capY.push(p.getY(i));
    }
    // centred on 0.5, the far edge raised by (0.2 * sin 30deg) = 0.1
    expect(Math.min(...capY)).toBeCloseTo(0.4, 5);
    expect(Math.max(...capY)).toBeCloseTo(0.6, 5);
    g.dispose();
  });

  it("gives each instance the cap that belongs to its body tile, -1 where none", () => {
    const { mesh, system } = place({
      ...base,
      atlas: { columns: 4, rows: 8 },
      tiles: [0, 1, 2],
      cap: { tiles: [24, -1, 26], height: 0.8, size: 0.3, tilt: 35 },
    });
    const attr = mesh.geometry.getAttribute("instanceRandom") as THREE.InstancedBufferAttribute;
    const pairs = new Set<string>();
    for (let i = 0; i < mesh.count; i++) pairs.add(`${attr.getZ(i)}>${attr.getW(i)}`);
    expect(pairs).toEqual(new Set(["0>24", "1>-1", "2>26"]));
    expect(mesh.geometry.getAttribute("coverCap")).toBeDefined();
    system.clear();
  });

  it("has no cap geometry when the layer names no cap", () => {
    const { mesh, system } = place({ ...base, atlas: { columns: 4, rows: 8 }, tiles: [0, 1] });
    expect(mesh.geometry.getAttribute("coverCap")).toBeUndefined();
    const attr = mesh.geometry.getAttribute("instanceRandom") as THREE.InstancedBufferAttribute;
    for (let i = 0; i < mesh.count; i++) expect(attr.getW(i)).toBe(-1);
    system.clear();
  });
});
