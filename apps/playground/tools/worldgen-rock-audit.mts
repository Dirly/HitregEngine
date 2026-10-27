/**
 * `worldgen rock-audit <world> [--zone z | --near x,z,r | --rect x0,z0,x1,z1 | --corridor "x,z;x,z;..." --width w]
 *                              [--every k] [--height-band 25] [--no-rocks] [--json] [--out f.json] [--md f.md] [--worst 20]`
 *
 * ROCK AUDIT — is the zone ONE palette per role, and does each role stay on its own slopes? (Derek 2026-10-21, his
 * major Hagsheer issue: "the rocks across what is being used isn't consistent", ground cover climbing the gorge walls.)
 *
 * It meshes the cells exactly as render does (`buildVoxelMesh`, the world's mesher choice) and reads every surface
 * triangle by its FACE normal (what the eye sees, not the vertex normal the splat was chosen with): the tile that
 * wins the triangle (largest summed weight of its three corners, the rendered top-4 on an indexed world) and every
 * tile holding a quarter or more. Skirt flaps (all corners on a cell side plane) and triangles under water are left
 * out. The scatter rocks of the area are read too: the slice each wears (main = cliff tile, small, large material)
 * and its cap layer.
 *
 * Bands: slope 0-20 / 20-45 / 45-70 / >70 degrees by height band (`--height-band` m). Faults, by area:
 *  (a) ground  — a GROUND tile (grass, dirt, gravel, scree, sand, turf...) wins a face steeper than 45 degrees;
 *  (b) cliff   — a CLIFF tile wins a face flatter than 20 degrees;
 *  (c) palette — a tile holding >= 25 % of a triangle (or worn by a rock) that is not in the zone's palette for its
 *                role (`regions[].palette`; without one, the zone's `ground` mapping is the implied palette).
 * Worst spots: faults binned on a 16 m grid, the largest fault area first. Exit 1 on any (a) or (c) area over
 * `--tolerance` (0.5 %) of the audited area.
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildVoxelMesh,
  createWorldField,
  pointInPolygon,
  regionPaletteSchema,
  scatterCell,
  scatterMaterialOf,
  type VoxelMesh,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { findAsset } from "./_closure.mjs";
import { surfaceRoles, zonePalette, type ZonePalette } from "./_zone-palette.mts";
import { updateJsonFile } from "./_scene-write.mts";
import { placedRocks } from "./rock-skins.mts";
import { modelTexel } from "./_model-texel.mjs";

export const SLOPE_BANDS = [
  { id: "0-20", lo: 0, hi: 20 },
  { id: "20-45", lo: 20, hi: 45 },
  { id: "45-70", lo: 45, hi: 70 },
  { id: ">70", lo: 70, hi: 91 },
] as const;
const bandOf = (deg: number): string => SLOPE_BANDS.find((b) => deg >= b.lo && deg < b.hi)!.id;

export interface TileUse { tris: number; area: number; at: [number, number, number] }
export interface AuditSpot { at: [number, number, number]; area: number; kinds: Record<string, number>; tiles: Record<string, number>; slope: number }
export interface RockAuditReport {
  ok: boolean;
  world: string;
  area: string;
  palette: ZonePalette | null;
  implied: boolean;
  cells: number;
  triangles: number;
  m2: number;
  /** slope band -> height band -> tile -> use (winning tile per triangle) */
  bands: Record<string, Record<string, Record<string, TileUse>>>;
  faults: { ground: { tris: number; area: number }; cliff: { tris: number; area: number }; palette: { tris: number; area: number; tiles: Record<string, number> } };
  /** m2 of off-palette tiles within half the zone border band of the edge (the neighbour's bleed): reported, not failed. */
  borderBleed: number;
  rocks: { checked: number; byMaterial: Record<string, number>; offPalette: { id: string; rule: string; tile: string; role: string; at: [number, number, number] }[]; offCount: number };
  /** Per-piece texel density (texture px / tile metres / the piece's scale: the rock-cap body is projected in MODEL metres). */
  texel: { checked: number; min: number | null; under: number; limit: number; worst: { id: string; what: string; tile: string; scale: number; txm: number; at: [number, number, number] }[] };
  worst: AuditSpot[];
  ms: number;
}

export interface AuditArea { contains(x: number, z: number): boolean; rect: [number, number, number, number]; text: string }

const r1 = (v: number) => Math.round(v * 10) / 10;

/** The implied palette of a zone with none declared: its `ground` mapping (and its rock cap). */
export function impliedPalette(recipe: WorldRecipe, zone: string | null): ZonePalette {
  const regions = ((recipe as { regions?: any[] }).regions ?? []) as any[];
  const z = zone ? regions.find((r) => r.id === zone) : null;
  const g = (z?.ground ?? {}) as Record<string, string>;
  return {
    ground: Object.entries(g).filter(([k]) => k !== "cliff").map(([, v]) => v),
    cliff: g.cliff ? [g.cliff] : [],
    cap: z?.rockCap?.layer ? [z.rockCap.layer] : [],
    rockSmall: [],
    rockLarge: [],
    builtStone: {},
  };
}

/** Is a triangle a skirt flap (every corner on one vertical side plane of its cell)? */
function onSidePlane(p: Float32Array, a: number, b: number, c: number, cellSize: number): boolean {
  const eps = 1e-3;
  for (const axis of [0, 2]) {
    const va = p[a * 3 + axis]!;
    if (Math.abs(va) > eps && Math.abs(va - cellSize) > eps) continue;
    if (Math.abs(p[b * 3 + axis]! - va) < eps && Math.abs(p[c * 3 + axis]! - va) < eps) return true;
  }
  return false;
}

export interface TriangleSink {
  (t: { x: number; y: number; z: number; deg: number; area: number; win: number; heavy: number[] }): void;
}

/** Walk a cell mesh's surface triangles: world centroid, FACE slope (deg), area, winning palette id and the ids holding >= `heavyShare`. */
export function walkMeshTriangles(mesh: VoxelMesh, x0: number, z0: number, cellSize: number, sink: TriangleSink, heavyShare = 0.25): void {
  const p = mesh.positions, idx = mesh.indices, S = mesh.surfaceCount;
  const acc = new Float32Array(Math.max(S, 1));
  const li = mesh.layerIndex, lw = mesh.layerWeight;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = idx[t * 3]!, b = idx[t * 3 + 1]!, c = idx[t * 3 + 2]!;
    if (onSidePlane(p, a, b, c, cellSize)) continue;
    const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const area = len / 2;
    const deg = (Math.acos(Math.min(1, Math.abs(ny) / len)) * 180) / Math.PI;
    acc.fill(0);
    for (const v of [a, b, c]) {
      if (li && lw) for (let k = 0; k < 4; k++) { const id = li[v * 4 + k]!; if (id < S) acc[id] = acc[id]! + lw[v * 4 + k]! / 255; }
      else for (let s = 0; s < S; s++) acc[s] = acc[s]! + mesh.splat[v * S + s]!;
    }
    let win = 0, total = 0;
    for (let s = 0; s < S; s++) { total += acc[s]!; if (acc[s]! > acc[win]!) win = s; }
    const heavy: number[] = [];
    if (total > 0) for (let s = 0; s < S; s++) if (acc[s]! / total >= heavyShare) heavy.push(s);
    sink({ x: (p[a * 3]! + p[b * 3]! + p[c * 3]!) / 3 + x0, y: (p[a * 3 + 1]! + p[b * 3 + 1]! + p[c * 3 + 1]!) / 3, z: (p[a * 3 + 2]! + p[b * 3 + 2]! + p[c * 3 + 2]!) / 3 + z0, deg, area, win, heavy });
  }
}

export interface RockAuditOptions {
  recipe: WorldRecipe;
  field?: WorldField;
  area: AuditArea;
  zone: string | null;
  project?: string;
  every?: number;
  heightBand?: number;
  rocks?: boolean;
  worst?: number;
  tolerance?: number;
  mesher?: "mc" | "dc" | "nets" | "auto";
  /** Texels per metre below which a rock piece is flagged (default 20; the standard is 40). */
  texelLimit?: number;
  /** Scene rocks (rock-kit prefab instances, rockCap meshes) to read texel density from (worldgen passes the world's scene). */
  placed?: { id: string; what: string; x: number; y: number; z: number; material: string | null; rockCap: { base?: number } | null; modelBase: string | null; scale: number }[];
  /** Mesh source for one cell (tests hand a synthetic one in). */
  meshCell?: (field: WorldField, cx: number, cz: number) => VoxelMesh;
}

export function rockAudit(opts: RockAuditOptions): RockAuditReport {
  const t0 = performance.now();
  const { recipe, area } = opts;
  const field = opts.field ?? createWorldField(recipe);
  const declared = opts.zone ? zonePalette(recipe, opts.zone) : null;
  const palette = declared ?? (opts.zone ? impliedPalette(recipe, opts.zone) : null);
  const roles = surfaceRoles(recipe, palette);
  const names = recipe.surfaces.map((s) => s.name);
  const S = recipe.cellSize, every = Math.max(1, opts.every ?? 1), hb = opts.heightBand ?? 25;
  const meshCell = opts.meshCell ?? ((f: WorldField, cx: number, cz: number) => buildVoxelMesh(f, { kind: "voxel", world: recipe.name, cell: [cx, cz], mesher: opts.mesher ?? "auto" }));
  const bands: RockAuditReport["bands"] = {};
  const faults: RockAuditReport["faults"] = { ground: { tris: 0, area: 0 }, cliff: { tris: 0, area: 0 }, palette: { tris: 0, area: 0, tiles: {} } };
  const bins = new Map<string, AuditSpot>();
  // a surface is in the palette by NAME or by its TEXTURE (the world's river gravel is the zone road's Gravel.png)
  const mapOf = (n: string) => (recipe.surfaces.find((s) => s.name === n) as { map?: string } | undefined)?.map ?? n;
  const okCliff = new Set((palette?.cliff ?? []).flatMap((n) => [n, mapOf(n)]));
  const okGround = new Set([...(palette?.ground ?? []), ...(palette?.cap ?? [])].flatMap((n) => [n, mapOf(n)]));
  const allowed = (s: number): boolean => {
    if (!palette) return true;
    const role = roles[s];
    if (role === "climate") return true;
    const n = names[s]!, m = mapOf(n);
    return role === "cliff" ? okCliff.has(n) || okCliff.has(m) : okGround.has(n) || okGround.has(m);
  };
  const spot = (x: number, y: number, z: number, area: number, kind: string, tile: string, deg: number) => {
    const k = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
    const b = bins.get(k) ?? { at: [r1(x), r1(y), r1(z)] as [number, number, number], area: 0, kinds: {}, tiles: {}, slope: 0 };
    b.area += area; b.kinds[kind] = (b.kinds[kind] ?? 0) + area; b.tiles[tile] = (b.tiles[tile] ?? 0) + area; b.slope = Math.max(b.slope, Math.round(deg));
    bins.set(k, b);
  };
  // the zone border blends the neighbour's tiles over zoneGround.band (Derek: "bleed from adjacency"): a tile of the
  // neighbour inside half the band of the edge is that bleed, not a palette fault
  const zoneDoc = opts.zone ? (((recipe as { regions?: any[] }).regions ?? []).find((r) => r.id === opts.zone) as { polygon: [number, number][] } | undefined) : undefined;
  const half = ((recipe as { zoneGround?: { band?: number } }).zoneGround?.band ?? 150) / 2;
  const nearEdge = (x: number, z: number): boolean => {
    const p = zoneDoc?.polygon;
    if (!p) return false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) if (segDist(x, z, p[j]!, p[i]!) < half) return true;
    return false;
  };
  let border = 0;
  let cells = 0, triangles = 0, m2 = 0;
  const [rx0, rz0, rx1, rz1] = area.rect;
  const sea = recipe.seaLevel ?? 0;
  for (let cz = Math.floor(rz0 / S); cz <= Math.floor(rz1 / S); cz++)
    for (let cx = Math.floor(rx0 / S); cx <= Math.floor(rx1 / S); cx++) {
      if (((cx % every) + every) % every !== 0 || ((cz % every) + every) % every !== 0) continue;
      const mx = (cx + 0.5) * S, mz = (cz + 0.5) * S;
      if (!area.contains(mx, mz) && !area.contains(cx * S, cz * S) && !area.contains((cx + 1) * S, (cz + 1) * S)) continue;
      const mesh = meshCell(field, cx, cz);
      if (mesh.triangleCount === 0) continue;
      cells++;
      walkMeshTriangles(mesh, cx * S, cz * S, S, (t) => {
        if (!area.contains(t.x, t.z)) return;
        const w = field.waterY(t.x, t.z);
        if ((w !== null && t.y < w - 0.25) || t.y < sea - 0.25) return;
        triangles++; m2 += t.area;
        const sb = bandOf(t.deg), h = `${Math.floor(t.y / hb) * hb}`;
        const tile = names[t.win]!;
        const row = ((bands[sb] ??= {})[h] ??= {});
        const u = (row[tile] ??= { tris: 0, area: 0, at: [r1(t.x), r1(t.y), r1(t.z)] });
        u.tris++; u.area += t.area;
        const role = roles[t.win];
        if (role === "ground" && t.deg > 45) { faults.ground.tris++; faults.ground.area += t.area; spot(t.x, t.y, t.z, t.area, "ground-on-face", tile, t.deg); }
        if (role === "cliff" && t.deg < 20) { faults.cliff.tris++; faults.cliff.area += t.area; spot(t.x, t.y, t.z, t.area, "cliff-on-flat", tile, t.deg); }
        const off = t.heavy.filter((s) => !allowed(s));
        if (off.length && nearEdge(t.x, t.z)) border += t.area;
        else if (off.length) {
          faults.palette.tris++; faults.palette.area += t.area;
          for (const s of off) faults.palette.tiles[names[s]!] = (faults.palette.tiles[names[s]!] ?? 0) + t.area;
          spot(t.x, t.y, t.z, t.area, "off-palette", names[off[0]!]!, t.deg);
        }
      });
    }

  // ---- texel density per piece: px of the slice / its tile metres / the piece's scale
  const TEXEL_LIMIT = opts.texelLimit ?? 20;
  const texel: RockAuditReport["texel"] = { checked: 0, min: null, under: 0, limit: TEXEL_LIMIT, worst: [] };
  const widthCache = new Map<string, number>();
  const pxOf = (tile: string): number => {
    if (!widthCache.has(tile)) { const f = opts.project ? findAsset(opts.project, `textures/${tile}`) : null; let w = 0; try { if (f) w = fs.readFileSync(f).readUInt32BE(16); } catch { w = 0; } widthCache.set(tile, w); }
    return widthCache.get(tile)!;
  };
  /** `atScale1`: a model's own UV density (tx/m at scale 1) instead of a rock-cap slice (px / tile metres). */
  const texelPiece = (id: string, what: string, tile: string, metres: number, scale: number, x: number, y: number, z: number, atScale1?: number) => {
    const px = atScale1 === undefined ? pxOf(tile) : 1;
    if (!px || !(scale > 0)) return;
    const txm = (atScale1 ?? px / metres) / scale;
    texel.checked++;
    texel.min = texel.min === null ? txm : Math.min(texel.min, txm);
    if (txm >= TEXEL_LIMIT) return;
    texel.under++;
    texel.worst.push({ id, what, tile, scale: r1(scale), txm: r1(txm), at: [r1(x), r1(y), r1(z)] });
    spot(x, y, z, Math.max(1, scale * scale * 4), "low-texel", `${what} ${r1(txm)} tx/m`, 0);
  };
  // ---- scatter rocks: the slice they wear and their cap
  const rocks: RockAuditReport["rocks"] = { checked: 0, byMaterial: {}, offPalette: [], offCount: 0 };
  if (opts.rocks !== false && opts.project) {
    const mats = new Map<string, { bases: { map: string; metres?: number }[] } | null>();
    const matOf = (id: string) => {
      if (!mats.has(id)) { const f = findAsset(opts.project!, `materials/${id}.json`); mats.set(id, f ? JSON.parse(fs.readFileSync(f, "utf8")).rockCap ?? null : null); }
      return mats.get(id);
    };
    const cliffMaps = new Set((palette?.cliff ?? []).map((n) => (recipe.surfaces.find((s) => s.name === n) as { map?: string } | undefined)?.map).filter(Boolean) as string[]);
    for (let cz = Math.floor(rz0 / S); cz <= Math.floor(rz1 / S); cz++)
      for (let cx = Math.floor(rx0 / S); cx <= Math.floor(rx1 / S); cx++) {
        if (((cx % every) + every) % every !== 0 || ((cz % every) + every) % every !== 0) continue;
        const insts = scatterCell(field, cx, cz);
        for (const inst of insts) {
          if (!inst.rockCap) {
            // a model drawing its OWN texture (trees, logs, hoodoos): its UV density at scale 1, divided by the instance scale
            const rule0 = recipe.scatter[inst.ruleIndex]!;
            const model = inst.model ?? (inst.variant !== undefined ? rule0.modelVariants?.[inst.variant]?.model : undefined) ?? rule0.model;
            const mf = model ? findAsset(opts.project!, `models/${model}`) : null;
            const mt = mf ? (modelTexel(mf) as { min: number } | null) : null;
            const ix = inst.position[0] + cx * S, iz = inst.position[2] + cz * S;
            if (mt && area.contains(ix, iz)) texelPiece(inst.id, rule0.id, model!, 1, inst.scale ?? 1, ix, inst.position[1], iz, mt.min);
            continue;
          }
          const rule = recipe.scatter[inst.ruleIndex]!;
          const x = inst.position[0] + cx * S, z = inst.position[2] + cz * S, y = inst.position[1];
          if (!area.contains(x, z)) continue;
          rocks.checked++;
          const sc = inst.scale ?? 1;
          const box = inst.colliderSize ?? (inst.variant !== undefined ? rule.modelVariants?.[inst.variant]?.colliderSize : undefined) ?? rule.colliderSize;
          const matId = scatterMaterialOf(rule, box, sc) ?? rule.material ?? "";
          const mat = matOf(matId);
          const kind = matId === rule.smallMaterial ? "rockSmall" : matId === rule.largeMaterial ? "rockLarge" : "cliff";
          const base = inst.rockCap.base ?? 0;
          const tile = mat?.bases?.[base]?.map ?? `${matId}#${base}`;
          rocks.byMaterial[`${kind}:${tile}`] = (rocks.byMaterial[`${kind}:${tile}`] ?? 0) + 1;
          texelPiece(inst.id, rule.id, tile, mat?.bases?.[base]?.metres ?? 6.4, sc, x, y, z);
          let ok = true;
          if (palette && nearEdge(x, z)) continue; // the border's bleed: the neighbour's stone and caps blend in
          if (palette) {
            if (kind === "cliff") ok = cliffMaps.size === 0 || cliffMaps.has(tile);
            else { const list = palette[kind as "rockSmall" | "rockLarge"]; ok = list.length === 0 || list.includes(tile); }
          }
          const capAmount = inst.rockCap.amount ?? 0;
          const capLayer = inst.rockCap.layer ?? -1;
          if (palette && capAmount > 0 && capLayer >= 0 && capLayer < names.length && roles[capLayer] !== "climate" && palette.cap.length && !palette.cap.includes(names[capLayer]!)) {
            rocks.offCount++;
            if (rocks.offPalette.length < 200) rocks.offPalette.push({ id: inst.id, rule: rule.id, tile: names[capLayer]!, role: "cap", at: [r1(x), r1(y), r1(z)] });
            spot(x, y, z, 1, "off-palette-rock", names[capLayer]!, 0);
          }
          if (!ok) {
            rocks.offCount++;
            if (rocks.offPalette.length < 200) rocks.offPalette.push({ id: inst.id, rule: rule.id, tile, role: kind, at: [r1(x), r1(y), r1(z)] });
            spot(x, y, z, Math.max(1, sc * sc), "off-palette-rock", tile, 0);
          }
        }
      }
    // placed rocks (POI dressing, kit pieces): the same projection, the instance's world scale
    for (const p of opts.placed ?? []) {
      if (!area.contains(p.x, p.z)) continue;
      const mat = p.material ? matOf(p.material) : null;
      const base = p.rockCap?.base ?? 0;
      const tile = mat?.bases?.[base]?.map ?? p.modelBase;
      if (tile) texelPiece(p.id, p.what, tile, mat?.bases?.[base]?.metres ?? 6.4, p.scale, p.x, p.y, p.z);
    }
  }

  for (const sb of Object.values(bands)) for (const hb2 of Object.values(sb)) for (const u of Object.values(hb2)) u.area = r1(u.area);
  const worst = [...bins.values()].sort((a, b) => b.area - a.area).slice(0, opts.worst ?? 20).map((b) => ({ ...b, area: r1(b.area), kinds: Object.fromEntries(Object.entries(b.kinds).map(([k, v]) => [k, r1(v)])), tiles: Object.fromEntries(Object.entries(b.tiles).map(([k, v]) => [k, r1(v)])) }));
  faults.ground.area = r1(faults.ground.area); faults.cliff.area = r1(faults.cliff.area); faults.palette.area = r1(faults.palette.area);
  for (const k of Object.keys(faults.palette.tiles)) faults.palette.tiles[k] = r1(faults.palette.tiles[k]!);
  const tol = (opts.tolerance ?? 0.005) * Math.max(m2, 1);
  return {
    ok: faults.ground.area <= tol && faults.palette.area <= tol && rocks.offCount === 0 && texel.under === 0,
    world: recipe.name, area: area.text, palette, implied: !declared && !!palette,
    cells, triangles, m2: Math.round(m2), borderBleed: Math.round(border), bands, faults, rocks, texel: { ...texel, min: texel.min === null ? null : r1(texel.min), worst: texel.worst.sort((a, b) => a.txm - b.txm).slice(0, 50) }, worst, ms: Math.round(performance.now() - t0),
  };
}

// ------------------------------------------------------------------ CLI

const opt = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

function segDist(px: number, pz: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2)) : 0;
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}

export function parseAuditArea(recipe: WorldRecipe, argv: string[], fail: (m: string) => never): { area: AuditArea; zone: string | null } {
  const regions = ((recipe as { regions?: any[] }).regions ?? []) as any[];
  const zoneId = opt(argv, "zone") ?? null;
  const zone = zoneId ? regions.find((r) => r.id === zoneId) : null;
  if (zoneId && !zone) fail(`no region ${zoneId}`);
  const inZone = (x: number, z: number) => !zone || pointInPolygon(x, z, zone.polygon);
  const near = opt(argv, "near"), rect = opt(argv, "rect"), corridor = opt(argv, "corridor");
  if (near) {
    const [x, z, r] = near.split(",").map(Number) as [number, number, number];
    return { zone: zoneId, area: { rect: [x - r, z - r, x + r, z + r], contains: (px, pz) => Math.hypot(px - x, pz - z) <= r && inZone(px, pz), text: `near ${near}` } };
  }
  if (rect) {
    const [a, b, c, d] = rect.split(",").map(Number) as [number, number, number, number];
    return { zone: zoneId, area: { rect: [a, b, c, d], contains: (px, pz) => px >= a && pz >= b && px <= c && pz <= d && inZone(px, pz), text: `rect ${rect}` } };
  }
  if (corridor) {
    const pts = corridor.split(";").map((p) => p.split(",").map(Number) as [number, number]);
    const w = Number(opt(argv, "width") ?? 120) / 2;
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    return {
      zone: zoneId,
      area: {
        rect: [Math.min(...xs) - w, Math.min(...zs) - w, Math.max(...xs) + w, Math.max(...zs) + w],
        contains: (px, pz) => { for (let i = 0; i + 1 < pts.length; i++) if (segDist(px, pz, pts[i]!, pts[i + 1]!) <= w) return inZone(px, pz); return false; },
        text: `corridor ${pts.length} pts, ${w * 2} m wide`,
      },
    };
  }
  if (!zone) fail("rock-audit wants --zone <id> (or --near / --rect / --corridor)");
  const xs = zone.polygon.map((p: number[]) => p[0]), zs = zone.polygon.map((p: number[]) => p[1]);
  return { zone: zoneId, area: { rect: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)], contains: inZone, text: `zone ${zoneId}` } };
}

export function rockAuditMarkdown(rep: RockAuditReport, title: string): string {
  const pct = (a: number) => `${((100 * a) / Math.max(rep.m2, 1)).toFixed(2)} %`;
  const L: string[] = [`# ${title}`, "", `World ${rep.world}, ${rep.area}; ${rep.cells} cells, ${rep.triangles} triangles, ${rep.m2} m2 of drawn surface (above water); ${rep.ms} ms.`, ""];
  L.push(`Palette ${rep.implied ? "(IMPLIED from regions[].ground: none declared)" : "(regions[].palette)"}: ground [${rep.palette?.ground.join(", ") ?? "-"}], cliff [${rep.palette?.cliff.join(", ") ?? "-"}], cap [${rep.palette?.cap.join(", ") ?? "-"}], rockSmall [${rep.palette?.rockSmall.join(", ") ?? "-"}], rockLarge [${rep.palette?.rockLarge.join(", ") ?? "-"}].`, "");
  L.push("| fault | triangles | m2 | share |", "| --- | --- | --- | --- |");
  L.push(`| (a) ground tile on a face > 45 deg | ${rep.faults.ground.tris} | ${rep.faults.ground.area} | ${pct(rep.faults.ground.area)} |`);
  L.push(`| (b) cliff tile on a face < 20 deg | ${rep.faults.cliff.tris} | ${rep.faults.cliff.area} | ${pct(rep.faults.cliff.area)} |`);
  L.push(`| (c) tile outside the zone palette (>= 25 % of a triangle) | ${rep.faults.palette.tris} | ${rep.faults.palette.area} | ${pct(rep.faults.palette.area)} |`);
  L.push(`| border bleed (neighbour tiles within half the zone band of the edge: reported, not failed) | | ${rep.borderBleed} | ${pct(rep.borderBleed)} |`);
  L.push(`| (c) rocks wearing a slice / cap outside the palette | ${rep.rocks.offCount} of ${rep.rocks.checked} | | |`, "");
  if (Object.keys(rep.faults.palette.tiles).length) L.push(`Off-palette terrain tiles (m2): ${Object.entries(rep.faults.palette.tiles).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`, "");
  L.push(`Texel density (rock pieces, px / tile m / piece scale; the rock-cap body is projected in model metres): ${rep.texel.checked} pieces, min ${rep.texel.min ?? "-"} tx/m, ${rep.texel.under} under ${rep.texel.limit} tx/m. Lowest: ${rep.texel.worst.slice(0, 10).map((w) => `${w.what} x${w.scale} ${w.txm} tx/m at ${w.at.join(", ")}`).join("; ") || "-"}`, "");
  L.push(`Rocks by slice: ${Object.entries(rep.rocks.byMaterial).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`, "");
  L.push("## Winning tile by slope band (m2, all heights)", "", "| slope | tiles |", "| --- | --- |");
  for (const b of SLOPE_BANDS) {
    const tot: Record<string, number> = {};
    for (const row of Object.values(rep.bands[b.id] ?? {})) for (const [k, u] of Object.entries(row)) tot[k] = (tot[k] ?? 0) + u.area;
    L.push(`| ${b.id} | ${Object.entries(tot).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v)}`).join(", ")} |`);
  }
  L.push("", `## Worst ${rep.worst.length} spots (16 m bins, fault m2)`, "", "| # | at x,y,z | m2 | max slope | faults | tiles |", "| --- | --- | --- | --- | --- | --- |");
  rep.worst.forEach((s, i) => L.push(`| ${i + 1} | ${s.at.join(", ")} | ${s.area} | ${s.slope} | ${Object.entries(s.kinds).map(([k, v]) => `${k} ${v}`).join(", ")} | ${Object.entries(s.tiles).map(([k, v]) => `${k} ${v}`).join(", ")} |`));
  return L.join("\n") + "\n";
}

export function commandRockAudit(host: { argv: string[]; loadRecipe(): { recipe: WorldRecipe; file: string }; fail(m: string): never; project?: string }): RockAuditReport {
  const { argv } = host;
  const { recipe, file } = host.loadRecipe();
  const st = fs.statSync(file), recipeKey = `${st.size}:${st.mtimeMs}`; // zonegen's palette row: STALE once the recipe changes
  const { area, zone } = parseAuditArea(recipe, argv, host.fail);
  const project = host.project || path.basename(path.resolve(path.dirname(file), "..", ".."));
  const rep = rockAudit({
    recipe, area, zone, project,
    every: Number(opt(argv, "every") ?? 1), heightBand: Number(opt(argv, "height-band") ?? 25),
    rocks: !argv.includes("--no-rocks"), worst: Number(opt(argv, "worst") ?? 20), tolerance: Number(opt(argv, "tolerance") ?? 0.005),
    texelLimit: Number(opt(argv, "texel") ?? 20),
    placed: (() => { const sf = path.join(path.dirname(path.dirname(file)), "scenes", `${recipe.name}.scene.json`); return !argv.includes("--no-scene") && fs.existsSync(sf) ? placedRocks(project, JSON.parse(fs.readFileSync(sf, "utf8"))) : []; })(),
  });
  const out = opt(argv, "out"), md = opt(argv, "md");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ ...rep, recipeKey }, null, 1)); }
  if (md) fs.mkdirSync(path.dirname(path.resolve(md)), { recursive: true });
  if (md) fs.writeFileSync(md, rockAuditMarkdown(rep, opt(argv, "title") ?? `Rock audit: ${area.text}`));
  if (argv.includes("--json")) console.log(JSON.stringify(rep, null, 1));
  else {
    const pct = (a: number) => `${((100 * a) / Math.max(rep.m2, 1)).toFixed(2)}%`;
    console.log(`rock-audit ${rep.world} ${rep.area}: ${rep.cells} cells, ${rep.triangles} tris, ${rep.m2} m2, ${(rep.ms / 1000).toFixed(1)} s${rep.implied ? " (palette IMPLIED: declare regions[].palette)" : ""}`);
    console.log(`  (a) ground on >45deg ${rep.faults.ground.area} m2 (${pct(rep.faults.ground.area)})   (b) cliff on <20deg ${rep.faults.cliff.area} m2 (${pct(rep.faults.cliff.area)})   (c) off-palette ${rep.faults.palette.area} m2 (${pct(rep.faults.palette.area)}) ${JSON.stringify(rep.faults.palette.tiles)}; rocks off ${rep.rocks.offCount}/${rep.rocks.checked}; border bleed ${rep.borderBleed} m2`);
    for (const s of rep.worst.slice(0, 10)) console.log(`  ${s.at.join(",")}  ${s.area} m2  ${s.slope}deg  ${JSON.stringify(s.kinds)} ${JSON.stringify(s.tiles)}`);
    console.log(`  texel: ${rep.texel.checked} rock pieces, min ${rep.texel.min ?? "-"} tx/m, ${rep.texel.under} under ${rep.texel.limit} tx/m${rep.texel.worst.slice(0, 5).map((w) => `; ${w.what} x${w.scale} ${w.txm} tx/m @ ${w.at.join(",")}`).join("")}`);
    console.log(rep.ok ? "OK" : "FAIL: see docs/voxel-worlds.md \"Zone palette\"");
  }
  if (!rep.ok) process.exitCode = 1;
  return rep;
}

/**
 * `worldgen palette <world> --zone z [--set palette.json [--inverse f]] [--undo f]`: show or write a zone's
 * `regions[].palette` (schema-checked, under the recipe's lock; the inverse holds the palette it replaced).
 */
export function commandPalette(host: { argv: string[]; loadRecipe(): { recipe: WorldRecipe; file: string }; fail(m: string): never }): void {
  const { argv, fail } = host;
  const zone = opt(argv, "zone") ?? fail("palette wants --zone <id>");
  const { recipe, file } = host.loadRecipe();
  const region = ((recipe as { regions?: any[] }).regions ?? []).find((r) => r.id === zone) ?? fail(`no region ${zone}`);
  const set = opt(argv, "set"), undo = opt(argv, "undo");
  if (!set && !undo) { console.log(JSON.stringify(region.palette ?? null, null, 1)); return; }
  const next = undo ? JSON.parse(fs.readFileSync(undo, "utf8")).palette ?? null : JSON.parse(fs.readFileSync(set!, "utf8"));
  if (next) {
    const parsed = regionPaletteSchema.safeParse(next);
    if (!parsed.success) fail(`palette: ${parsed.error.message}`);
    const names = new Set(recipe.surfaces.map((s) => s.name));
    const unknown = [...parsed.data.ground, ...parsed.data.cliff, ...parsed.data.cap].filter((n) => !names.has(n));
    if (unknown.length) fail(`palette: not palette surfaces of ${recipe.name}: ${unknown.join(", ")}`);
  }
  let before: unknown = null;
  updateJsonFile(file, (raw: any) => {
    const r = (raw.regions ?? []).find((q: any) => q.id === zone);
    if (!r) throw new Error(`no region ${zone} on disk`);
    before = r.palette ?? null;
    if (next) r.palette = next; else delete r.palette;
    return { doc: raw };
  }, { label: `worldgen palette ${zone}` });
  const inv = opt(argv, "inverse");
  if (inv && !undo && !fs.existsSync(inv)) { fs.mkdirSync(path.dirname(path.resolve(inv)), { recursive: true }); fs.writeFileSync(inv, JSON.stringify({ zone, palette: before }, null, 1)); }
  console.log(`palette ${zone}: ${undo ? "restored" : "written"}${inv && !undo ? `; inverse ${inv} (worldgen palette ${recipe.name} --zone ${zone} --undo ${inv})` : ""}`);
}
