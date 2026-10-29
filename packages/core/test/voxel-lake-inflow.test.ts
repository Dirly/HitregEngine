import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldRecipe } from "../src/index.js";

/**
 * 2026-10-29 (w2-hydro, redstrand dogfood): a river's envelope just above its lake (the traced bed cut through a rise,
 * or a bank cap read beside the lake's basin) held the inflow metres UNDER the lake, and the solved water climbed into
 * the sheet — the rivers audit's "uphill steps" on every seed. The lake now backs its inflow up to its level, and a
 * hair of climb anywhere (a tributary a decimetre under its trunk) is healed as backwater.
 */
function noFeatures(): WorldRecipe["features"] {
  return { heightPatches: [], passages: [], rivers: [], canyons: [], ridges: [], roads: [], towns: [], lakes: [], bridges: [], fills: [], riverPaths: [], tunnels: [], blobs: [], pois: [], camps: [] };
}
// truly flat ground at 60 (every noise layer's amplitude zeroed): the banks hold whatever the river stands at
const flat = Object.fromEntries(
  Object.entries({ ...defaultWorldRecipe().terrain, base: 60 }).map(([k, v]) => [k, v && typeof v === "object" && "amplitude" in v ? { ...v, amplitude: 0 } : v]),
) as WorldRecipe["terrain"];
const recipe = (features: Partial<WorldRecipe["features"]>): WorldRecipe =>
  worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24, terrain: flat, features: { ...noFeatures(), ...features } });

const lake = { id: "mere", center: [300, 0] as [number, number], polygon: [[200, -100], [400, -100], [400, 100], [200, 100]] as [number, number][], radius: 100, waterY: 58, depth: 5, bank: 16, carve: true, surface: "", shore: 8, tags: [] as string[] };

describe("a river arriving in its lake", () => {
  // the traced bed dips to 54 a hundred metres before the shore: its natural water (54 + 0.7 x 2) stands 2.6 m under
  // the lake it runs into
  const river = { id: "beck", points: [[-300, 0], [100, 0], [180, 0], [300, 0]] as [number, number][], width: 6, depth: 2, bank: 8, bedY: [62, 54, 54, 54], maxGrade: 0, water: true, surface: "", surfaceEdge: 2, taper: 0 };
  const field = createWorldField(recipe({ lakes: [lake], rivers: [river] }));
  const solved = field.rivers.find((r) => r.id === "beck")!;

  it("never climbs into the sheet", () => {
    const lv = solved.surfaceY!;
    for (let i = 0; i + 1 < lv.length; i++) expect(lv[i + 1]!).toBeLessThanOrEqual(lv[i]! + 1e-6);
  });

  it("is backed up to the lake's level at the shore", () => {
    const k = solved.points.findIndex((p) => p[0] >= 170);
    expect(solved.surfaceY![k]!).toBeCloseTo(58, 1);
  });
});
