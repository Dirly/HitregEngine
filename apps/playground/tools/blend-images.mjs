#!/usr/bin/env node
/**
 * blend-images: a .blend that packs the same image more than once. Importing a glTF into a kept .blend packs another
 * copy of its atlas each time, so a low-poly kit grows to hundreds of MB with nothing to show for it.
 *
 *   node tools/blend-images.mjs <file.blend>...          report; exit 1 if any file packs a duplicate
 *   node tools/blend-images.mjs --project world-kit      every .blend of 5 MB or more under that project's authoring/
 *   node tools/blend-images.mjs <file.blend> --fix       keep one copy of each image, in place
 *
 * --fix replaces the file only if every object still has the same mesh, transform and textures. `props status` fails
 * a .blend over 100 MB and points here. Scripts that import glTFs and save can call dedupe() from blend_images.py.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBlender } from "../../../tools/blender-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLENDER = process.env.HITREG_BLENDER ?? "P:/Program Files/Blender Foundation/Blender 5.2/blender.exe";
const SCRIPT = path.join(HERE, "blend_images.py");
const SCAN_FROM_BYTES = 5e6;

const argv = process.argv.slice(2);
const fix = argv.includes("--fix");
const projectAt = argv.indexOf("--project");
const project = projectAt >= 0 ? argv[projectAt + 1] : null;
const files = argv.filter((a, i) => !a.startsWith("--") && (projectAt < 0 || i !== projectAt + 1));
if (project) {
  const root = path.join(HERE, "..", "projects", project, "authoring");
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isFile() && entry.name.endsWith(".blend") && fs.statSync(file).size >= SCAN_FROM_BYTES) files.push(file);
  }
}
if (!files.length) { console.error("usage: blend-images.mjs <file.blend>... | --project <name> [--fix]"); process.exit(2); }

function blender(file, out) {
  const r = runBlender(BLENDER, ["--background", file, "--factory-startup", "--python-exit-code", "1", "--python", SCRIPT, "--", ...(out ? [out] : [])], { encoding: "utf8", maxBuffer: 1 << 26 }, "blend-images");
  if (r.status !== 0) throw Error(`Blender failed on ${file} (exit ${r.status}):\n${(r.stdout ?? "").slice(-1200)}\n${(r.stderr ?? "").slice(-600)}`);
  return r.stdout ?? "";
}
function report(file) {
  const line = blender(file).split(/\r?\n/).find((l) => l.startsWith("BLEND-IMAGES "));
  if (!line) throw Error(`no report from ${file}`);
  return JSON.parse(line.slice("BLEND-IMAGES ".length));
}
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

let duplicates = 0;
for (const file of files) {
  const before = report(file);
  const extra = before.packed - before.distinct;
  const size = fs.statSync(file).size;
  console.log(`${extra ? "DUPES" : "ok   "} ${mb(size).padStart(10)}  ${before.packed} packed, ${before.distinct} distinct  ${file}`);
  if (!extra) continue;
  if (!fix) { duplicates++; continue; }
  const temp = `${file}.dedupe.blend`;
  try {
    blender(file, temp);
    const after = report(temp);
    if (after.signature !== before.signature || after.objects !== before.objects || after.polygons !== before.polygons || after.packed !== after.distinct) {
      console.log(`  NOT replaced: the deduped copy differs (${JSON.stringify({ before, after })})`);
      duplicates++;
      continue;
    }
    fs.renameSync(temp, file);
    console.log(`  fixed: ${mb(size)} -> ${mb(fs.statSync(file).size)}, ${before.objects} objects identical`);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
if (duplicates) { console.log(`${duplicates} file(s) pack duplicate images${fix ? "" : " (--fix keeps one copy of each)"}`); process.exitCode = 1; }
