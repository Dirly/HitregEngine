// armor (tools/armor.mts): the brief schema, brief lint, items, the gen-set manifest and its sessions. No Codex call:
// gen is exercised through the same builders `--dry-run` prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemSchema } from "@hitreg/core";
import { armorBriefSchema, briefTemplate, type ArmorBriefInput } from "../tools/armor-codex/schema.mts";
import { briefLint, buildItems, buildManifest, genWaves, itemsLint, isOrnament, sessionImages, slotParts, subjectText, parseRules, sheetIds, type ModelFacts, type Templates } from "../tools/armor-codex/set.mts";
import { femaleChest, keyMask, freeEdges } from "../tools/armor-codex/measure.mts";
import { loadTemplates } from "../tools/armor-codex/stages.mts";

const brief = (over: Partial<ArmorBriefInput> = {}) =>
  armorBriefSchema.parse({
    id: "test-binder",
    name: "Test Binder",
    weight: "cloth",
    subject: "a basalt-grey quilted wool coat over the chest and arms, black stone knuckle plates on the gloves, charcoal trousers, black boots, a split skirt and a narrow tasset, a dark belt with an iron buckle.",
    materials: "quilted wool, black basalt plates",
    palette: "basalt grey, charcoal, black stone",
    backOrnament: "a thin iron wire open hand",
    levelBand: [1, 10],
    tiers: [{ rarity: "common" }, { rarity: "rare", ornate: true }],
    helm: { base: "Hood", look: "a quilted hood" },
    shoulders: { base: "ShoulderBase4", rim: "Rim1", look: "quilted pads" },
    legs: "robe",
    source: { kind: "zone", id: "z1" },
    ...over,
  });

const BODY_PARTS = ["HumanMale_ChestFront", "HumanMale_ChestBack", "HumanMale_ArmOutside", "HumanMale_ArmInside", "HumanMale_HandPalm", "HumanMale_HandFront", "HumanMale_Foot", "Human_LegsFront", "Human_LegsBack", "Belt", "Buckle", "RobesFront", "RobesBack", "TassetFront", "TassetBack", "ChestHalo"];
const facts = (tiles: string[] = []): ModelFacts => ({
  body: { parts: BODY_PARTS, rules: parseRules({ requires: { RobesFront: ["RobesBack"], RobesBack: ["RobesFront"], Buckle: ["Belt"] }, excludes: { RobesBack: ["TassetBack"] } }), tiles },
  helm: {
    parts: ["NoseGuard2", "FacecoverTotal", "Hood", "Helm3_base", "HeadBand1", "Helm2_Base", "Helm2_NoBeard", "NoseGuard1", "Helm1_Base", "Helm1_Flair", "Helm1_NoBeard", "Bandana", "Crown", "OrnateSide", "OrnateTop", "OrnateTop2"],
    rules: parseRules({ oneOf: [["Helm1_Base", "Helm2_Base", "Helm3_base", "HeadBand1"], ["NoseGuard1", "NoseGuard2"]], excludes: { HeadBand1: ["NoseGuard1", "NoseGuard2", "OrnateTop", "OrnateTop2"] }, requires: { Helm1_Flair: ["Helm1_Base"] } }),
    tiles,
  },
  shoulder: { parts: ["ShoulderBase1", "ShoulderBase2", "ShoulderBase3", "ShoulderBase4", "Rim1", "Accent1", "Ornate", "Ornate2", "PlanerRim", "PlanerAccent"], rules: parseRules({ oneOf: [["ShoulderBase1", "ShoulderBase2", "ShoulderBase3", "ShoulderBase4"], ["Rim1", "PlanerRim"]] }), tiles },
});
const KEYS = { body: ["#ff0000", "#a80000", "#f800ff", "#760079", "#1f00ff", "#11008a"], helm: ["#6a00c0", "#400080"], shoulder: ["#6a00c0"] };
const T: Templates = { body: "BODY SHEET\nSUBJECT:\n{subject}\nEND", female: "THE WOMAN'S VERSION", helm: "HELM SHEET\nSUBJECT:\n{subject}", shoulder: "PAD SHEET\nSUBJECT:\n{subject}" };

test("schema: every field is described, the template parses, defaults fill in", () => {
  const b = brief();
  assert.equal(b.helm.ornate[0], "OrnateTop");
  assert.equal(b.chestHalo, true);
  assert.doesNotThrow(() => armorBriefSchema.parse(briefTemplate("new-set")));
  const shape = armorBriefSchema.shape;
  for (const [k, v] of Object.entries(shape)) assert.ok((v as { description?: string }).description, `${k} has no .describe()`);
});

test("brief lint: a clean brief passes; TODOs, ornate commons and two helm bases do not", () => {
  assert.deepEqual(briefLint(brief(), facts(), KEYS).problems, []);
  assert.ok(briefLint(armorBriefSchema.parse(briefTemplate("x")), facts(), KEYS).problems.some((p) => /TODO/.test(p)));
  const ornateCommon = briefLint(brief({ tiers: [{ rarity: "common", ornate: true }] }), facts(), KEYS).problems;
  assert.ok(ornateCommon.some((p) => /rare or better/.test(p)), ornateCommon.join("; "));
  const twoBases = briefLint(brief({ helm: { base: "Helm1_Base", extras: ["Helm2_Base"], look: "x" } }), facts(), KEYS).problems;
  assert.ok(twoBases.some((p) => /one helm base/.test(p)));
  const rule = briefLint(brief({ helm: { base: "HeadBand1", extras: ["NoseGuard1"], look: "x" } }), facts(), KEYS).problems;
  assert.ok(rule.some((p) => /HeadBand1 cannot go with NoseGuard1/.test(p)), rule.join("; "));
  const orn = briefLint(brief({ helm: { base: "Hood", extras: ["OrnateTop"], look: "x" } }), facts(), KEYS).problems;
  assert.ok(orn.some((p) => /helm.extras carries an ornament/.test(p)));
  const badKey = briefLint(brief({ match: { helm: [{ from: ["#123456"], to: ["#6a00c0"] }] } }), facts(), KEYS).problems;
  assert.ok(badKey.some((p) => /not a body key colour/.test(p)));
});

test("items: one per slot per tier, male part names, ornaments only on the ornate rare tier, schema-valid", () => {
  const b = brief();
  const items = buildItems(b);
  assert.equal(items.length, 12);
  for (const it of items) {
    const r = itemSchema.safeParse(it.doc);
    assert.ok(r.success, `${it.id}: ${r.success ? "" : r.error.message}`);
    const parts = (it.doc.appearance as { parts: string[] }).parts;
    const rare = it.doc.rarity === "rare";
    assert.equal(parts.some(isOrnament), rare && /helm|shoulders|chest/.test(it.id), `${it.id}: ${parts.join(",")}`);
    assert.ok(!parts.some((p) => p.startsWith("HumanFemale_") || p.startsWith("F_")), "items name the man's parts");
    assert.ok((it.doc.tags as string[]).includes("test-binder"));
  }
  assert.deepEqual(slotParts(b, "legs", false), ["Human_LegsFront", "Human_LegsBack", "Belt", "Buckle", "RobesFront", "RobesBack"]);
  assert.equal(items.find((i) => i.id === "test-binder-chest-rare")!.doc.appearance && (items.find((i) => i.id === "test-binder-chest-rare")!.doc.appearance as { texture: string }).texture, "mmo/human-body-test-binder.png");
});

test("items lint: built items pass once the sheets are on the pages; a common ornament and a missing tile fail", () => {
  const b = brief();
  const docs = new Map(buildItems(b).map((i) => [i.id, i.doc]));
  const t = sheetIds(b.id);
  const all = facts([t.body, t.bodyF, t.helm, t.shoulder]);
  assert.deepEqual(itemsLint(b, (id) => docs.get(id) ?? null, all, () => true), []);
  assert.ok(itemsLint(b, (id) => docs.get(id) ?? null, facts(), () => true).some((p) => /not a tile/.test(p)));
  const helm = structuredClone(docs.get("test-binder-helm-common")!) as { appearance: { parts: string[] } };
  helm.appearance.parts.push("OrnateTop");
  docs.set("test-binder-helm-common", helm);
  assert.ok(itemsLint(b, (id) => docs.get(id) ?? null, all, () => true).some((p) => /ornaments are rare\+/.test(p)));
});

test("gen manifest: the doc's order, refs in order, the SUBJECT word for word on all four prompts", () => {
  const b = brief();
  const m = buildManifest(b, T);
  assert.deepEqual(m.images.map((i) => i.role), ["body", "female", "helm", "shoulder"]);
  const subject = subjectText(b);
  for (const i of m.images) {
    assert.ok(i.prompt.includes(subject), `${i.id} carries the subject`);
    assert.ok(!i.prompt.includes("{subject}"));
    assert.equal(i.size, "1254x1254");
  }
  assert.deepEqual(m.images[0]!.ref, ["../../tools/atlas/sets/human-body/key.png"]);
  assert.deepEqual(m.images[1]!.ref, ["../../tools/atlas/sets/human-body/key-female.png", "../../tools/atlas/art/human-body/test-binder.png"]);
  assert.deepEqual(m.images[2]!.ref, ["../../tools/atlas/sets/human-helm/key-labelled.png", "../../tools/atlas/art/human-body/test-binder.png"]);
  assert.ok(m.images[1]!.prompt.endsWith("THE WOMAN'S VERSION"));
  assert.match(m.images[2]!.prompt, /KEEP IT CLEAN AND READABLE[\s\S]*SECOND is the finished BODY sheet[\s\S]*HEADGEAR: a quilted hood/);
  assert.match(m.images[3]!.prompt, /SHOULDERS: quilted pads/);
});

test("gen sessions: the body first, then everything painted to it; done images skipped; --force redoes all", () => {
  const m = buildManifest(brief(), T).images;
  assert.deepEqual(genWaves(m, () => false).map((w) => w.map((i) => i.role)), [["body"], ["female", "helm", "shoulder"]]);
  assert.deepEqual(genWaves(m, (i) => i.role === "body").map((w) => w.map((i) => i.role)), [["female", "helm", "shoulder"]]);
  assert.deepEqual(genWaves(m, (i) => i.role !== "female").map((w) => w.map((i) => i.role)), [["female"]]);
  assert.deepEqual(genWaves(m, () => true), []);
  assert.equal(genWaves(m, () => true, true).length, 2);
  // --redo: that sheet and everything painted from it; a helm redo leaves the rest alone
  assert.deepEqual(genWaves(m, () => true, false, ["helm"]).map((w) => w.map((i) => i.role)), [["helm"]]);
  assert.deepEqual(genWaves(m, () => true, false, ["body"]).map((w) => w.map((i) => i.role)), [["body"], ["female", "helm", "shoulder"]]);
  // one session attaches each ref once: prompts get told which attachment is their FIRST and SECOND
  const s = sessionImages(genWaves(m, () => false)[1]!);
  assert.match(s[0]!.prompt, /^ATTACHMENTS FOR THIS IMAGE: this session has 4 attached images; the FIRST image this prompt names is attachment 1 \(sets\/human-body\/key-female.png\); the SECOND image this prompt names is attachment 2/);
  assert.match(s[1]!.prompt, /the FIRST image this prompt names is attachment 3 \(sets\/human-helm\/key-labelled.png\); the SECOND image this prompt names is attachment 2/);
  const single = sessionImages([m[0]!]);
  assert.equal(single[0]!.prompt, m[0]!.prompt, "a one-image session is left as written");
});

test("the real prompt files carry {subject} after their --- rule", () => {
  const t = loadTemplates();
  for (const k of ["body", "helm", "shoulder"] as const) assert.ok(t[k].includes("{subject}"), k);
  assert.match(t.female, /WOMAN'S VERSION/);
});

test("female chest: only the chest-front island (+gutter) comes from her sheet", () => {
  const S = 16, K = 32;
  const key = { width: K, height: K, data: new Uint8Array(K * K * 4) };
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) key.data.set([255, 0, 0, 255], (y * K + x) * 4);
  const fill = (v: number) => ({ width: S, height: S, data: new Uint8Array(S * S * 4).fill(v) });
  const out = femaleChest(fill(10), fill(200), key, "#ff0000", 1);
  assert.equal(out.img.data[(5 * S + 5) * 4], 200); // inside the island
  assert.equal(out.img.data[(3 * S + 5) * 4], 200); // the gutter
  assert.equal(out.img.data[(0 * S + 0) * 4], 10); // his everywhere else
  assert.equal(out.texels, 32); // 4x4 island + a 4-neighbour ring (no corners)
  assert.equal(keyMask(key, ["#ff0000"], S).reduce((a, v) => a + v, 0), 16);
});

test("free edges: paint touching a cut-out's free edge is counted, its anchored base is not", () => {
  const S = 16, K = 16;
  const key = { width: K, height: K, data: new Uint8Array(K * K * 4) };
  for (let y = 4; y < 14; y++) for (let x = 4; x < 12; x++) key.data.set([0xc0, 0x80, 0x40, 255], (y * K + x) * 4);
  const atlas = { width: S, height: S, data: new Uint8Array(S * S * 4) };
  const paint = (x: number, y: number) => (atlas.data[(y * S + x) * 4 + 3] = 255);
  for (let x = 6; x < 10; x++) paint(x, 13); // the base on the bottom edge
  assert.deepEqual(freeEdges(atlas, key, { "#c08040": { name: "ornate", cut: true, anchor: "bottom" } }), [{ slot: "ornate", edge: 22, opaque: 0 }]);
  paint(4, 6); // a plume touching the left edge
  assert.equal(freeEdges(atlas, key, { "#c08040": { name: "ornate", cut: true, anchor: "bottom" } })[0]!.opaque, 1);
});
