/**
 * ZONE PALETTE — the one set of tiles a zone may draw per role (Derek 2026-10-21: "the mood, the palette and the story
 * are the things that stay consistent").
 *
 * `regions[].palette` (core voxel/regions.ts `regionPaletteSchema`):
 *   ground:    palette SURFACE names the zone's open ground may draw (grass, dirt, accent, road, paving, its paint)
 *   cliff:     palette SURFACE names its faces may draw (the zone's cliff stone)
 *   cap:       palette SURFACE names (or rule capLayers) its rocks may wear on top
 *   rockSmall: TEXTURE ids (`textures/<id>`) its sub-4 m rocks may wear
 *   rockLarge: TEXTURE ids its 4-16 m free-standing rocks may wear
 *   builtStone:{ role -> material id | material ids } its built walls may wear (place-build zone defaults)
 *
 * Readers REFUSE a tile outside it: worldgen zone-textures (ground roles), rock-skins install (the zone's skin slices),
 * place-build (builtStone / builtKinds / wall operators), and `worldgen rock-audit` measures the rendered result.
 * A nested region (a place `within` the zone) uses its zone's palette.
 */
import type { WorldRecipe } from "@hitreg/core";

export interface ZonePalette {
  ground: string[];
  cliff: string[];
  cap: string[];
  rockSmall: string[];
  rockLarge: string[];
  builtStone: Record<string, string | string[]>;
}

export type PaletteRole = "ground" | "cliff" | "cap" | "rockSmall" | "rockLarge" | "builtStone";

type Region = { id: string; within?: string; palette?: Partial<ZonePalette>; ground?: Record<string, string>; polygon?: [number, number][]; tags?: string[] };

const regionsOf = (recipe: WorldRecipe): Region[] => ((recipe as { regions?: Region[] }).regions ?? []);

/** The top-level zone a region belongs to (follows `within`). */
export function zoneOf(recipe: WorldRecipe, id: string): Region | null {
  const regions = regionsOf(recipe);
  let cur = regions.find((r) => r.id === id) ?? null;
  for (let hop = 0; cur && cur.within && hop < 6; hop++) cur = regions.find((r) => r.id === cur!.within) ?? cur;
  return cur;
}

/** The declared palette of a zone (or of the zone a place sits in), normalised; null when none is declared. */
export function zonePalette(recipe: WorldRecipe, id: string): ZonePalette | null {
  const z = zoneOf(recipe, id);
  const p = z?.palette;
  if (!p) return null;
  return { ground: p.ground ?? [], cliff: p.cliff ?? [], cap: p.cap ?? [], rockSmall: p.rockSmall ?? [], rockLarge: p.rockLarge ?? [], builtStone: p.builtStone ?? {} };
}

export const builtStoneSet = (p: ZonePalette): Set<string> => new Set(Object.values(p.builtStone).flat());

/** Is `tile` allowed for `role` in the palette? A role the palette leaves empty allows nothing (an empty palette is a fault, not a pass). */
export function paletteAllows(p: ZonePalette, role: PaletteRole, tile: string): boolean {
  if (role === "builtStone") return builtStoneSet(p).has(tile);
  return p[role].includes(tile);
}

/** Every tile in `tiles` that the palette refuses for `role`. */
export function paletteRefusals(p: ZonePalette, role: PaletteRole, tiles: readonly string[]): string[] {
  return [...new Set(tiles.filter((t) => !paletteAllows(p, role, t)))];
}

/** Throw-style guard for a writer: refuse the write with a message naming the tiles and the zone. */
export function assertPalette(recipe: WorldRecipe, zone: string, role: PaletteRole, tiles: readonly string[], who: string): void {
  const p = zonePalette(recipe, zone);
  if (!p) return;
  const bad = paletteRefusals(p, role, tiles);
  if (bad.length)
    throw new Error(`${who}: ${bad.join(", ")} not in zone ${zoneOf(recipe, zone)?.id ?? zone}'s ${role} palette [${role === "builtStone" ? [...builtStoneSet(p)].join(", ") : p[role].join(", ")}] (recipe regions[].palette; one palette per role per zone)`);
}

/**
 * The ROLE of a palette surface in a zone audit: "cliff" (stone a face may draw), "ground" (anything a face must not
 * draw: grass, dirt, gravel, scree, sand, mud, turf, paving) or "climate" (snow/ice: weather, not the zone's look).
 * Order: the zone palette's own lists, base `surfaces[].role`, a region's `ground` mapping, then the name.
 */
export function surfaceRoles(recipe: WorldRecipe, palette?: ZonePalette | null): ("ground" | "cliff" | "climate")[] {
  const byName = new Map<string, "ground" | "cliff">();
  for (const r of regionsOf(recipe)) for (const [role, name] of Object.entries(r.ground ?? {})) if (!byName.has(name)) byName.set(name, role === "cliff" ? "cliff" : "ground");
  return recipe.surfaces.map((s) => {
    const name = s.name;
    if (palette?.cliff.includes(name)) return "cliff";
    if (palette?.ground.includes(name) || palette?.cap.includes(name)) return "ground";
    const role = (s as { role?: string }).role;
    if (role) return role === "cliff" ? "cliff" : "ground";
    const mapped = byName.get(name);
    if (mapped) return mapped;
    if (/snow|ice|frost/i.test(name)) return "climate";
    if (/cliff|rock|clint|crag|slate|shale|basalt|granite/i.test(name)) return "cliff";
    return "ground";
  });
}

/** The top-level zone (a region with no `within`) whose polygon holds (x, z), or null. */
export function zoneAt(recipe: WorldRecipe, x: number, z: number): string | null {
  for (const r of regionsOf(recipe)) if (!r.within && r.polygon && inPolygon(x, z, r.polygon)) return r.id;
  return null;
}

function inPolygon(x: number, z: number, poly: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if (zi! > z !== zj! > z && x < ((xj! - xi!) * (z - zi!)) / (zj! - zi!) + xi!) inside = !inside;
  }
  return inside;
}

/**
 * A `paint` operator against its zone's palette: a paint that reaches FACES (`faces: true`, or a slope window past 45
 * degrees) must name a cliff tile — ground cover on a wall is the leak Derek walked (accent shingle on the Weep Hole
 * walls); any other paint must name a ground or cliff tile of the zone. Null when allowed (or the zone has no palette).
 */
export function paintPaletteFault(recipe: WorldRecipe, doc: { id?: unknown; op?: unknown; surface?: unknown; faces?: unknown; slope?: unknown; polygon?: unknown; center?: unknown }): string | null {
  if (doc.op !== "paint" || typeof doc.surface !== "string") return null;
  const pts = (Array.isArray(doc.polygon) ? doc.polygon : Array.isArray(doc.center) ? [doc.center] : []) as [number, number][];
  if (!pts.length) return null;
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const zone = zoneAt(recipe, cx, cz);
  const p = zone ? zonePalette(recipe, zone) : null;
  if (!p) return null;
  const slope = Array.isArray(doc.slope) ? (doc.slope as number[]) : null;
  const onFaces = doc.faces === true && (!slope || slope[1]! > 45);
  if (onFaces && !p.cliff.includes(doc.surface))
    return `paint ${String(doc.id)}: faces in ${doc.surface}, not a cliff tile of zone ${zone} [${p.cliff.join(", ")}] — a wall wears the zone's cliff stone (drop faces, or paint a palette cliff tile)`;
  if (!p.ground.includes(doc.surface) && !p.cliff.includes(doc.surface))
    return `paint ${String(doc.id)}: ${doc.surface} is not in zone ${zone}'s palette (ground [${p.ground.join(", ")}], cliff [${p.cliff.join(", ")}])`;
  return null;
}
