import type { EntityId } from "./ids.js";
import type { EntityDoc, SceneDoc } from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";
import type { AssetLibrary } from "./assets.js";
import { applyOps, type Op } from "./ops.js";
import { snapPlacementOps } from "./placement.js";
import type { PlacementData } from "./components/placement.js";
import type { Vec3 } from "./math.js";

/**
 * Scatter — intent-level prop dressing. "Twenty crates and rocks in this
 * room, clutter toward the walls" becomes one deterministic ops batch, with
 * EVERY placement routed through the real placement solver
 * (`snapPlacementOps`): seeded Poisson-disc darts choose WHERE, the solver
 * decides HOW each prop actually meets the floor (raycast against real
 * geometry, sink, embed, rotation jitter), and anything the solver cannot
 * support is dropped, never faked.
 *
 * Vignettes need no special casing: a vignette is just a prefab whose root
 * carries richer `placement` metadata — scatter spawns the instance, prefab
 * expansion surfaces the root's placement component, and the solver reads it
 * like any other prop's.
 *
 * Pure and deterministic: same doc + options => byte-identical ops. Never
 * `Math.random`.
 */

// ---------------------------------------------------------------- rng
// Copied from placement.ts (not exported there): fnv1a + mulberry32, the
// engine's standard seeded-PRNG pair. If placement.ts ever exports these,
// delete the copies and import instead.

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG, identical in browser and Node. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- polygon

/** Shoelace area of an XZ polygon (absolute — winding-agnostic). */
export function polygonArea(polygon: readonly (readonly [number, number])[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}

/** Even-odd point-in-polygon test in the XZ plane (winding-agnostic). */
export function pointInPolygon(x: number, z: number, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!;
    const [xj, zj] = polygon[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from an XZ point to the polygon's nearest edge segment. */
export function polygonEdgeDistance(x: number, z: number, polygon: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i]!;
    const [bx, bz] = polygon[(i + 1) % polygon.length]!;
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lenSq));
    const px = ax + dx * t;
    const pz = az + dz * t;
    best = Math.min(best, Math.hypot(x - px, z - pz));
  }
  return best;
}

// ---------------------------------------------------------------- options

/** One row of a scatter table: what can be placed and how much room it claims. */
export interface ScatterEntry {
  /** Spawn an instance of this prefab (vignettes: prefabs whose root carries placement metadata). */
  prefabId?: string;
  /** OR spawn a copy of this entity template (a mesh prop). Its transform position is overwritten by the dart. */
  entity?: EntityDoc;
  /** Relative pick frequency (> 0). */
  weight: number;
  /**
   * Claim-disc radius in metres. No two placements' discs overlap. Size it to
   * cover the prop's footprint so a neighbour's snap ray can't land on it.
   */
  radius: number;
  /**
   * Placement overrides merged over the scatter default
   * `{ snap: "ground", rotJitter: "y" }` (rocks: `{ rotJitter: "full",
   * embed: [0.15, 0.45] }`). For a prefab entry with NO overrides whose root
   * already carries a `placement` component, scatter attaches nothing and the
   * prefab's own metadata drives the solve.
   */
  placement?: Partial<PlacementData>;
}

export interface ScatterRegion {
  /** World-space XZ footprint (CCW). Darts land strictly inside it. */
  polygon: [number, number][];
  /** Approximate floor height; darts spawn ~1m above it and the solver casts down. */
  y: number;
}

export interface ScatterOptions {
  region: ScatterRegion;
  table: ScatterEntry[];
  /** Exact number of placements to attempt. */
  count?: number;
  /** OR placements per square metre of the region (count = round(density * area)). */
  density?: number;
  /** Determinism seed — drives darts, entry picks, and the solver's jitter. */
  seed: number;
  /**
   * 0..1: fraction of darts biased to land within 1.5m of the polygon edge,
   * because human clutter accumulates along walls. Default 0.
   */
  wallBias?: number;
  /** Extra floor on inter-claim distance (metres); the claim radii already apply. */
  minSpacing?: number;
  /** Needed to expand prefab entries into support/placement metadata for the solver. */
  assets?: AssetLibrary;
}

export interface ScatterPlacement {
  id: EntityId;
  /** Index into the scatter table. */
  entry: number;
  /** Final world position after the placement solve (spawned at scene root, so local == world). */
  position: Vec3;
  radius: number;
}

export interface ScatterDrop {
  id: EntityId;
  entry: number;
  /** Currently always "no-support": the solver found nothing under the dart. */
  reason: string;
  /** The dart position that failed. */
  at: Vec3;
}

export interface ScatterReport {
  /** Placements attempted (count, or density * area). */
  requested: number;
  /** Region polygon area in m². */
  area: number;
  /** Total dart throws, including rejected ones. */
  attempts: number;
  /** Slots for which no non-overlapping in-polygon dart was found. */
  unplaced: number;
  placements: ScatterPlacement[];
  dropped: ScatterDrop[];
}

export interface ScatterResult {
  /** One combined batch: add-entity ops with FINAL solved transforms baked in. */
  ops: Op[];
  placed: number;
  dropped: number;
  report: ScatterReport;
}

// ---------------------------------------------------------------- scatter

const WALL_BAND = 1.5; // metres from the polygon edge that "wall bias" targets
const SPAWN_LIFT = 1; // darts spawn this far above region.y; the solver casts down
const ATTEMPTS_PER_SLOT = 30;

interface Dart {
  x: number;
  z: number;
  entry: number;
  radius: number;
}

/**
 * Scatter props/prefabs across a region, every placement settled by the real
 * placement solver. Returns one clean add-entity ops batch (final transforms
 * already baked — internally the batch is applied to a scratch doc, solved
 * with `snapPlacementOps`, and only supported placements survive), plus a
 * machine-readable report of what landed where and what was dropped.
 */
export function scatterOps(
  doc: SceneDoc,
  registry: ComponentRegistry,
  options: ScatterOptions,
): ScatterResult {
  const { region, table } = options;
  if (region.polygon.length < 3) throw new Error("scatterOps: region.polygon needs at least 3 points");
  if (table.length === 0) throw new Error("scatterOps: empty scatter table");
  for (const [i, entry] of table.entries()) {
    if (!(entry.weight > 0)) throw new Error(`scatterOps: table[${i}].weight must be > 0`);
    if (!(entry.radius >= 0)) throw new Error(`scatterOps: table[${i}].radius must be >= 0`);
    const hasPrefab = typeof entry.prefabId === "string";
    const hasEntity = entry.entity !== undefined;
    if (hasPrefab === hasEntity) {
      throw new Error(`scatterOps: table[${i}] must set exactly one of prefabId or entity`);
    }
  }
  const area = polygonArea(region.polygon);
  const requested =
    options.count ?? (options.density !== undefined ? Math.max(0, Math.round(options.density * area)) : undefined);
  if (requested === undefined) throw new Error("scatterOps: provide count or density");
  const wallBias = Math.min(1, Math.max(0, options.wallBias ?? 0));
  const minSpacing = options.minSpacing ?? 0;

  // dart stream seeded off the caller's seed alone; the solver re-seeds per
  // entity id (fnv1a(id) ^ seed) exactly like a hand-run snap would.
  const rng = mulberry32((options.seed >>> 0) ^ fnv1a("scatter"));

  const totalWeight = table.reduce((sum, entry) => sum + entry.weight, 0);
  const pickEntry = (): number => {
    let r = rng() * totalWeight;
    for (let i = 0; i < table.length; i++) {
      r -= table[i]!.weight;
      if (r <= 0) return i;
    }
    return table.length - 1;
  };

  // polygon bounds + perimeter table for edge-biased sampling
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [px, pz] of region.polygon) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }
  const edgeLengths: number[] = [];
  let perimeter = 0;
  for (let i = 0; i < region.polygon.length; i++) {
    const a = region.polygon[i]!;
    const b = region.polygon[(i + 1) % region.polygon.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    edgeLengths.push(len);
    perimeter += len;
  }

  const sampleInterior = (): [number, number] | null => {
    for (let i = 0; i < 20; i++) {
      const x = minX + (maxX - minX) * rng();
      const z = minZ + (maxZ - minZ) * rng();
      if (pointInPolygon(x, z, region.polygon)) return [x, z];
    }
    return null;
  };

  const sampleNearEdge = (): [number, number] | null => {
    let t = rng() * perimeter;
    let edge = 0;
    while (edge < edgeLengths.length - 1 && t > edgeLengths[edge]!) {
      t -= edgeLengths[edge]!;
      edge++;
    }
    const a = region.polygon[edge]!;
    const b = region.polygon[(edge + 1) % region.polygon.length]!;
    const len = edgeLengths[edge]!;
    if (len < 1e-9) return null;
    const f = Math.min(1, t / len);
    const ex = a[0] + (b[0] - a[0]) * f;
    const ez = a[1] + (b[1] - a[1]) * f;
    // inward offset: try both edge normals, keep the one inside the polygon
    // (winding-agnostic — CCW is the documented convention but not required)
    const nx = (b[1] - a[1]) / len;
    const nz = -(b[0] - a[0]) / len;
    const d = 0.05 + rng() * (WALL_BAND - 0.05);
    for (const sign of [1, -1]) {
      const x = ex + nx * d * sign;
      const z = ez + nz * d * sign;
      if (pointInPolygon(x, z, region.polygon)) return [x, z];
    }
    return null;
  };

  // ---- Poisson-disc dart throwing with per-entry claim discs
  const darts: Dart[] = [];
  let attempts = 0;
  let unplaced = 0;
  for (let slot = 0; slot < requested; slot++) {
    const entryIndex = pickEntry();
    const radius = table[entryIndex]!.radius;
    let found = false;
    for (let a = 0; a < ATTEMPTS_PER_SLOT && !found; a++) {
      attempts++;
      const p = rng() < wallBias ? sampleNearEdge() : sampleInterior();
      if (!p) continue;
      const [x, z] = p;
      let clear = true;
      for (const d of darts) {
        const need = Math.max(d.radius + radius, minSpacing);
        if (Math.hypot(d.x - x, d.z - z) < need) {
          clear = false;
          break;
        }
      }
      if (clear) {
        darts.push({ x, z, entry: entryIndex, radius });
        found = true;
      }
    }
    if (!found) unplaced++;
  }

  // ---- deterministic ids that cannot collide with the doc or each other
  const used = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = base;
    let k = 2;
    while (id in doc.entities || used.has(id)) id = `${base}~${k++}`;
    used.add(id);
    return id;
  };

  const spawns = darts.map((dart, i) => {
    const entry = table[dart.entry]!;
    const label = entry.prefabId ?? entry.entity!.name;
    const id = uniqueId(`scatter-${options.seed >>> 0}-${i}-${slug(label)}`);
    const position: Vec3 = [r6(dart.x), r6(region.y + SPAWN_LIFT), r6(dart.z)];
    return { id, dart, entity: buildSpawnEntity(entry, position, options.assets) };
  });

  // ---- route the whole batch through the real placement solver on a scratch doc
  const addOps: Op[] = spawns.map((s) => ({ op: "add-entity", id: s.id, entity: s.entity }));
  const scratch = applyOps(doc, addOps, registry).doc;
  const snap = snapPlacementOps(scratch, registry, spawns.map((s) => s.id), {
    assets: options.assets,
    seed: options.seed,
  });
  const settled = applyOps(scratch, snap.ops, registry).doc;
  const resultOf = new Map(snap.results.map((r) => [r.id, r]));

  const ops: Op[] = [];
  const placements: ScatterPlacement[] = [];
  const dropped: ScatterDrop[] = [];
  for (const spawn of spawns) {
    const result = resultOf.get(spawn.id);
    const action = result?.action ?? "missing";
    if (action === "no-support" || action === "missing") {
      dropped.push({
        id: spawn.id,
        entry: spawn.dart.entry,
        reason: "no-support",
        at: [r6(spawn.dart.x), r6(region.y + SPAWN_LIFT), r6(spawn.dart.z)],
      });
      continue;
    }
    // snapped / unchanged / skipped-none (an explicit snap:"none" opts out on purpose)
    const entity = structuredClone(settled.entities[spawn.id]!);
    const transform = entity.components["transform"] as { position: Vec3 };
    ops.push({ op: "add-entity", id: spawn.id, entity });
    placements.push({
      id: spawn.id,
      entry: spawn.dart.entry,
      position: [...transform.position],
      radius: spawn.dart.radius,
    });
  }

  return {
    ops,
    placed: placements.length,
    dropped: dropped.length,
    report: { requested, area: r6(area), attempts, unplaced, placements, dropped },
  };
}

// ---------------------------------------------------------------- spawn building

const SCATTER_PLACEMENT_DEFAULTS: Partial<PlacementData> = { snap: "ground", rotJitter: "y" };

function buildSpawnEntity(entry: ScatterEntry, position: Vec3, assets?: AssetLibrary): EntityDoc {
  if (entry.entity) {
    const template = structuredClone(entry.entity);
    const components = { ...template.components };
    const transform = (components["transform"] ?? {}) as Record<string, unknown>;
    components["transform"] = { ...transform, position };
    const templatePlacement = (components["placement"] ?? {}) as Record<string, unknown>;
    components["placement"] = {
      ...SCATTER_PLACEMENT_DEFAULTS,
      ...templatePlacement,
      ...(entry.placement ?? {}),
    };
    return {
      name: template.name,
      parent: null,
      tags: withScatterTag(template.tags),
      components,
    };
  }

  const prefabId = entry.prefabId!;
  const components: Record<string, unknown> = {
    transform: { position },
    prefab: { prefabId },
  };
  if (entry.placement) {
    components["placement"] = { ...SCATTER_PLACEMENT_DEFAULTS, ...entry.placement };
  } else if (!prefabRootHasPlacement(assets, prefabId)) {
    components["placement"] = { ...SCATTER_PLACEMENT_DEFAULTS };
  }
  // else: a vignette — the prefab root's own placement metadata drives the
  // solve (expansion surfaces it on the instance), and we don't clobber it.
  return { name: prefabId, parent: null, tags: withScatterTag([]), components };
}

function prefabRootHasPlacement(assets: AssetLibrary | undefined, prefabId: string): boolean {
  const prefab = assets?.getPrefab(prefabId);
  if (!prefab) return false;
  const root = prefab.entities[prefab.root];
  return root !== undefined && "placement" in root.components;
}

function withScatterTag(tags: readonly string[] | undefined): string[] {
  const out = [...(tags ?? [])];
  if (!out.includes("scatter")) out.push("scatter");
  return out;
}

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > 0 ? s.slice(0, 24) : "prop";
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
