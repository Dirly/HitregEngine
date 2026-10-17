import type { RockCap } from "../components/core.js";
import type { WorldField } from "./field.js";
import type { ScatterDoc } from "./recipe.js";
import { regionAt, type RegionDoc } from "./regions.js";
import { surfaceRoleIndex, zoneGroundRoles } from "./zone-ground.js";

/**
 * ROCK CAPS AND SKINS — what a scattered rock is made of and what it wears on top, resolved per instance.
 *
 * One mesh set and one material (the world-kit rock kit + the `rock-cap` shader) serve every zone;
 * what changes from zone to zone is this per-instance record, carried on the emitted mesh as
 * `mesh.source.rockCap`.
 *
 * BODY (`base`): the stone follows the place. With `recipe.rockSkins`, every rock samples the stone surface
 * the terrain draws where it stands, facing sideways (its zone's `ground.cliff`, or the sea cliff / butte it
 * leans on), and wears that surface's slice; a rule's `rockBase` / `rockBaseByCliff` only fill gaps. Without
 * the table, the legacy per-rule bases.
 *
 * CAP: the cap follows the ground's bands (`groundBand`), first match wins:
 * 1. stone ground (half or more cliff/rock under the rock): bare;
 * 2. a CLIMATE band — a surface no zone restyles (snow over the snow line): worn if cap-worthy, else bare.
 *    Neither the zone nor the rule overrides it (no sand tops above the snow line);
 * 3. the ZONE: the nearest region on the chain place -> zone -> parent that declares `rockCap`;
 * 4. the RULE's `cap`: a surface NAME (fixed), or "auto" — the dominant non-stone surface, if cap-worthy,
 *    its amount scaled by how much of the ground that surface covers.
 *
 * Only rules with `cap` are capped at all (trees never are). The tint is always the field's biome
 * tint there, so a cap matches the ground beside it exactly as the terrain's own layers do.
 * Everything is a pure function of the field and the position: seed-stable, chunk-independent,
 * identical on every host. Cosmetic: nothing reads it but the renderer. `worldgen rock-skins` gates both picks.
 */
export type RockCapResolver = (rule: ScatterDoc, x: number, y: number, z: number) => RockCap | undefined;

const resolvers = new WeakMap<WorldField, RockCapResolver>();

/** The resolver for `field`, built once per field (scatter asks for it per cell). */
export function rockCapResolver(field: WorldField): RockCapResolver {
  let resolver = resolvers.get(field);
  if (!resolver) resolvers.set(field, (resolver = createRockCapResolver(field)));
  return resolver;
}

/** What the ground beside a rock is, for its cap (`RockSkinProbe.groundBand`). */
export interface GroundBand {
  /**
   * - `climate`: a surface no zone restyles (no role: snow, a sea turf, gravel) holds the ground: the altitude / climate band.
   *   A rock wears it when it is cap-worthy, else stays bare. Neither the zone's `rockCap` nor a rule's fixed cap overrides it.
   * - `bare`: stone ground (cliff-role surfaces, a zone's cliff, `rock`) covers half or more: no cap.
   * - `zone`: a zone-restylable ground (grass, ground, accent): the zone's `rockCap`, else the rule's cap.
   * - `none`: no weights (outside the world).
   */
  band: "climate" | "bare" | "zone" | "none";
  /** Dominant non-stone surface (palette index), or -1. */
  surface: number;
  /** Its share of all the ground weight there. */
  share: number;
  /** Share of the ground that is stone. */
  bare: number;
  /** Whether `surface` reads as a cover on a rock top (snow, sand, moss, grass, turf, or some zone's rockCap layer). */
  worthy: boolean;
  /** The biome tint there. */
  tint: [number, number, number];
}

/** Where a rock's body slice came from (`RockSkinProbe.skinAt`). */
export interface RockSkinPick {
  base: number;
  /** The cliff surface the rock stands against (name), or null. */
  surface: string | null;
  /** world = `recipe.rockSkins`; rule = the rule's own `rockBaseByCliff` / `rockBase`; fallback = "*" or 0. */
  from: "world" | "rule" | "fallback";
}

/**
 * The two picks every rock makes, shared by the scatter resolver and the `worldgen rock-skins` gate so they can never
 * disagree: its body slice (`skinAt`, the stone follows the place) and the band of the ground beside it (`groundBand`,
 * the cap follows the ground). Pure functions of the field; memoised on a 4 m lattice.
 */
export interface RockSkinProbe {
  /** The stone surface the terrain draws at (x, y, z) facing sideways (zone cliffs, sea cliffs, buttes included); -1 for none. */
  cliffSurfaceAt(x: number, y: number, z: number): number;
  /**
   * The stone of the dry BANKS around (x, z), for a rock standing in water (a river bed, a plunge pool, a lake): the
   * sideways stone weights on every DRY point within 20 m (16 bearings), the nearest counting most (1 / r^2). The bed
   * under a rock blends the zones a river divides (a border drawn down the channel), so the stone at its own spot can
   * be the far bank's; the nearest bank is the one it reads against. `share`: the winner's share of the bank stone.
   */
  bankStoneAt(x: number, z: number): { surface: number; share: number; weights: ReadonlyMap<number, number> };
  skinAt(rule: ScatterDoc, x: number, y: number, z: number): RockSkinPick;
  groundBand(x: number, y: number, z: number): GroundBand;
  /** Palette indices that count as stone (never a cap). */
  readonly stone: ReadonlySet<number>;
}

const probes = new WeakMap<WorldField, RockSkinProbe>();
export function rockSkinProbe(field: WorldField): RockSkinProbe {
  let p = probes.get(field);
  if (!p) probes.set(field, (p = createRockSkinProbe(field)));
  return p;
}

const lattice = (x: number, z: number): number => ((Math.round(x / 4) & 0xffff) * 65536 + (Math.round(z / 4) & 0xffff));

export function createRockSkinProbe(field: WorldField): RockSkinProbe {
  const recipe = field.recipe;
  const surfaces = recipe.surfaces;
  const count = field.surfaceCount;
  const regions = (recipe as { regions?: readonly RegionDoc[] }).regions ?? [];
  const roles = zoneGroundRoles(recipe as never);
  const CLIFF = surfaceRoleIndex("cliff");
  const stone = new Set<number>();
  const worthy = new Set<number>();
  const climate = new Set<number>();
  const zoneCapLayers = new Set(regions.map((r) => r.rockCap?.layer).filter((n): n is string => !!n));
  // a world that tags its ground roles says which surfaces a zone restyles; the rest are climate bands. An untagged
  // world restyles nothing, so only the snow-like surfaces count as a band there (the zone's cap rules the rest).
  const tagged = surfaces.some((s) => (s as { role?: string }).role);
  surfaces.forEach((s, i) => {
    const role = (s as { role?: string }).role;
    if (role === "cliff" || roles.overrideRole[i] === CLIFF || /(rock|cliff)$/i.test(s.name)) {
      stone.add(i);
      return;
    }
    if (role !== "road" && role !== "paving" && (role === "grass" || /snow|sand|moss|grass|turf/i.test(s.name) || zoneCapLayers.has(s.name))) worthy.add(i);
    if (!role && roles.overrideRole[i]! < 0 && (tagged || /snow|ice|frost/i.test(s.name))) climate.add(i);
  });
  const skins = (recipe as { rockSkins?: Record<string, number> }).rockSkins;
  const scratch = new Float32Array(count + 3);
  const cliffMemo = new Map<number, number>();
  const cliffSurfaceAt = (x: number, y: number, z: number): number => {
    const key = lattice(x, z);
    const hit = cliffMemo.get(key);
    if (hit !== undefined) return hit;
    if (cliffMemo.size > 65536) cliffMemo.clear();
    // facing sideways: what the face beside the rock draws (the steep blend, the zone remap, sea rock)
    field.surfaceAt(x, y, z, 0, scratch, 0);
    let best = -1, bw = 1e-4;
    for (const i of stone) if (scratch[i]! > bw) { bw = scratch[i]!; best = i; }
    cliffMemo.set(key, best);
    return best;
  };
  // the zone's cliff surface (ground.cliff along place -> zone -> parent): the LEGACY rockBaseByCliff key
  const zoneCliffMemo = new Map<number, string | null>();
  const zoneCliff = (x: number, z: number): string | null => {
    const key = lattice(x, z);
    const hit = zoneCliffMemo.get(key);
    if (hit !== undefined) return hit;
    if (zoneCliffMemo.size > 65536) zoneCliffMemo.clear();
    let region = regionAt(regions, Math.round(x / 4) * 4, Math.round(z / 4) * 4, { places: true });
    let name: string | null = null;
    for (let hops = 0; region && hops < 4 && !name; hops++) {
      name = region.ground?.cliff ?? null;
      const parent: string | undefined = region.within;
      region = parent ? (regions.find((r) => r.id === parent) ?? null) : null;
    }
    zoneCliffMemo.set(key, name);
    return name;
  };
  type BankStone = { surface: number; share: number; weights: ReadonlyMap<number, number> };
  const pickStone = (weights: Map<number, number>): BankStone => {
    let surface = -1, best = 0, total = 0;
    for (const [i, w] of weights) { total += w; if (w > best) { best = w; surface = i; } }
    return { surface, share: total > 0 ? Math.round((best / total) * 1000) / 1000 : 0, weights };
  };
  /** Adds the sideways stone weights at a DRY point (in the water is no bank). */
  const addBank = (weights: Map<number, number>, px: number, pz: number, k: number): void => {
    const gy = field.height(px, pz);
    const wy = field.waterY(px, pz);
    if (wy !== null && gy < wy + 0.2) return;
    field.surfaceAt(px, gy, pz, 0, scratch, 0);
    for (const i of stone) if (scratch[i]! > 1e-3) weights.set(i, (weights.get(i) ?? 0) + scratch[i]! * k);
  };
  const bankMemo = new Map<number, BankStone>();
  const BANK_RADII = [2, 3.5, 5, 7, 10, 14, 20];
  const bankStoneAt = (x: number, z: number): BankStone => {
    // a 2 m lattice (seed-stable, chunk-independent: every rock in a cell asks about the same spot)
    const cx = Math.round(x / 2) * 2, cz = Math.round(z / 2) * 2;
    const key = (cx & 0xffff) * 65536 + (cz & 0xffff);
    const hit = bankMemo.get(key);
    if (hit) return hit;
    if (bankMemo.size > 65536) bankMemo.clear();
    // the NEAREST dry ground counts most (1 / r^2): in a pool on a zone border, the bank on the rock's own side
    const weights = new Map<number, number>();
    for (const r of BANK_RADII) for (let a = 0; a < 16; a++) addBank(weights, cx + Math.cos((a * Math.PI) / 8) * r, cz + Math.sin((a * Math.PI) / 8) * r, 1 / (r * r));
    const out = pickStone(weights);
    bankMemo.set(key, out);
    return out;
  };
  const skinAt = (rule: ScatterDoc, x: number, y: number, z: number): RockSkinPick => {
    const map = rule.rockBaseByCliff;
    if (skins) {
      // a rock in water wears its banks' stone (a border river's bed blends both zones); else the stone at its spot
      const bank = rule.water ? bankStoneAt(x, z).surface : -1;
      const i = bank >= 0 ? bank : cliffSurfaceAt(x, y, z);
      const name = i >= 0 ? surfaces[i]!.name : null;
      if (name !== null && skins[name] !== undefined) return { base: skins[name]!, surface: name, from: "world" };
      if (name !== null && map?.[name] !== undefined) return { base: map[name]!, surface: name, from: "rule" };
      if (skins["*"] !== undefined) return { base: skins["*"], surface: name, from: "fallback" };
      return { base: map?.["*"] ?? rule.rockBase ?? 0, surface: name, from: map?.["*"] !== undefined || rule.rockBase !== undefined ? "rule" : "fallback" };
    }
    // legacy (no world table): the rule's own bases, keyed by the zone's ground.cliff
    if (!map) return { base: rule.rockBase ?? 0, surface: null, from: rule.rockBase !== undefined ? "rule" : "fallback" };
    const name = zoneCliff(x, z);
    const hit = name !== null ? map[name] : undefined;
    if (hit !== undefined) return { base: hit, surface: name, from: "rule" };
    return { base: map["*"] ?? rule.rockBase ?? 0, surface: name, from: map["*"] !== undefined || rule.rockBase !== undefined ? "rule" : "fallback" };
  };
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const groundBand = (x: number, y: number, z: number): GroundBand => {
    // ONE biome evaluation for the weights and the tint, facing up (the cap is what lies on top)
    field.surfaceAt(x, y, z, 0.98, scratch, 0);
    const tint: [number, number, number] = [round(scratch[count]!), round(scratch[count + 1]!), round(scratch[count + 2]!)];
    let total = 0, bare = 0, best = -1, bw = 0;
    for (let i = 0; i < count; i++) {
      const w = scratch[i]!;
      total += w;
      if (stone.has(i)) bare += w;
      else if (w > bw) { bw = w; best = i; }
    }
    if (total <= 1e-6) return { band: "none", surface: -1, share: 0, bare: 0, worthy: false, tint };
    const share = bw / total, bareShare = bare / total;
    const out = { surface: best, share: round(share), bare: round(bareShare), worthy: best >= 0 && worthy.has(best), tint };
    if (bareShare >= 0.5 || best < 0) return { band: "bare", ...out };
    if (climate.has(best)) return { band: "climate", ...out };
    return { band: "zone", ...out };
  };
  return { cliffSurfaceAt, bankStoneAt, skinAt, groundBand, stone };
}

export function createRockCapResolver(field: WorldField): RockCapResolver {
  const count = field.surfaceCount;
  const index = new Map<string, number>(field.recipe.surfaces.map((s, i) => [s.name, i]));
  const probe = rockSkinProbe(field);
  const regions = (field.recipe as { regions?: readonly RegionDoc[] }).regions ?? [];
  const capped = regions.filter((r) => r.rockCap);
  const warned = new Set<string>();
  /** A palette surface, or one of the rule's material-only `capLayers` (index past the palette). */
  const layerOf = (name: string, rule: ScatterDoc): { layer: number; extra: boolean } | undefined => {
    const i = index.get(name);
    if (i !== undefined) return { layer: i, extra: false };
    const k = rule.capLayers?.indexOf(name) ?? -1;
    if (k >= 0) return { layer: count + k, extra: true };
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[voxel] rock cap layer "${name}" is neither a world surface nor in the rule's capLayers; those rocks stay bare`);
    }
    return undefined;
  };
  // the zone's cap on a 4 m WORLD lattice, memoised: two polygon walks over every region per rock were a tenth of
  // a water rule's cell (a cap border moves by at most 2 m; it is cosmetic). Bounded: cleared past 65k entries.
  const zoneMemo = new Map<number, { name: string; amount: number } | null>();
  const zoneCap = (x: number, z: number): { name: string; amount: number } | null => {
    if (capped.length === 0) return null;
    const key = lattice(x, z);
    const hit = zoneMemo.get(key);
    if (hit !== undefined) return hit;
    if (zoneMemo.size > 65536) zoneMemo.clear();
    const v = zoneCapAt(Math.round(x / 4) * 4, Math.round(z / 4) * 4);
    zoneMemo.set(key, v);
    return v;
  };
  const zoneCapAt = (x: number, z: number): { name: string; amount: number } | null => {
    let region = regionAt(regions, x, z, { places: true });
    for (let hops = 0; region && hops < 4; hops++) {
      if (region.rockCap) return { name: region.rockCap.layer, amount: region.rockCap.amount };
      const parent: string | undefined = region.within;
      region = parent ? (regions.find((r) => r.id === parent) ?? null) : null;
    }
    // a place cut out of nothing capped: the plain zone lookup (top-level zone) may still say
    const zone = regionAt(regions, x, z);
    return zone?.rockCap ? { name: zone.rockCap.layer, amount: zone.rockCap.amount } : null;
  };
  const round = (v: number) => Math.round(v * 1000) / 1000;

  return (rule, x, y, z) => {
    if (!rule.cap) return rule.rockBase !== undefined || rule.rockBaseByCliff ? { layer: 0, amount: 0, base: probe.skinAt(rule, x, y, z).base } : undefined;
    const base = probe.skinAt(rule, x, y, z).base;
    const ground = probe.groundBand(x, y, z);
    const tint = ground.tint;
    const bare: RockCap = { layer: 0, amount: 0, base };
    // a material-only layer (moss) carries its own colour: the ground's biome tint is not applied to it
    const fixed = (name: string, amount: number): RockCap => {
      const hit = layerOf(name, rule);
      if (!hit || amount <= 0) return bare;
      return hit.extra ? { layer: hit.layer, amount, base } : { layer: hit.layer, amount, tint, base };
    };
    // THE CAP FOLLOWS THE GROUND'S BANDS. Stone ground wears nothing; a climate band (the snow over the snow line, a
    // surface no zone restyles) is worn as the ground wears it, whatever the zone or the rule asks for: a snowfield's
    // rocks are snow-capped, never sand-capped, and bare sandstone grows no turf.
    if (ground.band === "bare" || ground.band === "none") return bare;
    // a rock on mixed ground wears less; a rock in a field wears the full amount
    const scaled = round((rule.capAmount ?? 0.6) * Math.min(1, ground.share * 1.25));
    if (ground.band === "climate") return ground.worthy ? { layer: ground.surface, amount: scaled, tint, base } : bare;
    // zone ground: the zone picks the layer; the rule scales its amount (capAmount over the 0.6 default)
    const zone = zoneCap(x, z);
    if (zone) return fixed(zone.name, round(Math.min(1, zone.amount * ((rule.capAmount ?? 0.6) / 0.6))));
    if (rule.cap !== "auto") return fixed(rule.cap, rule.capAmount ?? 0.6);
    if (!ground.worthy) return bare;
    return { layer: ground.surface, amount: scaled, tint, base };
  };
}
