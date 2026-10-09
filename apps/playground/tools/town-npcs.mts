#!/usr/bin/env tsx
/**
 * Populate a town from its authoring doc (projects/<p>/authoring/towns/<name>.json): every
 * resident becomes an NPC in the scene — a collider, the `npc` builtin (what
 * they say, sell, bank), and the modular human dressed by `character-look`
 * from a fixed build + worn items — standing on real ground, facing where the
 * doc says. Before writing anything it LINTS the town: every dialogue, shop,
 * quest and item the residents and their conversations name must exist and
 * parse, and every NPC a quest names must live somewhere.
 *
 * The models come from the doc's `creation` asset: the body option's model,
 * and each socketed model in its `mounts` that the resident shows (the face
 * and hair options' models always; a helm or shoulder model only when a worn
 * item draws on it); a mount with `mirrorTo` also gets its mirrored copy.
 *
 * Idempotent: the town's previous NPCs (tag `town-npc:<town>`) are replaced.
 * Also writes projects/<p>/docs/towns/<name>.md, the readable story + roster.
 * Process: docs/town-npcs.md.
 *
 *   cd apps/playground
 *   npx tsx tools/town-npcs.mts --project voxel-demo --town brinehold [--check]
 *     [--lineup brinehold-lineup --with hud,character-ui]   also write a review/test scene
 */
import fs from "node:fs";
import path from "node:path";
import {
  ComponentRegistry,
  createWorldField,
  registerCoreComponents,
  dialogueSchema,
  itemSchema,
  questSchema,
  shopSchema,
  worldRecipeSchema,
  type Dialogue,
  type DialogueCondition,
  type Quest,
  fillPlaces,
  literalCompassWords,
  placeTokens,
  type Places,
} from "@hitreg/core";
import { interiorUnitFor, placeUnder, RESIDENT_CULLING } from "./town-npc-placement.mts";
import { assetIds, assetPath, findAsset } from "./_closure.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
};
const checkOnly = process.argv.includes("--check");
// --pending-quests: dialogue refs to quests/items the zone quest phase has not written yet only WARN, so a town can get
// its bodies before its quests. Re-run without it once the quests exist; never install live with it.
const pendingQuests = process.argv.includes("--pending-quests");
const townName = arg("town", "");
const projectName = arg("project", "");
if (!townName || !projectName) {
  console.error("usage: npx tsx tools/town-npcs.mts --project <name> --town <authoring/towns/<town>.json> [--check]");
  process.exit(1);
}
const project = path.resolve(here, "..", "projects", projectName);
const assets = path.join(project, "assets");
/** Shared game data (items, creation, rigs) resolves through the project's dependsOn closure; world data stays local. */
const shared = (rel: string): string => assetPath(projectName, rel);

interface Resident {
  id: string;
  name: string;
  title: string;
  role: string;
  /** `inside`: a scene entity id — the building (or its `culling.interior` unit) the resident stands in; they go under that unit, hidden from outside. */
  place: { at: [number, number]; face?: [number, number]; yaw?: number; inside?: string };
  anim?: string;
  appearance: Record<string, string>;
  wear: string[];
  fallback?: string[];
  dialogue: string;
  shop?: string;
  vault?: boolean;
  /** The HEARTH (an innkeeper): where its dialogue's `bindSoul` binds the respawn ([x, y, z] world; absent = where the resident stands) and the place name (absent = the resident's name). A soul binder offers `openSoulbind` instead. */
  bindPoint?: [number, number, number];
  bindName?: string;
  radius?: number;
  about?: string;
  /** Held items (weapons, a shield, a staff…), socketed like the rig prefab socket that model; `holstered` sheathes them. */
  hold?: { primary?: string; offhand?: string; holstered?: boolean };
}
interface TownDoc {
  town: string;
  /** Prefab whose held-item sockets (bone-socket + equipment-look per model and slot) residents' held items copy. */
  weaponRig?: string;
  world: string;
  scene: string;
  name: string;
  creation: string;
  climate: string;
  story: {
    what: string;
    why: string;
    now: string;
    power: Array<{ name: string; who: string[]; about: string }>;
    relationships: Array<{ a: string; b: string; kind: string; about: string }>;
    hooks: string[];
  };
  defaults: { radius: number; anim: string };
  residents: Resident[];
  /** Named places the town's text refers to ({dir:id}…): a world POI, a scene entity (a camp), a town, or a bare point. */
  places?: Record<string, { poi?: string; entity?: string; town?: string; at?: [number, number]; name?: string }>;
}

const doc = JSON.parse(fs.readFileSync(path.join(project, "authoring", "towns", `${townName}.json`), "utf8")) as TownDoc;
const problems: string[] = [];
const warn: string[] = [];
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
const exists = (kind: string, id: string): boolean => findAsset(projectName, `${kind}/${id}.json`) !== null;

// -- lint ----------------------------------------------------------------------------
const residents = new Map(doc.residents.map((r) => [r.id, r]));
if (residents.size !== doc.residents.length) problems.push("duplicate resident id");
const itemIds = assetIds(projectName, "items");
for (const id of itemIds) {
  const parsed = itemSchema.safeParse(readJson(shared(`items/${id}.json`)));
  if (!parsed.success) problems.push(`item ${id}: ${parsed.error.issues[0]?.message}`);
}
const quests = new Map<string, Quest>();
for (const f of fs.readdirSync(path.join(assets, "quests")).filter((f) => f.endsWith(".json"))) {
  const parsed = questSchema.safeParse(readJson(path.join(assets, "quests", f)));
  if (!parsed.success) problems.push(`quest ${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  else quests.set(f.slice(0, -5), parsed.data);
}
for (const [id, q] of quests) {
  if (q.id !== id) problems.push(`quest file ${id}.json declares id "${q.id}"`);
  for (const npc of [q.giver, q.turnIn]) if (npc && !residents.has(npc)) warn.push(`quest ${id}: NPC "${npc}" is not a resident of ${doc.name}`);
  for (const o of q.objectives) {
    if (o.kind === "talk" && !residents.has(o.target)) warn.push(`quest ${id}: talk target "${o.target}" is not a resident of ${doc.name}`);
    if (o.kind === "collect" && !itemIds.has(o.target)) problems.push(`quest ${id}: collects unknown item "${o.target}"`);
    if (o.kind === "visit" && !q.area) problems.push(`quest ${id}: a visit objective needs an area`);
  }
  for (const r of q.rewardItems) if (!itemIds.has(r.itemId)) problems.push(`quest ${id}: rewards unknown item "${r.itemId}"`);
  for (const need of q.requires) if (!quests.has(need) && !exists("quests", need)) problems.push(`quest ${id}: requires unknown quest "${need}"`);
}
const conditionQuests = (c: DialogueCondition | undefined, out: string[]): string[] => {
  if (!c) return out;
  if (c.quest) out.push(c.quest);
  if (c.item) out.push(`item:${c.item}`);
  for (const x of [...(c.all ?? []), ...(c.any ?? []), ...(c.not ? [c.not] : [])]) conditionQuests(x, out);
  return out;
};
const shopsUsed = new Set<string>();
for (const r of doc.residents) {
  if (!exists("dialogues", r.dialogue)) {
    problems.push(`${r.id}: no dialogue assets/dialogues/${r.dialogue}.json`);
    continue;
  }
  const parsed = dialogueSchema.safeParse(readJson(path.join(assets, "dialogues", `${r.dialogue}.json`)));
  if (!parsed.success) {
    problems.push(`dialogue ${r.dialogue}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    continue;
  }
  const d: Dialogue = parsed.data;
  const refs: string[] = [];
  for (const s of d.start) conditionQuests(s.if, refs);
  for (const n of Object.values(d.nodes)) {
    for (const c of n.choices) {
      conditionQuests(c.if, refs);
      for (const a of c.do) {
        if (a.do === "acceptQuest" || a.do === "turnInQuest") {
          refs.push(a.quest);
          const q = quests.get(a.quest);
          if (a.do === "acceptQuest" && q && q.giver && q.giver !== r.id) warn.push(`${r.id} hands out "${a.quest}" but its giver is "${q.giver}"`);
          if (a.do === "turnInQuest" && q && q.turnIn !== r.id) problems.push(`${r.id} takes in "${a.quest}" but its turnIn is "${q.turnIn || "(none)"}"`);
        }
        if (a.do === "give" || a.do === "take") refs.push(`item:${a.item}`);
        if (a.do === "openShop") {
          if (a.shop !== r.shop) problems.push(`${r.id}: dialogue opens shop "${a.shop}" but the resident's shop is "${r.shop ?? "(none)"}"`);
          shopsUsed.add(a.shop);
        }
        if (a.do === "openVault" && !r.vault) problems.push(`${r.id}: dialogue opens the vault but the resident is not a banker (vault: true)`);
      }
    }
  }
  for (const ref of refs) {
    if (ref.startsWith("item:")) {
      if (!itemIds.has(ref.slice(5))) (pendingQuests ? warn : problems).push(`dialogue ${r.dialogue}: unknown item "${ref.slice(5)}"`);
    } else if (!quests.has(ref)) (pendingQuests ? warn : problems).push(`dialogue ${r.dialogue}: unknown quest "${ref}"`);
  }
  if (r.shop) {
    if (!exists("shops", r.shop)) problems.push(`${r.id}: no shop assets/shops/${r.shop}.json`);
    else {
      const s = shopSchema.safeParse(readJson(path.join(assets, "shops", `${r.shop}.json`)));
      if (!s.success) problems.push(`shop ${r.shop}: ${s.error.issues[0]?.message}`);
      else for (const e of s.data.stock) if (!itemIds.has(e.itemId)) warn.push(`shop ${r.shop}: stocks unknown item "${e.itemId}" (hidden until it exists)`);
    }
  }
}
for (const [id, q] of quests) if (q.giver && residents.has(q.giver) && !JSON.stringify(readJson(path.join(assets, "dialogues", `${residents.get(q.giver)!.dialogue}.json`))).includes(`"${id}"`)) warn.push(`quest ${id}: its giver's dialogue never offers it`);

// -- outfits ---------------------------------------------------------------------------
const wearOf = (r: Resident): string[] =>
  r.wear.map((id, i) => (itemIds.has(id) ? id : (r.fallback?.[i] ?? ""))).filter((id) => {
    if (!id) return false;
    if (!itemIds.has(id)) {
      problems.push(`${r.id}: wears unknown item "${id}"`);
      return false;
    }
    return true;
  });
interface CreationLike {
  appearance: Array<{ id: string; preview?: boolean; body?: boolean; options: Array<{ id: string; model?: string }> }>;
  mounts: Array<{ model: string; mirrorTo?: unknown }>;
}
const creation = readJson(shared(`creation/${doc.creation}.json`)) as CreationLike;
const bodyModel = creation.appearance.find((s) => s.body)?.options.find((o) => o.model)?.model ?? "";
if (!bodyModel) problems.push(`creation ${doc.creation}: no body slot option names a model`);
// socketed models in mount order: the ones every build shows (face, hair) and the ones only items draw on
const mountModels = [...new Set(creation.mounts.map((m) => m.model))];
const mirrored = new Set(creation.mounts.filter((m) => m.mirrorTo).map((m) => m.model));
const buildModels = new Set(
  creation.appearance.filter((s) => !s.preview && !s.body).flatMap((s) => s.options.map((o) => o.model ?? "")).filter(Boolean),
);
// held items: the rig prefab's socket for (slot, the item's model)
type RigEntity = { name: string; parent: string | null; tags?: string[]; components: Record<string, unknown> };
const rig = doc.weaponRig && exists("prefabs", doc.weaponRig) ? (readJson(shared(`prefabs/${doc.weaponRig}.json`)) as { entities: Record<string, RigEntity> }) : null;
if (doc.weaponRig && !rig) problems.push(`weaponRig: no prefab assets/prefabs/${doc.weaponRig}.json`);
const heldOf = (r: Resident): Array<["primary" | "offhand", string]> =>
  (["primary", "offhand"] as const).filter((s) => r.hold?.[s]).map((s) => [s, r.hold![s]!]);
function socketFor(slot: string, itemId: string): RigEntity | null {
  const model = (readJson(shared(`items/${itemId}.json`)) as { appearance?: { model?: string } }).appearance?.model;
  if (!rig || !model) return null;
  for (const [id, e] of Object.entries(rig.entities)) {
    const mesh = e.components["mesh"] as { source?: { assetId?: string } } | undefined;
    if (mesh?.source?.assetId !== model) continue;
    const look = Object.values(rig.entities).find((c) => c.parent === id && (c.components["script"] as { name?: string } | undefined)?.name === "equipment-look");
    const lookSlot = ((look?.components["script"] as { params?: { slot?: string } } | undefined)?.params?.slot) ?? "";
    if (lookSlot === slot) return e;
  }
  return null;
}

for (const r of doc.residents) {
  for (const [slot, option] of Object.entries(r.appearance)) {
    const s = creation.appearance.find((x) => x.id === slot);
    if (!s) problems.push(`${r.id}: no appearance slot "${slot}" in ${doc.creation}`);
    else if (!s.options.some((o) => o.id === option)) problems.push(`${r.id}: "${option}" is not an option of ${slot}`);
  }
  const missing = r.wear.filter((id) => !itemIds.has(id));
  if (missing.length) warn.push(`${r.id}: wearing fallbacks for ${missing.join(", ")}`);
  for (const [slot, id] of heldOf(r)) {
    if (!itemIds.has(id)) problems.push(`${r.id}: holds unknown item "${id}"`);
    else if (!socketFor(slot, id)) problems.push(`${r.id}: no ${slot} socket for ${id}'s model in the weapon rig "${doc.weaponRig ?? "(none)"}"`);
  }
}

// -- geography: what the town's people know about where things are ------------------------------
// RULE: quest and dialogue text never carries a literal compass word. Directions are computed from
// the world the text runs in: every server generates its own world, and Brinehold first shipped with
// every north/south flipped ("the southern cove" was north-west). Text names a PLACE instead —
// {dir:id} {Dir:id} {far:id} {place:id} {Place:id} — and core `fillPlaces` resolves it (north = -Z).
// The places table is generated here from the world: residents, gates, the doc's named places,
// nearby towns and every continent's capital. Written to assets/places/towns/<town>.json.
const placesId = `towns/${townName}`;
const placesTable: Places = { origin: [0, 0], places: {} };
{
  type WorldLite = {
    features?: {
      towns?: Array<{ id: string; center: [number, number]; tags?: string[]; gates?: Array<{ id: string; at: [number, number] }> }>;
      pois?: Array<{ id: string; position?: [number, number, number]; name?: string; kind?: string }>;
    };
    regions?: Array<{ id: string; name?: string; landmarks?: string[] }>;
  };
  const world = readJson(path.join(assets, "worlds", `${doc.world}.json`)) as WorldLite;
  const towns = world.features?.towns ?? [];
  const town = towns.find((t) => t.id === doc.town);
  if (!town) problems.push(`town "${doc.town}" is not in world "${doc.world}"`);
  else {
    placesTable.origin = [town.center[0], town.center[1]];
    const put = (id: string, at: [number, number], name: string, kind: string): void => {
      placesTable.places[id] = { at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10], name, kind };
    };
    // a town is known by its zone's name, when the zone has been named (not "Town 7" / "Zone 3")
    const townName = (id: string): string => {
      const r = (world.regions ?? []).find((g) => g.landmarks?.includes(id) && g.name && !/^(town|zone) \d+$/i.test(g.name));
      return r?.name ?? "";
    };
    for (const t of towns) {
      if (t.id === doc.town) continue;
      const far = Math.hypot(t.center[0] - town.center[0], t.center[1] - town.center[1]);
      if (t.tags?.includes("capital")) put(t.id, t.center, townName(t.id), "capital");
      else if (far < 3000) put(t.id, t.center, townName(t.id), "town");
    }
    for (const g of town.gates ?? []) put(g.id, g.at, "", "gate");
    for (const r of doc.residents) put(r.id, r.place.at, r.name, "resident");
    // the doc's named places: a POI, a scene entity (a camp), a town, or a bare point
    const scene = readJson(path.join(assets, "scenes", `${doc.scene}.scene.json`)) as { entities: Record<string, { components?: { transform?: { position?: number[] } } }> };
    for (const [id, p] of Object.entries(doc.places ?? {})) {
      let at: [number, number] | null = p.at ?? null;
      if (!at && p.poi) {
        const poi = world.features?.pois?.find((x) => x.id === p.poi);
        if (poi?.position) at = [poi.position[0], poi.position[2]];
        else problems.push(`place ${id}: no POI "${p.poi}" in world ${doc.world}`);
      }
      if (!at && p.entity) {
        const pos = scene.entities[p.entity]?.components?.transform?.position;
        if (pos) at = [pos[0]!, pos[2]!];
        else problems.push(`place ${id}: no entity "${p.entity}" in scene ${doc.scene}`);
      }
      if (!at && p.town) {
        const t = towns.find((x) => x.id === p.town);
        if (t) at = t.center;
        else problems.push(`place ${id}: no town "${p.town}"`);
      }
      if (at) put(id, at, p.name ?? "", p.poi ? "poi" : p.entity ? "camp" : p.town ? "town" : "point");
    }
  }
  // the rule itself
  const known = new Set(Object.keys(placesTable.places));
  const lint = (where: string, text: string): void => {
    for (const w of literalCompassWords(text)) problems.push(`${where}: literal compass word "${w}" in "${text.slice(0, 80)}" — name the place instead ({dir:<place>})`);
    for (const id of placeTokens(text)) if (!known.has(id)) problems.push(`${where}: unknown place "${id}" (add it to the town doc's places)`);
  };
  for (const q of quests.values()) {
    // a step in another town names its own places (objective `places`): its label is that town's to lint
    const homeSteps = q.objectives.filter((o) => !(o as { places?: string }).places);
    const stepsHere = q.objectives.filter((o) => (o as { places?: string }).places === placesId);
    const ours = residents.has(q.giver) || residents.has(q.turnIn) || q.places === placesId || stepsHere.length > 0;
    if (!ours) continue;
    const homeText = [q.title, q.description, q.area?.label ?? "", ...homeSteps.map((o) => o.label)];
    // a zone quest given by a resident carries the ZONE's places table (zonegen bind writes it): its text is linted
    // against that table, not against this town's
    const other = q.places && q.places !== placesId ? path.join(assets, "places", `${q.places}.json`) : "";
    if (other && fs.existsSync(other)) {
      const theirs = new Set(Object.keys((readJson(other) as { places?: Record<string, unknown> }).places ?? {}));
      for (const t of homeText) {
        for (const w of literalCompassWords(t)) problems.push(`quest ${q.id}: literal compass word "${w}" in "${t.slice(0, 80)}" — name the place instead ({dir:<place>})`);
        for (const id of placeTokens(t)) if (!theirs.has(id)) problems.push(`quest ${q.id}: unknown place "${id}" (not in ${q.places})`);
      }
      continue;
    }
    if (q.places !== placesId && (residents.has(q.giver) || residents.has(q.turnIn) || q.places === "") && placeTokens(homeText.join(" ")).length > 0)
      problems.push(`quest ${q.id}: uses place tokens but its "places" is not "${placesId}"`);
    if (q.places === placesId || residents.has(q.giver) || residents.has(q.turnIn)) for (const t of homeText) lint(`quest ${q.id}`, t);
    for (const o of stepsHere) lint(`quest ${q.id}/${o.id}`, o.label);
  }
  for (const r of doc.residents) {
    if (!exists("dialogues", r.dialogue)) continue;
    const d = readJson(path.join(assets, "dialogues", `${r.dialogue}.json`)) as { nodes: Record<string, { text: string | string[]; choices?: Array<{ text: string }> }> };
    for (const [id, n] of Object.entries(d.nodes)) {
      for (const t of [...(Array.isArray(n.text) ? n.text : [n.text]), ...(n.choices ?? []).map((c) => c.text)]) lint(`dialogue ${r.dialogue}#${id}`, t);
    }
  }
  for (const [k, t] of [["what", doc.story.what], ["why", doc.story.why], ["now", doc.story.now], ...doc.story.hooks.map((h, i) => [`hook ${i + 1}`, h])] as Array<[string, string]>) lint(`story ${k}`, t);
}

for (const w of warn) console.warn(`  warn  ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`  ERROR ${p}`);
  console.error(`${problems.length} problem(s) — nothing written`);
  process.exit(1);
}
console.log(`lint ok: ${doc.residents.length} residents, ${quests.size} quests, ${shopsUsed.size} shops`);
if (checkOnly) process.exit(0);

// -- scene ---------------------------------------------------------------------------------
type Entity = { name: string; parent: string | null; tags: string[]; components: Record<string, unknown> };
type SceneDoc = { entities: Record<string, Entity> };
const tag = `town-npc:${doc.town}`;
const round = (v: number): number => Math.round(v * 1000) / 1000;
const identity = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const socketed = (model: string) => ({
  source: { kind: "asset", assetId: model, partMask: 0, textureFilter: "pixel" },
  castShadow: true, receiveShadow: true, renderMode: "instanced", lod: true, moving: true, static: false,
});
const itemModel = (id: string): string =>
  (readJson(shared(`items/${id}.json`)) as { appearance?: { model?: string } }).appearance?.model ?? "";
// "mmo/human-shoulder.glb" -> "shoulder": the child entity's suffix
const shortName = (model: string): string => path.basename(model).replace(/\.[a-z]+$/i, "").replace(/^.*-/, "");

/** Drop every entity of this town (and their children) from a scene. */
function clearTown(scene: SceneDoc): void {
  const under = (id: string, root: string): boolean => {
    for (let p = scene.entities[id]?.parent; p; p = scene.entities[p]?.parent ?? null) if (p === root) return true;
    return false;
  };
  const roots = Object.entries(scene.entities).filter(([, e]) => e.tags?.includes(tag)).map(([id]) => id);
  for (const id of Object.keys(scene.entities)) if (roots.some((r) => r === id || under(id, r))) delete scene.entities[id];
}

/** One resident: the root (collider + npc), the skinned body, and a character-look per model it shows. */
function addResident(scene: SceneDoc, r: Resident, at: [number, number, number], yaw: number, inPlace = true): string[] {
  const wear = wearOf(r);
  // indoors: under the building's interior unit, so the culler hides them with its furnishings
  const unit = inPlace && r.place.inside ? interiorUnitFor(scene.entities, r.place.inside) : null;
  if (inPlace && r.place.inside && !unit) throw new Error(`${r.id}: place.inside "${r.place.inside}" is not a building with a culling.interior unit (or such a unit) in the scene`);
  const placed = placeUnder(scene.entities, unit, at, yaw);
  const worn = new Set(wear.map(itemModel));
  const look = { actor: r.id, creation: doc.creation, appearance: r.appearance, wear };
  const add = (id: string, e: Omit<Entity, "tags"> & { tags?: string[] }): void => {
    scene.entities[id] = { tags: [], ...e };
  };
  add(r.id, {
    name: r.name,
    parent: unit,
    tags: ["interactable", "townsfolk", tag],
    components: {
      transform: unit
        ? { position: placed.position.map(round), rotation: placed.rotation.map(round), scale: [1, 1, 1] }
        : { position: at.map(round), rotation: [0, round(Math.sin(yaw / 2)), 0, round(Math.cos(yaw / 2))], scale: [1, 1, 1] },
      // screen-size culling for a small animated thing in a town (docs/culling.md)
      culling: { ...RESIDENT_CULLING },
      rigidbody: { kind: "static" },
      collider: { shape: "capsule", size: [0.8, 1.8, 0.8], friction: 0.4 },
      script: {
        name: "npc",
        params: {
          name: r.name, title: r.title, dialogue: r.dialogue, places: placesId,
          ...(r.shop ? { shop: r.shop } : {}), ...(r.vault ? { vault: true } : {}), ...(r.hold?.holstered ? { holstered: true } : {}),
          ...(r.bindPoint ? { bindPoint: r.bindPoint } : {}), ...(r.bindName ? { bindName: r.bindName } : {}),
          radius: r.radius ?? doc.defaults.radius,
        },
      },
    },
  });
  add(`${r.id}-visual`, {
    name: `${r.name} visual`, parent: r.id,
    components: {
      transform: { position: [0, -0.9, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      mesh: { source: { kind: "asset", assetId: bodyModel, textureFilter: "nearest", partMask: 511 }, castShadow: true, receiveShadow: true, renderMode: "auto", lod: true, static: false },
      animator: { play: r.anim ?? doc.defaults.anim, fade: 0.3, speed: 1,
        poseLod: [{ distance: 40, fps: 20 }, { distance: 100, fps: 10 }] },
    },
  });
  add(`${r.id}-look`, { name: `${r.name} look`, parent: `${r.id}-visual`, components: { transform: identity, script: { name: "character-look", params: look } } });
  for (const model of mountModels) {
    if (!buildModels.has(model) && !worn.has(model)) continue;
    const name = shortName(model);
    const copies: Array<[string, boolean]> = mirrored.has(model) ? [[`${name}-l`, false], [`${name}-r`, true]] : [[name, false]];
    for (const [part, mirror] of copies) {
      add(`${r.id}-${part}`, {
        name: `${r.name} ${part}`, parent: `${r.id}-visual`,
        components: { transform: identity, mesh: socketed(model), script: { name: "character-look", params: mirror ? { ...look, mirror: true } : look } },
      });
    }
  }
  for (const [slot, itemId] of heldOf(r)) {
    const socket = socketFor(slot, itemId)!;
    add(`${r.id}-${slot}`, { name: `${r.name} ${slot}`, parent: `${r.id}-visual`, components: structuredClone(socket.components) });
    add(`${r.id}-${slot}-look`, {
      name: `${r.name} ${slot} look`, parent: `${r.id}-${slot}`,
      components: { transform: identity, script: { name: "equipment-look", params: { item: itemId } } },
    });
  }
  return wear;
}

/** Every component written must be one the engine accepts: one bad component fails the whole scene load. */
function validate(scene: SceneDoc): void {
  const components = new ComponentRegistry();
  registerCoreComponents(components);
  for (const [id, e] of Object.entries(scene.entities)) {
    if (!e.tags?.includes(tag) && !doc.residents.some((r) => id.startsWith(`${r.id}-`))) continue;
    for (const [name, data] of Object.entries(e.components)) {
      const v = components.validate(name, data);
      if (!v.ok) throw new Error(`${id}.${name}: ${v.error}`);
    }
  }
}

/** The talk window, once per scene. */
function ensureUi(scene: SceneDoc): void {
  const has = (name: string): boolean => Object.values(scene.entities).some((e) => (e.components["script"] as { name?: string } | undefined)?.name === name);
  if (!has("npc-ui")) scene.entities["npc-ui"] = { name: "NPC UI", parent: null, tags: [], components: { script: { name: "npc-ui", params: { cssClass: "mmo-screen" } } } };
  // name tags over players and NPCs (with ! / ? quest markers)
  if (!has("nameplates")) scene.entities["nameplates"] = { name: "Name tags", parent: null, tags: [], components: { script: { name: "nameplates", params: { cssClass: "mmo-screen" } } } };
}

// the town itself: residents on real ground
const recipe = worldRecipeSchema.parse(readJson(path.join(assets, "worlds", `${doc.world}.json`)));
const field = createWorldField(recipe);
const ground = (x: number, z: number): number => field.surfaceCast(x, z) ?? field.height(x, z);
const sceneFile = path.join(assets, "scenes", `${doc.scene}.scene.json`);
const scene = readJson(sceneFile) as SceneDoc;
clearTown(scene);
for (const r of doc.residents) {
  const [x, z] = r.place.at;
  const y = ground(x, z);
  const face = r.place.face;
  const yaw = r.place.yaw ?? (face ? Math.atan2(face[0] - x, face[1] - z) : 0);
  const wear = addResident(scene, r, [x, y + 0.9, z], yaw);
  console.log(`  ${r.id.padEnd(22)} [${x}, ${y.toFixed(1)}, ${z}] ${r.anim ?? doc.defaults.anim}  wears ${wear.join(", ")}`);
}
validate(scene);
ensureUi(scene);
const placesFile = path.join(assets, "places", `${placesId}.json`);
fs.mkdirSync(path.dirname(placesFile), { recursive: true });
fs.writeFileSync(placesFile, `${JSON.stringify(placesTable, null, 2)}\n`);
fs.writeFileSync(sceneFile, `${JSON.stringify(scene, null, 2)}\n`);
console.log(`wrote ${doc.residents.length} NPCs into ${path.relative(project, sceneFile)}`);

// --lineup <scene>: every resident in an arc on a lit floor, facing the player's start — a review
// scene for outfits and a lab for their conversations, shops and vault (the npc builtin works anywhere)
const lineup = arg("lineup", "");
if (lineup) {
  const file = path.join(assets, "scenes", `${lineup}.scene.json`);
  const lab: SceneDoc & { version?: number; name?: string } = fs.existsSync(file) ? (readJson(file) as SceneDoc) : { version: 1, name: lineup, entities: {} };
  clearTown(lab);
  const base: Record<string, Omit<Entity, "tags"> & { tags?: string[] }> = {
    sky: { name: "Sky", parent: null, components: { sky: { top: "#27324a", bottom: "#56607a", light: 0.9, fog: { color: "#3a4256", mode: "linear", near: 80, far: 260 }, environment: { mode: "sky", intensity: 1 } } } },
    sun: { name: "Sun", parent: null, components: { transform: { position: [20, 60, 40], rotation: [0.2, 0.1, -0.15, 0.96] }, light: { kind: "directional", color: "#fff1e0", intensity: 2.2, castShadow: true, shadowSize: 40, shadow: { enabled: true, mapSize: 1024, bias: -0.0004, normalBias: 0.02, cascades: 2 } } } },
    ambient: { name: "Ambient", parent: null, components: { light: { kind: "ambient", color: "#98a2c0", intensity: 1.1 } } },
    ground: { name: "Ground", parent: null, components: { transform: { position: [0, 0, 0] }, mesh: { source: { kind: "primitive", shape: "plane", size: [80, 1, 80], segments: [1, 1] }, material: "arena-floor", castShadow: false, receiveShadow: true }, collider: { shape: "box", size: [80, 0.2, 80] } } },
    camera: { name: "Camera", parent: null, components: { transform: { position: [0, 3, 16] }, camera: { active: true, fov: 60, far: 400, rig: { mode: "follow", targetTag: "player", distance: 6, height: 2.2 } } } },
    player: { name: "player", parent: null, tags: ["player"], components: { transform: { position: [0, 1.1, 9], rotation: [0, 1, 0, 0], scale: [1, 1, 1] }, prefab: { prefabId: "characters/player", props: {}, overrides: [] } } },
    telegraphs: { name: "telegraphs", parent: null, components: { transform: { position: [0, 0, 0] }, script: { name: "telegraph-pool", params: {} } } },
    fx: { name: "fx", parent: null, components: { transform: { position: [0, 0, 0] }, script: { name: "fx-pool", params: {} } } },
  };
  for (const [id, e] of Object.entries(base)) lab.entities[id] ??= { tags: [], ...e };
  // --with hud,character-ui: root entities copied from the town scene (the game's HUD and screens)
  for (const id of arg("with", "").split(",").filter(Boolean)) {
    const e = scene.entities[id];
    if (!e) console.warn(`  warn  --with: no entity "${id}" in ${doc.scene}`);
    else lab.entities[id] = structuredClone(e);
  }
  // an arc round the player's start, 120 degrees wide, everyone facing its centre
  const n = doc.residents.length;
  const radius = Math.max(6, n * 0.75);
  doc.residents.forEach((r, i) => {
    const t = n === 1 ? 0 : -Math.PI / 3 + (i / (n - 1)) * ((Math.PI * 2) / 3);
    const x = Math.sin(t) * radius;
    const z = 9 - Math.cos(t) * radius;
    addResident(lab, r, [x, 0.9, z], Math.atan2(0 - x, 9 - z), false);
  });
  validate(lab);
  ensureUi(lab);
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, name: lineup, ...lab }, null, 2)}\n`);
  console.log(`wrote the lineup ${path.relative(project, file)} (${n} residents)`);
}

// -- the readable version ---------------------------------------------------------------
const nameOf = (id: string): string => residents.get(id)?.name ?? id;
const md: string[] = [
  `# ${doc.name}`,
  "",
  `_Generated from \`authoring/towns/${townName}.json\` by \`apps/playground/tools/town-npcs.mts\` — edit the JSON, not this file._`,
  "",
  `**Where:** ${doc.town} in world \`${doc.world}\`. **Climate:** ${doc.climate}`,
  "",
  "## What it is", "", fillPlaces(doc.story.what, placesTable), "",
  "## Why it is here", "", fillPlaces(doc.story.why, placesTable), "",
  "## Now", "", fillPlaces(doc.story.now, placesTable), "",
  "## Who holds power", "",
  ...doc.story.power.map((p) => `- **${p.name}** (${p.who.map(nameOf).join(", ")}): ${p.about}`),
  "",
  "## Relationships", "",
  ...doc.story.relationships.map((r) => `- **${nameOf(r.a)} ↔ ${nameOf(r.b)}** — ${r.kind}. ${r.about}`),
  "",
  "## Geography (generated from the world; north is -Z)", "",
  "| place | kind | direction | distance |",
  "| --- | --- | --- | --- |",
  ...Object.entries(placesTable.places)
    .filter(([, pl]) => pl.kind !== "resident")
    .map(([id, pl]) => `| \`${id}\`${pl.name ? ` (${pl.name})` : ""} | ${pl.kind} | ${fillPlaces(`{dir:${id}}`, placesTable)} | ${Math.round(Math.hypot(pl.at[0] - placesTable.origin[0], pl.at[1] - placesTable.origin[1]))} m |`),
  "",
  "## Story hooks", "",
  ...doc.story.hooks.map((h) => `- ${fillPlaces(h, placesTable)}`),
  "",
  "## Residents", "",
  "| who | what | services | quests |",
  "| --- | --- | --- | --- |",
  ...doc.residents.map((r) => {
    const gives = [...quests.values()].filter((q) => q.giver === r.id).map((q) => q.title);
    const services = [r.shop ? `shop \`${r.shop}\`` : "", r.vault ? "vault" : ""].filter(Boolean).join(", ") || "—";
    return `| **${r.name}** | ${r.title}. ${r.about ?? ""} | ${services} | ${gives.join(", ") || "—"} |`;
  }),
  "",
  "## Quests", "",
  ...[...quests.values()]
    .filter((q) => residents.has(q.giver) || residents.has(q.turnIn))
    .map((q) => `- **${q.title}** (lv ${q.level}; from ${nameOf(q.giver)}${q.turnIn ? `, hand in to ${nameOf(q.turnIn)}` : ""}${q.requires.length ? `; after ${q.requires.join(", ")}` : ""}) — ${q.description}`),
  "",
];
const mdFile = path.join(project, "docs", "towns", `${townName}.md`);
fs.mkdirSync(path.dirname(mdFile), { recursive: true });
fs.writeFileSync(mdFile, md.join("\n"));
console.log(`wrote ${path.relative(project, mdFile)}`);
