/**
 * sea-wrecks — sink ship wrecks on a world's sea bed, spread along the coast, as ONE ops batch.
 *
 *   npx tsx tools/sea-wrecks.mts --project <p> --scene <id> --world <recipe id> [--count 8] [--depth 10,18] [--dry]
 *
 * Sites: every 30 m grid point whose bed is inside --depth, gently sloped and within 260 m of the shore is a
 * candidate; candidates within 240 m of a POI root are dropped (a place owns its own wrecks), then the sites are
 * picked farthest-point-first so they spread round the whole coast. Each site gets one of three layouts (a barque
 * broken in two, a whole barque on its side, a cutter with its bow torn off), each hull leaning and sunk 0.5 m into
 * the sand under its lowest sampled footprint point.
 *
 * Re-running replaces the previous set (entities tagged `sea-wreck`); the inverse batch is saved under
 * authoring/installs/sea-wrecks-<scene>.inverse.json (overwritten).
 */
import fs from "node:fs";
import path from "node:path";
import { ComponentRegistry, applyOps, createWorldField, registerCoreComponents, worldRecipeSchema, type Op, type SceneDoc } from "@hitreg/core";
import { applyOpsToSceneFile } from "./_scene-write.mts";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const project = opt("project"), sceneId = opt("scene"), worldId = opt("world");
if (!project || !sceneId || !worldId) {
  console.error("usage: sea-wrecks --project <p> --scene <id> --world <recipe id> [--count 8] [--depth 10,18] [--dry]");
  process.exit(2);
}
const count = Number(opt("count") ?? 8);
const [dMin, dMax] = (opt("depth") ?? "10,18").split(",").map(Number) as [number, number];
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const projectDir = path.resolve(here, "..", "projects", project);
const sceneFile = path.join(projectDir, "assets", "scenes", `${sceneId}.scene.json`);
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(path.join(projectDir, "assets", "worlds", `${worldId}.json`), "utf8")));
const field = createWorldField(recipe);
const sea = recipe.seaLevel;
const scene = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
const ents = scene.entities as Record<string, { parent: string | null; tags?: string[]; components: Record<string, any> }>;

// ---- sites ----
const pois = Object.values(ents).filter((e) => e.parent == null && (e.tags ?? []).includes("poi")).map((e) => e.components.transform?.position as [number, number, number]).filter(Boolean);
const limit = (recipe.bounds as any)?.limit ?? 4000;
type Site = { x: number; z: number; depth: number };
const cands: Site[] = [];
for (let x = -limit; x <= limit; x += 30)
  for (let z = -limit; z <= limit; z += 30) {
    const h = field.height(x, z), depth = sea - h;
    if (depth < dMin || depth > dMax) continue;
    if (field.shoreDistance(x, z) > 260) continue;
    let rough = 0;
    for (const [ox, oz] of [[14, 0], [-14, 0], [0, 14], [0, -14]] as const) rough = Math.max(rough, Math.abs(field.height(x + ox, z + oz) - h));
    if (rough > 3.2) continue;
    if (pois.some((p) => Math.hypot(p[0] - x, p[2] - z) < 240)) continue;
    cands.push({ x, z, depth });
  }
if (!cands.length) { console.error("no sea bed fits"); process.exit(1); }
// farthest-point pick, seeded at the candidate nearest the world's east end so the order is stable
const picked: Site[] = [cands.reduce((a, b) => (b.x > a.x ? b : a))];
while (picked.length < count) {
  let best: Site | null = null, bestD = -1;
  for (const c of cands) {
    const d = Math.min(...picked.map((p) => Math.hypot(p.x - c.x, p.z - c.z)));
    if (d > bestD) { bestD = d; best = c; }
  }
  if (!best || bestD < 200) break;
  picked.push(best);
}

// ---- layouts ----
const rnd = (i: number, k: number) => { const s = Math.sin((i + 1) * 127.1 + k * 311.7 + recipe.seed * 0.013) * 43758.5453; return s - Math.floor(s); };
/** yaw about Y, then roll about the hull's own long (Z) axis. */
const quat = (yaw: number, roll: number): [number, number, number, number] => {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  return [-sy * sr, sy * cr, cy * sr, cy * cr].map((v) => +v.toFixed(6)) as [number, number, number, number];
};
type Piece = { name: string; prefab: string; dx: number; dz: number; yaw: number; roll: number; half: number };
const layouts: ((i: number) => Piece[])[] = [
  (i) => { const yaw = rnd(i, 1) * 6.28; return [
    { name: "stern", prefab: "seagoing-ships/merchant-barque-wreck-stern", dx: 0, dz: 0, yaw, roll: 0.3 + rnd(i, 2) * 0.25, half: 8 },
    { name: "bow", prefab: "seagoing-ships/merchant-barque-wreck-bow", dx: Math.sin(yaw + 0.5) * 24, dz: Math.cos(yaw + 0.5) * 24, yaw: yaw + 0.9, roll: -(0.45 + rnd(i, 3) * 0.3), half: 7.6 },
  ]; },
  (i) => [{ name: "hull", prefab: "seagoing-ships/merchant-barque-wreck", dx: 0, dz: 0, yaw: rnd(i, 1) * 6.28, roll: (rnd(i, 2) < 0.5 ? -1 : 1) * (0.5 + rnd(i, 3) * 0.35), half: 15 }],
  (i) => { const yaw = rnd(i, 1) * 6.28; return [
    { name: "hull", prefab: "seagoing-ships/sailing-cutter-wreck", dx: 0, dz: 0, yaw, roll: 0.55 + rnd(i, 2) * 0.4, half: 6 },
    { name: "bow", prefab: "seagoing-ships/sailing-cutter-wreck-bow", dx: Math.sin(yaw - 0.7) * 11, dz: Math.cos(yaw - 0.7) * 11, yaw: yaw + 2.1, roll: -0.8, half: 3.2 },
  ]; },
];

const ops: Op[] = Object.keys(ents).filter((id) => ents[id]!.parent == null && (ents[id]!.tags ?? []).includes("sea-wreck")).map((id) => ({ op: "remove-entity", id }) as Op);
const removed = ops.length;
picked.forEach((s, i) => {
  const root = `sea-wreck-${i + 1}`, y0 = +field.height(s.x, s.z).toFixed(2);
  ops.push({ op: "add-entity", id: root, entity: { name: `sunken wreck ${i + 1}`, parent: null, tags: ["sea-wreck"], components: { transform: { position: [s.x, y0, s.z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } } } as Op);
  for (const p of layouts[i % layouts.length]!(i)) {
    const wx = s.x + p.dx, wz = s.z + p.dz, ax = Math.sin(p.yaw), az = Math.cos(p.yaw);
    let low = Infinity;
    for (const t of [-1, -0.5, 0, 0.5, 1]) low = Math.min(low, field.height(wx + ax * p.half * t, wz + az * p.half * t));
    ops.push({ op: "add-entity", id: `${root}-${p.name}`, entity: {
      name: `${p.name} (${p.prefab})`, parent: root, tags: ["sea-wreck", "wet", "held", `lean:${Math.round(Math.abs(p.roll) * 57.3)}`],
      components: { transform: { position: [+p.dx.toFixed(2), +(low - 0.5 - y0).toFixed(2), +p.dz.toFixed(2)], rotation: quat(p.yaw, p.roll), scale: [1, 1, 1] }, prefab: { prefabId: p.prefab, props: {}, overrides: [] } },
    } } as Op);
  }
  console.log(`  ${root}: (${s.x}, ${s.z}) bed ${y0} (${s.depth.toFixed(1)} m deep), layout ${i % layouts.length}`);
});
if (argv.includes("--dry")) { console.log(`--dry: ${picked.length} sites of ${cands.length} candidates, ${ops.length} ops, nothing written`); process.exit(0); }
const registry = new ComponentRegistry();
registerCoreComponents(registry);
const res = applyOpsToSceneFile(sceneFile, ops, (d, o) => applyOps(d, o, registry), { label: "sea-wrecks" });
const inverseFile = path.join(projectDir, "authoring", "installs", `sea-wrecks-${sceneId}.inverse.json`);
fs.mkdirSync(path.dirname(inverseFile), { recursive: true });
fs.writeFileSync(inverseFile, `${JSON.stringify(res.inverse, null, 1)}\n`);
console.log(`placed ${picked.length} wrecks (${removed} old roots replaced); inverse: ${path.relative(process.cwd(), inverseFile).replaceAll("\\", "/")}`);
