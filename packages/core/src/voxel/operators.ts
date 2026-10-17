/**
 * LANDFORM OPERATORS — install, remove, check, and the 6 m rule.
 *
 * WHERE OPERATORS EXPAND: at INSTALL (`worldgen op --apply`), not at field build. The operator doc is the truth and
 * its compiled pieces (`op:<id>:*` height patches, blobs, passages ...) are derived and regenerable — the same
 * contract as `terraceWalls` -> `tw-*` and `bridgeSpans` -> `bs-*`. Reasons:
 *  - `compile` READS the ground (shelf levels follow the slope it is cut into). At field build that read is circular
 *    (the field would need itself) and would put a whole-area solve inside every server/client field construction —
 *    against the latency budget and the "field is a pure, cheap function of the recipe" rule.
 *  - the streamer, the server, the HLOD bake and every gate (lips, float, seated, terrain-fine) already understand
 *    the low-level features; nothing downstream needs operator code, and `applyRecipeEdits` gives cell invalidation
 *    and the inverse for free.
 *  - `compiled.digest` catches a hand-edited piece and `compiled.ground` catches ground that moved under the operator
 *    (`checkOperators`), so derived never silently drifts from truth.
 *
 * Every install is ONE `applyRecipeEdits` batch: remove the operator's old pieces, add/update its doc, add the new
 * pieces. Its inverse restores the previous recipe exactly.
 */
import { applyRecipeEdits, FEATURE_KINDS, type FeatureKind, type RecipeEdit, type RecipeEditResult } from "./terraform.js";
import {
  FINE_MIN,
  getOperator,
  operatorDocSchema,
  operatorParams,
  operatorPrefix,
  type OperatorBounds,
  type OperatorDoc,
  type OperatorFieldReader,
  type OperatorOutput,
} from "./operator-registry.js";
import type { WorldRecipe } from "./recipe.js";
import "./operators-terrace.js";
import "./operators-path.js";
import "./operators-cave.js";
import "./operators-ledges.js";
import "./operators-landmark.js";

export * from "./operator-registry.js";

/** FNV-1a 32-bit over a string, hex. Core is headless and dependency-free: no node crypto. */
export function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Canonical JSON (sorted keys) so a digest never depends on key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Every feature of every kind whose id is in the operator's namespace. */
export function operatorPieces(recipe: WorldRecipe, id: string): { kind: FeatureKind; id: string; feature: Record<string, unknown> }[] {
  const prefix = operatorPrefix(id);
  const out: { kind: FeatureKind; id: string; feature: Record<string, unknown> }[] = [];
  for (const kind of FEATURE_KINDS) {
    if (kind === "operators") continue;
    for (const f of ((recipe.features as Record<string, unknown>)[kind] as { id: string }[] | undefined) ?? []) {
      if (typeof f.id === "string" && f.id.startsWith(prefix)) out.push({ kind, id: f.id, feature: f as Record<string, unknown> });
    }
  }
  return out;
}

/** The recipe with an operator's compiled pieces lifted off: the ground its `compile` must read. */
export function withoutOperatorPieces(recipe: WorldRecipe, id: string): WorldRecipe {
  const prefix = operatorPrefix(id);
  const features = { ...recipe.features } as Record<string, unknown>;
  for (const kind of FEATURE_KINDS) {
    const list = features[kind] as { id: string }[] | undefined;
    if (kind !== "operators" && list?.some((f) => f.id?.startsWith(prefix))) features[kind] = list.filter((f) => !f.id?.startsWith(prefix));
  }
  return { ...recipe, features: features as WorldRecipe["features"] };
}

/** Fingerprint of the ground an operator reads: a 9x9 grid over its bounds, to 5 cm. */
export function groundFingerprint(reader: OperatorFieldReader, b: OperatorBounds): string {
  const parts: string[] = [];
  for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) {
    const x = b.x0 + ((b.x1 - b.x0) * i) / 8, z = b.z0 + ((b.z1 - b.z0) * j) / 8;
    parts.push(String(Math.round(reader.height(x, z) * 20)));
  }
  return hash32(parts.join(","));
}

/** A 6 m-rule violation: a carve or patch finer than the lattice can draw. */
export interface FineCarve {
  kind: "passages" | "heightPatches" | "blobs";
  id: string;
  /** Its smallest dimension, metres. */
  min: number;
  what: string;
}

/** Smallest dimension of one carve/patch feature, metres (Infinity for kinds the rule does not cover). */
export function featureMinDimension(kind: string, f: Record<string, unknown>): { min: number; what: string } {
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  if (kind === "passages") {
    const w = n(f.width, 0), l = n(f.length, 0), h = n(f.height, 0);
    const min = Math.min(w, l, h);
    return { min, what: `passage ${w}x${l}x${h} m (w x l x h)` };
  }
  if (kind === "heightPatches") {
    const s = (f.size as number[] | undefined) ?? [0, 0];
    return { min: Math.min(s[0] ?? 0, s[1] ?? 0), what: `height patch ${s[0]}x${s[1]} m` };
  }
  if (kind === "blobs") {
    const r = n(f.radius, 0), top = n(f.topRadius, r);
    const d = 2 * Math.min(r, top) * Math.min(n(f.scaleX, 1), n(f.scaleZ, 1));
    return { min: d, what: `blob ${f.op ?? "remove"} diameter ${Math.round(d * 10) / 10} m` };
  }
  if (kind === "tunnels") {
    const r = n(f.radius, 0), e = n(f.endRadius, r);
    return { min: 2 * Math.min(r, e), what: `tunnel diameter ${2 * Math.min(r, e)} m` };
  }
  if (kind === "kitWalls") {
    const run = 2 * ((f.cuts as unknown[] | undefined)?.length ?? 0);
    return { min: run, what: `kit wall run ${run} m` };
  }
  return { min: Infinity, what: kind };
}

/** Prefixes of derived pieces owned by a system that keeps them legal by construction (kit walls, bridges, operators). */
export const FINE_EXEMPT_PREFIXES = ["op:", "tw-", "bs-"] as const;

export interface FineReport {
  ok: boolean;
  /** New violations: not exempt and not on the legacy list. */
  faults: FineCarve[];
  /** Violations on the recorded legacy list (counted, not failed). */
  legacy: FineCarve[];
  /** Fine pieces owned by exempt systems (`tw-` wall cuts, `bs-` bridge cuts). */
  exempt: number;
}

/**
 * THE 6 M RULE. The terrain lattice is 2 m, so a terrain carve or patch whose smallest dimension is under 6 m
 * (three steps) cannot be drawn — it becomes lumpy treads, bulging walls and kerbs over the walk line. Such shapes are
 * a kit / hero piece or an operator's job. `legacy` = ids recorded before the rule (they pass, and are counted);
 * `near` = only features whose footprint centre lies within that disc.
 */
export function fineCarves(recipe: WorldRecipe, options: { legacy?: Iterable<string>; near?: [number, number, number] } = {}): FineReport {
  const legacy = new Set(options.legacy ?? []);
  const report: FineReport = { ok: true, faults: [], legacy: [], exempt: 0 };
  const near = options.near;
  for (const kind of ["passages", "heightPatches", "blobs"] as const) {
    for (const f of (recipe.features[kind] ?? []) as unknown as Record<string, unknown>[]) {
      const id = String(f.id ?? "");
      const { min, what } = featureMinDimension(kind, f);
      if (!(min < FINE_MIN - 1e-6)) continue;
      if (near) {
        const c = featureCentre(kind, f);
        if (Math.hypot(c[0] - near[0], c[1] - near[1]) > near[2]) continue;
      }
      if (FINE_EXEMPT_PREFIXES.some((p) => id.startsWith(p))) { report.exempt += 1; continue; }
      const row: FineCarve = { kind, id, min: Math.round(min * 100) / 100, what };
      if (legacy.has(`${kind}/${id}`) || legacy.has(id)) report.legacy.push(row);
      else report.faults.push(row);
    }
  }
  report.ok = report.faults.length === 0;
  return report;
}

/** The one-line remedy every 6 m-rule message carries. */
export const FINE_REMEDY = "too fine for terrain: use a kit/hero piece or an operator";

function featureCentre(kind: string, f: Record<string, unknown>): [number, number] {
  if (kind === "heightPatches") {
    const o = f.origin as number[], s = f.size as number[];
    return [o[0]! + s[0]! / 2, o[1]! + s[1]! / 2];
  }
  const c = (kind === "passages" ? f.start : f.center) as number[];
  return [c[0]!, c[2]!];
}

export interface OperatorApplyResult extends RecipeEditResult {
  /** The edits applied (for logs and ops files). */
  edits: RecipeEdit[];
  /** The operator's own report (levels, grades ...). */
  report: OperatorOutput["report"];
  /** The doc as installed, with `compiled`. */
  doc: OperatorDoc;
}

/** Compile an operator doc against a reader without touching any recipe (the preview uses this). */
export function compileOperator(doc: Record<string, unknown>, reader: OperatorFieldReader): { output: OperatorOutput; pieces: { kind: FeatureKind; feature: Record<string, unknown> }[]; doc: OperatorDoc } {
  const parsed = operatorDocSchema.safeParse(doc);
  if (!parsed.success) throw new Error(`operator "${String(doc.id)}": ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const valid = parsed.data as OperatorDoc;
  const op = getOperator(valid.op)!;
  const params = op.schema.parse(operatorParams(valid));
  const output = op.compile(params, reader, { id: valid.id });
  const prefix = operatorPrefix(valid.id);
  const pieces: { kind: FeatureKind; feature: Record<string, unknown> }[] = [];
  for (const kind of Object.keys(output.features).sort()) {
    if (!(FEATURE_KINDS as readonly string[]).includes(kind) || kind === "operators") throw new Error(`operator ${valid.op} emitted unknown feature kind "${kind}"`);
    const seen = new Set<string>();
    for (const piece of output.features[kind] ?? []) {
      if (seen.has(piece.id)) throw new Error(`operator ${valid.op} emitted ${kind} id "${piece.id}" twice`);
      seen.add(piece.id);
      const feature = { ...piece, id: `${prefix}${piece.id}` };
      const { min, what } = featureMinDimension(kind, feature);
      // by construction: an operator that emits a shape the lattice cannot draw is a bug in the operator
      if (min < FINE_MIN - 1e-6) throw new Error(`operator ${valid.op} "${valid.id}" emitted ${kind}/${feature.id} (${what}): ${FINE_REMEDY} — the 6 m rule binds operators by construction`);
      pieces.push({ kind: kind as FeatureKind, feature });
    }
  }
  return { output, pieces, doc: valid };
}

/**
 * Install (or re-install) one operator: ONE edit batch that removes its old `op:<id>:*` pieces, writes its doc with a
 * fresh `compiled` stamp, and adds the newly compiled pieces. `reader` must be the ground WITHOUT this operator's
 * pieces (`withoutOperatorPieces`). Pure; the inverse restores the input recipe.
 */
export function applyOperator(recipe: WorldRecipe, doc: Record<string, unknown>, reader: OperatorFieldReader): OperatorApplyResult {
  const { output, pieces, doc: valid } = compileOperator(doc, reader);
  const op = getOperator(valid.op)!;
  const bounds = op.bounds(op.schema.parse(operatorParams(valid)));
  const installed: OperatorDoc = {
    ...valid,
    compiled: {
      digest: "", // set below from the landed pieces
      ground: groundFingerprint(reader, bounds),
      pieces: pieces.map((p) => `${p.kind}/${p.feature.id}`),
    },
  };
  const edits: RecipeEdit[] = operatorPieces(recipe, valid.id).map((p) => ({ edit: "remove-feature", kind: p.kind, id: p.id }));
  const exists = (recipe.features.operators ?? []).some((o) => o.id === valid.id);
  edits.push(exists ? { edit: "update-feature", kind: "operators", id: valid.id, feature: installed } : { edit: "add-feature", kind: "operators", feature: installed });
  for (const p of pieces) edits.push({ edit: "add-feature", kind: p.kind, feature: p.feature });
  const result = applyRecipeEdits(recipe, edits);
  // digest the pieces AS THEY LANDED (schema defaults filled), so `checkOperators` compares like with like
  const landed = operatorPieces(result.recipe, valid.id);
  const ordered = installed.compiled!.pieces.map((k) => landed.find((p) => `${p.kind}/${p.id}` === k)!);
  const stamped = (result.recipe.features.operators ?? []).find((o) => o.id === valid.id) as OperatorDoc;
  stamped.compiled = { ...installed.compiled!, digest: piecesDigest(ordered.map((p) => ({ kind: p.kind, feature: p.feature }))) };
  installed.compiled!.digest = stamped.compiled.digest; // the logged edit says what landed
  return { ...result, edits, report: output.report, doc: stamped };
}

/** Remove an operator and everything it compiled, as one batch with its inverse. */
export function removeOperator(recipe: WorldRecipe, id: string): RecipeEditResult & { edits: RecipeEdit[] } {
  const edits: RecipeEdit[] = operatorPieces(recipe, id).map((p) => ({ edit: "remove-feature", kind: p.kind, id: p.id }));
  if ((recipe.features.operators ?? []).some((o) => o.id === id)) edits.push({ edit: "remove-feature", kind: "operators", id });
  if (edits.length === 0) throw new Error(`no operator "${id}" and no op:${id}:* pieces`);
  return { ...applyRecipeEdits(recipe, edits), edits };
}

function piecesDigest(pieces: { kind: string; feature: Record<string, unknown> }[]): string {
  return hash32(pieces.map((p) => `${p.kind}\0${canonical(p.feature)}`).join("\n"));
}

export type OperatorState = "ok" | "EDITED" | "MISSING" | "STALE" | "UNCOMPILED";

/**
 * State of every installed operator: EDITED = a piece no longer matches what was compiled (hand edit), MISSING = a
 * piece is gone, STALE = the ground under it moved (re-apply), UNCOMPILED = a doc never applied. `readerFor` builds
 * the ground without that operator's pieces (pass it only when STALE matters — it builds a field).
 */
export function checkOperators(recipe: WorldRecipe, readerFor?: (id: string) => OperatorFieldReader): { id: string; op: string; state: OperatorState; why: string }[] {
  return (recipe.features.operators ?? []).map((doc) => {
    const d = doc as OperatorDoc;
    if (!d.compiled) return { id: d.id, op: d.op, state: "UNCOMPILED" as const, why: "never applied: worldgen op --apply" };
    const have = operatorPieces(recipe, d.id);
    const haveKeys = new Set(have.map((p) => `${p.kind}/${p.id}`));
    const missing = d.compiled.pieces.filter((k) => !haveKeys.has(k));
    if (missing.length) return { id: d.id, op: d.op, state: "MISSING" as const, why: `missing ${missing.join(", ")}` };
    const ordered = d.compiled.pieces.map((k) => have.find((p) => `${p.kind}/${p.id}` === k)!);
    const extra = have.length - ordered.length;
    if (extra > 0 || piecesDigest(ordered.map((p) => ({ kind: p.kind, feature: p.feature }))) !== d.compiled.digest) {
      return { id: d.id, op: d.op, state: "EDITED" as const, why: "a compiled piece was edited by hand: change the params and re-apply" };
    }
    if (readerFor) {
      const op = getOperator(d.op);
      if (op && groundFingerprint(readerFor(d.id), op.bounds(op.schema.parse(operatorParams(d)))) !== d.compiled.ground) {
        return { id: d.id, op: d.op, state: "STALE" as const, why: "the ground under it moved: re-apply" };
      }
    }
    return { id: d.id, op: d.op, state: "ok" as const, why: "" };
  });
}
