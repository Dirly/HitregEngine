/**
 * WATER EDGES — no water ends in the air, no curtain floats off its lip. One gate for every body of water.
 *
 *   worldgen water-edges <world> [--project p] [--near x,z,r | --rect x0,z0,x1,z1] [--stamp] [--no-scene] [--json] [--out f] [--list]
 *   node tools/water-edges.mts scene <project> [--scene <id|file>] [--world <recipe id>] [--json] [--out f]
 *   node tools/water-edges.mts scene <project> ... --fix [--grow 8] [--no-finish] [--inverse f.json]   (writes the scene)
 *   node tools/water-edges.mts undo <project> --inverse f.json [--scene ...]
 *
 * Bodies: every scene entity with a `water` component (or tagged "water" with a mesh) — dungeon pools and channels,
 * placed ponds — judged by its OUTLINE (core water-edges.ts): each edge point buried in solid (a wall, a rock lip, a
 * shore rising out of it), or at a declared finish (`water.finishes`: drain / lip-fall / dark / built), or OPEN — the
 * fault ("drop": water over a hole; "shelf": a sheet stopping over its own bed; "run-on": a channel going on).
 * Curtains (a world): every waterfall's curtain as the chunk builder emits it (fittedFalls: hung from the MEASURED lip,
 * hugging the face), judged against the river surface it must meet and the rock face it must hug (core curtainFit):
 * top gap > 0.5 m, face gap > 0.5 m (envelope-aware), points floating free or inside rock. Exit 1 on any fault.
 * Solid: the voxel field's density plus every non-water scene object's triangles (DC dungeon meshes, decks, hulls).
 *
 * `--fix` (scenes): each faulty body is re-cut to its walls (clipWaterToSolid: flooded to the walls at its level, a
 * buried rim), and what is still open gets a finish — a run-on channel a dark card where it leaves the light, a drop a
 * drain (a dark floor under the brink) — declared in the body's `water.finishes`. One applyOps batch, inverse kept;
 * a second run is a no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOps,
  ComponentRegistry,
  registerCoreComponents,
  classifyEdges,
  clipWaterToSolid,
  createWorldField,
  curtainFit,
  curtainColumns,
  foamLinedBank,
  fieldSolidProbe,
  fittedFalls,
  FALL_LIP_OFFSET,
  measureFallLip,
  meshOutline,
  solidAt,
  triangleSolidProbe,
  unionSolidProbe,
  voxelWaterEntities,
  worldRecipeSchema,
  type SceneDoc,
  type SolidProbe,
  type WaterFinish,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { readJson, sceneGeometry } from "./_prop-geometry.mts";
import { encodePng } from "./_png.mjs";
import { findAsset, PROJECTS } from "./_closure.mjs";
import { fieldOfScene } from "./float.mts";

export interface WaterEdgeRow {
  kind: "edge" | "curtain";
  id: string;
  what: string;
  x: number;
  y: number;
  z: number;
  issue: string;
  /** Edge rows: the open stretch's length (m) and why. Curtain rows: the measures. */
  length?: number;
  why?: string;
  topGap?: number;
  faceGap?: number;
  lipShift?: number;
}

export interface WaterEdgesReport {
  target: string;
  area: string;
  bodies: number;
  curtains: number;
  edgeSamples: { buried: number; finished: number; open: number; slivers: number; horizon: number };
  rows: WaterEdgeRow[];
  ok: boolean;
  ms: number;
}

type Area = { near?: [number, number, number]; rect?: [number, number, number, number] };
const r2 = (v: number): number => Math.round(v * 100) / 100;
const inArea = (a: Area, x: number, z: number): boolean =>
  (!a.near || Math.hypot(x - a.near[0], z - a.near[1]) <= a.near[2]) && (!a.rect || (x >= a.rect[0] && x <= a.rect[2] && z >= a.rect[1] && z <= a.rect[3]));
const opt = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
function registry(): ComponentRegistry { const reg = new ComponentRegistry(); registerCoreComponents(reg); return reg; }

/** Is this scene entity a body of water? */
export function isWaterBody(e: any): boolean {
  if (!e?.components) return false;
  if (e.components.water) return true;
  return Array.isArray(e.tags) && e.tags.includes("water") && !!e.components.mesh && !e.tags.includes("waterfall") && !e.components.sky;
}

export interface SceneBody {
  id: string;
  name: string;
  surfaceY: number;
  /** World-space triangles of its sheet. */
  world: number[];
  finishes: WaterFinish[];
  depth: number;
}

/** A water entity's sheet as world triangles (nine numbers each): a primitive plane at its own y, or a surface mesh. */
export function sheetTriangles(source: any, m: number[]): number[] {
  const local: number[] = [];
  if (source?.kind === "primitive") {
    const [sx, , sz] = (source.size ?? [1, 1, 1]) as number[];
    const a = [-sx! / 2, 0, -sz! / 2], b = [-sx! / 2, 0, sz! / 2], c = [sx! / 2, 0, sz! / 2], d = [sx! / 2, 0, -sz! / 2];
    local.push(...a, ...b, ...c, ...a, ...c, ...d);
  } else if (source?.kind === "surface" && source.positions && source.indices) {
    for (const i of source.indices as number[]) local.push(source.positions[i * 3], source.positions[i * 3 + 1], source.positions[i * 3 + 2]);
  }
  const out: number[] = [];
  for (let k = 0; k < local.length; k += 3) {
    const [x, y, z] = [local[k]!, local[k + 1]!, local[k + 2]!];
    out.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
  }
  return out;
}

/**
 * Inside-ness for a triangle soup (DC dungeon shells, open floors, decks): the nearest surface above a point faces
 * UP (it is a floor over us: we are in the rock under it) or, with none above, the nearest below faces DOWN. Surfaces
 * face the air, so this holds for closed shells and open floor sheets alike. A dungeon (no world field) is rock
 * wherever no shell reaches (`emptyIsSolid`).
 */
export function facingColumns(soup: readonly number[], emptyIsSolid = false, cell = 1): (x: number, y: number, z: number) => boolean {
  const buckets = new Map<string, number[]>();
  const n = Math.floor(soup.length / 9);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const x0 = Math.min(soup[o]!, soup[o + 3]!, soup[o + 6]!), x1 = Math.max(soup[o]!, soup[o + 3]!, soup[o + 6]!);
    const z0 = Math.min(soup[o + 2]!, soup[o + 5]!, soup[o + 8]!), z1 = Math.max(soup[o + 2]!, soup[o + 5]!, soup[o + 8]!);
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
      for (let k = Math.floor(z0 / cell); k <= Math.floor(z1 / cell); k++) {
        const key = `${i},${k}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        b.push(t);
      }
  }
  return (x, y, z) => {
    let above: [number, number] | null = null; // [height, normal y]
    let below: [number, number] | null = null;
    for (const t of buckets.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      const o = t * 9;
      const ax = soup[o]!, az = soup[o + 2]!, bx = soup[o + 3]!, bz = soup[o + 5]!, cx = soup[o + 6]!, cz = soup[o + 8]!;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u < -1e-7 || v < -1e-7 || w < -1e-7) continue;
      const h = u * soup[o + 1]! + v * soup[o + 4]! + w * soup[o + 7]!;
      // the face's normal y: (b - a) x (c - a), y component
      const ny = (soup[o + 5]! - az) * (soup[o + 6]! - ax) - (soup[o + 3]! - ax) * (soup[o + 8]! - az);
      if (h >= y) { if (!above || h < above[0]) above = [h, ny]; }
      else if (!below || h > below[0]) below = [h, ny];
    }
    if (above) return above[1] > 0;
    if (below) return below[1] < 0;
    // a column with no surface at all: outside every shell — rock in a dungeon (its shells bound the void), air in a world
    return emptyIsSolid;
  };
}

/** A probe that also answers "buried" (floor = hi) where `inside` says the point is in rock. */
function withInside(probe: SolidProbe, inside: (x: number, y: number, z: number) => boolean): SolidProbe {
  return {
    ...probe,
    floor: (x, z, hi, lo) => (inside(x, hi, z) ? hi : probe.floor(x, z, hi, lo)),
    wall: probe.wall ? (x, y, z, dx, dz, reach) => (inside(x, y, z) ? 0 : probe.wall!(x, y, z, dx, dz, reach)) : undefined,
  };
}

/** The solid of a scene: every non-water object's triangles, plus the world's field when there is one. */
export function sceneSolid(assets: string, doc: SceneDoc, field: WorldField | null): { probe: SolidProbe; bodies: SceneBody[] } {
  const ents = doc.entities as Record<string, any>;
  const geo = sceneGeometry(assets, doc as never);
  const soup: number[] = [];
  const bodies: SceneBody[] = [];
  for (const g of geo) {
    const root = g.id.split(":")[0]!;
    if (isWaterBody(ents[g.id]) || isWaterBody(ents[root])) {
      const e = ents[g.id] ?? ents[root];
      if (!ents[g.id]?.components?.water && !isWaterBody(ents[g.id])) continue;
      // the sheet itself, at its own height (sceneGeometry gives a primitive plane a metre-thick box)
      const world = sheetTriangles(e.components.mesh?.source, g.m);
      if (!world.length) continue;
      let top = -Infinity;
      for (let k = 1; k < world.length; k += 3) top = Math.max(top, world[k]!);
      bodies.push({ id: g.id, name: e.name ?? g.id, surfaceY: e.components.water?.surfaceY ?? top, world, finishes: e.components.water?.finishes ?? [], depth: e.components.water?.depth ?? 3 });
      continue;
    }
    if (ents[g.id]?.tags?.includes?.("waterfall") || ents[g.id]?.tags?.includes?.("water-finish")) continue;
    for (const v of g.world) soup.push(v);
  }
  const tris = withInside(triangleSolidProbe(soup, 1), facingColumns(soup, !field));
  return { probe: field ? unionSolidProbe(fieldSolidProbe(field), tris) : tris, bodies };
}

/**
 * The open sea at the world's edge, for a body at sea level: past the world boundary (`bounds.limit`, where
 * everything is open ocean) or, in a world without one, on the body's own outer rim over ground well under the sea.
 * Null for any other body: a placed pond's open edge stays a fault however far out it is.
 */
export function seaHorizon(field: WorldField | null, b: Pick<SceneBody, "surfaceY" | "world">): ((x: number, z: number) => boolean) | undefined {
  if (!field) return undefined;
  const sea = field.recipe.seaLevel ?? 0;
  if (Math.abs(b.surfaceY - sea) > 0.25) return undefined;
  const limit = (field.recipe as any).bounds?.limit as number | undefined;
  if (limit) return (x, z) => Math.hypot(x, z) >= limit;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < b.world.length; k += 3) { x0 = Math.min(x0, b.world[k]!); x1 = Math.max(x1, b.world[k]!); z0 = Math.min(z0, b.world[k + 2]!); z1 = Math.max(z1, b.world[k + 2]!); }
  const rim = 1;
  return (x, z) => (x <= x0 + rim || x >= x1 - rim || z <= z0 + rim || z >= z1 - rim) && field.height(x, z) < sea - 10;
}

/** Every water body of a scene judged by its outline. */
export function sceneWaterEdges(assets: string, doc: SceneDoc, field: WorldField | null, area: Area = {}, solid = sceneSolid(assets, doc, field)): { rows: WaterEdgeRow[]; bodies: number; samples: WaterEdgesReport["edgeSamples"] } {
  const rows: WaterEdgeRow[] = [];
  const samples = { buried: 0, finished: 0, open: 0, slivers: 0, horizon: 0 };
  let bodies = 0;
  for (const b of solid.bodies) {
    const idx: number[] = [];
    for (let i = 0; i < b.world.length / 3; i++) idx.push(i);
    const segs = meshOutline(b.world, idx);
    if (!segs.length) continue;
    const c = segs.reduce((s, g) => [s[0] + g.a[0] / segs.length, s[1] + g.a[1] / segs.length], [0, 0]);
    if (!inArea(area, c[0], c[1])) continue;
    bodies++;
    const rep = classifyEdges(solid.probe, segs, b.surfaceY, b.finishes, { bedDepth: Math.max(12, b.depth + 1), horizon: seaHorizon(field, b) });
    samples.horizon += rep.horizon;
    samples.buried += rep.buried; samples.finished += rep.finished; samples.open += rep.open; samples.slivers += rep.slivers;
    for (const run of rep.runs) {
      rows.push({ kind: "edge", id: b.id, what: b.name, x: r2(run.mid[0]), y: r2(b.surfaceY), z: r2(run.mid[1]), issue: `water edge in open air (${run.why}), ${run.length.toFixed(1)} m`, length: r2(run.length), why: run.why });
    }
  }
  return { rows, bodies, samples };
}

/** The curtain and upper water a chunk build emits for each fall in the area, judged by curtainFit. */
export function worldCurtains(field: WorldField, area: Area = {}, materialOf?: (name: string) => any): { rows: WaterEdgeRow[]; curtains: number; measures: any[] } {
  const rows: WaterEdgeRow[] = [];
  const measures: any[] = [];
  const size = field.recipe.cellSize;
  const probe = fieldSolidProbe(field);
  const docs = new Map<string, { entities: Record<string, unknown> }>();
  const chunk = (cx: number, cz: number) => {
    const k = `${cx},${cz}`;
    let d = docs.get(k);
    if (!d) docs.set(k, (d = { entities: voxelWaterEntities(field, cx, cz) }));
    return d;
  };
  let curtains = 0;
  fittedFalls(field).forEach((fall, index) => {
    if (!inArea(area, fall.x, fall.z)) return;
    const raw = field.falls[index]!;
    const lip = measureFallLip(field, raw, FALL_LIP_OFFSET);
    const cx = Math.floor(fall.x / size), cz = Math.floor(fall.z / size);
    const d = chunk(cx, cz);
    const ent: any = d.entities[`fall_${index}`];
    if (!ent) {
      rows.push({ kind: "curtain", id: `fall-${index}`, what: fall.river, x: r2(fall.x), y: r2(fall.top), z: r2(fall.z), issue: "no curtain emitted (no water material?)" });
      return;
    }
    curtains++;
    const x0 = cx * size, z0 = cz * size;
    const pos: number[] = ent.components.mesh.source.positions.map((v: number, i: number) => v + (i % 3 === 0 ? x0 : i % 3 === 2 ? z0 : 0));
    // the upper water around the lip: every water sheet vertex at the top level, from the lip's chunk and its neighbours
    const upper: number[] = [];
    const lx = fall.x - fall.dirX * FALL_LIP_OFFSET, lz = fall.z - fall.dirZ * FALL_LIP_OFFSET;
    const cells = new Set<string>();
    for (const [ox, oz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]) cells.add(`${Math.floor((lx + ox!) / size)},${Math.floor((lz + oz!) / size)}`);
    cells.add(`${cx},${cz}`);
    for (const key of cells) {
      const [ix, iz] = key.split(",").map(Number) as [number, number];
      for (const [id, e] of Object.entries(chunk(ix, iz).entities as Record<string, any>)) {
        if (id.startsWith("fall_") || !e.tags?.includes?.("water") || e.components?.mesh?.source?.kind !== "surface") continue;
        const p = e.components.mesh.source.positions as number[];
        for (let v = 0; v < p.length; v += 3) {
          if (Math.abs(p[v + 1]! - fall.top) > 0.3) continue;
          const wx = p[v]! + ix * size, wz = p[v + 2]! + iz * size;
          if (Math.hypot(wx - lx, wz - lz) > fall.reach + 12) continue;
          upper.push(wx, p[v + 1]!, wz);
        }
      }
    }
    const fit = curtainFit(probe, pos, fall, upper, { cols: curtainColumns(ent.components.mesh.source.uv1s) });
    measures.push({ fall: index, river: fall.river, lipShift: lip.shift, lipFound: lip.found, topGap: r2(fit.topGap), faceGap: r2(fit.faceGap), free: fit.free, inRock: fit.inRock, landed: fit.landed, landsAbovePool: r2(fit.landsAbovePool) });
    for (const f of fit.faults) {
      const at = fit.worstAt ?? [lx, fall.top, lz];
      rows.push({ kind: "curtain", id: `fall-${index}`, what: fall.river, x: r2(at[0]), y: r2(at[1]), z: r2(at[2]), issue: f, topGap: r2(fit.topGap), faceGap: r2(fit.faceGap), lipShift: lip.shift });
    }
  });
  // SHORE FOAM ON STEEP BANKS: the river water's outline in each fall's pool (the 3x3 cells round its foot) or, with
  // --near/--rect, every cell in the area, sampled every metre; the bed just inside the water is the bank the band
  // would line. A material whose band keeps its foam there draws the flat pale strips (core foamLinedBank).
  if (materialOf) {
    const cellsToCheck = new Set<string>();
    if (area.near || area.rect) {
      const [ax0, az0, ax1, az1] = area.near ? [area.near[0] - area.near[2], area.near[1] - area.near[2], area.near[0] + area.near[2], area.near[1] + area.near[2]] : area.rect!;
      for (let cx = Math.floor(ax0 / size); cx <= Math.floor(ax1 / size); cx++) for (let cz = Math.floor(az0 / size); cz <= Math.floor(az1 / size); cz++) cellsToCheck.add(`${cx},${cz}`);
    } else {
      for (const fall of fittedFalls(field)) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cellsToCheck.add(`${Math.floor(fall.x / size) + dx},${Math.floor(fall.z / size) + dz}`);
    }
    const lined = new Map<string, { metres: number; x: number; y: number; z: number }>();
    for (const key of cellsToCheck) {
      const [cx, cz] = key.split(",").map(Number) as [number, number];
      for (const [id, e] of Object.entries(chunk(cx, cz).entities as Record<string, any>)) {
        const src = e.components?.mesh?.source;
        if (id.startsWith("fall_") || !e.tags?.includes?.("water") || src?.kind !== "surface") continue;
        const mat = materialOf(e.components.mesh.material)?.water;
        if (!mat) continue;
        const banks: number[] = [];
        let at: [number, number, number] | null = null;
        for (const seg of meshOutline(src.positions, src.indices, [cx * size, 0, cz * size])) {
          const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
          for (let t = 0.5; t < len; t += 1) {
            const x = seg.a[0] + ((seg.b[0] - seg.a[0]) * t) / len - seg.out[0] * 0.5, z = seg.a[1] + ((seg.b[1] - seg.a[1]) * t) / len - seg.out[1] * 0.5;
            if (!inArea(area, x, z)) continue;
            const y = field.ground(x, z);
            const up = Math.abs(field.surfaceNormal(x, y, z)[1]);
            banks.push(up);
            if (up < 0.6 && !at) at = [x, y, z];
          }
        }
        const m = foamLinedBank(mat, banks);
        if (m > 0) {
          const k = e.components.mesh.material as string;
          const prev = lined.get(k);
          lined.set(k, { metres: (prev?.metres ?? 0) + m, x: prev?.x ?? at![0], y: prev?.y ?? at![1], z: prev?.z ?? at![2] });
        }
      }
    }
    for (const [mat, l] of lined) if (l.metres >= 4) rows.push({ kind: "foam", id: mat, what: mat, x: r2(l.x), y: r2(l.y), z: r2(l.z), issue: `shore foam lines ${l.metres} m of steep bank (flat pale strips along the banks and round rocks): give the material shoreFoam.steep so a steep bank meets the water with a wet line` });
  }
  return { rows, curtains, measures };
}

function summarize(target: string, area: string, t0: number, parts: { rows: WaterEdgeRow[]; bodies?: number; curtains?: number; samples?: WaterEdgesReport["edgeSamples"] }[]): WaterEdgesReport {
  const rows = parts.flatMap((p) => p.rows);
  const samples = { buried: 0, finished: 0, open: 0, slivers: 0, horizon: 0 };
  for (const p of parts) if (p.samples) { samples.horizon += p.samples.horizon ?? 0; samples.buried += p.samples.buried; samples.finished += p.samples.finished; samples.open += p.samples.open; samples.slivers += p.samples.slivers; }
  return {
    target, area,
    bodies: parts.reduce((s, p) => s + (p.bodies ?? 0), 0),
    curtains: parts.reduce((s, p) => s + (p.curtains ?? 0), 0),
    edgeSamples: samples, rows, ok: rows.length === 0, ms: Math.round(performance.now() - t0),
  };
}

function print(rep: WaterEdgesReport, list: boolean, extra?: any[]): void {
  console.log(`water-edges ${rep.target} ${rep.area}: ${rep.bodies} bodies, ${rep.curtains} curtains; edge samples buried ${rep.edgeSamples.buried} / finished ${rep.edgeSamples.finished} / open ${rep.edgeSamples.open} / sea horizon ${rep.edgeSamples.horizon} (slivers < 1 m: ${rep.edgeSamples.slivers}); ${rep.rows.length} fault(s) ${rep.ok ? "OK" : "FAIL"} (${rep.ms} ms)`);
  for (const m of extra ?? []) console.log(`  fall ${m.fall} ${m.river}: lip shift ${m.lipShift} m${m.lipFound ? "" : " (no edge found)"}, top gap ${m.topGap} m, face gap ${m.faceGap} m, free ${m.free}, in rock ${m.inRock}, landed cols ${m.landed} (${m.landsAbovePool} m)`);
  const rows = [...rep.rows].sort((a, b) => (b.length ?? b.faceGap ?? 0) - (a.length ?? a.faceGap ?? 0));
  for (const r of rows.slice(0, list ? rows.length : 12)) console.log(`  ${r.kind} ${r.id} "${r.what}" at (${r.x}, ${r.y}, ${r.z}): ${r.issue}`);
  if (!list && rows.length > 12) console.log(`  ... ${rows.length - 12} more (--list)`);
}

function emit(rep: WaterEdgesReport, argv: string[], extra?: any[]): void {
  const out = opt(argv, "out");
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ ...rep, passed: rep.ok, falls: extra ?? [] }, null, 1) /* passed: the dungeon pipeline reads it */); }
  if (argv.includes("--json")) console.log(JSON.stringify({ ...rep, falls: extra ?? [] }));
  else print(rep, argv.includes("--list"), extra);
}

function parseArea(argv: string[]): { area: Area; text: string } {
  const rc = opt(argv, "rect");
  if (rc) { const v = rc.split(",").map(Number) as [number, number, number, number]; return { area: { rect: v }, text: `rect ${v.join(",")}` }; }
  const n = opt(argv, "near");
  if (!n) return { area: {}, text: "(all)" };
  const v = n.split(",").map(Number) as [number, number, number];
  return { area: { near: v }, text: `near ${v.join(",")}` };
}

/** The world's own scene (placed ponds, wells, fountains), when its project has one. */
function worldScene(file: string, world: string): { assets: string; doc: SceneDoc } | null {
  const assets = path.dirname(path.dirname(path.resolve(file)));
  const sf = path.join(assets, "scenes", `${world}.scene.json`);
  return fs.existsSync(sf) ? { assets, doc: readJson(sf) as SceneDoc } : null;
}

/** `worldgen water-edges <world>`: every curtain (and with the world's scene, every placed body). `--stamp` stamps the stage. */
export function commandWaterEdges(host: { argv: string[]; loadRecipe(): { recipe: WorldRecipe; file: string }; fail(m: string): never; writeRecipe?(recipe: WorldRecipe, file: string): void }): WaterEdgesReport {
  const t0 = performance.now();
  const { argv } = host;
  const { recipe, file } = host.loadRecipe();
  const field = createWorldField(recipe);
  const { area, text } = parseArea(argv);
  const stamp = argv.includes("--stamp");
  if (stamp && (area.near || area.rect)) host.fail("--stamp sweeps the whole world; drop --near/--rect");
  const world = path.basename(file).replace(/\.json$/, "");
  const projectOf = path.basename(path.dirname(path.dirname(path.dirname(path.resolve(file)))));
  const matCache = new Map<string, any>();
  const materialOf = (name: string): any => {
    if (!matCache.has(name)) { const mf = findAsset(projectOf, `materials/${name}.json`); matCache.set(name, mf ? readJson(mf) : null); }
    return matCache.get(name);
  };
  const curtains = worldCurtains(field, area, materialOf);
  const parts: Parameters<typeof summarize>[3] = [curtains];
  const ws = argv.includes("--no-scene") ? null : worldScene(file, world);
  if (ws) parts.push(sceneWaterEdges(ws.assets, ws.doc, field, area));
  const rep = summarize(world, text, t0, parts);
  emit(rep, argv, curtains.measures);
  if (stamp && rep.ok && host.writeRecipe) {
    (recipe as any).pipeline = { ...((recipe as any).pipeline ?? {}), "water-edges": new Date().toISOString() };
    host.writeRecipe(recipe, file);
    console.log("  stamped stage water-edges");
  }
  if (!rep.ok) process.exitCode = 1;
  return rep;
}

// ------------------------------------------------------------------ fix (scenes)

/**
 * A dark finish reads as DISTANCE, not a wall, in one of two ways, chosen by how far the channel stays open past the
 * water's end (`openRun`):
 * - a long run (>= DEEP_RUN m): VEILS stand across it, set back over the run (share `at`), each hiding more of what
 *   lies behind (transmittance past veil k: 0.75, 0.45, 0.2, 0), so the real walls fall off step by step (PSX
 *   banding, not a smooth fog) into an opaque last one;
 * - a short run (the channel ends in rock a metre or two past the light: wreck-hole's sea mouth, 1.5 m): one PAINTED
 *   card at the run's end, a tunnel going away (darkDepthPng): what the walls would do, in the card itself.
 * The water runs on under either, to the card.
 */
export const DARK_SLICES: readonly { at: number; opacity: number }[] = [
  { at: 0.15, opacity: 0.25 },
  { at: 0.4, opacity: 0.4 },
  { at: 0.68, opacity: 0.55 },
  { at: 1, opacity: 1 },
];
export const DEEP_RUN = 6;

/**
 * The painted card: a tunnel going away — rounded rings, banded and ordered-dithered (PSX steps, nearest-filtered),
 * from the wall tone a metre or two in at the rim (no brighter than the fog: unlit, it must not glow) to black over
 * the vanishing point, low over the water (VANISH: share of the card from its top; the card reaches 0.6 m under the
 * surface to the roof, so the dark opens about a metre over the water). The arch in front hides the card's edges.
 */
const VANISH = 0.62;
export function darkDepthPng(tone: string, size = 32, bands = 5): Buffer {
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const rgb = [1, 3, 5].map((i) => parseInt(tone.slice(i, i + 2), 16));
  const px = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const v = (j + 0.5) / size;
      const dx = Math.abs((i + 0.5) / size - 0.5) / 0.5, dy = v < VANISH ? (VANISH - v) / VANISH : (v - VANISH) / (1 - VANISH);
      const d = Math.min(1, Math.cbrt(dx ** 3 + dy ** 3));
      const t = d ** 1.8 * bands + (bayer[(j % 4) * 4 + (i % 4)]! / 16 - 0.5) * 0.8;
      const f = Math.max(0, Math.min(1, Math.floor(t) / (bands - 1)));
      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(rgb[c]! * f);
      px[o + 3] = 255;
    }
  return encodePng(size, size, px);
}

export interface DarkMaterials { veils: string[]; painted: string }

/** The finish materials: veils [0..3] (unlit, the scene's fog tone darkened; the last opaque) and the painted card. */
export function ensureDarkVeils(assets: string, project: string, tone: string, wallTone = tone): DarkMaterials {
  const write = (id: string, body: object): string => {
    const f = path.join(assets, "materials", `${id}.json`);
    const text = JSON.stringify(body, null, 2) + "\n";
    if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== text) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    return id;
  };
  const tex = `${project}/water-dark-depth.png`;
  const tf = path.join(assets, "textures", tex);
  fs.mkdirSync(path.dirname(tf), { recursive: true });
  fs.writeFileSync(tf, darkDepthPng(wallTone));
  return {
    veils: DARK_SLICES.map((sl, k) => write(`${project}/water-dark-veil-${k}`, { shader: "unlit", color: tone, side: "double", opacity: sl.opacity, transparent: sl.opacity < 1 })),
    painted: write(`${project}/water-dark-depth`, { shader: "unlit", color: "#ffffff", map: tex, filter: "nearest", side: "double", opacity: 1 }),
  };
}

/** The scene's fog colour (its sky) scaled by `k` (0.3: the dark it recedes into; 1: the painted tunnel's rim); black without one. */
export function darkTone(doc: SceneDoc, k = 0.3): string {
  for (const e of Object.values(doc.entities as Record<string, any>)) {
    const c = e?.components?.sky?.fog?.color ?? e?.components?.fog?.color;
    if (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)) {
      const v = [1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(c.slice(i, i + 2), 16) * k)));
      return "#" + v.map((n) => n.toString(16).padStart(2, "0")).join("");
    }
  }
  return "#000000";
}

/** How far a channel stays open past (x, z) along `out` at the water's level (to the first rock or a drop), capped. */
export function openRun(probe: SolidProbe, x: number, z: number, y: number, out: [number, number], cap = 12): number {
  for (let d = 0.5; d <= cap; d += 0.5) {
    const px = x + out[0] * d, pz = z + out[1] * d;
    if (solidAt(probe, px, y + 0.3, pz) || probe.floor(px, pz, y, y - 12) === null) return Math.max(0.5, d - 0.5);
  }
  return cap;
}

/**
 * A dark finish as entities: veils over a long run or one painted card at a short run's end (see DARK_SLICES), and
 * the water running on under them (a strip of the body's own material). Ids: `fid` (the last card: the finish's
 * entity), `fid`-veil-<k>, `fid`-water.
 */
export function darkFinishEntities(fid: string, name: string, mid: [number, number], out: [number, number], width: number, surfaceY: number, run: number, roof: (x: number, z: number) => number | null, mats: DarkMaterials, water: string | undefined): Record<string, any> {
  const yaw = Math.atan2(-out[0], -out[1]);
  const ents: Record<string, any> = {};
  const span = Math.max(0.6, run - 0.2);
  const card = (id: string, d: number, material: string, label: string, grow: number): void => {
    const x = mid[0] + out[0] * d, z = mid[1] + out[1] * d;
    const height = Math.max(2.5, Math.min(8, (roof(x, z) ?? surfaceY + 4) - surfaceY + 0.6));
    ents[id] = {
      name: `${name}: ${label}`, parent: null, tags: ["water-finish"],
      components: {
        transform: { position: [r2(x), r2(surfaceY - 0.6 + height / 2), r2(z)], rotation: quatYawPitch(yaw, Math.PI / 2), scale: [1, 1, 1] },
        mesh: { source: { kind: "primitive", shape: "plane", size: [r2(width + grow), 1, r2(height)] }, material, castShadow: false, receiveShadow: false },
      },
    };
  };
  if (run >= DEEP_RUN) {
    DARK_SLICES.forEach((sl, k) => {
      const last = k === DARK_SLICES.length - 1;
      card(last ? fid : `${fid}-veil-${k}`, 0.3 + (span - 0.3) * sl.at, mats.veils[k]!, `continues into dark (${k + 1}/${DARK_SLICES.length})`, 0.2 * k);
    });
  } else card(fid, span, mats.painted, "continues into dark (painted depth)", 0.4);
  if (water) {
    ents[`${fid}-water`] = {
      name: `${name}: water running on into the dark`, parent: null, tags: ["water-finish"],
      components: {
        transform: { position: [r2(mid[0] + out[0] * (span / 2 + 0.1)), r2(surfaceY - 0.01), r2(mid[1] + out[1] * (span / 2 + 0.1))], rotation: quatYawPitch(yaw, 0), scale: [1, 1, 1] },
        mesh: { source: { kind: "primitive", shape: "plane", size: [r2(width + 0.6), 1, r2(span + 0.4)] }, material: water, castShadow: false, receiveShadow: false },
      },
    };
  }
  return ents;
}

/** The drain's material: unlit black, written once into the project. */
export function ensureDarkMaterial(assets: string, project: string): string {
  const id = `${project}/water-dark`;
  const f = path.join(assets, "materials", `${id}.json`);
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ shader: "unlit", color: "#000000", side: "double" }, null, 2) + "\n");
  }
  return id;
}

/**
 * The ops that make every faulty body's edges good: re-cut to its walls (a surface mesh, buried rim), then a finish
 * on each stretch still open (>= `minFinish` m): a run-on channel gets a dark card standing across it where it leaves
 * the light; a drop gets a drain (a dark floor under the brink). Bodies already clean get no op (idempotent).
 */
export function waterFixOps(assets: string, project: string, doc: SceneDoc, field: WorldField | null, opts: { grow?: number; finish?: boolean; minFinish?: number } = {}): { ops: any[]; notes: string[] } {
  const ents = doc.entities as Record<string, any>;
  const solid = sceneSolid(assets, doc, field);
  const before = sceneWaterEdges(assets, doc, field, {}, solid);
  const faulty = new Set(before.rows.map((r) => r.id));
  const ops: any[] = [];
  const notes: string[] = [];
  let darkMat: string | null = null;
  let veils: DarkMaterials | null = null;
  for (const b of solid.bodies) {
    if (!faulty.has(b.id)) continue;
    const e = ents[b.id];
    if (!e || e.parent) { notes.push(`${b.id}: not a root entity; re-cut it by hand`); continue; }
    // idempotent: a sheet already re-cut (a surface mesh) is never re-cut again (its seed would have grown); what is
    // still open on it is listed by the gate for a hand to finish
    if (e.components.mesh?.source?.kind === "surface") { notes.push(`${b.id}: already re-cut; ${before.rows.filter((r) => r.id === b.id).length} open stretch(es) left for a hand`); continue; }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < b.world.length; k += 3) { x0 = Math.min(x0, b.world[k]!); x1 = Math.max(x1, b.world[k]!); z0 = Math.min(z0, b.world[k + 2]!); z1 = Math.max(z1, b.world[k + 2]!); }
    const clip = clipWaterToSolid(solid.probe, { x0, z0, x1, z1 }, b.surfaceY, { grow: opts.grow ?? 8, depth: b.depth });
    if (clip.wet === 0) { notes.push(`${b.id}: no cell holds water at ${b.surfaceY} (is the surface under the floor?)`); continue; }
    const finishes: WaterFinish[] = (b.finishes ?? []).filter((f) => !f.entity || !f.entity.startsWith(`${b.id}-finish-`));
    if (opts.finish !== false) {
      // what the GATE will still call open on the re-cut sheet (a channel going on past the reach, a hole): one finish each
      const cut = classifyEdges(solid.probe, meshOutline(clip.positions, clip.indices, clip.origin), b.surfaceY, [], { bedDepth: Math.max(12, b.depth + 1) });
      for (const [n, st] of cut.runs.entries()) {
        const fid = `${b.id}-finish-${n}`;
        const mx = (st.from[0] + st.to[0]) / 2, mz = (st.from[1] + st.to[1]) / 2;
        const width = Math.hypot(st.to[0] - st.from[0], st.to[1] - st.from[1]) + 1;
        const kind = st.why === "drop" ? "drain" : "dark";
        // the card faces back into the water (-out); across it is the stretch
        const yaw = Math.atan2(-st.out[0], -st.out[1]);
        if (kind === "dark") {
          // depth, not a wall: veils down a long open channel, a painted tunnel at a short one; the water runs on under
          veils ??= ensureDarkVeils(assets, project, darkTone(doc), darkTone(doc, 1));
          const run = openRun(solid.probe, mx, mz, b.surfaceY, st.out);
          const roofAt = (x: number, z: number): number | null => solid.probe.ceiling?.(x, z, b.surfaceY + 0.1, b.surfaceY + 8) ?? null;
          const group = darkFinishEntities(fid, b.name, [mx, mz], st.out, width, b.surfaceY, run, roofAt, veils, e.components.mesh?.material);
          for (const [gid, ent] of Object.entries(group)) {
            if (ents[gid]) ops.push({ op: "remove-entity", id: gid });
            ops.push({ op: "add-entity", id: gid, entity: ent });
          }
          finishes.push({ kind, from: [r2(st.from[0]), r2(st.from[1])], to: [r2(st.to[0]), r2(st.to[1])], entity: fid });
          notes.push(`${b.id}: dark finish ${fid} over ${st.length.toFixed(1)} m at (${mx.toFixed(1)}, ${mz.toFixed(1)}): ${run >= DEEP_RUN ? `${DARK_SLICES.length} veils` : "a painted depth card"} over ${run.toFixed(1)} m of open channel`);
          continue;
        }
        darkMat ??= ensureDarkMaterial(assets, project);
        const entity = { // a drain: a dark floor 0.5 m under the surface past the brink, the water going down into it
              name: `${b.name}: drains into dark`, parent: null, tags: ["water-finish"],
              components: {
                transform: { position: [r2(mx + st.out[0] * 1), r2(b.surfaceY - 0.5), r2(mz + st.out[1] * 1)], rotation: quatYawPitch(yaw, 0), scale: [1, 1, 1] },
                mesh: { source: { kind: "primitive", shape: "plane", size: [r2(width), 1, 2] }, material: darkMat, castShadow: false, receiveShadow: false },
              },
            };
        if (ents[fid]) ops.push({ op: "remove-entity", id: fid });
        ops.push({ op: "add-entity", id: fid, entity });
        finishes.push({ kind, from: [r2(st.from[0]), r2(st.from[1])], to: [r2(st.to[0]), r2(st.to[1])], entity: fid });
        notes.push(`${b.id}: ${kind} finish ${fid} over ${st.length.toFixed(1)} m at (${mx.toFixed(1)}, ${mz.toFixed(1)})`);
      }
    }
    const t = e.components.transform ?? {};
    ops.push({ op: "set-component", id: b.id, component: "transform", data: { ...t, position: clip.origin.map(r2), rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
    ops.push({ op: "set-component", id: b.id, component: "mesh", data: { ...e.components.mesh, source: { kind: "surface", positions: clip.positions, indices: clip.indices } } });
    if (e.components.water) {
      const { size: _drop, ...water } = e.components.water;
      ops.push({ op: "set-component", id: b.id, component: "water", data: { ...water, ...(finishes.length ? { finishes } : {}) } });
    }
    notes.push(`${b.id}: re-cut to its walls (${clip.wet} wet + ${clip.rim} rim cells, ${(clip.bounds.x1 - clip.bounds.x0).toFixed(1)} x ${(clip.bounds.z1 - clip.bounds.z0).toFixed(1)} m)`);
  }
  return { ops, notes };
}

/** A card standing upright (a plane primitive is flat in XZ: pitch it up), turned by `yaw`. */
function quatYawPitch(yaw: number, pitch: number): number[] {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  // q = qYaw * qPitch(about X)
  return [r4(cy * sp), r4(sy * cp), r4(-sy * sp), r4(cy * cp)];
}
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

// ------------------------------------------------------------------ CLI

function sceneTarget(argv: string[], fail: (m: string) => never): { project: string; assets: string; file: string; doc: SceneDoc; field: WorldField | null } {
  const project = argv[1] ?? fail("usage: water-edges scene <project> [--scene <id|file>] [--world <recipe id>]");
  const assets = path.join(PROJECTS, project, "assets");
  const s = opt(argv, "scene");
  let file = s && fs.existsSync(s) ? s : path.join(assets, "scenes", `${s ?? project}.scene.json`);
  if (!fs.existsSync(file)) fail(`no scene ${file}; pass --scene`);
  const doc = readJson(file) as SceneDoc;
  return { project, assets, file, doc, field: fieldOfScene(project, doc, opt(argv, "world")) };
}

export function main(argv: string[]): void {
  const fail = (m: string): never => { console.error(m); process.exit(2); };
  const cmd = argv[0];
  if (cmd === "scene") {
    const t0 = performance.now();
    const t = sceneTarget(argv, fail);
    if (argv.includes("--fix")) {
      const { ops, notes } = waterFixOps(t.assets, t.project, t.doc, t.field, { grow: Number(opt(argv, "grow") ?? 8), finish: !argv.includes("--no-finish") });
      for (const n of notes) console.log(`  ${n}`);
      if (!ops.length) { console.log("water-edges --fix: nothing to do (idempotent: already applied)"); return; }
      const res = applyOps(t.doc, ops as never, registry());
      fs.writeFileSync(t.file, JSON.stringify(res.doc, null, 2));
      const inv = opt(argv, "inverse") ?? path.join(PROJECTS, t.project, "authoring", "sweeps", "water-fix.inverse.json");
      fs.mkdirSync(path.dirname(inv), { recursive: true });
      fs.writeFileSync(inv, JSON.stringify(res.inverse, null, 1));
      const after = sceneWaterEdges(t.assets, res.doc, t.field);
      console.log(`water-edges --fix: ${ops.length} ops applied to ${t.file}; inverse ${inv}; ${after.rows.length} fault(s) left`);
      return;
    }
    const { area, text } = parseArea(argv);
    const rep = summarize(`${t.project}/${path.basename(t.file)}`, text, t0, [sceneWaterEdges(t.assets, t.doc, t.field, area)]);
    emit(rep, argv);
    if (!rep.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "undo") {
    const t = sceneTarget(argv, fail);
    const inv = opt(argv, "inverse");
    if (!inv || !fs.existsSync(inv)) fail("undo needs --inverse <file>");
    const { doc: next } = applyOps(t.doc, readJson(inv!) as never, registry());
    fs.writeFileSync(t.file, JSON.stringify(next, null, 2));
    console.log(`water-edges undo: applied ${inv}`);
    return;
  }
  if (cmd === "world") {
    // node tools/water-edges.mts world <project> <world> [--near x,z,r] [--json] [--out f]  (no stamp; worldgen water-edges stamps)
    const [, project, world] = argv;
    const rf = findAsset(project!, `worlds/${world}.json`) ?? fail(`no world ${world} in ${project}'s closure`);
    commandWaterEdges({ argv, loadRecipe: () => ({ recipe: worldRecipeSchema.parse(readJson(rf)), file: rf }), fail });
    return;
  }
  fail("usage: water-edges scene <project> [...] [--fix] | water-edges undo <project> --inverse f | water-edges world <project> <world>   (worldgen water-edges <world>)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
