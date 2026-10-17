/**
 * The dev server's half of OWNER EDITS (packages/core dressing/owner.ts): the editor reports each owner edit of a
 * placed prop (before/after, scene frame); this finds what placed it and folds the edit into that owner's file —
 *
 *  - a dressed prop (tag `dress:<plan>`): `<plan file>.owner.json`, converted into the plan's map-local frame (the
 *    frame `dress apply` recorded in `<plan>.inverse.json`, else recovered from the plan's check report + the scene);
 *  - any other catalogued prop: `projects/<scene's project>/authoring/owner-overrides/<scene>.json`, scene frame.
 *
 * Node only (fs); imported by vite.config.ts (POST/GET /__hitreg/owner-edit) and by tests. Never writes a scene.
 */
import fs from "node:fs";
import path from "node:path";
import {
  entityOwnerState,
  inferApplyFrame,
  ownerOverridesSchema,
  rebaseOwnerOverrides,
  recordOwnerEdit,
  sceneToMap,
  type ApplyFrame,
  type OwnerOverrides,
  type OwnerTransform,
} from "../../../packages/core/src/dressing/owner.ts";

export interface OwnerEditRequest {
  scene: string;
  edits: {
    entity: string;
    tags?: string[];
    name?: string;
    parent?: string | null;
    before: OwnerTransform | null;
    after: OwnerTransform | null;
    note?: string;
  }[];
}

export interface OwnerEditResult {
  entity: string;
  file: string;
  owner: "plan" | "scene";
  plan?: string;
  item: string;
  reasons: string[];
  removed?: boolean;
}

const readJson = (f: string): unknown => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const idPart = (s: string): string => s.replace(/\//g, "--");
const projectsOf = (projectsRoot: string): string[] =>
  fs.existsSync(projectsRoot) ? fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

/** The project whose assets/scenes holds this scene, or null. */
export function sceneProject(projectsRoot: string, scene: string): string | null {
  for (const p of projectsOf(projectsRoot)) if (fs.existsSync(path.join(projectsRoot, p, "assets", "scenes", `${scene}.scene.json`))) return p;
  return null;
}

/** The plan file for a plan id: the scene's project first, then any project. */
export function findPlanFile(projectsRoot: string, planId: string, prefer: string | null): string | null {
  const order = [...(prefer ? [prefer] : []), ...projectsOf(projectsRoot).filter((p) => p !== prefer)];
  for (const p of order) {
    const f = path.join(projectsRoot, p, "authoring", "dressing", "plans", `${planId}.json`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const frameCache = new Map<string, ApplyFrame>();

/** How the plan was installed: recorded by `dress apply` (inverse `frame`), else recovered from its report + the scene. */
export function planFrame(planFile: string, sceneFile: string | null): ApplyFrame | null {
  const inv = planFile.replace(/\.json$/, ".inverse.json");
  if (fs.existsSync(inv)) {
    const f = (readJson(inv) as { frame?: ApplyFrame }).frame;
    if (f?.at) return f;
  }
  const cached = frameCache.get(planFile);
  if (cached) return cached;
  const report = planFile.replace(/\.json$/, ".report.json");
  if (!fs.existsSync(report) || !sceneFile || !fs.existsSync(sceneFile)) return null;
  const { plan: planId, placements } = readJson(report) as { plan: string; placements?: { id: string; position: [number, number, number]; yaw: number }[] };
  const scene = readJson(sceneFile) as { entities: Record<string, { tags?: string[]; components: Record<string, unknown> }> };
  const prefix = `dress-${idPart(planId)}-`;
  const pairs = [];
  for (const p of placements ?? []) {
    const e = scene.entities[prefix + idPart(p.id)];
    if (!e || (e.tags ?? []).includes("owner-fixed")) continue;
    const s = entityOwnerState(e as never);
    pairs.push({ local: p.position, localYaw: (p.yaw * 180) / Math.PI, scene: s.pos!, sceneYaw: s.yaw! });
  }
  const frame = inferApplyFrame(pairs);
  if (frame) frameCache.set(planFile, frame);
  return frame;
}

function loadOwnerFile(file: string, init: { plan?: string; scene?: string; frame: "map" | "scene" }): OwnerOverrides {
  if (fs.existsSync(file)) return ownerOverridesSchema.parse(readJson(file));
  return ownerOverridesSchema.parse({ version: 1, ...init, overrides: [] });
}

function writeOwnerFile(file: string, data: OwnerOverrides): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ownerOverridesSchema.parse(data); // never write an invalid file
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
}

/** The plan item a dressed entity stands for, and whether it is one the plan places at all. */
function dressedItem(planFile: string, planId: string, entity: string, name: string | undefined, ownerFile: OwnerOverrides): { item: string; planned: boolean } {
  const prefix = `dress-${idPart(planId)}-`;
  const known = ownerFile.overrides.find((o) => o.entity === entity);
  if (known) return { item: known.item, planned: false };
  const ids = new Set<string>();
  try {
    for (const i of (readJson(planFile) as { items?: { id: string }[] }).items ?? []) ids.add(i.id);
    const rep = planFile.replace(/\.json$/, ".report.json");
    if (fs.existsSync(rep)) for (const p of (readJson(rep) as { placements?: { id: string }[] }).placements ?? []) ids.add(p.id);
  } catch { /* unreadable plan: everything is owner-added */ }
  const fromName = name && name.includes(": ") ? name.slice(0, name.indexOf(": ")) : "";
  const fromId = entity.startsWith(prefix) ? entity.slice(prefix.length).replace(/--/g, "/") : "";
  for (const cand of [fromName, fromId]) if (cand && ids.has(cand) && entity === prefix + idPart(cand)) return { item: cand, planned: true };
  // a duplicate / an owner-dropped prop: an owner item named after its entity
  const own = fromId.startsWith("owner-") ? fromId : `owner-${(fromId || entity).replace(/[^a-z0-9._-]+/gi, "-")}`;
  return { item: own, planned: false };
}

/** Fold the editor's edits into the owners' files. */
export function recordOwnerEdits(projectsRoot: string, req: OwnerEditRequest, now = new Date().toISOString()): OwnerEditResult[] {
  const sceneProj = sceneProject(projectsRoot, req.scene);
  const sceneFile = sceneProj ? path.join(projectsRoot, sceneProj, "assets", "scenes", `${req.scene}.scene.json`) : null;
  const out: OwnerEditResult[] = [];
  for (const e of req.edits) {
    const planTag = (e.tags ?? []).find((t) => t.startsWith("dress:"));
    if (planTag) {
      const planId = planTag.slice("dress:".length);
      const planFile = findPlanFile(projectsRoot, planId, sceneProj);
      if (!planFile) throw new Error(`no plan file for ${planId}`);
      const frame = planFrame(planFile, sceneFile);
      if (!frame) throw new Error(`plan ${planId}: no install frame (re-run dress apply once so it records --at/--yaw)`);
      const file = planFile.replace(/\.json$/, ".owner.json");
      // the edits already kept move into this frame (exact: the scene positions do not change), and it is recorded
      const data = rebaseOwnerOverrides(loadOwnerFile(file, { plan: planId, frame: "map" }), frame);
      const { item, planned } = dressedItem(planFile, planId, e.entity, e.name, data);
      const roomM = e.parent?.match(new RegExp(`^dress-${idPart(planId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(room-(.+)|outdoor)$`));
      const next = recordOwnerEdit(
        data,
        {
          item,
          before: e.before ? sceneToMap(frame, e.before) : null,
          after: e.after ? sceneToMap(frame, e.after) : null,
          entity: e.entity,
          room: roomM ? (roomM[2] ?? "").replace(/--/g, "/") : "",
          ownerAdded: !planned,
          note: e.note,
        },
        now,
      );
      writeOwnerFile(file, next);
      const o = next.overrides.find((x) => x.item === item);
      out.push({ entity: e.entity, file, owner: "plan", plan: planId, item, reasons: o?.reasons ?? [], ...(o ? {} : { removed: true }) });
    } else {
      if (!sceneProj) throw new Error(`scene ${req.scene} is not in any project`);
      const file = path.join(projectsRoot, sceneProj, "authoring", "owner-overrides", `${req.scene}.json`);
      const data = loadOwnerFile(file, { scene: req.scene, frame: "scene" });
      const prev = data.overrides.find((o) => o.item === e.entity);
      const next = recordOwnerEdit(data, { item: e.entity, before: e.before, after: e.after, entity: e.entity, ownerAdded: prev ? prev.added : !e.before, note: e.note }, now);
      writeOwnerFile(file, next);
      const o = next.overrides.find((x) => x.item === e.entity);
      out.push({ entity: e.entity, file, owner: "scene", item: e.entity, reasons: o?.reasons ?? [], ...(o ? {} : { removed: true }) });
    }
  }
  return out;
}

/** What the prop panel shows for one entity: who placed it, the place's scale/cultures (swap filter), its override. */
export function ownerInfo(projectsRoot: string, scene: string, entity: string, tags: string[], name?: string) {
  const sceneProj = sceneProject(projectsRoot, scene);
  const planTag = tags.find((t) => t.startsWith("dress:"));
  if (planTag) {
    const planId = planTag.slice("dress:".length);
    const planFile = findPlanFile(projectsRoot, planId, sceneProj);
    if (!planFile) return { owner: "plan" as const, plan: planId, error: "no plan file" };
    const plan = readJson(planFile) as { space?: { scale?: string; cultures?: string[] }; rooms?: Record<string, { scale?: string; cultures?: string[]; role?: string }> };
    const file = planFile.replace(/\.json$/, ".owner.json");
    const data = loadOwnerFile(file, { plan: planId, frame: "map" });
    const { item, planned } = dressedItem(planFile, planId, entity, name, data);
    return {
      owner: "plan" as const,
      plan: planId,
      item,
      planned,
      file: path.relative(projectsRoot, file).replaceAll("\\", "/"),
      space: plan.space ?? {},
      rooms: plan.rooms ?? {},
      override: data.overrides.find((o) => o.item === item) ?? null,
    };
  }
  const file = sceneProj ? path.join(projectsRoot, sceneProj, "authoring", "owner-overrides", `${scene}.json`) : null;
  const data = file && fs.existsSync(file) ? ownerOverridesSchema.parse(readJson(file)) : null;
  return {
    owner: "scene" as const,
    item: entity,
    file: file ? path.relative(projectsRoot, file).replaceAll("\\", "/") : null,
    space: {},
    rooms: {},
    override: data?.overrides.find((o) => o.item === entity) ?? null,
  };
}

/** The props an owner may swap in (the project's dependsOn closure prop index), plus the real-size table. */
export function ownerCatalog(projectsRoot: string, project: string, kindSizesFile: string) {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (p: string): void => {
    if (seen.has(p)) return;
    seen.add(p);
    order.push(p);
    const pj = path.join(projectsRoot, p, "project.json");
    if (fs.existsSync(pj)) for (const d of ((readJson(pj) as { dependsOn?: string[] }).dependsOn ?? [])) visit(d);
  };
  visit(project);
  const props = new Map<string, Record<string, unknown>>();
  let kinds: Record<string, unknown> = fs.existsSync(kindSizesFile) ? ((readJson(kindSizesFile) as { kinds?: Record<string, unknown> }).kinds ?? {}) : {};
  for (const p of [...order].reverse()) {
    const idx = path.join(projectsRoot, p, "authoring", "dressing", "prop-index.json");
    if (fs.existsSync(idx)) for (const r of ((readJson(idx) as { props?: Record<string, unknown>[] }).props ?? [])) props.set(String(r["id"]), r);
    const cat = path.join(projectsRoot, p, "authoring", "prop-catalogs.json");
    if (fs.existsSync(cat)) {
      const extra = (readJson(cat) as { realSize?: { kinds?: Record<string, unknown> } }).realSize?.kinds ?? {};
      kinds = { ...kinds };
      for (const [k, v] of Object.entries(extra)) if (v === null) delete kinds[k]; else kinds[k] = { ...(kinds[k] as object), ...(v as object) };
    }
  }
  const pick = ["id", "mount", "size", "category", "scale", "cultures", "setting", "solid", "contact", "fire"];
  return {
    project,
    props: [...props.values()].filter((r) => r["ok"] !== false).map((r) => Object.fromEntries(pick.filter((k) => k in r).map((k) => [k, r[k]]))),
    kinds,
  };
}
