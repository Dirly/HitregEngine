import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { simplifierReady, simplifyGeometry } from "../src/mesh-simplify.js";

beforeAll(() => simplifierReady());

function maxIndex(geometry: THREE.BufferGeometry): number {
  const array = geometry.index!.array;
  let max = 0;
  for (let i = 0; i < array.length; i++) max = Math.max(max, array[i]!);
  return max;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;
}

/** An unconnected "leaf soup": `count` separate quads, each its own 4
 * vertices, scattered through a unit cube — the topology real foliage has,
 * where every edge is a border the quadric simplifier refuses to collapse. */
function makeCardSoup(count: number, size: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 4 * 3);
  const indices = new Uint32Array(count * 6);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let q = 0; q < count; q++) {
    const cx = rand(), cy = rand(), cz = rand();
    const corners = [
      [cx - size, cy - size, cz],
      [cx + size, cy - size, cz],
      [cx + size, cy + size, cz],
      [cx - size, cy + size, cz],
    ];
    for (let k = 0; k < 4; k++) positions.set(corners[k]!, (q * 4 + k) * 3);
    indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

describe("simplifyGeometry", () => {
  it("decimates a dense sphere to roughly the target ratio, compacted, with every attribute carried over", () => {
    const sphere = new THREE.SphereGeometry(1, 96, 64); // ~12k tris, indexed, normal + uv
    const result = simplifyGeometry(sphere, { targetRatio: 0.35 });
    expect(result).not.toBeNull();
    const { geometry, ratio, error, method } = result!;

    expect(method).toBe("quadric");
    expect(triangleCount(geometry)).toBeLessThan(triangleCount(sphere) * 0.5);
    expect(ratio).toBeCloseTo(triangleCount(geometry) / triangleCount(sphere), 6);
    // a unit sphere at a third of the triangles deviates by millimetres, not decimetres
    expect(error).toBeGreaterThan(0);
    expect(error).toBeLessThan(0.1);

    for (const name of ["position", "normal", "uv"]) {
      expect(geometry.getAttribute(name)).toBeDefined();
      expect(geometry.getAttribute(name).count).toBe(geometry.getAttribute("position").count);
    }
    // compacted: fewer vertices than the source, and no index points past them
    expect(geometry.getAttribute("position").count).toBeLessThan(sphere.getAttribute("position").count);
    expect(maxIndex(geometry)).toBeLessThan(geometry.getAttribute("position").count);
    expect(geometry.boundingSphere!.radius).toBeCloseTo(1, 1);
  });

  it("leaves the source geometry untouched", () => {
    const sphere = new THREE.SphereGeometry(1, 48, 32);
    const indexBefore = Array.from(sphere.index!.array);
    const vertsBefore = sphere.getAttribute("position").count;
    simplifyGeometry(sphere);
    expect(Array.from(sphere.index!.array)).toEqual(indexBefore);
    expect(sphere.getAttribute("position").count).toBe(vertsBefore);
  });

  it("accepts interleaved attributes (what GLTFLoader hands us) and emits plain ones", () => {
    const src = new THREE.SphereGeometry(1, 48, 32);
    const count = src.getAttribute("position").count;
    const interleaved = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) {
        interleaved[i * 6 + c] = src.getAttribute("position").getComponent(i, c);
        interleaved[i * 6 + 3 + c] = src.getAttribute("normal").getComponent(i, c);
      }
    }
    const buffer = new THREE.InterleavedBuffer(interleaved, 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute("normal", new THREE.InterleavedBufferAttribute(buffer, 3, 3));
    geometry.setIndex(src.index);

    const result = simplifyGeometry(geometry);
    expect(result).not.toBeNull();
    expect((result!.geometry.getAttribute("position") as THREE.BufferAttribute).isBufferAttribute).toBe(true);
    expect((result!.geometry.getAttribute("normal") as THREE.BufferAttribute).isBufferAttribute).toBe(true);
    expect(triangleCount(result!.geometry)).toBeLessThan(triangleCount(src) * 0.5);
  });

  it("accepts non-indexed geometry and returns an indexed result", () => {
    const soup = new THREE.SphereGeometry(1, 48, 32).toNonIndexed();
    expect(soup.index).toBeNull();
    const result = simplifyGeometry(soup);
    expect(result).not.toBeNull();
    expect(result!.geometry.index).not.toBeNull();
    expect(triangleCount(result!.geometry)).toBeLessThan(triangleCount(soup) * 0.5);
  });

  it("falls back to the topology-agnostic pass for card soups the quadric can't collapse", () => {
    const soup = makeCardSoup(2000, 0.05);
    const result = simplifyGeometry(soup, { targetRatio: 0.35 });
    expect(result).not.toBeNull();
    expect(result!.method).toBe("sloppy");
    expect(result!.ratio).toBeLessThan(0.5);
    expect(maxIndex(result!.geometry)).toBeLessThan(result!.geometry.getAttribute("position").count);
  });

  it("returns null rather than a pointless second draw path for geometry it can't meaningfully reduce", () => {
    // 2 triangles: nothing to remove without deleting the mesh
    const plane = new THREE.PlaneGeometry(1, 1, 1, 1);
    expect(simplifyGeometry(plane)).toBeNull();
    // an empty geometry never throws
    expect(simplifyGeometry(new THREE.BufferGeometry())).toBeNull();
  });
});
