import { pointInPolygon, polygonEdgeDistance } from "../scatter.js";
import { fbm2, smoothstep, type FbmSpec } from "./noise.js";
import { SURFACE_ROLES } from "./roles.js";
import type { RegionDoc } from "./regions.js";

/**
 * Zone ground: each zone (recipe `regions`) may restyle a few ground ROLES
 * (`regions[].ground`), and the field blends the swap in by zone membership.
 *
 * The model is ONE palette per world. A zone's cobble, its grass and its cliff
 * are ordinary palette surfaces; what makes them the zone's is that the
 * surfaces tagged with a role (`surfaces[].role`) hand their weight to the
 * zone's surface for that role wherever the zone holds the ground. Nothing
 * else changes: biomes, patches, roads and the shader are the same machinery.
 *
 * Membership is a smoothstep of the signed distance to the zone polygon over
 * `zoneGround.band` metres, jittered by noise, so two zones meet at 50/50 on
 * the border line and no border is a seam. It is evaluated on an 8 m lattice
 * and interpolated: an exact polygon distance per mesh vertex would cost more
 * than the rest of the splat, and a 150 m blend has nothing to resolve at 8 m.
 */

/** Minimal recipe shape the helpers read (a full `WorldRecipe` satisfies it). */
export interface ZoneGroundRecipe {
  seed: number;
  surfaces: readonly { name: string; role?: string | undefined }[];
  regions: readonly (Pick<RegionDoc, "id" | "polygon" | "within" | "ground"> & { palette?: unknown; groundBand?: number })[];
  zoneGround?: { band: number; jitter: number };
}

export interface ZoneGroundZone {
  id: string;
  polygon: readonly (readonly [number, number])[];
  /** [minX, minZ, maxX, maxZ] of the polygon. */
  bbox: [number, number, number, number];
  /** Index (into `zones`) of the zone this one is cut out of, or -1. */
  parent: number;
  /** Palette index per role (SURFACE_ROLES order), -1 where the zone keeps the base surface. */
  targets: Int16Array;
  /**
   * A zone with a declared `palette` (one palette per role; the slope decides the role): the palette index its CLIFF-role
   * weight goes to on ground flatter than ~25 deg (its accent, else its ground) instead of the cliff tile, so a biome's
   * rock flats (badlands redrock, moor rock) draw the zone's stony ground rather than its strata wall laid flat; -1 = keep.
   */
  flatCliff: number;
  /** This zone's own blend band (m; `regions[].groundBand`), else undefined = the world's `zoneGround.band`. */
  band?: number;
}

export interface ZoneGroundRoles {
  /** Role index (SURFACE_ROLES) of each palette surface tagged as a BASE surface, else -1. */
  baseRole: Int8Array;
  /** Role index a palette surface fills as some zone's override, else -1. */
  overrideRole: Int8Array;
  /** Zones that override at least one role with a surface that exists. */
  zones: ZoneGroundZone[];
  /** Override names that do not resolve to a palette surface: `zone.role -> name`. */
  unresolved: string[];
}

/** Index of a role name in SURFACE_ROLES, or -1. */
export const surfaceRoleIndex = (role: string): number => (SURFACE_ROLES as readonly string[]).indexOf(role);

function surfaceIndexOf(surfaces: ZoneGroundRecipe["surfaces"], name: string): number {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return -1;
  return surfaces.findIndex((s) => s.name.toLowerCase() === wanted);
}

/** Resolve every zone's ground overrides against the palette. Pure; cheap; call once per field. */
export function zoneGroundRoles(recipe: ZoneGroundRecipe): ZoneGroundRoles {
  const count = recipe.surfaces.length;
  const overrideRole = new Int8Array(count).fill(-1);
  const zones: ZoneGroundZone[] = [];
  const unresolved: string[] = [];
  for (const region of recipe.regions) {
    if (!region.ground) continue;
    const targets = new Int16Array(SURFACE_ROLES.length).fill(-1);
    let any = false;
    for (const [role, name] of Object.entries(region.ground)) {
      const r = surfaceRoleIndex(role);
      if (r < 0 || !name) continue;
      const s = surfaceIndexOf(recipe.surfaces, name);
      if (s < 0) {
        unresolved.push(`${region.id}.${role} -> ${name}`);
        continue;
      }
      targets[r] = s;
      overrideRole[s] = r;
      any = true;
    }
    if (!any) continue;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of region.polygon) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    zones.push({ id: region.id, polygon: region.polygon, bbox: [minX, minZ, maxX, maxZ], parent: -1, targets, flatCliff: -1, ...(region.groundBand !== undefined ? { band: region.groundBand } : {}) });
  }
  for (const zone of zones) {
    const region = recipe.regions.find((r) => r.id === zone.id);
    if (region?.within) zone.parent = zones.findIndex((z) => z.id === region.within);
    // a region nested in a palette zone (a corridor restyling its zone's cliff) keeps the zone's rule: its cliff weight
    // on the flat goes to its own accent/ground, as the zone's does
    let paletted = false;
    for (let r: (typeof recipe.regions)[number] | undefined = region, hop = 0; r && hop < 6 && !paletted; hop++) {
      paletted = !!r.palette;
      r = r.within ? recipe.regions.find((q) => q.id === r!.within) : undefined;
    }
    if (paletted) {
      const accent = zone.targets[surfaceRoleIndex("accent")]!;
      zone.flatCliff = accent >= 0 ? accent : zone.targets[surfaceRoleIndex("ground")]!;
    }
  }
  // A surface some zone uses as its override is never itself a base member:
  // remapping it again would move one zone's cobble into the next zone's.
  const baseRole = new Int8Array(count).fill(-1);
  recipe.surfaces.forEach((s, i) => {
    if (s.role && overrideRole[i]! < 0) baseRole[i] = surfaceRoleIndex(s.role);
  });
  return { baseRole, overrideRole, zones, unresolved };
}

/**
 * Palette indices that count as surface `name` for a gate (cover layers,
 * scatter, footsteps): the surface itself plus every zone override that
 * replaces it. Without this a zone that restyles `grass` would silently lose
 * every grass billboard, because the gate still asks for the name "grass".
 */
export function surfaceAliases(recipe: ZoneGroundRecipe, name: string, roles = zoneGroundRoles(recipe)): number[] {
  const index = surfaceIndexOf(recipe.surfaces, name);
  if (index < 0) return [];
  const role = roles.baseRole[index]!;
  if (role < 0) return [index];
  const out = [index];
  for (const zone of roles.zones) {
    const t = zone.targets[role]!;
    if (t >= 0 && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The BASE surface an override stands in for (the first palette surface tagged
 * with the role it fills), or `index` itself. What a footstep or a map legend
 * should call a zone's grass: "grass".
 */
export function surfaceBaseIndex(recipe: ZoneGroundRecipe, index: number, roles = zoneGroundRoles(recipe)): number {
  const role = roles.overrideRole[index] ?? -1;
  if (role < 0) return index;
  const base = roles.baseRole.indexOf(role);
  return base >= 0 ? base : index;
}

/** Lattice spacing (m) of the cached membership, and lattice cells per tile edge. */
const LATTICE = 8;
const TILE = 16;
const MAX_TILES = 2048;

/**
 * Membership of every override zone at (x, z), written to `out[k]` (0..1),
 * returning the sum (at most 1). Nested zones take their share out of their
 * parent's, so a town with its own paving inside a zone with another one is
 * the town's.
 */
export function createZoneMembership(
  recipe: ZoneGroundRecipe,
  roles: ZoneGroundRoles,
): (x: number, z: number, out: Float32Array) => number {
  const zones = roles.zones;
  const K = zones.length;
  const band = recipe.zoneGround?.band ?? 150;
  const jitterShare = recipe.zoneGround?.jitter ?? 0.35;
  // per zone: a corridor region may blend over a narrower band of its own (regions[].groundBand)
  const halves = zones.map((z) => (z.band ?? band) / 2);
  const amps = zones.map((z) => (z.band ?? band) * jitterShare);
  const jitterSpec: FbmSpec = { frequency: 1 / 260, amplitude: 1, octaves: 3, lacunarity: 2.1, gain: 0.5, ridged: false, seed: 4409 };
  const reaches = zones.map((_, k) => halves[k]! + amps[k]! + LATTICE * 2);
  const seed = recipe.seed;

  const raw = new Float32Array(Math.max(1, K));
  function exact(x: number, z: number, out: Float32Array, offset: number): void {
    let jitter = Number.NaN;
    for (let k = 0; k < K; k++) {
      const zone = zones[k]!;
      const [minX, minZ, maxX, maxZ] = zone.bbox;
      const reach = reaches[k]!;
      if (x < minX - reach || x > maxX + reach || z < minZ - reach || z > maxZ + reach) {
        raw[k] = 0;
        continue;
      }
      if (Number.isNaN(jitter)) jitter = fbm2(jitterSpec, x, z, seed);
      const d = polygonEdgeDistance(x, z, zone.polygon);
      const signed = (pointInPolygon(x, z, zone.polygon) ? d : -d) + jitter * amps[k]!;
      raw[k] = smoothstep(-halves[k]!, halves[k]!, signed);
    }
    for (let k = 0; k < K; k++) {
      const p = zones[k]!.parent;
      if (p >= 0) raw[p] = raw[p]! * (1 - raw[k]!);
    }
    for (let k = 0; k < K; k++) out[offset + k] = raw[k]!;
  }

  // world box of everything that can be non-zero; outside it there is no work
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  zones.forEach((zone, k) => {
    minX = Math.min(minX, zone.bbox[0] - reaches[k]!);
    minZ = Math.min(minZ, zone.bbox[1] - reaches[k]!);
    maxX = Math.max(maxX, zone.bbox[2] + reaches[k]!);
    maxZ = Math.max(maxZ, zone.bbox[3] + reaches[k]!);
  });

  const tiles = new Map<number, Float32Array>();
  const side = TILE + 1;
  function tile(tx: number, tz: number): Float32Array {
    const key = (tx + 32768) * 65536 + (tz + 32768);
    let t = tiles.get(key);
    if (t) return t;
    if (tiles.size >= MAX_TILES) tiles.clear();
    t = new Float32Array(side * side * K);
    const x0 = tx * TILE * LATTICE;
    const z0 = tz * TILE * LATTICE;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) exact(x0 + i * LATTICE, z0 + j * LATTICE, t, (j * side + i) * K);
    }
    tiles.set(key, t);
    return t;
  }

  return (x, z, out) => {
    if (K === 0 || x < minX || x > maxX || z < minZ || z > maxZ) {
      for (let k = 0; k < K; k++) out[k] = 0;
      return 0;
    }
    const gx = x / LATTICE;
    const gz = z / LATTICE;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const tx = Math.floor(ix / TILE);
    const tz = Math.floor(iz / TILE);
    const t = tile(tx, tz);
    const a = ((iz - tz * TILE) * side + (ix - tx * TILE)) * K;
    const b = a + K;
    const c = a + side * K;
    const d = c + K;
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const v = (t[a + k]! * (1 - fx) + t[b + k]! * fx) * (1 - fz) + (t[c + k]! * (1 - fx) + t[d + k]! * fx) * fz;
      out[k] = v;
      sum += v;
    }
    if (sum > 1) {
      const inv = 1 / sum;
      for (let k = 0; k < K; k++) out[k] = out[k]! * inv;
      sum = 1;
    }
    return sum;
  };
}
