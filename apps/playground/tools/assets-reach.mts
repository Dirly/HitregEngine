// What a project's kept scenes actually use — and what nothing uses.
//
//   npx tsx tools/assets-reach.mts <project> [--keep a,b,c | --keep-file f.txt] [--json out.json]
//                                  [--archive <dir>] [--dry]
//                                  [--kinds models,worlds,…]  only report/archive these kinds
//                                  [--wholesale items,spells,…] [--no-catalogs]  narrow the implicit roots
//                                  [--stop-kinds worlds,quests,…]  never reach these kinds except as roots
//                                  [--check-deps]  list references that resolve only in projects outside dependsOn
//
// Roots: the kept scenes (default: every scene project.json lists), every script of the
// project closure (project + dependsOn), the engine/playground source, and the data kinds the
// server/client load wholesale (items, spells, quests, dialogues, shops, …). From the roots it
// follows every string to the asset files it names — scene → world recipe → materials →
// textures, prefab → model → .bin, spritesheet → png — until nothing new turns up.
//
// Matching is deliberately conservative: a file is USED if any reached file mentions its path
// relative to its kind folder, with or without extension, and a code string with a `${`
// template (`mobs/${name}`) keeps everything under that prefix. A false "used" costs disk;
// a false "unused" breaks a game, so the rule leans one way.
//
// --archive moves the unused files of THIS project (not its dependencies) to <dir>, keeping
// relative paths, and writes <dir>/MOVED.json ([from, to] pairs) so it can be undone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(HERE, "..");
const ENGINE = path.resolve(PLAYGROUND, "../..");
const PROJECTS = path.join(PLAYGROUND, "projects");

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const project = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && ["keep", "keep-file", "json", "archive", "kinds", "also", "wholesale", "stop-kinds"].includes(args[i - 1].slice(2))));
if (!project) { console.error("usage: assets-reach.mts <project> [--keep a,b] [--keep-file f] [--json out] [--archive dir] [--dry]"); process.exit(1); }

/** Data kinds loaded wholesale (every file is live without a reference). */
const WHOLESALE = new Set(["items", "spells", "quests", "dialogues", "shops", "places", "progression", "creation",
  "perform-actions", "fx-catalog", "fx-templates", "vfx", "stories"]);
const TEXT = /\.(json|gltf|ts|mts|mjs|js|md|txt|svg|atlas)$/i;

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const walk = (d: string): string[] => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.name === ".git" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

// ---- project closure -----------------------------------------------------------------------
const closure: string[] = [];
const visit = (p: string) => {
  if (closure.includes(p)) return;
  closure.push(p);
  const mf = path.join(PROJECTS, p, "project.json");
  if (fs.existsSync(mf)) for (const d of readJson(mf).dependsOn ?? []) visit(d);
};
visit(project);

// ---- index every asset file ------------------------------------------------------------------
type Asset = { file: string; project: string; kind: string; rel: string; bytes: number };
const assets: Asset[] = [];
for (const p of closure) {
  const root = path.join(PROJECTS, p, "assets");
  for (const file of walk(root)) {
    const relToAssets = path.relative(root, file).split(path.sep).join("/");
    const [kind, ...rest] = relToAssets.split("/");
    assets.push({ file, project: p, kind, rel: rest.join("/"), bytes: fs.statSync(file).size });
  }
}
/** Lookup by kind-relative path with and without extension. */
const byKey = new Map<string, Asset[]>();
const add = (k: string, a: Asset) => { const l = byKey.get(k); if (l) l.push(a); else byKey.set(k, [a]); };
for (const a of assets) { add(a.rel, a); add(a.rel.replace(/\.[^./]+$/, ""), a); }
const relSorted = [...new Set(assets.map((a) => a.rel))].sort();

// --check-deps: the same index over every project OUTSIDE the closure. A reference that resolves only
// there is a missing dependsOn (or a file that has to be copied in) — at runtime it is simply missing.
const checkDeps = args.includes("--check-deps");
const outside = new Map<string, string[]>();
if (checkDeps) {
  for (const p of fs.readdirSync(PROJECTS)) {
    if (closure.includes(p) || !fs.existsSync(path.join(PROJECTS, p, "assets"))) continue;
    const root = path.join(PROJECTS, p, "assets");
    for (const file of walk(root)) {
      const rel = path.relative(root, file).split(path.sep).join("/").split("/").slice(1).join("/");
      for (const k of [rel, rel.replace(/.[^./]+$/, "")]) { const l = outside.get(k); if (l) { if (!l.includes(p)) l.push(p); } else outside.set(k, [p]); }
    }
  }
}
const crossRefs = new Map<string, Set<string>>(); // "project: key" -> referring files

// ---- string extraction -----------------------------------------------------------------------
const reached = new Set<Asset>();
const queue: string[] = [];
const scanned = new Set<string>();
const prefixes = new Set<string>();

function normalize(s: string): string[] {
  let t = s.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/[?#].*$/, "");
  const out = [t];
  t = t.replace(/^.*?\/?assets\//, "");
  out.push(t);
  const slash = t.indexOf("/");
  if (slash > 0) out.push(t.slice(slash + 1)); // drop a leading kind folder (textures/…, models/…)
  return out;
}

function mention(s: string, fromFile: string | null, whole = true) {
  if (s.length < 2) return;
  if (whole) {
    // lists in one string ("footsteps/a.mp3,footsteps/b.mp3"), url(...) in CSS, paths in prose
    const parts = s.split(/[,;\s()'"<>|]+/).filter((p) => p && p !== s);
    for (const p of parts) mention(p, fromFile, false);
    if (s.length > 400) return;
  }
  if (s.includes("${")) {
    for (const n of normalize(s.slice(0, s.indexOf("${")))) if (n.length >= 3) prefixes.add(n);
    return;
  }
  const cands = normalize(s);
  if (fromFile && /[./]/.test(s)) {
    // relative to the referring file (gltf uri, spritesheet image) — as a kind-relative path
    const abs = path.resolve(path.dirname(fromFile), s);
    for (const p of closure) {
      const root = path.join(PROJECTS, p, "assets");
      if (abs.startsWith(root)) cands.push(path.relative(root, abs).split(path.sep).join("/").replace(/^[^/]+\//, ""));
    }
  }
  let found = false;
  for (const c of cands) for (const k of [c, c.replace(/\.[^./]+$/, "")]) for (const a of byKey.get(k) ?? []) { hit(a); found = true; }
  if (checkDeps && !found && fromFile && fromFile.startsWith(PROJECTS) && s.includes("/")) {
    for (const c of cands) {
      const ps = outside.get(c) ?? outside.get(c.replace(/\.[^./]+$/, ""));
      if (!ps) continue;
      const key = `${ps.join("|")}: ${c}`;
      const set = crossRefs.get(key) ?? new Set<string>();
      set.add(path.relative(PROJECTS, fromFile).split(path.sep).join("/"));
      crossRefs.set(key, set);
      break;
    }
  }
}

const stopKinds = new Set(opt("stop-kinds")?.split(",") ?? []);
const roots = new Set<Asset>();
function hit(a: Asset) {
  if (reached.has(a)) return;
  if (stopKinds.has(a.kind) && !roots.has(a)) return;
  reached.add(a);
  // a world recipe keeps its map picture and layers (loaded by world name, never referenced)
  if (a.kind === "worlds") { const w = a.rel.replace(/.json$/, ""); for (const m of assets) if (m.kind === "maps" && m.rel.startsWith(w + ".")) hit(m); }
  if (TEXT.test(a.file)) queue.push(a.file);
}

function scan(file: string) {
  if (scanned.has(file)) return;
  scanned.add(file);
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  if (/\.(json|gltf)$/i.test(file)) {
    try {
      const v = JSON.parse(text);
      const rec = (x: unknown): void => {
        if (typeof x === "string") mention(x, file);
        else if (Array.isArray(x)) x.forEach(rec);
        else if (x && typeof x === "object") for (const [k, val] of Object.entries(x)) { if (k.includes("/")) mention(k, file); rec(val); }
      };
      // gltf: skip the big numeric arrays, keep uris and names
      rec(v);
      return;
    } catch { /* fall through to the text scan */ }
  }
  for (const m of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*?)\1/g)) mention(m[2], file);
}

// ---- roots -----------------------------------------------------------------------------------
const manifest = readJson(path.join(PROJECTS, project, "project.json"));
let keep: string[] | null = null;
if (opt("keep")) keep = opt("keep")!.split(",").map((s) => s.trim()).filter(Boolean);
if (opt("keep-file")) keep = fs.readFileSync(opt("keep-file")!, "utf8").split(/\r?\n/).map((s) => s.replace(/#.*/, "").trim()).filter(Boolean);
if (!keep) keep = (manifest.scenes ?? []).flatMap((s: { id: string; variants?: string[] }) => [s.id, ...(s.variants ?? [])]);

const sceneAssets = assets.filter((a) => a.kind === "scenes");
for (const id of keep) {
  const hits = sceneAssets.filter((a) => a.rel === `${id}.scene.json`);
  if (!hits.length) console.warn(`keep: no scene "${id}" in ${closure.join(", ")}`);
  hits.forEach((a) => { roots.add(a); hit(a); });
}
// every project in the closure's project.json lists its own scenes; portals name instance scenes
// by id, which `mention` resolves through the scenes kind like any other asset
const wholesale = opt("wholesale") ? new Set(opt("wholesale")!.split(",")) : WHOLESALE;
for (const a of assets) if (wholesale.has(a.kind)) { roots.add(a); hit(a); }
for (const p of closure) for (const f of walk(path.join(PROJECTS, p, "scripts"))) if (TEXT.test(f)) queue.push(f);
// catalogued props are live for dressing even when no scene places them yet (docs/prop-cataloging.md)
for (const p of args.includes("--no-catalogs") ? [] : closure) {
  const idx = path.join(PROJECTS, p, "authoring", "prop-catalogs.json");
  if (!fs.existsSync(idx)) continue;
  queue.push(idx);
  for (const c of readJson(idx).catalogs ?? []) for (const f of [c.path, c.dressing]) if (f) queue.push(path.join(PROJECTS, p, f));
}
for (const f of opt("also")?.split(",") ?? []) queue.push(path.resolve(f));
for (const f of walk(path.join(PLAYGROUND, "src"))) if (TEXT.test(f)) queue.push(f);
for (const pkg of fs.readdirSync(path.join(ENGINE, "packages"))) for (const f of walk(path.join(ENGINE, "packages", pkg, "src"))) if (TEXT.test(f)) queue.push(f);

while (queue.length) scan(queue.pop()!);
// template prefixes keep whole subtrees; re-run the queue for anything they pull in
let grew = true;
while (grew) {
  grew = false;
  for (const pre of prefixes) {
    let i = lowerBound(relSorted, pre);
    for (; i < relSorted.length && relSorted[i].startsWith(pre); i++) for (const a of byKey.get(relSorted[i]) ?? []) if (!reached.has(a)) { const before = reached.size; hit(a); if (reached.size > before) grew = true; }
  }
  while (queue.length) scan(queue.pop()!);
}
function lowerBound(arr: string[], x: string) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

// ---- report ----------------------------------------------------------------------------------
const mine = assets.filter((a) => a.project === project);
const kinds = opt("kinds")?.split(",");
const unused = mine.filter((a) => !reached.has(a) && (!kinds || kinds.includes(a.kind)));
const mb = (n: number) => (n / 1e6).toFixed(1);
const sum = (l: Asset[]) => l.reduce((s, a) => s + a.bytes, 0);
console.log(`${project}: closure ${closure.join(" + ")}; kept scenes ${keep.length}`);
console.log(`  used   ${mine.length - unused.length} files ${mb(sum(mine) - sum(unused))} MB`);
console.log(`  unused ${unused.length} files ${mb(sum(unused))} MB`);
const groups = new Map<string, Asset[]>();
for (const a of unused) { const g = `${a.kind}/${a.rel.split("/").slice(0, a.rel.includes("/") ? 1 : 0).join("/")}`; groups.set(g, [...(groups.get(g) ?? []), a]); }
for (const [g, l] of [...groups].sort((x, y) => sum(y[1]) - sum(x[1])).slice(0, 40)) console.log(`   ${mb(sum(l)).padStart(7)} MB ${String(l.length).padStart(5)}  ${g}`);

if (checkDeps) {
  console.log(`  references into projects outside the closure: ${crossRefs.size}`);
  for (const [k, from] of [...crossRefs].slice(0, 60)) console.log(`   ${k}  <- ${[...from].slice(0, 2).join(", ")}${from.size > 2 ? ` (+${from.size - 2})` : ""}`);
}
if (opt("json")) fs.writeFileSync(opt("json")!, JSON.stringify({ project, closure, keep, unused: unused.map((a) => `${a.kind}/${a.rel}`), used: mine.filter((a) => reached.has(a)).map((a) => `${a.kind}/${a.rel}`) }, null, 1));

const dest = opt("archive");
if (dest) {
  const moved: [string, string][] = [];
  for (const a of unused) {
    const to = path.join(dest, "assets", a.kind, a.rel);
    moved.push([a.file, to]);
    if (args.includes("--dry")) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(a.file, to);
  }
  if (!args.includes("--dry")) {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "MOVED.json"), JSON.stringify(moved, null, 1));
  }
  console.log(`${args.includes("--dry") ? "would move" : "moved"} ${moved.length} files to ${dest}`);
}
