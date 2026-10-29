/**
 * `worldgen water-logic <world> [--near x,z,r | --rect x0,z0,x1,z1] [--step 16] [--json] [--list] [--stamp]`
 *
 * Do the world's water bodies AGREE with each other? Rivers, lakes and marsh
 * tables come from three systems (an authored river solved by the field, the
 * hydrology's lakes, a climate zone's `waterTable`), and nothing else compares
 * their levels. Measured on the built field, every finding with coordinates:
 *
 *  - `river-under-fen`  a river standing more than 0.5 m under a marsh sheet beside it (within its bank + 30 m)
 *                       with no declared weir holding it: the fen would drain into it. Fix: a `weirs` entry on the
 *                       river where it leaves the marsh (its level defaults to the table) — the river then IS the fen.
 *  - `flat-reach`       (a note: reported, does not fail) over 300 m of river with no fall in its water at all and no lake/marsh/weir holding it: still
 *                       water drawn as a river.
 *  - `lake-no-outlet`   a lake a river runs INTO with no river running out: it should drain (or be declared a sink).
 *  - `outlet-above-lake` a river leaving a lake standing higher than the lake.
 *  - `perched-sheet`    a still sheet (lake or marsh) whose edge stands over lower ground with no water of its own
 *                       (water ending in the air), or over lower water that no fall explains.
 *
 * Exit 1 on any finding; `--stamp` stamps the `water-logic` stage when the whole world is clean.
 * docs/voxel-worlds.md "Weirs: rivers held at a fen's level".
 */
import {
  createWorldField,
  regionAt,
  type SurfaceSample,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";

export interface WaterLogicFinding {
  kind: "river-under-fen" | "flat-reach" | "lake-no-outlet" | "outlet-above-lake" | "perched-sheet";
  /** River or lake id, or the sheet's kind. */
  id: string;
  zone: string;
  x: number;
  z: number;
  /** For runs: the other end. */
  toX?: number;
  toZ?: number;
  /** Metres of river (runs) or sample cells (sheets). */
  extent: number;
  detail: string;
  /** perched-sheet: the sheet's level and the lowest ground (or lower water) its edge stands over in this cell group. */
  level?: number;
  lower?: number;
}

export interface WaterLogicReport {
  ok: boolean;
  findings: WaterLogicFinding[];
  counts: Record<string, number>;
}

/** Reported, never failing on their own. */
const NOTE_KINDS = new Set<WaterLogicFinding["kind"]>(["flat-reach"]);
/** How far under a lake's sheet a river's water may run at the lake's edge: the rivers stage's hair (0.15 + 0.7 x depth) at a 2 m channel. */
export const RIVER_HAIR = 1.6;
/** Most a river leaving a lake may lose per 4 m sample: the hair plus 4 m at the steepest `runGrade` (0.18). */
export const OUTLET_STEP = RIVER_HAIR + 4 * 0.18;

type Area = { near?: [number, number, number]; rect?: [number, number, number, number] };

function inArea(area: Area, x: number, z: number): boolean {
  if (area.near) return Math.hypot(x - area.near[0], z - area.near[1]) <= area.near[2];
  if (area.rect) return x >= area.rect[0] && x <= area.rect[2] && z >= area.rect[1] && z <= area.rect[3];
  return true;
}

/** Every water-logic finding of a world, on its field (one is created when not given). */
export function waterLogic(recipe: WorldRecipe, opts: Area & { step?: number; field?: WorldField } = {}): WaterLogicReport {
  const field = opts.field ?? createWorldField(recipe);
  const area: Area = { near: opts.near, rect: opts.rect };
  const regions = recipe.regions ?? [];
  const zoneOf = (x: number, z: number): string => regionAt(regions, x, z)?.name ?? regionAt(regions, x, z)?.id ?? "-";
  const findings: WaterLogicFinding[] = [];
  const s: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const lakeAt = (x: number, z: number): boolean => field.waterSurface(x, z, s) && s.kind === "lake";

  // ---- rivers: under a fen, and flat reaches
  for (const river of field.rivers) {
    if (!river.water || !river.surfaceY || river.surfaceY.length !== river.points.length) continue;
    const n = river.points.length;
    const along = [0];
    for (let k = 1; k < n; k++) along.push(along[k - 1]! + Math.hypot(river.points[k]![0] - river.points[k - 1]![0], river.points[k]![1] - river.points[k - 1]![1]));
    const weirAlong = (river.weirs ?? []).map((w) => {
      let best = 0;
      let bd = Infinity;
      river.points.forEach((p, k) => {
        const d = Math.hypot(p[0] - w.at[0], p[1] - w.at[1]);
        if (d < bd) {
          bd = d;
          best = along[k]!;
        }
      });
      return { along: best, level: w.level };
    });
    const heldByWeir = (k: number): boolean => weirAlong.some((w) => w.level !== undefined && along[k]! <= w.along + 0.5 && Math.abs(river.surfaceY![k]! - w.level) < 0.3);
    const belowWeir = (k: number): boolean => weirAlong.some((w) => along[k]! > w.along && along[k]! < w.along + 40);
    const bank = river.bank;
    let run: { k0: number; k1: number; worst: number; table: number; lo: number; hi: number } | null = null;
    const flush = (): void => {
      if (!run) return;
      const [x0, z0] = river.points[run.k0]!;
      const [x1, z1] = river.points[run.k1]!;
      const len = along[run.k1]! - along[run.k0]!;
      if (len >= 8 && inArea(area, x0, z0)) {
        findings.push({
          kind: "river-under-fen", id: river.id, zone: zoneOf(x0, z0), x: r1(x0), z: r1(z0), toX: r1(x1), toZ: r1(z1), extent: Math.round(len),
          detail: `river ${r1(run.lo)}..${r1(run.hi)} beside marsh ${r1(run.table)} (up to ${r1(run.worst)} m under it) with no weir: add river.weirs at the fen's outlet`,
        });
      }
      run = null;
    };
    for (let k = 0; k < n; k++) {
      const [x, z] = river.points[k]!;
      const y = river.surfaceY[k]!;
      let table = -Infinity;
      if (k + 1 < n || k > 0) {
        const a = river.points[Math.max(0, k - 1)]!;
        const b = river.points[Math.min(n - 1, k + 1)]!;
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / l;
        const nz = (b[0] - a[0]) / l;
        const half = (river.widths && river.widths.length === n ? river.widths[k]! : river.width) / 2;
        for (const d of [half + bank * 0.9, half + bank * 1.3, half + bank + 15, half + bank + 30]) {
          for (const side of [-1, 1]) {
            const px = x + nx * d * side;
            const pz = z + nz * d * side;
            const t = field.marshTable(px, pz);
            // the sheet must really stand there: ground under the table (a wet pool), not a hummock
            if (t !== null && field.height(px, pz) < t - 0.05 && t > table) table = t;
          }
        }
      }
      const under = table > -Infinity ? table - y : 0;
      if (under > 0.5 && !heldByWeir(k) && !belowWeir(k) && !lakeAt(x, z)) {
        if (!run) run = { k0: k, k1: k, worst: under, table, lo: y, hi: y };
        run.k1 = k;
        run.worst = Math.max(run.worst, under);
        run.table = Math.max(run.table, table);
        run.lo = Math.min(run.lo, y);
        run.hi = Math.max(run.hi, y);
      } else if (run && along[k]! - along[run.k1]! > 30) flush(); // a probe missing the pools for a sample or two is the same run
    }
    flush();
    // flat reaches: the water level does not change at all over 300 m, and nothing holds it there
    let f0 = 0;
    const flatFlush = (k1: number): void => {
      const len = along[k1]! - along[f0]!;
      if (len > 300) {
        const mid = Math.floor((f0 + k1) / 2);
        const [mx, mz] = river.points[mid]!;
        const held = lakeAt(mx, mz) || heldByWeir(mid) || (field.marshTable(mx, mz) !== null && Math.abs(field.marshTable(mx, mz)! - river.surfaceY![mid]!) < 0.3);
        const [x0, z0] = river.points[f0]!;
        const [x1, z1] = river.points[k1]!;
        if (!held && inArea(area, x0, z0)) {
          findings.push({ kind: "flat-reach", id: river.id, zone: zoneOf(x0, z0), x: r1(x0), z: r1(z0), toX: r1(x1), toZ: r1(z1), extent: Math.round(len), detail: `water flat at ${r1(river.surfaceY![f0]!)} for ${Math.round(len)} m: no flow` });
        }
      }
    };
    for (let k = 1; k < n; k++) {
      if (Math.abs(river.surfaceY[k]! - river.surfaceY[f0]!) > 0.05) {
        flatFlush(k - 1);
        f0 = k;
      }
    }
    flatFlush(n - 1);
  }

  // ---- lakes: inflow without outflow, outlets above the lake
  for (const lake of recipe.features.lakes) {
    const outline: readonly (readonly [number, number])[] = lake.polygon ?? [lake.center];
    const reach = (lake.polygon ? 0 : lake.radius) + lake.bank + 24;
    const near = (x: number, z: number): boolean => {
      let d = Infinity;
      for (const p of outline) d = Math.min(d, Math.hypot(p[0] - x, p[1] - z));
      return d <= reach;
    };
    let inflow = 0;
    let outflow = 0;
    for (const river of field.rivers) {
      if (!river.water || !river.surfaceY) continue;
      const head = river.points[0]!;
      const mouth = river.points[river.points.length - 1]!;
      if (near(head[0], head[1])) {
        outflow++;
        if (river.surfaceY[0]! > lake.waterY + 0.3) {
          findings.push({ kind: "outlet-above-lake", id: `${lake.id}->${river.id}`, zone: zoneOf(head[0], head[1]), x: r1(head[0]), z: r1(head[1]), extent: 1, detail: `outlet water ${r1(river.surfaceY[0]!)} over lake ${r1(lake.waterY)}` });
        }
      }
      if (near(mouth[0], mouth[1])) inflow++;
      // a river passing through the lake (in and out) is both
      if (!near(head[0], head[1]) && !near(mouth[0], mouth[1]) && river.points.some((p) => near(p[0], p[1]))) {
        inflow++;
        outflow++;
      }
    }
    const [cx, cz] = lake.center;
    if (inflow > 0 && outflow === 0 && inArea(area, cx, cz) && !lake.id.startsWith("sink")) {
      findings.push({ kind: "lake-no-outlet", id: lake.id, zone: zoneOf(cx, cz), x: r1(cx), z: r1(cz), extent: 1, detail: `${inflow} river(s) in, none out, level ${r1(lake.waterY)}: give it an outlet river or a declared sink` });
    }
  }

  // ---- perched still sheets: a grid over the area (or the land bounds)
  const step = opts.step ?? 16;
  let box: [number, number, number, number];
  if (area.near) box = [area.near[0] - area.near[2], area.near[1] - area.near[2], area.near[0] + area.near[2], area.near[1] + area.near[2]];
  else if (area.rect) box = area.rect;
  else {
    const lim = recipe.bounds?.limit ?? 4000;
    box = [-lim, -lim, lim, lim];
  }
  const cells = new Map<string, { n: number; x: number; z: number; kind: string; y: number; lower: number; why: string }>();
  const t: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
  const u: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
  for (let z = box[1]; z <= box[3]; z += step) {
    for (let x = box[0]; x <= box[2]; x += step) {
      if (!inArea(area, x, z)) continue;
      if (!field.waterSurface(x, z, s) || (s.kind !== "lake" && s.kind !== "marsh")) continue;
      const y = s.y;
      const kind = s.kind;
      const g = field.height(x, z);
      if (g >= y || y <= recipe.seaLevel + 0.05) continue;
      for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
        const nx = x + dx;
        const nz = z + dz;
        const ng = field.height(nx, nz);
        if (ng >= y - 0.5) continue;
        // the lake's flood runs on a 4 m raster, this grid on 16 m: when the ground between the wet sample and the lower
        // dry one rises to the level, the sheet ends on that rim and the dry hollow beyond it is its own (2026-10-28)
        let rim = false;
        for (let k = 1; k < 4 && !rim; k++) if (field.height(x + (dx * k) / 4, z + (dz * k) / 4) >= y - 0.5) rim = true;
        if (rim) continue;
        const wet = field.waterSurface(nx, nz, t) && t.y > ng;
        const ny = wet ? t.y : -Infinity;
        // a river leaving or entering a lake runs a hair UNDER the lake by the rivers stage's own design
        // (surface = lake level - SURFACE x channel depth - 0.15: up to ~1.6 m for a 2 m channel); a 0.5 m tolerance
        // against river water failed every authored outlet and inflow on firstshore (2026-10-28)
        if (wet && ny >= y - (t.kind === "river" ? RIVER_HAIR : 0.5)) continue;
        // a steep outlet stream (its `runGrade` up to 18 %) loses more than the hair in 16 m: water that steps down
        // continuously from the sheet, each 4 m within the hair plus what the steepest run grade loses there
        // (OUTLET_STEP), is the river leaving the lake, not a sheet in the air
        if (wet && t.kind === "river") {
          let prev = y;
          let steps = true;
          for (let k = 1; k <= 4 && steps; k++) {
            if (!field.waterSurface(x + (dx * k) / 4, z + (dz * k) / 4, u) || prev - u.y > OUTLET_STEP) steps = false;
            else prev = u.y;
          }
          if (steps) continue;
        }
        // the lake ends AT a river (an outlet or inflow) within the hair or stepping down from it, and the dry sample
        // beyond is that river's far bank, standing over the river's water: the river holds the lake's edge, nothing
        // hangs (2026-10-29 w3-hydro, redstrand dogfood 2130 lake-1/lake-2, 2332 lake-2: lake 63.0 -> river 61.5 at
        // 4 m -> bank 62.1 at 16 m was read as "sheet 63 over dry ground 62.1")
        if (!wet) {
          let prev = y;
          let held = false;
          for (let k = 1; k < 4; k++) {
            const px = x + (dx * k) / 4;
            const pz = z + (dz * k) / 4;
            if (!field.waterSurface(px, pz, u)) break;
            if (u.kind === "lake" && u.y === y) continue;
            if (u.kind !== "river" || prev - u.y > OUTLET_STEP) break;
            if (u.y >= y - RIVER_HAIR || prev === y) { held = ng >= u.y - 0.1; break; }
            prev = u.y;
          }
          if (held) continue;
        }
        if (wet && t.kind === "river" && field.falls.some((f) => Math.hypot(f.x - nx, f.z - nz) < 40)) continue;
        // under the sea is the sea: a lagoon over its own beach is the coast's business
        if (ny > -Infinity && ny <= recipe.seaLevel + 0.05 && t.kind !== "river" && t.kind !== "lake" && t.kind !== "marsh") continue;
        const why = wet ? `over ${t.kind} water ${r1(ny)}` : `over dry ground ${r1(ng)} (ends in the air)`;
        const key = `${Math.floor(x / 64)},${Math.floor(z / 64)}:${kind}:${wet ? t.kind : "dry"}`;
        const c = cells.get(key);
        if (c) {
          c.n++;
          c.lower = Math.min(c.lower, wet ? ny : ng);
        } else cells.set(key, { n: 1, x, z, kind, y, lower: wet ? ny : ng, why });
        break;
      }
    }
  }
  for (const c of cells.values()) {
    findings.push({ kind: "perched-sheet", id: c.kind, zone: zoneOf(c.x, c.z), x: c.x, z: c.z, extent: c.n, detail: `${c.kind} sheet ${r1(c.y)} ${c.why}`, level: c.y, lower: c.lower });
  }
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  // flat reaches are reported, not failed: a level arm from a lake to a lip can be meant
  return { ok: findings.every((f) => NOTE_KINDS.has(f.kind)), findings, counts };
}

export interface WaterLogicHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  fail(message: string): never;
  writeRecipe?(recipe: WorldRecipe, file: string): void;
}

export function commandWaterLogic(host: WaterLogicHost): WaterLogicReport {
  const { argv } = host;
  const { recipe, file } = host.loadRecipe();
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const area: Area = {};
  const near = opt("near");
  if (near) {
    const v = near.split(",").map(Number);
    if (v.length !== 3 || !v.every(Number.isFinite)) host.fail("--near wants x,z,r");
    area.near = v as [number, number, number];
  }
  const rect = opt("rect");
  if (rect) {
    const v = rect.split(",").map(Number);
    if (v.length !== 4 || !v.every(Number.isFinite)) host.fail("--rect wants x0,z0,x1,z1");
    area.rect = v as [number, number, number, number];
  }
  const stamp = argv.includes("--stamp");
  if (stamp && (area.near || area.rect)) host.fail("--stamp sweeps the whole world; drop --near/--rect");
  const t0 = Date.now();
  const rep = waterLogic(recipe, { ...area, step: Number(opt("step") ?? 16) });
  if (argv.includes("--json")) console.log(JSON.stringify(rep, null, 1));
  else {
    console.log(`water-logic ${recipe.name}: ${rep.findings.length} finding(s) ${JSON.stringify(rep.counts)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const shown = argv.includes("--list") ? rep.findings : rep.findings.slice(0, 40);
    for (const f of shown) {
      const to = f.toX !== undefined ? ` -> ${f.toX},${f.toZ}` : "";
      console.log(`  ${f.kind} [${f.zone}] ${f.id} @ ${f.x},${f.z}${to}  ${f.extent}${f.kind === "perched-sheet" ? " cells" : f.kind.startsWith("lake") || f.kind.startsWith("outlet") ? "" : " m"}: ${f.detail}`);
    }
    if (shown.length < rep.findings.length) console.log(`  ... ${rep.findings.length - shown.length} more (--list)`);
    console.log(rep.ok ? "OK: rivers, lakes and marsh tables agree" : "FAIL: see docs/voxel-worlds.md \"Weirs: rivers held at a fen's level\"");
  }
  if (stamp && rep.ok && host.writeRecipe) {
    (recipe as any).pipeline = { ...((recipe as any).pipeline ?? {}), "water-logic": new Date().toISOString() };
    host.writeRecipe(recipe, file);
    console.log("  stamped stage water-logic");
  }
  if (!rep.ok) process.exitCode = 1;
  return rep;
}

/** A settled lake stands this much over the ground (or water) its edge leaked to: inside the perched rule's 0.5 m. */
export const LAKE_SETTLE_RISE = 0.3;
/** A settled lake stands at most this much over a river arriving under it (inside RIVER_HAIR). */
export const LAKE_INFLOW_HAIR = 1;

/**
 * The lakes whose sheets perch (`perched-sheet`, kind lake) and the level that would hold each: the lowest ground or
 * water its edge stands over + LAKE_SETTLE_RISE, never above its level less 0.1 m. `lakeBasin` maps a lake id to its
 * hydrology basin index; a lake with none (a hand-placed lake, a marsh pool: -1 / missing) is not settled. The rivers
 * stage settles lake levels after the rivers with it (2026-10-29 w3-hydro). A lake a river's solved water climbs into
 * by more than RIVER_HAIR is also settled: to the arrival + LAKE_INFLOW_HAIR. Measured on `field` (default: the world's
 * field without towns, roads and bridges, as the rivers stage samples it).
 */
export function lakeSettleLevels(
  recipe: WorldRecipe,
  lakeBasin: ReadonlyMap<string, number>,
  field: WorldField = createWorldField({ ...recipe, features: { ...recipe.features, towns: [], roads: [], bridges: [] } }),
): { lake: WorldRecipe["features"]["lakes"][number]; basin: number; level: number }[] {
  const rep = waterLogic(recipe, { field });
  const out = new Map<string, { lake: WorldRecipe["features"]["lakes"][number]; basin: number; level: number }>();
  for (const f of rep.findings) {
    if (f.kind !== "perched-sheet" || f.id !== "lake" || f.level === undefined || f.lower === undefined) continue;
    let lake: WorldRecipe["features"]["lakes"][number] | null = null;
    let best = Infinity;
    for (const l of recipe.features.lakes) {
      if (Math.abs(l.waterY - f.level) > 0.02) continue;
      const d = l.polygon && l.polygon.length >= 3 ? polyDistance(l.polygon, f.x, f.z) : Math.max(0, Math.hypot(f.x - l.center[0], f.z - l.center[1]) - l.radius);
      if (d < best) {
        best = d;
        lake = l;
      }
    }
    if (!lake) continue;
    const basin = lakeBasin.get(lake.id);
    if (basin === undefined || basin < 0) continue;
    const level = Math.min(lake.waterY - 0.1, f.lower + LAKE_SETTLE_RISE);
    const known = out.get(lake.id);
    if (!known || level < known.level) out.set(lake.id, { lake, basin, level });
  }
  // a river whose solved water CLIMBS more than the hair into a lake arrives under it: the lake's grid spill level
  // stands over the ground the river found (2026-10-29 w3-hydro, redstrand dogfood 3443 river-1: 54.25 -> lake-2 57.42).
  // The lake comes down to the arrival + LAKE_INFLOW_HAIR (the rivers audit's and this sweep's own hair)
  for (const r of field.rivers) {
    const lv = r.surfaceY && r.surfaceY.length === r.points.length ? r.surfaceY : r.bedY;
    if (!r.water || !lv || lv.length !== r.points.length) continue;
    for (let i = 0; i + 1 < lv.length; i++) {
      if (lv[i + 1]! - lv[i]! <= RIVER_HAIR) continue;
      const [x, z] = r.points[i + 1]!;
      let lake: WorldRecipe["features"]["lakes"][number] | null = null;
      for (const l of recipe.features.lakes) {
        if (Math.abs(l.waterY - lv[i + 1]!) > 0.05) continue;
        const d = l.polygon && l.polygon.length >= 3 ? polyDistance(l.polygon, x, z) : Math.max(0, Math.hypot(x - l.center[0], z - l.center[1]) - l.radius);
        if (d <= l.bank) lake = l;
      }
      if (!lake) continue;
      const basin = lakeBasin.get(lake.id);
      if (basin === undefined || basin < 0) continue;
      const level = Math.min(lake.waterY - 0.1, lv[i]! + LAKE_INFLOW_HAIR);
      const known = out.get(lake.id);
      if (!known || level < known.level) out.set(lake.id, { lake, basin, level });
    }
  }
  return [...out.values()];
}

/** Distance to a polygon (0 inside). */
function polyDistance(poly: readonly (readonly [number, number])[], x: number, z: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xi - xj;
    const dz = zi - zj;
    const l = dx * dx + dz * dz;
    const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - xj) * dx + (z - zj) * dz) / l));
    best = Math.min(best, Math.hypot(x - xj - dx * t, z - zj - dz * t));
  }
  return inside ? 0 : best;
}
