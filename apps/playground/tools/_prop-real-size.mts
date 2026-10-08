/**
 * Real size per prop kind (docs/world-standards/props.md): the ranges are DATA (tools/prop-kind-sizes.json, extended
 * per project by authoring/prop-catalogs.json `realSize.kinds`), scaled by the user's scale class. `props status`
 * flags a prop outside its kind's range; `dress check` refuses placing one (`wrong-size`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface KindSize { match: string; dim: "h" | "long" | "max"; range: [number, number]; note?: string }
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
  if (v >= lo && v <= hi) return null;
  const dimWord = k.dim === "h" ? "tall" : k.dim === "long" ? "long" : "across";
  return `real size: a ${kind} ${v} m ${dimWord} is outside ${lo}-${hi} m for a ${cls?.id ?? "human"}-scale user${k.note ? ` (${k.note})` : ""}${v > hi ? ": never scale a prop up to read from far away; a bigger one needs its own model" : ""}`;
}
