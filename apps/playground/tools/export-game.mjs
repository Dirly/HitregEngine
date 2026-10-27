// Export a project into a self-contained, playable static bundle:
//   <out>/manifest.json  <out>/assets-index.json  <out>/content/<kind>/...
// (The runtime play.js + index.html come from `vite build` separately; this
//  tool produces the CONTENT half of the bundle.)
import { readdirSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

// `worlds` carries the procedural-world RECIPES (assets/worlds/<id>.json). A
// scene's `voxelWorld` component resolves its recipe BY ID at scene-resolve
// time, so a bundle without them boots a scene whose terrain simply never
// exists — sky, water and hand-placed props render over an empty world, with
// only a console warning to say why.
//
// KEEP IN STEP WITH src/asset-loader.ts: every folder it reads must ship. The
// data kinds were missing for a while — a published build then had no
// `creation` asset, so every NPC (and the player) lost its head, hair and helm,
// and townsfolk had no dialogue, places, shops or quests.
const KINDS = [
  "scenes", "materials", "prefabs", "models", "textures", "audio", "terrain", "spritesheets", "worlds", "volumes",
  // data assets (asset-loader.ts jsonKinds)
  "vfx", "spells", "items", "progression", "creation", "quests", "dialogues", "shops", "places", "perform-actions",
  // the PLAYER map's terrain picture (src/world-map.ts): maps/<world>.base.png ONLY
  "maps",
  // loading art (a scene's `loadingScreen`, docs/hosting.md → "Loading art"): the painted cover only
  "loading", "chunks",
];
// Per-kind file filters. maps/ also holds <world>.png (markers baked in, every layer) and
// <world>.layers.json (quest places, reservations, packs) — authoring/review data a player
// must never receive. Only the plain terrain picture ships.
const SHIP = {
  maps: (rel) => /^[^/]+\.base\.png$/.test(rel),
  // loading/<scene>.snapshot.png is the raw capture kept for review, never shipped
  loading: (rel) => /^[^/]+\.(png|jpe?g|webp)$/i.test(rel) && !/\.snapshot\.png$/i.test(rel),
};

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

// These are boot metadata, not models/textures or streamed scene/chunk documents.
const PACK_KINDS = new Set(KINDS.filter((kind) => !["scenes", "models", "textures", "audio", "maps", "loading", "chunks"].includes(kind)));

export function exportGame({ project, entry, out, projects = resolve("projects") }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new Error("Invalid project name");
  const scope = [];
  const visit = (name) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid dependency: ${name}`);
    if (scope.includes(name)) return;
    const root = join(projects, name);
    if (!existsSync(join(root, "assets"))) throw new Error(`Missing project assets: ${root}`);
    scope.push(name);
    const manifest = join(root, "project.json");
    const deps = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).dependsOn ?? [] : [];
    for (const dep of deps) visit(dep);
  };
  visit(project);
  const sources = new Map();
  const index = {};
  for (const kind of KINDS) {
    const found = new Map();
    for (const name of scope) {
      const dir = join(projects, name, "assets", kind);
      if (!existsSync(dir)) continue;
      for (const rel of walk(dir).sort()) {
        if (SHIP[kind] && !SHIP[kind](rel)) continue;
        if (!found.has(rel)) found.set(rel, join(dir, rel)); // same owner-first resolution as the live client
      }
    }
    index[kind] = [...found.keys()];
    for (const [rel, file] of found) sources.set(`${kind}/${rel}`, file);
  }
  if (!index.scenes.includes(entry)) throw new Error(`Entry scene not found in ${project}'s closure: ${entry}`);
  const target = resolve(out);
  // Validate the final absolute target before clearing output. Never erase source projects or the checkout.
  const contains = (parent, child) => { const rel = relative(parent, child); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };
  if (contains(target, resolve(".")) || contains(target, projects) || contains(projects, target)) throw new Error(`Unsafe export destination: ${target}`);
  if (existsSync(target) && readdirSync(target).length &&
      !(existsSync(join(target, "manifest.json")) && existsSync(join(target, "assets-index.json")))) {
    throw new Error(`Refusing to clear a non-bundle directory: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, "content"), { recursive: true });
  const packed = [];
  for (const [rel, file] of sources) {
    const dst = join(target, "content", rel);
    mkdirSync(join(dst, ".."), { recursive: true });
    copyFileSync(file, dst);
    if (PACK_KINDS.has(rel.split("/")[0]) && rel.endsWith(".json")) {
      try { packed.push([rel, { data: JSON.parse(readFileSync(file, "utf8")) }]); }
      catch (error) { packed.push([rel, { error: String(error) }]); }
    }
  }
  // Static hosts have no asset-batch endpoint. Ship bounded packs instead of thousands of tiny requests.
  index["json-packs"] = [];
  mkdirSync(join(target, "asset-json"), { recursive: true });
  for (let i = 0; i < packed.length; i += 64) {
    const file = `asset-json/${i / 64}.json`;
    writeFileSync(join(target, file), JSON.stringify(Object.fromEntries(packed.slice(i, i + 64))));
    index["json-packs"].push(file);
  }
  writeFileSync(join(target, "assets-index.json"), JSON.stringify(index, null, 2));
  const manifest = {
    manifestVersion: 1,
    game: { id: project, name: project.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), version: "0.1.0" },
    runtime: { engine: "hitreg", version: "0.1.0" },
    entry: { scene: entry },
    multiplayer: { enabled: false },
    build: { at: new Date().toISOString() },
  };
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { files: sources.size, scenes: index.scenes.length, scope, packs: index["json-packs"].length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [project, entry, out = "public/game"] = process.argv.slice(2);
  if (!project || !entry) throw new Error("usage: node tools/export-game.mjs <project> <entryScene.scene.json> [outDir]");
  const result = exportGame({ project, entry, out });
  console.log(`exported ${project} → ${out} (${result.files} asset files, ${result.packs} JSON packs; projects: ${result.scope.join(", ")})`);
}
