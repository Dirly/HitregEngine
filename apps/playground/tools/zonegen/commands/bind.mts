/**
 * zonegen bind <world> --project <p> --zone <z> [--quest <id> ...] [--scene <id>] [--dry]
 *
 * Compiles planned quests (quests.json, frozen) into real game data, INCREMENTALLY: every run decides each quest
 * `bound` or `blocked` from what exists NOW, so a re-run after a town's residents or a POI is built picks up the
 * newly unblocked quests. A quest binds only when everything it touches exists:
 *   - its giver, turn-in and talk targets are residents placed in a town doc AND generated into the scene;
 *   - every location it happens at is built (town: a town doc; elsewhere: the POI job is `installed`);
 *   - every declared entity it uses (readable, object, presence) has an entity of that id in the scene;
 *   - every creature it kills has a spawnable template in the scene/prefabs (a rare or boss: its own id);
 *   - every item it collects, delivers, needs, grants or rewards has an item asset;
 *   - every block (source, action, condition, consequence, perform action) is registered;
 *   - every quest it `requires` is bound.
 * For a bound quest (not --dry) it writes the engine quest asset (assets/quests/<id>.json, validated by questSchema:
 * per-step kind, target, area, places, after, when, then, source), the places tables its text tokens resolve against
 * (assets/places/zones/<world>/<zone>/<town>.json, one per zone town: origin = that town) and a WRITING TASK
 * (zones/<z>/bind/tasks/<id>.md) for the prose an agent or the Codex CLI writes afterwards (journal text, objective
 * labels, the giver's offer and hand-in, the lead lines). It writes no prose: labels are `[write] <step>` until the
 * writer replaces them, and a re-run keeps whatever text the writer put in. reports/bind.json records every quest's
 * state, reasons, files and an inputs hash; `zonegen status` reads it. --dry prints the table and writes nothing.
 */
import fs from "node:fs";
import { assetIds } from "../../_closure.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  conditionBlockNames,
  DEFAULT_PERFORM_ACTIONS,
  placesSchema,
  questBlocks,
  questConsequenceSchema,
  questSchema,
  type QuestInput,
} from "@hitreg/core";
import { exists, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import type { PlannedQuest } from "../schemas.mts";
import { loadZonePlan, plannedResidents, poiJob, reservationOf, residents, sceneIndex, entityXZ, instanceScenes, type BindReport, type BindRow, type InstanceScene, type Resident, type SceneIndex, type ZonePlan } from "./_zone.mts";
import { whenOf } from "./poi-brief.mts";
import { rel, requireZone, townNames } from "./_shared.mts";

type Objective = PlannedQuest["objectives"][number];
type Area = { label: string; center: [number, number]; radius: number };
export interface Reason { code: string; message: string }

export const WRITE_MARK = "[write]";
export const isUnwritten = (s: string | undefined): boolean => !s || s.startsWith(WRITE_MARK);

interface Env {
  ctx: Ctx;
  plan: ZonePlan;
  scene: SceneIndex;
  /** Scenes the world scene's portals lead to: a creature or entity not in the world scene may stand in one. */
  instances: InstanceScene[];
  residents: Map<string, Resident>;
  planned: Map<string, string>;
  items: Set<string>;
  prefabs: Set<string>;
  towns: Map<string, { id: string; name: string; doc: string; center: [number, number]; radius: number }>;
}

export interface Decision {
  id: string;
  reasons: Reason[];
  quest: QuestInput | null;
  /** Mechanics the data cannot carry alone (an item handed over by a dialogue, a template's loot): for the task. */
  wiring: string[];
  /** Zone towns whose places tables the quest names. */
  towns: Set<string>;
  /** Steps whose target stands in an instance scene, and the portal that leads there. */
  instances: { objective: string; scene: string; portal: string; back: string | null }[];
}

const placesId = (ctx: Ctx, town: string): string => `zones/${ctx.world}/${ctx.zone}/${town}`;
const placesFile = (ctx: Ctx, town: string): string => path.join(ctx.paths.projectDir, "assets", "places", `${placesId(ctx, town)}.json`);

function makeEnv(ctx: Ctx, plan: ZonePlan): Env {
  const assets = path.join(ctx.paths.projectDir, "assets");
  const listIds = (dir: string): Set<string> => new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : []);
  const prefabs = new Set<string>();
  const walk = (d: string, pre: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(path.join(d, e.name), `${pre}${e.name}/`);
      else if (e.name.endsWith(".json")) prefabs.add(`${pre}${e.name.slice(0, -5)}`);
  };
  walk(path.join(assets, "prefabs"), "");
  const recipe = readJson(ctx.paths.recipe) as { features?: { towns?: { id: string; center: [number, number]; radius: number; falloff?: number }[] } };
  const names = townNames(ctx.paths, ctx.world);
  const towns = new Map<string, { id: string; name: string; doc: string; center: [number, number]; radius: number }>();
  for (const t of plan.brief.towns) {
    const rt = recipe.features?.towns?.find((x) => x.id === t.id);
    if (rt) towns.set(t.id, { id: t.id, name: t.name, doc: names.get(t.id) ?? "", center: rt.center, radius: rt.radius + (rt.falloff ?? 0) });
  }
  const scene = sceneIndex(ctx);
  return { ctx, plan, scene, instances: scene.found ? instanceScenes(ctx, scene) : [], residents: residents(ctx), planned: plannedResidents(ctx), items: assetIds(ctx.paths.projectDir, "items"), prefabs, towns };
}

/** Town id of a town location, or "". */
const townOfLocation = (env: Env, loc: string): string => env.plan.graph.locations.find((l) => l.id === loc && l.kind === "town")?.town ?? "";
/** The zone town nearest a point (directions for a step out in the wild are given from there). */
function nearestTown(env: Env, at: [number, number]): string {
  let best = "";
  let d = Infinity;
  for (const t of env.towns.values()) {
    const x = Math.hypot(t.center[0] - at[0], t.center[1] - at[1]);
    if (x < d) (d = x), (best = t.id);
  }
  return best;
}
const townDocName = (env: Env, townId: string): string => env.towns.get(townId)?.doc || townId;

/** Decide one planned quest from what exists now (requires are judged by the caller). */
export function decide(env: Env, q: PlannedQuest): Decision {
  const { plan, scene } = env;
  const reasons: Reason[] = [];
  const wiring: string[] = [];
  const towns = new Set<string>();
  const instances: Decision["instances"] = [];
  const why =(code: string, message: string): void => {
    if (!reasons.some((r) => r.code === code && r.message === message)) reasons.push({ code, message });
  };
  const entities = new Map(plan.graph.entities.map((e) => [e.id, e]));
  const creatures = new Map((plan.bestiary?.creatures ?? []).map((c) => [c.id, c]));
  const specials = new Map([...(plan.zoneBestiary?.rares ?? []), ...(plan.zoneBestiary?.bosses ?? [])].map((r) => [r.id, r]));

  const npc = (id: string, role: string): Resident | null => {
    const r = env.residents.get(id);
    if (!r) {
      const town = env.planned.get(id);
      why("npc-unplaced", town ? `${role} ${id}: planned in ${town}'s plan but not in its town doc (town-place-npcs, then town-npcs)` : `${role} ${id}: no town plans this resident`);
      return null;
    }
    if (!r.at) return void why("npc-unplaced", `${role} ${id}: in ${r.townName}'s town doc without a spot (town-place-npcs)`), null;
    if (!scene.entities.has(id)) return void why("npc-unplaced", `${role} ${id}: placed in ${r.townName}'s doc but not generated into scene ${scene.scene} (town-npcs)`), null;
    return r;
  };
  const location = (id: string): void => {
    const loc = plan.graph.locations.find((l) => l.id === id);
    if (!loc) return void why("plan-defect", `location ${id} is not in the quest graph`);
    if (loc.kind === "town") {
      if (!env.towns.get(loc.town)?.doc) why("town-missing", `town ${loc.town} (${loc.name}) has no town doc`);
      return;
    }
    // a WILD location is open country, not a POI: nobody builds it. It is ready when the creatures that hold it stand
    // there (zonegen populate tags their areas `location:<id>`). Its scenery needs are exterior dressing, not a quest blocker.
    if (loc.kind === "wild") {
      const held = [...scene.entities.values()].some((e) => (e.tags ?? []).includes("populate") && (e.tags ?? []).includes(`location:${id}`));
      if (loc.hostile && !held) why("location-unbuilt", `wild location ${id}: no ${loc.hostile} creature areas installed there (zonegen populate, then its installer)`);
      return;
    }
    const job = poiJob(env.ctx, env.ctx.zone, id);
    // a job revising an already installed site (installedAt recorded, its `poi:<id>` entities in the scene) is built:
    // the installed version stands in the world while the next one is prepared
    const standing = (): boolean => {
      if (!job) return false;
      const at = (readJson(path.join(job.dir, "progress.json")) as { installedAt?: string }).installedAt;
      return !!at && [...scene.entities.values()].some((e) => e.tags.includes(`poi:${id}`));
    };
    if (!job || (job.stage !== "installed" && !standing())) why("location-unbuilt", `location ${id} not built (${job ? `POI job at "${job.stage}"` : "no POI job: zonegen poi-brief"})`);
  };
  // the instance (reached through a world-scene portal) a step's target stands in; null = the world scene
  let stepInstance: InstanceScene | null = null;
  const instanceHolding = (pred: (e: { id: string; tags: string[] }) => boolean): InstanceScene | null =>
    env.instances.find((i) => [...i.entities.values()].some(pred)) ?? null;
  const entity = (id: string): void => {
    const e = entities.get(id);
    if (!e) return void why("plan-defect", `entity ${id} is not declared in the quest graph`);
    if (scene.entities.has(id)) return;
    const inst = instanceHolding((x) => x.id === id);
    if (inst) stepInstance = inst;
    else why("entity-unplaced", `${e.kind} ${id} (${e.what}) not placed in scene ${scene.scene}${env.instances.length ? ` or the instances its portals lead to (${env.instances.map((i) => i.scene).join(", ")})` : ""} (owner of ${e.location})`);
  };
  const item = (id: string): void => {
    if (!env.items.has(id)) why("no-item-asset", `item ${id} has no item asset (assets/items/${id}.json; zonegen items writes the declared ones)`);
  };
  // populate installs level-tiered templates tagged `creature:<id>`: a kill then targets the TAG, so every tier counts
  const isTagged = (ref: string) => (e: { tags: string[] }): boolean => (e.tags ?? []).includes("npc") && (e.tags ?? []).includes(`creature:${ref}`);
  const tagged = (ref: string): boolean => [...scene.entities.values()].some(isTagged(ref));
  const template = (ref: string): string => {
    if (tagged(ref)) return `tag:creature:${ref}`;
    const sp = specials.get(ref);
    if (sp) {
      if (scene.entities.has(ref) || env.prefabs.has(ref)) return ref;
      // not in the world: an instance behind one of its portals (a dungeon boss at its table)
      const byTag = instanceHolding(isTagged(ref));
      const inst = byTag ?? instanceHolding((x) => x.id === ref);
      if (inst) {
        stepInstance = inst;
        return byTag ? `tag:creature:${ref}` : ref;
      }
      why("no-template", `rare/boss ${ref} (on ${sp.base}) has no spawn template \`${ref}\` in the scene, the prefabs${env.instances.length ? ` or the instances its portals lead to (${env.instances.map((i) => i.scene).join(", ")})` : ""}`);
      return ref;
    }
    {
      // an ordinary creature that lives only in an instance
      const inst = instanceHolding(isTagged(ref));
      if (inst && !creatures.get(ref)?.template) {
        stepInstance = inst;
        return `tag:creature:${ref}`;
      }
    }
    const c = creatures.get(ref);
    if (!c) return void why("plan-defect", `creature ${ref} is not in the catalogue or the zone's rares/bosses`), ref;
    if (!c.template) return void why("no-template", `creature ${ref} has no spawn template in the bestiary (body ${c.body.status})`), ref;
    if (!scene.entities.has(c.template) && !env.prefabs.has(c.template)) why("no-template", `creature ${ref}: template ${c.template} is not in scene ${scene.scene} or the prefabs`);
    return c.template;
  };
  const block = (slot: "source" | "action" | "condition" | "consequence", name: string): void => {
    if (!questBlocks.has(slot, name)) why("block-missing", `${slot} block "${name}" is not registered`);
  };
  const areaOf = (loc: string, needArea: boolean): Area | undefined => {
    const town = townOfLocation(env, loc);
    if (town) {
      const t = env.towns.get(town);
      return needArea && t ? { label: `{place:${loc}}`, center: t.center, radius: Math.max(50, Math.round(t.radius)) } : undefined;
    }
    const res = reservationOf(plan, loc);
    if (!res) return void why("plan-defect", `location ${loc} has no reservation`), undefined;
    return { label: `{place:${loc}}`, center: res.center, radius: Math.max(50, Math.round(res.radius)) };
  };

  // ---- source, turn-in, quest-level town
  block("source", q.giver.type);
  let homeTown = "";
  let giver = "";
  let source: QuestInput["source"];
  if (q.giver.type === "npc") {
    const r = npc(q.giver.ref, "giver");
    giver = q.giver.ref;
    homeTown = r?.town ?? env.planned.get(q.giver.ref) ?? "";
    if (!r) homeTown = [...env.towns.values()].find((t) => t.doc === env.planned.get(q.giver.ref))?.id ?? plan.brief.hub;
  } else if (q.giver.type === "object" || q.giver.type === "presence") {
    entity(q.giver.ref);
    giver = q.giver.ref;
    source = { kind: q.giver.type, ref: q.giver.ref };
    const at = entities.get(q.giver.ref)?.location ?? "";
    homeTown = townOfLocation(env, at) || (reservationOf(plan, at) ? nearestTown(env, reservationOf(plan, at)!.center) : plan.brief.hub);
  } else if (q.giver.type === "auto") {
    if (q.giver.area && q.giver.area.radius < 50) why("plan-defect", `auto source area radius ${q.giver.area.radius} < 50`);
    for (const c of conditionBlockNames(q.giver.when ?? {})) block("condition", c);
    source = { kind: "auto", ...(q.giver.when ? { when: q.giver.when as never } : {}), ...(q.giver.area ? { area: q.giver.area } : {}) };
    homeTown = q.giver.area ? nearestTown(env, q.giver.area.center) : plan.brief.hub;
  }
  if (q.turnIn) npc(q.turnIn, "turn-in");
  if (!homeTown) homeTown = plan.brief.hub;
  towns.add(homeTown);

  // ---- objectives
  const objectives: QuestInput["objectives"] = [];
  for (const o of q.objectives) {
    block("action", o.action);
    const t = o.target;
    let target = "";
    let stepTown = "";
    stepInstance = null;
    if (t.type === "npc") {
      const r = npc(t.ref, `${o.action} target`);
      target = t.ref;
      stepTown = r?.town ?? "";
    } else if (t.type === "entity") {
      entity(t.ref);
      target = t.ref;
    } else if (t.type === "creature") target = template(t.ref);
    else if (t.type === "item") {
      item(t.ref);
      target = t.ref;
    } else if (t.type === "place") location(t.ref);
    const inst = stepInstance as InstanceScene | null;
    if (inst) instances.push({ objective: o.id, scene: inst.scene, portal: inst.portal, back: inst.back });
    if (["interact", "read", "deliver", "talk"].includes(o.action) && (t.type === "place" || !target))
      why("plan-defect", `${o.id}: a ${o.action} step needs an entity to aim at, the plan names ${t.type} ${t.ref}`);
    if (o.at) location(o.at);
    const at = o.at || (t.type === "place" ? t.ref : t.type === "entity" ? (entities.get(t.ref)?.location ?? "") : "");
    if (!stepTown && at) stepTown = townOfLocation(env, at);
    if (stepTown) towns.add(stepTown);
    const untargeted = o.action === "visit" || o.action === "endure" || (o.action === "perform" && !target);
    const area = at ? areaOf(at, untargeted) : undefined;
    if (untargeted && !area) why("plan-defect", `${o.id}: a ${o.action} step needs a place (no \`at\`)`);

    // conditions: the step's window plus the quest items it needs (a deliver's own item is the action itself)
    const deliverItem = o.action === "deliver" ? String(o.params.item ?? "") : "";
    for (const i of [...o.needs, ...o.grants, ...(deliverItem ? [deliverItem] : [])]) item(i);
    const conds = [whenOf(o), ...o.needs.filter((i) => i !== deliverItem).map((i) => ({ item: i }))].filter(Boolean) as Record<string, unknown>[];
    for (const c of o.conditions) block("condition", c);
    const when = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : { all: conds };
    for (const c of conditionBlockNames(when ?? {})) block("condition", c);
    const then = o.then.map((x) => (typeof x === "string" ? { do: x } : x));
    for (const c of then) {
      // the registered consequence block is the one whose schema accepts the entry (setFlag/clearFlag -> "flag")
      if (!questConsequenceSchema.safeParse(c).success) why("plan-defect", `${o.id}: consequence ${JSON.stringify(c)} is incomplete`);
      else if (!questBlocks.list("consequence").some((b) => b.schema.safeParse(c).success)) why("block-missing", `${o.id}: no registered consequence block accepts ${JSON.stringify(c)}`);
    }
    if (o.action === "perform") {
      const action = String(o.params.action ?? "");
      if (!DEFAULT_PERFORM_ACTIONS.some((a) => a.name === action)) why("block-missing", `${o.id}: perform action "${action}" is not in the engine vocabulary (add it to the project's performActions asset)`);
    }
    // what the data alone cannot carry
    // the template's own loot, where the kill target is a placed body (world or instance): `item:min:max,...`
    const lootOf = (): string => {
      const idx: SceneIndex = inst ?? scene;
      const ref = t.ref;
      const bodies = [...idx.entities.values()].filter((e) => e.id === ref || e.id === target || isTagged(ref)(e));
      for (const b of bodies)
        for (const c of idx.entities.values()) {
          const s = c.components.script as { name?: string; params?: { loot?: unknown } } | undefined;
          if ((c.id === b.id || c.parent === b.id) && s?.name === "combat-actor" && typeof s.params?.loot === "string") return s.params.loot;
        }
      return "";
    };
    for (const g of o.grants) {
      if (o.action === "kill" && t.type === "creature" && lootOf().split(",").some((x) => x.split(":")[0] === g)) {
        wiring.push(`${o.id}: done — ${t.ref}'s combat-actor loot${inst ? ` in ${inst.scene}` : ""} drops ${g}.`);
        continue;
      }
      if (o.action === "talk") wiring.push(`${o.id}: ${target}'s conversation must \`give\` ${g} (a choice in its dialogue).`);
      else if (o.action === "kill") wiring.push(`${o.id}: the ${target} template's loot must drop ${g}.`);
      else wiring.push(`${o.id}: ${o.action} ${target} must yield ${g}; no engine block gives an item on ${o.action}: author it as ${target}'s conversation (\`give\`) or a pickup at ${at || "?"}.`);
    }
    // every item this step needs or collects that no step of the quest grants: where it really comes from
    for (const it of new Set([...(o.action === "collect" ? [t.ref] : []), ...o.needs, ...(deliverItem ? [deliverItem] : [])])) {
      if (q.objectives.some((x) => x.grants.includes(it))) continue;
      const earlier = plan.graph.quests.find((x) => x.id !== q.id && q.requires.includes(x.id) && x.objectives.some((y) => y.grants.includes(it)));
      if (earlier) {
        wiring.push(`${o.id}: ${it} is carried in from ${earlier.id} (${earlier.objectives.find((y) => y.grants.includes(it))!.id}).`);
        continue;
      }
      const src = plan.graph.items.find((i) => i.id === it)?.source;
      wiring.push(
        src?.type === "creature" ? `${o.id}: ${src.ref}'s template must drop ${it} (loot).` :
        src?.type === "location" ? `${o.id}: ${it} must be picked up at ${src.ref} (the POI owner places it).` :
        src ? `${o.id}: ${src.type} ${src.ref} must hand over ${it} (its conversation \`give\`s it).` : `${o.id}: nothing in the plan says where ${it} comes from.`,
      );
    }
    const params: Record<string, unknown> =
      o.action === "deliver" ? { item: deliverItem } : o.action === "endure" ? { seconds: o.params.seconds } : o.action === "perform" ? { action: o.params.action, ...(o.params.range !== undefined ? { range: o.params.range } : {}) } : {};
    objectives.push({
      id: o.id,
      label: `${WRITE_MARK} ${o.id}`,
      kind: o.action as never,
      target,
      required: o.count,
      ...(area ? { area } : {}),
      ...(stepTown && stepTown !== homeTown ? { places: placesId(env.ctx, townDocName(env, stepTown)) } : {}),
      after: o.after,
      ...(inst ? { scene: inst.scene } : {}),
      ...(when ? { when: when as never } : {}),
      then: then as never,
      ...params,
    } as never);
  }
  for (const r of q.rewards.items) item(r);

  // quest area = the first step's region; steps sharing it drop their own copy
  const first = objectives.find((o) => (o as { area?: Area }).area) as { area?: Area } | undefined;
  const qArea = first?.area;
  for (const o of objectives as { area?: Area }[]) if (o.area && qArea && JSON.stringify(o.area) === JSON.stringify(qArea)) delete o.area;

  const quest: QuestInput = {
    id: q.id,
    title: q.title,
    description: "",
    objectives,
    ...(qArea ? { area: qArea } : {}),
    rewardXp: q.rewards.xp,
    rewardCoins: q.rewards.coins,
    rewardItems: q.rewards.items.map((itemId) => ({ itemId, qty: 1 })),
    giver,
    turnIn: q.turnIn,
    requires: q.requires,
    level: q.level,
    places: placesId(env.ctx, townDocName(env, homeTown)),
    ...(source ? { source } : {}),
  };
  const parsed = questSchema.safeParse(quest);
  if (!parsed.success) for (const i of parsed.error.issues) why("compile", `${i.path.join(".")}: ${i.message}`);
  return { id: q.id, reasons, quest: parsed.success ? quest : null, wiring, towns, instances };
}

/** Keep the text a writer already put into an existing asset (title, description, labels, area labels). */
function keepText(file: string, quest: QuestInput): QuestInput {
  if (!exists(file)) return quest;
  const old = questSchema.safeParse(readJson(file));
  if (!old.success) return quest;
  const o = old.data;
  const labels = new Map(o.objectives.map((x) => [x.id, x]));
  return {
    ...quest,
    title: o.title || quest.title,
    description: o.description || quest.description,
    ...(quest.area && o.area ? { area: { ...quest.area, label: o.area.label } } : {}),
    objectives: quest.objectives.map((x) => {
      const prev = labels.get(x.id);
      if (!prev) return x;
      const area = (x as { area?: Area }).area;
      return { ...x, label: isUnwritten(prev.label) ? x.label : prev.label, ...(area && prev.area ? { area: { ...area, label: prev.area.label } } : {}) } as typeof x;
    }),
  };
}

/** The zone's places tables, one per zone town (origin = that town): residents, zone locations, towns, placed entities. */
function writePlaces(env: Env, townIds: Set<string>): string[] {
  const { plan, ctx } = env;
  const written: string[] = [];
  for (const townId of townIds) {
    const t = env.towns.get(townId);
    if (!t) continue;
    const places: Record<string, { at: [number, number]; name: string; kind: string }> = {};
    for (const r of env.residents.values()) if (r.town === townId && r.at) places[r.id] = { at: r.at, name: r.name, kind: "resident" };
    for (const other of env.towns.values()) places[other.id] = { at: other.center, name: other.name, kind: "town" };
    for (const l of plan.graph.locations) {
      if (l.kind === "town") {
        const tt = env.towns.get(l.town);
        if (tt) places[l.id] = { at: tt.center, name: l.name, kind: "town" };
        continue;
      }
      const res = reservationOf(plan, l.id);
      if (res) places[l.id] = { at: res.center, name: l.name, kind: "poi" };
    }
    for (const e of plan.graph.entities) {
      const se = env.scene.entities.get(e.id);
      const at = se ? entityXZ(se) : null;
      if (at) places[e.id] = { at, name: e.what, kind: "point" };
    }
    const table = placesSchema.parse({ origin: t.center, places });
    const file = placesFile(ctx, townDocName(env, townId));
    writeJson(file, table);
    written.push(file);
  }
  return written;
}

/** The writing task for one bound quest: what to write, where it lives, and the gate it must pass. */
function writeTask(env: Env, q: PlannedQuest, d: Decision, assetFile: string): string {
  const { ctx, plan } = env;
  const file = path.join(ctx.paths.zoneDir(ctx.zone), "bind", "tasks", `${q.id}.md`);
  const dialogueOf = (id: string): string => {
    const r = env.residents.get(id);
    if (r) return `assets/dialogues/${r.dialogue || `${r.townName}/${id}`}.json`;
    const e = env.scene.entities.get(id);
    const script = e?.components.script as { name?: string; params?: { dialogue?: string } } | undefined;
    return `assets/dialogues/${script?.params?.dialogue || `zones/${ctx.zone}/${id}`}.json`;
  };
  const tokens = [...new Set([...plan.graph.locations.map((l) => l.id), ...plan.graph.entities.map((e) => e.id)])];
  const lines = [
    `# Writing task: ${q.title} (${q.id})`,
    "",
    `Bound by \`zonegen bind\`; the mechanics are fixed. Write prose ONLY into the fields below. Plan summary (not prose to copy): ${q.summary}`,
    "",
    "Rules: docs/town-npcs.md. No literal compass word anywhere; name places with {place:id} / {dir:id} / {far:id} tokens.",
    `Place ids you may use: ${tokens.join(", ")} (plus the residents of the quest's towns). A gated step says its window in words.`,
    "",
    `## Quest asset: ${rel(ctx.paths, assetFile)}`,
    "- `description`: the journal entry (2-3 sentences).",
    ...q.objectives.map((o) => {
      const inst = d.instances.find((x) => x.objective === o.id);
      return `- objective \`${o.id}\` label (replace \`${WRITE_MARK} ${o.id}\`): ${o.action} ${o.target.type} ${o.target.ref}${o.count > 1 ? ` x${o.count}` : ""}${o.at ? ` at {place:${o.at}}` : ""}${whenOf(o) ? `; only while ${JSON.stringify(whenOf(o))}` : ""}${inst ? `; happens INSIDE the instance scene \`${inst.scene}\` (entered through the portal \`${inst.portal}\`${inst.back ? `, left through \`${inst.back}\`` : ""}): name the place the player goes into, not a place token inside it` : ""}`;
    }),
    "",
    "## Dialogue",
    ...(q.giver.type === "npc" ? [`- ${dialogueOf(q.giver.ref)}: the offer, a start entry \`{ if: { quest: "${q.id}", status: "available" } }\` leading to a choice with \`{ do: "acceptQuest", quest: "${q.id}" }\`; an active-quest reminder.`] : []),
    ...(q.giver.type === "object" || q.giver.type === "presence" ? [`- ${dialogueOf(q.giver.ref)}: what the ${q.giver.type} says or shows, with the choice \`{ do: "acceptQuest", quest: "${q.id}" }\`.`] : []),
    ...(q.giver.type === "auto" ? ["- none to start it (auto source); the journal description carries the hook."] : []),
    ...(q.turnIn ? [`- ${dialogueOf(q.turnIn)}: the hand-in, a start entry \`{ if: { quest: "${q.id}", status: "ready" } }\` BEFORE the greeting, with \`{ do: "turnInQuest", quest: "${q.id}" }\`.`] : []),
    ...q.objectives.filter((o) => o.action === "talk").map((o) => `- ${dialogueOf(o.target.ref)}: what ${o.target.ref} says when the step \`${o.id}\` is open (gate on \`{ quest: "${q.id}", status: "active" }\`).`),
    ...q.objectives.filter((o) => o.action === "read").map((o) => `- ${dialogueOf(o.target.ref)}: the text of the readable \`${o.target.ref}\`.`),
    ...(d.wiring.length ? ["", "## Wiring the data cannot carry (do it, then re-run bind-check)", ...d.wiring.map((w) => `- ${w}`)] : []),
    ...(q.leads.length
      ? ["", "## Leads (a hint found elsewhere; never a direction, distance or token that points the compass)", ...q.leads.map((l) =>
          l.from.type === "resident" ? `- rumour in ${dialogueOf(l.from.ref)} (small talk, ungated): ${l.summary}` :
          l.from.type === "readable" ? `- lore in ${dialogueOf(l.from.ref)}: ${l.summary}` :
          `- ${l.kind} at ${l.from.type} ${l.from.ref}: something the POI owner shows, no text needed unless it is a sign: ${l.summary}`)]
      : []),
    "",
    "## Gate",
    `\`npx tsx tools/zonegen.mts bind-check ${ctx.world} --project ${ctx.project} --zone ${ctx.zone}\` (wraps tools/town-content-check.mts). Bulk text may go through \`node tools/codex-task.mjs --brief <this file> --out ... --check "<bind-check>"\`.`,
    "",
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

const hashOf = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "bind");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const plan = loadZonePlan(ctx, ctx.zone, f);
  if (!plan) {
    for (const x of f) console.error(`  ERROR ${x.code}: ${x.message}`);
    return 1;
  }
  const only = ctx.argv.flatMap((a, i) => (a === "--quest" && ctx.argv[i + 1] ? [ctx.argv[i + 1]!] : []));
  for (const id of only) if (!plan.graph.quests.some((q) => q.id === id)) return console.error(`bind: no planned quest "${id}"`), 2;
  const dry = ctx.flag("dry");
  const env = makeEnv(ctx, plan);
  if (!env.scene.found) console.log(`  (scene ${env.scene.scene} not found: nothing counts as placed)`);

  // decide every quest (requires need the whole graph), then drop those whose required quests do not bind
  const decisions = new Map(plan.graph.quests.map((q) => [q.id, decide(env, q)]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of plan.graph.quests) {
      const d = decisions.get(q.id)!;
      for (const r of q.requires) {
        const other = decisions.get(r);
        const msg = other ? `requires ${r}, which does not bind` : `requires ${r}, not a quest of this zone`;
        if ((!other || other.reasons.length) && !d.reasons.some((x) => x.message === msg)) {
          d.reasons.push({ code: "requires-unbound", message: msg });
          changed = true;
        }
      }
    }
  }

  const prev = new Map((exists(ctx.paths.report("bind", ctx.zone)) ? ((readJson(ctx.paths.report("bind", ctx.zone)) as BindReport).quests ?? []) : []).map((r) => [r.id, r]));
  const rows: BindRow[] = [];
  const placeTowns = new Set<string>();
  const qdir = path.join(ctx.paths.projectDir, "assets", "quests");
  for (const q of plan.graph.quests) {
    const d = decisions.get(q.id)!;
    const selected = !only.length || only.includes(q.id);
    if (!selected) {
      const old = prev.get(q.id);
      if (old) rows.push(old);
      continue;
    }
    const files: string[] = [];
    if (!d.reasons.length && d.quest && !dry) {
      const file = path.join(qdir, `${q.id}.json`);
      writeJson(file, keepText(file, d.quest));
      files.push(rel(ctx.paths, file), rel(ctx.paths, writeTask(env, q, d, file)));
      for (const t of d.towns) placeTowns.add(t);
    }
    rows.push({ id: q.id, state: d.reasons.length ? "blocked" : "bound", reasons: d.reasons, files, hash: hashOf({ q, quest: d.quest, reasons: d.reasons }), ...(d.instances.length ? { instances: d.instances } : {}) });
  }
  if (!dry && placeTowns.size) for (const file of writePlaces(env, placeTowns)) for (const r of rows) if (r.state === "bound" && !r.files.includes(rel(ctx.paths, file))) r.files.push(rel(ctx.paths, file));

  // the table
  const w = Math.max(...rows.map((r) => r.id.length)) + 1;
  console.log(`bind ${ctx.zone}${dry ? " (dry)" : ""}: scene ${env.scene.scene}, ${rows.filter((r) => r.state === "bound").length}/${rows.length} bindable`);
  for (const r of rows) {
    const codes = [...new Set(r.reasons.map((x) => x.code))];
    console.log(`  ${r.state === "bound" ? "bound  " : "blocked"} ${r.id.padEnd(w)} ${codes.join(", ")}`);
    for (const x of r.reasons) console.log(`  ${" ".repeat(8 + w)}  - ${x.message}`);
    for (const x of r.instances ?? []) console.log(`  ${" ".repeat(8 + w)}  > ${x.objective} happens in scene ${x.scene}: through portal ${x.portal}${x.back ? `, back out through ${x.back}` : ""}`);
  }
  const tally = new Map<string, number>();
  for (const r of rows) for (const c of new Set(r.reasons.map((x) => x.code))) tally.set(c, (tally.get(c) ?? 0) + 1);
  console.log(`  blocked by (quests per reason): ${[...tally].map(([c, n]) => `${c} ${n}`).join(", ") || "nothing"}`);
  if (!dry) {
    const report: BindReport = { zone: ctx.zone, at: new Date().toISOString(), scene: env.scene.scene, dry: false, quests: rows };
    writeJson(ctx.paths.report("bind", ctx.zone), report);
    console.log(`  wrote ${rel(ctx.paths, ctx.paths.report("bind", ctx.zone))}`);
  }
  return 0;
}
