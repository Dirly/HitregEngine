/**
 * Content stamps for the per-town build rows (survey, layout, install, paths, walk, residents).
 *
 * The town tools write each other's inputs (doors and layout write the world recipe, layout rewrites its layout file
 * even when nothing moved, install rewrites the ops), so judging a row by FILE TIME makes the rows chase each other
 * in a circle. Instead each row records, when its evidence file is first seen with new content, a digest of ONLY
 * what its gate reads (a projection of each input); the row is STALE only when that digest changes. A tool rewriting
 * a file with identical content, or another stage editing an unrelated part of the recipe, leaves the row ok.
 *
 * Sidecar: zones/<zone>/reports/town-<name>.stamps.json  { rows: { <stage>: { evidence, inputs, at } } } (written by
 * `zonegen status`; deleting it only makes every row re-stamp).
 * First sight of new evidence: if an AUTHORED input (plan, envelopes, town doc, building models) is newer than the
 * evidence, the row is STALE (it was produced from older authoring); inputs other chain tools write (recipe, survey,
 * layout, install ops) are judged by content from then on. Limit: a genuine change to a chain input made after the
 * evidence and before status first sees it is absorbed into the stamp.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { exists, readJson, writeJson } from "../lib.mts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
export interface StampInput { file: string; authored: boolean; /** What the gate reads of it; absent = the bytes. */ proj?: (raw: J) => unknown }
interface Stamp { evidence: string; inputs: Record<string, string>; at: string }

const hash = (v: unknown): string => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 20);
const mtime = (f: string): number => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : NaN);

const memo = new Map<string, { m: number; raw: J }>();
function jsonOf(file: string): J {
  const m = mtime(file);
  const hit = memo.get(file);
  if (hit && hit.m === m) return hit.raw;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  memo.set(file, { m, raw });
  return raw;
}
function digestOf(i: StampInput): string {
  if (!exists(i.file)) return "missing";
  if (!i.proj) return hash(fs.readFileSync(i.file));
  return hash(i.proj(jsonOf(i.file)));
}

/** Features of the recipe that shape the ground near a town, by kind; `bare` drops what the town's own tools write. */
const GROUND_KINDS = ["canyons", "ridges", "roads", "towns", "heightPatches", "lakes", "fills", "tunnels", "blobs", "rivers", "riverPaths", "passages", "bridges"];
const GROUND_TOP = ["seed", "cellSize", "resolution", "seaLevel", "bounds", "minY", "maxY", "verticalRange", "terrain", "macroNoise"];
function pointsOf(x: J): number[][] {
  const out: number[][] = [];
  const visit = (v: J): void => {
    if (Array.isArray(v) && v.length >= 2 && v.length <= 3 && v.every((n: unknown) => typeof n === "number")) out.push(v.length === 3 ? [v[0] as number, v[2] as number] : (v as number[]));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(x);
  return out;
}
export function groundNear(townId: string, reach: number, bare: boolean): (recipe: J) => unknown {
  return (recipe: J) => {
    const town = (recipe.features?.towns ?? []).find((t: J) => t.id === townId);
    if (!town) return { missing: townId };
    const [cx, cz] = town.center;
    const R = town.radius + (town.falloff ?? 0) + reach;
    const near = (f: J): boolean => pointsOf(f).some(([x, z]) => Math.hypot(x! - cx, z! - cz) <= R);
    const out: Record<string, unknown> = {};
    for (const k of GROUND_TOP) out[k] = recipe[k];
    for (const kind of GROUND_KINDS) {
      let list = ((recipe.features?.[kind] ?? []) as J[]).filter(near);
      if (bare && kind === "roads") list = list.filter((r) => !String(r.id).startsWith(`${townId}-`));
      if (bare && kind === "towns") list = list.map((t) => (t.id === townId ? { id: t.id, tier: t.tier, center: t.center, radius: t.radius, falloff: t.falloff } : t));
      out[kind] = list;
    }
    return out;
  };
}
/** The town's street network and gates as the doors pass reads them (its own door roads excluded). */
export const streetsOf = (townId: string) => (recipe: J): unknown => ({
  streets: ((recipe.features?.roads ?? []) as J[]).filter((r) => String(r.id).startsWith(`${townId}-`) && !String(r.id).startsWith(`${townId}-door-`)),
  gates: ((recipe.features?.towns ?? []) as J[]).find((t) => t.id === townId)?.gates ?? [],
});

/**
 * Judge one row: null = current, else why it is stale. Re-stamps (and saves) when the evidence content is new and no
 * authored input is newer than it.
 */
export class TownStamps {
  private rows: Record<string, Stamp>;
  private dirty = false;
  constructor(private readonly file: string) {
    this.rows = exists(file) ? ((readJson(file) as { rows?: Record<string, Stamp> }).rows ?? {}) : {};
  }
  judge(stage: string, evidence: string, evidenceProj: ((raw: J) => unknown) | undefined, inputs: StampInput[]): string | null {
    const ev = digestOf({ file: evidence, authored: false, proj: evidenceProj });
    const now = Object.fromEntries(inputs.map((i, n) => [`${path.basename(i.file)}#${n}`, digestOf(i)]));
    const s = this.rows[stage];
    // the gate was RUN AGAIN after the stamp and came out the same (its file is newer than the stamp, same content): the
    // re-run read today's inputs, so the stamp moves to them; without this a passing re-run could never clear STALE
    if (s && s.evidence === ev && mtime(evidence) > Date.parse(s.at) + 1000 && inputs.every((i) => !i.authored || !(mtime(i.file) > mtime(evidence)))) {
      this.rows[stage] = { evidence: ev, inputs: now, at: new Date().toISOString() };
      this.dirty = true;
      return null;
    }
    if (s && s.evidence === ev) {
      const changed = Object.keys(now).filter((k) => s.inputs?.[k] !== now[k]).map((k) => k.replace(/#d+$/, ""));
      return changed.length ? `what it reads changed since it ran: ${[...new Set(changed)].join(", ")}` : null;
    }
    const late = inputs.filter((i) => i.authored && mtime(i.file) > mtime(evidence)).map((i) => path.basename(i.file));
    if (late.length) return `${late.join(", ")} changed since`;
    this.rows[stage] = { evidence: ev, inputs: now, at: new Date().toISOString() };
    this.dirty = true;
    return null;
  }
  save(): void {
    if (this.dirty) writeJson(this.file, { note: "zonegen town-row stamps: digest of what each gate reads, taken when its evidence was first seen (see tools/zonegen/commands/_town-stamps.mts)", rows: this.rows });
    this.dirty = false;
  }
}
