/**
 * REPEAT LINT — anything we repeat is ONE prefab with shared, tweakable parameters.
 *
 * Derek 2026-10-30: "The braziers not all being the same game object, so each light had its own value. Reusable
 * modules: programming 101." and "It's not just lighting, it's anything we repeat... should be a prefab." A scene (or a
 * prefab, or an ops batch a tool is about to write) fails when:
 *
 *  - `identical`: two or more INLINE entities (no `prefab` component) carry the same structure — the same components
 *    and values, the same child subtree (children's own transforms included), only the root transform differing: a
 *    repeated light, vfx, collider set, sign or stall assembly written out in full each time;
 *  - `inline-role`: two or more inline entities of one visual role (fires, braziers, torches, lamps, lanterns,
 *    candles, beacons, hearths, sconces, chandeliers, windows' glow; point lights generally) each carry their own
 *    light / vfx / particles values, equal or not: one controllable object per repeated thing;
 *  - `override-role`: instances of ONE prefab override its light / vfx / particles values differently from each other
 *    (each brazier its own intensity): a different look is a variant prefab, never per-instance numbers.
 *
 * Generated meshes (terrain cells, water surfaces, skirts: `surface` / `voxel` / `heightmap` sources) are unique by
 * construction and never counted. Pure: works on any `{ entities }` document.
 */

export interface LintEntity {
  name?: string;
  parent?: string | null;
  tags?: string[];
  components?: Record<string, unknown>;
}
export interface LintDoc { entities: Record<string, LintEntity> }

export type RepeatRule = "identical" | "inline-role" | "override-role";
export interface RepeatFinding {
  rule: RepeatRule;
  /** The repeated thing: a structure signature's summary, a role, or a prefab id. */
  key: string;
  /** Entity ids involved (all of them). */
  ids: string[];
  /** What to do, in a line. */
  fix: string;
}

/** Components that are a "thing" (not just a group node). */
const CONTENT = ["mesh", "light", "vfx", "particles", "collider", "rigidbody", "script", "scripts", "audio", "billboard", "decal", "water", "grass", "animator"];
/** Components whose per-instance values make a separate look. */
const LOOK = ["light", "vfx", "particles"];
/** Generated geometry kinds: unique by construction. */
const GENERATED = new Set(["surface", "voxel", "voxelCell", "heightmap", "chunk", "path"]);
const ROLE_RE = /(fire|brazier|torch|lamp|lantern|candle|beacon|hearth|sconce|chandelier|window|glow|pyre|campfire|ember|flame)/i;

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  if (typeof v === "number") return String(Math.round(v * 1e4) / 1e4);
  return JSON.stringify(v);
};

function childrenOf(doc: LintDoc): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [id, e] of Object.entries(doc.entities)) {
    const p = e.parent ?? null;
    if (p == null || !doc.entities[p]) continue;
    (m.get(p) ?? m.set(p, []).get(p)!).push(id);
  }
  return m;
}

const generated = (e: LintEntity): boolean => {
  const mesh = e.components?.["mesh"] as { source?: { kind?: string } } | undefined;
  return !!mesh?.source?.kind && GENERATED.has(mesh.source.kind);
};
const hasContent = (e: LintEntity): boolean => CONTENT.some((k) => e.components?.[k] !== undefined);

/** The role of an entity with a look component, from its name, tags, vfx preset and light kind. */
export function lookRole(e: LintEntity): string | null {
  const c = e.components ?? {};
  if (!LOOK.some((k) => c[k] !== undefined)) return null;
  const words = [e.name ?? "", ...(e.tags ?? []), stable((c["vfx"] as { preset?: unknown } | undefined)?.preset ?? "")].join(" ");
  const m = ROLE_RE.exec(words);
  if (m) return m[1]!.toLowerCase();
  const light = c["light"] as { kind?: string } | undefined;
  if (light) return light.kind === "point" || light.kind === "spot" || light.kind === undefined ? `${light.kind ?? "point"}-light` : null; // one sun / ambient per scene is not a repeat
  return c["vfx"] ? "vfx" : "particles";
}

/** Components of a bare geometry part (a mesh or a collider of one model, nothing tweakable on it). */
const GEOMETRY = new Set(["transform", "mesh", "collider", "rigidbody", "visibility", "culling", "name"]);

/**
 * Find every repeated inline structure, inline look role and per-instance look override in a document.
 * `scope: "prefab"` (a prefab's own entities): the leaf geometry parts of one model (a mesh node, a box of a compound
 * collider) are that model's parts, not repeats; looks and multi-entity assemblies still count. `scene` (default):
 * every inline thing counts.
 */
export function findRepeats(doc: LintDoc, o: { minCount?: number; scope?: "scene" | "prefab" } = {}): RepeatFinding[] {
  const min = o.minCount ?? 2, kids = childrenOf(doc), sig = new Map<string, string>(), content = new Map<string, boolean>();
  const signature = (id: string, root: boolean): string => {
    const key = `${id}:${root ? 1 : 0}`;
    if (sig.has(key)) return sig.get(key)!;
    const e = doc.entities[id]!, comps = { ...(e.components ?? {}) };
    if (root) delete comps["transform"];
    const ch = (kids.get(id) ?? []).map((c) => signature(c, false)).sort();
    const s = `${stable(comps)}|${ch.join(";")}`;
    sig.set(key, s);
    return s;
  };
  const subtreeContent = (id: string): boolean => {
    if (content.has(id)) return content.get(id)!;
    const e = doc.entities[id]!;
    const v = !e.components?.["prefab"] && !generated(e) && (hasContent(e) || (kids.get(id) ?? []).some(subtreeContent));
    content.set(id, v);
    return v;
  };
  const inlineIds = Object.keys(doc.entities).filter((id) => !doc.entities[id]!.components?.["prefab"]);
  const out: RepeatFinding[] = [];

  // identical: group inline roots by subtree signature; report only maximal repeats (a repeated assembly, not its parts)
  const groups = new Map<string, string[]>();
  for (const id of inlineIds) {
    if (!subtreeContent(id) || generated(doc.entities[id]!)) continue;
    if (o.scope === "prefab" && !(kids.get(id) ?? []).length && Object.keys(doc.entities[id]!.components ?? {}).every((k) => GEOMETRY.has(k))) continue;
    const s = signature(id, true);
    (groups.get(s) ?? groups.set(s, []).get(s)!).push(id);
  }
  const repeated = new Set<string>();
  for (const ids of groups.values()) if (ids.length >= min) for (const id of ids) repeated.add(id);
  const underRepeated = (id: string): boolean => { let p = doc.entities[id]?.parent ?? null; while (p) { if (repeated.has(p)) return true; p = doc.entities[p]?.parent ?? null; } return false; };
  for (const ids of groups.values()) {
    if (ids.length < min) continue;
    const top = ids.filter((id) => !underRepeated(id));
    if (top.length < min) continue;
    const e = doc.entities[top[0]!]!, what = Object.keys(e.components ?? {}).filter((k) => k !== "transform").join("+") || "group";
    out.push({ rule: "identical", key: `${e.name ?? top[0]} (${what}${(kids.get(top[0]!) ?? []).length ? `, ${(kids.get(top[0]!) ?? []).length} children` : ""})`, ids: top, fix: `make it one prefab and place ${top.length} instances of it` });
  }

  // inline-role: inline look components of one role, wherever they stand (inside one prefab doc or a scene)
  const roles = new Map<string, string[]>();
  for (const id of inlineIds) {
    const e = doc.entities[id]!;
    if (repeated.has(id) || underRepeated(id)) continue; // already reported as identical
    const r = lookRole(e);
    if (r) (roles.get(r) ?? roles.set(r, []).get(r)!).push(id);
  }
  for (const [r, ids] of roles) if (ids.length >= min) out.push({ rule: "inline-role", key: r, ids, fix: `one ${r} prefab carries the light/vfx values; place it ${ids.length} times (a different look is a variant prefab)` });

  // override-role: one prefab, its instances overriding light/vfx/particles differently
  const byPrefab = new Map<string, { id: string; looks: string }[]>();
  for (const [id, e] of Object.entries(doc.entities)) {
    const p = e.components?.["prefab"] as { prefabId?: string; overrides?: { path?: string; value?: unknown }[] } | undefined;
    if (!p?.prefabId) continue;
    const looks = (p.overrides ?? []).filter((x) => typeof x.path === "string" && LOOK.some((k) => x.path!.includes(`/components/${k}`)));
    if (!looks.length) continue;
    (byPrefab.get(p.prefabId) ?? byPrefab.set(p.prefabId, []).get(p.prefabId)!).push({ id, looks: stable(looks.map((x) => [x.path, x.value]).sort()) });
  }
  for (const [pf, rows] of byPrefab) {
    const variants = new Set(rows.map((r) => r.looks));
    const count = Object.values(doc.entities).filter((e) => (e.components?.["prefab"] as { prefabId?: string } | undefined)?.prefabId === pf).length;
    // the same override on every instance is a variant waiting to be made; different overrides are per-instance numbers
    if (variants.size >= 2 || (rows.length >= min && rows.length === count)) out.push({ rule: "override-role", key: pf, ids: rows.map((r) => r.id), fix: variants.size >= 2 ? `${variants.size} different light/vfx overrides of ${pf}: make each look a variant prefab` : `every instance overrides ${pf}'s light/vfx the same way: put it in the prefab (or a variant)` });
  }
  return out;
}

/** The entities an ops batch adds, as a document (to lint what a tool is about to write). */
export function docOfOps(ops: readonly { op?: string; id?: string; entity?: LintEntity }[]): LintDoc {
  const entities: Record<string, LintEntity> = {};
  for (const o of ops) if (o.op === "add-entity" && o.id && o.entity) entities[o.id] = o.entity;
  return { entities };
}
