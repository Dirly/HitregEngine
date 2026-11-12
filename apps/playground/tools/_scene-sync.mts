/**
 * SCENE SYNC — builders and people on the same scene at once (pure logic: packages/core/src/scene-sync.ts).
 *
 *   syncScene({ scene, builder, target })   a generator's whole output -> ONE ops batch on the live file, only its
 *                                            `built:<builder>` entities, the edit record laid on top; no change = no write
 *   editScene({ scene, ops, by, note })      a deliberate edit of ANY entity (an agent answering a note): applied under
 *                                            the same lock and folded into the edit record, so a rebuild keeps it
 *   releaseEdits({ scene, ids })             drop records so the generator's own values come back on the next sync
 *
 * The edit record is `projects/<p>/authoring/owner-overrides/<scene>.json` (the same file the editor's owner edits go
 * to, tools/_owner-edit-bridge.mts); precedence owner > agent > generator (an agent edit of what the owner set needs `answers`). Writes go through
 * tools/_scene-write.mts (the lock, the removal guard, atomic write); the inverse of the last batch is saved to
 * `authoring/scene-sync/<scene>--<builder|edit>.inverse.json`, overwritten. Node only.
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyOps,
  builtTag,
  createScene,
  entityEditsOf,
  ownerConflicts,
  ownerHeld,
  ownerOverridesSchema,
  planSceneSync,
  targetFromOps,
  type ComponentRegistry,
  type EntityDoc,
  type Op,
  type OwnerOverrides,
  type SceneDoc,
  type SceneSyncOptions,
  type SceneSyncPlan,
} from "../../../packages/core/src/index.ts";
import { defaultRegistry } from "../../../packages/server/src/index.ts";
import { applyOpsToSceneFile, withFileLock, writeAtomic, writeJsonFile } from "./_scene-write.mts";
import { recordOwnerEdits, sceneEditRecordFile } from "./_owner-edit-bridge.mts";
import { declareActivity } from "./_agent-activity.mts";

export { builtTag, idCounter, stableId } from "../../../packages/core/src/index.ts";

interface SceneRef { file: string; name: string; projectsRoot: string | null; project: string | null }

/** The scene file, its name, and the project that holds it (walks up to project.json). */
export function sceneRef(file: string): SceneRef {
  const abs = path.resolve(file);
  const name = path.basename(abs).replace(/\.scene\.json$/, "");
  let dir = path.dirname(abs);
  while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, "project.json"))) dir = path.dirname(dir);
  const has = fs.existsSync(path.join(dir, "project.json"));
  return { file: abs, name, projectsRoot: has ? path.dirname(dir) : null, project: has ? path.basename(dir) : null };
}

const recordFileOf = (ref: SceneRef): string | null => (ref.projectsRoot && ref.project ? sceneEditRecordFile(ref.projectsRoot, ref.project, ref.name) : null);
const inverseFileOf = (ref: SceneRef, who: string): string =>
  ref.projectsRoot && ref.project
    ? path.join(ref.projectsRoot, ref.project, "authoring", "scene-sync", `${ref.name}--${who}.inverse.json`)
    : path.join(path.dirname(ref.file), `${ref.name}--${who}.inverse.json`);

function readRecord(file: string | null): OwnerOverrides | null {
  if (!file || !fs.existsSync(file)) return null;
  return ownerOverridesSchema.parse(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")));
}

const WRITE = { indent: 2, trailer: "\n" } as const;

export interface SyncSceneOptions {
  /** The live scene file (projects/<p>/assets/scenes/<name>.scene.json). Created empty when missing. */
  scene: string;
  /** This generator's name: its entities carry `built:<builder>`. One per script (build-scene, install-portals, …). */
  builder: string;
  /** What the builder generates: its add-entity ops (ids must be stable), or a doc. */
  target: Op[] | SceneDoc;
  registry?: ComponentRegistry;
  /** One-time move from a whole-file rewrite: untagged live entities this builder made (they are regenerated). */
  claim?: (id: string, e: EntityDoc) => boolean;
  /** Components / tags put on entities another builder (or nobody) generates; see SceneSyncOptions.attach. */
  attach?: SceneSyncOptions["attach"];
  dry?: boolean;
  /** Print the report (default true). */
  print?: boolean;
  matchRadius?: number;
}

export interface SyncReport extends SceneSyncPlan {
  file: string;
  builder: string;
  written: boolean;
  inverseFile: string | null;
  /** Records found by kind + place, re-keyed to the entity they matched. */
  rekeyed: number;
}

/** Bring the live scene's `built:<builder>` entities to `target`, under the scene lock, as one ops batch. */
export function syncScene(o: SyncSceneOptions): SyncReport {
  const ref = sceneRef(o.scene);
  const reg = o.registry ?? defaultRegistry();
  const target = Array.isArray(o.target) ? targetFromOps(ref.name, o.target as Op[], reg) : o.target;
  if (!fs.existsSync(ref.file)) {
    if (o.dry) throw new Error(`scene-sync: no scene at ${ref.file} (a dry run does not create it)`);
    writeJsonFile(ref.file, createScene(ref.name), { ...WRITE, label: `scene-sync ${o.builder}` });
  }
  let report!: SyncReport;
  // the owner's editor shows "agent working" for this scene while a real (not dry) sync runs
  const activity = o.dry ? { done() {} } : declareActivity({ scene: ref.name, what: `scene-sync ${o.builder}`, ttlMs: 300_000 });
  try {
  withFileLock(
    ref.file,
    () => {
      const live = JSON.parse(fs.readFileSync(ref.file, "utf8").replace(/^﻿/, "")) as SceneDoc;
      const plan = planSceneSync(live, target, { builder: o.builder, edits: readRecord(recordFileOf(ref)), claim: o.claim, matchRadius: o.matchRadius, registry: reg, attach: o.attach });
      report = { ...plan, file: ref.file, builder: o.builder, written: false, inverseFile: null, rekeyed: 0 };
      if (o.dry) return;
      // a record found by kind + place is re-keyed to the entity it matched (and this builder), so it matches by id
      // from now on, wherever the builder later moves that entity
      const rf = recordFileOf(ref);
      if (rf && plan.edits.byPlace.length)
        withFileLock(rf, () => {
          const data = readRecord(rf)!;
          const items = new Set(data.overrides.map((r) => r.item));
          for (const m of plan.edits.byPlace) {
            const r = data.overrides.find((x) => x.item === m.record);
            if (!r || items.has(m.entity)) continue;
            items.delete(r.item);
            r.item = m.entity;
            r.entity = m.entity;
            r.builder = o.builder;
            items.add(m.entity);
            report.rekeyed++;
          }
          if (report.rekeyed) writeAtomic(rf, JSON.stringify({ ...data, overrides: [...data.overrides].sort((a, b) => a.item.localeCompare(b.item)) }, null, 1) + "\n");
        });
      if (!plan.ops.length) return;
      const { inverse } = applyOpsToSceneFile(ref.file, plan.ops, (d, ops) => applyOps(d, ops, reg), { ...WRITE, label: `scene-sync ${o.builder}` });
      const inv = inverseFileOf(ref, o.builder);
      writeAtomic(inv, JSON.stringify({ scene: path.basename(ref.file), builder: o.builder, at: new Date().toISOString(), ops: inverse }) + "\n");
      report.written = true;
      report.inverseFile = inv;
    },
    { label: `scene-sync ${o.builder}` },
  );
  } finally {
    activity.done();
  }
  if (o.print !== false) printSyncReport(report, o.dry);
  return report;
}

/** One summary line, then warnings and every stale record. */
export function printSyncReport(r: SyncReport, dry = false): void {
  const c = r.counts, e = r.edits;
  const by = (who: string) => e.held.filter((h) => h.by === who).length;
  console.log(
    `scene-sync ${r.builder} -> ${path.basename(r.file)}: ${dry ? "DRY " : ""}${r.ops.length} op(s)${r.written ? "" : r.ops.length ? " (not written)" : " (no change, nothing written)"}; ` +
      `+${c.add} -${c.remove} ~${c.change} (reparent ${c.reparent}), ${c.unchanged} unchanged of ${c.target}` +
      `${c.adopted ? `, adopted ${c.adopted}` : ""}${c.claimed ? `, claimed ${c.claimed}` : ""}${c.attached ? `, attached to ${c.attached}` : ""}; ` +
      `edits kept ${e.held.length} (owner ${by("owner")}, agent ${by("agent")}), deleted ${e.deleted.length}, restored ${e.restored.length}, matched by place ${e.byPlace.length}${r.rekeyed ? ` (re-keyed ${r.rekeyed})` : ""}, stale ${e.stale.length}`,
  );
  for (const w of r.warnings) console.log(`  WARNING ${w}`);
  for (const s of e.stale) console.log(`  STALE edit ${s.record}: ${s.why}`);
}

export interface EditSceneOptions {
  scene: string;
  ops: Op[];
  /** Who decided it. An agent answering the owner's note is "agent" (the default). */
  by?: "owner" | "agent";
  /** Why (kept on the record). */
  note?: string;
  /**
   * PRECEDENCE is owner > agent > generator. An agent edit that changes a property the OWNER set (his move, his light
   * colour, his delete…) is REFUSED unless it names what it answers: the id of his note, or his words. With it,
   * the edit applies and every owner property it overrides is reported and recorded (`overrodeOwner`).
   */
  answers?: string;
  registry?: ComponentRegistry;
  print?: boolean;
}

export interface EditSceneResult {
  inverse: Op[];
  recorded: number;
  inverseFile: string;
  /** Owner-held properties this edit overrode on purpose (entity -> properties). */
  overrodeOwner: { entity: string; props: string[] }[];
}

/** Owner-held properties an agent's edits would change, per entity. */
function ownerConflictsOf(record: OwnerOverrides | null, edits: ReturnType<typeof entityEditsOf>): { entity: string; props: string[]; at: string }[] {
  const out: { entity: string; props: string[]; at: string }[] = [];
  for (const e of edits) {
    const r = record?.overrides.find((x) => (x.entity ?? x.item) === e.entity || x.item === e.entity);
    const props = ownerConflicts(r, e.before, e.after);
    if (props.length) out.push({ entity: e.entity, props, at: r?.at ?? "" });
  }
  return out;
}

/**
 * A deliberate edit of ANY entity (builder-made, hand-added, anything): applied to the live file under its lock, then
 * recorded, so the next regeneration keeps it. An agent edit of what the owner set needs `answers` (see above).
 */
export function editScene(o: EditSceneOptions): EditSceneResult {
  const ref = sceneRef(o.scene);
  if (!ref.projectsRoot) throw new Error(`editScene: ${ref.file} is not inside a project (no project.json above it): there is no edit record to keep the edit in`);
  const reg = o.registry ?? defaultRegistry();
  const by = o.by ?? "agent";
  const activity = declareActivity({ scene: ref.name, what: `editScene (${by})${o.answers ? `: ${o.answers}` : ""}`, ttlMs: 120_000 });
  let out!: EditSceneResult;
  try {
    withFileLock(
      ref.file,
      () => {
        const live = JSON.parse(fs.readFileSync(ref.file, "utf8").replace(/^﻿/, "")) as SceneDoc;
        const dry = applyOps(live, o.ops, reg); // validates; nothing written yet
        const edits = entityEditsOf(live, dry.doc, [...dry.changedEntities, ...dry.addedEntities, ...dry.removedEntities], o.note ?? o.answers);
        const conflicts = by === "agent" ? ownerConflictsOf(readRecord(recordFileOf(ref)), edits) : [];
        const list = conflicts.map((c) => `${c.entity}: ${c.props.join(", ")}${c.at ? ` (owner, ${c.at})` : ""}`);
        if (conflicts.length && !o.answers)
          throw new Error(`editScene REFUSED (nothing written): it changes what the owner set by hand: ${list.join("; ")}. Owner > agent: pass answers: "<his note id or words>" only when he asked for this.`);
        for (const e of edits) e.overrideOwner = conflicts.find((c) => c.entity === e.entity)?.props;
        const res = applyOpsToSceneFile(ref.file, o.ops, (d, ops) => applyOps(d, ops, reg), { ...WRITE, label: `editScene (${by})` });
        if (edits.length) recordOwnerEdits(ref.projectsRoot!, { scene: ref.name, edits }, new Date().toISOString(), by);
        const inv = inverseFileOf(ref, "edit");
        writeAtomic(inv, JSON.stringify({ scene: path.basename(ref.file), by, note: o.note ?? "", answers: o.answers ?? "", at: new Date().toISOString(), ops: res.inverse }) + "\n");
        out = { inverse: res.inverse, recorded: edits.length, inverseFile: inv, overrodeOwner: conflicts.map((c) => ({ entity: c.entity, props: c.props })) };
        if (o.print !== false && conflicts.length) console.log(`editScene: OVERRODE the owner's own edits, answering "${o.answers}": ${list.join("; ")}`);
      },
      { label: `editScene (${by})` },
    );
  } finally {
    activity.done();
  }
  return out;
}

/**
 * Drop the edit records of these entities: the generator's own values return on its next sync. A record that holds
 * what the OWNER set is refused unless `answers` names his note (owner > agent > generator). Returns how many.
 */
export function releaseEdits(o: { scene: string; ids: string[]; answers?: string }): number {
  const ref = sceneRef(o.scene);
  const file = recordFileOf(ref);
  if (!file || !fs.existsSync(file)) return 0;
  let dropped = 0;
  withFileLock(file, () => {
    const data = readRecord(file)!;
    const hit = (r: OwnerOverrides["overrides"][number]) => o.ids.includes(r.entity ?? r.item) || o.ids.includes(r.item);
    const owned = data.overrides.filter((r) => hit(r) && ownerHeld(r).length);
    if (owned.length && !o.answers) throw new Error(`releaseEdits REFUSED: the owner set ${owned.map((r) => `${r.item} (${ownerHeld(r).join(", ")})`).join("; ")} by hand; pass answers: "<his note id or words>" only when he asked for it`);
    const keep = data.overrides.filter((r) => !hit(r));
    dropped = data.overrides.length - keep.length;
    if (dropped) writeAtomic(file, JSON.stringify({ ...data, overrides: keep }, null, 1) + "\n");
  });
  return dropped;
}
