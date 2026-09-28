import { z } from "zod";

/**
 * Which parts of one ubermesh may be shown together. A weapon's families need
 * no table (one blade, one guard); worn gear does: a player's headgear has
 * three helms that exclude each other, pieces that only exist on one helm
 * (a cheek guard modelled for Helm1), and pieces that hang off something
 * (a nose guard needs a helm or a hood to hang from). The table rides in the
 * model's glTF extras beside `parts` (unwrap-weapon writes it from the recipe),
 * so the creator and the equip path check a look against the model they draw.
 */
export const partRulesSchema = z
  .object({
    oneOf: z
      .array(z.array(z.string().min(1)).min(2))
      .default([])
      .describe("Groups of parts of which AT MOST one shows at a time: the three helms, the two nose guards."),
    requires: z
      .record(z.string().min(1), z.array(z.string().min(1)).min(1))
      .default({})
      .describe(
        "Part → parts of which at least ONE must also show: a helm's cheek guard needs that helm, a nose guard " +
          "needs something to hang from.",
      ),
    excludes: z
      .record(z.string().min(1), z.array(z.string().min(1)).min(1))
      .default({})
      .describe("Part → parts it may never show with, in either direction: a headband takes no nose guard."),
    hides: z
      .record(z.string().min(1), z.array(z.string().min(1)).min(1))
      .default({})
      .describe(
        "Part → parts of OTHER models worn with it that it covers, hidden while it shows: a helm hides the hair " +
          "ubermesh's styles, a mouth plate the beards, a full face cover the head's skin (it sits ON the head's " +
          "surface, so the two would z-fight). Names are the other models' own part names.",
      ),
  })
  .describe(
    "Which parts of an ubermesh may be worn together, carried in the model's extras as `rules` beside `parts`.",
  );

export type PartRules = z.infer<typeof partRulesSchema>;

/** Every part of other models that the shown `parts` cover (the union of their `hides`). */
export function partsHiddenBy(rules: PartRules, parts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of parts) for (const h of rules.hides[p] ?? []) out.add(h);
  return out;
}

/** Every rule a set of parts breaks, as sentences; empty = a valid look. */
export function partProblems(rules: PartRules, parts: readonly string[]): string[] {
  const on = new Set(parts);
  const out: string[] = [];
  for (const group of rules.oneOf) {
    const hit = group.filter((p) => on.has(p));
    if (hit.length > 1) out.push(`only one of ${group.join(", ")} (has ${hit.join(" + ")})`);
  }
  for (const [part, needs] of Object.entries(rules.requires)) {
    if (on.has(part) && !needs.some((n) => on.has(n))) out.push(`${part} needs one of ${needs.join(", ")}`);
  }
  const seen = new Set<string>();
  for (const [part, never] of Object.entries(rules.excludes)) {
    if (!on.has(part)) continue;
    for (const other of never) {
      const key = [part, other].sort().join("|");
      if (on.has(other) && !seen.has(key)) {
        seen.add(key);
        out.push(`${part} cannot go with ${other}`);
      }
    }
  }
  return out;
}
