/**
 * The stamp a worldgen stage leaves in `recipe.pipeline` when it writes (worldgen.mts writeRecipe).
 *
 * A stage that changed something is stamped now. One that changed NOTHING keeps its stamp, so re-running it does not
 * make everything downstream STALE — unless a stage it reads was re-run after that stamp: then this run re-checked its
 * output against the new upstream (pinned towns after a rivers re-run) and the stamp moves to just past the newest
 * such stage. Still earlier than anything stamped later, so nothing downstream goes stale, and the row stops reading
 * STALE forever (`status` compares stamps).
 */
export function stageStamp(had: string | undefined, depStamps: (string | undefined)[], unchanged: boolean, now: Date = new Date()): { stamp: string; moved: boolean } {
  if (!unchanged || !had) return { stamp: now.toISOString(), moved: false };
  const newest = Math.max(0, ...depStamps.map((d) => Date.parse(d ?? "") || 0));
  if (newest > Date.parse(had)) return { stamp: new Date(newest + 1).toISOString(), moved: true };
  return { stamp: had, moved: false };
}
