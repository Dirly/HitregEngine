import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldField } from "../src/index.js";

// Shaped sea stacks (`terrain.seaCliffs[].stacks.shape`) and stretch turf (`turf`): opt-in, so a world without them
// samples exactly as before; with them every stack keeps its site, radius and top, its shape stays inside the
// footprint it reports, and its top stays flat enough to anchor a rope bridge.
const base = defaultWorldRecipe();
const shape = {
  plan: "mixed", fins: 0.4, tiers: [0, 1], girth: [0.8, 1.8], ledges: [2, 3], strata: 0.25, cap: [0.1, 0.16], lip: [0.9, 1.6],
  waveNotch: { depth: [1.4, 2.6], height: [2.4, 4] }, apron: { reach: [7, 14], height: [1.5, 3.2], boulders: 1.2 },
};
function recipe(extra: { shape?: unknown; turf?: unknown } = {}) {
  return worldRecipeSchema.parse({
    ...base,
    bounds: { continents: [{ center: [0, 0], radius: 700, falloff: 250, warp: 0 }], oceanFloor: -45, landFloor: 4 },
    regions: [{ id: "coast", name: "Coast", polygon: [[-600, -600], [600, -600], [600, 600], [-600, 600]], ground: { grass: "dirt" } }],
    surfaces: base.surfaces.map((s) => (s.name === "grass" ? { ...s, role: "grass" } : s)),
    terrain: {
      ...base.terrain,
      base: 20,
      caves: { ...base.terrain.caves, enabled: false },
      planarCliffs: { profile: "terrace" },
      seaCliffs: [{
        id: "east", along: [[640, -500], [700, 0], [640, 500]], reach: 300, fade: 120, height: [80, 100],
        stacks: { density: 1, cell: 70, offshore: [20, 120], ...(extra.shape ? { shape: extra.shape } : {}) },
        ...(extra.turf ? { turf: extra.turf } : {}),
      }],
    },
  });
}

/** The stack's top: 1 m cells within 1.5 m of the top level, flood-filled from the centre; walkable = slope <= 30 deg. */
function topArea(f: WorldField, s: { x: number; z: number; top: number }, R: number): { top: number; walkable: number } {
  const n = 2 * R + 1, g = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) g[j * n + i] = f.ground(s.x - R + i, s.z - R + j);
  const seen = new Uint8Array(n * n), stack = [R * n + R];
  seen[R * n + R] = 1;
  let top = 0, walkable = 0;
  while (stack.length) {
    const idx = stack.pop()!, i = idx % n, j = (idx - i) / n;
    if (Math.abs(g[idx]! - s.top) > 1.5 || i === 0 || j === 0 || i === n - 1 || j === n - 1) continue;
    top++;
    const gx = (g[idx + 1]! - g[idx - 1]!) / 2, gz = (g[idx + n]! - g[idx - n]!) / 2;
    if (Math.atan(Math.hypot(gx, gz)) <= Math.PI / 6) walkable++;
    for (const o of [1, -1, n, -n]) if (!seen[idx + o]) { seen[idx + o] = 1; stack.push(idx + o); }
  }
  return { top, walkable };
}

describe("shaped sea stacks", () => {
  const plain = createWorldField(recipe());
  const shaped = createWorldField(recipe({ shape }));
  const plainStacks = plain.seaCliffs()!.stacksIn(-2000, -2000, 2000, 2000);
  const stacks = shaped.seaCliffs()!.stacksIn(-2000, -2000, 2000, 2000);

  it("leaves a world without `shape` / `turf` sampling exactly as before (schema defaults add nothing)", () => {
    const again = createWorldField(recipe());
    const r = recipe();
    expect(r.terrain.seaCliffs![0]!.stacks.shape).toBeUndefined();
    expect(r.terrain.seaCliffs![0]!.turf).toBeUndefined();
    expect(plain.seaCliffs()!.shaped).toBe(false);
    const splatA = new Float32Array(r.surfaces.length), splatB = new Float32Array(r.surfaces.length);
    for (const s of plainStacks) for (let a = 0; a < 12; a++) {
      const x = s.x + Math.cos(a) * s.radius * 1.3, z = s.z + Math.sin(a) * s.radius * 1.3;
      expect(again.height(x, z)).toBe(plain.height(x, z));
      for (let y = -10; y < s.top + 4; y += 9.7) expect(again.density(x, y, z)).toBe(plain.density(x, y, z));
      again.splatAt(x, s.top, z, 1, splatA, 0); plain.splatAt(x, s.top, z, 1, splatB, 0);
      expect([...splatA]).toEqual([...splatB]);
    }
  });

  it("keeps every stack's site, radius and top", () => {
    expect(stacks.length).toBeGreaterThan(2);
    expect(stacks.map((s) => [s.x, s.z, s.radius, s.top, s.arch])).toEqual(plainStacks.map((s) => [s.x, s.z, s.radius, s.top, s.arch]));
    for (const s of stacks) {
      expect(s.extent).toBeGreaterThan(s.radius * 0.7);
      expect(s.footprint).toBeGreaterThan(s.extent!);
    }
  });

  it("changes the ground only inside the footprints it reports (and the stacks' arch fins)", () => {
    const sc = shaped.seaCliffs()!, col = sc.newColumn();
    let changed = 0;
    for (const s of stacks) {
      const R = Math.ceil(s.footprint! + 16);
      for (let z = -R; z <= R; z += 2) for (let x = -R; x <= R; x += 2) {
        const px = s.x + x, pz = s.z + z;
        if (shaped.height(px, pz) === plain.height(px, pz)) continue;
        changed++;
        // inside some stack's footprint
        const owner = stacks.some((o) => Math.hypot(px - o.x, pz - o.z) <= o.footprint!);
        sc.column(px, pz, col);
        if (!owner) expect.fail(`ground changed at ${px},${pz}, outside every footprint (nearest stack base ${col.stackBase.toFixed(1)})`);
      }
    }
    expect(changed).toBeGreaterThan(0);
  });

  it("has a flat, walkable top on every stack (rope-bridge anchors)", { timeout: 60000 }, () => {
    const report: string[] = [];
    for (const s of stacks) {
      const { top, walkable } = topArea(shaped, s, Math.ceil(s.extent! + 6));
      report.push(`${s.x.toFixed(0)},${s.z.toFixed(0)} r${s.radius.toFixed(1)} top ${s.top.toFixed(1)}: ${walkable}/${top} m2 walkable`);
      // a fin of the smallest radius still holds a bridge anchor and a few players
      expect(walkable).toBeGreaterThan(Math.min(120, 1.2 * s.radius * s.radius));
      expect(walkable / top).toBeGreaterThan(0.75);
      expect(shaped.ground(s.x, s.z)).toBeCloseTo(s.top, 1);
    }
    console.log("walkable stack tops:\n  " + report.join("\n  "));
  });

  it("is seed-stable: a second field builds the same shapes", () => {
    const again = createWorldField(recipe({ shape }));
    for (const s of stacks) for (let a = 0; a < 8; a++) {
      const x = s.x + Math.cos(a) * s.extent!, z = s.z + Math.sin(a) * s.extent!;
      for (let y = -4; y < s.top + 2; y += 6.1) expect(again.density(x, y, z)).toBe(shaped.density(x, y, z));
    }
  });

  it("cuts a wave notch at the waterline and keeps nothing growing on the apron", () => {
    const sc = shaped.seaCliffs()!;
    let notched = 0, apron = 0;
    for (const s of stacks) for (let a = 0; a < 16; a++) {
      const ca = Math.cos(a * 0.3927), sa = Math.sin(a * 0.3927);
      // the face at mid-height and at the notch (a little over the apron): the notch stands further in
      const faceAt = (y: number): number => { let r = 0; while (r < s.footprint! && shaped.density(s.x + ca * r, y, s.z + sa * r) < 0) r += 0.25; return r; };
      const mid = faceAt(base.seaLevel + (s.top - base.seaLevel) * 0.5), low = faceAt(base.seaLevel + 4.2);
      if (low < mid - 0.5) notched++;
      for (let r = 0; r < s.footprint!; r += 1) if (sc.apron(s.x + ca * r, s.z + sa * r)) { apron++; break; }
    }
    expect(notched).toBeGreaterThan(stacks.length * 4);
    expect(apron).toBeGreaterThan(stacks.length * 8);
  });

  it("turf paints the stack tops with the zone's ground though they stand outside its polygon", () => {
    const turfed = createWorldField(recipe({ shape, turf: { zone: "coast" } }));
    const r = recipe();
    const dirtIx = r.surfaces.findIndex((s) => s.name === "dirt");
    const grassIx = r.surfaces.findIndex((s) => s.role === "grass");
    const a = new Float32Array(r.surfaces.length), b = new Float32Array(r.surfaces.length);
    const off = stacks.filter((s) => s.x > 600 + 50);
    expect(off.length).toBeGreaterThan(0);
    let hits = 0;
    for (const s of off) {
      shaped.splatAt(s.x, s.top, s.z, 1, a, 0);
      turfed.splatAt(s.x, s.top, s.z, 1, b, 0);
      if (grassIx >= 0 && a[grassIx]! > 0.05) {
        expect(b[grassIx]!).toBeLessThan(a[grassIx]!);
        expect(b[dirtIx]!).toBeGreaterThan(a[dirtIx]!);
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(0);
  });
});
