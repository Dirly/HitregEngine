import type { ComponentRegistry } from "./components/registry.js";
import { diffSceneDocs } from "./diff.js";
import { applyOps, type Op } from "./ops.js";
import { createScene, type EntityDoc, type SceneDoc } from "./scene.js";
import { applyOwnerState, entityOwnerState, ownerAddedEntity, sameOwnerTransform, type OwnerOverride, type OwnerOverrides, type OwnerTransform } from "./dressing/owner.js";

/**
 * SCENE SYNC — a generator (a dungeon's build-scene, an installer) and the people editing the same scene, at once.
 *
 * A builder computes its TARGET (the entities it generates) and hands it here instead of rewriting the scene file.
 * `planSceneSync` returns ONE ops batch that brings the live scene's `built:<builder>` entities to that target and
 * touches nothing else; an unchanged target is zero ops. The builder tag answers "which entities does this generator
 * regenerate", nothing more: it is not a permission boundary.
 *
 * Deliberate edits (the owner's in the editor, an agent's through `editScene`) are kept in the scene's EDIT RECORD
 * (`OwnerOverrides`, frame "scene"; precedence owner > agent > generator: `ownerProps` = what the owner holds). The sync puts every record onto the
 * target before diffing, so a regeneration never undoes a move, delete, add or component change. A record names its
 * entity by id; when the id is gone it falls back to KIND + PLACE (same prefab, or same name and component kinds,
 * within `matchRadius` of the record's `from` position); one that matches nothing is reported stale, never guessed.
 * A deleted entity takes its subtree and every entity tagged `with:<its id>` (dependents the builder declares).
 * Pure: no fs, no DOM.
 */

export const BUILT_TAG_PREFIX = "built:";
export const builtTag = (builder: string): string => `${BUILT_TAG_PREFIX}${builder}`;
/** The builder that generates an entity (its `built:<builder>` tag), or null. */
export const builderOf = (e: { tags?: readonly string[] } | undefined): string | null =>
  e?.tags?.find((t) => t.startsWith(BUILT_TAG_PREFIX))?.slice(BUILT_TAG_PREFIX.length) ?? null;

/** Separator between the parts of a stable id (a "/" would break prefab override paths if the subtree became a prefab). */
export const STABLE_ID_SEP = "--";
const slug = (p: string | number): string =>
  String(p)
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

/**
 * A STABLE entity id from what the thing is and its generator key: `stableId("camp", "floor-5", "tent", 1)` ->
 * `camp--floor-5--tent-1`... parts are slugged and joined with `--` (a trailing number joins its word with "-").
 * Never a running counter over the whole build: a key must stay the same when an unrelated thing is added.
 */
export function stableId(...parts: (string | number)[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p === "number" && out.length) out[out.length - 1] = `${out[out.length - 1]}-${slug(p)}`;
    else out.push(slug(p));
  }
  return out.join(STABLE_ID_SEP);
}

/**
 * Ids per key: `ids.of("tent")` -> `tent-1`, `tent-2`… counted PER KEY (a scope such as a room or a camp), so adding a
 * thing to one scope never renames another scope's things. Prefer keys that already say which one (a position slot,
 * a named spot); this is for genuinely interchangeable siblings inside one scope.
 */
export function idCounter(): { of(...key: (string | number)[]): string } {
  const n = new Map<string, number>();
  return {
    of(...key) {
      const k = stableId(...key);
      const i = (n.get(k) ?? 0) + 1;
      n.set(k, i);
      return `${k}-${i}`;
    },
  };
}

/** Every id an ops list adds more than once (a builder bug: the second add would fail, or silently replace). */
export function duplicateAddIds(ops: readonly Op[]): string[] {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const o of ops) if (o.op === "add-entity") (seen.has(o.id) ? dup : seen).add(o.id);
  return [...dup];
}

/** A builder's ops (adds, then any edits of them) as a target doc; throws listing EVERY duplicate id. */
export function targetFromOps(name: string, ops: Op[], registry: ComponentRegistry): SceneDoc {
  const dup = duplicateAddIds(ops);
  if (dup.length) throw new Error(`scene-sync: ${dup.length} duplicate id(s) in the builder's ops: ${dup.slice(0, 20).join(", ")}${dup.length > 20 ? " …" : ""}`);
  // parents another builder (or the live scene) owns: stand-ins so the batch validates; never part of the target
  const stand: Op[] = [];
  const added = new Set(ops.flatMap((o) => (o.op === "add-entity" ? [o.id] : [])));
  for (const o of ops) {
    const p = o.op === "add-entity" ? o.entity.parent : o.op === "reparent" ? o.parent : null;
    if (p && !added.has(p) && !stand.some((s) => s.op === "add-entity" && s.id === p)) stand.push({ op: "add-entity", id: p, entity: { name: p, parent: null, tags: ["scene-sync:external-parent"], components: {} } as EntityDoc });
  }
  const { doc } = applyOps(createScene(name), [...stand, ...ops], registry);
  for (const s of stand) if (s.op === "add-entity") delete doc.entities[s.id];
  return doc;
}

const sortedKinds = (e: EntityDoc): string[] => Object.keys(e.components).sort();
/** Same transform/prefab state within the record's precision (components are compared by the diff itself). */
const sameState = (a: OwnerTransform, b: OwnerTransform): boolean => sameOwnerTransform(a, b) && sameOwnerTransform(b, a);
const posOf = (e: EntityDoc | undefined): [number, number, number] | null => {
  const p = (e?.components["transform"] as { position?: number[] } | undefined)?.position;
  return p ? [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] : null;
};
const prefabOf = (e: EntityDoc | undefined): string | undefined => (e?.components["prefab"] as { prefabId?: string } | undefined)?.prefabId;

/** The record of an entity edit, as the editor and `editScene` report it (the bridge folds it into the record file). */
export interface EntityEdit {
  entity: string;
  tags: string[];
  name: string;
  parent: string | null;
  kind: string[];
  before: OwnerTransform | null;
  after: OwnerTransform | null;
  note?: string;
  /** An agent edit: the owner-held properties it overrides on purpose. */
  overrideOwner?: string[];
}

/**
 * The edits a batch made, entity by entity (`ids` = changed ∪ added ∪ removed of its ApplyResult). Transform and prefab
 * for anything; every other component too, except on a dressed prop (`dress:<plan>`: its plan file holds props only).
 * A change of name, tags or parent alone is not an edit record (nothing a regeneration would undo that it should not).
 */
export function entityEditsOf(before: SceneDoc, after: SceneDoc, ids: Iterable<string>, note?: string): EntityEdit[] {
  const out: EntityEdit[] = [];
  for (const id of ids) {
    const eb = before.entities[id], ea = after.entities[id];
    const e = (ea ?? eb)!;
    if (!e) continue;
    const components = !(e.tags ?? []).some((t) => t.startsWith("dress:"));
    const sb = eb ? entityOwnerState(eb as never, { components }) : null, sa = ea ? entityOwnerState(ea as never, { components }) : null;
    if (sb && sa && JSON.stringify(sb) === JSON.stringify(sa)) continue;
    out.push({ entity: id, tags: [...(e.tags ?? [])], name: e.name ?? id, parent: e.parent ?? null, kind: sortedKinds(e as EntityDoc), before: sb, after: sa, ...(note ? { note } : {}) });
  }
  return out;
}

export interface SceneSyncOptions {
  builder: string;
  /** The scene's edit record (owner + agent edits, frame "scene"). */
  edits?: OwnerOverrides | null;
  /**
   * Live entities WITHOUT any `built:` tag that this builder made before it tagged its output (the one-time move from
   * a whole-file rewrite): claimed, they are regenerated (updated, or removed when the target no longer has them).
   * Applies only on the FIRST sync (no entity carries `built:<builder>` yet), never to `owner-added` / recorded adds.
   */
  claim?: (id: string, e: EntityDoc) => boolean;
  /** Kind + place fallback radius, metres. Default 1.5. */
  matchRadius?: number;
  /** Normalizes the record's components through their schemas (recommended: the registry the scene validates with). */
  registry?: ComponentRegistry;
  /**
   * Components / tags this builder puts on entities it does NOT generate (a portal stage giving the layout's exit its
   * portal script). Each is marked on the entity with an `attach:<builder>/<component>` or `attach:<builder>#<tag>` tag,
   * which every other builder's sync keeps (its regeneration never strips them); this builder's next sync updates or
   * takes back what it no longer attaches.
   */
  attach?: { id: string; components?: Record<string, unknown>; tags?: string[] }[];
}

const ATTACH = /^attach:([^/#]+)([/#])(.+)$/;
export const attachTag = (builder: string, component: string): string => `attach:${builder}/${component}`;
export const attachTagOfTag = (builder: string, tag: string): string => `attach:${builder}#${tag}`;

export interface SceneSyncPlan {
  ops: Op[];
  counts: { owned: number; target: number; add: number; remove: number; change: number; reparent: number; unchanged: number; adopted: number; claimed: number; attached: number };
  edits: {
    /** Records put onto the target (id -> who made it). */
    held: { id: string; by: string; reasons: string[] }[];
    /** Records whose id is gone, matched by kind + place. */
    byPlace: { record: string; entity: string; distance: number }[];
    deleted: string[];
    /** Hand-added entities missing from the live scene, re-added. */
    restored: string[];
    /** Records that match nothing this builder generates (kept, reported). */
    stale: { record: string; why: string }[];
  };
  warnings: string[];
}

/**
 * The ops batch that brings `live`'s `built:<builder>` entities to `target` (+ the edit record), and nothing else.
 * Throws when a target id is generated by another builder.
 */
export function planSceneSync(live: SceneDoc, target: SceneDoc, opts: SceneSyncOptions): SceneSyncPlan {
  const tag = builtTag(opts.builder), radius = opts.matchRadius ?? 1.5;
  const T: Record<string, EntityDoc> = structuredClone(target.entities);
  for (const e of Object.values(T)) if (!e.tags.includes(tag)) e.tags = [...e.tags.filter((t) => !t.startsWith(BUILT_TAG_PREFIX)), tag];
  const records = opts.edits?.overrides ?? [];
  const addedIds = new Set(records.filter((r) => r.added).map((r) => r.entity ?? r.item));

  // what this builder regenerates in the live scene
  const L: Record<string, EntityDoc> = {};
  let adopted = 0, claimed = 0;
  // claim is the one-time move off a whole-file rewrite: only while no entity carries this builder's tag yet
  const firstSync = !Object.values(live.entities).some((e) => builderOf(e) === opts.builder);
  const conflicts: string[] = [];
  for (const [id, e] of Object.entries(live.entities)) {
    const b = builderOf(e);
    if (b === opts.builder) L[id] = e;
    else if (id in T) {
      if (b) conflicts.push(`${id} (built:${b})`);
      else { L[id] = e; adopted++; }
    } else if (firstSync && !b && !addedIds.has(id) && !e.tags.includes("owner-added") && opts.claim?.(id, e)) { L[id] = e; claimed++; }
  }
  if (conflicts.length) throw new Error(`scene-sync ${opts.builder}: ${conflicts.length} target id(s) are generated by another builder: ${conflicts.slice(0, 12).join(", ")}`);

  // what OTHER builders attached to this builder's entities stays (their markers, components and tags)
  for (const [id, t] of Object.entries(T)) {
    const e = L[id];
    if (!e) continue;
    for (const tg of e.tags) {
      const m = ATTACH.exec(tg);
      if (!m || m[1] === opts.builder) continue;
      if (!t.tags.includes(tg)) t.tags.push(tg);
      if (m[2] === "/") { if (m[3]! in e.components) t.components[m[3]!] = structuredClone(e.components[m[3]!]); }
      else if (!t.tags.includes(m[3]!)) t.tags.push(m[3]!);
    }
  }

  // ---- the edit record onto the target ----
  const held: SceneSyncPlan["edits"]["held"] = [], byPlace: SceneSyncPlan["edits"]["byPlace"] = [], deleted: string[] = [], restored: string[] = [];
  const stale: SceneSyncPlan["edits"]["stale"] = [];
  const matched = new Map<OwnerOverride, string>();
  const taken = new Set<string>();
  const mine = records.filter((r) => !r.added && (r.builder === undefined || r.builder === opts.builder));
  for (const r of mine) {
    const id = r.entity ?? r.item;
    if (id in T) { matched.set(r, id); taken.add(id); }
  }
  for (const r of mine) {
    if (matched.has(r)) continue;
    const id = r.entity ?? r.item;
    // an entity this builder does not generate (another builder's, or nobody's): not this sync's business
    if (id in live.entities && !(id in L)) continue;
    if (r.builder === undefined && !(id in L) && !r.from) continue;
    // a record with no builder (made before ids were stable): only a builder that generates that kind considers it
    if (r.builder === undefined && !(id in L) && !Object.values(T).some((e) => (r.from?.prop ? prefabOf(e) === r.from.prop : !prefabOf(e) && (r.name === undefined || e.name === r.name)))) continue;
    const at = r.from?.pos;
    if (!at) { stale.push({ record: r.item, why: "no id match and no recorded position to match by place" }); continue; }
    const cands: { id: string; d: number }[] = [];
    for (const [tid, e] of Object.entries(T)) {
      if (taken.has(tid)) continue;
      const kindOk = r.from?.prop ? prefabOf(e) === r.from.prop : !prefabOf(e) && (r.name === undefined || e.name === r.name) && (!r.kind || r.kind.join() === sortedKinds(e).join());
      const p = kindOk ? posOf(e) : null;
      if (!p) continue;
      const d = Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
      if (d <= radius) cands.push({ id: tid, d });
    }
    cands.sort((a, b) => a.d - b.d);
    if (!cands.length) {
      if (r.builder === opts.builder || id in L) stale.push({ record: r.item, why: `${r.deleted ? "deleted" : "edited"} ${r.from?.prop ?? r.name ?? "entity"}: nothing of that kind within ${radius} m of [${at.map((v) => v.toFixed(1)).join(", ")}]` });
      else stale.push({ record: r.item, why: `${r.deleted ? "deleted (already gone)" : "edited"} ${r.from?.prop ?? r.name ?? "entity"}: no builder recorded and nothing of that kind of this builder's within ${radius} m of [${at.map((v) => v.toFixed(1)).join(", ")}]` });
      continue;
    }
    if (cands.length > 1 && cands[1]!.d - cands[0]!.d < 0.05) { stale.push({ record: r.item, why: `ambiguous: ${cands[0]!.id} and ${cands[1]!.id} are both ${cands[0]!.d.toFixed(2)} m from where it was` }); continue; }
    matched.set(r, cands[0]!.id);
    taken.add(cands[0]!.id);
    byPlace.push({ record: r.item, entity: cands[0]!.id, distance: +cands[0]!.d.toFixed(3) });
  }
  for (const [r, id] of matched) {
    if (!(id in T)) continue;
    if (r.deleted) {
      const doomed = [id];
      // its subtree, and what the builder marked as going with it (`with:<id>`: a tipi's wall colliders and furs)
      for (let i = 0; i < doomed.length; i++) for (const [cid, c] of Object.entries(T)) if (!doomed.includes(cid) && (c.parent === doomed[i] || c.tags.includes(`with:${doomed[i]}`))) doomed.push(cid);
      for (const d of doomed) delete T[d];
      deleted.push(id);
      continue;
    }
    const builders = T[id]!.components;
    T[id]!.components = { ...builders };
    applyOwnerState(T[id]! as never, r.set);
    // a record's components in the schema's own shape (defaults, key order), so an unchanged one diffs as unchanged
    if (opts.registry) for (const k of Object.keys(r.set.components ?? {})) {
      const v = opts.registry.validate(k, T[id]!.components[k]);
      if (v.ok) T[id]!.components[k] = v.data;
      else {
        if (k in builders) T[id]!.components[k] = builders[k];
        else delete T[id]!.components[k];
        stale.push({ record: r.item, why: `its ${k} no longer validates (${v.error}); the builder's ${k} is kept` });
      }
    }
    // the record keeps 4 decimals and a yaw in degrees: a live transform already in that state stays byte-for-byte
    const cur = L[id];
    if (cur?.components["transform"] && sameState(entityOwnerState(cur as never), entityOwnerState(T[id]! as never))) T[id]!.components["transform"] = structuredClone(cur.components["transform"]);
    held.push({ id, by: r.by, reasons: r.reasons });
  }

  // tags are a set here: the same tags in another order are no change
  for (const [id, t] of Object.entries(T)) {
    const e = L[id];
    if (e && e.tags.length === t.tags.length && t.tags.every((x) => e.tags.includes(x))) t.tags = [...e.tags];
  }

  // hand-added entities the scene lost (a whole-file rewrite before the sync existed): back in
  const incoming: Record<string, EntityDoc> = {};
  for (const [id, e] of Object.entries(live.entities)) if (!(id in L)) incoming[id] = e;
  Object.assign(incoming, T);
  for (const r of records) {
    const id = r.entity ?? r.item;
    if (!r.added || r.deleted || id in incoming) continue;
    incoming[id] = ownerAddedEntity(r, (p) => p in incoming) as EntityDoc;
    restored.push(id);
  }

  // ---- diff: the whole scene, where only this builder's entities (and restored ones) can differ ----
  const ops = diffSceneDocs(live, { ...live, entities: incoming });
  const removes = ops.filter((o): o is Extract<Op, { op: "remove-entity" }> => o.op === "remove-entity");
  const warnings: string[] = [];
  // a removal cascades: never take down an entity nobody regenerates (a hand-added prop under a builder's group)
  const keepParents = new Set<string>();
  for (const o of removes) {
    const sub = [o.id];
    for (let i = 0; i < sub.length; i++) for (const [cid, c] of Object.entries(live.entities)) if (c.parent === sub[i]) sub.push(cid);
    const foreign = sub.filter((id) => !(id in L) && !(id in T));
    if (foreign.length) { keepParents.add(o.id); warnings.push(`kept ${o.id}: the target drops it but it holds ${foreign.length} entit${foreign.length === 1 ? "y" : "ies"} this builder does not generate (${foreign.slice(0, 4).join(", ")}); reparent them, then re-run`); }
  }
  const finalOps = ops.filter((o) => !(o.op === "remove-entity" && keepParents.has(o.id)));

  // ---- this builder's attachments to entities it does not generate ----
  let attachedChanged = 0;
  const want = new Map((opts.attach ?? []).map((a) => [a.id, a]));
  const touched = new Set<string>(want.keys());
  for (const [id, e] of Object.entries(live.entities)) if (e.tags.some((t) => ATTACH.exec(t)?.[1] === opts.builder)) touched.add(id);
  for (const id of touched) {
    const e = live.entities[id];
    if (!e) { if (!(id in T)) throw new Error(`scene-sync ${opts.builder}: attach to ${id}, which is not in the scene`); continue; }
    if (id in T) throw new Error(`scene-sync ${opts.builder}: attach to ${id}, which this builder generates (put it in the target)`);
    const a = want.get(id);
    const comps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a?.components ?? {})) {
      const r = opts.registry?.validate(k, v);
      if (r && !r.ok) throw new Error(`scene-sync ${opts.builder}: attach ${k} to ${id}: ${r.error}`);
      comps[k] = r ? r.data : v;
    }
    const oldMarks = e.tags.filter((t) => ATTACH.exec(t)?.[1] === opts.builder);
    const oldTags = oldMarks.flatMap((t) => { const m = ATTACH.exec(t)!; return m[2] === "#" ? [m[3]!] : []; });
    const oldComps = oldMarks.flatMap((t) => { const m = ATTACH.exec(t)!; return m[2] === "/" ? [m[3]!] : []; });
    const marks = [...Object.keys(comps).map((k) => attachTag(opts.builder, k)), ...(a?.tags ?? []).map((t) => attachTagOfTag(opts.builder, t))];
    let tags = e.tags.filter((t) => !oldMarks.includes(t) && !(oldTags.includes(t) && !(a?.tags ?? []).includes(t)));
    for (const t of [...(a?.tags ?? []), ...marks]) if (!tags.includes(t)) tags.push(t);
    if (tags.length === e.tags.length && tags.every((t) => e.tags.includes(t))) tags = e.tags;
    let changed = false;
    if (tags !== e.tags) { finalOps.push({ op: "set-tags", id, tags }); changed = true; }
    for (const [k, v] of Object.entries(comps)) if (JSON.stringify(v) !== JSON.stringify(e.components[k])) { finalOps.push({ op: "set-component", id, component: k, data: v }); changed = true; }
    for (const k of oldComps) if (!(k in comps) && k in e.components) { finalOps.push({ op: "remove-component", id, component: k }); changed = true; }
    if (changed) attachedChanged++;
  }

  // ---- id churn: ids that changed while the thing stayed where it was (counter ids) ----
  const removedIds = Object.keys(L).filter((id) => !(id in T)), addedIdsT = Object.keys(T).filter((id) => !(id in L));
  if (removedIds.length >= 5 && addedIdsT.length) {
    const spots = new Map<string, number>();
    const key = (e: EntityDoc) => { const p = posOf(e); return p ? `${prefabOf(e) ?? e.name}@${p.map((v) => v.toFixed(2)).join(",")}` : ""; };
    for (const id of addedIdsT) { const k = key(T[id]!); if (k) spots.set(k, (spots.get(k) ?? 0) + 1); }
    let churn = 0;
    for (const id of removedIds) { const k = key(L[id]!); const c = k ? spots.get(k) ?? 0 : 0; if (c > 0) { churn++; spots.set(k, c - 1); } }
    const owned = Object.keys(L).length;
    if (churn >= 5 && churn >= owned * 0.2) {
      const counterish = removedIds.filter((id) => /[-_]\d+$/.test(id)).length;
      warnings.push(
        `id churn: ${churn} of ${owned} entities keep their kind and place but change id` +
          (counterish > removedIds.length / 2 ? " (the old ids end in a running number)" : "") +
          ". Ids must come from what a thing is and its generator key (stableId), never a counter over the build. Expected once, when a builder first moves to stable ids.",
      );
    }
  }

  const count = (k: Op["op"]) => finalOps.filter((o) => o.op === k).length;
  const changedIds = new Set(finalOps.filter((o) => o.op !== "add-entity" && o.op !== "remove-entity").map((o) => (o as { id: string }).id));
  return {
    ops: finalOps,
    counts: {
      owned: Object.keys(L).length,
      target: Object.keys(T).length,
      add: count("add-entity"),
      remove: count("remove-entity"),
      change: changedIds.size,
      reparent: count("reparent"),
      unchanged: Object.keys(T).filter((id) => id in L && !changedIds.has(id)).length,
      adopted,
      claimed,
      attached: attachedChanged,
    },
    edits: { held, byPlace, deleted, restored, stale },
    warnings,
  };
}
