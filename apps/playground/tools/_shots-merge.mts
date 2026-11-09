/**
 * Merge a re-shoot of SOME views into a place's evidence run (place-build `shots --views <ids> --merge`).
 *
 * r-found 2026-10-31 (coordinator ruling): light-shots skips a spot that stalls past --spot-timeout, and on a busy machine
 * the far / aerial views of a big place stall in every run, a different set each time (Red Dial: read-2-421m, avenue,
 * blocks, arcade, aerial over three runs, 90 s and 240 s). A whole re-run then costs 20 minutes to lose another three. The
 * merge re-shoots only the missing views (at a long --spot-timeout) and folds their frames into the existing run: each
 * re-shot view's records REPLACE that view's old ones; every other view's records stay. The frames are overwritten in
 * place (same file names under evidence/<lab>/) and the wash verdict is judged again over the merged set.
 */

/** One shot record of a light-shots run (<stem>.json `shots[]`); only `spot` is read here, the rest rides along. */
export type ShotRecord = { spot: string } & Record<string, unknown>;
export type ShotRun = { shots?: ShotRecord[] } & Record<string, unknown>;

/**
 * The merged run: `base` with the records of every view in `views` replaced by `add`'s records for those views (a view
 * the re-shoot skipped again keeps nothing and stays missing). Top-level fields come from `base`, plus `merged`: when and
 * which views. `washVerdict` is dropped: the caller judges the merged frames again (never a stale verdict).
 */
export function mergeShotRuns(base: ShotRun, add: ShotRun, views: readonly string[], at = new Date().toISOString()): ShotRun & { merged: { at: string; views: string[]; got: string[] }[] } {
  const want = new Set(views);
  const got = [...new Set((add.shots ?? []).filter((s) => want.has(s.spot)).map((s) => s.spot))];
  const shots = [...(base.shots ?? []).filter((s) => !want.has(s.spot)), ...(add.shots ?? []).filter((s) => want.has(s.spot))];
  const { washVerdict: _drop, ...rest } = base as ShotRun & { washVerdict?: unknown };
  const prior = Array.isArray((base as { merged?: unknown }).merged) ? ((base as { merged: { at: string; views: string[]; got: string[] }[] }).merged) : [];
  // light-shots `blackFrames` ("<spot>@<hour>", failed renders): the re-shot views' entries come from the new run only
  const spotOf = (b: string) => b.replace(/@[^@]*$/, "");
  const blackFrames = [...(((base as { blackFrames?: string[] }).blackFrames ?? []).filter((b) => !want.has(spotOf(b)))), ...(((add as { blackFrames?: string[] }).blackFrames ?? []).filter((b) => want.has(spotOf(b))))];
  return { ...rest, shots, ...(blackFrames.length ? { blackFrames } : { blackFrames: undefined }), merged: [...prior, { at, views: [...views], got }] };
}

/** The views of `all` (views.json order) that have no record in `run`. */
export function missingViews(all: readonly string[], run: ShotRun): string[] {
  const shot = new Set((run.shots ?? []).map((s) => s.spot));
  return all.filter((n) => !shot.has(n));
}

/** The exact command that re-shoots `missing` and merges them (printed by the wash gate). */
export function mergeCommand(a: { world: string; project: string; zone: string; poi: string; lab?: string | null; port?: string | null }, missing: readonly string[]): string {
  return `node --max-old-space-size=6144 node_modules/tsx/dist/cli.mjs tools/place-build.mts shots ${a.world} --project ${a.project}${a.zone ? ` --zone ${a.zone}` : ""} --location ${a.poi}${a.lab ? ` --lab ${a.lab}` : ""} --views ${missing.join(",")} --merge --port ${a.port ?? "<port>"}`;
}
