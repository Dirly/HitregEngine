import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorldField, defaultWorldRecipe, terraceWallSchema, voxelChunkDoc, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import {
  applyTerraceFit,
  fitTerraceWall,
  footprintFromPath,
  loadTerraceKit,
  refitTerraceWalls,
  shelfFootprint,
  naturalRecipe,
  outlinesOverlap,
  refitGrouped,
  solveTerraceChain,
  splitShelf,
  terraceGates,
  townShelfOutlines,
  townTerraceWalls,
  trimShelfTo,
} from "../tools/worldgen-terrace-walls.mts";

const KIT = path.resolve(import.meta.dirname, "../projects/world-kit/authoring/retaining-wall/lookup.json");
const haveKit = fs.existsSync(KIT);

/** A flat-noise world whose only relief is a planar hillside (a height patch): rises 0.35 m per m towards -Z. */
function hillside(rise = 0.35, lift = 0): WorldRecipe {
  const recipe = worldRecipeSchema.parse({
    ...defaultWorldRecipe(),
    version: 1,
    name: "terrace-test",
    seed: 3,
    terrain: {
      base: 20,
      warp: { strength: 0, frequency: 0.001 },
      continent: { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: 1 },
      hills: { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: 2 },
      mountains: { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: 3 },
      detail: { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: 4 },
    },
  });
  recipe.terrain.overhang.strength = 0;
  recipe.terrain.caves.enabled = false;
  const n = 81, size = 160;
  const heights: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights.push(20 + lift + (80 - (j * size) / (n - 1)) * rise);
  recipe.features.heightPatches.push({ id: "slope", origin: [-80, -80], size: [size, size], columns: n, rows: n, heights, blend: 8, filter: 0 });
  return recipe;
}

const doc = (extra: Record<string, unknown> = {}) => ({
  id: "t1",
  style: "masonry-stone" as const,
  // 16 m along the contour, 10 m deep; the wall is the south (+Z) edge
  ...footprintFromPath([[0, 6], [16, 6]], 10),
  height: 3,
  ...extra,
});

test("footprintFromPath: a 2-point wall line gets a pad on its left", () => {
  const { footprint, walls } = footprintFromPath([[0, 0], [10, 0]], 8);
  assert.deepEqual(footprint, [[0, 0], [10, 0], [10, -8], [0, -8]]);
  assert.deepEqual(walls, [0]);
});

test("fit: pad level, wall foot, kit pieces, cuts and a clean drawn riser", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside();
  const kit = loadTerraceKit("proving", () => {});
  const fit = fitTerraceWall(recipe, doc() as never, kit);
  const s = fit.doc.solved!;
  assert.equal(s.height, 3);
  assert.ok(Math.abs(s.topY - s.baseY - 3) < 0.011);
  assert.deepEqual(s.runs, [{ edges: [0], closed: false }]);
  assert.ok(s.pieces.some((p) => p.role === "end-l") && s.pieces.some((p) => p.role === "end-r"));
  assert.ok(s.pieces.every((p) => p.prefab.startsWith("retaining-wall/stone-")));
  assert.ok(s.cuts.some((c) => c.kind === "face"));
  assert.ok(s.pieces.some((p) => p.overrides?.some((o) => /\.p\d\.glb$/.test(String(o.value)))), "body pieces off the 3.2 m phase use their phase mesh");
  applyTerraceFit(recipe, fit);
  const field = createWorldField(recipe);
  // the riser stands inside the wall body: pad at topY just behind the coping, the foot at baseY in front
  const behind = field.surfaceCast(8, 6 - 1.2, s.topY + 4, s.baseY - 3)!;
  const front = field.surfaceCast(8, 6 + 0.4, s.topY + 4, s.baseY - 3)!;
  // height() (server ground, scatter, NPCs) reads the foot in front of the face too, not the lattice berm
  assert.ok(Math.abs(field.height(8, 6.5) - s.baseY) < 0.05, `height() in front of the face ${field.height(8, 6.5)}`);
  assert.ok(Math.abs(field.height(8, 4) - s.topY) < 0.05, "height() on the pad");
  assert.ok(Math.abs(behind - s.topY) < 0.25, `pad behind the wall at ${behind}, want ${s.topY}`);
  assert.ok(Math.abs(front - s.baseY) < 0.25, `foot in front of the wall at ${front}, want ${s.baseY}`);
  const g = terraceGates(recipe, fit.doc, { field });
  assert.equal(g.riser.gutter <= 0.25 && g.riser.against <= 0.3, true, g.lines.join("\n"));
  assert.equal(g.seated.foot.gap <= 0.25 && g.seated.foot.clip <= 0.6, true, g.lines.join("\n"));
  assert.equal(g.stale, false);
  // the streamer emits the pieces into the cells they stand in
  const chunk = voxelChunkDoc(field, "terrace-test", 0, 0, { scatter: false, water: false } as never);
  assert.ok(Object.keys(chunk.entities).some((k) => k.startsWith("tw_t1_")));
});

test("re-fit after a terrain change follows the new ground; --check reports the old fit STALE", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside();
  const kit = loadTerraceKit("proving", () => {});
  applyTerraceFit(recipe, fitTerraceWall(recipe, doc() as never, kit));
  const before = recipe.features.terraceWalls![0]!.solved!;
  // the hill is rebuilt 4 m higher
  const raised = hillside(0.35, 4);
  raised.features.terraceWalls = recipe.features.terraceWalls;
  raised.features.heightPatches.push(...recipe.features.heightPatches.filter((p) => p.id.startsWith("tw-")));
  raised.features.passages = recipe.features.passages;
  raised.features.clearings = recipe.features.clearings;
  assert.equal(terraceGates(raised, raised.features.terraceWalls![0]!).stale, true);
  refitTerraceWalls(raised, kit);
  const after = raised.features.terraceWalls![0]!.solved!;
  assert.ok(Math.abs(after.topY - before.topY - 4) < 0.3, `pad ${before.topY} -> ${after.topY}`);
  assert.equal(raised.features.heightPatches.filter((p) => p.id === "tw-t1").length, 1, "one patch after the refit");
  assert.ok(after.pieces.every((p, i) => Math.abs(p.position[1] - before.pieces[i]!.position[1] - (after.baseY - before.baseY)) < 1e-6));
  assert.equal(terraceGates(raised, raised.features.terraceWalls![0]!).stale, false);
});

test("inserts: a stair-turn and an arched doorway are placed, the door carved, the pad keeps a roof over it", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside();
  const kit = loadTerraceKit("proving", () => {});
  const fit = fitTerraceWall(recipe, doc({ id: "t2", ...footprintFromPath([[0, 6], [24, 6]], 10), height: 4.5, inserts: [{ role: "stair-turn", edge: 0, at: 4 }, { role: "door-arch", edge: 0, at: 14 }] }) as never, kit);
  const s = fit.doc.solved!;
  assert.ok(s.pieces.some((p) => p.role === "stair-turn"));
  assert.ok(s.pieces.some((p) => p.role === "door-arch"));
  assert.ok(s.cuts.some((c) => c.kind === "door"));
  assert.ok(s.sockets.some((k) => k.tag === "socket:interior"));
  // a lattice row between the passage roof and the pad top
  const roof = s.baseY + 3.5;
  assert.ok(Math.ceil(roof / 2) * 2 <= s.topY - 0.15 + 1e-9, `no lattice row between ${roof} and ${s.topY}`);
});

test("natural style fails clearly without the shelf kit, and builds its masonry fallback", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside();
  const real = loadTerraceKit("proving", () => {});
  // a kit with no natural shelves, whatever is installed
  const kit = { ...real, resolve: (style: string) => { if (style === "natural") throw new Error("natural terraces need the natural shelf kit"); return real.resolve(style as never); } };
  assert.throws(() => fitTerraceWall(recipe, doc({ id: "t3", style: "natural" }) as never, kit as never), /natural shelf kit/);
  const fit = fitTerraceWall(recipe, doc({ id: "t3", style: "natural", fallback: "masonry-common" }) as never, kit as never);
  assert.equal(fit.doc.solved!.style, "masonry-common");
  assert.match(fit.doc.solved!.warnings.join(" "), /natural shelf kit missing/);
});

test("natural style builds rock shelves when the shelf kit is installed", { skip: !fs.existsSync(path.resolve(import.meta.dirname, "../projects/world-kit/authoring/rock-kit/shelf-lookup.json")) && "no natural shelf kit" }, () => {
  const recipe = hillside();
  const kit = loadTerraceKit("proving", () => {});
  const fit = fitTerraceWall(recipe, doc({ id: "t4", style: "natural", inserts: [{ role: "stair", edge: 0, at: 6 }] }) as never, kit);
  const s = fit.doc.solved!;
  assert.equal(s.style, "natural");
  assert.ok(s.pieces.every((p) => p.prefab.startsWith("rock-kit/")));
  assert.ok(s.pieces.some((p) => p.role === "rock-steps"));
});

test("shelfFootprint: a diagonal town shelf becomes one simple rectilinear outline on the 2 m grid", () => {
  const fp = shelfFootprint([[0, 0], [60, 35], [100, 58]], 12)!;
  assert.ok(fp && fp.length >= 4);
  const keys = new Set(fp.map((p) => p.join(",")));
  assert.equal(keys.size, fp.length, "no vertex twice (a pinched outline)");
  let area = 0;
  fp.forEach((p, i) => {
    const q = fp[(i + 1) % fp.length]!;
    assert.ok(p[0] === q[0] || p[1] === q[1], "axis-aligned");
    assert.ok(p[0] % 2 === 0 && p[1] % 2 === 0, "on the 2 m grid");
    area += p[0] * q[1] - q[0] * p[1];
  });
  assert.ok(area < 0, "pad on the left (the walls' winding)");
});

test("auto walls never end a run at an inner corner (the open edge there would stand beside the foot strip)", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside();
  const kit = loadTerraceKit("proving", () => {});
  // an L whose notch opens downhill: the notch's corner is concave
  const fp: [number, number][] = [[0, 6], [16, 6], [16, -2], [28, -2], [28, -10], [0, -10]];
  const fit = fitTerraceWall(recipe, { id: "t5", style: "masonry-common", footprint: fp, walls: "auto", height: 3, facing: [0, 1] } as never, kit);
  const n = fp.length;
  const dir = (i: number) => { const a = fp[i]!, b = fp[(i + 1) % n]!; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const inner = (i: number, j: number) => { const p = dir(i), q = dir(j); return p[0]! * q[1]! - p[1]! * q[0]! > 1e-9; };
  for (const r of fit.doc.solved!.runs) {
    if (r.closed) continue;
    const first = r.edges[0]!, last = r.edges[r.edges.length - 1]!;
    assert.ok(!inner((first + n - 1) % n, first), `run starts at an inner corner: ${r.edges}`);
    assert.ok(!inner(last, (last + 1) % n), `run ends at an inner corner: ${r.edges}`);
  }
});

test("any angle: a wall on a 30 deg diagonal with a 15 deg bend plans on the run grid and draws a clean riser", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside(0.3);
  const kit = loadTerraceKit("proving", () => {});
  // a wall line heading 30 deg off +X, bending 15 deg left half way; pad on its left (uphill, -Z side)
  const r = (deg: number, l: number, from: [number, number]): [number, number] => [from[0] + Math.cos((deg * Math.PI) / 180) * l, from[1] - Math.sin((deg * Math.PI) / 180) * l];
  const a: [number, number] = [-20, 30], b = r(-30, 20, a), c = r(-15, 20, b);
  const pad: [number, number][] = [a, b, c, r(75, 12, c), r(60, 12, a)];
  const fit = fitTerraceWall(recipe, { id: "t6", style: "masonry-common", footprint: pad, walls: [0, 1], height: 3 } as never, kit);
  const sd = fit.doc.solved!;
  assert.ok(sd.pieces.some((p) => /^corner-(outer|inner)-a15$/.test(p.role)), sd.pieces.map((p) => p.role).join(","));
  assert.ok(sd.pieces.some((p) => Math.abs(((p.yaw % 90) + 90) % 90) > 1), "pieces at a non-axis yaw");
  applyTerraceFit(recipe, fit);
  const field = createWorldField(recipe);
  const g = terraceGates(recipe, fit.doc, { field });
  assert.equal(g.riser.gutter <= 0.25 && g.riser.against <= 0.3, true, g.lines.join("\n"));
  assert.equal(g.seated.foot.gap <= 0.25 && g.seated.foot.clip <= 0.6, true, g.lines.join("\n"));
});

// ------------------------------------------------------------------ town risers solved together

/** Three stacked pads up the hillside (ground = 20 - 0.35 z): each wall faces +Z, downhill. */
function stackedRisers() {
  const pads = [
    { z0: 30, z1: 18, top: 9.5 }, // riser-1: wall at z = 30, pad back to z = 18
    { z0: 18, z1: 6, top: 13.9 }, // riser-2: its foot on riser-1's pad, a 4.4 m wall
    { z0: 6, z1: -6, top: 18.3 }, // riser-3
  ];
  return pads.map((p, k) => terraceWallSchema.parse({
    id: `town-x-riser-${k + 1}`, owner: "town-x", tags: ["town-riser"], style: "masonry-common",
    footprint: [[-24 + 2 * k, p.z0], [24 - 2 * k, p.z0], [24 - 2 * k, p.z1], [-24 + 2 * k, p.z1]],
    walls: [0], topY: p.top, height: k === 0 ? 3 : 4.4, strip: 6, feather: 8,
  }));
}

test("town risers solve TOGETHER: bottom-up, masked patches in chain order, every gate passes, and a refit of one refits the chain to the same result", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside();
  const kit = loadTerraceKit("proving", () => {});
  // given top-down, solved bottom-up
  const fits = solveTerraceChain(recipe, [...stackedRisers()].reverse(), kit);
  assert.deepEqual(fits.map((f) => f.doc.id), ["town-x-riser-1", "town-x-riser-2", "town-x-riser-3"]);
  const tw = () => recipe.features.heightPatches.filter((p) => p.id.startsWith("tw-"));
  assert.deepEqual(tw().map((p) => p.id), ["tw-town-x-riser-1", "tw-town-x-riser-2", "tw-town-x-riser-3"], "a higher pad's patch comes later (wins)");
  assert.ok(tw().every((p) => p.weights?.length === p.heights.length), "masked patches");
  const field = createWorldField(recipe);
  for (const f of fits) {
    const g = terraceGates(recipe, f.doc, { field, faults: true });
    assert.ok(g.ok, `${f.doc.id}\n${g.lines.join("\n")}`);
  }
  // riser-2's foot strip is riser-1's pad: the same level
  assert.equal(fits[1]!.doc.solved!.baseY, fits[0]!.doc.solved!.topY);
  // one riser named: the whole chain is refitted, bottom-up, and lands where it was (deterministic, converged)
  const before = JSON.stringify(recipe.features.terraceWalls!.map((t) => t.solved));
  const patchesBefore = JSON.stringify(tw());
  const again = refitGrouped(recipe, recipe.features.terraceWalls!.filter((t) => t.id === "town-x-riser-2"), kit);
  assert.equal(again.length, 3, "the chain, not the one");
  assert.equal(JSON.stringify(recipe.features.terraceWalls!.map((t) => t.solved)), before);
  assert.equal(JSON.stringify(tw()), patchesBefore);
  const f2 = createWorldField(recipe);
  for (const t of recipe.features.terraceWalls!) assert.equal(terraceGates(recipe, t, { field: f2 }).stale, false, t.id);
});

test("a masked riser patch does not freeze the ground under it: outside the levelled ground the hill shows through", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside();
  const kit = loadTerraceKit("proving", () => {});
  const fit = fitTerraceWall(recipe, stackedRisers()[0]!, kit);
  applyTerraceFit(recipe, fit);
  const p = fit.patch;
  // a corner sample of the patch box, far outside the pad and its feather: weight 0, the ground is the hill's own
  const cx = p.origin[0] + 2, cz = p.origin[1] + 2;
  const k = Math.round((cx - p.origin[0]) / (p.size[0] / (p.columns - 1))) + Math.round((cz - p.origin[1]) / (p.size[1] / (p.rows - 1))) * p.columns;
  assert.equal(p.weights![k], 0);
  const bare = createWorldField(naturalRecipe(recipe, fit.doc.id));
  assert.ok(Math.abs(createWorldField(recipe).height(cx, cz) - bare.height(cx, cz)) < 1e-6);
});

test("townShelfOutlines keeps neighbouring pads apart; splitShelf only between shelves that run along each other; trimShelfTo keeps an upper shelf over the one below", () => {
  // two parallel shelves 16 m apart with 12 m radii: plain outlines (10.5 m half-widths) overlap by 5 m
  const a = { points: [[0, 0], [60, 0]] as [number, number][], radius: 12 };
  const b = { points: [[0, -16], [60, -16]] as [number, number][], radius: 12 };
  const [oa, ob] = townShelfOutlines([a, b]);
  assert.ok(oa && ob);
  assert.equal(outlinesOverlap(oa!, ob!), false);
  const shelf = (id: string, pts: [number, number][], y: number) => ({ id, points: pts, radius: 10, falloff: 4, groundY: y, flatten: 0, tags: [] as string[] });
  const lo = shelf("t-terrace-1", [[0, 0], [60, 0]], 10), hi = shelf("t-terrace-2", [[0, -30], [60, -30]], 22);
  const mid = splitShelf(lo, hi, "t", ["t-terrace-1", "t-terrace-2"])!;
  assert.ok(mid, "parallel shelves 30 m apart take a shelf between");
  assert.equal(mid.id, "t-terrace-3");
  assert.ok(mid.points.every((p) => Math.abs(p[1] + 15) < 1e-6), JSON.stringify(mid.points));
  assert.equal(splitShelf(lo, shelf("t-terrace-2", [[30, -20], [30, -80]], 22), "t", []), null, "a shelf climbing across the one below: no split");
  assert.equal(splitShelf(lo, shelf("t-terrace-2", [[0, -12], [60, -12]], 22), "t", []), null, "too close for a third pad");
  // trim: an upper shelf running past the lower one's ends stops 2 m inside them
  assert.deepEqual(trimShelfTo([[-20, -16], [80, -16]], [[0, 0], [60, 0]], 2), [[2, -16], [58, -16]]);
  assert.deepEqual(trimShelfTo([[30, -20], [30, -80]], [[0, 0], [60, 0]], 2), [[30, -20], [30, -80]], "across: untouched");
});

test("townTerraceWalls: a drop too tall for one wall is split into two stacked terraces, and every wall left passes its gates", { skip: !haveKit && "world-kit retaining-wall kit not installed" }, () => {
  const recipe = hillside();
  const kit = loadTerraceKit("proving", () => {});
  // natural ground 20 - 0.35 z: shelves at z = 30 (9.5 m) and z = 0 (20 m): 10.5 m apart in height, 30 m on plan
  recipe.features.towns = [{
    id: "town-x", tier: "town", center: [0, 12], radius: 45, falloff: 20, groundY: 9.5, flatten: 0, gates: [], tags: [],
    terraces: [
      { id: "town-x-terrace-1", points: [[-30, 30], [30, 30]], radius: 9, falloff: 4, groundY: 9.5, flatten: 1, tags: [] },
      { id: "town-x-terrace-2", points: [[-30, 0], [30, 0]], radius: 9, falloff: 4, groundY: 20, flatten: 1, tags: [] },
    ],
  } as never];
  const lines: string[] = [];
  const { fits } = townTerraceWalls(recipe, recipe.features.towns[0]!, kit, [], (s) => lines.push(s), 6);
  const log = lines.join("\n");
  assert.match(log, /split, new shelf town-x-terrace-3/, log);
  assert.equal(recipe.features.towns[0]!.terraces.length, 3);
  assert.ok(fits.length >= 2, log);
  const field = createWorldField(recipe);
  for (const f of fits) {
    assert.ok(f.doc.solved!.height <= 6.4 + 1e-9, `${f.doc.id} ${f.doc.solved!.height} m`);
    const g = terraceGates(recipe, f.doc, { field, faults: true });
    assert.ok(g.ok, `${f.doc.id}\n${g.lines.join("\n")}\n${log}`);
  }
});
