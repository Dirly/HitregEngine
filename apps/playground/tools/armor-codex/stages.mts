/**
 * The `armor` stages with their IO: brief lint → gen → import → bake → items → review. Each stage leaves a stamp
 * (.hitreg/armor-codex/<set>/state.json: ok, when, a fingerprint of what it read) so `status` can say
 * ok / STALE / MISSING / FAILED per stage, like `worldgen status`. A failing gate keeps the stage for a retry and
 * installs nothing; the next stage refuses to run until it is ok.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { partsHiddenBy } from "@hitreg/core";
import { decodePng, encodePng } from "../_png.mjs";
import { armorBriefSchema, briefTemplate, matchesOf, SLOTS, HELM_BASES, HELM_ORNATE, type ArmorBrief } from "./schema.mts";
import { buildItems, buildManifest, briefLint, crossSetLint, itemsLint, genWaves, sessionImages, afterRule, parseRules, sheetIds, bodyThemes, bodySheetId, setSheets, piecesOf, sheetWeights, MODEL, bodyParts, type ModelFacts, type GenImage, type Templates, type Piece as SetPiece } from "./set.mts";
import { lootPlanSchema, lootPlanLint, type LootPlan } from "./loot.mts";
import { readGlb, worldScale, type Glb } from "./glb.mts";
import { bodyHoles, freeEdges, density, femaleChest, keyMask, type Img, type SlotSpec } from "./measure.mts";
import { mountMatrices, renderView, frontDir, femaleParts, composeSheet, readPng, writePng, type Mount, type Piece, type Sex } from "./review.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PG = path.resolve(HERE, "../..");
export const ENGINE = path.resolve(PG, "../..");
const ATLAS = path.join(ENGINE, "tools/atlas");
export const STAGES = ["brief", "gen", "import", "bake", "items", "review"] as const;
export type Stage = (typeof STAGES)[number];

export interface Ctx { project: string; force: boolean; dryRun: boolean; log: (s: string) => void; /** gen: roles to make again, with every sheet painted from them */ redo?: string[] }
export interface StageResult { ok: boolean; lines: string[]; tokens?: number }

export const paths = (project: string, id = "") => {
  const authoring = path.join(PG, "projects", project, "authoring", "armor-sets");
  const assets = path.join(PG, "projects", project, "assets");
  return {
    authoring,
    assets,
    brief: path.join(authoring, `${id}.json`),
    review: path.join(authoring, "review", `${id}.png`),
    ledger: path.join(authoring, "ledger.md"),
    stage: path.join(PG, ".hitreg", "armor-codex", id),
    model: (m: string) => path.join(assets, "models", ...m.split("/")),
    texture: (t: string) => path.join(assets, "textures", ...t.split("/")),
    item: (i: string) => path.join(assets, "items", `${i}.json`),
  };
};
export const atlasOut = (set: "human-body" | "human-helm" | "human-shoulder", theme: string) => path.join(ATLAS, "out", set, theme, "atlas.png");
/** Every art sheet of a set: each body theme and its woman's sheet, then helm and shoulder. */
const artFiles = (b: ArmorBrief): string[] => [
  ...bodyThemes(b).flatMap((t) => [path.join(ATLAS, "art/human-body", `${t}.png`), path.join(ATLAS, "art/human-body", `${t}-f.png`)]),
  path.join(ATLAS, "art/human-helm", `${b.id}.png`),
  path.join(ATLAS, "art/human-shoulder", `${b.id}.png`),
];
/** Every imported atlas of a set (tools/atlas/out). */
const outFiles = (b: ArmorBrief): string[] => [...bodyThemes(b).flatMap((t) => [atlasOut("human-body", t), atlasOut("human-body", `${t}-f`)]), atlasOut("human-helm", b.id), atlasOut("human-shoulder", b.id)];
/** An instance's loot plan (null for a kit, or when the file is missing). */
export function readPlan(project: string, b: ArmorBrief): LootPlan | null {
  if (b.kind !== "instance" || !b.loot) return null;
  const f = path.join(paths(project).authoring, ...b.loot.split("/"));
  return fs.existsSync(f) ? lootPlanSchema.parse(JSON.parse(fs.readFileSync(f, "utf8"))) : null;
}
const keyPng = (set: string, file = "key.png") => path.join(ATLAS, "sets", set, file);
const manifestOf = (set: string): { slots: Record<string, SlotSpec> } => JSON.parse(fs.readFileSync(path.join(ATLAS, "sets", set, "manifest.json"), "utf8"));
const png = (f: string): Img => decodePng(fs.readFileSync(f));
const sha = (...files: string[]) => {
  const h = crypto.createHash("sha1");
  for (const f of files) h.update(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from(`missing:${f}`));
  return h.digest("hex").slice(0, 16);
};
const shaText = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- facts
export function readBrief(project: string, id: string): ArmorBrief {
  const f = paths(project, id).brief;
  if (!fs.existsSync(f)) throw new Error(`no brief ${path.relative(PG, f)}: armor brief new ${id} --project ${project}`);
  return armorBriefSchema.parse(JSON.parse(fs.readFileSync(f, "utf8")));
}
export function listBriefs(project: string): string[] {
  const d = paths(project).authoring;
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
}
export function loadTemplates(): Templates {
  const r = (f: string) => afterRule(fs.readFileSync(path.join(ATLAS, "sets", f), "utf8"));
  return { body: r("human-body/prompt.md"), female: r("human-body/prompt-female.md"), helm: r("human-helm/prompt.md"), shoulder: r("human-shoulder/prompt.md") };
}
export function loadFacts(project: string): ModelFacts {
  const p = paths(project);
  const one = (m: string) => {
    const g = readGlb(p.model(m));
    const byIndex = Object.fromEntries(Object.entries(g.parts).map(([n, i]) => [i, n]));
    const tris: Record<string, number> = {};
    for (const t of g.tris) { const n = byIndex[t.part]; if (n) tris[n] = (tris[n] ?? 0) + 1; }
    return { parts: Object.keys(g.parts), rules: parseRules(g.rules), tiles: Object.keys(g.tiles), tris };
  };
  return { body: one(MODEL.body), helm: one(MODEL.helm), shoulder: one(MODEL.shoulder) };
}
export const manifestKeys = () => ({
  body: Object.keys(manifestOf("human-body").slots),
  helm: Object.keys(manifestOf("human-helm").slots),
  shoulder: Object.keys(manifestOf("human-shoulder").slots),
});

// ---------------------------------------------------------------- stamps
interface Stamp { ok: boolean; at: string; fp: string; note?: string; tokens?: number }
type State = Partial<Record<Stage, Stamp>>;
const stateFile = (project: string, id: string) => path.join(paths(project, id).stage, "state.json");
export const readState = (project: string, id: string): State => (fs.existsSync(stateFile(project, id)) ? JSON.parse(fs.readFileSync(stateFile(project, id), "utf8")) : {});
function stamp(project: string, id: string, stage: Stage, s: Omit<Stamp, "at">): void {
  const st = readState(project, id);
  st[stage] = { ...s, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(stateFile(project, id)), { recursive: true });
  fs.writeFileSync(stateFile(project, id), JSON.stringify(st, null, 2) + "\n");
}

/** What each stage read, as one fingerprint: a stage is STALE when its inputs no longer hash the same. */
export function fingerprint(project: string, b: ArmorBrief, stage: Stage): string {
  const st = readState(project, b.id);
  switch (stage) {
    case "brief": return shaText(JSON.stringify(b));
    case "gen": return shaText(JSON.stringify(buildManifest(b, loadTemplates()).images.map((i) => i.prompt)));
    case "import": return sha(...artFiles(b),...(b.bodyManifest?[path.join(PG,'projects',project,b.bodyManifest)]:[]));
    case "bake": return sha(...outFiles(b));
    case "items": return shaText(JSON.stringify(buildItems(b, readPlan(project, b))));
    case "review": return shaText(`${st.bake?.at}|${st.items?.at}`);
  }
}
/** Do the stage's outputs exist? */
function outputsExist(project: string, b: ArmorBrief, stage: Stage): boolean {
  const p = paths(project, b.id);
  switch (stage) {
    case "brief": return fs.existsSync(p.brief);
    case "gen": return artFiles(b).every((f) => fs.existsSync(f));
    case "import": return outFiles(b).every((f) => fs.existsSync(f));
    case "bake": return setSheets(b).every((x) => fs.existsSync(p.texture(x)));
    case "items": {
      const items = buildItems(b, readPlan(project, b));
      return items.length > 0 && items.every((i) => fs.existsSync(p.item(i.id)));
    }
    case "review": return fs.existsSync(p.review);
  }
}
export type Status = "ok" | "STALE" | "MISSING" | "FAILED";
export function stageStatus(project: string, b: ArmorBrief, stage: Stage): { status: Status; note: string } {
  const s = readState(project, b.id)[stage];
  if (s && !s.ok) return { status: "FAILED", note: s.note ?? "" };
  // a set whose art predates the tool: its gen stage is the art on disk
  if (stage === "gen" && b.existingArt && outputsExist(project, b, stage)) return { status: "ok", note: "existing art" };
  if (!s || !outputsExist(project, b, stage)) return { status: "MISSING", note: "" };
  if (s.fp !== fingerprint(project, b, stage)) return { status: "STALE", note: `inputs changed since ${s.at.slice(0, 16)}` };
  return { status: "ok", note: s.at.slice(0, 16) };
}

// ---------------------------------------------------------------- processes
function node(args: string[], ctx: Ctx, cwd = PG): { status: number; out: string } {
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function ledger(project: string, line: string): void {
  const f = paths(project).ledger;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, "# Armor sets: Codex ledger\n\nOne line per `armor gen` session: set, images, seconds, Codex tokens.\n\n");
  fs.appendFileSync(f, line + "\n");
}

// ---------------------------------------------------------------- stages
export function stageBrief(ctx: Ctx, b: ArmorBrief): StageResult {
  const { problems, warnings } = briefLint(b, loadFacts(ctx.project), manifestKeys());
  if (b.kind === "instance") {
    const plan = readPlan(ctx.project, b);
    if (!plan) problems.push(`no loot plan ${b.loot ?? "(loot not set)"}: armor loot-plan ${b.source.id || b.id} --project ${ctx.project}`);
    else {
      const l = lootPlanLint(plan, sheetWeights(b));
      problems.push(...l.problems.map((x) => `loot: ${x}`));
      warnings.push(...l.warnings.map((x) => `loot: ${x}`));
    }
  }
  // across every set of the project: no two ship the identical helm or shoulder pick
  const cross = crossSetLint(listBriefs(ctx.project).map((id) => (id === b.id ? b : readBrief(ctx.project, id))).map((x) => ({ b: x, plan: readPlan(ctx.project, x) })));
  problems.push(...cross.problems.filter((x) => x.includes(`${b.id}:`)));
  warnings.push(...cross.warnings.filter((x) => new RegExp(`(: |, )${b.id}(,|$)`).test(x)));
  const lines = [...problems.map((p) => `  ! ${p}`), ...warnings.map((w) => `  ~ ${w}`)];
  const pieces = piecesOf(b, readPlan(ctx.project, b));
  const count = (slot: string) => new Set(pieces.filter((x) => x.slot === slot).map((x) => x.parts.join("+"))).size;
  if (!problems.length) lines.unshift(`  brief ${b.id}: ok (${b.kind}; ${b.kind === "kit" ? `${b.tiers.map((t) => t.rarity + (t.ornate ? "+ornate" : "")).join(", ")}; ${b.weight}` : `${pieces.length} pieces, ${bodyThemes(b).length} body sheet(s)`}; ${count("helm")} helms, ${count("shoulders")} shoulders; levels ${b.levelBand.join("-")})`);
  if (!ctx.dryRun) stamp(ctx.project, b.id, "brief", { ok: !problems.length, fp: fingerprint(ctx.project, b, "brief"), note: problems[0] });
  return { ok: !problems.length, lines };
}

/** The set's ONE manifest, written to the stage dir; the sessions to run (done images skipped). */
export function planGen(ctx: Ctx, b: ArmorBrief): { manifest: { images: GenImage[] }; waves: GenImage[][]; file: string } {
  const manifest = buildManifest(b, loadTemplates());
  const done = (i: GenImage) => fs.existsSync(path.resolve(PG, i.target));
  const waves = genWaves(manifest.images, done, ctx.force, ctx.redo ?? []).map(sessionImages);
  return { manifest, waves, file: path.join(paths(ctx.project, b.id).stage, "gen-set.json") };
}

export function stageGen(ctx: Ctx, b: ArmorBrief): StageResult {
  const { manifest, waves, file } = planGen(ctx, b);
  const lines: string[] = [];
  if (ctx.dryRun) {
    lines.push(JSON.stringify({ manifest: path.relative(PG, file), sessions: waves.map((w) => w.map((i) => i.id)), images: manifest.images, sessionPrompts: waves.map((w) => w.map((i) => ({ id: i.id, prompt: i.prompt }))) }, null, 2));
    return { ok: true, lines };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  if (!waves.length) {
    lines.push(`  gen ${b.id}: every sheet exists (${manifest.images.map((i) => i.role).join(", ")}) — nothing to generate`);
    stamp(ctx.project, b.id, "gen", { ok: true, fp: fingerprint(ctx.project, b, "gen"), note: "nothing to generate" });
    return { ok: true, lines };
  }
  let total = 0;
  for (const [n, wave] of waves.entries()) {
    const wf = path.join(path.dirname(file), `session-${n + 1}.json`);
    fs.writeFileSync(wf, JSON.stringify({ images: wave.map(({ role: _role, ...i }) => i) }, null, 2) + "\n");
    ctx.log(`  gen ${b.id}: session ${n + 1}/${waves.length} — ${wave.map((i) => i.role).join(", ")} (Codex)`);
    const r = node([path.join(PG, "tools/image-request.mjs"), "gen-set", "--manifest", wf, "--timeout", "2400", ...(ctx.force || ctx.redo?.length ? ["--force"] : [])], ctx);
    const json = (() => { try { return JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)); } catch { return null; } })();
    const tokens = typeof json?.tokens === "number" ? json.tokens : null;
    if (tokens) total += tokens;
    ledger(ctx.project, `- ${new Date().toISOString().slice(0, 16)} ${b.id} session ${n + 1}: ${wave.map((i) => i.role).join(", ")}; ${r.status === 0 ? "ok" : `FAILED (exit ${r.status})`}; ${json?.seconds ?? "?"}s; ${tokens ?? "?"} Codex tokens`);
    if (r.status !== 0) {
      const why = json?.results?.filter((x: { status: string }) => x.status !== "done").map((x: { id: string; reason?: string }) => `${x.id}: ${x.reason}`).join("; ") || r.out.trim().split("\n").slice(-3).join(" / ");
      lines.push(`  ! gen ${b.id}: session ${n + 1} failed — ${why}`);
      stamp(ctx.project, b.id, "gen", { ok: false, fp: fingerprint(ctx.project, b, "gen"), note: why.slice(0, 300), tokens: total });
      return { ok: false, lines, tokens: total };
    }
    for (const x of json?.results ?? []) lines.push(`  ${x.id}: ${x.status} ${x.size ?? ""}${x.fixed ? ` (${x.fixed})` : ""}`);
  }
  lines.push(`  gen ${b.id}: ${waves.flat().length} image(s) in ${waves.length} session(s), ${total || "?"} Codex tokens`);
  stamp(ctx.project, b.id, "gen", { ok: true, fp: fingerprint(ctx.project, b, "gen"), tokens: total });
  return { ok: true, lines, tokens: total };
}

/** Clear opaque texels on a cut-out slot's free edges when they are few (a stray touch), in place. */
function clearFreeEdges(atlas: Img, key: Img, hex: string, spec: SlotSpec, baseBand = 0.2): number {
  const S = atlas.width;
  const m = keyMask(key, [hex], S);
  let y0 = S, y1 = -1;
  for (let i = 0; i < S * S; i++) if (m[i]) { const y = Math.floor(i / S); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const cutoff = spec.anchor === "bottom" ? y1 - Math.max(1, Math.floor((y1 - y0 + 1) * baseBand)) : S;
  let n = 0;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (!m[y * S + x] || y > cutoff) continue;
      const border = x === 0 || y === 0 || x === S - 1 || y === S - 1 || !m[y * S + x - 1] || !m[y * S + x + 1] || !m[(y - 1) * S + x] || !m[(y + 1) * S + x];
      if (border && atlas.data[(y * S + x) * 4 + 3]! >= 128) { atlas.data[(y * S + x) * 4 + 3] = 0; n++; }
    }
  return n;
}

/** Most opaque free-edge texels a cut-out may carry and still be repaired (more = a filled plaque: regenerate). */
export const EDGE_REPAIR_SHARE = 0.06;
const DENSITY = { target: 109, tolerance: 0.1 };
/** Parts painted by the ordinary human-helm key. Independent native UV layouts
 * (face plates, cloth caps) must never contribute area at this sheet's size.
 * Native replacements of these named parts retain their ordinary key layout. */
const HELM_KEY_PARTS=[...HELM_BASES.filter(name=>name!=='PeasantCap'),...HELM_ORNATE,'Helm1_Flair','Helm1_NoBeard','Helm2_NoBeard','NoseGuard1','NoseGuard2','Helm1RearCap','HoodCrown'];
export function helmDensityChecks(helm:Glb,keySize:number,nativeSheets:readonly {texture:string;parts:readonly string[];size:number}[]):Array<readonly[string,number]>{
  const indices=(names:readonly string[])=>new Set(names.flatMap(name=>helm.parts[name]===undefined?[]:[helm.parts[name]!]));
  const checks:Array<readonly[string,number]>=[['helm (key layout)',density(helm,keySize,.019,indices(HELM_KEY_PARTS))]];
  for(const sheet of nativeSheets)checks.push([`helm native ${sheet.texture}`,density(helm,sheet.size,.019,indices(sheet.parts))]);
  return checks;
}

export function stageImport(ctx: Ctx, b: ArmorBrief): StageResult {
  const lines: string[] = [];
  let ok = true;
  const miss = artFiles(b).filter((f) => !fs.existsSync(f));
  if (miss.length) return { ok: false, lines: [`  ! import ${b.id}: no art ${miss.map((f) => path.relative(ENGINE, f)).join(", ")} — run gen`] };
  const imp = path.join(ATLAS, "import-atlas.mjs");
  const stageDir = paths(ctx.project, b.id).stage;
  const bodyManifest=b.bodyManifest?path.join(PG,'projects',ctx.project,b.bodyManifest):path.join(ATLAS,'sets/human-body/manifest.json');
  if(!fs.existsSync(bodyManifest))return{ok:false,lines:[`  ! import ${b.id}: body manifest missing ${bodyManifest}`]};
  const themes = bodyThemes(b);
  const runs: [string, string[]][] = [
    ...themes.flatMap((t): [string, string[]][] => [
      [`body ${t}`, [imp, "--set", "human-body", "--theme", t,"--manifest",bodyManifest]],
      [`female ${t} (whole sheet, kept in the stage)`, [imp, "--key", keyPng("human-body"), "--manifest", bodyManifest, "--art", path.join(ATLAS, "art/human-body", `${t}-f.png`), "--out", path.join(stageDir, `female-full-${t}`)]],
    ]),
    ["helm", [imp, "--set", "human-helm", "--theme", b.id]],
    ["shoulder", [imp, "--set", "human-shoulder", "--theme", b.id]],
  ];
  for (const [what, args] of runs) {
    const r = node([...args, "--filter", "nearest"], ctx, ENGINE);
    const warn = r.out.split("\n").filter((l) => /^\s+! /.test(l));
    lines.push(`  import ${what}: ${r.status === 0 ? "ok" : `FAILED (exit ${r.status})`}${warn.length ? `, ${warn.length} importer warning(s)` : ""}`);
    for (const w of warn.slice(0, 6)) lines.push(`    ${w.trim()}`);
    if (r.status !== 0) {
      lines.push(...r.out.trim().split("\n").slice(-4).map((l) => `    ${l}`));
      stamp(ctx.project, b.id, "import", { ok: false, fp: fingerprint(ctx.project, b, "import"), note: `import-atlas ${what} exited ${r.status}` });
      return { ok: false, lines };
    }
  }
  // the woman's sheets: his atlas with her chest front
  const bodyKey = png(keyPng("human-body"));
  for (const t of themes) {
    const fem = femaleChest(png(atlasOut("human-body", t)), png(path.join(stageDir, `female-full-${t}`, "atlas.png")), bodyKey);
    writePng(atlasOut("human-body", `${t}-f`), fem.img);
    lines.push(`  female chest ${t}: ${fem.texels} texels of her chest front (+3 gutter) onto his atlas -> out/human-body/${t}-f`);
  }
  // match-material: helm and shoulder slots made of a body material take the (first) body sheet's measured tone
  const mt = matchesOf(b);
  for (const [set, pairs] of [["human-helm", mt.helm], ["human-shoulder", mt.shoulder]] as const)
    for (const pair of pairs) {
      const r = node([path.join(ATLAS, "match-material.mjs"), "--from", atlasOut("human-body", themes[0]!), "--from-key", keyPng("human-body"), "--from-regions", pair.from.join(","), "--to", atlasOut(set, b.id), "--to-key", keyPng(set), "--to-regions", pair.to.join(",")], ctx, ENGINE);
      const nums = r.out.split("\n").filter((l) => /source|before|after/.test(l)).map((l) => l.trim());
      lines.push(`  match ${set} ${pair.to.join("+")} <- body ${pair.from.join("+")}: ${r.status === 0 ? "" : `FAILED ${r.out.trim().split("\n").pop()}`}`);
      for (const n of nums) lines.push(`    ${n}`);
      if (r.status !== 0) ok = false;
    }
  // measure: holes on the body's real UVs
  const models = paths(ctx.project);
  const body = readGlb(models.model(MODEL.body));
  for (const t of themes)
    for (const [label, file] of [["male", atlasOut("human-body", t)], ["female", atlasOut("human-body", `${t}-f`)]] as const) {
      const isFemale = (part: string) => part.startsWith("HumanFemale_") || part.startsWith("F_");
      const holes = bodyHoles(png(file), body).filter((h) => isFemale(h.part) === (label === "female"));
      const bad = holes.filter((h) => h.holes > 0);
      lines.push(`  holes (${t} ${label}, alpha < 128 inside non-cut parts' UV triangles): ${bad.length ? bad.map((h) => `${h.part} ${h.holes}/${h.texels}`).join(", ") : `0 in ${holes.reduce((s, h) => s + h.texels, 0)} texels`}`);
      if (bad.length) ok = false;
    }
  // measure + repair: free edges of every cut-out square
  const cutSets: [string, string, (s: SlotSpec) => boolean][] = [
    ...themes.map((t): [string, string, (s: SlotSpec) => boolean] => ["human-body", t, (s) => s.name === "ornament"]),
    ["human-helm", b.id, () => true],
    ["human-shoulder", b.id, () => true],
  ];
  for (const [set, theme, keep] of cutSets) {
    const file = atlasOut(set as "human-body", theme);
    const atlas = png(file);
    const key = png(keyPng(set));
    const slots = Object.fromEntries(Object.entries(manifestOf(set).slots).filter(([, s]) => s.cut === true && keep(s)));
    let repaired = 0;
    const redoRole = set === "human-body" ? (b.kind === "instance" ? `body:${theme}` : "body") : set.replace("human-", "");
    for (const e of freeEdges(atlas, key, slots)) {
      let opaque = e.opaque;
      if (opaque && opaque <= Math.ceil(e.edge * EDGE_REPAIR_SHARE)) {
        const [hex, spec] = Object.entries(slots).find(([, s]) => s.name === e.slot)!;
        repaired += clearFreeEdges(atlas, key, hex, spec);
        lines.push(`  free edge ${set} ${theme} ${e.slot}: ${opaque}/${e.edge} opaque — cleared (a stray touch)`);
        opaque = 0;
      } else lines.push(`  free edge ${set} ${theme} ${e.slot}: ${opaque}/${e.edge} opaque${opaque ? `  <-- paint runs off the cut-out: regenerate this sheet (armor gen ${b.id} --redo ${redoRole} --project ${ctx.project}, then armor run ${b.id})` : ""}`);
      if (opaque) ok = false;
    }
    if (repaired) {
      fs.writeFileSync(file, encodePng(atlas.width, atlas.height, atlas.data));
      if (set === "human-body") {
        // the woman's copy shares the ornament
        const f = png(atlasOut("human-body", `${theme}-f`));
        clearFreeEdges(f, key, Object.entries(slots)[0]![0], Object.entries(slots)[0]![1]);
        writePng(atlasOut("human-body", `${theme}-f`), f);
      }
    }
  }
  // density on the models
  const male = png(atlasOut("human-body", themes[0]!));
  const helm = readGlb(models.model(MODEL.helm)), sh = readGlb(models.model(MODEL.shoulder));
  const nativeSheets=new Map<string,{texture:string;parts:string[];size:number}>();
  for(const piece of piecesOf(b,readPlan(ctx.project,b))){
    if(piece.slot!=='helm'||piece.texture===sheetIds(b.id).helm)continue;
    const file=models.texture(piece.texture);
    if(!fs.existsSync(file))throw new Error(`Native helm texture missing: ${piece.texture}`);
    const sheet=nativeSheets.get(piece.texture)??{texture:piece.texture,parts:[],size:png(file).width};
    sheet.parts=[...new Set([...sheet.parts,...piece.parts])];nativeSheets.set(piece.texture,sheet);
  }
  for (const [what, d] of [["body", density(body, male.width, worldScale(body.meshWorld))], ...helmDensityChecks(helm,png(atlasOut("human-helm", b.id)).width,[...nativeSheets.values()]), ["shoulder", density(sh, png(atlasOut("human-shoulder", b.id)).width, 0.019)]] as const) {
    const off = Math.abs(d / DENSITY.target - 1) > DENSITY.tolerance;
    lines.push(`  density ${what}: ${d.toFixed(0)} texels/m (house ${DENSITY.target} ±${DENSITY.tolerance * 100}%)${off ? "  <-- off" : ""}`);
    if (off) ok = false;
  }
  stamp(ctx.project, b.id, "import", { ok, fp: fingerprint(ctx.project, b, "import"), note: ok ? undefined : "a measured gate failed (see the import output)" });
  return { ok, lines };
}

/** A native accessory's independent tile is not a theme painted against the base recipe key. */
export const themesForTileIds = (tiles: readonly string[], prefix: string): string[] =>
  tiles.filter(t=>t.startsWith(prefix)&&t.endsWith('.png')).map(t=>t.slice(prefix.length,-4));
const themesOnPage = (project: string, model: string, prefix: string): string[] =>
  themesForTileIds(Object.keys(readGlb(paths(project).model(model)).tiles),prefix);

/** Re-bake the helm and shoulder pages with `themes` (every theme on the page, plus or minus some). */
function bakeWeaponPages(ctx: Ctx, lines: string[], add: string[], drop: string[] = []): string | null {
  for (const [recipe, model] of [["human-helm", MODEL.helm], ["human-shoulder", MODEL.shoulder]] as const) {
    const themes = [...new Set([...themesOnPage(ctx.project, model, `mmo/${recipe}-`), ...add])].filter((t) => !drop.includes(t));
    const missing = themes.filter((th) => !fs.existsSync(atlasOut(recipe, th)));
    if (missing.length) return `${recipe}: no out/ atlas for page theme(s) ${missing.join(", ")} (import-atlas them first)`;
    ctx.log(`  weapon-page ${recipe}: ${themes.length} themes`);
    const r = node([path.join(PG, "tools/weapon-page.mjs"), "--recipe", recipe, "--project", ctx.project, "--model", model, "--themes", ...themes], ctx);
    lines.push(...r.out.trim().split("\n").filter((l) => /weapon-page|wrote|!|Error/.test(l)).slice(0, 6).map((l) => `  ${l.trim()}`));
    if (r.status !== 0) return `weapon-page ${recipe} exited ${r.status}: ${r.out.trim().split("\n").slice(-2).join(" / ")}`;
  }
  return null;
}

export function stageBake(ctx: Ctx, b: ArmorBrief): StageResult {
  const lines: string[] = [];
  const p = paths(ctx.project, b.id);
  const fail = (why: string): StageResult => {
    lines.push(`  ! bake ${b.id}: ${why}`);
    stamp(ctx.project, b.id, "bake", { ok: false, fp: fingerprint(ctx.project, b, "bake"), note: why });
    return { ok: false, lines };
  };
  // body: add or replace every body sheet (and its woman's copy) without re-running the weight transfer
  const pairs = bodyThemes(b).flatMap((t) => [[bodySheetId(t), atlasOut("human-body", t)], [bodySheetId(t, true), atlasOut("human-body", `${t}-f`)]] as const);
  const bp = node([path.join(PG, "tools/body-page.mjs"), "--glb", p.model(MODEL.body), ...pairs.flatMap(([id, src]) => ["--theme", `${id}=${src}`])], ctx);
  lines.push(...bp.out.trim().split("\n").map((l) => `  ${l.trim()}`));
  if (bp.status !== 0) return fail("body-page failed");
  for (const [id, src] of pairs) {
    fs.mkdirSync(path.dirname(p.texture(id)), { recursive: true });
    fs.copyFileSync(src, p.texture(id));
  }
  // helm and shoulders: every theme already on the page plus this one, re-baked (pages only hold what they were baked with)
  const bad = bakeWeaponPages(ctx, lines, [b.id]);
  if (bad) return fail(bad);
  const ic = node([path.join(PG, "tools/item-icon.mjs"), "--project", ctx.project, "--model", MODEL.body], ctx);
  lines.push(`  item-icon ${MODEL.body}: ${ic.status === 0 ? `${ic.out.split("\n").filter((l) => /->/.test(l)).length} icon(s)` : `FAILED ${ic.out.trim().split("\n").pop()}`}`);
  if (ic.status !== 0) return fail("item-icon failed");
  // the page must now carry the set
  const facts = loadFacts(ctx.project);
  const all = [...facts.body.tiles, ...facts.helm.tiles, ...facts.shoulder.tiles];
  const absent = setSheets(b).filter((id) => !all.includes(id));
  if (absent.length) return fail(`not on the page after the bake: ${absent.join(", ")}`);
  lines.push(`  bake ${b.id}: on every page (body ${facts.body.tiles.length}, helm ${facts.helm.tiles.length}, shoulder ${facts.shoulder.tiles.length} tiles)`);
  stamp(ctx.project, b.id, "bake", { ok: true, fp: fingerprint(ctx.project, b, "bake") });
  return { ok: true, lines };
}

/**
 * `armor retire <id> …`: take whole sets out — their tiles off all three pages (pages re-baked square with every
 * remaining theme), their items, icons, sheets, icon framing, brief, review, stage state, art and imported atlases.
 * Returns the removed item ids. Overwrites in place; git (and the projects' own repos) are the history.
 */
export function retireSets(ctx: Ctx, ids: string[]): { lines: string[]; removedItems: string[]; ok: boolean } {
  const lines: string[] = [];
  const P = paths(ctx.project);
  // read raw: a retired brief may predate the current schema; only id, kind and body keys are needed
  const briefs = ids.map((id) => { const raw = JSON.parse(fs.readFileSync(paths(ctx.project, id).brief, "utf8")); return { ...raw, kind: raw.kind ?? "kit" } as ArmorBrief; });
  const sheets = briefs.flatMap(setSheets);
  // items: by tag (every set item is tagged with its set id), so pieces renamed since are caught too
  const removedItems: string[] = [];
  const itemDir = path.join(P.assets, "items");
  for (const f of fs.readdirSync(itemDir).filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(fs.readFileSync(path.join(itemDir, f), "utf8"));
    if (!ids.some((id) => f.startsWith(`${id}-`) && (doc.tags ?? []).includes(id) && (doc.tags ?? []).includes("armor"))) continue;
    const id = f.slice(0, -5);
    removedItems.push(id);
    if (!ctx.dryRun) {
      fs.rmSync(path.join(itemDir, f));
      fs.rmSync(P.texture(`icons/${id}.png`), { force: true });
    }
  }
  lines.push(`  items: ${removedItems.length} removed`);
  if (ctx.dryRun) return { lines: [...lines, `  (dry run) would drop ${sheets.join(", ")}`], removedItems, ok: true };
  const presetsFile = path.join(PG, "projects", ctx.project, "authoring", "item-icons.json");
  if (fs.existsSync(presetsFile)) {
    const presets = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    let n = 0;
    for (const id of removedItems) if (presets.items?.[id]) { delete presets.items[id]; n++; }
    if (n) fs.writeFileSync(presetsFile, JSON.stringify(presets, null, 2) + "\n");
    lines.push(`  icon framing: ${n} entries removed`);
  }
  // pages: body sheets dropped, helm/shoulder pages re-baked without the sets
  const bodyDrop = sheets.filter((s) => s.startsWith("mmo/human-body-"));
  const bp = node([path.join(PG, "tools/body-page.mjs"), "--glb", P.model(MODEL.body), ...bodyDrop.flatMap((s) => ["--drop", s])], ctx);
  lines.push(...bp.out.trim().split("\n").map((l) => `  ${l.trim()}`));
  if (bp.status !== 0) return { lines, removedItems, ok: false };
  const bad = bakeWeaponPages(ctx, lines, [], ids);
  if (bad) return { lines: [...lines, `  ! ${bad}`], removedItems, ok: false };
  for (const s of sheets) fs.rmSync(P.texture(s), { force: true });
  for (const b of briefs) {
    for (const f of [...artFiles(b), ...outFiles(b).map((x) => path.dirname(x))]) fs.rmSync(f, { recursive: true, force: true });
    fs.rmSync(paths(ctx.project, b.id).review, { force: true });
    fs.rmSync(paths(ctx.project, b.id).stage, { recursive: true, force: true });
    fs.rmSync(paths(ctx.project, b.id).brief, { force: true });
  }
  const ic = node([path.join(PG, "tools/item-icon.mjs"), "--project", ctx.project, "--model", MODEL.body], ctx);
  lines.push(`  item-icon ${MODEL.body}: ${ic.status === 0 ? "re-rendered" : `FAILED ${ic.out.trim().split("\n").pop()}`}`);
  lines.push(`  retired ${ids.join(", ")}: ${sheets.length} sheets off the pages, briefs, reviews, art and atlases removed`);
  return { lines, removedItems, ok: ic.status === 0 };
}

/**
 * The project's own stat-requirement rule (`projects/<p>/tools/item-requires.mjs`, package D3a: which attribute an
 * item asks for and how much, by kind, rarity and level), or null for a project without one. buildItems only knows the
 * level band; without this its items shipped with the brief's own strength guess and none for leather or cloth, and the
 * foundation's `item-requires` check (server d3a/d3b tests) failed on every armour set (t-triage 2026-11-03).
 */
type RequireRule = (id: string, doc: Record<string, unknown>) => Record<string, number> | null;
function requireRule(project: string): RequireRule | null {
  const f = path.join(PG, "projects", project, "tools", "item-requires.mjs");
  if (!fs.existsSync(f)) return null;
  const mod = createRequire(import.meta.url)(f) as { requirementFor: (item: unknown, abilities: unknown) => Record<string, number> | null; readAbilityFacts: () => unknown };
  const abilities = mod.readAbilityFacts();
  return (id, doc) => mod.requirementFor({ ...doc, __id: id }, abilities);
}

/** The house framing of body-model hands and feet (the vanguard/ranger/magus entries of item-icons.json). */
const ICON_FRAME = { gloves: { from: [1, 0, 0], up: [0, 0, 1], roll: 0 }, boots: { from: [1, -0.35, 0.15], up: [0, 0, 1], roll: 0 } };

export function stageItems(ctx: Ctx, b: ArmorBrief): StageResult {
  const p = paths(ctx.project, b.id);
  const lines: string[] = [];
  const plan = readPlan(ctx.project, b);
  const items = buildItems(b, plan);
  if (!items.length) return { ok: false, lines: [`  ! items ${b.id}: nothing to write${b.kind === "instance" ? " (no loot plan)" : ""}`] };
  const rule = requireRule(ctx.project);
  for (const it of items) {
    const want = rule?.(it.id, it.doc);
    if (want) it.doc.requires = want;
    const f = p.item(it.id);
    // keep a rendered icon across re-writes; everything else is the brief's
    const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...it.doc, ...(prev?.icon ? { icon: prev.icon } : {}) }, null, 2) + "\n");
  }
  // a piece the brief no longer ships (an id that changed) is taken out, so nothing stale drops
  const want = new Set(items.map((i) => i.id));
  const stale = fs.readdirSync(path.join(p.assets, "items")).filter((f) => f.endsWith(".json") && f.startsWith(`${b.id}-`) && !want.has(f.slice(0, -5))).filter((f) => {
    const doc = JSON.parse(fs.readFileSync(path.join(p.assets, "items", f), "utf8"));
    return (doc.tags ?? []).includes(b.id) && (doc.tags ?? []).includes("armor");
  });
  for (const f of stale) { fs.rmSync(path.join(p.assets, "items", f)); fs.rmSync(p.texture(`icons/${f.slice(0, -5)}.png`), { force: true }); }
  const bySlot = SLOTS.map((s) => `${items.filter((i) => (i.doc.slots as string[])[0] === s).length} ${s}`).join(", ");
  lines.push(`  items ${b.id}: ${items.length} written (${bySlot})${stale.length ? `; ${stale.length} no longer shipped, removed: ${stale.map((f) => f.slice(0, -5)).join(", ")}` : ""}`);
  // icon framing is per model, and per ITEM for the body's hands and feet (authoring/item-icons.json; docs/item-icons.md):
  // without it gloves and boots render from the chest's front view, two specks far apart
  const presetsFile = path.join(PG, "projects", ctx.project, "authoring", "item-icons.json");
  const presets = fs.existsSync(presetsFile) ? JSON.parse(fs.readFileSync(presetsFile, "utf8")) : { models: {}, items: {} };
  presets.items ??= {};
  let framed = 0;
  for (const it of items) {
    const slot = (it.doc.slots as string[])[0];
    const frame = slot === "gloves" ? ICON_FRAME.gloves : slot === "boots" ? ICON_FRAME.boots : null;
    if (frame && !presets.items[it.id]) { presets.items[it.id] = frame; framed++; }
  }
  for (const f of stale) if (presets.items[f.slice(0, -5)]) { delete presets.items[f.slice(0, -5)]; framed++; }
  if (framed) {
    fs.writeFileSync(presetsFile, JSON.stringify(presets, null, 2) + "\n");
    lines.push(`  icon framing: ${framed} glove/boot entries changed in authoring/item-icons.json`);
  }
  const ic = node([path.join(PG, "tools/item-icon.mjs"), "--project", ctx.project, "--item", ...items.map((i) => i.id)], ctx);
  lines.push(`  icons: ${ic.status === 0 ? `${ic.out.split("\n").filter((l) => /->/.test(l)).length} rendered` : `FAILED ${ic.out.trim().split("\n").pop()}`}`);
  const problems = lintItems(ctx.project, b);
  for (const pr of problems) lines.push(`  ! ${pr}`);
  const ok = ic.status === 0 && !problems.length;
  if (ok) lines.push(`  items lint: ok`);
  stamp(ctx.project, b.id, "items", { ok, fp: fingerprint(ctx.project, b, "items"), note: problems[0] });
  return { ok, lines };
}

export function lintItems(project: string, b: ArmorBrief): string[] {
  const p = paths(project, b.id);
  const facts = loadFacts(project);
  const plan = readPlan(project, b);
  const read = (id: string) => (fs.existsSync(p.item(id)) ? JSON.parse(fs.readFileSync(p.item(id), "utf8")) : null);
  const out = itemsLint(b, read, facts, (t) => fs.existsSync(p.texture(t)), plan);
  const rule = requireRule(project);
  for (const it of buildItems(b, plan)) {
    const doc = read(it.id);
    if (doc && (!doc.icon || !fs.existsSync(p.texture(doc.icon)))) out.push(`${it.id}: no rendered icon`);
    const want = doc && rule?.(it.id, doc);
    if (want && JSON.stringify(doc.requires ?? {}) !== JSON.stringify(want)) out.push(`${it.id}: requires ${JSON.stringify(doc.requires ?? {})}, the project's rule (tools/item-requires.mjs) says ${JSON.stringify(want)}`);
  }
  return out;
}

// ---------------------------------------------------------------- review
interface Creation { appearance: { id: string; options: { id: string; remap?: { parts?: Record<string, string>; prefixes?: Record<string, string> } }[] }[]; mounts: Mount[] }
function creation(project: string): Creation {
  const dir = path.join(paths(project).assets, "creation");
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".json"));
  if (!f) throw new Error(`no creation asset in ${dir}`);
  return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
}

/** One review row: a dressed character (body theme + body parts, one helm piece, one shoulder piece). */
interface Look { label: string; bodyTheme: string; body: string[]; helm: string[]; helmTexture?: string; shoulder: string[] }

/**
 * The review rows. Kit: one row per HELM piece and one per SHOULDER piece (each worn with the body at its first
 * tier), so every piece the set ships is seen on both sexes. Instance: one row per body sheet (its pieces), then a
 * row per helm piece and per shoulder piece (on the first body sheet).
 */
export function reviewLooks(b: ArmorBrief, pieces: SetPiece[]): Look[] {
  const looks: Look[] = [];
  const firstOf = (slot: string) => pieces.find((x) => x.slot === slot);
  const uniq = (slot: string) => {
    const seen = new Set<string>();
    return pieces.filter((x) => x.slot === slot && !seen.has(x.parts.join("+")) && seen.add(x.parts.join("+")));
  };
  const bodyAt = (theme: string, ornate: boolean, rarity?: string): string[] => {
    if (b.kind === "kit") return (["chest", "gloves", "legs", "boots"] as const).flatMap((s) => bodyParts(s, b.legs, ornate, b.chestHalo, b.bareArms));
    // an instance sheet: the pieces drawn from it (the richest legs piece), missing slots plain
    return (["chest", "gloves", "legs", "boots"] as const).flatMap((s) => {
      const mine = pieces.filter((x) => x.slot === s && x.bodyTheme === theme && (!rarity || true));
      return mine.length ? mine.sort((x, y) => y.parts.length - x.parts.length)[0]!.parts : bodyParts(s, "plain", false);
    });
  };
  const helm0 = firstOf("helm")?.parts ?? [], sh0 = firstOf("shoulders")?.parts ?? [];
  const firstBody = bodyThemes(b)[0]!;
  if (b.kind === "instance")
    for (const t of bodyThemes(b)) {
      const ws = (b.bodies ?? []).find((s) => `${b.id}-${s.key}` === t)!.weights;
      looks.push({ label: `body sheet ${t}: chest ${ws.chest}, legs ${ws.legs}, gloves ${ws.gloves}, boots ${ws.boots}`, bodyTheme: t, body: bodyAt(t, pieces.some((x) => x.bodyTheme === t && x.ornate)), helm: helm0, helmTexture: firstOf("helm")?.texture, shoulder: sh0 });
    }
  for (const h of uniq("helm")) looks.push({ label: `helm "${h.name}" ${h.weight} ${h.rarity}: ${h.parts.join(" + ")}`, bodyTheme: firstBody, body: bodyAt(firstBody, h.ornate), helm: h.parts, helmTexture: h.texture, shoulder: (pieces.find((x) => x.slot === "shoulders" && x.rarity === h.rarity) ?? firstOf("shoulders"))?.parts ?? [] });
  for (const s of uniq("shoulders")) {
    const h = pieces.find((x) => x.slot === "helm" && x.rarity === s.rarity) ?? firstOf("helm");
    looks.push({ label: `shoulders "${s.name}" ${s.weight} ${s.rarity}: ${s.parts.join(" + ")}`, bodyTheme: firstBody, body: bodyAt(firstBody, s.ornate), helm: h?.parts ?? [], helmTexture: h?.texture, shoulder: s.parts });
  }
  return looks;
}

export function stageReview(ctx: Ctx, b: ArmorBrief): StageResult {
  const p = paths(ctx.project, b.id);
  const t = sheetIds(b.id);
  const cr = creation(ctx.project);
  const remap = cr.appearance.find((a) => a.id === "sex")?.options.find((o) => o.id === "female")?.remap ?? {};
  const body = readGlb(p.model(MODEL.body)), helm = readGlb(p.model(MODEL.helm)), sh = readGlb(p.model(MODEL.shoulder));
  const headFile = p.model("mmo/human-head.glb");
  const head: Glb | null = fs.existsSync(headFile) ? readGlb(headFile) : null;
  const tex = (id: string) => readPng(p.texture(id));
  const helmRules = parseRules(helm.rules);
  const front = frontDir(body);
  const back = front.map((v) => -v);
  // a three-quarter view of the head and shoulders, so helm and pad pieces read at review size
  const quarter = [front[0]! + 0.8, 0, front[2]!].map((v, _i, a) => v / Math.hypot(a[0]!, a[2]!));
  const plan = readPlan(ctx.project, b);
  const pieces = piecesOf(b, plan);
  const rows: { label: string; views: Img[] }[] = [];
  for (const look of reviewLooks(b, pieces)) {
    const views: Img[] = [];
    const closeups: Img[] = [];
    for (const sex of ["male", "female"] as Sex[]) {
      const hidden = partsHiddenBy(helmRules, look.helm);
      const bodyPiece: Piece = { glb: body, parts: sex === "male" ? look.body : femaleParts(look.body, remap), tex: tex(bodySheetId(look.bodyTheme, sex === "female")), at: body.meshWorld };
      const top: Piece[] = [];
      const headAt = mountMatrices(body, cr.mounts, "mmo/human-head.glb", sex)[0];
      if (head && headAt) {
        const hp = (sex === "male" ? ["HeadFace", "HeadSides/Back", "HeadBottom", "HeadCrown"] : ["F_HeadFace", "F_HeadSides/Back", "F_HeadBottom", "F_HeadCrown"]).filter((x) => !hidden.has(x));
        top.push({ glb: head, parts: hp, tex: tex(sex === "male" ? "mmo/human-head-m-young.png" : "mmo/human-head-female-f-young.png"), at: headAt });
      }
      for (const at of mountMatrices(body, cr.mounts, MODEL.helm, sex)) top.push({ glb: helm, parts: look.helm, tex: tex(look.helmTexture ?? t.helm), at });
      for (const at of mountMatrices(body, cr.mounts, MODEL.shoulder, sex)) top.push({ glb: sh, parts: look.shoulder, tex: tex(t.shoulder), at });
      views.push(renderView([bodyPiece, ...top], front, 260), renderView([bodyPiece, ...top], back, 260));
      // close-up: the chest only (no arms, so the frame stays on the head and pads)
      const chestOnly = { ...bodyPiece, parts: bodyPiece.parts.filter((x) => /ChestFront|ChestBack/.test(x)) };
      closeups.push(renderView([chestOnly, ...top], quarter, 200));
    }
    rows.push({ label: `${look.label}  (male front, back / female front, back / male, female 3/4)`, views: [...views, ...closeups] });
  }
  const icons = buildItems(b, plan).map((i) => readPng(p.texture(`icons/${i.id}.png`))).filter((x): x is Img => !!x);
  const sheet = composeSheet({ title: `${b.name} (${b.id}, ${b.kind})`, rows, icons });
  writePng(p.review, sheet);
  const lines = [`  review ${b.id}: ${path.relative(PG, p.review)} (${sheet.width}x${sheet.height}, ${rows.length} row(s), ${icons.length} icons) — look at it`];
  stamp(ctx.project, b.id, "review", { ok: true, fp: fingerprint(ctx.project, b, "review") });
  return { ok: true, lines };
}

export const RUNNERS: Record<Stage, (ctx: Ctx, b: ArmorBrief) => StageResult> = {
  brief: stageBrief, gen: stageGen, import: stageImport, bake: stageBake, items: stageItems, review: stageReview,
};

/** `brief new`: the template, refused when the file exists (unless --force). */
export function newBrief(project: string, id: string, force: boolean): string {
  const f = paths(project, id).brief;
  if (fs.existsSync(f) && !force) throw new Error(`${path.relative(PG, f)} exists (pass --force to overwrite)`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(briefTemplate(id), null, 2) + "\n");
  return f;
}
