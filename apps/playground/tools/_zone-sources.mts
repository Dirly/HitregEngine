/**
 * Where a zonegen-built world keeps what the worldgen status rows look for (2026-10-21, WORLD-GATES):
 *  - its creatures: each zone's installed `zonegen populate` (zones/<z>/populate/installed-<world>.json), NOT worldgen's
 *    generic camps — `worldgen spawn` would pile camps onto those populations, so the `spawn` row reads n/a;
 *  - its stories: each zone's zonegen brief (zones/<z>/brief.json: `story`, else its `premise`), until
 *    `zonegen stories` copies them into the recipe regions.
 * Paths: <projectDir>/authoring/zonegen/<world>/zones/<zone>/.
 */
import fs from "node:fs";
import path from "node:path";

export const zonesDir = (projectDir: string, world: string): string => path.join(projectDir, "authoring", "zonegen", world, "zones");
const zoneIds = (projectDir: string, world: string): string[] => {
  const d = zonesDir(projectDir, world);
  return fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
};

/** Zones whose zonegen population is installed in the world (populate/installed-<world>.json present). */
export function zonegenPopulated(projectDir: string, world: string): string[] {
  return zoneIds(projectDir, world).filter((z) => fs.existsSync(path.join(zonesDir(projectDir, world), z, "populate", `installed-${world}.json`)));
}

/** A zonegen brief's story text: `story`, else `premise` ("" when neither). */
export function briefStory(brief: unknown): string {
  const b = (brief ?? {}) as { story?: unknown; premise?: unknown };
  const s = typeof b.story === "string" && b.story.trim() ? b.story : typeof b.premise === "string" ? b.premise : "";
  return s.trim();
}

/** zone id -> its brief's story, for every zone with a non-empty one. */
export function briefStories(projectDir: string, world: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const z of zoneIds(projectDir, world)) {
    const f = path.join(zonesDir(projectDir, world), z, "brief.json");
    if (!fs.existsSync(f)) continue;
    try { const s = briefStory(JSON.parse(fs.readFileSync(f, "utf8"))); if (s) out.set(z, s); } catch { /* unreadable brief: no story */ }
  }
  return out;
}

/** The `zone-stories` row: every wild zone told, by its recipe story or its zonegen brief. null = ok. */
export function zoneStoriesMissing(regions: ReadonlyArray<{ id: string; story: string; within?: string | null }>, briefs: ReadonlyMap<string, string>): string | null {
  const wild = regions.filter((z) => !z.within);
  const untold = wild.filter((z) => !z.story.trim() && !briefs.get(z.id));
  return untold.length ? `${untold.length} of ${wild.length} zones have no story (recipe region or zonegen brief)` : null;
}

/** Copy brief stories into recipe regions: the edited regions and the inverse ({ zone: story before }). Idempotent. */
export function storiesIntoRegions(regions: Array<{ id: string; story: string }>, briefs: ReadonlyMap<string, string>): { changed: string[]; inverse: Record<string, string> } {
  const changed: string[] = [], inverse: Record<string, string> = {};
  for (const r of regions) {
    const s = briefs.get(r.id);
    if (!s || r.story === s) continue;
    inverse[r.id] = r.story;
    r.story = s;
    changed.push(r.id);
  }
  return { changed, inverse };
}
