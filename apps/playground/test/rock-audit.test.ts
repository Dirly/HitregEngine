import { after, test } from "node:test";
import assert from "node:assert/strict";
import { defaultWorldRecipe, worldRecipeSchema, type VoxelMesh } from "@hitreg/core";
import { rockAudit, walkMeshTriangles } from "../tools/worldgen-rock-audit.mts";
import { paintPaletteFault, paletteRefusals, zonePalette, surfaceRoles } from "../tools/_zone-palette.mts";
import { paletteSkinFaults } from "../tools/rock-skins.mts";

import { FIXTURE_PROJECT, useRockSkinsFixture } from "./fixtures/rock-skins/build.mts";

after(useRockSkinsFixture());

const ZONE = [[-500, -500], [500, -500], [500, 500], [-500, 500]] as [number, number][];

function world(palette?: Record<string, unknown>) {
  const base = defaultWorldRecipe();
  return worldRecipeSchema.parse({
    ...base,
    name: "rock-audit-test",
    cellSize: 32,
    resolution: 16,
    surfaces: [
      ...base.surfaces.map((s) => (s.name === "rock" ? { ...s, role: "cliff" } : s.name === "grass" ? { ...s, role: "grass" } : s)),
      { name: "z-cliff", color: "#333333", roughness: 0.9, map: "zones/z/cliff.png", uvScale: 18 },
      { name: "z-grass", color: "#335533", roughness: 0.9, map: "zones/z/grass.png", uvScale: 3.5 },
      { name: "gravel", color: "#776655", roughness: 0.9, map: "mmo/Gravel.png", uvScale: 3.5 },
    ],
    regions: [{ id: "z", name: "Z", polygon: ZONE, ground: { cliff: "z-cliff", grass: "z-grass" }, ...(palette ? { palette } : {}) }, { id: "z-place", name: "P", polygon: [[0, 0], [10, 0], [10, 10]], within: "z" }],
  });
}

/**
 * A synthetic cell: four quads at y 400 (above any water), each one tile —
 * flat z-grass, VERTICAL z-grass (a), flat z-cliff (b), vertical gravel (a + c) — plus a skirt flap on the cell plane.
 */
function syntheticMesh(recipe: ReturnType<typeof world>): VoxelMesh {
  const S = recipe.surfaces.length, idx = (n: string) => recipe.surfaces.findIndex((s) => s.name === n);
  const pos: number[] = [], splat: number[] = [], ind: number[] = [];
  const quad = (pts: number[][], tile: string) => {
    const v0 = pos.length / 3;
    for (const p of pts) { pos.push(...p); const w = new Array(S).fill(0); w[idx(tile)] = 1; splat.push(...w); }
    ind.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
  };
  quad([[2, 400, 2], [6, 400, 2], [6, 400, 6], [2, 400, 6]], "z-grass"); // 16 m2 flat grass: fine
  quad([[10, 400, 4], [14, 400, 4], [14, 404, 4], [10, 404, 4]], "z-grass"); // 16 m2 wall of grass: (a)
  quad([[18, 400, 2], [22, 400, 2], [22, 400, 6], [18, 400, 6]], "z-cliff"); // 16 m2 flat cliff: (b)
  quad([[24, 400, 10], [28, 400, 10], [28, 404, 10], [24, 404, 10]], "gravel"); // 16 m2 wall of gravel: (a), and (c) when gravel is off-palette
  quad([[0, 396, 20], [0, 396, 24], [0, 400, 24], [0, 400, 20]], "z-grass"); // a skirt flap on the x = 0 plane: ignored
  return { positions: new Float32Array(pos), normals: new Float32Array(pos.length), indices: new Uint32Array(ind), splat: new Float32Array(splat), surfaceCount: S, tint: new Float32Array(pos.length), min: [0, 0, 0], max: [32, 500, 32], vertexCount: pos.length / 3, triangleCount: ind.length / 3 };
}

const area = { rect: [0, 0, 31, 31] as [number, number, number, number], contains: () => true, text: "test cell" };

test("walks surface triangles by FACE slope and leaves skirt flaps out", () => {
  const recipe = world();
  const seen: number[] = [];
  walkMeshTriangles(syntheticMesh(recipe), 0, 0, 32, (t) => seen.push(Math.round(t.deg)));
  assert.deepEqual(seen, [0, 0, 90, 90, 0, 0, 90, 90]);
});

test("rock-audit flags ground on faces, cliff on flat and tiles outside the zone palette", () => {
  const recipe = world({ ground: ["z-grass"], cliff: ["z-cliff"], cap: [], rockSmall: [], rockLarge: [], builtStone: {} });
  const rep = rockAudit({ recipe, area, zone: "z", meshCell: () => syntheticMesh(recipe), rocks: false });
  assert.equal(rep.implied, false);
  assert.equal(rep.cells, 1);
  assert.equal(rep.m2, 64);
  assert.equal(rep.faults.ground.area, 32, "the grass wall and the gravel wall");
  assert.equal(rep.faults.cliff.area, 16);
  assert.equal(rep.faults.palette.area, 16);
  assert.deepEqual(Object.keys(rep.faults.palette.tiles), ["gravel"]);
  assert.equal(rep.ok, false);
  assert.ok(rep.bands[">70"]!["400"]!["z-grass"]!.area === 16);
  assert.ok(rep.worst.length >= 2);
  // a palette naming gravel by name (or a ground tile with the same texture) admits it; the walls still fail (a)
  const withGravel = world({ ground: ["z-grass", "gravel"], cliff: ["z-cliff"] });
  const rep2 = rockAudit({ recipe: withGravel, area, zone: "z", meshCell: () => syntheticMesh(withGravel), rocks: false });
  assert.equal(rep2.faults.palette.area, 0);
  assert.equal(rep2.faults.ground.area, 32);
  // without a declared palette the zone's ground mapping is the implied one
  const implied = rockAudit({ recipe: world(), area, zone: "z", meshCell: () => syntheticMesh(world()), rocks: false });
  assert.equal(implied.implied, true);
  assert.deepEqual(implied.palette!.cliff, ["z-cliff"]);
});

test("the palette refuses tiles outside it, per role; a place uses its zone's", () => {
  const recipe = world({ ground: ["z-grass"], cliff: ["z-cliff"], rockLarge: ["zones/z/rock-large.png"], builtStone: { face: "z/face", cap: ["z/cap"] } });
  const p = zonePalette(recipe, "z-place")!;
  assert.deepEqual(paletteRefusals(p, "cliff", ["z-cliff", "rock"]), ["rock"]);
  assert.deepEqual(paletteRefusals(p, "builtStone", ["z/face", "z/cap", "other/face"]), ["other/face"]);
  assert.equal(zonePalette(world(), "z"), null);
  const roles = surfaceRoles(recipe, p);
  assert.equal(roles[recipe.surfaces.findIndex((s) => s.name === "z-cliff")], "cliff");
  assert.equal(roles[recipe.surfaces.findIndex((s) => s.name === "gravel")], "ground");
  assert.equal(roles[recipe.surfaces.findIndex((s) => s.name === "snow")], "climate");
});

test("a face paint must be a cliff tile of its zone; a floor paint any tile of the palette", () => {
  const recipe = world({ ground: ["z-grass", "gravel"], cliff: ["z-cliff"] });
  const poly = [[1, 1], [9, 1], [9, 9], [1, 9]];
  assert.match(paintPaletteFault(recipe, { id: "walls", op: "paint", surface: "gravel", faces: true, polygon: poly })!, /not a cliff tile/);
  assert.equal(paintPaletteFault(recipe, { id: "walls", op: "paint", surface: "z-cliff", faces: true, polygon: poly }), null);
  assert.equal(paintPaletteFault(recipe, { id: "floor", op: "paint", surface: "gravel", polygon: poly }), null);
  assert.equal(paintPaletteFault(recipe, { id: "floor", op: "paint", surface: "gravel", faces: true, slope: [0, 30], polygon: poly }), null, "a slope window under 45 deg reaches no face");
  assert.match(paintPaletteFault(recipe, { id: "floor", op: "paint", surface: "sand", polygon: poly })!, /not in zone z's palette/);
  assert.equal(paintPaletteFault(recipe, { id: "far", op: "paint", surface: "sand", polygon: [[900, 900], [910, 900], [910, 910]] }), null, "outside every palette zone");
});

test("rock-skins install refuses a zone slice outside its palette", () => {
  const recipe = world({ ground: ["z-grass"], cliff: ["z-cliff"], rockLarge: ["zones/z/rock-large.png"], rockSmall: ["zones/z/rock-small.png"] });
  const bases = [{ map: "rock-kit/granite.png" }, { map: "zones/z/cliff.png" }];
  assert.deepEqual(paletteSkinFaults(recipe, { "z-cliff": 1 }, bases, [{ map: "a" }, { map: "zones/z/rock-small.png" }], [{ map: "a" }, { map: "zones/z/rock-large.png" }]), []);
  const bad = paletteSkinFaults(recipe, { "z-cliff": 0 }, bases, [{ map: "a" }, { map: "b" }], [{ map: "a" }, { map: "b" }]);
  assert.equal(bad.length, 3);
  assert.match(bad[0]!, /rock-kit\/granite.png/);
});

test("rock texel density: the body is projected in model metres, so a scaled-up piece loses texels per metre", () => {
  const recipe = worldRecipeSchema.parse({ ...world({ ground: ["z-grass"], cliff: ["z-cliff"] }), scatter: [] });
  const placed = [
    { id: "boulder", what: "rock-kit/boulder", x: 10, y: 400, z: 10, material: "terrain/fixture-world-rock", rockCap: { base: 4 }, modelBase: null, scale: 1 },
    { id: "pillar", what: "rock-kit/buttress", x: 20, y: 400, z: 20, material: "terrain/fixture-world-rock", rockCap: { base: 4 }, modelBase: null, scale: 3 },
  ];
  const rep = rockAudit({ recipe, area, zone: "z", project: FIXTURE_PROJECT, placed, meshCell: () => syntheticMesh(recipe) });
  assert.equal(rep.texel.checked, 2);
  assert.equal(rep.texel.under, 1);
  assert.equal(rep.texel.worst[0]!.id, "pillar");
  assert.ok(Math.abs(rep.texel.worst[0]!.txm - 512 / 12.8 / 3) < 0.1, `fixture slate cliff 512 px / 12.8 m / x3 = 13.3 tx/m, got ${rep.texel.worst[0]!.txm}`);
  assert.ok(rep.worst.some((s) => s.kinds["low-texel"]));
  assert.equal(rep.ok, false);
});
