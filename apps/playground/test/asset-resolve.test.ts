import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  duplicateAssets,
  fallbackProjectOrder,
  projectClosure,
  resolveAssetFile,
  sceneOwnerProject,
} from "../tools/_asset-resolve.mts";

const MODEL = "models/places/door/relief.glb";

/**
 * Projects sorted so the lab comes FIRST in directory order (aa-kings-lab),
 * the way pr1-kings-lab sorted before skelmorrow and shadowed its model.
 * world: dependsOn [kit]; aa-kings-lab: dependsOn [kit, world] with a stale
 * copy of the world's model; other-world: an unrelated real project with the
 * same path.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-resolve-"));
  const assetsRoot = path.join(root, "assets");
  const projectsRoot = path.join(root, "projects");
  fs.mkdirSync(assetsRoot, { recursive: true });
  const project = (name: string, manifest: Record<string, unknown>, files: Record<string, string>) => {
    const dir = path.join(projectsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, name, ...manifest }));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, "assets", rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, "assets", rel), body);
    }
  };
  project("aa-kings-lab", { title: "Kings lab (scratch)", dependsOn: ["kit", "world"] }, {
    [MODEL]: "stale",
    "scenes/kings.scene.json": "{}",
  });
  project("kit", {}, { "prefabs/kit/lamp.json": "kit-lamp" });
  project("other-world", { dependsOn: ["kit"] }, { [MODEL]: "other", "scenes/other.scene.json": "{}" });
  project("world", { dependsOn: ["kit"] }, { [MODEL]: "real", "scenes/world.scene.json": "{}" });
  return { root: { assetsRoot, projectsRoot }, projectsRoot };
}

const read = (file: string) => fs.readFileSync(file, "utf8");

test("a scene's request resolves inside its own project closure, never a lab's stale copy", () => {
  const { root, projectsRoot } = fixture();
  const owner = sceneOwnerProject(projectsRoot, "world");
  assert.equal(owner, "world");
  const scope = projectClosure(projectsRoot, owner!);
  assert.deepEqual(scope, ["world", "kit"]);
  assert.equal(read(resolveAssetFile(root, MODEL, scope)), "real");
  // a dependency's asset still resolves through the closure
  assert.equal(read(resolveAssetFile(root, "prefabs/kit/lamp.json", scope)), "kit-lamp");
});

test("the lab's own scene still sees the lab's file (its closure starts with itself)", () => {
  const { root, projectsRoot } = fixture();
  assert.equal(read(resolveAssetFile(root, MODEL, projectClosure(projectsRoot, "aa-kings-lab"))), "stale");
});

test("an unrelated project's scene never gets another real project's same-path file first", () => {
  const { root, projectsRoot } = fixture();
  assert.equal(read(resolveAssetFile(root, MODEL, projectClosure(projectsRoot, "other-world"))), "other");
});

test("unscoped fallback: shared before leaf, scratch projects last", () => {
  const { root, projectsRoot } = fixture();
  const order = fallbackProjectOrder(projectsRoot);
  assert.equal(order.at(-1), "aa-kings-lab");
  assert.ok(order.indexOf("world") < order.indexOf("aa-kings-lab"));
  assert.equal(order[0], "kit");
  // directory order put the lab first; the fallback no longer does
  assert.notEqual(read(resolveAssetFile(root, MODEL, null)), "stale");
});

test("a new file still goes beside its siblings (one owning folder), else the flat tree", () => {
  const { root, projectsRoot } = fixture();
  const scope = projectClosure(projectsRoot, "world");
  assert.equal(
    resolveAssetFile(root, "prefabs/kit/new.json", scope),
    path.resolve(projectsRoot, "kit", "assets", "prefabs/kit/new.json"),
  );
  // three projects own scenes/: no single owner, so the flat tree
  assert.equal(resolveAssetFile(root, "scenes/new.scene.json", scope), path.resolve(root.assetsRoot, "scenes/new.scene.json"));
});

test("duplicateAssets lists same-path files with the fallback winner", () => {
  const { projectsRoot } = fixture();
  const dupes = duplicateAssets(projectsRoot);
  assert.deepEqual(dupes.map((d) => d.file), [MODEL]);
  assert.notEqual(dupes[0]!.fallbackWinner, "aa-kings-lab");
});

test("an unknown or malformed project gives no scope", () => {
  const { projectsRoot } = fixture();
  assert.equal(projectClosure(projectsRoot, "nope"), null);
  assert.equal(projectClosure(projectsRoot, "../world"), null);
});
