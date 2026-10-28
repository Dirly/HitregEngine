import { test } from "node:test";
import assert from "node:assert/strict";
import { continentalWorldRecipe, worldRecipeSchema, COAST_TYPES, type CoastSegmentDoc, type WorldRecipe } from "@hitreg/core";
import {
  analyseLoop,
  assignCoastTypes,
  checkCoastPlan,
  coastStageCheck,
  cutSegments,
  DEFAULT_COAST_RULES,
  describeSegments,
  eligible,
  LEVEL_TOP_UNDULATION,
  planCoast,
  targetShares,
  traceShorelines,
  type SegmentInfo,
} from "../tools/worldgen-coast.mts";

// A disc with a peninsula to the east: shore distance = metres inland (the union of two discs), as the field's is.
const shore = (x: number, z: number): number => Math.max(900 - Math.hypot(x, z), 500 - Math.hypot(x - 900, z));
// the ground climbs faster behind the eastern shore
const height = (x: number, z: number): number => Math.max(0, shore(x, z)) * (x > 400 ? 0.25 : 0.04);
const SPACING = 24;

const loops = traceShorelines(shore, 2000, 8, SPACING);

test("traces the shoreline as one closed loop on the contour", () => {
  assert.equal(loops.length, 1);
  const loop = loops[0]!;
  assert.ok(loop.length > 2 * Math.PI * 900 && loop.length < 2 * Math.PI * 1400, `length ${loop.length}`);
  for (const [x, z] of loop.points) assert.ok(Math.abs(shore(x, z)) < 1.5, `off the contour at ${x},${z}: ${shore(x, z)}`);
  // spacing as asked
  const a = loop.points[0]!, b = loop.points[1]!;
  assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - SPACING) < 3);
});

const points = analyseLoop(loops[0]!, { shore, height, windTo: Math.PI, fetchOpen: 1500, outerRadius: 1e9 });

test("reads exposure from the wind and the fetch, bays from the curvature and the slope behind", () => {
  const east = points.filter((p) => p.x > 1300);
  const west = points.filter((p) => p.x < -850);
  assert.ok(east.length > 3 && west.length > 3);
  assert.ok(east.every((p) => p.exposed), "the peninsula's tip faces the wind over open sea");
  assert.ok(west.every((p) => !p.exposed), "the west shore has its back to the wind");
  assert.ok(east.every((p) => p.nx > 0.7), "outward normals point out to sea");
  // the tip of the peninsula is a headland, the junction between disc and lobe a bay
  const tip = points.filter((p) => p.x > 1380);
  // the two discs meet at (761, +-480)
  const junction = points.filter((p) => Math.hypot(p.x - 761, Math.abs(p.z) - 480) < 60);
  assert.ok(tip.length > 0 && tip.every((p) => p.bay < 0), `tip bay ${tip.map((p) => p.bay.toFixed(1)).join(",")}`);
  assert.ok(junction.length > 0 && junction.every((p) => p.bay > 0), `junction bay ${junction.map((p) => p.bay.toFixed(1)).join(",")}`);
  assert.ok(east.every((p) => p.slope > 0.2) && west.every((p) => p.slope < 0.06), "slope behind read from the ground");
});

const cuts = cutSegments(points, SPACING, 120, 420);
const segs = describeSegments(0, points, cuts, SPACING);

test("cuts the loop into segments between the minimum and maximum length that cover it once", () => {
  assert.ok(segs.length >= 8, `${segs.length} segments`);
  assert.equal(cuts.reduce((a, c) => a + c.count, 0), points.length);
  for (const s of segs) {
    assert.ok(s.length >= 120 - 1e-6, `${s.index} is ${s.length} m`);
    assert.ok(s.length <= 420 + SPACING, `${s.index} is ${s.length} m`);
    assert.equal(s.points.length, (cuts[s.index]!.count) + 1);
  }
  // consecutive segments share their endpoint (wrapping)
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i]!.points[segs[i]!.points.length - 1]!, b = segs[(i + 1) % segs.length]!.points[0]!;
    assert.deepEqual(a, b);
  }
});

test("assigns types inside the rules: shares near target, beaches sheltered, no run over maxRun, seed-stable", () => {
  const group = { key: "loop-0", rules: DEFAULT_COAST_RULES, segs };
  const assigned = assignCoastTypes([group], [segs], 7);
  const target = targetShares(segs, DEFAULT_COAST_RULES);
  const total = segs.reduce((a, s) => a + s.length, 0);
  for (const t of COAST_TYPES) {
    const share = segs.filter((s) => assigned.get(s)!.type === t).reduce((a, s) => a + s.length, 0) / total;
    assert.ok(Math.abs(share - target[t]) <= DEFAULT_COAST_RULES.tolerance + 1e-9, `${t}: ${share.toFixed(2)} vs target ${target[t].toFixed(2)}`);
  }
  assert.equal(target.mudflat, 0, "no river mouth or marsh: no mudflat target");
  for (const s of segs) {
    const t = assigned.get(s)!.type;
    assert.ok(eligible(s, t), `${s.index} ${t} not eligible`);
    if (t === "sand-beach" || t === "cove") assert.equal(s.exposure, "sheltered");
  }
  // runs
  const n = segs.length;
  for (let i = 0; i < n; i++) {
    let run = segs[i]!.length;
    for (let k = 1; k < n; k++) { const o = segs[(i + k) % n]!; if (assigned.get(o)!.type !== assigned.get(segs[i]!)!.type) break; run += o.length; }
    assert.ok(run <= DEFAULT_COAST_RULES.maxRun, `run of ${run} m from ${i}`);
  }
  assert.ok(segs.some((s) => assigned.get(s)!.type === "sheer-cliff") && segs.some((s) => ["sand-beach", "cove"].includes(assigned.get(s)!.type)));
  const again = assignCoastTypes([group], [segs], 7);
  assert.deepEqual([...again.values()].map((a) => a.type), [...assigned.values()].map((a) => a.type));
});

/** A recipe carrying a hand-made plan on a tiny island (the gate reads the docs, never the field). */
function withPlan(segments: Partial<CoastSegmentDoc>[], stretches: string[] = ["coast-0-0"]): WorldRecipe {
  const base = continentalWorldRecipe();
  return worldRecipeSchema.parse({
    ...base,
    terrain: { ...base.terrain, seaCliffs: stretches.map((id) => ({ id, along: [[0, 0], [100, 0]] })) },
    features: {
      coastSegments: segments.map((s, i) => ({
        id: `cs-0-${i}`, type: "rocky-shore", points: [[i * 100, 0], [i * 100 + 100, 0]], loop: 0, exposure: "sheltered", fetch: 3000, facing: 0,
        slopeBehind: 0.2, concave: true, mud: false, length: 100, ...s,
      })),
    },
  });
}
// 2000 m of shore in 20 segments at the default shares: 5 cliff, 4 rocky, 3 shingle, 4 sand, 2 cove, (mud 0 -> renormalised)
const good: Partial<CoastSegmentDoc>[] = [];
for (let i = 0; i < 20; i++) {
  const t = i < 3 ? "sheer-cliff" : i < 6 ? "rocky-shore" : i < 9 ? "shingle" : i < 13 ? "sand-beach" : i < 15 ? "cove" : i < 17 ? "sheer-cliff" : "rocky-shore";
  good.push({ type: t, ...(t === "sheer-cliff" ? { stretch: "coast-0-0", exposure: "exposed" } : {}) });
}

test("the gate passes a plan that keeps every rule and names the rule it fails", () => {
  const ok = checkCoastPlan(withPlan(good));
  assert.ok(ok.ok, ok.findings.map((f) => `${f.rule}: ${f.detail}`).join("\n"));
  assert.equal(coastStageCheck(withPlan(good)), null);
  const rule = (r: WorldRecipe): string[] => [...new Set(checkCoastPlan(r).findings.map((f) => f.rule))];
  // a beach on an exposed segment
  assert.ok(rule(withPlan(good.map((s, i) => (i === 9 ? { ...s, exposure: "exposed" } : s)))).includes("beach-exposed"), "expected the beach-exposed rule");
  // a 700 m run of one type (segments 3-9 rocky-shore)
  assert.ok(rule(withPlan(good.map((s, i) => (i >= 6 && i < 10 ? { ...s, type: "rocky-shore" } : s)))).includes("max-run"), "expected the max-run rule");
  // a cliff with no stretch, and a stretch nobody belongs to
  assert.ok(rule(withPlan(good, [])).includes("cliff-no-stretch"), "expected the cliff-no-stretch rule");
  assert.ok(rule(withPlan(good, ["coast-0-0", "coast-0-9"])).includes("orphan-stretch"), "expected the orphan-stretch rule");
  // no beach at all
  assert.ok(rule(withPlan(good.map((s) => (s.type === "sand-beach" || s.type === "cove" ? { ...s, type: "shingle" } : s)))).includes("zone-needs-beach"), "expected the zone-needs-beach rule");
  // the share rule
  assert.ok(rule(withPlan(good.map((s) => (s.type === "shingle" ? { ...s, type: "rocky-shore" } : s)))).includes("share"), "expected the share rule");
  // a level top asked for (topEdge) that its stretch does not keep (edge 36 < 160); the field is not measured here
  const asked = withPlan(good.map((s, i) => (i === 0 ? { ...s, topEdge: 160 } : s)));
  assert.ok(checkCoastPlan(asked, { measureTops: false }).findings.some((f) => f.rule === "flat-top" && /edge 36 m/.test(f.detail)), "expected the flat-top rule on a stretch edge under the asked top");
  asked.terrain.seaCliffs![0]!.edge = 160;
  assert.ok(!checkCoastPlan(asked, { measureTops: false }).findings.some((f) => f.rule === "flat-top"), "a stretch holding the asked edge passes");
  assert.match(coastStageCheck(withPlan(good, [])) ?? "", /cliff-no-stretch/);
});

test("plans a real continent through the field and the plan passes its own gate", { timeout: 120000 }, () => {
  const base = continentalWorldRecipe();
  const recipe = worldRecipeSchema.parse({
    ...base,
    bounds: { ...base.bounds, continents: [{ center: [0, 0], radius: 800, falloff: 400, warp: 0.5, warpScale: 700, coastVariation: 0.5, coastVariationScale: 900, lobes: [[700, 200, 450]], lobeBlend: 300 }], limit: 2400 },
  });
  const plan = planCoast(recipe);
  assert.equal(plan.loops.length, 1, plan.log.join("\n"));
  assert.ok(plan.segments.length >= 12, `${plan.segments.length} segments`);
  assert.ok(plan.stretches.length >= 1);
  recipe.terrain.seaCliffs = plan.stretches;
  recipe.features.coastSegments = plan.segments;
  const parsed = worldRecipeSchema.parse(recipe);
  const rep = checkCoastPlan(parsed);
  assert.ok(rep.ok, rep.findings.map((f) => `${f.rule}: ${f.detail}`).join("\n"));
  // every stretch ends where its run ends: a segment next to a cliff run is not inside its polyline's reach along the shore
  for (const st of plan.stretches) assert.ok(st.endFade !== undefined && st.endFade >= 30);
  // a level top asked for by coast-top (segment topEdge) survives a re-plan: same id, its stretch keeps the edge, level
  const cliff = parsed.features.coastSegments!.find((s) => s.type === "sheer-cliff")!;
  cliff.topEdge = 150;
  const again = planCoast(parsed);
  const kept = again.segments.find((s) => s.id === cliff.id)!;
  assert.equal(kept.topEdge, 150, "topEdge kept by segment id");
  const st = again.stretches.find((s) => s.id === kept.stretch)!;
  assert.equal(st.edge, 150, "the stretch keeps the asked edge");
  assert.equal(st.undulation, LEVEL_TOP_UNDULATION, "a level top is near-flat");
  assert.equal(again.segments.filter((s) => s.topEdge).length, 1, "only the asked segment carries a top");
});
