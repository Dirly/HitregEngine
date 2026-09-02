/**
 * Placement toolbox CLI — snap and lint scene documents headlessly, no dev
 * server needed. While `pnpm dev` runs, the file write live-syncs into the
 * browser like any other scene edit.
 *
 *   pnpm -F playground place snap <scene.json> [--ids a,b,c] [--seed 7] [--dry-run]
 *   pnpm -F playground place lint <scene.json> [--gap 0.03] [--overlap 0.15] [--no-fail]
 *
 * snap: settles entities carrying a `placement` component onto the surface
 * they declare (ground/ceiling/wall, sink + seeded jitter). With --ids it
 * snaps exactly those entities whether or not they carry the component.
 * lint: reports floating (detached) props and z-fight risks; pass
 * --overlap <tol> to also report interpenetrating statics (opt-in — graybox
 * construction interpenetrates on purpose). Exit 1 when findings exist, for
 * CI; --no-fail suppresses that.
 *
 * Prefab instances resolve against assets/prefabs plus every
 * projects/<name>/assets/prefabs (same buckets as the running app).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  lintPlacement,
  registerChunkComponents,
  registerCoreAssetTypes,
  registerCoreComponents,
  sceneDocSchema,
  snapPlacementOps,
} from "@hitreg/core";

const args = process.argv.slice(2);
const command = args[0];
const file = args[1];

function flag(name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length && !args[at + 1]!.startsWith("--")) return args[at + 1];
  return undefined;
}
const has = (name: string): boolean => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

if ((command !== "snap" && command !== "lint") || !file) {
  console.error("usage: place snap <scene.json> [--ids a,b,c] [--seed 7] [--dry-run]");
  console.error("       place lint <scene.json> [--gap 0.03] [--overlap 0.15] [--no-fail]");
  process.exit(2);
}
if (file.endsWith(".chunk.json")) {
  console.error("chunk cells aren't supported yet — snap/lint the scene that streams them, or ask for chunk support.");
  process.exit(2);
}

const playgroundRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenePath = resolve(process.cwd(), file);

const registry = new ComponentRegistry();
registerCoreComponents(registry);
registerChunkComponents(registry);
const assets = new AssetLibrary();
registerCoreAssetTypes(assets);

// -- prefab libraries: flat assets/ plus every project (same buckets as the app)
function* jsonFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(full);
    else if (entry.name.endsWith(".json")) yield full;
  }
}
const prefabRoots = [join(playgroundRoot, "assets", "prefabs")];
const projectsDir = join(playgroundRoot, "projects");
if (existsSync(projectsDir)) {
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) prefabRoots.push(join(projectsDir, entry.name, "assets", "prefabs"));
  }
}
for (const root of prefabRoots) {
  for (const full of jsonFiles(root)) {
    const id = relative(root, full).replace(/\\/g, "/").replace(/\.json$/, "");
    try {
      assets.addPrefab(id, JSON.parse(readFileSync(full, "utf8")));
    } catch (error) {
      console.warn(`  ! skipped prefab ${id}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
}

const doc = sceneDocSchema.parse(JSON.parse(readFileSync(scenePath, "utf8")));

if (command === "snap") {
  const ids = flag("ids")?.split(",").map((s) => s.trim()).filter(Boolean);
  const seed = Number(flag("seed") ?? 0);
  const targets = ids ?? Object.keys(doc.entities);
  const { ops, results } = snapPlacementOps(doc, registry, targets, {
    assets,
    seed,
    requirePlacement: ids === undefined, // bare `snap` = everything that opted in; --ids = exactly those
  });
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.action, (counts.get(result.action) ?? 0) + 1);
  for (const result of results) {
    if (result.action === "snapped") {
      const dy = result.to && result.from ? (result.to[1] - result.from[1]).toFixed(3) : "?";
      console.log(`  ${result.id}: snapped onto ${result.support} (dy ${dy})`);
    } else if (result.action === "no-support") {
      console.log(`  ${result.id}: NO SUPPORT within reach — left in place`);
    }
  }
  console.log(
    `${ops.length} moved | ` +
      [...counts.entries()].map(([action, n]) => `${action}: ${n}`).join(", "),
  );
  if (ops.length > 0 && !has("dry-run")) {
    const next = applyOps(doc, ops, registry).doc;
    writeFileSync(scenePath, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`wrote ${relative(process.cwd(), scenePath)}`);
  } else if (has("dry-run")) {
    console.log("(dry run — nothing written)");
  }
} else {
  const findings = lintPlacement(doc, registry, {
    assets,
    gapTol: flag("gap") ? Number(flag("gap")) : undefined,
    overlapTol: flag("overlap") ? Number(flag("overlap")) : undefined,
  });
  for (const f of findings) {
    const at = f.at.map((v) => v.toFixed(2)).join(", ");
    const pair = f.other ? `${f.entity} <> ${f.other}` : f.entity;
    console.log(`  [${f.kind}] ${pair}: ${f.message} @ (${at})`);
  }
  console.log(`${findings.length} finding${findings.length === 1 ? "" : "s"}`);
  if (findings.length > 0 && !has("no-fail")) process.exit(1);
}
