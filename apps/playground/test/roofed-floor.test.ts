import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredRoofed, probeColumn, roofedFloorY } from "../tools/_roofed-floor.mts";

// an arch: ground at y 10 everywhere; a roof slab 16.0-16.8 over x in [-4, 4]; a 0.5 m step (plinth) at x in [-1, 1]
const ground = (x: number) => (Math.abs(x) <= 1 ? 10.5 : 10);
const solids = (x: number): Array<[number, number]> => [[-100, ground(x)], ...(Math.abs(x) <= 4 ? [[16, 16.8] as [number, number]] : [])];
const castDown = (x: number, y: number, _z: number, len: number): number | null => {
  let best: number | null = null;
  for (const [lo, hi] of solids(x)) for (const s of [hi, lo]) if (s <= y && s >= y - len && (best === null || s > best)) best = s;
  return best;
};
const castUp = (x: number, y: number, _z: number, len: number): number | null => {
  let best: number | null = null;
  for (const [lo, hi] of solids(x)) for (const s of [lo, hi]) if (s >= y && s <= y + len && (best === null || s < best)) best = s;
  return best;
};

test("roofed area: the floor under the arch, not the roof", () => {
  const cols = [];
  for (let x = -6; x <= 6; x += 1) cols.push(probeColumn(castDown, castUp, x, 0, 50, 4));
  assert.equal(cols[6]!.surfaces[0]!.y, 16.8);              // the first top from the sky IS the roof
  assert.equal(cols[6]!.surfaces[0]!.ceiling, null);
  assert.equal(roofedFloorY(cols), 10);                    // median of the roofed columns' lowest floors (plinth 10.5 is the minority)
});

test("open sky gives null; only a thin roof share gives null", () => {
  const open = [-20, -15, -10].map((x) => probeColumn(castDown, castUp, x, 0, 50, 4));
  assert.equal(roofedFloorY(open), null);
  const mostlyOpen = [...Array.from({ length: 30 }, (_, i) => probeColumn(castDown, castUp, -40 - i, 0, 50, 4)), probeColumn(castDown, castUp, 3, 0, 50, 4)];
  assert.equal(roofedFloorY(mostlyOpen), null);
});

test("roofed declarations", () => {
  assert.ok(declaredRoofed({ roofed: true }));
  assert.ok(declaredRoofed({ indoor: true }));
  assert.ok(declaredRoofed({ surfaceNote: "under the arch roof" }));
  assert.ok(!declaredRoofed({ surfaceNote: "gravel" }));
  assert.ok(!declaredRoofed({}));
});
