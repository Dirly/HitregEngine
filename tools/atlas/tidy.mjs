#!/usr/bin/env node
/**
 * What is in tools/atlas, what it weighs, and what of it is disposable.
 *
 *   node tools/atlas/tidy.mjs                 report only, touches nothing
 *   node tools/atlas/tidy.mjs --slices        delete every slices/ folder
 *   node tools/atlas/tidy.mjs --art           delete art sheets already registered
 *   node tools/atlas/tidy.mjs --slices --art  both
 *
 * The layout this walks:
 *
 *   sets/<set>/     key.png, manifest.json, prompt.md, key-check.png
 *                   The set. Small, committed, and the only thing here you
 *                   cannot regenerate — never deleted by this script.
 *   art/<set>/<theme>.png
 *                   The 1254 sheet a generator handed back. ~1.7 MB each, and
 *                   DISPOSABLE once its atlas exists: the atlas is what ships,
 *                   and a sheet is only ever painted against one key, so a key
 *                   that changes needs new art rather than this art again.
 *                   Keep it while you are still re-registering with different
 *                   manifest settings; drop it when the theme is settled.
 *   out/<set>/<theme>/
 *                   atlas.png (ships), atlas-preview.png and report.json (small,
 *                   worth keeping — the report is the record of how the artwork
 *                   registered), slices/ (per-island cut-ups, written only with
 *                   --slices, for looking at once and never read again).
 *
 * Flat, this folder reached 40 MB and 38 output directories across three
 * different keys with nothing but a filename prefix to say which was which.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const DO_SLICES = args.has("--slices");
const DO_ART = args.has("--art");

const size = (p) => {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, e) => n + size(path.join(p, e)), 0);
};
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const dirs = (p) =>
  fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

const sets = [...new Set([...dirs(path.join(here, "sets")), ...dirs(path.join(here, "out")), ...dirs(path.join(here, "art"))])].sort();
let freed = 0;

for (const set of sets) {
  const artDir = path.join(here, "art", set);
  const outDir = path.join(here, "out", set);
  const themes = dirs(outDir).sort();
  console.log(
    `\n${set}  —  ${themes.length} theme(s), set ${mb(size(path.join(here, "sets", set)))}, ` +
      `art ${mb(size(artDir))}, out ${mb(size(outDir))}`,
  );
  for (const theme of themes) {
    const slices = path.join(outDir, theme, "slices");
    const art = path.join(artDir, `${theme}.png`);
    const hasAtlas = fs.existsSync(path.join(outDir, theme, "atlas.png"));
    const bits = [];
    if (fs.existsSync(slices)) {
      const n = size(slices);
      if (DO_SLICES) { fs.rmSync(slices, { recursive: true, force: true }); freed += n; bits.push(`slices deleted (${mb(n)})`); }
      else bits.push(`slices ${mb(n)} — disposable`);
    }
    if (fs.existsSync(art)) {
      const n = size(art);
      // Only ever delete art whose atlas actually exists. Art without an atlas
      // is a sheet that has not been registered yet, which is the one case
      // where it is the only copy of anything.
      if (DO_ART && hasAtlas) { fs.rmSync(art); freed += n; bits.push(`art deleted (${mb(n)})`); }
      else if (hasAtlas) bits.push(`art ${mb(n)} — disposable`);
      else bits.push(`art ${mb(n)} — NOT registered, keeping`);
    }
    if (!hasAtlas) bits.push("no atlas.png");
    console.log(`   ${theme.padEnd(22)} ${bits.join(", ") || "clean"}`);
  }
}

console.log(
  freed
    ? `\nfreed ${mb(freed)}. tools/atlas is now ${mb(size(here))}.`
    : `\ntools/atlas is ${mb(size(here))}. Nothing deleted — pass --slices and/or --art to act.`,
);
