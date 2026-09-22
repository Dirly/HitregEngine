// One command: build a deployable, self-contained game bundle.
//   node tools/publish.mjs <project> <entryScene> [--console|--no-console]
//   → dist/<project>/  (index.html + assets/js + content/ + manifest.json)
// Drop the folder on ANY static host (Cloudflare R2, itch, Netlify, …).
//
// The developer console (/time, /weather, …) is STRIPPED by default: the
// module is never compiled into the bundle, so a published game has no console
// in it rather than a disabled one. project.json's `devConsole` sets this
// game's default ("dev" = strip, "always" = keep, "never" = strip and refuse
// to keep); --console / --no-console override it for one build.
import { execSync } from "node:child_process";
import { cpSync, readFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [project, entry] = args.filter((a) => !a.startsWith("--"));
if (!project || !entry) {
  console.error("usage: node tools/publish.mjs <project> <entryScene.scene.json> [--console|--no-console]");
  process.exit(1);
}

/** project.json's declared default, then the flags. */
const manifestPath = `projects/${project}/project.json`;
const declared = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")).devConsole ?? "dev")
  : "dev";
let withConsole = declared === "always";
if (flags.has("--console")) withConsole = true;
if (flags.has("--no-console")) withConsole = false;
if (withConsole && declared === "never") {
  console.error(`project.json says devConsole: "never" — refusing to ship the console in ${project}`);
  process.exit(1);
}
const out = `dist/${project}`;
console.log("1/3 content + manifest…");
execSync(`node tools/export-game.mjs ${project} ${entry} ${out}`, { stdio: "inherit" });
console.log("2/3 building editor-free runtime…");
execSync("npx vite build", { stdio: "inherit", env: { ...process.env, GAME: "1", HITREG_CONSOLE: withConsole ? "1" : "0" } });
console.log("3/3 assembling bundle…");
cpSync("dist-game/play.html", `${out}/index.html`);
cpSync("dist-game/assets", `${out}/assets`, { recursive: true });
console.log(`\n✅ ${out}/  — serve on any static host for a playable URL.`);
console.log(withConsole ? "   developer console: INCLUDED (--no-console to strip it)" : "   developer console: stripped");
