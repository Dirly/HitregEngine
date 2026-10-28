/**
 * town-palette — a town's wall/roof PALETTE (MMO/WFC KIT-RULES 37): assign one kit style per lot, then check the mix.
 *
 *   npx tsx tools/town-palette.mts assign --project <p> --town <name> [--palette firstshore] [--dry]
 *   npx tsx tools/town-palette.mts check  --project <p> --town <name> [--palette firstshore] [--results <build>_results.json]
 *   (either command also takes --plan <file> [--layout <file>] for a plan outside a project, e.g. a kit test street)
 *
 * A palette is MMO/WFC/styles/palettes/<name>.json (HITREG_PALETTES_DIR overrides): registered styles sharing one theme
 * folder, each with a weight (timber-frame 50 / stucco 25 / plank 15 / stone 10), a `stone_style` and the building
 * `stone_types` (banks, chapels, towers ...) that always take it. Derek 2026-10-28: "some wood, some stone, no two
 * neighbours alike".
 *
 * assign: writes `request.style` (and `request.seed`) into every building of authoring/towns/<town>-plan.json that does
 *   not already carry a style, drawn from the palette by a per-lot hash of town + lot id (the same plan always gives the
 *   same picks), the weights balanced by a greedy quota so a 20-lot town lands within a few points of the weights. A
 *   lot's own `style` is never overwritten; `--force` re-draws every lot the palette owns.
 * check (the gate, exit 1 on any finding):
 *   - no two ADJACENT lots (ground outlines within 6 m in <town>-layout.json; plan order when no layout exists yet) share
 *     wall material AND roof family;
 *   - every palette style's share of the palette lots is within +-15 points of its weight;
 *   - with --results (wfc/build.py's <town>_results.json): the distinct-shell gate — no two lots with the same `shell`
 *     digest, and every lot's seed differs from every other's.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const opt = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };
const flag = (name: string): boolean => argv.includes(`--${name}`);
const WFC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../MMO/WFC");
const PALETTES_DIR = process.env.HITREG_PALETTES_DIR ?? path.join(WFC, "styles", "palettes");
const STYLES_DIR = process.env.HITREG_STYLES_DIR ?? path.join(WFC, "styles");

export interface PaletteEntry { style: string; weight: number; wall?: string; roof?: string }
export interface Palette { name: string; theme?: string; styles: PaletteEntry[]; stone_style?: string; stone_types?: string[] }
export interface PlanBuilding { id: string; type?: string; style?: string; request: { name?: string; style?: string; seed?: number; system?: string; roof?: string; size: [number, number]; features?: string[] } }

/** Deterministic 0..1 from a string (sha1), the same on every run. */
export function hash01(s: string): number { return parseInt(crypto.createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0x100000000; }

/** A style's wall material and roof family, from the palette entry else the style file (its `extends` chain). */
export function lookOf(style: string, pal: Palette, stylesDir = STYLES_DIR): { wall: string; roof: string } {
  const e = pal.styles.find((s) => s.style === style);
  if (e?.wall && e?.roof) return { wall: e.wall, roof: e.roof };
  const load = (n: string): Record<string, unknown> => {
    const f = path.join(stylesDir, `${n}.json`);
    if (!fs.existsSync(f)) return {};
    const st = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
    const base = (st.extends as string | undefined) ?? (n !== "default" ? "default" : undefined);
    const merged = base ? { ...load(base) } : {};
    for (const [k, v] of Object.entries(st)) merged[k] = typeof v === "object" && v && !Array.isArray(v) && typeof merged[k] === "object" ? { ...(merged[k] as object), ...(v as object) } : v;
    return merged;
  };
  const st = load(style);
  return { wall: e?.wall ?? ((st.walls as { material?: string } | undefined)?.material ?? "timber-frame"), roof: e?.roof ?? ((st.roof as { family?: string } | undefined)?.family ?? "gable45") };
}

/** Lots the palette owns (not stone-typed, no hand-set style) get a style: a per-lot hash orders them, a greedy quota keeps
 *  the shares at the weights. Pure: returns id -> style for every building. */
export function assignStyles(buildings: PlanBuilding[], pal: Palette, town: string, force = false): Map<string, string> {
  const out = new Map<string, string>();
  const stoneTypes = new Set(pal.stone_types ?? []);
  const free: PlanBuilding[] = [];
  for (const b of buildings) {
    const own = b.request.style ?? b.style;
    if (own && !force && !(pal.styles.some((s) => s.style === own) && force)) { out.set(b.id, own); continue; }
    if (own && !force) { out.set(b.id, own); continue; }
    const t = (b.type ?? b.id).toLowerCase();
    if (pal.stone_style && (b.request.system === "stone" || [...stoneTypes].some((k) => t.includes(k)))) { out.set(b.id, pal.stone_style); continue; }
    free.push(b);
  }
  const total = pal.styles.reduce((a, s) => a + s.weight, 0);
  const quota = pal.styles.map((s) => ({ style: s.style, want: (s.weight / total) * free.length, got: 0 }));
  // hash order: each lot picks the style furthest below its quota among those its hash favours; ties by the hash
  for (const b of [...free].sort((p, q) => hash01(`${town}:${p.id}`) - hash01(`${town}:${q.id}`))) {
    const h = hash01(`${town}:${b.id}:style`);
    let best = quota[0]!, bestScore = -Infinity;
    for (const q of quota) {
      const deficit = q.want - q.got;          // positive: this style is owed lots
      const score = deficit + 0.6 * (hash01(`${b.id}:${q.style}`) - 0.5) + (h < 0.5 ? 0 : 0.01);
      if (score > bestScore) { bestScore = score; best = q; }
    }
    best.got++; out.set(b.id, best.style);
  }
  return out;
}

type P = [number, number];
function segDist(p: P, a: P, b: P): number {
  const vx = b[0] - a[0], vz = b[1] - a[1], wx = p[0] - a[0], wz = p[1] - a[1];
  const l2 = vx * vx + vz * vz, t = l2 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vz));
}
/** Smallest gap between two ground outlines (vertex to edge, both ways). */
export function outlineGap(a: P[], b: P[]): number {
  let d = Infinity;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) d = Math.min(d, segDist(a[i]!, b[j]!, b[(j + 1) % b.length]!), segDist(b[j]!, a[i]!, a[(i + 1) % a.length]!));
  return d;
}

/** Pairs of lots that are neighbours: ground outlines within `gap` m (layout), else consecutive in plan order. */
export function neighbours(buildings: PlanBuilding[], layout: { buildings?: { id: string; ground?: P[] }[] } | null, gap = 6): [string, string][] {
  const out: [string, string][] = [];
  const g = new Map((layout?.buildings ?? []).filter((b) => b.ground).map((b) => [b.id, b.ground!]));
  if (g.size) {
    const ids = [...g.keys()];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (outlineGap(g.get(ids[i]!)!, g.get(ids[j]!)!) <= gap) out.push([ids[i]!, ids[j]!]);
  } else for (let i = 0; i + 1 < buildings.length; i++) out.push([buildings[i]!.id, buildings[i + 1]!.id]);
  return out;
}

export interface CheckInput { buildings: PlanBuilding[]; styles: Map<string, string>; pal: Palette; pairs: [string, string][]; results?: { name: string; lot?: string | null; shell?: string | null; seed?: number }[]; lookOf?: (s: string) => { wall: string; roof: string } }
/** The gate's findings (empty = pass). Pure. */
export function paletteFindings(inp: CheckInput): string[] {
  const f: string[] = [];
  const look = inp.lookOf ?? ((s: string) => lookOf(s, inp.pal));
  for (const [a, b] of inp.pairs) {
    const sa = inp.styles.get(a), sb = inp.styles.get(b);
    if (!sa || !sb) continue;
    const la = look(sa), lb = look(sb);
    if (la.wall === lb.wall && la.roof === lb.roof) f.push(`adjacent ${a} (${sa}) and ${b} (${sb}) share wall ${la.wall} and roof ${la.roof}`);
  }
  const owned = inp.buildings.filter((b) => inp.pal.styles.some((s) => s.style === inp.styles.get(b.id)));
  const total = inp.pal.styles.reduce((x, s) => x + s.weight, 0);
  for (const s of inp.pal.styles) {
    const n = owned.filter((b) => inp.styles.get(b.id) === s.style).length;
    const share = owned.length ? (100 * n) / owned.length : 0, want = (100 * s.weight) / total;
    if (Math.abs(share - want) > 15) f.push(`${s.style}: ${n}/${owned.length} palette lots = ${share.toFixed(0)} %, the palette wants ${want.toFixed(0)} % (+-15)`);
  }
  if (inp.results) {
    const byLot = new Map(inp.results.map((r) => [r.lot ?? r.name, r]));
    const seen = new Map<string, string>();
    for (const b of inp.buildings) {
      const r = byLot.get(b.id);
      if (!r) { f.push(`${b.id}: no build result`); continue; }
      if (!r.shell) { f.push(`${b.id}: no shell digest (the build failed?)`); continue; }
      const prev = seen.get(r.shell);
      if (prev) f.push(`${b.id} and ${prev} are the same building (shell ${r.shell})`); else seen.set(r.shell, b.id);
    }
    const seeds = new Map<number, string>();
    for (const r of inp.results) if (r.seed !== undefined) { const p = seeds.get(r.seed); if (p) f.push(`${r.lot ?? r.name} and ${p} solved with the same seed ${r.seed}`); else seeds.set(r.seed, r.lot ?? r.name); }
  }
  return f;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const projectName = opt("project", ""), townName0 = opt("town", "");
  if (!["assign", "check"].includes(cmd) || (!opt("plan", "") && (!projectName || !townName0))) {
    console.error("usage: town-palette assign|check --project <p> --town <name> | --plan <file> [--layout <file>] [--palette <name>] [--results <file>] [--dry] [--force]");
    process.exit(2);
  }
  const projectDir = path.resolve("projects", projectName);
  const townsDir = path.join(projectDir, "authoring/towns");
  const planFile = opt("plan", "") ? path.resolve(opt("plan", "")) : path.join(townsDir, `${townName0}-plan.json`);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as { town?: string; palette?: string; buildings?: PlanBuilding[]; lots?: PlanBuilding[] };
  if (!plan.buildings) plan.buildings = plan.lots ?? [];       // a build.py town plan ({town, lots: [{id, at, rot, request}]}) works too
  const planB = plan as { town?: string; palette?: string; buildings: PlanBuilding[] };
  const townName = townName0 || plan.town || path.basename(planFile).replace(/-plan\.json$|\.json$/, "");
  const palName = opt("palette", plan.palette ?? "");
  if (!palName) { console.error(`${townName}: the plan names no "palette" and --palette was not given`); process.exit(2); }
  const pal = JSON.parse(fs.readFileSync(path.join(PALETTES_DIR, `${palName}.json`), "utf8")) as Palette;
  const layoutFile = opt("layout", "") ? path.resolve(opt("layout", "")) : path.join(townsDir, `${townName}-layout.json`);
  const layout = fs.existsSync(layoutFile) ? (JSON.parse(fs.readFileSync(layoutFile, "utf8")) as { buildings?: { id: string; ground?: P[] }[] }) : null;
  if (cmd === "assign") {
    const styles = assignStyles(planB.buildings, pal, townName, flag("force"));
    let changed = 0;
    for (const b of planB.buildings) {
      const s = styles.get(b.id)!;
      if (b.request.style !== s) { b.request.style = s; changed++; }
      if (b.request.seed === undefined) { b.request.seed = parseInt(crypto.createHash("sha1").update(`${townName}:${b.id}`).digest("hex").slice(0, 6), 16) % 100000; changed++; }
      console.log(`  ${b.id.padEnd(22)} ${s.padEnd(12)} seed ${b.request.seed}`);
    }
    plan.palette = palName;
    if (plan.lots) delete (plan as { buildings?: unknown }).buildings;
    if (!flag("dry")) { fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 1)}\n`); console.log(`palette ${palName}: ${changed} fields written to ${path.relative(process.cwd(), planFile)}`); }
    else console.log(`palette ${palName}: ${changed} fields would change (--dry)`);
  } else {
    const styles = new Map(planB.buildings.map((b) => [b.id, b.request.style ?? b.style ?? "default"]));
    const resultsFile = opt("results", "");
    const results = resultsFile ? (JSON.parse(fs.readFileSync(resultsFile, "utf8")) as CheckInput["results"]) : undefined;
    const pairs = neighbours(planB.buildings, layout);
    const f = paletteFindings({ buildings: planB.buildings, styles, pal, pairs, results });
    const counts = new Map<string, number>();
    for (const s of styles.values()) counts.set(s, (counts.get(s) ?? 0) + 1);
    console.log(`palette ${palName}: ${planB.buildings.length} lots, ${pairs.length} adjacent pairs (${layout ? "layout outlines <= 6 m" : "plan order; no layout yet"}): ${[...counts].map(([s, n]) => `${s} ${n}`).join(", ")}${results ? `; shells ${new Set(results.map((r) => r.shell)).size} distinct of ${results.length}` : ""}`);
    for (const x of f) console.log(`  ! ${x}`);
    console.log(f.length ? `PALETTE FAILED (${f.length})` : "PALETTE OK");
    process.exit(f.length ? 1 : 0);
  }
}
