/**
 * zonegen — the zone pipeline: plan a whole zone as linted data, freeze it, then build it with bounded agents.
 *
 *   npx tsx tools/zonegen.mts status <world> --project <p> [--zone <id>] [--next]     what is done, stale, missing, next
 *   npx tsx tools/zonegen.mts <command> <world> --project <p> [--zone <id>] [...]
 *
 * `status` is the plan. Every other command is one stage's gate or generator; each lives in
 * tools/zonegen/commands/<command>.mts and exports `run(ctx)`. Formats: tools/zonegen/schemas.mts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makePaths, type Ctx } from "./zonegen/lib.mts";

const argv = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.join(here, "zonegen", "commands");
const list = (): string[] =>
  fs.existsSync(commandsDir)
    ? fs.readdirSync(commandsDir).filter((f) => f.endsWith(".mts") && !f.startsWith("_")).map((f) => f.slice(0, -4)).sort()
    : [];
const command = argv[0] ?? "";
const world = argv[1] && !argv[1].startsWith("--") ? argv[1] : "";
const rest = argv.slice(world ? 2 : 1);
const opt = (name: string, fallback = ""): string => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--") ? rest[i + 1]! : fallback;
};
const flag = (name: string): boolean => rest.includes(`--${name}`);
const file = path.join(commandsDir, `${command}.mts`);
if (!command || command.startsWith("_") || !fs.existsSync(file)) {
  console.error(`usage: zonegen <command> <world> --project <p> [--zone <id>]\ncommands: ${list().join(", ")}`);
  process.exit(2);
}
const project = opt("project");
if (!project || !world) {
  console.error("zonegen: give the world and --project <name>");
  process.exit(2);
}
const ctx: Ctx = { argv: rest, project, world, zone: opt("zone"), opt, flag, paths: makePaths(project, world) };
const mod = (await import(pathToFileURL(file).href)) as { run(ctx: Ctx): Promise<number> | number };
process.exit(await mod.run(ctx));
