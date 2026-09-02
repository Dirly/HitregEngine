import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  DEFAULT_IMPOSTOR_GRID,
  hemiOctDecode,
  hemiOctEncode,
  impostorFrameDirection,
  impostorFrameDirections,
  impostorFrameUp,
  impostorGeometry,
  impostorInstanceData,
  impostorMaterial,
  selectImpostorFrames,
  writeImpostorSlot,
  type ImpostorAtlas,
} from "../src/impostor.js";

function randomUpperDir(seed: number): THREE.Vector3 {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  return new THREE.Vector3(rand() * 2 - 1, rand(), rand() * 2 - 1).normalize();
}

describe("hemi-octahedral mapping", () => {
  it("round-trips upper-hemisphere directions", () => {
    for (let k = 1; k <= 200; k++) {
      const dir = randomUpperDir(k * 7919);
      const uv = hemiOctEncode(dir);
      expect(uv.x).toBeGreaterThanOrEqual(0);
      expect(uv.x).toBeLessThanOrEqual(1);
      expect(uv.y).toBeGreaterThanOrEqual(0);
      expect(uv.y).toBeLessThanOrEqual(1);
      const back = hemiOctDecode(uv.x, uv.y);
      expect(back.distanceTo(dir)).toBeLessThan(1e-6);
    }
  });

  it("puts the pole at the centre and the horizon on the border", () => {
    expect(hemiOctEncode(new THREE.Vector3(0, 1, 0)).toArray()).toEqual([0.5, 0.5]);
    expect(hemiOctEncode(new THREE.Vector3(1, 0, 0)).toArray()).toEqual([1, 1]);
    expect(hemiOctEncode(new THREE.Vector3(0, 0, 1)).toArray()).toEqual([1, 0]);
    expect(hemiOctEncode(new THREE.Vector3(-1, 0, 0)).toArray()).toEqual([0, 0]);
    expect(hemiOctDecode(0.5, 0.5).toArray()).toEqual([0, 1, 0]);
  });

  it("clamps below-horizon directions to the horizon rather than wrapping", () => {
    const below = new THREE.Vector3(0.6, -0.5, 0.2).normalize();
    const uv = hemiOctEncode(below);
    const decoded = hemiOctDecode(uv.x, uv.y);
    expect(decoded.y).toBeCloseTo(0, 6);
    // same azimuth as the input
    const azIn = Math.atan2(below.z, below.x);
    const azOut = Math.atan2(decoded.z, decoded.x);
    expect(azOut).toBeCloseTo(azIn, 5);
  });
});

describe("frame layout", () => {
  it("bakes grid² unit directions in the upper hemisphere, pole in the middle, horizon on the edges", () => {
    const grid = DEFAULT_IMPOSTOR_GRID;
    const dirs = impostorFrameDirections(grid);
    expect(dirs).toHaveLength(grid * grid);
    for (const d of dirs) {
      expect(d.length()).toBeCloseTo(1, 6);
      expect(d.y).toBeGreaterThanOrEqual(0);
    }
    // border frames are exactly horizontal
    for (let i = 0; i < grid; i++) {
      expect(impostorFrameDirection(i, 0, grid).y).toBeCloseTo(0, 6);
      expect(impostorFrameDirection(i, grid - 1, grid).y).toBeCloseTo(0, 6);
      expect(impostorFrameDirection(0, i, grid).y).toBeCloseTo(0, 6);
      expect(impostorFrameDirection(grid - 1, i, grid).y).toBeCloseTo(0, 6);
    }
    // an odd grid has the exact pole as its centre frame
    expect(impostorFrameDirection(2, 2, 5).toArray()).toEqual([0, 1, 0]);
  });

  it("uses the pole substitute only when looking straight down", () => {
    expect(impostorFrameUp(new THREE.Vector3(0, 1, 0)).toArray()).toEqual([0, 0, -1]);
    expect(impostorFrameUp(new THREE.Vector3(0.3, 0.9, 0.1).normalize()).toArray()).toEqual([0, 1, 0]);
  });
});

describe("frame selection", () => {
  const grid = 6;

  it("weights sum to 1 and every selected frame is inside the grid", () => {
    for (let k = 1; k <= 200; k++) {
      const { frames, weights } = selectImpostorFrames(randomUpperDir(k * 104729), grid);
      expect(weights[0] + weights[1] + weights[2]).toBeCloseTo(1, 6);
      for (const w of weights) expect(w).toBeGreaterThanOrEqual(-1e-9);
      for (const [i, j] of frames) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(grid);
        expect(j).toBeGreaterThanOrEqual(0);
        expect(j).toBeLessThan(grid);
      }
    }
  });

  it("gives a baked frame direction full weight on exactly that frame", () => {
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const { frames, weights } = selectImpostorFrames(impostorFrameDirection(i, j, grid), grid);
        const k = weights.findIndex((w) => Math.abs(w - 1) < 1e-6);
        expect(k).toBeGreaterThanOrEqual(0);
        expect(frames[k]).toEqual([i, j]);
      }
    }
  });

  it("interpolates between neighbouring frames' directions", () => {
    const a = impostorFrameDirection(2, 3, grid);
    const b = impostorFrameDirection(3, 3, grid);
    const mid = a.clone().add(b).normalize();
    const { frames, weights } = selectImpostorFrames(mid, grid);
    const wa = weights[frames.findIndex(([i, j]) => i === 2 && j === 3)] ?? 0;
    const wb = weights[frames.findIndex(([i, j]) => i === 3 && j === 3)] ?? 0;
    expect(wa).toBeGreaterThan(0.3);
    expect(wb).toBeGreaterThan(0.3);
    expect(wa + wb).toBeGreaterThan(0.95);
  });
});

describe("per-batch data", () => {
  it("decomposes instance matrices into unit quaternions and the largest axis scale", () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(3, 0, -2), q, new THREE.Vector3(1.5, 2, 1));
    const data = impostorInstanceData([m, new THREE.Matrix4()]);
    expect(Array.from(data.rotations.subarray(0, 4)).map((v) => +v.toFixed(5))).toEqual(
      [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(5)),
    );
    expect(data.scales[0]).toBeCloseTo(2, 6);
    expect(Array.from(data.rotations.subarray(4, 8))).toEqual([0, 0, 0, 1]);
    expect(data.scales[1]).toBe(1);
  });

  it("builds a centre-anchored quad with explicit bounds and per-instance side buffers", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 4, 1));
    const geometry = impostorGeometry(bounds, 7);
    const position = geometry.getAttribute("position");
    for (let k = 0; k < 4; k++) {
      expect(position.getX(k)).toBe(0);
      expect(position.getY(k)).toBe(2);
      expect(position.getZ(k)).toBe(0);
    }
    expect(geometry.boundingSphere!.center.toArray()).toEqual([0, 2, 0]);
    expect(geometry.boundingSphere!.radius).toBeCloseTo(Math.sqrt(4 + 16 + 4) / 2, 6);
    expect(geometry.getAttribute("impostorRotation").count).toBe(7);
    expect(geometry.getAttribute("impostorScale").count).toBe(7);
  });

  it("writeImpostorSlot copies one logical instance into one far-tier slot", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 4, 1));
    const far = { geometry: impostorGeometry(bounds, 3) };
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(), q, new THREE.Vector3(3, 3, 3));
    const data = impostorInstanceData([new THREE.Matrix4(), m, new THREE.Matrix4()]);
    writeImpostorSlot(far, data, 0, 1); // logical instance 1 → slot 0
    const rotation = far.geometry.getAttribute("impostorRotation");
    const scale = far.geometry.getAttribute("impostorScale");
    expect(rotation.getW(0)).toBeCloseTo(q.w, 6);
    expect(rotation.getX(0)).toBeCloseTo(q.x, 6);
    expect(scale.getX(0)).toBe(3);
    // a batch without impostor data is a silent no-op
    expect(() => writeImpostorSlot(far, undefined, 1, 0)).not.toThrow();
  });

  it("impostorMaterial wires the quad, blend and normal into a lit, alpha-tested node material", () => {
    const atlas: ImpostorAtlas = {
      albedo: new THREE.DataTexture(new Uint8Array(4), 1, 1),
      normal: new THREE.DataTexture(new Uint8Array(4), 1, 1),
      grid: 6,
      flipFrames: true,
    };
    const material = impostorMaterial(atlas, new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 4, 1)));
    expect(material.positionNode).toBeTruthy();
    expect(material.colorNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
    expect(material.normalNode).toBeTruthy();
    expect(material.alphaTest).toBeGreaterThan(0);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
  });
});
