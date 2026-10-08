/**
 * zonegen quests <world> --project <p> --zone <id> — the logic lint of the zone's quest graph.
 *
 * Blocks are read from @hitreg/core's quest block registry (`questBlocks`) at run time, so the plan cannot drift from
 * what the engine runs: a source, action, condition or consequence the registry does not list is an ERROR (it would pass
 * the plan and do nothing at runtime). Beyond references, it proves ORDER: quests (`requires`) and objectives (`after`)
 * are acyclic, and every item an objective `needs` is granted by an objective that is necessarily done before it.
 *
 * Budget: main and dungeon quests must sit in an arc and are counted through `arcs`; side AND link quests count against
 * `sideQuests`; discovery against `discoveryQuests`; locations by size, a pinpoint costing half a small POI. Objective
 * parameters come from the registered action block's own schema (`params`), conditions from `if`, consequences from
 * `then` objects; non-resident givers and targets are declared `entities`.
 *
 * Sameness (WARNINGS for now, thresholds in the zone brief's `variety`): each quest's signature
 * `source|action>action|conditions|consequences` may repeat (or near-repeat, Jaccard of block multisets) only so often in
 * the zone and its neighbours; floors on kill-free quests, non-NPC sources, world-gated quests and distinct actions; a
 * ceiling on plain NPC kill/collect errands; and each block's registered rarity cap.
 */
import path from "node:path";
import { conditionBlockNames, DEFAULT_PERFORM_ACTIONS, dialogueConditionSchema, literalCompassWords, questBlocks, questConsequenceSchema, type QuestBlockSlot } from "@hitreg/core";
import { exists, finish, load, readJson, type Ctx, type Finding } from "../lib.mts";
import { bestiarySchema, castSchema, HABITATS, questGraphSchema, zoneBestiarySchema, zoneBriefSchema, type PlannedQuest } from "../schemas.mts";
import { err, requireZone, townNames, warn } from "./_shared.mts";

/** The engine's objective kinds: the registered action blocks. */
export function objectiveKinds(): string[] {
  return questBlocks.names("action");
}
/** Target types each action accepts; an entity target must also be a declared entity of one of the listed kinds. */
const TARGET_FOR: Record<string, { types: string[]; entityKinds?: string[] }> = {
  visit: { types: ["place"] },
  kill: { types: ["creature"] },
  collect: { types: ["item"] },
  talk: { types: ["npc", "entity"], entityKinds: ["presence", "object"] },
  interact: { types: ["place", "entity"], entityKinds: ["object", "presence", "readable"] },
  read: { types: ["place", "entity"], entityKinds: ["readable"] },
  // an entity only: a delivery is handed over AT a thing (bind cannot aim it at a whole place)
  deliver: { types: ["entity"], entityKinds: ["object", "presence", "readable"] },
  endure: { types: ["place"] },
  perform: { types: ["place", "entity"], entityKinds: ["object", "presence", "readable"] },
};
type PlannedObjective = PlannedQuest["objectives"][number];
/** A consequence entry's registered block name: a name as written, or the block whose schema accepts the object. */
const consequenceName = (t: string | Record<string, unknown>): string =>
  typeof t === "string" ? t : (questBlocks.list("consequence").find((b) => b.schema.safeParse(t).success)?.name ?? "?");
const thenNames = (o: PlannedObjective): string[] => o.then.map(consequenceName);
/** Condition blocks a planned objective uses (`when` night/day is the clock; `if` names its own). */
const conditionsOf = (o: PlannedObjective): string[] => [...o.conditions, ...(o.when !== "any" ? ["clock"] : []), ...conditionBlockNames(o.if ?? {})];
/** Field names of a block's object schema, for messages. */
const fieldsOf = (schema: unknown): string[] => Object.keys((schema as { shape?: Record<string, unknown> }).shape ?? {});
/** `source|action>action|conditions|consequences`, targets stripped. */
export function questSignature(q: PlannedQuest): string {
  const conds = [...new Set(q.objectives.flatMap(conditionsOf))].sort();
  const then = [...new Set(q.objectives.flatMap(thenNames))].sort();
  return `${q.giver.type}|${q.objectives.map((o) => o.action).join(">")}|${conds.join(",")}|${then.join(",")}`;
}
/** Every block a quest uses, with repeats: the multiset near-duplicates are judged on. */
function blockBag(q: PlannedQuest): Map<string, number> {
  const bag = new Map<string, number>();
  const add = (k: string): void => void bag.set(k, (bag.get(k) ?? 0) + 1);
  add(`source:${q.giver.type}`);
  for (const o of q.objectives) {
    add(`action:${o.action}`);
    for (const c of conditionsOf(o)) add(`condition:${c}`);
    for (const c of thenNames(o)) add(`consequence:${c}`);
  }
  return bag;
}
export function jaccard(a: Map<string, number>, b: Map<string, number>): number {
  let lo = 0;
  let hi = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    lo += Math.min(a.get(k) ?? 0, b.get(k) ?? 0);
    hi += Math.max(a.get(k) ?? 0, b.get(k) ?? 0);
  }
  return hi ? lo / hi : 1;
}

/** First cycle in a directed graph (node -> successors), as a path, or null. */
function cycle(nodes: string[], next: (n: string) => string[]): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const m of next(n)) {
      const c = visit(m);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of nodes) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/** All transitive predecessors of `n` (excluding n). */
function ancestors(n: string, prev: (n: string) => string[]): Set<string> {
  const out = new Set<string>();
  const todo = [...prev(n)];
  while (todo.length) {
    const m = todo.pop()!;
    if (out.has(m)) continue;
    out.add(m);
    todo.push(...prev(m));
  }
  return out;
}

const isChain = (q: PlannedQuest): boolean => {
  const edges = q.objectives.reduce((n, o) => n + o.after.length, 0);
  const outDeg = new Map<string, number>();
  for (const o of q.objectives) for (const a of o.after) outDeg.set(a, (outDeg.get(a) ?? 0) + 1);
  return edges === q.objectives.length - 1 && q.objectives.every((o) => o.after.length <= 1) && [...outDeg.values()].every((d) => d <= 1);
};

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "quests");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const p = ctx.paths;
  const zone = ctx.zone;
  const inputs = [p.quests(zone), p.zoneBestiary(zone), p.brief(zone), p.bestiary];
  const cat = load(p.bestiary, bestiarySchema, f, "creature catalogue");
  const g = load(p.quests(zone), questGraphSchema, f, "quest graph");
  const zb = load(p.zoneBestiary(zone), zoneBestiarySchema, f, "zone bestiary");
  const brief = load(p.brief(zone), zoneBriefSchema, f, "zone brief");
  const kinds = objectiveKinds();
  if (kinds.length === 0) err(f, "engine-kinds", "could not read the objective kinds from @hitreg/core questSchema: the lint cannot judge actions");

  if (g && zb && brief) {
    if (g.quests.length === 0) err(f, "empty", "no quests planned");
    if (g.zone !== zone) err(f, "wrong-zone", `quests.zone is "${g.zone}", not "${zone}"`);
    // residents of the zone's town plans
    const residents = new Set<string>();
    const names = townNames(p, ctx.world);
    for (const t of brief.towns) {
      const name = names.get(t.id);
      if (!name || !exists(p.townPlan(name))) {
        warn(f, "no-plan", `${t.id}: no town plan, so its residents cannot be quest npcs yet`, t.id);
        continue;
      }
      inputs.push(p.townPlan(name));
      for (const r of (readJson(p.townPlan(name)) as { residents?: { id: string }[] }).residents ?? []) residents.add(r.id);
    }
    // a kill target: any creature the zone fields (wildlife, line-up, spill, a GROUP member), a rare, a boss, or a group id
    // ("members of this group": fight the gang, not just its leader)
    const creatures = new Set([...zb.wildlife.map((w) => w.creature), ...zb.faction.map((x) => x.creature), ...zb.minor.map((x) => x.creature), ...zb.groups.flatMap((gr) => gr.members.map((m) => m.creature)), ...zb.groups.map((gr) => gr.id), ...zb.rares.map((r) => r.id), ...zb.bosses.map((b) => b.id)]);
    const locations = new Map(g.locations.map((l) => [l.id, l]));
    const entities = new Map(g.entities.map((e) => [e.id, e]));
    for (const e of g.entities) {
      if (!locations.has(e.location)) err(f, "unknown-location", `entity ${e.id}: location "${e.location}" is not a location`, e.id);
      if (residents.has(e.id) || locations.has(e.id)) err(f, "id-clash", `entity ${e.id} reuses a resident or location id`, e.id);
    }
    // creature levels for the quest-level check: catalogue band, a rare's own level, a boss's base band
    const catalogue = new Map((cat?.creatures ?? []).map((c) => [c.id, c]));
    const levelOf = (ref: string): [number, number] | null => {
      const gr = zb.groups.find((x) => x.id === ref);
      if (gr) {
        const bands = gr.members.map((m) => catalogue.get(m.creature)?.level).filter((b): b is [number, number] => !!b);
        return bands.length ? [Math.min(...bands.map((b) => b[0])), Math.max(...bands.map((b) => b[1]))] : null;
      }
      const rare = zb.rares.find((r) => r.id === ref);
      if (rare) return [rare.level, rare.level];
      const boss = zb.bosses.find((b) => b.id === ref);
      const c = catalogue.get(boss ? boss.base : ref);
      return c ? c.level : null;
    };
    const items = new Map(g.items.map((i) => [i.id, i]));
    const quests = new Map(g.quests.map((q) => [q.id, q]));
    const used = new Set<string>();
    const itemAsset = (id: string): boolean => exists(path.join(p.projectDir, "assets", "items", `${id}.json`));

    for (const it of g.items) if (it.unique) err(f, "unique-item", `item ${it.id} is unique: one copy in a shared world strands every other player`, it.id);

    for (const q of g.quests) {
      const qr = q.id;
      if (q.arc && !g.arcs.some((a) => a.id === q.arc)) err(f, "unknown-arc", `${qr}: arc "${q.arc}" is not declared`, qr);
      if ((q.kind === "main" || q.kind === "dungeon") && !q.arc) err(f, "no-arc", `${qr}: a ${q.kind} quest outside any arc — the budget counts main and dungeon quests through their arcs`, qr);
      for (const r of q.requires) if (!quests.has(r)) err(f, "unknown-quest", `${qr}: requires "${r}", which is not a quest of this zone`, qr);
      if (!questBlocks.has("source", q.giver.type)) err(f, "unregistered-block", `${qr}: source "${q.giver.type}" is not a registered quest block (${questBlocks.names("source").join(", ")})`, qr);
      if (q.giver.type === "npc" && !residents.has(q.giver.ref)) err(f, "unknown-npc", `${qr}: giver "${q.giver.ref}" is not a resident of the zone's town plans`, qr);
      // leads: how a quest no person offers is found (rumour, lore, sight) — words, never a marker or a direction
      if (q.giver.type !== "npc" && q.leads.length === 0) err(f, "no-lead", `${qr}: its source is "${q.giver.type}", not a town npc, and it has no lead — nothing tells a player it exists`, qr);
      if (q.leads.length > brief.variety.maxLeadsPerQuest) warn(f, "many-leads", `${qr}: ${q.leads.length} leads (at most ${brief.variety.maxLeadsPerQuest}): a few hints, not a trail`, qr);
      const start = q.giver.type === "npc" ? "" : q.giver.ref || q.objectives[0]?.at || "";
      for (const [i, l] of q.leads.entries()) {
        const lr = `${qr}/lead ${i + 1}`;
        if (l.from.type === "resident" && !residents.has(l.from.ref)) err(f, "lead-holder", `${lr}: resident "${l.from.ref}" is not in the zone's town plans`, lr);
        if (l.from.type === "location") {
          if (!locations.has(l.from.ref)) err(f, "lead-holder", `${lr}: location "${l.from.ref}" is not a location`, lr);
          used.add(l.from.ref);
        }
        if (l.from.type === "readable" || l.from.type === "entity" || l.kind === "lore") {
          const e = entities.get(l.from.ref);
          if (!e) err(f, "lead-holder", `${lr}: ${l.kind} held by ${l.from.type} "${l.from.ref}", which is not a declared entity${l.from.type === "readable" ? " (a lore lead must name a declared READABLE, not its location)" : ""}`, lr);
          else {
            used.add(e.location);
            if ((l.kind === "lore" || l.from.type === "readable") && e.kind !== "readable") err(f, "lead-holder", `${lr}: lore must be held by a readable; ${e.id} is a ${e.kind}`, lr);
          }
        }
        if ((start && l.from.ref === start) || (q.giver.type !== "auto" && l.from.ref === q.giver.ref)) err(f, "lead-at-start", `${lr}: found at the quest's own start (${l.from.ref}) — a lead points there from somewhere else`, lr);
        if (/\{(dir|Dir|far):/.test(l.summary) || literalCompassWords(l.summary).length) err(f, "lead-direction", `${lr}: a lead names places and circumstances, never a direction or distance ({dir:}, {far:}, a compass word)`, lr);
      }
      const source = questBlocks.get("source", q.giver.type);
      if (source) {
        const parsed = source.schema.safeParse({ kind: q.giver.type, ref: q.giver.ref, ...(q.giver.when ? { when: q.giver.when } : {}), ...(q.giver.area ? { area: q.giver.area } : {}) });
        if (!parsed.success) err(f, "source-params", `${qr}: source ${q.giver.type}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")} (fields: ${fieldsOf(source.schema).join(", ")})`, qr);
      }
      if (q.giver.type === "object" || q.giver.type === "presence") {
        const e = entities.get(q.giver.ref);
        if (e) {
          used.add(e.location);
          if (e.kind === "readable" ? q.giver.type !== "object" : e.kind !== q.giver.type) err(f, "source-entity", `${qr}: a ${q.giver.type} source, but entity ${e.id} is a ${e.kind}`, qr);
        } else if (locations.has(q.giver.ref)) {
          used.add(q.giver.ref);
          warn(f, "source-legacy", `${qr}: ${q.giver.type} source names location ${q.giver.ref}; declare the ${q.giver.type} in \`entities\` and name it instead`, qr);
        } else err(f, "unknown-entity", `${qr}: ${q.giver.type} source "${q.giver.ref}" is neither a declared entity nor a location`, qr);
      }
      if (q.turnIn && !residents.has(q.turnIn)) err(f, "unknown-npc", `${qr}: turn-in "${q.turnIn}" is not a resident`, qr);
      if (q.level < brief.level[0] || q.level > brief.level[1]) warn(f, "level", `${qr}: level ${q.level} outside the zone's ${brief.level.join("-")}`, qr);
      for (const it of q.rewards.items) if (!items.has(it) && !itemAsset(it)) warn(f, "reward-item", `${qr}: reward "${it}" is neither a planned item nor an item asset`, qr);

      const objIds = new Set(q.objectives.map((o) => o.id));
      for (const o of q.objectives) {
        const ref = `${qr}/${o.id}`;
        if (kinds.length && !kinds.includes(o.action)) err(f, "unregistered-block", `${ref}: action "${o.action}" is not a registered quest block (${kinds.join(", ")})`, ref);
        for (const c of o.conditions) if (!questBlocks.has("condition", c)) err(f, "unregistered-block", `${ref}: condition "${c}" is not a registered quest block (${questBlocks.names("condition").join(", ")})`, ref);
        for (const c of o.then) {
          if (typeof c === "string") {
            if (!questBlocks.has("consequence", c)) err(f, "unregistered-block", `${ref}: consequence "${c}" is not a registered quest block (${questBlocks.names("consequence").join(", ")})`, ref);
          } else {
            const parsed = questConsequenceSchema.safeParse(c);
            if (!parsed.success) err(f, "consequence-params", `${ref}: consequence ${JSON.stringify(c)}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")} (shape: { do: setFlag | clearFlag, flag })`, ref);
          }
        }
        if (o.if) {
          const parsed = dialogueConditionSchema.safeParse(o.if);
          if (!parsed.success) err(f, "condition-params", `${ref}: if: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, ref);
          for (const c of conditionBlockNames(o.if)) if (!questBlocks.has("condition", c)) err(f, "unregistered-block", `${ref}: if uses "${c}", not a registered condition block (${questBlocks.names("condition").join(", ")})`, ref);
        }
        // the action block's own fields: params, with the legacy encodings (deliver's item in `needs`) still read
        const block = questBlocks.get("action", o.action);
        if (block) {
          const names = fieldsOf(block.schema);
          const unknown = Object.keys(o.params).filter((k) => !names.includes(k));
          if (unknown.length) err(f, "action-params", `${ref}: ${o.action} has no parameter ${unknown.join(", ")} (its parameters: ${names.join(", ") || "none"})`, ref);
          const merged: Record<string, unknown> = { ...(o.action === "deliver" && o.needs[0] ? { item: o.needs[0] } : {}), ...o.params };
          const parsed = block.schema.safeParse(merged);
          if (!parsed.success) {
            const missing = parsed.error.issues.filter((i) => i.path.length === 1 && !(String(i.path[0]) in merged));
            const wrong = parsed.error.issues.filter((i) => !missing.includes(i));
            if (wrong.length) err(f, "action-params", `${ref}: ${o.action} params: ${wrong.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")} (its parameters: ${names.join(", ")})`, ref);
            if (missing.length) warn(f, "action-params-missing", `${ref}: ${o.action} needs ${missing.map((i) => i.path.join(".")).join(", ")} in params before it can be bound (its parameters: ${names.join(", ")})`, ref);
          }
          if (o.action === "perform" && typeof o.params.action === "string" && !DEFAULT_PERFORM_ACTIONS.some((a) => a.name === o.params.action))
            warn(f, "perform-vocabulary", `${ref}: "${o.params.action}" is not an engine perform action (${DEFAULT_PERFORM_ACTIONS.map((a) => a.name).join(", ")}); the project must add it in its performActions asset`, ref);
        }
        const want = TARGET_FOR[o.action];
        if (want && !want.types.includes(o.target.type)) err(f, "target-type", `${ref}: ${o.action} takes a ${want.types.join(" or ")} target, not a ${o.target.type}`, ref);
        const t = o.target;
        if (t.type === "entity") {
          const e = entities.get(t.ref);
          if (!e) err(f, "unknown-entity", `${ref}: entity "${t.ref}" is not declared in \`entities\``, ref);
          else {
            used.add(e.location);
            if (want?.entityKinds && !want.entityKinds.includes(e.kind)) err(f, "target-type", `${ref}: ${o.action} cannot target a ${e.kind} (${e.id})`, ref);
          }
        }
        if (t.type === "creature" && o.action === "kill") {
          const band = levelOf(t.ref);
          if (band) {
            const d = q.level < band[0] ? band[0] - q.level : q.level > band[1] ? q.level - band[1] : 0;
            if (d > 3) err(f, "quest-level", `${ref}: a level ${q.level} quest sends the player against ${t.ref} (level ${band.join("-")})`, ref);
            else if (d > 0) warn(f, "quest-level", `${ref}: quest level ${q.level} is outside ${t.ref}'s ${band.join("-")}`, ref);
          }
        }
        if (t.type === "item" && o.action === "collect") {
          const it = items.get(t.ref);
          const granted = g.quests.some((qq) => qq.objectives.some((x) => x.grants.includes(t.ref)));
          const src = it?.source;
          const sourced =
            !!src &&
            (src.type === "creature" ? creatures.has(src.ref) : src.type === "location" ? locations.has(src.ref) : src.type === "npc" ? residents.has(src.ref) : entities.has(src.ref));
          if (src && !sourced) err(f, "item-source", `${ref}: ${t.ref}'s source ${src.type} "${src.ref}" does not resolve`, ref);
          if (src?.type === "location" && sourced) used.add(src.ref);
          if (!src && !granted) (it ? err : warn)(f, "item-source", `${ref}: collect ${t.ref}, but nothing drops, holds or grants it (give the item a \`source\` or an objective \`grants\`)`, ref);
        }
        if (t.type === "npc" && !residents.has(t.ref)) err(f, "unknown-npc", `${ref}: npc "${t.ref}" is not a resident of the zone's town plans`, ref);
        if (t.type === "creature" && !creatures.has(t.ref)) err(f, "unknown-creature", `${ref}: "${t.ref}" is not in the zone bestiary (a creature it fields, a group id, a rare or a boss)`, ref);
        if (t.type === "item" && !items.has(t.ref) && !itemAsset(t.ref)) err(f, "unknown-item", `${ref}: item "${t.ref}" is neither a planned quest item nor an item asset`, ref);
        if (t.type === "place") {
          if (!locations.has(t.ref)) err(f, "unknown-location", `${ref}: place "${t.ref}" is not a location`, ref);
          used.add(t.ref);
        }
        if (o.at) {
          if (!locations.has(o.at)) err(f, "unknown-location", `${ref}: at "${o.at}" is not a location`, ref);
          used.add(o.at);
        }
        for (const a of o.after) if (!objIds.has(a)) err(f, "unknown-objective", `${ref}: after "${a}", not an objective of ${qr}`, ref);
        for (const it of [...o.needs, ...o.grants]) if (!items.has(it)) err(f, "unknown-item", `${ref}: quest item "${it}" is not declared in items`, ref);
      }
      const oc = cycle([...objIds], (n) => q.objectives.find((o) => o.id === n)!.after.filter((a) => objIds.has(a)));
      if (oc) err(f, "objective-cycle", `${qr}: objectives wait on each other: ${oc.join(" -> ")}`, qr);
    }
    const qc = cycle([...quests.keys()], (n) => quests.get(n)!.requires.filter((r) => quests.has(r)));
    if (qc) err(f, "quest-cycle", `quests require each other: ${qc.join(" -> ")}`);

    // items: every `needs` granted by something necessarily done earlier
    if (!qc) {
      for (const q of g.quests) {
        const earlierQuests = ancestors(q.id, (n) => quests.get(n)?.requires ?? []);
        const objIds = new Set(q.objectives.map((o) => o.id));
        for (const o of q.objectives) {
          if (o.needs.length === 0) continue;
          const before = ancestors(o.id, (n) => (q.objectives.find((x) => x.id === n)?.after ?? []).filter((a) => objIds.has(a)));
          const granted = new Set<string>();
          for (const b of before) for (const it of q.objectives.find((x) => x.id === b)!.grants) granted.add(it);
          for (const eq of earlierQuests) for (const x of quests.get(eq)?.objectives ?? []) for (const it of x.grants) granted.add(it);
          for (const it of o.needs)
            if (!granted.has(it)) {
              const anywhere = g.quests.flatMap((qq) => qq.objectives.filter((x) => x.grants.includes(it)).map((x) => `${qq.id}/${x.id}`));
              err(f, "need-unreachable", `${q.id}/${o.id} needs ${it}, but ${anywhere.length ? `it is granted only by ${anywhere.join(", ")}, not necessarily done first (add after/requires)` : "nothing grants it"}`, `${q.id}/${o.id}`);
            }
        }
      }
    }

    for (const a of g.arcs) for (const qid of a.quests) {
      if (!quests.has(qid)) err(f, "unknown-quest", `arc ${a.id}: quest "${qid}" does not exist`, a.id);
      else if (quests.get(qid)!.arc !== a.id) warn(f, "arc-mismatch", `arc ${a.id} lists ${qid}, whose arc is "${quests.get(qid)!.arc}"`, a.id);
    }

    // locations & dungeons
    const townIds = new Set(brief.towns.map((t) => t.id));
    for (const r of zb.rares) {
      if (locations.has(r.where)) used.add(r.where);
      else if (!(HABITATS as readonly string[]).includes(r.where)) err(f, "rare-where", `rare ${r.id} haunts "${r.where}", which is neither a location of this graph nor a habitat`, r.id);
    }
    for (const b of zb.bosses) if (b.dungeon && !g.dungeons.some((d) => d.id === b.dungeon)) err(f, "boss-dungeon", `boss ${b.id} lives in dungeon "${b.dungeon}", which the quest graph does not plan`, b.id);
    for (const d of g.dungeons) {
      const ref = d.id;
      const boss = zb.bosses.find((b) => b.id === d.antagonist);
      if (!boss) err(f, "antagonist", `dungeon ${ref}: antagonist "${d.antagonist}" is not a boss in the zone bestiary`, ref);
      else if (boss.dungeon && boss.dungeon !== d.id) warn(f, "antagonist", `dungeon ${ref}: boss ${boss.id} says it lives in "${boss.dungeon}"`, ref);
      const ent = locations.get(d.entrance);
      if (!ent) err(f, "entrance", `dungeon ${ref}: entrance "${d.entrance}" is not a location`, ref);
      else {
        used.add(ent.id);
        if (ent.kind !== "dungeon-entrance") err(f, "entrance", `dungeon ${ref}: entrance ${ent.id} is a ${ent.kind}, not a dungeon-entrance`, ref);
        if (ent.entranceTo && ent.entranceTo !== d.id) err(f, "entrance", `dungeon ${ref}: entrance ${ent.id} leads to "${ent.entranceTo}"`, ref);
      }
      if (d.rooms.length === 0) warn(f, "rooms", `dungeon ${ref}: no required rooms listed — its quests ask nothing of the layout`, ref);
    }
    for (const l of g.locations) {
      if (l.kind === "town" && !townIds.has(l.town)) err(f, "town", `location ${l.id}: town "${l.town}" is not a town of this zone`, l.id);
      if (l.kind === "dungeon-entrance" && l.entranceTo && !g.dungeons.some((d) => d.id === l.entranceTo)) err(f, "entrance", `location ${l.id}: enters unknown dungeon "${l.entranceTo}"`, l.id);
      if (!used.has(l.id) && !l.discovery && l.kind !== "town") err(f, "unused-location", `location ${l.id} is used by no quest and not marked discovery`, l.id);
    }
    // quests attach to the brief's signature places: each place is a location of the same id, sized as designed
    for (const pl of brief.places) {
      const l = locations.get(pl.id);
      if (!l) err(f, "place-missing", `signature place ${pl.id} has no location of the same id: quests attach to places, they do not replace them`, pl.id);
      else if (l.size !== pl.size) err(f, "place-size", `location ${pl.id} is ${l.size}, the brief designed it ${pl.size}`, pl.id);
      if (pl.dungeon && !g.dungeons.some((d) => d.entrance === pl.id || locations.get(d.entrance)?.place === pl.id))
        err(f, "place-dungeon", `place ${pl.id} owns the dungeon "${pl.dungeon.name}" and no planned dungeon enters there (an entrance location with place "${pl.id}")`, pl.id);
    }
    const placeIds = new Set(brief.places.map((x) => x.id));
    for (const l of g.locations) if (l.place && !placeIds.has(l.place)) err(f, "unknown-place", `location ${l.id}: place "${l.place}" is not a signature place of the brief`, l.id);
    // one landmark, one dungeon
    const dungeonsAt = new Map<string, string[]>();
    for (const d of g.dungeons) {
      const at = locations.get(d.entrance)?.place || d.entrance;
      dungeonsAt.set(at, [...(dungeonsAt.get(at) ?? []), d.id]);
    }
    for (const [at, ds] of dungeonsAt) if (ds.length > 1 && placeIds.has(at)) warn(f, "place-dungeons", `place ${at} has ${ds.length} dungeons (${ds.join(", ")}): each landmark gets its own`, at);

    // who holds the hostile places: one story faction, but most places belong to someone else
    {
      const v = brief.variety;
      const castFile = p.cast;
      const cast = exists(castFile) ? castSchema.safeParse(readJson(castFile)) : null;
      if (cast?.success) inputs.push(castFile);
      const main = cast?.success ? (cast.data.rows.find((r) => r.zone === zone)?.faction ?? "") : "";
      const groups = new Map(zb.groups.map((gr) => [gr.id, gr]));
      const factionIds = new Set((cat?.factions ?? []).map((x) => x.id));
      const holder = new Map<string, { key: string; faction: string }>();
      for (const l of g.locations) {
        if (!l.hostile) continue;
        const gr = groups.get(l.hostile);
        if (gr) holder.set(l.id, { key: gr.id, faction: gr.faction });
        else if (factionIds.has(l.hostile)) holder.set(l.id, { key: l.hostile, faction: l.hostile });
        else err(f, "hostile", `location ${l.id}: hostile "${l.hostile}" is neither a group of the zone bestiary nor a catalogue faction`, l.id);
      }
      const n = holder.size;
      const mainHeld = [...holder.values()].filter((h) => main && h.faction === main).length;
      if (n > 0 && mainHeld / n > v.maxMainHostileShare)
        err(f, "main-holds-all", `${mainHeld} of ${n} hostile places are held by the main faction ${main} (at most ${Math.round(v.maxMainHostileShare * 100)}%): give most places their own occupants`);
      const distinct = new Set([...holder.values()].map((h) => h.key)).size;
      if (n >= v.minHostileGroups && distinct < v.minHostileGroups)
        err(f, "few-holders", `${n} hostile places held by only ${distinct} group(s) (at least ${v.minHostileGroups}): ${[...new Set([...holder.values()].map((h) => h.key))].join(", ")}`);
      // kill objectives across the zone: whose members do they target?
      const groupOf = (ref: string): string => {
        if (zb.groups.some((x) => x.id === ref)) return ref;
        if (zb.rares.some((r) => r.id === ref) || zb.bosses.some((b) => b.id === ref)) return ref;
        const gr = zb.groups.find((x) => x.members.some((m) => m.creature === ref));
        if (gr) return gr.id;
        if (zb.faction.some((x) => x.creature === ref)) return `faction:${main}`;
        const minor = zb.minor.find((x) => x.creature === ref);
        return minor ? `minor:${minor.from}` : `wildlife:${ref}`;
      };
      const killed = new Set(g.quests.flatMap((q) => q.objectives.filter((o) => o.action === "kill" && o.target.type === "creature").map((o) => groupOf(o.target.ref))));
      if (killed.size > 0 && killed.size < v.minKillGroups) warn(f, "few-kill-groups", `kill objectives target only ${killed.size} group(s) (${[...killed].join(", ")}); at least ${v.minKillGroups}`);
    }

    // budget
    const b = brief.budget;
    const count = (k: string): number => g.quests.filter((q) => q.kind === k).length;
    const over = (what: string, n: number, cap: number): void => {
      if (n > cap) err(f, "budget", `${n} ${what} against a budget of ${cap}`);
    };
    over("arcs", g.arcs.length, b.arcs);
    if (b.mainQuests !== undefined) over("main quests", count("main"), b.mainQuests);
    over("side and link quests", count("side") + count("link"), b.sideQuests);
    over("discovery quests", count("discovery"), b.discoveryQuests);
    over("dungeons", g.dungeons.length, b.dungeons);
    const sized = (s: string): number => g.locations.filter((l) => l.kind !== "town" && l.size === s).length;
    // a pinpoint is half a small POI: two pinpoints (a stone, a grave) cost one small site
    const pins = sized("pinpoint");
    if (sized("small") + Math.ceil(pins / 2) > b.pois.small)
      err(f, "budget", `${sized("small")} small locations + ${pins} pinpoint(s) (two pinpoints count as one small) against a budget of ${b.pois.small}`);
    over("medium locations", sized("medium"), b.pois.medium);
    over("large locations", sized("large"), b.pois.large);

    // sameness: signatures, floors, ceiling, rarity (warnings for now)
    {
      const v = brief.variety;
      const sig = new Map(g.quests.map((q) => [q.id, questSignature(q)]));
      const bags = new Map(g.quests.map((q) => [q.id, blockBag(q)]));
      const repeats = (q: PlannedQuest, pool: PlannedQuest[]): PlannedQuest[] =>
        pool.filter((o) => questSignature(o) === sig.get(q.id) || jaccard(blockBag(o), bags.get(q.id)!) >= v.nearDuplicate);
      const neighbourQuests: PlannedQuest[] = [];
      for (const n of brief.neighbours) {
        if (!exists(p.quests(n.zone))) continue;
        const ng = questGraphSchema.safeParse(readJson(p.quests(n.zone)));
        if (ng.success) neighbourQuests.push(...ng.data.quests);
      }
      const reported = new Set<string>();
      for (const q of g.quests) {
        const s = sig.get(q.id)!;
        if (reported.has(s)) continue;
        const here = repeats(q, g.quests);
        if (here.length > v.maxRepeatPerZone) {
          reported.add(s);
          warn(f, "repeat", `${here.length} quests share the shape ${s} (or nearly): ${here.map((x) => x.id).join(", ")} — at most ${v.maxRepeatPerZone} per zone`, q.id);
          continue;
        }
        const around = here.length + repeats(q, neighbourQuests).length;
        if (around > v.maxRepeatNeighbourhood) {
          reported.add(s);
          warn(f, "repeat-neighbourhood", `${around} quests across this zone and its neighbours share the shape ${s} — at most ${v.maxRepeatNeighbourhood}`, q.id);
        }
      }
      const n = g.quests.length;
      if (n > 0) {
        const noKill = g.quests.filter((q) => !q.objectives.some((o) => o.action === "kill")).length;
        if (noKill / n < v.minNoKillShare) warn(f, "floor-no-kill", `${noKill}/${n} quests have no kill; the floor is ${Math.round(v.minNoKillShare * 100)}%`);
        const nonNpc = g.quests.filter((q) => q.giver.type !== "npc").length;
        if (nonNpc < v.minNonNpcSources) warn(f, "floor-sources", `${nonNpc} quests come from something other than an NPC; the floor is ${v.minNonNpcSources}`);
        const worldGated = g.quests.filter((q) => q.objectives.some((o) => conditionsOf(o).some((c) => questBlocks.get("condition", c)?.scope === "world"))).length;
        if (worldGated < v.minWorldGated) warn(f, "floor-world-gated", `${worldGated} quests are gated by world state (clock, weather); the floor is ${v.minWorldGated}`);
        const distinct = new Set(g.quests.flatMap((q) => q.objectives.map((o) => o.action))).size;
        if (distinct < v.minDistinctActions) warn(f, "floor-actions", `${distinct} distinct actions in the zone; the floor is ${v.minDistinctActions}`);
        const plain = g.quests.filter((q) => /^npc\|(kill(>kill)*|collect(>collect)*)\|\|$/.test(sig.get(q.id)!)).length;
        if (plain / n > v.maxKillCollectShare) warn(f, "ceiling-errands", `${plain}/${n} quests are an NPC sending you to kill or collect; the ceiling is ${Math.round(v.maxKillCollectShare * 100)}%`);
      }
      // rarity caps a block declares
      const uses = new Map<string, number>();
      const count = (slot: QuestBlockSlot, name: string): void => void uses.set(`${slot}:${name}`, (uses.get(`${slot}:${name}`) ?? 0) + 1);
      for (const q of g.quests) {
        const seen = new Set<string>();
        const once = (slot: QuestBlockSlot, name: string): void => { if (!seen.has(`${slot}:${name}`)) { seen.add(`${slot}:${name}`); count(slot, name); } };
        once("source", q.giver.type);
        for (const o of q.objectives) {
          once("action", o.action);
          for (const c of conditionsOf(o)) once("condition", c);
          for (const c of thenNames(o)) once("consequence", c);
        }
      }
      for (const b of questBlocks.list()) {
        const used = uses.get(`${b.slot}:${b.name}`) ?? 0;
        if (b.rarity?.perZone !== undefined && used > b.rarity.perZone) warn(f, "rarity", `${b.slot} block "${b.name}" is rare (at most ${b.rarity.perZone} per zone) but ${used} quests use it`);
      }
    }

    // shape
    const places = g.locations.filter((l) => l.kind !== "town").length;
    if (g.quests.length >= 4 && places / g.quests.length >= 0.8)
      warn(f, "place-per-quest", `${places} locations for ${g.quests.length} quests: nearly one place per quest; let quests share places`);
    const long = g.quests.filter((q) => q.objectives.length >= 3);
    if (long.length > 0 && long.every(isChain)) warn(f, "all-linear", `every multi-step quest is a straight line; give some a branch (two objectives with no order)`);
    console.log(`quests ${zone}: ${g.quests.length} quests, ${g.arcs.length} arcs, ${g.locations.length} locations, ${g.dungeons.length} dungeons, ${g.items.length} items; kinds ${kinds.join("/")}`);
  }
  return finish(ctx, "quests", inputs, f);
}
