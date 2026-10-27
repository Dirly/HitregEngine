import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeReach, colliderReach, type ReachRepair } from "../tools/_collider-reach.mts";

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
  it("judges a ROOFED anchor on the floor under the roof, not on the roof's top", () => {
    // open ground at y 0 and a 10 x 10 slab 6-8 m up over the anchor (a rock lintel over a gate terrace)
    const positions: number[] = [], indices: number[] = [];
    const quad = (y: number, x0: number, z0: number, x1: number, z1: number, up: boolean) => {
      const b = positions.length / 3;
      positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      indices.push(...(up ? [b, b + 3, b + 2, b, b + 2, b + 1] : [b, b + 1, b + 2, b, b + 2, b + 3]));
    };
    quad(0, -60, -60, 60, 60, true);
    quad(8, -5, -5, 5, 5, true);
    quad(6, -5, -5, 5, 5, false);
    const reach = colliderReach({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices), offset: [0, 0, 0] }, { center: [0, 0], radius: 20, ground: () => -50, anchors: [[0, 0, 0.2]], caves: [] });
    assert.deepEqual(reach.withCaves, [true]);
  });
});

describe("collider reach walks with the REAL body's limits (0.4 m autostep, 50 deg climb)", () => {
  /** One heightfield mesh at 0.25 m over x, z in [-30, 30], the ground far below (never walked). */
  function field(height: (x: number, z: number) => number) {
    const S = 0.25, lo = -30, N = Math.round(60 / S) + 1, positions: number[] = [], indices: number[] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const x = lo + i * S, z = lo + j * S; positions.push(x, height(x, z), z); }
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i; indices.push(a, a + N, a + 1, a + 1, a + N, a + N + 1); }
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
  }
  /** A pad (x 5..15, |z| < 5) standing `h` over the open floor: only reached across its west riser or ramp. */
  const pad = (x: number, z: number) => x > 5 && x < 15 && Math.abs(z) < 5;
  const reachOf = (height: (x: number, z: number) => number, anchor: [number, number, number], extra: { ground?: (x: number, z: number) => number; exact?: boolean[] } = {}) =>
    colliderReach(field(height), { center: [0, 0], radius: 4, ground: extra.ground ?? (() => -50), anchors: [anchor], caves: [], exact: extra.exact }).withCaves[0];

  it("a 1.6 m riser up to a pad FAILS (a ramp head short of its shelf)", () => {
    assert.equal(reachOf((x, z) => (pad(x, z) ? 1.6 : 0), [10, 0, 1.6]), false);
  });
  it("a 0.75 m riser fails too (the old walk took it: twice the body's step)", () => {
    assert.equal(reachOf((x, z) => (pad(x, z) ? 0.75 : 0), [10, 0, 0.75]), false);
  });
  it("a 0.3 m step passes", () => {
    assert.equal(reachOf((x, z) => (pad(x, z) ? 0.3 : 0), [10, 0, 0.3]), true);
  });
  it("a continuous 42 deg ramp passes; a 55 deg one fails", () => {
    // a ramp up the west side (|z| < 2) onto a 6 m block (x 10..20, |z| < 5); elsewhere the block is a sheer wall
    const ramp = (deg: number) => (x: number, z: number) => (x >= 10 && x < 20 && Math.abs(z) < 5 ? 6 : Math.abs(z) < 2 && x < 10 ? Math.max(0, Math.min(6, 6 - (10 - x) * Math.tan((deg * Math.PI) / 180))) : 0);
    assert.equal(reachOf(ramp(42), [15, 0, 6]), true);
    assert.equal(reachOf(ramp(55), [15, 0, 6]), false);
  });
  it("a rock floor buried under the terrain is not walkable", () => {
    // a recess floor at y 0 inside a 2 m pit; the terrain (ground) fills the pit to y 1.9 and the hill around is at 2
    const rock = (x: number, z: number) => (Math.abs(x) < 3 && Math.abs(z) < 3 ? 0 : 2);
    assert.equal(reachOf(rock, [0, 0, 0], { ground: (x, z) => (Math.abs(x) < 3 && Math.abs(z) < 3 ? 1.9 : 2) }), false);
    assert.equal(reachOf(rock, [0, 0, 0], { ground: () => -50 }), false); // a 2 m pit is not stepped into and out of
  });
  it("an opening must be cut: a target 1 m off the floor beside it does not count", () => {
    // flat floor at 0 with a solid 1 m block over the target (a door leaf where the wicket should be)
    const positions: number[] = [], indices: number[] = [];
    const quad = (y: number, x0: number, z0: number, x1: number, z1: number, up: boolean) => {
      const b = positions.length / 3;
      positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      indices.push(...(up ? [b, b + 3, b + 2, b, b + 2, b + 1] : [b, b + 1, b + 2, b, b + 2, b + 3]));
    };
    quad(0, -40, -40, 40, 40, true);
    quad(3, -0.6, -0.6, 0.6, 0.6, true);
    quad(0.05, -0.6, -0.6, 0.6, 0.6, false);
    const mesh = { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
    const at = (exact: boolean) => colliderReach(mesh, { center: [0, 0], radius: 4, ground: () => -50, anchors: [[0, 0, 0]], caves: [], exact: [exact] }).withCaves[0];
    assert.equal(at(true), false);
    // open the leaf and the same target is reached
    const open = colliderReach({ positions: Float32Array.from(positions.slice(0, 12)), indices: Uint32Array.from(indices.slice(0, 6)) }, { center: [0, 0], radius: 4, ground: () => -50, anchors: [[0, 0, 0]], caves: [], exact: [true] });
    assert.deepEqual(open.withCaves, [true]);
  });
});
