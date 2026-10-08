/**
 * Role noise for imported stamps: natural rock gets rough geometry, built work stays crisp.
 *
 * A project keeps its table as DATA (normally `authoring/noise.json`, embedded in the
 * mesh-stamp by `export_mesh_stamp(noise=...)` or passed to `convertMeshStamp` as
 * `options.noise`):
 *
 *   { "version": 1,
 *     "roles":   { "<key>": { amount, scale, octaves?, grow?, seed?, floor?, band? } | null, ... },
 *     "protect": [ { a, b?, radius, fade } | { min, max, fade }, ... ],   // stamp frame (Y up, entrance-relative)
 *     "floorCap": 0.06,
 *     "band": { above: 0.6, below: 0.2, fade: 0.4, cell: 0.5, minClear: 1 } | null }
 *
 * The FLOOR BAND (default on for every noised role except floor roles) fades a role's noise to zero
 * from `below` under to `above` over each walkable floor, so noised wall feet meet the floor clean and
 * vertical and the floor stays dressable. Floors come from the stamp's own exposed up-facing faces
 * (`floorGrid`); a role's `band: false` turns it off, `band: {...}` overrides the table's values.
 *
 * A solid's key is its object's `dc_noise` tag when the exporter recorded one
 * (`solidNoise`), else its palette roles: a solid touching ANY crisp role (no entry,
 * or null) stays crisp; otherwise it takes its gentlest role. Solids sharing a key
 * become one mesh node carrying that key's csg `noise`, so crisp roles keep exact
 * source normals and one volume per group still culls blocks.
 */

export const NOISE_LIMITS = { maxAmount: 1, floorCap: 0.06 };
/** Floor-band defaults: noise is zero from 0.2 m under to 0.6 m over each floor, back to full 0.4 m higher. */
export const BAND_DEFAULTS = { above: 0.6, below: 0.2, fade: 0.4, cell: 0.5, minClear: 1 };

function normaliseBand(band, where) {
  check(band && typeof band === "object", `${where} band must be an object, null or false`);
  const out = { ...BAND_DEFAULTS, ...band };
  for (const k of ["above", "below", "minClear"]) check(Number.isFinite(out[k]) && out[k] >= 0 && out[k] <= 4, `${where} band.${k} must be 0..4 m`);
  for (const k of ["fade", "cell"]) check(Number.isFinite(out[k]) && out[k] > 0 && out[k] <= 4, `${where} band.${k} must be > 0 and <= 4 m`);
  return out;
}

function check(cond, message) { if (!cond) throw new Error(`Role noise: ${message}`); }

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

/** Validate a project noise table; returns a normalised copy. */
export function normaliseNoiseTable(table) {
  if (table === undefined || table === null) return null;
  check(typeof table === "object" && table.version === 1, "table must be { version: 1, roles, protect? }");
  check(table.roles && typeof table.roles === "object", "table needs a roles object");
  const floorCap = table.floorCap ?? NOISE_LIMITS.floorCap;
  check(Number.isFinite(floorCap) && floorCap >= 0 && floorCap <= 0.2, "floorCap must be 0..0.2 m");
  const tableBand = table.band === null || table.band === false ? null : normaliseBand(table.band ?? {}, "table");
  const roles = {};
  for (const [key, spec] of Object.entries(table.roles)) {
    if (spec === null || spec === false) { roles[key] = null; continue; }
    check(spec && typeof spec === "object", `role ${key} must be an object or null`);
    check(Number.isFinite(spec.amount) && spec.amount >= 0 && spec.amount <= NOISE_LIMITS.maxAmount, `role ${key} amount must be 0..${NOISE_LIMITS.maxAmount} m`);
    check(Number.isFinite(spec.scale) && spec.scale > 0, `role ${key} needs a positive scale (m)`);
    if (spec.octaves !== undefined) check(Number.isInteger(spec.octaves) && spec.octaves >= 1 && spec.octaves <= 5, `role ${key} octaves must be 1..5`);
    const amount = spec.floor ? Math.min(spec.amount, floorCap) : spec.amount;
    // floor roles ARE the floor: no band. Otherwise the table's band unless the role turns it off or overrides it.
    const band = spec.floor || spec.band === false || spec.band === null ? null
      : spec.band ? normaliseBand({ ...(tableBand ?? {}), ...spec.band }, `role ${key}`) : tableBand;
    roles[key] = amount > 0 ? { amount, scale: spec.scale, ...(spec.octaves ? { octaves: spec.octaves } : {}), grow: spec.grow !== false, ...(Number.isInteger(spec.seed) ? { seed: spec.seed } : {}), ...(band ? { band } : {}) } : null;
  }
  const protect = (table.protect ?? []).map((z, i) => {
    const v3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
    if ("a" in z) {
      check(v3(z.a) && (z.b === undefined || v3(z.b)), `protect[${i}] capsule needs a (and optional b) as [x,y,z]`);
      return { a: z.a, ...(z.b ? { b: z.b } : {}), radius: z.radius ?? 0, fade: z.fade ?? 1 };
    }
    check(v3(z.min) && v3(z.max), `protect[${i}] needs a/b or min/max`);
    return { min: z.min, max: z.max, fade: z.fade ?? 1 };
  });
  return { version: 1, roles, protect, floorCap, band: tableBand };
}

/**
 * Walkable floors of a stamp on an X/Z grid: up-facing faces (normal y >= 0.6) with at least `minClear` of
 * headroom (no down-facing face from just under the floor up to minClear above it, so a solid's top buried
 * under another solid is not a floor). Returns { origin:[x,z], cell, columns, rows, spans } where each cell
 * holds flat [lo, hi, ...] height ranges. Same frame as the stamp (and its mesh nodes).
 */
export function floorGrid(meshes, { cell = BAND_DEFAULTS.cell, minClear = BAND_DEFAULTS.minClear, minNy = 0.6 } = {}) {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) {
    lo[0] = Math.min(lo[0], m.positions[i]); hi[0] = Math.max(hi[0], m.positions[i]);
    lo[1] = Math.min(lo[1], m.positions[i + 2]); hi[1] = Math.max(hi[1], m.positions[i + 2]);
  }
  const origin = [Math.floor(lo[0] / cell) * cell, Math.floor(lo[1] / cell) * cell];
  const columns = Math.max(1, Math.ceil((hi[0] - origin[0]) / cell) + 1), rows = Math.max(1, Math.ceil((hi[1] - origin[1]) / cell) + 1);
  const ups = new Map(), downs = new Map();
  // separating-axis overlap of a triangle and an axis-aligned cell, in plan
  const overlaps = (t, x0, z0) => {
    const xs = [t[0], t[3], t[6]], zs = [t[2], t[5], t[8]], cx = [x0, x0 + cell, x0 + cell, x0], cz = [z0, z0, z0 + cell, z0 + cell];
    for (let e = 0; e < 3; e++) {
      const ax = -(zs[(e + 1) % 3] - zs[e]), az = xs[(e + 1) % 3] - xs[e];
      let tmin = Infinity, tmax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let v = 0; v < 3; v++) { const d = ax * xs[v] + az * zs[v]; tmin = Math.min(tmin, d); tmax = Math.max(tmax, d); }
      for (let v = 0; v < 4; v++) { const d = ax * cx[v] + az * cz[v]; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
      if (tmax < bmin - 1e-9 || bmax < tmin - 1e-9) return false;
    }
    return true;
  };
  for (const m of meshes) {
    const P = m.positions, I = m.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 0)) continue;
      const up = ny / len >= minNy, down = ny / len <= -0.3;
      if (!up && !down) continue;
      const tri = [P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]];
      const ymin = Math.min(tri[1], tri[4], tri[7]), ymax = Math.max(tri[1], tri[4], tri[7]);
      const i0 = Math.max(0, Math.floor((Math.min(tri[0], tri[3], tri[6]) - origin[0]) / cell)), i1 = Math.min(columns - 1, Math.floor((Math.max(tri[0], tri[3], tri[6]) - origin[0]) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(tri[2], tri[5], tri[8]) - origin[1]) / cell)), j1 = Math.min(rows - 1, Math.floor((Math.max(tri[2], tri[5], tri[8]) - origin[1]) / cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x0 = origin[0] + i * cell, z0 = origin[1] + j * cell;
        if (!overlaps(tri, x0, z0)) continue;
        // plane height over the cell's corners, clamped to the triangle's own height range
        let l = Infinity, h = -Infinity;
        for (const [x, z] of [[x0, z0], [x0 + cell, z0], [x0, z0 + cell], [x0 + cell, z0 + cell]]) {
          const y = tri[1] - (nx * (x - tri[0]) + nz * (z - tri[2])) / ny;
          l = Math.min(l, y); h = Math.max(h, y);
        }
        l = Math.max(ymin, Math.min(ymax, l)); h = Math.max(ymin, Math.min(ymax, h));
        const map = up ? ups : downs, k = j * columns + i;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(up ? [l, h] : l);
      }
    }
  }
  const spans = new Array(columns * rows);
  for (let k = 0; k < spans.length; k++) {
    const ceilings = downs.get(k) ?? [];
    const keep = (ups.get(k) ?? []).filter(([l, h]) => !ceilings.some((c) => c >= l - 0.02 && c <= h + minClear));
    spans[k] = mergeSpans(keep.flat());
  }
  return { origin, cell, columns, rows, spans };
}

function mergeSpans(flat, gap = 0.05) {
  const pairs = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
  pairs.sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [l, h] of pairs) {
    if (out.length && l <= out[out.length - 1] + gap) out[out.length - 1] = Math.max(out[out.length - 1], h);
    else out.push(l, h);
  }
  return out;
}

/** The floor band zone for one noised node: the grid cropped to the node's reach and dilated past each floor's edge. */
function bandZone(grid, band, amount, lo, hi) {
  const { cell } = grid;
  const reach = amount + 0.5;                                   // the farthest sample the noise can move a surface from
  const dil = Math.ceil(reach / cell) + 1;
  const i0 = Math.max(0, Math.floor((lo[0] - reach - grid.origin[0]) / cell) - 1), i1 = Math.min(grid.columns - 1, Math.floor((hi[0] + reach - grid.origin[0]) / cell) + 1);
  const j0 = Math.max(0, Math.floor((lo[2] - reach - grid.origin[1]) / cell) - 1), j1 = Math.min(grid.rows - 1, Math.floor((hi[2] + reach - grid.origin[1]) / cell) + 1);
  if (i1 < i0 || j1 < j0) return null;
  const columns = i1 - i0 + 1, rows = j1 - j0 + 1, spans = [];
  let any = false;
  const r2 = (v, f) => Math[f](v * 100) / 100;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const flat = [];
    for (let dj = -dil; dj <= dil; dj++) for (let di = -dil; di <= dil; di++) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= grid.columns || nj >= grid.rows) continue;
      const sp = grid.spans[nj * grid.columns + ni];
      for (let q = 0; q < sp.length; q++) flat.push(sp[q]);
    }
    const merged = mergeSpans(flat).map((v, k) => r2(v, k % 2 ? "ceil" : "floor"));
    if (merged.length) any = true;
    spans.push(merged);
  }
  if (!any) return null;
  return { floors: { origin: [+(grid.origin[0] + i0 * cell).toFixed(4), +(grid.origin[1] + j0 * cell).toFixed(4)], cell, columns, rows, spans }, above: band.above, below: band.below, fade: band.fade };
}

/**
 * Split one exported group into crisp + per-key noised mesh nodes.
 * Returns { nodes, report, maxAmount }. Without a table the single crisp node is the old output.
 */
export function roleNoiseNodes(mesh, palette, table, groupName, floors = null) {
  const whole = { positions: [...mesh.positions], indices: [...mesh.indices] };
  if (mesh.solidTriangleCounts !== undefined) whole.solidTriangleCounts = structuredClone(mesh.solidTriangleCounts);
  if (mesh.triangleMaterials !== undefined) whole.triangleMaterials = [...mesh.triangleMaterials];
  const crispOnly = { nodes: [{ id: "imported-mesh", op: "add", shape: "mesh", position: [0, 0, 0], mesh: whole }], report: [], maxAmount: 0 };
  if (!table) return crispOnly;
  check(Array.isArray(mesh.solidTriangleCounts), `group ${groupName} has no solidTriangleCounts; re-export with tools/mesh-dc/export_blender.py`);
  const tags = mesh.solidNoise;
  check(tags === undefined || (Array.isArray(tags) && tags.length === mesh.solidTriangleCounts.length), `group ${groupName} solidNoise must list one key (or null) per solid`);
  const buckets = new Map(); // key -> { spec, solids: [triStart, triCount][] }
  let tri = 0;
  mesh.solidTriangleCounts.forEach((count, s) => {
    let key = null;
    const tag = tags?.[s];
    if (typeof tag === "string" && tag) {
      check(tag in table.roles, `group ${groupName}: dc_noise tag "${tag}" is not in the table (add it, or null for crisp)`);
      key = table.roles[tag] ? tag : null;
    } else {
      const roles = new Set();
      for (let t = tri; t < tri + count; t++) roles.add(palette[mesh.triangleMaterials?.[t] ?? 0]?.id);
      let best = null;
      for (const role of roles) {
        const spec = table.roles[role];
        if (!spec) { best = null; break; }
        if (!best || spec.amount < table.roles[best].amount) best = role;
      }
      key = best;
    }
    const k = key ?? "";
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push([tri, count]);
    tri += count;
  });
  check(tri * 3 === mesh.indices.length, `group ${groupName} solidTriangleCounts do not add up to its triangles`);
  const nodes = [], report = [];
  let maxAmount = 0;
  // Crisp first (stable id), then noised keys in table order.
  const order = ["", ...Object.keys(table.roles)].filter((k, i, a) => buckets.has(k) && a.indexOf(k) === i);
  for (const key of order) {
    const solids = buckets.get(key);
    const remap = new Map(), positions = [], indices = [], solidTriangleCounts = [], triangleMaterials = [];
    for (const [start, count] of solids) {
      solidTriangleCounts.push(count);
      for (let t = start; t < start + count; t++) {
        for (let c = 0; c < 3; c++) {
          const v = mesh.indices[t * 3 + c];
          let m = remap.get(v);
          if (m === undefined) { m = positions.length / 3; remap.set(v, m); positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]); }
          indices.push(m);
        }
        if (mesh.triangleMaterials) triangleMaterials.push(mesh.triangleMaterials[t]);
      }
    }
    const meshData = { positions, indices, solidTriangleCounts, ...(mesh.triangleMaterials ? { triangleMaterials } : {}) };
    const node = { id: key ? `noise-${key.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}` : "imported-mesh", op: "add", shape: "mesh", position: [0, 0, 0], mesh: meshData };
    const spec = key ? table.roles[key] : null;
    if (spec) {
      node.noise = { amount: spec.amount, scale: spec.scale, seed: spec.seed ?? hash(`${groupName}/${key}`), ...(spec.octaves ? { octaves: spec.octaves } : {}), ...(spec.grow ? { grow: true } : {}) };
      // Only the zones that can reach this node's solids (keeps volume files small; the engine filters again).
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], positions[i]); hi[i % 3] = Math.max(hi[i % 3], positions[i]); }
      const near = table.protect.filter((z) => {
        const reach = ("a" in z ? z.radius : 0) + z.fade + spec.amount;
        const zlo = "a" in z ? [0, 1, 2].map((k) => Math.min(z.a[k], (z.b ?? z.a)[k])) : z.min;
        const zhi = "a" in z ? [0, 1, 2].map((k) => Math.max(z.a[k], (z.b ?? z.a)[k])) : z.max;
        return [0, 1, 2].every((k) => zlo[k] - reach <= hi[k] && zhi[k] + reach >= lo[k]);
      });
      if (spec.band) {
        check(floors, `group ${groupName}: role ${key} has a floor band but no floor grid was given (convertMeshStamp passes floorGrid(source.meshes))`);
        const zone = bandZone(floors, spec.band, spec.amount, lo, hi);
        if (zone) near.push(zone);
      }
      if (near.length) node.noise.protect = near;
      maxAmount = Math.max(maxAmount, spec.amount);
    }
    nodes.push(node);
    report.push({ key: key || null, solids: solids.length, triangles: indices.length / 3, noise: spec ? { amount: spec.amount, scale: spec.scale, octaves: spec.octaves ?? 2, grow: !!spec.grow, band: spec.band ? { above: spec.band.above, below: spec.band.below, fade: spec.band.fade } : null } : null });
  }
  return { nodes, report, maxAmount };
}

/**
 * Walk-lane protection along a route: capsules following the walkable floor.
 * `route` is a list of [x, z] stamp-frame points (Y up). Floor heights come from the
 * stamp's own up-facing triangles, choosing at each 0.5 m sample the floor nearest the
 * previous one (so stacked levels resolve by continuity from `startY`). Consecutive
 * samples merge into one capsule while they stay within `tolerance` of a straight line.
 */
export function routeProtect(source, route, { startY = 0, height = 1.2, radius = 0.7, fade = 1.2, step = 0.5, maxRise = 0.9, tolerance = 0.15 } = {}) {
  check(Array.isArray(route) && route.length >= 2, "route needs at least two [x, z] points");
  const cell = 2, grid = new Map();
  for (const mesh of source.meshes) {
    const P = mesh.positions, I = mesh.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 0) || ny / len < 0.6) continue;
      const tri = [P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]];
      const x0 = Math.floor(Math.min(tri[0], tri[3], tri[6]) / cell), x1 = Math.floor(Math.max(tri[0], tri[3], tri[6]) / cell);
      const z0 = Math.floor(Math.min(tri[2], tri[5], tri[8]) / cell), z1 = Math.floor(Math.max(tri[2], tri[5], tri[8]) / cell);
      for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) { const key = `${i},${k}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(tri); }
    }
  }
  const floorsAt = (x, z) => {
    const out = [];
    for (const t of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      const d = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d;
      const l2 = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      out.push(l1 * t[1] + l2 * t[4] + l3 * t[7]);
    }
    return out;
  };
  const samples = [];
  let y = startY;
  for (let i = 0; i + 1 < route.length; i++) {
    const [ax, az] = route[i], [bx, bz] = route[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let s = i ? 1 : 0; s <= n; s++) {
      const x = ax + ((bx - ax) * s) / n, z = az + ((bz - az) * s) / n;
      const ok = floorsAt(x, z).filter((f) => f <= y + maxRise);
      if (ok.length) y = ok.reduce((best, f) => (Math.abs(f - y) < Math.abs(best - y) ? f : best));
      samples.push([x, y + height, z]);
    }
  }
  const zones = [];
  let start = 0;
  const offLine = (a, b, p) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    const t = dd ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / dd)) : 0;
    return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2]);
  };
  for (let end = 2; end <= samples.length; end++) {
    const last = end === samples.length;
    let fits = !last;
    if (fits) for (let k = start + 1; k < end; k++) if (offLine(samples[start], samples[end], samples[k]) > tolerance) { fits = false; break; }
    if (!fits) {
      const stop = last ? end - 1 : end - 1;
      zones.push({ a: samples[start].map((v) => +v.toFixed(3)), b: samples[stop].map((v) => +v.toFixed(3)), radius, fade });
      start = stop;
    }
  }
  return zones;
}

/** A box over an opening: floor-centre [x, y, z], clear width and height (orientation-free, square in plan). */
export function openingProtect(center, width, height, { margin = 0.3, fade = 1 } = {}) {
  const h = width / 2 + margin;
  return { min: [center[0] - h, center[1] - 0.1, center[2] - h], max: [center[0] + h, center[1] + height + margin, center[2] + h], fade };
}
