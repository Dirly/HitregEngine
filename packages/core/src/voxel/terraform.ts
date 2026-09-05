import { z } from "zod";
import {
  blobSchema,
  canyonSchema,
  lakeSchema,
  poiSchema,
  riverSchema,
  roadSchema,
  townSchema,
  tunnelSchema,
  type WorldRecipe,
} from "./recipe.js";
import { cellsInRect } from "./chunk.js";

/**
 * TERRAFORM — editing a world recipe as atomic, invertible batches.
 *
 * A voxel world is a pure function of its recipe: no voxel data is stored
 * anywhere, so "editing the terrain" means editing the small JSON document
 * the terrain is derived FROM. That is what makes an edit cheap enough to
 * save, diff, replicate and undo — a crater is a few hundred bytes of
 * feature, not a region of chunk deltas.
 *
 * WHY THIS IS NOT THE `Op` PROTOCOL. `Op` mutates a SceneDoc's entities;
 * a recipe has no entities, and forcing a blob through `add-entity` would
 * lie about what it is. So this mirrors the ops DISCIPLINE — every mutation
 * is a validated batch that returns the inverse batch, never a blind file
 * rewrite — over a document type of its own. `applyRecipeEdits` is to a
 * recipe what `applyOps` is to a scene.
 *
 * The other half of an edit is knowing WHAT IT TOUCHED. Every edit reports
 * the world-space XZ footprint it changed, INCLUDING the blend margin
 * (falloff / bank / shoulder / rim), because the terrain actually moves out
 * there too. `cellsForFootprints` turns that into the cell list a caller
 * must re-mesh — the difference between re-meshing 4 cells and re-meshing
 * the resident world.
 *
 * Pure and deterministic: the input recipe is never mutated, and the same
 * batch against the same recipe produces byte-identical output.
 */

// ---------------------------------------------------------------------------
// Feature kinds
// ---------------------------------------------------------------------------

/** The editable feature arrays under `recipe.features`. */
export const FEATURE_KINDS = [
  "rivers",
  "canyons",
  "roads",
  "towns",
  "lakes",
  "tunnels",
  "blobs",
  "pois",
] as const;

export type FeatureKind = (typeof FEATURE_KINDS)[number];

const FEATURE_SCHEMAS: Record<FeatureKind, z.ZodType> = {
  rivers: riverSchema,
  canyons: canyonSchema,
  roads: roadSchema,
  towns: townSchema,
  lakes: lakeSchema,
  tunnels: tunnelSchema,
  blobs: blobSchema,
  pois: poiSchema,
};

/** A feature after validation — every kind carries an `id`. */
interface AnyFeature {
  id: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// The edit vocabulary
// ---------------------------------------------------------------------------

export type RecipeEdit =
  | {
      edit: "add-feature";
      kind: FeatureKind;
      feature: unknown;
      /**
       * Insert position within the kind's array. Omit to append. Order
       * matters — features of one kind are evaluated in array order, so two
       * overlapping blobs do not commute — which is why the inverse of a
       * remove restores the exact index rather than appending.
       */
      index?: number;
    }
  | { edit: "update-feature"; kind: FeatureKind; id: string; feature: unknown }
  | { edit: "remove-feature"; kind: FeatureKind; id: string };

export const recipeEditSchema: z.ZodType<RecipeEdit> = z.discriminatedUnion("edit", [
  z.object({
    edit: z.literal("add-feature"),
    kind: z.enum(FEATURE_KINDS),
    feature: z.unknown(),
    index: z.number().int().min(0).optional(),
  }),
  z.object({
    edit: z.literal("update-feature"),
    kind: z.enum(FEATURE_KINDS),
    id: z.string().min(1),
    feature: z.unknown(),
  }),
  z.object({
    edit: z.literal("remove-feature"),
    kind: z.enum(FEATURE_KINDS),
    id: z.string().min(1),
  }),
]) as z.ZodType<RecipeEdit>;

/** Machine-readable summary of the vocabulary, for the engine spec. */
export const RECIPE_EDIT_SPECS = [
  {
    edit: "add-feature",
    fields: ["kind", "feature", "index?"],
    summary:
      "Append (or insert at `index`) one feature into recipe.features[kind]. The feature is validated against that kind's schema; a colliding or missing id is made unique deterministically.",
  },
  {
    edit: "update-feature",
    fields: ["kind", "id", "feature"],
    summary:
      "Replace the feature with this id in place, keeping its array position. The replacement is schema-validated and keeps the same id.",
  },
  {
    edit: "remove-feature",
    fields: ["kind", "id"],
    summary: "Delete the feature with this id. Its inverse restores it at the same index.",
  },
] as const satisfies ReadonlyArray<{ edit: RecipeEdit["edit"]; fields: string[]; summary: string }>;

export class RecipeEditError extends Error {
  constructor(
    message: string,
    readonly editIndex: number,
  ) {
    super(`edit[${editIndex}]: ${message}`);
    this.name = "RecipeEditError";
  }
}

// ---------------------------------------------------------------------------
// Footprints
// ---------------------------------------------------------------------------

/**
 * World-space XZ bounds of the ground a feature actually changes.
 *
 * Y is deliberately absent: the mesh cache is keyed per XZ cell
 * (`world:cx_cz:lodStep`), so a column is the finest unit invalidation can
 * address, and heightfield features (towns, roads, rivers, canyons) have no
 * meaningful vertical bound anyway.
 */
export interface Footprint {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

function pointsBounds(points: readonly (readonly number[])[], pad: number): Footprint {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of points) {
    // 2D polylines are [x, z]; tunnels are [x, y, z].
    const x = p[0]!;
    const z = p.length >= 3 ? p[2]! : p[1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The XZ region a feature influences, blend margin INCLUDED.
 *
 * The margin is the whole point. A town's `radius` is where it is fully
 * flat, but `falloff` is where it stops disagreeing with natural terrain;
 * invalidate only the radius and the ring between the two keeps a stale mesh
 * and shows a seam. Same for a river's `bank`, a road's `shoulder`, a
 * canyon's `rim` and a blob's `falloff`.
 *
 * Returns null for features with no terrain effect (a POI is a labelled
 * point — it places things, it does not move ground).
 */
export function featureFootprint(kind: FeatureKind, feature: unknown): Footprint | null {
  const f = feature as AnyFeature;
  switch (kind) {
    case "pois":
      return null;
    case "towns": {
      const c = f["center"] as [number, number];
      const reach = num(f["radius"], 0) + num(f["falloff"], 35);
      return { x0: c[0] - reach, z0: c[1] - reach, x1: c[0] + reach, z1: c[1] + reach };
    }
    case "lakes": {
      const bank = num(f["bank"], 18);
      const polygon = f["polygon"] as number[][] | undefined;
      if (polygon && polygon.length >= 3) return pointsBounds(polygon, bank);
      const c = f["center"] as [number, number];
      const reach = num(f["radius"], 60) + bank;
      return { x0: c[0] - reach, z0: c[1] - reach, x1: c[0] + reach, z1: c[1] + reach };
    }
    case "blobs": {
      const c = f["center"] as [number, number, number];
      const r = num(f["radius"], 0);
      const falloff = num(f["falloff"], 4);
      // A capsule leans on `topRadius` at its far end; take the widest.
      const widest = Math.max(r, num(f["topRadius"], r));
      const rx = widest * num(f["scaleX"], 1) + falloff;
      const rz = widest * num(f["scaleZ"], 1) + falloff;
      return { x0: c[0] - rx, z0: c[2] - rz, x1: c[0] + rx, z1: c[2] + rz };
    }
    case "tunnels": {
      const r = Math.max(num(f["radius"], 3), num(f["endRadius"], 0));
      return pointsBounds(f["points"] as number[][], r);
    }
    case "rivers":
      return pointsBounds(f["points"] as number[][], num(f["width"], 8) / 2 + num(f["bank"], 14));
    case "roads":
      // the embankment band is regraded too, and scatter keeps a clearance
      // beyond the shoulder: a path edit has to re-cook the cells whose props
      // it just invalidated, not only the ones it re-shaped
      return pointsBounds(f["points"] as number[][], num(f["width"], 6) / 2 + num(f["shoulder"], 8) + num(f["smooth"], 0) + 12);
    case "canyons":
      return pointsBounds(f["points"] as number[][], num(f["width"], 70) / 2 + num(f["rim"], 60));
  }
}

/**
 * The cells a set of footprints covers — exactly what has to be re-meshed
 * (and whose cached meshes must be dropped) for the edit to become visible.
 * Deduplicated; deterministic order.
 */
export function cellsForFootprints(
  cellSize: number,
  footprints: readonly Footprint[],
): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const fp of footprints) {
    for (const cell of cellsInRect(cellSize, fp.x0, fp.z0, fp.x1, fp.z1)) {
      const key = `${cell[0]}_${cell[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cell);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Every feature schema defaults `id` to its kind ("blob", "town", …), so a
 * batch that adds three blobs would otherwise produce three features called
 * "blob" and make `update`/`remove` ambiguous. Suffix deterministically
 * until free — the same batch on the same recipe always lands the same ids.
 */
function uniqueId(taken: ReadonlySet<string>, desired: string): string {
  if (!taken.has(desired)) return desired;
  for (let n = 2; ; n++) {
    const candidate = `${desired}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface RecipeEditResult {
  /** A new recipe; the input is never mutated. */
  recipe: WorldRecipe;
  /** Applying these (in order) to `recipe` restores the input recipe. */
  inverse: RecipeEdit[];
  /**
   * Ground changed by the batch — for an update, both the old and the new
   * footprint, since the feature may have moved.
   */
  touched: Footprint[];
  /** Ids of features added by the batch, in order, after uniquing. */
  added: string[];
}

/**
 * Apply a batch of edits to a world recipe.
 *
 * Atomic: an invalid edit throws `RecipeEditError` and the caller's recipe
 * is untouched (work happens on a copy). Every feature is validated against
 * its own schema before it lands, so a recipe can never be left holding
 * something the field sampler cannot read.
 */
export function applyRecipeEdits(recipe: WorldRecipe, edits: readonly RecipeEdit[]): RecipeEditResult {
  // Shallow-copy down to the feature arrays; nothing else is touched, and
  // the feature objects themselves are replaced rather than mutated.
  const features = { ...recipe.features } as Record<FeatureKind, AnyFeature[]>;
  for (const kind of FEATURE_KINDS) features[kind] = [...(features[kind] ?? [])];

  const inverse: RecipeEdit[] = [];
  const touched: Footprint[] = [];
  const added: string[] = [];

  const pushFootprint = (kind: FeatureKind, feature: unknown): void => {
    const fp = featureFootprint(kind, feature);
    if (fp) touched.push(fp);
  };

  edits.forEach((edit, i) => {
    const list = features[edit.kind];
    if (!list) throw new RecipeEditError(`unknown feature kind "${edit.kind}"`, i);
    const schema = FEATURE_SCHEMAS[edit.kind];

    if (edit.edit === "add-feature") {
      const parsed = schema.safeParse(edit.feature);
      if (!parsed.success) {
        throw new RecipeEditError(`invalid ${edit.kind} feature: ${parsed.error.issues[0]?.message ?? "schema error"}`, i);
      }
      const feature = parsed.data as AnyFeature;
      const taken = new Set(list.map((f) => f.id));
      feature.id = uniqueId(taken, feature.id);

      const at = edit.index === undefined ? list.length : Math.min(edit.index, list.length);
      list.splice(at, 0, feature);
      added.push(feature.id);
      pushFootprint(edit.kind, feature);
      // Undo an insert by removing what we just inserted.
      inverse.unshift({ edit: "remove-feature", kind: edit.kind, id: feature.id });
      return;
    }

    const at = list.findIndex((f) => f.id === edit.id);
    if (at < 0) throw new RecipeEditError(`no ${edit.kind} feature with id "${edit.id}"`, i);
    const previous = list[at]!;

    if (edit.edit === "remove-feature") {
      list.splice(at, 1);
      pushFootprint(edit.kind, previous);
      // Restore at the same index: feature order is evaluation order.
      inverse.unshift({ edit: "add-feature", kind: edit.kind, feature: previous, index: at });
      return;
    }

    const parsed = schema.safeParse(edit.feature);
    if (!parsed.success) {
      throw new RecipeEditError(`invalid ${edit.kind} feature: ${parsed.error.issues[0]?.message ?? "schema error"}`, i);
    }
    const next = parsed.data as AnyFeature;
    // An update never renames: the id is the handle the caller still holds.
    next.id = previous.id;
    list[at] = next;
    // The feature may have MOVED, so both the ground it left and the ground
    // it arrived on are stale.
    pushFootprint(edit.kind, previous);
    pushFootprint(edit.kind, next);
    inverse.unshift({ edit: "update-feature", kind: edit.kind, id: previous.id, feature: previous });
  });

  return {
    recipe: { ...recipe, features: features as WorldRecipe["features"] },
    inverse,
    touched,
    added,
  };
}

/** Cells a whole edit result invalidated — `cellsForFootprints` over its `touched`. */
export function cellsForEdits(recipe: WorldRecipe, result: RecipeEditResult): [number, number][] {
  return cellsForFootprints(recipe.cellSize, result.touched);
}
