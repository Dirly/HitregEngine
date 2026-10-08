// codex-task — hand a bounded TEXT job (dialogue, quests, shop copy…) to the local Codex CLI and install only what
// passes a check. The text twin of image-request.mjs: Codex never runs in a project folder.
//
//   node tools/codex-task.mjs --brief <brief.md> --out "<name>=<install path>,<name>=<install path>" \
//        [--context a.json,b.md] [--check "<command; {stage} = the staging dir>"] [--timeout 1800] [--ledger <file.md>]
//
// 1. makes .hitreg/codex-staging/<stamp>/ and copies each --context file into it under context/
// 2. runs `codex exec --cd <stage> -s workspace-write --skip-git-repo-check -` with the brief on stdin, telling it to
//    write ONLY the named output files into the stage (JSON files must parse)
// 3. runs --check (exit 0 = pass) — e.g. a schema + lint pass over the staged files
// 4. copies each output to its install path; appends Codex's token count to --ledger if given
// Exit: 0 installed, 1 check failed (nothing installed; the stage is kept for a retry), 2 usage, 3 codex failed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const briefFile = opt("brief", "");
const outs = opt("out", "")
  .split(",")
  .filter(Boolean)
  .map((pair) => {
    const [name, dest] = pair.split("=");
    return { name: name.trim(), dest: path.resolve(dest.trim()) };
  });
if (!briefFile || outs.length === 0) {
  console.error('usage: codex-task --brief <brief.md> --out "<name>=<dest>,…" [--context a,b] [--check "<cmd {stage}>"] [--timeout 1800] [--ledger f.md]');
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stage = path.resolve(".hitreg/codex-staging", stamp);
fs.mkdirSync(path.join(stage, "context"), { recursive: true });
const contexts = opt("context", "").split(",").filter(Boolean);
for (const c of contexts) fs.copyFileSync(path.resolve(c), path.join(stage, "context", path.basename(c)));

const prompt = [
  fs.readFileSync(briefFile, "utf8").trim(),
  "",
  "## Output contract",
  `Reference material is in ./context/ (${contexts.map((c) => path.basename(c)).join(", ") || "none"}). Read it; do not modify it.`,
  `Write ONLY these files into the current working directory: ${outs.map((o) => o.name).join(", ")}.`,
  "No notes, no logs, no other files. JSON files must be valid JSON (no comments, no trailing commas).",
  "Reply with only the filenames you wrote.",
].join("\n");
fs.writeFileSync(path.join(stage, "PROMPT.md"), prompt); // kept in the stage (never in a project)

const timeout = Number(opt("timeout", "1800"));
const t0 = Date.now();
const res = spawnSync("codex", ["exec", "--cd", stage, "-s", "workspace-write", "--skip-git-repo-check", "-"], {
  input: prompt,
  encoding: "utf8",
  shell: true,
  timeout: timeout * 1000,
  maxBuffer: 1 << 26,
});
const secs = Math.round((Date.now() - t0) / 1000);
const all = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
fs.writeFileSync(path.join(stage, "codex.log"), all);
const tokenMatch = all.match(/tokens used[:\s]*([\d,]+)/i);
const tokens = tokenMatch ? Number(tokenMatch[1].replace(/,/g, "")) : null;
if (res.error?.code === "ENOENT") {
  console.error("codex CLI not found on PATH");
  process.exit(3);
}
if (res.status !== 0) {
  console.error(`codex exec exited ${res.status} after ${secs}s; stage kept at ${stage}`);
  process.exit(3);
}
const missing = outs.filter((o) => !fs.existsSync(path.join(stage, o.name)));
const bad = outs.filter((o) => o.name.endsWith(".json") && fs.existsSync(path.join(stage, o.name))).filter((o) => {
  try {
    JSON.parse(fs.readFileSync(path.join(stage, o.name), "utf8"));
    return false;
  } catch {
    return true;
  }
});
if (missing.length || bad.length) {
  console.error(`codex did not deliver: ${[...missing.map((o) => `${o.name} missing`), ...bad.map((o) => `${o.name} is not valid JSON`)].join(", ")}; stage kept at ${stage}`);
  process.exit(1);
}
const check = opt("check", "");
if (check) {
  const c = spawnSync(check.replaceAll("{stage}", stage), { encoding: "utf8", shell: true, maxBuffer: 1 << 26 });
  process.stdout.write(c.stdout ?? "");
  process.stderr.write(c.stderr ?? "");
  if (c.status !== 0) {
    console.error(`check failed; nothing installed; stage kept at ${stage}`);
    process.exit(1);
  }
}
for (const o of outs) {
  fs.mkdirSync(path.dirname(o.dest), { recursive: true });
  fs.copyFileSync(path.join(stage, o.name), o.dest);
}
const ledger = opt("ledger", "");
if (ledger) fs.appendFileSync(ledger, `\n- codex-task ${stamp}: ${outs.length} file(s), ${secs}s, ${tokens ?? "?"} Codex tokens (${path.basename(briefFile)})\n`);
console.log(`installed ${outs.length} file(s) in ${secs}s; Codex tokens: ${tokens ?? "unknown"}; stage ${stage}`);
