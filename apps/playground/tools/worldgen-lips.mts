/**
 * `worldgen lips <world> [--near x,z,r] [--list] [--json] [--allow id,id]`
 * `worldgen seated <world> --slab x,z,halfX,halfZ,yawDeg,baseY [--slab ...] | --slabs <file.json>`
 *
 * LIPS — the lip / sawtooth gate. The terrain is drawn from the field sampled
 * on the 2 m voxel lattice, so any height change an EDIT makes that is
 * narrower than the lattice comes out as teeth (a diagonal patch edge), a
 * wall (a deep path cut with a narrow shoulder) or a one-sample rim. This
 * measures exactly that, on the edited world against the same world without
 * its height patches and graded roads (`measureTerrainLips` in core), only in
 * the bands where those edits meet the ground:
 *
 *  - every height patch: its whole raster and 6 m beyond its edge;
 *  - along every graded road (flatten > 0 with a surface): out to its reach.
 *
 * Faults are attributed to the nearest patch / road and the command exits 1
 * when any are found (an `--allow`ed id is reported, not failed). Thresholds:
 * `--alias 0.5` (m the drawn ground misses the field by), `--max-slope 1.6`
 * (rise/run between lattice samples), `--lip 0.75` (one-sample rim/slot, m).
 *
 * SEATED — is a built slab (a wall, a platform, a foundation) sitting on the
 * DRAWN ground? Samples the lattice-reconstructed ground along each slab's
 * footprint and reports `gap` (base over the ground: it hangs) and `clip`
 * (ground over the base: the terrain shows through). Exit 1 above
 * `--gap 0.25` / `--clip 0.6`.
 *
 * See docs/voxel-worlds.md "Height-patch edges".
 */
import fs from "node:fs";
import {
  createWorldField,
  measureTerrainLips,
  seatReport,
  type TerrainLipFault,
  type WorldRecipe,
} from "@hitreg/core";

export interface LipsHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  fail(message: string): never;
}

interface Owner {
  kind: "patch" | "road";
  id: string;
  /** distance from (x, z) to this owner's edge band, <= 0 inside the band */
  band(x: number, z: number): number;
  box: [number, number, number, number];
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function owners(recipe: WorldRecipe): Owner[] {
  const out: Owner[] = [];
  for (const p of recipe.features.heightPatches) {
    const [x0, z0] = p.origin, x1 = x0 + p.size[0], z1 = z0 + p.size[1];
    out.push({
      kind: "patch",
      id: p.id,
      box: [x0 - 6, z0 - 6, x1 + 6, z1 + 6],
      band: (x, z) => {
        // the whole raster (a terrace edge drawn into it is an edge too) and 6 m beyond
        const inside = x > x0 && z > z0 && x < x1 && z < z1;
        return inside ? -Math.min(x - x0, z - z0, x1 - x, z1 - z) : Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)) - 6;
      },
    });
  }
  for (const r of recipe.features.roads) {
    if (!(r.flatten > 0) || !r.surfaceY) continue;
    const reach = r.width / 2 + r.shoulder + r.smooth + 4;
    // one owner per run of segments no longer than ~48 m: a long road's
    // bounding box is mostly ground it never touches
    let start = 0;
    while (start + 1 < r.points.length) {
      let end = start + 1, len = 0;
      while (end < r.points.length) {
        len += Math.hypot(r.points[end]![0] - r.points[end - 1]![0], r.points[end]![1] - r.points[end - 1]![1]);
        if (len >= 48) break;
        end++;
      }
      end = Math.min(end, r.points.length - 1);
      const pts = r.points.slice(start, end + 1);
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
      for (const [x, z] of pts) { bx0 = Math.min(bx0, x); bz0 = Math.min(bz0, z); bx1 = Math.max(bx1, x); bz1 = Math.max(bz1, z); }
      out.push({
        kind: "road",
        id: r.id,
        box: [bx0 - reach, bz0 - reach, bx1 + reach, bz1 + reach],
        band: (x, z) => {
          let d = Infinity;
          for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(x, z, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]));
          return d - reach;
        },
      });
      start = end;
    }
  }
  return out;
}

const num = (argv: string[], name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(argv[i + 1]) : dflt;
  return Number.isFinite(v) ? v : dflt;
};
const str = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

export interface LipsResult {
  ok: boolean;
  owners: { kind: string; id: string; alias: number; step: number; lip: number; worst: number; run: number; allowed: boolean }[];
  totals: { alias: number; step: number; lip: number; cells: number; touched: number };
}

/** The gate as a function, so installers and `zonegen status` can call it in-process. */
export function runLipsGate(recipe: WorldRecipe, opts: { near?: [number, number, number]; aliasTol?: number; maxSlope?: number; lipTol?: number; allow?: string[] } = {}): LipsResult & { faults: (TerrainLipFault & { owner: string })[] } {
  const field = createWorldField(recipe);
  const reference = createWorldField({ ...recipe, features: { ...recipe.features, heightPatches: [], roads: [] } });
  let list = owners(recipe);
  if (opts.near) {
    const [nx, nz, nr] = opts.near;
    list = list.filter((o) => o.box[0] < nx + nr && o.box[2] > nx - nr && o.box[1] < nz + nr && o.box[3] > nz - nr);
  }
  const allow = new Set(opts.allow ?? []);
  const rows: LipsResult["owners"] = [];
  const all: (TerrainLipFault & { owner: string })[] = [];
  const totals = { alias: 0, step: 0, lip: 0, cells: 0, touched: 0 };
  // measured owner by owner; a cell in two bands is attributed to the nearer one
  for (const o of list) {
    let [x0, z0, x1, z1] = o.box;
    if (opts.near) {
      const [nx, nz, nr] = opts.near;
      x0 = Math.max(x0, nx - nr); z0 = Math.max(z0, nz - nr); x1 = Math.min(x1, nx + nr); z1 = Math.min(z1, nz + nr);
    }
    if (x1 <= x0 || z1 <= z0) continue;
    const others = list.filter((q) => q !== o && q.box[0] < x1 && q.box[2] > x0 && q.box[1] < z1 && q.box[3] > z0);
    const rep = measureTerrainLips(field, reference, {
      x0, z0, x1, z1,
      aliasTol: opts.aliasTol, maxSlope: opts.maxSlope, lipTol: opts.lipTol,
      include: (x, z) => {
        const mine = o.band(x, z);
        if (mine > 0) return false;
        for (const q of others) if (q.band(x, z) < mine) return false;
        return true;
      },
    });
    totals.cells += rep.cells;
    totals.touched += rep.touchedCells;
    const worst = Math.max(rep.worst.alias, rep.worst.step, rep.worst.lip);
    const n = rep.counts.alias + rep.counts.step + rep.counts.lip;
    if (n > 0) {
      const row = rows.find((q) => q.id === o.id && q.kind === o.kind);
      if (row) { row.alias += rep.counts.alias; row.step += rep.counts.step; row.lip += rep.counts.lip; row.worst = Math.max(row.worst, worst); row.run = Math.max(row.run, rep.longestRun); }
      else rows.push({ kind: o.kind, id: o.id, alias: rep.counts.alias, step: rep.counts.step, lip: rep.counts.lip, worst, run: rep.longestRun, allowed: allow.has(o.id) });
      if (!allow.has(o.id)) { totals.alias += rep.counts.alias; totals.step += rep.counts.step; totals.lip += rep.counts.lip; }
      for (const f of rep.faults) all.push({ ...f, owner: o.id });
    }
  }
  rows.sort((a, b) => b.alias + b.step + b.lip - (a.alias + a.step + a.lip));
  return { ok: totals.alias + totals.step + totals.lip === 0, owners: rows, totals, faults: all };
}

export function commandLips(host: LipsHost): void {
  const { argv } = host;
  const { recipe } = host.loadRecipe();
  const nearArg = str(argv, "near");
  let near: [number, number, number] | undefined;
  if (nearArg) {
    near = nearArg.split(",").map(Number) as [number, number, number];
    if (near.length !== 3 || !near.every(Number.isFinite)) host.fail("--near wants x,z,r");
  }
  const allow = (str(argv, "allow") ?? "").split(",").filter(Boolean);
  const t0 = Date.now();
  const res = runLipsGate(recipe, { near, aliasTol: num(argv, "alias", 0.5), maxSlope: num(argv, "max-slope", 1.6), lipTol: num(argv, "lip", 0.75), allow });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ok: res.ok, totals: res.totals, owners: res.owners }, null, 1));
  } else {
    console.log(`lips ${recipe.name}${near ? ` near ${near.join(",")}` : ""}: ${res.totals.touched}/${res.totals.cells} edited lattice cells in edge bands, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    console.log(`  alias (sawtooth) ${res.totals.alias}   step (wall) ${res.totals.step}   lip (rim/slot) ${res.totals.lip}`);
    for (const r of res.owners.slice(0, argv.includes("--list") ? Infinity : 25)) {
      console.log(`  ${r.allowed ? "allowed " : ""}${r.kind} ${r.id}: alias ${r.alias}, step ${r.step}, lip ${r.lip}; worst ${r.worst.toFixed(2)} m; longest run ${r.run} cells`);
    }
    if (argv.includes("--list")) {
      for (const f of [...res.faults].sort((a, b) => b.size - a.size).slice(0, 200)) console.log(`    ${f.kind} ${f.owner} @ ${f.x.toFixed(0)},${f.z.toFixed(0)}  ${f.size} m`);
    }
    console.log(res.ok ? "OK: no edit draws sharper than the lattice" : "FAIL: widen the patch feather / lower edgeSlope, set a road maxCut or a wider shoulder; see docs/voxel-worlds.md \"Height-patch edges\"");
  }
  if (!res.ok) process.exitCode = 1;
}

export function commandSeated(host: LipsHost): void {
  const { argv } = host;
  const { recipe } = host.loadRecipe();
  const slabs: { id?: string; x: number; z: number; halfX: number; halfZ: number; yaw?: number; baseY: number }[] = [];
  const file = str(argv, "slabs");
  if (file) slabs.push(...JSON.parse(fs.readFileSync(file, "utf8")));
  argv.forEach((a, i) => {
    if (a !== "--slab") return;
    const v = (argv[i + 1] ?? "").split(",").map(Number);
    if (v.length !== 6 || !v.every(Number.isFinite)) host.fail("--slab wants x,z,halfX,halfZ,yawDeg,baseY");
    slabs.push({ id: `slab${slabs.length}`, x: v[0]!, z: v[1]!, halfX: v[2]!, halfZ: v[3]!, yaw: (v[4]! * Math.PI) / 180, baseY: v[5]! });
  });
  if (!slabs.length) host.fail("give --slab x,z,halfX,halfZ,yawDeg,baseY (repeatable) or --slabs <file.json> ([{id,x,z,halfX,halfZ,yaw(rad),baseY}])");
  const field = createWorldField(recipe);
  const maxGap = num(argv, "gap", 0.25), maxClip = num(argv, "clip", 0.6);
  let bad = 0;
  for (const s of slabs) {
    const r = seatReport(field, s);
    const fail = r.gap > maxGap || r.clip > maxClip;
    if (fail) bad++;
    console.log(`  ${fail ? "FAIL" : "ok  "} ${s.id ?? ""} @ ${s.x.toFixed(1)},${s.z.toFixed(1)}: gap ${r.gap} m, clip ${r.clip} m`);
  }
  console.log(bad ? `FAIL: ${bad}/${slabs.length} slabs not seated (gap > ${maxGap} m or clip > ${maxClip} m)` : `OK: ${slabs.length} slabs seated`);
  if (bad) process.exitCode = 1;
}
