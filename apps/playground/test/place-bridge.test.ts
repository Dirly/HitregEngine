import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLandmarkMesh, compileLandmarkSpec, landmarkOperatorSchema } from "@hitreg/core";
import { baseGap, bridgeSchema, lowerPatch, planBridge, type BridgeInput } from "../tools/_place-bridge.mts";

// A synthetic slot gorge across the deck line (+z): rim 121.6, a shelf at 110 under the south rim, the floor at 15,
// a ledge at 85 under the north rim, the north rim from s 114.
const gorge = (_x: number, z: number): number => (z < 8 ? 121.6 : z < 20 ? 110 : z < 105 ? 15 : z < 114 ? 85 : 121.6);
const M = { face: "m/face", arch: "m/arch", parapet: "m/parapet", coping: "m/coping", deck: "m/deck", footing: "m/footing", roof: "m/roof" };
const input: BridgeInput = {
  id: "span", deck: { from: [0, 0], to: [0, 124], y: 121.6 },
  piers: [{ at: [0, 44], top: [9.6, 8], setBacks: [50, 90], cutwater: "left" }, { at: [0, 80.4], top: [9.6, 8], setBacks: [50, 90], cutwater: "left" }],
  arches: { springing: 90 }, start: { kind: "gate-tower" }, end: { kind: "block", length: 8 }, materials: M,
};
const TILE = 6.4; // a 256 px texture at 40 texels per metre

function mesh() {
  const p = planBridge(input, gorge);
  const op = landmarkOperatorSchema.parse(p.landmark);
  const c = compileLandmarkSpec((op.source as { csg: unknown }).csg, { voxel: 0.5, yaw: op.yaw, skipThin: true });
  return { p, built: buildLandmarkMesh(c, { tile: () => [TILE, TILE] }) };
}

test("bridge plan: two tiered piers, three equal round arches at one crown, a gate tower, refuges, every role", () => {
  const { p, built } = mesh();
  assert.deepEqual(p.faults, []);
  const parts = ((p.landmark.source as { csg: { parts: { name: string }[] } }).csg.parts).map((q) => q.name);
  for (const n of ["pier-1-footing", "pier-1-tier-1", "pier-1-tier-3", "pier-2-tier-3", "pier-1-cutwater-left", "ring-arch-start", "ring-arch-1", "ring-arch-end", "band-arch-1", "gate-tower-walls", "gate-tower-roof", "deck-paving", "deck-slab", "abutment-end", "impost-end"]) assert.ok(parts.includes(n), `missing ${n}`);
  assert.equal(parts.filter((n) => n.startsWith("pier-1-tier-")).length, 3); // two set-backs
  assert.equal(parts.filter((n) => /^refuge-.*-parapet$/.test(n)).length, 4); // both sides of both piers
  const crowns = (p.report.arches as { crown: number; span: number }[]);
  assert.equal(crowns.length, 3);
  assert.ok(Math.max(...crowns.map((a) => a.crown)) - Math.min(...crowns.map((a) => a.crown)) < 0.05, JSON.stringify(crowns));
  assert.ok(Math.abs(crowns[1]!.span - (80.4 - 44 - 8)) < 0.05);
  assert.deepEqual(built.groups.map((g) => g.role).sort(), ["arch", "band-1", "band-2", "band-3", "coping", "cornice", "deck", "face", "footing", "parapet", "pier-low-1", "pier-low-2", "pier-mid-1", "pier-mid-2", "pier-top-1", "pier-top-2", "roof"]);
  // a material list cycles over the bays / piers (the art gate: one tile under 2500 m2), every role named in the map
  const p2 = planBridge({ ...input, materials: { ...M, band: ["m/a", "m/b"], pierMid: ["m/c", "m/d"] } }, gorge), mats = p2.landmark.materials as Record<string, string>;
  assert.deepEqual([mats["band-1"], mats["band-2"], mats["band-3"], mats["pier-mid-1"], mats["pier-mid-2"], mats["pier-top-1"], mats.cornice], ["m/a", "m/b", "m/a", "m/c", "m/d", "m/face", "m/arch"]);
  assert.equal(built.revealSkipped.length, 0);
  assert.ok(p.top > 121.6 + 15, `tower top ${p.top}`);
});

test("bridge plan: the deck is one level walk end to end (paving top at deck y under the whole line, refuges included)", () => {
  const { p, built } = mesh();
  const deck = built.groups.find((g) => g.role === "deck")!;
  const tris: number[][][] = [];
  for (let t = 0; t < deck.indices.length; t += 3) { const v = [0, 1, 2].map((k) => { const i = deck.indices[t + k]! * 3; return [deck.positions[i]!, deck.positions[i + 1]!, deck.positions[i + 2]!]; }); const ny = (v[1]![2]! - v[0]![2]!) * (v[2]![0]! - v[0]![0]!) - (v[1]![0]! - v[0]![0]!) * (v[2]![2]! - v[0]![2]!); if (ny > 1e-9) tris.push(v); }
  // the walk surface over (x, z): the highest up-facing paving triangle (spec frame = world here: deck along +z from 0,0)
  const top = (x: number, z: number) => { let y = -Infinity; for (const [a, b, c] of tris) { const d = (b![2]! - c![2]!) * (a![0]! - c![0]!) + (c![0]! - b![0]!) * (a![2]! - c![2]!); const l1 = ((b![2]! - c![2]!) * (x - c![0]!) + (c![0]! - b![0]!) * (z - c![2]!)) / d, l2 = ((c![2]! - a![2]!) * (x - c![0]!) + (a![0]! - c![0]!) * (z - c![2]!)) / d, l3 = 1 - l1 - l2; if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) y = Math.max(y, l1 * a![1]! + l2 * b![1]! + l3 * c![1]!); } return y; };
  for (let z = -4; z <= 123.5; z += 0.5) for (const x of [-1.8, 0, 1.8]) assert.ok(Math.abs(top(x, z) - 121.6) < 0.01, `walk at ${x},${z}: ${top(x, z)}`);
  for (const s of p.report.refuges as number[]) assert.ok(Math.abs(top(4.6, s) - 121.6) < 0.01, `refuge floor at ${s}`); // the bulge past the parapet line
  assert.ok(top(0, 30) > 121 && top(4.0, 30) === -Infinity); // the paving stops at the parapet
  assert.equal(p.walk[0]![1], 121.6);
});

test("bridge plan: every face carries UVs at the role tile (40 tx/m), none stretched past 1.3:1 (caps, soffits, deck underside)", () => {
  const { built } = mesh();
  let area = 0, stretched = 0, worst = 1, under = 0;
  for (const g of built.groups) for (let t = 0; t < g.indices.length; t += 3) {
    const ids = [0, 1, 2].map((k) => g.indices[t + k]!), P = ids.map((i) => [g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!]), U = ids.map((i) => [g.uvs[i * 2]! * TILE, g.uvs[i * 2 + 1]! * TILE]);
    const e1 = P[1]!.map((v, k) => v - P[0]![k]!), e2 = P[2]!.map((v, k) => v - P[0]![k]!);
    const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!], a = Math.hypot(...cr) / 2;
    if (a < 1e-6) continue;
    // world-to-uv map on the triangle's plane: singular values of J (2x2 in an orthonormal plane basis)
    const ex = e1.map((v) => v / Math.hypot(...e1)), n = cr.map((v) => v / (2 * a)), ey = [n[1]! * ex[2]! - n[2]! * ex[1]!, n[2]! * ex[0]! - n[0]! * ex[2]!, n[0]! * ex[1]! - n[1]! * ex[0]!];
    const p1 = [e1.reduce((s, v, k) => s + v * ex[k]!, 0), 0], p2 = [e2.reduce((s, v, k) => s + v * ex[k]!, 0), e2.reduce((s, v, k) => s + v * ey[k]!, 0)];
    const du1 = [U[1]![0]! - U[0]![0]!, U[1]![1]! - U[0]![1]!], du2 = [U[2]![0]! - U[0]![0]!, U[2]![1]! - U[0]![1]!], det = p1[0]! * p2[1]! - p1[1]! * p2[0]!;
    const J = [(du1[0]! * p2[1]! - du2[0]! * p1[1]!) / det, (du2[0]! * p1[0]! - du1[0]! * p2[0]!) / det, (du1[1]! * p2[1]! - du2[1]! * p1[1]!) / det, (du2[1]! * p1[0]! - du1[1]! * p2[0]!) / det];
    const s1 = J[0]! ** 2 + J[1]! ** 2 + J[2]! ** 2 + J[3]! ** 2, dt = Math.abs(J[0]! * J[3]! - J[1]! * J[2]!), disc = Math.sqrt(Math.max(0, s1 * s1 / 4 - dt * dt));
    const smax = Math.sqrt(s1 / 2 + disc), smin = Math.sqrt(Math.max(0, s1 / 2 - disc));
    area += a; if (smin < 0.5) { under += a; continue; } // a face with no texture running across it
    const r = smax / smin; worst = Math.max(worst, r); if (r > 1.3) stretched += a;
    assert.ok(Math.abs(Math.sqrt(smax * smin) - 1) < 0.35, `${g.role} texel scale ${Math.sqrt(smax * smin).toFixed(2)} m/m`);
  }
  assert.equal(under, 0, `${under.toFixed(2)} m2 of faces have no UVs running across them`);
  assert.ok(stretched / area < 0.02, `${((100 * stretched) / area).toFixed(2)}% of the surface stretched past 1.3:1 (worst ${worst.toFixed(2)})`);
});

test("bridge plan: pier footings, the tower and the impost are seated in the ground (no daylight on any base outline)", () => {
  const { p } = mesh();
  const names = p.bases.map((b) => b.name);
  for (const n of ["pier-1-footing", "pier-2-footing", "gate-tower", "impost-end", "abutment-end"]) assert.ok(names.includes(n), `base ${n}`);
  for (const b of p.bases) { const g = baseGap(b, gorge); assert.ok(g.gap <= 0.05, `${b.name} stands ${g.gap} m clear at ${g.at}`); }
  // a footing planned on one ground and dropped over a deeper hole shows daylight
  const pier = p.bases.find((b) => b.name === "pier-1-footing")!;
  assert.ok(baseGap(pier, (x, z) => gorge(x, z) - 5).gap > 3);
});

test("bridge plan: the gate passage patch only lowers (rim edge kept); schema refuses a tiny deck", () => {
  const hill = (_x: number, z: number) => (z < 4 ? 122.5 : 119); // ground over the deck behind the tower, under it past the rim
  const lp = lowerPatch("t", [0, 0], [0, 1], 2, -7.5, 5.5, (s) => (s < -4.5 ? 121.55 : 121.25), hill) as { heights: number[]; weights: number[]; columns: number; origin: number[] };
  const at = (x: number, z: number) => (z - lp.origin[1]!) * lp.columns + (x - lp.origin[0]!);
  assert.equal(lp.weights[at(0, 0)], 1); assert.equal(lp.heights[at(0, 0)], 121.25);
  assert.equal(lp.heights[at(0, -6)], 121.55);
  assert.equal(lp.weights[at(0, 5)], 0); // already under: never filled
  assert.ok(lp.weights[0]! < 1e-6);
  assert.throws(() => planBridge({ ...input, deck: { from: [0, 0], to: [0, 5], y: 10 } }, gorge));
  assert.throws(() => bridgeSchema.parse({ ...input, materials: {} }));
});
