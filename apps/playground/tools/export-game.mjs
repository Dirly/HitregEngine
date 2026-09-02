// Export a project into a self-contained, playable static bundle:
//   <out>/manifest.json  <out>/assets-index.json  <out>/assets/<kind>/...
// (The runtime play.js + index.html come from `vite build` separately; this
//  tool produces the CONTENT half of the bundle.)
import { readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const project = process.argv[2];
const entry = process.argv[3];
const out = process.argv[4] ?? "public/game";
if (!project || !entry) {
  console.error("usage: node tools/export-game.mjs <project> <entryScene.scene.json> [outDir]");
  process.exit(1);
}

const SRC = join("projects", project, "assets");
if (!existsSync(SRC)) { console.error("no assets at " + SRC); process.exit(1); }
// `worlds` carries the procedural-world RECIPES (assets/worlds/<id>.json). A
// scene's `voxelWorld` component resolves its recipe BY ID at scene-resolve
// time, so a bundle without them boots a scene whose terrain simply never
// exists — sky, water and hand-placed props render over an empty world, with
// only a console warning to say why.
const KINDS = ["scenes", "materials", "prefabs", "models", "textures", "audio", "terrain", "spritesheets", "worlds"];

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "content"), { recursive: true });

const index = {};
let files = 0;
for (const kind of KINDS) {
  const kdir = join(SRC, kind);
  if (!existsSync(kdir)) { index[kind] = []; continue; }
  const list = walk(kdir);
  index[kind] = list;
  for (const rel of list) {
    const dst = join(out, "content", kind, rel);
    mkdirSync(join(dst, ".."), { recursive: true });
    copyFileSync(join(kdir, rel), dst);
    files++;
  }
}
writeFileSync(join(out, "assets-index.json"), JSON.stringify(index, null, 2));

const manifest = {
  manifestVersion: 1,
  game: { id: project, name: project.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), version: "0.1.0" },
  runtime: { engine: "hitreg", version: "0.1.0" },
  entry: { scene: entry },
  multiplayer: { enabled: false },
  build: { at: new Date().toISOString() },
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`exported ${project} → ${out}  (${files} asset files, ${index.scenes.length} scenes)`);
