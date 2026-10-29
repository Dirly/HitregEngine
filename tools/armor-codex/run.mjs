// hitreg.armor registered runner: one implementation with the CLI (apps/playground/tools/armor.mts).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const playground = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/playground");
export async function run(_context, inputs) {
  const set = String(inputs.set ?? "").trim();
  const project = String(inputs.project || "foundation");
  const cmd = {
    status: ["status", ...(set ? [set] : [])],
    lint: ["brief", "lint", set],
    "dry-run": ["gen", set, "--dry-run"],
    run: ["run", set],
  }[inputs.command] ?? ["status"];
  const args = ["node_modules/tsx/dist/cli.mjs", "tools/armor.mts", ...cmd, "--project", project];
  const r = spawnSync(process.execPath, args, { cwd: playground, encoding: "utf8", maxBuffer: 64 << 20 });
  const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { assets: [], previews: [], warnings: r.status ? [`armor ${cmd.join(" ")} exited ${r.status}`] : [], report: { status: r.status }, log };
}
