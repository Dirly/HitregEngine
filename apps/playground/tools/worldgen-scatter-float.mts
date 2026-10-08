/**
 * `worldgen scatter-float <world> [--near x,z,r] [--list] [--cover-step 1]`
 *
 * Does any plant hang in the air? Solves real cells exactly as the chunk
 * builder does (`scatterCell`, the shared placement), asks the ground-cover
 * sampler the editor and the runtime use (`voxelGroundProbes`), and measures
 * every instance against the TERRAIN MESH of its cell — the triangles that are
 * drawn and that the trimesh collider is built from, not the field's analytic
 * height. Two faults are counted:
 *
 *  - FLOAT: the base stands more than `--tol` (0.35 m) above the surface under
 *    its own point (or there is no surface under it at all);
 *  - OPEN:  somewhere on the instance's footing ring (trunk radius for a prop,
 *    the card half-width for cover) the ground drops away by more than the
 *    slope can explain — the edge of a cave mouth, a cutting, an overhang.
 *
 * Without `--near` it samples the cells every terrain EDIT touches (passages,
 * tunnels, subtracting blobs, height patches), which is where the fault lives.
 * Exits 1 when anything is found. See docs/voxel-worlds.md "Scatter".
 */
import {
  buildVoxelMesh,
  createWorldField,
  editedGround,
  scatterCell,
  scatterFooting,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { voxelGroundProbes } from "../src/voxel-ground.ts";

export interface ScatterFloatHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  fail(message: string): never;
}

/** Vertical ray hits against one cell's terrain mesh, bucketed by 1 m columns. */
interface CellSurface {
  hits(x: number, z: number): number[];
}

function cellSurface(field: WorldField, cx: number, cz: number): CellSurface {
  const mesh = buildVoxelMesh(field, { kind: "voxel", world: field.recipe.name, cell: [cx, cz] });
  const size = field.recipe.cellSize;
  const x0 = cx * size;
  const z0 = cz * size;
  const n = Math.ceil(size);
  const buckets: number[][] = Array.from({ length: n * n }, () => []);
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
    const minX = Math.max(0, Math.floor(Math.min(p[a]!, p[b]!, p[c]!)));
    const maxX = Math.min(n - 1, Math.floor(Math.max(p[a]!, p[b]!, p[c]!)));
    const minZ = Math.max(0, Math.floor(Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!)));
    const maxZ = Math.min(n - 1, Math.floor(Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!)));
    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) buckets[x + z * n]!.push(t);
  }
  return {
    hits(wx, wz) {
      const lx = wx - x0, lz = wz - z0;
      const bx = Math.floor(lx), bz = Math.floor(lz);
      if (bx < 0 || bz < 0 || bx >= n || bz >= n) return [];
      const out: number[] = [];
      for (const t of buckets[bx + bz * n]!) {
        const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
        const ax = p[a]!, az = p[a + 2]!, bxp = p[b]!, bzp = p[b + 2]!, cxp = p[c]!, czp = p[c + 2]!;
        const d = (bzp - czp) * (ax - cxp) + (cxp - bxp) * (az - czp);
        if (Math.abs(d) < 1e-9) continue; // vertical (a skirt or a wall seen edge-on)
        const u = ((bzp - czp) * (lx - cxp) + (cxp - bxp) * (lz - czp)) / d;
        const v = ((czp - az) * (lx - cxp) + (ax - cxp) * (lz - czp)) / d;
        const w = 1 - u - v;
        if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
        out.push(u * p[a + 1]! + v * p[b + 1]! + w * p[c + 1]!);
      }
      return out;
    },
  };
}

export function commandScatterFloat(host: ScatterFloatHost): void {
  const { argv } = host;
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const tol = Number(opt("tol") ?? 0.35);
  const list = argv.includes("--list");
  const coverStep = Number(opt("cover-step") ?? 1);
  const maxCells = Number(opt("max-cells") ?? 400);
  const skipCover = argv.includes("--no-cover");
  const { recipe } = host.loadRecipe();
  const field = createWorldField(recipe);
  const size = recipe.cellSize;

  // ---- which cells
  const cells = new Map<string, [number, number]>();
  const addRect = (x0: number, z0: number, x1: number, z1: number): void => {
    for (let cz = Math.floor(z0 / size); cz <= Math.floor(z1 / size); cz++)
      for (let cx = Math.floor(x0 / size); cx <= Math.floor(x1 / size); cx++) cells.set(`${cx},${cz}`, [cx, cz]);
  };
  const near = opt("near");
  if (near) {
    const [x, z, r] = near.split(",").map(Number) as [number, number, number];
    if (![x, z, r].every(Number.isFinite)) host.fail("--near wants x,z,r");
    addRect(x - r, z - r, x + r, z + r);
  } else {
    const f = recipe.features;
    for (const p of f.passages) {
      const end = p.start[p.axis === "x" ? 0 : 2] + p.direction * p.length;
      const half = p.width / 2 + 6;
      if (p.axis === "x") addRect(Math.min(p.start[0], end) - 6, p.start[2] - half, Math.max(p.start[0], end) + 6, p.start[2] + half);
      else addRect(p.start[0] - half, Math.min(p.start[2], end) - 6, p.start[0] + half, Math.max(p.start[2], end) + 6);
    }
    for (const t of f.tunnels) for (const q of t.points) addRect(q[0] - t.radius - 4, q[2] - t.radius - 4, q[0] + t.radius + 4, q[2] + t.radius + 4);
    for (const b of f.blobs) if (b.op !== "add") addRect(b.center[0] - b.radius * b.scaleX - 4, b.center[2] - b.radius * b.scaleZ - 4, b.center[0] + b.radius * b.scaleX + 4, b.center[2] + b.radius * b.scaleZ + 4);
    for (const h of f.heightPatches) addRect(h.origin[0], h.origin[1], h.origin[0] + h.size[0], h.origin[1] + h.size[1]);
  }
  let chosen = [...cells.values()];
  if (field.worldLimit !== Infinity) chosen = chosen.filter(([cx, cz]) => Math.hypot((cx + 0.5) * size, (cz + 0.5) * size) < field.worldLimit);
  if (chosen.length > maxCells) {
    console.log(`  ${chosen.length} cells touched; sampling ${maxCells} (--max-cells)`);
    const stride = chosen.length / maxCells;
    chosen = Array.from({ length: maxCells }, (_, i) => chosen[Math.floor(i * stride)]!);
  }

  const surfaces = new Map<string, CellSurface>();
  const surfaceAt = (x: number, z: number): CellSurface => {
    const cx = Math.floor(x / size), cz = Math.floor(z / size);
    const key = `${cx},${cz}`;
    let s = surfaces.get(key);
    if (!s) surfaces.set(key, (s = cellSurface(field, cx, cz)));
    return s;
  };
  /** Highest mesh surface at or below `y + reach`, or -Infinity. */
  const groundBelow = (x: number, z: number, y: number, reach = 1): number => {
    let best = -Infinity;
    for (const h of surfaceAt(x, z).hits(x, z)) if (h <= y + reach && h > best) best = h;
    return best;
  };
  /**
   * Classify one footing: gap under the centre, and the worst drop on the
   * ring. `base` is where the model's origin is, `sink` how far the rule
   * bedded it on purpose (yOffset x scale, or cover's slope sink): the ground
   * is looked for near `base + sink`, so a deliberately buried base is not
   * mistaken for one hovering over a lower surface.
   */
  const judge = (x: number, z: number, base: number, sink: number, radius: number, steepAllowance: number): { gap: number; drop: number; ground: number } => {
    const foot = base + sink;
    let ground = groundBelow(x, z, foot, 0.75);
    if (ground === -Infinity) {
      // nothing below but a surface just above: BURIED (steep ground, a sunk
      // base), which is not this check's fault — not hovering over a void
      let above = Infinity;
      for (const h of surfaceAt(x, z).hits(x, z)) if (h > foot && h < foot + 3 && h < above) above = h;
      if (above !== Infinity) ground = above;
    }
    const gap = base - ground;
    let drop = 0;
    if (radius > 0) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = x + Math.cos(a) * radius, pz = z + Math.sin(a) * radius;
        const g = groundBelow(px, pz, foot, 0.75 + steepAllowance * radius);
        // only higher ground there (uphill, a wall): not a drop
        if (g === -Infinity && surfaceAt(px, pz).hits(px, pz).some((h) => h > foot)) continue;
        drop = Math.max(drop, foot - g - steepAllowance * radius);
      }
    }
    return { gap, drop, ground };
  };
  const OPEN = 1.0; // metres the footing ring may fall away beyond its slope

  type Row = { kind: string; id: string; x: number; z: number; base: number; ground: number; gap: number; drop: number };
  const bad: Row[] = [];
  let props = 0;
  let blades = 0;
  const t0 = Date.now();
  for (const [cx, cz] of chosen) {
    for (const inst of scatterCell(field, cx, cz)) {
      const rule = recipe.scatter[inst.ruleIndex]!;
      if (rule.cliff) continue; // cliff stacks hang on faces by design
      props++;
      const x = inst.position[0] + cx * size;
      const z = inst.position[2] + cz * size;
      const base = inst.position[1];
      const radius = scatterFooting(rule, inst.scale);
      const { gap, drop, ground } = judge(x, z, base, Math.max(0, -rule.yOffset * inst.scale), radius, 1.2);
      if (gap > tol || drop > OPEN) bad.push({ kind: rule.id, id: inst.id, x, z, base, ground, gap, drop });
    }
    if (skipCover || recipe.cover.length === 0) continue;
    const probes = voxelGroundProbes(() => field);
    for (const layer of recipe.cover) {
      const radius = (layer.bladeWidth / 2) * (layer.scaleRange?.[1] ?? 1.3);
      for (let gz = 0; gz < size; gz += coverStep) {
        for (let gx = 0; gx < size; gx += coverStep) {
          const x = cx * size + gx + coverStep * 0.37;
          const z = cz * size + gz + coverStep * 0.61;
          const y = probes.sampleCover(x, z, layer as never);
          if (y === null) continue;
          blades++;
          // a floating layer (lily pads) lies on water, not on the ground
          if (layer.water?.mode === "surface") continue;
          const { gap, drop, ground } = judge(x, z, y, 0.5, Math.min(radius, 0.6), 1.2);
          if (gap > tol || drop > OPEN) bad.push({ kind: `cover:${layer.id}`, id: `${x.toFixed(1)},${z.toFixed(1)}`, x, z, base: y, ground, gap, drop });
        }
      }
    }
  }

  // What a finding is ABOUT. The fault this check exists for is a terrain
  // EDIT the placement did not see: a 3D carve (passage, tunnel, subtracting
  // blob) within reach of the footing, or a height patch. Anything else is
  // the 2 m mesh disagreeing with a sharp HEIGHTFIELD edge (a fill's bank, a
  // cliff) on untouched ground — real, older, everywhere in every world, and
  // not this fault; it is reported, not failed on.
  const patches = recipe.features.heightPatches;
  // the same world with every 3D carve taken out: what the ground would be
  // had nobody cut into it (natural overhangs included, so a steep face's
  // overhang noise is not mistaken for an edit)
  const bare = createWorldField({
    ...recipe,
    features: { ...recipe.features, passages: [], tunnels: [], blobs: recipe.features.blobs.filter((b) => b.op === "add") },
  });
  const attributable = (r: Row): boolean => {
    if (patches.some((h) => r.x > h.origin[0] - 4 && r.z > h.origin[1] - 4 && r.x < h.origin[0] + h.size[0] + 4 && r.z < h.origin[1] + h.size[1] + 4)) return true;
    // a carve counts only where it CHANGED the ground within 3 m: a tunnel
    // 300 m under a mountain is near in plan and irrelevant to the grass
    for (let k = -1; k < 8; k++) {
      const px = k < 0 ? r.x : r.x + Math.cos((k / 8) * Math.PI * 2) * 3;
      const pz = k < 0 ? r.z : r.z + Math.sin((k / 8) * Math.PI * 2) * 3;
      const real = editedGround(field, px, pz, 0);
      if (real === undefined) continue;
      const before = bare.surfaceCast(px, pz) ?? bare.height(px, pz);
      if (real === null || Math.abs(real - before) > 0.3) return true;
    }
    return false;
  };
  const background = bad.filter((r) => !attributable(r));
  const edits = bad.filter(attributable);
  if (background.length) {
    console.log(`  (background, not an edit: ${background.length} on untouched heightfield edges — the 2 m mesh vs the exact height; not failed on)`);
    if (list) for (const r of background) console.log(`    bg ${r.kind} at (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) gap ${Number.isFinite(r.gap) ? r.gap.toFixed(2) : "inf"} drop ${Number.isFinite(r.drop) ? r.drop.toFixed(2) : "inf"}`);
  }
  bad.length = 0;
  bad.push(...edits);
  const floats = bad.filter((r) => r.gap > tol);
  const open = bad.filter((r) => r.gap <= tol);
  console.log(
    `scatter-float ${recipe.name}: ${chosen.length} cells, ${props} props, ${blades} cover samples (step ${coverStep} m) in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  const byKind = new Map<string, number>();
  for (const r of bad) byKind.set(r.kind.startsWith("cover:") ? "cover" : "props", (byKind.get(r.kind.startsWith("cover:") ? "cover" : "props") ?? 0) + 1);
  console.log(`  FLOAT (base > ${tol} m over the mesh): ${floats.length}   OPEN (footing over a drop > ${OPEN} m): ${open.length}   [props ${byKind.get("props") ?? 0}, cover ${byKind.get("cover") ?? 0}]`);
  const show = list ? bad : bad.slice().sort((a, b) => b.gap - a.gap).slice(0, 25);
  for (const r of show.sort((a, b) => b.gap - a.gap)) {
    console.log(
      `    ${r.kind.padEnd(24)} ${r.id.padEnd(28)} at (${r.x.toFixed(1)}, ${r.z.toFixed(1)})  base ${r.base.toFixed(2)}  ground ${Number.isFinite(r.ground) ? r.ground.toFixed(2) : "none"}  gap ${Number.isFinite(r.gap) ? r.gap.toFixed(2) : "inf"}  ring drop ${Number.isFinite(r.drop) ? r.drop.toFixed(2) : "inf"}`,
    );
  }
  if (!list && bad.length > show.length) console.log(`    ... ${bad.length - show.length} more (--list for all)`);
  if (bad.length === 0) console.log("  no findings");
  else process.exit(1);
}
