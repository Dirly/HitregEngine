/**
 * WATER BASELINE (2026-10-29 redstrand w9, coordinator): a `worldgen rivers` re-solve rewrites every lake, river and
 * fall, so a re-solve that moves the water at a sited place (a town's lake shore, a fall in a place's view) went
 * unseen. Each run now writes a per-lake / river / fall level summary and diffs it against the previous run's:
 *
 *   waterLevels      the summary: lakes (level, centre, radius, a digest of the shoreline), rivers (ends, bed ends,
 *                    a digest of the course), falls (position)
 *   diffWaterLevels  what moved: a lake's level by more than `tol` m or its shoreline at all, a river's course, a fall
 *                    by more than `tol` m, anything added or gone; each with the sited places it lies near
 *   baselineFile     projects/<p>/authoring/worldgen/<world>-water-levels.json (beside the recipe for a flat-tree world)
 *   waterLevelsCheck the `water-baseline` status row: the recipe's water still equals the last run's summary (no other
 *                    tool moved it), and the last re-solve moved no water near a sited place unless accepted
 *                    (`worldgen rivers <world> --accept-water "<dated ruling>"`)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorldRecipe } from "@hitreg/core";

export interface WaterLevels {
  lakes: Record<string, { waterY: number; center: [number, number]; radius: number; shore: string }>;
  rivers: Record<string, { start: [number, number]; end: [number, number]; bed: [number | null, number | null]; course: string }>;
  falls: Record<string, { at: [number, number, number] }>;
}
export interface WaterMove { kind: "lake" | "river" | "fall"; id: string; what: string; at: [number, number]; near: string[] }
export interface WaterBaseline { ran: string; levels: WaterLevels; moved: WaterMove[]; accepted?: string }
export interface SitedSpot { id: string; center: [number, number]; radius: number }

const digest = (v: unknown): string => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const r2 = (v: number): number => Math.round(v * 100) / 100;
const xz = (p: readonly number[]): [number, number] => [p[0]!, p[p.length - 1]!];

export function waterLevels(recipe: WorldRecipe): WaterLevels {
  const f = recipe.features as unknown as {
    lakes: { id: string; waterY: number; center: [number, number]; radius: number; polygon?: unknown }[];
    rivers: { id: string; points: number[][]; bedY?: number[] }[];
    pois: { id: string; kind: string; position: [number, number, number] }[];
  };
  const out: WaterLevels = { lakes: {}, rivers: {}, falls: {} };
  for (const l of f.lakes ?? []) out.lakes[l.id] = { waterY: r2(l.waterY), center: [r2(l.center[0]), r2(l.center[1])], radius: r2(l.radius), shore: digest(l.polygon ?? null) };
  for (const r of f.rivers ?? []) {
    const pts = r.points ?? [];
    if (!pts.length) continue;
    out.rivers[r.id] = { start: xz(pts[0]!), end: xz(pts[pts.length - 1]!), bed: [r.bedY?.[0] ?? null, r.bedY?.[r.bedY.length - 1] ?? null], course: digest([pts, r.bedY ?? null]) };
  }
  for (const p of f.pois ?? []) if (p.kind === "falls") out.falls[p.id] = { at: [r2(p.position[0]), r2(p.position[1]), r2(p.position[2])] };
  return out;
}

/** What moved between two summaries, each with the sited places (radius + 100 m) it lies near. */
export function diffWaterLevels(prev: WaterLevels, cur: WaterLevels, places: readonly SitedSpot[] = [], tol = 0.3): WaterMove[] {
  const near = (at: [number, number], reach = 0): string[] => places.filter((p) => Math.hypot(p.center[0] - at[0], p.center[1] - at[1]) <= p.radius + 100 + reach).map((p) => p.id);
  const out: WaterMove[] = [];
  for (const id of new Set([...Object.keys(prev.lakes), ...Object.keys(cur.lakes)])) {
    const a = prev.lakes[id], b = cur.lakes[id];
    const at = (b ?? a)!.center, reach = (b ?? a)!.radius;
    if (!a || !b) { out.push({ kind: "lake", id, what: a ? "gone" : "new", at, near: near(at, reach) }); continue; }
    const what: string[] = [];
    if (Math.abs(a.waterY - b.waterY) > tol) what.push(`level ${a.waterY} -> ${b.waterY}`);
    if (a.shore !== b.shore || Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) > tol || Math.abs(a.radius - b.radius) > tol) what.push("shoreline moved");
    if (what.length) out.push({ kind: "lake", id, what: what.join(", "), at, near: near(at, reach) });
  }
  for (const id of new Set([...Object.keys(prev.rivers), ...Object.keys(cur.rivers)])) {
    const a = prev.rivers[id], b = cur.rivers[id];
    const at = (b ?? a)!.end;
    if (!a || !b) { out.push({ kind: "river", id, what: a ? "gone" : "new", at, near: near(at) }); continue; }
    if (a.course !== b.course) {
      const bed = a.bed[0] !== null && b.bed[0] !== null ? ` (bed ${a.bed[0]}..${a.bed[1]} -> ${b.bed[0]}..${b.bed[1]})` : "";
      out.push({ kind: "river", id, what: `course re-cut${bed}`, at, near: near(at) });
    }
  }
  for (const id of new Set([...Object.keys(prev.falls), ...Object.keys(cur.falls)])) {
    const a = prev.falls[id], b = cur.falls[id];
    const p = (b ?? a)!.at, at: [number, number] = [p[0], p[2]];
    if (!a || !b) { out.push({ kind: "fall", id, what: a ? "gone" : "new", at, near: near(at) }); continue; }
    const d = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1], a.at[2] - b.at[2]);
    if (d > tol) out.push({ kind: "fall", id, what: `moved ${r2(d)} m`, at, near: near(at) });
  }
  return out;
}

export function describeMoves(moves: readonly WaterMove[]): string {
  return moves.map((m) => `${m.kind} ${m.id}: ${m.what}${m.near.length ? ` [NEAR ${m.near.join(", ")}]` : ""}`).join("; ");
}

export function baselineFile(recipeFile: string, world: string): string {
  const abs = path.resolve(recipeFile);
  const m = /^(.*[\\/]projects[\\/][^\\/]+)[\\/]assets[\\/]worlds[\\/]/.exec(abs);
  return m ? path.join(m[1]!, "authoring", "worldgen", `${world}-water-levels.json`) : path.join(path.dirname(abs), `${world}.water-levels.json`);
}

export function readBaseline(file: string): WaterBaseline | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as WaterBaseline) : null;
}

/** Record a rivers run: diff against the last run, write the new summary; returns the moves (empty on a first run). */
export function recordWaterRun(file: string, recipe: WorldRecipe, places: readonly SitedSpot[], now = new Date().toISOString()): { first: boolean; moves: WaterMove[] } {
  const prev = readBaseline(file);
  const levels = waterLevels(recipe);
  const moves = prev ? diffWaterLevels(prev.levels, levels, places) : [];
  // an earlier unaccepted move near a place stays listed until accepted: a second, quiet run must not hide it
  const carried = prev && !prev.accepted ? prev.moved.filter((m) => m.near.length && !moves.some((n) => n.kind === m.kind && n.id === m.id)) : [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc: WaterBaseline = { ran: now, levels, moved: [...moves, ...carried] };
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  return { first: !prev, moves };
}

export function acceptWater(file: string, ruling: string): WaterBaseline | null {
  const b = readBaseline(file);
  if (!b) return null;
  b.accepted = ruling;
  b.moved = [];
  fs.writeFileSync(file, JSON.stringify(b, null, 1) + "\n");
  return b;
}

/** The `water-baseline` row: null = ok. */
export function waterLevelsCheck(recipe: WorldRecipe, file: string): string | null {
  const b = readBaseline(file);
  if (!b) return `no water baseline yet (worldgen rivers writes ${path.basename(file)})`;
  const drift = diffWaterLevels(b.levels, waterLevels(recipe), [], 0.05);
  if (drift.length) return `the water changed since the last rivers run, outside it: ${describeMoves(drift)}`;
  const atPlaces = b.moved.filter((m) => m.near.length);
  if (atPlaces.length) return `the last rivers re-solve moved water near sited places: ${describeMoves(atPlaces)} (re-shoot / re-check those places, then worldgen rivers <world> --accept-water "<dated ruling>")`;
  return null;
}
