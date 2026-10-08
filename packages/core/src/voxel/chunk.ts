/**
 * Cell -> `ChunkDoc`: what makes a generated world stream through exactly the
 * same machinery as an authored one.
 *
 * A procedural cell is turned into an ordinary chunk document — a terrain
 * entity whose mesh source is `{ kind: "voxel", world, cell }` plus one
 * collapsed prefab instance per scattered prop — and handed to the existing
 * `ChunkManager`. That buys the LOD rings, the HLOD supercell merge, the
 * physics attach/detach, the instanced-batch bookkeeping and the "chunk
 * content never enters the scene doc" rule for free, all of it already
 * debugged against a real game (docs/performance-lessons.md).
 *
 * The document stays tiny and legible: the terrain is four lines regardless of
 * how many triangles it becomes, and props are one line each, exactly as
 * ARCHITECTURE.md's collapsed-document rule requires.
 */

import type { ChunkDoc } from "../chunks.js";
import type { EntityDoc } from "../scene.js";
import type { VoxelWorldData } from "../components/voxel.js";
import type { RiverFall, SurfaceSample, WorldField } from "./field.js";
import { scatterCell, type ScatterCellOptions } from "./scatter.js";
import { fallSiteRockInstances } from "./fall-site-rocks.js";
import type { VoxelMesher } from "./mesh.js";
import type { BridgeDoc, LakeDoc, RiverDoc, ScatterDoc, WorldRecipe } from "./recipe.js";

export interface VoxelChunkOptions extends ScatterCellOptions {
  /** Include scatter props (trees/rocks). Off for a bare-terrain preview. */
  scatter?: boolean;
  /**
   * Does this prefab/model asset exist? Scatter rules and POIs naming assets
   * that don't are dropped, with everything else in the cell kept.
   *
   * This is not defensiveness for its own sake: prefab expansion THROWS on an
   * unknown prefab, and a chunk load that throws loads nothing — so without
   * this one absent tree asset silently deletes the terrain, the collider and
   * every other prop in the cell, and you fall through the floor of a world
   * that looks empty. A recipe naturally names assets before they are made
   * (the whole point of authoring the world first), so this is the normal
   * case, not an edge case.
   *
   * Omit it — as the CLI does — to trust every reference.
   */
  assetExists?: (assetId: string, kind: "prefab" | "model") => boolean;
  /** Include a cooked trimesh collider on the terrain entity. */
  collision?: boolean;
  colliderLodStep?: number;
  /** Terrain material asset id; falls back to the recipe's own `material`. */
  material?: string;
  terrainCastShadow?: boolean;
  /** Mesh at a coarser lattice (HLOD/preview). 1 = full detail. */
  lodStep?: number;
  /** Which mesher the terrain cell asks for. Omit for marching cubes. */
  mesher?: VoxelMesher;
  /** Emit river ribbons and lake sheets (needs `recipe.waterMaterial`). Default on. */
  water?: boolean;
}

/** The terrain entity's id inside every generated chunk — stable, so edits/diagnostics can name it. */
export const VOXEL_TERRAIN_ID = "terrain";

/** Can this scatter rule actually be built with the assets the host has? */
function scatterUsable(rule: ScatterDoc, exists: VoxelChunkOptions["assetExists"]): boolean {
  if (!rule.prefab && !rule.model) return false;
  if (!exists) return true;
  if (rule.prefab) return exists(rule.prefab, "prefab");
  return exists(rule.model!, "model");
}

function propEntity(rule: ScatterDoc, instance: ReturnType<typeof scatterCell>[number]): EntityDoc {
  const components: Record<string, unknown> = {
    transform: {
      position: instance.position,
      rotation: instance.rotation,
      scale: [instance.scale, instance.scale, instance.scale],
    },
  };
  if (rule.prefab) {
    components["prefab"] = { prefabId: rule.prefab, props: {}, overrides: [] };
  } else if (rule.model) {
    components["mesh"] = {
      source: {
        kind: "asset",
        assetId: rule.model,
        ...(instance.vegetationTint ? { vegetationTint: instance.vegetationTint } : {}),
        ...(rule.foliageNormals === undefined ? {} : { foliageNormals: rule.foliageNormals }),
        ...(rule.foliageUp === undefined ? {} : { foliageUp: rule.foliageUp }),
        ...(rule.brightness === undefined ? {} : { brightness: rule.brightness }),
        ...(rule.wind === undefined ? {} : { wind: rule.wind }),
        ...(rule.cameraFade === undefined ? {} : { cameraFade: rule.cameraFade }),
      },
      ...(rule.material ? { material: rule.material } : {}),
      // instanced is not an optimisation here, it is the difference between a
      // forest and a slideshow: one InstancedMesh per model per supercell
      renderMode: "instanced",
      lod: rule.lod,
      static: rule.static,
      castShadow: rule.castShadow,
      receiveShadow: true,
    };
  }
  if (rule.collider !== "none") {
    // Size and offset are the MODEL-space numbers, NOT pre-multiplied by
    // `instance.scale`. The transform above already carries that scale and
    // the physics sim applies a body's world scale to its collider itself
    // (`sim.ts`: `size[i] * s`, `offset[i] * s`) — Rapier colliders do not
    // scale with their body, so the sim has to, and a rule that scaled them
    // here as well got scale SQUARED. At the 0.9-1.7 a rock rule asks for
    // that is a collider up to 2.9x the rock, floating at twice the right
    // height: an invisible boulder several metres across, and invisible is
    // the whole problem — nothing draws a collider, so it survived a static
    // audit of the recipe against the model. `worldgen scatter` compares the
    // rule to the model on the same assumption this line now honours.
    components["collider"] = {
      shape: rule.collider,
      size: [rule.colliderSize[0], rule.colliderSize[1], rule.colliderSize[2]],
      offset: [0, rule.colliderSize[1] / 2, 0],
    };
  }
  return { name: instance.id, parent: null, tags: ["scatter", rule.id], components };
}

/**
 * How far the water surface runs on UNDER the ground past the shoreline (m).
 * The terrain is marching cubes over the same 2 m lattice this samples, so
 * the two waterlines agree to within its interpolation; the overlap hides
 * that difference under the bank instead of leaving a sliver of dry bed.
 */
const WATER_OVERLAP = 0.35;

/**
 * Ground this far under a river's bed is not the river's: the bed could not
 * be built up to (RIVER_MAX_BUILD), so the channel is a sheet over a valley.
 * No water is drawn there — a dry gap reads as a dry reach, a sheet in the
 * air reads as a bug.
 */
const WATER_FLOOR_SLACK = 3;

/**
 * Most the water may differ across one lattice square (m). A rapid falls
 * about a metre between neighbouring samples; more than this is two bodies
 * of water that merely touch (a river perched beside a lake it does not
 * reach), and joining them drew a sheer wall of water between the two.
 */
const WATER_MAX_STEP = 64;

/**
 * Water for one cell, built FROM THE TERRAIN: the lattice is sampled for the
 * water surface (`field.waterSurface` — lakes, and rivers solved as level
 * pools) and the ground, and water is kept wherever it stands above the
 * ground, the edge cut by marching squares at the interpolated crossing.
 *
 * This replaced a ribbon per river and a polygon per lake, whose widths came
 * from a formula: the formula never agreed with where the ground actually
 * crossed the water, so the water floated over dry strips in one place and
 * stopped short of the bank in the next (measured on the mmo world: 57 % of
 * ribbon edges more than a metre off the real shore). Here the shoreline IS
 * where the ground crosses the surface — the Valheim rule, per pool.
 *
 * Every vertex is a function of world XZ on the shared lattice, so two cells
 * produce the same vertices along their common edge: no stitching, no gap.
 * One mesh per material per cell (rivers and lakes usually one each); the
 * per-vertex current rides in `uv` (m/s along world X and Z), which the
 * water material reads in `flowMode: "field"` and HLOD merges keep.
 */
function waterEntities(
  field: WorldField,
  cx: number,
  cz: number,
  material: string,
  entities: ChunkDoc["entities"],
  lodStep = 1,
): void {
  const recipe = field.recipe;
  const size = recipe.cellSize;
  const x0 = cx * size;
  const z0 = cz * size;
  const step = field.voxelSize * Math.max(1, lodStep);
  const reach = 2 * step;
  if (!field.waterNear(x0 - reach, z0 - reach, x0 + size + reach, z0 + size + reach)) return;
  const n = Math.max(1, Math.round(size / step));
  const cellStep = size / n;
  const side = n + 1;
  const count = side * side;
  const f = new Float32Array(count);
  const wy = new Float32Array(count);
  const fx = new Float32Array(count);
  const fz = new Float32Array(count);
  const mat: (string | null)[] = new Array(count).fill(null);
  const riverMaterial = recipe.riverMaterial ?? material;
  const nearFalls = field.falls.filter((f) => f.x > x0 - 60 && f.x < x0 + size + 60 && f.z > z0 - 60 && f.z < z0 + size + 60);
  /** Each fall's curtain span (curtainSpan): the upper water cut at its lip line ends where the curtain does. */
  const spans = new Map<RiverFall, [number, number]>();
  const spanOf = (fall: RiverFall): [number, number] => {
    let known = spans.get(fall);
    if (!known) spans.set(fall, (known = curtainSpan(field, fall)));
    return known;
  };
  /**
   * The fall whose lip line — or its cut line, FALL_ROLL_BACK upstream, where
   * the upper water ends and the curtain begins — crosses lattice square
   * (i, j) within its band, or null.
   */
  const straddledLip = (i: number, j: number): RiverFall | null => {
    for (const fall of nearFalls) {
      const lx = fall.x - fall.dirX * FALL_LIP_OFFSET;
      const lz = fall.z - fall.dirZ * FALL_LIP_OFFSET;
      let neg = false;
      let pos = false;
      let negCut = false;
      let posCut = false;
      for (const [ci, cj] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]] as const) {
        const d = (x0 + ci * cellStep - lx) * fall.dirX + (z0 + cj * cellStep - lz) * fall.dirZ;
        if (d < 0) neg = true;
        else pos = true;
        if (d + FALL_ROLL_BACK < 0) negCut = true;
        else posCut = true;
      }
      if (!(neg && pos) && !(negCut && posCut)) continue;
      // water at the UPPER level on both sides (a lake curving on past the
      // lip line) is just water: the line only cuts where the upper level ends
      let upperPast = false;
      for (const [ci, cj] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]] as const) {
        const c = cj * side + ci;
        const d = (x0 + ci * cellStep - lx) * fall.dirX + (z0 + cj * cellStep - lz) * fall.dirZ;
        if (d >= 0 && mat[c] !== null && Math.abs(wy[c]! - fall.top) < 0.6) upperPast = true;
      }
      if (upperPast) continue;
      const sx = x0 + (i + 0.5) * cellStep - lx;
      const sz = z0 + (j + 0.5) * cellStep - lz;
      if (Math.abs(-sx * fall.dirZ + sz * fall.dirX) <= fall.reach) return fall;
    }
    return null;
  };
  /**
   * The fall whose lip line lattice square (i, j) stands just UPSTREAM of
   * (every corner within two squares before the line, inside its band), or
   * null. Such a square with a corner already reading the pool below (the
   * pool's surface reaches under the brink) spans two levels and was dropped
   * outright: an open hole in the upper water a metre or two before the lip,
   * seen as a dark crack beside the curtain's top. It is drawn at the upper
   * level instead, cut against the ground like the lip squares.
   */
  const upstreamLip = (i: number, j: number): RiverFall | null => {
    for (const fall of nearFalls) {
      const lx = fall.x - fall.dirX * FALL_CUT;
      const lz = fall.z - fall.dirZ * FALL_CUT;
      let near = true;
      let upper = false;
      for (const [ci, cj] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]] as const) {
        const d = (x0 + ci * cellStep - lx) * fall.dirX + (z0 + cj * cellStep - lz) * fall.dirZ;
        if (d >= 0 || d < -2 * cellStep) near = false;
        const c = cj * side + ci;
        if (mat[c] !== null && Math.abs(wy[c]! - fall.top) < 0.6) upper = true;
      }
      if (!near || !upper) continue;
      const sx = x0 + (i + 0.5) * cellStep - lx;
      const sz = z0 + (j + 0.5) * cellStep - lz;
      if (Math.abs(-sx * fall.dirZ + sz * fall.dirX) <= fall.reach) return fall;
    }
    return null;
  };
  /**
   * The upper water's second uv at local (x, z) near a lip: (across the
   * curtain's span 0..1, -1 - t), t = 0 on the lip line to 1 SHEET_FADE_RUN
   * upstream (or 2 m beyond the span's side), which the water material fades
   * the side bands by — the same bands as the curtain's top row, so the two
   * soften together. Everywhere else (0.5, -2): t = 1, no fade. The box around
   * a lip reaches a lattice square past where t hits 1, so no triangle
   * interpolates a fading vertex against the far default.
   */
  let shaped = false;
  const sheetShape = (x: number, z: number): [number, number] => {
    let best: [number, number] = [0.5, -2];
    let found = false;
    for (const fall of nearFalls) {
      const dx = x + x0 - (fall.x - fall.dirX * FALL_CUT);
      const dz = z + z0 - (fall.z - fall.dirZ * FALL_CUT);
      const along = dx * fall.dirX + dz * fall.dirZ;
      const across = -dx * fall.dirZ + dz * fall.dirX;
      const margin = 2 + 2 * cellStep;
      if (along > 2 * cellStep || along < -(SHEET_FADE_RUN + 2 * cellStep) || Math.abs(across) > fall.reach + margin) continue;
      const [lo, hi] = spanOf(fall);
      if (across < lo - margin || across > hi + margin) continue;
      const beyond = Math.max(0, lo - across, across - hi);
      const t = along > 0.05 ? 1 : Math.min(1, Math.max(-along / SHEET_FADE_RUN, beyond / 2, 0));
      if (!found || -1 - t > best[1]) best = [Math.round(((across - lo) / (hi - lo)) * 1e4) / 1e4, Math.round((-1 - t) * 1e4) / 1e4];
      found = true;
      shaped = true;
    }
    return best;
  };
  const sample: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
  let any = false;
  // ground at every sample near a fall, for cutting the lip squares
  const groundAt = nearFalls.length > 0 ? new Float32Array(count) : null;
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const k = j * side + i;
      f[k] = -1;
      const x = x0 + i * cellStep;
      const z = z0 + j * cellStep;
      if (groundAt) groundAt[k] = field.height(x, z);
      if (!field.waterSurface(x, z, sample)) continue;
      // at or under the sea the ocean plane is the water
      if (sample.y <= recipe.seaLevel + 0.05) continue;
      const ground = groundAt ? groundAt[k]! : field.height(x, z);
      if (sample.kind === "river" && ground < sample.floor - WATER_FLOOR_SLACK) continue;
      f[k] = sample.y + WATER_OVERLAP - ground;
      wy[k] = sample.y;
      fx[k] = sample.flowX;
      fz[k] = sample.flowZ;
      // ONE material for rivers and plain lakes, so where a lake spills into
      // a river they are one mesh and one surface; only a lake that names its
      // own water (a swamp) keeps it
      mat[k] = sample.material ?? riverMaterial;
      if (f[k]! > 0) any = true;
    }
  }
  if (!any) return;

  interface Mesh {
    positions: number[];
    uvs: number[];
    /** sheetShape per vertex: the side fade near a lip (emitted only where one is near) */
    uv1s: number[];
    indices: number[];
    ids: Map<number, number>;
  }
  const meshes = new Map<string, Mesh>();
  const round = (v: number): number => Math.round(v * 100) / 100;
  /** A vertex on corner `a` (b < 0) or on the crossing of edge a-b, shared by id within the mesh. */
  const vertex = (mesh: Mesh, a: number, b: number): number => {
    const id = b < 0 ? a : count + Math.min(a, b) * count + Math.max(a, b);
    const known = mesh.ids.get(id);
    if (known !== undefined) return known;
    const ax = (a % side) * cellStep;
    const az = Math.floor(a / side) * cellStep;
    let x = ax;
    let z = az;
    let y = wy[a]!;
    let u = fx[a]!;
    let v = fz[a]!;
    if (b >= 0) {
      // a is in the water, b is not: the crossing where f reaches 0
      const t = f[a]! / (f[a]! - f[b]!);
      x += ((b % side) * cellStep - ax) * t;
      z += (Math.floor(b / side) * cellStep - az) * t;
      if (mat[b] !== null) {
        y += (wy[b]! - y) * t;
        u += (fx[b]! - u) * t;
        v += (fz[b]! - v) * t;
      }
    }
    const index = mesh.positions.length / 3;
    mesh.positions.push(round(x), round(y), round(z));
    mesh.uvs.push(round(u), round(v));
    mesh.uv1s.push(...sheetShape(round(x), round(z)));
    mesh.ids.set(id, index);
    return index;
  };
  const poly: [number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // counter-clockwise seen from above (+Y): (i,j) -> (i,j+1) -> (i+1,j+1) -> (i+1,j)
      const corners = [j * side + i, (j + 1) * side + i, (j + 1) * side + i + 1, j * side + i + 1];
      let inside = 0;
      let owner = -1;
      let low = Infinity;
      let high = -Infinity;
      for (const c of corners) {
        if (f[c]! > 0) {
          inside++;
          if (owner < 0) owner = c;
        }
        if (mat[c] !== null) {
          low = Math.min(low, wy[c]!);
          high = Math.max(high, wy[c]!);
        }
      }
      // a square straddling a lip line is cut ON it (below), whatever its corners hold
      const lipFall = groundAt ? straddledLip(i, j) : null;
      if (!lipFall && (inside === 0 || high - low > WATER_MAX_STEP)) continue;
      // A square straddling a waterfall's lip is NOT drawn from its corners:
      // four corners at two levels made a sloping, sawtoothed face with fins
      // down both sides. It is cut on the lip line instead — flat at the upper
      // level before it, flat at the pool's after it — and the fall itself is
      // its own curtain mesh (fallCurtain) hanging from that line.
      if (lipFall || high - low > 1.5) {
        const fall = lipFall ?? (groundAt ? upstreamLip(i, j) : null);
        if (!fall) continue;
        let mesh = meshes.get(riverMaterial);
        if (!mesh) {
          mesh = { positions: [], uvs: [], uv1s: [], indices: [], ids: new Map() };
          meshes.set(riverMaterial, mesh);
        }
        const lx = fall.x - fall.dirX * FALL_CUT;
        const lz = fall.z - fall.dirZ * FALL_CUT;
        const square: [number, number][] = [
          [i * cellStep, j * cellStep],
          [i * cellStep, (j + 1) * cellStep],
          [(i + 1) * cellStep, (j + 1) * cellStep],
          [(i + 1) * cellStep, j * cellStep],
        ];
        const corners4 = corners;
        /** Metres past the cut line (the upper piece ends there; the pool piece starts at the lip line, FALL_ROLL_BACK on). */
        const side = (q: [number, number]): number => (q[0] + x0 - lx) * fall.dirX + (q[1] + z0 - lz) * fall.dirZ;
        const levelSide = (q: [number, number], keep: number): number => (keep < 0 ? side(q) : side(q) - FALL_ROLL_BACK);
        /** A polygon corner: local x, z, the level over the ground there, the current (u, v), and the level. */
        type Corner = [number, number, number, number, number, number];
        /** Keep the part of a polygon where `value` >= 0, cutting each edge at the crossing (every field linear along the edge). */
        const clip = (poly: Corner[], value: (q: Corner) => number): Corner[] => {
          const out: Corner[] = [];
          for (let e = 0; e < poly.length; e++) {
            const a = poly[e]!;
            const b = poly[(e + 1) % poly.length]!;
            const da = value(a);
            const db = value(b);
            if (da >= 0) out.push(a);
            if (da >= 0 !== db >= 0) {
              const t = da / (da - db);
              out.push(a.map((av, k) => av + (b[k]! - av) * t) as Corner);
            }
          }
          return out;
        };
        const lipCurrent = fallCurrent(fall, FALL_LIP_SPEED);
        for (const [keep, y] of [[-1, fall.top], [1, fall.bottom]] as const) {
          // only a level that is really there on its side of the line: the
          // upper where an upstream corner holds the upper water, the lower where
          // a downstream corner holds the pool
          const present = square.some((q, e) => {
            const cc = corners4[e]!;
            if (mat[cc] === null || levelSide(q, keep) * keep < 0) return false;
            return keep < 0 ? Math.abs(wy[cc]! - y) < 0.6 : wy[cc]! <= y + 0.6 && wy[cc]! >= y - 4;
          });
          if (!present) continue;
          // the square with, per corner, how far this level stands over the
          // ground there (f is the corner's own level over the ground): cut
          // against the ground like any other water, THEN on the lip line —
          // uncut, the flat pieces hung out over the rock beside the lip
          // the current: the upper water's own at an upstream corner that holds
          // it (so the piece runs on from the squares upstream without a jump),
          // the lip's on the line (below: exactly the curtain's top row's)
          const corners = square.map((q, e) => {
            const cc = corners4[e]!;
            const own = keep < 0 && side(q) < 0 && mat[cc] !== null && Math.abs(wy[cc]! - y) < 0.6;
            // at the corner's OWN level (the lattice square beside it has its
            // vertex there: a lake a few cm over the lip's level left a step
            // along the piece's edge, a hairline crack onto the rock), the
            // lip's on the line
            const level = own ? wy[cc]! : y;
            const over = level + WATER_OVERLAP - groundAt![cc]!;
            return [q[0], q[1], over, own ? fx[cc]! : NaN, own ? fz[cc]! : NaN, level] as Corner;
          });
          // a corner without the upper water's own current (past the line, or
          // reading the pool) takes the mean of those that have it
          const owned = corners.filter((q) => !Number.isNaN(q[3]));
          for (const q of corners) {
            if (!Number.isNaN(q[3])) continue;
            q[3] = owned.length ? owned.reduce((sum, o) => sum + o[3], 0) / owned.length : lipCurrent[0];
            q[4] = owned.length ? owned.reduce((sum, o) => sum + o[4], 0) / owned.length : lipCurrent[1];
          }
          const wet = clip(corners, (q) => q[2]);
          if (wet.length < 3) continue;
          let piece = clip(wet, (q) => levelSide([q[0], q[1]], keep) * keep);
          // the upper piece ends across the lip exactly where the curtain's
          // top does, so the sheet and the curtain meet with nothing jutting
          if (keep < 0 && lipFall && piece.length >= 3) {
            const [lo, hi] = spanOf(fall);
            const across = (q: Corner): number => -(q[0] + x0 - lx) * fall.dirZ + (q[1] + z0 - lz) * fall.dirX;
            piece = clip(clip(piece, (q) => across(q) - lo), (q) => hi - across(q));
          }
          if (piece.length < 3) continue;
          const base = mesh.positions.length / 3;
          for (const q of piece) {
            const onLine = keep < 0 && Math.abs(side([q[0], q[1]])) < 1e-6;
            mesh.positions.push(round(q[0]), round(keep < 0 && !onLine ? q[5] : y), round(q[1]));
            if (keep < 0) {
              // the upper piece: its current eases from the water upstream's to
              // the lip's (FALL_LIP_SPEED, just under the rapids froth: froth on
              // it read as a pale line along the curtain's top), and ON the line
              // it is exactly the curtain's top row's, unrounded, so the flow
              // texture runs over the edge without a jump
              mesh.uvs.push(onLine ? lipCurrent[0] : round(q[3]), onLine ? lipCurrent[1] : round(q[4]));
            } else {
              // the pool piece churns white where the curtain lands (3.4 m/s)
              mesh.uvs.push(round(fall.dirX * 3.4), round(fall.dirZ * 3.4));
            }
            mesh.uv1s.push(...sheetShape(round(q[0]), round(q[1])));
          }
          for (let t = 1; t + 1 < piece.length; t++) mesh.indices.push(base, base + t, base + t + 1);
        }
        continue;
      }
      // Sutherland-Hodgman against f > 0; the result is convex (a square
      // with corners cut off), so a fan triangulates it
      poly.length = 0;
      for (let e = 0; e < 4; e++) {
        const a = corners[e]!;
        const b = corners[(e + 1) % 4]!;
        const aIn = f[a]! > 0;
        const bIn = f[b]! > 0;
        if (aIn) poly.push([a, -1]);
        if (aIn !== bIn) poly.push(aIn ? [a, b] : [b, a]);
      }
      if (poly.length < 3) continue;
      const key = mat[owner]!;
      let mesh = meshes.get(key);
      if (!mesh) {
        mesh = { positions: [], uvs: [], uv1s: [], indices: [], ids: new Map() };
        meshes.set(key, mesh);
      }
      const ids = poly.map(([a, b]) => vertex(mesh!, a, b));
      // A whole square splits along the diagonal whose ends are closest in
      // height: across a waterfall's lip (three corners up, one down) the
      // other diagonal folds the face into a tooth.
      if (inside === 4 && Math.abs(wy[corners[1]!]! - wy[corners[3]!]!) < Math.abs(wy[corners[0]!]! - wy[corners[2]!]!)) {
        mesh.indices.push(ids[1]!, ids[2]!, ids[3]!, ids[1]!, ids[3]!, ids[0]!);
        continue;
      }
      for (let t = 1; t + 1 < ids.length; t++) mesh.indices.push(ids[0]!, ids[t]!, ids[t + 1]!);
    }
  }
  let index = 0;
  for (const [materialId, mesh] of meshes) {
    if (mesh.indices.length === 0) continue;
    entities[index === 0 ? "water" : `water_${index}`] = {
      name: `water ${cx}_${cz}`,
      parent: null,
      tags: ["water"],
      components: {
        transform: { position: [0, 0, 0] },
        mesh: {
          // the second uv only where a lip is near (sheetShape): elsewhere the geometry has none and never fades
          source: shaped
            ? { kind: "surface", positions: mesh.positions, indices: mesh.indices, uvs: mesh.uvs, uv1s: mesh.uv1s }
            : { kind: "surface", positions: mesh.positions, indices: mesh.indices, uvs: mesh.uvs },
          material: materialId,
          static: false,
          castShadow: false,
          receiveShadow: false,
        },
      },
    };
    index++;
  }
}

/**
 * Mist at the foot of every waterfall whose plunge pool is in this cell: the
 * weather's dust bank (the same big soft upright noise quads) in spray white,
 * rising slowly off the pool. Sized by the fall — a 40 m plunge off a sea
 * cliff throws far more than a 6 m drop — and batched with every other fall's
 * mist into one draw, since they share one particle configuration.
 */
function mistEntities(field: WorldField, cx: number, cz: number, entities: ChunkDoc["entities"]): void {
  const size = field.recipe.cellSize;
  const x0 = cx * size;
  const z0 = cz * size;
  const material = field.recipe.riverMaterial ?? field.recipe.waterMaterial;
  field.falls.forEach((fall, index) => {
    if (fall.x < x0 || fall.x >= x0 + size || fall.z < z0 || fall.z >= z0 + size) return;
    const height = fall.top - fall.bottom;
    // the water lattice's square at full detail (waterEntities' cellStep): the curtain's top row meets its lip cut
    const grid = size / Math.max(1, Math.round(size / field.voxelSize));
    if (material) entities[`fall_${index}`] = fallCurtain(fall, x0, z0, material, curtainSpan(field, fall), grid);
    const spread = Math.max(4, fall.width * 0.9);
    entities[`mist_${index}`] = {
      name: `${fall.river} falls mist`,
      parent: null,
      tags: ["waterfall-mist"],
      components: {
        transform: { position: [fall.x - x0 + fall.dirX * 2, fall.bottom + 0.6, fall.z - z0 + fall.dirZ * 2] },
        particles: {
          emitting: true,
          rate: Math.round(Math.min(26, 4 + height * 0.55)),
          max: Math.round(Math.min(26, 4 + height * 0.55) * 7),
          lifetime: [3, 6],
          shape: "box",
          shapeSize: [spread, 1.5, spread],
          coneAngle: 35,
          spread: 10,
          turbulence: 0.35,
          turbulenceSpeed: 0.8,
          fadeIn: 0.2,
          // up off the pool, drifting downstream with the water
          direction: [fall.dirX * 0.35, 1, fall.dirZ * 0.35],
          radial: "none",
          speed: [0.6, 1.8 + height * 0.04],
          gravity: 0,
          drag: 0.05,
          sizeStart: 2.5 + height * 0.06,
          sizeEnd: 7 + height * 0.2,
          spin: 0.4,
          colorStart: "#eef6f7",
          colorEnd: "#cfe2e6",
          opacityStart: 1,
          opacityEnd: 0,
          blending: "normal",
          sprite: "noise",
          filter: "linear",
          steps: 0,
          snap: 0,
          frameRate: 0,
          softFade: 1,
          stretch: 0,
          orient: "upright",
          opacityCurve: [[0, 0], [0.2, 0.32], [0.65, 0.22], [1, 0]],
          space: "world",
        },
      },
    };
    // Splash: droplets thrown up off the pool and pulled back down, streaked
    // along their flight — the white water the mist rises from.
    const at = [fall.x - x0 + fall.dirX * 1.5, fall.bottom + 0.2, fall.z - z0 + fall.dirZ * 1.5];
    entities[`splash_${index}`] = {
      name: `${fall.river} falls splash`,
      parent: null,
      tags: ["waterfall-splash"],
      components: {
        transform: { position: at },
        particles: {
          emitting: true,
          rate: Math.round(Math.min(60, 12 + height * 1.2)),
          max: Math.round(Math.min(60, 12 + height * 1.2) * 1.4),
          lifetime: [0.5, 1.1],
          shape: "box",
          shapeSize: [spread * 0.8, 0.4, 2],
          coneAngle: 40,
          spread: 20,
          turbulence: 0,
          turbulenceSpeed: 0,
          fadeIn: 0,
          direction: [fall.dirX * 0.5, 1, fall.dirZ * 0.5],
          radial: "none",
          speed: [3 + height * 0.05, 6 + height * 0.12],
          gravity: 9.8,
          drag: 0.2,
          sizeStart: 0.35,
          sizeEnd: 0.2,
          spin: 0,
          colorStart: "#ffffff",
          colorEnd: "#d8ecef",
          opacityStart: 0.95,
          opacityEnd: 0,
          blending: "normal",
          sprite: "pixel",
          filter: "nearest",
          steps: 0,
          snap: 0,
          frameRate: 0,
          softFade: 0,
          stretch: 0.05,
          orient: "velocity",
          space: "world",
        },
      },
    };
    // Foam: rings spreading on the pool where the fall lands.
    entities[`foam_${index}`] = {
      name: `${fall.river} falls foam`,
      parent: null,
      tags: ["waterfall-foam"],
      components: {
        transform: { position: [at[0]!, fall.bottom + 0.08, at[2]!] },
        particles: {
          emitting: true,
          rate: Math.round(Math.min(8, 2 + height * 0.15)),
          max: 16,
          lifetime: [1.2, 2],
          shape: "box",
          shapeSize: [spread * 0.6, 0, 1.5],
          coneAngle: 0,
          spread: 0,
          turbulence: 0,
          turbulenceSpeed: 0,
          fadeIn: 0.1,
          direction: [fall.dirX, 0, fall.dirZ],
          radial: "none",
          speed: [0.4, 1],
          gravity: 0,
          drag: 0.3,
          sizeStart: 1.5,
          sizeEnd: 4 + height * 0.08,
          spin: 0,
          colorStart: "#ffffff",
          colorEnd: "#e4f1f3",
          opacityStart: 0.7,
          opacityEnd: 0,
          blending: "normal",
          sprite: "ring",
          filter: "nearest",
          steps: 0,
          snap: 0,
          frameRate: 0,
          softFade: 0,
          stretch: 0,
          orient: "ground",
          space: "world",
        },
      },
    };
  });
}

/**
 * The rocks of a fall site — the ones an agent stacked and its `walls`
 * dressing — as instances of the world's own scatter rules (propEntity), so
 * each batches with that rule's other instances: no new material, no new draw
 * call. Where they stand is solved once per site against the meshed surface
 * (fall-site-rocks.ts); a cell only takes the ones inside it.
 */
function fallSiteRocks(field: WorldField, cx: number, cz: number, entities: ChunkDoc["entities"], options: VoxelChunkOptions): void {
  const recipe = field.recipe;
  const size = recipe.cellSize;
  const x0 = cx * size;
  const z0 = cz * size;
  for (const site of recipe.features.fallSites ?? []) {
    // a site's rocks stay within ~100 m of its fall (walls reach 40 m out of a
    // span of a few dozen metres): don't solve a site for a cell nowhere near it
    const reach = 110 + (site.walls?.reach ?? 0);
    const near =
      (site.at[0] + reach > x0 && site.at[0] - reach < x0 + size && site.at[1] + reach > z0 && site.at[1] - reach < z0 + size) ||
      site.rocks.some((r) => r.at[0] >= x0 && r.at[0] < x0 + size && r.at[1] >= z0 && r.at[1] < z0 + size);
    if (!near) continue;
    for (const rock of fallSiteRockInstances(field, site)) {
      const [x, y, z] = rock.position;
      if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
      const rule = recipe.scatter[rock.ruleIndex];
      if (!rule || !scatterUsable(rule, options.assetExists)) continue;
      entities[rock.id] = propEntity(rule, {
        rule: rule.id,
        ruleIndex: rock.ruleIndex,
        id: rock.id,
        position: [x - x0, y, z - z0],
        rotation: rock.rotation,
        scale: rock.scale,
        biome: "",
      });
    }
  }
}

/** Where a fall's lip line stands, upstream of its foot (the solved lip is this long). */
const FALL_LIP_OFFSET = 3;

/**
 * Where the upper water is cut and the curtain takes over: this far upstream
 * of the lip line (m), so the curtain's level rows and the start of its roll
 * lie over the shelf, under the upper water's own level, and it is already
 * past 30 degrees where it crosses the brink. With the join ON the lip line
 * the curtain's first half metre ran on level out over the drop — flat water
 * hanging 16 m over the pool (the lip-shard audit's case).
 */
const FALL_ROLL_BACK = 0.45;
/** The upper water's cut line and the curtain's top row: this far upstream of a fall's foot. */
const FALL_CUT = FALL_LIP_OFFSET + FALL_ROLL_BACK;

/** The current on the lip line (m/s): the upper water's cut edge and the curtain's top row both carry it. */
const FALL_LIP_SPEED = 1.1;

/**
 * How far upstream of a lip line the upper water's sides fade with the
 * curtain's (m): the sheet writes (across the span 0..1, -1 - t) in its second
 * uv, t = 0 on the line to 1 this far up, and the water material fades the
 * span's side bands by it, so the sheet's corners at the brink are as soft as
 * the curtain's top corners instead of a hard corner over a faded one.
 */
const SHEET_FADE_RUN = 4;

/**
 * A fall's current at `speed`, down its direction. The direction is rounded
 * ONCE and scaled, so every vertex of a curtain (and the upper water's lip
 * edge) carries exactly the same direction: the fall texture's across
 * coordinate is world position (thousands of metres) dotted with it, and any
 * wobble between vertices throws that lookup tens of metres and swirls it.
 */
function fallCurrent(fall: RiverFall, speed: number): [number, number] {
  return [(Math.round(fall.dirX * 1e5) / 1e5) * speed, (Math.round(fall.dirZ * 1e5) / 1e5) * speed];
}

/**
 * How far either side of the channel's centreline the upper water really
 * stands at the lip line (across = along (-dirZ, dirX)): walked out from the
 * centre just upstream of the line while the water there is the upper level
 * over the ground. A pool carved wider than its channel (a crafted site's
 * ledge) pours over the whole of that width; a curtain only the channel's
 * width left the rest of the lip an open edge of water with a window under
 * it, the pool's pale underside showing through (the "shard" at a step).
 */
function curtainSpan(field: WorldField, fall: RiverFall): [number, number] {
  const lx = fall.x - fall.dirX * (FALL_CUT + 0.25);
  const lz = fall.z - fall.dirZ * (FALL_CUT + 0.25);
  const sample: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
  // the ground as the WATER MESH sees it: its lattice heights, bilinear
  // between them (the pieces at the lip are cut against the lattice corners,
  // and the exact height ended the curtain up to 2 m short of their edge)
  const vs = field.voxelSize;
  const lattice = (x: number, z: number): number => {
    const i = Math.floor(x / vs);
    const j = Math.floor(z / vs);
    const u = x / vs - i;
    const v = z / vs - j;
    const hh = (a: number, b: number): number => field.height(a * vs, b * vs);
    return (hh(i, j) * (1 - u) + hh(i + 1, j) * u) * (1 - v) + (hh(i, j + 1) * (1 - u) + hh(i + 1, j + 1) * u) * v;
  };
  const edge = (sign: number): number => {
    let last = 0;
    for (let w = 0; w <= fall.reach + 2; w += 0.25) {
      const x = lx - fall.dirZ * w * sign;
      const z = lz + fall.dirX * w * sign;
      // the upper level (or a lake above it, which the lip pieces flatten to
      // it) over the ground; a dry step shorter than a lattice square does
      // not end it. The lip pieces of the upper water are clipped to this
      // span in waterEntities, so the two agree by construction.
      const water = fall.top + WATER_OVERLAP > lattice(x, z) && field.waterSurface(x, z, sample) && sample.y >= fall.top - 0.6;
      if (water) last = w;
      else if (w - last > vs) break;
    }
    return last;
  };
  // to the water's edge and a hand past it, no further: the sheet's top must
  // meet the upper water exactly, and a curtain running on into "rock" stood
  // out in the air wherever the walls beside the lip were cut back
  const base = fall.width / 2;
  return [-Math.max(base, edge(-1) + 0.3), Math.max(base, edge(1) + 0.3)];
}

/**
 * The falling water of one waterfall: a sheet across the upper water at the
 * lip line (`span`: exactly its width there) that carries the upper water ON
 * over the brink — its top row IS the upper water's cut edge (waterEntities
 * cuts its lip pieces on the same line, clipped to the same span, and puts a
 * vertex wherever a lattice line crosses it: the top row has a vertex at every
 * one of those crossings, at the same height, with the same current), then a
 * short flat run and a rounded roll over the edge, so the join is one surface,
 * not an edge laid against a sheet — then falls as a thrown sheet: a parabola
 * out from the lip, bulging furthest at the middle, ending under the pool
 * below. Rows are dense near the top, where the curve is.
 *
 * (It used to start 0.8 m upstream, 6 cm UNDER the upper water, and dip
 * through it: the sheet's cut edge then stood over the curtain's top as a
 * pale ledge of flat water with a different texture on each side of it — the
 * seam at every lip.)
 *
 * The current rides in uv: FALL_LIP_SPEED on the top rows, exactly the upper
 * edge's, rising to 4 m/s over the roll, always down one rounded direction
 * (fallCurrent: the fall texture's across coordinate is world position dotted
 * with it). The second uv is the sheet's own frame: (across 0..1 over `span`,
 * down 0..1 from the lip to the foot). The water material shades the flat top
 * rows as the upper water and blends to falling water over the roll by the
 * surface's slope, and dissolves the sheet by the second uv
 * (scene-builder buildWaterMaterial): the middle of the top fully opaque, the
 * side bands soft from the top corners down, widening with the fall, and the
 * last fifth breaking up into the plunge pool. One face: the material is
 * double-sided and shades a steep face as its front from both sides.
 * `grid` is the water lattice's square (field.voxelSize at full detail).
 */
function fallCurtain(fall: RiverFall, x0: number, z0: number, material: string, span: [number, number], grid: number): ChunkDoc["entities"][string] {
  const h = fall.top - fall.bottom;
  const [lo, hi] = span;
  const mid = (lo + hi) / 2;
  const halfSpan = Math.max(1e-3, (hi - lo) / 2);
  const px = -fall.dirZ;
  const pz = fall.dirX;
  const lxWorld = fall.x - fall.dirX * FALL_CUT;
  const lzWorld = fall.z - fall.dirZ * FALL_CUT;
  const lx = lxWorld - x0;
  const lz = lzWorld - z0;
  // the brink, as (metres past the cut line, metres under the upper surface):
  // level with the upper water for a hand (so the top row's normal is the
  // sheet's, straight up), then rolling over the edge, which it crosses (the
  // lip line, FALL_ROLL_BACK on) already 30 degrees down
  const brink: [number, number][] = [[0, 0], [0.25, 0], [0.45, 0.04], [0.6, 0.13], [0.7, 0.27], [0.76, 0.44]];
  const lastDrop = brink[brink.length - 1]![1];
  const lastOut = brink[brink.length - 1]![0];
  const fallRows = Math.max(8, Math.ceil(h / 1.1));
  const profile: [number, number][] = [...brink];
  for (let j = 1; j <= fallRows; j++) {
    // dense near the top: t^1.5
    const t = (j / fallRows) ** 1.5;
    const drop = lastDrop + (h - lastDrop) * t + (j === fallRows ? 0.8 : 0);
    const out = lastOut + Math.min(FALL_LIP_OFFSET + 0.4, 0.8 * (Math.sqrt(drop) - Math.sqrt(lastDrop)));
    profile.push([out, drop]);
  }
  // columns: the span's ends, every crossing of the lip line with a lattice
  // line (world x or z a multiple of `grid`: where the upper water's lip
  // pieces have their edge vertices), and midpoints so none is over 1.25 m
  const cuts: number[] = [lo, hi];
  for (const [p0, dp] of [[lxWorld, px], [lzWorld, pz]] as const) {
    if (Math.abs(dp) < 1e-6) continue;
    const a = p0 + dp * lo;
    const b = p0 + dp * hi;
    for (let k = Math.ceil(Math.min(a, b) / grid); k * grid <= Math.max(a, b); k++) {
      const w = (k * grid - p0) / dp;
      if (w > lo + 0.02 && w < hi - 0.02) cuts.push(w);
    }
  }
  cuts.sort((a, b) => a - b);
  const across: number[] = [];
  for (const w of cuts) {
    const last = across[across.length - 1];
    if (last !== undefined && w - last < 0.02) continue;
    if (last !== undefined) {
      const pieces = Math.ceil((w - last) / 1.25);
      for (let s = 1; s < pieces; s++) across.push(last + ((w - last) * s) / pieces);
    }
    across.push(w);
  }
  const cols = across.length - 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  const uv1s: number[] = [];
  const indices: number[] = [];
  const round = (v: number): number => Math.round(v * 100) / 100;
  profile.forEach(([outBase, drop]) => {
    // 1 at the sheet's bottom, 0.8 m under the pool: the pool's surface is ~0.95
    const down = Math.max(0, Math.min(1, drop / (h + 0.8)));
    // the upper edge's current on the level rows, speeding up to 4 m/s over the roll
    const [flowU, flowV] = fallCurrent(fall, drop <= 0 ? FALL_LIP_SPEED : Math.min(4, FALL_LIP_SPEED + (4 - FALL_LIP_SPEED) * (drop / lastDrop)));
    for (const w of across) {
      const centre = 1 - ((w - mid) / halfSpan) ** 2;
      // the thrown sheet bulges: the middle carries furthest out (the roll
      // is the same all along the brink, so the top row stays on the cut line)
      const out = outBase <= lastOut ? outBase : lastOut + (outBase - lastOut) * (0.78 + 0.3 * Math.max(0, centre));
      positions.push(round(lx + fall.dirX * out + px * w), round(fall.top - drop), round(lz + fall.dirZ * out + pz * w));
      uvs.push(flowU, flowV);
      uv1s.push(Math.round(((w - lo) / (hi - lo)) * 1e4) / 1e4, Math.round(down * 1e4) / 1e4);
    }
  });
  for (let j = 0; j + 1 < profile.length; j++) {
    for (let c = 0; c < cols; c++) {
      const a = j * (cols + 1) + c;
      const b = a + 1;
      const d = a + cols + 1;
      const e = d + 1;
      // faces downstream
      indices.push(a, b, d, b, e, d);
    }
  }
  return {
    name: `${fall.river} falls`,
    parent: null,
    tags: ["water", "waterfall"],
    components: {
      transform: { position: [0, 0, 0] },
      mesh: {
        source: { kind: "surface", positions, indices, uvs, uv1s },
        material,
        static: false,
        castShadow: false,
        receiveShadow: false,
      },
    },
  };
}

/** The parameter range [t0, t1] of segment a-b inside the rect (Liang-Barsky), or null. */
function clipSegmentToRect(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const checks: [number, number][] = [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dz, a[2] - z0],
    [dz, z1 - a[2]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

/** A clipped run of a polyline, with per-point scalars (a width, an arc length) interpolated alongside. */
interface ClippedRun {
  points: [number, number, number][];
  /** One array per input channel, parallel to `points`. */
  values: number[][];
  /** Input segment the run starts on, and where along it (0 = at that segment's first point). */
  startSegment: number;
  startT: number;
  /** Input segment the run ends on, and where along it (1 = at that segment's second point). */
  endSegment: number;
  endT: number;
}

/**
 * Cut a 3D polyline into the runs lying inside the rect, ends interpolated
 * onto its border. Each `channels` array (one value per input point) is
 * interpolated the same way, so a ribbon's width is continuous across the
 * cell seam. The segment indices say which input points a run touches, so a
 * caller can hand it the neighbours beyond its ends.
 */
export function clipPolylineToRect(
  line: readonly (readonly [number, number, number])[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  channels: readonly (readonly number[])[] = [],
): ClippedRun[] {
  const runs: ClippedRun[] = [];
  const empty = (): ClippedRun => ({
    points: [],
    values: channels.map(() => []),
    startSegment: 0,
    startT: 0,
    endSegment: 0,
    endT: 0,
  });
  let run = empty();
  const lerp = (a: readonly [number, number, number], b: readonly [number, number, number], t: number): [number, number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const pushValues = (i: number, t: number): void => {
    channels.forEach((values, c) => {
      const va = values[i]!;
      const vb = values[i + 1]!;
      run.values[c]!.push(va + (vb - va) * t);
    });
  };
  const same = (p: [number, number, number], q: [number, number, number]): boolean =>
    Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[2] - q[2]) < 1e-6;
  const flush = (): void => {
    if (run.points.length > 1) runs.push(run);
    run = empty();
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const span = clipSegmentToRect(a, b, x0, z0, x1, z1);
    if (!span) {
      flush();
      continue;
    }
    const [t0, t1] = span;
    const start = lerp(a, b, t0);
    const end = lerp(a, b, t1);
    if (run.points.length === 0 || !same(run.points[run.points.length - 1]!, start)) {
      flush();
      run.points.push(start);
      pushValues(i, t0);
      run.startSegment = i;
      run.startT = t0;
    }
    if (!same(run.points[run.points.length - 1]!, end)) {
      run.points.push(end);
      pushValues(i, t1);
    }
    run.endSegment = i;
    run.endT = t1;
    if (t1 < 1) flush();
  }
  flush();
  return runs;
}

/**
 * Build the chunk document for one cell of a generated world.
 *
 * Pure and deterministic: same field + same cell = the same document, every
 * time, in Node and in the browser. That is what lets the worldgen CLI reason
 * about a cell the player is standing in without the two ever exchanging data.
 */
export function voxelChunkDoc(
  field: WorldField,
  world: string,
  cx: number,
  cz: number,
  options: VoxelChunkOptions = {},
): ChunkDoc {
  const recipe = field.recipe;
  const entities: ChunkDoc["entities"] = {};

  const terrainComponents: Record<string, unknown> = {
    transform: { position: [0, 0, 0] },
    mesh: {
      source: {
        kind: "voxel",
        world,
        cell: [cx, cz],
        ...(options.lodStep && options.lodStep > 1 ? { lodStep: options.lodStep } : {}),
        ...(options.mesher && options.mesher !== "mc" ? { mesher: options.mesher } : {}),
      },
      ...(options.material ?? recipe.material ? { material: options.material ?? recipe.material } : {}),
      // NOT `static: true`, which would opt the cell into static draw-call
      // batching. That exists to collapse hundreds of small props into one
      // call; a terrain cell is already one call, and merging cells together
      // would only cost per-cell frustum culling. HLOD is unaffected — the
      // supercell assembler decides by what an entity IS, not by this flag.
      static: false,
      castShadow: options.terrainCastShadow ?? false,
      receiveShadow: true,
    },
  };
  if (options.collision !== false) {
    terrainComponents["collider"] = { shape: "trimesh" };
  }
  entities[VOXEL_TERRAIN_ID] = {
    name: `terrain ${cx}_${cz}`,
    parent: null,
    tags: ["terrain", "voxel"],
    components: terrainComponents,
  };

  if (options.scatter !== false && recipe.scatter.length > 0) {
    const usable = recipe.scatter.map((rule) => scatterUsable(rule, options.assetExists));
    // nothing usable at all? skip the scatter solve entirely rather than
    // running the (not free) lattice sweep to throw every result away
    if (usable.some(Boolean)) {
      for (const instance of scatterCell(field, cx, cz, options)) {
        if (!usable[instance.ruleIndex]) continue;
        const rule = recipe.scatter[instance.ruleIndex];
        if (!rule) continue;
        entities[instance.id] = propEntity(rule, instance);
      }
    }
  }

  if (options.water !== false && recipe.waterMaterial) {
    waterEntities(field, cx, cz, recipe.waterMaterial, entities, options.lodStep);
    // mist only near: an HLOD far cell is a kilometre off
    if (!(options.lodStep && options.lodStep > 1)) mistEntities(field, cx, cz, entities);
    fallSiteRocks(field, cx, cz, entities, options);
  }
  if (recipe.features.bridges.length > 0) bridgeEntities(field, cx, cz, entities);

  // POIs are authored points, not scattered ones — they belong to whichever
  // cell contains them and carry their own prefab and yaw.
  for (const poi of recipe.features.pois) {
    const pcx = Math.floor(poi.position[0] / recipe.cellSize);
    const pcz = Math.floor(poi.position[2] / recipe.cellSize);
    if (pcx !== cx || pcz !== cz || !poi.prefab) continue;
    if (options.assetExists && !options.assetExists(poi.prefab, "prefab")) continue;
    const half = poi.rotationY / 2;
    entities[`poi_${poi.id}`] = {
      name: poi.id,
      parent: null,
      tags: ["poi", poi.kind, ...poi.tags],
      components: {
        transform: {
          position: [
            poi.position[0] - cx * recipe.cellSize,
            poi.position[1],
            poi.position[2] - cz * recipe.cellSize,
          ],
          rotation: [0, Math.sin(half), 0, Math.cos(half)],
        },
        prefab: { prefabId: poi.prefab, props: {}, overrides: [] },
      },
    };
  }

  return { version: 1, entities };
}

/**
 * Placeholder bridges for one cell: a deck slab from abutment to abutment
 * (a `path` ribbon with thickness, clipped to the cell like the water) and
 * a box pier every few metres down to the river bed. Each carries a
 * collider so the crossing is walkable the moment the world streams in.
 * A WFC bridge builder replaces these by reading `features.bridges`; the
 * abutments and `deckY` are the contract, and the roads on both banks
 * already end at them.
 */
function bridgeEntities(field: WorldField, cx: number, cz: number, entities: ChunkDoc["entities"]): void {
  const recipe = field.recipe;
  const size = recipe.cellSize;
  const x0 = cx * size;
  const z0 = cz * size;
  const x1 = x0 + size;
  const z1 = z0 + size;
  for (const bridge of recipe.features.bridges as readonly BridgeDoc[]) {
    const [a, b] = bridge.points;
    const material = bridge.material ?? recipe.bridgeMaterial;
    if (!material) continue;
    const underside = bridge.deckY - bridge.thickness;
    // the deck: a slab whose top is the road surface, extended a metre into
    // each bank so it never hangs short of the abutment
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const span = Math.hypot(dx, dz);
    if (span < 1) continue;
    const ux = dx / span;
    const uz = dz / span;
    const line: [number, number, number][] = [
      [a[0] - ux, underside, a[1] - uz],
      [b[0] + ux, underside, b[1] + uz],
    ];
    const runs = clipPolylineToRect(line, x0, z0, x1, z1);
    runs.forEach((run, r) => {
      if (run.points.length < 2) return;
      entities[`bridge_${bridge.id}_${r}`] = {
        name: `${bridge.id} deck`,
        parent: null,
        tags: ["bridge", "deck"],
        components: {
          transform: { position: [0, 0, 0] },
          mesh: {
            source: {
              kind: "path",
              points: run.points.map(([px, py, pz]) => [px - x0, py, pz - z0] as [number, number, number]),
              closed: false,
              crossSection: "ribbon",
              width: bridge.width,
              thickness: Math.max(0.1, bridge.thickness),
              doubleSided: false,
              radius: 0.15,
              radialSegments: 6,
              segmentsPerSpan: 1,
              trim: [0, 0],
            },
            material,
            static: true,
            castShadow: true,
            receiveShadow: true,
          },
          collider: { shape: "trimesh" },
        },
      };
    });
    // piers: from the ground (the river bed) up into the deck, at most
    // eight metres apart, none within three of an abutment
    if (span < 10) continue;
    const count = Math.max(1, Math.round((span - 6) / 8));
    const yaw = Math.atan2(ux, uz);
    const half = yaw / 2;
    for (let k = 0; k < count; k++) {
      const t = (k + 1) / (count + 1);
      const px = a[0] + dx * t;
      const pz = a[1] + dz * t;
      if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue;
      const ground = field.height(px, pz) - 0.5;
      const h = underside + 0.05 - ground;
      if (h < 0.5) continue;
      const w = Math.min(bridge.width * 0.6, 2.4);
      entities[`bridge_${bridge.id}_pier${k}`] = {
        name: `${bridge.id} pier`,
        parent: null,
        tags: ["bridge", "pier"],
        components: {
          transform: {
            position: [px - x0, ground + h / 2, pz - z0],
            rotation: [0, Math.sin(half), 0, Math.cos(half)],
          },
          mesh: {
            source: { kind: "primitive", shape: "box", size: [w, h, Math.max(0.8, w * 0.45)] },
            material,
            static: true,
            castShadow: true,
            receiveShadow: true,
          },
          collider: { shape: "box", size: [w, h, Math.max(0.8, w * 0.45)] },
        },
      };
    }
  }
}

/** Chunk options straight from a scene's `voxelWorld` component. */
export function voxelChunkOptionsFrom(data: VoxelWorldData): VoxelChunkOptions {
  return {
    scatter: data.scatter,
    collision: data.collision,
    colliderLodStep: data.colliderLodStep,
    material: data.material,
    terrainCastShadow: data.terrainCastShadow,
    mesher: data.mesher,
  };
}

/** Cell coordinates covering a world-space XZ rectangle, for CLI/preview sweeps. */
export function cellsInRect(
  cellSize: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let cz = Math.floor(z0 / cellSize); cz <= Math.floor(z1 / cellSize); cz++) {
    for (let cx = Math.floor(x0 / cellSize); cx <= Math.floor(x1 / cellSize); cx++) {
      out.push([cx, cz]);
    }
  }
  return out;
}
