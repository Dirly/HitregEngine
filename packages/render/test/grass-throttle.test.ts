import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { GrassSystem, type GrassData } from "../src/index.js";

/**
 * The cost side of ground cover: how OFTEN a field re-places itself, how much
 * of the terrain it re-asks about when it does, and how much of that lands in
 * one frame.
 *
 * This is the "standing still is fine, moving kills it" bug. A CPU profile of
 * a chunk-streamed voxel world put the terrain field's `fbm2` at 6.9% of
 * main-thread self time while moving — and, damningly, at 8.2% with the
 * camera merely ROTATING, no cells streaming at all. Ground cover was the
 * source: a third-person camera orbits its player, that orbit crossed the
 * recenter grid, and every crossing re-placed the whole field and re-evaluated
 * the procedural terrain under every tuft. Spikes of 80-130ms in a single
 * frame came out of it.
 *
 * The three properties below are the fix, and each one is a thing a future
 * refactor can silently take away.
 */

const DATA: GrassData = {
  bladeColor: "#ffffff",
  tipColor: "#ffffff",
  bladeWidth: 0.7,
  bladeHeight: 0.9,
  crossQuads: 2,
  alphaTest: 0.35,
  surfaces: [],
  minSurface: 0.5,
  slopeMax: 1,
  density: 1,
  radius: 24,
  windStrength: 0.05,
  windSpeed: 1,
  heightFadeStart: 100,
  heightFadeEnd: 200,
};

/** cell = radius * RECENTER_FRACTION, the grid the patch centre snaps to. */
const CELL = DATA.radius * 0.6;

interface Rig {
  system: GrassSystem;
  camera: THREE.PerspectiveCamera;
  mesh: () => THREE.InstancedMesh;
  /** ground samples taken since the last `reset()` */
  samples: () => number;
  reset: () => void;
  /** move the camera and run `frames` update ticks */
  pump: (x: number, z: number, frames?: number) => void;
  /** every instance's "x,z" -> "y", i.e. the field as it stands on screen */
  placements: () => Map<string, string>;
}

function rig(ground: (x: number, z: number) => number | null = () => 0): Rig {
  const group = new THREE.Object3D();
  const system = new GrassSystem();
  system.register("cover", group, DATA);
  const camera = new THREE.PerspectiveCamera();
  let count = 0;
  const sampleGrassy = (x: number, z: number): number | null => {
    count += 1;
    return ground(x, z);
  };
  const mesh = (): THREE.InstancedMesh => group.children[0] as THREE.InstancedMesh;
  const tick = (): void => {
    camera.updateMatrixWorld(true);
    system.update(camera, () => 0, sampleGrassy);
  };
  return {
    system,
    camera,
    mesh,
    samples: () => count,
    reset: () => {
      count = 0;
    },
    pump: (x, z, frames = 1) => {
      camera.position.set(x, 40, z);
      for (let i = 0; i < frames; i++) tick();
    },
    placements: () => {
      const out = new Map<string, string>();
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const instanced = mesh();
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, m);
        m.decompose(p, q, s);
        out.set(`${p.x.toFixed(4)},${p.z.toFixed(4)}`, p.y.toFixed(4));
      }
      return out;
    },
  };
}

describe("cover re-placement hysteresis", () => {
  it("re-samples nothing when the camera only turns", () => {
    const r = rig();
    r.pump(7.2, 3); // first placement, unbudgeted, runs to completion
    expect(r.samples()).toBeGreaterThan(500);
    r.reset();
    for (let i = 0; i < 60; i++) {
      r.camera.rotation.y = (i / 60) * Math.PI * 2;
      r.pump(7.2, 3);
    }
    expect(r.samples()).toBe(0);
  });

  it("holds its centre past the snap boundary, and moves once well over it", () => {
    const r = rig();
    r.pump(0, 0, 4);
    const before = r.placements();
    expect(before.size).toBeGreaterThan(200);

    // just past the half-cell boundary: plain snapping would have jumped here,
    // which is what a camera orbiting on the line did dozens of times a second
    r.pump(CELL * 0.53, 0, 10);
    expect([...r.placements().keys()].sort()).toEqual([...before.keys()].sort());

    // clear of the deadband, so the field must follow
    r.pump(CELL * 0.8, 0, 10);
    expect([...r.placements().keys()].sort()).not.toEqual([...before.keys()].sort());
  });
});

describe("cover ground-sample cache", () => {
  it("stops asking about ground it has already walked over", () => {
    const r = rig();
    // an orbit centred ON a grid boundary — the worst case, and the one a
    // third-person camera actually produces
    const orbit = (turn: number): void => {
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        r.pump(CELL * 0.5 + Math.cos(a) * 5, Math.sin(a) * 5);
      }
      expect(turn).toBeGreaterThanOrEqual(0);
    };
    r.pump(CELL * 0.5 + 5, 0, 1);
    const cold = r.samples();
    expect(cold).toBeGreaterThan(500);

    r.reset();
    orbit(1);
    r.pump(CELL * 0.5 + 5, 0, 40); // flush anything still in flight
    const first = r.samples();
    // the disc it recentres onto overlaps the old one heavily, so even the
    // first lap costs a fraction of a cold placement
    expect(first).toBeLessThan(cold * 0.6);

    r.reset();
    orbit(2);
    r.pump(CELL * 0.5 + 5, 0, 40);
    // and every lap after that is free: the terrain field is never asked again
    expect(r.samples()).toBe(0);
  });

  it("keeps heights right across the sign boundary, and past its own capacity", () => {
    // a height that varies with position: a cache that mixes up cells (the
    // int32 key packing is the risk, and negative cells are where it bites)
    // or serves an evicted neighbour's answer shows up as a wrong y
    const height = (x: number, z: number): number => x * 0.01 - z * 0.02;
    const r = rig(height);
    // walk a long way, in both signs, through many discs' worth of cells —
    // far more than the cache holds, so eviction is exercised
    for (let step = 0; step < 12; step++) r.pump(60 - step * 20, step * 20 - 60, 30);
    const placed = r.placements();
    expect(placed.size).toBeGreaterThan(200);
    for (const [key, y] of placed) {
      const [x, z] = key.split(",").map(Number) as [number, number];
      expect(Number(y), `blade at ${key}`).toBeCloseTo(height(x, z), 3);
    }
  });

  it("drops the cache when the ground itself changes", () => {
    let level = 5;
    const r = rig(() => level);
    r.pump(0, 0, 4);
    expect([...r.placements().values()][0]).toBe("5.0000");

    // a terrain edit the host knows about but the cache cannot see
    level = 9;
    r.pump(0, 0, 4);
    expect([...r.placements().values()][0], "cached, as it should be").toBe("5.0000");

    r.system.invalidateGround();
    r.pump(0, 0, 30);
    const after = [...r.placements().values()];
    expect(after.length).toBeGreaterThan(200);
    expect(new Set(after)).toEqual(new Set(["9.0000"]));
  });
});

describe("cover re-placement is amortised", () => {
  it("builds a new field over several frames without showing a partial one", () => {
    const r = rig((x, z) => x * 0.01 + z * 0.01);
    r.pump(0, 0, 4);
    const before = r.placements();
    const count = r.mesh().count;
    expect(count).toBeGreaterThan(200);

    // far enough that none of the new disc is cached — the expensive case
    r.pump(400, 400, 1);
    // one frame in, the field on screen is still the OLD one, whole: a
    // half-built disc must never be visible, and the count must never dip
    expect(r.mesh().count).toBe(count);
    expect([...r.placements().keys()].sort()).toEqual([...before.keys()].sort());
    // ...and it did do work, just not all of it
    expect(r.samples()).toBeGreaterThan(0);

    let frames = 1;
    while (frames < 200 && r.mesh().count === count && r.placements().has([...before.keys()][0]!)) {
      r.pump(400, 400, 1);
      expect(r.mesh().count, "never a partially filled field").toBeGreaterThan(0);
      frames += 1;
    }
    // it took several frames rather than one 80-130ms stall, and still finished
    expect(frames).toBeGreaterThan(1);
    expect(frames).toBeLessThan(200);
    const after = r.placements();
    expect(after.size).toBeGreaterThan(200);
    for (const key of after.keys()) expect(before.has(key)).toBe(false);
  });

  it("shares one frame budget across layers instead of one each", () => {
    const group = new THREE.Object3D();
    const system = new GrassSystem();
    const camera = new THREE.PerspectiveCamera();
    let count = 0;
    const sample = (): number => {
      count += 1;
      return 0;
    };
    system.register("a", group, DATA);
    system.register("b", group, DATA);
    const tick = (): void => {
      camera.updateMatrixWorld(true);
      system.update(camera, () => 0, sample);
    };
    camera.position.set(0, 40, 0);
    tick(); // both layers' FIRST placement: unbudgeted by design
    const cold = count;
    count = 0;
    camera.position.set(500, 40, 500);
    tick();
    // two layers moving at once cost what one does, not double — otherwise a
    // scene with grass and ferns spikes where a single layer was tuned not to
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(cold / 2);
    system.clear();
  });
});
