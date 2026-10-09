/**
 * Human NPC templates for `zonegen populate`: a creature of a human family (ready body + theme `<outfit>-<weapon>`)
 * becomes a dressed, armed, animated subtree cloned from a working PATTERN entity, instead of a capsule.
 *
 * Everything project-specific is DECLARED in `authoring/zonegen/human-template.json`:
 *   pattern    { scene, entity }  a placed armed hostile human (root: rigidbody + collider + controller; children:
 *              visual/animator, character-look mounts, bone-socket weapon + equipment-look, character-sheet,
 *              weapon-stance, mob-brain, combat-actor, combat-caster)
 *   creation   the creation asset whose appearance options the look is picked from (hash of the template id)
 *   weaponRig  a prefab with one bone-socket per (weapon model, slot): the grip for the weapon item's model
 *   families   bestiary families this applies to (default ["human"])
 *   outfits    { <set>: { wear: [item ids], standIn?, why? } }
 *   weapons    { <word>: { item, standIn? } }   an item tagged `placeholder` is a stand-in too
 *   looks      { <creature id>: { <slot>: <option> } }  pinned choices (a named rare's sex); the rest is hashed
 *
 * Ids: every child is `<template>-<part>` (NpcManager.spawn turns `<root>-<part>` into `<copy>/<part>`), and every
 * string param equal to a pattern id (`actor`, ...) is rewritten to the template's.
 */
import fs from "node:fs";
import { assetIds, assetPath } from "../../_closure.mjs";
import path from "node:path";
import type { Op } from "@hitreg/core";
import type { Finding } from "../lib.mts";

type Json = Record<string, unknown>;
interface EntityDoc { name: string; parent: string | null; tags?: string[]; components: Json }
interface Script { name: string; params?: Json }
interface CreationDoc {
  appearance: Array<{ id: string; preview?: boolean; body?: boolean; options: Array<{ id: string; model?: string; requires?: Record<string, string[]> }> }>;
  mounts: Array<{ model: string; mirrorTo?: unknown }>;
}
interface ItemDoc { slots?: string[]; tags?: string[]; appearance?: { model?: string } }
export interface HumanConfig {
  pattern: { scene: string; entity: string };
  creation: string;
  weaponRig: string;
  families?: string[];
  outfits: Record<string, { wear: string[]; standIn?: string; why?: string }>;
  weapons: Record<string, { item: string; standIn?: string }>;
  looks?: Record<string, Record<string, string>>;
}
export interface HumanKit {
  file: string;
  cfg: HumanConfig;
  families: Set<string>;
  /** Pattern subtree, parents before children. */
  pattern: Array<[string, EntityDoc]>;
  rootId: string;
  creation: CreationDoc;
  rig: Record<string, EntityDoc>;
  items: Map<string, ItemDoc>;
}
export interface HumanDress {
  outfit: string;
  weapon: string;
  wear: string[];
  weaponItem: string;
  /** Reasons this template is still a stand-in (empty = the real thing). */
  standIns: string[];
}
export interface HumanSpec {
  id: string;
  label: string;
  tags: string[];
  at: number[];
  faction: string;
  level: number;
  hp: number;
  xp: number;
  abilities: string[];
  /** combat-actor loot spec; empty = nothing. */
  loot?: string;
  brain: { hostileTo: string; speed: number; aggroRange: number; deaggroRange: number; attackInterval: number; alertRadius: number; leash: number; roam: number };
  dress: HumanDress;
  /** Pinned look choices (config `looks` for this creature). */
  pin?: Record<string, string>;
}

const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
const scriptOf = (e: EntityDoc): Script | undefined => e.components["script"] as Script | undefined;
const meshModel = (e: EntityDoc): string | undefined => (e.components["mesh"] as { source?: { assetId?: string } } | undefined)?.source?.assetId;
const shortName = (model: string): string => path.basename(model).replace(/\.[a-z]+$/i, "").replace(/^.*-/, "");
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export function humanConfigFile(projectDir: string): string {
  return path.join(projectDir, "authoring", "zonegen", "human-template.json");
}

/** Load the declared pattern + its references; null (with a finding) when the project declares none or it is broken. */
export function loadHumanKit(projectDir: string, f: Finding[]): HumanKit | null {
  const file = humanConfigFile(projectDir);
  if (!fs.existsSync(file)) return null;
  const cfg = read(file) as HumanConfig;
  const bad = (message: string): null => {
    f.push({ level: "error", code: "human-template", message: `${path.basename(file)}: ${message}` });
    return null;
  };
  const assets = path.join(projectDir, "assets");
  const sceneFile = path.join(assets, "scenes", `${cfg.pattern.scene}.scene.json`);
  if (!fs.existsSync(sceneFile)) return bad(`pattern scene ${cfg.pattern.scene} not found`);
  const scene = read(sceneFile) as { entities: Record<string, EntityDoc> };
  const rootId = cfg.pattern.entity;
  if (!scene.entities[rootId]) return bad(`pattern entity ${rootId} is not in scene ${cfg.pattern.scene}`);
  const pattern: Array<[string, EntityDoc]> = [[rootId, scene.entities[rootId]!]];
  for (let k = 0; k < pattern.length; k++)
    for (const [id, e] of Object.entries(scene.entities)) if (e.parent === pattern[k]![0]) pattern.push([id, e]);
  const scripts = new Set(pattern.map(([, e]) => scriptOf(e)?.name));
  const lacks = ["mob-brain", "combat-caster", "combat-actor", "character-look", "character-sheet", "bone-socket", "equipment-look"].filter((n) => !scripts.has(n));
  if (lacks.length) return bad(`pattern ${rootId} has no ${lacks.join(", ")} script`);
  const creationFile = assetPath(projectDir, `creation/${cfg.creation}.json`);
  if (!fs.existsSync(creationFile)) return bad(`creation ${cfg.creation} not found`);
  const rigFile = assetPath(projectDir, `prefabs/${cfg.weaponRig}.json`);
  if (!fs.existsSync(rigFile)) return bad(`weaponRig prefab ${cfg.weaponRig} not found`);
  const items = new Map<string, ItemDoc>();
  for (const id of assetIds(projectDir, "items")) items.set(id, read(assetPath(projectDir, `items/${id}.json`)) as ItemDoc);
  for (const [set, o] of Object.entries(cfg.outfits)) for (const id of o.wear) if (!items.has(id)) return bad(`outfit ${set} wears unknown item ${id}`);
  for (const [w, o] of Object.entries(cfg.weapons)) if (!items.has(o.item)) return bad(`weapon ${w} names unknown item ${o.item}`);
  return {
    file, cfg, families: new Set(cfg.families ?? ["human"]), pattern, rootId,
    creation: read(creationFile) as CreationDoc,
    rig: (read(rigFile) as { entities: Record<string, EntityDoc> }).entities,
    items,
  };
}

/** `<outfit>-<weapon>` -> worn items + weapon item, or why it cannot be dressed. */
export function dressFor(kit: HumanKit, theme: string): HumanDress | { error: string } {
  const outfit = Object.keys(kit.cfg.outfits).filter((s) => theme.startsWith(`${s}-`)).sort((a, b) => b.length - a.length)[0];
  if (!outfit) return { error: `theme '${theme}' names no declared outfit set` };
  const weapon = theme.slice(outfit.length + 1);
  const w = kit.cfg.weapons[weapon];
  if (!w) return { error: `theme '${theme}': no declared weapon item for '${weapon}'` };
  const o = kit.cfg.outfits[outfit]!;
  const standIns: string[] = [];
  if (o.standIn) standIns.push(`outfit ${outfit} -> ${o.standIn} set (${o.why ?? "no items of its own"})`);
  if (w.standIn || kit.items.get(w.item)?.tags?.includes("placeholder")) standIns.push(`weapon ${weapon} -> ${w.item} (${w.standIn ?? "placeholder item"})`);
  return { outfit, weapon, wear: [...o.wear], weaponItem: w.item, standIns };
}

/** A look from the creation options, picked by hashing the template id (sex first, then options it allows). */
export function lookFor(kit: HumanKit, id: string, pin: Record<string, string> = {}): Record<string, string> {
  const look: Record<string, string> = {};
  const allowed = (o: { requires?: Record<string, string[]> }): boolean => Object.entries(o.requires ?? {}).every(([k, v]) => v.includes(look[k] ?? ""));
  const slots = kit.creation.appearance.filter((s) => !s.preview);
  for (const s of [...slots.filter((x) => x.body), ...slots.filter((x) => !x.body)]) {
    const opts = s.options.filter(allowed);
    if (!opts.length) continue;
    const pinned = opts.find((o) => o.id === pin[s.id]);
    if (pinned) {
      look[s.id] = pinned.id;
      continue;
    }
    look[s.id] = opts[hash(`${id}:${s.id}`) % opts.length]!.id;
  }
  return look;
}

function rewrite(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => rewrite(v, map));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, rewrite(v, map)]));
  return value;
}

/** The template subtree as add-entity ops (parents first); `entities` is the same subtree for checks. */
export function humanTemplateOps(kit: HumanKit, s: HumanSpec): { ops: Op[]; entities: Record<string, EntityDoc>; appearance: Record<string, string> } {
  const root = kit.rootId;
  const map = new Map<string, string>();
  for (const [old] of kit.pattern) map.set(old, old === root ? s.id : `${s.id}-${old.startsWith(`${root}-`) ? old.slice(root.length + 1) : old}`);
  const out = new Map<string, EntityDoc>();
  for (const [old, e] of kit.pattern)
    out.set(map.get(old)!, { name: e.name, parent: e.parent === null ? null : map.get(e.parent)!, tags: [], components: rewrite(structuredClone(e.components), map) as Json });
  const appearance = lookFor(kit, s.id, s.pin);
  const wear = s.dress.wear;
  const visual = [...out].find(([, e]) => e.components["animator"])?.[0] ?? s.id;

  // character-look mounts: one per creation mount model the build shows (face, hair) or the worn items draw on
  const buildModels = new Set(kit.creation.appearance.filter((x) => !x.preview && !x.body).flatMap((x) => x.options.map((o) => o.model ?? "")).filter(Boolean));
  const worn = new Set(wear.map((id) => kit.items.get(id)?.appearance?.model ?? ""));
  const mirrored = new Set(kit.creation.mounts.filter((m) => m.mirrorTo).map((m) => m.model));
  const mountTpl = [...out.values()].find((e) => scriptOf(e)?.name === "character-look" && meshModel(e));
  for (const [id, e] of [...out]) if (scriptOf(e)?.name === "character-look" && meshModel(e)) out.delete(id);
  for (const model of [...new Set(kit.creation.mounts.map((m) => m.model))]) {
    if (!mountTpl || (!buildModels.has(model) && !worn.has(model))) continue;
    const name = shortName(model);
    const copies: Array<[string, boolean]> = mirrored.has(model) ? [[`${name}-l`, false], [`${name}-r`, true]] : [[name, false]];
    for (const [part, mirror] of copies) {
      const e = structuredClone(mountTpl);
      (e.components["mesh"] as { source: Json }).source.assetId = model;
      e.parent = visual;
      const sc = scriptOf(e)!;
      sc.params = { ...sc.params, mirror: mirror || undefined };
      if (!mirror) delete sc.params["mirror"];
      out.set(`${s.id}-${part}`, e);
    }
  }

  // the held weapon: the rig's socket for the item's model in the primary slot
  const model = kit.items.get(s.dress.weaponItem)?.appearance?.model ?? "";
  const socketOf = (): EntityDoc | undefined => {
    for (const [id, e] of Object.entries(kit.rig)) {
      if (meshModel(e) !== model || scriptOf(e)?.name !== "bone-socket") continue;
      const look = Object.values(kit.rig).find((c) => c.parent === id && scriptOf(c)?.name === "equipment-look");
      if ((scriptOf(look!)?.params?.["slot"] ?? "") === "primary") return e;
    }
    return undefined;
  };
  const socket = socketOf();
  for (const [, e] of out) {
    const sc = scriptOf(e);
    if (!sc) continue;
    const p = (sc.params ??= {});
    switch (sc.name) {
      case "character-look":
        p["appearance"] = appearance;
        p["wear"] = wear;
        break;
      case "bone-socket":
        if (socket && meshModel(e) !== model) {
          e.components["transform"] = structuredClone(socket.components["transform"]);
          e.components["mesh"] = structuredClone(socket.components["mesh"]);
          e.components["script"] = structuredClone(socket.components["script"]);
        }
        break;
      case "character-sheet": {
        const prev = (p["startingItems"] as Array<{ itemId: string; equip?: boolean }> | undefined) ?? [];
        const keep = prev.filter((it) => !(kit.items.get(it.itemId)?.slots ?? []).some((sl) => sl === "primary" || sl === "offhand"));
        p["startingItems"] = [...keep, { itemId: s.dress.weaponItem, equip: true }];
        p["startingLevel"] = s.level;
        break;
      }
      case "mob-brain":
        delete p["home"];
        Object.assign(p, { faction: s.faction, abilities: s.abilities.join(","), ...s.brain });
        break;
      case "combat-actor":
        Object.assign(p, { faction: s.faction, maxHp: s.hp, xpValue: s.xp, level: s.level, loot: s.loot ?? "" });
        break;
      case "combat-caster":
        Object.assign(p, { playerControlled: false, bar: s.abilities.join(",") });
        break;
      case "third-person-controller":
        p["speed"] = Math.max(Number(p["speed"] ?? 0), s.brain.speed);
        p["sprintSpeed"] = Math.max(Number(p["sprintSpeed"] ?? 0), s.brain.speed);
        break;
    }
  }
  for (const [id, e] of out) {
    if (id === s.id) {
      e.name = s.label;
      e.tags = s.tags;
      e.components["transform"] = { ...(e.components["transform"] as Json), position: s.at, rotation: [0, 0, 0, 1] };
    } else e.name = `${s.id} ${id.slice(s.id.length + 1)}`;
  }
  // parents first
  const order: string[] = [s.id];
  for (let k = 0; k < order.length; k++) for (const [id, e] of out) if (e.parent === order[k]) order.push(id);
  const entities: Record<string, EntityDoc> = {};
  for (const id of order) entities[id] = out.get(id)!;
  return { ops: order.map((id) => ({ op: "add-entity", id, entity: entities[id] }) as never), entities, appearance };
}

/** Problems a spawned copy would have: missing fight scripts, ids/actors off the `<root>-<part>` pattern. */
export function checkHumanSubtree(id: string, entities: Record<string, EntityDoc>): string[] {
  const problems: string[] = [];
  const have = new Set(Object.values(entities).map((e) => scriptOf(e)?.name));
  for (const n of ["mob-brain", "combat-caster", "combat-actor"]) if (!have.has(n)) problems.push(`no ${n} script`);
  for (const [eid, e] of Object.entries(entities)) {
    if (eid !== id && !eid.startsWith(`${id}-`)) problems.push(`child ${eid} is not ${id}-<part>`);
    const actor = scriptOf(e)?.params?.["actor"];
    if (actor !== undefined && actor !== id) problems.push(`${eid}: actor ${String(actor)} is not ${id}`);
  }
  return problems;
}
