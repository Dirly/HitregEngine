import { z } from "zod";

/**
 * OWNER OVERRIDES — the owner's hand edits to placed props, kept so no re-install undoes them.
 *
 * Agents place loose props by NAME through dressing plans (`dress apply`) and installers place fixtures through
 * ops. When the owner moves, turns, scales, swaps, deletes, duplicates or adds a prop in the editor, the scene
 * changes through an ops batch as always, AND the change is written here, on the thing that placed it:
 *
 *  - a dressed prop (tag `dress:<plan>`) -> `<plan file>.owner.json` beside the plan, in the PLAN's frame (map-local
 *    metres, yaw in degrees), so a plan re-applied at another `--at` keeps the edit where the owner put it;
 *  - any other catalogued prop in a scene (an installer's lantern or brazier) -> `authoring/owner-overrides/<scene>.json`
 *    of the scene's project, in the scene frame (the entity's parent frame), keyed by entity id.
 *
 * Why a sibling file and not a field of the plan: dressers rewrite whole plans, and `dress fixtures` writes them;
 * a file only the owner writes cannot be clobbered by either, and the plan's check hash stays the dresser's.
 *
 * `dress apply` (and every re-dress) resolves the plan, then applies these LAST; `dress check` honours them (an
 * owner-deleted item is never re-added, an owner-moved one never moved); `dress manifest` prints them as fixed for the
 * next dresser; `dress overrides` lists them by reason class — the learning signal (floating, moved, swapped, deleted).
 * Zod-only, pure: no fs, no DOM.
 */

const xyz = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

export const ownerTransformSchema = z
  .object({
    pos: xyz.optional().describe("Where the prop's ORIGIN goes: the plan's map-local metres (plan file) or the scene frame (scene file)."),
    yaw: z.number().finite().optional().describe("Degrees about +Y the prop faces, in the same frame."),
    scale: z.number().positive().optional().describe("Uniform scale of the placed instance (1 = as catalogued)."),
    prop: z.string().min(1).optional().describe("Prefab id: set = swapped for this catalogue prop."),
    rot: z
      .tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
      .optional()
      .describe("Full rotation quaternion [x,y,z,w], present only when the entity is tilted (not turned about +Y alone); it wins over `yaw` when applied."),
    scale3: xyz.optional().describe("Non-uniform scale [x,y,z], present only when the axes differ; it wins over `scale` when applied."),
    components: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Other components as whole data (light, collider, vfx, script…). Under `set`: only the components the owner changed (each held whole). " +
          "Under `from`: the entity's components when the owner first touched it. Owner-added entities keep all of theirs here.",
      ),
  })
  .describe("An entity's state as the owner left it (or as the agent had placed it, under `from`): transform, prefab and, for any entity, its other components.");
export type OwnerTransform = z.infer<typeof ownerTransformSchema>;

export const OWNER_REASONS = ["floating", "sunk", "moved", "rotated", "scaled", "swapped", "edited", "deleted", "added"] as const;
export type OwnerReason = (typeof OWNER_REASONS)[number];

export const ownerOverrideSchema = z
  .object({
    item: z
      .string()
      .min(1)
      .describe("Plan file: the plan item / placement id (`<item>/<member>` for a set member; `owner-…` for an owner-added prop). Scene file: the entity id."),
    set: ownerTransformSchema.default({}).describe("The owner's values; omitted fields keep what the plan/installer resolves."),
    deleted: z.boolean().default(false).describe("The owner deleted it: never re-added by any re-apply."),
    added: z.boolean().default(false).describe("Placed by the owner (not from the plan / installer): `set.prop` and `set.pos` are required."),
    entity: z.string().optional().describe("Scene entity id an owner-added prop is installed under (kept so the editor's id survives a re-apply)."),
    room: z.string().optional().describe("Plan file, owner-added: the map room it belongs to (its culling group); \"\" or omitted = outdoors."),
    from: ownerTransformSchema.optional().describe("What the agent had placed before the owner's first edit: the learning signal compares the two."),
    reasons: z.array(z.enum(OWNER_REASONS)).default([]).describe("Reason classes (ownerReasons): floating = moved down, sunk = moved up, moved, rotated, scaled, swapped, edited (a component other than transform/prefab), deleted, added."),
    ownerProps: z
      .array(z.string())
      .optional()
      .describe(
        "Scene file: the properties the OWNER set and still holds (pos, rot, scale, prop, component:<name>; `*` = the whole entity: he added or deleted it). " +
          "Precedence is owner > agent > generator: an agent edit touching one of these is refused unless it names the note it answers (editScene `answers`).",
      ),
    overrodeOwner: z
      .array(z.string())
      .optional()
      .describe("Scene file: owner-held properties the latest AGENT edit overrode on purpose, answering `note`. The owner's next edit of the entity wins again."),
    builder: z
      .string()
      .optional()
      .describe("Scene file: the builder that owned the entity at the first edit (its `built:<builder>` tag). Only that builder's scene-sync applies it; none = any builder may match it."),
    name: z.string().optional().describe("Scene file: the entity's name at the first edit (matching a non-prop entity by kind + place when its id changed)."),
    kind: z.array(z.string()).optional().describe("Scene file: the entity's component names at the first edit (sorted): its kind when it has no prefab."),
    parent: z.string().nullable().optional().describe("Scene file, owner-added: the parent entity the owner put it under."),
    tags: z.array(z.string()).optional().describe("Scene file, owner-added: the entity's tags (re-added with them)."),
    by: z.string().default("owner"),
    at: z.string().default("").describe("ISO time of the last edit."),
    note: z.string().default("").describe("Why, in the owner's words, when given."),
  })
  .superRefine((o, ctx) => {
    if (o.added && !o.deleted && (!o.set.pos || (!o.set.prop && !o.set.components)))
      ctx.addIssue({ code: "custom", path: ["set"], message: "an owner-added entity needs set.pos and set.prop (a prop) or set.components (anything else)" });
  });
export type OwnerOverride = z.infer<typeof ownerOverrideSchema>;

export const ownerOverridesSchema = z
  .object({
    version: z.literal(1).default(1),
    plan: z.string().optional().describe("The dressing plan these edits sit on (`<plan>.owner.json`)."),
    scene: z.string().optional().describe("The scene these edits sit on (`authoring/owner-overrides/<scene>.json`): installer-placed props."),
    frame: z
      .enum(["map", "scene"])
      .default("map")
      .describe("`map`: positions in the plan's map-local frame (apply adds --at/--yaw). `scene`: positions in the entity's parent frame, applied as they are."),
    installed: z
      .object({ at: xyz, yaw: z.number().finite() })
      .optional()
      .describe("Plan files: the install frame (--at, --yaw degrees) the editor converted the owner's edits with. A re-apply with another frame re-bases them first (rebaseOwnerOverrides), so they stay where the owner put them in the scene."),
    overrides: z.array(ownerOverrideSchema).default([]),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.overrides.forEach((o, i) => {
      if (seen.has(o.item)) ctx.addIssue({ code: "custom", path: ["overrides", i, "item"], message: `duplicate item "${o.item}"` });
      seen.add(o.item);
    });
    if (!f.plan === !f.scene) ctx.addIssue({ code: "custom", path: ["plan"], message: "give exactly one of `plan` or `scene`" });
  })
  .describe(
    "The owner's hand edits to placed props (move, turn, scale, swap, delete, add), kept beside what placed them and applied LAST by every re-apply " +
      "(`dress apply`, installers via `dress owner-apply`). Written by the editor, never by agents; agents read them as fixed (`dress overrides`).",
  );
export type OwnerOverrides = z.infer<typeof ownerOverridesSchema>;
export type OwnerOverridesInput = z.input<typeof ownerOverridesSchema>;

// ---- reason classes ---------------------------------------------------------

/** Metres a move must exceed to count; degrees a turn must exceed; scale ratio. */
const MOVE_EPS = 0.03;
const YAW_EPS = 1;
const SCALE_EPS = 0.01;
const angleDiff = (a: number, b: number): number => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/**
 * The reason classes of one edit. `floating`: moved DOWN (the agent left it in the air); `sunk`: moved up; `moved`:
 * moved sideways. A missing `from` (nothing to compare) yields only the explicit classes.
 */
export function ownerReasons(o: { set: OwnerTransform; from?: OwnerTransform; deleted?: boolean; added?: boolean }): OwnerReason[] {
  if (o.added) return ["added"];
  if (o.deleted) return ["deleted"];
  const out: OwnerReason[] = [];
  const f = o.from, s = o.set;
  if (s.prop && f?.prop && s.prop !== f.prop) out.push("swapped");
  if (s.pos && f?.pos) {
    const dy = s.pos[1] - f.pos[1];
    if (dy < -MOVE_EPS) out.push("floating");
    else if (dy > MOVE_EPS) out.push("sunk");
    if (Math.hypot(s.pos[0] - f.pos[0], s.pos[2] - f.pos[2]) > MOVE_EPS) out.push("moved");
  }
  if ((s.yaw !== undefined && f?.yaw !== undefined && angleDiff(s.yaw, f.yaw) > YAW_EPS) || (f && !sameRot(s.rot, f.rot, 0.0005))) out.push("rotated");
  if ((s.scale !== undefined && Math.abs(s.scale - (f?.scale ?? 1)) > SCALE_EPS) || (s.scale3 && f && !sameXyz(s.scale3, f.scale3 ?? [f.scale ?? 1, f.scale ?? 1, f.scale ?? 1], SCALE_EPS)))
    out.push("scaled");
  if (s.components && Object.keys(s.components).some((k) => !sameJson(s.components![k], f?.components?.[k]))) out.push("edited");
  return out;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameXyz = (a: readonly number[] | undefined, b: readonly number[] | undefined, eps: number): boolean =>
  !a || !b ? !a === !b : a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= eps);
/** Same rotation (q and -q are the same turn); both absent = same; one absent = the other must be a pure yaw, so different. */
function sameRot(a: readonly number[] | undefined, b: readonly number[] | undefined, eps: number): boolean {
  if (!a || !b) return !a === !b;
  const dot = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!);
  return dot >= 1 - eps;
}
/** Same component set and data; undefined and {} are the same. */
function sameComponents(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in (b ?? {}) && sameJson(a![k], b![k]));
}

/** True when `set` is the same state as `from` (an edit undone back to what the agent placed). */
export function sameOwnerTransform(a: OwnerTransform, b: OwnerTransform | undefined): boolean {
  if (!b) return false;
  if ((a.prop ?? b.prop) !== (b.prop ?? a.prop)) return false;
  if (a.pos && b.pos && a.pos.some((v, i) => Math.abs(v - b.pos![i]!) > 0.005)) return false;
  if (a.yaw !== undefined && b.yaw !== undefined && angleDiff(a.yaw, b.yaw) > 0.25) return false;
  if (Math.abs((a.scale ?? 1) - (b.scale ?? 1)) > 0.001) return false;
  if ((a.rot || b.rot) && !sameRot(a.rot, b.rot, 1e-5)) return false;
  if ((a.scale3 || b.scale3) && !sameXyz(a.scale3, b.scale3, 0.001)) return false;
  // components are compared only when both sides carry them (a prop-only state never says anything about lights)
  if (a.components !== undefined && b.components !== undefined && !sameComponents(a.components, b.components)) return false;
  return true;
}

// ---- recording an edit --------------------------------------------------------

/** One edit as the editor saw it: the state before and after (null = did not exist / removed). */
export interface OwnerEdit {
  item: string;
  before: OwnerTransform | null;
  after: OwnerTransform | null;
  /** Scene entity id (owner-added props keep it). */
  entity?: string;
  room?: string;
  /** True when the item is not the plan's / installer's own (a duplicate, a prop dropped in by the owner). */
  ownerAdded?: boolean;
  note?: string;
  /** Scene file: the entity's `built:<builder>` owner, its name, component kinds (sorted), and (owner-added) parent + tags. */
  builder?: string;
  name?: string;
  kind?: string[];
  parent?: string | null;
  tags?: string[];
  /** An agent edit: the owner-held properties it overrides on purpose (ownerConflicts), answering `note`. */
  overrideOwner?: string[];
}

// ---- precedence: owner > agent > generator ------------------------------------------------------

/** The properties two states differ in: pos, rot, scale, prop, component:<name>; `*` when one side does not exist. */
export function changedProps(before: OwnerTransform | null | undefined, after: OwnerTransform | null | undefined): string[] {
  if (!before || !after) return before === after ? [] : ["*"];
  const out: string[] = [];
  if (before.pos && after.pos && before.pos.some((v, i) => Math.abs(v - after.pos![i]!) > 0.005)) out.push("pos");
  if ((before.yaw !== undefined && after.yaw !== undefined && angleDiff(before.yaw, after.yaw) > 0.25) || ((before.rot || after.rot) && !sameRot(before.rot, after.rot, 1e-5))) out.push("rot");
  if (Math.abs((before.scale ?? 1) - (after.scale ?? 1)) > 0.001 || ((before.scale3 || after.scale3) && !sameXyz(before.scale3, after.scale3, 0.001))) out.push("scale");
  if ((before.prop ?? "") !== (after.prop ?? "") && after.prop !== undefined) out.push("prop");
  if (before.components && after.components)
    for (const k of new Set([...Object.keys(before.components), ...Object.keys(after.components)])) if (!sameJson(before.components[k], after.components[k])) out.push(`component:${k}`);
  return out;
}

/** What a record changes relative to what was there (`from`), as property names. */
export function recordProps(o: Pick<OwnerOverride, "set" | "from" | "added" | "deleted">): string[] {
  if (o.added || o.deleted) return ["*"];
  const s = o.set, f = o.from;
  if (!f) return [...(s.pos ? ["pos"] : []), ...(s.yaw !== undefined || s.rot ? ["rot"] : []), ...(s.scale !== undefined || s.scale3 ? ["scale"] : []), ...(s.prop ? ["prop"] : []), ...Object.keys(s.components ?? {}).map((k) => `component:${k}`)];
  const props = changedProps(f, { ...f, ...s, components: f.components ? { ...f.components, ...s.components } : undefined });
  for (const k of Object.keys(s.components ?? {})) if (!props.includes(`component:${k}`) && !sameJson(s.components![k], f.components?.[k])) props.push(`component:${k}`);
  return props;
}

/** The properties the owner holds on a record (records made before `ownerProps` existed: everything an owner record changes). */
export function ownerHeld(o: OwnerOverride | undefined): string[] {
  if (!o) return [];
  return o.ownerProps ?? (o.by === "owner" ? recordProps(o) : []);
}

/** The owner-held properties an edit (before -> after) would change: an agent may change them only on purpose. */
export function ownerConflicts(o: OwnerOverride | undefined, before: OwnerTransform | null, after: OwnerTransform | null): string[] {
  const held = ownerHeld(o);
  if (!held.length) return [];
  const changed = changedProps(before, after);
  if (!changed.length) return [];
  if (held.includes("*") || changed.includes("*")) return held;
  return held.filter((p) => changed.includes(p));
}

/**
 * Fold one edit into an overrides file, immutably. The FIRST edit of an item records `from` (what the agent placed);
 * later edits keep it, so the learning signal compares the owner's final state with the agent's, whatever the steps.
 * An edit that returns an item to its `from` state (an undo) removes the override; deleting an owner-added prop
 * removes it; restoring a deleted one (undo) clears `deleted`.
 */
export function recordOwnerEdit(file: OwnerOverrides, edit: OwnerEdit, at = new Date().toISOString(), by = "owner"): OwnerOverrides {
  const overrides = file.overrides.filter((o) => o.item !== edit.item);
  const prev = file.overrides.find((o) => o.item === edit.item);
  const added = prev?.added ?? edit.ownerAdded ?? false;
  const from = prev?.from ?? (added ? undefined : edit.before ?? undefined);
  let next: OwnerOverride | null;
  if (!edit.after) {
    next = added ? null : { item: edit.item, set: {}, deleted: true, added: false, from, reasons: [], by, at, note: edit.note ?? prev?.note ?? "" };
  } else if (!added && sameOwnerTransform(edit.after, from)) {
    next = null; // back to what the agent placed
  } else {
    next = {
      item: edit.item,
      set: { ...edit.after },
      deleted: false,
      added,
      ...(added && (edit.entity ?? prev?.entity) ? { entity: edit.entity ?? prev?.entity } : {}),
      ...(added && (edit.room ?? prev?.room) !== undefined ? { room: edit.room ?? prev?.room } : {}),
      from,
      reasons: [],
      by,
      at,
      note: edit.note ?? prev?.note ?? "",
    };
  }
  if (next) {
    // components: the owner holds only those he changed (each whole); an owner-added entity keeps all of its own
    if (!added && next.set.components) {
      const kept = Object.fromEntries(Object.entries(next.set.components).filter(([k, v]) => !sameJson(v, from?.components?.[k])));
      if (Object.keys(kept).length) next.set.components = kept;
      else delete next.set.components;
    }
    // what identifies the entity when its id changes (scene-sync matches by kind + place), kept from the first edit
    const keep = {
      builder: prev?.builder ?? edit.builder,
      name: prev?.name ?? edit.name,
      kind: prev?.kind ?? edit.kind,
      ...(added ? { parent: edit.parent !== undefined ? edit.parent : prev?.parent, tags: edit.tags ?? prev?.tags } : {}),
    };
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    // precedence: the owner holds what he set (his newest edit wins again); an agent edit keeps his holdings except the
    // ones it overrode on purpose (`overrideOwner`, answering `note`)
    if (by === "owner") next.ownerProps = recordProps(next);
    else {
      const over = edit.overrideOwner ?? [];
      const held = ownerHeld(prev).filter((p) => !over.includes(p) && !over.includes("*"));
      if (held.length) next.ownerProps = held;
      if (over.length) next.overrodeOwner = over;
    }
    next.reasons = ownerReasons(next);
    if (!next.from) delete next.from;
    overrides.push(next);
  }
  overrides.sort((a, b) => a.item.localeCompare(b.item));
  return { ...file, overrides };
}

// ---- applying to resolved placements ------------------------------------------------

/** A placement as the resolver (or an installer) produced it; yaw RADIANS, position the prefab origin. */
export interface OwnedPlacement {
  id: string;
  prop: string;
  room: string;
  level?: number;
  position: [number, number, number];
  yaw: number;
  scale?: [number, number, number];
}

export interface OwnerApplyResult<P extends OwnedPlacement> {
  placements: (P & { owner?: true })[];
  /** Ids the owner fixed (moved/turned/scaled/swapped or added): no seat, no re-placement. */
  fixed: Set<string>;
  deleted: string[];
  added: string[];
  /** Overrides naming an item the plan no longer has (kept, reported). */
  stale: string[];
}

const DEG = Math.PI / 180;

/**
 * Plan, then owner: deleted items are dropped, edited ones take the owner's values, owner-added ones are appended.
 * Idempotent (the input placements are what the plan resolves, never the previous scene), deterministic, and the
 * order of the plan's placements is kept so entity ids and inverse batches stay stable.
 */
export function applyOwnerOverrides<P extends OwnedPlacement>(
  placements: readonly P[],
  file: OwnerOverrides | null | undefined,
  /** Item id -> the item it stands ON (plan `on` places): a dependent follows its host's move and goes with its delete. */
  hostOf?: ReadonlyMap<string, string>,
): OwnerApplyResult<P> {
  const fixed = new Set<string>();
  const deleted: string[] = [];
  const added: string[] = [];
  const stale: string[] = [];
  if (!file || !file.overrides.length) return { placements: [...placements], fixed, deleted, added, stale };
  const by = new Map(file.overrides.map((o) => [o.item, o]));
  const out: (P & { owner?: true })[] = [];
  const seen = new Set<string>();
  for (const p of placements) {
    const o = by.get(p.id);
    if (!o || o.added) {
      out.push(p);
      continue;
    }
    seen.add(p.id);
    if (o.deleted) {
      deleted.push(p.id);
      continue;
    }
    const s = o.set;
    fixed.add(p.id);
    out.push({
      ...p,
      prop: s.prop ?? p.prop,
      position: s.pos ? [...s.pos] : p.position,
      yaw: s.yaw !== undefined ? s.yaw * DEG : p.yaw,
      ...(s.scale !== undefined ? { scale: [s.scale, s.scale, s.scale] } : {}),
      owner: true,
    });
  }
  // what stands ON an owner-moved host moves with it (rigidly, in the plan frame); on a deleted host it goes too
  if (hostOf?.size) {
    const before = new Map(placements.map((p) => [p.id, p]));
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let i = 0; i < out.length; i++) {
        const p = out[i]!;
        const host = hostOf.get(p.id);
        if (!host || by.has(p.id) || p.owner) continue;
        if (deleted.includes(host)) {
          deleted.push(p.id);
          out.splice(i--, 1);
          changed = true;
          continue;
        }
        const now = out.find((q) => q.id === host), was = before.get(host);
        if (!now?.owner || !was) continue;
        const dy = now.yaw - was.yaw, c = Math.cos(dy), sn = Math.sin(dy);
        const rx = p.position[0] - was.position[0], rz = p.position[2] - was.position[2];
        out[i] = {
          ...p,
          position: [now.position[0] + rx * c + rz * sn, now.position[1] + (p.position[1] - was.position[1]), now.position[2] - rx * sn + rz * c],
          yaw: p.yaw + dy,
          owner: true,
        };
        fixed.add(p.id);
        changed = true;
      }
      if (!changed) break;
    }
  }
  for (const o of file.overrides) {
    if (o.added) {
      if (o.deleted) continue;
      fixed.add(o.item);
      added.push(o.item);
      out.push({
        id: o.item,
        prop: o.set.prop!,
        room: o.room ?? "",
        level: 0,
        position: [...o.set.pos!],
        yaw: (o.set.yaw ?? 0) * DEG,
        ...(o.set.scale !== undefined ? { scale: [o.set.scale, o.set.scale, o.set.scale] } : {}),
        owner: true,
      } as unknown as P & { owner: true });
    } else if (!seen.has(o.item)) {
      // a deleted item the plan no longer places is still deleted (dress takes it out before resolving)
      if (o.deleted) deleted.push(o.item);
      else stale.push(o.item);
    }
  }
  return { placements: out, fixed, deleted, added, stale };
}

// ---- frames ------------------------------------------------------------------

/** How a plan was installed: `--at` and `--yaw` (degrees). Scene = at + R(yaw) · map-local. */
export interface ApplyFrame {
  at: [number, number, number];
  yaw: number;
}

/** Map-local -> scene (the entity's parent frame), as `dress apply` computes it. */
export function mapToScene(frame: ApplyFrame, t: OwnerTransform): OwnerTransform {
  const y0 = frame.yaw * DEG, c = Math.cos(y0), s = Math.sin(y0);
  const out: OwnerTransform = { ...t };
  if (t.pos) {
    const [lx, ly, lz] = t.pos;
    out.pos = [frame.at[0] + lx * c + lz * s, frame.at[1] + ly, frame.at[2] - lx * s + lz * c];
  }
  if (t.yaw !== undefined) out.yaw = t.yaw + frame.yaw;
  if (t.rot) out.rot = yawTimes(frame.yaw, t.rot);
  return out;
}

/** The quaternion of a turn by `deg` about +Y, times q (the turn applied after q). */
function yawTimes(deg: number, q: readonly number[]): [number, number, number, number] {
  const h = (deg * DEG) / 2, s = Math.sin(h), c = Math.cos(h);
  const [x, y, z, w] = q as [number, number, number, number];
  return [c * x + s * z, c * y + s * w, c * z - s * x, c * w - s * y].map((v) => +v.toFixed(6)) as [number, number, number, number];
}

/** Scene -> map-local: the inverse of mapToScene. */
export function sceneToMap(frame: ApplyFrame, t: OwnerTransform): OwnerTransform {
  const y0 = frame.yaw * DEG, c = Math.cos(y0), s = Math.sin(y0);
  const out: OwnerTransform = { ...t };
  if (t.pos) {
    const dx = t.pos[0] - frame.at[0], dz = t.pos[2] - frame.at[2];
    out.pos = [dx * c - dz * s, t.pos[1] - frame.at[1], dx * s + dz * c].map((v) => +v.toFixed(4)) as [number, number, number];
  }
  if (t.yaw !== undefined) out.yaw = +((((t.yaw - frame.yaw) % 360) + 540) % 360 - 180).toFixed(3);
  if (t.rot) out.rot = yawTimes(-frame.yaw, t.rot);
  return out;
}

/**
 * The frame a plan was installed with, recovered from pairs of (map-local placement, scene transform) when the
 * install did not record it (installs before owner overrides existed). Yaw from the displacement between the two
 * farthest-apart pairs (or from one pair's facing), at from the median offset. Null with no pairs.
 */
export function inferApplyFrame(pairs: readonly { local: [number, number, number]; localYaw: number; scene: [number, number, number]; sceneYaw: number }[]): ApplyFrame | null {
  if (!pairs.length) return null;
  let yawDeg: number;
  let best: [number, number] | null = null, bestD = 0;
  for (let i = 0; i < pairs.length; i++)
    for (let j = i + 1; j < Math.min(pairs.length, i + 40); j++) {
      const a = pairs[i]!, b = pairs[j]!;
      const d = Math.hypot(a.local[0] - b.local[0], a.local[2] - b.local[2]);
      if (d > bestD) { bestD = d; best = [i, j]; }
    }
  if (best && bestD > 0.5) {
    const a = pairs[best[0]]!, b = pairs[best[1]]!;
    // scene = R·local with R(x,z) = (x c + z s, -x s + z c): a rotation by -yaw in atan2(z, x) terms
    const angL = Math.atan2(b.local[2] - a.local[2], b.local[0] - a.local[0]);
    const angS = Math.atan2(b.scene[2] - a.scene[2], b.scene[0] - a.scene[0]);
    yawDeg = (angL - angS) / DEG;
  } else yawDeg = (pairs[0]!.sceneYaw - pairs[0]!.localYaw);
  yawDeg = Math.round(((((yawDeg % 360) + 540) % 360) - 180) * 1000) / 1000;
  const y0 = yawDeg * DEG, c = Math.cos(y0), s = Math.sin(y0);
  const med = (v: number[]): number => { const t = [...v].sort((p, q) => p - q); return t[Math.floor(t.length / 2)]!; };
  const at: [number, number, number] = [
    med(pairs.map((p) => p.scene[0] - (p.local[0] * c + p.local[2] * s))),
    med(pairs.map((p) => p.scene[1] - p.local[1])),
    med(pairs.map((p) => p.scene[2] - (-p.local[0] * s + p.local[2] * c))),
  ].map((v) => Math.round(v * 1000) / 1000) as [number, number, number];
  return { at, yaw: yawDeg };
}

/**
 * Re-express a plan file's edits in another install frame (`installed` -> `to`): the scene positions do not move.
 * Exact whatever frame the edits were recorded with, so an inferred frame (an install that recorded none) costs nothing
 * as long as the plan is re-applied where it was. No-op when the frames agree or the file records none.
 */
export function rebaseOwnerOverrides(file: OwnerOverrides, to: ApplyFrame): OwnerOverrides {
  const from = file.installed;
  if (!from || (from.yaw === to.yaw && from.at.every((v, i) => Math.abs(v - to.at[i]!) < 1e-6))) return { ...file, installed: { at: [...to.at], yaw: to.yaw } };
  const re = (t: OwnerTransform | undefined): OwnerTransform | undefined => (t ? sceneToMap(to, mapToScene(from, t)) : t);
  return {
    ...file,
    installed: { at: [...to.at], yaw: to.yaw },
    overrides: file.overrides.map((o) => ({ ...o, set: re(o.set)!, ...(o.from ? { from: re(o.from) } : {}) })),
  };
}

// ---- scene-level overrides (installer-placed props) ---------------------------------------

interface SceneEntityLike {
  parent: string | null;
  name?: string;
  tags?: string[];
  components: Record<string, unknown>;
}

const yawOfQuat = (q: readonly number[] | undefined): number => (q ? (2 * Math.atan2(q[1] ?? 0, q[3] ?? 1)) / DEG : 0);
const quatOfYaw = (deg: number): [number, number, number, number] => [0, +Math.sin((deg * DEG) / 2).toFixed(6), 0, +Math.cos((deg * DEG) / 2).toFixed(6)];

/**
 * A scene entity's owner-visible state (position, yaw degrees, uniform scale, prefab id; `rot` / `scale3` only when it
 * is tilted / non-uniformly scaled). `components: true` adds every other component whole (any-entity edits).
 */
export function entityOwnerState(e: SceneEntityLike, opts: { components?: boolean } = {}): OwnerTransform {
  const t = (e.components["transform"] ?? {}) as { position?: number[]; rotation?: number[]; scale?: number[] };
  const prefab = e.components["prefab"] as { prefabId?: string } | undefined;
  const q = t.rotation, sc = t.scale ?? [1, 1, 1];
  const tilted = !!q && (Math.abs(q[0] ?? 0) > 1e-4 || Math.abs(q[2] ?? 0) > 1e-4);
  const uneven = Math.abs((sc[1] ?? 1) - (sc[0] ?? 1)) > 1e-4 || Math.abs((sc[2] ?? 1) - (sc[0] ?? 1)) > 1e-4;
  const out: OwnerTransform = {
    pos: (t.position ?? [0, 0, 0]).map((v) => +(+v).toFixed(4)) as [number, number, number],
    yaw: +yawOfQuat(t.rotation).toFixed(3),
    scale: +(sc[0] ?? 1).toFixed(4),
    ...(prefab?.prefabId ? { prop: prefab.prefabId } : {}),
  };
  if (tilted) out.rot = q!.map((v) => +(+v).toFixed(6)) as [number, number, number, number];
  if (uneven) out.scale3 = sc.map((v) => +(+v).toFixed(4)) as [number, number, number];
  if (opts.components) {
    const rest = Object.fromEntries(Object.entries(e.components).filter(([k]) => k !== "transform" && k !== "prefab").map(([k, v]) => [k, structuredClone(v)]));
    out.components = rest;
  }
  return out;
}

/**
 * Put an owner/agent state onto an entity doc (mutates `e`): transform fields that are set, a swapped prefab (its
 * props/overrides kept only when the prefab is the same), and every component the state holds.
 */
export function applyOwnerState(e: SceneEntityLike, s: OwnerTransform): void {
  const t = { ...((e.components["transform"] ?? {}) as Record<string, unknown>) };
  if (s.pos) t["position"] = [...s.pos];
  if (s.rot) t["rotation"] = [...s.rot];
  else if (s.yaw !== undefined) t["rotation"] = quatOfYaw(s.yaw);
  if (s.scale3) t["scale"] = [...s.scale3];
  else if (s.scale !== undefined) t["scale"] = [s.scale, s.scale, s.scale];
  if (s.pos || s.rot || s.yaw !== undefined || s.scale3 || s.scale !== undefined) e.components["transform"] = t;
  const pf = e.components["prefab"] as Record<string, unknown> | undefined;
  if (s.prop && pf && pf["prefabId"] !== s.prop) e.components["prefab"] = { prefabId: s.prop, props: {}, overrides: [] };
  for (const [k, v] of Object.entries(s.components ?? {})) e.components[k] = structuredClone(v);
}

/** The entity an owner-added record re-creates. */
export function ownerAddedEntity(o: OwnerOverride, parentExists: (id: string) => boolean): SceneEntityLike {
  const s = o.set;
  const e: SceneEntityLike = {
    name: o.name ?? (s.prop ? `${s.prop}` : o.item),
    parent: o.parent && parentExists(o.parent) ? o.parent : null,
    tags: o.tags ?? ["owner-added"],
    components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...(s.prop ? { prefab: { prefabId: s.prop } } : {}) },
  };
  applyOwnerState(e, s);
  return e;
}

type SceneOp =
  | { op: "remove-entity"; id: string }
  | { op: "set-component"; id: string; component: string; data: unknown }
  | { op: "add-entity"; id: string; entity: SceneEntityLike };

/**
 * Ops that bring a scene to the owner's state for a `frame: "scene"` overrides file: edited entities get the owner's
 * transform / prefab, deleted ones are removed, owner-added ones are added if missing. Idempotent: nothing is emitted
 * for an entity already in the owner's state. Installers run this LAST (`dress owner-apply`).
 */
export function sceneOwnerOps(doc: { entities: Record<string, SceneEntityLike> }, file: OwnerOverrides): SceneOp[] {
  const ops: SceneOp[] = [];
  for (const o of file.overrides) {
    const id = o.entity ?? o.item;
    const e = doc.entities[id];
    if (o.deleted) {
      if (e && !(e.parent && file.overrides.some((p) => p.deleted && (p.entity ?? p.item) === e.parent))) ops.push({ op: "remove-entity", id });
      continue;
    }
    if (!e) {
      if (!o.added) continue; // the installer no longer places it: stale
      const parentOk = (p: string) => p in doc.entities || ops.some((x) => x.op === "add-entity" && x.id === p);
      ops.push({ op: "add-entity", id, entity: ownerAddedEntity(o, parentOk) });
      continue;
    }
    ops.push(...entityStateOps(id, e, o.set));
  }
  return ops;
}

/** set-component ops that bring entity `e` to state `s` (nothing for what already matches). */
export function entityStateOps(id: string, e: SceneEntityLike, s: OwnerTransform): SceneOp[] {
  const next: SceneEntityLike = { ...e, components: { ...e.components } };
  applyOwnerState(next, s);
  const out: SceneOp[] = [];
  for (const [k, v] of Object.entries(next.components)) {
    if (v === e.components[k]) continue;
    if (k === "transform" && sameOwnerTransform(entityOwnerState(next), entityOwnerState(e))) continue;
    if (JSON.stringify(v) === JSON.stringify(e.components[k])) continue;
    out.push({ op: "set-component", id, component: k, data: v });
  }
  return out;
}

// ---- scale range ---------------------------------------------------------------

/**
 * The uniform scale the owner may give a prop: the catalogue's real-size range for its kind (tools/prop-kind-sizes.json,
 * scaled by the place's scale class) divided by the prop's declared size, so a scaled prop never leaves its kind's
 * real size; without a kind, a modest variation band. Never past what `dress check` would refuse.
 */
export function ownerScaleRange(
  propId: string,
  size: readonly number[] | undefined,
  kinds: Record<string, { match: string; dim: "h" | "long" | "max"; range: [number, number] }> | undefined,
  classFactor = 1,
): { min: number; max: number; kind: string | null } {
  const free = { min: 0.75, max: 1.33, kind: null };
  if (!size || size.length < 3 || !kinds) return free;
  const name = propId.split("/").pop()!.replace(/[-_]/g, " ");
  for (const [kind, k] of Object.entries(kinds)) {
    if (!new RegExp(k.match).test(name)) continue;
    const dim = k.dim === "h" ? size[1]! : k.dim === "long" ? Math.max(size[0]!, size[2]!) : Math.max(size[0]!, size[1]!, size[2]!);
    if (!(dim > 0)) return { ...free, kind };
    const min = Math.max(0.25, (k.range[0] * classFactor) / dim), max = (k.range[1] * classFactor) / dim;
    return max >= min ? { min: +min.toFixed(3), max: +max.toFixed(3), kind } : { min: 1, max: 1, kind };
  }
  return free;
}
