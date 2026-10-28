/**
 * The Codex prop gate: builds a staged design in Blender headless and holds it to the prop rules. codex-task.mjs runs it
 * as `--check`; exit 0 = pass (the design is installed), 1 = fail (nothing installed; the gate text is in
 * <stage>/gate.txt for the retry).
 *
 *   npx tsx tools/prop-codex/check.mts <stage dir> --job <job.json>
 *
 * job.json: { name, culture, scale: {id,height}, worldKit } (written by run.mts).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_KIND_SIZES, realSizeIssue } from "../_prop-real-size.mts";
import { CATEGORIES, LANDMARK_TRIANGLES, LIMITS, type ScaleInfo } from "./brief.mts";
import {readReusePolicy,reuseFaults} from '../_prop-reuse.mts';

export const BLENDER = process.env.HITREG_BLENDER ?? "P:/Program Files/Blender Foundation/Blender 5.2/blender.exe";
const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface GeometryRecord {
  name: string; error?: string; design?: string; category?: string; mount?: string; solid?: boolean; setting?: string; cultures?: string[];
  centrepiece?: boolean; size?: number[]; triangles?: number; parts?: { part: string; role: string; faces: number; extent?: number[] }[]; texel?: number;
  rooms?: string[] | null; use?: string[] | null; against?: string; shift?: number[];
  /** An engine water disc in glTF frame (Y up, origin-relative): centre [x, y, z], radius, depth. */
  water?: { centre: number[]; radius: number; depth: number } | null;
  paintPlan?: import('./paint.mts').PaintPlan | null;
  paint?: (Omit<import('./paint.mts').PaintPlan,'surfaces'> & {ready: boolean; size: number; atlasSha256: string; artSha256: string; layoutSha256: string; surfaces: (import('./paint.mts').PaintPlan['surfaces'][number] & {texel?: number})[]}) | null;
}
export interface Job { name: string; culture: string; scale: ScaleInfo; worldKit: string; /** a landmark request's height, m */ landmark?: number }

/** Every rule a built design breaks (empty = pass). Pure: the gate wiring's unit under test. */
export function gateFaults(rec: GeometryRecord, job: Job, scales: ScaleInfo[]): string[] {
  if (rec.error) return [`build failed: ${rec.error}`];
  const out: string[] = [];
  const f = job.scale.height / 1.8, size = rec.size ?? [0, 0, 0], max = Math.max(...size);
  const lm = job.landmark, triMax = lm ? LANDMARK_TRIANGLES : LIMITS.trianglesMax;
  if ((rec.triangles ?? 0) > triMax) out.push(`triangles: ${rec.triangles} > ${triMax}; simplify (fewer segments, fewer parts)`);
  const fussy = (rec.parts ?? []).filter((p) => p.extent && Math.max(...p.extent) < LIMITS.partMinExtent);
  if (fussy.length) out.push(`sub-5 cm detail: ${fussy.length} part(s) under ${LIMITS.partMinExtent * 100} cm (${[...new Set(fussy.map((p) => p.part))].slice(0, 6).join("; ")}): remove them, the texture paints them`);
  const t = rec.texel ?? 0;
  if (t < LIMITS.texel.min || t > LIMITS.texel.max) out.push(`texel density ${t}/m outside ${LIMITS.texel.min}-${LIMITS.texel.max} (target ${LIMITS.texel.target}): do not touch UVs or scale the mesh after building`);
  const issue = lm ? null : realSizeIssue(job.name, [size[0]!, size[1]!, size[2]!], job.scale.id, scales, DEFAULT_KIND_SIZES);
  if (issue) out.push(issue);
  if (lm && Math.abs(size[1]! - lm) > 0.1 * lm) out.push(`height: ${size[1]!.toFixed(2)} m; the landmark is ${lm} m tall (within 10%)`);
  const cap = lm ? 1.1 * lm : 6 * f;
  if (max > cap) out.push(`size: ${max.toFixed(2)} m on its largest side; a ${job.scale.id}-scale prop is at most ${cap.toFixed(1)} m`);
  if (max < 0.08) out.push(`size: ${max.toFixed(2)} m is too small to read as a prop`);
  if (!["floor", "wall", "surface", "ceiling"].includes(rec.mount ?? "")) out.push(`mount "${rec.mount}": one of floor, wall, surface, ceiling`);
  if (rec.water) {
    const w = rec.water, half = Math.min(size[0]!, size[2]!) / 2;
    if (!(w.radius >= 0.2)) out.push(`water radius ${w.radius} m: at least 0.2 m`);
    if (w.radius > half + 0.01) out.push(`water radius ${w.radius} m spills past the prop's footprint (${half.toFixed(2)} m): keep the disc inside the rim`);
    if (!(w.depth > 0 && w.depth <= 3)) out.push(`water depth ${w.depth} m: 0-3 m, down to the bed`);
    if (w.centre[1]! < 0 || w.centre[1]! > size[1]!) out.push(`water surface at ${w.centre[1]!.toFixed(2)} m is outside the prop's height (0-${size[1]!.toFixed(2)} m)`);
  }
  if (rec.mount === "surface" && max > 0.6 * f) out.push(`a surface prop is ${max.toFixed(2)} m; at most ${(0.6 * f).toFixed(2)} m rests on a table`);
  if (!CATEGORIES.includes(rec.category ?? "")) out.push(`category "${rec.category}": one of ${CATEGORIES.join(", ")}`);
  if (!["indoor", "outdoor", "both"].includes(rec.setting ?? "")) out.push(`setting "${rec.setting}": indoor, outdoor or both`);
  if (!(rec.cultures ?? []).some((c) => c === job.culture || c === "any")) out.push(`cultures [${(rec.cultures ?? []).join(", ")}] must include "${job.culture}"`);
  if ((rec.parts ?? []).length < (rec.paintPlan?.surfaces.length ? 1 : 2)) out.push("one part only: a prop is built from its real parts (a lid has battens, a tub has a rim and staves)");
  for (const s of rec.paint?.surfaces ?? []) if (!s.texel || s.texel < LIMITS.texel.min || s.texel > LIMITS.texel.max) out.push(`paint surface ${s.name}: texel density ${s.texel ?? 0}/m outside ${LIMITS.texel.min}-${LIMITS.texel.max}`);
  return out;
}

/** Run the Blender build on design files; returns the geometry records. */
export function blenderBuild(worldKit: string, designs: string[], outDir: string, geometry: string, options: {paintMode?: 'plan'|'final'; paintRoot?: string} = {}): GeometryRecord[] {
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(geometry, {force:true});
  const r = spawnSync(BLENDER, ["--background", "--factory-startup", "--python-exit-code", "1", "--python", path.join(HERE, "build.py"), "--", "--world-kit", worldKit, "--designs", designs.join(","), "--out", outDir, "--geometry", geometry, "--paint-mode", options.paintMode ?? 'final', ...(options.paintRoot ? ['--paint-root', options.paintRoot] : [])], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw Error(`Blender build failed (exit ${r.status}):\n${(r.stdout ?? '').slice(-1500)}\n${(r.stderr ?? '').slice(-1500)}`);
  if (!fs.existsSync(geometry)) throw Error(`blender build wrote no geometry (exit ${r.status}):\n${(r.stdout ?? "").slice(-1500)}\n${(r.stderr ?? "").slice(-1500)}`);
  return (JSON.parse(fs.readFileSync(geometry, "utf8")) as { props: GeometryRecord[] }).props;
}

async function main() {
  const stage = process.argv[2];
  const jobFile = process.argv[process.argv.indexOf("--job") + 1];
  if (!stage || !jobFile) { console.error("check.mts <stage> --job <job.json>"); process.exit(2); }
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8")) as Job & { scales: ScaleInfo[] };
  const design = path.join(stage, `${job.name}.py`);
  let faults: string[];
  try {
    const [rec] = blenderBuild(job.worldKit, [design], path.join(stage, "out"), path.join(stage, "geometry.json"), {paintMode:'plan'});
    faults = rec ? [...gateFaults(rec, job, job.scales),...reuseFaults(rec,readReusePolicy(job.worldKit))] : ["build produced no record"];
    if (rec && !rec.error) console.log(`gate ${job.name}: ${rec.size!.map((v) => v.toFixed(2)).join("x")} m, ${rec.triangles} tris, ${rec.parts!.length} parts, texel ${rec.texel}/m`);
  } catch (e) { faults = [(e as Error).message]; }
  fs.writeFileSync(path.join(stage, "gate.txt"), faults.length ? faults.map((f) => `- ${f}`).join("\n") + "\n" : "pass\n");
  for (const f of faults) console.log(`FAIL ${job.name}: ${f}`);
  process.exit(faults.length ? 1 : 0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
