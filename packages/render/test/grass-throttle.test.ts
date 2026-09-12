import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import Attributes from "three/src/renderers/common/Attributes.js";
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

/** LEAD_MAX_FRACTION in grass.ts — the cap on how far ahead a recenter may place. */
const LEAD_MAX = 0.12;

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

/** Small enough that one frame cannot finish a disc even with a free sampler. */
const TEST_BUDGET_MS = 0.02;

function rig(ground: (x: number, z: number) => number | null = () => 0, budgetMs = TEST_BUDGET_MS): Rig {
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
    // a tiny budget: the placement walk is time-budgeted, and a test sampler
    // is free, so 2ms of it would finish the whole disc in one frame
    system.update(camera, () => 0, sampleGrassy, budgetMs);
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
  it("uploads a changed placement once and keeps wind/camera frames upload-free", () => {
    const r = rig(() => 0, 1000);
    r.pump(0, 0);
    const mesh = r.mesh();
    let writes = 0;
    const attributes = new Attributes({ createAttribute() {}, updateAttribute() { writes++; } }, { createAttribute() {} });
    const buffers = [mesh.instanceMatrix, mesh.geometry.getAttribute("instanceRandom")];
    const draw = () => buffers.forEach((a) => attributes.update(a, 1));
    // The first render creates buffers. Repeated main/shadow uses do not
    // re-upload their unchanged placement data even while wind animates.
    draw();
    for (let i = 0; i < 60; i++) { r.pump(0, 0); draw(); draw(); draw(); draw(); }
    expect(writes).toBe(0);
    r.pump(100, 100, 4);
    expect(mesh.count).toBeGreaterThan(0);
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: mesh.count * 16 }]);
    draw(); draw(); draw(); draw();
    expect(writes).toBe(2);
    r.system.clear();
  });
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

    // clear of the deadband, so the field must follow. Many frames, not ten:
    // the placement walk is time-budgeted and this rig runs on a deliberately
    // tiny budget, so a whole disc takes a while — this test is about WHERE
    // the centre lands, not how fast it gets there.
    r.pump(CELL * 0.8, 0, 600);
    expect([...r.placements().keys()].sort()).not.toEqual([...before.keys()].sort());
  });
});

describe("cover ground-sample cache", () => {
  it("stops asking about ground it has already walked over", () => {
    // Test cache reuse over the same completed route. The 0.02ms budget used
    // by scheduling tests makes the visited discs depend on host CPU load,
    // so the second lap could finish work the first lap never reached.
    const r = rig(() => 0, 1000);
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
    // and every lap after that is free: the terrain field is never asked
    // again. This is also what pins the recenter LEAD (see below) to a
    // direction that repeats — one derived from where the camera sits on the
    // circle would put every lap's centre somewhere new and re-sample under
    // it forever.
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
    // many frames: the re-place is budgeted (unlike the first one) and the
    // sampled disc is PLACEMENT_PAD wider than the radius it draws
    r.pump(0, 0, 2000);
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
      system.update(camera, () => 0, sample, TEST_BUDGET_MS);
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

describe("cover leads a travelling camera", () => {
  /** Mean x of every blade on screen — where the field actually IS. */
  const fieldX = (r: Rig): number => {
    let sum = 0;
    let n = 0;
    for (const key of r.placements().keys()) {
      sum += Number(key.split(",")[0]);
      n++;
    }
    expect(n).toBeGreaterThan(50);
    return sum / n;
  };

  /** How far the field's centre sits OFF the recenter grid, along x. */
  const offGrid = (r: Rig): number => {
    const c = fieldX(r);
    return c - Math.round(c / CELL) * CELL;
  };

  it("places the disc ahead of a camera that keeps walking", () => {
    // A generous budget here on purpose: this test is about WHERE a placement
    // is centred, not how many frames it takes to fill in.
    const r = rig(() => 0, 50);
    let x = 0;
    r.pump(0, 0, 20);
    expect(offGrid(r)).toBeCloseTo(0, 1); // standing: dead on the grid

    // The centre is snapped to the recenter grid and the lead is added on top
    // of it, so the lead is exactly the field's offset FROM that grid — which
    // makes it directly measurable, without having to reason about where in
    // the cell the camera happens to be.
    const cap = DATA.radius * LEAD_MAX;
    for (let leg = 0; leg < 6; leg++) {
      for (let i = 0; i < 200; i++) {
        x += CELL / 200;
        r.pump(x, 0);
      }
      expect(offGrid(r), `after ${leg + 1} cells of walking`).toBeCloseTo(cap, 0);
    }
    // walking back leads the other way
    for (let i = 0; i < 1200; i++) {
      x -= CELL / 200;
      r.pump(x, 0);
    }
    expect(offGrid(r)).toBeCloseTo(-cap, 0);
  });

  it("does not re-place a field just because the camera stopped", () => {
    const r = rig(() => 0, 50);
    let x = 0;
    for (let i = 0; i < 600; i++) {
      x += CELL / 200;
      r.pump(x, 0);
    }
    expect(offGrid(r)).toBeCloseTo(DATA.radius * LEAD_MAX, 0);
    // The lead is a fraction of the deadband by construction, so a camera
    // that stops inside it never triggers another placement — the field
    // simply stays a few metres ahead, which costs nothing and is invisible.
    r.reset();
    r.pump(x, 0, 400);
    expect(r.samples()).toBe(0);
  });
});

describe("cover reaches past its own fade in every direction", () => {
  /**
   * The worst direction: bin every blade by its bearing from the camera and
   * take the smallest of the per-bin maximum distances. That number is where
   * the field ENDS on the side it ends soonest — and if it lands inside the
   * fade band, the player sees grass stop in a hard arc rather than dissolve.
   *
   * This is the bug the placement pad and the coverage clamp exist for. The
   * fade is measured from the CAMERA and the disc is placed around a snapped,
   * hysteretic CENTRE, so on the trailing side the disc used to end at about
   * 0.58 of the radius — well inside a fade that does not start until 0.7.
   */
  const worstReach = (r: Rig, camX: number, camZ: number): number => {
    const BINS = 16;
    const far = new Array<number>(BINS).fill(0);
    let blades = 0;
    for (const key of r.placements().keys()) {
      const [x, z] = key.split(",").map(Number) as [number, number];
      const dx = x - camX;
      const dz = z - camZ;
      const bin = Math.min(BINS - 1, Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * BINS));
      far[bin] = Math.max(far[bin]!, Math.hypot(dx, dz));
      blades++;
    }
    expect(blades).toBeGreaterThan(500);
    return Math.min(...far);
  };

  it("still covers the fade band on the side it has drifted away from", () => {
    const r = rig(() => 0, 50);
    let x = 0;
    // walk far enough for many recenters, checking at every step of the cycle
    // rather than at one lucky phase of it
    let worst = Infinity;
    for (let i = 0; i < 3000; i++) {
      x += (CELL * 10) / 3000;
      r.pump(x, 0);
      if (i % 30 === 0 && i > 300) worst = Math.min(worst, worstReach(r, x, 0));
    }
    // FADE_BAND in grass.ts: nothing fades at all before 0.7 of the radius,
    // so a field that ends inside that is a visible edge
    expect(worst).toBeGreaterThan(DATA.radius * 0.7);
  });
});
