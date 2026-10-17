import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeReach, type ReachRepair } from "../tools/_collider-reach.mts";

// A synthetic "bake": flat ground at y 0 and a 4 m plateau (x, z in [0, 12]) as ONE heightfield mesh. The solve's
// estimate would call the plateau reachable; the collider has a sheer 4 m wall all round, so the walk must not. A repair
// ramp is cut into the heightfield exactly as the landmark notch does (floor <= half width off its centre line).
const HALF = 1.6;
function bake(repairs: ReachRepair[]) {
  const height = (x: number, z: number) => {
    let y = x >= 0 && x <= 12 && z >= 0 && z <= 12 ? 4 : 0;
    for (const r of repairs) {
      const dx = r.from[0] - r.to[0], dz = r.from[2] - r.to[2], len = Math.hypot(dx, dz);
      const along = ((x - r.to[0]) * dx + (z - r.to[2]) * dz) / len, lat = Math.abs((x - r.to[0]) * dz - (z - r.to[2]) * dx) / len;
      if (lat <= HALF && along >= -1.5 && along <= len + 1.5) y = r.to[1] + (r.from[1] - r.to[1]) * Math.max(0, Math.min(1, along / len));
    }
    return y;
  };
  const S = 0.25, lo = -40, N = Math.round(80 / S) + 1, positions: number[] = [], indices: number[] = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const x = lo + i * S, z = lo + j * S; positions.push(x, height(x, z), z); }
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i; indices.push(a, a + N, a + 1, a + 1, a + N, a + N + 1); }
  return { mesh: { positions, indices }, site: { center: [6, 6] as [number, number], radius: 12, ground: () => -50, anchors: [[6, 6, 4]] as [number, number, number][], caves: [] } };
}

describe("ledge landmark reach loop (the collider is the truth)", () => {
  it("repairs a shelf the estimate calls reachable but the collider walls off", () => {
    const out = closeReach({ initial: [], bake, band: 4, maxRounds: 3 });
    assert.ok(out.added.length >= 1);
    assert.deepEqual(out.faults, []);
    assert.deepEqual(out.reach.withCaves, [true]);
    for (const r of out.added) {
      const run = Math.hypot(r.from[0] - r.to[0], r.from[2] - r.to[2]);
      assert.ok((r.from[1] - r.to[1]) / run <= 0.5);
      assert.ok(r.to[1] < 1); // the foot stands on the reached ground
    }
  });
  it("reports what it cannot repair as a fault, never silently", () => {
    const out = closeReach({ initial: [], bake: () => bake([]), band: 4, maxRounds: 2 });
    assert.deepEqual(out.faults, [0]);
  });
});
