/**
 * props — prop intake for the dressing system: measure, declare, validate,
 * index and serve props. Every catalogued prop prefab's ROOT carries a
 * `dressing` component (packages/core/src/components/dressing.ts) compiled
 * from a per-collection sidecar (`dressing.json`, registered as the `dressing`
 * field of that collection in authoring/prop-catalogs.json). Placing agents
 * read ONLY `menu`; nobody reads full catalog records.
 *
 *   npx tsx tools/props.mts measure <prefab id> --project <p>
 *   npx tsx tools/props.mts suggest <prefab id> | --all [--catalog <path>]  (draft declaration from geometry)
 *   npx tsx tools/props.mts status [--catalog <path>] [--next] [--quiet]   (ok / STALE / MISSING per prop; exit 1 if any)
 *   npx tsx tools/props.mts sync                                           (sidecars -> prefab roots, idempotent)
 *   npx tsx tools/props.mts index                                          (authoring/dressing/prop-index.json)
 *   npx tsx tools/props.mts menu --room <role> [--wealth w] [--theme t] [--mount m] [--category c] [--fits tag] [--setting s] [--limit 60]
 *   npx tsx tools/props.mts menu --setting outdoor [--room camp|ruin|yard|quay|street|plaza] ...  (an outdoor site's list)
 *   npx tsx tools/props.mts menu --search <word>                           ("do we already have a barrel?": offered + exists-but-not-offered)
 *   ... --scale <class> --culture <c>   (any menu) only props made for that scale class (or `any`) and that people (or `any`);
 *       a room menu with --plan <plan file> takes them from the plan's `space` / room. Vocabulary: menu --vocabulary
 *   npx tsx tools/props.mts menu --rooms | --categories | --tags           (the vocabulary)
 *
 *   REUSE FIRST (tools/_prop-make.mts; each writes a catalogued prefab in a new collection, never edits the source):
 *   npx tsx tools/props.mts wrap <prefab> --id <coll/name> [--scale s] [--yaw deg] [--pitch deg] [--roll deg] [--decl '<json>']
 *                                    sized/posed wrapper: nests the source, foot re-seated at the origin (tent x1.5, a rack turned to +Z)
 *   npx tsx tools/props.mts variant <prefab> --id <coll/name> --material <id> | --art <png> [--part <entity,...>] [--triplanar <m/tile>]
 *                                    same model(s), new material or art (--triplanar projects tiling art over atlas UVs in metres)
 *   npx tsx tools/props.mts compose <recipe.json>                          (props + models + primitives + alpha cards -> one prefab;
 *                                    REFUSED when its prefab parts mix cultures or scales, or a part is resized to stand in)
 *   npx tsx tools/props.mts request add --name <thing> --culture <c> --scale <s> --for <place> [--why text] | request [--all]
 *                                    the project's prop-request list by culture (authoring/dressing/prop-requests.json)
 *   npx tsx tools/props.mts dupes [<new prefab id>...]                     (DUPLICATE of <existing id>; exit 1 when ids are given and one is)
 *   npx tsx tools/props.mts menu --map <map id> --room <room id> [--role r] [--wealth w] [--all]
 *                                    ROOM-AWARE: only what physically fits that room (under its ceiling, within its cover ceiling,
 *                                    a free wall stretch long enough when it needs a wall), with use, wall need, and each set's shape
 *   npx tsx tools/props.mts report                                         (authoring/dressing/prop-report.md: every prop's in-game size,
 *                                                                           real size + scale used, mount, flags, texel density)
 *   npx tsx tools/props.mts proof <prefab id>                              (contact sheet PNG beside a 1.8 m figure)
 *   npx tsx tools/props.mts reskin-plan [--json]                           (LOW texel density props: size needed, UV fitness, route a/b/c)
 *   npx tsx tools/props.mts reskin <prefab id> --route a|b|c [--role wood|stone] [--art <png>]   (one kit prop to the target)
 *
 * Run from apps/playground. --project defaults to voxel-demo.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { applyOps, ComponentRegistry, registerCoreComponents, dressingSchema, dressingSetSchema, dressingOrigin, isLooseClutter, type DressingData } from "@hitreg/core";
import { mergeVocabulary, scaleFits, cultureFits, dressingPlanSchema, type DressingVocabulary } from "@hitreg/core";
import { socketMapSchema, placeableFloor, roomBudget, standStretches, describeSetShape, HEAD_STEP } from "@hitreg/core";
import { locate, prefabGeometry, measure, findSurfaces, supportBelow, readJson, prefabFile, type PropGeometry, type Measure, type V3 } from "./_prop-geometry.mts";
import { closure, PROJECTS } from "./_closure.mjs";
import { kindSizes, realSizeIssue, type KindSize } from "./_prop-real-size.mts";
import { addRequest, compositeFaults, readRequests, requestsFile } from "./_prop-composite-guard.mts";
import { texelDensity, clearGeometryCaches, type Density, type TexInfo, type PixelPage } from "./_prop-geometry.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOMS = ["bedroom", "kitchen", "hall", "tavern", "shop", "workshop", "storage", "office", "chapel", "cellar", "street", "plaza", "quay", "yard", "camp", "ruin", "dungeon", "cave-mouth", "path", "shore"];
export const OUTDOOR_ROOMS = new Set(["street", "plaza", "quay", "yard", "camp", "ruin", "cave-mouth", "path", "shore"]);
export const CATEGORIES = ["furniture", "storage", "bedding", "light", "tableware", "document", "tool", "decor", "trade", "sacred", "street"];

// ------------------------------------------------------------------ args ----
const argv = process.argv.slice(2);
const cmd = argv[0];
const positional: string[] = [];
const flags: Record<string, string | true> = {};
const BOOLEAN = new Set(["vocabulary", "json", "all", "sheet", "compact", "next", "quiet", "rooms", "categories", "tags", "surfaces", "force"]);
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && !BOOLEAN.has(a.slice(2))) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
  } else positional.push(a);
}
const flag = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
/** Scale classes + cultures: core's DRESSING_VOCABULARY merged with this project's authoring/dressing/vocabulary.json (data, not code). */
function vocabulary(): DressingVocabulary {
  const f = proj("authoring/dressing/vocabulary.json");
  return fs.existsSync(f) ? mergeVocabulary(readJson(f)) : mergeVocabulary();
}
const projectName = flag("project") ?? "proving";
const PROJECT = path.resolve(HERE, "..", "projects", projectName);
const ASSETS = path.join(PROJECT, "assets");
const INDEX = "authoring/prop-catalogs.json";
/**
 * The project and its dependsOn closure (a world, then world-kit, then foundation): READS look through
 * all of them — catalogs, sidecars, sets, plans, prefabs — the way the running game resolves assets;
 * WRITES (index, report, new props) go to --project.
 */
const ROOTS: string[] = closure(projectName).map((p: string) => path.join(PROJECTS, p));
const proj = (rel: string): string => { for (const r of ROOTS) { const f = path.join(r, rel); if (fs.existsSync(f)) return f; } return path.join(PROJECT, rel); };

// -------------------------------------------------------------- catalogs ----
/** `shared`: a reusable collection (kits, supplied props, wrappers/variants/composites); otherwise a site's own. */
interface CatalogEntry { path: string; entries: string; prefabIds?: boolean; pathFields?: string[]; dressing?: string; dressingExempt?: string; shared?: boolean }
/** Prefab folders that hold no props at all (building cells, shells, characters): accounted for without a row each. */
interface ExemptFolder { folder: string; reason: string }
interface Owner { entry: CatalogEntry; row: any }
interface Decl { kind: "declared"; raw: any; sidecar: string } // raw = sidecar value (compact input)
interface Exempt { kind: "exempt"; reason: string; sidecar: string }

/** The project's texel-density standard: props are drawn at `target` texels/m; below `min` (median) is LOW. */
interface DensityStandard { target: number; min: number; note?: string }
type Registry = { version: number; catalogs: CatalogEntry[]; texelDensity?: DensityStandard; exemptFolders?: ExemptFolder[]; realSize?: { userHeight?: number; kinds?: Record<string, Partial<KindSize> | null> } };
/** Every closure project's prop-catalogs.json merged, own first; standards from the first that sets them. */
function mergedRegistry(): Registry {
  const out: Registry = { version: 1, catalogs: [], exemptFolders: [] };
  for (const r of ROOTS) {
    const file = path.join(r, INDEX);
    if (!fs.existsSync(file)) continue;
    const one = readJson(file) as Registry;
    for (const c of one.catalogs ?? []) if (!out.catalogs.some((o) => o.path === c.path && o.entries === c.entries)) out.catalogs.push(c);
    for (const e of one.exemptFolders ?? []) if (!out.exemptFolders!.some((o) => o.folder === e.folder)) out.exemptFolders!.push(e);
    out.texelDensity ??= one.texelDensity;
    out.realSize ??= one.realSize;
  }
  return out;
}
const registry = mergedRegistry();
/** Real size per kind: tools/prop-kind-sizes.json with the project's `realSize` over it. */
const KIND_SIZES = kindSizes(registry.realSize);
const STANDARD: DensityStandard | null = registry.texelDensity ?? null;
const docCache = new Map<string, any>();
const doc = (rel: string) => { if (!docCache.has(rel)) docCache.set(rel, readJson(proj(rel))); return docCache.get(rel); };

/** prefab id -> owning catalog rows, in registry order. */
function catalogued(only?: string): Map<string, Owner[]> {
  const out = new Map<string, Owner[]>();
  for (const entry of registry.catalogs) {
    if (only && entry.path !== only) continue;
    const rows = doc(entry.path)[entry.entries];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const paths = (entry.pathFields ?? []).map((f) => row[f]).filter((v: unknown) => typeof v === "string") as string[];
      if (entry.prefabIds && typeof row.id === "string") paths.push(`assets/prefabs/${row.id}.json`);
      for (const p of paths) {
        const m = /^assets\/prefabs\/(.+)\.json$/i.exec(p.replaceAll("\\", "/"));
        if (!m) continue;
        const list = out.get(m[1]) ?? [];
        if (!list.some((o) => o.entry === entry)) list.push({ entry, row });
        out.set(m[1], list);
      }
    }
  }
  return out;
}
function sidecar(rel: string): { version: number; props: Record<string, any> } {
  const file = proj(rel);
  if (!fs.existsSync(file)) return { version: 1, props: {} };
  return doc(rel);
}
/** The declaration (or exemption) for a prefab: the first owning collection that has one. */
function lookup(id: string, owners: Owner[]): Decl | Exempt | null {
  for (const { entry } of owners) {
    if (entry.dressing) {
      const v = sidecar(entry.dressing).props?.[id];
      if (v && typeof v.exempt === "string") return { kind: "exempt", reason: v.exempt, sidecar: entry.dressing };
      if (v) return { kind: "declared", raw: v, sidecar: entry.dressing };
    }
    if (entry.dressingExempt) return { kind: "exempt", reason: entry.dressingExempt, sidecar: entry.path };
  }
  return null;
}

// ------------------------------------------------------------- registry ----
const components = new ComponentRegistry();
registerCoreComponents(components);
const sha = (b: string | Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const stable = (v: unknown) => JSON.stringify(v);

// --------------------------------------------------------------- helpers ----
const geoCache = new Map<string, { geo: PropGeometry; m: Measure }>();
function geometry(id: string) {
  let hit = geoCache.get(id);
  if (!hit) { const geo = prefabGeometry(ASSETS, id); hit = { geo, m: measure(geo) }; geoCache.set(id, hit); }
  return hit;
}
const densCache = new Map<string, Density>();
function density(id: string): Density {
  let hit = densCache.get(id);
  if (!hit) {
    hit = texelDensity(geometry(id).geo, { pixels: pagePixels });
    // a triplanar material ignores the mesh's UVs (a variant laying tiling art over an atlas layout): its density is
    // the texture's width over the metres one tile spans
    const mats = new Set(geometry(id).geo.tris.map((t) => t.material).filter(Boolean) as string[]);
    const tri = [...mats].map((m) => { const f = locate(ASSETS, "materials", `${m}.json`); const j = fs.existsSync(f) ? readJson(f) : null; return j?.triplanar && j.map ? { j, f: locate(ASSETS, "textures", j.map) } : null; });
    if (mats.size && tri.every(Boolean) && tri.every((t) => fs.existsSync(t!.f))) {
      const px = fs.readFileSync(tri[0]!.f).readUInt32BE(16), v = px / tri[0]!.j.triplanarScale;
      hit = { ...hit, median: v, p10: v, texturedArea: hit.area, flatArea: 0 };
    }
    densCache.set(id, hit);
  }
  return hit;
}
let decode: ((b: Buffer) => { width: number; height: number; data: Uint8Array }) | null = null;
const pageCache = new Map<string, PixelPage | null>();
/** Decoded PNG pages (for blow-up detection); loaded once per page. */
function pagePixels(t: TexInfo): PixelPage | null {
  if (!t.file || !/\.png$/i.test(t.file) || !decode) return null;
  if (!pageCache.has(t.file)) { try { const p = decode(fs.readFileSync(t.file)); pageCache.set(t.file, { width: p.width, height: p.height, data: p.data }); } catch { pageCache.set(t.file, null); } }
  return pageCache.get(t.file)!;
}
/**
 * ok / LOW / HIGH / n/a against the project standard (n/a: nothing textured to judge). HIGH = finer than 1.2x the
 * target on a LARGE surface (25 m2 or more: a wall, a tower, a deck): beside town walls and terrain, smaller pixels
 * read as a different art style. Small props are hand-made finer on purpose and are never HIGH.
 */
function densityState(d: Density): "ok" | "LOW" | "HIGH" | "n/a" {
  if (!STANDARD || !Number.isFinite(d.median) || d.texturedArea < 0.25 * d.area) return "n/a";
  return d.median < STANDARD.min ? "LOW" : d.median > STANDARD.target * 1.2 && d.area >= 25 ? "HIGH" : "ok";
}
const pct = (v: number) => `${Math.round(v * 100)}%`;
function densityLine(d: Density): string {
  if (!Number.isFinite(d.median)) return `texels/m n/a (no textured surface${d.flatArea ? `, ${pct(d.flatArea / d.area)} flat palette` : ""})`;
  const blown = Object.entries(d.effective).map(([k, v]) => ` | ${k} blown up ${v}x nearest (counted at its real detail)`).join("");
  return `texels/m median ${d.median.toFixed(1)} p10 ${d.p10.toFixed(1)}${STANDARD ? ` (target ${STANDARD.target}, min ${STANDARD.min}: ${densityState(d)})` : ""} | textured ${pct(d.texturedArea / d.area)} flat ${pct(d.flatArea / d.area)} of ${d.area.toFixed(2)} m2 | tex ${d.textures.map((t) => `${t.size.join("x")} ${t.key}`).join(", ")} | uv overlap ${pct(d.overlap)} coverage ${pct(d.coverage)} islands ${d.islands.length}${blown}`;
}
const f2 = (v: number) => (Number.isFinite(v) ? +v.toFixed(2) : v);
const dims = (s: number[]) => s.map((v) => (v >= 10 ? v.toFixed(0) : v < 0.1 ? String(+v.toPrecision(1)) : v.toFixed(1)).replace(/^0\./, ".")).join("x");
const prefabRoot = (id: string) => { const d = readJson(prefabFile(ASSETS, id)); return { d, rootId: d.root ?? Object.keys(d.entities).find((k) => d.entities[k].parent == null) }; };

/** Every measured/heuristic problem with a declaration. Empty = ok. */
function audit(id: string, owners: Owner[], data: DressingData, all: Map<string, DressingData>): string[] {
  const why: string[] = [];
  const { geo, m } = geometry(id);
  // A light-only fixture (a flame + light for a building's OWN sconce or lantern: the bracket is the building's mesh)
  // has nothing to measure; its declared size is the flame's envelope and is taken as given.
  const lightOnly = !geo.tris.length && data.fire && geo.effects.length > 0 && geo.lights > 0;
  if (!geo.tris.length && !lightOnly) why.push("no geometry measured");
  if (lightOnly && !data.anchorKinds.length) why.push("flame and light only (no mesh of its own): declare anchorKinds (the building anchor kinds it fills) so it is never placed on a bare wall or floor");
  // size within tolerance of the measured bounds
  const tol = (v: number) => Math.max(0.02, v * 0.03);
  if (!lightOnly) data.size.forEach((v, k) => { if (Math.abs(v - m.size[k]) > tol(m.size[k])) why.push(`size[${"XYZ"[k]}] ${v} != measured ${m.size[k]}`); });
  // origin
  const want = dressingOrigin(data);
  if (!lightOnly && m.origin !== want) why.push(`origin is ${m.origin} (at ${m.originAt.join(",")} of bounds), declared ${want}`);
  // sockets inside the bounds and supported
  for (const s of data.provides) {
    const [x, y, z] = s.position, hx = s.size[0] / 2, hz = s.size[1] / 2, e = 0.03;
    const inside = x - hx >= m.min[0] - e && x + hx <= m.max[0] + e && z - hz >= m.min[2] - e && z + hz <= m.max[2] + e && y >= m.min[1] - e && y <= m.max[1] + e;
    if (!inside) why.push(`socket ${s.id} leaves the bounds`);
    if (s.kind === "surface") {
      const gap = supportBelow(geo, s.position as V3);
      if (!(gap <= 0.04)) why.push(`socket ${s.id} floats ${Number.isFinite(gap) ? gap.toFixed(2) + " m" : "over nothing"} above the mesh`);
    }
    if (s.kind === "slot") for (const k of s.accepts) if (![...all.values()].some((d) => d.slotKind === k)) why.push(`slot ${s.id} accepts "${k}" but no prop has that slotKind`);
  }
  // mount-specific sanity
  if (data.mount === "slot" && ![...all.values()].some((d) => d.provides.some((s) => s.kind === "slot" && s.accepts.includes(data.slotKind))))
    why.push(`slot prop: no catalogued prop provides a slot accepting "${data.slotKind}"`);
  if (data.mount === "ceiling" && data.chain && !all.has(data.chain)) why.push(`chain ${data.chain} is not a declared prop`);
  const flatTags = ["paper", "map", "letter", "document"];
  if (data.fits.some((t) => flatTags.includes(t)) && m.size[1] > 0.04) why.push(`fits ${data.fits.join(",")} but is ${m.size[1]} m tall: an upright mesh, not a flat sheet`);
  if (data.mount === "surface" && m.size[1] > 1.0) why.push(`surface item ${m.size[1]} m tall`);
  if (data.mount === "floor" && m.size[1] < 0.03 && data.solid) why.push("flat floor covering must be solid:false");
  const hasFire = geo.effects.some((e) => /fire/.test(e));
  if (hasFire && !data.fire) why.push(`prefab has ${geo.effects.join(",")} but fire:false`);
  if (data.fire && !hasFire && !owners.some((o) => o.row.fire)) why.push("fire:true but the prefab carries no fire effect");
  // name heuristics for the known failures
  const n = id.split("/").pop()!;
  if (/grave|tomb/.test(n) && data.setting !== "outdoor") why.push("gravestone must be setting:outdoor");
  if (/drawer/.test(n) && data.mount === "floor" && !data.provides.some((s) => s.kind === "slot")) why.push("a drawer standing on the floor that provides no drawer slots");
  if (/chandelier/.test(n) && data.mount !== "ceiling") why.push("chandelier not ceiling-mounted");
  if (/paper|scroll|book|letter/.test(n) && data.mount !== "surface" && data.mount !== "wall" && data.mount !== "part" && m.size[1] < 0.5) why.push("document not surface/wall-mounted");
  if (/wardrobe|bookshelf|^shelf|bed/.test(n) && data.mount === "floor" && data.against !== "wall") why.push("wardrobe/shelf/bed must be against:wall");
  if (/candle|torch|brazier|campfire/.test(n) && !/shelf|holder/.test(n) && !data.fire && geo.effects.length) why.push("flame prop not fire:true");
  for (const r of data.rooms) if (!ROOMS.includes(r)) why.push(`room "${r}" not in the vocabulary`);
  const vocab = vocabulary();
  if (data.scale && !vocab.scales.some((x) => x.id === data.scale)) why.push(`scale "${data.scale}" not in the dressing vocabulary (${vocab.scales.map((x) => x.id).join(", ")})`);
  for (const c of data.cultures ?? []) if (!vocab.cultures.some((x) => x.id === c)) why.push(`culture "${c}" not in the dressing vocabulary`);
  if (data.category && !CATEGORIES.includes(data.category)) why.push(`category "${data.category}" not in the vocabulary`);
  // real size per kind, at the user scale it was made for (a row's realSizeExempt says why it is deliberately off)
  const real = lightOnly ? null : realSizeIssue(id, data.size, data.scale, vocab.scales, KIND_SIZES);
  if (real && !owners.some((o) => typeof o.row?.realSizeExempt === "string" && o.row.realSizeExempt.trim().length >= 8)) why.push(real);
  return why;
}

// ----------------------------------------------------------------- suggest ----
function suggest(id: string, owners: Owner[]): Record<string, unknown> {
  const { geo, m } = geometry(id);
  const n = id.split("/").pop()!, cat = String(owners[0]?.row?.category ?? "");
  const [w, h, d] = m.size, big = Math.max(w, h, d);
  let mount = "floor";
  if (/chandelier|hanging/.test(n)) mount = "ceiling";
  else if (h < 0.04 || (big < 0.5 && !/pile|sack|stool/.test(n))) mount = "surface";
  else if (/^drawer$/.test(n) && big < 0.7) mount = "slot";
  const out: Record<string, unknown> = { mount, size: m.size };
  if (m.origin !== "off" && m.origin !== dressingOrigin({ mount: mount as any })) out.origin = m.origin;
  if (m.origin === "off") out._originNote = `origin off the bounds (at ${m.originAt.join(",")}): fix the pivot`;
  if (mount === "floor") {
    out.against = (h > 1.1 && d < 0.6 * w) || /wardrobe|shelf|bed/.test(n) ? "wall" : "either";
    if (h < 0.03) out.solid = false;
  }
  if (geo.effects.some((e) => /fire/.test(e))) out.fire = true;
  if (mount === "floor" && h > 0.3) {
    const surfaces = findSurfaces(geo).filter((s) => s.area >= 0.03);
    if (surfaces.length)
      out.provides = surfaces.slice(0, 6).map((s, k) => ({
        id: surfaces.length === 1 ? "top" : `board-${surfaces.length - k}`,
        kind: "surface",
        position: s.position,
        size: s.size,
        ...(Number.isFinite(s.clearHeight) ? { clearHeight: s.clearHeight } : {}),
        capacity: Math.max(1, Math.min(8, Math.round(s.area / 0.06))),
      }));
  }
  out._hint = { catalogCategory: cat, triangles: m.triangles, effects: geo.effects };
  return out;
}

// --------------------------------------------------------------- status ----
interface Row { id: string; state: "ok" | "STALE" | "MISSING"; why: string[]; exempt?: string }
function evaluate(only?: string): { rows: Row[]; data: Map<string, DressingData> } {
  const all = catalogued(only), everything = only ? catalogued() : all;
  // parse every declaration in the project first (slot hosts and chains may live in another collection)
  const data = new Map<string, DressingData>(), errors = new Map<string, string>();
  for (const [id, owners] of everything) {
    const dcl = lookup(id, owners);
    if (dcl?.kind !== "declared") continue;
    const parsed = dressingSchema.safeParse(dcl.raw);
    if (parsed.success) data.set(id, parsed.data);
    else errors.set(id, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const rows: Row[] = [];
  for (const [id, owners] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dcl = lookup(id, owners);
    if (!fs.existsSync(prefabFile(ASSETS, id))) { rows.push({ id, state: "MISSING", why: ["prefab file missing"] }); continue; }
    const { d, rootId } = prefabRoot(id);
    const onPrefab = d.entities[rootId]?.components?.dressing;
    if (!dcl) { rows.push({ id, state: "MISSING", why: [`no declaration or exemption (sidecar ${owners.map((o) => o.entry.dressing ?? `<none for ${o.entry.path}>`).join(" | ")})`] }); continue; }
    if (dcl.kind === "exempt") {
      rows.push({ id, state: onPrefab ? "STALE" : "ok", why: onPrefab ? ["exempt but the prefab still carries a dressing component (run sync)"] : [], exempt: dcl.reason });
      continue;
    }
    if (errors.has(id)) { rows.push({ id, state: "STALE", why: [`schema: ${errors.get(id)}`] }); continue; }
    const p = data.get(id)!, why = audit(id, owners, p, data);
    if (stable(onPrefab) !== stable(p)) why.push(onPrefab ? "prefab root out of sync with the sidecar (run sync)" : "prefab root has no dressing yet (run sync)");
    rows.push({ id, state: why.length ? "STALE" : "ok", why });
  }
  return { rows, data };
}

// ----------------------------------------------------------------- sync ----
function sync(): { changed: string[]; rehashed: string[]; staleHash: string[] } {
  const all = catalogued(), changed: string[] = [], rehashed: string[] = [], staleHash: string[] = [];
  for (const [id, owners] of all) {
    const dcl = lookup(id, owners);
    if (!dcl || !fs.existsSync(prefabFile(ASSETS, id))) continue;
    const file = prefabFile(ASSETS, id), before = fs.readFileSync(file, "utf8");
    const { d, rootId } = prefabRoot(id);
    const current = d.entities[rootId]?.components?.dressing;
    let ops: any[] = [];
    if (dcl.kind === "exempt") { if (current) ops = [{ op: "remove-component", id: rootId, component: "dressing" }]; }
    else {
      const parsed = dressingSchema.safeParse(dcl.raw);
      if (!parsed.success) { console.error(`skip ${id}: invalid declaration`); continue; }
      if (stable(current) !== stable(parsed.data)) ops = [{ op: "set-component", id: rootId, component: "dressing", data: parsed.data }];
    }
    if (!ops.length) continue;
    const next = applyOps(d, ops, components).doc;
    const text = JSON.stringify(next, null, 2) + "\n";
    fs.writeFileSync(file, text);
    changed.push(id);
    // the owning rows record the prefab's hash: keep them true (only where they were true before)
    const oldHash = sha(before), newHash = sha(text);
    for (const { entry, row } of owners) {
      if (typeof row.sha256 !== "string" || !entry.prefabIds) continue;
      if (row.sha256 !== oldHash) { staleHash.push(`${id} (${entry.path})`); continue; }
      const catFile = proj(entry.path), catText = fs.readFileSync(catFile, "utf8");
      const needle = `"sha256": "${oldHash}"`;
      if (catText.split(needle).length !== 2) { staleHash.push(`${id} (${entry.path}: hash not unique)`); continue; }
      fs.writeFileSync(catFile, catText.replace(needle, `"sha256": "${newHash}"`));
      row.sha256 = newHash;
      rehashed.push(id);
    }
  }
  return { changed, rehashed, staleHash };
}

// --------------------------------------------------------- uncatalogued ----
/** Every prefab id under assets/prefabs/. */
function allPrefabIds(): string[] {
  const root = path.join(ASSETS, "prefabs"), out: string[] = [];
  const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".json")) out.push(path.relative(root, f).replaceAll("\\", "/").replace(/\.json$/, "")); } };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}
/** Prefabs neither catalogued nor inside a registered exempt folder: invisible to builders AND unaccounted for. */
function uncatalogued(): string[] {
  const known = catalogued(), folders = (registry.exemptFolders ?? []).map((f) => f.folder.replace(/\/?$/, "/"));
  return allPrefabIds().filter((id) => !known.has(id) && !folders.some((f) => id.startsWith(f)));
}

// ------------------------------------------------------- duplicate guard ----
/**
 * The families a builder keeps remaking. A site's own prefab whose name falls in one that a SHARED collection already
 * offers is a duplicate, unless it nests a shared prop (a wrapper or composite reuses; it does not remake).
 */
const FAMILIES: [string, RegExp][] = [
  ["barrel", /barrel|cask|keg|\btun\b/], ["crate", /crate/], ["tent", /\btent\b/], ["cart", /\bcart\b(?! wheel)|handcart|wagon|wheel ?barrow|caravan/], ["torch", /torch/],
  ["bones", /bone|skull/], ["sack", /sack/], ["basket", /basket/], ["chest", /\bchest\b|coffer/], ["cage", /cage/], ["banner", /banner|pennant/],
  ["campfire", /campfire|fire-?pit/], ["table", /\btable\b/], ["bench", /\bbench\b/], ["stool", /stool/], ["chair", /chair/], ["bed", /(?<!(reed|river|sea|flower|peat) )\bbeds?\b/],
  ["lantern", /lantern/],["shelter", /tarp|lean-to|shelter/], ["brazier", /brazier/], ["gravestone", /grave-?stone|headstone/],
  ["column", /column|pillar/], ["statue", /statue/],
];
const familyOf = (id: string): string | null => { const n = id.split("/").pop()!.replace(/[-_]/g, " "); return FAMILIES.find(([, re]) => re.test(n))?.[0] ?? null; };
interface Dupe { id: string; family: string; of: string[] }
function duplicates(only?: string[]): Dupe[] {
  const all = catalogued(), shared = new Map<string, string[]>();
  const isShared = (owners: Owner[]) => owners.some((o) => o.entry.shared);
  for (const [id, owners] of all) {
    if (!isShared(owners)) continue;
    const dcl = lookup(id, owners), fam = familyOf(id);
    if (!fam || dcl?.kind !== "declared") continue; // only what the menu actually offers
    shared.set(fam, [...(shared.get(fam) ?? []), id]);
  }
  const ids = only ?? [...all].filter(([, owners]) => !isShared(owners)).map(([id]) => id);
  const out: Dupe[] = [];
  for (const id of ids.sort()) {
    const fam = familyOf(id), owners = all.get(id) ?? [];
    if (!fam || !shared.has(fam) || (owners.length && isShared(owners))) continue;
    if (owners.some((o) => o.row?.wraps || o.row?.variantOf || o.row?.composedFrom)) continue;
    if (fs.existsSync(prefabFile(ASSETS, id))) { const nested = prefabGeometry(ASSETS, id).nested; if (nested.some((n) => shared.get(fam)!.includes(n))) continue; }
    out.push({ id, family: fam, of: shared.get(fam)!.filter((s) => s !== id) });
  }
  return out;
}
const dupeLine = (d: Dupe) => `DUPLICATE ${d.id}: DUPLICATE of ${d.of.slice(0, 4).join(", ")}${d.of.length > 4 ? ` (+${d.of.length - 4} more ${d.family})` : ""}`;

/** Where a prop comes from, for the menu: wrapper / variant / composite and its source. */
function provenance(owners: Owner[]): string {
  const row = owners.find((o) => o.row?.wraps || o.row?.variantOf || o.row?.composedFrom)?.row;
  if (!row) return "";
  if (row.wraps) return `wraps ${row.wraps}${row.scale ? ` x${row.scale}` : ""}${row.yaw ? ` yaw ${row.yaw}` : ""}${row.pitch || row.roll ? " tilted" : ""}`;
  if (row.variantOf) return `variant of ${row.variantOf} (${row.material})`;
  const part = (s: string) => (s.startsWith("card") ? `card ${s.split("+ ")[1]}` : s.startsWith("primitive") ? `${s.split(" ")[1]} primitive` : s.split(" ")[1]);
  return `composite of ${(row.composedFrom as string[]).map(part).filter((v, k, a) => a.indexOf(v) === k).join(" + ")}`;
}

// ---------------------------------------------------------------- index ----
const INDEX_OUT = path.join(PROJECT, "authoring/dressing/prop-index.json");
function socketSummary(p: DressingData): string {
  return p.provides
    .map((s) => s.kind === "surface" ? `${s.id}@${f2(s.position[1])}${s.clearHeight < 10 ? "<" + f2(s.clearHeight) : ""}` : `${s.kind}:${s.accepts.join("/") || "any"}`)
    .join(" ");
}
function buildIndex() {
  const { rows, data } = evaluate();
  const owners = catalogued();
  // a row with `supersededBy` (a reskin or revision under a new id) keeps its declaration, so installed scenes and old
  // plans still check, but the menu offers only its successor
  const superseded = (id: string) => (owners.get(id) ?? []).some((o) => typeof o.row.supersededBy === "string");
  const props = [...data].filter(([id, p]) => p.mount !== "part" && !superseded(id)).map(([id, p]) => ({
    id, mount: p.mount, size: p.size, ...(p.mount === "floor" ? { against: p.against } : {}), category: p.category, use: p.use, rooms: p.rooms, themes: p.themes,
    ...(p.mount === "wall" ? { wallHeight: p.wallHeight } : {}), ...(p.chain ? { chain: true } : {}), ...(p.clearance ? { clearance: p.clearance } : {}),
    ...(p.scale ? { scale: p.scale } : {}), ...(p.cultures ? { cultures: p.cultures } : {}), ...(p.centrepiece ? { centrepiece: true } : {}),
    wealth: p.wealth, fire: p.fire, setting: p.setting, solid: p.solid, fits: p.fits, slotKind: p.slotKind, sockets: socketSummary(p),
    ...(p.anchorKinds.length ? { anchorKinds: p.anchorKinds } : {}), ...(isLooseClutter(p) ? { loose: true } : {}),
    ok: rows.find((r) => r.id === id)?.state === "ok",
    ...(provenance(owners.get(id) ?? []) ? { from: provenance(owners.get(id) ?? []) } : {}),
  }));
  const setsDir = proj("authoring/dressing/sets"), sets: any[] = [];
  if (fs.existsSync(setsDir))
    for (const f of fs.readdirSync(setsDir).filter((f) => f.endsWith(".json"))) {
      const parsed = dressingSetSchema.safeParse(readJson(path.join(setsDir, f)));
      if (!parsed.success) { console.error(`set ${f}: invalid (${parsed.error.issues[0]?.message})`); continue; }
      const s = parsed.data, a = data.get(s.items[0]!.prop);
      const floor = s.items.filter((i, k) => k === 0 || i.place.kind === "floor").map((i) => data.get(i.prop)).filter((d): d is DressingData => !!d);
      // a wall-backed anchor needs a stretch as wide as the members standing beside it along the wall
      const wallNeed = a?.against === "wall" ? +Math.max(a.size[0], s.footprint[0]).toFixed(2) : 0;
      sets.push({
        id: s.id, name: s.name, rooms: s.rooms, wealth: s.wealth, themes: s.themes, footprint: s.footprint, members: s.items.length, anchor: s.items[0]!.prop, props: [...new Set(s.items.map((i) => i.prop))],
        use: a?.use ?? [], against: a?.against ?? "either", wallNeed, tallest: +Math.max(0, ...floor.map((d) => d.size[1])).toFixed(2),
        cover: +floor.filter((d) => d.solid).reduce((m, d) => m + d.size[0] * d.size[2], 0).toFixed(2), loose: floor.filter((d) => isLooseClutter(d)).length,
        shape: s.shape || describeSetShape(s, (id) => data.get(id)),
      });
    }
  const out = { version: 1, generatedBy: "tools/props.mts index", rooms: ROOMS, categories: CATEGORIES, props: props.sort((a, b) => a.id.localeCompare(b.id)), sets };
  fs.mkdirSync(path.dirname(INDEX_OUT), { recursive: true });
  // one compact row per line: diffable, greppable, and never read whole by an agent (they read `menu`)
  const block = (list: unknown[]) => (list.length ? "[\n" + list.map((r) => "  " + JSON.stringify(r)).join(",\n") + "\n ]" : "[]");
  const text = `{\n "version": 1,\n "generatedBy": "tools/props.mts index",\n "rooms": ${JSON.stringify(ROOMS)},\n "categories": ${JSON.stringify(CATEGORIES)},\n "props": ${block(out.props)},\n "sets": ${block(out.sets)}\n}\n`;
  fs.writeFileSync(INDEX_OUT, text);
  return out;
}

// ----------------------------------------------------------------- menu ----
function menu() {
  if (!fs.existsSync(INDEX_OUT)) buildIndex();
  if (flag("map")) return roomMenu();
  const idx = readJson(INDEX_OUT);
  const props: any[] = idx.props, sets: any[] = idx.sets ?? [];
  const tally = (key: string) => { const c = new Map<string, number>(); for (const p of props) for (const v of [].concat(p[key] ?? [])) if (v !== "") c.set(v, (c.get(v) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}(${n})`).join(" "); };
  if (flags.rooms) { console.log(`rooms: ${ROOMS.join(" ")}\nin use: ${tally("rooms")}  (props with no rooms fit anywhere)`); return; }
  if (flags.categories) { console.log(`categories: ${tally("category")}\nmounts: ${tally("mount")}`); return; }
  if (flags.vocabulary) { const v = vocabulary(); console.log(`scale classes: ${v.scales.map((x) => `${x.id} (${x.note})`).join("\n  ")}\ncultures: ${v.cultures.map((x) => x.id).join(" ")}\nin use: scale ${tally("scale")} | cultures ${tally("cultures")}`); return; }
  if (flags.tags) { console.log(`fits tags: ${tally("fits")}\nslot kinds: ${tally("slotKind")}\nthemes: ${tally("themes") || "(none: all neutral)"}`); return; }
  const room = flag("room"), wealth = flag("wealth"), theme = flag("theme"), mount = flag("mount"), category = flag("category"), fits = flag("fits");
  const pf = placeFilter();
  const setting = flag("setting") ?? (room ? (OUTDOOR_ROOMS.has(room) ? "outdoor" : room === "dungeon" ? undefined : "indoor") : undefined);
  const limit = Number(flag("limit") ?? 60);
  if (flag("search")) return searchMenu(props, flag("search")!);
  if (!room && !mount && !category && !fits && !flag("setting") && !pf.scale && !pf.cultures.length) { console.log("usage: menu --room <role> | --setting indoor|outdoor [--wealth w] [--theme t] [--mount m] [--category c] [--fits tag] [--limit 60]; menu --search <word>; menu --rooms | --categories | --tags"); process.exitCode = 1; return; }
  if (room && !ROOMS.includes(room)) { console.log(`unknown room "${room}". rooms: ${ROOMS.join(" ")}`); process.exitCode = 1; return; }
  const score = (p: any) => {
    if (mount && p.mount !== mount) return -1;
    if (category && p.category !== category) return -1;
    if (fits && !p.fits.includes(fits)) return -1;
    if (setting && p.setting !== "both" && p.setting !== setting) return -1;
    if (wealth && p.wealth.length && !p.wealth.includes(wealth)) return -1;
    if (theme && p.themes.length && !p.themes.includes(theme)) return -1;
    if (!pf.ok(p)) return -1;
    if (p.mount === "slot") return -1; // slot items come with their host: never menu'd loose
    if (p.anchorKinds?.length) return -1; // flame-only fixtures fill a building's own anchors (dress fixtures), never furniture
    let s = 1;
    if (room) { if (p.rooms.includes(room)) s += 4; else if (p.rooms.length) return -1; }
    if (wealth && p.wealth.includes(wealth)) s += 1;
    if (theme && p.themes.includes(theme)) s += 2;
    if (p.ok === false) s -= 0.5;
    return s;
  };
  const lines: { s: number; t: string }[] = [];
  const byId = new Map(props.map((p) => [p.id, p]));
  for (const st of sets) {
    if (!(st.props ?? [st.anchor]).every((id: string) => byId.has(id) && pf.ok(byId.get(id)))) continue;
    if (room && st.rooms.length && !st.rooms.includes(room)) continue;
    if (wealth && st.wealth.length && !st.wealth.includes(wealth)) continue;
    if (mount || category || fits) continue;
    lines.push({ s: 10 + (room && st.rooms.includes(room) ? 4 : 0), t: `set ${st.id} | ${st.members} items | floor ${dims(st.footprint)} | ${st.name}` });
  }
  for (const p of props) {
    const s = score(p);
    if (s < 0) continue;
    const m = p.mount === "floor" ? `floor${p.against === "wall" ? "/wall" : p.against === "free" ? "/free" : ""}${p.solid ? "" : "/walkover"}` : p.mount;
    const extra = [p.fire ? "FIRE" : "", p.loose ? "LOOSE (counts against the room's floor-clutter budget)" : "", p.fits.length ? `fits:${p.fits.join(",")}` : "", p.sockets ? `on:${p.sockets}` : "", p.ok ? "" : "(unchecked)"].filter(Boolean).join(" ");
    lines.push({ s, t: `${p.id} | ${m} | ${dims(p.size)} | ${p.category}${(p.rooms ?? []).length ? ` | ${p.rooms.join("/")}` : ""}${extra ? " | " + extra : ""}${p.from ? ` | ${p.from}` : ""}` });
  }
  lines.sort((a, b) => b.s - a.s || a.t.localeCompare(b.t));
  console.log(`# ${lines.length} match${lines.length > limit ? `, first ${limit} (--limit n)` : ""}. Ids are FULL prefab ids (folder included): copy them exactly. size = WxHxD m as placed. on: = sockets (id@height<clear). place with a dressing plan, never a transform.`);
  if (pf.scale || pf.cultures.length) console.log(`# only ${pf.scale ? `${pf.scale}-scale or any-scale` : "any-scale"} props${pf.cultures.length ? ` of ${pf.cultures.join("/")} (or any)` : ""}; untagged props are hidden (catalogue them)`);
  console.log(`# fewer, better things: a room is mostly open floor (dress manifest shows each room's cover ceiling and loose budget). Storage goes on shelves. Hearth/sconce/lantern flames are not here: they come from the building (dress fixtures).`);
  for (const l of lines.slice(0, limit)) console.log(l.t);
}

/**
 * menu --search <word>: "do we already have a barrel?" Matches the id, category, use, rooms, provenance and the
 * family synonyms of the duplicate guard (barrel finds casks and kegs), then lists catalogued props that exist but
 * are NOT offered (exempt, blocked or site-fitted) so nobody remakes them either.
 */
function searchMenu(props: any[], word: string) {
  const w = word.toLowerCase(), fam = FAMILIES.find(([name, re]) => name === w || re.test(w));
  const hit = (s: string) => s.toLowerCase().includes(w) || (!!fam && fam[1].test(s.split("/").pop()!.replace(/[-_]/g, " ")));
  const found = props.filter((p) => hit(p.id) || p.category === w || (p.use ?? []).includes(w) || (p.rooms ?? []).includes(w) || (p.from ?? "").toLowerCase().includes(w));
  console.log(`# ${found.length} prop(s) the menu offers for "${word}"${fam ? ` (family ${fam[0]})` : ""}. USE one of these, wrap it (props wrap), re-skin it (props variant) or combine it (props compose); never model a new one.`);
  for (const p of found) {
    const m = p.mount === "floor" ? `floor${p.against === "wall" ? "/wall" : p.against === "free" ? "/free" : ""}` : p.mount;
    console.log(`${p.id} | ${m} | ${dims(p.size)} | ${p.category} | ${p.setting} | ${(p.rooms ?? []).join("/") || "any room"}${p.from ? ` | ${p.from}` : ""}`);
  }
  const offered = new Set(props.map((p) => p.id)), hidden: string[] = [];
  for (const [id, owners] of catalogued()) {
    if (offered.has(id) || !hit(id)) continue;
    const d = lookup(id, owners);
    const next = owners.map((o) => o.row.supersededBy).find((v) => typeof v === "string");
    hidden.push(`${id} (${next ? `superseded by ${next}` : d?.kind === "exempt" ? d.reason.replace(/\s+/g, " ").slice(0, 110) : d ? "declared as a part/slot" : "not declared"})`);
  }
  if (hidden.length) console.log(`# exists but not offered (do not remake; use the wrapper named, or wrap/variant it):\n  ${hidden.sort().join("\n  ")}`);
}

/**
 * The place's scale class and cultures: --scale / --culture, else the --plan's `space` (and the room's own override).
 * A prop is offered only when it declares a matching (or `any`) scale and culture; an untagged prop is hidden from a
 * filtered menu, because the resolver warns on it there.
 */
function placeFilter(roomId?: string): { scale?: string; cultures: string[]; keepCentre: boolean; ok: (p: any) => boolean } {
  let scale = flag("scale"), cultures = flag("culture") ? flag("culture")!.split(",") : [], keepCentre = false;
  const planRef = flag("plan");
  if (planRef) {
    const file = fs.existsSync(planRef) ? planRef : proj(`authoring/dressing/plans/${planRef}.json`);
    const plan = dressingPlanSchema.parse(readJson(file)), room = roomId ? plan.rooms[roomId] : undefined;
    scale ??= room?.scale ?? plan.space?.scale;
    if (!cultures.length) cultures = room?.cultures ?? plan.space?.cultures ?? [];
    keepCentre = room?.keepCentre ?? plan.space?.kind === "dungeon";
  }
  const vocab = vocabulary();
  const ok = (p: any): boolean =>
    (!scale || (!!p.scale && scaleFits(vocab, scale, p.scale))) && (!cultures.length || (!!p.cultures && cultureFits(vocab, cultures, p.cultures)));
  return { ...(scale ? { scale } : {}), cultures, keepCentre, ok };
}

/** Words for what a floor piece needs of a wall. */
const wallWords = (p: any): string =>
  p.mount !== "floor" ? "" : p.against === "wall" ? `NEEDS A WALL (${f2(p.size[0])} m stretch)` : p.against === "free" ? "stands in the open" : "wall or open";

/**
 * menu --map <id> --room <id>: only what physically fits THAT room, and per line what a designer must know without opening
 * anything (use, wall need, size, and for a set its members and where they fall).
 */
function roomMenu() {
  const mapId = flag("map")!, roomId = flag("room");
  // a map of another project (a dungeon dressed from this catalogue) is given by its path
  const file = mapId.endsWith(".json") && fs.existsSync(mapId) ? mapId : proj(`authoring/dressing/sockets/${mapId}.json`);
  if (!fs.existsSync(file)) { console.log(`no socket map ${mapId} (authoring/dressing/sockets/${mapId}.json)`); process.exitCode = 1; return; }
  const map = socketMapSchema.parse(readJson(file));
  const lv = map.levels.find((l) => l.rooms.some((r) => r.id === roomId));
  if (!roomId || !lv) { console.log(`usage: menu --map ${mapId} --room <room id> [--role r]; rooms: ${map.levels.flatMap((l) => l.rooms.map((r) => r.id)).join(", ")}`); process.exitCode = 1; return; }
  const room = lv.rooms.find((r) => r.id === roomId)!, role = flag("role") ?? "", wealth = flag("wealth");
  if (role && !ROOMS.includes(role)) { console.log(`unknown role "${role}". roles: ${ROOMS.join(" ")}`); process.exitCode = 1; return; }
  const placeable = placeableFloor(lv).find((f) => f.room === roomId)?.placeable ?? 0;
  const budget = roomBudget(room.area, role, placeable);
  // highest clear height over placeable floor
  let topHead = 0;
  for (let r = 0; r < lv.rows; r++) for (let c = 0; c < lv.columns; c++) {
    const ch = lv.cells[r]![c], rm = lv.room[r]![c];
    if ((ch === "." || ch === "o") && rm !== "." && parseInt(rm!, 36) === room.index) { const h = lv.head[r]![c]!; if (h !== ".") topHead = Math.max(topHead, parseInt(h, 36) * HEAD_STEP); }
  }
  const walls = lv.walls.filter((w) => w.room === roomId);
  // an outdoor site (tools/site-sockets.mts): open sky, so no height limit, and outdoor props instead of indoor ones
  let openCells = 0, floorCells = 0;
  for (const row of lv.cells) for (const ch of row) if (ch === "o") openCells++; else if (ch === ".") floorCells++;
  const outdoorRoom = openCells > floorCells;
  if (outdoorRoom) topHead = Infinity;
  let stand = 0, standAt = "", hang = 0, hangH = 0;
  for (const w of walls) {
    for (const [a, b] of standStretches(lv, w)) if (b - a > stand) [stand, standAt] = [b - a, `${w.id} ${a.toFixed(2)}..${b.toFixed(2)}`];
    for (const [a, b] of w.spans) if (b - a > hang) [hang, hangH] = [b - a, w.height];
  }
  const idx = readJson(INDEX_OUT), props: any[] = idx.props, sets: any[] = idx.sets ?? [];
  const pf = placeFilter(roomId);
  const roleOk = (rooms: string[]) => !role || !rooms.length || rooms.includes(role);
  const wealthOk = (w: string[]) => !wealth || !w.length || w.includes(wealth);
  const tooBig: string[] = [];
  const fit = (p: any): string | undefined => {
    const [W, H, D] = p.size as [number, number, number];
    if (p.mount === "floor") {
      if (H + 0.05 > topHead) return "too tall";
      if (p.solid && W * D > budget.maxCoverM2) return "bigger than the cover ceiling";
      if (p.against === "wall" && W > stand + 1e-6) return "no wall stretch that long";
      return undefined;
    }
    if (p.mount === "wall") return W <= hang + 1e-6 && hangH >= (p.wallHeight?.[0] ?? 1.2) + H ? undefined : "no wall that takes it";
    if (p.mount === "ceiling") return room.maxHead >= H + 2.0 ? undefined : "ceiling too low";
    return undefined;
  };
  console.log(`# ROOM ${roomId} of ${mapId} (level ${lv.level}${role ? `, as ${role}` : ""}): ceiling ${room.minHead.toFixed(2)}..${room.maxHead >= 8.75 ? "open" : room.maxHead.toFixed(2)} m, ` +
    `placeable floor ${placeable.toFixed(1)} m² of ${room.area.toFixed(1)}, cover ceiling ${budget.maxCoverM2} m² (${Math.round(budget.maxCover * 100)}% of placeable), ` +
    `loose <= ${budget.loose}, at least ${budget.minItems} items; longest free wall stretch ${stand.toFixed(2)} m${standAt ? ` (${standAt}, left to right seen from inside)` : ""}`);
  if (pf.scale || pf.cultures.length || pf.keepCentre)
    console.log(`# this place: ${pf.scale ? `${pf.scale}-scale` : "any scale"}${pf.cultures.length ? `, ${pf.cultures.join("/")}` : ""}: only matching (or any) props are listed${pf.keepCentre ? "; its MIDDLE stays clear: fill walls and corners first, one set piece (setPiece: true or a centrepiece prop) may stand in the centre" : ""}`);
  console.log(`# place with { "kind": "auto", "room": "${roomId}", "prefer": "wall" | "corner" | "open" | "near", "near": "<item id | hearth | door | stair>" }: sets first, then single pieces; the resolver picks the spot.`);
  const lines: string[] = [];
  const byId = new Map(props.map((p) => [p.id, p]));
  const setOk = (st: any): boolean => (st.props ?? [st.anchor]).every((id: string) => byId.has(id) && pf.ok(byId.get(id)));
  for (const s of sets) {
    if (!roleOk(s.rooms) || !wealthOk(s.wealth) || !setOk(s)) continue;
    const why = s.tallest + 0.05 > topHead ? "too tall" : s.cover > budget.maxCoverM2 ? "bigger than the cover ceiling" : s.wallNeed > stand + 1e-6 ? "no wall stretch that long" : undefined;
    if (why) { tooBig.push(`set ${s.id} (${why})`); continue; }
    const wall = s.against === "wall" ? `NEEDS A WALL (${s.wallNeed.toFixed(2)} m stretch)` : s.against === "free" ? "stands in the open" : "wall or open";
    lines.push(`set ${s.id} | ${(s.use ?? []).join("/") || "-"} | ${wall} | ${dims(s.footprint)} m, ${s.cover} m² cover${s.loose ? `, ${s.loose} LOOSE` : ""} | ${s.shape}`);
  }
  const surf: string[] = [];
  for (const p of props) {
    if (p.mount === "slot" || p.mount === "part" || p.anchorKinds?.length) continue;
    if (!roleOk(p.rooms) || !wealthOk(p.wealth) || p.setting === (outdoorRoom ? "indoor" : "outdoor")) continue;
    if (!pf.ok(p)) continue;
    if (p.mount === "surface") { surf.push(`${p.id} (${(p.use ?? []).join("/") || "-"})`); continue; }
    const why = fit(p);
    if (why) { tooBig.push(`${p.id} (${why})`); continue; }
    const where = p.mount === "floor" ? wallWords(p) : p.mount === "wall" ? "hangs on a wall" : `hangs from the ceiling${p.chain ? " on a chain" : ""}`;
    const extra = [p.centrepiece ? "CENTREPIECE (may hold the middle)" : "", p.scale && p.scale !== "any" ? `${p.scale}-scale` : "", p.solid === false ? "walk-over" : "", p.loose ? "LOOSE" : "", p.fire ? "FIRE" : "", p.clearance ? `keeps ${p.clearance} m clear in front` : "", p.sockets ? "things go on it" : ""].filter(Boolean).join(", ");
    lines.push(`${p.id} | ${(p.use ?? []).join("/") || "-"} | ${where} | ${dims(p.size)} m${extra ? ` | ${extra}` : ""}`);
  }
  lines.sort((a, b) => (a.startsWith("set ") === b.startsWith("set ") ? a.localeCompare(b) : a.startsWith("set ") ? -1 : 1));
  const limit = flags.all ? Infinity : Number(flag("limit") ?? 80);
  for (const l of lines.slice(0, limit)) console.log(l);
  if (lines.length > limit) console.log(`# ... ${lines.length - limit} more (--all)`);
  if (surf.length) console.log(`# on tables and shelves (place with { "kind": "on", "item": "<host>" }): ${surf.join(", ")}`);
  if (tooBig.length) console.log(`# left out, they do not fit this room: ${tooBig.join("; ")}`);
}

// --------------------------------------------------------------- report ----
const REPORT_OUT = path.join(PROJECT, "authoring/dressing/prop-report.md");
const KEY_NAME: Record<string, string> = { l: "longest side", h: "height", w: "width", d: "depth" };
/** Every catalogued prop: in-game size, the real size and scale it was made at, mount, density. */
function propReport(): string {
  const { rows, data } = evaluate();
  const all = catalogued();
  const md = (s: unknown) => String(s ?? "").replace(/\|/g, "\|");
  const L: string[] = ["# Prop report", "", `Generated ${new Date().toISOString().slice(0, 10)} by \`props report\` from the catalogs and the prefabs' own \`dressing\` declarations. Sizes are metres as placed in game (width x height x depth). Density = median texels per metre${STANDARD ? ` (target ${STANDARD.target}, LOW below ${STANDARD.min})` : ""}.`, ""];
  for (const entry of registry.catalogs) {
    const ids = [...all].filter(([, owners]) => owners[0]?.entry === entry).map(([id]) => id).sort();
    if (!ids.length) continue;
    L.push(`## ${entry.path} (${ids.length})`, "", "| Prop | Mount | In game W x H x D | Real size used | Scale | Category | Flags | Density | Status |", "|---|---|---|---|---|---|---|---|---|");
    for (const id of ids) {
      const row = all.get(id)![0]!.row, p = data.get(id), st = rows.find((r) => r.id === id);
      const sc = row.scale && typeof row.scale === "object" ? row.scale : null;
      const real = sc ? `${KEY_NAME[sc.key] ?? sc.key} ${sc.metres} m` : "not scaled";
      const scale = sc ? `x${sc.worldScale ?? 1}` : "-";
      let dens = "-";
      if (fs.existsSync(prefabFile(ASSETS, id))) try { const d = density(id); dens = Number.isFinite(d.median) ? `${d.median.toFixed(0)} ${densityState(d)}` : "n/a"; } catch { dens = "n/a"; }
      const flags = p ? [p.anchorKinds.length ? `anchor-only (${p.anchorKinds.join("/")})` : "", isLooseClutter(p) ? "loose" : "", p.fire ? "fire" : "", p.solid ? "" : "walk-over", p.setting !== "both" ? p.setting : ""].filter(Boolean).join(", ") : "";
      const mount = p ? (p.mount === "floor" && p.against !== "either" ? `floor/${p.against}` : p.mount) : st?.exempt ? "exempt" : "-";
      L.push(`| ${md(id)} | ${mount} | ${p ? p.size.map((v) => v.toFixed(2)).join(" x ") : "-"} | ${real} | ${scale} | ${md(p?.category || row.category || "-")} | ${flags || "-"} | ${dens} | ${st?.state ?? "-"}${st?.exempt ? ` (exempt: ${md(st.exempt)})` : ""} |`);
    }
    L.push("");
  }
  fs.writeFileSync(REPORT_OUT, L.join("\n"));
  return REPORT_OUT;
}

// --------------------------------------------------------- reskin plan ----
/** What a prop's art is made of, from the texels its UVs actually sample (area-weighted): plain wood / grey / other. */
function materialMix(id: string): { wood: number; grey: number; other: number } {
  const { geo } = geometry(id);
  const mix = { wood: 0, grey: 0, other: 0 };
  let total = 0;
  const pts = [[1 / 3, 1 / 3], [0.7, 0.15], [0.15, 0.7], [0.15, 0.15]];
  for (const t of geo.tris) {
    if (!t.tex || !t.uv) continue;
    const img = pagePixels(t.tex);
    if (!img) continue;
    const e1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], e2 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    const A = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
    for (const [s, r] of pts) {
      const u = t.uv[0][0] * (1 - s - r) + t.uv[1][0] * s + t.uv[2][0] * r, v = t.uv[0][1] * (1 - s - r) + t.uv[1][1] * s + t.uv[2][1] * r;
      const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width))), y = Math.min(img.height - 1, Math.max(0, Math.floor((t.tex.flipY ? 1 - v : v) * img.height)));
      const i = (y * img.width + x) * 4, R = img.data[i] / 255, G = img.data[i + 1] / 255, B = img.data[i + 2] / 255;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), sat = mx ? (mx - mn) / mx : 0;
      let hue = 0;
      if (mx !== mn) hue = mx === R ? 60 * (((G - B) / (mx - mn)) % 6) : mx === G ? 60 * ((B - R) / (mx - mn) + 2) : 60 * ((R - G) / (mx - mn) + 4);
      if (hue < 0) hue += 360;
      const w = A / pts.length;
      if (sat < 0.22 || mx < 0.1) mix.grey += w;
      else if (hue >= 8 && hue <= 50 && sat >= 0.3 && mx <= 0.9) mix.wood += w;
      else mix.other += w;
      total += w;
    }
  }
  if (total) { mix.wood /= total; mix.grey /= total; mix.other /= total; }
  return mix;
}
const METAL = /anvil|candel|chandelier|lamp|coin|gold|cauldron|cage|chain|lantern|brazier/;
interface Plan { id: string; median: number; p10: number; factor: number; tileNow: number; tileNeed: number; source: number | null; route: "a" | "b" | "c"; role?: string; carry: boolean; why: string; kit: boolean }
function reskinPlan(): { plans: Plan[]; pages: string[][]; bulk: { props: number; side: number; nowSide: number } | null } {
  if (!STANDARD) throw Error(`no texelDensity standard in ${INDEX}`);
  const all = catalogued(), plans: Plan[] = [];
  const kitSides: number[] = [];
  let kitPage = 0, kitPad = 0;
  for (const [id, owners] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!fs.existsSync(prefabFile(ASSETS, id))) continue;
    const d = density(id), st = densityState(d);
    const kitOwner = owners.find((o) => Array.isArray(o.row.tile));
    const atlas = kitOwner ? doc(kitOwner.entry.path).atlas : null;
    const tex = d.textures[0];
    const tilePx = () => Math.round((kitOwner!.row.tile[2] * atlas.size[0]) / (d.effective[tex.key] ?? 1));
    if (kitOwner && atlas && Number.isFinite(d.median)) {
      // bulk: every kit prop at target -> its own square tile (+ gutter), on one page
      kitPage = atlas.size[0]; kitPad = atlas.gutter ?? 8;
      kitSides.push(Math.max(16, Math.ceil((tilePx() * STANDARD.target) / d.median)));
    }
    if (st !== "LOW") continue;
    const f = STANDARD.target / d.median;
    let tileNow: number, source: number | null = null;
    if (kitOwner && atlas) {
      tileNow = tilePx();
      const ts = kitOwner.row.source?.textureSize;
      if (Array.isArray(ts)) source = Math.min(ts[0], ts[1]);
    } else {
      // no tile record: the prop's UV bounds in texels stand in for its tile
      const { geo } = geometry(id);
      let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
      for (const t of geo.tris) if (t.uv && t.tex?.key === tex.key) for (const [u, v] of t.uv) { u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v); }
      tileNow = Math.max(1, Math.round(Math.max(u1 - u0, v1 - v0) * tex.size[0]));
    }
    const tileNeed = Math.ceil(tileNow * f);
    // can the UV layout carry art drawn for it at that size?
    const tiny = d.islands.filter((i) => i.texelArea * f * f < 16).reduce((t, i) => t + i.worldArea, 0) / (d.texturedArea || 1);
    const problems = [
      d.overlap > 0.25 ? `${pct(d.overlap)} of the UV layout is stacked/mirrored` : "",
      tiny > 0.25 ? `${pct(tiny)} of the surface is on islands under 4x4 texels even at ${tileNeed}px` : "",
      tileNeed > 1024 ? `needs a ${tileNeed}px tile (the UVs waste the page)` : "",
    ].filter(Boolean);
    const carry = !problems.length;
    const mix = materialMix(id), name = id.split("/").pop()!;
    let route: Plan["route"], role: string | undefined, why: string;
    if (source && source > tileNow && (d.median * source) / tileNow >= STANDARD.min) {
      route = "a"; why = `source art is ${source}px, packed at ${tileNow}px: re-pack at ${Math.min(source, tileNeed)}px`;
    } else if ((mix.wood >= 0.7 || mix.grey >= 0.7 || (mix.wood + mix.grey >= 0.85 && mix.other < 0.1)) && (STANDARD as any).detailRoles?.[mix.grey > mix.wood ? (METAL.test(name) ? "metal" : "stone") : "wood"]) {
      route = "b"; role = mix.grey > mix.wood ? (METAL.test(name) ? "metal" : "stone") : "wood";
      why = `plain ${role} (${pct(Math.max(mix.wood, mix.grey))} ${mix.grey > mix.wood ? "grey" : "wood"} texels)${source ? `, source only ${source}px` : ""}: town ${role} detail at ${STANDARD.target}/m over its own colours`;
    } else {
      route = "c"; why = `painted/mixed art (wood ${pct(mix.wood)} grey ${pct(mix.grey)} other ${pct(mix.other)})${source ? `, source only ${source}px` : ""}: new art for its UV layout`;
    }
    if (!carry) why += `; UVs cannot carry it: ${problems.join("; ")}${route === "c" ? " (re-unwrap first)" : ""}`;
    plans.push({ id, median: d.median, p10: d.p10, factor: f, tileNow, tileNeed, source, route, role, carry, why, kit: !!kitOwner });
  }
  // route (c) on as few square generator pages as possible (shelf pack, 1024 page, 8px gutter)
  const PAGE = 1024, GAP = 8, pages: string[][] = [], shelves: { h: number; x: number }[][] = [];
  for (const p of plans.filter((q) => q.route === "c" && q.carry).sort((a, b) => b.tileNeed - a.tileNeed)) {
    const s = p.tileNeed + GAP;
    let placed = false;
    for (let k = 0; k < pages.length && !placed; k++) {
      for (const sh of shelves[k]) if (sh.x + s <= PAGE && s <= sh.h) { sh.x += s; placed = true; break; }
      const used = shelves[k].reduce((t, sh) => t + sh.h, 0);
      if (!placed && used + s <= PAGE) { shelves[k].push({ h: s, x: s }); placed = true; }
      if (placed) pages[k].push(p.id);
    }
    if (!placed) { pages.push([p.id]); shelves.push([{ h: s, x: s }]); }
  }
  const bulk = kitSides.length ? { props: kitSides.length, side: Math.ceil(Math.sqrt(kitSides.reduce((t, s) => t + (s + 2 * kitPad) ** 2, 0)) * 1.08), nowSide: kitPage } : null;
  return { plans, pages, bulk };
}

// --------------------------------------------------------------- reskin ----
/** Reskin one LOW prop of an atlas kit by route a/b/c (see tools/_prop-reskin.mts), then re-measure and record it. */
async function reskinProp(id: string) {
  if (!STANDARD) throw Error(`no texelDensity standard in ${INDEX}`);
  const route = flag("route") as "a" | "b" | "c";
  if (!["a", "b", "c"].includes(route)) throw Error("reskin <id> --route a|b|c [--role wood|stone] [--art <png>]");
  const owners = catalogued().get(id) ?? [], kitOwner = owners.find((o) => Array.isArray(o.row.tile));
  if (!kitOwner) throw Error(`${id}: not in an atlas kit collection (rows with tile [u, v, scale]); reskin its own texture instead`);
  const { reskin, BAK } = await import("./_prop-reskin.mts");
  const { decodePng, encodePng } = await import("./_png.mjs" as string);
  const kitFile = proj(kitOwner.entry.path), kit = readJson(kitFile), row = kit[kitOwner.entry.entries].find((r: any) => r.id === id);
  if (kit.atlas?.standard) throw Error(`${kitOwner.entry.path} is sized and routed by its generator (${kit.generatedBy}): add "${id.split("/").pop()}" to its ROUTES and re-run it; a reskin here would be wiped`);
  const pageFile = proj(kit.atlas.path);
  const before = density(id), tex = before.textures[0];
  const tilePx = (row.tile[2] * kit.atlas.size[0]) / (before.effective[tex.key] ?? 1);
  const need = Math.ceil((tilePx * STANDARD.target) / before.median);
  // nobody else may sample this slot (POI assemblies reuse kit tiles): their look would change too
  const slotR = [row.tile[0] - 0.01 * row.tile[2], row.tile[1] - 0.01 * row.tile[2], row.tile[0] + 1.01 * row.tile[2], row.tile[1] + 1.01 * row.tile[2]];
  const sharers: string[] = [];
  for (const [other] of catalogued()) {
    if (other === id || !fs.existsSync(prefabFile(ASSETS, other))) continue;
    const g = geometry(other).geo;
    if (g.tris.some((t) => t.tex?.file && path.resolve(t.tex.file) === path.resolve(pageFile) && t.uv?.some(([u, v]) => u > slotR[0] && u < slotR[2] && 1 - v > slotR[1] && 1 - v < slotR[3]))) sharers.push(other);
  }
  if (sharers.length) throw Error(`${id}: its tile is also sampled by ${sharers.join(", ")}; reskinning it would change them too`);
  const img = (f: string) => { const p = decodePng(fs.readFileSync(f)); return { width: p.width, height: p.height, data: p.data }; };
  const roleName = flag("role"), roleDecl = roleName ? (STANDARD as any).detailRoles?.[roleName] : null;
  if (route === "b" && !roleDecl) throw Error(`route b needs --role <${Object.keys((STANDARD as any).detailRoles ?? {}).filter((k) => k !== "note").join("|")}> (texelDensity.detailRoles in ${INDEX})`);
  const art = flag("art");
  if (route === "c" && (!art || !fs.existsSync(art))) throw Error("route c needs --art <png> (generated for the prop: docs/image-generation.md)");
  const modelFile = proj(row.modelPath);
  const res = reskin({
    route, pageFile, atlas: kit.atlas, tile: row.tile, modelFile, tris: geometry(id).geo.tris, need, target: STANDARD.target,
    source: route !== "c" ? img(proj(row.source.textureImage)) : undefined,
    role: roleDecl ? { page: img(locate(ASSETS, "textures", roleDecl.texture)), rect: roleDecl.rect, metres: roleDecl.metres } : undefined,
    art: art ? img(art) : undefined,
    encode: encodePng, decode: (b: Buffer) => img2(decodePng(b)),
  });
  function img2(p: any) { return { width: p.width, height: p.height, data: p.data }; }
  // re-measure from disk
  clearGeometryCaches(); geoCache.clear(); densCache.clear(); pageCache.clear();
  const after = density(id);
  const glb = fs.readFileSync(modelFile), pageBytes = fs.readFileSync(pageFile);
  if (res.page.enlarged > 1) {
    kit.atlas.size = [res.page.after, res.page.after];
    kit.atlas.tile = Math.round(kit.atlas.tile * res.page.enlarged);
    kit.atlas.gutter = Math.round(kit.atlas.gutter * res.page.enlarged);
    kit.atlas.enlarged = { factor: res.page.enlarged, from: res.page.before, date: "2026-10-01", note: `enlarged ${res.page.enlarged}x nearest by props reskin so reskinned props can be drawn finer in their own slots; every other tile is its old art blown up (props measure counts it at its real detail), and every model's normalized UVs still hold` };
  }
  kit.atlas.sha256 = sha(pageBytes);
  row.tile = res.tile;
  row.texelsPerMetre = +after.median.toFixed(1);
  row.modelSha256 = sha(glb);
  row.reskin = {
    route, ...(roleName ? { role: roleName, detail: roleDecl } : {}), ...(art ? { art: path.relative(PROJECT, path.resolve(art)).replaceAll("\\", "/") } : {}),
    content: res.content, date: "2026-10-01", by: "tools/props.mts reskin",
    texelsPerMetre: { before: +before.median.toFixed(1), beforeP10: +before.p10.toFixed(1), after: +after.median.toFixed(1), afterP10: +after.p10.toFixed(1), target: STANDARD.target },
    backups: [`${row.modelPath}${BAK}`, `${kit.atlas.path}${BAK}`],
    note: "applied on top of the generated kit: re-running interior-kit.mjs drops it unless the generator learns per-prop tiles and art",
  };
  fs.writeFileSync(kitFile, JSON.stringify(kit, null, 2) + "\n");
  console.log(`${id}: route ${route}${roleName ? ` (${roleName})` : ""}  texels/m ${before.median.toFixed(1)} (p10 ${before.p10.toFixed(1)}) -> ${after.median.toFixed(1)} (p10 ${after.p10.toFixed(1)})  content ${res.content.join("x")}px in a ${res.slot}px slot; page ${res.page.before} -> ${res.page.after}${res.backups.length ? `\n  backups: ${res.backups.map((b) => path.relative(PROJECT, b)).join(", ")}` : ""}\n  ${densityLine(after)}`);
}

// ---------------------------------------------------------------- proof ----
/** One 3/4 view per prop, 6 per row, in the order given: a quick look at many props at once. */
async function proofSheet(ids: string[]) {
  const THREE = await import("three");
  const { renderStrip } = await import("./_softrender.mjs" as string);
  const { decodePng, encodePng } = await import("./_png.mjs" as string);
  const tile = 220, cols = 6, rows = Math.ceil(ids.length / cols), W = tile * cols, H = tile * rows;
  const rgba = new Uint8Array(W * H * 4);
  const pages = new Map<string, any>();
  ids.forEach((id, k) => {
    const { geo } = geometry(id);
    const mat = geo.tris.find((t) => t.material)?.material;
    if (mat && !pages.has(mat)) {
      const mf = locate(ASSETS, "materials", `${mat}.json`), map = fs.existsSync(mf) ? readJson(mf).map : null, tf = map && locate(ASSETS, "textures", map);
      pages.set(mat, tf && fs.existsSync(tf) ? (() => { const png = decodePng(fs.readFileSync(tf)); return { width: png.width, height: png.height, rgba: png.data }; })() : null);
    }
    const tris = geo.tris.map((t) => ({ p: [t.a, t.b, t.c].map((p) => new THREE.Vector3(p[0], p[1], p[2])), uv: t.uv?.map(([u, v]) => [u, 1 - v]) }));
    if (!tris.length) return;
    const img = renderStrip([{ tris }], [new THREE.Vector3(-0.55, -0.45, -0.75)], mat ? pages.get(mat) : null, tile);
    const ox = (k % cols) * tile, oy = Math.floor(k / cols) * tile;
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) for (let c = 0; c < 4; c++) rgba[((oy + y) * W + ox + x) * 4 + c] = img.rgba[(y * tile + x) * 4 + c];
  });
  const outDir = flag("out") ?? path.join(os.tmpdir(), "hitreg-props-proofs");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `sheet-${ids.length}.png`);
  fs.writeFileSync(out, Buffer.from(encodePng(W, H, rgba)));
  const names = ids.map((id, k) => (k % cols === 0 ? `
  row ${k / cols + 1}: ` : "") + id.split("/").pop()).join(" ");
  console.log(`${out}${names}`);
}

async function proof(id: string) {
  const THREE = await import("three");
  const { renderStrip } = await import("./_softrender.mjs" as string);
  const { decodePng, encodePng } = await import("./_png.mjs" as string);
  const all = catalogued(), owners = all.get(id) ?? [];
  const dcl = owners.length ? lookup(id, owners) : null;
  const decl = dcl?.kind === "declared" ? dressingSchema.parse(dcl.raw) : null;
  const { geo } = geometry(id);
  const V = (p: number[]) => new THREE.Vector3(p[0], p[1], p[2]);
  // texture: the first mesh material's map (kits share one page)
  let texture: any = null;
  const mat = geo.tris.find((t) => t.material)?.material;
  if (mat) {
    const mf = locate(ASSETS, "materials", `${mat}.json`);
    if (fs.existsSync(mf)) {
      const map = readJson(mf).map, tf = map && locate(ASSETS, "textures", map);
      if (tf && fs.existsSync(tf)) { const png = decodePng(fs.readFileSync(tf)); texture = { width: png.width, height: png.height, rgba: png.data }; }
    }
  }
  const mount = decl?.mount ?? "floor";
  // where the prop's origin sits in the test frame
  let base: V3 = [0, 0, 0];
  const host: any[] = [];
  const box = (min: V3, max: V3, color: number[]) => {
    const c = (x: number, y: number, z: number) => [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]];
    const q = (a: number[], b: number[], cc: number[], d: number[]) => { host.push({ p: [a, b, cc].map(V), color }, { p: [a, cc, d].map(V), color }); };
    q(c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)); q(c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)); q(c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0));
    q(c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)); q(c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0));
  };
  const s = decl?.size ?? [1, 1, 1];
  if (mount === "wall") base = [0, (decl?.wallHeight[0] ?? 1.2) + 0, 0];
  if (mount === "ceiling") base = [0, 3, 0];
  if (mount === "surface" || mount === "slot") { box([-0.6, 0, -0.4], [0.6, 0.85, 0.4], [120, 95, 70]); base = [0, 0.85, 0]; }
  const back = mount === "wall" ? 0 : -s[2] / 2; // a wall prop's origin is its back; a floor prop's back is half its depth behind
  if (mount === "wall" || (mount === "floor" && decl?.against === "wall")) box([-1.5, 0, back - 0.1], [1.5, 3, back], [110, 110, 120]);
  if (mount === "ceiling") box([-1.5, 3, -1.5], [1.5, 3.1, 1.5], [110, 110, 120]);
  if (mount === "wall") base = [0, base[1] + (dressingOrigin(decl!) === "back" ? s[1] / 2 : 0), 0];
  box([-1.6, -0.05, -0.2], [1.6, 0, 1.8], [80, 90, 80]); // floor
  // 1.8 m figure to the side
  const fx = Math.max(0.6, s[0] / 2 + 0.5);
  box([fx, 0, 0.3], [fx + 0.45, 1.8, 0.55], [200, 80, 60]);
  box([fx + 0.12, 1.8, 0.35], [fx + 0.33, 1.8 + 0.001, 0.5], [200, 80, 60]);
  const tris = geo.tris.map((t) => ({ p: [t.a, t.b, t.c].map((p) => V([p[0] + base[0], p[1] + base[1], p[2] + base[2]])), uv: t.uv?.map(([u, v]) => [u, 1 - v]) }));
  // sockets as thin yellow plates
  for (const sk of decl?.provides ?? []) if (sk.kind === "surface") {
    const [x, y, z] = sk.position, hx = sk.size[0] / 2, hz = sk.size[1] / 2;
    box([x - hx + base[0], y + base[1] + 0.003, z - hz + base[2]], [x + hx + base[0], y + base[1] + 0.006, z + hz + base[2]], [230, 200, 40]);
  }
  const views = [V([0.15, -0.25, -1]), V([-1, -0.3, -0.6]), V([0.6, -0.9, -0.6])];
  const img = renderStrip([{ tris: [...host, ...tris] }, { tris }], views, texture, 300);
  const outDir = flag("out") ?? path.join(os.tmpdir(), "hitreg-props-proofs");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${id.replaceAll("/", "__")}.png`);
  fs.writeFileSync(out, Buffer.from(encodePng(img.width, img.height, img.rgba)));
  console.log(`${out}\n  columns: in context (${mount}${decl?.against === "wall" ? ", against a wall" : ""}; red = 1.8 m figure; yellow = surface sockets) | prop alone. rows: front, side, above`);
}

// ----------------------------------------------------------------- main ----
async function main() {
  decode = (await import("./_png.mjs" as string)).decodePng;
  if (cmd === "measure") {
    const ids = positional.length ? positional : flags.all ? [...catalogued(flag("catalog"))].map(([k]) => k) : [];
    if (!ids.length) throw Error("measure <prefab id...> | --all [--catalog <path>]");
    for (const id of ids) {
      const { geo, m } = geometry(id);
      console.log(`${id} size ${m.size.join("x")} origin ${m.origin} (${m.originAt.join(",")}) tris ${m.triangles}${geo.effects.length ? " fx " + geo.effects.join(",") : ""}${geo.warnings.length ? " WARN " + geo.warnings.join("; ") : ""}`);
      console.log(`   ${densityLine(density(id))}`);
      if (flags.surfaces) for (const s of findSurfaces(geo)) console.log(`   surface y=${s.position[1]} at ${s.position[0]},${s.position[2]} ${s.size.join("x")} clear ${s.clearHeight}`);
    }
    return;
  }
  if (cmd === "suggest") {
    const all = catalogued();
    const ids = positional.length ? positional : flags.all ? [...catalogued(flag("catalog"))].map(([k]) => k) : [];
    if (!ids.length) throw Error("suggest <prefab id...> | --all [--catalog <path>]");
    const out: Record<string, unknown> = {};
    for (const id of ids) out[id] = suggest(id, all.get(id) ?? []);
    console.log(flags.compact ? Object.entries(out).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join("\n") : JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === "status") {
    const { rows, data: statusData } = evaluate(flag("catalog"));
    const bad = rows.filter((r) => r.state !== "ok");
    if (flags.next) {
      const r = bad[0];
      console.log(r ? `${r.state} ${r.id}: ${r.why.join("; ")}\n  next: npx tsx tools/props.mts ${r.why.some((w) => /run sync/.test(w)) && r.why.length === 1 ? "sync" : `suggest ${r.id}`} --project ${projectName}` : "all props ok");
    }
    // texel density: its own column and count, a FINDING (never the exit code) until LOW props are reskinned
    const dens = new Map<string, { s: string; m: number }>();
    if (STANDARD) for (const r of rows) {
      if (r.state === "MISSING") continue;
      try { const d = density(r.id); dens.set(r.id, { s: densityState(d), m: d.median }); } catch { dens.set(r.id, { s: "n/a", m: NaN }); }
    }
    const dcol = (id: string) => { const d = dens.get(id); return !STANDARD ? "" : !d || d.s === "n/a" ? "  -       " : `${d.s.padEnd(4)} ${d.m.toFixed(0).padStart(4)} `; };
    if (!flags.next)
      for (const r of rows) if (!flags.quiet || r.state !== "ok" || ["LOW", "HIGH"].includes(dens.get(r.id)?.s ?? "")) console.log(`${r.state.padEnd(7)} ${dcol(r.id)}${r.id}${r.exempt ? `  (exempt: ${r.exempt})` : ""}${r.why.length ? "  - " + r.why.join("; ") : ""}`);
    const count = (s: string) => rows.filter((r) => r.state === s).length;
    const blocked = rows.filter((r) => r.exempt?.startsWith("BLOCKED"));
    console.log(`\n${rows.length} catalogued prefabs: ${count("ok")} ok (${rows.filter((r) => r.exempt && r.state === "ok").length} exempt, of which ${blocked.length} BLOCKED until re-posed), ${count("STALE")} STALE, ${count("MISSING")} MISSING`);
    {
      const data = statusData;
      const untagged = [...data].filter(([, d]) => d.mount !== "part" && (!d.scale || !d.cultures)).map(([id]) => id);
      if (untagged.length) console.log(`UNTAGGED ${untagged.length} declared prop(s) without a scale class or cultures (a finding; a place that declares its scale/cultures hides and warns on them): ${untagged.slice(0, 12).join(", ")}${untagged.length > 12 ? ", ..." : ""}`);
    }
    if (flags.quiet) for (const r of blocked) console.log(`BLOCKED ${r.id}: ${r.exempt!.replace(/^BLOCKED:?\s*/, "")}`);
    if (STANDARD) {
      const n = (s: string) => [...dens.values()].filter((d) => d.s === s).length;
      console.log(`texel density (median texels/m; target ${STANDARD.target}, min ${STANDARD.min}): ${n("ok")} ok, ${n("LOW")} LOW, ${n("HIGH")} HIGH, ${n("n/a")} n/a  (LOW and HIGH are findings, not a gate: LOW -> props reskin-plan; HIGH -> rescale the UVs or use a town role tile)`);
    }
    if (!flag("catalog")) {
      // every prefab is either a catalogued row or inside a registered exempt folder: nothing is invisible by accident
      const lost = uncatalogued();
      if (lost.length) { console.log(`MISSING ${lost.length} prefab(s) in no catalog and no exemptFolders entry of ${INDEX} (invisible to builders): ${lost.slice(0, 12).join(", ")}${lost.length > 12 ? ", ..." : ""}`); process.exitCode = 1; }
      const dup = duplicates();
      if (dup.length) {
        console.log(`\n${dup.length} site-made prefab(s) remake something the catalogue offers (a finding, not the exit code; new ones are refused by \`props dupes <id>\`):`);
        if (!flags.quiet) for (const d of dup) console.log(`  ${dupeLine(d)}`);
      }
    }
    if (fs.existsSync(INDEX_OUT)) {
      const t = fs.statSync(INDEX_OUT).mtimeMs, newer = registry.catalogs.some((c) => c.dressing && fs.existsSync(proj(c.dressing)) && fs.statSync(path.join(PROJECT, c.dressing)).mtimeMs > t);
      if (newer) { console.log("STALE   prop-index.json is older than a sidecar (run index)"); process.exitCode = 1; }
    } else { console.log("MISSING prop-index.json (run index)"); process.exitCode = 1; }
    if (bad.length) process.exitCode = 1;
    return;
  }
  if (cmd === "sync") {
    const r = sync();
    console.log(`sync: ${r.changed.length} prefab(s) updated, ${r.rehashed.length} catalog hash(es) refreshed`);
    for (const s of r.staleHash) console.log(`  catalog hash was already stale, left alone: ${s}`);
    return;
  }
  if (cmd === "index") {
    const out = buildIndex();
    console.log(`${path.relative(process.cwd(), INDEX_OUT)}: ${out.props.length} placeable props, ${out.sets.length} sets`);
    return;
  }
  if (cmd === "menu") return menu();
  if (cmd === "dupes") {
    // with ids: the intake check a builder runs on its NEW prefabs before cataloguing them (exit 1 on a duplicate)
    const list = duplicates(positional.length ? positional : undefined);
    for (const d of list) console.log(dupeLine(d));
    console.log(list.length ? `${list.length} duplicate(s): use the existing prop (props menu --search <word>), or wrap / variant / compose it` : "no duplicates");
    if (positional.length && list.length) process.exitCode = 1;
    return;
  }
  if (cmd === "wrap" || cmd === "variant" || cmd === "compose") {
    const make = await import("./_prop-make.mts");
    const ctx = { project: PROJECT, assets: ASSETS, registryFile: path.join(PROJECT, INDEX) };
    const num = (k: string) => (flag(k) !== undefined ? Number(flag(k)) : undefined);
    const decl = flag("decl") ? JSON.parse(flag("decl")!) : undefined, force = !!flags.force, note = flag("note");
    let out: unknown;
    if (cmd === "wrap") {
      if (!positional[0] || !flag("id")) throw Error("wrap <source prefab> --id <collection/name> [--scale s] [--yaw deg] [--pitch deg] [--roll deg] [--decl '<json>'] [--note text]");
      out = make.wrap(ctx, positional[0], flag("id")!, { scale: num("scale"), yaw: num("yaw"), pitch: num("pitch"), roll: num("roll"), decl, force, note });
    } else if (cmd === "variant") {
      if (!positional[0] || !flag("id")) throw Error("variant <source prefab> --id <collection/name> --material <id> | --art <png> [--part <entity>[,<entity>]] [--triplanar <m per tile>] [--decl '<json>']");
      out = make.variant(ctx, positional[0], flag("id")!, { material: flag("material"), art: flag("art"), part: flag("part")?.split(","), triplanar: num("triplanar"), decl, force, note });
    } else {
      if (!positional[0]) throw Error("compose <recipe.json>");
      // a composite never mixes cultures or scales, nor resizes a prop to stand in for another: that is a prop request
      const recipe = readJson(path.resolve(positional[0]));
      const dressingOf = (pid: string) => { try { const { d, rootId } = prefabRoot(pid); return d.entities[rootId]?.components?.dressing; } catch { return undefined; } };
      const faults = compositeFaults(recipe, dressingOf, vocabulary());
      if (faults.length) {
        console.error(`REFUSED compose ${recipe.id}: ${faults.join("; ")}.\nA missing object is a PROP REQUEST, not a composite: npx tsx tools/props.mts request add --name "<the thing>" --culture <c> --scale <s> --for <place> --why "<what it is for>" (authoring/dressing/prop-requests.json), and leave the spot for it.`);
        process.exitCode = 1;
        return;
      }
      out = make.compose(ctx, positional[0], { force });
    }
    console.log(JSON.stringify(out));
    // the new prefab and its collection are now catalogued: compile its declaration onto the root like any other
    docCache.clear();
    Object.assign(registry, mergedRegistry());
    const r = sync();
    console.log(`sync: ${r.changed.length} prefab(s) updated. next: props status --catalog authoring/${(flag("id") ?? (out as any).id).replace(/\/[^/]+$/, "")}/catalog.json, props proof <id>, then props index`);
    return;
  }
  if (cmd === "request") {
    if (positional[0] === "add") {
      const need = (k: string) => { const v = flag(k); if (!v) throw Error(`request add --name <thing> --culture <c> --scale <s> --for <place> [--why text]: --${k} missing`); return v; };
      const v = vocabulary(), culture = need("culture"), scale = need("scale");
      if (!v.cultures.some((c) => c.id === culture)) throw Error(`culture "${culture}" not in the dressing vocabulary (${v.cultures.map((c) => c.id).join(", ")})`);
      if (!v.scales.some((c) => c.id === scale)) throw Error(`scale "${scale}" not in the dressing vocabulary (${v.scales.map((c) => c.id).join(", ")})`);
      const r = addRequest(PROJECT, { name: need("name"), culture, scale, for: need("for"), why: flag("why") ?? "" });
      console.log(`prop request ${r.id} (${r.status}) for ${r.for} -> ${path.relative(process.cwd(), requestsFile(PROJECT))}`);
      return;
    }
    const list = readRequests(PROJECT).filter((r) => flags.all || r.status === "open");
    const by = new Map<string, typeof list>();
    for (const r of list) by.set(r.culture, [...(by.get(r.culture) ?? []), r]);
    for (const [c, rows] of by) { console.log(`${c}:`); for (const r of rows) console.log(`  ${r.id.padEnd(32)} ${r.scale.padEnd(6)} ${r.status.padEnd(7)} for ${r.for}${r.why ? ` - ${r.why}` : ""}`); }
    console.log(`${list.length} ${flags.all ? "" : "open "}prop request(s)`);
    return;
  }
  if (cmd === "report") { const out = propReport(); console.log(`prop report -> ${path.relative(process.cwd(), out)}`); return; }
  if (cmd === "reskin") { if (!positional[0]) throw Error("reskin <prefab id> --route a|b|c [--role r] [--art png]"); return reskinProp(positional[0]); }
  if (cmd === "reskin-plan") {
    const { plans, pages, bulk } = reskinPlan();
    if (flags.json) { console.log(JSON.stringify({ standard: STANDARD, plans, routeCPages: pages, bulk }, null, 2)); return; }
    console.log(`# ${plans.length} LOW props (median below ${STANDARD!.min} texels/m; target ${STANDARD!.target}). tile = px on its page now -> needed for the target.`);
    for (const r of ["a", "b", "c"] as const) {
      const list = plans.filter((p) => p.route === r);
      console.log(`\nroute (${r}) ${r === "a" ? "re-pack from the larger source art" : r === "b" ? "town material detail over its own colours" : "new art for its own UV layout"}: ${list.length}`);
      for (const p of list.sort((x, y) => x.median - y.median))
        console.log(`  ${p.id.padEnd(34)} ${p.median.toFixed(1).padStart(5)}/m (p10 ${p.p10.toFixed(1)}) x${p.factor.toFixed(2)}  tile ${p.tileNow}->${p.tileNeed}px${p.role ? `  [${p.role}]` : ""}  ${p.carry ? "" : "UV-BLOCKED "}${p.why}`);
    }
    console.log(`\nroute (c) image requests: ${pages.length} square 1024 page(s)${pages.map((pg, k) => `\n  page ${k + 1}: ${pg.join(", ")}`).join("")}`);
    const blocked = plans.filter((p) => !p.carry);
    if (blocked.length) console.log(`UV-blocked (need a re-unwrap or a re-pose before any art): ${blocked.map((p) => p.id).join(", ")}`);
    if (bulk) console.log(`\nkit in bulk: all ${bulk.props} tiled kit props drawn at ${STANDARD!.target}/m would fit one ~${bulk.side}px square page (now ${bulk.nowSide}px): over-dense small props shrink, LOW ones grow`);
    return;
  }
  if (cmd === "proof") { if (!positional[0]) throw Error("proof <prefab id> | proof --sheet <id...>"); return void (flags.sheet ? proofSheet(positional) : proof(positional[0])).catch((e) => { console.error(e); process.exitCode = 1; }); }
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exitCode = cmd ? 1 : 0;
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
