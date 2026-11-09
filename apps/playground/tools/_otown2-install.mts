// o-town2 scratch (deleted when the round ends): Bell Strand (town-1) into a scene as ONE ops batch (the lab first; live
// only on the coordinator's go). Every building is its shipped strand-town prefab at the design's exact position and
// facing (origin = footprint centre - facing x zc, floor 0.6 m over its terrace); the curtain is the kit record's
// placements (towns/town-1-works/kit-wall.json, tag town-wall:town-1) on the town floor; the square, smithy and strand
// get their grey-box dressing (strand-props stone: well, trough, mounting steps; small nets only).
//   npx tsx tools/_otown2-install.mts --project <p> --scene <scene id> [--dry]
//   writes authoring/towns/town-1-install-ops.json ({ ops, inverse }) in that project
import fs from "node:fs";
import { ComponentRegistry, applyOps, keepOutAtDoor, pointInPolygon, registerCoreComponents, solvePlacement, type Op, type SceneDoc } from "@hitreg/core";
import { applyOpsToSceneFile } from "./_scene-write.mts";
import { prefabGeometry } from "./_prop-geometry.mts";
import { baseFlats, prefabInfo, requestFor, sceneContext } from "./_place-solve.mts";
import { townContext } from "./town-seated.mts";

type V2 = [number, number];
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const PROJ = `projects/${opt("project") ?? "otown2-lab"}`, SCENE = opt("scene") ?? "otown2lab";
const T = `${PROJ}/authoring/towns`;
const design = JSON.parse(fs.readFileSync(`${T}/town-1-design.json`, "utf8"));
const layout = JSON.parse(fs.readFileSync(`${T}/town-1-layout.json`, "utf8"));
const kit = JSON.parse(fs.readFileSync(`${T}/town-1-works/kit-wall.json`, "utf8"));
const line = JSON.parse(fs.readFileSync(`${T}/town-1-wall-line.json`, "utf8"));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
// 6 decimals: a quaternion rounded to 3 is not unit (|q| up to 1.001) and scales a 12.8 m wall piece ~7 mm past its joint (z-fight)
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const quatY = (yawRad: number) => [0, r6(Math.sin(yawRad / 2)), 0, r6(Math.cos(yawRad / 2))];
const C: V2 = [640, -368], U: V2 = [-Math.SQRT1_2, -Math.SQRT1_2], V: V2 = [Math.SQRT1_2, -Math.SQRT1_2];
const W = (s: number, t: number): V2 => [C[0] + s * U[0] + t * V[0], C[1] + s * U[1] + t * V[1]];
const dirW = (a: number, b: number): V2 => { const x = a * U[0] + b * V[0], z = a * U[1] + b * V[1]; const l = Math.hypot(x, z); return [x / l, z / l]; };
const yawOf = (f: V2) => Math.atan2(f[0], f[1]);
const LEVEL: Record<string, number> = Object.fromEntries(design.terraces.map((t: any) => [t.id, t.level]));
const terraceOf = (id: string) => design.terraces.find((t: any) => t.buildings.includes(id))?.id as string;

const TAG = "town-building:town-1", ROOT = "town-town-1";
const sceneFile = `${PROJ}/assets/scenes/${SCENE}.scene.json`;
const scene = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
const ops: Op[] = [];
for (const [id, e] of Object.entries(scene.entities)) if (e.tags.includes(TAG) && (e.parent === null || !scene.entities[e.parent]?.tags.includes(TAG))) ops.push({ op: "remove-entity", id } as Op);
ops.push({ op: "add-entity", id: ROOT, entity: { name: "Town-1 (Bell Strand)", parent: null, tags: [TAG, "town:town-1"], components: { transform: {} } } } as never);
const add = (id: string, name: string, prefab: string, at: [number, number, number], yaw: number, tags: string[] = []) =>
  ops.push({ op: "add-entity", id, entity: { name, parent: ROOT, tags: [TAG, "town:town-1", ...tags], components: { transform: { position: at.map(r3), rotation: quatY(yaw) }, prefab: { prefabId: prefab, props: {}, overrides: [] } } } } as never);

// ---- buildings
const report: string[] = [];
for (const b of design.buildings) {
  const lot = layout.buildings.find((x: any) => x.id === b.id);
  const t = terraceOf(b.id), lvl = LEVEL[t]!;
  if (lot && Math.abs(lot.groundY - lvl) > 0.05) report.push(`! ${b.id}: layout ground ${lot.groundY} vs terrace ${lvl}`);
  const fl = Math.hypot(b.facing[0], b.facing[1]); const f: V2 = [b.facing[0] / fl, b.facing[1] / fl];
  const zc = line.zc[b.prefab] as number;
  const o: V2 = [b.at[0] - f[0] * zc, b.at[1] - f[1] * zc];
  // k-town6: a base face of the model (a plinth step, a footing ledge) lying IN the terrace plane z-fights the paving
  // (barracks 0.24 m2): lift the building until none is within 2.5 cm of it (FLAT_CLEAR, the solver flats rule)
  const up0 = b.prefab === "strand-town/strand-chapel" ? 1.25 : 0.6, bfl = baseFlats(PROJ.split("/")[1]!, b.prefab, prefabInfo(PROJ.split("/")[1]!, b.prefab)?.footing ?? 0);
  let up = up0; while (up < up0 + 0.06 && bfl.some((h) => Math.abs(h + up) < 0.025)) up += 0.005;
  if (up > up0) report.push(`flats: ${b.id} lifted ${(up - up0).toFixed(3)} m off a base face in the paving plane`);
  add(`t1-${b.id}`, `${b.name} (${b.prefab.split("/")[1]})`, b.prefab, [o[0], lvl + up, o[1]], yawOf(f), [`lot:${b.id}`]); // the chapel: its own 1.2 m plinth, grade 1.25 under the origin
  if (b.prefab === "strand-town/strand-workshop") {
    // the yard's open front on the workshop's back face (request back = at - facing x D/2)
    const D = b.request.size[1] * 3.2, yd = line.yard.depth as number;
    const y: V2 = [b.at[0] - f[0] * (D / 2 + yd / 2), b.at[1] - f[1] * (D / 2 + yd / 2)];
    add("t1-workshop-yard", "Cartwright's yard (strand-workshop-yard)", line.yard.prefab, [y[0], lvl, y[1]], yawOf(f), ["lot:workshop"]);
  }
  if (b.prefab === "strand-town/strand-smithy") {
    // the forge bay (model z 3.2..9.6 in front of the door wall): kiln, anvil, bellows, on the bay floor (plinth top)
    const R: V2 = [f[1], -f[0]];
    const at = (x: number, z: number, up = 0.6): [number, number, number] => [o[0] + R[0] * x + f[0] * z, lvl + up, o[1] + R[1] * x + f[1] * z];
    add("t1-smithy-kiln", "Smithy forge (blacksmith-kiln)", "strand-props/blacksmith-kiln", at(-5, 5.6, 0), yawOf(f), ["forge"]); // the open bay's floor is the yard ground in front of the plinth
    add("t1-smithy-anvil", "Smithy anvil", "house-interior/anvil", at(-1, 7), yawOf(f) + 0.3, ["forge"]);
    add("t1-smithy-bellows", "Smithy bellows", "town-craft/smiths-bellows-frame", at(-7.6, 5.2, 0.03), yawOf(f) + Math.PI / 2, ["forge"]);
  }
}
// ---- the curtain: the kit record, one level (the town floor), tagged for town-wall-line check
const wallY = LEVEL.town!;
kit.placements.forEach((p: any, i: number) => add(`t1-wall-${String(i).padStart(3, "0")}`, `Curtain ${p.kind} (${p.prefab.split("/")[1]})`, p.prefab, [p.position[0], wallY, p.position[2]], (p.yaw * Math.PI) / 180, ["town-wall:town-1", "wall"]));
// ---- Bell Square (toward the painting; k-town3 2026-10-31: Derek's walk -- the all-wood shelters in front of the cloth
// stalls removed; every stone piece in the Redstrand stone, strand-props re-skins, gate tools/town-grey.mts): stalls down both long sides and along the fork, the tree ring on the
// fork's island, waiting for its great dead tree (a prop request: DeadDriedTree blacked every frame, o-town 10-30), stone
// benches round it, the covered well by the chapel steps, trough + mounting steps + hitching rail by the inn, barrels
// and crates by the stalls
// k-town7: the corner WALL_SETS / MID_SETS no longer carry stalls or carts (rule below, `banned`)
const sq: [string, string, number, number, [number, number]][] = [
  ["stall-w1", "market-trades/baker-stall", 3, -11.2, [0, 1]], ["stall-w3", "market-trades/potter-stall", 15.5, -11.2, [0, 1]],
  ["stall-e1", "market-trades/fishmonger-stall", 6, 15.2, [0, -1]] /* k-town9: 3 -> 6, the walk pinched between it and tree-se (s 0.7, t 16.3) once the packed rows closed the corner */, ["stall-e3", "market-trades/greengrocer-stall", 14, 15.2, [0, -1]],
  ["stall-w2", "market-trades/greengrocer-stall", 9.5, -11.2, [0, 1]], ["stall-e2", "town-market/compact-market-stall", 8.5, 15.4, [0, -1]],
  // k-town5 (to the square painting, concept/town-1-square.png): the tree ring back on the Y-fork's island between the
  // two branches (it had been pushed into fork-east by the stair keep-out); the roofed stone WELL-HOUSE with its trough
  // right of the axial steps, a bench in front of it; garden beds, potted trees and a shade tree are prop requests
  // (props request: civic/kerbed-garden-bed, potted-citrus-tree, potted-olive-tree, square-shade-tree), staked at
  // (2, -9) / (2, 13) for the beds
  ["tree-ring", "strand-green/ringed-shade-tree", 7.5, 3.5, [-1, 0]],
  ["bench-1", "strand-props/stone-bench", 4.3, 3.5, [-1, 0]], ["bench-2", "strand-props/stone-bench", 12.6, 9.5, [-1, 0]],
  ["well", "strand-props/well-house", 16.5, 8.5, [-1, 0]], ["well-trough", "strand-props/covered-public-water-trough", 16.5, 12.2, [-1, 0]],
  ["trough", "strand-props/covered-public-water-trough", -1.5, 13, [0, -1]], ["steps", "strand-props/stone-mounting-steps", -2.5, -12.5, [0, 1]],
  ["rail", "town-market/hitching-rail", 0.5, -13.5, [0, 1]], ["sundial", "strand-props/civic-sundial", 16.5, -6, [-1, 0]],
  ["barrel-1", "poi-props/apples-barrel", 10.8, -12.8, [0, 1]] /* k-town9: 6.2 -> 10.8, the walk pinched between it and stall-w1 */, ["barrel-2", "poi-props/berry-barrel", 12.6, -12.8, [0, 1]], ["crate-1", "poi-props/crate", 18.2, -12.9, [0, 1]],
  ["barrel-3", "poi-props/apples-barrel", 5.9, 16.8, [0, -1]], ["crate-2", "poi-props/crate", 11.2, 16.9, [0, -1]], ["basket-1", "poi-props/basket", 16.9, 16.6, [0, -1]],
];
// k-town4: the chapel close's AXIAL stair (retaining-wall stair-axial) keeps its flight and a 4 m apron in front clear:
// a square piece inside that zone slides sideways along the square (t) to the nearer clear side (placement, not by hand)
const worldDir = `${PROJ}/assets/worlds`;
const recipeW = fs.readdirSync(worldDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(`${worldDir}/${f}`, "utf8"))).find((r) => r.name === design.world);
const stairKeep = (recipeW?.features?.terraceWalls ?? []).flatMap((tw: any) => (tw.solved?.pieces ?? []).filter((q: any) => q.role === "stair-axial").map((q: any) => {
  const y = (q.yaw * Math.PI) / 180, X: V2 = [Math.cos(y), -Math.sin(y)], Z: V2 = [Math.sin(y), Math.cos(y)];
  const depth = 6; // the flight reaches 4.8 m out at the close's 2 m drop (lookup plan front); 6 covers it
  return { o: [q.position[0], q.position[2]] as V2, X, Z, x0: -1.5, x1: (q.run ?? 6) + 1.5, z0: -1, z1: depth + 4 };
}));
const inKeep = (p: V2) => stairKeep.some((k: any) => { const dx = p[0] - k.o[0], dz = p[1] - k.o[1]; const lx = dx * k.X[0] + dz * k.X[1], lz = dx * k.Z[0] + dz * k.Z[1]; return lx > k.x0 && lx < k.x1 && lz > k.z0 && lz < k.z1; });
// k-town7 (Derek 11-02 "a TON of extra market stalls that make no sense"): a STALL CAP per market frontage -- one stall
// per STALL_PER m of the square's two long sides; the cap keeps the listed order's first, the rest are cut (reported)
const STALL_PER = +(process.env.STALL_PER ?? 16);
{ const sqP = design.squares.find((q: any) => q.id === "bell-square")?.polygon as V2[] | undefined;
  const sides = sqP ? sqP.map((p, i) => Math.hypot(sqP[(i + 1) % sqP.length]![0] - p[0], sqP[(i + 1) % sqP.length]![1] - p[1])).sort((x, y) => y - x) : [0, 0];
  const cap = Math.floor((sides[0]! + sides[1]!) / STALL_PER); let n = 0;
  for (let i = 0; i < sq.length; i++) if (/stall/.test(sq[i]![1])) { if (++n > cap) { report.push(`rule: stall cap ${cap} (${(sides[0]! + sides[1]!).toFixed(0)} m of frontage / ${STALL_PER}): cut ${sq[i]![0]}`); sq.splice(i--, 1); } } }
for (const [id, prefab, s, t0, fd] of sq) { let t = t0;
  if (inKeep(W(s, t))) { let d = 0.5; while (d < 14 && inKeep(W(s, t0 + d)) && inKeep(W(s, t0 - d))) d += 0.5; t = !inKeep(W(s, t0 + d)) ? t0 + d : t0 - d; report.push(`stair keep-out: square ${id} moved ${(t - t0).toFixed(1)} m across the square`); }
  const p = W(s, t); add(`t1-square-${id}`, `Bell Square ${id} (${prefab})`, prefab, [p[0], LEVEL.town! - (id.startsWith("stall") || id.startsWith("barrel") ? 0.045 : 0), p[1]], yawOf(dirW(fd[0], fd[1])), ["square-dressing"]); } // stalls and barrels 4.5 cm into the paving: the barrels' lowest tops stand ~2 cm over it (z-fight)
// ---- the strand: boats drawn up and SMALL nets (Derek 10-30: no giant net frames) by the boat shed
const bs = design.buildings.find((b: any) => b.id === "boat-shed");
if (bs) {
  const f: V2 = [bs.facing[0], bs.facing[1]], R: V2 = [f[1], -f[0]];
  // k-town5: the boats' keels 3 cm over the strand (boat-2's hull bottom z-fought the terrain, 0.018 m2)
  const at = (x: number, z: number): [number, number, number] => [bs.at[0] + R[0] * x + f[0] * z, LEVEL.strand! + 0.03, bs.at[1] + R[1] * x + f[1] * z];
  const items: [string, string, number, number, number][] = [
    ["boat-1", "codex-craft/beached-rowing-boat", -9, -4, 0.4], ["boat-2", "codex-craft/beached-rowing-boat", -9.5, 2, -0.3],
    ["net-frame", "rural-props/net-frame", 8.5, 3, 0], ["net-line", "rural-props/net-drying-line", 9, -5, Math.PI / 2],
  ];
  for (const [id, prefab, x, z, dy] of items) add(`t1-strand-${id}`, `Strand ${id} (${prefab})`, prefab, at(x, z), yawOf(f) + dy, ["strand-dressing"]);
}
const registry = new ComponentRegistry(); registerCoreComponents(registry);
// ---- k-town6 (Derek 11-02: the painting's greenery; "empty corners are begging to be filled"): every NEW piece is an
// intent (prefab, a spot, a facing) the PLACEMENT SOLVER corrects or drops (tools/_place-solve.mts: the built
// buildings, their door markers and the pieces already placed are obstacles/keep-outs; ground = the walked town floor).
// Corners are FOUND, not hand-picked: the 1 m cells of the town floor clear of every building envelope, street, square,
// door, stair and the curtain; each connected pocket gets a set chosen by what it touches (the barracks door: arms;
// the curtain: a lean-to with stacked goods and a palm; between houses: a planter and potted trees).
{
  const PROJECT = PROJ.split("/")[1]!;
  const doc0 = applyOps(structuredClone(scene), ops, registry).doc as any;
  const ground = townContext(PROJECT, "town-1", SCENE).ground;
  const ctx = sceneContext(PROJECT, doc0, ground, [C], { reach: 120 });
  const doorKO = layout.buildings.filter((b: any) => b.door).map((b: any) => keepOutAtDoor(`door:${b.id}`, b.door as V2, (b.facing ?? [0, 1]) as V2, 2.4));
  ctx.keepOuts = [...(ctx.keepOuts ?? []), ...doorKO];
  const placed: V2[] = [];
  const flatMemo = new Map<string, number[]>();
  const lowFlats = (prefab: string): number[] => { if (flatMemo.has(prefab)) return flatMemo.get(prefab)!; const a = new Map<number, number>();
    try { for (const t of prefabGeometry(`${PROJ}/assets`, prefab).tris) { const ys = [t.a[1], t.b[1], t.c[1]]; if (Math.max(...ys) - Math.min(...ys) > 0.01 || t.a[1] > 0.2) continue;
      const ar = Math.abs((t.b[0] - t.a[0]) * (t.c[2] - t.a[2]) - (t.c[0] - t.a[0]) * (t.b[2] - t.a[2])) / 2, k = Math.round(t.a[1] / 0.005) * 0.005; a.set(k, (a.get(k) ?? 0) + ar); } } catch { /* no geometry: no flats */ }
    const out = [...a].filter(([, v]) => v >= 0.03).map(([k]) => k); flatMemo.set(prefab, out); return out; };
  // k-town7 (Derek's walk 2026-11-02), rules every town install keeps: no wheel / cart / wagon prop inside a town (standing
  // ban, memory no-wheel-and-axle-props); market stalls only on a square or a market street, never as corner filler
  // along the curtain (they sat in random spots and blocked the walk)
  // k-town8 (Derek 11-02: lamp posts free-standing, NO hanging chain): a chain-hung / hanging / bracket lantern is refused
  const banned = (prefab: string, tags: string[]): string | null => /wheel|cart|wagon/i.test(prefab) ? "wheel / cart / wagon props are banned in towns"
    : /stall/i.test(prefab) && !tags.includes("square-dressing") ? "stalls stand only on a square or a market street"
    : /hanging-lantern|lantern-bracket|chain/i.test(prefab) ? "chain-hung lanterns are banned in towns (free-standing lamp posts only)" : null;
  // `check`: a rule the SOLVED spot must keep (palm clearance, a lamp close to its house front); a fault drops the piece
  const place = (id: string, prefab: string, at: V2, yaw: number, move = 2.5, tags: string[] = [], check?: (p: V2) => string | null, quiet = false): boolean => {
    { const why = banned(prefab, tags); if (why) { report.push(`rule: refused ${id} (${prefab}): ${why}`); return false; } }
    // every piece keeps its own base faces off the floor (the solver flats rule; requestFor gives them to structures only):
    // a barrel's floor or a box's bottom board 1.6 cm over the paving z-fought it (k-town6 lab zfight)
    const req = requestFor(PROJECT, id, prefab, at, yaw, 1, { movable: true, flats: baseFlats(PROJECT, prefab, prefabInfo(PROJECT, prefab)?.footing ?? 0) });
    if (!req) { report.push(`solver: ${id} ${prefab}: no catalogue size, not placed`); return false; }
    req.rule = { ...(req.rule ?? {}), tolerance: { ...((req.rule as any)?.tolerance ?? {}), move, yaw: 30 } } as never;
    const r = solvePlacement(req, ctx);
    if (r.status === "dropped") { if (!quiet) report.push(`solver: dropped ${id} (${prefab}): ${r.reason}`); return false; }
    if (inKeep([r.x!, r.z!])) { if (!quiet) report.push(`solver: dropped ${id}: in the chapel stair's apron`); return false; }
    { const why = check?.([r.x!, r.z!]); if (why) { if (!quiet) report.push(`rule: dropped ${id} (${prefab}): ${why}`); return false; } }
    // a small piece sinks past its own near-flat bottom faces (a barrel's disc 1.6 cm up, a box's 4.4 cm board): the
    // least sink >= the seat's 3 cm that leaves every one >= 2.5 cm off the floor plane (the zfight gate's 2 cm)
    let y = r.y!;
    if (4 * req.half[0] * req.half[1] < 6 && r.ground && r.ground.relief < 0.02) { const hs = lowFlats(prefab); let sk = 0.03; while (sk < 0.12 && hs.some((h) => Math.abs(h - sk) < 0.025)) sk += 0.005; y = r.ground.hi - sk; }
    add(id, `Bell Strand ${id.replace(/^t1-/, "")} (${prefab})`, prefab, [r.x!, y, r.z!], r.yaw ?? yaw, tags);
    const hx = req.half[0], hz = req.half[1];
    ctx.obstacles!.push({ id, box: { c: [r.x!, r.z!], half: [hx, hz], yaw: r.yaw ?? yaw }, band: [r.y! - 0.1, r.y! + req.height] });
    placed.push([r.x!, r.z!]);
    if (r.status === "moved") report.push(`solver: ${id} moved ${r.moved} m`);
    return true;
  };
  // -- k-town7 (the paintings: a lit lantern by every door at dusk): the catalogue's hanging lantern (town-lights,
  // one light bucket, the same prefab everywhere) on its bracket post backed to the house front beside the door, the
  // lantern hanging out over the step. The solver seats it; that building's own door keep-out is lifted for it only.
  // Derek 11-02: free-standing posts, no hanging chain, close to the houses (outdoor-lanterns/top-mounted-lamp-post)
  // k-town8: the town floor's geometry (used by the lamp, palm, bench and corner rules below)
  const town = design.terraces.find((t: any) => t.id === "town");
  const poly = town.polygon as V2[], wallLine = line.line as V2[];
  const segD = (p: V2, a: V2, b: V2) => { const vx = b[0] - a[0], vz = b[1] - a[1]; const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz || 1))); return Math.hypot(p[0] - a[0] - vx * u, p[1] - a[1] - vz * u); };
  const lineD = (p: V2, L: V2[], closed = false) => { let m = Infinity; for (let i = 0; i + 1 < L.length + (closed ? 1 : 0); i++) m = Math.min(m, segD(p, L[i]!, L[(i + 1) % L.length]!)); return m; };
  const inPoly = (p: V2, P: V2[]) => pointInPolygon(p[0], p[1], P);
  const envOf = (b: any) => (b.full ?? b.ground) as V2[];
  const envs = layout.buildings.filter((b: any) => b.terrace !== "town-1-strand").map(envOf);
  const doors = layout.buildings.filter((b: any) => b.door).map((b: any) => ({ id: b.id as string, at: b.door as V2 }));
  const DOOR_LAMP = process.env.DOOR_LAMP ?? "strand-props/lamp-post";
  for (const b of layout.buildings) {
    // no lamp in a gate passage or on a shed (the gate pair stood in the middle of Gate Road, k-town8 frame)
    if (!b.door || /shed|gate|tower|wall/.test(b.id)) continue;
    const f: V2 = (b.facing ?? [0, 1]) as V2, fl = Math.hypot(f[0], f[1]) || 1, fw: V2 = [f[0] / fl, f[1] / fl], side: V2 = [fw[1], -fw[0]];
    const ko = ctx.keepOuts ?? []; ctx.keepOuts = ko.filter((k: any) => k.id !== `door:${b.id}`);
    // Derek 11-02: CLOSE to the houses: the solved post stands within 1.3 m of its own building's envelope
    const E = envOf(b), close = (p: V2) => (inPoly(p, E) || lineD(p, E, true) <= 1.3 ? null : `${lineD(p, E, true).toFixed(1)} m off its house front (max 1.3)`);
    let ok1 = false;
    for (const sd of [1, -1]) { if (ok1) break; for (const off of [1.6, 2.1, 2.6]) {
      // the door marker is the keep-out point 2.5 m out from the envelope (k-town7 put the posts 0.6 m beyond it: in the
      // middle of the street); the post stands beside the steps, 0.6 m out from the house front
      const back = Math.max(0, lineD(b.door as V2, E, true) - 0.6), at: V2 = [b.door[0] + side[0] * off * sd - fw[0] * back, b.door[1] + side[1] * off * sd - fw[1] * back];
      if (place(`t1-door-lamp-${b.id}`, DOOR_LAMP, at, yawOf(fw), 0.4, ["door-lantern"], close, !process.env.K8_DBG)) { ok1 = true; break; } } }
    ctx.keepOuts = ko;
    if (!ok1) report.push(`door lantern: ${b.id} has no lawful spot beside its door`);
  }
  // k-town8 (Derek 11-02): PALMS get space and their own small bed: strand-green/palm-bed (1.8 m kerb), its kerb 2.5 m
  // off the curtain's inner face and every house envelope, and off every walkway (street / court edge + the bed's half)
  const PALM = process.env.PALM ?? "strand-green/palm-bed", PALM_CLEAR = +(process.env.PALM_CLEAR ?? 2.5), PALM_HALF = 0.9;
  // ...and never in the passage the town-walk measured (survey/town-1-walk.json trail; k-town8 round 3: a wall palm in the
  // only passage to the back walk stopped the in:gate walk, as the 4.2 m surround did in k-town7)
  const walkTrailF = `${T}/survey/town-1-walk.json`, walkTrail: V2[] = fs.existsSync(walkTrailF) ? JSON.parse(fs.readFileSync(walkTrailF, "utf8")).routes.flatMap((r: any) => r.trail.map((q: number[]) => [q[0], q[2]] as V2)) : [];
  const palmWhy = (p: V2): string | null => {
    if (walkTrail.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < PALM_HALF + 1.2)) return "on the walk trail";
    const dw = lineD(p, wallLine) - 1.2 - PALM_HALF; if (dw < PALM_CLEAR) return `kerb ${dw.toFixed(1)} m off the curtain (min ${PALM_CLEAR})`;
    for (const E of envs) { const d = inPoly(p, E) ? -1 : lineD(p, E, true) - PALM_HALF; if (d < PALM_CLEAR) return `kerb ${d.toFixed(1)} m off a house (min ${PALM_CLEAR})`; }
    for (const s of design.streets) { const d = lineD(p, s.points) - s.width / 2 - PALM_HALF; if (d < 0) return `on walkway ${s.id}`; }
    for (const q of design.squares) if (inPoly(p, q.polygon)) return `on ${q.id}`;
    // k-town9: off every OTHER terrace's edge too (the raised close's retaining wall): a bed 1 m off it pinched the walk
    for (const t of design.terraces) { if (inPoly(p, t.polygon)) continue; const d = lineD(p, t.polygon, true) - PALM_HALF; if (d < PALM_CLEAR && (t.level ?? 0) !== (design.terraces.find((u: any) => inPoly(p, u.polygon))?.level ?? 0)) return `kerb ${d.toFixed(1)} m off terrace ${t.id}'s edge (min ${PALM_CLEAR})`; }
    return null;
  };
  // k-town8 (Derek 11-02: "benches placed like a city: round the tree stands, facing walkways"): a stone bench beside a
  // tree stand on the side of the nearest walkway (street, court or square edge), facing it
  const walkways: V2[][] = [...design.streets.map((s: any) => s.points as V2[]), ...design.squares.map((q: any) => [...q.polygon, q.polygon[0]] as V2[])];
  const nearestWalk = (p: V2): V2 => { let best = Infinity, q: V2 = p; for (const L of walkways) for (let i = 0; i + 1 < L.length; i++) { const a = L[i]!, b = L[i + 1]!, vx = b[0] - a[0], vz = b[1] - a[1], u = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz || 1))), c: V2 = [a[0] + vx * u, a[1] + vz * u], d = Math.hypot(c[0] - p[0], c[1] - p[1]); if (d < best) { best = d; q = c; } } return q; };
  const benchFor = (id: string, tree: V2, R: number) => {
    const q = nearestWalk(tree), l = Math.hypot(q[0] - tree[0], q[1] - tree[1]) || 1, d: V2 = [(q[0] - tree[0]) / l, (q[1] - tree[1]) / l], t: V2 = [d[1], -d[0]];
    for (const [k, s] of [[0, 0], [1, 0.8], [2, -0.8]] as [number, number][]) if (place(`${id}-bench${k ? `-${k}` : ""}`, "strand-props/stone-bench", [tree[0] + d[0] * (R + 0.5) + t[0] * s, tree[1] + d[1] * (R + 0.5) + t[1] * s], yawOf(d), 0.3, ["bench", "tree-stand"], undefined, true)) return true;
    report.push(`bench: ${id} has no lawful spot between its tree stand and ${l.toFixed(1)} m to the walkway`); return false;
  };
  const placePalm = (id: string, at0: V2, tags: string[], bench = false): boolean => {
    // the first candidate (the spot, then 1 m steps toward the town centre) whose solved spot keeps the palm rule
    const toC: V2 = [C[0] - at0[0], C[1] - at0[1]], l = Math.hypot(toC[0], toC[1]) || 1;
    for (const k of [0, 1, 2, 3]) { const p: V2 = [at0[0] + toC[0] / l * k, at0[1] + toC[1] / l * k]; if (palmWhy(p)) continue;
      if (place(id, PALM, p, (k * 1.3) % 6.28, 1.0, tags, palmWhy, true)) { if (bench) benchFor(id, [p[0], p[1]], PALM_HALF); return true; } }
    return false;
  };
  // -- the square, to the painting: shade trees at both front corners and on the fork island (tree-surround + tree),
  // kerbed planters at the k-town5 stakes, potted trees by the west stalls, potted shrubs by the inn
  const sqGreen: [string, string, number, number, [number, number]][] = [
    // k-town8: the kerbed planters dotted on the square are gone (Derek: gardens are laid-out areas, not planters)
    ["tree-nw", "strand-green/ringed-shade-tree", -3.5, -14.5, [0, 1]], ["tree-se", "strand-green/ringed-shade-tree", -3.5, 17.5, [0, -1]],
    ["pot-1", "strand-green/potted-tree", 1, -12.8, [0, 1]], ["pot-2", "strand-green/potted-tree", 12.4, -11.2, [0, 1]], ["pot-3", "strand-green/potted-shrub", 18.5, -10.8, [0, 1]],
    ["pot-4", "strand-green/potted-tree", 5.6, 15.3, [0, -1]], ["pot-5", "strand-green/potted-shrub", 11.2, 15.6, [0, -1]],
  ];
  for (const [id, prefab, s, t, fd] of sqGreen) if (place(`t1-square-${id}`, prefab, W(s, t), yawOf(dirW(fd[0], fd[1])), 2.5, ["square-dressing", "green"]) && /shade-tree/.test(prefab)) benchFor(`t1-square-${id}`, W(s, t), 2.6);
  // -- free cells of the town floor
  const free = (p: V2) => inPoly(p, poly) && lineD(p, poly, true) >= 1.2 && lineD(p, wallLine) >= 2.4
    && envs.every((E: V2[]) => !inPoly(p, E) && lineD(p, E, true) >= 0.9)
    && design.streets.every((s: any) => lineD(p, s.points) >= s.width / 2 + 0.7)
    && design.squares.every((q: any) => !inPoly(p, q.polygon) && lineD(p, q.polygon, true) >= 0.6)
    && doors.every((d: any) => Math.hypot(p[0] - d.at[0], p[1] - d.at[1]) >= 3.5) && !inKeep(p)
    && placed.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= 2);
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs)), z0 = Math.floor(Math.min(...zs)), nx = Math.ceil(Math.max(...xs)) - x0, nz = Math.ceil(Math.max(...zs)) - z0;
  const cell = (i: number, j: number): V2 => [x0 + i + 0.5, z0 + j + 0.5];
  const ok = new Uint8Array(nx * nz); for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) ok[i * nz + j] = free(cell(i, j)) ? 1 : 0;
  const seen = new Uint8Array(nx * nz), pockets: V2[][] = [];
  for (let k = 0; k < nx * nz; k++) { if (!ok[k] || seen[k]) continue; const st = [k], cells: V2[] = []; seen[k] = 1;
    while (st.length) { const c = st.pop()!, i = Math.floor(c / nz), j = c % nz; cells.push(cell(i, j));
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di!, b = j + dj!; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const q = a * nz + b; if (ok[q] && !seen[q]) { seen[q] = 1; st.push(q); } } }
    if (cells.length >= 10) pockets.push(cells); }
  report.push(`corners: ${pockets.length} empty pocket(s) of >= 10 m2 on the town floor (${pockets.map((p) => p.length).join(", ")} m2)`);
  if (process.env.K6_MAP) { const rows: string[] = []; for (let j = 0; j < nz; j += 2) { let r = ""; for (let i = 0; i < nx; i += 2) { const p = cell(i, j); const k = pockets.findIndex((c) => c.some((q) => q[0] === p[0] && q[1] === p[1])); r += k >= 0 ? String(k + 1) : inPoly(p, poly) ? (envs.some((E: V2[]) => inPoly(p, E)) ? "#" : design.streets.some((s: any) => lineD(p, s.points) < s.width / 2) ? "=" : ".") : " "; } rows.push(r); } console.log(`x0 ${x0} z0 ${z0} (2 m/char, +x right, +z down)\n` + rows.join("\n")); }
  // -- a set per pocket: spots are pocket cells (nearest the wall / the door / the middle), the solver has the last word
  const barracks = layout.buildings.find((b: any) => b.id === "barracks");
  const wallDir = (p: V2): V2 => { let best = Infinity, n: V2 = [0, 1]; for (let i = 0; i + 1 < wallLine.length; i++) { const a = wallLine[i]!, b = wallLine[i + 1]!, d = segD(p, a, b); if (d < best) { best = d; const vx = b[0] - a[0], vz = b[1] - a[1], u = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz))); const qx = a[0] + vx * u, qz = a[1] + vz * u, l = Math.hypot(p[0] - qx, p[1] - qz) || 1; n = [(p[0] - qx) / l, (p[1] - qz) / l]; } } return n; };
  // big pockets are split into ~11 m tiles on the town's own axes (U, V), each tile >= 30 m2 one set; sets rotate so
  // two neighbouring tiles never repeat (Derek: a believable walled town, not one yard copied round the curtain)
  const tiles: V2[][] = [];
  for (const cells of pockets) { const g = new Map<string, V2[]>(); for (const c of cells) { const d: V2 = [c[0] - C[0], c[1] - C[1]], k = `${Math.floor((d[0] * U[0] + d[1] * U[1]) / 11)}|${Math.floor((d[0] * V[0] + d[1] * V[1]) / 11)}`; (g.get(k) ?? g.set(k, []).get(k)!).push(c); }
    for (const t of g.values()) if (t.length >= (cells.length < 60 ? 10 : 30)) tiles.push(t); }
  report.push(`corners: ${tiles.length} tile(s) to dress`);
  // -- k-town8 (Derek's walk 11-02): the town's TRADES beside the chapel, found on the free floor, never hand-placed.
  // Seen from the square (the square's centre to the chapel), RIGHT of the chapel behind the houses: the open-air forge
  // on its raised stone patio (strand-props/forge-patio, steps toward the nearest walkway); LEFT: the mage tower (the
  // kit's strand-wall-tower, a stand-in until the Codex mage-tower piece) with a laid-out garden beside it
  const chapelB = design.buildings.find((b: any) => b.id === "chapel"), sqPoly = design.squares.find((q: any) => q.id === "bell-square")?.polygon as V2[] | undefined;
  if (chapelB && sqPoly) {
    const sqC: V2 = [sqPoly.reduce((a, p) => a + p[0], 0) / sqPoly.length, sqPoly.reduce((a, p) => a + p[1], 0) / sqPoly.length];
    const ch: V2 = chapelB.at, fl = Math.hypot(ch[0] - sqC[0], ch[1] - sqC[1]) || 1, fc: V2 = [(ch[0] - sqC[0]) / fl, (ch[1] - sqC[1]) / fl], right: V2 = [-fc[1], fc[0]];
    const cellsOn = (sd: number) => pockets.flat().filter((c) => ((c[0] - ch[0]) * right[0] + (c[1] - ch[1]) * right[1]) * sd > 4).sort((a, b) => Math.hypot(a[0] - ch[0], a[1] - ch[1]) - Math.hypot(b[0] - ch[0], b[1] - ch[1]));
    const faceWalk = (p: V2): V2 => { const q = nearestWalk(p), l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
    // a trade never stands ON a walkway (round 1: the tower sat 3.2 m off Tower Lane's centre and blocked the walk):
    // its footprint radius R + 0.8 m clear of every street / court edge and square
    // i-town2 (k-town9 see-through seam: the forge patio's awning post stood against the curtain): a trade's footprint
    // radius R keeps TRADE_WALL_AIR clear of the curtain's inner face (line - 1.2 m, as the palm rule)
    const TRADE_WALL_AIR = +(process.env.TRADE_WALL_AIR ?? 2);
    const offCurtain = (R: number, inner: (p: V2) => string | null) => (p: V2): string | null => { const d = lineD(p, wallLine) - 1.2 - R; return d < TRADE_WALL_AIR ? `${d.toFixed(1)} m off the curtain (min ${TRADE_WALL_AIR})` : inner(p); };
    const offWalk = (R: number) => (p: V2): string | null => { for (const st of design.streets) { const d = lineD(p, st.points) - st.width / 2 - R; if (d < 0.8) return `${d.toFixed(1)} m off walkway ${st.id} (min 0.8)`; } for (const q of design.squares) if (inPoly(p, q.polygon) || lineD(p, q.polygon, true) < R + 0.8) return `on ${q.id}`; return null; };
    // ...and off the town-walk's last measured trail (survey/town-1-walk.json: the in:gate route to every terrace's
    // centre; round 2 the tower stood in the only passage to the back walk): R + 1 m clear of every trail point
    const walkF = `${T}/survey/town-1-walk.json`, trail: V2[] = fs.existsSync(walkF) ? JSON.parse(fs.readFileSync(walkF, "utf8")).routes.flatMap((r: any) => r.trail.map((q: number[]) => [q[0], q[2]] as V2)) : [];
    const offTrail = (R: number, inner: (p: V2) => string | null) => (p: V2): string | null => trail.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < R + 1) ? "on the walk trail" : inner(p);
    const tryOn = (sd: number, id: string, prefab: string, tags: string[], R = 4.0, tries = 200): V2 | null => {
      for (const c of cellsOn(sd).filter((c) => !trail.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < R + 1)).slice(0, tries)) { const f = faceWalk(c); if (place(id, prefab, c, yawOf(f), 1.0, tags, offTrail(R, offCurtain(R, offWalk(R))), true)) return c; }
      report.push(`trades: ${id} (${prefab}) found no free spot on the chapel's ${sd > 0 ? "right" : "left"}`); return null; };
    // Derek 11-02 (live walk): the forge patio stands square to the rampart, its back SMACK against the curtain's inner
    // face, its steps (+Z) facing into the town. Candidates: the right-side cells within 14 m of the curtain; each is
    // snapped to the nearest wall point, backed onto the face (line - 1.2 m) by the patio's back edge (PATIO_BACK).
    const PATIO_BACK = +(process.env.PATIO_BACK ?? 3.45);
    const wallFoot = (p: V2): { w: V2; n: V2; d: number } => { let best = { w: p, d: Infinity }; for (let i = 0; i + 1 < wallLine.length; i++) { const a = wallLine[i]!, b = wallLine[i + 1]!, vx = b[0] - a[0], vz = b[1] - a[1], u = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz || 1))), c: V2 = [a[0] + vx * u, a[1] + vz * u], d = Math.hypot(c[0] - p[0], c[1] - p[1]); if (d < best.d) best = { w: c, d }; } const l = best.d || 1; return { w: best.w, n: [(p[0] - best.w[0]) / l, (p[1] - best.w[1]) / l], d: best.d }; };
    const PATIO_SIDE = +(process.env.PATIO_SIDE ?? 3.55);
    // how far the floor runs free ahead of the steps (0.5 m steps up to 12 m): stops at a placed obstacle's box or the
    // curtain's inner face
    const openAhead = (p: V2, f: V2): number => { for (let s = 0; s <= 12; s += 0.5) { const q: V2 = [p[0] + f[0] * s, p[1] + f[1] * s]; if (lineD(q, wallLine) < 1.6) return s; if ((ctx.obstacles ?? []).some((o: any) => { const dx = q[0] - o.box.c[0], dz = q[1] - o.box.c[1], cy = Math.cos(o.box.yaw ?? 0), sy = Math.sin(o.box.yaw ?? 0), lx = dx * cy - dz * sy, lz = dx * sy + dz * cy; return Math.abs(lx) < o.box.half[0] + 0.4 && Math.abs(lz) < o.box.half[1] + 0.4; })) return s; } return 12; };
    let forgeSteps: V2 | null = null;
    const backedForge = (): V2 | null => {
      const id = "t1-forge-patio", prefab = process.env.FORGE ?? "strand-props/forge-patio", seen = new Set<string>();
      for (const c of cellsOn(1).filter((c) => lineD(c, wallLine) < 14).slice(0, 300)) {
        const { w, n } = wallFoot(c), t: V2 = [-n[1], n[0]];
        // the steps face the most open floor: back to the wall (steps inward), or a side to the wall (steps along it)
        const opts = ([[n, PATIO_BACK], [t, PATIO_SIDE], [[-t[0], -t[1]] as V2, PATIO_SIDE]] as [V2, number][]).map(([f, off]) => {
          const at: V2 = [w[0] + n[0] * (1.2 + off), w[1] + n[1] * (1.2 + off)], front: V2 = [at[0] + f[0] * 3.6, at[1] + f[1] * 3.6];
          return { f, at, open: openAhead(front, f) };
        }).sort((a, b) => b.open - a.open);
        for (const o of opts) {
          const k = `${o.at[0].toFixed(1)}|${o.at[1].toFixed(1)}|${o.f.map((v) => v.toFixed(1))}`;
          if (seen.has(k)) continue; seen.add(k);
          if (o.open < 4) continue; // a stair that runs into a house back is no front
          if (place(id, prefab, o.at, yawOf(o.f), 0.3, ["trade", "forge"], offTrail(1.5, offWalk(3.6)), true)) { forgeSteps = o.f; report.push(`trades: forge patio backed on the curtain, ${o.open.toFixed(1)} m open before its steps`); return o.at; }
        }
      }
      report.push("trades: the forge patio found no wall-backed spot on the chapel's right; falling back to the free floor"); return null; };
    const forge = backedForge() ?? tryOn(1, "t1-forge-patio", process.env.FORGE ?? "strand-props/forge-patio", ["trade", "forge"]);
    if (forge) { const f = forgeSteps ?? faceWalk(forge); ctx.keepOuts!.push(keepOutAtDoor("door:forge-patio", [forge[0] + f[0] * 3.9, forge[1] + f[1] * 3.9], f, 2.4)); report.push(`trades: forge patio at ${forge.map((v) => v.toFixed(1))}, steps facing ${f.map((v) => v.toFixed(2))}`); }
    const tower = tryOn(-1, "t1-mage-tower", process.env.MAGE_TOWER ?? "strand-town/strand-wall-tower", ["trade", "mage-tower"]);
    if (tower) {
      report.push(`trades: mage tower at ${tower.map((v) => v.toFixed(1))}`);
      // its garden: the nearest free left-side spot to the tower that takes the whole formal garden
      const near = cellsOn(-1).sort((a, b) => Math.hypot(a[0] - tower[0], a[1] - tower[1]) - Math.hypot(b[0] - tower[0], b[1] - tower[1])).filter((c) => Math.hypot(c[0] - tower[0], c[1] - tower[1]) > 6.5).slice(0, 40);
      if (!near.some((c) => place("t1-mage-garden", "strand-green/formal-garden", c, yawOf(faceWalk(c)), 1.0, ["trade", "mage-tower", "garden"], offWalk(3.4), true))) report.push("trades: the mage tower's garden found no room beside it");
    }
  }
  // k-town8: "garden" = ONE laid-out formal garden (strand-green/formal-garden: kerbed beds, a path cross), at most
  // GARDEN_MAX in town and only where it fits whole; "palms" = palms in their own beds with a bench facing the walkway
  const GARDEN_MAX = +(process.env.GARDEN_MAX ?? 3); let gardens = 0;
  const WALL_SETS = ["yard", "palms", "garden", "palms"], MID_SETS = ["garden", "palms"];
  let n = 0, nw = 0, nm = 0, arms = false;
  for (const cells of tiles) {
    const mid: V2 = [cells.reduce((a, c) => a + c[0], 0) / cells.length, cells.reduce((a, c) => a + c[1], 0) / cells.length];
    const byWall = [...cells].sort((a, b) => lineD(a, wallLine) - lineD(b, wallLine)), wallNear = lineD(byWall[0]!, wallLine) < 4.5;
    const nearest = (p: V2) => [...cells].sort((a, b) => Math.hypot(a[0] - p[0], a[1] - p[1]) - Math.hypot(b[0] - p[0], b[1] - p[1]))[0]!;
    const tag = `corner-${++n}`;
    const P = (prefab: string, at: V2, yaw: number) => place(`t1-${tag}-${prefab.split("/")[1]}-${placed.length}`, prefab, at, yaw, 2.5, ["corner-dressing", tag]);
    const near = nearest(barracks?.door ?? [1e9, 1e9]);
    if (!arms && barracks?.door && Math.hypot(near[0] - barracks.door[0], near[1] - barracks.door[1]) < 8) {
      // the arms by the barracks door: racks backed to the barracks front, a crate of kit
      arms = true; const f: V2 = barracks.facing, side: V2 = [f[1], -f[0]], at = near;
      P("town-stone-armory/weapon-shield-rack", [at[0] + side[0] * 0.8, at[1] + side[1] * 0.8], yawOf(f));
      P("town-stone-armory/armor-rack", [at[0] + side[0] * 2.2, at[1] + side[1] * 2.2], yawOf(f));
      P("poi-props/crate", [at[0] - side[0] * 0.4, at[1] - side[1] * 0.4], yawOf(f) + 0.3);
      continue;
    }
    const kind = wallNear ? WALL_SETS[nw++ % WALL_SETS.length]! : MID_SETS[nm++ % MID_SETS.length]!;
    const w = wallNear ? byWall[0]! : nearest(mid), nrm = wallNear ? wallDir(w) : dirW(-1, 0), t: V2 = [nrm[1], -nrm[0]], face = yawOf(nrm);
    const at = (dt: number, dn: number): V2 => [w[0] + t[0] * dt + nrm[0] * dn, w[1] + t[1] * dt + nrm[1] * dn];
    if (kind === "yard") {
      // a yard against the curtain: a lean-to backed to it, stacked goods beside it
      // (no lean-to: carters-rest/lean-to z-fights its own frame against its roof, 21 clusters in the k-town6 lab)
      for (const [k, [pf, dt, dn]] of ([["house-furniture/barrel-a", 3.2, 0.6], ["house-furniture/barrel-a", 4.4, 0.7], ["poi-props/crate", 3.6, 1.8], ["house-furniture/grain-sack-a", 4.8, 2.0], ["poi-props/crate", -3.2, 0.8]] as [string, number, number][]).entries())
        P(pf, at(dt, dn), face + k * 0.4);
    } else if (kind === "stall") {
      // a stall with its barrels (the painting's corners): backed to the wall / facing the street
      P("town-market/compact-market-stall", at(0, 1.4), face);
      P("poi-props/apples-barrel", at(2.1, 0.9), face); P("poi-props/berry-barrel", at(2.3, 1.9), face + 0.5);
      P("poi-props/crate", at(-2.1, 0.8), face); P("poi-props/basket", at(-2.0, 1.8), face);
      P("strand-green/potted-tree", at(-3.4, 0.9), 0);
    } else if (kind === "palms") {
      const tg = ["corner-dressing", tag, "green"];
      const dn = wallNear ? 4.8 : 0; placePalm(`t1-${tag}-palm-a`, at(-2.6, dn), tg, true); placePalm(`t1-${tag}-palm-b`, at(2.6, dn + 0.2), tg);
    } else {
      // a garden: ONE laid-out formal garden where it fits whole (else a palm in its bed); no dotted planters
      const gAt = at(0, wallNear ? 5.5 : 0);
      if (!(gardens < GARDEN_MAX && place(`t1-${tag}-formal-garden`, "strand-green/formal-garden", gAt, face, 1.5, ["corner-dressing", tag, "garden"], undefined, true) && ++gardens)) placePalm(`t1-${tag}-palm`, gAt, ["corner-dressing", tag, "green"], true);
    }
  }
  // -- palms along the curtain's inner face where the floor runs clear (one every ~14 m, solver-checked); k-town8: in
  // their own beds, 2.5 m clear (centre 4.8 m off the line)
  for (let i = 0; i + 1 < wallLine.length; i++) { const a = wallLine[i]!, b = wallLine[i + 1]!, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 7; d < L - 3; d += 14) { const p: V2 = [a[0] + (b[0] - a[0]) * d / L, a[1] + (b[1] - a[1]) * d / L], nrm = wallDir([p[0] + (C[0] - p[0]) * 0.02, p[1] + (C[1] - p[1]) * 0.02]);
      const q: V2 = [p[0] + nrm[0] * 4.8, p[1] + nrm[1] * 4.8]; if (free(q)) placePalm(`t1-wall-palm-${i}-${d}`, q, ["corner-dressing", "green"]); } }
}
applyOps(structuredClone(scene), ops, registry); // validate first
console.log(report.join("\n"));
if (argv.includes("--dry")) { console.log(`would apply ${ops.length} ops`); process.exit(0); }
const res = applyOpsToSceneFile(sceneFile, ops, (d, o) => applyOps(d, o, registry), { label: "o-town2 town-1 install" });
fs.writeFileSync(`${T}/town-1-install-ops.json`, JSON.stringify({ ops, inverse: (res as any).inverse }, null, 1));
console.log(`applied ${ops.length} ops to ${sceneFile}; inverse in ${T}/town-1-install-ops.json`);
