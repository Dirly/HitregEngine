import { describe, expect, it } from "vitest";
import {
  auditVoxelMesh,
  buildVoxelMesh,
  createWorldField,
  defaultWorldRecipe,
  dcRiserSchema,
  resolveCellMesher,
  voxelChunkDoc,
  worldRecipeSchema,
  type SampleBlockExact,
  type WorldField,
} from "../src/index.js";

/** The default world with one DC riser: a 40 m top edge running +X (shelf to the north, low side south), 6 m drop. */
function riserWorld(riser: Record<string, unknown> = {}, surfaces = false) {
  const base = worldRecipeSchema.parse(defaultWorldRecipe());
  const plain = createWorldField(base);
  const C = base.cellSize;
  // the middle of a cell, so the riser's band stays within a 3 x 3 block of cells
  const x = 4 * C + C / 2, z = 4 * C + C / 2, h = plain.height(x, z);
  const doc = dcRiserSchema.parse({ id: "r", points: [[x - 20, z], [x + 20, z]], top: Math.round(h) + 3, foot: Math.round(h) - 3, ...riser });
  const recipe = worldRecipeSchema.parse({
    ...base,
    ...(surfaces ? { surfaces: [...base.surfaces, { name: "riser-rubble", color: "#77736b" }, { name: "riser-damp", color: "#3f4433" }, { name: "riser-top", color: "#a9a59c" }] } : {}),
    features: { ...base.features, dcRisers: [doc] },
  });
  return { field: createWorldField(recipe), doc, x, z, C, plain };
}

/** Highest mesh surface at world (x, z) among the cell's triangles (the collider is this mesh). */
function meshTop(field: WorldField, cx: number, cz: number, x: number, z: number): number | null {
  const C = field.recipe.cellSize;
  const m = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, cz], mesher: "auto" });
  const lx = x - cx * C, lz = z - cz * C;
  let best: number | null = null;
  for (let t = 0; t < m.indices.length; t += 3) {
    const v = [0, 1, 2].map((e) => { const i = m.indices[t + e]! * 3; return [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!] as const; });
    const [a, b, c] = v as unknown as [readonly number[], readonly number[], readonly number[]];
    const d = (b[2]! - c[2]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[2]! - c[2]!);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((b[2]! - c[2]!) * (lx - c[0]!) + (c[0]! - b[0]!) * (lz - c[2]!)) / d, l2 = ((c[2]! - a[2]!) * (lx - c[0]!) + (a[0]! - c[0]!) * (lz - c[2]!)) / d, l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const y = l1 * a[1]! + l2 * b[1]! + l3 * c[1]!;
    if (best === null || y > best) best = y;
  }
  return best;
}

const smooth = { rough: { depth: 0, lean: 0, joint: 0, stepShare: 0, dropShare: 0 } };

describe("DC risers: the field", () => {
  const { field, doc, x, z, C } = riserWorld(smooth);

  it("owns its band: shelf at top behind the edge, foot in front, a battered face between (height = density)", () => {
    expect(field.height(x, z - 1.5)).toBeCloseTo(doc.top, 3);
    // the face: 6 m at batter 0.12 runs 0.72 m out; the apron is held at the foot
    expect(field.height(x, z + 1.5)).toBeCloseTo(doc.foot, 3);
    expect(field.height(x, z + 0.36)).toBeCloseTo(doc.top - 3, 1);
    // the public ground and the density agree (placement reads the same surface the mesher builds)
    for (const dz of [-1.5, 0.3, 1.5]) expect(field.ground(x, z + dz)).toBeCloseTo(field.height(x, z + dz), 1);
    expect(field.planarNear(x, z)).toBe(true);
    expect(field.carveSpan(x - 1, z - 1, x + 1, z + 1)).not.toBeNull();
  });

  it("agrees with the point query at every sample and hands the dual mesher exact data on the riser", () => {
    const step = field.voxelSize;
    const ox = Math.floor((x - 12) / step) * step, oz = Math.floor((z - 10) / step) * step, oy = Math.floor((doc.foot - 8) / step) * step;
    const nx = 13, ny = 12, nz = 11;
    const exact: SampleBlockExact = {};
    const values = field.sampleBlock({ origin: [ox, oy, oz], nx, ny, nz, step }, exact);
    expect(exact.hermite).toBeDefined();
    expect(exact.active!.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
    let worst = 0, worstHermite = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const idx = i + j * nx + k * nx * ny, px = ox + i * step, py = oy + j * step, pz = oz + k * step;
      worst = Math.max(worst, Math.abs(field.density(px, py, pz) - values[idx]!));
      if (exact.active![idx]) worstHermite = Math.max(worstHermite, Math.abs(exact.hermite!.value(px, py, pz) - values[idx]!));
    }
    expect(worst).toBeLessThan(1e-3);
    expect(worstHermite).toBeLessThan(1e-4);
  });

  it("the auto mesher builds the riser's cells with DC and the far cells with MC", () => {
    const cx = Math.floor(x / C), cz = Math.floor(z / C);
    expect(resolveCellMesher(field, cx, cz, "auto")).toBe("dc");
    expect(resolveCellMesher(field, cx + 6, cz + 6, "auto")).toBe("mc");
    const docOut = voxelChunkDoc(field, "w", cx, cz, { mesher: "auto", scatter: false });
    expect((docOut.entities["terrain"]!.components["mesh"] as { source: { mesher?: string } }).source.mesher).toBe("dc");
  });

  it("renders and collides as one surface: the mesh top matches height() on the shelf, face and foot", () => {
    const cx = Math.floor(x / C), cz = Math.floor(z / C);
    for (const [dx, dz] of [[-6, -1.5], [4, -1.2], [0, 1.6], [7, 2.5], [-9, 1.8]] as const) {
      const top = meshTop(field, cx, cz, x + dx, z + dz)!;
      expect(top).not.toBeNull();
      expect(Math.abs(top - field.height(x + dx, z + dz))).toBeLessThan(0.35);
    }
    // the face is sharp: 0.6 m behind the edge is the shelf, 0.6 m past the foot is the foot (no 2 m lattice ramp)
    expect(meshTop(field, cx, cz, x, z - 0.6)!).toBeGreaterThan(doc.top - 0.35);
    expect(meshTop(field, cx, cz, x, z + 0.72 + 0.6)!).toBeLessThan(doc.foot + 0.35);
  });

  it("is closed over its cells (no seam where riser meets shelf, slope or a neighbour); MC/DC borders only on smooth ground", () => {
    const cx = Math.floor(x / C), cz = Math.floor(z / C);
    // all DC: closed (no open edge anywhere, the riser meets shelf and slope in one surface)
    const dc = auditVoxelMesh(field, { cells: [cx - 1, cz - 1, cx + 1, cz + 1], mesher: "dc", worst: 0 });
    expect(dc.openEdges).toBe(0);
    expect(dc.bladeVertices).toBe(0);
    // as shipped (auto): open edges only on an MC/DC cell border, on smooth ground far from the riser, closed by the skirts
    const audit = auditVoxelMesh(field, { cells: [cx - 1, cz - 1, cx + 1, cz + 1], mesher: "auto", worst: 5000 });
    expect(audit.openAt.length).toBe(audit.openEdges);
    expect(audit.skirtExposed).toBe(0);
    expect(audit.bladeVertices).toBe(0);
    const mesherAt = (px: number, pz: number) => resolveCellMesher(field, Math.floor(px / C), Math.floor(pz / C), "auto");
    for (const [px, , pz] of audit.openAt) {
      const onX = Math.abs(px / C - Math.round(px / C)) < 1e-3, onZ = Math.abs(pz / C - Math.round(pz / C)) < 1e-3;
      expect(onX || onZ).toBe(true);
      const mixed = onZ ? mesherAt(px, pz - 1) !== mesherAt(px, pz + 1) : mesherAt(px - 1, pz) !== mesherAt(px + 1, pz);
      expect(mixed).toBe(true);
      expect(field.dcRiserIn(px, pz, px, pz)).toBe(false);
    }
  });

  it("dual cells meet their neighbour exactly on the shared plane across the riser", () => {
    const cx = Math.floor(x / C), cz = Math.floor(z / C);
    // the riser crosses x = (cx + 1) * C: compare the shared border's surface points
    const left = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, cz], mesher: "auto" });
    const right = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx + 1, cz], mesher: "auto" });
    const border = (m: typeof left, at: number): Set<string> => {
      const out = new Set<string>();
      for (let i = 0; i < m.vertexCount; i++) if (Math.abs(m.positions[i * 3]! - at) < 1e-4) out.add(`${m.positions[i * 3 + 1]!.toFixed(3)},${m.positions[i * 3 + 2]!.toFixed(3)}`);
      return out;
    };
    const a = border(left, C), b = border(right, 0);
    expect(a.size).toBeGreaterThan(4);
    let shared = 0;
    for (const k of a) if (b.has(k)) shared++;
    expect(shared / Math.min(a.size, b.size)).toBeGreaterThan(0.5);
  });
});

describe("DC risers: stepped, hand-made, painted", () => {
  it("benches: two faces with a flat planted tread between", () => {
    const { field, doc, x, z } = riserWorld({ ...smooth, steps: { tiers: 2, tread: 2.5 } });
    // tier 1 crest at the line, its face 3 m tall at 0.12 -> 0.36 m, then 2.5 m of tread at top - 3
    expect(field.height(x, z + 1.6)).toBeCloseTo(doc.top - 3, 3);
    expect(field.height(x, z + 4.8)).toBeCloseTo(doc.foot, 1);
  });

  it("rough: seeded panels, crest runs and dropped stones, bounded, deterministic", () => {
    const a = riserWorld({ seed: 3 }), b = riserWorld({ seed: 3 }), c = riserWorld({ seed: 4 });
    const crest = (f: WorldField, x: number, z: number) => Array.from({ length: 30 }, (_, i) => f.height(x - 15 + i, z - 0.5));
    expect(crest(a.field, a.x, a.z)).toEqual(crest(b.field, b.x, b.z));
    expect(crest(a.field, a.x, a.z)).not.toEqual(crest(c.field, c.x, c.z));
    // the crest is not one flat line: some runs step down, none more than 2 steps or a dropped stone
    const ys = crest(a.field, a.x, a.z);
    const top = a.doc.top;
    expect(ys.some((y) => y < top - 0.3)).toBe(true);
    expect(ys.every((y) => y >= top - Math.max(2 * a.doc.rough.step, a.doc.rough.drop) - 1e-6 && y <= top + 1e-6)).toBe(true);
    // the face: panels stand at different offsets (the 3 m-down contour moves along the run)
    const faceAt = (s: number) => { for (let n = -1; n < 3; n += 0.05) if (a.field.height(a.x + s, a.z + n) < top - 3) return n; return NaN; };
    const offs = [-15, -9, -3, 3, 9, 15].map(faceAt);
    expect(Math.max(...offs) - Math.min(...offs)).toBeGreaterThan(0.1);
  });

  it("paints the face with the named surfaces: damp foot band, body, weathered crest band", () => {
    const { field, doc, x, z } = riserWorld({ ...smooth, surfaces: { face: "riser-rubble", foot: "riser-damp", top: "riser-top" } }, true);
    const n = field.recipe.surfaces.length, out = new Float32Array(n);
    const idx = (name: string) => field.recipe.surfaces.findIndex((s) => s.name === name);
    const at = (y: number) => { field.splatAt(x, y, z + (doc.top - y) * doc.batter, 0, out, 0); return Array.from(out); };
    expect(at(doc.foot + 0.3)[idx("riser-damp")]).toBeGreaterThan(0.9);
    expect(at(doc.top - 3)[idx("riser-rubble")]).toBeGreaterThan(0.9);
    expect(at(doc.top - 0.3)[idx("riser-top")]).toBeGreaterThan(0.9);
  });

  it("leaves a world without dcRisers byte-identical", () => {
    const { plain, x, z } = riserWorld();
    const base = createWorldField(worldRecipeSchema.parse(defaultWorldRecipe()));
    const req = { origin: [x - 10, 0, z - 10] as [number, number, number], nx: 9, ny: 9, nz: 9, step: 2 };
    expect(Array.from(plain.sampleBlock(req))).toEqual(Array.from(base.sampleBlock(req)));
    expect(resolveCellMesher(plain, 4, 4, "auto")).toBe("mc");
  });
});
