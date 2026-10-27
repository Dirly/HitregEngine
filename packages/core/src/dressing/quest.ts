/**
 * Quest objects in dressing plans: a plan item carrying `quest: { entity }` (schema.ts `dressingQuestSchema`) is a quest
 * object a zone's quest plan declares (quests.json `entities[]`, kind object|readable, at a `location`). This module is
 * the pure half: which plan items are allowed to name which entities (`checkQuestItems`, run by `dress check`), which
 * placement carries the entity (`questPlacements`), and the entity id, tags and `npc` script `dress apply` writes
 * (`questEntity`). The tool supplies the declarations, the plan's locations and the other plans. Zod-free, DOM-free.
 */
import type { DressingPlan, DressingQuest } from "./schema.js";
import type { DressingFinding, DressingPlacement } from "./resolve.js";

/** One quests.json `entities[]` row. */
export interface QuestEntityDecl {
  id: string;
  kind: string;
  location: string;
  what?: string;
  /** The zone whose quests.json declares it. */
  zone?: string;
}

/** Entity kinds a plan may place: the rest (a `presence`) are characters, placed by the cast tools. */
export const QUEST_OBJECT_KINDS = ["object", "readable"] as const;
export const QUEST_DEFAULT_RADIUS = 2.5;

export const isQuestObjectKind = (kind: string): boolean => (QUEST_OBJECT_KINDS as readonly string[]).includes(kind);

/**
 * `dress check` for quest items. `locations`: the town and/or place this plan dresses (a building plan of town T -> [T],
 * a site plan of POI P -> [P]). `elsewhere`: quest entity ids placed by OTHER plans of the project.
 * Violations: an entity not declared, declared at another location, or not an object/readable.
 * Warnings: a declared object of this plan's location that no plan places.
 */
export function checkQuestItems(
  plan: Pick<DressingPlan, "items">,
  declared: readonly QuestEntityDecl[],
  locations: readonly string[],
  elsewhere: ReadonlySet<string> = new Set(),
): { violations: DressingFinding[]; warnings: DressingFinding[] } {
  const violations: DressingFinding[] = [];
  const warnings: DressingFinding[] = [];
  const byId = new Map(declared.map((d) => [d.id, d]));
  const here = locations.length ? locations.join(" / ") : "(no town or place: the plan id names none)";
  const mine = new Set<string>();
  for (const item of plan.items) {
    if (!item.quest) continue;
    const id = item.quest.entity;
    mine.add(id);
    const d = byId.get(id);
    if (!d) violations.push({ item: item.id, code: "quest-undeclared", message: `quest entity "${id}" is declared in no quests.json entities[] of the project's zones` });
    else if (!locations.includes(d.location))
      violations.push({ item: item.id, code: "quest-wrong-location", message: `quest entity "${id}" belongs to location "${d.location}"${d.zone ? ` (zone ${d.zone})` : ""}, not ${here}: it goes in a plan of that place` });
    else if (!isQuestObjectKind(d.kind))
      violations.push({ item: item.id, code: "quest-not-object", message: `quest entity "${id}" is a ${d.kind}, not an object or readable: characters are cast, not dressed` });
    if (elsewhere.has(id)) violations.push({ item: item.id, code: "quest-duplicate", message: `quest entity "${id}" is already placed by another plan` });
  }
  for (const d of declared) {
    if (!locations.includes(d.location) || !isQuestObjectKind(d.kind) || mine.has(d.id) || elsewhere.has(d.id)) continue;
    warnings.push({ item: "", code: "quest-object-unplanned", message: `${d.location} declares ${d.kind} "${d.id}" (${d.what ?? ""}) and no plan places it: one plan item with quest.entity "${d.id}"` });
  }
  return { violations, warnings };
}

/**
 * The placement that IS each quest item's object: the item's own placement, or for a set item its anchor piece
 * (`<item>/<first member>`, the first placement under the item). Map placement id -> the item's quest.
 */
export function questPlacements(plan: Pick<DressingPlan, "items">, placements: readonly Pick<DressingPlacement, "id">[]): Map<string, DressingQuest> {
  const out = new Map<string, DressingQuest>();
  for (const item of plan.items) {
    if (!item.quest) continue;
    const p = placements.find((pl) => pl.id === item.id) ?? placements.find((pl) => pl.id.startsWith(`${item.id}/`) && !/\/chain-\d+$/.test(pl.id));
    if (p) out.set(p.id, item.quest);
  }
  return out;
}

/**
 * What `dress apply` writes for a quest object: the exact entity id, the tags (`interactable`, `zone:<zone>`, the place's
 * own tags) and the `npc` builtin with face: false. `readable` defaults from the declared kind, `dialogue` to
 * `zones/<zone>/<entity>` (zonegen wire's convention), `places` is set when the tool found the zone's places table.
 */
export function questEntity(
  quest: DressingQuest,
  o: { zone: string; name: string; kind?: string; placeTags?: readonly string[]; places?: string },
): { id: string; tags: string[]; script: { name: "npc"; params: Record<string, unknown> } } {
  const readable = quest.readable ?? o.kind === "readable";
  return {
    id: quest.entity,
    tags: ["interactable", `zone:${o.zone}`, ...(o.placeTags ?? [])],
    script: {
      name: "npc",
      params: {
        name: o.name,
        ...(readable ? { readable: true } : {}),
        face: false,
        radius: quest.radius ?? QUEST_DEFAULT_RADIUS,
        dialogue: quest.dialogue ?? `zones/${o.zone}/${quest.entity}`,
        ...(o.places ? { places: o.places } : {}),
      },
    },
  };
}
