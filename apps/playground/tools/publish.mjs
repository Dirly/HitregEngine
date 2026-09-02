// One command: build a deployable, self-contained game bundle.
//   node tools/publish.mjs <project> <entryScene>
//   → dist/<project>/  (index.html + assets/js + content/ + manifest.json)
// Drop the folder on ANY static host (Cloudflare R2, itch, Netlify, …).
import { execSync } from "node:child_process";
import { cpSync } from "node:fs";
const project = process.argv[2];
const entry = process.argv[3];
if (!project || !entry) {
  console.error("usage: node tools/publish.mjs <project> <entryScene.scene.json>");
  process.exit(1);
}
const out = `dist/${project}`;
console.log("1/3 content + manifest…");
execSync(`node tools/export-game.mjs ${project} ${entry} ${out}`, { stdio: "inherit" });
console.log("2/3 building editor-free runtime…");
execSync("npx vite build", { stdio: "inherit", env: { ...process.env, GAME: "1" } });
console.log("3/3 assembling bundle…");
cpSync("dist-game/play.html", `${out}/index.html`);
cpSync("dist-game/assets", `${out}/assets`, { recursive: true });
console.log(`\n✅ ${out}/  — serve on any static host for a playable URL.`);
