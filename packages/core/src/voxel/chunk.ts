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
import { riverBank, type WorldField } from "./field.js";
import { scatterCell, type ScatterCellOptions } from "./scatter.js";
import { smoothstep } from "./noise.js";
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
    components["collider"] = {
      shape: rule.collider,
      size: [
        rule.colliderSize[0] * instance.scale,
        rule.colliderSize[1] * instance.scale,
        rule.colliderSize[2] * instance.scale,
      ],
      offset: [0, (rule.colliderSize[1] * instance.scale) / 2, 0],
    };
  }
  return { name: instance.id, parent: null, tags: ["scatter", rule.id], components };
}

/** Sutherland-Hodgman clip of a polygon to an axis-aligned rectangle. */
function clipPolygonToRect(
  polygon: readonly (readonly [number, number])[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): [number, number][] {
  let out: [number, number][] = polygon.map((p) => [p[0], p[1]]);
  const edges: ((p: readonly [number, number]) => boolean)[] = [
    (p) => p[0] >= x0,
    (p) => p[0] <= x1,
    (p) => p[1] >= z0,
    (p) => p[1] <= z1,
  ];
  const cross = (a: readonly [number, number], b: readonly [number, number], edge: number): [number, number] => {
    // intersection of segment a-b with one of the four rect lines
    if (edge < 2) {
      const x = edge === 0 ? x0 : x1;
      const t = (x - a[0]) / (b[0] - a[0]);
      return [x, a[1] + (b[1] - a[1]) * t];
    }
    const z = edge === 2 ? z0 : z1;
    const t = (z - a[1]) / (b[1] - a[1]);
    return [a[0] + (b[0] - a[0]) * t, z];
  };
  for (let e = 0; e < 4; e++) {
    const inside = edges[e]!;
    const input = out;
    out = [];
    if (input.length === 0) break;
    let prev = input[input.length - 1]!;
    for (const cur of input) {
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur, e));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cross(prev, cur, e));
      }
      prev = cur;
    }
  }
  // drop duplicate consecutive points a clip can leave on a corner
  const clean: [number, number][] = [];
  for (const pt of out) {
    const last = clean[clean.length - 1];
    if (last && Math.abs(last[0] - pt[0]) < 1e-6 && Math.abs(last[1] - pt[1]) < 1e-6) continue;
    clean.push(pt);
  }
  if (clean.length > 1) {
    const a = clean[0]!;
    const b = clean[clean.length - 1]!;
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) clean.pop();
  }
  return clean;
}

/**
 * Push a closed polygon outward by `distance`: each vertex moves along the
 * mitred normal of its two edges, the mitre capped at twice the distance
 * so a sharp corner does not spike. Winding is detected from the signed
 * area so "outward" is outward either way round.
 */
function offsetPolygon(polygon: readonly (readonly [number, number])[], distance: number): [number, number][] {
  const n = polygon.length;
  if (n < 3 || distance === 0) return polygon.map((p) => [p[0], p[1]]);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  // for a counter-clockwise loop (positive area in this handedness) the
  // outward normal of edge (dx, dz) is (dz, -dx); flip it for the other winding
  const sign = area > 0 ? 1 : -1;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n]!;
    const cur = polygon[i]!;
    const next = polygon[(i + 1) % n]!;
    const normalOf = (a: readonly [number, number], b: readonly [number, number]): [number, number] => {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      return [(sign * dz) / len, (-sign * dx) / len];
    };
    const n0 = normalOf(prev, cur);
    const n1 = normalOf(cur, next);
    let mx = n0[0] + n1[0];
    let mz = n0[1] + n1[1];
    const mlen = Math.hypot(mx, mz);
    if (mlen < 1e-6) {
      out.push([cur[0] + n1[0] * distance, cur[1] + n1[1] * distance]);
      continue;
    }
    mx /= mlen;
    mz /= mlen;
    // mitre length = distance / cos(half angle); capped
    const cosHalf = Math.max(0.5, mx * n1[0] + mz * n1[1]);
    const reach = distance / cosHalf;
    out.push([cur[0] + mx * reach, cur[1] + mz * reach]);
  }
  return out;
}

/** Even-odd point-in-polygon on XZ pairs. */
function insidePolygonXZ(poly: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** A lake's outline: its polygon, or a 32-gon around a disc. */
function lakeOutline(lake: LakeDoc): [number, number][] {
  if (lake.polygon) return lake.polygon.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    out.push([lake.center[0] + Math.cos(a) * lake.radius, lake.center[1] + Math.sin(a) * lake.radius]);
  }
  return out;
}

/**
 * Water entities for one cell: a ribbon per river channel crossing it and a
 * flat sheet per lake overlapping it, each clipped to the cell so it streams
 * in and out with the ground it lies on.
 *
 * Lakes are emitted as ONE flat n-gon per cell (a `poly` mesh) rather than
 * as a single entity in the cell holding the centre: a big lake spans many
 * cells, and water that vanished when one particular cell unloaded while the
 * shore around it stayed would be the most visible streaming bug in the
 * world. Neighbouring sheets share their clipped edge exactly, so there is no
 * gap and no double-blended overlap between them.
 *
 * Rivers are ribbons following the bed with a control point beyond each end
 * of the cell for tangent continuity; the metre or so of overlap is under the
 * banks. A vertical drop in `bedY` gives a ribbon that falls — a waterfall
 * comes for free from the same data that carved the channel.
 */
function waterEntities(
  field: WorldField,
  cx: number,
  cz: number,
  material: string,
  entities: ChunkDoc["entities"],
): void {
  const recipe = field.recipe;
  const size = recipe.cellSize;
  const x0 = cx * size;
  const z0 = cz * size;
  const x1 = x0 + size;
  const z1 = z0 + size;

  const riverMaterial = recipe.riverMaterial ?? material;
  // the sheets as drawn (half a bank past each outline): a ribbon running
  // under one is a second water surface a hand under the first, and the two
  // wave patterns crossing drew a bright line along every sheet edge
  const sheets = (recipe.features.lakes as readonly LakeDoc[]).map((lake) => offsetPolygon(lakeOutline(lake), lake.bank * 0.75));
  const underSheet = (x: number, z: number): boolean => sheets.some((poly) => insidePolygonXZ(poly, x, z));
  // the field's rivers, not the recipe's: a hand-written river has its bed
  // solved there, and the doc in the recipe carries none
  for (const river of field.rivers) {
    if (!river.water || !river.bedY || river.bedY.length !== river.points.length) continue;
    const perDepth = river.depths && river.depths.length === river.points.length ? river.depths : null;
    const surfaceAt = (i: number): number => Math.max(0.4, (perDepth ? perDepth[i]! : river.depth) * 0.7);
    // the surface polyline, with the tapered head left dry (the carve there is
    // a trickle the ribbon would overhang)
    const along: number[] = [0];
    for (let i = 1; i < river.points.length; i++) {
      const a = river.points[i - 1]!;
      const b = river.points[i]!;
      along.push(along[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const dryUntil = river.taper * 0.5;
    const line: [number, number, number][] = [];
    const lineWidths: number[] = [];
    const lineAlong: number[] = [];
    const perPoint = river.widths && river.widths.length === river.points.length ? river.widths : null;
    for (let i = 0; i < river.points.length; i++) {
      if (along[i]! < dryUntil) continue;
      const pt = river.points[i]!;
      line.push([pt[0], river.bedY[i]! + surfaceAt(i), pt[1]]);
      lineAlong.push(along[i]!);
      // Out to the WATERLINE, not the edge of the flat bed. The bank rises
      // from the bed over `bank` metres and the surface (0.7 of the depth up)
      // crosses it about 0.63 of the way out, so a ribbon of the bed's width
      // stopped well short of the shore: a hard edge floating over a dry
      // strip of sand between the water and its bank. Past the waterline the
      // bank hides the sheet, which is the shoreline for free.
      const grow = river.taper > 0 ? smoothstep(0, river.taper, along[i]!) : 1;
      const bed = (perPoint ? perPoint[i]! : river.width) * (0.2 + 0.8 * grow);
      // to 0.75 of the bank: the waterline is at 0.63 and the levee the field
      // builds holds to 0.85, so the edge is under ground on either side
      lineWidths.push(bed + riverBank(river, perPoint ? perPoint[i]! : NaN) * (0.35 + 0.65 * grow) * 1.5 * 0.5);
    }
    // Where the river runs THROUGH a lake the ribbon stops at the shore: the
    // line is cut into pieces at the sheet's edge, each piece ending a couple
    // of metres UNDER the sheet (the crossing found by bisection along the
    // segment that enters or leaves it) so it dives beneath the lake instead
    // of drawing a second water surface across it.
    const pieces: { pts: [number, number, number][]; widths: number[]; along: number[] }[] = [];
    if (sheets.length === 0) pieces.push({ pts: line, widths: lineWidths, along: lineAlong });
    else {
      const wet = line.map((p) => underSheet(p[0], p[2]));
      /** The point on segment i-1 -> i just inside the sheet, as [point, width, along]; `entering` says which end is wet. */
      const crossing = (i: number, entering: boolean): [[number, number, number], number, number] => {
        const a = line[i - 1]!;
        const b = line[i]!;
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          const inside = underSheet(a[0] + (b[0] - a[0]) * mid, a[2] + (b[2] - a[2]) * mid);
          if (inside === entering) hi = mid;
          else lo = mid;
        }
        const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
        const t = Math.max(0, Math.min(1, entering ? hi + 2.5 / len : lo - 2.5 / len));
        return [
          [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
          lineWidths[i - 1]! + (lineWidths[i]! - lineWidths[i - 1]!) * t,
          lineAlong[i - 1]! + (lineAlong[i]! - lineAlong[i - 1]!) * t,
        ];
      };
      let current: { pts: [number, number, number][]; widths: number[]; along: number[] } | null = null;
      for (let i = 0; i < line.length; i++) {
        if (!wet[i]) {
          if (!current) {
            current = { pts: [], widths: [], along: [] };
            if (i > 0) {
              // leaving a sheet: start just under its edge
              const [p, w, s] = crossing(i, false);
              current.pts.push(p);
              current.widths.push(w);
              current.along.push(s);
            }
          }
          current.pts.push(line[i]!);
          current.widths.push(lineWidths[i]!);
          current.along.push(lineAlong[i]!);
        } else if (current) {
          // entering a sheet: end just under its edge
          const [p, w, s] = crossing(i, true);
          current.pts.push(p);
          current.widths.push(w);
          current.along.push(s);
          pieces.push(current);
          current = null;
        }
      }
      if (current) pieces.push(current);
    }
    // the current, for the water shader: a torrent on a steep reach, a
    // stroll on a flat one (the bed grade over the whole river)
    const drop = river.bedY[0]! - river.bedY[river.bedY.length - 1]!;
    const grade = along[along.length - 1]! > 0 ? drop / along[along.length - 1]! : 0;
    const flowSpeed = Math.min(3, 0.9 + 12 * Math.max(0, grade));
    pieces.forEach((piece, pieceIndex) => {
    const line = piece.pts;
    const lineWidths = piece.widths;
    const lineAlong = piece.along;
    if (line.length < 2) return;
    // Clipped EXACTLY to the cell: a run ends on the cell border, at the same
    // interpolated point its neighbour's run starts on (overlapping strips
    // from two cells were two transparent sheets at one height — z-fighting).
    // Then each run is handed the control point BEYOND each of its ends as a
    // phantom (`trim`): the Catmull-Rom tangent at a run's end point depends
    // on the point past it, and without it each cell extrapolated its own —
    // the two ribbons met at one point with two different side vectors, so
    // their edge vertices missed each other by up to half a width. That was
    // the gap along every cell seam of every river.
    const runs = clipPolylineToRect(line, x0, z0, x1, z1, [lineWidths, lineAlong]);
    runs.forEach((run, r) => {
      if (run.points.length < 2) return;
      const [widths, alongs] = run.values as [number[], number[]];
      const points3 = [...run.points];
      const widthsOut = [...widths];
      const alongOut = [...alongs];
      let trimStart = 0;
      let trimEnd = 0;
      const before = run.startT > 0 ? run.startSegment : run.startSegment - 1;
      if (before >= 0) {
        points3.unshift(line[before]!);
        widthsOut.unshift(lineWidths[before]!);
        alongOut.unshift(lineAlong[before]!);
        trimStart = 1;
      }
      const after = run.endT < 1 ? run.endSegment + 1 : run.endSegment + 2;
      if (after < line.length) {
        points3.push(line[after]!);
        widthsOut.push(lineWidths[after]!);
        alongOut.push(lineAlong[after]!);
        trimEnd = 1;
      }
      const points = points3.map(([px, py, pz]) => [px - x0, py, pz - z0] as [number, number, number]);
      entities[pieceIndex === 0 ? `water_${river.id}_${r}` : `water_${river.id}_p${pieceIndex}_${r}`] = {
        name: `${river.id} water`,
        parent: null,
        tags: ["water", "river"],
        components: {
          transform: { position: [0, 0, 0] },
          mesh: {
            source: {
              kind: "path",
              points,
              closed: false,
              crossSection: "ribbon",
              width: Math.max(...widthsOut),
              widths: widthsOut,
              thickness: 0,
              doubleSided: false,
              radius: 0.15,
              radialSegments: 6,
              segmentsPerSpan: 3,
              trim: [trimStart, trimEnd],
              flowSpeed,
              uvMetres: true,
              uvAlong: alongOut,
            },
            material: riverMaterial,
            static: false,
            castShadow: false,
            receiveShadow: false,
          },
        },
      };
    });
    });
  }

  for (const lake of recipe.features.lakes as readonly LakeDoc[]) {
    // The outline is traced on the hydrology grid (16 m cells, simplified),
    // so it sits inside the true waterline by up to a cell; drawn as-is the
    // sheet stopped short of the shore with a hard edge hanging over a dry
    // strip of bed. Pushed out by half a bank, the shore carve's own rise
    // through the surface hides the edge, which is the shoreline for free —
    // and where the ground beyond the outline is still under the surface,
    // the water shows over it, which is where water belongs.
    // A FULL bank past the outline, not half: the river carve at an inlet
    // lowers the bank band beyond the traced shore, and a sheet that stopped
    // short of that drew its foam edge in mid-air over water-level ground.
    // Wherever the ground is higher the sheet buries itself, so the margin
    // costs nothing but area.
    const outline = offsetPolygon(lakeOutline(lake), lake.bank * 0.75);
    const clipped = clipPolygonToRect(outline, x0, z0, x1, z1);
    if (clipped.length < 3) continue;
    // counter-clockwise seen from above (+Y normal): signed area in XZ, with
    // +X right and +Z toward the viewer, is negative for that winding
    let area = 0;
    for (let i = 0; i < clipped.length; i++) {
      const a = clipped[i]!;
      const b = clipped[(i + 1) % clipped.length]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (Math.abs(area) < 1) continue;
    const ordered = area > 0 ? [...clipped].reverse() : clipped;
    entities[`water_${lake.id}`] = {
      name: `${lake.id} water`,
      parent: null,
      tags: ["water", "lake"],
      components: {
        transform: { position: [0, 0, 0] },
        mesh: {
          source: {
            kind: "poly",
            vertices: ordered.map((pt) => [pt[0] - x0, lake.waterY, pt[1] - z0] as [number, number, number]),
            faces: [{ v: ordered.map((_, i) => i), mat: 0, smooth: 0 }],
            materials: [],
          },
          material: lake.material ?? material,
          static: false,
          castShadow: false,
          receiveShadow: false,
        },
      },
    };
  }
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
    waterEntities(field, cx, cz, recipe.waterMaterial, entities);
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
