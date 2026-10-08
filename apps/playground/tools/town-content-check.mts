/**
 * town-content-check — lint a batch of town content (dialogues, quests, shops) BEFORE it is installed, against the
 * project's live assets and the town doc. The gate `codex-task.mjs --check` runs on a staging folder.
 *
 *   npx tsx tools/town-content-check.mts --project voxel-demo --town brinehold --stage <dir>
 *
 * Staged files are named by kind: `dialogue.<id>.json` (id without the town prefix; installed as
 * dialogues/<town>/<id>.json), `quest.<id>.json`, `shop.<id>.json` (installed as shops/<town>/<id>.json).
 * Checks: each parses against its schema; no literal compass word anywhere (places are {dir:id}/{place:id}/{far:id});
 * every place token names a known place; every quest a dialogue or quest names exists (staged or installed); every
 * item a shop/quest/dialogue names exists; talk targets, givers and turn-ins are residents of the town.
 * Exit 1 with every problem listed.
 */
import fs from "node:fs";
import path from "node:path";
import { dialogueSchema, literalCompassWords, placeTokens, questSchema, shopSchema } from "@hitreg/core";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const project = path.resolve("projects", opt("project", ""));
const townName = opt("town", "");
const stage = path.resolve(opt("stage", ""));
const assets = path.join(project, "assets");
const town = JSON.parse(fs.readFileSync(path.join(project, "authoring/towns", `${townName}.json`), "utf8"));
const residents = new Set<string>(town.residents.map((r: { id: string }) => r.id));
const places = new Set<string>(Object.keys(town.places ?? {}));
const placesFile = path.join(assets, "places/towns", `${townName}.json`);
if (fs.existsSync(placesFile)) {
  const table = JSON.parse(fs.readFileSync(placesFile, "utf8"));
  for (const k of Object.keys(table.places ?? table)) places.add(k);
}
for (const r of residents) places.add(r);
const items = new Set(fs.readdirSync(path.join(assets, "items")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
const quests = new Set(fs.readdirSync(path.join(assets, "quests")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
const staged = fs.readdirSync(stage).filter((f) => f.endsWith(".json"));
for (const f of staged) if (f.startsWith("quest.")) quests.add(f.slice(6, -5));

const problems: string[] = [];
const textOf = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(textOf) : v && typeof v === "object" ? Object.values(v).flatMap(textOf) : []);
function checkText(file: string, doc: unknown): void {
  for (const t of textOf(doc)) {
    const words = literalCompassWords(t);
    if (words.length) problems.push(`${file}: compass word(s) ${words.join(", ")} in "${t.slice(0, 80)}"`);
    for (const id of placeTokens(t)) if (!places.has(id)) problems.push(`${file}: unknown place "${id}"`);
  }
}
function walkConditions(file: string, c: unknown): void {
  if (!c || typeof c !== "object") return;
  const o = c as Record<string, unknown>;
  if (typeof o.quest === "string" && !quests.has(o.quest)) problems.push(`${file}: condition names unknown quest "${o.quest}"`);
  if (typeof o.item === "string" && !items.has(o.item)) problems.push(`${file}: condition names unknown item "${o.item}"`);
  for (const k of ["all", "any"]) for (const x of (o[k] as unknown[]) ?? []) walkConditions(file, x);
  if (o.not) walkConditions(file, o.not);
}
for (const f of staged) {
  const raw = JSON.parse(fs.readFileSync(path.join(stage, f), "utf8"));
  if (f.startsWith("dialogue.")) {
    const r = dialogueSchema.safeParse(raw);
    if (!r.success) { problems.push(`${f}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`); continue; }
    // only what a player reads: node lines and choice buttons (ids like south-road-bounty are not prose)
    checkText(f, Object.values(r.data.nodes).map((n) => [n.text, n.choices.map((c) => c.text)]));
    for (const s of r.data.start) walkConditions(f, s.if);
    for (const n of Object.values(r.data.nodes))
      for (const c of n.choices) {
        walkConditions(f, c.if);
        for (const a of c.do) {
          if ((a.do === "acceptQuest" || a.do === "turnInQuest") && !quests.has(a.quest)) problems.push(`${f}: ${a.do} unknown quest "${a.quest}"`);
          if ((a.do === "give" || a.do === "take") && !items.has(a.item)) problems.push(`${f}: ${a.do} unknown item "${a.item}"`);
          if (a.do === "openShop" && !fs.existsSync(path.join(assets, "shops", `${a.shop}.json`)) && !staged.includes(`shop.${a.shop.split("/").pop()}.json`)) problems.push(`${f}: openShop unknown shop "${a.shop}"`);
        }
      }
  } else if (f.startsWith("quest.")) {
    const r = questSchema.safeParse(raw);
    if (!r.success) { problems.push(`${f}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`); continue; }
    const q = r.data;
    if (q.id !== f.slice(6, -5)) problems.push(`${f}: id "${q.id}" does not match the file name`);
    checkText(f, { title: q.title, description: q.description, objectives: q.objectives.map((o) => o.label), area: q.area?.label });
    for (const who of [q.giver, q.turnIn]) if (who && !residents.has(who)) problems.push(`${f}: "${who}" is not a resident`);
    for (const o of q.objectives) {
      if (o.kind === "talk" && !residents.has(o.target)) problems.push(`${f}: talk target "${o.target}" is not a resident`);
      if (o.kind === "collect" && !items.has(o.target)) problems.push(`${f}: collects unknown item "${o.target}"`);
      if (o.kind === "visit" && !q.area) problems.push(`${f}: a visit objective needs an area`);
    }
    for (const need of q.requires) if (!quests.has(need)) problems.push(`${f}: requires unknown quest "${need}"`);
    for (const it of q.rewardItems) if (!items.has(it.itemId)) problems.push(`${f}: rewards unknown item "${it.itemId}"`);
  } else if (f.startsWith("shop.")) {
    const r = shopSchema.safeParse(raw);
    if (!r.success) { problems.push(`${f}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`); continue; }
    for (const s of r.data.stock) if (!items.has(s.itemId)) problems.push(`${f}: stocks unknown item "${s.itemId}"`);
  } else problems.push(`${f}: unknown kind (expected dialogue./quest./shop. prefix)`);
}
if (problems.length) {
  console.log(`CONTENT CHECK FAILED (${problems.length}):`);
  for (const p of problems) console.log(`  ! ${p}`);
  process.exit(1);
}
console.log(`CONTENT CHECK OK (${staged.length} files)`);
