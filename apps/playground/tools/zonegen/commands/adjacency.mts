/**
 * zonegen adjacency <world> --project <p> — which zones touch, over what, and which towns each holds.
 *
 * Procedural, from the recipe only (no world field): shared borders from @hitreg/core's `allSharedBorders`, the
 * `pass`-tagged POIs standing on each border, and every road/path/trail whose polyline steps from one zone into the
 * other. Writes adjacency.json, which every later lint reads instead of re-deriving geometry.
 */
import { allSharedBorders } from "@hitreg/core";
import { exists, finish, loadRecipe, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import { distToPolyline, err, MIN_BORDER, warn, inZone, wildZones, zoneTowns, type Adjacency, type Border } from "./_shared.mts";

/** A pass POI belongs to a border when it stands within this many metres of both zones' outlines. */
const PASS_REACH = 60;

export async function run(ctx: Ctx): Promise<number> {
  const findings: Finding[] = [];
  const recipe = loadRecipe(ctx.paths);
  const wild = wildZones(recipe);
  if (wild.length === 0) err(findings, "no-zones", "the recipe has no wilderness zones (regions without `within`): run `worldgen zones` and the zone-setup skill first");

  const borders = new Map<string, Border>();
  const key = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const borderFor = (a: string, b: string): Border => {
    const k = key(a, b);
    let x = borders.get(k);
    if (!x) borders.set(k, (x = { a: a < b ? a : b, b: a < b ? b : a, length: 0, passes: [], paths: [] }));
    return x;
  };
  const chains = allSharedBorders(wild);
  for (const chain of chains) borderFor(chain.a, chain.b).length += chain.length;

  // a pass belongs to the ONE border it stands on: the chain whose samples come nearest, within PASS_REACH, and only
  // a border long enough to hold a pass (a corner touch of a few metres never carries one)
  for (const poi of recipe.features.pois) {
    if (!poi.tags.includes("pass")) continue;
    const [x, , z] = poi.position;
    let best: { k: string; d: number } | null = null;
    for (const chain of chains) {
      const b = borders.get(key(chain.a, chain.b))!;
      if (b.length < MIN_BORDER) continue;
      const d = distToPolyline(x, z, chain.samples.map((s) => [s.x, s.z] as const));
      if (d <= PASS_REACH && (!best || d < best.d)) best = { k: key(chain.a, chain.b), d };
    }
    if (best) borders.get(best.k)!.passes.push(poi.id);
  }

  for (const road of recipe.features.roads) {
    let last: string | null = null;
    const crossed = new Set<string>();
    for (const [x, z] of road.points) {
      const here = wild.find((r) => inZone(r, x, z))?.id ?? null;
      if (here && last && here !== last) crossed.add(key(here, last));
      if (here) last = here;
    }
    for (const k of crossed) {
      const [a, b] = k.split("|") as [string, string];
      borderFor(a, b).paths.push(road.id);
    }
  }

  const list = [...borders.values()].sort((p, q) => p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  for (const b of list) {
    b.length = Math.round(b.length);
    if (b.length < MIN_BORDER) b.short = true;
    b.passes = [...new Set(b.passes)];
  }
  const adjacency: Adjacency = {
    world: ctx.world,
    at: new Date().toISOString(),
    zones: wild.map((r) => ({
      id: r.id,
      name: r.name,
      ...(r.level ? { level: r.level } : {}),
      towns: zoneTowns(recipe, r.id),
      neighbours: list.filter((b) => b.a === r.id || b.b === r.id).map((b) => (b.a === r.id ? b.b : b.a)).sort(),
    })),
    borders: list,
  };
  // rewrite only when something changed: the file is a planning input, and a fresh timestamp alone would make every
  // downstream gate and the freeze STALE
  const same = exists(ctx.paths.adjacency) && JSON.stringify({ ...(readJson(ctx.paths.adjacency) as Adjacency), at: "" }) === JSON.stringify({ ...adjacency, at: "" });
  if (!same) writeJson(ctx.paths.adjacency, adjacency);

  const orphanTowns = recipe.regions.filter((r) => r.within !== undefined && !wild.some((w) => w.id === r.within));
  for (const t of orphanTowns) err(findings, "orphan-town-zone", `town zone ${t.id} is within "${t.within}", which is not a wilderness zone`, t.id);
  const claims = new Map<string, string[]>();
  for (const r of recipe.regions) if (r.within !== undefined && r.landmarks[0]) claims.set(r.landmarks[0], [...(claims.get(r.landmarks[0]) ?? []), r.id]);
  for (const [town, zones] of claims)
    if (zones.length > 1) warn(findings, "town-claimed-twice", `town ${town} is landmarks[0] of ${zones.length} town zones (${zones.join(", ")}): counted in each parent; fix the recipe's town zones`, town);

  console.log(`${ctx.world}: ${wild.length} zones, ${list.length} borders, ${adjacency.zones.reduce((n, z) => n + z.towns.length, 0)} towns`);
  console.log(`  ${"zone".padEnd(14)} ${"name".padEnd(22)} towns${" ".repeat(30)} neighbours`);
  for (const z of adjacency.zones) {
    const towns = z.towns.map((t) => `${t.id}:${t.tier[0]}`).join(" ");
    console.log(`  ${z.id.padEnd(14)} ${z.name.slice(0, 22).padEnd(22)} ${towns.padEnd(35).slice(0, 35)} ${z.neighbours.join(" ")}`);
  }
  const closed = list.filter((b) => b.passes.length === 0 && b.paths.length === 0 && !b.short);
  console.log(`  borders with a path across: ${list.filter((b) => b.paths.length).length}; with a pass POI: ${list.filter((b) => b.passes.length).length}; sealed (neither): ${closed.length}; corner touches under ${MIN_BORDER} m: ${list.filter((b) => b.short).map((b) => `${b.a}/${b.b} ${b.length} m`).join(", ") || "none"}`);
  return finish({ ...ctx, zone: "" }, "adjacency", [ctx.paths.recipe], findings);
}
