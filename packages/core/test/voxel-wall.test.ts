import { describe, expect, it } from "vitest";
import { buildLandmarkMesh, findZFights, type ZFightMesh, buildWall, heightPatchSchema, prepareHeightPatch, compileLandmarkOperator, compileOperator, getOperator, wallLandmarkParams, wallParamsSchema, type BuiltGroup, type OperatorFieldReader } from "../src/index.js";

/** A hillside: flat at y 10 for z < 0, rising 0.5 m per m beyond (a slope to run a wall into). */
const reader = (h: (x: number, z: number) => number = (_x, z) => 10 + Math.max(0, z) * 0.5): OperatorFieldReader => ({ height: h, voxelSize: 2, seaLevel: 0, seed: 7 });

function volume(groups: BuiltGroup[]): number {
  let v = 0;
  for (const g of groups) for (let t = 0; t < g.indices.length; t += 3) {
    const p = [0, 1, 2].map((e) => { const i = g.indices[t + e]! * 3; return [g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!]; });
    const [a, b, c] = p as [number[], number[], number[]];
    v += a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  }
  return v / 6;
}
const bake = (doc: Record<string, unknown>, r = reader()) => {
  const p = wallLandmarkParams(doc, r, { id: "w" });
  const c = compileLandmarkOperator(p, r, { id: "w" })!; // compileTriangleMesh validates every solid: closed, manifold, no self-intersection
  return { p, c, mesh: buildLandmarkMesh(c.compiled, { tile: () => [4, 4] }) };
};
/** Highest collider surface at (x, z) in the spec frame (the bake is in world heights at y 0). */
function topAt(groups: BuiltGroup[], x: number, z: number): number | null {
  let best: number | null = null;
  for (const g of groups) for (let t = 0; t < g.indices.length; t += 3) {
    const v = [0, 1, 2].map((e) => Array.from(g.positions.subarray(g.indices[t + e]! * 3, g.indices[t + e]! * 3 + 3)));
    const [a, b, c] = v as [number[], number[], number[]];
    const d = (b[2]! - c[2]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[2]! - c[2]!);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((b[2]! - c[2]!) * (x - c[0]!) + (c[0]! - b[0]!) * (z - c[2]!)) / d, l2 = ((c[2]! - a[2]!) * (x - c[0]!) + (a[0]! - c[0]!) * (z - c[2]!)) / d, l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const y = l1 * a[1]! + l2 * b[1]! + l3 * c[1]!;
    if (best === null || y > best) best = y;
  }
  return best;
}

describe("wall operator", { timeout: 30_000 }, () => { // the ramp case is ~2.5 s alone: the default 5 s fails under a full-suite load
  it("is registered with a described schema and compiles through the built landmark (deterministic)", () => {
    expect(getOperator("wall")?.description).toMatch(/SWEPT WALL/);
    const doc = { id: "w", op: "wall", points: [[-30, -10], [0, -14], [30, -10]], height: 5, thickness: 1.4, cap: {}, buttresses: { every: 8 } };
    const a = compileOperator(doc, reader()), b = compileOperator(doc, reader());
    expect(JSON.stringify(a.output.features)).toBe(JSON.stringify(b.output.features));
    const lm = (a.output.features.landmarks as unknown as { prefab: string; position: number[] }[])[0]!;
    expect(lm.prefab).toMatch(/^landmarks\/w-/);
    expect(lm.position[1]).toBe(0); // world heights in the spec
  });

  it("builds closed outward solids per role with metre UVs (u along the wall)", () => {
    const { mesh } = bake({ points: [[-20, -10], [20, -10]], height: 4, thickness: 1, batter: 0, smooth: false, irregularity: { thickness: 0, height: 0, lean: 0 }, ends: { start: "none", end: "none" } });
    const roles = mesh.groups.map((g) => g.role).sort();
    expect(roles).toEqual(["cap", "face", "footing"]);
    expect(volume(mesh.groups)).toBeGreaterThan(0);
    // the face: a 40 m run tiled at 4 m -> u spans 10 tiles
    const face = mesh.groups.find((g) => g.role === "face")!;
    let u0 = Infinity, u1 = -Infinity;
    for (let i = 0; i < face.vertexCount; i++) if (face.normals[i * 3 + 2]! > 0.9) { u0 = Math.min(u0, face.uvs[i * 2]!); u1 = Math.max(u1, face.uvs[i * 2]!); } // the right (+z) face
    expect(u1 - u0).toBeGreaterThan(9.9);
    expect(u1 - u0).toBeLessThan(10.6);
    // top of the wall: ground 10 + height 4 (coping top), walkable surface right over the centreline
    expect(topAt(mesh.groups, 0, 0)).toBeCloseTo(14, 1);
  });

  it("irregularity is seeded and bounded", () => {
    const base = { points: [[-30, -10], [30, -10]], height: 6, thickness: 2, scale: "giant", ends: { start: "none", end: "none" } };
    const a = bake({ ...base, seed: 1 }).mesh, b = bake({ ...base, seed: 1 }).mesh, c = bake({ ...base, seed: 2 }).mesh;
    const sig = (m: typeof a) => m.groups.map((g) => Array.from(g.positions.slice(0, 60)).join(",")).join("|");
    expect(sig(a)).toBe(sig(b));
    expect(sig(a)).not.toBe(sig(c));
    for (let x = -28; x <= 28; x += 4) { const t = topAt(a.groups, x, 0)!; expect(Math.abs(t - 16)).toBeLessThanOrEqual(0.51); }
  });

  it("gates leave a clear passage under an arch; the coping runs over it", () => {
    const { mesh } = bake({ points: [[-20, -10], [20, -10]], height: 6, thickness: 1.5, smooth: false, irregularity: { thickness: 0, height: 0, lean: 0 }, openings: [{ name: "g", at: 20, width: 3, height: 4 }], ends: { start: "none", end: "none" } });
    // inside the gate (x 0 = station 20) the highest surface is the coping (16); beside it too, but no surface at 11-13
    const ys: number[] = [];
    for (const g of mesh.groups) for (let i = 0; i < g.vertexCount; i++) if (Math.abs(g.positions[i * 3]!) < 0.6 && Math.abs(g.positions[i * 3 + 2]!) < 0.6) ys.push(g.positions[i * 3 + 1]!);
    expect(ys.some((y) => y > 10.5 && y < 13.5)).toBe(false);
    expect(topAt(mesh.groups, 0, 0)).toBeCloseTo(16, 1);
  });

  it("a window (sill > 0) leaves a hole between sill and head; the body runs on under it (LANDMARKS 2026-10-22: tower slits)", () => {
    const doc = { points: [[-20, -10], [20, -10]], height: 6, thickness: 1.5, smooth: false, irregularity: { thickness: 0, height: 0, lean: 0 }, openings: [{ name: "slit", at: 20, width: 0.8, height: 4.5, sill: 3, arch: false }], ends: { start: "none", end: "none" } };
    const { mesh } = bake(doc);
    const ys: number[] = [];
    for (const g of mesh.groups) for (let i = 0; i < g.vertexCount; i++) if (Math.abs(g.positions[i * 3]!) < 0.45 && Math.abs(g.positions[i * 3 + 2]!) < 0.8) ys.push(g.positions[i * 3 + 1]!);
    expect(ys.some((y) => y > 13.1 && y < 14.4)).toBe(false); // the slit: clear from the sill (13) to the head (14.5)
    expect(ys.some((y) => Math.abs(y - 13) < 0.01)).toBe(true); // the sill's level top
    expect(ys.some((y) => Math.abs(y - 14.5) < 0.01)).toBe(true); // the lintel's soffit
    expect(topAt(mesh.groups, 0, 0)).toBeCloseTo(16, 1);
    expect(zfights(mesh.groups)).toEqual([]);
  });

  it("parapet + crenels + stairs + pier ends + buttresses all build (town wall into a hill)", () => {
    const { mesh, p } = bake({
      points: [[-30, -20], [0, -12], [20, 10]], height: 6, thickness: 2.2, heightMode: "step", face: "right",
      parapet: { side: "face", crenels: {} }, stairs: [{ from: 4, to: 20, side: "back" }], buttresses: { every: 10 },
      ends: { start: "pier", end: "terrain" }, openings: [{ name: "gate", at: 28, width: 3.2, height: 4.2 }],
    });
    const roles = new Set(mesh.groups.map((g) => g.role));
    for (const r of ["face", "cap", "footing", "parapet", "merlon", "stair", "pier", "buttress"]) expect(roles.has(r)).toBe(true);
    expect(p.targets.some((t) => t.name.startsWith("stair-top"))).toBe(true);
  });

  it("retaining backfill raises only the earth side, >= 6 m wide", () => {
    const r = reader(() => 10);
    const w = buildWall({ variant: "retaining", points: [[-20, 0], [20, 0]], height: 5, face: "right", backfill: { width: 8, feather: 8 } }, r, { id: "rw" });
    const g = w.ground as unknown as { origin: number[]; columns: number; heights: number[]; weights: number[] };
    expect(g).toBeTruthy();
    // right of travel along +x is +z: the earth (raised) side is -z
    const at = (x: number, z: number) => g.heights[Math.round((z - g.origin[1]!) / 2) * g.columns + Math.round((x - g.origin[0]!) / 2)]!;
    expect(at(0, -6)).toBeGreaterThan(14);
    for (let r = 0; r < g.heights.length / g.columns; r++) if (g.origin[1]! + r * 2 > 1) for (let c = 0; c < g.columns; c++) expect(g.heights[r * g.columns + c]!).toBeLessThanOrEqual(10.05);
  });

  it("ramp: a sloped deck with kerbs, steep stretches become flights with risers <= 0.4", () => {
    const r = reader((x) => 10 + Math.max(0, x) * 0.1);
    const doc = { variant: "ramp", points: [[0, 0], [60, 0], [80, 0]], thickness: 4, ramp: { levels: [{ at: 0 }, { at: 60, y: 18 }, { at: "end", y: 30 }], riser: 0.3 }, parapet: { side: "right" as const } };
    const w = buildWall(wallParamsSchema.parse({ ...doc, parapet: { side: "face" } }), r, { id: "ramp" });
    const deck = w.report.deck as { flights: number[][]; treads: number; maxSlopeGrade: number };
    expect(deck.flights.length).toBe(1);
    expect(deck.treads).toBeGreaterThanOrEqual(Math.ceil(12 / 0.3));
    expect(deck.maxSlopeGrade).toBeLessThanOrEqual(0.45);
    const { mesh, p } = bake({ ...doc, parapet: { side: "face" } }, r);
    expect(p.targets.map((t) => t.name)).toEqual(["ramp-foot", "ramp-mid", "ramp-head"]);
    // walk the centreline: no rise between 0.25 m samples above 0.4 m (the body's step)
    let prev = topAt(mesh.groups, 0 - 40, 0)!; let worst = 0;
    for (let x = 0.25; x <= 79.5; x += 0.25) { const t = topAt(mesh.groups, x - 40, 0); if (t === null) continue; worst = Math.max(worst, t - prev); prev = t; }
    expect(worst).toBeLessThanOrEqual(0.4);
    expect(topAt(mesh.groups, 79 - 40, 0)).toBeCloseTo(30, 0);
  });

  it("a 1.2 m free wall turns a sharp 90 deg corner on a mitre (closed solids, corner filled, nothing past it, UVs run on)", () => {
    const flat = reader(() => 10);
    for (const irregular of [false, true]) {
      const doc = { points: [[-20, 0], [0, 0], [0, 20]], height: 1.2, thickness: 0.6, smooth: false, ends: { start: "none", end: "none" }, ...(irregular ? {} : { irregularity: { thickness: 0, height: 0, lean: 0 } }) };
      const { mesh, c } = bake(doc, flat);
      if (irregular) continue;
      const at = c.at;
      const top = (x: number, z: number) => topAt(mesh.groups, x - at[0]!, z - at[1]!);
      // the turn is toward +z (the right of travel, n > 0): (0.3, -0.3) is the outside corner, (-0.3, 0.3) the inside one
      expect(top(0, 0)).toBeCloseTo(11.2, 1);
      expect(top(0.33, -0.33)).toBeCloseTo(11.2, 1); // the cap's overhang wraps the outside corner
      expect(top(-0.25, 0.25)).toBeCloseTo(11.2, 1);
      expect(top(-0.75, 0.75)).toBeNull(); // inside the L, past the footing: open ground (the faces stop on the mitre)
      expect(top(0.75, -0.75)).toBeNull();
      // the outside face's u is the same on both legs where they meet at the corner edge
      const face = mesh.groups.find((g) => g.role === "face")!;
      const us: number[] = [];
      for (let i = 0; i < face.vertexCount; i++) {
        const x = face.positions[i * 3]! + at[0]!, z = face.positions[i * 3 + 2]! + at[1]!;
        if (Math.max(Math.abs(face.normals[i * 3]!), Math.abs(face.normals[i * 3 + 2]!)) > 0.9 && Math.abs(x - 0.3) < 0.02 && Math.abs(z + 0.3) < 0.02) us.push(face.uvs[i * 2]!);
      }
      expect(us.length).toBeGreaterThan(1);
      // (a battered face is developed at its solid's outermost offset, so it is never sheared: the corner edge may part by
      // 2k x the batter's lean, a few cm, instead of the face reading stretched on later legs; owner walk 2026-10-21)
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(0.05);
    }
  });

  it("a battered retaining wall with footing turns inside and outside corners (and short legs, acute turns) as closed solids", () => {
    const r = reader(() => 10);
    for (const face of ["right", "left"] as const) {
      const { mesh, c } = bake({ variant: "retaining", face, points: [[-20, 0], [0, 0], [0, 20]], height: 4, batter: 0.15, smooth: false, footing: {}, buttresses: { every: 6 }, ends: { start: "none", end: "none" } }, r);
      const at = c.at;
      expect(new Set(mesh.groups.map((g) => g.role))).toEqual(new Set(["face", "cap", "footing", "buttress"]));
      // the footing runs on round the corner: its top (ground + plinth 0.3) stands just past the battered foot on the
      // corner's diagonal, on the exposed side (right of travel = +z / -x: the inside of this turn; left: the outside)
      const sgn = face === "right" ? -1 : 1, d = (0.6 + 0.6 + 0.15) * sgn;
      const t = topAt(mesh.groups, d - at[0]!, -d - at[1]!);
      expect(t).not.toBeNull();
      expect(t!).toBeGreaterThan(10.2);
    }
    // a 0.6 m jog, a 1 m leg between two same-way corners, a 150 deg hairpin (warned): all still compile
    bake({ points: [[-20, 0], [0, 0], [0, 0.6], [20, 0.6]], height: 3, thickness: 1, smooth: false, footing: {} }, r);
    bake({ points: [[-20, 0], [0, 0], [0, 1], [-20, 1]], height: 3, thickness: 1.4, smooth: false, footing: {} }, r);
    const hp = buildWall({ points: [[-20, 0], [0, 0], [-17, 10]], height: 3, smooth: false }, r, { id: "hp" });
    expect((hp.report.warnings as string[]).some((w) => /turns 1[45][0-9] deg/.test(w))).toBe(true);
    bake({ points: [[-20, 0], [0, 0], [-17, 10]], height: 3, smooth: false }, r);
  });

  it("a closed rectangle (town wall ring) with a crenellated walk: every corner mitred, the walk continuous all the way round", () => {
    const r = reader((x) => 10 + 0.04 * x);
    const doc = { points: [[-15, -10], [15, -10], [15, 10], [-15, 10], [-15, -10]], height: 6, thickness: 2.4, smooth: false, parapet: { side: "both", thickness: 0.5, crenels: {} } };
    const { mesh, c } = bake(doc, r);
    const w = buildWall(doc, r, { id: "w" });
    expect(new Set(mesh.groups.map((g) => g.role))).toEqual(new Set(["face", "cap", "footing", "parapet", "merlon"]));
    expect(w.report.warnings).toEqual([]);
    const at = c.at;
    const top = (x: number, z: number) => topAt(mesh.groups, x - at[0]!, z - at[1]!);
    // the walk round the ring's centreline (sampled every 0.5 m, corners included): no gap, no step past the jitter
    const ring = [[-15, -10], [15, -10], [15, 10], [-15, 10], [-15, -10]];
    let prev: number | null = null, worst = 0;
    for (let i = 0; i + 1 < ring.length; i++) {
      const [a, b] = [ring[i]!, ring[i + 1]!], n = Math.round(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!) / 0.5);
      for (let k = 0; k < n; k++) {
        const t = top(a[0]! + ((b[0]! - a[0]!) * k) / n, a[1]! + ((b[1]! - a[1]!) * k) / n);
        expect(t).not.toBeNull();
        if (prev !== null) worst = Math.max(worst, Math.abs(t! - prev));
        prev = t;
      }
    }
    expect(worst).toBeLessThan(0.15);
    // each outside corner carries the parapet round it (merlon/parapet top over the walk)
    for (const [x, z] of [[-15, -10], [15, -10], [15, 10], [-15, 10]] as const) expect(top(x + Math.sign(x) * 1.05, z + Math.sign(z) * 1.05)!).toBeGreaterThan(top(x, z)! + 0.8);
  });

  it("ramp: a switchback stair (leg, landing, reversed leg) turns on true corners; risers <= 0.35, no bumps on the walk line", () => {
    const r = reader(() => 10);
    const pts = [[0, 0], [24, 0], [24, 6], [0, 6]];
    const doc = { variant: "ramp", points: pts, smooth: false, thickness: 2.4, ramp: { levels: [{ at: 0, y: 10.05 }, { at: 24, y: 18 }, { at: 30, y: 18 }, { at: "end", y: 26 }], maxGrade: 0.2, riser: 0.3 }, parapet: { side: "both", height: 1, thickness: 0.4 } };
    const w = buildWall(wallParamsSchema.parse(doc), r, { id: "w" });
    const deck = w.report.deck as { flights: number[][]; treads: number };
    expect(deck.flights.length).toBeGreaterThanOrEqual(2);
    expect((w.report.landings as unknown[]).length).toBe(1); // the two corners share one level landing leg
    const { mesh } = bake(doc, r);
    // the collider triangles near the walk line, bucketed by metre cell (topAt over every triangle is too slow)
    const bins = new Map<string, BuiltGroup[]>();
    for (const g of mesh.groups) for (let t = 0; t < g.indices.length; t += 3) {
      const ids = [0, 1, 2].map((e) => g.indices[t + e]!), xs = ids.map((i) => g.positions[i * 3]! + w.at[0]), zs = ids.map((i) => g.positions[i * 3 + 2]! + w.at[1]);
      const one = { ...g, indices: Uint32Array.from(ids) } as BuiltGroup;
      for (let bx = Math.floor(Math.min(...xs)); bx <= Math.floor(Math.max(...xs)); bx++) for (let bz = Math.floor(Math.min(...zs)); bz <= Math.floor(Math.max(...zs)); bz++) { const k = `${bx},${bz}`; const l = bins.get(k) ?? []; l.push(one); bins.set(k, l); }
    }
    const top = (x: number, z: number) => topAt(bins.get(`${Math.floor(x)},${Math.floor(z)}`) ?? [], x - w.at[0], z - w.at[1]);
    let prev: number | null = null, worstBump = 0, worstRise = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i]!, pts[i + 1]!], n = Math.round(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!) / 0.1);
      for (let k = i === 0 ? 5 : 0; k < n - (i === pts.length - 2 ? 5 : 0); k++) {
        const t = top(a[0]! + ((b[0]! - a[0]!) * k) / n, a[1]! + ((b[1]! - a[1]!) * k) / n);
        expect(t).not.toBeNull();
        if (prev !== null) { worstBump = Math.max(worstBump, prev - t!); worstRise = Math.max(worstRise, t! - prev); }
        prev = t;
      }
    }
    expect(worstBump).toBeLessThanOrEqual(0.05); // climbing all the way: never a lip to fall back off
    expect(worstRise).toBeLessThanOrEqual(0.35); // risers <= 0.35
    expect(prev!).toBeCloseTo(26, 0);
  });

  it("ramp: cut.calm marks the cut patch as built ground (overhang noise off over it); default leaves it natural", () => {
    const h = (x: number, z: number) => 10 + 0.3 * x + 0.9 * z;
    const doc = { variant: "ramp", points: [[0, 0], [40, 0]], thickness: 3, ramp: { followGround: true, lift: 0.4 } };
    const plain = buildWall(wallParamsSchema.parse(doc), reader(h), { id: "w" });
    const calm = buildWall(wallParamsSchema.parse({ ...doc, ramp: { ...doc.ramp, cut: { calm: true } } }), reader(h), { id: "w" });
    expect((plain.ground as { calm?: boolean }).calm).toBeUndefined();
    expect((calm.ground as { calm?: boolean }).calm).toBe(true);
    expect(heightPatchSchema.parse(calm.ground).calm).toBe(true);
  });
  it("ramp: the walkable top along the centreline has no bumps over the treads/deck (cut ground stays under the slab)", () => {
    // a causeway climbing a rough bank: steady grade, a steep pitch (flights), the bank rising across the deck and
    // +-2.5 m ground off the centreline (the lattice nodes the cut must lower) - the wall-lab spoil-causeway case
    const pitch = (x: number) => Math.min(Math.max(x - 30, 0), 12) * 0.6;
    const h = (x: number, z: number) => 10 + 0.3 * x + pitch(x) + 0.7 * z + 2.5 * Math.sin(1.7 * x + 0.4) * Math.sin(1.3 * z);
    const r = reader(h);
    const doc = { variant: "ramp", scale: "giant", points: [[0, 0], [80, 0]], thickness: 6, batter: 0.1, ramp: { followGround: true, lift: 0.4, maxGrade: 0.4, riser: 0.3 }, parapet: { side: "both", height: 1, thickness: 0.7 } };
    const w = buildWall(wallParamsSchema.parse(doc), r, { id: "w" });
    expect((w.report.deck as { flights: unknown[] }).flights.length).toBeGreaterThan(0);
    const cut = prepareHeightPatch(heightPatchSchema.parse(w.ground), 2, h);
    const ground = (x: number, z: number) => cut.apply(x, z, h(x, z));
    const { mesh } = bake(doc, r);
    // the collider triangles under the sampled strip, bucketed by metre of x (topAt over every triangle is too slow here)
    const bins = new Map<number, BuiltGroup[]>();
    for (const g of mesh.groups) for (let t = 0; t < g.indices.length; t += 3) {
      const ids = [0, 1, 2].map((e) => g.indices[t + e]!), xs = ids.map((i) => g.positions[i * 3]!), zs = ids.map((i) => g.positions[i * 3 + 2]!);
      if (Math.min(...zs) > 2 - w.at[1] || Math.max(...zs) < -2 - w.at[1]) continue;
      const one = { ...g, indices: Uint32Array.from(ids) } as BuiltGroup;
      for (let b = Math.floor(Math.min(...xs)); b <= Math.floor(Math.max(...xs)); b++) { const l = bins.get(b) ?? []; l.push(one); bins.set(b, l); }
    }
    const top = (x: number, z: number) => topAt(bins.get(Math.floor(x - w.at[0])) ?? [], x - w.at[0], z - w.at[1]);
    let prev: number | null = null, worstBump = 0, worstRise = 0, worstGround = -Infinity;
    for (let x = 1; x <= 79; x += 0.1) for (const z of [-1.5, 0, 1.5]) {
      const t = top(x, z);
      expect(t).not.toBeNull();
      worstGround = Math.max(worstGround, ground(x, z) - t!);
      if (z !== 0) continue;
      const walk = Math.max(t!, ground(x, z));
      if (prev !== null) { worstBump = Math.max(worstBump, prev - walk); worstRise = Math.max(worstRise, walk - prev); }
      prev = walk;
    }
    expect(worstGround).toBeLessThanOrEqual(0.05); // the cut ground never pokes through the treads/deck
    expect(worstBump).toBeLessThanOrEqual(0.05); // climbing: never a lip to fall back off
    expect(worstRise).toBeLessThanOrEqual(0.4); // risers <= the body's step
  });
  it("ramp: the cut lowers the bank flat to the parapet foot over a switchback LANDING too (the next leg up claims no node)", () => {
    // the weeping stair down a 2.2 m/m bank: legs 6 m apart, each ~13 m lower than the one above. A cut node is owned by
    // the leg nearest it, so the node between two legs went to the upper leg (uncut) and the 2 m lattice + tent filter
    // drew an earth wedge ~1 m over the landing inside its bank-side parapet (weeping-stair zfight, -2448,87.5,-1081)
    const h = (_x: number, z: number) => 60 - 2.2 * z;
    const r = reader(h);
    const doc = { variant: "ramp", points: [[0, 0], [0, 9], [-29, 9], [-29, 15], [-1, 15], [-1, 21], [-29, 21], [-29, 24]], smooth: false, thickness: 3.6, batter: 0.02, ramp: { levels: [{ at: 0, y: 54.88 }, { at: 12, y: 54.88 }, { at: 35, y: 40.74 }, { at: 47, y: 40.74 }, { at: 69, y: 27.21 }, { at: 81, y: 27.21 }, { at: 103, y: 13.68 }, { at: "end", y: 13.68 }], maxGrade: 0.12, riser: 0.3, stairGrade: 0.6, deck: 0.35, cut: { feather: 6, calm: true } }, parapet: { side: "both", height: 1, thickness: 0.45 }, seed: 17 };
    const w = buildWall(wallParamsSchema.parse(doc), r, { id: "w" });
    const cut = prepareHeightPatch(heightPatchSchema.parse(w.ground), 2, h);
    const node = (x: number, z: number) => cut.apply(x, z, h(x, z));
    // the terrain as drawn: the 2 m lattice, interpolated between nodes
    const drawn = (x: number, z: number) => {
      const x0 = Math.floor(x / 2) * 2, z0 = Math.floor(z / 2) * 2, u = (x - x0) / 2, v = (z - z0) / 2;
      return (node(x0, z0) * (1 - u) + node(x0 + 2, z0) * u) * (1 - v) + (node(x0, z0 + 2) * (1 - u) + node(x0 + 2, z0 + 2) * u) * v;
    };
    // the landing on the z 15 leg (s 69..81: x -4 .. -1 then round the corner), bank side = toward the z 9 leg, out to
    // the parapet's outer face (half-width 1.8 + 0.45)
    let worst = -Infinity;
    for (let x = -4; x <= -1.5; x += 0.25) for (let z = 12.75; z <= 15; z += 0.25) worst = Math.max(worst, drawn(x, z) - 27.21);
    expect(worst).toBeLessThanOrEqual(0); // the ground stays under the landing's deck (the parapet stands on it, no wedge)
    // ... and the leg above still stands in its ground: its body reaches below the lowered bank on its downhill face
    const { mesh } = bake(doc, r);
    let foot = Infinity;
    for (const g of mesh.groups) for (let i = 0; i < g.positions.length; i += 3) {
      const x = g.positions[i]! + w.at[0], z = g.positions[i + 2]! + w.at[1];
      if (x > -6 && x < -2 && z > 10 && z < 11.5) foot = Math.min(foot, g.positions[i + 1]!);
    }
    expect(foot).toBeLessThan(drawn(-4, 11) - 0.3);
  });
});

/** The bake as the zfight tool sees it: one draw per role (each role its own material). */
function zfights(groups: BuiltGroup[]) {
  const meshes: ZFightMesh[] = groups.map((g) => {
    const soup = new Float32Array(g.indices.length * 3);
    for (let t = 0; t < g.indices.length; t++) soup.set(g.positions.subarray(g.indices[t]! * 3, g.indices[t]! * 3 + 3), t * 3);
    return { id: g.role, positions: soup };
  });
  return findZFights(meshes).clusters;
}
const fmt = (cs: ReturnType<typeof zfights>) => cs.slice(0, 8).map((c) => `${c.a.mesh}|${c.b.mesh} ${c.area.toFixed(3)} m2 gap ${c.gap.toFixed(3)} at ${c.centre.map((v) => v.toFixed(1)).join(",")} n ${c.normal.map((v) => v.toFixed(2)).join(",")}`);

describe("wall operator: one mesh owns each plane", { timeout: 60_000 }, () => {
  it("no coplanar tread/coping faces on ramps with parapets, kerbs, flights, corners and a switchback", () => {
    const flat = reader(() => 10);
    const cases: [string, Record<string, unknown>, OperatorFieldReader][] = [
      ["straight ramp, parapet one side, kerb the other", { variant: "ramp", points: [[0, 0], [60, 0], [80, 0]], thickness: 4, ramp: { levels: [{ at: 0 }, { at: 60, y: 18 }, { at: "end", y: 30 }], riser: 0.3 }, parapet: { side: "face" } }, reader((x) => 10 + Math.max(0, x) * 0.1)],
      ["kerbs only", { variant: "ramp", points: [[0, 0], [40, 0]], thickness: 3, ramp: { levels: [{ at: 0, y: 10.05 }, { at: 20, y: 11 }, { at: "end", y: 18 }], riser: 0.3 } }, flat],
      ["switchback, parapets both sides", { variant: "ramp", points: [[0, 0], [24, 0], [24, 6], [0, 6]], smooth: false, thickness: 2.4, ramp: { levels: [{ at: 0, y: 10.05 }, { at: 24, y: 18 }, { at: 30, y: 18 }, { at: "end", y: 26 }], maxGrade: 0.2, riser: 0.3 }, parapet: { side: "both", height: 1, thickness: 0.4 } }, flat],
      ["weeping stair (switchbacks, jittered width, footing)", { variant: "ramp", points: [[0, 0], [0, 9], [-29, 9], [-29, 15], [-1, 15], [-1, 21], [-29, 21], [-29, 24]], smooth: false, thickness: 3.6, batter: 0.02, ramp: { levels: [{ at: 0, y: 54.88 }, { at: 12, y: 54.88 }, { at: 35, y: 40.74 }, { at: 47, y: 40.74 }, { at: 69, y: 27.21 }, { at: 81, y: 27.21 }, { at: 103, y: 13.68 }, { at: "end", y: 13.68 }], maxGrade: 0.12, riser: 0.3, stairGrade: 0.6, deck: 0.35 }, parapet: { side: "both", height: 1, thickness: 0.45 }, seed: 17 }, flat],
      ["ramp with a smooth bend and footing, giant", { variant: "ramp", scale: "giant", points: [[0, 0], [30, 0], [50, 20]], thickness: 6, batter: 0.1, ramp: { levels: [{ at: 0, y: 10.05 }, { at: 30, y: 24 }, { at: "end", y: 26 }], riser: 0.3 }, parapet: { side: "back", height: 1, thickness: 0.7 } }, flat],
    ];
    const bad: string[] = [];
    for (const [name, doc, r] of cases) { const cs = zfights(bake(doc, r).mesh.groups); if (cs.length) bad.push(`${name}: ${cs.length} clusters`, ...fmt(cs)); }
    expect(bad).toEqual([]);
  });
  it("no coplanar faces on free / retaining / quay walls with coping, footing, buttresses, crenels, stairs, piers and gates", () => {
    const flat = reader(() => 10);
    const cases: [string, Record<string, unknown>, OperatorFieldReader][] = [
      ["free wall: coping, footing, buttresses both sides, crenellated parapet both sides, pier ends", { points: [[-20, 0], [20, 0]], height: 5, thickness: 1.6, buttresses: { every: 8, side: "both" }, parapet: { side: "both", crenels: {} }, ends: { start: "pier", end: "none" } }, flat],
      ["town wall into a hill (step mode, gate, stairs, piers)", { points: [[-30, -20], [0, -12], [20, 10]], height: 6, thickness: 2.2, heightMode: "step", face: "right", parapet: { side: "face", crenels: {} }, stairs: [{ from: 4, to: 20, side: "back" }], buttresses: { every: 10 }, ends: { start: "pier", end: "terrain" }, openings: [{ name: "gate", at: 28, width: 3.2, height: 4.2 }] }, reader()],
      ["retaining wall, sharp corners, parapet on the back, buttresses", { variant: "retaining", points: [[-20, 0], [0, 0], [0, 14], [16, 20]], smooth: false, height: 5, thickness: 1.2, batter: 0.1, face: "right", buttresses: { every: 7 }, parapet: { side: "back" }, ends: { start: "none", end: "pier" } }, flat],
      ["quay with coping and a deep footing, giant", { variant: "quay", scale: "giant", points: [[-30, 0], [0, 4], [30, 0]], height: 3, thickness: 3, face: "left", buttresses: { every: 12 } }, reader(() => -2)],
      ["closed ring with a crenellated walk", { points: [[0, 0], [24, 0], [24, 16], [0, 16], [0, 0]], smooth: false, height: 6, thickness: 2, parapet: { side: "both", crenels: {} } }, flat],
    ];
    const bad: string[] = [];
    for (const [name, doc, r] of cases) { const cs = zfights(bake(doc, r).mesh.groups); if (cs.length) bad.push(`${name}: ${cs.length} clusters`, ...fmt(cs)); }
    expect(bad).toEqual([]);
  });
});

describe("wall operator: material variants", { timeout: 60_000 }, () => {
  const area = (g: BuiltGroup) => { let a = 0; for (let t = 0; t < g.indices.length; t += 3) { const [p, q, r] = [0, 1, 2].map((e) => Array.from(g.positions.subarray(g.indices[t + e]! * 3, g.indices[t + e]! * 3 + 3))) as [number[], number[], number[]]; const u = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!], w = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!]; a += Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2; } return a; };
  it("a role given a LIST alternates its variants in equal bands (roles <role>~k, materials expanded, closed solids, no coplanar faces)", () => {
    const flat = reader(() => 10);
    const cases: [string, Record<string, unknown>, OperatorFieldReader, string[]][] = [
      ["giant retaining wall round sharp corners", { variant: "retaining", scale: "giant", points: [[-40, 0], [0, 0], [0, 30], [30, 40]], smooth: false, height: 12, thickness: 4, batter: 0.08, face: "right", buttresses: { every: 14 }, materials: { face: ["a", "b", "c"], cap: ["k1", "k2"], buttress: ["b1", "b2"] }, materialBand: 10 }, flat, ["face", "cap", "buttress"]],
      ["ramp with flights, parapets and footing", { variant: "ramp", scale: "giant", points: [[0, 0], [40, 0], [80, 10]], thickness: 6, batter: 0.1, ramp: { levels: [{ at: 0, y: 10.05 }, { at: 40, y: 30 }, { at: "end", y: 34 }], riser: 0.3, stairGrade: 0.8 }, parapet: { side: "both", height: 1, thickness: 0.7 }, materials: { face: "f", deck: ["d1", "d2", "d3"], parapet: ["p1", "p2"] }, materialBand: 8 }, reader((x) => 10 + Math.max(0, x) * 0.1), ["deck", "parapet"]],
    ];
    const bad: string[] = [];
    for (const [name, doc, r, roles] of cases) {
      const { p, mesh } = bake(doc, r);
      const lists = doc.materials as Record<string, string | string[]>;
      for (const role of roles) {
        const list = lists[role] as string[];
        list.forEach((id, k) => expect(p.materials[k ? `${role}~${k + 1}` : role]).toBe(id));
        const areas = list.map((_, k) => mesh.groups.filter((g) => g.role === (k ? `${role}~${k + 1}` : role)).reduce((s, g) => s + area(g), 0));
        if (areas.some((a) => a <= 0)) bad.push(`${name}: ${role} variant without geometry ${areas.map((a) => a.toFixed(0)).join("/")}`);
        else if (role !== "buttress" && Math.max(...areas) > 2 * Math.min(...areas)) bad.push(`${name}: ${role} variants unbalanced ${areas.map((a) => a.toFixed(0)).join("/")}`);
      }
      const cs = zfights(mesh.groups); if (cs.length) bad.push(`${name}: ${cs.length} clusters`, ...fmt(cs));
    }
    expect(bad).toEqual([]);
    // a single string still maps one role
    expect(wallLandmarkParams({ points: [[0, 0], [10, 0]], materials: { face: "x" } }, flat, { id: "w" }).materials).toMatchObject({ face: "x", cap: "x", footing: "x" });
  });
});

describe("wall operator: a flight from the line's end with a cut", { timeout: 60_000 }, () => {
  it("the cut ground at the line's end stays within a step (<= 0.4 m) of the first tread", () => {
    // a stair straight up from a flat floor (y 10) onto a 0.6 m/m bank: the flight starts AT the line's end. The cut's end
    // ramp was 2 lattice cells long from the very end node, so the tent-filtered ground at the foot sank ~0.2 m under the
    // floor and the first riser was 0.5 m (Ironspur stair foot, 2900,146,-838)
    const h = (x: number, _z: number) => 10 + 0.6 * Math.max(0, x);
    const r = reader(h);
    const doc = { variant: "ramp", scale: "giant", points: [[0.01, 0], [30, 0]], thickness: 8, batter: 0.1, ramp: { levels: [{ at: 0, y: 10.05 }, { at: "end", y: 28.05 }], maxGrade: 0.35, riser: 0.3, stairGrade: 0.7, cut: { feather: 4 } }, parapet: { side: "both", height: 1, thickness: 0.8 } };
    const w = buildWall(wallParamsSchema.parse(doc), r, { id: "w" });
    const cut = prepareHeightPatch(heightPatchSchema.parse(w.ground), 2, h);
    const node = (x: number, z: number) => cut.apply(x, z, h(x, z));
    const drawn = (x: number, z: number) => {
      const x0 = Math.floor(x / 2) * 2, z0 = Math.floor(z / 2) * 2, u = (x - x0) / 2, v = (z - z0) / 2;
      return (node(x0, z0) * (1 - u) + node(x0 + 2, z0) * u) * (1 - v) + (node(x0, z0 + 2) * (1 - u) + node(x0 + 2, z0 + 2) * u) * v;
    };
    const { mesh } = bake(doc, r);
    let worst = 0;
    for (const z of [-2, 0, 2]) {
      const tread = topAt(mesh.groups, 0.25 - w.at[0], z - w.at[1])!; // the first tread's top
      for (let x = -1; x <= 0; x += 0.25) worst = Math.max(worst, tread - drawn(x, z));
    }
    expect(worst).toBeLessThanOrEqual(0.4);
  });
});

describe("wall operator: a switchback ramp's tall faces", { timeout: 60_000 }, () => {
  const verts = (gs: BuiltGroup[], at: [number, number]): [number, number, number][] => gs.flatMap((g) => Array.from({ length: g.positions.length / 3 }, (_, i): [number, number, number] => [g.positions[i * 3]! + at[0], g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]! + at[1]]));
  it("buttresses stand on the sides only where the face is >= minHeight, never reach the other leg, no coplanar faces", () => {
    const flat = reader(() => 10);
    // legs at z 0 and z 4.6 (2.4 m decks: a 2.2 m gap less the batter, under a 1.2 m buttress each side), the deck climbing
    // 18 m: tall faces on the upper half. every 6: leg 1 buttresses at x 3, 9, ...; leg 2 (s 34.6 + ...) at x 25.6, 19.6, ...
    const doc = { variant: "ramp", points: [[0, 0], [30, 0], [30, 4.6], [0, 4.6]], smooth: false, thickness: 2.4, ramp: { levels: [{ at: 0, y: 10.05 }, { at: 30, y: 19 }, { at: 34.6, y: 19 }, { at: "end", y: 28 }], maxGrade: 0.2, riser: 0.3 },
      parapet: { side: "both", height: 1, thickness: 0.4 }, buttresses: { every: 6, depth: 1.2, side: "both", minHeight: 3 } };
    const w = buildWall(wallParamsSchema.parse(doc), flat, { id: "w" });
    const { mesh } = bake(doc, flat);
    const v = verts(mesh.groups.filter((g) => g.role === "buttress"), w.at);
    expect(v.length).toBeGreaterThan(0);
    const leg1 = v.filter(([x]) => [3, 9, 15, 21, 27].some((a) => Math.abs(x - a) < 0.7)), leg2 = v.filter(([x]) => [25.6, 19.6, 13.6, 7.6, 1.6].some((a) => Math.abs(x - a) < 0.7));
    expect(leg1.length + leg2.length).toBe(v.length);
    // a buttress never reaches into the other leg (its top-face line: leg 2 at z 3.4, leg 1 at z 1.2)
    expect(leg1.filter(([, , z]) => z > 0 && z >= 3.4)).toEqual([]);
    expect(leg2.filter(([, , z]) => z < 4.6 && z <= 1.2)).toEqual([]);
    // where the face is under 3 m (leg 1 at x 3: the deck ~1 m up) there is none
    expect(leg1.filter(([x]) => Math.abs(x - 3) < 0.7)).toEqual([]);
    expect(leg1.filter(([x, , z]) => Math.abs(x - 21) < 0.7 && z < -1.2).length).toBeGreaterThan(0); // the open outer face of leg 1 has them
    expect(zfights(mesh.groups).length).toBe(0);
  });
  it("blind arches span neighbouring buttresses in rows (a set-back course each), stand out of the face, no coplanar faces", () => {
    const flat = reader(() => 10);
    const base = { variant: "ramp", points: [[0, 0], [30, 0], [30, 4.6], [0, 4.6]], smooth: false, thickness: 2.4, ramp: { levels: [{ at: 0, y: 10.05 }, { at: 30, y: 19 }, { at: 34.6, y: 19 }, { at: "end", y: 28 }], maxGrade: 0.2, riser: 0.3 },
      parapet: { side: "both", height: 1, thickness: 0.4 } };
    const bt = { every: 5, depth: 1.4, width: 1.2, taper: 0.45, side: "both", minHeight: 3 };
    const plain = buildWall(wallParamsSchema.parse({ ...base, buttresses: bt }), flat, { id: "w" });
    const doc = { ...base, buttresses: { ...bt, arches: { tier: 5, band: 0.5, projection: 0.5 } } };
    const w = buildWall(wallParamsSchema.parse(doc), flat, { id: "w" });
    const tb = w.report.buttresses as { built: number; arches: number }, tp = plain.report.buttresses as { built: number; arches: number };
    expect(tb.built).toBe(tp.built); // the arches never change the buttresses
    expect(tp.arches).toBe(0);
    expect(tb.arches).toBeGreaterThan(2);
    const { mesh } = bake(doc, flat);
    const vA = verts(mesh.groups.filter((g) => g.role === "buttress"), w.at), vP = verts(bake({ ...base, buttresses: bt }, flat).mesh.groups.filter((g) => g.role === "buttress"), w.at);
    expect(vA.length).toBeGreaterThan(vP.length);
    // a crown (between two buttresses, mid-bay) stands out of leg 2's outer face (z > 4.6 + half thickness)
    expect(vA.some(([x, , z]) => z > 4.6 + 1.2 + 0.3 && vP.every(([px]) => Math.abs(px - x) > 0.7))).toBe(true);
    expect(zfights(mesh.groups).length).toBe(0);
  });
  it("materialBand `leg`: one variant per built leg (a landing keeps the leg before it's), materialOffset shifts the cycle", () => {
    const flat = reader(() => 10);
    const doc = (offset: number) => ({ variant: "ramp", points: [[0, 0], [24, 0], [24, 6], [0, 6]], smooth: false, thickness: 2.4, ramp: { levels: [{ at: 0, y: 10.05 }, { at: 24, y: 18 }, { at: 30, y: 18 }, { at: "end", y: 26 }], maxGrade: 0.2, riser: 0.3 },
      parapet: { side: "both", height: 1, thickness: 0.4 }, materials: { face: ["a", "b", "c"] }, materialBand: "leg", materialOffset: offset });
    const zOf = (gs: BuiltGroup[]): [number, number] => { const zs = gs.flatMap((g) => Array.from({ length: g.positions.length / 3 }, (_, i) => g.positions[i * 3 + 2]!)); return [Math.min(...zs), Math.max(...zs)]; };
    const { mesh, p } = bake(doc(0));
    const roles = new Set(mesh.groups.map((g) => g.role));
    expect(roles.has("face") && roles.has("face~2")).toBe(true);
    expect(roles.has("face~3")).toBe(false); // two long legs, the landing keeps the first's
    expect(p.materials).toMatchObject({ face: "a", "face~2": "b", "face~3": "c" });
    const w = buildWall(wallParamsSchema.parse(doc(0)), flat, { id: "w" });
    const [a0, a1] = zOf(mesh.groups.filter((g) => g.role === "face")), [b0] = zOf(mesh.groups.filter((g) => g.role === "face~2"));
    expect(a0 + w.at[1]).toBeLessThan(0); expect(a1 + w.at[1]).toBeGreaterThan(5); // leg 1 + its landing
    expect(b0 + w.at[1]).toBeGreaterThan(3); // leg 2 only
    const shifted = new Set(bake(doc(1)).mesh.groups.map((g) => g.role));
    expect(shifted.has("face~2") && shifted.has("face~3") && !shifted.has("face")).toBe(true);
    expect(zfights(mesh.groups).length).toBe(0);
  });
});

/** UV stretch of one triangle: the ratio of the two singular values of its world-to-UV map (1 = square texels). */
function stretchOf(p: number[][], uv: number[][]): number {
  const e1 = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!], e2 = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];
  const l1 = Math.hypot(...e1), n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
  const ax = e1.map((v) => v / l1), ay = [n[1]! * ax[2]! - n[2]! * ax[1]!, n[2]! * ax[0]! - n[0]! * ax[2]!, n[0]! * ax[1]! - n[1]! * ax[0]!], ly = Math.hypot(...ay);
  const by = ay.map((v) => v / ly), dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  // world in-plane coords P (2x2) and UV deltas Q (2x2): J = Q P^-1
  const P = [[l1, dot(e2, ax)], [0, dot(e2, by)]], Q = [[uv[1]![0]! - uv[0]![0]!, uv[2]![0]! - uv[0]![0]!], [uv[1]![1]! - uv[0]![1]!, uv[2]![1]! - uv[0]![1]!]];
  const det = P[0]![0]! * P[1]![1]! - P[0]![1]! * P[1]![0]!;
  if (Math.abs(det) < 1e-9) return 1;
  const Pi = [[P[1]![1]! / det, -P[0]![1]! / det], [-P[1]![0]! / det, P[0]![0]! / det]];
  const J = [[Q[0]![0]! * Pi[0]![0]! + Q[0]![1]! * Pi[1]![0]!, Q[0]![0]! * Pi[0]![1]! + Q[0]![1]! * Pi[1]![1]!], [Q[1]![0]! * Pi[0]![0]! + Q[1]![1]! * Pi[1]![0]!, Q[1]![0]! * Pi[0]![1]! + Q[1]![1]! * Pi[1]![1]!]];
  const a = J[0]![0]! ** 2 + J[1]![0]! ** 2, b = J[0]![0]! * J[0]![1]! + J[1]![0]! * J[1]![1]!, c = J[0]![1]! ** 2 + J[1]![1]! ** 2;
  const tr = a + c, disc = Math.sqrt(Math.max(0, ((a - c) / 2) ** 2 + b * b)), s1 = tr / 2 + disc, s2 = tr / 2 - disc;
  return s2 > 1e-12 ? Math.sqrt(s1 / s2) : Infinity;
}

describe("wall UVs on every face (owner walk 2026-10-21: the kirkyard wall's coping read stretched)", () => {
  const flat = reader(() => 10);
  const cases: [string, Record<string, unknown>][] = [
    ["a square kirkyard ring", { points: [[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]], height: 1.8, thickness: 0.8, smooth: false }],
    // LANDMARKS 2026-10-21: a keep's 45 deg mitres (shared planes of its legs) were laid u = -n, 22% of its face area stretched
    ["a thick tall square keep", { points: ([[-7, -7], [7, -7], [7, 7], [-7, 7], [-7, -7]] as [number, number][]).map(([x, z]) => [x * Math.cos(0.58) - z * Math.sin(0.58), x * Math.sin(0.58) + z * Math.cos(0.58)]), height: 20, thickness: 2.5, smooth: false, heightMode: "level", topY: 30 }],
    // LANDMARKS 2026-10-21: inside-corner faces turned in plan (a quad clamped onto the mitre) were developed point by
    // point: 8-38:1 on a battered gatehouse and keep with arched gates
    ["a battered gatehouse with two arched gates", { points: [[-3.5, -3.5], [-3.5, 3.5], [3.5, 3.5], [3.5, -3.5], [-3.5, -3.5]], height: 14, thickness: 1.8, smooth: false, heightMode: "level", topY: 24, bury: 1.1, batter: 0.02, parapet: { height: 1.1, thickness: 0.45, side: "both", crenels: { merlon: 1.4, gap: 0.8, height: 0.7 }, walked: false }, openings: [{ name: "a", at: 3.5, width: 3.2, height: 5, arch: true }, { name: "b", at: 17.5, width: 3.2, height: 5, arch: true }] }],
    ["a battered keep with an arched door", { points: [[-7, -7], [-7, 7], [7, 7], [7, -7], [-7, -7]], height: 24, thickness: 2.5, smooth: false, heightMode: "level", topY: 34, bury: 1.1, batter: 0.02, parapet: { height: 1.1, thickness: 0.45, side: "both", crenels: { merlon: 1.4, gap: 0.8, height: 0.7 }, walked: false }, openings: [{ name: "door", at: 35, width: 3, height: 4.5, arch: true }] }],
    ["a 16-sided turret", { points: Array.from({ length: 17 }, (_, i) => [2.6 * Math.cos((i * Math.PI) / 8), 2.6 * Math.sin((i * Math.PI) / 8)]), height: 9, thickness: 1.2, smooth: false }],
  ];
  for (const [what, doc] of cases)
    it(`${what}: caps and tops are laid square (no shear from the developed length), every face within 1.3:1`, () => {
      const { mesh } = bake(doc, flat);
      let area = 0, bad = 0, topWorst = 1, worst = 1;
      for (const g of mesh.groups)
        for (let t = 0; t < g.indices.length; t += 3) {
          const ix = [0, 1, 2].map((e) => g.indices[t + e]!);
          const p = ix.map((i) => [g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!]), uv = ix.map((i) => [g.uvs[i * 2]!, g.uvs[i * 2 + 1]!]);
          const e1 = p[1]!.map((v, k) => v - p[0]![k]!), e2 = p[2]!.map((v, k) => v - p[0]![k]!);
          const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!], A = Math.hypot(...n) / 2;
          if (A < 1e-6) continue;
          const k = stretchOf(p, uv);
          area += A;
          if (k > 1.3) bad += A;
          worst = Math.max(worst, k);
          if (g.role === "cap" && Math.abs(n[1]!) / (2 * A) > 0.9) topWorst = Math.max(topWorst, k);
        }
      expect(topWorst).toBeLessThan(1.05);
      expect(bad / area).toBeLessThan(0.02);
      if (/battered/.test(what)) expect(worst).toBeLessThan(1.5); // no sheared face at all (a 45 deg merlon bevel reads 1.41)
    });
});

describe("a crenellated top seen, not walked (LANDMARKS 2026-10-21: keep and tower tops no stair reaches)", () => {
  it("a walked parapet declares the walk-mid reach target; walked: false declares none", () => {
    const r = reader(() => 10);
    const doc = { points: [[-10, 0], [10, 0]], height: 8, thickness: 2, smooth: false, parapet: { side: "both", crenels: {} } };
    expect(buildWall(doc, r, { id: "a" }).deckTargets.some((t) => t.name === "walk-mid")).toBe(true);
    expect(buildWall({ ...doc, parapet: { ...doc.parapet, walked: false } }, r, { id: "b" }).deckTargets.some((t) => t.name === "walk-mid")).toBe(false);
  });
});
