// One command: build a deployable, self-contained game bundle.
//   node tools/publish.mjs <project> <entryScene> [--console|--no-console]
//                          [--gateway <url> | --server <ws-url>] [--out <dir>]
//   → dist/<project>/  (index.html + assets/js + content/ + manifest.json)
// Drop the folder on ANY static host (Cloudflare R2, itch, Netlify, …).
//
// The developer console (/time, /weather, …) is STRIPPED by default: the
// module is never compiled into the bundle, so a published game has no console
// in it rather than a disabled one. project.json's `devConsole` sets this
// game's default ("dev" = strip, "always" = keep, "never" = strip and refuse
// to keep); --console / --no-console override it for one build.
//
// Multiplayer: project.json's `multiplayer` is stamped into the manifest. A
// "server" project's bundle joins a dedicated server — where it finds one, in
// order: ?gateway= / ?server= on the page, then --gateway / --server given
// here (manifest.multiplayer.gateway / .server), then the page's own origin as
// the gateway (deploy/ serves the client and the gateway on one hostname).
// The entry scene should be the scene main hosts (`--scene`); a grant for
// another scene reloads the page on it. Details: docs/hosting.md → "The
// published client".
import { execSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const VALUED = new Set(["--gateway", "--server", "--out"]);
const flags = new Set();
const values = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUED.has(a)) values[a.slice(2)] = args[++i];
  else if (a.startsWith("--")) flags.add(a);
  else positional.push(a);
}
const [project, entry] = positional;
if (!project || !entry) {
  console.error("usage: node tools/publish.mjs <project> <entryScene.scene.json> [--console|--no-console] [--gateway <url> | --server <ws-url>] [--out <dir>]");
  process.exit(1);
}
if (values.gateway && !/^https?:\/\//.test(values.gateway)) {
  console.error(`--gateway must be an http(s) url (main's gateway), got "${values.gateway}"`);
  process.exit(1);
}
if (values.server && !/^wss?:\/\//.test(values.server)) {
  console.error(`--server must be a ws(s) url, got "${values.server}"`);
  process.exit(1);
}

/** project.json's declared defaults, then the flags. */
const manifestPath = `projects/${project}/project.json`;
const projectJson = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const declared = projectJson.devConsole ?? "dev";
let withConsole = declared === "always";
if (flags.has("--console")) withConsole = true;
if (flags.has("--no-console")) withConsole = false;
if (withConsole && declared === "never") {
  console.error(`project.json says devConsole: "never" — refusing to ship the console in ${project}`);
  process.exit(1);
}
const mode = projectJson.multiplayer === "server" ? "server" : projectJson.multiplayer === "p2p" ? "p2p" : undefined;
if ((values.gateway || values.server) && mode !== "server") {
  console.error(`--gateway/--server only apply to a project with multiplayer: "server" (${project} is "${projectJson.multiplayer ?? "p2p"}")`);
  process.exit(1);
}
const out = values.out ?? `dist/${project}`;
console.log("1/3 content + manifest…");
execSync(`node tools/export-game.mjs ${project} ${entry} ${out}`, { stdio: "inherit" });
{
  // the multiplayer half of the manifest: what export-game cannot know
  const file = `${out}/manifest.json`;
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (typeof projectJson.title === "string" && projectJson.title) manifest.game.name = projectJson.title;
  manifest.multiplayer = {
    // a published P2P game has no signaling relay yet, so it plays alone (as before)
    enabled: mode === "server",
    ...(mode ? { mode } : {}),
    ...(values.gateway ? { gateway: values.gateway.replace(/\/+$/, "") } : {}),
    ...(values.server ? { server: values.server } : {}),
  };
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}
console.log("2/3 building editor-free runtime…");
execSync("npx vite build", { stdio: "inherit", env: { ...process.env, GAME: "1", HITREG_CONSOLE: withConsole ? "1" : "0" } });
console.log("3/3 assembling bundle…");
cpSync("dist-game/play.html", `${out}/index.html`);
cpSync("dist-game/assets", `${out}/assets`, { recursive: true });
console.log(`\n✅ ${out}/  — serve on any static host for a playable URL.`);
console.log(withConsole ? "   developer console: INCLUDED (--no-console to strip it)" : "   developer console: stripped");
if (mode === "server") {
  const where = values.gateway ? `gateway ${values.gateway}` : values.server ? `open server ${values.server}` : "gateway = the page's own origin (or ?gateway= on the page)";
  console.log(`   multiplayer: dedicated server — ${where}`);
}
