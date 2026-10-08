/**
 * Zone budgets — what one copy of a zone will have to carry, counted from the scene before anyone plays it.
 *
 * A layer's tick cost is (mostly) what is placed where its players stand and how many creatures wake around
 * them; the scale pass (docs/hosting.md → "How many players a copy holds") measured what fits. This census
 * reads a scene and its world's zones and reports, PER ZONE:
 *
 *   entities      placed entities (root subtrees standing in the zone, children counted)
 *   colliders     collider entities among them, and the triangles of their trimeshes (streamed statics:
 *                 cooking cost and wasm memory)
 *   creatures     NPCs a spawn area will spawn there, plus authored ones
 *   crowd         the most creatures that can be awake around one spot: every pack whose area lies within
 *                 the interest radius of any spawn point or NPC, summed (what a fight there wakes)
 *
 * and judges each against a budget. The world tools run it after generating or editing a world
 * (`pnpm -F @hitreg/server zone-budget --scene <name>`), so a new world cannot bring a stall back silently.
 * A short bot run (bin/zone-budget.ts --bots) adds the tick itself.
 */

import {
  expandScene,
  getVoxelWorld,
  regionAt,
  type AssetLibrary,
  type ComponentRegistry,
  type EntityDoc,
  type RegionDoc,
  type SceneDoc,
  type SpawnAreaData,
} from "@hitreg/core";
import type { MeshGeometryData } from "@hitreg/physics";
import { populationOf } from "./spawn-areas.js";

export interface ZoneBudget {
  /** Placed entities per zone (scene content: buildings, props, NPC subtrees). */
  entities: number;
  /** Collider entities per zone. */
  colliders: number;
  /** Trimesh triangles per zone, summed over its streamed statics. */
  triangles: number;
  /** Largest single trimesh (triangles): cooked in pieces of 4096 since 2026-10-05, but its memory is whole. */
  largestTrimesh: number;
  /** Creatures awake around one spot at most (packs within the interest radius of each other). */
  crowd: number;
}

/**
 * Defaults, from the 2026-10-05 scale pass on `proving` (docs/hosting.md): a copy of a zone with these loads
 * held its marks with the measured player counts. Raise one only with a new measurement behind it.
 */
export const DEFAULT_ZONE_BUDGET: ZoneBudget = {
  entities: 6000,
  colliders: 2500,
  triangles: 1_500_000,
  largestTrimesh: 200_000,
  crowd: 60,
};

export interface ZoneCensus {
  zone: string;
  name: string;
  entities: number;
  colliders: number;
  triangles: number;
  largestTrimesh: { triangles: number; id: string } | null;
  creatures: number;
  spawnAreas: number;
  crowd: { creatures: number; at: [number, number] | null };
  /** Budget lines this zone breaks. */
  over: string[];
}

export interface CensusOptions {
  doc: SceneDoc;
  assets: AssetLibrary;
  registry: ComponentRegistry;
  /** Triangles of an asset mesh (the server's collision provider); without it trimesh triangles read 0. */
  meshGeometry?: (assetId: string, node?: string) => MeshGeometryData | null | Promise<unknown> | undefined;
  /** Zones to use instead of the world's `regions`. */
  regions?: RegionDoc[];
  /** Metres within which packs count as one crowd (the server's interest radius; default 150). */
  crowdRadius?: number;
  budget?: Partial<ZoneBudget>;
}

/** Count what each zone of a scene carries and judge it against the budget. */
export function zoneCensus(opts: CensusOptions): { zones: ZoneCensus[]; budget: ZoneBudget; pass: boolean } {
  const budget: ZoneBudget = { ...DEFAULT_ZONE_BUDGET, ...(opts.budget ?? {}) };
  const expanded = expandScene(opts.doc, opts.assets, opts.registry);
  const entities = expanded.entities;
  let regions: ReadonlyArray<RegionDoc> = opts.regions ?? [];
  if (!opts.regions) {
    for (const e of Object.values(entities)) {
      const world = (e.components["voxelWorld"] as { world?: string } | undefined)?.world;
      if (world) regions = getVoxelWorld(world)?.recipe.regions ?? [];
    }
  }
  const children = new Map<string, string[]>();
  for (const [id, e] of Object.entries(entities)) {
    if (e.parent === null) continue;
    const list = children.get(e.parent);
    if (list) list.push(id);
    else children.set(e.parent, [id]);
  }
  const zones = new Map<string, ZoneCensus>();
  const zoneOf = (x: number, z: number): ZoneCensus => {
    const r = regionAt(regions as RegionDoc[], x, z);
    const key = r?.id ?? "(no zone)";
    let c = zones.get(key);
    if (!c) {
      c = { zone: key, name: r?.name ?? key, entities: 0, colliders: 0, triangles: 0, largestTrimesh: null, creatures: 0, spawnAreas: 0, crowd: { creatures: 0, at: null }, over: [] };
      zones.set(key, c);
    }
    return c;
  };
  /** Creatures by place, for the crowd: [x, z, count, zone]. */
  const packs: Array<{ x: number; z: number; n: number; zone: ZoneCensus }> = [];
  const triangles = new Map<string, number>();
  const trianglesOf = (e: EntityDoc): number => {
    const src = (e.components["mesh"] as { source?: { kind?: string; assetId?: string; node?: string } } | undefined)?.source;
    if (src?.kind !== "asset" || !src.assetId || !opts.meshGeometry) return 0;
    const key = `${src.assetId}\0${src.node ?? ""}`;
    let n = triangles.get(key);
    if (n === undefined) {
      const g = opts.meshGeometry(src.assetId, src.node);
      n = g && !(g instanceof Promise) && "indices" in g ? (g as MeshGeometryData).indices.length / 3 : 0;
      triangles.set(key, n);
    }
    return n;
  };
  for (const [rootId, root] of Object.entries(entities)) {
    if (root.parent !== null) continue;
    if (root.tags.includes("player")) continue; // a body per player, not content
    const p = (root.components["transform"] as { position?: number[] } | undefined)?.position;
    if (!p || p.length < 3) continue; // world-wide (the voxel world, global scripts)
    if (root.components["voxelWorld"] || root.components["water"] || root.components["sky"]) continue;
    const zone = zoneOf(p[0]!, p[2]!);
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const e = entities[id];
      if (!e) continue;
      zone.entities++;
      const col = e.components["collider"] as { shape?: string } | undefined;
      if (col) {
        zone.colliders++;
        if (col.shape === "trimesh") {
          const n = trianglesOf(e);
          zone.triangles += n;
          if (n > (zone.largestTrimesh?.triangles ?? 0)) zone.largestTrimesh = { triangles: n, id };
        }
      }
      for (const child of children.get(id) ?? []) stack.push(child);
    }
    const area = root.components["spawnArea"] as SpawnAreaData | undefined;
    if (area) {
      const n = populationOf(area);
      zone.creatures += n;
      zone.spawnAreas++;
      packs.push({ x: p[0]!, z: p[2]!, n, zone });
    } else if (root.tags.includes("npc")) {
      zone.creatures++;
      packs.push({ x: p[0]!, z: p[2]!, n: 1, zone });
    }
  }
  // the crowd: around each pack, everything within the radius (a fight there can wake all of it)
  const radius = opts.crowdRadius ?? 150;
  for (const a of packs) {
    let n = 0;
    for (const b of packs) if (Math.hypot(a.x - b.x, a.z - b.z) <= radius) n += b.n;
    if (n > a.zone.crowd.creatures) a.zone.crowd = { creatures: n, at: [Math.round(a.x), Math.round(a.z)] };
  }
  let pass = true;
  for (const c of zones.values()) {
    if (c.entities > budget.entities) c.over.push(`entities ${c.entities} > ${budget.entities}`);
    if (c.colliders > budget.colliders) c.over.push(`colliders ${c.colliders} > ${budget.colliders}`);
    if (c.triangles > budget.triangles) c.over.push(`trimesh triangles ${c.triangles} > ${budget.triangles}`);
    if ((c.largestTrimesh?.triangles ?? 0) > budget.largestTrimesh) c.over.push(`one trimesh of ${c.largestTrimesh!.triangles} triangles (${c.largestTrimesh!.id}) > ${budget.largestTrimesh}`);
    if (c.crowd.creatures > budget.crowd) c.over.push(`${c.crowd.creatures} creatures can wake around [${c.crowd.at!.join(", ")}] > ${budget.crowd}`);
    if (c.over.length > 0) pass = false;
  }
  return { zones: [...zones.values()].sort((a, b) => a.zone.localeCompare(b.zone)), budget, pass };
}
