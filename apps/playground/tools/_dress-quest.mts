/**
 * Quest objects placed through dressing plans (`dress check` / `dress apply`; core dressing/quest.ts is the pure half).
 * A plan item with `quest: { entity }` is a quest object a zone's quest plan declares
 * (authoring/zonegen/<world>/zones/<zone>/quests.json `entities[]`). This file finds the project's declarations, the
 * town / place a plan dresses, the quest objects other plans already place, the zone's places table, and turns the
 * item's placement op into the quest entity (exact id, tags, `npc` builtin). Also used by `zonegen quest-objects`.
 */
import fs from "node:fs";
import path from "node:path";
import { checkQuestItems, isQuestObjectKind, questEntity, type DressingFinding, type DressingPlan, type DressingQuest, type QuestEntityDecl } from "@hitreg/core";

export interface ZoneDecl extends QuestEntityDecl { zone: string; world: string }

const dirs = (d: string): string[] => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

/**
 * Every quests.json `entities[]` row of the project's zones, with its zone and world — then of the projects it
 * `dependsOn` (project.json), so a lab or proof copy of a world (no zonegen of its own, depends on the world's project)
 * checks and applies the same quest objects as the world itself (T-D2: every quest item refused in reedholt-proof).
 * The project's own declaration of an id wins.
 */
export function questDecls(projectDir: string): ZoneDecl[] {
  const out = zoneDecls(projectDir);
  let deps: string[] = [];
  try { deps = (JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")) as { dependsOn?: string[] }).dependsOn ?? []; } catch { /* no project.json */ }
  const seen = new Set(out.map((d) => d.id));
  for (const dep of deps) for (const d of zoneDecls(path.join(path.dirname(projectDir), dep))) if (!seen.has(d.id)) { seen.add(d.id); out.push(d); }
  return out;
}

function zoneDecls(projectDir: string): ZoneDecl[] {
  const out: ZoneDecl[] = [];
  const zg = path.join(projectDir, "authoring", "zonegen");
  for (const world of dirs(zg))
    for (const zone of dirs(path.join(zg, world, "zones"))) {
      const file = path.join(zg, world, "zones", zone, "quests.json");
      if (!fs.existsSync(file)) continue;
      const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { entities?: { id: string; kind: string; location: string; what?: string }[] };
      for (const e of doc.entities ?? []) out.push({ id: e.id, kind: e.kind, location: e.location, what: e.what ?? "", zone, world });
    }
  return out;
}

/** The town a building plan dresses: `<town>--<building>` or `<town>/<building>` plan ids. Null otherwise. */
export function planTown(planId: string): { town: string; building: string } | null {
  const m = /^([a-z0-9][a-z0-9-]*?)(?:--|\/)(.+)$/i.exec(planId);
  return m ? { town: m[1]!, building: m[2]! } : null;
}

/** The locations a plan may place quest objects of: its town, and its POI (dress apply's poi). */
export function planLocations(planId: string, poi: string | null): string[] {
  const t = planTown(planId);
  return [...new Set([...(t ? [t.town] : []), ...(poi ? [poi] : [])])];
}

/** Plan files of a project (no reports, inverses, owner edits or walks). */
export function planFiles(projectDir: string): string[] {
  const dir = path.join(projectDir, "authoring", "dressing", "plans");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !/\.(report|inverse|owner|walk)\.json$/.test(f)).map((f) => path.join(dir, f));
}

/** Quest entity id -> the plan id placing it, over every plan of the project except `exceptFile`. */
export function plannedQuestObjects(projectDir: string, exceptFile = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of planFiles(projectDir)) {
    if (exceptFile && path.resolve(file) === path.resolve(exceptFile)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: string; items?: { quest?: { entity?: string } }[] };
      for (const it of doc.items ?? []) if (it.quest?.entity) out.set(it.quest.entity, doc.id ?? path.basename(file, ".json"));
    } catch { /* an unreadable plan is its own check's problem */ }
  }
  return out;
}

/** `dress check` findings for the plan's quest items (core checkQuestItems over this project's files). */
export function questFindings(projectDir: string, planFile: string, plan: Pick<DressingPlan, "id" | "items">, poi: string | null): { violations: DressingFinding[]; warnings: DressingFinding[]; locations: string[] } {
  const locations = planLocations(plan.id, poi);
  const declared = questDecls(projectDir);
  const here = declared.filter((d) => locations.includes(d.location));
  // check only the declarations that matter: this plan's locations, plus the ids its items name (to say where they belong)
  const named = new Set(plan.items.flatMap((i) => (i.quest ? [i.quest.entity] : [])));
  const relevant = declared.filter((d) => locations.includes(d.location) || named.has(d.id));
  if (!here.length && !named.size) return { violations: [], warnings: [], locations };
  const r = checkQuestItems(plan, relevant, locations, new Set(plannedQuestObjects(projectDir, planFile).keys()));
  return { ...r, locations };
}

/** The zone's places table for a location (`zones/<world>/<zone>/<town>`, else the zone's only/first table), or undefined. */
export function placesFor(projectDir: string, world: string, zone: string, town: string | null): string | undefined {
  const dir = path.join(projectDir, "assets", "places", "zones", world, zone);
  if (town && fs.existsSync(path.join(dir, `${town}.json`))) return `zones/${world}/${zone}/${town}`;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  return files[0] ? `zones/${world}/${zone}/${files[0].slice(0, -5)}` : undefined;
}

/** "parish-strongbox" -> "Parish strongbox". */
export const entityTitle = (id: string): string => { const s = id.replace(/-/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };

type AddOp = { op: "add-entity"; id: string; entity: { name: string; parent: string | null; tags: string[]; components: Record<string, unknown> } };

/**
 * Turn the placement op of a quest item into the quest object: the entity id becomes `quest.entity` EXACTLY, tags gain
 * `quest-object`, `interactable`, `zone:<zone>` and the place's tags, the `npc` builtin is attached, and static batching
 * overrides are dropped (an interactable stays its own entity).
 */
export function questAddOp(op: AddOp, quest: DressingQuest, o: { decl?: ZoneDecl; planId: string; poi: string | null; places?: string }): AddOp {
  const t0 = planTown(o.planId);
  const t = t0 && t0.town !== o.poi ? t0 : null; // `<poi>--<area>` site plans are not town buildings
  const placeTags = [...(t ? [`town:${t.town}`, `building:${t.building}`] : []), ...(o.poi ? [`poi:${o.poi}`] : [])];
  const q = questEntity(quest, { zone: o.decl?.zone ?? "unknown", name: entityTitle(quest.entity), kind: o.decl?.kind, placeTags, places: o.places });
  const prefab = { ...(op.entity.components["prefab"] as Record<string, unknown>) };
  delete prefab["overrides"];
  return {
    op: "add-entity",
    id: q.id,
    entity: {
      ...op.entity,
      name: `${entityTitle(quest.entity)}: ${String(prefab["prefabId"] ?? "")}`,
      tags: [...new Set([...op.entity.tags, "quest-object", ...q.tags])],
      components: { ...op.entity.components, prefab, script: q.script },
    },
  };
}

/** Declared quest objects per location of a zone, each with the plan placing it and whether the scene has it. */
export function questObjectRows(projectDir: string, zone: string, scene: { entities: Record<string, { tags?: string[] }> } | null, location?: string): { location: string; id: string; kind: string; what: string; plan: string; placed: boolean }[] {
  const planned = plannedQuestObjects(projectDir);
  return questDecls(projectDir)
    .filter((d) => d.zone === zone && isQuestObjectKind(d.kind) && (!location || d.location === location))
    .map((d) => ({ location: d.location, id: d.id, kind: d.kind, what: d.what ?? "", plan: planned.get(d.id) ?? "", placed: !!scene?.entities[d.id] }))
    .sort((a, b) => a.location.localeCompare(b.location) || a.id.localeCompare(b.id));
}
