/**
 * The world map's DATA and its DRAWING, shared by every place a map is shown:
 * the in-game full map (M), the HUD minimap (`hitreg:minimap-draw`), and the
 * review PNG `zonegen map` renders for agents (the CLI runs this same file in
 * headless Chrome), so the picture a reviewer judges placement on is the one
 * the person walking the world sees.
 *
 * Self-contained on purpose: no imports, no DOM globals (the drawing takes a
 * 2D context it is handed). Its inputs are plain JSON — the world recipe, a
 * scene doc, and the optional authoring bundle `zonegen map` writes beside the
 * terrain picture (`assets/maps/<world>.layers.json`).
 *
 * World axes: +X is east (right), +Z is SOUTH (down); north is -Z, up the map.
 */

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

export type MarkerKind =
  | "town"
  | "place"
  | "dungeon"
  | "quest"
  | "spawn"
  | "pack"
  | "mob"
  | "reservation"
  | "site";

export interface MapMarker {
  kind: MarkerKind;
  id: string;
  name: string;
  x: number;
  z: number;
  /** Footprint in metres (spawn area, reservation, town pad). */
  radius?: number;
  /** Creature level, for spawn areas, packs and mobs. */
  level?: number;
  /** Size/tier word (town tier) or a short extra ("named: The Gatekeeper"). */
  detail?: string;
}

export interface MapZone {
  id: string;
  name: string;
  polygon: [number, number][];
  hub: [number, number];
  /** A town zone (recipe region with `within`): drawn fainter, named by its town marker instead. */
  town: boolean;
}

export interface MapData {
  world: string;
  /** Half-width of the square the terrain picture covers (same rule as `worldgen map`). */
  extent: number;
  /** World limit radius, or 0 when unbounded. */
  limit: number;
  zones: MapZone[];
  roads: { id: string; trail: boolean; points: [number, number][]; box: [number, number, number, number] }[];
  markers: MapMarker[];
}

/** What `zonegen map` gathers from authoring files the running game cannot read. */
export interface MapExtras {
  world: string;
  /** Entity ids of NPCs that give a quest (zonegen quests.json `giver.ref`). */
  questGivers?: string[];
  /** Named quest locations with where they are (quests.json locations + reservations). */
  places?: { id: string; name: string; kind: string; x: number; z: number; radius?: number; zone?: string }[];
  reservations?: { id: string; site: string; x: number; z: number; radius: number; interior?: string; zone?: string }[];
  packs?: { id: string; site?: string; x: number; z: number; level?: number; count: number; named?: string; faction?: string }[];
}

interface RecipeLike {
  name?: string;
  bounds?: { limit?: number };
  regions?: { id: string; name: string; polygon: [number, number][]; hub?: [number, number]; within?: string }[];
  features: {
    towns: { id: string; center: [number, number]; tier?: string; radius?: number; tags?: string[] }[];
    roads?: { id: string; points: number[][] }[];
    pois?: { id: string; kind: string; position: [number, number, number]; zone?: string }[];
  };
}

interface EntityLike {
  name?: string;
  parent?: string | null;
  tags?: string[];
  components?: Record<string, unknown>;
}
export interface SceneLike {
  entities: Record<string, EntityLike>;
}

/** The map's square: the world limit plus a margin, exactly as `worldgen map` frames it with no --extent. */
export function mapExtent(recipe: { bounds?: { limit?: number } }): number {
  const limit = recipe.bounds?.limit;
  return limit ? Math.ceil((limit + 200) / 100) * 100 : 3000;
}

/** Town id -> display name: the name of its town zone (`within` region whose hub is the town), else the id. */
export function townNames(recipe: RecipeLike): Map<string, string> {
  const names = new Map<string, string>();
  for (const town of recipe.features.towns) {
    const zone =
      recipe.regions?.find((r) => r.within && r.id === `${town.id}-zone`) ??
      recipe.regions?.find((r) => r.within && r.hub && Math.hypot(r.hub[0] - town.center[0], r.hub[1] - town.center[1]) < 1);
    names.set(town.id, zone?.name ?? town.id);
  }
  return names;
}

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
const rotate = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const mulQ = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** World position of every entity of a scene doc, composing parent transforms (position, quaternion, scale). */
export function worldPositions(scene: SceneLike): (id: string) => Vec3 | null {
  const memo = new Map<string, { p: Vec3; q: Quat; s: Vec3 } | null>();
  const resolve = (id: string, depth: number): { p: Vec3; q: Quat; s: Vec3 } | null => {
    if (memo.has(id)) return memo.get(id)!;
    const e = scene.entities[id];
    if (!e || depth > 64) return null;
    const t = (e.components?.["transform"] ?? {}) as { position?: Vec3; rotation?: Quat; scale?: Vec3 };
    const lp: Vec3 = t.position ?? [0, 0, 0];
    const lq: Quat = t.rotation ?? [0, 0, 0, 1];
    const ls: Vec3 = t.scale ?? [1, 1, 1];
    let out: { p: Vec3; q: Quat; s: Vec3 };
    const parent = e.parent ? resolve(e.parent, depth + 1) : null;
    if (parent) {
      const scaled: Vec3 = [lp[0] * parent.s[0], lp[1] * parent.s[1], lp[2] * parent.s[2]];
      const r = rotate(parent.q, scaled);
      out = { p: [parent.p[0] + r[0], parent.p[1] + r[1], parent.p[2] + r[2]], q: mulQ(parent.q, lq), s: [parent.s[0] * ls[0], parent.s[1] * ls[1], parent.s[2] * ls[2]] };
    } else out = { p: lp, q: lq, s: ls };
    memo.set(id, out);
    return out;
  };
  return (id) => resolve(id, 0)?.p ?? null;
}

const tagValue = (tags: string[] | undefined, key: string): string | undefined =>
  tags?.find((t) => t.startsWith(`${key}:`))?.slice(key.length + 1);
const scriptsOf = (e: EntityLike): { name: string; params?: Record<string, unknown> }[] => {
  const s = e.components?.["script"] as { name?: string; params?: Record<string, unknown>; scripts?: { name: string; params?: Record<string, unknown> }[] } | undefined;
  if (!s) return [];
  if (Array.isArray(s.scripts)) return s.scripts;
  return s.name ? [{ name: s.name, params: s.params }] : [];
};

/**
 * Everything the map draws, from the recipe (zones, towns, roads, generator
 * sites), the scene (built places = `poi` roots, portals, quest givers, spawn
 * areas, placed creatures) and the authoring bundle (reservations, packs,
 * quest-location names). Any input may be missing; the map shows what exists.
 */
export function collectMapData(recipe: RecipeLike, scene: SceneLike | null, extras: MapExtras | null, world = recipe.name ?? ""): MapData {
  const markers: MapMarker[] = [];
  const names = townNames(recipe);
  for (const town of recipe.features.towns) {
    markers.push({ kind: "town", id: town.id, name: names.get(town.id) ?? town.id, x: town.center[0], z: town.center[1], radius: town.radius, detail: town.tier ?? (town.tags?.includes("capital") ? "capital" : "town") });
  }
  const zones: MapZone[] = (recipe.regions ?? [])
    .filter((r) => r.polygon.length >= 3)
    .map((r) => ({
      id: r.id,
      name: r.name,
      polygon: r.polygon,
      town: !!r.within,
      hub: r.hub ?? r.polygon.reduce<[number, number]>((a, p) => [a[0] + p[0] / r.polygon.length, a[1] + p[1] / r.polygon.length], [0, 0]),
    }));
  const roads = (recipe.features.roads ?? []).map((road) => {
    const points = road.points.map((p) => (p.length >= 3 ? [p[0]!, p[2]!] : [p[0]!, p[1]!]) as [number, number]);
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of points) {
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], z); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], z);
    }
    return { id: road.id, trail: road.id.startsWith("trail-"), points, box };
  });
  for (const poi of recipe.features.pois ?? []) {
    if (poi.kind === "peak" || poi.kind === "falls") continue;
    markers.push({ kind: "site", id: poi.id, name: poi.id, x: poi.position[0], z: poi.position[2], detail: poi.kind });
  }

  const placed = new Set<string>();
  const givers = new Set(extras?.questGivers ?? []);
  if (scene) {
    const at = worldPositions(scene);
    for (const [id, e] of Object.entries(scene.entities)) {
      const tags = e.tags ?? [];
      const scripts = scriptsOf(e);
      const portal = scripts.find((s) => s.name === "portal");
      const spawn = e.components?.["spawnArea"] as { radius?: number; spawns?: { template?: string; count?: number }[] } | undefined;
      const isPoiRoot = tags.includes("poi") && !e.parent && tags.some((t) => t.startsWith("poi:"));
      const isGiver = tags.includes("quest-giver") || givers.has(id);
      const isMob = tags.includes("populate") && tags.includes("npc") && !spawn;
      if (!portal && !spawn && !isPoiRoot && !isGiver && !isMob) continue;
      const p = at(id);
      if (!p) continue;
      if (portal) {
        const name = String(portal.params?.["name"] ?? e.name ?? id).replace(/^the /, "The ");
        markers.push({ kind: "dungeon", id, name, x: p[0], z: p[2], detail: portal.params?.["scene"] ? `→ ${portal.params["scene"]}` : undefined });
      } else if (spawn) {
        const creature = tagValue(tags, "creature") ?? spawn.spawns?.[0]?.template ?? "spawn";
        const level = Number(tagValue(tags, "level"));
        const count = (spawn.spawns ?? []).reduce((n, s) => n + (s.count ?? 1), 0);
        markers.push({ kind: "spawn", id, name: `${creature}${count > 1 ? ` ×${count}` : ""}`, x: p[0], z: p[2], radius: spawn.radius, level: Number.isFinite(level) ? level : undefined, detail: tagValue(tags, "pop") });
      } else if (isPoiRoot) {
        placed.add(tagValue(tags, "poi")!);
        markers.push({ kind: "place", id, name: e.name ?? id, x: p[0], z: p[2] });
      } else if (isGiver) {
        const npc = scripts.find((s) => s.name === "npc");
        markers.push({ kind: "quest", id, name: String(npc?.params?.["name"] ?? e.name ?? id), x: p[0], z: p[2] });
      } else if (isMob) {
        const level = Number(tagValue(tags, "level"));
        markers.push({ kind: "mob", id, name: (e.name ?? tagValue(tags, "creature") ?? id).replace(/\s*\(lv[^)]*\)/i, ""), x: p[0], z: p[2], level: Number.isFinite(level) ? level : undefined });
      }
    }
  }
  for (const place of extras?.places ?? []) {
    // a built place is already on the map from its scene root; a planned one shows as planned
    if (place.kind === "town" || placed.has(place.id)) continue;
    markers.push({ kind: "place", id: place.id, name: place.name, x: place.x, z: place.z, radius: place.radius, detail: scene ? "planned" : place.kind });
  }
  for (const r of extras?.reservations ?? []) {
    markers.push({ kind: "reservation", id: r.id, name: r.id, x: r.x, z: r.z, radius: r.radius, detail: r.interior && r.interior !== "none" ? r.interior : undefined });
  }
  for (const pack of extras?.packs ?? []) {
    markers.push({ kind: "pack", id: pack.id, name: pack.named ? `${pack.named}` : pack.id, x: pack.x, z: pack.z, level: pack.level, detail: `${pack.count} creature${pack.count === 1 ? "" : "s"}${pack.named ? " + named" : ""}` });
  }
  const limit = recipe.bounds?.limit ?? 0;
  return { world, extent: mapExtent(recipe), limit, zones, roads, markers };
}

/** Which zone (deepest: a town zone over its parent) a point is in, by name. */
export function zoneAt(data: MapData, x: number, z: number): { zone: string | null; town: string | null } {
  let zone: string | null = null;
  let town: string | null = null;
  for (const r of data.zones) {
    if (!inside(r.polygon, x, z)) continue;
    if (r.town) town = r.name;
    else zone = r.name;
  }
  return { zone, town };
}
function inside(poly: [number, number][], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

export type LayerId = "zones" | "roads" | "towns" | "places" | "dungeons" | "quests" | "labels" | "spawns" | "packs" | "reservations" | "sites";

export interface LayerInfo {
  id: LayerId;
  label: string;
  colour: string;
  /** Glyph used in the legend and on the map. */
  shape: "line" | "ring" | "dot" | "square" | "diamond" | "bang" | "circle" | "text" | "triangle";
  /** Part of the DEV layer: off by default, for judging placement. */
  dev: boolean;
  /** Keyboard key that toggles it on the full map. */
  key: string;
}

export const LAYERS: readonly LayerInfo[] = [
  { id: "zones", label: "zone borders + names", colour: "#ffffff", shape: "line", dev: false, key: "1" },
  { id: "roads", label: "roads / trails", colour: "#ead7a2", shape: "line", dev: false, key: "2" },
  { id: "towns", label: "towns", colour: "#ff5a4a", shape: "square", dev: false, key: "3" },
  { id: "places", label: "named places", colour: "#ffb347", shape: "dot", dev: false, key: "4" },
  { id: "dungeons", label: "dungeon entrances", colour: "#c38bff", shape: "diamond", dev: false, key: "5" },
  { id: "quests", label: "quest givers", colour: "#ffe14d", shape: "bang", dev: false, key: "6" },
  { id: "labels", label: "labels", colour: "#e6e9ef", shape: "text", dev: false, key: "7" },
  { id: "spawns", label: "spawn areas (radius)", colour: "#ff4d6d", shape: "circle", dev: true, key: "8" },
  { id: "packs", label: "packs + placed creatures", colour: "#ff8c42", shape: "triangle", dev: true, key: "9" },
  { id: "reservations", label: "reservations (radius)", colour: "#5ad1ff", shape: "ring", dev: true, key: "R" },
  { id: "sites", label: "generator sites", colour: "#9aa3ad", shape: "dot", dev: true, key: "G" },
];
/** The REVIEW default (`zonegen map`, and the editor's dev view): every non-dev layer. */
export const DEFAULT_LAYERS: ReadonlySet<LayerId> = new Set(LAYERS.filter((l) => !l.dev).map((l) => l.id));
/**
 * What a PLAYER's map may ever show (the owner's ruling: the map shows towns, roads and zones;
 * named places, dungeon entrances and quest givers are found by exploring). Every other layer
 * exists only in dev builds / the editor, and a published client cannot turn it on.
 */
export const PLAYER_LAYERS: ReadonlySet<LayerId> = new Set<LayerId>(["zones", "roads", "towns", "labels"]);
const LAYER_OF: Record<MarkerKind, LayerId> = {
  town: "towns",
  place: "places",
  dungeon: "dungeons",
  quest: "quests",
  spawn: "spawns",
  pack: "packs",
  mob: "packs",
  reservation: "reservations",
  site: "sites",
};
const colourOf = (id: LayerId): string => LAYERS.find((l) => l.id === id)!.colour;

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

export interface MapView {
  /** World point at the centre of the canvas. */
  cx: number;
  cz: number;
  /** Canvas pixels per world metre. */
  scale: number;
  width: number;
  height: number;
}

export interface DrawOptions {
  layers: ReadonlySet<LayerId>;
  /** The terrain picture (`assets/maps/<world>.base.png`) and the half-width it covers. */
  base?: { image: CanvasImageSource; width: number; height: number; extent: number } | null;
  player?: { x: number; z: number; yaw: number } | null;
  /** Minimap: smaller glyphs, fewer labels, no scale bar. */
  compact?: boolean;
  font?: string;
  /** Zone to emphasise (the others are dimmed): the review map for one zone. */
  focusZone?: string;
  /** Canvas rectangles [x, y, w, h] labels must keep clear of (panels drawn over the map). */
  avoid?: [number, number, number, number][];
  /** The player's own map markers (client-side UI state, never gameplay). */
  pins?: readonly MapPin[];
  /** Id of the pin being edited: drawn with a selection ring. */
  selectedPin?: string | null;
  /** Canvas background used outside the terrain image. */
  backgroundColor?: string;
  /** Host theme colours for personal markers and their labels. */
  pinColor?: string;
  pinLabelColor?: string;
}

// ---------------------------------------------------------------------------
// player markers (pins)
// ---------------------------------------------------------------------------

/** A marker shape. The SHAPE carries the meaning (one colour for all), so it reads without colour vision. */
export type PinShape = "pin" | "dungeon" | "mob" | "camp" | "resource" | "star" | "flag" | "cross" | "ring";
export const PIN_SHAPES: readonly { id: PinShape; label: string }[] = [
  { id: "pin", label: "Location" },
  { id: "dungeon", label: "Dungeon" },
  { id: "mob", label: "Mobs" },
  { id: "camp", label: "Camp" },
  { id: "resource", label: "Resource" },
  { id: "star", label: "Important" },
  { id: "flag", label: "Goal / meet" },
  { id: "cross", label: "Danger" },
  { id: "ring", label: "Circle" },
];
export interface MapPin {
  id: string;
  x: number;
  z: number;
  shape: PinShape;
  /** Optional short label (at most PIN_LABEL_MAX characters). */
  label: string;
}
export const PIN_LABEL_MAX = 32;
const PIN_FILL = "#8fe6ff";

/** One pin glyph whose marked spot is (px, py); s is its size in px. Shared by the map, minimap and the shape picker. */
export function drawPinGlyph(ctx: CanvasRenderingContext2D, shape: PinShape, px: number, py: number, s: number, fill = PIN_FILL): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.fillStyle = fill;
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  switch (shape) {
    case "pin": {
      // teardrop: its point is the marked spot
      ctx.moveTo(px, py);
      ctx.bezierCurveTo(px - s * 0.9, py - s * 0.9, px - s * 0.9, py - s * 2, px, py - s * 2);
      ctx.bezierCurveTo(px + s * 0.9, py - s * 2, px + s * 0.9, py - s * 0.9, px, py);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py - s * 1.35, s * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = "#0b1a22";
      ctx.fill();
      break;
    }
    case "dungeon": {
      // Masonry arch: a dark entrance in an engraved stone surround.
      ctx.moveTo(px - s, py + s * 0.8);
      ctx.lineTo(px - s, py - s * 0.2);
      ctx.arc(px, py - s * 0.2, s, Math.PI, 0);
      ctx.lineTo(px + s, py + s * 0.8);
      ctx.closePath(); ctx.stroke(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(px - s * 0.48, py + s * 0.8);
      ctx.lineTo(px - s * 0.48, py - s * 0.15);
      ctx.arc(px, py - s * 0.15, s * 0.48, Math.PI, 0);
      ctx.lineTo(px + s * 0.48, py + s * 0.8);
      ctx.closePath(); ctx.fillStyle = "#17130e"; ctx.fill();
      break;
    }
    case "mob": {
      // A skull silhouette, with eyes and teeth that survive minimap sizes.
      ctx.arc(px, py - s * 0.2, s * 0.9, Math.PI * 0.15, Math.PI * 0.85, true);
      ctx.lineTo(px - s * 0.5, py + s);
      ctx.lineTo(px + s * 0.5, py + s);
      ctx.closePath(); ctx.stroke(); ctx.fill();
      ctx.fillStyle = "#17130e";
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(px + side * s * 0.35, py - s * 0.1, s * 0.22, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillRect(px - s * 0.1, py + s * 0.38, s * 0.2, s * 0.5);
      break;
    }
    case "camp": {
      // Canvas tent with an open door and crossed ridge poles.
      ctx.moveTo(px, py - s);
      ctx.lineTo(px + s * 1.1, py + s * 0.8);
      ctx.lineTo(px - s * 1.1, py + s * 0.8);
      ctx.closePath(); ctx.stroke(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(px, py - s * 0.15); ctx.lineTo(px + s * 0.4, py + s * 0.8); ctx.lineTo(px - s * 0.4, py + s * 0.8); ctx.closePath();
      ctx.fillStyle = "#17130e"; ctx.fill();
      break;
    }
    case "resource": {
      // Faceted ore crystal rather than a generic coloured dot.
      ctx.moveTo(px, py - s * 1.15); ctx.lineTo(px + s * 0.75, py - s * 0.2); ctx.lineTo(px + s * 0.5, py + s * 0.9);
      ctx.lineTo(px - s * 0.5, py + s * 0.9); ctx.lineTo(px - s * 0.75, py - s * 0.2); ctx.closePath(); ctx.stroke(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(px, py - s * 0.9); ctx.lineTo(px, py + s * 0.7); ctx.moveTo(px - s * 0.6, py - s * 0.2); ctx.lineTo(px + s * 0.6, py - s * 0.2);
      ctx.strokeStyle = "#534125"; ctx.lineWidth = 1; ctx.stroke();
      break;
    }
    case "star": {
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? s * 0.45 : s * 1.1;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        if (i) ctx.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
        else ctx.moveTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      break;
    }
    case "flag": {
      // pole up from the spot, pennant to the right
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - s * 2);
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = fill;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px + 1, py - s * 2);
      ctx.lineTo(px + s * 1.3, py - s * 1.55);
      ctx.lineTo(px + 1, py - s * 1.1);
      ctx.closePath();
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.stroke();
      ctx.fill();
      break;
    }
    case "cross": {
      const d = s * 0.8;
      ctx.moveTo(px - d, py - d);
      ctx.lineTo(px + d, py + d);
      ctx.moveTo(px + d, py - d);
      ctx.lineTo(px - d, py + d);
      ctx.lineWidth = s * 0.55 + 3;
      ctx.stroke();
      ctx.lineWidth = s * 0.55;
      ctx.strokeStyle = fill;
      ctx.stroke();
      break;
    }
    case "ring": {
      ctx.arc(px, py, s * 0.85, 0, Math.PI * 2);
      ctx.lineWidth = s * 0.45 + 3;
      ctx.stroke();
      ctx.lineWidth = s * 0.45;
      ctx.strokeStyle = fill;
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/** Labels hidden below this many pixels per metre, by kind (collision decides the rest). */
const LABEL_MIN_SCALE: Record<MarkerKind, number> = {
  town: 0,
  place: 0.05,
  dungeon: 0.05,
  quest: 0.6,
  spawn: 0.45,
  pack: 0.3,
  mob: 0.9,
  reservation: 0.12,
  site: 0.35,
};
const LABEL_PRIORITY: Record<MarkerKind, number> = { town: 1, dungeon: 2, place: 3, quest: 4, pack: 5, reservation: 6, spawn: 7, mob: 8, site: 9 };

const levelColour = (level: number | undefined): string => {
  if (level === undefined) return "rgb(255,77,109)";
  const t = Math.max(0, Math.min(1, (level - 1) / 14));
  // green (easy) -> amber -> red -> violet (hard); the label carries the number too
  const stops = [[90, 220, 120], [255, 200, 60], [255, 77, 77], [190, 90, 255]];
  const f = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const k = f - i;
  const c = stops[i]!.map((v, j) => Math.round(v + (stops[i + 1]![j]! - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

export function drawMapLayers(ctx: CanvasRenderingContext2D, data: MapData, view: MapView, options: DrawOptions): void {
  const { width, height, scale } = view;
  const on = options.layers;
  const compact = !!options.compact;
  const font = options.font ?? "ui-sans-serif, system-ui, Segoe UI, sans-serif";
  const toX = (x: number): number => (x - view.cx) * scale + width / 2;
  const toY = (z: number): number => (z - view.cz) * scale + height / 2;
  const visible = (x: number, z: number, pad: number): boolean => {
    const px = toX(x);
    const py = toY(z);
    return px > -pad && py > -pad && px < width + pad && py < height + pad;
  };

  ctx.save();
  ctx.fillStyle = options.backgroundColor ?? "#0d1a26";
  ctx.fillRect(0, 0, width, height);
  // terrain: only the part of the picture under the view is sampled, so a
  // minimap redraw is one small drawImage however large the picture is
  const base = options.base;
  if (base) {
    const ppm = base.width / (2 * base.extent);
    const wx0 = view.cx - width / 2 / scale;
    const wz0 = view.cz - height / 2 / scale;
    const wx1 = view.cx + width / 2 / scale;
    const wz1 = view.cz + height / 2 / scale;
    const sx0 = Math.max(0, (wx0 + base.extent) * ppm);
    const sy0 = Math.max(0, (wz0 + base.extent) * ppm);
    const sx1 = Math.min(base.width, (wx1 + base.extent) * ppm);
    const sy1 = Math.min(base.height, (wz1 + base.extent) * ppm);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const dx = toX(sx0 / ppm - base.extent);
      const dy = toY(sy0 / ppm - base.extent);
      ctx.drawImage(base.image, sx0, sy0, sx1 - sx0, sy1 - sy0, dx, dy, ((sx1 - sx0) / ppm) * scale, ((sy1 - sy0) / ppm) * scale);
    }
  }

  const path = (pts: [number, number][], close: boolean): void => {
    ctx.beginPath();
    pts.forEach(([x, z], i) => (i === 0 ? ctx.moveTo(toX(x), toY(z)) : ctx.lineTo(toX(x), toY(z))));
    if (close) ctx.closePath();
  };

  // zones: the focused zone stays bright, the rest of the world is dimmed
  if (options.focusZone) {
    const focus = data.zones.find((z) => z.id === options.focusZone);
    if (focus) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      focus.polygon.forEach(([x, z], i) => (i === 0 ? ctx.moveTo(toX(x), toY(z)) : ctx.lineTo(toX(x), toY(z))));
      ctx.closePath();
      ctx.fillStyle = "rgba(5,8,12,0.55)";
      ctx.fill("evenodd");
      ctx.restore();
    }
  }
  if (on.has("zones")) {
    for (const zone of data.zones) {
      path(zone.polygon, true);
      ctx.setLineDash(zone.town ? [4, 3] : []);
      ctx.lineWidth = zone.town ? 1 : compact ? 1.5 : 2;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth += 2;
      ctx.stroke();
      ctx.lineWidth -= 2;
      ctx.strokeStyle = zone.town ? "rgba(255,210,200,0.6)" : zone.id === options.focusZone ? "#ffffff" : "rgba(255,255,255,0.75)";
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (data.limit > 0) {
    ctx.beginPath();
    ctx.arc(toX(0), toY(0), data.limit * scale, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(200,40,40,0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (on.has("roads")) {
    const wx0 = view.cx - width / 2 / scale;
    const wz0 = view.cz - height / 2 / scale;
    const wx1 = view.cx + width / 2 / scale;
    const wz1 = view.cz + height / 2 / scale;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const pass of [0, 1]) {
      for (const road of data.roads) {
        if (road.box[2] < wx0 || road.box[0] > wx1 || road.box[3] < wz0 || road.box[1] > wz1) continue;
        path(road.points, false);
        const w = road.trail ? 1 : Math.max(1.5, Math.min(5, 4 * scale));
        if (pass === 0) {
          ctx.strokeStyle = "rgba(40,28,14,0.7)";
          ctx.lineWidth = w + 2;
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = road.trail ? "#c8aa6e" : colourOf("roads");
          ctx.lineWidth = w;
          ctx.setLineDash(road.trail ? [3, 3] : []);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  // footprints first (under every glyph): reservations, spawn radii
  const markers = data.markers.filter((m) => on.has(LAYER_OF[m.kind]) && visible(m.x, m.z, (m.radius ?? 0) * scale + 40));
  for (const m of markers) {
    if (!m.radius) continue;
    const r = m.radius * scale;
    if (m.kind === "reservation") {
      ctx.beginPath();
      ctx.arc(toX(m.x), toY(m.z), Math.max(2, r), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(90,209,255,0.10)";
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = colourOf("reservations");
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (m.kind === "spawn" && r >= 2) {
      ctx.beginPath();
      ctx.arc(toX(m.x), toY(m.z), r, 0, Math.PI * 2);
      const c = levelColour(m.level);
      ctx.fillStyle = c.replace("rgb", "rgba").replace(")", ",0.16)");
      ctx.fill();
      ctx.strokeStyle = c;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (m.kind === "town" && r > 10) {
      ctx.beginPath();
      ctx.arc(toX(m.x), toY(m.z), r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,90,74,0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  // glyphs: least important first, so a town is never buried under a spawn dot
  const order = [...markers].sort((a, b) => LABEL_PRIORITY[b.kind] - LABEL_PRIORITY[a.kind]);
  const k = compact ? 0.8 : 1;
  for (const m of order) {
    const px = toX(m.x);
    const py = toY(m.z);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    switch (m.kind) {
      case "town": {
        const s = ({ capital: 7, city: 6, town: 5, village: 4, hamlet: 3.5 } as Record<string, number>)[m.detail ?? "town"] ?? 5;
        ctx.fillStyle = colourOf("towns");
        ctx.fillRect(px - s * k, py - s * k, 2 * s * k, 2 * s * k);
        ctx.strokeRect(px - s * k, py - s * k, 2 * s * k, 2 * s * k);
        break;
      }
      case "place":
        dot(ctx, px, py, 4.5 * k, m.detail === "planned" ? "rgba(255,179,71,0.35)" : colourOf("places"));
        break;
      case "dungeon":
        ctx.beginPath();
        ctx.moveTo(px, py - 7 * k);
        ctx.lineTo(px + 6 * k, py);
        ctx.lineTo(px, py + 7 * k);
        ctx.lineTo(px - 6 * k, py);
        ctx.closePath();
        ctx.fillStyle = colourOf("dungeons");
        ctx.fill();
        ctx.stroke();
        break;
      case "quest":
        dot(ctx, px, py, 5 * k, "#1d1a10");
        ctx.font = `700 ${Math.round(10 * k)}px ${font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = colourOf("quests");
        ctx.fillText("!", px, py + 0.5);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        break;
      case "spawn":
        dot(ctx, px, py, 2.5 * k, levelColour(m.level));
        break;
      case "pack":
      case "mob": {
        const s = (m.kind === "pack" ? 6 : 4) * k;
        ctx.beginPath();
        ctx.moveTo(px, py - s);
        ctx.lineTo(px + s, py + s * 0.8);
        ctx.lineTo(px - s, py + s * 0.8);
        ctx.closePath();
        ctx.fillStyle = m.kind === "pack" ? colourOf("packs") : levelColour(m.level);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case "reservation":
        dot(ctx, px, py, 2, colourOf("reservations"));
        break;
      case "site":
        dot(ctx, px, py, 2, colourOf("sites"));
        break;
    }
  }

  // labels: zone names first, then by marker priority; a label that would
  // overlap one already placed tries the other sides, then is dropped (zoom in)
  const placed: [number, number, number, number][] = [];
  const free = (x: number, y: number, w: number, h: number): boolean =>
    x >= 0 && y >= 0 && x + w <= width && y + h <= height && !placed.some((b) => x < b[0] + b[2] && b[0] < x + w && y < b[1] + b[3] && b[1] < y + h);
  const write = (text: string, x: number, y: number, size: number, colour: string, weight = 500): void => {
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  };
  // the player's arrow claims its space before any label
  for (const r of options.avoid ?? []) placed.push(r);
  if (options.player) placed.push([toX(options.player.x) - 10, toY(options.player.z) - 10, 20, 20]);
  if (on.has("zones")) {
    const size = compact ? 11 : 14;
    for (const zone of data.zones) {
      if (zone.town) continue; // a town zone is named by its town marker
      if (!visible(zone.hub[0], zone.hub[1], 100)) continue;
      ctx.font = `700 ${size}px ${font}`;
      const text = compact ? zone.name : zone.name.toUpperCase();
      const w = ctx.measureText(text).width;
      // over the hub, nudged up/down until clear
      for (const dy of [-28, -44, 22, -60, 38]) {
        const x = toX(zone.hub[0]) - w / 2;
        const y = toY(zone.hub[1]) + dy;
        if (free(x, y - size, w, size + 2)) {
          placed.push([x - 4, y - size - 2, w + 8, size + 6]);
          write(text, x, y, size, zone.id === options.focusZone ? "#ffffff" : "rgba(255,255,255,0.9)", 700);
          break;
        }
      }
    }
  }
  if (on.has("labels")) {
    const size = compact ? 10 : 12;
    const candidates = order
      .filter((m) => scale >= LABEL_MIN_SCALE[m.kind] * (compact ? 1.5 : 1))
      .sort((a, b) => LABEL_PRIORITY[a.kind] - LABEL_PRIORITY[b.kind]);
    for (const m of candidates) {
      let text = m.name;
      if ((m.kind === "spawn" || m.kind === "pack" || m.kind === "mob") && m.level !== undefined) text += ` L${m.level}`;
      if (m.kind === "dungeon" && !compact) text += " (dungeon)";
      if (m.kind === "reservation" && m.radius) text += ` r${Math.round(m.radius)}`;
      if (m.detail === "planned") text += " (planned)";
      const big = m.kind === "town";
      const fs = big ? size + 2 : m.kind === "spawn" || m.kind === "site" || m.kind === "mob" ? size - 2 : size;
      ctx.font = `${big ? 700 : 500} ${fs}px ${font}`;
      const w = ctx.measureText(text).width;
      const px = toX(m.x);
      const py = toY(m.z);
      const spots: [number, number][] = [[px + 9, py + fs / 2 - 1], [px - 9 - w, py + fs / 2 - 1], [px - w / 2, py - 9], [px - w / 2, py + fs + 8]];
      for (const [x, y] of spots) {
        if (!free(x - 1, y - fs, w + 2, fs + 3)) continue;
        placed.push([x - 1, y - fs, w + 2, fs + 3]);
        const colour = m.kind === "town" ? "#ffe0d8" : m.kind === "quest" ? "#fff2a8" : m.kind === "dungeon" ? "#e6d2ff" : m.kind === "reservation" ? "#bfeeff" : m.kind === "spawn" || m.kind === "mob" ? levelColour(m.level) : m.kind === "site" ? "#c9ced4" : "#ffe2bd";
        write(text, x, y, fs, colour, big ? 700 : 500);
        break;
      }
    }
  }

  // player markers: above every map glyph and label
  if (options.pins?.length) {
    const s = compact ? 5 : 7;
    for (const pin of options.pins) {
      let px = toX(pin.x);
      let py = toY(pin.z);
      if (px < 0 || py < 0 || px > width || py > height) {
        if (!compact) continue;
        // minimap: a marker beyond the edge sits on the edge, dimmed, in its direction
        const pad = 10;
        const cx = width / 2;
        const cy = height / 2;
        const t = Math.min((cx - pad) / Math.max(1e-6, Math.abs(px - cx)), (cy - pad) / Math.max(1e-6, Math.abs(py - cy)));
        px = cx + (px - cx) * t;
        py = cy + (py - cy) * t;
        ctx.save();
        ctx.globalAlpha = 0.7;
        drawPinGlyph(ctx, pin.shape, px, py + (pin.shape === "pin" || pin.shape === "flag" ? s * 0.8 : 0), s * 0.8, options.pinColor);
        ctx.restore();
        continue;
      }
      if (pin.id === options.selectedPin) {
        ctx.beginPath();
        ctx.arc(px, py, s * 2.2, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }
      drawPinGlyph(ctx, pin.shape, px, py, s, options.pinColor);
      const label = pin.label.trim();
      if (!label) continue;
      const fs = compact ? 10 : 12;
      ctx.font = `600 ${fs}px ${font}`;
      const w = ctx.measureText(label).width;
      const lift = pin.shape === "pin" || pin.shape === "flag" ? s : 0;
      const spots: [number, number][] = [[px + s + 4, py + fs / 2 - 1 - lift], [px - s - 4 - w, py + fs / 2 - 1 - lift], [px - w / 2, py + fs + s]];
      // on the full map the player's own label is always written (first free side, else the right)
      const spot = spots.find(([x, y]) => free(x - 1, y - fs, w + 2, fs + 3)) ?? (compact ? null : spots[0]!);
      if (!spot) continue;
      placed.push([spot[0] - 1, spot[1] - fs, w + 2, fs + 3]);
      write(label, spot[0], spot[1], fs, options.pinLabelColor ?? "#d9f6ff", 600);
    }
  }

  if (options.player) {
    const { x, z, yaw } = options.player;
    ctx.save();
    ctx.translate(toX(x), toY(z));
    ctx.rotate(-yaw);
    ctx.beginPath();
    ctx.moveTo(0, -10 * k);
    ctx.lineTo(7 * k, 8 * k);
    ctx.lineTo(0, 4 * k);
    ctx.lineTo(-7 * k, 8 * k);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#000000";
    ctx.stroke();
    ctx.restore();
  }

  if (!compact) {
    // scale bar: the largest of 50 m .. 5 km that fits in a fifth of the width
    const steps = [50, 100, 250, 500, 1000, 2000, 5000];
    let metres = steps[0]!;
    for (const s of steps) if (s * scale <= width / 5) metres = s;
    const bar = metres * scale;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(width - bar - 28, height - 34, bar + 16, 26);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(width - bar - 20, height - 16, bar, 3);
    write(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, width - bar - 20, height - 21, 11, "#ffffff");
    // north
    write("N ↑", width / 2 - 10, 18, 12, "#ffffff", 700);
  }
  ctx.restore();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.stroke();
}

/** The legend as canvas drawing (the review PNG; the in-game map has a DOM legend with toggles). */
export function drawLegend(ctx: CanvasRenderingContext2D, layers: ReadonlySet<LayerId>, x: number, y: number, title: string, counts: Partial<Record<LayerId, number>> = {}): void {
  const rows = LAYERS.filter((l) => layers.has(l.id) && l.id !== "labels");
  const w = 250;
  const h = 34 + rows.length * 18 + (layers.has("spawns") || layers.has("packs") ? 22 : 0);
  ctx.save();
  ctx.fillStyle = "rgba(10,13,18,0.88)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#2a2f3a";
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.font = "700 13px ui-sans-serif, system-ui, Segoe UI, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(title, x + 10, y + 20);
  ctx.font = "12px ui-sans-serif, system-ui, Segoe UI, sans-serif";
  rows.forEach((l, i) => {
    const ry = y + 40 + i * 18;
    legendSwatch(ctx, l, x + 18, ry - 4);
    ctx.fillStyle = "#e6e9ef";
    ctx.fillText(`${l.label}${counts[l.id] !== undefined ? `  (${counts[l.id]})` : ""}`, x + 34, ry);
  });
  if (layers.has("spawns") || layers.has("packs")) {
    const ry = y + 40 + rows.length * 18 + 2;
    ctx.fillStyle = "#e6e9ef";
    ctx.fillText("level", x + 10, ry);
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = levelColour(1 + i * 2);
      ctx.fillRect(x + 50 + i * 22, ry - 10, 22, 10);
    }
    ctx.fillStyle = "#e6e9ef";
    ctx.fillText("1", x + 52, ry + 12);
    ctx.fillText("15", x + 50 + 7 * 22 + 4, ry + 12);
  }
  ctx.restore();
}

/** One legend glyph, matching the map's own marks. */
export function legendSwatch(ctx: CanvasRenderingContext2D, l: LayerInfo, x: number, y: number): void {
  ctx.save();
  ctx.fillStyle = l.colour;
  ctx.strokeStyle = l.colour;
  ctx.lineWidth = 2;
  ctx.beginPath();
  switch (l.shape) {
    case "line":
      ctx.moveTo(x - 7, y);
      ctx.lineTo(x + 7, y);
      ctx.stroke();
      break;
    case "ring":
    case "circle":
      ctx.setLineDash(l.shape === "ring" ? [3, 2] : []);
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "square":
      ctx.fillRect(x - 5, y - 5, 10, 10);
      break;
    case "diamond":
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 5, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 5, y);
      ctx.fill();
      break;
    case "triangle":
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y + 5);
      ctx.lineTo(x - 6, y + 5);
      ctx.fill();
      break;
    case "bang":
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#1d1a10";
      ctx.fill();
      ctx.fillStyle = l.colour;
      ctx.font = "700 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", x, y + 0.5);
      break;
    case "text":
      ctx.font = "700 11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Aa", x, y);
      break;
    default:
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
  }
  ctx.restore();
}

/** Marker counts per layer (legend numbers). */
export function layerCounts(data: MapData): Partial<Record<LayerId, number>> {
  const counts: Partial<Record<LayerId, number>> = { zones: data.zones.filter((z) => !z.town).length, roads: data.roads.length };
  for (const m of data.markers) counts[LAYER_OF[m.kind]] = (counts[LAYER_OF[m.kind]] ?? 0) + 1;
  return counts;
}
