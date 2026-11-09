import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dressFor, humanTemplateOps, loadHumanKit, type HumanSpec } from "../tools/zonegen/commands/_human-template.mts";
import type { Finding } from "../tools/zonegen/lib.mts";

test("human outfits resolve their own creation mounts and body through dependencies, while legacy outfits keep the default", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-human-template-"));
  const previous = process.env.HITREG_PROJECTS_ROOT;
  process.env.HITREG_PROJECTS_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.HITREG_PROJECTS_ROOT;
    else process.env.HITREG_PROJECTS_ROOT = previous;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (rel: string, doc: unknown) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
  };
  const entity = (parent: string | null, components: Record<string, unknown>) => ({ name: "pattern", parent, components });
  const mesh = (assetId: string) => ({ source: { kind: "asset", assetId, partMask: 0, textureFilter: "nearest" } });
  const script = (name: string) => ({ name, params: { actor: "pattern", creation: "default" } });
  const pattern = {
    pattern: entity(null, { transform: { position: [0, 0, 0] }, script: script("mob-brain") }),
    "pattern-visual": entity("pattern", { mesh: mesh("human/body.glb"), animator: { play: "Idle" } }),
    "pattern-look": entity("pattern-visual", { script: script("character-look") }),
    "pattern-head": entity("pattern-visual", { mesh: mesh("human/head.glb"), script: script("character-look") }),
    ...Object.fromEntries(["combat-caster", "combat-actor", "character-sheet", "bone-socket", "equipment-look"].map((name) => [`pattern-${name}`, entity("pattern", { script: script(name) })])),
  };
  const defaultProfile = {
    appearance: [{ id: "sex", body: true, options: [{ id: "male", model: "human/body.glb" }] }, { id: "face", options: [{ id: "plain", model: "human/head.glb" }] }],
    mounts: [{ model: "human/head.glb" }, { model: "human/helm.glb" }],
  };
  const cultProfile = {
    appearance: [{ id: "sex", body: true, options: [{ id: "female", model: "cult/boss-body.glb" }] }, { id: "face", options: [{ id: "cult-face", model: "human/head.glb", requires: { sex: ["female"] } }] }],
    mounts: [{ model: "human/head.glb" }, { model: "cult/ornate-helm.glb" }, { model: "cult/ornate-shoulder.glb", mirrorTo: "right" }, { model: "cult/faceplate.glb" }],
  };
  const config = {
    pattern: { scene: "pattern", entity: "pattern" }, creation: "default", weaponRig: "rig",
    outfits: { legacy: { wear: ["legacy-helm"] }, cult: { creation: "cult-profile", wear: ["cult-helm", "cult-shoulder", "cult-mask"] } },
    weapons: { sword: { item: "sword" } },
  };
  write("world/project.json", { dependsOn: ["shared"] });
  write("world/authoring/zonegen/human-template.json", config);
  write("shared/assets/scenes/pattern.scene.json", { entities: pattern });
  write("shared/assets/prefabs/rig.json", { entities: {} });
  write("shared/assets/creation/default.json", defaultProfile);
  write("shared/assets/creation/cult-profile.json", cultProfile);
  for (const [id, model] of Object.entries({ "legacy-helm": "human/helm.glb", "cult-helm": "cult/ornate-helm.glb", "cult-shoulder": "cult/ornate-shoulder.glb", "cult-mask": "cult/faceplate.glb", sword: "weapons/sword.glb" }))
    write(`shared/assets/items/${id}.json`, { appearance: { model } });
  const findings: Finding[] = [];
  const kit = loadHumanKit(path.join(root, "world"), findings);
  assert.ok(kit);
  assert.deepEqual(findings, []);
  const original = JSON.stringify(kit.pattern);
  const spawn = (outfit: string) => {
    const dress = dressFor(kit, `${outfit}-sword`);
    assert.ok(!("error" in dress));
    const spec: HumanSpec = {
      id: outfit, label: outfit, tags: [], at: [1, 2, 3], faction: "cult", level: 8, hp: 260, xp: 26, abilities: ["strike"], dress,
      pin: { sex: "female" }, brain: { hostileTo: "player", speed: 2, aggroRange: 12, deaggroRange: 24, attackInterval: 2, alertRadius: 10, leash: 18, roam: 2 },
    };
    return humanTemplateOps(kit, spec);
  };
  const cult = spawn("cult");
  assert.deepEqual(cult.appearance, { sex: "female", face: "cult-face" });
  const models = Object.values(cult.entities).map((e) => (e.components.mesh as { source: { assetId: string } } | undefined)?.source.assetId).filter(Boolean);
  assert.deepEqual(models.sort(), ["cult/boss-body.glb", "cult/faceplate.glb", "cult/ornate-helm.glb", "cult/ornate-shoulder.glb", "cult/ornate-shoulder.glb", "human/head.glb"].sort());
  const scripts = Object.values(cult.entities).map((e) => e.components.script as { name: string; params: Record<string, unknown> } | undefined);
  for (const s of scripts.filter((s) => s?.name === "character-look")) assert.equal(s!.params.creation, "cult-profile");
  const shoulders = scripts.filter((s) => s?.name === "character-look" && typeof s.params.mirror === "boolean");
  assert.equal(shoulders.length, 1);
  assert.equal(shoulders[0]!.params.mirror, true);
  assert.equal((cult.entities["cult-visual"]!.components.mesh as { source: { textureFilter: string } }).source.textureFilter, "nearest");
  const legacy = spawn("legacy");
  assert.deepEqual(legacy.appearance, { sex: "male", face: "plain" });
  assert.equal((legacy.entities["legacy-visual"]!.components.mesh as { source: { assetId: string } }).source.assetId, "human/body.glb");
  assert.ok(legacy.entities["legacy-helm"]);
  assert.ok(!legacy.entities["legacy-shoulder-l"]);
  for (const e of Object.values(legacy.entities)) {
    const s = e.components.script as { name: string; params: Record<string, unknown> } | undefined;
    if (s?.name === "character-look") assert.equal(s.params.creation, "default");
  }
  assert.equal(JSON.stringify(kit.pattern), original);
  write("world/authoring/zonegen/human-template.json", { ...config, outfits: { missing: { wear: [], creation: "missing-profile" } } });
  const missing: Finding[] = [];
  assert.equal(loadHumanKit(path.join(root, "world"), missing), null);
  assert.match(missing[0]!.message, /creation missing-profile not found/);
});
