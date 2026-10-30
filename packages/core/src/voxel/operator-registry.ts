/**
 * LANDFORM OPERATORS — the registry and the recipe doc shape.
 *
 * Agents never write voxels or raw carve boxes for landforms (owner ruling 2026-10-15: 413 box cuts for one cliff
 * path on a 2 m lattice drew lumpy treads and kerbs over the walk line). They write ONE operator doc into
 * `features.operators` — `{ id, op, ...params }`, a handful of numbers — and the operator's `compile` turns it into the
 * low-level features the field already understands (height patches, blobs, passages, roads ...), ids `op:<id>:*`.
 *
 * This file holds only the registry and the doc schema (zod + type imports), so `recipe.ts` can validate
 * `features.operators` without an import cycle. Applying, removing and checking operators is `./operators.ts`;
 * each operator registers itself from its own module (`./operators-terrace.ts` ...).
 */
import { z } from "zod";

/** Smallest dimension, metres, any terrain carve or patch may have: three 2 m lattice steps (the 6 m rule). */
export const FINE_MIN = 6;

/** What `compile` may read: the ground WITHOUT this operator's own output (re-running never stacks on itself). */
export interface OperatorFieldReader {
  /** Ground height at (x, z), every other feature applied. */
  height(x: number, z: number): number;
  /** Lattice spacing, metres (2 on every shipped world). */
  readonly voxelSize: number;
  readonly seaLevel: number;
  /** World seed, for deterministic jitter. */
  readonly seed: number;
  /**
   * Optional full-volume read: the field density at a point (negative = solid rock, positive = air), every other
   * feature applied. Volume-aware operators (`cave`) measure rock cover with it (overhangs, other caves, arches);
   * without it they fall back to the heightfield (`height` columns).
   */
  density?(x: number, y: number, z: number): number;
  /** Optional: the world's palette surface names (`paint`/`scree` refuse a surface that is not in it). */
  readonly surfaces?: readonly string[];
  /** Optional: the world's scatter rule ids (`scree` boulders must name existing rules). */
  readonly scatterRules?: readonly string[];
}

/** A compiled feature: an object for one `features.<kind>` array, `id` LOCAL to the operator (namespaced on apply). */
export type OperatorPiece = { id: string } & Record<string, unknown>;

export interface OperatorOutput {
  /** Feature kind (a `FEATURE_KINDS` entry of terraform.ts) -> the pieces to add. Local ids, unique per kind. */
  features: Partial<Record<string, OperatorPiece[]>>;
  /** Free-form numbers for the preview and the agent (shelf levels, ramp grades, cut/fill). Never read back. */
  report: Record<string, unknown>;
}

/** World XZ box an operator works in (its footprint, before any blend margin). */
export interface OperatorBounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface LandformOperator<P = any> {
  /** The `op` string in the recipe. */
  op: string;
  /** One line for the engine spec. */
  description: string;
  /** Params schema (the doc minus `id` / `op` / `compiled`); `.describe()` every field — it IS the agent-facing doc. */
  schema: z.ZodType<P>;
  /** Pure and deterministic: same params + same ground -> byte-identical output. Must obey the 6 m rule. */
  compile(params: P, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput;
  /** Area the operator shapes (the preview frames it, the ground fingerprint samples it). */
  bounds(params: P): OperatorBounds;
  /** Optional outline(s) to draw on the preview map, world XZ loops. */
  outline?(params: P): [number, number][][];
}

const REGISTRY = new Map<string, LandformOperator>();

/** Register an operator. Re-registering the same `op` replaces it (hot reload). */
export function registerOperator<P>(operator: LandformOperator<P>): void {
  REGISTRY.set(operator.op, operator as LandformOperator);
}
export function getOperator(op: string): LandformOperator | undefined {
  return REGISTRY.get(op);
}
export function operatorNames(): string[] {
  return [...REGISTRY.keys()].sort();
}
/** For the engine spec: op -> { description, JSON Schema of its params }. */
export function operatorSpecs(): Record<string, { description: string; schema: unknown }> {
  const out: Record<string, { description: string; schema: unknown }> = {};
  for (const name of operatorNames()) {
    const o = REGISTRY.get(name)!;
    let schema: unknown = {};
    try { schema = z.toJSONSchema(o.schema, { io: "input", unrepresentable: "any" }); } catch { /* keep {} */ }
    out[name] = { description: o.description, schema };
  }
  return out;
}

/** What `worldgen op --apply` stamps on the doc: how to tell hand edits and a moved ground from a clean install. */
export const operatorCompiledSchema = z.object({
  digest: z.string().describe("Hash of the compiled pieces as installed. A mismatch = a piece was hand-edited (never do that: change the params and re-apply)."),
  ground: z.string().describe("Fingerprint of the ground the operator read (its bounds, without its own output). A mismatch = the ground moved under it: re-apply."),
  pieces: z.array(z.string()).describe("`<kind>/<id>` of every installed piece."),
});

export const OPERATOR_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Owner ruling 2026-10-30: the path RIBBON system (the `path` operator, `features.ribbons`, a world-op of kind
 * `ribbons`) is gone from the engine and every tool. A world or a job that still declares one fails to load with this
 * message, never silently: re-plan the walk as a carved + painted track (`worldgen road`, place-build tracks).
 */
export const RIBBONS_REMOVED = "ribbons were removed 2026-10-30: use carved+painted tracks";
/** Operator names that were ribbon builders: a doc naming one fails with RIBBONS_REMOVED. */
export const REMOVED_RIBBON_OPS: readonly string[] = ["path", "ribbon"];

/**
 * One `features.operators` entry: `{ id, op, ...params }`. The params are validated by the registered operator's
 * schema; an unknown `op` is an error. `compiled` is written by the tool, never by hand.
 */
export const operatorDocSchema = z
  .object({
    id: z.string().regex(OPERATOR_ID_RE).describe("Slug. Its compiled pieces are `op:<id>:*`; re-applying replaces exactly those."),
    op: z.string().describe("Registered operator: see the engine spec `landformOperators` (terrace, ledges, ...)."),
    compiled: operatorCompiledSchema.optional(),
  })
  .passthrough()
  .superRefine((doc, ctx) => {
    if (REMOVED_RIBBON_OPS.includes(doc.op)) {
      ctx.addIssue({ code: "custom", path: ["op"], message: `operator "${doc.id}" (op ${doc.op}): ${RIBBONS_REMOVED}` });
      return;
    }
    const o = REGISTRY.get(doc.op);
    if (!o) {
      ctx.addIssue({ code: "custom", path: ["op"], message: `unknown landform operator "${doc.op}" (registered: ${operatorNames().join(", ") || "none"})` });
      return;
    }
    const parsed = o.schema.safeParse(operatorParams(doc));
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path as (string | number)[], message: issue.message });
  });
export type OperatorDoc = z.infer<typeof operatorDocSchema> & Record<string, unknown>;

/** The params of a doc: everything except `id`, `op` and `compiled`. */
export function operatorParams(doc: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, op: _op, compiled: _c, ...params } = doc;
  return params;
}

/** The namespace prefix of an operator's compiled pieces. */
export function operatorPrefix(id: string): string {
  return `op:${id}:`;
}
