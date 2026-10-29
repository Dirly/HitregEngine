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
import { partsHiddenBy } from "@hitreg/core";
import { decodePng, encodePng } from "../_png.mjs";
import { armorBriefSchema, briefTemplate, matchesOf, SLOTS, type ArmorBrief } from "./schema.mts";
import { buildItems, buildManifest, briefLint, itemsLint, genWaves, sessionImages, afterRule, parseRules, sheetIds, MODEL, slotParts, type ModelFacts, type GenImage, type Templates } from "./set.mts";
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
const artOf = (id: string) => ({
  body: path.join(ATLAS, "art/human-body", `${id}.png`),
  female: path.join(ATLAS, "art/human-body", `${id}-f.png`),
  helm: path.join(ATLAS, "art/human-helm", `${id}.png`),
  shoulder: path.join(ATLAS, "art/human-shoulder", `${id}.png`),
});
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
    return { parts: Object.keys(g.parts), rules: parseRules(g.rules), tiles: Object.keys(g.tiles) };
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
  const a = artOf(b.id);
  const st = readState(project, b.id);
  switch (stage) {
    case "brief": return shaText(JSON.stringify(b));
    case "gen": return shaText(JSON.stringify(buildManifest(b, loadTemplates()).images.map((i) => i.prompt)));
    case "import": return sha(a.body, a.female, a.helm, a.shoulder);
    case "bake": return sha(atlasOut("human-body", b.id), atlasOut("human-body", `${b.id}-f`), atlasOut("human-helm", b.id), atlasOut("human-shoulder", b.id));
    case "items": return shaText(JSON.stringify(buildItems(b)));
    case "review": return shaText(`${st.bake?.at}|${st.items?.at}`);
  }
}
/** Do the stage's outputs exist? */
function outputsExist(project: string, b: ArmorBrief, stage: Stage): boolean {
  const p = paths(project, b.id);
  const a = artOf(b.id);
  switch (stage) {
    case "brief": return fs.existsSync(p.brief);
    case "gen": return [a.body, a.female, a.helm, a.shoulder].every((f) => fs.existsSync(f));
    case "import": return [atlasOut("human-body", b.id), atlasOut("human-body", `${b.id}-f`), atlasOut("human-helm", b.id), atlasOut("human-shoulder", b.id)].every((f) => fs.existsSync(f));
    case "bake": {
      const t = sheetIds(b.id);
      return [t.body, t.bodyF, t.helm, t.shoulder].every((x) => fs.existsSync(p.texture(x)));
    }
    case "items": return buildItems(b).every((i) => fs.existsSync(p.item(i.id)));
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
  const lines = [...problems.map((p) => `  ! ${p}`), ...warnings.map((w) => `  ~ ${w}`)];
  if (!problems.length) lines.unshift(`  brief ${b.id}: ok (${b.tiers.map((t) => t.rarity + (t.ornate ? "+ornate" : "")).join(", ")}; ${b.weight}; levels ${b.levelBand.join("-")})`);
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

export function stageImport(ctx: Ctx, b: ArmorBrief): StageResult {
  const lines: string[] = [];
  let ok = true;
  const a = artOf(b.id);
  const miss = Object.values(a).filter((f) => !fs.existsSync(f));
  if (miss.length) return { ok: false, lines: [`  ! import ${b.id}: no art ${miss.map((f) => path.relative(ENGINE, f)).join(", ")} — run gen`] };
  const imp = path.join(ATLAS, "import-atlas.mjs");
  const stageDir = paths(ctx.project, b.id).stage;
  const runs: [string, string[]][] = [
    ["body", [imp, "--set", "human-body", "--theme", b.id]],
    ["female (whole sheet, kept in the stage)", [imp, "--key", keyPng("human-body"), "--manifest", path.join(ATLAS, "sets/human-body/manifest.json"), "--art", a.female, "--out", path.join(stageDir, "female-full")]],
    ["helm", [imp, "--set", "human-helm", "--theme", b.id]],
    ["shoulder", [imp, "--set", "human-shoulder", "--theme", b.id]],
  ];
  for (const [what, args] of runs) {
    const r = node(args, ctx, ENGINE);
    const warn = r.out.split("\n").filter((l) => /^\s+! /.test(l));
    lines.push(`  import ${what}: ${r.status === 0 ? "ok" : `FAILED (exit ${r.status})`}${warn.length ? `, ${warn.length} importer warning(s)` : ""}`);
    for (const w of warn.slice(0, 6)) lines.push(`    ${w.trim()}`);
    if (r.status !== 0) {
      lines.push(...r.out.trim().split("\n").slice(-4).map((l) => `    ${l}`));
      stamp(ctx.project, b.id, "import", { ok: false, fp: fingerprint(ctx.project, b, "import"), note: `import-atlas ${what} exited ${r.status}` });
      return { ok: false, lines };
    }
  }
  // the woman's sheet: his atlas with her chest front
  const bodyKey = png(keyPng("human-body"));
  const male = png(atlasOut("human-body", b.id));
  const fem = femaleChest(male, png(path.join(stageDir, "female-full", "atlas.png")), bodyKey);
  writePng(atlasOut("human-body", `${b.id}-f`), fem.img);
  lines.push(`  female chest: ${fem.texels} texels of her chest front (+3 gutter) onto his atlas -> out/human-body/${b.id}-f`);
  // match-material: helm and shoulder slots made of a body material take the body's measured tone
  const mt = matchesOf(b);
  for (const [set, pairs] of [["human-helm", mt.helm], ["human-shoulder", mt.shoulder]] as const)
    for (const pair of pairs) {
      const r = node([path.join(ATLAS, "match-material.mjs"), "--from", atlasOut("human-body", b.id), "--from-key", keyPng("human-body"), "--from-regions", pair.from.join(","), "--to", atlasOut(set, b.id), "--to-key", keyPng(set), "--to-regions", pair.to.join(",")], ctx, ENGINE);
      const nums = r.out.split("\n").filter((l) => /source|before|after/.test(l)).map((l) => l.trim());
      lines.push(`  match ${set} ${pair.to.join("+")} <- body ${pair.from.join("+")}: ${r.status === 0 ? "" : `FAILED ${r.out.trim().split("\n").pop()}`}`);
      for (const n of nums) lines.push(`    ${n}`);
      if (r.status !== 0) ok = false;
    }
  // measure: holes on the body's real UVs
  const models = paths(ctx.project);
  const body = readGlb(models.model(MODEL.body));
  for (const [label, file] of [["male", atlasOut("human-body", b.id)], ["female", atlasOut("human-body", `${b.id}-f`)]] as const) {
    const isFemale = (part: string) => part.startsWith("HumanFemale_") || part.startsWith("F_");
    const holes = bodyHoles(png(file), body).filter((h) => isFemale(h.part) === (label === "female"));
    const bad = holes.filter((h) => h.holes > 0);
    lines.push(`  holes (${label}, alpha < 128 inside non-cut parts' UV triangles): ${bad.length ? bad.map((h) => `${h.part} ${h.holes}/${h.texels}`).join(", ") : `0 in ${holes.reduce((s, h) => s + h.texels, 0)} texels`}`);
    if (bad.length) ok = false;
  }
  // measure + repair: free edges of every cut-out square
  const cutSets: [string, string, (s: SlotSpec) => boolean][] = [
    ["human-body", b.id, (s) => s.name === "ornament"],
    ["human-helm", b.id, () => true],
    ["human-shoulder", b.id, () => true],
  ];
  for (const [set, theme, keep] of cutSets) {
    const file = atlasOut(set as "human-body", theme);
    const atlas = png(file);
    const key = png(keyPng(set));
    const slots = Object.fromEntries(Object.entries(manifestOf(set).slots).filter(([, s]) => s.cut === true && keep(s)));
    let repaired = 0;
    for (const e of freeEdges(atlas, key, slots)) {
      let opaque = e.opaque;
      if (opaque && opaque <= Math.ceil(e.edge * EDGE_REPAIR_SHARE)) {
        const [hex, spec] = Object.entries(slots).find(([, s]) => s.name === e.slot)!;
        repaired += clearFreeEdges(atlas, key, hex, spec);
        lines.push(`  free edge ${set} ${e.slot}: ${opaque}/${e.edge} opaque — cleared (a stray touch)`);
        opaque = 0;
      } else lines.push(`  free edge ${set} ${e.slot}: ${opaque}/${e.edge} opaque${opaque ? `  <-- paint runs off the cut-out: regenerate this sheet (armor gen ${b.id} --redo ${set.replace("human-", "")} --project ${ctx.project}, then armor run ${b.id})` : ""}`);
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
  const helm = readGlb(models.model(MODEL.helm)), sh = readGlb(models.model(MODEL.shoulder));
  for (const [what, d] of [["body", density(body, male.width, worldScale(body.meshWorld))], ["helm", density(helm, png(atlasOut("human-helm", b.id)).width, 0.019)], ["shoulder", density(sh, png(atlasOut("human-shoulder", b.id)).width, 0.019)]] as const) {
    const off = Math.abs(d / DENSITY.target - 1) > DENSITY.tolerance;
    lines.push(`  density ${what}: ${d.toFixed(0)} texels/m (house ${DENSITY.target} ±${DENSITY.tolerance * 100}%)${off ? "  <-- off" : ""}`);
    if (off) ok = false;
  }
  stamp(ctx.project, b.id, "import", { ok, fp: fingerprint(ctx.project, b, "import"), note: ok ? undefined : "a measured gate failed (see the import output)" });
  return { ok, lines };
}

const themesOnPage = (project: string, model: string, prefix: string): string[] =>
  Object.keys(readGlb(paths(project).model(model)).tiles).map((t) => t.slice(prefix.length, -4));

export function stageBake(ctx: Ctx, b: ArmorBrief): StageResult {
  const lines: string[] = [];
  const p = paths(ctx.project, b.id);
  const t = sheetIds(b.id);
  const fail = (why: string): StageResult => {
    lines.push(`  ! bake ${b.id}: ${why}`);
    stamp(ctx.project, b.id, "bake", { ok: false, fp: fingerprint(ctx.project, b, "bake"), note: why });
    return { ok: false, lines };
  };
  // body: add or replace the two sheets without re-running the weight transfer
  const bp = node([path.join(PG, "tools/body-page.mjs"), "--glb", p.model(MODEL.body), "--theme", `${t.body}=${atlasOut("human-body", b.id)}`, "--theme", `${t.bodyF}=${atlasOut("human-body", `${b.id}-f`)}`], ctx);
  lines.push(...bp.out.trim().split("\n").map((l) => `  ${l.trim()}`));
  if (bp.status !== 0) return fail("body-page failed");
  for (const [id, src] of [[t.body, atlasOut("human-body", b.id)], [t.bodyF, atlasOut("human-body", `${b.id}-f`)]] as const) {
    fs.mkdirSync(path.dirname(p.texture(id)), { recursive: true });
    fs.copyFileSync(src, p.texture(id));
  }
  // helm and shoulders: every theme already on the page plus this one, re-baked (pages only hold what they were baked with)
  for (const [recipe, model] of [["human-helm", MODEL.helm], ["human-shoulder", MODEL.shoulder]] as const) {
    const themes = [...new Set([...themesOnPage(ctx.project, model, `mmo/${recipe}-`), b.id])];
    const missing = themes.filter((th) => !fs.existsSync(atlasOut(recipe, th)));
    if (missing.length) return fail(`${recipe}: no out/ atlas for page theme(s) ${missing.join(", ")} (import-atlas them first)`);
    ctx.log(`  weapon-page ${recipe}: ${themes.length} themes`);
    const r = node([path.join(PG, "tools/weapon-page.mjs"), "--recipe", recipe, "--project", ctx.project, "--model", model, "--themes", ...themes], ctx);
    lines.push(...r.out.trim().split("\n").filter((l) => /weapon-page|wrote|^\s+\S+\s+\d+x\d+|!|Error/.test(l)).slice(0, 12).map((l) => `  ${l.trim()}`));
    if (r.status !== 0) return fail(`weapon-page ${recipe} exited ${r.status}: ${r.out.trim().split("\n").slice(-2).join(" / ")}`);
  }
  const ic = node([path.join(PG, "tools/item-icon.mjs"), "--project", ctx.project, "--model", MODEL.body], ctx);
  lines.push(`  item-icon ${MODEL.body}: ${ic.status === 0 ? `${ic.out.split("\n").filter((l) => /->/.test(l)).length} icon(s)` : `FAILED ${ic.out.trim().split("\n").pop()}`}`);
  if (ic.status !== 0) return fail("item-icon failed");
  // the page must now carry the set
  const facts = loadFacts(ctx.project);
  const absent = [[facts.body, t.body], [facts.body, t.bodyF], [facts.helm, t.helm], [facts.shoulder, t.shoulder]].filter(([f, id]) => !(f as { tiles: string[] }).tiles.includes(id as string)).map(([, id]) => id);
  if (absent.length) return fail(`not on the page after the bake: ${absent.join(", ")}`);
  lines.push(`  bake ${b.id}: on every page (body ${facts.body.tiles.length}, helm ${facts.helm.tiles.length}, shoulder ${facts.shoulder.tiles.length} tiles)`);
  stamp(ctx.project, b.id, "bake", { ok: true, fp: fingerprint(ctx.project, b, "bake") });
  return { ok: true, lines };
}

/** The house framing of body-model hands and feet (the vanguard/ranger/magus entries of item-icons.json). */
const ICON_FRAME = { gloves: { from: [1, 0, 0], up: [0, 0, 1], roll: 0 }, boots: { from: [1, -0.35, 0.15], up: [0, 0, 1], roll: 0 } };

export function stageItems(ctx: Ctx, b: ArmorBrief): StageResult {
  const p = paths(ctx.project, b.id);
  const lines: string[] = [];
  const items = buildItems(b);
  for (const it of items) {
    const f = p.item(it.id);
    // keep a rendered icon across re-writes; everything else is the brief's
    const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...it.doc, ...(prev?.icon ? { icon: prev.icon } : {}) }, null, 2) + "\n");
  }
  lines.push(`  items ${b.id}: ${items.length} written (${b.tiers.map((t) => t.rarity).join(", ")} x ${SLOTS.length} slots)`);
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
  if (framed) {
    fs.writeFileSync(presetsFile, JSON.stringify(presets, null, 2) + "\n");
    lines.push(`  icon framing: ${framed} glove/boot item(s) added to authoring/item-icons.json`);
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
  const read = (id: string) => (fs.existsSync(p.item(id)) ? JSON.parse(fs.readFileSync(p.item(id), "utf8")) : null);
  const out = itemsLint(b, read, facts, (t) => fs.existsSync(p.texture(t)));
  for (const it of buildItems(b)) {
    const doc = read(it.id);
    if (doc && (!doc.icon || !fs.existsSync(p.texture(doc.icon)))) out.push(`${it.id}: no rendered icon`);
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
  const rows: { label: string; views: Img[] }[] = [];
  for (const tier of b.tiers) {
    const views: Img[] = [];
    for (const sex of ["male", "female"] as Sex[]) {
      const bodyParts = ["chest", "gloves", "legs", "boots"].flatMap((s) => slotParts(b, s as (typeof SLOTS)[number], tier.ornate));
      const helmParts = slotParts(b, "helm", tier.ornate), shParts = slotParts(b, "shoulders", tier.ornate);
      const hidden = partsHiddenBy(helmRules, helmParts);
      const pieces: Piece[] = [{ glb: body, parts: sex === "male" ? bodyParts : femaleParts(bodyParts, remap), tex: tex(sex === "male" ? t.body : t.bodyF), at: body.meshWorld }];
      const headAt = mountMatrices(body, cr.mounts, "mmo/human-head.glb", sex)[0];
      if (head && headAt) {
        const hp = (sex === "male" ? ["HeadFace", "HeadSides/Back", "HeadBottom", "HeadCrown"] : ["F_HeadFace", "F_HeadSides/Back", "F_HeadBottom", "F_HeadCrown"]).filter((x) => !hidden.has(x));
        pieces.push({ glb: head, parts: hp, tex: tex(sex === "male" ? "mmo/human-head-m-young.png" : "mmo/human-head-female-f-young.png"), at: headAt });
      }
      for (const at of mountMatrices(body, cr.mounts, MODEL.helm, sex)) pieces.push({ glb: helm, parts: helmParts, tex: tex(t.helm), at });
      for (const at of mountMatrices(body, cr.mounts, MODEL.shoulder, sex)) pieces.push({ glb: sh, parts: shParts, tex: tex(t.shoulder), at });
      views.push(renderView(pieces, front, 260), renderView(pieces, back, 260));
    }
    rows.push({ label: `${tier.rarity}${tier.ornate ? " ornate" : ""}: male front, back / female front, back`, views });
  }
  const icons = buildItems(b).map((i) => readPng(p.texture(`icons/${i.id}.png`))).filter((x): x is Img => !!x);
  const sheet = composeSheet({ title: `${b.name} (${b.id})`, rows, icons });
  writePng(p.review, sheet);
  const lines = [`  review ${b.id}: ${path.relative(PG, p.review)} (${sheet.width}x${sheet.height}, ${rows.length} tier row(s), ${icons.length} icons) — look at it`];
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
