/**
 * Build-side reads the late zonegen commands share (poi-brief, bind, bind-check, explore, audit): the frozen plan of a
 * zone in one load, what is actually placed in the zone's scene, which planned residents stand in a town doc, and the
 * state of each POI job. Underscore-prefixed: not a command.
 *
 * Evidence, never claims: a resident is "placed" when its town doc gives it a spot AND its entity exists in the scene
 * (town-npcs writes it); a declared quest entity is placed when an entity of that id exists in the scene; a location
 * is built when its POI job's progress.json says `installed`.
 */
import fs from "node:fs";
import path from "node:path";
import { exists, readJson, type Ctx, type Finding } from "../lib.mts";
import {
  bestiarySchema,
  questGraphSchema,
  reservationsSchema,
  zoneBestiarySchema,
  zoneBriefSchema,
  type Bestiary,
  type QuestGraph,
  type Reservation,
  type Reservations,
  type ZoneBestiary,
  type ZoneBrief,
} from "../schemas.mts";
import { townNames } from "./_shared.mts";

export interface ZonePlan {
  brief: ZoneBrief;
  graph: QuestGraph;
  reservations: Reservations;
  zoneBestiary: ZoneBestiary | null;
  bestiary: Bestiary | null;
}

/** The frozen plan of one zone, or the reasons it cannot be read. */
export function loadZonePlan(ctx: Ctx, zone: string, f: Finding[]): ZonePlan | null {
  const p = ctx.paths;
  const parse = <T,>(file: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, what: string): T | null => {
    if (!exists(file)) {
      f.push({ level: "error", code: "missing-file", message: `${what} not written: ${path.relative(process.cwd(), file)}` });
      return null;
    }
    const r = schema.safeParse(readJson(file));
    if (!r.success) {
      f.push({ level: "error", code: "schema", message: `${what}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
      return null;
    }
    return r.data;
  };
  const brief = parse(p.brief(zone), zoneBriefSchema, "zone brief");
  const graph = parse(p.quests(zone), questGraphSchema, "quest graph");
  const reservations = parse(p.reservations(zone), reservationsSchema, "reservations");
  if (!brief || !graph || !reservations) return null;
  const zoneBestiary = exists(p.zoneBestiary(zone)) ? parse(p.zoneBestiary(zone), zoneBestiarySchema, "zone bestiary") : null;
  const bestiary = exists(p.bestiary) ? parse(p.bestiary, bestiarySchema, "bestiary") : null;
  return { brief, graph, reservations, zoneBestiary, bestiary };
}

// ------------------------------------------------------------------ scene

export interface SceneEntity { id: string; name: string; parent: string | null; tags: string[]; components: Record<string, unknown> }
export interface SceneIndex { scene: string; file: string; found: boolean; entities: Map<string, SceneEntity> }

/** The zone's scene: `--scene <id>`, else the scene named after the world. Missing = an empty index (nothing placed). */
export function sceneIndex(ctx: Ctx): SceneIndex {
  const scene = ctx.opt("scene", ctx.world);
  return indexFile(scene, path.join(ctx.paths.projectDir, "assets", "scenes", `${scene}.scene.json`));
}

/** Index a scene file (entities as a map or an array). */
function indexFile(scene: string, file: string): SceneIndex {
  const entities = new Map<string, SceneEntity>();
  if (!exists(file)) return { scene, file, found: false, entities };
  const raw = (readJson(file) as { entities?: unknown }).entities;
  const list: [string, Record<string, unknown>][] = Array.isArray(raw)
    ? (raw as Record<string, unknown>[]).map((e) => [String(e.id), e])
    : Object.entries((raw ?? {}) as Record<string, Record<string, unknown>>);
  for (const [id, e] of list)
    entities.set(id, { id, name: String(e.name ?? id), parent: (e.parent as string | null) ?? null, tags: (e.tags as string[]) ?? [], components: (e.components as Record<string, unknown>) ?? {} });
  return { scene, file, found: true, entities };
}

/**
 * Where a scene NAME resolves, the way the server's `loadContent(playgroundRoots(playground))` resolves it: every
 * `projects/<name>/` with an `assets/` folder (directory order), then the flat playground tree; scenes live anywhere
 * under `<root>/assets/scenes/` and are named by their basename; the first root wins.
 */
export function findSceneFile(playground: string, scene: string): string | null {
  const roots: string[] = [];
  const projectsDir = path.join(playground, "projects");
  if (fs.existsSync(projectsDir))
    for (const e of fs.readdirSync(projectsDir, { withFileTypes: true }))
      if (e.isDirectory() && fs.existsSync(path.join(projectsDir, e.name, "assets"))) roots.push(path.join(projectsDir, e.name));
  if (fs.existsSync(path.join(playground, "assets"))) roots.push(playground);
  const want = `${scene}.scene.json`;
  const search = (dir: string): string | null => {
    if (!fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = search(full);
        if (hit) return hit;
      } else if (e.name === want) return full;
    }
    return null;
  };
  for (const r of roots) {
    const hit = search(path.join(r, "assets", "scenes"));
    if (hit) return hit;
  }
  return null;
}

/** A scene reached from the world scene through one of its `portal` scripts (an instance: a dungeon, a cellar). */
export interface InstanceScene extends SceneIndex {
  /** The world-scene portal entity that leads there, its mode and the anchor it lands on. */
  portal: string;
  mode: string;
  anchor: string | null;
  /** The instance's way back: a `portal` in it whose `back` is true or whose scene is the world scene. */
  back: string | null;
}
const portalParams = (e: SceneEntity): Record<string, unknown> | null => {
  const s = e.components.script as { name?: string; params?: Record<string, unknown> } | undefined;
  return s?.name === "portal" ? (s.params ?? {}) : null;
};

/** Every scene the world scene's forward portals lead to (one hop), indexed; first portal per scene wins. */
export function instanceScenes(ctx: Ctx, world: SceneIndex): InstanceScene[] {
  const out: InstanceScene[] = [];
  const playground = path.resolve(ctx.paths.projectDir, "..", "..");
  for (const e of world.entities.values()) {
    const p = portalParams(e);
    const scene = typeof p?.scene === "string" ? p.scene : "";
    if (!p || !scene || p.back === true || scene === world.scene || out.some((x) => x.scene === scene)) continue;
    const file = findSceneFile(playground, scene);
    if (!file) continue;
    const idx = indexFile(scene, file);
    const back = [...idx.entities.values()].find((x) => {
      const bp = portalParams(x);
      return !!bp && (bp.back === true || bp.scene === world.scene);
    });
    out.push({ ...idx, portal: e.id, mode: String(p.mode ?? "interact"), anchor: typeof p.anchor === "string" ? p.anchor : null, back: back?.id ?? null });
  }
  return out;
}

/** An entity's authored [x, z] (its own transform; children are not composed). */
export function entityXZ(e: SceneEntity): [number, number] | null {
  const pos = (e.components.transform as { position?: number[] } | undefined)?.position;
  return pos && pos.length >= 3 ? [pos[0]!, pos[2]!] : null;
}

// --------------------------------------------------------------- residents

export interface Resident { id: string; name: string; town: string; townName: string; at: [number, number] | null; dialogue: string }

/** Every resident of this world's town docs (town id -> doc name via townNames), placed or not. */
export function residents(ctx: Ctx): Map<string, Resident> {
  const out = new Map<string, Resident>();
  for (const [townId, townName] of townNames(ctx.paths, ctx.world)) {
    const doc = readJson(ctx.paths.townDoc(townName)) as { residents?: { id: string; name?: string; place?: { at?: [number, number] }; dialogue?: string }[] };
    for (const r of doc.residents ?? []) out.set(r.id, { id: r.id, name: r.name ?? r.id, town: townId, townName, at: r.place?.at ?? null, dialogue: r.dialogue ?? "" });
  }
  return out;
}

/** Which zone town PLANS a resident (authoring/towns/<name>-plan.json), for the "planned, not placed" message. */
export function plannedResidents(ctx: Ctx): Map<string, string> {
  const out = new Map<string, string>();
  const dir = path.join(ctx.paths.projectDir, "authoring", "towns");
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith("-plan.json")) continue;
    try {
      const plan = readJson(path.join(dir, f)) as { residents?: { id: string }[] };
      for (const r of plan.residents ?? []) out.set(r.id, f.slice(0, -"-plan.json".length));
    } catch {
      /* not a plan */
    }
  }
  return out;
}

// -------------------------------------------------------------------- POIs

export interface PoiJob { dir: string; stage: string; ownerAgentId: string | null; handoff: Record<string, unknown> | null }
export const poiJobDir = (ctx: Ctx, zone: string, location: string): string => path.join(ctx.paths.zoneDir(zone), "pois", location);
/** The POI creator job of a location, or null when none was prepared. */
export function poiJob(ctx: Ctx, zone: string, location: string): PoiJob | null {
  const dir = poiJobDir(ctx, zone, location);
  const progress = path.join(dir, "progress.json");
  if (!exists(progress)) return null;
  const pr = readJson(progress) as { stage?: string; ownerAgentId?: string | null };
  const hf = path.join(dir, "handoff.json");
  return { dir, stage: pr.stage ?? "?", ownerAgentId: pr.ownerAgentId ?? null, handoff: exists(hf) ? (readJson(hf) as Record<string, unknown>) : null };
}

export const reservationOf = (plan: ZonePlan, location: string): Reservation | undefined => plan.reservations.reservations.find((r) => r.location === location);

/** Bound-quest report written by `zonegen bind` (reports/bind.json). */
export interface BindRow {
  id: string; state: "bound" | "blocked"; reasons: { code: string; message: string }[]; files: string[]; hash: string;
  /** Steps that happen in an instance scene, and the world-scene portal that leads there. */
  instances?: { objective: string; scene: string; portal: string; back: string | null }[];
}
export interface BindReport { zone: string; at: string; scene: string; dry: false; quests: BindRow[] }
export function readBindReport(ctx: Ctx, zone: string): BindReport | null {
  const file = ctx.paths.report("bind", zone);
  return exists(file) ? (readJson(file) as BindReport) : null;
}
