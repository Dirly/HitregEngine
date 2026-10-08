/**
 * zonegen sites <world> --project <p> --zone <id> [--step 8] [--top 40] [--no-map] [--size 1800] [--out <dir>]
 *
 * THE SITE FINDER, run BEFORE the zone brief: read the ground (heightfield, water, roads and paths, towns and every
 * reservation) and list where places want to go — canyon ends, cliffs over water, plateaus and mesas, peaks, passes,
 * the narrow neck between a cliff and the shore (a wall), coves, waterfalls, the tops of paths that climb, and the
 * largest empty land — each scored, with how the player arrives (which road, how far, the climb, how many metres of
 * road see it, the bearing it should face). The zone master picks places from this list and the map, then writes the
 * brief (a place records its pick in `site`); reserve checks the reservation stands on it.
 *
 * Gate (lint): every path that climbs leads somewhere; no large empty landform; places per km2 of land and the
 * largest empty disc against the thresholds in ./_site-finder.mts. The engine is ./_site-finder.mts (no I/O).
 *
 * Options: --focus x,z,r draws one area close up (sites-<x>_<z>_<r>.png); --step the sample grid in metres.
 *
 * Writes  zones/<zone>/reports/sites.json            gate report (what `zonegen status` reads)
 *         zones/<zone>/reports/sites-candidates.json the ranked candidates, path findings, density
 *         zones/<zone>/reports/sites.png             the review map with the candidates drawn and labelled
 * `--out <dir>` writes all three there instead (a read-only look at a live world).
 */
import fs from "node:fs";
import path from "node:path";
import { createWorldField } from "@hitreg/core";
import { exists, finish, loadRecipe, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import { collectMapData, DEFAULT_LAYERS, layerCounts, type LayerId } from "../../../src/map-layers.ts";
import { err, requireZone, warn } from "./_shared.mts";
import { findScene, gatherExtras, shootMap } from "./map.mts";
import { CLIMB_NEEDS_PLACE, EMPTY_MAX, findSites, travelRoads, LANDFORM_COVER, LANDFORM_HA, MIN_PER_KM2, type Content, type RoadLine, type SiteReport, type Vec2 } from "./_site-finder.mts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

const xz = (p: number[]): Vec2 => (p.length >= 3 ? [p[0]!, p[2]!] : [p[0]!, p[1]!]);
export { travelRoads };

/** Everything already standing: towns (with their falloff) and every zone's reservations. */
export function standingContent(ctx: Ctx, recipe: J): Content[] {
  const out: Content[] = ((recipe.features?.towns ?? []) as J[]).map((t) => ({ id: t.id, kind: "town" as const, x: t.center[0], z: t.center[1], radius: t.radius + (t.falloff ?? 0) }));
  const zonesDir = path.join(ctx.paths.worldDir, "zones");
  if (exists(zonesDir))
    for (const zone of fs.readdirSync(zonesDir)) {
      const file = ctx.paths.reservations(zone);
      if (!exists(file)) continue;
      // the quest graph says which places are hostile and which hostile ones are lookouts over a road
      const qf = ctx.paths.quests(zone);
      const locs = new Map<string, J>(exists(qf) ? (((readJson(qf) as J).locations ?? []) as J[]).map((l) => [l.id as string, l]) : []);
      for (const r of ((readJson(file) as J).reservations ?? []) as J[]) {
        const l = locs.get(r.location);
        out.push({ id: r.location, kind: "reservation", x: r.center[0], z: r.center[1], radius: r.radius, zone, hostile: !!l?.hostile, overlooksRoad: l?.overlooksRoad === true });
      }
    }
  return out;
}

// the overlay drawn on the review map (runs in the page: plain JS, no imports)
const DRAW = String.raw`
const COLORS = { "cliff-water": "#4fc3f7", "canyon-end": "#ff8a65", plateau: "#ffd54f", peak: "#e0e0e0", saddle: "#ba68c8", "wall-gap": "#ef5350", cove: "#4dd0e1", waterfall: "#81d4fa", "path-end": "#aed581", switchback: "#9ccc65", "empty-land": "#ffffff", island: "#26a69a", access: "#ff4081" };
const SHAPE = { "cliff-water": "tri", "canyon-end": "chev", plateau: "square", peak: "tri", saddle: "diamond", "wall-gap": "bar", cove: "circle", waterfall: "drop", "path-end": "circle", switchback: "z", "empty-land": "ring", island: "circle", access: "bar" };
ctx.save();
ctx.font = "bold 12px system-ui, sans-serif";
ctx.textBaseline = "middle";
const boxes = [];
const free = (x, y, w, h) => !boxes.some((b) => x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]);
for (const e of data.empties) {
  ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath(); ctx.arc(toX(e.at[0]), toY(e.at[1]), e.radius * scale, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
}
for (const e of data.empties) {
  const t = "EMPTY " + e.radius + " m";
  ctx.fillStyle = "rgba(0,0,0,0.72)"; const w = ctx.measureText(t).width + 8;
  ctx.fillRect(toX(e.at[0]) - w / 2, toY(e.at[1]) + 8, w, 16); ctx.fillStyle = "#fff"; ctx.fillText(t, toX(e.at[0]) - w / 2 + 4, toY(e.at[1]) + 16);
  boxes.push([toX(e.at[0]) - w / 2, toY(e.at[1]) + 8, w, 16]);
}
for (const l of data.landforms) {
  if (l.covered >= 0.25) continue;
  const t = l.kind.toUpperCase() + " " + l.areaHa + " ha, " + Math.round(l.covered * 100) + "% used";
  const x = toX(l.at[0]), y = toY(l.at[1]) - 22; const w = ctx.measureText(t).width + 8;
  ctx.fillStyle = "rgba(120,0,0,0.85)"; ctx.fillRect(x - w / 2, y - 8, w, 16); ctx.fillStyle = "#fff"; ctx.fillText(t, x - w / 2 + 4, y);
  boxes.push([x - w / 2, y - 8, w, 16]);
}
for (const p of data.paths) {
  const x = toX(p.at[0]), y = toY(p.at[1]);
  ctx.lineWidth = 3; ctx.strokeStyle = p.leadsTo ? "#9ccc65" : p.kind === "wasted-climb" ? "#ffb74d" : "#ff1744";
  ctx.beginPath(); ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7); ctx.stroke();
}
for (const c of data.candidates) {
  const x = toX(c.at[0]), y = toY(c.at[1]);
  const col = c.usedBy ? "rgba(170,170,170,0.9)" : COLORS[c.kind];
  if (c.approach.firstSeen && !c.usedBy) {
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(toX(c.approach.firstSeen.at[0]), toY(c.approach.firstSeen.at[1])); ctx.stroke(); ctx.setLineDash([]);
  }
  if (c.kind === "wall-gap" && c.detail.line) {
    ctx.strokeStyle = col; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(toX(c.detail.line[0][0]), toY(c.detail.line[0][1])); ctx.lineTo(toX(c.detail.line[1][0]), toY(c.detail.line[1][1])); ctx.stroke();
  }
  // facing tick: the way the site should face its approach
  const a = (c.approach.faces * Math.PI) / 180;
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(a) * 16, y - Math.cos(a) * 16); ctx.stroke();
  ctx.fillStyle = col; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
  const s = 7; ctx.beginPath();
  switch (SHAPE[c.kind]) {
    case "tri": ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * 0.8); ctx.lineTo(x - s, y + s * 0.8); ctx.closePath(); break;
    case "square": ctx.rect(x - s, y - s, 2 * s, 2 * s); break;
    case "diamond": ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); break;
    case "chev": ctx.moveTo(x - s, y - s); ctx.lineTo(x, y + s); ctx.lineTo(x + s, y - s); ctx.lineTo(x, y - s * 0.2); ctx.closePath(); break;
    case "bar": ctx.rect(x - s, y - 3, 2 * s, 6); break;
    case "drop": ctx.arc(x, y + 2, s * 0.7, 0, Math.PI * 2); ctx.moveTo(x, y - s); break;
    case "z": ctx.rect(x - 5, y - 5, 10, 10); break;
    case "ring": ctx.arc(x, y, 4, 0, Math.PI * 2); break;
    default: ctx.arc(x, y, s * 0.8, 0, Math.PI * 2);
  }
  ctx.fill(); ctx.stroke();
  if (!c.label) continue;
  const text = c.id + " " + c.kind + " " + c.score + (c.usedBy ? " (" + c.usedBy + ")" : "");
  const w = ctx.measureText(text).width + 8;
  for (const [dx, dy] of [[10, -10], [10, 10], [-w - 10, -10], [-w - 10, 10], [10, -24], [-w - 10, 24]]) {
    if (!free(x + dx, y + dy - 8, w, 16)) continue;
    boxes.push([x + dx, y + dy - 8, w, 16]);
    ctx.fillStyle = "rgba(0,0,0,0.72)"; ctx.fillRect(x + dx, y + dy - 8, w, 16);
    ctx.fillStyle = col; ctx.fillText(text, x + dx + 4, y + dy);
    break;
  }
}
// key
const kinds = Object.keys(COLORS);
const kx = 12, ky = view.height - 24 - kinds.length * 17;
ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.fillRect(kx - 6, ky - 22, 330, kinds.length * 17 + 40);
ctx.fillStyle = "#fff"; ctx.fillText("site finder (grey = already used; tick = faces; dashed = first seen from)", kx, ky - 10);
kinds.forEach((k, n) => { ctx.fillStyle = COLORS[k]; ctx.fillRect(kx, ky + n * 17 + 2, 12, 12); ctx.fillStyle = "#ddd"; ctx.fillText(k, kx + 18, ky + n * 17 + 8); });
ctx.fillStyle = "#ff1744"; ctx.fillText("X path leads nowhere   ", kx + 150, ky + 8);
ctx.fillStyle = "#ffb74d"; ctx.fillText("X wasted climb", kx + 150, ky + 25);
ctx.fillStyle = "#fff"; ctx.fillText("dashed circle = empty land", kx + 150, ky + 42);
ctx.restore();
`;

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "sites");
  if (bad !== null) return bad;
  const zone = ctx.zone;
  const outDir = ctx.opt("out");
  if (outDir) {
    // a look at a live world: every file this command writes goes to --out, nothing under the project
    const dir = path.resolve(outDir);
    ctx = { ...ctx, paths: { ...ctx.paths, report: (stage: string) => path.join(dir, `${stage}.json`) } };
  }
  const p = ctx.paths;
  const reports = path.dirname(p.report("sites", zone));
  const f: Finding[] = [];
  const recipe = loadRecipe(p) as unknown as J;
  const region = (recipe.regions as J[]).find((r) => r.id === zone && r.within === undefined);
  if (!region) {
    console.error(`zonegen sites: ${zone} is not a wilderness zone of ${ctx.world}`);
    return 2;
  }
  const t0 = performance.now();
  const field = createWorldField(recipe as never);
  const content = standingContent(ctx, recipe);
  const report: SiteReport = findSites({
    field: field as never,
    seaLevel: recipe.seaLevel ?? 0,
    polygon: region.polygon,
    zone,
    roads: travelRoads(recipe),
    content,
    canyons: ((recipe.features?.canyons ?? []) as J[]).map((c) => ({ id: c.id, points: (c.points as number[][]).map(xz) })),
    step: Number(ctx.opt("step", "8")),
  });
  console.log(`sites ${zone}: ${report.candidates.length} candidates, ${report.paths.length} path findings (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

  // ---- the lint
  for (const x of report.paths) {
    if (x.kind === "dead-end" && !x.leadsTo) (x.climb >= CLIMB_NEEDS_PLACE ? err : warn)(f, x.climb >= CLIMB_NEEDS_PLACE ? "path-leads-nowhere" : "dead-end", x.message, x.road);
    if (x.kind === "switchback-top" && !x.leadsTo) {
      // a hairpin run that tops out at a pass carries on; one that tops out anywhere else must arrive somewhere
      const pass = report.candidates.some((c) => c.kind === "saddle" && Math.hypot(c.at[0] - x.at[0], c.at[1] - x.at[1]) < 200);
      (pass ? warn : err)(f, pass ? "pass-unmarked" : "climb-to-nothing", pass ? `${x.message} — it crosses a pass: a waystation, gate or shrine belongs there` : x.message, x.road);
    }
    if (x.kind === "wasted-climb") warn(f, "wasted-climb", x.message, x.road);
  }
  if (report.perKm2 < MIN_PER_KM2) err(f, "sparse", `${report.places} place(s) and town(s) on ${report.landKm2} km2 of land = ${report.perKm2}/km2 (at least ${MIN_PER_KM2}/km2): too much open space`);
  if (report.largestEmpty && report.largestEmpty.radius > EMPTY_MAX)
    err(f, "empty-land", `nothing within ${report.largestEmpty.radius} m of [${report.largestEmpty.at.join(", ")}] (${report.largestEmpty.landform}); at most ${EMPTY_MAX} m`);
  for (const l of report.landforms) {
    if (l.covered >= LANDFORM_COVER) continue;
    const msg = `${l.kind} landform of ${l.areaHa} ha at [${l.at.join(", ")}]${l.relief > 0 ? ` (${l.relief} m over its foot)` : ""}: only ${Math.round(l.covered * 100)}% within reach of a place`;
    (l.kind === "plateau" || l.areaHa >= 3 * LANDFORM_HA ? err : warn)(f, "empty-landform", msg, l.id);
  }
  // hostile places off town-to-town roads (a lookout over one is allowed: location `overlooksRoad`)
  for (const h of report.hostileOnRoad) if (!h.lookout && content.some((c) => c.id === h.place && c.zone === zone)) err(f, "hostile-on-road", h.message, h.place);
  // a strong site no walking body reaches from a road: its access device is a candidate of its own
  for (const a of report.candidates.filter((c) => c.kind === "access" && !c.usedBy).slice(0, 8)) warn(f, "access-device", a.why, a.id);
  const strong = report.candidates.filter((c) => c.inZone && !c.usedBy && c.score >= 8 && c.kind !== "empty-land" && c.kind !== "path-end");
  for (const c of strong.slice(0, 8)) warn(f, "unused-site", `${c.id} ${c.kind} at [${c.at.join(", ")}] (score ${c.score}): ${c.why}`, c.id);

  // ---- the candidate list
  const top = Number(ctx.opt("top", "40"));
  const listing = {
    world: ctx.world,
    zone,
    at: new Date().toISOString(),
    step: report.step,
    density: { landKm2: report.landKm2, places: report.places, perKm2: report.perKm2, min: MIN_PER_KM2, largestEmpty: report.largestEmpty, emptyMax: EMPTY_MAX },
    empties: report.empties,
    landforms: report.landforms,
    paths: report.paths,
    candidates: report.candidates.filter((c) => c.inZone),
  };
  const listFile = path.join(reports, "sites-candidates.json");
  writeJson(listFile, listing);
  console.log(`\n  land ${report.landKm2} km2, ${report.places} places -> ${report.perKm2}/km2 (min ${MIN_PER_KM2}); largest empty ${report.largestEmpty ? `${report.largestEmpty.radius} m at [${report.largestEmpty.at}]` : "none"}`);
  console.log(`  top candidates (score, kind, where, approach):`);
  for (const c of listing.candidates.filter((c) => c.kind !== "empty-land").slice(0, Math.min(top, 25)))
    console.log(`  ${c.id} ${String(c.score).padStart(4)} ${c.kind.padEnd(11)} [${c.at.join(", ")}] y${Math.round(c.y)}  ${c.usedBy ? `(used: ${c.usedBy}) ` : ""}${c.why}; road ${c.approach.road ?? "-"} ${c.approach.distance} m, climb ${c.approach.climb} m, seen from ${c.approach.seenM} m of road, faces ${c.approach.facesWord}${c.approach.note ? ` (${c.approach.note})` : ""}`);
  console.log(`  wrote ${path.relative(process.cwd(), listFile)}`);

  // ---- the map
  if (!ctx.flag("no-map")) {
    const basePng = path.join(p.projectDir, "assets", "maps", `${ctx.world}.base.png`);
    if (!exists(basePng)) console.warn(`  no terrain picture ${basePng}: run \`zonegen map ${ctx.world} --project ${ctx.project} --base\` first (map skipped)`);
    else {
      const scene = findScene(ctx);
      const data = collectMapData(recipe as never, scene?.doc ?? null, gatherExtras(ctx, recipe), ctx.world);
      const layers = new Set<LayerId>([...DEFAULT_LAYERS, "reservations"]);
      const size = Number(ctx.opt("size", "1800"));
      const xs = region.polygon.map((q: number[]) => q[0]);
      const zs = region.polygon.map((q: number[]) => q[1]);
      // --focus x,z,r draws one area close up (a wall site, a canyon) instead of the whole zone
      const focus = ctx.opt("focus").split(",").map(Number);
      const box: [number, number, number, number] = focus.length === 3 && focus.every(Number.isFinite)
        ? [focus[0]! - focus[2]!, focus[1]! - focus[2]!, focus[0]! + focus[2]!, focus[1]! + focus[2]!]
        : [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
      // the zone box with a margin, the long side `size` px (a wide zone gets a wide picture)
      const w = box[2] - box[0] + 240;
      const h = box[3] - box[1] + 240;
      const scale = size / Math.max(w, h);
      const view = { cx: (box[0] + box[2]) / 2, cz: (box[1] + box[3]) / 2, scale, width: Math.round(w * scale), height: Math.max(700, Math.round(h * scale)) };
      const ranked = listing.candidates.filter((c) => c.kind !== "empty-land");
      const labelled = new Set([...ranked.slice(0, top), ...ranked.filter((c) => c.score >= 7 || c.kind === "plateau")].map((c) => c.id));
      const overlay = {
        data: { candidates: listing.candidates.map((c) => ({ ...c, label: labelled.has(c.id) })), empties: report.empties, paths: report.paths, landforms: report.landforms },
        draw: DRAW,
      };
      const out = path.join(reports, ctx.opt("focus") ? `sites-${ctx.opt("focus").replaceAll(",", "_")}.png` : "sites.png");
      const shot = await shootMap({ basePng, data, view, layers, title: `${region.name} (${zone}) · SITE FINDER · ${(1 / view.scale).toFixed(1)} m/px`, counts: layerCounts(data), focusZone: zone, out, overlay });
      if (shot) console.warn(`  map: ${shot}`);
      else console.log(`  wrote ${path.relative(process.cwd(), out)}`);
    }
  }
  // the ground and what already stands on it (every zone's reservations count; this zone's is the one hashed)
  const inputs = [p.recipe, p.reservations(zone), p.quests(zone)];
  return finish(ctx, "sites", inputs, f);
}

