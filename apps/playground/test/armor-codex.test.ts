// armor (tools/armor.mts): the brief schema, brief lint (kit and instance), cross-set pick lint, loot plans, items,
// the gen-set manifest and its sessions. No Codex call: gen is exercised through the same builders `--dry-run` prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemSchema } from "@hitreg/core";
import { armorBriefSchema, briefTemplate, type ArmorBriefInput } from "../tools/armor-codex/schema.mts";
import { briefLint, buildItems, buildManifest, crossSetLint, genWaves, itemsLint, isOrnament, pickDifference, sessionImages, sheetWeights, slotParts, subjectText, parseRules, sheetIds, type ModelFacts, type Templates } from "../tools/armor-codex/set.mts";
import { lootPlanLint, lootPlanSchema, planSkeleton, lootInputSchema, type LootPlan } from "../tools/armor-codex/loot.mts";
import { femaleChest, keyMask, freeEdges } from "../tools/armor-codex/measure.mts";
import { loadTemplates,reviewLooks,themesForTileIds,helmDensityChecks } from "../tools/armor-codex/stages.mts";
import { I4, type Glb } from '../tools/armor-codex/glb.mts';
// @ts-expect-error plain JS module
import { weaponPagePaths } from "../tools/_weapon-page-paths.mjs";
import path from 'node:path';

test('bare-arm kit chest leaves arm ownership with the creation body',()=>{
 const b=armorBriefSchema.parse({...briefTemplate('copperback-test'),bareArms:true});
 const parts=slotParts(b,'chest',false);
 assert.deepEqual(parts,['HumanMale_ChestFront','HumanMale_ChestBack']);
 assert.ok(slotParts({...b,bareArms:false},'chest',false).includes('HumanMale_ArmOutside'));
});

test('helmet density separates key paint from independent cap UVs and unused native masks',()=>{
 const tri=(part:number,pixels:number)=>({part,p:[[0,0,0],[1,0,0],[0,1,0]],uv:[[0,0],[109*.019/pixels,0],[0,109*.019/pixels]]});
 const helm:Glb={parts:{Helm1_Base:0,PeasantCap:1,CultMask:2},tiles:{},rules:{},meshWorld:I4(),joints:{},tris:[tri(0,132),tri(1,54),tri(2,8)]};
 const checks=helmDensityChecks(helm,132,[{texture:'mmo/cloth-cap.png',parts:['PeasantCap'],size:54}]);
 assert.equal(checks.length,2);
 for(const[,d]of checks)assert.ok(Math.abs(d-109)<1e-8,`Expected actual 109 texels/m, got ${d}`);
 assert.match(checks[1]![0],/cloth-cap/);
 const keyAdditions={...helm,parts:{Helm1RearCap:3,HoodCrown:4,CultMask:2},tris:[tri(3,132),tri(4,132),tri(2,8)]};
 assert.ok(Math.abs(helmDensityChecks(keyAdditions,132,[])[0]![1]-109)<1e-8,'Native rear coverage and hood crowns still use the ordinary key layout');
});

test('recipe theme discovery ignores independent native accessory tiles on the same page',()=>{
 assert.deepEqual(themesForTileIds(['mmo/human-helm-peasant.png','mmo/cult-bronze-face.png','mmo/peasant-cap-cloth.png','mmo/human-helm-watch.png','mmo/human-helm-readme.txt'],'mmo/human-helm-'),['peasant','watch']);
});

test('weapon page defaults keep the legacy atlas and texture routes', () => {
 const engine=path.resolve('fixture-engine');
 assert.deepEqual(weaponPagePaths(engine,'human-helm','mmo/human-helm.glb'),{atlasRoot:path.join(engine,'tools/atlas/out'),outDir:path.join(engine,'tools/atlas/out/human-helm'),textureDir:'mmo'});
});
test('weapon page can install a compiled atlas under independent texture IDs', () => {
 const root=path.resolve('compiled-boss-art'),p=weaponPagePaths(path.resolve('fixture-engine'),'human-helm','mmo/boss-helm.glb',{'atlas-root':root,'texture-dir':'mmo/ornate'});
 assert.equal(p.outDir,path.join(root,'human-helm'));assert.equal(p.textureDir,'mmo/ornate');
 assert.throws(()=>weaponPagePaths('.', 'human-helm','mmo/head.glb',{'texture-dir':'../outside'}),/relative asset/);
 assert.throws(()=>weaponPagePaths('.', 'human-helm','mmo/head.glb',{'texture-dir':'C:/outside'}),/relative asset/);
});

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
    helmLook: "a quilted hood",
    helms: [
      { key: "hood", name: "Test Hood", base: "Hood", tiers: ["common"] },
      { key: "crowned", name: "Test Crowned Hood", base: "Hood", extras: ["Bandana", "Crown"], ornate: ["OrnateTop"], tiers: ["rare"] },
    ],
    shoulderLook: "quilted pads",
    shoulders: [
      { key: "pad", name: "Test Pad", base: "ShoulderBase4", rim: "Rim1", tiers: ["common"] },
      { key: "pauldron", name: "Test Pauldron", base: "ShoulderBase1", ornate: ["Ornate"], tiers: ["rare"] },
    ],
    legs: "robe",
    source: { kind: "zone", id: "z1" },
    ...over,
  });

test('body registration manifests stay project relative',()=>{
 assert.equal(brief({bodyManifest:'authoring/workwear/body-import.json'}).bodyManifest,'authoring/workwear/body-import.json');
 for(const bodyManifest of ['../shared.json','/outside.json','C:/outside.json','authoring/../outside.json','authoring\\outside.json'])assert.throws(()=>brief({bodyManifest}));
 assert.equal(brief().bodyManifest,undefined);
});

const BODY_PARTS = ["HumanMale_ChestFront", "HumanMale_ChestBack", "HumanMale_ArmOutside", "HumanMale_ArmInside", "HumanMale_HandPalm", "HumanMale_HandFront", "HumanMale_Foot", "Human_LegsFront", "Human_LegsBack", "Belt", "Buckle", "RobesFront", "RobesBack", "TassetFront", "TassetBack", "ChestHalo"];
const HELM_PARTS = ["NoseGuard2", "FacecoverTotal", "Hood", "Helm3_base", "HeadBand1", "Helm2_Base", "Helm2_NoBeard", "NoseGuard1", "Helm1_Base", "Helm1_Flair", "Helm1_NoBeard", "Bandana", "Crown", "OrnateSide", "OrnateTop", "OrnateTop2"];
const SHOULDER_PARTS = ["ShoulderBase1", "ShoulderBase2", "ShoulderBase3", "ShoulderBase4", "Rim1", "Accent1", "Ornate", "Ornate2", "PlanerRim", "PlanerAccent"];
// triangle counts of the real models (lint measures distinctness in triangles)
const HELM_TRIS = { NoseGuard2: 36, FacecoverTotal: 100, Hood: 96, Helm3_base: 72, HeadBand1: 20, Helm2_Base: 56, Helm2_NoBeard: 24, NoseGuard1: 44, Helm1_Base: 72, Helm1_Flair: 16, Helm1_NoBeard: 12, Bandana: 30, Crown: 20 };
const facts = (tiles: string[] = []): ModelFacts => ({
  body: { parts: BODY_PARTS, rules: parseRules({ requires: { RobesFront: ["RobesBack"], RobesBack: ["RobesFront"], Buckle: ["Belt"] }, excludes: { RobesBack: ["TassetBack"] } }), tiles },
  helm: {
    parts: HELM_PARTS,
    rules: parseRules({ oneOf: [["Helm1_Base", "Helm2_Base", "Helm3_base", "HeadBand1"], ["NoseGuard1", "NoseGuard2"]], excludes: { HeadBand1: ["NoseGuard1", "NoseGuard2", "OrnateTop", "OrnateTop2"] }, requires: { Helm1_Flair: ["Helm1_Base"] } }),
    tiles,
    tris: HELM_TRIS,
  },
  shoulder: { parts: SHOULDER_PARTS, rules: parseRules({ oneOf: [["ShoulderBase1", "ShoulderBase2", "ShoulderBase3", "ShoulderBase4"], ["Rim1", "PlanerRim"]] }), tiles, tris: { ShoulderBase1: 38, ShoulderBase2: 76, ShoulderBase3: 32, ShoulderBase4: 44, Rim1: 28, Accent1: 28, PlanerRim: 24, PlanerAccent: 24 } },
});
const KEYS = { body: ["#ff0000", "#a80000", "#f800ff", "#760079", "#1f00ff", "#11008a"], helm: ["#6a00c0", "#400080"], shoulder: ["#6a00c0"] };
const T: Templates = { body: "BODY SHEET\nSUBJECT:\n{subject}\nEND", female: "THE WOMAN'S VERSION", helm: "HELM SHEET\nSUBJECT:\n{subject}", shoulder: "PAD SHEET\nSUBJECT:\n{subject}" };

test("schema: every field is described, the template parses, defaults fill in", () => {
  const b = brief();
  assert.equal(b.kind, "kit");
  assert.equal(b.chestHalo, true);
  assert.doesNotThrow(() => armorBriefSchema.parse(briefTemplate("new-set")));
  const shape = armorBriefSchema.shape;
  for (const [k, v] of Object.entries(shape)) assert.ok((v as { description?: string }).description, `${k} has no .describe()`);
});

test("brief lint: a clean kit passes; TODOs, ornate commons, two helm bases, rule breaks and ornament extras do not", () => {
  assert.deepEqual(briefLint(brief(), facts(), KEYS).problems, []);
  assert.ok(briefLint(armorBriefSchema.parse(briefTemplate("x")), facts(), KEYS).problems.some((p) => /TODO/.test(p)));
  const ornateCommon = briefLint(brief({ tiers: [{ rarity: "common", ornate: true }, { rarity: "rare" }] }), facts(), KEYS).problems;
  assert.ok(ornateCommon.some((p) => /rare or better/.test(p)), ornateCommon.join("; "));
  const withHelm = (h: object) => brief({ helms: [{ key: "a", name: "A", base: "Hood", tiers: ["common"] }, { key: "b", name: "B", tiers: ["rare"], ...h } as never] });
  assert.ok(briefLint(withHelm({ base: "Helm1_Base", extras: ["Helm2_Base"] }), facts(), KEYS).problems.some((p) => /one helm base/.test(p)));
  assert.ok(briefLint(withHelm({ base: "HeadBand1", extras: ["NoseGuard1"] }), facts(), KEYS).problems.some((p) => /HeadBand1 cannot go with NoseGuard1/.test(p)));
  assert.ok(briefLint(withHelm({ base: "Helm1_Base", extras: ["OrnateTop"] }), facts(), KEYS).problems.some((p) => /extras carry an ornament/.test(p)));
  const badKey = briefLint(brief({ match: { helm: [{ from: ["#123456"], to: ["#6a00c0"] }] } }), facts(), KEYS).problems;
  assert.ok(badKey.some((p) => /not a body key colour/.test(p)));
});

test("brief lint: helm and shoulder pieces must be distinct, cover every tier, and only name tiers of the set", () => {
  // Helm1 vs Helm1 + flared neck guard: 16 of 88 triangles differ (18%) — the same piece
  const same = brief({ helms: [{ key: "a", name: "A", base: "Helm1_Base", tiers: ["common"] }, { key: "b", name: "B", base: "Helm1_Base", extras: ["Helm1_Flair"], tiers: ["rare"] }] });
  assert.ok(briefLint(same, facts(), KEYS).problems.some((p) => /read as the same piece: .* 18%/.test(p)));
  // + the face plate as well: 28 of 100 differ — distinct
  const differ = brief({ helms: [{ key: "a", name: "A", base: "Helm1_Base", tiers: ["common"] }, { key: "b", name: "B", base: "Helm1_Base", extras: ["Helm1_Flair", "Helm1_NoBeard"], tiers: ["rare"] }] });
  assert.ok(!briefLint(differ, facts(), KEYS).problems.some((p) => /same piece/.test(p)));
  assert.equal(pickDifference(["Hood"], ["Hood", "NoseGuard2"], HELM_TRIS).toFixed(2), "0.27");
  assert.equal(pickDifference(["Hood", "OrnateTop"], ["Hood"], HELM_TRIS), 0, "ornaments do not make a piece distinct");
  const gap = brief({ shoulders: [{ key: "a", name: "A", base: "ShoulderBase4", tiers: ["common"] }, { key: "b", name: "B", base: "ShoulderBase1", tiers: ["common"] }] });
  assert.ok(briefLint(gap, facts(), KEYS).problems.some((p) => /shoulders: no piece drops at the rare tier/.test(p)));
  const stray = brief({ shoulders: [{ key: "a", name: "A", base: "ShoulderBase4", tiers: ["common", "epic"] }, { key: "b", name: "B", base: "ShoulderBase1", tiers: ["rare"] }] });
  assert.ok(briefLint(stray, facts(), KEYS).problems.some((p) => /tier epic is not a tier of the set/.test(p)));
  assert.throws(() => brief({ helms: [] }), "a kit cannot have zero helm pieces");
});

test('one multi-tier helm keeps both rarity IDs and all slot/tier checks',()=>{
 const b=brief({helms:[{key:'hood',name:'Shared Hood',base:'Hood',tiers:['common','rare']}]});
 assert.deepEqual(briefLint(b,facts(),KEYS).problems,[]);
 assert.deepEqual(buildItems(b).filter(i=>itemSchema.parse(i.doc).slots.includes('helm')).map(i=>i.id),['test-binder-helm-common','test-binder-helm-rare']);
 assert.throws(()=>brief({helms:[]}));
 const gap=brief({...b,helms:[{...b.helms![0]!,tiers:['common']}]});
 assert.ok(briefLint(gap,facts(),KEYS).problems.some(p=>/helm: no piece drops at the rare tier/.test(p)));
 const stray=brief({...b,helms:[{...b.helms![0]!,tiers:['common','rare','epic']}]});
 assert.ok(briefLint(stray,facts(),KEYS).problems.some(p=>/tier epic is not a tier/.test(p)));
 assert.throws(()=>brief({...b,shoulders:[]}));
});

test("wardrobe reuse is explicit, preserves strict collisions and does not waive within-kit rules", () => {
  const reason = "Practical civilian caps and shawls share fitted geometry; distinct painted cuts and occupation materials establish their identity.";
  const strict = brief(), wardrobe = brief({ id: "town-wardrobe", reusePartPicks: reason });
  const reused = crossSetLint([{ b: strict }, { b: wardrobe }]);
  assert.deepEqual(reused.problems, []);
  assert.ok(reused.warnings.some((p) => /shared wardrobe pick/.test(p)));
  const unwaived = crossSetLint([{ b: strict }, { b: wardrobe }, { b: brief({ id: "strict-twin" }) }]);
  assert.ok(unwaived.problems.some((p) => /identical pick/.test(p)));
  assert.throws(() => brief({ reusePartPicks: "skip" }));
  const same = brief({ reusePartPicks: reason, helms: [{ key: "a", name: "A", base: "Hood", tiers: ["common"] }, { key: "b", name: "B", base: "Hood", tiers: ["rare"] }] });
  assert.ok(briefLint(same, facts(), KEYS).problems.some((p) => /read as the same piece/.test(p)));
});

test("items: body per slot per tier, one item per helm/shoulder piece per tier; the first piece at a tier keeps the plain id", () => {
  const b = brief({ helms: [{ key: "hood", name: "Test Hood", base: "Hood", tiers: ["common", "rare"] }, { key: "crowned", name: "Test Crowned Hood", base: "Hood", extras: ["Bandana", "Crown"], ornate: ["OrnateTop"], tiers: ["rare"] }] });
  const items = buildItems(b);
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes("test-binder-helm-common") && ids.includes("test-binder-helm-rare") && ids.includes("test-binder-helm-crowned-rare"), ids.join(", "));
  assert.equal(items.length, 13);
  const crowned = items.find((i) => i.id === "test-binder-helm-crowned-rare")!.doc;
  assert.equal(crowned.name, "Test Crowned Hood");
  assert.deepEqual((crowned.appearance as { parts: string[] }).parts, ["Hood", "Bandana", "Crown", "OrnateTop"]);
  for (const it of items) {
    const r = itemSchema.safeParse(it.doc);
    assert.ok(r.success, `${it.id}: ${r.success ? "" : r.error.message}`);
    const parts = (it.doc.appearance as { parts: string[] }).parts;
    if (parts.some(isOrnament)) assert.equal(it.doc.rarity, "rare", `${it.id}: ${parts.join(",")}`);
    assert.ok(!parts.some((p) => p.startsWith("HumanFemale_") || p.startsWith("F_")), "items name the man's parts");
    assert.ok((it.doc.tags as string[]).includes("test-binder") && (it.doc.tags as string[]).includes("cloth"));
  }
  assert.deepEqual(slotParts(b, "legs", false), ["Human_LegsFront", "Human_LegsBack", "Belt", "Buckle", "RobesFront", "RobesBack"]);
  assert.equal((items.find((i) => i.id === "test-binder-chest-rare")!.doc.appearance as { texture: string }).texture, "mmo/human-body-test-binder.png");
});

test("native cap picks keep their own tile when a set's items are regenerated", () => {
  const b = brief({ helms: [
    { key: "coif", name: "Work coif", base: "PeasantCap", texture: "mmo/peasant-cap-cloth.png", tiers: ["common"] },
    { key: "hood", name: "Work hood", base: "Hood", tiers: ["rare"] },
  ] });
  const items = buildItems(b);
  const cap = itemSchema.parse(items.find((i) => i.id === "test-binder-helm-common")!.doc);
  assert.deepEqual(cap.appearance!.parts, ["PeasantCap"]);
  assert.equal(cap.appearance!.texture, "mmo/peasant-cap-cloth.png");
  const rows = reviewLooks(b, buildItems(b).map((item) => {
    const doc = itemSchema.parse(item.doc);
    return { id: item.id, name: doc.name, slot: doc.slots[0]!, weight: "cloth", rarity: doc.rarity, ornate: false, parts: doc.appearance!.parts, texture: doc.appearance!.texture!, key: item.id };
  }) as Parameters<typeof reviewLooks>[1]);
  assert.equal(rows.find((row) => row.helm.includes("PeasantCap"))!.helmTexture, "mmo/peasant-cap-cloth.png");
  assert.equal(itemSchema.parse(items.find((i) => i.id === "test-binder-helm-rare")!.doc).appearance!.texture, "mmo/human-helm-test-binder.png");
  assert.throws(() => brief({ helms: [
    { key: "coif", name: "Bad cap", base: "PeasantCap", texture: "../outside.png", tiers: ["common"] },
    { key: "hood", name: "Hood", base: "Hood", tiers: ["rare"] },
  ] }));
});

test("items lint: built items pass once the sheets are on the pages; a common ornament and a missing tile fail", () => {
  const b = brief();
  const docs = new Map(buildItems(b).map((i) => [i.id, i.doc]));
  const t = sheetIds(b.id);
  const all = facts([t.body, t.bodyF, t.helm, t.shoulder]);
  assert.deepEqual(itemsLint(b, (id) => docs.get(id) ?? null, all, () => true), []);
  assert.ok(itemsLint(b, (id) => docs.get(id) ?? null, facts(), () => true).some((p) => /not a tile/.test(p)));
  assert.ok(itemsLint(b, (id) => docs.get(id) ?? null, facts([t.body, t.helm, t.shoulder]), () => true).some((p) => /no woman's sheet/.test(p)));
  const helm = structuredClone(docs.get("test-binder-helm-common")!) as { appearance: { parts: string[] } };
  helm.appearance.parts.push("OrnateTop");
  docs.set("test-binder-helm-common", helm);
  assert.ok(itemsLint(b, (id) => docs.get(id) ?? null, all, () => true).some((p) => /ornaments are rare\+/.test(p)));
});

test("cross-set lint: an identical helm pick in two sets fails, a shared base only warns", () => {
  const a = brief();
  const other = brief({ id: "other-set" });
  const twin = crossSetLint([{ b: a }, { b: other }]);
  assert.ok(twin.problems.some((p) => /helm: identical pick Hood in test-binder:hood, other-set:hood/.test(p)), twin.problems.join("; "));
  const apart = brief({
    id: "other-set",
    helms: [{ key: "coif", name: "Coif", base: "Hood", extras: ["NoseGuard1"], tiers: ["common"] }, { key: "helm", name: "Helm", base: "Helm2_Base", tiers: ["rare"] }],
    shoulders: [{ key: "a", name: "A", base: "ShoulderBase2", tiers: ["common"] }, { key: "b", name: "B", base: "ShoulderBase3", tiers: ["rare"] }],
  });
  const c = crossSetLint([{ b: a }, { b: apart }]);
  assert.deepEqual(c.problems, []);
  assert.ok(c.warnings.some((w) => /helm base Hood shared by 2 sets/.test(w)));
});

// ---------------------------------------------------------------- instance sets and loot plans
const instance = (over: Partial<ArmorBriefInput> = {}) =>
  armorBriefSchema.parse({
    id: "test-halls",
    kind: "instance",
    name: "the Test Halls",
    subject: "the loot of the test halls: blackened iron, bone linen, ash wool and scuffed leather, worn and gritty, one look across every weight.",
    materials: "iron, linen, wool, leather",
    palette: "black, bone, rust, ash",
    backOrnament: "an open shackle",
    levelBand: [6, 10],
    helmLook: "the halls' headgear",
    shoulderLook: "the halls' pads",
    bodies: [
      { key: "warder", weights: { chest: "plate", legs: "mail", gloves: "plate", boots: "leather" }, subject: "THE WARDERS: a black iron breastplate, mail chausses, iron gauntlets and dark leather boots, all marked with a rust shackle." },
      { key: "cult", weights: { chest: "cloth", legs: "leather", gloves: "cloth", boots: "cloth" }, subject: "THE CULT: an ash wool coat, a dark leather apron and leggings, linen hand wraps with stone fingertips and wool foot-wraps." },
    ],
    helmPaint: [
      { parts: ["Helm1_Base", "Helm1_Flair", "Helm1_NoBeard"], weight: "mail", look: "iron cap, mail skirt" },
      { parts: ["Helm2_Base", "Helm2_NoBeard", "NoseGuard1", "NoseGuard2", "OrnateSide", "OrnateTop", "OrnateTop2"], weight: "plate", look: "iron drum helm" },
      { parts: ["Helm3_base", "HeadBand1"], weight: "leather", look: "boiled leather" },
      { parts: ["Hood", "FacecoverTotal", "Bandana", "Crown"], weight: "cloth", look: "ash wool" },
    ],
    shoulderPaint: [
      { parts: ["ShoulderBase1"], weight: "leather", look: "leather dome" },
      { parts: ["ShoulderBase2", "Rim1", "Accent1", "Ornate", "Ornate2"], weight: "plate", look: "iron lames" },
      { parts: ["ShoulderBase3"], weight: "mail", look: "mail cap" },
      { parts: ["ShoulderBase4", "PlanerRim", "PlanerAccent"], weight: "cloth", look: "wool pad" },
    ],
    loot: "loot/test-halls.json",
    source: { kind: "dungeon", id: "test-halls" },
    ...over,
  });
const sources = lootInputSchema.parse({
  dungeon: "test-halls",
  zone: "w/z1",
  sizeClass: "medium",
  levelBand: [6, 10],
  sources: [
    { id: "cult", kind: "trash", name: "Cultists", creatures: ["cultist"], area: "upper halls" },
    { id: "dead", kind: "trash", name: "Dead", creatures: ["ghost"], area: "ossuary" },
    { id: "warden", kind: "named", name: "Warden", creatures: ["risen-bones"], area: "gate" },
    { id: "voice", kind: "boss", name: "Voice", creatures: ["mire-caller"], area: "lowest hall" },
  ],
});
/** A finished plan: the skeleton, named, with helm/shoulder parts kept distinct. */
const finished = (): LootPlan => {
  const plan = planSkeleton(sources, "test-halls", sheetWeights(instance()));
  plan.pieces.forEach((p, i) => { p.name = `Piece ${i}`; p.story = "worn here"; });
  return plan;
};

test("instance brief lint: mixed sheets pass; a missing weight, an unpainted part and a kit field do not", () => {
  assert.deepEqual(briefLint(instance(), facts(), KEYS).problems, []);
  const noCloth = instance({
    bodies: [{ key: "warder", weights: { chest: "plate", legs: "mail", gloves: "plate", boots: "leather" }, subject: "THE WARDERS: a black iron breastplate, mail chausses, iron gauntlets and dark leather boots, all marked with a rust shackle." }],
    helmPaint: [{ parts: HELM_PARTS, weight: "plate", look: "iron" }],
    shoulderPaint: [{ parts: SHOULDER_PARTS, weight: "mail", look: "mail" }],
  });
  assert.ok(briefLint(noCloth, facts(), KEYS).problems.some((p) => /no sheet region is painted cloth/.test(p)));
  const unpainted = instance({ helmPaint: [{ parts: ["Hood"], weight: "cloth", look: "wool" }] });
  assert.ok(briefLint(unpainted, facts(), KEYS).problems.some((p) => /helmPaint: Helm1_Base has no weight/.test(p)));
  assert.ok(briefLint(instance({ tiers: [{ rarity: "common" }] }), facts(), KEYS).problems.some((p) => /not helms \/ shoulders \/ tiers/.test(p)));
});

test("loot plan: the skeleton covers every slot in two weights and all four weights, inside the level band; lint wants names", () => {
  const sk = planSkeleton(sources, "test-halls", sheetWeights(instance()));
  assert.ok(lootPlanLint(sk, sheetWeights(instance())).problems.some((p) => /still a TODO/.test(p)));
  const plan = finished();
  const l = lootPlanLint(plan, sheetWeights(instance()));
  assert.deepEqual(l.problems.filter((p) => !/looks the same/.test(p)), []);
  assert.equal(plan.set, null, "a medium normal dungeon gets loose pieces");
  for (const p of plan.pieces) assert.ok(p.rarity !== "rare" || p.from.includes("voice"), `${p.id}: only the boss drops rare at level 10`);
});

test("loot plan lint: same look, wrong weight for its sheet, rarity over the cap, ornate common, an unknown source, a set without its rule", () => {
  const W = sheetWeights(instance());
  const base = finished();
  const named = (p: LootPlan) => lootPlanLint(p, W).problems;
  const twin = structuredClone(base);
  const helms = twin.pieces.filter((p) => p.slot === "helm");
  helms[1]!.parts = [...helms[0]!.parts];
  helms[1]!.weight = helms[0]!.weight;
  assert.ok(named(twin).some((p) => /looks the same as/.test(p)));
  const wrong = structuredClone(base);
  const chest = wrong.pieces.find((p) => p.slot === "chest" && p.sheet === "warder")!;
  chest.weight = "cloth";
  assert.ok(named(wrong).some((p) => /body sheet warder paints the chest as plate/.test(p)));
  const rare = structuredClone(base);
  rare.pieces.find((p) => p.from[0] === "cult")!.rarity = "rare";
  assert.ok(named(rare).some((p) => /rare is above the level-10 cap \(uncommon\)/.test(p)));
  const orn = structuredClone(base);
  Object.assign(orn.pieces[0]!, { ornate: true, rarity: "common" });
  assert.ok(named(orn).some((p) => /ornate on a common piece/.test(p)));
  const lost = structuredClone(base);
  lost.pieces[0]!.from = ["nobody"];
  assert.ok(named(lost).some((p) => /not a source of the plan/.test(p)));
  const set = lootPlanSchema.parse({ ...structuredClone(base), set: { rule: "dungeon-set", name: "Halls Set" } });
  assert.ok(named(set).some((p) => /a dungeon set needs a large or hard\/raid dungeon; this one is medium, normal/.test(p)));
  const big = lootPlanSchema.parse({ ...structuredClone(base), sizeClass: "large", set: { rule: "dungeon-set", name: "Halls Set" } });
  assert.ok(named(big).some((p) => /carries 0 piece\(s\) here, want 4-6/.test(p)), "the rule fires, but the set needs its pieces");
});

test("instance items: one per planned piece, the piece's own weight tag and sheet, the -f sheet for the body", () => {
  const b = instance();
  const plan = finished();
  const items = buildItems(b, plan);
  assert.equal(items.length, plan.pieces.length);
  const chest = items.find((i) => (i.doc.slots as string[])[0] === "chest" && (i.doc.appearance as { texture: string }).texture === "mmo/human-body-test-halls-warder.png")!;
  assert.ok((chest.doc.tags as string[]).includes("plate"));
  const helm = items.find((i) => (i.doc.slots as string[])[0] === "helm")!;
  assert.equal((helm.doc.appearance as { texture: string }).texture, "mmo/human-helm-test-halls.png");
  const t = ["mmo/human-body-test-halls-warder.png", "mmo/human-body-test-halls-warder-f.png", "mmo/human-body-test-halls-cult.png", "mmo/human-body-test-halls-cult-f.png", "mmo/human-helm-test-halls.png", "mmo/human-shoulder-test-halls.png"];
  const docs = new Map(items.map((i) => [i.id, i.doc]));
  assert.deepEqual(itemsLint(b, (id) => docs.get(id) ?? null, facts(t), () => true, plan), []);
});

test("instance manifest: each body sheet and its woman's copy, then ONE helm and ONE shoulder sheet with the per-part weights", () => {
  const m = buildManifest(instance(), T);
  assert.deepEqual(m.images.map((i) => i.role), ["body:test-halls-warder", "body:test-halls-cult", "female:test-halls-warder", "female:test-halls-cult", "helm", "shoulder"]);
  assert.match(m.images[0]!.prompt, /MIXED WEIGHTS .*CHEST AND ARMS: PLATE; HANDS: PLATE; TROUSERS, ROBE PANELS, TASSET AND BELT: MAIL; BOOTS: LEATHER\): THE WARDERS/);
  assert.match(m.images[4]!.prompt, /EACH REGION IS ITS OWN ARMOUR WEIGHT[\s\S]*- HELM3, BAND: LEATHER, boiled leather/);
  assert.deepEqual(m.images[3]!.ref, ["../../tools/atlas/sets/human-body/key-female.png", "../../tools/atlas/art/human-body/test-halls-cult.png"]);
  assert.deepEqual(genWaves(m.images, () => false).map((w) => w.length), [2, 4]);
  assert.deepEqual(genWaves(m.images, () => true, false, ["body:test-halls-cult"]).map((w) => w.map((i) => i.role)), [["body:test-halls-cult"], ["female:test-halls-cult"]]);
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
