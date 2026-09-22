import type { EntityId } from "./ids.js";
import type { SceneDoc } from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";
import type { AssetLibrary } from "./assets.js";
import type { Op } from "./ops.js";
import type { WaterData } from "./components/core.js";
import { expandScene } from "./prefab.js";
import { worldTransforms, type Vec3, type WorldTransform } from "./math.js";
import { collectSceneTriangles, raycastTriangles, type TriangleSoup } from "./placement.js";

/**
 * Water as CONTAINED volumes, not floating sheets. `waterFillOps` fills a
 * region (a basin, a channel) with a surface plane; `lintWater` then walks
 * every water surface's EDGES and demands each edge point be embedded in
 * solid geometry — an edge hanging in open air is "levitating water", the
 * defect the seal verifier can't see because the sheet itself is sealed
 * against nothing.
 *
 * The third part is the RUNTIME question — "is this point under water, and how
 * far?" — answered by {@link WaterIndex} over the `water` components in a
 * scene. Swimming, the underwater look and anything else that cares all read
 * that one answer, so they can never disagree about where the waterline is.
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
  /**
   * Metres of swimmable water under the surface (the `water` component's
   * `depth`). Give it the depth of the basin: a volume that reaches past the
   * bed into the room below reports water down there too.
   */
  depth?: number;
  /** false leaves the sheet visual-only — no swimming, no underwater tint. */
  swim?: boolean;
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
          // the gameplay half: the sheet is the top of a VOLUME you swim in
          // (see waterSchema). Surface omitted — the plane IS at surfaceY.
          water: {
            ...(options.depth !== undefined ? { depth: options.depth } : {}),
            ...(options.swim === false ? { swim: false } : {}),
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

// ---------------------------------------------------------------- runtime volumes

/** One authored body of water, as the runtime asks about it. */
export interface WaterVolume {
  entity: EntityId;
  /** World Y of the surface. */
  surfaceY: number;
  /** World Y the volume stops at (`surfaceY - depth`) — below this you are under the water, not in it. */
  floorY: number;
  /** Footprint in world XZ. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** False = visual only: it reports depth but nobody swims in it. */
  swim: boolean;
  /** Drift in m/s added to whatever swims here. */
  current: readonly [number, number];
  /** Per-body overrides of the underwater look. */
  color?: string;
  density?: number;
}

/** What a point is standing in. `depth` is negative in the air above the surface. */
export interface WaterSample {
  surfaceY: number;
  floorY: number;
  /** Metres of water over this point: `surfaceY - y`. Negative above the surface. */
  depth: number;
  swim: boolean;
  current: readonly [number, number];
  color?: string;
  density?: number;
  /** Entity that owns the surface, or null when it came from a procedural world. */
  entity: EntityId | null;
}

/**
 * The authored water in a scene, as volumes.
 *
 * The footprint is MEASURED off each entity's own mesh rather than declared,
 * because the alternative is two numbers that have to agree forever: an
 * author who widens the pool's plane and forgets its component gets a pool you
 * can drown beside. `water.size` overrides it for the meshes the measurement
 * cannot see — an imported GLB, a path ribbon — and for fencing a swimmable
 * area smaller than its sheet.
 *
 * `doc` should be EXPANDED (prefab instances resolved), since a pool inside a
 * prefab is the normal way to ship one.
 */
export function waterVolumes(
  doc: SceneDoc,
  world: Map<EntityId, WorldTransform> = worldTransforms(doc),
): WaterVolume[] {
  const entities: Record<EntityId, SceneDoc["entities"][string]> = {};
  const datas = new Map<EntityId, WaterData>();
  for (const [id, entity] of Object.entries(doc.entities)) {
    const data = entity.components["water"] as WaterData | undefined;
    if (!data) continue;
    datas.set(id, data);
    entities[id] = entity;
  }
  if (datas.size === 0) return [];
  // the triangle pass runs over the water entities ALONE (a scene's other
  // geometry can be millions of triangles, and none of it is water)
  const soups = collectSceneTriangles({ ...doc, entities }, world);
  const bounds = new Map<EntityId, { min: Vec3; max: Vec3 }>();
  for (const soup of soups) bounds.set(soup.entity, soup.aabb);

  const out: WaterVolume[] = [];
  for (const [id, data] of datas) {
    const at = world.get(id);
    const box = bounds.get(id);
    const centreX = at ? at.position[0] : 0;
    const centreZ = at ? at.position[2] : 0;
    let x0: number, z0: number, x1: number, z1: number;
    if (data.size) {
      x0 = centreX - data.size[0] / 2;
      x1 = centreX + data.size[0] / 2;
      z0 = centreZ - data.size[1] / 2;
      z1 = centreZ + data.size[1] / 2;
    } else if (box) {
      [x0, x1] = [box.min[0], box.max[0]];
      [z0, z1] = [box.min[2], box.max[2]];
    } else {
      // a mesh nothing can measure and no declared size: skip it rather than
      // invent a footprint — silent water the size of a guess is worse than none
      continue;
    }
    // Default the surface to the TOP of the mesh, not the entity's origin: a
    // sheet authored as a thin box (or a shaped basin) has its origin
    // somewhere in the middle, and half a metre of error at the waterline is
    // the difference between wading and swimming.
    const surfaceY = data.surfaceY ?? (box ? box.max[1] : (at ? at.position[1] : 0));
    out.push({
      entity: id,
      surfaceY,
      floorY: surfaceY - data.depth,
      x0, z0, x1, z1,
      swim: data.swim,
      current: data.current,
      ...(data.color ? { color: data.color } : {}),
      ...(data.density !== undefined ? { density: data.density } : {}),
    });
  }
  return out;
}

/**
 * Point queries over a scene's authored water.
 *
 * Deliberately a linear scan: authored bodies of water come in handfuls (a
 * dungeon's pools, a town's canal), the query runs once per swimming character
 * per tick, and a grid would be more code than the thing it indexes. A
 * PROCEDURAL world's ocean, lakes and rivers never enter here at all — they
 * are answered from the recipe (`WorldField.waterY`), which is both exact and
 * free of the thousands of streamed sheets that draw them.
 */
export class WaterIndex {
  constructor(readonly volumes: readonly WaterVolume[] = []) {}

  get empty(): boolean {
    return this.volumes.length === 0;
  }

  /**
   * The water at a point, or null where there is none. Points ABOVE a surface
   * still sample it (with a negative `depth`) so a caller can watch the
   * waterline approach — a fade that only starts once you are already under
   * has nothing left to fade.
   *
   * Where volumes overlap the HIGHEST surface wins, which is what makes a
   * cistern above a flooded cellar read correctly from inside either.
   */
  sampleAt(x: number, y: number, z: number): WaterSample | null {
    let best: WaterVolume | null = null;
    for (const v of this.volumes) {
      if (x < v.x0 || x > v.x1 || z < v.z0 || z > v.z1) continue;
      // Below the bed is not "in the water" — it is under the floor the water
      // sits on, i.e. inside solid rock or in the room beneath it. The
      // tolerance is what stops a diver who reaches the bottom from falling
      // OUT of the water: its feet then rest exactly on the floor the author
      // measured the volume to, and a hair of settling either way made the
      // lake blink out of existence around them (measured — the swimmer
      // popped to an idle clip on the bed).
      if (y < v.floorY - FLOOR_TOLERANCE) continue;
      if (best === null || v.surfaceY > best.surfaceY) best = v;
    }
    if (!best) return null;
    return {
      surfaceY: best.surfaceY,
      floorY: best.floorY,
      depth: best.surfaceY - y,
      swim: best.swim,
      current: best.current,
      ...(best.color ? { color: best.color } : {}),
      ...(best.density !== undefined ? { density: best.density } : {}),
      entity: best.entity,
    };
  }

  /** Surface height over (x, z) ignoring where the asker is vertically, or null. */
  surfaceAt(x: number, z: number): number | null {
    let best: number | null = null;
    for (const v of this.volumes) {
      if (x < v.x0 || x > v.x1 || z < v.z0 || z > v.z1) continue;
      if (best === null || v.surfaceY > best) best = v.surfaceY;
    }
    return best;
  }
}

/**
 * The runtime's one water question, over both kinds of water at once:
 * authored volumes (`water` components, via a {@link WaterIndex}) and a
 * procedural world's own ocean, lakes and rivers (via the recipe's field).
 *
 * Both hosts build it — the browser for `ctx.waterAt` and the camera's
 * submersion, the dedicated server for the body it simulates on the player's
 * behalf — because a client that thinks it is swimming while the server
 * thinks it is falling is the worst kind of desync there is: the authority
 * wins, and the player watches themselves get dragged under.
 *
 * `field` is read through a getter: a live recipe edit swaps the field object,
 * and a query holding the old one would answer about the previous world.
 */
export interface WaterQuerySources {
  /** Authored water in the scene. */
  index?: WaterIndex | null | (() => WaterIndex | null);
  /** The procedural world, if the scene has one. */
  field?: WaterField | null | (() => WaterField | null);
}

/** The slice of `WorldField` this needs — stated structurally so tests need no world. */
export interface WaterField {
  waterY(x: number, z: number): number | null;
  height(x: number, z: number): number;
  readonly worldLimit: number;
}

export function waterQuery(
  sources: WaterQuerySources,
): (x: number, y: number, z: number) => WaterSample | null {
  const index = sources.index;
  const field = sources.field;
  const indexOf: () => WaterIndex | null = typeof index === "function" ? index : () => index ?? null;
  const fieldOf: () => WaterField | null = typeof field === "function" ? field : () => field ?? null;
  return (x, y, z) => {
    const authored = indexOf()?.sampleAt(x, y, z) ?? null;
    const world = fieldOf();
    let generated: WaterSample | null = null;
    if (world && (world.worldLimit === Infinity || Math.hypot(x, z) <= world.worldLimit)) {
      const surfaceY = world.waterY(x, z);
      const bed = surfaceY === null ? 0 : world.height(x, z);
      if (surfaceY !== null && y >= bed - FLOOR_TOLERANCE) {
        // The bed is the ground the generator carved under the water, so the
        // volume ends exactly where the terrain collider starts — no pocket of
        // air at the bottom of a lake for a diver to fall through, and no
        // "water" reported inside the rock beneath it.
        generated = {
          surfaceY,
          floorY: bed,
          depth: surfaceY - y,
          swim: true,
          // A river's flow is not reported here: the recipe knows the channel's
          // direction but `waterY` answers about a POINT, and a current worth
          // pushing a swimmer with has to come from the channel it belongs to.
          // Authored water carries one; generated water does not, yet.
          current: NO_CURRENT,
          entity: null,
        };
      }
    }
    if (!authored) return generated;
    if (!generated) return authored;
    // Overlapping sources: the higher surface wins, exactly as two authored
    // volumes do — an aqueduct over a river is water at both heights, and the
    // one you are in is the one above you.
    return authored.surfaceY >= generated.surfaceY ? authored : generated;
  };
}

const NO_CURRENT: readonly [number, number] = [0, 0];

/**
 * How far under a water volume's own floor still counts as being in it.
 *
 * A body that reaches the bottom has its feet ON the bed — which is exactly
 * where an authored volume ends and where a generated one's analytic ground
 * sits, give or take whatever the marching cubes actually produced. Without
 * this, touching the bottom drops a diver out of the water entirely: back to
 * gravity, back to the walking clips, on the floor of a lake.
 */
const FLOOR_TOLERANCE = 0.5;

// ---------------------------------------------------------------- helpers

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > 0 ? s.slice(0, 32) : "water";
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
