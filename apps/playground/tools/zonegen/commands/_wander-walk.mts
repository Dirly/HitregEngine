/**
 * Wanderer proof: does a player crossing a zone MEET wandering mobs? (owner ruling 2026-10-22: "I want to SEE
 * wandering mobs"). Boots the scene the way the dedicated server does (tools/_server-boot.mts + the server's own
 * NpcManager and SpawnAreaManager, so roaming areas fill and walk exactly as live), then walks the real player body
 * along each leg (a recipe road, or a straight line) at run speed and counts what it meets:
 *
 *   npx tsx tools/zonegen/commands/_wander-walk.mts --project skelmorrow --scene skelmorrow --zone hagsheer \
 *     --road path-town-1-town-2,path-town-1-town-2.s2 --line -2400,-420:-2060,-1640 [--meet 45] [--out <json>]
 *
 * A solo met = a roll of a solo area (every mix row a single); a "wandering pack met" = one spawn roll of a roaming area (`placement` route / anywhere: members that appeared in the
 * same tick within 10 m of each other) with a living member within --meet metres of the walker. A camp met = a `pack`
 * area with a living member that close. Every creature met is checked for a capsule body (a placeholder template).
 * The walker is immortal (hp topped up): this measures encounters, not combat. --seconds caps each leg (default 900). No world clock runs headless, so
 * `hours`-gated areas (bats) count as always out.
 */
import fs from "node:fs";
import path from "node:path";
import { NpcManager, SpawnAreaManager } from "../../../../../packages/server/src/index.ts";
import { bootServerBody, type P3 } from "../../_server-boot.mts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] ?? d : d);
const project = opt("project", "skelmorrow");
const scene = opt("scene", project);
const zone = opt("zone", "");
const meet = Number(opt("meet", "45"));
const out = opt("out", "");
const t0 = Date.now();

const b = await bootServerBody({ playground: path.resolve("."), scene, peer: "wander-walker", terrainCache: true, log: () => {} });
const npcs = new NpcManager(b.server, { respawnSeconds: 20 });
const spawnAreas = new SpawnAreaManager(b.server, npcs);
const world = b.world;
const recipe = b.terrain.resolved.field.recipe;
const ground = (x: number, z: number): number => b.terrain.groundHeight(x, z);
const pos = (): P3 => world.positionOf(b.bodyId)!;
const net = world.netState as unknown as { get(k: string): unknown; set(k: string, v: unknown): boolean };
const alive = (id: string): boolean => world.entities.has(id) && net.get(`combat/${id}.dead`) !== true;
const roaming = [...spawnAreas.areas.values()].filter((a) => a.roaming);
/** A solo area: every roll is one creature (spawnArea mix rows of count [1,1], no companions). */
const soloArea = new Set(roaming.filter((a) => (a.data.mix ?? []).length > 0 && (a.data.mix ?? []).every((m) => m.count[1] === 1 && !(m.with ?? []).length)).map((a) => a.id));
const packs = [...spawnAreas.areas.values()].filter((a) => !a.roaming && (!zone || world.entities.get(a.id)?.tags.includes(`zone:${zone}`)));
console.log(`booted ${scene} in ${Date.now() - t0} ms: ${spawnAreas.areas.size} spawn areas (${roaming.length} roaming), ${npcs.list().length} NPCs`);

// ---- what a creature is
const capsuleTemplate = (tpl: string): boolean => {
  const e = world.expanded.entities[tpl] as { tags?: string[]; components?: Record<string, { source?: { shape?: string } }> } | undefined;
  return !!e && ((e.tags ?? []).includes("placeholder") || e.components?.["mesh"]?.source?.shape === "capsule");
};

// ---- roll bookkeeping: an id's first tick and spot; a roll = same area, same tick, within 10 m
const firstSeen = new Map<string, { tick: number; at: P3; area: string; roll: string }>();
let tickNo = 0;
const noteSpawns = (): void => {
  for (const a of roaming)
    for (const id of a.npcIds) {
      if (firstSeen.has(id)) continue;
      const at = world.positionOf(id);
      if (!at) continue;
      const mate = [...firstSeen.values()].find((s) => s.area === a.id && s.tick === tickNo && Math.hypot(s.at[0] - at[0], s.at[2] - at[2]) < 10);
      firstSeen.set(id, { tick: tickNo, at: [at[0], at[1], at[2]], area: a.id, roll: mate?.roll ?? `${a.id}@${tickNo}#${id}` });
    }
};

interface Leg { name: string; points: Array<[number, number]> }
const legs: Leg[] = [];
for (const spec of opt("road", "").split(";").filter(Boolean)) {
  const ids = spec.split(",");
  const pts: Array<[number, number]> = [];
  for (const id of ids) {
    const r = recipe.features.roads.find((x) => x.id === id);
    if (!r) throw new Error(`no road ${id}`);
    for (const q of r.points) pts.push([q[0]!, q[1]!]);
  }
  // inside the zone only (a road leaves it at the pass)
  const region = recipe.regions.find((r) => r.id === zone && r.within === undefined);
  const inZone = (x: number, z: number): boolean => {
    if (!region) return true;
    let c = false;
    const poly = region.polygon;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  legs.push({ name: `road ${spec}`, points: pts.filter(([x, z]) => inZone(x, z)) });
}
for (const spec of opt("line", "").split(";").filter(Boolean)) {
  const [a, c] = spec.split(":").map((s) => s.split(",").map(Number) as [number, number]);
  legs.push({ name: `line ${spec}`, points: [a!, c!] });
}
if (!legs.length) throw new Error("give --road <ids> and/or --line x,z:x,z");

const results: Array<Record<string, unknown>> = [];
for (const leg of legs) {
  const start = leg.points[0]!;
  b.holdAt([start[0], ground(start[0], start[1]) + 1.5, start[1]], 3600, 30);
  const metPacks = new Map<string, { area: string; creatures: Set<string>; at: P3; templates: Set<string> }>();
  const metCamps = new Map<string, Set<string>>();
  const capsules = new Set<string>();
  let metres = 0;
  let k = 1;
  let last = pos();
  let stuckFor = 0;
  const maxTicks = 60 * Number(opt("seconds", "900"));
  let t = 0;
  for (; t < maxTicks && k < leg.points.length; t++) {
    const p = pos();
    const target = leg.points[k]!;
    const dx = target[0] - p[0], dz = target[1] - p[2], l = Math.hypot(dx, dz);
    if (l < 3) { k++; continue; }
    b.stepWith([dx / l, dz / l], false);
    tickNo++;
    noteSpawns();
    const q = pos();
    const moved = Math.hypot(q[0] - last[0], q[2] - last[2]);
    metres += moved;
    last = q;
    // stuck (a wall, a bank): nudge the body 2 m along the leg rather than measure a standstill
    stuckFor = moved < 0.02 ? stuckFor + 1 : 0;
    if (stuckFor > 90) {
      const nx = q[0] + (dx / l) * 2, nz = q[2] + (dz / l) * 2;
      world.sim.setPosition(b.bodyId, [nx, ground(nx, nz) + 1.5, nz]);
      last = pos();
      stuckFor = 0;
    }
    if (t % 10) continue;
    for (const a of roaming)
      for (const id of a.npcIds) {
        if (!alive(id)) continue;
        const at = world.positionOf(id);
        if (!at || Math.hypot(at[0] - q[0], at[2] - q[2]) > meet) continue;
        const roll = firstSeen.get(id)?.roll ?? `${a.id}@?#${id}`;
        const m = metPacks.get(roll) ?? { area: a.id, creatures: new Set<string>(), at: [Math.round(at[0]), Math.round(at[1]), Math.round(at[2])] as P3, templates: new Set<string>() };
        m.creatures.add(id);
        const tpl = npcs.npcs.get(id)?.template ?? "";
        m.templates.add(tpl);
        if (capsuleTemplate(tpl)) capsules.add(tpl);
        metPacks.set(roll, m);
      }
    for (const a of packs)
      for (const id of a.npcIds) {
        if (!alive(id)) continue;
        const at = world.positionOf(id);
        if (!at || Math.hypot(at[0] - q[0], at[2] - q[2]) > meet) continue;
        const s = metCamps.get(a.id) ?? new Set<string>();
        s.add(id);
        metCamps.set(a.id, s);
        const tpl = npcs.npcs.get(id)?.template ?? "";
        if (capsuleTemplate(tpl)) capsules.add(tpl);
      }
  }
  const km = metres / 1000;
  const row = {
    leg: leg.name,
    metres: Math.round(metres),
    seconds: Math.round(t / 60),
    finished: k >= leg.points.length,
    solosMet: [...metPacks.values()].filter((m) => soloArea.has(m.area)).length,
    metresPerSolo: Math.round(metres / Math.max(1, [...metPacks.values()].filter((m) => soloArea.has(m.area)).length)),
    packsMet: [...metPacks.values()].filter((m) => !soloArea.has(m.area)).length,
    wanderingPacksMet: metPacks.size,
    wanderingPacksPerKm: Math.round((metPacks.size / Math.max(0.01, km)) * 10) / 10,
    wanderingCreaturesMet: [...metPacks.values()].reduce((n, m) => n + m.creatures.size, 0),
    campsMet: metCamps.size,
    campsPerKm: Math.round((metCamps.size / Math.max(0.01, km)) * 10) / 10,
    capsules: [...capsules],
    packs: [...metPacks.values()].map((m) => ({ area: m.area, at: m.at, size: m.creatures.size, templates: [...m.templates] })),
  };
  results.push(row);
  console.log(`${leg.name}: ${row.metres} m in ${row.seconds} s${row.finished ? "" : " (NOT finished)"}; solos met ${row.solosMet} (one per ${row.metresPerSolo} m), roaming packs met ${row.packsMet}; all wandering rolls ${row.wanderingPacksMet} (${row.wanderingPacksPerKm}/km, ${row.wanderingCreaturesMet} creatures); camps met ${row.campsMet} (${row.campsPerKm}/km); capsules ${row.capsules.length}`);
  for (const m of row.packs) console.log(`   ${m.area} at [${m.at.join(", ")}] x${m.size}: ${m.templates.join(", ")}`);
}
if (out) fs.writeFileSync(out, JSON.stringify({ scene, zone, meet, at: new Date().toISOString(), legs: results }, null, 2) + "\n");
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(0);
