/**
 * Helpers the zonegen commands share: reading the world recipe as ZONES (not as a field), the adjacency file,
 * the town name <-> id index, and small geometry. Underscore-prefixed: not a command (the dispatcher skips it).
 *
 * Nothing here builds the world field. Every check that would need ground heights says so in its finding instead.
 */
import fs from "node:fs";
import path from "node:path";
import { pointInPolygon, type WorldRecipe } from "@hitreg/core";
import { exists, readJson, type Finding, type Paths } from "../lib.mts";

export type Tier = "hamlet" | "village" | "town" | "city" | "capital";
export const TIERS: readonly Tier[] = ["hamlet", "village", "town", "city", "capital"];
export const WEALTH = ["destitute", "poor", "comfortable", "wealthy", "noble"] as const;

export const err = (f: Finding[], code: string, message: string, ref?: string): void => void f.push({ level: "error", code, message, ref });
export const warn = (f: Finding[], code: string, message: string, ref?: string): void => void f.push({ level: "warn", code, message, ref });

type Region = WorldRecipe["regions"][number];
type TownDoc = WorldRecipe["features"]["towns"][number];
export type P2 = readonly [number, number];

export interface ZoneTown { id: string; zone: string; name: string; tier: Tier; center: [number, number]; radius: number; falloff: number }
export interface ZoneSummary { id: string; name: string; level?: [number, number]; towns: ZoneTown[]; neighbours: string[] }
export interface Border { a: string; b: string; length: number; passes: string[]; paths: string[]; /** Shorter than MIN_BORDER: a corner touch (absent in files written before it existed). */ short?: boolean }
export interface Adjacency { world: string; at: string; zones: ZoneSummary[]; borders: Border[] }

export const tierOf = (t: TownDoc): Tier => (t.tier as Tier | undefined) ?? (t.tags.includes("capital") ? "capital" : "town");
export const wildZones = (recipe: WorldRecipe): Region[] => recipe.regions.filter((r) => r.within === undefined);

/** A wilderness zone's towns: the town zones cut out of it (`within` = it), each naming its town in landmarks[0]. */
export function zoneTowns(recipe: WorldRecipe, zone: string): ZoneTown[] {
  const out: ZoneTown[] = [];
  for (const r of recipe.regions) {
    if (r.within !== zone) continue;
    const id = r.landmarks[0] ?? "";
    const t = recipe.features.towns.find((x) => x.id === id);
    if (!t) continue;
    out.push({ id: t.id, zone: r.id, name: r.name, tier: tierOf(t), center: t.center, radius: t.radius, falloff: t.falloff });
  }
  return out;
}

export function readAdjacency(paths: Paths, findings: Finding[]): Adjacency | null {
  if (!exists(paths.adjacency)) {
    err(findings, "missing-file", `adjacency not computed yet: run \`zonegen adjacency\``);
    return null;
  }
  return readJson(paths.adjacency) as Adjacency;
}
export const neighboursOf = (adj: Adjacency, zone: string): string[] => adj.zones.find((z) => z.id === zone)?.neighbours ?? [];
export const borderOf = (adj: Adjacency, a: string, b: string): Border | undefined =>
  adj.borders.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));

/**
 * Town docs (`authoring/towns/<name>.json`, holding `town` = the recipe town id and `world`) are how a town NAME
 * (the file stem every town tool takes as --town) maps to its recipe id. Plans, layouts and surveys carry `town`
 * too but never `world`, which is what tells them apart.
 */
export function townNames(paths: Paths, world: string): Map<string, string> {
  const dir = path.join(paths.projectDir, "authoring", "towns");
  const byId = new Map<string, string>();
  if (!fs.existsSync(dir)) return byId;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const doc = readJson(path.join(dir, f)) as { town?: unknown; world?: unknown };
      if (typeof doc.town === "string" && doc.world === world) byId.set(doc.town, f.slice(0, -5));
    } catch {
      /* not a town doc */
    }
  }
  return byId;
}

export function distToPolyline(x: number, z: number, pts: readonly P2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  if (pts.length === 1) best = Math.hypot(x - pts[0]![0], z - pts[0]![1]);
  return best;
}

export const inZone = (region: Region, x: number, z: number): boolean => pointInPolygon(x, z, region.polygon);

/** Word set for the near-duplicate checks: lower-case words of 4+ letters, a few fillers dropped. */
const STOP = new Set(["that", "this", "with", "from", "their", "they", "have", "were", "what", "where", "into", "over", "here", "there", "them", "which", "while", "been", "only", "every"]);
export const tokens = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? []);
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Gap in levels between two bands' entry points: what a player feels walking over the border. */
export const levelStep = (a: readonly [number, number], b: readonly [number, number]): number => Math.abs(a[0] - b[0]);
export const bandsOverlap = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] <= b[1] && b[0] <= a[1];

export const rel = (paths: Paths, file: string): string => path.relative(paths.projectDir, file).replaceAll("\\", "/");
export const requireZone = (zone: string, cmd: string): number | null => {
  if (zone) return null;
  console.error(`zonegen ${cmd}: give --zone <id>`);
  return 2;
};

/**
 * How well a creature's level band fits a zone's: "none" when they do not overlap (an error), "thin" when the overlap
 * covers under half of the zone's band (a warning: a 8-25 creature leading a 1-10 zone), else "fine".
 */
export function levelFit(creature: readonly [number, number], zone: readonly [number, number]): "none" | "thin" | "fine" {
  const overlap = Math.min(creature[1], zone[1]) - Math.max(creature[0], zone[0]) + 1;
  if (overlap <= 0) return "none";
  return overlap * 2 < zone[1] - zone[0] + 1 ? "thin" : "fine";
}

/** Roles that fight in melee: a brute and a skirmisher are melee fighters too. */
export const MELEE_ROLES = new Set(["melee", "brute", "skirmisher"]);

/** Borders shorter than this (metres) are corner touches: no pass is attributed to them and no level step is judged across them. */
export const MIN_BORDER = 120;

/** Building sets the project can build from: the WFC kits in assets/wfc (`<set>-<building>.tileset.json`, `<set>.tileset.json`). */
export function buildingSets(paths: Paths): string[] {
  const dir = path.join(paths.projectDir, "assets", "wfc");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".tileset.json")).map((f) => f.slice(0, -".tileset.json".length));
}
export const buildingSetKnown = (sets: string[], set: string): boolean => sets.some((s) => s === set || s.startsWith(`${set}-`));
