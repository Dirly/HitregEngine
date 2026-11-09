/**
 * game-shell <scene> --project <world> [--check] [--dry-run] [--uninstall] [--replace-player] [--keep-camera]
 *
 * Installs the GAME SHELL into a world scene: the player body (prefab), the third-person camera rig, the root system
 * entities (HUD, inventory, NPC talk, name tags, telegraphs, fx dispatcher, soundscape, combat audio, ambient
 * particles) and the pooled VFX. What the shell is lives in the game's data, `assets/game-shell.json`, found through
 * the project's dependsOn closure (foundation owns it); this tool is generic. Run from apps/playground.
 *
 *   --check           report what the scene lacks; exit 1 when anything does (no write)
 *   --dry-run         print the batch it would apply (no write)
 *   (no flag)         apply it as ONE applyOps batch under the scene's lock (tools/_scene-write.mts) and save the
 *                     inverse to projects/<world>/authoring/installs/game-shell-<scene>.inverse.json
 *   --uninstall       apply that saved inverse
 *   --replace-player  replace a player that is neither the shell's prefab nor a dev capsule
 *   --keep-camera     leave a camera whose rig differs from the shell's
 *   --keep-spawn      leave the player where it stands (default: moved to the world spawn, tools/_world-spawn.mts:
 *                     the starter town's gate street, facing up it, on the probed ground; the spawn marker follows)
 *
 * Never doubles: a system whose script already runs anywhere in the scene is skipped, pooled ids that exist are
 * skipped, and the environment (sky, day-night, weather, zone-mood) is not the shell's (worldgen-scene-env.mts).
 * Creatures (spawnArea, mob-combat-bridge) are `zonegen populate`; town NPCs are `town-npcs`.
 * `worldgen init --scene` / `worldgen scene` build new world scenes with the shell; `worldgen status` has a
 * `game-shell` row.
 */
import fs from "node:fs";
import path from "node:path";
import { applyOps, ComponentRegistry, createWorldField, registerChunkComponents, registerCoreComponents, worldRecipeSchema, type Op, type SceneDoc } from "@hitreg/core";
import { findAsset, loadShell, planShell, projectsRoot } from "./_game-shell.mjs";
import { removalsOf, updateJsonFile } from "./_scene-write.mts";
import { shellSpawn } from "./worldgen-scene-env.mts";

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const scene = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
const project = opt("project");
const fail = (why: string): never => {
  console.error(`game-shell: ${why}`);
  process.exit(2);
};
if (!scene || !project) fail("usage: game-shell <scene> --project <world> [--check|--dry-run|--uninstall] [--replace-player] [--keep-camera]");

const projectDir = path.join(projectsRoot(), project!);
const sceneFile = path.join(projectDir, "assets", "scenes", `${scene}.scene.json`);
if (!fs.existsSync(sceneFile)) fail(`no scene ${path.relative(process.cwd(), sceneFile)}`);
const inverseFile = path.join(projectDir, "authoring", "installs", `game-shell-${scene}.inverse.json`);
const registry = new ComponentRegistry();
registerCoreComponents(registry);
registerChunkComponents(registry);
const rel = (f: string) => path.relative(process.cwd(), f).replaceAll("\\", "/");

if (flag("uninstall")) {
  if (!fs.existsSync(inverseFile)) fail(`nothing to uninstall: no ${rel(inverseFile)}`);
  const inverse = JSON.parse(fs.readFileSync(inverseFile, "utf8")) as Op[];
  updateJsonFile<SceneDoc>(sceneFile, (fresh) => {
    if (!fresh) throw new Error("scene vanished");
    return { doc: applyOps(fresh, inverse, registry).doc, removed: removalsOf(inverse, fresh) };
  }, { label: `game-shell uninstall ${scene}` });
  fs.rmSync(inverseFile);
  console.log(`game-shell: uninstalled from ${rel(sceneFile)} (${inverse.length} inverse ops)`);
  process.exit(0);
}

const loaded = loadShell(project!);
if (!loaded) fail(`no assets/game-shell.json in ${project}'s closure (does project.json dependsOn foundation?)`);
const prefabFile = findAsset(project!, `prefabs/${loaded!.shell.player.prefab}.json`);
if (!prefabFile) fail(`the shell's player prefab ${loaded!.shell.player.prefab} is not in ${project}'s closure`);
const prefabDoc = JSON.parse(fs.readFileSync(prefabFile!, "utf8"));
// the world spawn from the world's data (the starter town's gate street, tools/_world-spawn.mts), on the probed ground
const spawn = (() => {
  if (flag("keep-spawn")) return null;
  const scene0 = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
  const world = Object.values(scene0.entities).map((e) => (e.components["voxelWorld"] as { world?: string } | undefined)?.world).find(Boolean);
  const recipeFile = world ? findAsset(project!, `worlds/${world}.json`) : null;
  if (!recipeFile) return null;
  const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(recipeFile, "utf8")));
  return shellSpawn(recipe, path.resolve(recipeFile, "..", "..", ".."), createWorldField(recipe));
})();
const planOpts = { prefabDoc, replacePlayer: flag("replace-player"), keepCamera: flag("keep-camera"), spawn };

const report = (plan: ReturnType<typeof planShell>) => {
  console.log(`game-shell ${scene} (${project}; shell from ${rel(loaded!.file)})${spawn ? `; spawn ${spawn.position.join(", ")}: ${spawn.from}` : ""}`);
  for (const a of plan.added) console.log(`  + ${a}`);
  for (const s of plan.skipped) console.log(`  = ${s}`);
  for (const f of plan.findings) console.log(`  ! ${f}`);
};

if (flag("check") || flag("dry-run")) {
  const doc = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
  const plan = planShell(loaded!, doc, planOpts);
  applyOps(doc, plan.ops as Op[], registry); // validates the batch against the scene as it is now
  report(plan);
  if (flag("dry-run")) console.log(`  ${plan.ops.length} ops (dry run: nothing written)`);
  const missing = plan.added.length + plan.findings.length;
  console.log(missing ? `  ${plan.added.length} missing, ${plan.findings.length} finding(s)` : "  shell complete");
  process.exit(flag("check") && missing ? 1 : 0);
}

if (fs.existsSync(inverseFile)) fail(`${rel(inverseFile)} exists: the shell was installed already (--check to see what is missing, --uninstall first to redo)`);
let applied: { ops: Op[]; inverse: Op[]; plan: ReturnType<typeof planShell> } | null = null;
updateJsonFile<SceneDoc>(sceneFile, (fresh) => {
  if (!fresh) throw new Error("scene vanished");
  const plan = planShell(loaded!, fresh, planOpts);
  const ops = plan.ops as Op[];
  const result = applyOps(fresh, ops, registry);
  applied = { ops, inverse: result.inverse, plan };
  return { doc: result.doc, removed: removalsOf(ops, fresh) };
}, { label: `game-shell ${scene}` });
const done = applied as unknown as { ops: Op[]; inverse: Op[]; plan: ReturnType<typeof planShell> };
report(done.plan);
if (done.ops.length) {
  fs.mkdirSync(path.dirname(inverseFile), { recursive: true });
  fs.writeFileSync(inverseFile, JSON.stringify(done.inverse, null, 2) + "\n");
  console.log(`  applied ${done.ops.length} ops to ${rel(sceneFile)}; inverse ${rel(inverseFile)}`);
} else console.log("  nothing to do: shell complete");
