/**
 * repeat-lint — anything we repeat is ONE prefab with shared, tweakable parameters (Derek 2026-10-30: "It's not just
 * lighting, it's anything we repeat... should be a prefab").
 *
 *   npx tsx tools/repeat-lint.mts --project <p> [--project <q> ...] [--scenes-only | --prefabs-only] [--json <file>] [--quiet]
 *   npx tsx tools/repeat-lint.mts --file <scene-or-prefab.json> [...]
 *
 * Every scene (`assets/scenes/*.scene.json`) and prefab (`assets/prefabs/**.json`) of the named projects is linted with
 * @hitreg/core `findRepeats` (packages/core/src/place-solver/repeat-lint.ts): `identical` inline structures (same
 * components, values and child subtree, only the root transform differing), `inline-role` (two or more inline lights /
 * vfx / particles of one role, each with its own values) and `override-role` (instances of one prefab overriding its
 * light / vfx values differently). Generated meshes are never counted. Last line `REPEATS: <n> finding(s) -> ok|FAILED`.
 * Tools lint what they are about to write with `findRepeats(docOfOps(ops))` before writing it.
 */
import fs from "node:fs";
import path from "node:path";
import { findRepeats, type RepeatFinding } from "@hitreg/core";
import { PROJECTS } from "./_closure.mjs";

const argv = process.argv.slice(2);
const opts = (n: string): string[] => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]!] : []));
const flag = (n: string): boolean => argv.includes(`--${n}`);

const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith(".json") ? [path.join(dir, d.name)] : [])) : []);

export interface FileFindings { file: string; findings: RepeatFinding[] }

/** Lint the scenes and prefabs of a project (paths relative to apps/playground in the result). */
export function lintProject(project: string, o: { scenes?: boolean; prefabs?: boolean } = {}): FileFindings[] {
  const root = path.join(PROJECTS, project, "assets"), files: string[] = [];
  if (o.scenes !== false) files.push(...walk(path.join(root, "scenes")).filter((f) => f.endsWith(".scene.json")));
  if (o.prefabs !== false) files.push(...walk(path.join(root, "prefabs")));
  return files.flatMap((f) => lintFile(f));
}

export function lintFile(f: string): FileFindings[] {
  let doc: { entities?: Record<string, unknown> };
  try { doc = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return []; }
  if (!doc || typeof doc !== "object" || !doc.entities || typeof doc.entities !== "object") return [];
  const findings = findRepeats(doc as never, { scope: /[\\/]prefabs[\\/]/.test(f) ? "prefab" : "scene" });
  return findings.length ? [{ file: path.relative(path.resolve(PROJECTS, ".."), f).replace(/\\/g, "/"), findings }] : [];
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1]?.endsWith("repeat-lint.mts")) {
  const projects = opts("project"), files = opts("file");
  if (!projects.length && !files.length) { console.error("repeat-lint: --project <p> or --file <json> is required"); process.exit(2); }
  const res: FileFindings[] = [
    ...projects.flatMap((p) => lintProject(p, { scenes: !flag("prefabs-only"), prefabs: !flag("scenes-only") })),
    ...files.flatMap((f) => lintFile(path.resolve(f))),
  ];
  let n = 0;
  for (const r of res) {
    n += r.findings.length;
    if (flag("quiet")) continue;
    console.log(r.file);
    for (const f of r.findings) console.log(`  ${f.rule.padEnd(13)} ${f.key}  x${f.ids.length}: ${f.ids.slice(0, 6).join(", ")}${f.ids.length > 6 ? ", ..." : ""}\n                -> ${f.fix}`);
  }
  const out = opts("json")[0];
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1) + "\n");
  console.log(`REPEATS: ${n} finding(s) in ${res.length} file(s) -> ${n ? "FAILED" : "ok"}`);
  process.exit(n ? 1 : 0);
}
