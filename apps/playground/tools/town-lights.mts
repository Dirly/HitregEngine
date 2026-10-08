/**
 * town-lights — every town street and every road near a town carries lanterns (docs/world-standards/towns.md, "Lights").
 *
 *   npx tsx tools/town-lights.mts apply --project <p> --town <name> [--dry]   plan from the data, install, then check
 *   npx tsx tools/town-lights.mts check --project <p> --town <name>           judge what the scene holds; exit 1 on failure
 *
 * The rule is data (tools/street-lights.json, schema + planner + gate in tools/town-lights-rule.mts; a project may
 * override it with authoring/street-lights.json). Nothing here is placed by hand: the planner reads the town's streets,
 * lanes, plazas, gates, door paths, stairs and building footprints, its dock structures (town plan `structures[].built`) and built gate passages (`structures[].built.mouths`: each mouth is lit like a gate),
 * the world roads leaving each gate, their junctions and bridge ends, and stands catalogued lit props by NAME
 * (`town-lights/lamp-post-lit`, `town-lights/hanging-lantern-lit`) on lawful ground. Same inputs, same lanterns.
 *
 * apply writes ONE ops batch through core `applyOps` (validated, atomic): it removes the town's previous lanterns (root
 * `town-<name>-lights`, tag `town-lights:<name>`) and adds the new ones, each a prefab instance tagged `lights:<kind>`
 * with its own `culling: { minScreenPx }`. The batch and its inverse go to authoring/towns/<name>-lights-ops.json.
 * Read the scene fresh right before writing: the editor and other stages write it too.
 *
 * check reads the installed lanterns back from the scene and writes the gate report authoring/towns/<name>-lights.json
 * (`zonegen status` row `town <name>: lights` reads it). Its last line is `LIGHTS <name>: ... -> ok|FAILED`.
 */
import fs from "node:fs";
import path from "node:path";
import { ComponentRegistry, applyOps, createWorldField, registerCoreComponents, worldRecipeSchema, type Op, type SceneDoc } from "@hitreg/core";
import { checkTownLights, loadStreetLighting, planTownLights, streetLightingFile, type Lantern, type LightKind, type TownLightInput } from "./town-lights-rule.mts";

type XZ = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const argv = process.argv.slice(2);
const cmd = argv.find((a) => a === "apply" || a === "check");
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const projectName = opt("project");
const townName = opt("town");
if ((cmd !== "apply" && cmd !== "check") || !projectName || !townName) {
  console.error("usage: town-lights apply|check --project <p> --town <name> [--dry]");
  process.exit(2);
}
const projectDir = path.resolve("projects", projectName);
const towns = path.join(projectDir, "authoring", "towns");
const readJson = (f: string): J => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const townDoc = readJson(path.join(towns, `${townName}.json`));
const recipeFile = path.join(projectDir, "assets", "worlds", `${townDoc.world}.json`);
const sceneFile = path.join(projectDir, "assets", "scenes", `${townDoc.scene}.scene.json`);
const rule = loadStreetLighting(projectDir);
const raw = readJson(recipeFile);
const field = createWorldField(worldRecipeSchema.parse(raw));
const tag = `town-lights:${townName}`;
const rootId = `town-${townName}-lights`;

function inputFor(scene: SceneDoc): TownLightInput {
  const t = (raw.features.towns as J[]).find((x) => x.id === townDoc.town);
  if (!t) throw new Error(`town ${townDoc.town} is not in ${path.basename(recipeFile)}`);
  const layoutFile = path.join(towns, `${townName}-layout.json`);
  const layout = fs.existsSync(layoutFile) ? readJson(layoutFile) : { buildings: [] };
  const planFile = path.join(towns, `${townName}-plan.json`);
  const plan = fs.existsSync(planFile) ? readJson(planFile) : {};
  const docks: TownLightInput["docks"] = [];
  const dockIds = new Set<string>();
  for (const s of (plan.structures ?? []) as J[]) {
    if (!["dock", "quay", "jetty", "harbour"].includes(s.kind) || !s.site?.corners) continue;
    const b = s.built ?? {};
    dockIds.add(s.id);
    docks.push({
      id: s.id, corners: s.site.corners, centre: s.site.centre ?? s.at, along: s.site.along ?? [1, 0],
      ...(b.streetJoin?.at ? { head: { at: b.streetJoin.at, y: b.streetJoin.y ?? b.deck?.y ?? s.site.groundY } } : {}),
      ...(b.deck?.along && b.deck?.across ? { deck: { y: b.deck.y, along: b.deck.along, across: b.deck.across } } : {}),
      ...(b.jetty?.root && b.jetty?.end ? { jetty: { root: b.jetty.root, end: b.jetty.end, y: b.jetty.y, width: b.jetty.width ?? 2.4 } } : {}),
    });
  }
  // what already stands in the streets: residents, landmarks, structures, quest objects (not the docks: those are lit ON)
  const obstacles: TownLightInput["obstacles"] = [];
  const R = t.radius + rule.roads.junctionReach + 50;
  for (const [id, e] of Object.entries(scene.entities) as [string, J][]) {
    if (e.parent !== null || e.tags?.includes(tag) || dockIds.has(id)) continue;
    const p = e.components?.transform?.position;
    if (!p || Math.hypot(p[0] - t.center[0], p[2] - t.center[1]) > R) continue;
    const tags: string[] = e.tags ?? [];
    if (tags.some((x) => x.startsWith("town-npc:"))) obstacles.push({ at: [p[0], p[2]], r: rule.clearance.npc, what: `resident ${id}` });
    else if (tags.some((x) => /^(town-landmark:|structure:|statue$|quest-object$)/.test(x))) obstacles.push({ at: [p[0], p[2]], r: rule.clearance.landmark, what: `landmark ${id}` });
  }
  return {
    town: { id: t.id, name: townName!, center: t.center, radius: t.radius, gates: [
      // a town gate point that lies inside its own built passage (structure of the same id, within the passage's
      // reach) is lit at the passage's mouths instead: its own pair would stand in the drums
      ...((t.gates ?? []) as J[]).filter((g) => {
        const b = ((plan.structures ?? []) as J[]).find((s) => s.id === g.id)?.built;
        return !(b?.mouths && b.at && Math.hypot(g.at[0] - b.at[0], g.at[1] - b.at[1]) < (b.reach ?? 10));
      }).map((g: J) => ({ id: g.id, at: g.at, facing: g.facing, width: g.width ?? 6 })),
      // a built gatehouse / wall gate (town plan `structures[].built.mouths`): each mouth of the passage is a gate of
      // its own, so it gets the flanking pair outside it on BOTH sides of the wall
      ...((plan.structures ?? []) as J[]).flatMap((s) => ((s.built?.mouths ?? []) as J[]).map((m, i) => ({ id: `${s.id}-mouth-${i}`, at: m.at, facing: m.facing, width: m.width ?? s.built.width ?? 6 }))),
    ] },
    roads: (raw.features.roads as J[]).map((r) => ({ id: r.id, points: r.points.map((q: number[]) => [q[0], q[1]] as XZ), width: r.width ?? 3 })),
    bridges: ((raw.features.bridges ?? []) as J[]).map((b) => ({ id: b.id, points: b.points, width: b.width ?? 6, deckY: b.deckY })),
    buildings: (layout.buildings as J[]).map((b) => ({ id: b.id, poly: b.full ?? b.corners, ...(b.door ? { door: b.door } : {}) })),
    docks,
    obstacles,
    ground: { height: (x, z) => field.height(x, z), waterY: (x, z) => field.waterY(x, z) },
  };
}

/** The lanterns the scene holds for this town, as the planner wrote them (kind/ref/deck from tags + name). */
function installedOf(scene: SceneDoc): Lantern[] {
  const out: Lantern[] = [];
  for (const [id, e] of Object.entries(scene.entities) as [string, J][]) {
    if (!e.tags?.includes(tag) || !e.components?.prefab) continue;
    const kind = (e.tags.find((x: string) => x.startsWith("lights:")) ?? "lights:street").slice(7) as LightKind;
    const ref = (e.tags.find((x: string) => x.startsWith("lights-ref:")) ?? "lights-ref:").slice(11);
    const [x, y, z] = e.components.transform.position;
    const q = e.components.transform.rotation ?? [0, 0, 0, 1];
    out.push({ id: id.slice(rootId.length + 1), prefab: e.components.prefab.prefabId, kind, ref, at: [x, y, z], yaw: 2 * Math.atan2(q[1], q[3]), ...(e.tags.includes("lights:deck") ? { deck: true } : {}) });
  }
  return out;
}

function check(scene: SceneDoc): number {
  const inp = inputFor(scene);
  const installed = installedOf(scene);
  const res = checkTownLights(inp, rule, installed);
  const report = {
    town: townName, world: townDoc.world, scene: townDoc.scene, ok: res.ok, at: new Date().toISOString(),
    rule: path.relative(projectDir, streetLightingFile(projectDir)).replaceAll("\\", "/"),
    counts: res.counts, total: installed.length, failures: res.failures,
    lanterns: installed.map((l) => ({ id: l.id, prefab: l.prefab, kind: l.kind, ref: l.ref, at: l.at.map((v) => +v.toFixed(2)) })),
  };
  fs.writeFileSync(path.join(towns, `${townName}-lights.json`), `${JSON.stringify(report, null, 1)}\n`);
  for (const f of res.failures) console.log(`  ! ${f}`);
  const tally = Object.entries(res.counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none";
  console.log(`LIGHTS ${townName}: ${installed.length} lanterns (${tally}), ${res.failures.length} failure(s) -> ${res.ok ? "ok" : "FAILED"}`);
  return res.ok ? 0 : 1;
}

const sceneNow = (): SceneDoc => readJson(sceneFile) as SceneDoc;

if (cmd === "check") process.exit(check(sceneNow()));

// apply
const scene0 = sceneNow();
const planned = planTownLights(inputFor(scene0), rule);
for (const u of planned.unplaced) console.log(`  - no lawful spot for ${u.kind} ${u.ref} near (${u.at[0].toFixed(0)}, ${u.at[1].toFixed(0)}): last refusal "${u.why}"`);
const byKind: Record<string, number> = {};
for (const l of planned.lanterns) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
console.log(`planned ${planned.lanterns.length} lanterns for ${townName}: ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")}`);
if (argv.includes("--dry")) {
  for (const l of planned.lanterns) console.log(`  ${l.id.padEnd(44)} ${l.prefab.padEnd(34)} [${l.at.map((v) => v.toFixed(1)).join(", ")}]`);
  process.exit(0);
}
const scene = sceneNow(); // fresh: the editor autosaves
const ops: Op[] = [];
for (const [id, e] of Object.entries(scene.entities) as [string, J][]) if (e.tags?.includes(tag) && (e.parent === null || !scene.entities[e.parent]?.tags?.includes(tag))) ops.push({ op: "remove-entity", id });
ops.push({ op: "add-entity", id: rootId, entity: { name: `${townDoc.name ?? townName} — street lights`, parent: null, tags: ["town-lights", tag], components: { transform: {} } } as never });
for (const l of planned.lanterns) {
  ops.push({
    op: "add-entity",
    id: `${rootId}-${l.id}`,
    entity: {
      name: `${l.kind} lantern (${l.ref})`,
      parent: rootId,
      tags: ["town-lights", tag, `lights:${l.kind}`, `lights-ref:${l.ref}`, ...(l.deck ? ["lights:deck"] : [])],
      components: {
        transform: { position: l.at, rotation: [0, +Math.sin(l.yaw / 2).toFixed(6), 0, +Math.cos(l.yaw / 2).toFixed(6)], scale: [1, 1, 1] },
        culling: { minScreenPx: 3 },
        prefab: { prefabId: l.prefab },
      },
    } as never,
  });
}
const registry = new ComponentRegistry();
registerCoreComponents(registry);
const result = applyOps(scene, ops, registry);
fs.writeFileSync(sceneFile, `${JSON.stringify(result.doc, null, 2)}\n`);
fs.writeFileSync(path.join(towns, `${townName}-lights-ops.json`), `${JSON.stringify({ ops, inverse: result.inverse }, null, 1)}\n`);
console.log(`installed into ${path.relative(process.cwd(), sceneFile)} (${ops.length} ops; inverse saved to authoring/towns/${townName}-lights-ops.json)`);
process.exit(check(result.doc as SceneDoc));
