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
// worlds live in their own project since the 2026-10-08 restructure (proving ships the sample world)
const WORLDS = path.resolve(HERE, "../projects/proving/assets/worlds");
export const MOOD_BAND = {
  about: "a mood changes TONE, never brightness. The EFFECTIVE sun (mood light x the scene's authored sun colour x lightScale) and fill (mood shade x the authored ambient colour) must keep their luminance within +-8% of the world default, judged per channel against the real light colour (a cold tint on an amber sun cuts its dominant red, so the multiplier's own luminance says too little). Fog, mist, contrast and saturation are held near 1 so no zone washes out or crushes.",
  lightScale: [0.9, 1.3], // only to carry a tinted light back to the house luminance: the effective product is the gate
  fogDensity: [0.9, 1.1],
  mist: [0.75, 1.25],
  contrast: [0.97, 1.03],
  saturation: [0.95, 1.1],
  effective: [0.92, 1.08],
  calibration: "2026-10-09 lighting pass: proving's 14 moods cut the effective sun 22-40% and the fill ~45% while passing the old multiplier-only check (minLuma light 0.66 / shade 0.53); fog 1.25 + mist 1.5 + saturation 0.68 read as washed out. House grade saturation is 0.9, so the floor here keeps the effective saturation >= ~0.85.",
};
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [lin(n >> 16 & 255), lin(n >> 8 & 255), lin(n & 255)]; };
const Y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
export const luma = (hex) => +Y(rgb(hex)).toFixed(3);
/** Luminance of `tint` (a mood multiplier) applied to `base` (the light it multiplies), relative to `base` alone. */
export const effective = (tint, base = "#ffffff") => { const b = rgb(base), t = rgb(tint); return +(Y(b.map((x, i) => x * t[i])) / Y(b)).toFixed(3); };

/** `lights` = the world scene's authored { sun, ambient } colours (white when unknown). */
export function lintMood(mood, lights = { sun: "#ffffff", ambient: "#ffffff" }) {
  const out = [];
  for (const k of ["lightScale", "fogDensity", "mist", "contrast", "saturation"]) {
    const v = mood[k] ?? 1, [lo, hi] = MOOD_BAND[k];
    if (v < lo || v > hi) out.push(`${k} ${v} outside [${lo}, ${hi}] (${k === "saturation" ? "washes the zone out" : k === "lightScale" ? "more than a tint needs to keep its luminance" : "a brightness change, not a tone"})`);
  }
  const [lo, hi] = MOOD_BAND.effective;
  const sun = effective(mood.light ?? "#ffffff", lights.sun) * (mood.lightScale ?? 1);
  if (sun < lo || sun > hi) out.push(`effective sun ${sun.toFixed(2)}x outside [${lo}, ${hi}] (light ${mood.light ?? "-"} x sun ${lights.sun} x lightScale ${mood.lightScale ?? 1}): tint the hue at the same luminance`);
  const fill = effective(mood.shade ?? "#ffffff", lights.ambient);
  if (fill < lo || fill > hi) out.push(`effective fill ${fill.toFixed(2)}x outside [${lo}, ${hi}] (shade ${mood.shade ?? "-"} x ambient ${lights.ambient}): tint the hue at the same luminance`);
  return out;
}

/** The authored sun and ambient colours of the scene that streams this world (projects/<p>/assets/scenes). */
export function worldLights(world) {
  const projects = path.resolve(HERE, "../projects");
  for (const p of fs.readdirSync(projects)) {
    const dir = path.join(projects, p, "assets", "scenes");
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((n) => n.endsWith(".scene.json")).sort((a, b) => (b === `${world}.scene.json`) - (a === `${world}.scene.json`));
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      if (!text.includes(`"world": "${world}"`) && !text.includes(`"world":"${world}"`)) continue;
      const ents = Object.values(JSON.parse(text).entities ?? {});
      if (!ents.some((e) => e.components?.voxelWorld?.world === world)) continue;
      const sun = ents.find((e) => e.components?.light?.kind === "directional")?.components.light.color ?? "#ffffff";
      const ambient = ents.find((e) => e.components?.light?.kind === "ambient")?.components.light.color ?? "#ffffff";
      return { sun, ambient, scene: f };
    }
  }
  return { sun: "#ffffff", ambient: "#ffffff", scene: null };
}

/** proving's worlds first, then any other project's `assets/worlds` (each world is its own project now). */
const worldFile = (w) => {
  const own = path.join(WORLDS, `${w}.json`);
  if (fs.existsSync(own)) return own;
  const projects = path.resolve(HERE, "../projects");
  for (const p of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const file = path.join(projects, p, "assets", "worlds", `${w}.json`);
    if (fs.existsSync(file)) return file;
  }
  return own;
};
const args = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ? process.argv.slice(2) : ["(imported)"];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

if (args[0] === "lint") {
  const world = opt("world", "proving");
  const w = JSON.parse(fs.readFileSync(worldFile(world), "utf8"));
  const lights = worldLights(world);
  console.log(`judged against ${lights.scene ?? "no scene (white lights)"}: sun ${lights.sun}, ambient ${lights.ambient}`);
  let bad = 0;
  for (const r of w.regions ?? []) {
    if (!r.mood) continue;
    const f = lintMood(r.mood, lights);
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
  const lint = lintMood(to, worldLights(prop.world));
  console.log(`${prop.region}: ${JSON.stringify(from)}\n  -> ${JSON.stringify(to)}\n  lint: ${lint.length ? lint.join("; ") : "ok"}`);
  if (!args.includes("--apply") && !revert) { console.log("dry run (pass --apply to write; --revert undoes)"); process.exit(0); }
  // one-line edit: replace the serialised mood object in place, keep the rest of the file byte-identical
  const needle = JSON.stringify(from);
  const hits = text.split(needle).length - 1;
  if (hits === 1) fs.writeFileSync(file, text.replace(needle, JSON.stringify(to)));
  else {
    // a pretty-printed recipe never contains the compact needle: rewrite it in its OWN indent, or every line changes
    region.mood = to;
    const indent = text.match(/^\{\r?\n( +)"/)?.[1].length ?? 1;
    fs.writeFileSync(file, JSON.stringify(w, null, indent) + "\n");
  }
  console.log(`written ${path.relative(process.cwd(), file)}`);
} else if (args[0] !== "(imported)") {
  console.log("usage: node tools/zone-mood.mjs lint [--world proving] | install <proposal.json> [--apply|--revert]");
}
