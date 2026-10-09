/**
 * site-sockets — measure an OUTDOOR site (a POI's camp, yard, cave mouth, shore, ruin) into socket maps of named pitches,
 * so a dresser places its props by NAME (`props menu --map`, `dress check`, `dress apply`), never by a transform.
 *
 *   npx tsx tools/site-sockets.mts --project proving --job <poi job dir> [--scene proving] [--prefix hrimgard] [--area <id>]
 *
 * Reads the job's handoff.json files (the job dir and every v<N>/ under it, newest last) and boots the scene headless as
 * the dedicated server does (terrain, installed props' colliders, water). It never writes a scene or the world. Writes ONE
 * map per area, authoring/dressing/sockets/<poi>-<area>.json (WORLD coordinates: apply with --at 0,0,0 --yaw 0); its one
 * room is the area id. Measurement: @hitreg/core buildSiteSocketMap (cells, walls, anchors and what is refused).
 *
 * Inputs, all optional, the owner's declaration winning (handoff.json `siteDressing`):
 *   siteDressing.areas:     [{ id, role: camp|yard|cave-mouth|path|shore|ruin, centre: [x,z], radius, floorY?, room? }]
 *                           floorY: a chamber under the ground (cave floor height); room: that chamber's passage id
 *                           default: a 14 m `camp` round every hearth/bonfire of the POI
 *   siteDressing.anchors:   [{ id, kind: hearth|door|cave-mouth|water-edge|<any>, at: [x,z], facing?: [dx,dz] (OUT of a door
 *                           or cave), radius? }]   added to the derived ones: hearths (fire prefabs), tent doors (toward
 *                           the nearest hearth), cave mouths (the POI's `passages`, facing out)
 *   siteDressing.keepClear: [{ id, why, at: [x,z], radius } | { id, why, points: [[x,z]...], width }]   added to the derived:
 *                           every recipe road/path near the site (+0.6 m), passages, sitePacks clearings (8 m discs) and
 *                           namedSpots (their radius)
 * Built things: every scene entity tagged `poi:<poi>` whose prefab declares `dressing` is a footprint (and its sides are
 * walls); anything else with a collider is caught by a ray from above.
 */
import fs from "node:fs";
import path from "node:path";
import { buildSiteSocketMap, dressingSchema, type SiteAnchorIn, type SiteArea, type SiteBlocker, type SiteKeep } from "@hitreg/core";
import {
  HeadlessWorld, TerrainStreamer, defaultEvents, defaultRegistry, defaultScripts, loadContent, loadProjectScripts, playgroundRoots, resolveServerVoxelWorld,
} from "../../../packages/server/src/index.ts";

type P2 = [number, number];
const argv = process.argv.slice(2);
const opt = (n: string, d = ""): string => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1]! : d; };
const project = opt("project", "proving"), jobArg = opt("job");
if (!jobArg) { console.error("usage: site-sockets --project <p> --job <poi job dir> [--scene <scene>] [--prefix <feature id prefix>] [--area <id>]"); process.exit(2); }
const proj = path.join("projects", project);
const job = path.isAbsolute(jobArg) || fs.existsSync(jobArg) ? jobArg : path.join(proj, jobArg);
const readJ = <T,>(f: string): T => JSON.parse(fs.readFileSync(f, "utf8")) as T;
interface Handoff {
  poiId?: string; sitePacks?: { clearings?: Array<{ id: string; centre: number[]; radius?: number }>; newClearings?: Array<{ id: string; centre: number[]; radius?: number }>; namedSpots?: Array<{ creature: string; at?: number[] | null; radius?: number }> };
  siteDressing?: { areas?: SiteArea[]; anchors?: SiteAnchorIn[]; keepClear?: Array<{ id: string; why?: string; at?: P2; radius?: number; points?: P2[]; width?: number }> };
}
const handoffs = [path.join(job, "handoff.json"), ...fs.readdirSync(job).filter((d) => /^v\d+$/.test(d)).sort((a, b) => +a.slice(1) - +b.slice(1)).map((d) => path.join(job, d, "handoff.json"))].filter((f) => fs.existsSync(f)).map((f) => readJ<Handoff>(f));
if (!handoffs.length) { console.error(`no handoff.json in ${job}`); process.exit(2); }
const poi = handoffs.find((h) => h.poiId)?.poiId ?? path.basename(job);
const prefix = opt("prefix", poi.split("-")[0]!);
const scene = opt("scene", "proving");
const xz = (p: number[]): P2 => (p.length === 3 ? [p[0]!, p[2]!] : [p[0]!, p[1]!]);

// ---- the scene's POI entities (world transforms composed from the doc) and the prefabs' declared footprints
const content = loadContent(playgroundRoots(path.resolve(".")));
const sceneDoc = content.scenes.get(scene);
if (!sceneDoc) throw new Error(`no scene ${scene}`);
type Ent = { parent?: string | null; tags?: string[]; components: { transform?: { position?: number[]; rotation?: number[]; scale?: number[] }; prefab?: { prefabId: string } } };
const ents = (sceneDoc as unknown as { entities: Record<string, Ent> }).entities;
const qmul = (a: number[], b: number[]): number[] => [a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!, a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!, a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!, a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!];
const qrot = (q: number[], v: number[]): number[] => { const p = qmul(qmul(q, [v[0]!, v[1]!, v[2]!, 0]), [-q[0]!, -q[1]!, -q[2]!, q[3]!]); return [p[0]!, p[1]!, p[2]!]; };
const worldOf = (id: string): { p: number[]; q: number[]; s: number[] } => {
  const e = ents[id]!, t = e.components.transform ?? {}, lp = t.position ?? [0, 0, 0], lq = t.rotation ?? [0, 0, 0, 1], ls = t.scale ?? [1, 1, 1];
  if (!e.parent || !ents[e.parent]) return { p: lp, q: lq, s: ls };
  const w = worldOf(e.parent), r = qrot(w.q, [lp[0]! * w.s[0]!, lp[1]! * w.s[1]!, lp[2]! * w.s[2]!]);
  return { p: [w.p[0]! + r[0]!, w.p[1]! + r[1]!, w.p[2]! + r[2]!], q: qmul(w.q, lq), s: [w.s[0]! * ls[0]!, w.s[1]! * ls[1]!, w.s[2]! * ls[2]!] };
};
const prefabSize = new Map<string, [number, number, number] | null>();
const sizeOf = (pid: string): [number, number, number] | null => {
  if (!prefabSize.has(pid)) {
    const f = path.join(proj, "assets", "prefabs", `${pid}.json`);
    let s: [number, number, number] | null = null;
    try { const doc = readJ<{ root?: string; entities: Record<string, Ent & { components: { dressing?: unknown } }> }>(f); const root = Object.values(doc.entities).find((e) => (e.components as { dressing?: unknown }).dressing); if (root) s = dressingSchema.parse((root.components as { dressing: unknown }).dressing).size as [number, number, number]; } catch { /* not a dressed prop */ }
    prefabSize.set(pid, s);
  }
  return prefabSize.get(pid)!;
};
const FIRE = /hearth|bonfire|fire-pit|campfire|giant-fire/, TENT = /tent|hut|shack|lean-to/;
const blockers: Array<SiteBlocker & { prefab: string }> = [];
for (const [id, e] of Object.entries(ents)) {
  const pid = e.components.prefab?.prefabId;
  if (!pid || !(e.tags ?? []).includes(`poi:${poi}`)) continue;
  const size = sizeOf(pid);
  if (!size) continue;
  const w = worldOf(id), q = w.q, yaw = Math.atan2(2 * (q[3]! * q[1]! + q[0]! * q[2]!), 1 - 2 * (q[1]! * q[1]! + q[2]! * q[2]!));
  blockers.push({ id: id.replace(new RegExp(`^${prefix}-`), ""), prefab: pid, centre: [w.p[0]!, w.p[2]!], half: [(size[0] * Math.abs(w.s[0]!)) / 2, (size[2] * Math.abs(w.s[2]!)) / 2], yaw });
}

// ---- named points, kept-clear routes and discs
const recipe = readJ<{ features: { roads?: Array<{ id: string; width?: number; role?: string; points: number[][] }>; passages?: Array<{ id: string; start: number[]; axis: "x" | "z"; direction: number; length: number; width: number }> } }>(path.join(proj, "assets", "worlds", `${scene}.json`));
const own = handoffs.map((h) => h.siteDressing ?? {});
const anchors: SiteAnchorIn[] = [];
const hearths = blockers.filter((b) => FIRE.test(b.prefab));
for (const h of hearths) anchors.push({ id: h.id, kind: "hearth", at: h.centre, radius: Math.max(...h.half) });
for (const t of blockers.filter((b) => TENT.test(b.prefab))) {
  const near = hearths.slice().sort((a, b) => Math.hypot(a.centre[0] - t.centre[0], a.centre[1] - t.centre[1]) - Math.hypot(b.centre[0] - t.centre[0], b.centre[1] - t.centre[1]))[0];
  if (!near) continue;
  const d = [near.centre[0] - t.centre[0], near.centre[1] - t.centre[1]], l = Math.hypot(d[0]!, d[1]!) || 1, f: P2 = [d[0]! / l, d[1]! / l];
  // the footprint's extent along f: the rectangle's support distance
  const c = Math.cos(t.yaw), s = Math.sin(t.yaw), ext = Math.abs(f[0] * c - f[1] * s) * t.half[0] + Math.abs(f[0] * s + f[1] * c) * t.half[1];
  anchors.push({ id: `${t.id}-door`, kind: "door", at: [t.centre[0] + f[0] * (ext + 0.5), t.centre[1] + f[1] * (ext + 0.5)], facing: f });
}
const keep: SiteKeep[] = [];
const passages = (recipe.features.passages ?? []).filter((p) => p.id.startsWith(`${prefix}-`));
for (const p of passages) {
  const a = xz(p.start), u: P2 = p.axis === "x" ? [p.direction, 0] : [0, p.direction];
  keep.push({ id: p.id, why: "portal/cave passage", points: [a, [a[0] + u[0] * p.length, a[1] + u[1] * p.length]], width: p.width });
  if (/mouth|door/.test(p.id)) anchors.push({ id: p.id.replace(`${prefix}-`, ""), kind: "cave-mouth", at: a, facing: [-u[0], -u[1]] });
}
for (const h of handoffs) {
  for (const c of [...(h.sitePacks?.clearings ?? []), ...(h.sitePacks?.newClearings ?? [])]) keep.push({ id: c.id, why: "creature-pack clearing", points: [xz(c.centre)], radius: c.radius ?? 8 });
  for (const n of h.sitePacks?.namedSpots ?? []) if (n.at) keep.push({ id: n.creature, why: "quest/named spot", points: [xz(n.at)], radius: n.radius ?? 6 });
}
for (const o of own) {
  anchors.push(...(o.anchors ?? []));
  for (const k of o.keepClear ?? []) keep.push({ id: k.id, why: k.why ?? "kept clear by the owner", points: k.points ?? [k.at!], ...(k.points ? { width: k.width ?? 2 } : { radius: k.radius ?? 2 }) });
}
let areas: SiteArea[] = own.flatMap((o) => o.areas ?? []);
if (!areas.length) areas = hearths.map((h) => ({ id: h.id, role: "camp", centre: h.centre, radius: 14 }));
if (opt("area")) areas = areas.filter((a) => a.id === opt("area"));
if (!areas.length) { console.error("no areas: declare handoff.json siteDressing.areas (or the POI has no hearth)"); process.exit(2); }
const lo: P2 = [Math.min(...areas.map((a) => a.centre[0] - a.radius)) - 20, Math.min(...areas.map((a) => a.centre[1] - a.radius)) - 20];
const hi: P2 = [Math.max(...areas.map((a) => a.centre[0] + a.radius)) + 20, Math.max(...areas.map((a) => a.centre[1] + a.radius)) + 20];
for (const r of recipe.features.roads ?? []) {
  if (r.role === "none") continue;   // paint-only strips (spoil, grit, a worn yard) are ground colour, not walking routes
  const pts = r.points.map((p) => [p[0]!, p[p.length - 1]!] as P2);
  if (pts.some((p) => p[0] > lo[0] && p[0] < hi[0] && p[1] > lo[1] && p[1] < hi[1])) keep.push({ id: r.id, why: "walking route", points: pts, width: r.width ?? 4 });
}

// ---- boot the real ground (read only)
const events = defaultEvents();
const scripts = defaultScripts(events);
await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
const world = await HeadlessWorld.create({ doc: sceneDoc, assets: content.assets, registry: defaultRegistry(), events, scripts, exclude: (_id, e) => e.tags.includes("player") || e.tags.includes("npc") });
const voxel = resolveServerVoxelWorld(world.base);
if (!voxel) throw new Error("scene has no voxel world");
const terrain = new TerrainStreamer(world, voxel, { pool: false });
const mid: P2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
terrain.ensureAround(mid[0], mid[1], Math.ceil(Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 64) + 1);
for (let i = 0; i < 30; i++) world.step?.();
const fld = terrain.resolved.field as unknown as { height(x: number, z: number): number; waterY(x: number, z: number): number | null };
const sampler = {
  ground: (x: number, z: number): number | null => { const h = world.sim.raycast([x, fld.height(x, z) + 0.3, z], [0, -1, 0], 3, { solid: true }); return h ? h.point[1] : fld.height(x, z); },
  top: (x: number, z: number): number | null => { const h = world.sim.raycast([x, fld.height(x, z) + 30, z], [0, -1, 0], 60, { solid: true }); return h ? h.point[1] : null; },
  water: (x: number, z: number): number | null => fld.waterY(x, z),
};

const outDir = path.join(proj, "authoring", "dressing", "sockets");
fs.mkdirSync(outDir, { recursive: true });
console.log(`${poi}: ${blockers.length} built footprints, ${anchors.length} named points, ${keep.length} kept-clear routes/discs (scene ${scene}, read only)`);
// an area with `floorY` is a chamber under the ground (a cave floor): sample from just above that floor; its `room`
// (the chamber's passage id) is the room being dressed, not a kept-clear route
const caveSampler = (fy: number) => ({ ...sampler,
  ground: (x: number, z: number): number | null => { const h = world.sim.raycast([x, fy + 1.5, z], [0, -1, 0], 3.5, { solid: true }); return h ? h.point[1] : null; },
  top: (x: number, z: number): number | null => { const h = world.sim.raycast([x, fy + 3.2, z], [0, -1, 0], 6, { solid: true }); return h ? h.point[1] : null; },
  water: (): number | null => null });
for (const area of areas) {
  const id = `${poi}-${area.id}`;
  const { floorY: fy, room } = area as SiteArea & { floorY?: number; room?: string };
  // under ground only the cave's own passages, quest spots and pack clearings apply (surface routes run over its roof)
  const areaKeep = keep.filter((q) => q.id !== room && (fy == null || ["portal/cave passage", "quest/named spot", "creature-pack clearing"].includes(q.why)));
  const { map, report } = buildSiteSocketMap({ id, source: `${path.relative(proj, job).replaceAll("\\", "/")} handoff (site ${area.role}, measured on scene ${scene})`, areas: [area], anchors, keep: areaKeep, blockers }, fy != null ? caveSampler(fy) : sampler);
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(map) + "\n");
  const r = report[0]!, lv = map.levels[0]!;
  console.log(`  ${id}  role ${area.role}  open ${r.open} m2  walls ${lv.walls.length}  anchors ${Object.entries(r.anchors).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  console.log(`    refused cells: ${JSON.stringify(r.refused)}`);
  console.log(`    menu: npx tsx tools/props.mts menu --project ${project} --map ${id} --room ${area.id} --role ${area.role}`);
}
process.exit(0);
