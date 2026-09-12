import { describe, expect, it } from "vitest";
// Imported by relative path on purpose: @hitreg/scripting must not depend on
// @hitreg/physics (it runs headless, with no Rapier wasm), but the layer bits
// steering.ts restates have to be checked against the real ones somewhere, and
// layers.ts has no imports of its own so nothing is pulled in behind it.
import { Layers } from "../../physics/src/layers.js";
import {
  GROUND_LAYERS,
  LAYER_PROP,
  LAYER_TERRAIN,
  LAYER_WORLD,
  OBSTACLE_LAYERS,
  TerrainSteering,
  groundHeightAt,
  type SteeringSim,
} from "../src/steering.js";
import type { SimHit } from "../src/index.js";

/**
 * A world made of a height function and a few boxes, answering raycasts.
 *
 * Deliberately not a physics engine: steering only ever asks two questions
 * (how high is the ground at a point, is there furniture along this line), so
 * a test world only has to answer those two — and a fake makes the cliffs and
 * doorways exact instead of approximately modelled.
 */
function world(opts: {
  /** Ground height at (x, z); null = a hole in the world. */
  height?: (x: number, z: number) => number | null;
  /** Axis-aligned obstacles on the WORLD layer. */
  boxes?: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
}): SteeringSim & { rays: number } {
  const height = opts.height ?? (() => 0);
  const boxes = opts.boxes ?? [];
  const sim = {
    rays: 0,
    raycast(
      origin: [number, number, number],
      dir: [number, number, number],
      maxDistance: number,
      query?: { layers?: number },
    ): SimHit | null {
      sim.rays++;
      const layers = query?.layers ?? 0xffff;
      if (dir[1] < -0.5) {
        if ((layers & GROUND_LAYERS) === 0) return null;
        const h = height(origin[0], origin[2]);
        if (h === null || h > origin[1] || origin[1] - h > maxDistance) return null;
        return { entityId: "ground", point: [origin[0], h, origin[2]], normal: [0, 1, 0], distance: origin[1] - h };
      }
      if ((layers & OBSTACLE_LAYERS) === 0) return null;
      // March the segment: coarse, but a box is either in the way or it is not.
      const steps = 40;
      for (let i = 1; i <= steps; i++) {
        const t = (i / steps) * maxDistance;
        const x = origin[0] + dir[0] * t;
        const z = origin[2] + dir[2] * t;
        for (const b of boxes) {
          if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) {
            return { entityId: "wall", point: [x, origin[1], z], normal: [0, 0, -1], distance: t };
          }
        }
      }
      return null;
    },
  };
  return sim;
}

const NORTH: [number, number] = [0, 1];

function solveAt(
  steering: TerrainSteering,
  sim: SteeringSim,
  from: [number, number, number],
  desired: [number, number] = NORTH,
  now = 0,
) {
  return steering.solve(sim, { from, desired, dt: 1 / 8, speed: 4 }, now);
}

describe("steering layer bits", () => {
  it("still match @hitreg/physics", () => {
    // If this fails, someone renumbered a layer that is documented as
    // append-only — every mob in the game is now probing the wrong thing.
    expect(LAYER_WORLD).toBe(Layers.WORLD);
    expect(LAYER_TERRAIN).toBe(Layers.TERRAIN);
    expect(LAYER_PROP).toBe(Layers.PROP);
  });

  it("keeps terrain out of the horizontal obstacle mask", () => {
    // The whole reason slopes work: a horizontal ray that included TERRAIN
    // would report every hillside as a wall.
    expect(OBSTACLE_LAYERS & LAYER_TERRAIN).toBe(0);
    expect(GROUND_LAYERS & LAYER_TERRAIN).toBe(LAYER_TERRAIN);
  });
});

describe("groundHeightAt", () => {
  it("reads the ground under a point", () => {
    const sim = world({ height: (x) => x * 0.5 });
    expect(groundHeightAt(sim, 4, 0, 2)).toBeCloseTo(2);
  });

  it("returns null rather than a number when there is nothing there", () => {
    // An unstreamed chunk is a normal condition. A caller that defaults this
    // to 0 walks its mobs underground, silently.
    const sim = world({ height: () => null });
    expect(groundHeightAt(sim, 0, 0, 0)).toBeNull();
  });

  it("returns null when the scene has no physics queries at all", () => {
    expect(groundHeightAt(null, 0, 0, 0)).toBeNull();
    expect(groundHeightAt({}, 0, 0, 0)).toBeNull();
  });
});

describe("TerrainSteering on open ground", () => {
  it("goes where it was asked, and only pays for three rays", () => {
    const sim = world({});
    const steering = new TerrainSteering();
    const result = solveAt(steering, sim, [0, 0, 0]);
    expect(result.dir[0]).toBeCloseTo(0);
    expect(result.dir[1]).toBeCloseTo(1);
    expect(result.blocked).toBe(false);
    expect(sim.rays).toBe(3); // ground here, ground ahead, obstacle ahead
  });

  it("stops when asked to stop", () => {
    const steering = new TerrainSteering();
    const result = solveAt(steering, world({}), [0, 0, 0], [0, 0]);
    expect(result.dir).toEqual([0, 0]);
  });

  it("falls back to the wish direction when the scene has no physics", () => {
    // A brain in a doc-only scene should still patrol, not freeze.
    const steering = new TerrainSteering();
    const result = solveAt(steering, null, [0, 0, 0], [3, 0]);
    expect(result.dir[0]).toBeCloseTo(1);
    expect(result.groundY).toBeNull();
  });
});

describe("TerrainSteering and terrain", () => {
  it("walks up a climbable slope without treating it as a wall", () => {
    // 25 degrees: a hill, not a cliff.
    const sim = world({ height: (_x, z) => Math.max(0, z) * Math.tan((25 * Math.PI) / 180) });
    const result = solveAt(new TerrainSteering(), sim, [0, 0, 0]);
    expect(result.blocked).toBe(false);
    expect(result.dir[1]).toBeCloseTo(1);
  });

  it("refuses a grade steeper than maxSlope", () => {
    const sim = world({ height: (_x, z) => Math.max(0, z) * Math.tan((75 * Math.PI) / 180) });
    const result = solveAt(new TerrainSteering(), sim, [0, 0, 0]);
    expect(result.blocked).toBe(true);
    // It does not stand there helpless either: the ground at the foot of the
    // cliff is flat, so it slides along the base instead of climbing.
    expect(result.dir[1]).toBeLessThan(0.2);
  });

  it("steps up a kerb without noticing", () => {
    const sim = world({ height: (_x, z) => (z > 1 ? 0.3 : 0) });
    const result = solveAt(new TerrainSteering(), sim, [0, 0, 0]);
    expect(result.blocked).toBe(false);
  });

  it("will not walk off a cliff", () => {
    // Flat ground that falls away 20 m north of the origin.
    const sim = world({ height: (_x, z) => (z > 1 ? -20 : 0) });
    const result = solveAt(new TerrainSteering(), sim, [0, 0, 0]);
    expect(result.dir[1]).toBeLessThan(0.9); // not straight over the edge
  });

  it("will not walk into a hole in the world", () => {
    // An unstreamed chunk ahead reads as null, not as a floor at y=0.
    const sim = world({ height: (_x, z) => (z > 1 ? null : 0) });
    const result = solveAt(new TerrainSteering(), sim, [0, 0, 0]);
    expect(result.blocked).toBe(true);
  });
});

describe("TerrainSteering and furniture", () => {
  it("slides around a boulder instead of stopping at it", () => {
    const sim = world({ boxes: [{ minX: -1.5, maxX: 1.5, minZ: 1, maxZ: 3 }] });
    const result = solveAt(new TerrainSteering(), sim, [0, 0, 0]);
    expect(result.blocked).toBe(true);
    expect(result.dir).not.toEqual([0, 0]);
    // Still making progress toward where it wanted to go, just not directly.
    expect(result.dir[1]).toBeGreaterThan(0);
    expect(Math.abs(result.dir[0])).toBeGreaterThan(0.2);
  });

  it("keeps going the same way round rather than jittering", () => {
    // Two equally good ways past an obstacle is exactly the setup that makes a
    // memoryless steerer vibrate on the spot.
    const sim = world({ boxes: [{ minX: -1.5, maxX: 1.5, minZ: 1, maxZ: 3 }] });
    const steering = new TerrainSteering();
    const first = solveAt(steering, sim, [0, 0, 0], NORTH, 0);
    const sides: number[] = [];
    for (let i = 1; i < 5; i++) {
      sides.push(Math.sign(solveAt(steering, sim, [0, 0, 0], NORTH, i / 8).dir[0]));
    }
    expect(sides.every((s) => s === Math.sign(first.dir[0]))).toBe(true);
  });

  it("gives up when it is walled in", () => {
    const sim = world({
      boxes: [
        { minX: -6, maxX: 6, minZ: 1, maxZ: 2 },
        { minX: -6, maxX: 6, minZ: -2, maxZ: -1 },
        { minX: 1, maxX: 2, minZ: -6, maxZ: 6 },
        { minX: -2, maxX: -1, minZ: -6, maxZ: 6 },
      ],
    });
    expect(solveAt(new TerrainSteering(), sim, [0, 0, 0]).dir).toEqual([0, 0]);
  });
});

describe("TerrainSteering when a body is not actually moving", () => {
  it("notices, and sidesteps", () => {
    const sim = world({});
    const steering = new TerrainSteering();
    // The body wants to run north at 4 m/s and never moves — wedged on
    // geometry the probes cannot see, which is the case a probe cannot fix.
    let result = solveAt(steering, sim, [0, 0, 0], NORTH, 0);
    expect(result.stuck).toBe(false);
    for (let i = 1; i <= 10 && !result.stuck; i++) {
      result = solveAt(steering, sim, [0, 0, 0], NORTH, i / 8);
    }
    expect(result.stuck).toBe(true);
    // Sidestepping: across the way it was going, not into it.
    expect(Math.abs(result.dir[0])).toBeGreaterThan(0.9);
  });

  it("does not call a body that is travelling stuck", () => {
    const sim = world({});
    const steering = new TerrainSteering();
    let result = solveAt(steering, sim, [0, 0, 0], NORTH, 0);
    for (let i = 1; i <= 10; i++) {
      result = solveAt(steering, sim, [0, 0, i * 0.5], NORTH, i / 8);
    }
    expect(result.stuck).toBe(false);
  });

  it("does not call a body that never asked to move stuck", () => {
    const sim = world({});
    const steering = new TerrainSteering();
    let result = solveAt(steering, sim, [0, 0, 0], [0, 0], 0);
    for (let i = 1; i <= 10; i++) result = solveAt(steering, sim, [0, 0, 0], [0, 0], i / 8);
    expect(result.stuck).toBe(false);
  });
});

describe("TerrainSteering separation", () => {
  it("leans away from a packmate standing on top of it", () => {
    const steering = new TerrainSteering();
    const result = steering.solve(
      world({}),
      { from: [0, 0, 0], desired: NORTH, dt: 1 / 8, speed: 4, avoid: [[0.3, 0, 0.9]] },
      0,
    );
    // Pushed off the neighbour (which is at +x) while still heading north.
    expect(result.dir[0]).toBeLessThan(0);
    expect(result.dir[1]).toBeGreaterThan(0);
  });

  it("ignores a packmate that is far enough away", () => {
    const steering = new TerrainSteering();
    const result = steering.solve(
      world({}),
      { from: [0, 0, 0], desired: NORTH, dt: 1 / 8, speed: 4, avoid: [[8, 0, 0.9]] },
      0,
    );
    expect(result.dir[0]).toBeCloseTo(0);
  });
});
