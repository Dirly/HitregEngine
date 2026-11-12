/**
 * Site paths survive `worldgen paths` (t2-town 2026-11-12, coordinator ruling: "paths deleting existing site paths is a
 * TOOL BUG"). `worldgen paths --to "x,z=name"` cuts links to destinations that are not towns, ids
 * `path-<a>-<b>` where an end is `site-<name>`. A later plain `worldgen paths` (a new town joining the network) used to
 * drop every `path-*` and re-cut only the towns, so the seven red-dial / weeping-sun site links vanished and every place
 * on them went STALE. Now: a site path is KEPT unless this run re-cuts one of its sites (`--to` names it again) or one of
 * its town ends no longer exists; a kept path that no longer touches anything at either end (its town gate moved, the
 * road it joined was re-cut away) is dropped and named, so the owner re-cuts it with `--to`.
 */

export type XZ = readonly [number, number];
export interface SitePathRoad { id: string; points: readonly (readonly number[])[] }

/** The two place ids a `path-<a>-<b>[.jN|.sN]` id names (towns by their recipe id, sites as `site-<name>`); null if not a path id. */
export function pathEnds(id: string, townIds: readonly string[]): [string, string] | null {
  if (!id.startsWith("path-")) return null;
  const rest = id.slice(5).replace(/(\.[sj]\d+)+$/, "");
  const ok = (s: string) => townIds.includes(s) || (s.startsWith("site-") && s.length > 5);
  let found: [string, string] | null = null;
  for (let i = rest.indexOf("-"); i > 0; i = rest.indexOf("-", i + 1)) {
    const a = rest.slice(0, i), b = rest.slice(i + 1);
    if (!ok(a) || !ok(b)) continue;
    // prefer the split whose ends are both whole ids (a town id, or a site name with no town id inside it)
    if (!found || townIds.includes(b) || townIds.includes(a)) found = [a, b];
    if (townIds.includes(a) || townIds.includes(b)) break;
  }
  return found;
}

export interface SitePathPick<R extends SitePathRoad> { keep: R[]; drop: { id: string; why: string }[] }

/**
 * Which existing `path-*` roads a `worldgen paths` run keeps BEFORE routing: every site path whose sites are not re-cut
 * by this run (`recut` = the run's `--to` site ids) and whose town ends all still exist. Town-to-town paths are never
 * kept (the stage re-cuts them).
 */
export function keepSitePaths<R extends SitePathRoad>(roads: readonly R[], townIds: readonly string[], recut: ReadonlySet<string>): SitePathPick<R> {
  const keep: R[] = [], drop: { id: string; why: string }[] = [];
  for (const r of roads) {
    const ends = pathEnds(r.id, townIds) ?? pathEnds(r.id, [...townIds, ...siteLikeTowns(r.id)]);
    if (!ends || !ends.some((e) => e.startsWith("site-"))) continue;
    const again = ends.find((e) => recut.has(e));
    if (again) { drop.push({ id: r.id, why: `${again} is re-cut by this run (--to)` }); continue; }
    const gone = ends.find((e) => !e.startsWith("site-") && !townIds.includes(e));
    if (gone) { drop.push({ id: r.id, why: `its town ${gone} is no longer in the recipe` }); continue; }
    keep.push(r);
  }
  return { keep, drop };
}

/** An id whose town end is not a recipe town (it was removed): the token after `site-...-` is unknown; tried as-is. */
function siteLikeTowns(id: string): string[] {
  const rest = id.slice(5).replace(/(\.[sj]\d+)+$/, "");
  const m = rest.match(/^(.*?)-(site-.+)$/);
  return m && !m[1]!.startsWith("site-") ? [m[1]!] : [];
}

const segDist = (p: XZ, a: readonly number[], b: readonly number[]): number => {
  const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]!) * dx + (p[1] - a[1]!) * dz) / l2)) : 0;
  return Math.hypot(p[0] - (a[0]! + dx * t), p[1] - (a[1]! + dz * t));
};

/**
 * AFTER routing: a kept site path whose pieces touch nothing at any end (no other road within `reach` m, no anchor such as
 * a town gate or a site centre) lost what it joined — dropped and named. Pieces of one link (`.jN` / `.sN`) count as
 * touching each other.
 */
export function strandedSitePaths<R extends SitePathRoad>(kept: readonly R[], network: readonly SitePathRoad[], anchors: readonly XZ[], reach = 10): { keep: R[]; drop: { id: string; why: string }[] } {
  const family = (id: string) => id.replace(/(\.[sj]\d+)+$/, "");
  const keep: R[] = [], drop: { id: string; why: string }[] = [];
  for (const r of kept) {
    const ends = [r.points[0], r.points[r.points.length - 1]].filter(Boolean).map((p) => [p![0]!, p![1]!] as XZ);
    const touches = ends.some((e) =>
      anchors.some((a) => Math.hypot(a[0] - e[0], a[1] - e[1]) <= reach * 2) ||
      network.some((o) => o.id !== r.id && (family(o.id) === family(r.id) || o.points.some((p, i) => i > 0 && segDist(e, o.points[i - 1]!, p) <= reach))));
    if (touches) keep.push(r);
    else drop.push({ id: r.id, why: "neither end meets a road, a gate or its site any more (a changed endpoint): re-cut it with --to" });
  }
  return { keep, drop };
}
