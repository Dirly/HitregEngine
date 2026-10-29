import { test } from "node:test";
import assert from "node:assert/strict";
import { measureShapeMask, planCoastShape, shapeFindings, descriptorDistance, SOLIDITY_MAX, SPINE_CREST_MAX, SPINE_CREST_MIN, type CoastOutline } from "../tools/worldgen-coast-shape.mts";
import { dryOpenMin, treeKindOf } from "../tools/worldgen-biome-read.mts";

/**
 * The coast-shape step and the `shape` / `read` dogfood rules (2026-10-29 redstrand w2-shape: every seed was the same
 * rounded two-lobe blob, and the map told neither dry ground, the oasis ribbon nor pine from broadleaf).
 */
const N = 200;
function mask(inside: (x: number, z: number) => boolean): Uint8Array {
  const m = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (inside(x - N / 2, z - N / 2)) m[x + z * N] = 1;
  return m;
}
const disc = (x: number, z: number, r: number, cx = 0, cz = 0) => (x - cx) ** 2 + (z - cz) ** 2 <= r * r;
const segDist = (x: number, z: number, ax: number, az: number, bx: number, bz: number) => {
  const ex = bx - ax, ez = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
  return Math.hypot(x - ax - ex * t, z - az - ez * t);
};

test("a rounded blob fails the shape rule: solid, no peninsula, no bay", () => {
  const blob = measureShapeMask(mask((x, z) => disc(x, z, 50) || disc(x, z, 35, 40, 10)), N, N);
  assert.ok(blob.solidity > SOLIDITY_MAX, `blob solidity ${blob.solidity}`);
  assert.equal(blob.peninsulas.length, 0);
  const f = shapeFindings(blob, null);
  assert.ok(f.some((s) => /solidity/.test(s)) && f.some((s) => /peninsula/.test(s)), f.join("; "));
});

test("a landmass with a peninsula, a sound and an islet passes, each measured", () => {
  const shaped = measureShapeMask(
    mask((x, z) => {
      const body = disc(x, z, 48) && segDist(x, z, 60, 0, 22, 0) > 9; // a sound cut in from the east
      const arm = segDist(x, z, -30, 30, -75, 75) < 9; // a peninsula to the south-west
      return body || arm || disc(x, z, 3, -85, -40); // and an islet
    }),
    N,
    N,
  );
  assert.ok(shaped.solidity <= SOLIDITY_MAX, `solidity ${shaped.solidity}`);
  assert.equal(shaped.peninsulas.length, 1, `peninsulas ${shaped.peninsulas}`);
  assert.ok(shaped.bays.length >= 1, `bays ${shaped.bays}`);
  assert.equal(shaped.islets, 1);
  assert.deepEqual(shapeFindings(shaped, 0.5), []);
});

test("the outline descriptor ignores rotation and tells different outlines apart", () => {
  const a = measureShapeMask(mask((x, z) => disc(x, z, 45) || segDist(x, z, 0, 0, 80, 0) < 10), N, N);
  const rotated = measureShapeMask(mask((x, z) => disc(x, z, 45) || segDist(x, z, 0, 0, 0, 80) < 10), N, N);
  const other = measureShapeMask(mask((x, z) => disc(x, z, 45) || segDist(x, z, 0, 0, 80, 0) < 10 || segDist(x, z, 0, 0, -60, -60) < 10), N, N);
  assert.ok(descriptorDistance(a.descriptor, rotated.descriptor) < 0.03, `rotated ${descriptorDistance(a.descriptor, rotated.descriptor)}`);
  assert.ok(descriptorDistance(a.descriptor, other.descriptor) > 0.06, `other ${descriptorDistance(a.descriptor, other.descriptor)}`);
});

test("capes root where the upland meets the coast, inlets at the low coast, islets apart", () => {
  // a 4 km disc with high ground behind the east coast (bearing 0) and low ground behind the west (bearing 180)
  const radius = Array.from({ length: 72 }, () => 2000);
  const inland = Array.from({ length: 72 }, (_, b) => 60 + 50 * Math.cos((b / 72) * Math.PI * 2));
  const o: CoastOutline = { cx: 0, cz: 0, radius, inland, widthM: 4000 };
  const main = { center: [0, 0] as [number, number], radius: 1600, falloff: 650, warp: 0.6, warpScale: 1100, coastVariation: 0.5, coastVariationScale: 1600, lobes: [], lobeBlend: 300, capes: [], inlets: [], shapeBlend: 140 };
  for (let seed = 1; seed <= 6; seed++) {
    let s = seed * 9301;
    const random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const plan = planCoastShape(main, o, random, main);
    assert.ok(plan.capes.length >= 2 && plan.capes.length <= 6, "1-3 capes, two capsules each");
    assert.ok(plan.inlets.length >= 1 && plan.inlets.length <= 3);
    // the first cape roots on the high side (x > 0), the first inlet's head on the low side (x < 0)
    assert.ok(plan.capes[0]![0] > 0, `cape root ${plan.capes[0]!.slice(0, 2)}`);
    assert.ok(plan.inlets[0]![2] < 0, `inlet head ${plan.inlets[0]!.slice(2, 4)}`);
    // a cape reaches 15-35 % of the width past the coast
    const tip = plan.capes[1]!;
    const reach = Math.hypot(tip[2], tip[3]) - 2000;
    assert.ok(reach > 0.1 * 4000 && reach < 0.4 * 4000, `reach ${reach}`);
    assert.equal(plan.ridges.length, plan.capes.length / 2, "one plateau spine per cape");
    assert.ok(plan.ridges.every((r) => r.id.startsWith("cape-") && r.height >= 55 && r.falloff <= 70));
    // a ridge along the arm, not a flat-topped racetrack (redstrand 3039): a narrow crest, rising out of the upland at the
    // root (no end cap on the land), running out to the cape's tip
    plan.ridges.forEach((r, k) => {
      assert.ok(r.width <= SPINE_CREST_MAX && r.width >= SPINE_CREST_MIN, `crest ${r.width}`);
      const hs = r.heights!;
      assert.equal(hs.length, r.points.length);
      assert.ok(hs[0]! < 0.5 * r.height && Math.max(...hs) === r.height, `heights ${hs}`);
      const end = r.points[r.points.length - 1]!, capTip = plan.capes[k * 2 + 1]!;
      assert.ok(Math.hypot(end[0] - capTip[2], end[1] - capTip[3]) <= capTip[5] * 1.2, `spine ends ${end} short of the tip ${capTip.slice(2, 4)}`);
    });
    for (const a of plan.islets) for (const b of plan.islets) if (a !== b) assert.ok(Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) >= 300);
  }
});

test("the read rule's tree kinds and dry-share threshold", () => {
  assert.equal(treeKindOf("pine"), "pine");
  assert.equal(treeKindOf("pine-snow"), "pine");
  assert.equal(treeKindOf("maple"), "broadleaf");
  assert.equal(treeKindOf("palm"), "scrub");
  assert.equal(treeKindOf("dead-dried-tree"), "scrub");
  assert.equal(dryOpenMin(0.5), 0.5);
  assert.ok(dryOpenMin(1) <= 0.75);
});

test("islet loops join the largest loop's coast group; a big second landmass keeps its own", async () => {
  const { loopGroupOf, ISLET_LOOP_M } = await import("../tools/worldgen-coast.mts");
  const g = loopGroupOf(new Map([[0, 16000], [1, 600], [2, ISLET_LOOP_M + 1], [3, 300]]));
  assert.deepEqual([...g.entries()], [[0, 0], [1, 0], [2, 2], [3, 0]]);
});

test("harsh climates: dry by aridity, cold by warmth, and twice the climate cells on the landmass", async () => {
  const { harshness } = await import("../tools/worldgen-biome-read.mts");
  const { climateCellSize, CLIMATE_CELLS_HARSH } = await import("../tools/worldgen-climate.mts");
  const zones = (o: object) => ({ climate: { zones: o } }) as never;
  assert.deepEqual(harshness(zones({ aridity: 0.5, warmth: 0.1 })), { kind: "dry", severity: 0.5 });
  assert.equal(harshness(zones({ warmth: -0.4 })).kind, "cold");
  assert.equal(harshness(zones({ aridity: 0.1, warmth: 0 })).kind, null);
  assert.ok(climateCellSize(7.7, CLIMATE_CELLS_HARSH) < climateCellSize(7.7));
});
