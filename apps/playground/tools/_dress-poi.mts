/**
 * Which POI a dressing plan dresses, and the ops that tag its installed entities `poi:<id>` — so poi-walk, site-sockets,
 * art-check and the zonegen gates see small-find dressing as the POI's own (an untagged dressing root belonged to no one).
 * Used by `dress apply` (tags every entity it adds) and `dress retag` (tags dressing installed before this rule).
 *
 * Order: --poi flag > the socket map's site source (`<job dir> handoff (site ...)`, written by site-sockets) when it
 * names a job > the longest POI job id the plan id equals or starts with (`<poi>-<area>`). Null when nothing matches.
 */
import fs from "node:fs";
import path from "node:path";

/** Every POI job id of a project: projects/<p>/authoring/zonegen/<world>/zones/<zone>/pois/<id> directory names. */
export function poiJobIds(projectDir: string): string[] {
  const out = new Set<string>();
  const zg = path.join(projectDir, "authoring", "zonegen");
  const dirs = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
  for (const w of dirs(zg)) for (const z of dirs(path.join(zg, w, "zones"))) for (const p of dirs(path.join(zg, w, "zones", z, "pois"))) out.add(p);
  return [...out].sort();
}

/** The POI a plan dresses (see the header for the order), or null. */
export function dressPoiId(o: { planId: string; mapSource?: string | null; flag?: string | null; jobIds: readonly string[] }): string | null {
  if (o.flag) return o.flag;
  const jobs = new Set(o.jobIds);
  const m = /^(.*?)\s+handoff \(site /.exec(o.mapSource ?? "");
  if (m) { const id = path.basename(m[1]!.replace(/\\/g, "/")); if (jobs.has(id)) return id; }
  let best: string | null = null;
  for (const id of jobs) if ((o.planId === id || o.planId.startsWith(`${id}-`)) && (!best || id.length > best.length)) best = id;
  return best;
}

type Ents = Record<string, { tags?: string[]; parent?: string | null } | undefined>;
/**
 * `set-tags` ops adding `poi:<poiId>` to every scene entity of dressing plan `planId` (tagged `dress:<planId>`) that lacks
 * it. An entity already tagged for ANOTHER poi is left alone and reported (a plan never steals another place's props).
 */
export function retagOps(ents: Ents, planId: string, poiId: string): { ops: { op: "set-tags"; id: string; tags: string[] }[]; conflicts: string[] } {
  const ops: { op: "set-tags"; id: string; tags: string[] }[] = [], conflicts: string[] = [];
  const want = `poi:${poiId}`;
  for (const [id, e] of Object.entries(ents)) {
    const tags = e?.tags ?? [];
    if (!tags.includes(`dress:${planId}`) || tags.includes(want)) continue;
    if (tags.some((t) => t.startsWith("poi:"))) { conflicts.push(id); continue; }
    ops.push({ op: "set-tags", id, tags: [...tags, want] });
  }
  return { ops, conflicts };
}
