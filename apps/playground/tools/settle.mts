/**
 * settle — lay out a SETTLEMENT (where people live) from a culture profile: households on the ground the culture wants,
 * all facing one gathering spot, each with its dwelling + kit, work where the work belongs, one connected path graph,
 * cover cleared under every dwelling / fire / yard, creature-group spots sized by tier; every prop footprint kept on
 * dry ground / open deck off the lanes the plan lays (catalogue sizes), area roles the props declare. Stilt cultures get a
 * deck grid: a communal deck, family compounds (platforms with huts, work frame, ramp + low boat landing; some raised a
 * ramp higher) composed from the kit's parts, wide walkways, work decks, landings, a ramp down to the bank.
 * The grammar is @hitreg/core `planSettlement` / `checkSettlement` (packages/core/src/dressing/settlement.ts).
 *
 *   npx tsx tools/settle.mts cultures [--project p]                      the culture profiles in the closure
 *   npx tsx tools/settle.mts plan  --project p --poi <id> --culture <id> --households N [--clusters N] [--wealth w]
 *          --centre x,z --radius r [--seed n] [--anchor gather=x,z] [--anchor approach=x,z] [--anchor work:<id>=x,z]
 *          [--size small|medium|large] [--scene <name>] [--recipe <file>] [--ignore <entity id prefix>]
 *        survey + layout; writes authoring/settlement/<poi>/ (plan.json, plan.svg, handoff-siteDressing.json, world-ops.json,
 *        scene-ops.json, kit-gaps.json) and one dressing plan per area (authoring/dressing/plans/<poi>-<area>.json); a stilt
 *        culture also writes its compound prefabs + deck frame (assets/prefabs/generated/settle/<poi>/). Never writes the
 *        world or the scene.
 *   npx tsx tools/settle.mts apply --project p --poi <id> --scene <name|file> [--recipe <file>] [--dry]
 *        world ops (vegetation clearings owner settle-<poi>, cover CLEARED; ribbon path operators via `worldgen op --apply`)
 *        and the stilt structures (one ops batch into the scene; inverse kept). Then: copy handoff-siteDressing.json into
 *        the POI's handoff.json `siteDressing`, `site-sockets`, and `dress check` / `dress apply --at 0,0,0 --yaw 0` per plan.
 *   npx tsx tools/settle.mts structures --project p --poi <id>
 *        re-solve a stilt village's prefabs + scene-ops.json + handoff-siteDressing/-navigation.json from its saved plan.json
 *        (layout and dressing plans untouched).
 *   npx tsx tools/settle.mts check --project p --poi <id> [--scene <name|file>] [--recipe <file>]
 *        the gate: households complete, door facing, spacing, reach over the path graph, cover cleared in the INSTALLED
 *        world (when the scene/recipe is given), stilt decks vs water, creature spots, tier. Last line `SETTLE <poi>: ... -> ok|FAILED`.
 *
 * Culture profiles are data: <project>/authoring/settlement/cultures/<id>.json (world-kit holds crockin, frogkin, ogre,
 * giant), schema `settlementCultureSchema`. Heavy (the world field, many prefabs): run inside heavy.mjs on a shared machine.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyOps, checkSettlement, ComponentRegistry, clearingSchema, dressingSchema, createWorldField, isLooseClutter, planSettlement, registerCoreComponents, settlementCultureSchema, settlementDressingPlans,
  settlementSiteDressing, settlementSvg, settlementWorldOps, stiltFootprint, stiltRoutes, walkwayPieces, worldRecipeSchema, type SettlementCulture, type SettlementPlan, type SettleGround, type SettlePropInfo, type WorldRecipe,
} from "@hitreg/core";
import { closure, findAsset, PROJECTS } from "./_closure.mjs";
import { applyOpsToSceneFile, updateJsonFile } from "./_scene-write.mts";
// @ts-expect-error untyped engine tool module
import { tierFor } from "../../../tools/poi-review/size-tiers.mjs";

type V2 = [number, number];
const argv = process.argv.slice(2), cmd = argv[0];
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const opts = (n: string): string[] => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]!] : []));
const flag = (n: string): boolean => argv.includes(`--${n}`);
const fail = (m: string): never => { console.error(`settle: ${m}`); process.exit(2); };
const need = (n: string): string => opt(n) ?? fail(`--${n} is required`);
const readJ = <T,>(f: string): T => JSON.parse(fs.readFileSync(f, "utf8")) as T;
const writeJ = (f: string, v: unknown): void => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + "\n"); };
const pair = (s: string): V2 => { const v = s.split(",").map(Number); if (v.length !== 2 || v.some((x) => !Number.isFinite(x))) fail(`bad x,z "${s}"`); return [v[0]!, v[1]!]; };
const project = opt("project") ?? "skelmorrow";
// the catalogue's dressing for every prop the profile names: sizes, rooms, setting, mount
const propInfo = new Map<string, SettlePropInfo | undefined>();
const props = (id: string): SettlePropInfo | undefined => {
  if (!propInfo.has(id)) {
    let v: SettlePropInfo | undefined;
    try {
      const doc = readJ<{ entities: Record<string, { components: { dressing?: unknown } }> }>(findAsset(project, `prefabs/${id}.json`)!);
      const raw = Object.values(doc.entities).find((x) => x.components.dressing)?.components.dressing;
      const d = raw ? dressingSchema.parse(raw) : undefined;
      if (d) v = { size: d.size as [number, number, number], rooms: d.rooms, setting: d.setting, mount: d.mount, solid: d.solid, loose: isLooseClutter(d) };
    } catch { v = undefined; }
    propInfo.set(id, v);
  }
  return propInfo.get(id);
};
const proj = path.join(PROJECTS, project);
const rel = (f: string): string => path.relative(process.cwd(), f).replaceAll("\\", "/");

function cultureFile(id: string): string {
  for (const p of closure(project)) { const f = path.join(PROJECTS, p, "authoring", "settlement", "cultures", `${id}.json`); if (fs.existsSync(f)) return f; }
  return fail(`no culture profile ${id} (authoring/settlement/cultures/${id}.json in ${closure(project).join(", ")})`);
}
const loadCulture = (id: string): SettlementCulture => settlementCultureSchema.parse(readJ(cultureFile(id)));
const outDir = (poi: string): string => path.join(proj, "authoring", "settlement", poi);
function sceneFileOf(ref: string): string { const f = fs.existsSync(ref) && ref.endsWith(".json") ? path.resolve(ref) : findAsset(project, `scenes/${ref}.scene.json`) ?? path.join(proj, "assets", "scenes", `${ref}.scene.json`); if (!fs.existsSync(f)) fail(`no scene ${f}`); return f; }
function worldFileOf(scene: Record<string, unknown> | null): string {
  if (opt("recipe")) return path.resolve(opt("recipe")!);
  let id: string | undefined;
  for (const e of Object.values((scene as { entities?: Record<string, { components?: { voxelWorld?: { world?: string } } }> } | null)?.entities ?? {})) id ??= e.components?.voxelWorld?.world;
  return findAsset(project, `worlds/${id ?? project}.json`) ?? fail(`no world recipe for ${id ?? project} (pass --recipe)`);
}

// ---- scene entities as blockers (installed structures; dressing props and this settlement's own entities excluded)
type Ent = { parent?: string | null; tags?: string[]; components: { transform?: { position?: number[]; rotation?: number[]; scale?: number[] }; prefab?: { prefabId: string } } };
const qmul = (a: number[], b: number[]): number[] => [a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!, a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!, a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!, a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!];
const qrot = (q: number[], v: number[]): number[] => { const p = qmul(qmul(q, [v[0]!, v[1]!, v[2]!, 0]), [-q[0]!, -q[1]!, -q[2]!, q[3]!]); return [p[0]!, p[1]!, p[2]!]; };
function blockersOf(scene: { entities: Record<string, Ent> }, centre: V2, radius: number, poi: string): { at: V2; r: number; id: string }[] {
  const ents = scene.entities, memo = new Map<string, { p: number[]; q: number[] }>();
  const worldOf = (id: string): { p: number[]; q: number[] } => {
    if (memo.has(id)) return memo.get(id)!;
    const e = ents[id]!, t = e.components.transform ?? {}, lp = t.position ?? [0, 0, 0], lq = t.rotation ?? [0, 0, 0, 1];
    let w = { p: lp, q: lq };
    if (e.parent && ents[e.parent]) { const pw = worldOf(e.parent), r = qrot(pw.q, lp); w = { p: [pw.p[0]! + r[0]!, pw.p[1]! + r[1]!, pw.p[2]! + r[2]!], q: qmul(pw.q, lq) }; }
    memo.set(id, w); return w;
  };
  const ignore = opts("ignore");
  const out: { at: V2; r: number; id: string }[] = [];
  for (const [id, e] of Object.entries(ents)) {
    const pid = e.components.prefab?.prefabId; if (!pid) continue;
    if ((e.tags ?? []).some((t) => t === "dressing" || t === "player" || t === "npc" || t === `settle:${poi}`) || ignore.some((p) => id.startsWith(p))) continue;
    if (ents[e.parent ?? ""]?.components.prefab) continue; // nested inside a placed prefab: its parent stands for it
    const w = worldOf(id); const at: V2 = [w.p[0]!, w.p[2]!];
    if (Math.hypot(at[0] - centre[0], at[1] - centre[1]) > radius + 30) continue;
    let r = 4;
    try { const doc = readJ<{ entities: Record<string, { components: { dressing?: { size?: number[] } } }> }>(findAsset(project, `prefabs/${pid}.json`)!); const d = Object.values(doc.entities).find((x) => x.components.dressing)?.components.dressing; if (d?.size) r = Math.hypot(d.size[0]!, d.size[2]!) / 2; } catch { /* no catalogue size: 4 m */ }
    out.push({ at, r: r + 1, id });
  }
  return out;
}

// ---- stilt: family compounds and the village deck composed from the kit's parts (the kit's own example teaches the
// 2x2 hut; a 1x1 hut is one of the kit's hut tiles), one prefab per compound + one for the communal deck and walkways
interface Tile { id: string; weight: number; prefabId?: string; parts?: string[] }
interface Tileset { tiles: Tile[]; pins?: unknown[]; connected?: boolean; cellSize: number[] }
type Face = "px" | "nx" | "pz" | "nz";
const FACE_DEG: Record<Face, number> = { pz: 0, px: 90, nz: 180, nx: 270 };
const FACE_V: Record<Face, V2> = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] };
const yq = (deg: number): number[] => [0, +Math.sin((deg * Math.PI) / 360).toFixed(6), 0, +Math.cos((deg * Math.PI) / 360).toFixed(6)];
const uvRot = (deg: number): number => { let r = -deg % 360; if (r <= -180) r += 360; if (r > 180) r -= 360; return r; };
const turnIJ = (i: number, j: number, q: number): [number, number] => { let a = i, b = j; for (let n = 0; n < ((q % 4) + 4) % 4; n++) [a, b] = [b, -a]; return [a, b]; };
const opposite = (a: Face, b: Face): boolean => FACE_V[a][0] === -FACE_V[b][0] && FACE_V[a][1] === -FACE_V[b][1];

function solveStilt(plan: SettlementPlan, culture: SettlementCulture, poi: string, seed: number, gaps: string[]): { ops: unknown[]; prefabs: string[] } {
  const wf = culture.dwelling; if (wf.kind !== "wfc") return { ops: [], prefabs: [] };
  const grid = plan.stilt!;
  const kitAssets = path.join(PROJECTS, wf.project, "assets");
  const raw = readJ<Tileset>(path.join(kitAssets, "wfc", `${wf.kit}.tileset.json`));
  const prefabDoc = (id: string): { entities: Record<string, { name: string; parent: string | null; tags?: string[]; components: Record<string, unknown> }> } => readJ(findAsset(wf.project, `prefabs/${id}.json`)!);
  // part templates (entity JSON) from the kit's own cell prefabs
  // a part is its entity and its children (the hidden collider mesh): a deck without them is no floor at all
  type PartEnt = { components: Record<string, unknown>; name: string; tags?: string[] };
  const tpl = new Map<string, PartEnt & { kids: PartEnt[] }>();
  for (const t of raw.tiles) if (t.prefabId) { const doc = prefabDoc(t.prefabId); for (const [id, e] of Object.entries(doc.entities)) { const part = (e.tags ?? []).find((x) => x.startsWith("wfc-part:"))?.slice(9); if (part && !tpl.has(part)) tpl.set(part, { ...e, kids: Object.values(doc.entities).filter((k) => k.parent === id) }); } }
  const needed = ["floor-deck", "rail-rope", "floor-deck-landing", "ladder", "rail-rope-gate", "floor-walkway-wide", "floor-walkway-wide-hub", "floor-walkway-wide-arm", "deck-ramp", "floor-deck-landing-low", ...wf.frames, wf.walkways.main, `${wf.walkways.main}-hub`, wf.walkways.branch, `${wf.walkways.branch}-hub`, ...(wf.watch ? [wf.watch] : [])];
  const LV = wf.levels;
  if (LV) needed.push(...LV.floors, ...LV.stairs.map((x) => x.part), ...LV.landings.flatMap((x) => [x.part, x.ladder]), ...(LV.terrace ? [LV.terrace.hatch, LV.terrace.stack, LV.terrace.ladder] : []));
  for (const p of needed) if (!tpl.has(p)) fail(`kit ${wf.kit} has no ${p} part (re-import the kit)`);
  const has = (p: string): boolean => tpl.has(p);
  // levels: every deck, stair and dock part is the one of the kit's heights nearest its walk level whose posts still end
  // 0.5 m under the water (kit geometry), set down so its top meets the level
  const geo = new Map(readJ<{ part: string; minZup: number[]; maxZup: number[] }[]>(path.join(PROJECTS, wf.project, "authoring", `${wf.kit}-kit`, "geometry.json")).map((g) => [g.part, g]));
  const WETPOST = -wf.deckOverWater - 0.5, r3 = (v: number): number => +v.toFixed(3);
  const nearest = <T,>(opts: { v: T; base: number; minZ: number }[], what: string): { v: T; base: number } => {
    const wet = opts.filter((o) => o.minZ + o.base <= WETPOST + 1e-6).sort((a, b) => Math.abs(a.base) - Math.abs(b.base));
    if (wet[0]) return wet[0];
    const deep = [...opts].sort((a, b) => a.minZ + a.base - (b.minZ + b.base))[0]!;
    gaps.push(`${what}: no kit part's posts reach under the water (deepest ends ${r3(deep.minZ + deep.base)} m from the deck)`);
    return deep;
  };
  const floorFor = (y: number, parts = LV?.floors ?? ["floor-deck"]): { part: string; off: number } => { const n = nearest(parts.filter((p) => geo.has(p)).map((p) => ({ v: p, base: y - geo.get(p)!.maxZup[2]!, minZ: geo.get(p)!.minZup[2]! })), `deck at +${y} m`); return { part: n.v, off: r3(n.base - y) }; };
  const stairFor = (top: number): { part: string; off: number } => { const lo = top - (LV?.rise ?? 1.5); const n = nearest(LV!.stairs.filter((x) => geo.has(x.part)).map((x) => ({ v: x.part, base: lo - x.lo, minZ: geo.get(x.part)!.minZup[2]! })), `stair to +${top} m`); return { part: n.v, off: r3(n.base - top) }; };
  const dockFor = (y: number): { part: string; off: number; ladder: string; ladderOff: number } => { const n = nearest(LV!.landings.filter((x) => geo.has(x.part)).map((x) => ({ v: x, base: y - geo.get(x.part)!.maxZup[2]!, minZ: geo.get(x.part)!.minZup[2]! })), `dock at +${y} m`); return { part: n.v.part, off: r3(n.base - y), ladder: n.v.ladder, ladderOff: -n.v.ladderTop }; };
  const watchOff = (y: number): number => (wf.watch && geo.has(wf.watch) ? r3(Math.min(0, WETPOST - (geo.get(wf.watch)!.minZup[2]! + y))) : 0);
  const storey = wf.cell[1];
  // a ladder on face f: turned so its rungs stand on that side of the cell (kit ladders sit at different depths: engine z =
  // -Blender y), and for a mooring off a full deck moved out past the deck lip
  const ladderOn = (part: string, f: Face, outside: boolean): { deg: number; at: number[] } => {
    const g = geo.get(part), zc = g ? -(g.minZup[1]! + g.maxZup[1]!) / 2 : 1.6, deg = zc >= 0 ? FACE_DEG[f] : FACE_DEG[f] + 180, d = outside ? grid.cell / 2 + 0.15 - Math.abs(zc) : 0;
    return { deg, at: [r3(FACE_V[f][0] * d), 0, r3(FACE_V[f][1] * d)] };
  };
  const partEnt = (part: string, parent: string, deg: number, at: number[] = [0, 0, 0]): Record<string, unknown> => {
    const t = JSON.parse(JSON.stringify(tpl.get(part)!)) as { name: string; tags?: string[]; components: Record<string, { [k: string]: unknown }>; kids: PartEnt[] };
    t.components.transform = { position: at, rotation: yq(deg) };
    const mesh = t.components.mesh as { source?: { uvRotation?: number } } | undefined;
    if (mesh?.source && /floor|deck/.test(part)) mesh.source.uvRotation = uvRot(deg);
    return { name: t.name, parent, tags: t.tags ?? [], components: t.components, locked: false, kids: t.kids };
  };
  // put a part entity and its children into a prefab's entity table under `id`
  const place = (ents: Record<string, Record<string, unknown>>, id: string, e: Record<string, unknown>): void => {
    const { kids, ...main } = e as Record<string, unknown> & { kids?: PartEnt[] };
    ents[id] = main;
    (kids ?? []).forEach((k, n) => { ents[`${id}-k${n}`] = { name: k.name, parent: id, tags: k.tags ?? [], components: JSON.parse(JSON.stringify(k.components)), locked: false }; });
  };
  // 1x1 huts: the kit's hut tiles (hutTiles) by door side; the 2x2 hut: the kit example that teaches it, door cell first
  const hutRe = new RegExp(wf.hutTiles);
  const hutTiles = (f: Face): Tile[] => raw.tiles.filter((x) => hutRe.test(x.id) && (x.parts ?? []).some((p) => p.startsWith(`doorway-reed@${f}@`)));
  const examples = readJ<Record<string, { part: string; cell: number[]; rotation: number }[]>>(path.join(PROJECTS, wf.project, "authoring", `${wf.kit}-kit`, "examples.json"));
  const big = examples["hut-reed-2x2-apron"]?.filter((p) => p.cell[2]! >= 0 && p.cell[2]! <= 1 && p.cell[0]! >= 0 && p.cell[0]! <= 1 && !/walkway/.test(p.part));
  if (grid.blocks.some((b) => b.huts.some((h) => h.size === "2x2")) && !big?.length) fail(`kit ${wf.kit}: no hut-reed-2x2-apron example to build the 2x2 hut from`);

  const key = (i: number, j: number): string => `${i},${j}`;
  const at = new Map(grid.cells.map((c) => [key(c.i, c.j), c]));
  // is the neighbour on face f walked into from this cell? (a ramp joins only along its slope)
  const linked = (c: { kind: string; face?: Face; i: number; j: number; y?: number; open?: Face[] }, f: Face): boolean => {
    // a walkway arrives on this side (its rail is left open)
    if (c.open?.includes(f)) return true;
    const n = at.get(key(c.i + FACE_V[f][0], c.j + FACE_V[f][1])); if (!n) return false;
    const slope = (k: string): boolean => k === "ramp" || k === "stair";
    if (slope(n.kind) && n.face && n.face !== f && !opposite(n.face, f)) return false;
    if (slope(c.kind) && c.face && c.face !== f && !opposite(c.face, f)) return false;
    // decks of different heights meet only through a ramp: elsewhere the higher edge is railed (a walkway passing a raised
    // compound is no way onto it)
    if ((n.y ?? 0) !== (c.y ?? 0) && !slope(n.kind) && !slope(c.kind)) return false;
    return true;
  };
  const centreOf = (i: number, j: number): V2 => [grid.origin[0] + i * grid.cell, grid.origin[1] + j * grid.cell];
  const huts = new Map(grid.blocks.flatMap((b) => b.huts.map((h) => [key(h.cell[0], h.cell[1]), h] as const)));
  const communal = grid.cells.filter((c) => c.kind === "communal");
  const dist = (c: { at: V2 }): number => Math.hypot(c.at[0] - plan.gathering.at[0], c.at[1] - plan.gathering.at[1]);
  const mid = communal.length ? communal.reduce((b, c) => (dist(c) < dist(b) ? c : b)) : null;
  let hutN = 0;
  // the parts of the gathering's first centre prop that are its fire (entities with a light or a flame look, no mesh body),
  // lifted onto the kit hearth's pan top (the part's own height: geometry max)
  const fireOf: [string, Record<string, unknown>][] = [];
  if (wf.hearth && culture.gathering.centre[0]) {
    const doc = readJ<{ entities: Record<string, { name: string; parent: string | null; tags?: string[]; components: Record<string, unknown> }> }>(findAsset(project, `prefabs/${culture.gathering.centre[0]}.json`)!);
    const pan = (readJ<{ part: string; maxZup: number[] }[]>(path.join(PROJECTS, wf.project, "authoring", `${wf.kit}-kit`, "geometry.json")).find((g) => g.part === wf.hearth)?.maxZup[2]) ?? 0.3;
    const fires = Object.entries(doc.entities).filter(([, e]) => e.parent && (e.components.light || /flame|fire|glow/.test(String((e.components.prefab as { prefabId?: string } | undefined)?.prefabId ?? ""))));
    const low = Math.min(...fires.map(([, e]) => ((e.components.transform as { position?: number[] })?.position?.[1]) ?? 0));
    for (const [k, e] of fires) {
      const t = JSON.parse(JSON.stringify(e.components.transform ?? {})) as { position?: number[]; scale?: number[] };
      const p = t.position ?? [0, 0, 0];
      t.position = [p[0]!, +(p[1]! - low + pan + 0.08).toFixed(3), p[2]!];
      fireOf.push([k, { name: `hearth ${e.name}`, tags: ["settle-hearth"], components: { ...JSON.parse(JSON.stringify(e.components)), transform: t }, locked: false }]);
    }
  }
  const compose = (cells: typeof grid.cells, root: V2, name: string): Record<string, Record<string, unknown>> => {
    const ents: Record<string, Record<string, unknown>> = { root: { name, parent: null, tags: ["generated", "settle"], components: { transform: {} }, locked: false } };
    for (const c of cells) {
      const cid = `cell-${c.i}-${c.j}`, p = centreOf(c.i, c.j), y = c.y ?? 0;
      ents[cid] = { name: `${c.kind} ${c.ref} [${c.i},${c.j}]`, parent: "root", tags: ["wfc-cell", `settle-${c.kind}`], components: { transform: { position: [+(p[0] - root[0]).toFixed(3), y, +(p[1] - root[1]).toFixed(3)] } }, locked: false };
      const add = (part: string, deg: number, off: number[] = [0, 0, 0], tag = part): void => place(ents, `${cid}-${tag}`, partEnt(part, cid, deg, off));
      // a hut's mooring side: its ladder down into the water and a gate in the rail
      const railSides = (skip?: Face): void => { for (const f of Object.keys(FACE_V) as Face[]) if (f !== skip && !linked(c, f)) { if (c.moor === f) { const dk = LV?.landings.length ? dockFor(y) : { ladder: "ladder", ladderOff: 0 }, L = ladderOn(dk.ladder, f, true); add(dk.ladder, L.deg, [L.at[0]!, dk.ladderOff, L.at[2]!], `moor-${f}`); add("rail-rope-gate", FACE_DEG[f], [0, 0, 0], `gate-${f}`); } else add("rail-rope", FACE_DEG[f], [0, 0, 0], `rail-${f}`); } };
      if (c.kind === "hut") {
        const h = huts.get(key(c.i, c.j)); if (!h) continue; // a 2x2 hut is built from its door cell
        if (h.size === "2x2") {
          for (const q of big!) {
            const [di, dj] = turnIJ(q.cell[0]!, q.cell[2]!, h.turn), ci = `${cid}-big-${di}-${dj}`;
            ents[ci] ??= { name: `hut ${c.hut} [${di},${dj}]`, parent: cid, tags: ["wfc-cell"], components: { transform: { position: [di * grid.cell, 0, dj * grid.cell] } }, locked: false };
            const fl = q.part === "floor-deck" ? floorFor(y) : null;
            place(ents, `${ci}-${q.part}-${q.rotation}`, partEnt(fl?.part ?? q.part, ci, q.rotation + 90 * h.turn, [0, fl?.off ?? 0, 0]));
          }
        } else {
          const opts = hutTiles(h.door); if (!opts.length) fail(`kit ${wf.kit}: no hut tile matching ${wf.hutTiles} with a door on ${h.door}`);
          const t = opts[(seed + hutN++) % opts.length]!;
          const doorDeg = Number((t.parts ?? []).find((pp) => pp.startsWith("doorway-reed@"))?.split("@")[2] ?? FACE_DEG[h.door]);
          for (const pp of t.parts ?? []) {
            const [part, , deg] = pp.split("@"); if (!part || !has(part)) continue;
            if (part === "floor-deck") { const fl = floorFor(y); add(fl.part, Number(deg ?? 0), [0, fl.off, 0], `${part}-${deg}`); continue; }
            const roof = /^roof-/.test(part);
            // a roof terrace replaces the roof; an upper room lifts it a storey over the walls built again
            if (roof && h.top === "terrace") continue;
            if (h.top === "room") { add(part === "doorway-reed" ? "wall-reed-window" : part, Number(deg ?? 0), [0, storey, 0], `up-${part}-${deg}`); if (roof) continue; }
            add(part, Number(deg ?? 0), [0, 0, 0], `${part}-${deg}`);
          }
          if (h.top && LV?.terrace) { add(h.top === "room" ? LV.terrace.stack : LV.terrace.hatch, doorDeg, [0, 0, 0], "top"); add(LV.terrace.ladder, doorDeg, [0, 0, 0], "top-ladder"); }
          const hh = plan.households.find((x) => x.id === c.hut); if (hh) hh.dwelling.tile = t.id;
        }
        continue;
      }
      if (c.kind === "corridor") {
        const N = (Object.keys(FACE_V) as Face[]).filter((f) => linked(c, f));
        if (N.length === 2 && opposite(N[0]!, N[1]!)) add("floor-walkway-wide", N.includes("pz") ? 0 : 90);
        else { add("floor-walkway-wide-hub", 0); for (const f of N) add("floor-walkway-wide-arm", FACE_DEG[f] + 180, [0, 0, 0], `arm-${f}`); }
        continue;
      }
      if (c.kind === "ramp") { add("deck-ramp", FACE_DEG[c.face as Face]); continue; }
      if (c.kind === "stair") { const st = stairFor(y); add(st.part, FACE_DEG[c.face as Face], [0, st.off, 0]); continue; }
      if (c.kind === "landing" && c.low) { add("floor-deck-landing-low", FACE_DEG[c.face as Face]); continue; }
      if (c.kind === "landing" && c.face) {
        const a = FACE_DEG[c.face];
        const dk = LV?.landings.length ? dockFor(y) : { part: "floor-deck-landing", off: 0, ladder: "ladder", ladderOff: 0 };
        add(dk.part, a - 180, [0, dk.off, 0], "floor");
        if (c.ref !== "dry-link") { const L = ladderOn(dk.ladder, c.face, false); add(dk.ladder, L.deg, [0, dk.ladderOff, 0]); add("rail-rope-gate", a, [0, 0, 0], "gate"); railSides(c.face); }
        continue;
      }
      const hearth = c === mid && wf.hearth && has(wf.hearth);
      // the lookout is a whole cell of its own (deck, posts and tower)
      const watch = !!wf.watch && c.fit === wf.watch;
      const fl = hearth ? { part: wf.hearth!, off: 0 } : watch ? { part: wf.watch!, off: watchOff(y) } : floorFor(y);
      add(fl.part, 0, [0, fl.off, 0], "floor");
      // the hearth's fire pan burns: the gathering centre prop's own flame and light (not its body), set on the pan
      if (hearth) for (const [k, e] of fireOf) ents[`${cid}-hearth-${k}`] = { ...e, parent: cid };
      if (c.fit && c.face && !watch) { const v = FACE_V[c.face]; add(c.fit, FACE_DEG[c.face], [v[0] * 1.35, 0, v[1] * 1.35], "fit"); }
      railSides();
    }
    return ents;
  };
  const ops: unknown[] = [], prefabs: string[] = [];
  const genDir = path.join(proj, "assets", "prefabs", "generated", "settle", poi);
  fs.rmSync(genDir, { recursive: true, force: true }); // the tool's own output: replaced whole, never kept beside
  fs.mkdirSync(genDir, { recursive: true });
  const write = (id: string, cells: typeof grid.cells, root: V2, label: string): void => {
    const pid = `generated/settle/${poi}/${id}`;
    writeJ(path.join(proj, "assets", "prefabs", `${pid}.json`), { version: 1, name: `${poi}-${id}`, root: "root", entities: { ...compose(cells, root, `${poi} ${id}`), ...(id === "decks" ? walkEnts(root) : {}) } });
    prefabs.push(pid);
    ops.push({ op: "add-entity", id: `settle-${poi}-${id}`, entity: { name: `${poi} ${label}`, parent: null, tags: [`poi:${poi}`, `settle:${poi}`], components: { transform: { position: [root[0], grid.deckY, root[1]], rotation: [0, 0, 0, 1] }, prefab: { prefabId: pid }, culling: { minScreenPx: 4 } } } });
  };
  // the walkways: each leg a run of the kit's walkway piece stretched to fit each straight stretch, a hub at every bend
  // (2 cm proud, so the joint reads as a cross plank and never fights the runs), a ramp down onto the bank at the bank leg
  const walkEnts = (root: V2): Record<string, Record<string, unknown>> => {
    const ents: Record<string, Record<string, unknown>> = {};
    for (const w of grid.walks ?? []) {
      if (w.points.length < 2) continue;
      const part = w.main ? wf.walkways.main : wf.walkways.branch, hub = `${part}-hub`;
      const P = w.points, last = P.length - 1;
      const rel = (p: V2, y = 0): number[] => [+(p[0] - root[0]).toFixed(3), y, +(p[1] - root[1]).toFixed(3)];
      const dirOf = (a: V2, b: V2): V2 => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
      const deg = (d: V2): number => (Math.atan2(d[0], d[1]) * 180) / Math.PI;
      // runs + bend hubs from core (walkwayPieces: the hub stands WALKWAY_HUB_LIFT proud so no two planks share a plane)
      let endExt = 0; // a short last leg reaching on past the walk's end (walkwayPieces ext): the bank ramp starts that much further out
      for (const pc of walkwayPieces(P, w.main ? wf.walkways.mainWidth : wf.walkways.branchWidth)) {
        const e = partEnt(pc.kind === "hub" ? hub : part, "root", pc.yaw, rel(pc.at, pc.y));
        if (pc.kind === "run") (e.components as { transform: { scale?: number[] } }).transform.scale = [1, 1, pc.scaleZ];
        endExt = Math.max(endExt, pc.ext?.[1] ?? 0);
        place(ents, `${w.id}-${pc.id}`, e);
      }
      if (w.ramp) { const d = dirOf(P[last - 1]!, P[last]!), o = 2 + endExt; place(ents, `${w.id}-ramp`, partEnt("deck-ramp", "root", deg(d), rel([P[last]![0] + d[0] * o, P[last]![1] + d[1] * o]))); }
    }
    return ents;
  };
  const own = (b: { id: string }) => (c: (typeof grid.cells)[number]): boolean => c.ref === b.id || c.ref === `${b.id}-boats` || c.ref === `${b.id}-dock` || (c.kind === "ramp" && c.ref.endsWith(`-${b.id}`));
  for (const b of grid.blocks) write(b.id, grid.cells.filter(own(b)), b.centre, `family compound ${b.id} (${b.huts.length} huts, ${wf.kit} parts)`);
  write("decks", grid.cells.filter((c) => !grid.blocks.some((b) => own(b)(c))), grid.origin, "decks (communal, walkways, work decks, landings)");
  // what the kit still lacks for this village (measured, not opinion)
  if (grid.dryLink && !(grid.walks ?? []).some((w) => w.ramp)) gaps.push("the bank link steps off level: no bank stands one ramp below the deck within reach (a STAIR to the shore would reach lower banks)");
  if (plan.defences.length && (!has("stakes-water") || !has("watch-platform"))) gaps.push("defences on the approach side have no water pieces: the kit needs STAKES-IN-WATER and a WATCH PLATFORM");
  return { ops, prefabs };
}

// ---- commands
function cultures(): void {
  for (const p of closure(project)) {
    const dir = path.join(PROJECTS, p, "authoring", "settlement", "cultures");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const c = settlementCultureSchema.safeParse(readJ(path.join(dir, f)));
      console.log(c.success ? `${p}/${c.data.id}: ${c.data.ground}, ${c.data.dwelling.kind === "wfc" ? `WFC ${c.data.dwelling.kit}` : c.data.dwelling.props.join(" | ")}, gathering ${c.data.gathering.kind}, paths ${c.data.paths.kind} — ${c.data.describe}` : `${p}/${f}: INVALID ${c.error.issues[0]?.path.join(".")}: ${c.error.issues[0]?.message}`);
    }
  }
}

function plan(): void {
  const poi = need("poi"), cultureId = need("culture"), culture = loadCulture(cultureId);
  const centre = pair(need("centre")), radius = Number(need("radius")), seed = Number(opt("seed") ?? 1);
  const anchors: Record<string, V2> = {};
  for (const a of opts("anchor")) { const [k, v] = a.split("="); if (!k || !v) { fail(`--anchor name=x,z, got ${a}`); continue; } anchors[k] = pair(v); }
  const scene = opt("scene") ? readJ<{ entities: Record<string, Ent> }>(sceneFileOf(opt("scene")!)) : null;
  const recipeFile = worldFileOf(scene as never);
  const recipe = worldRecipeSchema.parse(readJ(recipeFile)) as WorldRecipe;
  const field = createWorldField(recipe) as unknown as { height(x: number, z: number): number; waterY(x: number, z: number): number | null };
  const blockers = scene ? blockersOf(scene, centre, radius, poi) : [];
  const ground: SettleGround = { height: (x, z) => field.height(x, z), water: (x, z) => field.waterY(x, z), blocked: (x, z) => blockers.some((b) => Math.hypot(x - b.at[0], z - b.at[1]) < b.r) };
  const size = opt("size");
  const t = size ? tierFor(size) as { id: string; minCreatureGroups: number; footprintDiameterM: { min: number; max: number } } : undefined;
  const input = { id: poi, culture, households: Number(need("households")), ...(opt("clusters") ? { clusters: Number(opt("clusters")) } : {}), ...(opt("wealth") ? { wealth: opt("wealth") as "poor" } : {}), centre, radius, seed, anchors, ...(t ? { tier: { id: t.id, minCreatureGroups: t.minCreatureGroups, footprintDiameterM: t.footprintDiameterM } } : {}) };
  const t0 = Date.now();
  const p = planSettlement({ ...input, props }, ground);
  console.log(`survey: ${p.survey.dry} dry / ${p.survey.wet} wet cells (${p.survey.step} m), water level ${p.survey.waterLevel ?? "-"}, ${p.survey.pads.filter((x) => x.area >= culture.minPadArea).length} pads >= ${culture.minPadArea} m², ${blockers.length} installed blockers (${Date.now() - t0} ms)`);
  const dir = outDir(poi), gaps: string[] = [];
  let sceneOps: unknown[] = [], prefabs: string[] = [];
  if (p.stilt) ({ ops: sceneOps, prefabs } = solveStilt(p, culture, poi, seed, gaps));
  // props must exist in the closure
  const missing = [...new Set(p.areas.flatMap((a) => a.items.map((i) => i.prop)))].filter((id) => !findAsset(project, `prefabs/${id}.json`));
  if (missing.length) p.warnings.push({ code: "missing-prop", message: `not in ${project}'s closure: ${missing.join(", ")}` });
  const prev = fs.existsSync(path.join(dir, "plan.json")) ? readJ<{ plan: SettlementPlan }>(path.join(dir, "plan.json")).plan.areas.map((x) => `${poi}-${x.id}`) : [];
  writeJ(path.join(dir, "plan.json"), { input: { ...input, culture: cultureId, cultureFile: rel(cultureFile(cultureId)), recipe: rel(recipeFile), scene: opt("scene") ?? null }, plan: p });
  fs.writeFileSync(path.join(dir, "plan.svg"), settlementSvg(p, `${poi} (seed ${seed})`));
  writeHandoffs(p, culture, dir);
  writeJ(path.join(dir, "world-ops.json"), settlementWorldOps(p, culture, poi));
  writeJ(path.join(dir, "scene-ops.json"), { poi, prefabs, ops: sceneOps });
  writeJ(path.join(dir, "kit-gaps.json"), { culture: cultureId, kit: culture.dwelling.kind === "wfc" ? culture.dwelling.kit : null, gaps: [...new Set(gaps)] });
  const plansDir = path.join(proj, "authoring", "dressing", "plans");
  // this tool's previous plans for the POI go first (an area the new layout lacks must not linger)
  if (fs.existsSync(plansDir)) for (const f of fs.readdirSync(plansDir)) if (prev.includes(f.replace(/(\.report|\.inverse|\.owner)?\.json$/, ""))) fs.rmSync(path.join(plansDir, f));
  const dplans = settlementDressingPlans(p, culture, poi);
  for (const dp of dplans) writeJ(path.join(plansDir, `${dp.id}.json`), dp);
  const res = checkSettlement(p, culture, { households: input.households, ...(input.tier ? { tier: input.tier } : {}) });
  console.log(`${poi}: ${p.households.length} households in ${p.clusters.length} clusters, gathering ${p.gathering.at.join(",")}, ${p.work.length} work areas, ${p.paths.length} path legs (${[...new Set(p.paths.map((x) => x.kind))].join("/")}), ${p.clearings.length} clearings, ${p.creatures.length} creature spots${p.stilt ? `, ${p.stilt.blocks.length} family compounds (${p.stilt.blocks.map((b) => `${b.id} ${b.huts.length} huts${b.y ? ` +${b.y} m` : ""}`).join(", ")}) + ${p.stilt.cells.length} deck cells at y ${p.stilt.deckY} (water ${p.stilt.water})` : ""}`);
  if (p.stilt) {
    // concentration, measured: boardwalk metres per dwelling (all, and the core within the culture's core radius)
    const g = p.gathering.at, dg = (q: number[]): number => Math.hypot(q[0]! - g[0], q[1]! - g[1]), len = (pts: number[][]): number => pts.slice(1).reduce((t, b, n) => t + Math.hypot(b[0]! - pts[n]![0]!, b[1]! - pts[n]![1]!), 0);
    const walks = p.stilt.walks.filter((w) => w.points.length), coreR = culture.core.radius;
    const coreHuts = p.households.filter((h) => dg(h.dwelling.at) <= coreR).length, coreM = walks.filter((w) => w.points.every((q) => dg(q) <= coreR)).reduce((t, w) => t + len(w.points), 0), allM = walks.reduce((t, w) => t + len(w.points), 0);
    const nn = p.households.map((h) => Math.min(...p.households.filter((x) => x !== h).map((x) => Math.hypot(x.dwelling.at[0] - h.dwelling.at[0], x.dwelling.at[1] - h.dwelling.at[1])))).sort((a, b) => a - b);
    console.log(`  boardwalk: ${allM.toFixed(0)} m for ${p.households.length} huts (${(allM / Math.max(1, p.households.length)).toFixed(1)} m/hut); core ${coreHuts} huts within ${coreR} m, ${coreM.toFixed(0)} m (${(coreM / Math.max(1, coreHuts)).toFixed(1)} m/hut); ${p.stilt.walks.length - walks.length} shared-deck joins; nearest-hut median ${(nn[nn.length >> 1] ?? 0).toFixed(1)} m; levels ${[...new Set(p.stilt.blocks.map((b) => b.y))].sort().join("/")} m over the deck`);
    const H = p.stilt.blocks.flatMap((b) => b.huts.map((h) => ({ b, h })));
    console.log(`  levels: ${[...new Set(H.map((x) => x.b.y))].sort((a, b) => a - b).map((y) => `+${y} m ${H.filter((x) => x.b.y === y).length} huts`).join(", ")}; ${p.stilt.cells.filter((c) => c.kind === "stair").length} stair flights; ${H.filter((x) => x.h.top === "terrace").length} roof terraces, ${H.filter((x) => x.h.top === "room").length} upper rooms; docks ${H.filter((x) => x.h.dock).length}/${H.length} huts; watch +${p.stilt.cells.find((c) => c.fit && c.fit === (culture.dwelling.kind === "wfc" ? culture.dwelling.watch : ""))?.y ?? "-"} m`);
  }
  if (p.stilt) {
    // deck versus huts, seen from above (targets: hut roofs >= 40% of the built core, communal <= 12 x 12 m, no side-by-side
    // walkways, < 10 m² of walkway per core hut, no empty deck over 30 m²)
    const fp = stiltFootprint(p, culture.core.radius, (id) => props(id)?.size)!;
    console.log(`  footprint: built ${fp.builtM2.toFixed(0)} m² (huts ${fp.hutM2.toFixed(0)}, deck ${fp.deckM2.toFixed(0)}, walkways ${fp.walkM2.toFixed(0)}); hut roofs ${(fp.hutShare * 100).toFixed(0)}% (core ${(fp.coreHutShare * 100).toFixed(0)}%); open deck ${(fp.openShare * 100).toFixed(0)}%; communal ${fp.communal.join(" x ")} m; core walkway ${fp.coreWalkPerHut.toFixed(1)} m²/hut; ${fp.parallel.length} side-by-side walkway pairs; ${fp.empty.length} empty decks > 30 m²; ${p.stilt.trimmed ?? 0} bare cells trimmed`);
    for (const x of fp.parallel) p.warnings.push({ code: "stilt-parallel-walkways", message: `${x.a} and ${x.b} run side by side for ${x.m} m, ${x.gap} m apart` });
    for (const x of fp.empty) p.warnings.push({ code: "stilt-empty-deck", message: `${x.ref}: ${x.cells} empty deck cells (${x.m2} m²) at ${x.at.join(",")}` });
  }
  for (const w of p.warnings) console.log(`  warn ${w.code}: ${w.message}`);
  for (const g of new Set(gaps)) console.log(`  kit gap: ${g}`);
  for (const f of res.findings) console.log(`  ${f.code === "tier-footprint" ? "note" : "FAIL"} ${f.code}: ${f.message}`);
  console.log(`wrote ${rel(dir)}/ (plan.json, plan.svg, handoff-siteDressing.json, world-ops.json, scene-ops.json, kit-gaps.json) + ${dplans.length} dressing plans ${rel(plansDir)}/${poi}-*.json${prefabs.length ? ` + ${prefabs.length} prefabs` : ""}`);
  console.log(`PLAN ${poi}: ${res.ok ? "ok" : "FAILED"}`);
}

function apply(): void {
  const poi = need("poi"), dir = outDir(poi);
  const sceneFile = sceneFileOf(need("scene"));
  const scene = readJ<Record<string, unknown>>(sceneFile);
  const recipeFile = worldFileOf(scene);
  const ops = readJ<ReturnType<typeof settlementWorldOps>>(path.join(dir, "world-ops.json"));
  const owner = `settle-${poi}`;
  // one read-modify-write of the recipe under its lock (tools/_scene-write.mts); --dry only validates
  const edit = (raw: { features: { clearings?: { owner?: string }[] } }) => {
    const before = raw.features.clearings ?? [];
    raw.features.clearings = [...before.filter((c) => c.owner !== owner), ...ops.clearings.map((c) => clearingSchema.parse(c))];
    const ok = worldRecipeSchema.safeParse(raw);
    if (!ok.success) fail(`refusing to write an invalid world: ${ok.error.issues[0]?.message}`);
    return { doc: raw, removed: before.filter((c) => c.owner === owner).length };
  };
  if (flag("dry")) edit(readJ(recipeFile));
  else updateJsonFile(recipeFile, (raw) => edit(raw), { label: `settle ${poi}`, indent: 1, trailer: "" });
  console.log(`clearings: ${ops.clearings.length} (owner ${owner}, cover CLEARED) in ${rel(recipeFile)}${flag("dry") ? " — DRY" : ""}`);
  if (ops.operators.length) {
    const f = path.join(dir, "path-operators.json");
    writeJ(f, ops.operators);
    const world = path.basename(recipeFile, ".json");
    const r = spawnSync(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "tools/worldgen.mts", "op", world, "--apply", f, "--recipe", recipeFile, "--inverse", path.join(dir, "path-operators.inverse.json"), ...(flag("dry") ? ["--dry-run"] : [])], { stdio: "inherit", cwd: path.resolve(PROJECTS, "..") });
    if (r.status) fail(`worldgen op --apply exited ${r.status}`);
  }
  const so = readJ<{ ops: { op: string; id: string }[] }>(path.join(dir, "scene-ops.json"));
  if (so.ops.length) {
    const reg = new ComponentRegistry(); registerCoreComponents(reg);
    const ents = (scene as { entities: Record<string, { tags?: string[] }> }).entities;
    const removes = Object.entries(ents).filter(([, e]) => (e.tags ?? []).includes(`settle:${poi}`)).map(([id]) => ({ op: "remove-entity", id }));
    if (flag("dry")) applyOps(scene as never, [...removes, ...so.ops] as never, reg);
    else { const { inverse } = applyOpsToSceneFile(sceneFile, [...removes, ...so.ops], (d, o) => applyOps(d, o as never, reg), { label: `settle ${poi}`, trailer: "" }); writeJ(path.join(dir, "scene-ops.inverse.json"), { scene: rel(sceneFile), ops: inverse }); }
    console.log(`structures: removed ${removes.length}, added ${so.ops.length} settle:${poi} entities in ${rel(sceneFile)}${flag("dry") ? " — DRY" : ""}`);
  }
  console.log(`next: put ${rel(path.join(dir, "handoff-siteDressing.json"))} in the POI handoff.json siteDressing, then site-sockets --job <poi job> --scene <scene>, then per plan: dress check --plan ${poi}-<area> && dress apply --plan ${poi}-<area> --scene <scene> --at 0,0,0 --yaw 0`);
}

/** The POI handoff blocks derived from a plan (no re-plan): siteDressing (areas + their walk `reach`) and, for a stilt
 *  village, navigation (bank -> communal deck -> hut doors up every level; network: the way to every dressing area). */
function writeHandoffs(p: SettlementPlan, culture: SettlementCulture, dir: string): void {
  writeJ(path.join(dir, "handoff-siteDressing.json"), settlementSiteDressing(p, culture, (id) => props(id)?.size));
  if (p.stilt) { const nav = stiltRoutes(p, 3, (id) => props(id)?.size, true); writeJ(path.join(dir, "handoff-navigation.json"), { routes: nav.filter((r) => !r.network).map(({ id, points }) => ({ id, points })), network: nav.filter((r) => r.network).map(({ id, points }) => ({ id, points })) }); }
}
/** structures: re-solve a stilt village's prefabs + scene-ops.json from its SAVED plan.json (no re-plan: the layout, its
 *  dressing plans and socket maps stay as they are) — after a kit or placement fix (e.g. walkwayPieces). */
function structures(): void {
  const poi = need("poi"), dir = outDir(poi);
  const saved = readJ<{ input: { culture: string; seed?: number }; plan: SettlementPlan }>(path.join(dir, "plan.json"));
  if (!saved.plan.stilt) fail(`${poi}: not a stilt village (no structures to solve)`);
  const gaps: string[] = [];
  const { ops, prefabs } = solveStilt(saved.plan, loadCulture(saved.input.culture), poi, saved.input.seed ?? 1, gaps);
  writeJ(path.join(dir, "scene-ops.json"), { poi, prefabs, ops });
  writeHandoffs(saved.plan, loadCulture(saved.input.culture), dir);
  console.log(`STRUCTURES ${poi}: ${prefabs.length} prefabs, ${ops.length} scene ops (from the saved plan)`);
}
function check(): void {
  const poi = need("poi"), dir = outDir(poi);
  const saved = readJ<{ input: { culture: string; households: number; tier?: { id: string; minCreatureGroups: number; footprintDiameterM: { min: number; max: number } } }; plan: SettlementPlan }>(path.join(dir, "plan.json"));
  const culture = loadCulture(saved.input.culture);
  let clearings: { center?: [number, number]; radius?: number; cover?: boolean }[] | undefined;
  if (opt("scene") || opt("recipe")) {
    const recipeFile = worldFileOf(opt("scene") ? readJ(sceneFileOf(opt("scene")!)) : null);
    clearings = (readJ<{ features: { clearings?: { center?: [number, number]; radius?: number; cover?: boolean }[] } }>(recipeFile).features.clearings ?? []);
    console.log(`cover judged against the INSTALLED clearings of ${rel(recipeFile)} (${clearings.length})`);
  }
  const res = checkSettlement(saved.plan, culture, { households: saved.input.households, ...(saved.input.tier ? { tier: saved.input.tier } : {}), ...(clearings ? { clearings } : {}) });
  for (const f of res.findings) console.log(`${f.code === "tier-footprint" ? "note" : "FAIL"} ${f.code}${f.ref ? ` [${f.ref}]` : ""}: ${f.message}`);
  const gaps = fs.existsSync(path.join(dir, "kit-gaps.json")) ? readJ<{ gaps: string[] }>(path.join(dir, "kit-gaps.json")).gaps : [];
  if (gaps.length) console.log(`kit gaps (${gaps.length}): see ${rel(path.join(dir, "kit-gaps.json"))}`);
  console.log(`SETTLE ${poi}: ${Object.entries(res.summary).map(([k, v]) => `${k} ${v}`).join(", ")} -> ${res.ok ? "ok" : "FAILED"}`);
  process.exit(res.ok ? 0 : 1);
}

switch (cmd) {
  case "cultures": cultures(); break;
  case "plan": plan(); break;
  case "apply": apply(); break;
  case "check": check(); break;
  case "structures": structures(); break;
  default: console.error("usage: settle cultures | plan --project p --poi id --culture c --households N --centre x,z --radius r [...] | apply --project p --poi id --scene s | check --project p --poi id [--scene s]  (see the header of tools/settle.mts)"); process.exit(2);
}
