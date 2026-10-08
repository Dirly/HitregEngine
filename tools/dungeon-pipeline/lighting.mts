/**
 * Apply the dungeon lighting model (tools/dungeon-pipeline/lighting.json, merged with a project's own
 * authoring/lighting.json) to a dungeon scene as ONE applyOps batch: the readability-floor hemisphere fill, fog that
 * fades to the fill-lit tone, neutral exposure with a capped vignette, and the interior cullingProfile.
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
import { ctxOf, measurePopin } from "./quality.mjs";

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

/** warm / cold / neutral: the temperature of the bucket most plan spaces use (plan.lights maps warm|cold -> bucket). */
export function dominantTone(plan: Json | null): "warm" | "cold" | "neutral" {
  const map = plan?.lights ?? {};
  const toneOf = (bucket: string) => (map.warm === bucket ? "warm" : map.cold === bucket ? "cold" : "neutral");
  const count = new Map<string, number>();
  for (const sp of plan?.spaces ?? []) if (sp.lights) count.set(toneOf(sp.lights), (count.get(toneOf(sp.lights)) ?? 0) + 1);
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return (best?.[0] as "warm" | "cold" | "neutral") ?? "neutral";
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
      ops.push({ op: "set-component", id, component: "sky", data: { ...sky, ...dome, fog } });
    }
    const post = e.components["postfx"] as Json | undefined;
    if (post) {
      const tonemap = { ...(post.tonemap ?? {}), exposure: model.post.exposure };
      const vignette = post.vignette ? { ...post.vignette, amount: Math.min(post.vignette.amount ?? 0, model.post.vignetteMax) } : post.vignette;
      ops.push({ op: "set-component", id, component: "postfx", data: { ...post, tonemap, vignette } });
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
  const model = merge(readJson(path.join(HERE, "lighting.json"))!, readJson(path.join(root, "authoring/lighting.json")));
  const pop = measurePopin(c);
  const atEntry = Math.max(0, ...(pop?.rows ?? []).filter((r: Json) => r.routed).map((r: Json) => r.atEntryM));
  const { ops, summary } = lightingOps(doc, model, dominantTone(c.plan), atEntry);
  if (args.includes("--dry")) { console.log(JSON.stringify({ summary, ops: ops.map((o) => ({ op: o.op, id: (o as Json).id, component: (o as Json).component })) }, null, 1)); process.exit(0); }
  const result = applyOps(doc, ops, defaultRegistry());
  fs.writeFileSync(scenePath, JSON.stringify(result.doc, null, 1) + "\n");
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports/lighting.json"), JSON.stringify({ at: new Date().toISOString(), scene: path.relative(root, scenePath), summary, inverse: result.inverse }, null, 1) + "\n");
  console.log(`lighting: ${ops.length} ops on ${path.relative(root, scenePath)} (tone ${summary.tone}, fill ${summary.fill.intensity}, reveal ${summary.cullingProfile.interiorReveal} m); inverse in reports/lighting.json`);
}
