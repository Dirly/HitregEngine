/**
 * Apply the dungeon lighting model (tools/dungeon-pipeline/lighting.json, merged with a project's own
 * authoring/lighting.json) to a dungeon scene as ONE applyOps batch: the readability-floor hemisphere fill, fog that
 * fades to the fill-lit tone, the shared post preset (grade, bloom, vignette <= the cap, no pixelate) and character
 * rim, neutral exposure, and the interior cullingProfile.
 *
 *   npx tsx ../../tools/dungeon-pipeline/lighting.mts --project projects/<id> [--scene <id>] [--dry]   (from apps/playground)
 *
 * Writes the scene and reports/lighting.json { applied, inverse } (the inverse ops undo it). --dry prints the ops.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, type Op, type SceneDoc } from "../../packages/core/src/index.ts";
import { defaultRegistry } from "../../packages/server/src/index.ts";
import { ctxOf, lightLevel, measurePopin } from "./quality.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Json = Record<string, any>;
const readJson = (f: string): Json | null => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const merge = (a: Json, b: Json | null): Json => {
  if (!b) return a;
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v;
  return out;
};
const scaleHex = (hex: string, k: number): string => "#" + [1, 3, 5].map((i) => Math.round(Math.min(255, parseInt(hex.slice(i, i + 2), 16) * k)).toString(16).padStart(2, "0")).join("");

/** warm / cold / neutral: the temperature of the bucket most plan spaces use (plan.lights maps warm|cold -> bucket); with
 *  no such map, the buckets the dressing plans name ("lights"), each toned by lighting.json tones.byBucket. */
export function dominantTone(plan: Json | null, dressingBuckets: string[] = [], byBucket: Json = {}): "warm" | "cold" | "neutral" {
  const map = plan?.lights && typeof plan.lights === "object" ? plan.lights : null;
  const count = new Map<string, number>();
  const add = (t: string) => count.set(t, (count.get(t) ?? 0) + 1);
  if (map) {
    // a map that names no temperature for a bucket (plan.lights { bucket: "tomb" }) falls back to tones.byBucket
    const toneOf = (bucket: string) => (map.warm === bucket ? "warm" : map.cold === bucket ? "cold" : typeof byBucket[bucket] === "string" ? byBucket[bucket] : "neutral");
    for (const sp of plan?.spaces ?? []) if (sp.lights) add(toneOf(sp.lights));
  } else for (const b of dressingBuckets) add(typeof byBucket[b] === "string" ? byBucket[b] : "neutral");
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return (best?.[0] as "warm" | "cold" | "neutral") ?? "neutral";
}

/** The fill tone: a project's authoring/lighting.json `tone` (warm | cold | neutral, with its why) wins over the counted
 *  dominant tone - for a dungeon whose read and climax sit in the minority of its spaces (a cold sea cave beside warm
 *  galleries). One hemisphere fill per scene, so the tone is a choice, not a per-space mix. */
export function chooseTone(own: Json | null, counted: () => "warm" | "cold" | "neutral"): string {
  const t = own?.tone;
  return t === "warm" || t === "cold" || t === "neutral" ? t : counted();
}

/** The light bucket each dressing plan names (authoring/dressing/plans/*.json, reports and inverses left out). */
export function dressingBuckets(root: string): string[] {
  const dir = path.join(root, "authoring/dressing/plans");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !/.(inverse|report).json$/.test(n))
    .map((n) => readJson(path.join(dir, n))?.lights).filter((b): b is string => typeof b === "string");
}

/** The ops that put the lighting model on `doc` (pure; `popinAtEntryM` sizes an `auto` reveal). */
export function lightingOps(doc: SceneDoc, model: Json, tone: string, popinAtEntryM: number): { ops: Op[]; summary: Json } {
  const ops: Op[] = [];
  const t = model.tones[tone] ?? model.tones.neutral;
  const E = doc.entities;
  const fill = { kind: "ambient", color: t.sky, groundColor: t.ground, intensity: model.fill.intensity };
  const ambients = Object.entries(E).filter(([, e]) => (e.components["light"] as Json | undefined)?.kind === "ambient");
  if (ambients.length) for (const [id, e] of ambients) ops.push({ op: "set-component", id, component: "light", data: { ...(e.components["light"] as Json), ...fill } });
  else ops.push({ op: "add-entity", id: "readability-fill", entity: { name: "Readability fill (lighting.json)", parent: null, tags: [], components: { light: fill } } });
  let skyId: string | null = null;
  for (const [id, e] of Object.entries(E)) {
    const sky = e.components["sky"] as Json | undefined;
    if (sky) {
      skyId = skyId ?? id;
      const fog = sky.fog ? { ...sky.fog, color: scaleHex(t.sky, model.fog.colourScale), near: model.fog.near, far: model.fog.far } : sky.fog;
      const fogTone = scaleHex(t.sky, model.fog.colourScale);
      const dome = model.fog.background ? { top: fogTone, bottom: fogTone } : {};
      const rim = model.rim ? { rim: Object.fromEntries(Object.entries(model.rim).filter(([k]) => k !== "about")) } : {};
      ops.push({ op: "set-component", id, component: "sky", data: { ...sky, ...dome, ...rim, fog } });
    }
    const post = e.components["postfx"] as Json | undefined;
    if (post) {
      // the shared post preset, key by key (keys it does not name stay the scene's own), then the exposure and the vignette cap
      const preset: Json = model.post.preset ?? {};
      const merged: Json = { ...post };
      for (const [k, v] of Object.entries(preset)) merged[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(post[k] ?? {}), ...v } : v;
      const tonemap = { ...(merged.tonemap ?? {}), exposure: model.post.exposure };
      const vignette = merged.vignette ? { ...merged.vignette, amount: Math.min(merged.vignette.amount ?? 0, model.post.vignetteMax) } : merged.vignette;
      ops.push({ op: "set-component", id, component: "postfx", data: { ...merged, tonemap, vignette } });
    }
  }
  const cp = model.cullingProfile;
  const reveal = cp.interiorReveal === "auto" ? Math.max(cp.minReveal, Math.ceil((popinAtEntryM + 1) / 5) * 5) : cp.interiorReveal;
  const profile = { interiorReveal: reveal, maxMinScreenPx: cp.maxMinScreenPx, occlusion: cp.occlusion };
  const holder = Object.entries(E).find(([, e]) => e.components["cullingProfile"])?.[0] ?? (E[doc.name] ? doc.name : skyId);
  if (holder) ops.push({ op: "set-component", id: holder, component: "cullingProfile", data: profile });
  return { ops, summary: { tone, fill, fog: { colour: scaleHex(t.sky, model.fog.colourScale), near: model.fog.near, far: model.fog.far }, post: model.post, cullingProfile: { holder, ...profile } } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const root = path.resolve(opt("project") ?? ".");
  const c = ctxOf(root);
  const sceneId = opt("scene") ?? c.id;
  const scenePath = path.join(root, `assets/scenes/${sceneId}.scene.json`);
  const doc = readJson(scenePath) as SceneDoc | null;
  if (!doc) throw new Error(`no scene ${scenePath}`);
  const own = readJson(path.join(root, "authoring/lighting.json"));
  const model = merge(readJson(path.join(HERE, "lighting.json"))!, own);
  // the dungeon's light level (lit | night; thresholds.json readability.levels) sets the fill, unless it names its own
  const level = lightLevel(own);
  if ((own as Json | null)?.fill?.intensity === undefined) {
    const fill = model.levels?.[level]?.fill;
    if (typeof fill !== "number") throw new Error(`lighting: no fill for light level "${level}" in tools/dungeon-pipeline/lighting.json levels`);
    model.fill.intensity = fill;
  }
  const pop = measurePopin(c);
  const atEntry = Math.max(0, ...(pop?.rows ?? []).filter((r: Json) => r.routed).map((r: Json) => r.atEntryM));
  const { ops, summary } = lightingOps(doc, model, chooseTone(own, () => dominantTone(c.plan, dressingBuckets(root), model.tones.byBucket)), atEntry);
  if (args.includes("--dry")) { console.log(JSON.stringify({ summary, ops: ops.map((o) => ({ op: o.op, id: (o as Json).id, component: (o as Json).component })) }, null, 1)); process.exit(0); }
  const result = applyOps(doc, ops, defaultRegistry());
  // keep the file's own layout (indent, trailing newline) so the diff is the lighting, not a reformat
  const raw = fs.readFileSync(scenePath, "utf8");
  const indent = /\n( +)"/.exec(raw)?.[1]?.length ?? 2;
  fs.writeFileSync(scenePath, JSON.stringify(result.doc, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports/lighting.json"), JSON.stringify({ at: new Date().toISOString(), scene: path.relative(root, scenePath), summary, inverse: result.inverse }, null, 1) + "\n");
  console.log(`lighting: ${ops.length} ops on ${path.relative(root, scenePath)} (level ${level}, tone ${summary.tone}, fill ${summary.fill.intensity}, reveal ${summary.cullingProfile.interiorReveal} m); inverse in reports/lighting.json`);
}
