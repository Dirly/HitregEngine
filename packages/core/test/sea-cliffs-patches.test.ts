import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldField } from "../src/index.js";

// A round island whose east coast is a sea-cliff stretch. Height patches and POIs on the cliff top or on a stack
// must level their own footprint and never move the wall line or delete a stack (they used to be clearance
// obstacles: anything within ~90 m pushed the profile back and a stack site whose weight fell under 0.6 vanished).
const base = defaultWorldRecipe();
function recipe(features: Record<string, unknown> = {}, planar = false) {
  return worldRecipeSchema.parse({
    ...base,
    bounds: { continents: [{ center: [0, 0], radius: 700, falloff: 250, warp: 0 }], oceanFloor: -45, landFloor: 4 },
    terrain: {
      ...base.terrain,
      base: 20,
      caves: { ...base.terrain.caves, enabled: false },
      ...(planar ? { planarCliffs: { profile: "terrace" } } : {}),
      seaCliffs: [{ id: "east", along: [[640, -500], [700, 0], [640, 500]], reach: 300, fade: 120, height: [80, 100], stacks: { density: 1, cell: 70, offshore: [20, 120] } }],
    },
    features,
  });
}

/** Metres along +x at row z where the ground first drops under the sea (the wall's foot) walking out from x0. */
function wallX(field: WorldField, z: number, x0 = 400): number {
  for (let x = x0; x < 1100; x += 0.5) if (field.height(x, z) < base.seaLevel + 2) return x;
  return NaN;
}

function pad(id: string, cx: number, cz: number, half: number, y: number) {
  const n = 9;
  return { id, origin: [cx - half, cz - half], size: [half * 2, half * 2], columns: n, rows: n, heights: new Array(n * n).fill(y), blend: 2 };
}

describe("sea cliffs keep their wall and stacks under patches and POIs", () => {
  const plain = createWorldField(recipe());
  const stacks = plain.seaCliffs()!.stacksIn(-2000, -2000, 2000, 2000);

  it("has a wall and stacks to test against", () => {
    expect(stacks.length).toBeGreaterThan(0);
    expect(wallX(plain, 0)).toBeGreaterThan(500);
  });

  it("a pad on a stack top keeps the stack (and levels its top)", () => {
    const s = stacks[0]!;
    const level = Math.round(s.top - 1);
    const f = createWorldField(recipe({
      heightPatches: [pad("pad-stack", s.x, s.z, Math.max(4, s.radius * 0.6), level)],
      pois: [{ id: "tower", position: [s.x, s.top, s.z] }],
    }));
    const after = f.seaCliffs()!.stacksIn(-2000, -2000, 2000, 2000);
    expect(after.length).toBe(stacks.length);
    const same = after.find((o) => Math.hypot(o.x - s.x, o.z - s.z) < 0.01)!;
    expect(same).toBeDefined();
    expect(same.top).toBeCloseTo(s.top, 6);
    expect(f.height(s.x, s.z)).toBeCloseTo(level, 0);
    // the sea round the stack is still sea
    expect(f.height(s.x + s.radius * 3, s.z)).toBeCloseTo(plain.height(s.x + s.radius * 3, s.z), 6);
  });

  it("a POI and a pad on the cliff top keep the wall where it was", () => {
    const z = 0, wx = wallX(plain, z);
    const top = plain.height(wx - 25, z);
    const f = createWorldField(recipe({
      heightPatches: [pad("pad-top", wx - 25, z, 10, Math.round(top + 0.5))],
      pois: [{ id: "watch", position: [wx - 20, top, z] }],
    }));
    for (const dz of [-60, -20, 20, 60]) expect(wallX(f, z + dz)).toBeCloseTo(wallX(plain, z + dz), 6);
    expect(wallX(f, z)).toBeCloseTo(wx, 6);
    // the pad levels its own footprint and nothing outside it
    expect(f.height(wx - 25, z)).toBeCloseTo(Math.round(top + 0.5), 0);
    expect(f.height(wx - 80, z)).toBeCloseTo(plain.height(wx - 80, z), 6);
  });

  it("on the planar path the pad levels the stack top (the walls give way under the patch)", () => {
    const pl = createWorldField(recipe({}, true));
    const s = pl.seaCliffs()!.stacksIn(-2000, -2000, 2000, 2000)[0]!;
    const level = Math.round(s.top - 3);
    const f = createWorldField(recipe({ heightPatches: [pad("pad-stack", s.x, s.z, Math.max(4, s.radius * 0.6), level)] }, true));
    const hit = f.surfaceCast(s.x, s.z, s.top + 20, s.top - 20);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit! - level)).toBeLessThan(1);
    // and the stack still stands: its wall a little outside the pad is still rock up to near the old top
    expect(f.seaCliffs()!.stacksIn(-2000, -2000, 2000, 2000).length).toBe(pl.seaCliffs()!.stacksIn(-2000, -2000, 2000, 2000).length);
  });
});
