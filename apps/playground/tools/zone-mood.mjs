// Zone moods: lint and a one-line installer (owner ruling 2026-10-06: "lighting must FEEL SIMILAR across zones; the
// difference is COLOUR TONE, not brightness/exposure" — Ironspur "just got super dark, details were lost").
//
//   node tools/zone-mood.mjs lint [--world proving]                    every region mood vs the band below
//   node tools/zone-mood.mjs install <proposal.json> [--apply|--revert] dry by default; prints the line it changes
//
// A proposal is { world, region, before: {...mood}, after: {...mood}, why } — the installer refuses unless the
// recipe's current mood equals `before` (apply) or `after` (revert), so it is its own inverse.
// The band is data (MOOD_BAND below is the rule; docs/zone-creation-lessons.md "Lighting floor, matte, interior culling").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORLDS = path.resolve(HERE, "../projects/voxel-demo/assets/worlds");
export const MOOD_BAND = {
  about: "luminance stays near the world default (lightScale 1, fogDensity 1, mist 1, contrast 1); tone (sky/haze/light/shade hue, temperature, saturation) is free. Colour multipliers (light, shade) may tint but not darken: relative luminance >= minLuma.",
  lightScale: [0.9, 1.1],
  fogDensity: [0.8, 1.25],
  mist: [0.5, 1.5],
  contrast: [0.95, 1.06],
  minLuma: { light: 0.66, shade: 0.53 },
  calibration: "2026-10-06 on the neighbours the owner did not flag: zone-1 light 0.678 / shade 0.554, zone-5 0.735 / 0.565 (relative luminance of the multiplier colour)",
};
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luma = (hex) => { const n = parseInt(hex.slice(1), 16); return +(0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255)).toFixed(3); };

export function lintMood(mood) {
  const out = [];
  for (const k of ["lightScale", "fogDensity", "mist", "contrast"]) {
    const v = mood[k] ?? 1, [lo, hi] = MOOD_BAND[k];
    if (v < lo || v > hi) out.push(`${k} ${v} outside [${lo}, ${hi}] (a brightness change, not a tone)`);
  }
  for (const k of ["light", "shade"]) if (mood[k] && luma(mood[k]) < MOOD_BAND.minLuma[k]) out.push(`${k} ${mood[k]} darkens (luminance ${luma(mood[k])} < ${MOOD_BAND.minLuma[k]}): tint the hue, keep it light`);
  return out;
}

const worldFile = (w) => path.join(WORLDS, `${w}.json`);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

if (args[0] === "lint") {
  const w = JSON.parse(fs.readFileSync(worldFile(opt("world", "proving")), "utf8"));
  let bad = 0;
  for (const r of w.regions ?? []) {
    if (!r.mood) continue;
    const f = lintMood(r.mood);
    if (f.length) bad++;
    console.log(`${f.length ? "FAIL" : "ok  "} ${r.id}${f.length ? ": " + f.join("; ") : ""}`);
  }
  process.exitCode = bad ? 1 : 0;
} else if (args[0] === "install") {
  const prop = JSON.parse(fs.readFileSync(path.resolve(args[1]), "utf8"));
  const file = worldFile(prop.world);
  const text = fs.readFileSync(file, "utf8");
  const w = JSON.parse(text);
  const region = (w.regions ?? []).find((r) => r.id === prop.region);
  if (!region) throw new Error(`no region ${prop.region} in ${prop.world}`);
  const revert = args.includes("--revert");
  const [from, to] = revert ? [prop.after, prop.before] : [prop.before, prop.after];
  if (JSON.stringify(region.mood) !== JSON.stringify(from)) throw new Error(`${prop.region}'s mood is not the proposal's ${revert ? "after" : "before"}; refusing (someone changed it)`);
  const lint = lintMood(to);
  console.log(`${prop.region}: ${JSON.stringify(from)}\n  -> ${JSON.stringify(to)}\n  lint: ${lint.length ? lint.join("; ") : "ok"}`);
  if (!args.includes("--apply") && !revert) { console.log("dry run (pass --apply to write; --revert undoes)"); process.exit(0); }
  // one-line edit: replace the serialised mood object in place, keep the rest of the file byte-identical
  const needle = JSON.stringify(from);
  const hits = text.split(needle).length - 1;
  if (hits === 1) fs.writeFileSync(file, text.replace(needle, JSON.stringify(to)));
  else { region.mood = to; fs.writeFileSync(file, JSON.stringify(w, null, 1) + "\n"); }
  console.log(`written ${path.relative(process.cwd(), file)}`);
} else {
  console.log("usage: node tools/zone-mood.mjs lint [--world proving] | install <proposal.json> [--apply|--revert]");
}
