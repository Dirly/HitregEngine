import type { EntityId } from "./ids.js";
import type { SceneDoc } from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";
import type { AssetLibrary } from "./assets.js";
import type { Op } from "./ops.js";
import { expandScene } from "./prefab.js";
import { worldTransforms, type Vec3 } from "./math.js";
import { collectSceneTriangles, raycastTriangles, type TriangleSoup } from "./placement.js";

/**
 * Water as CONTAINED volumes, not floating sheets. `waterFillOps` fills a
 * region (a basin, a channel) with a surface plane; `lintWater` then walks
 * every water surface's EDGES and demands each edge point be embedded in
 * solid geometry — an edge hanging in open air is "levitating water", the
 * defect the seal verifier can't see because the sheet itself is sealed
 * against nothing.
 *
 * Pure functions over scene docs producing ops/findings; geometry comes from
 * the same triangle collection the placement solver uses.
 */

// ---------------------------------------------------------------- fill

export type WaterRegion =
  | { x0: number; z0: number; x1: number; z1: number }
  | { polygon: [number, number][] };

export interface WaterFillOptions {
  region: WaterRegion;
  /** World Y of the water surface. */
  surfaceY: number;
  /** Material asset GUID for the surface (a water material). */
  material: string;
  /** Entity name (default "water"); also seeds the deterministic entity id. */
  name?: string;
}

export interface WaterFillReport {
  /** The rect actually emitted (polygon regions use their bounding rect in v1). */
  rect: { x0: number; z0: number; x1: number; z1: number };
  /**
   * The requested polygon, recorded verbatim when the region was a polygon —
   * v1 emits its bounding rect, so a later pass (or a linter reading this
   * report) can tighten the surface to the true footprint.
   */
  polygon?: [number, number][];
  surfaceY: number;
  /** Rect area in m². */
  area: number;
}

export interface WaterFillResult {
  ops: Op[];
  /** Id of the emitted water-surface entity. */
  id: EntityId;
  report: WaterFillReport;
}

/**
 * Emit a water surface filling the region at `surfaceY`: one `plane`
 * primitive (flat in XZ), no collider, tagged `["water"]`, lightly segmented
 * so a water shader has vertices to move. Polygon regions emit the bounding
 * rect for v1 (the polygon is recorded in the report). Deterministic; the
 * entity id derives from `name` and never collides with existing entities.
 */
export function waterFillOps(
  doc: SceneDoc,
  _registry: ComponentRegistry,
  options: WaterFillOptions,
): WaterFillResult {
  const region = options.region;
  let rect: { x0: number; z0: number; x1: number; z1: number };
  let polygon: [number, number][] | undefined;
  if ("polygon" in region) {
    if (region.polygon.length < 3) throw new Error("waterFillOps: region.polygon needs at least 3 points");
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [px, pz] of region.polygon) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }
    rect = { x0: minX, z0: minZ, x1: maxX, z1: maxZ };
    polygon = region.polygon.map(([px, pz]) => [px, pz]);
  } else {
    rect = {
      x0: Math.min(region.x0, region.x1),
      z0: Math.min(region.z0, region.z1),
      x1: Math.max(region.x0, region.x1),
      z1: Math.max(region.z0, region.z1),
    };
  }
  const width = rect.x1 - rect.x0;
  const depth = rect.z1 - rect.z0;
  if (!(width > 0) || !(depth > 0)) throw new Error("waterFillOps: region has zero area");

  const name = options.name ?? "water";
  let id = slug(name);
  let k = 2;
  while (id in doc.entities) id = `${slug(name)}~${k++}`;

  const segments: [number, number] = [
    Math.min(32, Math.max(1, Math.ceil(width / 2))),
    Math.min(32, Math.max(1, Math.ceil(depth / 2))),
  ];

  const ops: Op[] = [
    {
      op: "add-entity",
      id,
      entity: {
        name,
        parent: null,
        tags: ["water"],
        components: {
          transform: { position: [r6((rect.x0 + rect.x1) / 2), r6(options.surfaceY), r6((rect.z0 + rect.z1) / 2)] },
          mesh: {
            source: { kind: "primitive", shape: "plane", size: [r6(width), 1, r6(depth)], segments },
            material: options.material,
            castShadow: false,
          },
          // no collider: water is a surface, not a solid
        },
      },
    },
  ];

  return {
    ops,
    id,
    report: {
      rect: { x0: r6(rect.x0), z0: r6(rect.z0), x1: r6(rect.x1), z1: r6(rect.z1) },
      ...(polygon ? { polygon } : {}),
      surfaceY: options.surfaceY,
      area: r6(width * depth),
    },
  };
}

// ---------------------------------------------------------------- lint

export interface WaterFinding {
  /** Source-doc entity id of the offending water surface. */
  entity: EntityId;
  message: string;
  /** World point on the unsupported edge (pin/camera target). */
  at: Vec3;
}

export interface WaterLintOptions {
  /** Needed to expand prefab instances into solid support geometry. */
  assets?: AssetLibrary;
  /** Metres between edge sample points. Default 0.5. */
  step?: number;
  /** An edge point with no solid face within this horizontal distance is levitating. Default 0.35. */
  maxGap?: number;
  maxFindings?: number;
}

const EDGE_DIP = 0.02; // sample just below the surface so a wall exactly reaching it still counts
const EDGE_INSET = 0.05; // cast from slightly inside the water so a wall flush with the edge is hit

/**
 * Verify every water surface is CONTAINED: for each entity tagged `"water"`
 * (or named *water*), sample points along its surface edges (every `step`
 * metres) and require each to be embedded in solid geometry — a horizontal
 * raycast outward at surface height hits a face within `maxGap`, or the
 * point lies inside some solid's AABB. An edge point hanging in open air is
 * a "levitating water" finding carrying the world point to look at.
 */
export function lintWater(
  doc: SceneDoc,
  registry: ComponentRegistry,
  options: WaterLintOptions = {},
): WaterFinding[] {
  const step = options.step ?? 0.5;
  const maxGap = options.maxGap ?? 0.35;
  const maxFindings = options.maxFindings ?? 200;
  const expanded = options.assets ? expandScene(doc, options.assets, registry) : doc;
  const world = worldTransforms(expanded);
  const soups = collectSceneTriangles(expanded, world);

  // findings reference source-doc entities (prefab children -> instance root)
  const sourceOf = (id: EntityId): EntityId => (id in doc.entities ? id : id.split(":")[0]!);
  const isWaterEntity = (id: EntityId): boolean => {
    const entity = expanded.entities[id];
    if (!entity) return false;
    return entity.tags.includes("water") || /water/i.test(entity.name);
  };

  // group water soups by source entity; everything else is solid support
  const waterAabbs = new Map<EntityId, { min: Vec3; max: Vec3 }>();
  const solids: TriangleSoup[] = [];
  for (const soup of soups) {
    if (isWaterEntity(soup.entity) || isWaterEntity(sourceOf(soup.entity))) {
      const src = sourceOf(soup.entity);
      const box = waterAabbs.get(src);
      if (!box) {
        waterAabbs.set(src, { min: [...soup.aabb.min], max: [...soup.aabb.max] });
      } else {
        for (let a = 0; a < 3; a++) {
          if (soup.aabb.min[a]! < box.min[a]!) box.min[a] = soup.aabb.min[a]!;
          if (soup.aabb.max[a]! > box.max[a]!) box.max[a] = soup.aabb.max[a]!;
        }
      }
    } else {
      solids.push(soup);
    }
  }

  const insideSolidAabb = (x: number, y: number, z: number): boolean => {
    for (const solid of solids) {
      if (
        x >= solid.aabb.min[0] - 1e-6 && x <= solid.aabb.max[0] + 1e-6 &&
        y >= solid.aabb.min[1] - 1e-6 && y <= solid.aabb.max[1] + 1e-6 &&
        z >= solid.aabb.min[2] - 1e-6 && z <= solid.aabb.max[2] + 1e-6
      ) {
        return true;
      }
    }
    return false;
  };

  const findings: WaterFinding[] = [];
  for (const [entity, aabb] of waterAabbs) {
    const surfaceY = aabb.max[1];
    const y = surfaceY - EDGE_DIP;
    // the surface's edge rectangle in XZ, walked edge by edge with its outward normal
    const edges: { a: [number, number]; b: [number, number]; out: [number, number] }[] = [
      { a: [aabb.min[0], aabb.min[2]], b: [aabb.max[0], aabb.min[2]], out: [0, -1] }, // -Z edge
      { a: [aabb.max[0], aabb.min[2]], b: [aabb.max[0], aabb.max[2]], out: [1, 0] }, // +X edge
      { a: [aabb.max[0], aabb.max[2]], b: [aabb.min[0], aabb.max[2]], out: [0, 1] }, // +Z edge
      { a: [aabb.min[0], aabb.max[2]], b: [aabb.min[0], aabb.min[2]], out: [-1, 0] }, // -X edge
    ];
    for (const edge of edges) {
      const len = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
      if (len < 1e-9) continue;
      const n = Math.max(1, Math.ceil(len / step));
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        const px = edge.a[0] + (edge.b[0] - edge.a[0]) * f;
        const pz = edge.a[1] + (edge.b[1] - edge.a[1]) * f;
        // embedded if a horizontal outward cast (from slightly inside the
        // water) hits a solid face within maxGap...
        const origin: Vec3 = [px - edge.out[0] * EDGE_INSET, y, pz - edge.out[1] * EDGE_INSET];
        const dir: Vec3 = [edge.out[0], 0, edge.out[1]];
        const hits = raycastTriangles(solids, origin, dir, maxGap + EDGE_INSET);
        if (hits.length > 0) continue;
        // ...or the point itself sits inside some solid's AABB
        if (insideSolidAabb(px, y, pz)) continue;
        findings.push({
          entity,
          message:
            `levitating water: surface edge point (${px.toFixed(2)}, ${surfaceY.toFixed(2)}, ${pz.toFixed(2)}) ` +
            `hangs in open air — no solid within ${maxGap}m outward`,
          at: [r6(px), r6(surfaceY), r6(pz)],
        });
        if (findings.length >= maxFindings) return findings;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- helpers

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > 0 ? s.slice(0, 32) : "water";
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
