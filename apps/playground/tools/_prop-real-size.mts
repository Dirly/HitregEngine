/**
 * Real size per prop kind (docs/world-standards/props.md): the ranges are DATA (tools/prop-kind-sizes.json, extended
 * per project by authoring/prop-catalogs.json `realSize.kinds`), scaled by the user's scale class. `props status`
 * flags a prop outside its kind's range; `dress check` refuses placing one (`wrong-size`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `long`: an optional second bound on the longer horizontal side (a stool is short AND narrow: a 1 m wide "stool" is a side table). */
export interface KindSize { match: string; dim: "h" | "long" | "max"; range: [number, number]; long?: [number, number]; note?: string }
export interface KindSizes { userHeight: number; kinds: Record<string, KindSize> }
interface ScaleClass { id: string; height: number }

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KIND_SIZES: KindSizes = JSON.parse(fs.readFileSync(path.join(HERE, "prop-kind-sizes.json"), "utf8"));

/** The default table with a project's `realSize` (from its prop-catalogs registry) laid over it. */
export function kindSizes(extra?: { userHeight?: number; kinds?: Record<string, Partial<KindSize> | null> }): KindSizes {
  const kinds: Record<string, KindSize> = { ...DEFAULT_KIND_SIZES.kinds };
  for (const [k, v] of Object.entries(extra?.kinds ?? {})) {
    if (v === null) delete kinds[k];
    else kinds[k] = { ...kinds[k], ...v } as KindSize;
  }
  return { userHeight: extra?.userHeight ?? DEFAULT_KIND_SIZES.userHeight, kinds };
}

const nameOf = (id: string): string => id.split("/").pop()!.replace(/[-_]/g, " ");
/** The kind a prefab id names, or null (most props have no kind range). */
export function kindOf(id: string, table: KindSizes): string | null {
  const n = nameOf(id);
  for (const [k, v] of Object.entries(table.kinds)) if (new RegExp(v.match).test(n)) return k;
  return null;
}

const measureDim = (size: number[], dim: KindSize["dim"]): number =>
  dim === "h" ? size[1]! : dim === "long" ? Math.max(size[0]!, size[2]!) : Math.max(size[0]!, size[1]!, size[2]!);

/**
 * The real-size fault of a prop of `size` used at scale class `scale` (undefined / "any" = human), or null.
 * `scales` is the dressing vocabulary's scale list (heights per class).
 */
export function realSizeIssue(id: string, size: number[], scale: string | undefined, scales: ScaleClass[], table: KindSizes): string | null {
  const kind = kindOf(id, table);
  if (!kind) return null;
  const k = table.kinds[kind]!;
  const cls = scale && scale !== "any" ? scales.find((s) => s.id === scale) : undefined;
  const f = cls && cls.height > 0 ? cls.height / table.userHeight : 1;
  const lo = +(k.range[0] * f).toFixed(2);
  const hi = +(k.range[1] * f).toFixed(2);
  const v = +measureDim(size, k.dim).toFixed(2);
  if (v >= lo && v <= hi) {
    if (!k.long || k.dim === "long") return null;
    // the second bound (owner walk 2026-10-27: a purchased pack's `Stool_1`, 0.6 m tall and 1.05 m wide, was dressed as a
    // stool beside tables; it is a side table — a pack's object name is never an identity)
    const w = +measureDim(size, "long").toFixed(2);
    const wlo = +(k.long[0] * f).toFixed(2), whi = +(k.long[1] * f).toFixed(2);
    if (w >= wlo && w <= whi) return null;
    return `real size: a ${kind} ${w} m across is outside ${wlo}-${whi} m for a ${cls?.id ?? "human"}-scale user${k.note ? ` (${k.note})` : ""}: the name is the pack's, not what the thing is — re-declare it as what its size says it is`;
  }
  const dimWord = k.dim === "h" ? "tall" : k.dim === "long" ? "long" : "across";
  return `real size: a ${kind} ${v} m ${dimWord} is outside ${lo}-${hi} m for a ${cls?.id ?? "human"}-scale user${k.note ? ` (${k.note})` : ""}${v > hi ? ": never scale a prop up to read from far away; a bigger one needs its own model" : ""}`;
}

/**
 * Prefab ids whose owning catalogue row declares `realSizeExempt` (a reason of 8+ characters: the piece is deliberately
 * off the real-size range, e.g. the interior kit drawn at 1.5x for the 2.5x town buildings). `props status` and
 * `dress check` both honour it. `roots` = the closure's project folders, own first (each may hold
 * authoring/prop-catalogs.json; catalogue paths are resolved in the first root that has them).
 */
export function realSizeExemptIds(roots: string[]): Set<string> {
  const out = new Set<string>();
  catalogRows(roots, (row, ids) => {
    if (typeof row?.realSizeExempt === "string" && row.realSizeExempt.trim().length >= 8) for (const id of ids) out.add(id);
  });
  return out;
}

/**
 * Prefab id -> its successor for every catalogue row with `supersededBy` (a reskin or revision under a new id), chains
 * followed. A set authored with the old piece places the successor (`dress` sets, `props menu`).
 */
export function supersededIds(roots: string[]): Map<string, string> {
  const next = new Map<string, string>();
  catalogRows(roots, (row, ids) => {
    if (typeof row?.supersededBy === "string" && row.supersededBy) for (const id of ids) if (id !== row.supersededBy) next.set(id, row.supersededBy);
  });
  const out = new Map<string, string>();
  for (const id of next.keys()) {
    let at = id;
    for (let i = 0; i < 8 && next.has(at); i++) at = next.get(at)!;
    out.set(id, at);
  }
  return out;
}

/**
 * OWNER OUTRANKS A STAND-IN. A catalogue row may carry `supersededFor: { <role>: <owner prop id> }`: the prop stays usable
 * for what it still is (a painted heap as a heap base) but for that role the owner-made prop is the thing (skulls on and
 * around a bone pile are the owner's modelled skull, never the flat painted ones). Prefab id -> [{ role, by }].
 * `dress check` warns `owner-outranks` when a placement of such a prop has no placement of the owner prop (or a
 * prefab of the same owner mesh, `<by>-*`) on it or within OUTRANK_RADIUS metres, and `superseded` when a plan places a
 * prop whose row has `supersededBy` directly.
 */
export const OUTRANK_RADIUS = 1.5;
export function outrankedIds(roots: string[]): Map<string, { role: string; by: string }[]> {
  const out = new Map<string, { role: string; by: string }[]>();
  catalogRows(roots, (row, ids) => {
    const f = row?.supersededFor;
    if (!f || typeof f !== "object") return;
    for (const [role, by] of Object.entries(f)) if (typeof by === "string" && by) for (const id of ids) out.set(id, [...(out.get(id) ?? []), { role, by }]);
  });
  return out;
}

/** The findings of the outrank rule over resolved placements (pure; tested in test/owner-outranks.test.ts). */
export function outrankFindings(
  placements: { id: string; prop: string; position: number[] }[],
  outranked: Map<string, { role: string; by: string }[]>,
  superseded: Map<string, string>,
  radius = OUTRANK_RADIUS,
): { item: string; code: string; message: string }[] {
  const out: { item: string; code: string; message: string }[] = [];
  const isOf = (prop: string, by: string) => prop === by || prop.startsWith(by + "-");
  for (const p of placements) {
    const next = superseded.get(p.prop);
    if (next) out.push({ item: p.id, code: "superseded", message: `${p.prop} is superseded by ${next}: place ${next}` });
    for (const { role, by } of outranked.get(p.prop) ?? []) {
      const near = placements.some((q) => q !== p && isOf(q.prop, by) && Math.hypot(q.position[0]! - p.position[0]!, q.position[2]! - p.position[2]!) <= radius);
      if (!near) out.push({ item: p.id, code: "owner-outranks", message: `${p.prop} stands in for the owner-made ${by} as the ${role}: put ${by} (or ${by}-surface on its heap-top) on it or within ${radius} m` });
    }
  }
  return out;
}

/** Every row of every catalogue in the closure's prop-catalogs.json registries, with the prefab ids it owns. */
function catalogRows(roots: string[], visit: (row: any, prefabIds: string[]) => void): void {
  const read = (rel: string): any => {
    for (const r of roots) { const f = path.join(r, rel); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")); }
    return null;
  };
  const seen = new Set<string>();
  for (const r of roots) {
    const idx = path.join(r, "authoring/prop-catalogs.json");
    if (!fs.existsSync(idx)) continue;
    const reg = JSON.parse(fs.readFileSync(idx, "utf8")) as { catalogs?: { path: string; entries: string; prefabIds?: boolean; pathFields?: string[] }[] };
    for (const entry of reg.catalogs ?? []) {
      const key = `${entry.path}\0${entry.entries}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rows = read(entry.path)?.[entry.entries];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const paths = (entry.pathFields ?? []).map((f) => row[f]).filter((v: unknown) => typeof v === "string") as string[];
        if (entry.prefabIds && typeof row.id === "string") paths.push(`assets/prefabs/${row.id}.json`);
        const ids: string[] = [];
        for (const p of paths) {
          const m = /^assets\/prefabs\/(.+)\.json$/i.exec(p.replaceAll("\\", "/"));
          if (m && !ids.includes(m[1]!)) ids.push(m[1]!);
        }
        if (ids.length) visit(row, ids);
      }
    }
  }
}

/**
 * Furniture that stands against a wall by its NAME (props status audit): wardrobes, shelves, beds. A bed is the whole
 * word in the prop name ("bed", "oak-bed", "bed-double"), so a bedroll (camp ground bedding) or a flowerbed is not one.
 */
export function standsAgainstWall(name: string): boolean {
  return /wardrobe|bookshelf|^shelf|(^|-)bed(-|$)/.test(name);
}
