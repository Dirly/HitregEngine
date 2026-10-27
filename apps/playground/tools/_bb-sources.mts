/**
 * Blockbench intake completeness: every named element and group of a project's Blockbench sources
 * (`<project>/source/blockbench/*.bbmodel`) is either CUT into a catalogued prop or SKIPPED with a reason.
 *
 * Why (2026-10-21): Dungeon.bbmodel's `Skull` / `SkullCandle` sat uncatalogued for weeks while its brazier, cages and
 * pikes were cut — nobody had a list of what a source holds that the catalogue does not.
 *
 * Coverage comes from two places:
 *  - catalog rows that name their source piece: `sourceModel` (contains the .bbmodel file name) + `sourceElement` /
 *    `sourceGroup`, or a `tool` line with `--element <name>` / `--group <name>`;
 *  - `<project>/authoring/blockbench-sources.json`: { "<file>.bbmodel": { "cut": { "<name>": "<prefab id>" },
 *    "skip": { "<name>": "<why>" }, "skipFile": "<why>" } } for pieces cut before rows named them, kit/character parts,
 *    and whole files that are not prop sources.
 * A covered GROUP covers everything inside it. Generic geometry names (mesh, cube, sphere, torus, cylinder, plane,
 * groupN) are not units on their own: they are reported through the group that holds them, or by their index when
 * loose at the root.
 */
import fs from "node:fs";
import path from "node:path";

export interface BbUnit { name: string; kind: "group" | "element"; path: string[] }
export interface SourceCuts { cut?: Record<string, string>; skip?: Record<string, string>; skipFile?: string }

const GENERIC = /^(mesh|cube|sphere|torus|cylinder|plane|cone|group\d*|bone\d*|new ?group)$/i;
export const isGenericName = (n: string) => GENERIC.test(n.trim());

/** Every named unit of a .bbmodel (outliner order), with the group path above it. */
export function bbUnits(bb: any): BbUnit[] {
  const els = new Map<string, any>((bb.elements ?? []).map((e: any) => [e.uuid, e]));
  const groups = new Map<string, any>((bb.groups ?? []).map((g: any) => [g.uuid, g]));
  const out: BbUnit[] = [];
  const walk = (n: any, above: string[]) => {
    if (typeof n === "string") { const e = els.get(n); if (e?.name) out.push({ name: e.name, kind: "element", path: above }); return; }
    const name = groups.get(n.uuid)?.name ?? n.name ?? "group";
    out.push({ name, kind: "group", path: above });
    for (const c of n.children ?? []) walk(c, [...above, name]);
  };
  for (const n of bb.outliner ?? []) walk(n, []);
  return out;
}

/** The units nothing covers: not cut, not skipped, not inside a covered group. Generic names collapse into their group. */
export function uncutUnits(units: readonly BbUnit[], covered: ReadonlySet<string>): BbUnit[] {
  const has = (n: string) => covered.has(n.toLowerCase());
  const full = (u: BbUnit) => [...u.path, u.name].join("/").toLowerCase();
  const inside = (u: BbUnit, g: BbUnit) => u.path.length > g.path.length && (u.path.join("/").toLowerCase() + "/").startsWith(full(g) + "/");
  const seen = new Set<string>(), out: BbUnit[] = [];
  for (const u of units) {
    if (has(u.name) || u.path.some(has)) continue;
    // a generic piece inside a named group is that group's business
    if (isGenericName(u.name) && u.path.length) continue;
    // a CONTAINER group (it holds named pieces) is not a prop: its named pieces are the units. A group of generic
    // geometry only (a lantern of two meshes) is one unit by its own name.
    if (u.kind === "group" && units.some((v) => inside(v, u) && !isGenericName(v.name))) continue;
    const key = `${u.kind}:${full(u)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/** Names a set of catalog rows covers for one source file. */
export function rowCoverage(rows: readonly any[], file: string): string[] {
  const base = path.basename(file).toLowerCase(), names: string[] = [];
  for (const r of rows) {
    const src = String(r?.sourceModel ?? r?.source ?? "").toLowerCase(), tool = String(r?.tool ?? "");
    if (!src.includes(base) && !tool.toLowerCase().includes(base)) continue;
    for (const k of ["sourceElement", "sourceGroup"]) if (typeof r[k] === "string") names.push(r[k]);
    for (const m of tool.matchAll(/--(?:element|group)\s+("[^"]+"|\S+)/g)) names.push(m[1]!.replace(/"/g, ""));
  }
  return names;
}

export interface SourceReport { file: string; units: number; skipped?: string; uncut: BbUnit[] }

/** Walk every closure project's source/blockbench and report the uncut units. `catalogRows` = every catalog row known. */
export function blockbenchReport(projectDirs: readonly string[], catalogRows: readonly any[]): SourceReport[] {
  const reports: SourceReport[] = [];
  for (const dir of projectDirs) {
    const srcDir = path.join(dir, "source", "blockbench");
    if (!fs.existsSync(srcDir)) continue;
    const sideFile = path.join(dir, "authoring", "blockbench-sources.json");
    const side: Record<string, SourceCuts> = fs.existsSync(sideFile) ? JSON.parse(fs.readFileSync(sideFile, "utf8")) : {};
    for (const f of fs.readdirSync(srcDir).filter((x) => x.toLowerCase().endsWith(".bbmodel")).sort()) {
      const file = path.join(srcDir, f), cuts = side[f] ?? {};
      const units = bbUnits(JSON.parse(fs.readFileSync(file, "utf8")));
      if (cuts.skipFile) { reports.push({ file, units: units.length, skipped: cuts.skipFile, uncut: [] }); continue; }
      const covered = new Set([...rowCoverage(catalogRows, f), ...Object.keys(cuts.cut ?? {}), ...Object.keys(cuts.skip ?? {})].map((n) => n.toLowerCase()));
      reports.push({ file, units: units.length, uncut: uncutUnits(units, covered) });
    }
  }
  return reports;
}
