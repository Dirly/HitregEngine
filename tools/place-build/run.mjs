// hitreg.place-build registered runner: one implementation with the CLI (apps/playground/tools/place-build.mts).
// Install is deliberately not offered here: it writes the live world and is the coordinator's command-line step.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const playground = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/playground");
export async function run(_context, inputs) {
  const args = ["--max-old-space-size=6144", "node_modules/tsx/dist/cli.mjs", "tools/place-build.mts", inputs.command, inputs.world, "--zone", inputs.zone, "--location", inputs.location];
  if (inputs.archetype) args.push("--archetype", inputs.archetype);
  for (const s of String(inputs.sets ?? "").split(/\s+/).filter(Boolean)) args.push("--set", s);
  const r = spawnSync(process.execPath, args, { cwd: playground, encoding: "utf8", maxBuffer: 64 << 20 });
  const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { assets: [], previews: [], warnings: r.status ? [`place-build ${inputs.command} exited ${r.status}`] : [], report: { status: r.status }, log };
}
