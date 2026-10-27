/**
 * Wanderer tables: zones/<z>/wanderers.json — the packs and roamers that WALK a zone (owner ruling 2026-10-22: "I want
 * to SEE wandering mobs"; no ravens or horses as starter wanderers). `zonegen populate` reads the table and writes each
 * row as a roaming `spawnArea`:
 *  - placement `route`: a pack (a roll of 2-4, or a band with `with` companions) walking a road corridor out and back,
 *    or a LOOP over the moor / round a gorge rim (spawnArea `loop`), every member of a roll setting off the same way;
 *  - placement `anywhere`: singles and pairs roaming a disc round a place (spiders at a cave mouth, rats at a midden),
 *    `hours` gating it to a world-clock window (bats at dusk and night).
 * Rules that live here (the one place): which families are never wanderers in a starter zone, and the `wanderers`
 * status row's bar (at least WANDER_RULES.minHostileKinds hostile kinds roam the zone).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Ctx, Finding } from "../lib.mts";

export const WANDER_RULES = {
  /** Families that are never wanderers in a starter zone (birds and livestock): a place that wants them declares them. */
  neverInStarter: ["raven", "horse", "goat", "sheep", "pig", "bison"] as readonly string[],
  /** A zone's roaming set must hold at least this many distinct hostile kinds (families). */
  minHostileKinds: 4,
  /** A starter zone fails when more than this share of its creatures alive attacks on sight. */
  starterHostileMax: 0.5,
  /** Metres a WARY creature lets a stranger come before it attacks (spawnArea.territory for temperament territorial). */
  waryMetres: 6,
  /**
   * Alive cap in view: at most this many creatures alive inside any circle of viewRadius metres (every area counted by
   * its alive SHARE inside the circle: a disc by overlap, a route by its points). Frame time and server AI scale with it.
   * Raise only on PERF-STREAM's word.
   */
  viewCap: 30,
  viewRadius: 150,
  /** Share of a starter zone's wolf packs that are wary rather than hostile (picked per area, deterministic). */
  starterWaryWolves: 0.6,
} as const;

/**
 * Dispositions a wanderer row (or a starter zone's wildlife) can carry, as mob-brain temperaments:
 * hostile = attacks on sight; wary = attacks only who comes within WANDER_RULES.waryMetres (territorial);
 * neutral = never starts a fight, fights back when hit (passive); skittish = the same, and wanders off (passive).
 */
export const DISPOSITIONS = { passive: "passive", wary: "territorial", aggressive: "hostile", hostile: "hostile", neutral: "passive", skittish: "passive" } as const;

/**
 * A starter zone is an EverQuest starting zone (owner ruling 2026-10-22): lots of passive, some aggressive. Shares of
 * the creatures alive in the zone by disposition (passive = ignores players until attacked, wary = attacks within
 * waryMetres, aggressive = on sight); the `wanderers` row fails a starter zone outside target ± band.
 */
export const STARTER_MIX = { passive: 0.6, wary: 0.15, aggressive: 0.25, band: 0.1 } as const;
export type Shares = { passive: number; wary: number; aggressive: number };
/** The mix lint: each share inside its target ± band. */
export function starterMixFindings(s: Shares): Finding[] {
  const out: Finding[] = [];
  for (const k of ["passive", "wary", "aggressive"] as const)
    if (Math.abs(s[k] - STARTER_MIX[k]) > STARTER_MIX.band + 1e-9)
      out.push({ level: "warn", code: "starter-mix", message: `starter zone: ${Math.round(s[k] * 100)}% ${k} (target ${Math.round(STARTER_MIX[k] * 100)}% ± ${Math.round(STARTER_MIX.band * 100)})` });
  return out;
}
/** Fodder (passive) is 1-3 levels under where it stands; `key` picks the step deterministically. */
export const fodderLevel = (level: number, key: string): number => Math.max(1, level - 1 - Math.floor(hash01(key) * 3));
export type Disposition = keyof typeof DISPOSITIONS;

/**
 * A starter zone's default disposition by family (owner ruling: at most half the life attacks on sight): wolves,
 * spiders and humans hostile, a share of wolf packs wary, rats and bats neutral until provoked, deer and birds skittish.
 * `key` makes the wolf share deterministic per area.
 */
export function starterDisposition(family: string, key: string): Disposition {
  if (family === "wolf") return hash01(key) < WANDER_RULES.starterWaryWolves ? "wary" : "aggressive";
  if (["rat", "giant-rat", "bat", "beetle", "salamander", "dragonfly", "deer", "muledeer", "elk", "raven", "goat", "sheep", "horse", "pig", "bison", "bighornsheep"].includes(family)) return "passive";
  return "aggressive";
}
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000003) / 1000003;
}

const temperament = z.enum(["hostile", "territorial", "passive"]);
const disposition = z.enum(["passive", "wary", "aggressive", "hostile", "neutral", "skittish"]).describe("passive (= neutral, skittish) ignores players until attacked and stands 1-3 levels under where it lives (fodder); wary attacks only within WANDER_RULES.waryMetres; aggressive (= hostile) attacks on sight. Wins over `temperament`. Unset in a starter zone = the family's default (starterDisposition).");
const member = z.object({
  creature: z.string().min(1).describe("Catalogue bestiary creature id (wolf, giant-spider, bandit-cutthroat...)."),
  theme: z.string().default("").describe("Theme of that creature (its painted skin or, for a human, its outfit set)."),
  name: z.string().optional().describe("Display name, '<Kin> <Role>' (Moor Wolf, Bandit Cutpurse). Default: the catalogue's."),
  role: z.enum(["melee", "ranged", "caster", "swarm", "brute", "skirmisher", "support", "elite", "boss"]).optional().describe("Combat role (pack stats). Default: the creature's first role."),
});
const mixRow = member.extend({
  weight: z.number().positive().default(1),
  count: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([1, 1]).describe("[min, max] of this row spawned together by one roll."),
  temperament: temperament.optional(),
  disposition: disposition.optional(),
  with: z.array(member).default([]).describe("Companions spawned in the same roll (a band): each its own template."),
});
const rare = member.extend({
  id: z.string().min(1),
  name: z.string().min(1).describe("The rare's own name (Greyjaw)."),
  title: z.string().optional().describe("Its title (the Moor Reaver)."),
  level: z.number().int().min(1),
  scale: z.number().positive().default(1),
  chance: z.number().min(0).max(1).default(0.12),
  lockout: z.tuple([z.number().min(0), z.number().min(0)]).default([600, 1200]),
});
const anchor = z.object({
  near: z.string().optional().describe("A reserved location id: its centre."),
  at: z.tuple([z.number(), z.number()]).optional().describe("[x, z] world metres."),
});
export const wandererAreaSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  placement: z.enum(["route", "anywhere", "solo"]).describe(
    "route: a pack walking a road or a loop. anywhere: singles and pairs roaming one disc. solo: SINGLE creatures (each roll is one) on short wander loops, " +
      "scattered over many discs: one per `places` entry, or the whole zone's open land tiled (`tile`). Owner ruling 2026-10-22: a hunting ground is mostly solos; packs are the exception.",
  ),
  places: z.array(z.string()).optional().describe("`solo`: reserved location ids, one disc round each."),
  tile: z.boolean().optional().describe("`solo`: tile the zone's open land (off towns, water, cliffs) with discs of `radius`."),
  perKm2: z.number().positive().optional().describe("`solo`: creatures alive per km² of a disc's open land (instead of `population`, which is then per disc)."),
  route: z
    .object({
      road: z.array(z.string()).optional().describe("Recipe road ids walked as one corridor (their points inside the zone, clear of sanctuaries)."),
      offset: z.number().default(0).describe("Metres to the side of the road the corridor runs (positive = left of travel)."),
      loop: z.object({ near: z.string().optional(), at: z.tuple([z.number(), z.number()]).optional(), radius: z.number().positive() }).optional().describe("A closed loop of this radius round a place, bent onto walkable ground."),
      points: z.array(z.tuple([z.number(), z.number()])).optional().describe("Explicit [x, z] route points."),
      closed: z.boolean().default(false).describe("`points` form a loop."),
    })
    .optional(),
  at: anchor.optional().describe("`anywhere`: the disc's centre."),
  radius: z.number().positive().default(150).describe("`anywhere`: the disc creatures spawn and roam in (shrunk to stay off towns and inside the zone)."),
  population: z.number().int().min(1).optional().describe("Creatures alive at once (per disc for `solo`). Required unless a `solo` gives `perKm2`."),
  level: z.number().int().min(1).optional().describe("Default: walking distance from the hub, as every populate level."),
  hours: z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)]).optional(),
  temperament: temperament.optional(),
  disposition: disposition.optional(),
  mix: z.array(mixRow).min(1),
  rares: z.array(rare).default([]),
});
export const wanderersSchema = z.object({ zone: z.string(), note: z.string().optional(), areas: z.array(wandererAreaSchema).default([]) });
export type WandererArea = z.infer<typeof wandererAreaSchema>;
export type Wanderers = z.infer<typeof wanderersSchema>;

export function wanderersFile(ctx: Ctx, zone: string): string {
  return path.join(ctx.paths.zoneDir(zone), "wanderers.json");
}

export function loadWanderers(ctx: Ctx, zone: string, f: Finding[]): Wanderers | null {
  const file = wanderersFile(ctx, zone);
  if (!fs.existsSync(file)) return null;
  const parsed = wanderersSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    f.push({ level: "error", code: "wanderers-schema", message: `wanderers.json: ${i.path.join(".")}: ${i.message}` });
    return null;
  }
  return parsed.data;
}

/** Every creature a row of the table can put on the ground (mix rows, companions, rares). */
export function wandererCreatures(a: WandererArea): Array<{ creature: string; temperament: string }> {
  const out: Array<{ creature: string; temperament: string }> = [];
  for (const m of a.mix) {
    const d = m.disposition ?? a.disposition;
    const t = d ? DISPOSITIONS[d] : (m.temperament ?? a.temperament ?? "hostile");
    out.push({ creature: m.creature, temperament: t });
    for (const w of m.with) out.push({ creature: w.creature, temperament: t });
  }
  for (const r of a.rares) out.push({ creature: r.creature, temperament: "hostile" });
  return out;
}

/**
 * The table's rules: birds and livestock never wander a starter zone, and at least `minHostileKinds` hostile kinds
 * (families) roam it. `familyOf` maps a creature id to its family (unknown -> the id).
 */
export function wandererFindings(w: Wanderers | null, familyOf: (creature: string) => string, starter: boolean): Finding[] {
  const f: Finding[] = [];
  if (!w || !w.areas.length) {
    f.push({ level: "error", code: "wanderers-none", message: "no wanderer table (zones/<z>/wanderers.json): nothing walks the roads or the moor" });
    return f;
  }
  const hostile = new Set<string>();
  for (const a of w.areas)
    for (const c of wandererCreatures(a)) {
      const fam = familyOf(c.creature);
      if (starter && WANDER_RULES.neverInStarter.includes(fam))
        f.push({ level: "error", code: "wanderer-banned", message: `${a.id}: ${c.creature} (${fam}) never wanders a starter zone (birds and livestock stay at the places that declare them)` });
      if (c.temperament === "hostile") hostile.add(fam);
    }
  if (hostile.size < WANDER_RULES.minHostileKinds)
    f.push({ level: "error", code: "wanderers-thin", message: `only ${hostile.size} hostile kind(s) roam the zone (${[...hostile].join(", ") || "none"}); the bar is ${WANDER_RULES.minHostileKinds}` });
  return f;
}

/** A route's points resampled every `every` metres (keeps the ends). */
export function resample(points: ReadonlyArray<readonly [number, number]>, every: number): Array<[number, number]> {
  if (points.length < 2) return points.map((p) => [p[0], p[1]]);
  const out: Array<[number, number]> = [[points[0]![0], points[0]![1]]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]!;
    const [bx, bz] = points[i]!;
    const l = Math.hypot(bx - ax, bz - az);
    let d = every - carry;
    while (d <= l) {
      out.push([ax + ((bx - ax) * d) / l, az + ((bz - az) * d) / l]);
      d += every;
    }
    carry = l - (d - every);
  }
  const last = points[points.length - 1]!;
  const tail = out[out.length - 1]!;
  if (Math.hypot(tail[0] - last[0], tail[1] - last[1]) > every * 0.3) out.push([last[0], last[1]]);
  return out;
}

/** Shift a polyline sideways by `d` metres (left of travel positive). */
export function offsetLine(points: ReadonlyArray<readonly [number, number]>, d: number): Array<[number, number]> {
  if (!d || points.length < 2) return points.map((p) => [p[0], p[1]]);
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(points.length - 1, i + 1)]!;
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    return [p[0] - (tz / l) * d, p[1] + (tx / l) * d];
  });
}

/** The longest run of consecutive points that pass `ok`. */
export function longestRun<T>(points: readonly T[], ok: (p: T) => boolean): T[] {
  let best: T[] = [];
  let cur: T[] = [];
  for (const p of points) {
    if (ok(p)) cur.push(p);
    else {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  return cur.length > best.length ? cur : best;
}

/** Route length in metres. */
export function routeLength(points: ReadonlyArray<readonly [number, number]>): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return l;
}

/** A display name as a template-id slug ("Bandit Cutpurse" -> "bandit-cutpurse"). */
export const nameSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The `wanderers` status row: FAILED when the table breaks a rule (a bird or livestock wandering a starter zone, fewer
 * than WANDER_RULES.minHostileKinds hostile kinds), MISSING when there is no table or its areas are not in the scene.
 */
export function wanderersRow(ctx: Ctx, zone: string): { state: "ok" | "MISSING" | "FAILED"; why: string; how: string } {
  const how = `write zones/${zone}/wanderers.json -> npx tsx tools/zonegen.mts populate ${ctx.world} --project ${ctx.project} --zone ${zone} -> coordinator: its install.mts`;
  const f: Finding[] = [];
  const w = loadWanderers(ctx, zone, f);
  if (f.length) return { state: "FAILED", why: f[0]!.message, how };
  if (!w) return { state: "MISSING", why: "no wanderer table: nothing walks the roads or the moor", how };
  const read = (file: string): unknown => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
  const cat = read(ctx.paths.bestiary) as { creatures?: Array<{ id: string; family: string }> } | null;
  const fam = new Map((cat?.creatures ?? []).map((c) => [c.id, c.family]));
  const cast = read(ctx.paths.cast) as { rows?: Array<{ zone: string; starter?: boolean }> } | null;
  const starter = (cast?.rows ?? []).some((r) => r.zone === zone && r.starter);
  const bad = wandererFindings(w, (id) => fam.get(id) ?? id, starter).filter((x) => x.level === "error");
  if (bad.length) return { state: "FAILED", why: bad.map((x) => x.message).join("; "), how };
  const scene = read(path.join(ctx.paths.projectDir, "assets", "scenes", `${ctx.world}.scene.json`)) as { entities?: Record<string, unknown> } | null;
  const ents = scene?.entities ?? {};
  const missing = w.areas.filter((a) => !Object.keys(ents).some((id) => id === `pop-${zone}-wander-${a.id}` || id.startsWith(`pop-${zone}-wander-${a.id}-`)));
  const kinds = new Set(w.areas.flatMap((a) => wandererCreatures(a).filter((c) => c.temperament === "hostile").map((c) => fam.get(c.creature) ?? c.creature)));
  const summary = `${w.areas.length} wanderer areas, ${w.areas.filter((a) => a.placement !== "solo").length} pack/roamer + ${w.areas.filter((a) => a.placement === "solo").length} solo tables, ${kinds.size} hostile kinds (${[...kinds].join(", ")})`;
  const rep = read(ctx.paths.report("populate", zone)) as { numbers?: { hostileShare?: number; aliveInView?: { count: number; at: number[] } } } | null;
  const share = rep?.numbers?.hostileShare;
  const view = rep?.numbers?.aliveInView;
  const mixShares = (rep?.numbers as { dispositionShares?: Shares } | undefined)?.dispositionShares;
  if (starter && mixShares) {
    const bad = starterMixFindings(mixShares);
    if (bad.length) return { state: "FAILED", why: `${summary}; ${bad.map((b) => b.message.replace("starter zone: ", "")).join("; ")}`, how };
  }
  if (view && view.count > WANDER_RULES.viewCap)
    return { state: "FAILED", why: `${summary}; ${view.count} creatures alive within ${WANDER_RULES.viewRadius} m of [${view.at.join(", ")}] (cap ${WANDER_RULES.viewCap})`, how };
  if (starter && typeof share === "number" && share > WANDER_RULES.starterHostileMax)
    return { state: "FAILED", why: `${summary}; ${Math.round(share * 100)}% of the zone's creatures attack on sight (starter bar ${Math.round(WANDER_RULES.starterHostileMax * 100)}%)`, how };
  if (missing.length) return { state: "MISSING", why: `${summary}; ${missing.length} not installed (${missing.slice(0, 3).map((a) => a.id).join(", ")})`, how };
  return { state: "ok", why: `${summary}${typeof share === "number" ? `; ${Math.round(share * 100)}% hostile on sight` : ""}${mixShares ? `; passive ${Math.round(mixShares.passive * 100)}% / wary ${Math.round(mixShares.wary * 100)}% / aggressive ${Math.round(mixShares.aggressive * 100)}%` : ""}${view ? `; worst ${view.count} alive in ${WANDER_RULES.viewRadius} m` : ""}`, how };
}
