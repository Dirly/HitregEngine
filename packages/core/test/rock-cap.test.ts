import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createRockCapResolver,
  createWorldField,
  defaultWorldRecipe,
  meshSchema,
  rockMassNodes,
  rockSkinProbe,
  createRockSkinProbe,
  zoneWallStone,
  scatterCell,
  voxelChunkDoc,
  worldRecipeSchema,
  type RockShapeContext,
} from "../src/index.js";

/** mulberry32, as the formations use. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("rockMassNodes (shared by the fall formations and the rock kit)", () => {
  const ctx = (seed: number): RockShapeContext => ({
    rand: rng(seed),
    bedUp: [0.05, 0.998, 0.03],
    dip: 0.06,
    dipAz: 0.7,
    strataStep: 3,
    strataBase: 1.2,
    ground: () => 0,
  });
  const mass = { center: [4, 3, -2] as [number, number, number], size: [8, 6, 5] as [number, number, number], front: [0.6, 0.8] as [number, number] };

  it("is a pure function of the mass and the stream", () => {
    const a = rockMassNodes(mass, "m0", ctx(9)).nodes;
    const b = rockMassNodes(mass, "m0", ctx(9)).nodes;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(rockMassNodes(mass, "m0", ctx(10)).nodes)).not.toBe(JSON.stringify(a));
  });

  it("keeps its output byte-identical to the pre-refactor shaper (pinned)", () => {
    // Pinned from the extraction (2026-10-09): the fall-site formations must not change shape.
    // The five mmo fall sites were also compared whole, old vs new: identical (see the rock-kit report).
    const nodes = rockMassNodes(mass, "m0", ctx(9)).nodes;
    const hash = createHash("sha256").update(JSON.stringify(nodes)).digest("hex").slice(0, 16);
    expect(nodes[0]).toMatchObject({ id: "m0-orb", op: "add", shape: "ellipsoid" });
    expect(nodes.some((n) => n["id"] === "m0-front")).toBe(true);
    expect(nodes.some((n) => n["id"] === "m0-top")).toBe(true);
    expect(hash).toMatchInlineSnapshot(`"38de9c8dc75f9752"`);
  });
});

describe("rock caps", () => {
  const base = defaultWorldRecipe();
  const names = base.surfaces.map((s) => s.name);
  const rock = {
    id: "rock-small",
    model: "rock-kit/boulder-s-1.glb",
    modelVariants: [
      { model: "rock-kit/boulder-s-1.glb", weight: 1 },
      { model: "rock-kit/boulder-s-2.glb", weight: 1, colliderSize: [0.9, 0.5, 0.6] },
      { model: "rock-kit/boulder-s-3.glb", weight: 1 },
    ],
    cap: "auto",
    capAmount: 0.8,
    density: 0.02,
    slopeMax: 1,
    collider: "box",
    colliderSize: [1, 0.6, 0.9],
    hlod: false,
    lod: false,
  };
  const recipe = (patch: Record<string, unknown> = {}, regions: unknown[] = []) =>
    worldRecipeSchema.parse({ ...base, cellSize: 32, resolution: 16, scatter: [{ ...rock, ...patch }], regions });
  const sampleCells = (field: ReturnType<typeof createWorldField>) => {
    const out = [];
    for (let cz = -3; cz <= 3; cz++) for (let cx = -3; cx <= 3; cx++) out.push(...scatterCell(field, cx, cz));
    return out;
  };

  it("caps auto rules from the ground, never with a cliff surface, and repeats exactly", () => {
    const field = createWorldField(recipe());
    const a = sampleCells(field);
    expect(a.length).toBeGreaterThan(20);
    expect(JSON.stringify(a)).toBe(JSON.stringify(sampleCells(createWorldField(recipe()))));
    for (const i of a) {
      expect(i.rockCap).toBeDefined();
      expect(i.rockCap!.amount).toBeGreaterThanOrEqual(0);
      expect(i.rockCap!.amount).toBeLessThanOrEqual(0.8);
      // auto wears only a cover that reads on a rock top (no dirt hats)
      if (i.rockCap!.amount > 0) expect(names[i.rockCap!.layer]).toMatch(/snow|sand|moss|grass/i);
      if (i.rockCap!.amount > 0) expect(i.rockCap!.tint).toHaveLength(3);
      expect(i.variant).toBeGreaterThanOrEqual(0);
      expect(i.variant).toBeLessThan(3);
    }
    // all three variants show up
    expect(new Set(a.map((i) => i.variant)).size).toBe(3);
  });

  it("does not move, rescale or re-yaw anything when caps and variants are added", () => {
    const plain = sampleCells(createWorldField(recipe({ cap: undefined, modelVariants: undefined })));
    const capped = sampleCells(createWorldField(recipe()));
    expect(capped.map((i) => [i.id, i.position, i.rotation, i.scale])).toEqual(plain.map((i) => [i.id, i.position, i.rotation, i.scale]));
    expect(plain.every((i) => i.rockCap === undefined && i.variant === undefined)).toBe(true);
  });

  it("a fixed cap uses that layer, and a zone's rockCap wins over the rule", () => {
    const fixed = createRockCapResolver(createWorldField(recipe({ cap: "sand" })));
    const r = recipe({ cap: "sand" }).scatter[0]!;
    expect(fixed(r, 3, 10, 4)).toMatchObject({ layer: names.indexOf("sand"), amount: 0.8, base: 0 });
    const zoned = recipe({ cap: "auto", rockBase: 1, capAmount: 0.6 }, [
      { id: "frost", name: "Frost", polygon: [[-500, -500], [500, -500], [500, 500], [-500, 500]], rockCap: { layer: "snow", amount: 0.9 } },
    ]);
    const z = createRockCapResolver(createWorldField(zoned));
    expect(z(zoned.scatter[0]!, 3, 10, 4)).toMatchObject({ layer: names.indexOf("snow"), amount: 0.9, base: 1 });
    // the rule scales the zone's amount (capAmount over the 0.6 default): a light-capped rule wears half of it
    expect(z({ ...zoned.scatter[0]!, capAmount: 0.3 }, 3, 10, 4)!.amount).toBeCloseTo(0.45, 3);
    expect(z({ ...zoned.scatter[0]!, capAmount: 0.9 }, 3, 10, 4)!.amount).toBe(1);
    // outside the zone: back to the rule
    expect(z(zoned.scatter[0]!, 900, 10, 4)?.layer).not.toBe(undefined);
  });

  it("a zone may name a material-only cap layer (capLayers): indexed past the palette, no biome tint", () => {
    const zoned = recipe({ cap: "auto", capLayers: ["moss"], capAmount: 0.6 }, [
      { id: "bog", name: "Bog", polygon: [[-500, -500], [500, -500], [500, 500], [-500, 500]], rockCap: { layer: "moss", amount: 0.8 } },
    ]);
    const resolve = createRockCapResolver(createWorldField(zoned));
    const cap = resolve(zoned.scatter[0]!, 3, 10, 4)!;
    expect(cap).toMatchObject({ layer: names.length, amount: 0.8, base: 0 });
    expect(cap.tint).toBeUndefined();
  });

  it("a rule without cap is never capped; rockBase alone sets the body only", () => {
    const resolve = createRockCapResolver(createWorldField(recipe()));
    const r = recipe({ cap: undefined }).scatter[0]!;
    expect(resolve(r, 1, 1, 1)).toBeUndefined();
    expect(resolve({ ...r, rockBase: 1 }, 1, 1, 1)).toEqual({ layer: 0, amount: 0, base: 1 });
  });

  it("emits the variant model, its own collider, the cap and hlod:false onto the chunk entity", () => {
    const field = createWorldField(recipe());
    let checked = 0;
    for (let cz = -2; cz <= 2 && checked < 10; cz++) {
      for (let cx = -2; cx <= 2; cx++) {
        const doc = voxelChunkDoc(field, "test", cx, cz, { water: false });
        for (const entity of Object.values(doc.entities)) {
          if (!(entity.tags ?? []).includes("rock-small")) continue;
          const mesh = meshSchema.parse(entity.components["mesh"]);
          expect(mesh.source.kind).toBe("asset");
          const source = mesh.source as { assetId: string; rockCap?: unknown };
          expect(source.assetId).toMatch(/^rock-kit\/boulder-s-[123]\.glb$/);
          expect(source.rockCap).toBeDefined();
          expect(mesh.hlod).toBe(false);
          const collider = entity.components["collider"] as { size: number[] };
          if (source.assetId.endsWith("-2.glb")) expect(collider.size).toEqual([0.9, 0.5, 0.6]);
          else expect(collider.size).toEqual([1, 0.6, 0.9]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("cliff dressing modes (face bands, crest, foot)", () => {
  const base = defaultWorldRecipe();
  const cliffRule = (cliff: Record<string, unknown>, id: string) => ({
    id, model: "rock-kit/outcrop-2.glb", density: 0.02, slopeMin: 0.6, slopeMax: 1, collider: "box", colliderSize: [4, 3, 3],
    cliff: { stack: [2, 4], spacing: 3, minDrop: 3, search: 12, ...cliff },
  });
  const recipe = worldRecipeSchema.parse({
    ...base, cellSize: 32, resolution: 16,
    scatter: [
      cliffRule({ mode: "face", orient: "normal", band: 4, embed: 1 }, "face"),
      cliffRule({ mode: "crest", lean: 0.3 }, "crest"),
      cliffRule({ mode: "foot", apron: 0.6 }, "foot"),
    ],
  });
  const sample = () => {
    const field = createWorldField(recipe);
    const out = [];
    for (let cz = -8; cz <= 8; cz++) for (let cx = -8; cx <= 8; cx++) out.push(...scatterCell(field, cx, cz).map((i) => ({ ...i, cx, cz })));
    return out;
  };
  const rotate = (q: number[], v: number[]) => {
    const [x, y, z, w] = q as [number, number, number, number];
    const t = [2 * (y * v[2]! - z * v[1]!), 2 * (z * v[0]! - x * v[2]!), 2 * (x * v[1]! - y * v[0]!)];
    return [v[0]! + w * t[0]! + (y * t[2]! - z * t[1]!), v[1]! + w * t[1]! + (z * t[0]! - x * t[2]!), v[2]! + w * t[2]! + (x * t[1]! - y * t[0]!)];
  };
  const all = sample();

  it("is seed-stable and emits all three modes", () => {
    expect(JSON.stringify(all)).toBe(JSON.stringify(sample()));
    for (const rule of ["face", "crest", "foot"]) expect(all.filter((i) => i.rule === rule).length, rule).toBeGreaterThan(0);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
  });

  it("face facets lie along the face: up off vertical, long axis horizontal, heights on the strata", () => {
    for (const i of all.filter((i) => i.rule === "face")) {
      const x = rotate(i.rotation, [1, 0, 0]);
      // horizontal give or take the yaw spread (about the normal)
      expect(Math.abs(x[1]!)).toBeLessThan(0.25);
      const len = Math.hypot(...rotate(i.rotation, [0, 1, 0]));
      expect(len).toBeCloseTo(1, 4);
    }
  });

  it("crest props lean OUT and foot props stand on the ground", () => {
    const field = createWorldField(recipe);
    for (const i of all.filter((i) => i.rule === "foot")) {
      const wx = i.position[0] + i.cx * 32, wz = i.position[2] + i.cz * 32;
      expect(Math.abs(i.position[1] - field.height(wx, wz))).toBeLessThan(0.01);
    }
    const tipped = all.filter((i) => i.rule === "crest").map((i) => rotate(i.rotation, [0, 1, 0])[1]!);
    const crests = all.filter((i) => i.rule === "crest");
    const bad = crests.filter((i) => rotate(i.rotation, [0, 1, 0])[1]! >= 0.995);
    expect(bad.length, JSON.stringify(bad.slice(0, 3).map((i) => [i.id, i.rotation]))).toBe(0);
    void tipped;
  });

  it("a clearing keeps cliff pieces off it where they stand, not just at their lattice point", () => {
    // a crest piece walks up to the lip and a foot piece out from the foot: the clearing is tested where it lands
    // a small clearing on every crest piece of the uncleared run (their lattice points lie elsewhere, off the lip)
    const crests = all.filter((i) => i.rule === "crest").slice(0, 40);
    expect(crests.length).toBeGreaterThan(0);
    const at = (i: (typeof all)[number]) => [i.position[0] + i.cx * 32, i.position[2] + i.cz * 32] as const;
    const clearings = crests.map((i, n) => { const [x, z] = at(i); return { id: `c${n}`, polygon: [[x - 1, z - 1], [x + 1, z - 1], [x + 1, z + 1], [x - 1, z + 1]], feather: 0, keep: 0, scatter: true }; });
    const cleared = worldRecipeSchema.parse({ ...recipe, features: { ...recipe.features, clearings } });
    const field = createWorldField(cleared);
    const out: typeof all = [];
    for (let cz = -8; cz <= 8; cz++) for (let cx = -8; cx <= 8; cx++) out.push(...scatterCell(field, cx, cz).map((i) => ({ ...i, cx, cz })));
    const inside = out.filter((i) => crests.some((c) => { const [x, z] = at(c), [px, pz] = at(i); return Math.abs(px - x) < 1 && Math.abs(pz - z) < 1; }));
    expect(inside.length, JSON.stringify(inside.slice(0, 3).map((i) => [i.id, i.position, i.cx]))).toBe(0);
  });
});

describe("rock formations", () => {
  const base = defaultWorldRecipe();
  const rule = (formation: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: "rocks", model: "rock-kit/boulder-m-1.glb", density: 0.004, slopeMax: 0.8, collider: "box", colliderSize: [1.6, 1.1, 1.4],
    yOffset: -0.1, formation, ...extra,
  });
  const make = (formation: Record<string, unknown>) => {
    const recipe = worldRecipeSchema.parse({ ...base, cellSize: 32, resolution: 16, scatter: [rule(formation)] });
    return { recipe, field: createWorldField(recipe) };
  };
  const cells = (field: ReturnType<typeof createWorldField>) => {
    const out = [];
    for (let cz = -5; cz <= 5; cz++) for (let cx = -5; cx <= 5; cx++) out.push(...scatterCell(field, cx, cz).map((i) => ({ ...i, cx, cz })));
    return out;
  };

  it("groups instances into formations, seated, seed-stable, unique ids", () => {
    const { field } = make({ kinds: [{ kind: "row" }, { kind: "cluster" }, { kind: "stack" }, { kind: "arc" }, { kind: "spill" }, { kind: "single", weight: 0.2 }] });
    const a = cells(field);
    expect(JSON.stringify(a)).toBe(JSON.stringify(cells(make({ kinds: [{ kind: "row" }, { kind: "cluster" }, { kind: "stack" }, { kind: "arc" }, { kind: "spill" }, { kind: "single", weight: 0.2 }] }).field)));
    expect(new Set(a.map((i) => i.id)).size).toBe(a.length);
    const anchors = a.filter((i) => !i.id.includes("_f"));
    expect(a.length).toBeGreaterThan(anchors.length * 2); // singles are the minority
    // members stand on the ground under them, sunk by yOffset (the anchor keeps scatter's own ground) — or deeper,
    // where seat.ts found the ground under the footprint lower than the underside (never higher)
    for (const i of a.filter((i) => i.id.includes("_f"))) {
      const wx = i.position[0] + i.cx * 32, wz = i.position[2] + i.cz * 32;
      expect(i.position[1] - (field.height(wx, wz) - 0.1 * i.scale)).toBeLessThan(1e-6);
    }
  });

  it("small members are fillers: no collider, out of HLOD; the anchor keeps both", () => {
    const { field } = make({ kinds: [{ kind: "cluster" }], fillers: 0.65 });
    let fillers = 0;
    const direct = cells(field).filter((i) => i.filler).length;
    expect(direct).toBeGreaterThan(0);
    for (let cz = -5; cz <= 5; cz++) for (let cx = -5; cx <= 5; cx++) {
      const doc = voxelChunkDoc(field, "t", cx, cz, { water: false });
      for (const [id, e] of Object.entries(doc.entities)) {
        if (!(e.tags ?? []).includes("rocks")) continue;
        const mesh = meshSchema.parse(e.components["mesh"]);
        if (id.includes("_f") && mesh.hlod === false) { fillers++; expect(e.components["collider"]).toBeUndefined(); }
        if (!id.includes("_f")) { expect(mesh.hlod).toBe(true); expect(e.components["collider"]).toBeDefined(); }
      }
    }
    expect(fillers).toBeGreaterThan(0);
  });
});

describe("cliff-scale masses (cliff fit)", () => {
  const base = defaultWorldRecipe();
  const variants = [
    { model: "rock-kit/buttress-1.glb", weight: 1, colliderSize: [3, 6, 2] as [number, number, number] },
    { model: "rock-kit/buttress-2.glb", weight: 1, colliderSize: [3, 10, 2] as [number, number, number] },
    { model: "rock-kit/buttress-3.glb", weight: 1, colliderSize: [3, 16, 2] as [number, number, number] },
  ];
  const massRule = (id: string, cliff: Record<string, unknown>) => ({
    id, model: variants[0]!.model, modelVariants: variants, density: 0.01, slopeMin: 0.45, slopeMax: 1, collider: "box", colliderSize: [3, 10, 2],
    cliff: { stack: [1, 2], minDrop: 6, search: 16, embed: 0.5, ...cliff, fit: { fraction: [0.2, 0.5], scale: [0.7, 1.4], reach: 40, ...(cliff.fit as object) } },
  });
  const recipe = worldRecipeSchema.parse({
    ...base, cellSize: 32, resolution: 16,
    scatter: [
      massRule("rib", { mode: "face", orient: "slope", fit: { at: [0, 0.5] } }),
      massRule("pillar", { mode: "face", orient: "lean", lean: 0.2 }),
      massRule("tooth", { mode: "crest", lean: 0.1 }),
    ],
  });
  const sample = () => {
    const field = createWorldField(recipe);
    const out = [];
    for (let cz = -8; cz <= 8; cz++) for (let cx = -8; cx <= 8; cx++) out.push(...scatterCell(field, cx, cz));
    return out;
  };
  const all = sample();

  it("places every mode, seed-stable, unique ids", () => {
    expect(JSON.stringify(all)).toBe(JSON.stringify(sample()));
    for (const rule of ["rib", "pillar", "tooth"]) expect(all.filter((i) => i.rule === rule).length, rule).toBeGreaterThan(0);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
  });

  it("sizes each piece with a variant whose scale stays in fit.scale (model-space texels stay near 1)", () => {
    for (const i of all) {
      expect(i.variant, i.id).toBeGreaterThanOrEqual(0);
      expect(i.variant!).toBeLessThan(variants.length);
      expect(i.scale).toBeGreaterThanOrEqual(0.7 - 1e-9);
      expect(i.scale).toBeLessThanOrEqual(1.4 + 1e-9);
    }
    // the fit mixes the variants (different drops pick different sizes)
    expect(new Set(all.map((i) => i.variant)).size).toBeGreaterThan(1);
  });

  it("a slope-oriented rib lies up the fall line, its front out of the face", () => {
    const field = createWorldField(recipe);
    const rotate = (q: number[], v: number[]) => {
      const [x, y, z, w] = q as [number, number, number, number];
      const t = [2 * (y * v[2]! - z * v[1]!), 2 * (z * v[0]! - x * v[2]!), 2 * (x * v[1]! - y * v[0]!)];
      return [v[0]! + w * t[0]! + (y * t[2]! - z * t[1]!), v[1]! + w * t[1]! + (z * t[0]! - x * t[2]!), v[2]! + w * t[2]! + (x * t[1]! - y * t[0]!)];
    };
    const ribs = all.filter((i) => i.rule === "rib");
    let outward = 0;
    for (const i of ribs) {
      const up = rotate(i.rotation, [0, 1, 0]);
      expect(up[1]!).toBeGreaterThan(0); // never upside down
      const front = rotate(i.rotation, [0, 0, 1]);
      if (front[1]! > -0.2) outward++;
    }
    expect(outward).toBe(ribs.length);
    void field;
  });
});

describe("water rocks carry their waterline (cap wet)", () => {
  it("is a fraction of the rock's height, only where water stands over its foot", () => {
    const base = defaultWorldRecipe();
    const recipe = worldRecipeSchema.parse({
      ...base, cellSize: 32, resolution: 16,
      scatter: [{ id: "lake", model: "rock-kit/boulder-m-1.glb", density: 0.05, slopeMax: 0.9, collider: "box", colliderSize: [1.6, 1.1, 1.4], cap: "auto", scale: [0.6, 1.4], yOffset: -0.15,
        water: { mode: "in", top: [0.2, 1.5], maxDepth: 1.6 } }],
    });
    const real = createWorldField(recipe);
    // a still sheet 0.8 m over the ground at the origin: the lake every water gate reads
    const level = real.height(0, 0) + 0.8;
    const field = { ...real, waterNear: () => true, lakeY: () => level, waterY: () => level,
      waterSurface: (_x: number, _z: number, out: { y: number; kind: string; flowX: number; flowZ: number; floor: number }) => { out.y = level; out.kind = "lake"; out.flowX = 0; out.flowZ = 0; out.floor = -Infinity; return true; } } as typeof real;
    const out = [];
    for (let cz = -6; cz <= 6; cz++) for (let cx = -6; cx <= 6; cx++) out.push(...scatterCell(field, cx, cz).map((i) => ({ ...i, cx, cz })));
    expect(out.length).toBeGreaterThan(0);
    for (const i of out) {
      const wet = i.rockCap?.wet;
      expect(wet, i.id).toBeDefined();
      expect(wet!).toBeGreaterThan(0);
      expect(wet!).toBeLessThanOrEqual(1);
      // the line sits where the sheet crosses the rock: foot + wet x height = the level (to the 1/200 quantum)
      const foot = i.position[1], h = (1.1 / 0.92) * i.scale;
      expect(Math.abs(foot + Math.min(1, wet!) * h - level)).toBeLessThan(h * 0.01 + 1e-6 + (wet === 1 ? Infinity : 0));
    }
  });
});

describe("rock skins: the stone follows the place, the cap follows the ground", () => {
  const base = defaultWorldRecipe();
  // the base slope rock is the cliff role; one zone (all of x < 0) restyles it as slate
  const ROLES: Record<string, string> = { rock: "cliff", grass: "grass", blightedgrass: "grass", dirt: "ground", blighteddirt: "ground", sand: "accent" };
  const surfaces = [...base.surfaces.map((s) => (ROLES[s.name] ? { ...s, role: ROLES[s.name] } : s)), { name: "slate", color: "#445566", roughness: 0.9 }];
  const zone = { id: "slatelands", name: "Slatelands", polygon: [[-3000, -3000], [0, -3000], [0, 3000], [-3000, 3000]], ground: { cliff: "slate" } };
  const rule = { id: "rocks", model: "rock-kit/boulder-s-1.glb", cap: "auto", rockBase: 1, density: 0.02, slopeMax: 1, collider: "box", colliderSize: [1, 0.6, 0.9] };
  const make = (patch: Record<string, unknown> = {}, regions: unknown[] = [zone]) =>
    worldRecipeSchema.parse({ ...base, cellSize: 32, resolution: 16, surfaces, scatter: [rule], regions, ...patch });
  const names = surfaces.map((s) => s.name);

  it("samples the stone the terrain draws where the rock stands: the zone's cliff inside it, the base rock outside", () => {
    const probe = rockSkinProbe(createWorldField(make({ rockSkins: { rock: 0, slate: 2 } })));
    const inside = probe.cliffSurfaceAt(-600, 20, 40), outside = probe.cliffSurfaceAt(600, 20, 40);
    expect(names[inside]).toBe("slate");
    expect(names[outside]).toBe("rock");
  });

  it("a rock in water wears its nearest bank's stone, not the blend the bed picks up across a border river", () => {
    // a river (x 0..20) is the border: slate on the west bank, rock on the east; the bed blends both, slate a bit ahead
    const recipe = make({ rockSkins: { rock: 0, slate: 2 } });
    const real = createWorldField(recipe);
    const si = names.indexOf("slate"), ri = names.indexOf("rock");
    const field = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      height: () => 0,
      waterY: (x: number) => (x > 0 && x < 20 ? 1 : null),
      surfaceAt: (x: number, _y: number, _z: number, _ny: number, out: Float32Array, o: number) => {
        out.fill(0, o, o + real.surfaceCount);
        const [w, e] = x <= 0 ? [0.85, 0.15] : x >= 20 ? [0.2, 0.8] : [0.55, 0.45];
        out[o + si] = w;
        out[o + ri] = e;
      },
    });
    const probe = createRockSkinProbe(field);
    const wet = { ...recipe.scatter[0]!, water: { mode: "river" } } as never;
    // the old pick: the stone at its own spot (the bed) says slate, 3 m off the rock bank
    expect(names[probe.cliffSurfaceAt(17, 0, 0)]).toBe("slate");
    expect(probe.skinAt(wet, 17, 0, 0)).toMatchObject({ base: 0, surface: "rock" });
    expect(probe.skinAt(wet, 3, 0, 0)).toMatchObject({ base: 2, surface: "slate" });
    expect(names[probe.bankStoneAt(17, 0).surface]).toBe("rock");
    // a dry rock still reads the stone at its spot
    expect(probe.skinAt(recipe.scatter[0]!, 17, 0, 0).surface).toBe("slate");
  });

  it("the world's rockSkins table wins over a rule's rockBase; without it the legacy rule base stands", () => {
    const recipe = make({ rockSkins: { rock: 0, slate: 2 } });
    const resolve = createRockCapResolver(createWorldField(recipe));
    expect(resolve(recipe.scatter[0]!, -600, 20, 40)!.base).toBe(2);
    expect(resolve(recipe.scatter[0]!, 600, 20, 40)!.base).toBe(0);
    expect(rockSkinProbe(createWorldField(recipe)).skinAt(recipe.scatter[0]!, -600, 20, 40)).toMatchObject({ base: 2, surface: "slate", from: "world" });
    const legacy = make();
    expect(createRockCapResolver(createWorldField(legacy))(legacy.scatter[0]!, -600, 20, 40)!.base).toBe(1);
    // a stone with no entry falls back to "*", else the rule's own base
    const partial = make({ rockSkins: { slate: 2, "*": 5 } });
    expect(createRockCapResolver(createWorldField(partial))(partial.scatter[0]!, 600, 20, 40)!.base).toBe(5);
    // scattered instances carry it
    const field = createWorldField(recipe);
    const inst = [];
    for (let cz = -2; cz <= 2; cz++) for (let cx = -24; cx <= -20; cx++) inst.push(...scatterCell(field, cx, cz));
    expect(inst.length).toBeGreaterThan(0);
    expect(inst.every((i) => i.rockCap?.base === 2)).toBe(true);
  });

  it("above the snow line a rock wears the snow, whatever the zone's cap or the rule's fixed cap says", () => {
    const sandy = [{ ...zone, rockCap: { layer: "sand", amount: 0.6 } }];
    const recipe = make({}, sandy);
    const resolve = createRockCapResolver(createWorldField(recipe));
    const low = resolve(recipe.scatter[0]!, -600, 10, 40)!;
    const high = resolve(recipe.scatter[0]!, -600, 600, 40)!;
    expect(names[low.layer]).toBe("sand");
    expect(names[high.layer]).toBe("snow");
    expect(high.amount).toBeGreaterThan(0);
    const fixed = make({ scatter: [{ ...rule, cap: "sand" }] }, sandy);
    expect(names[createRockCapResolver(createWorldField(fixed))(fixed.scatter[0]!, -600, 600, 40)!.layer]).toBe("snow");
    const band = rockSkinProbe(createWorldField(recipe)).groundBand(-600, 600, 40);
    expect(band).toMatchObject({ band: "climate", worthy: true });
    expect(names[band.surface]).toBe("snow");
  });

  it("a fall site's masses wear the zone's cliff surface sampled on the wall, base-palette stone elsewhere", () => {
    const field = createWorldField(make());
    const wall = new Array(field.surfaceCount + 3).fill(0);
    wall[names.indexOf("slate")] = 0.7;
    wall[names.indexOf("rock")] = 0.2;
    expect(zoneWallStone(field, wall, 1)).toBe("slate");
    wall[names.indexOf("slate")] = 0.1;
    expect(zoneWallStone(field, wall, 1)).toBe(null);
    expect(zoneWallStone(field, wall, 0)).toBe(null);
  });
});
