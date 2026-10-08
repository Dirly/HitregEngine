/**
 * `worldgen vegetation <world>` — what grows in a REGION, and CLEARINGS.
 *
 *   worldgen vegetation <world>                                  report: every region's vegetation, its resolved plan, clearings
 *   worldgen vegetation <world> --region <id> --set <json|file>  set regions[id].vegetation (schema-validated)
 *   worldgen vegetation <world> --region <id> --clear            remove it
 *   worldgen vegetation <world> --clearings <file>               upsert clearings by id (a JSON array, or { "clearings": [...] })
 *   worldgen vegetation <world> --remove-clearings <owner|id,..> remove clearings by owner or id
 *   worldgen vegetation <world> --region <id> --count            solve the region's cells and tally scatter per rule
 *   worldgen vegetation <world> --at x,z                         the plan and clearing keep at one point
 *   add --dry-run to any write to validate and print without writing.
 *
 * The data is `regions[].vegetation` and `features.clearings` (core vegetation.ts,
 * docs/voxel-worlds.md section 31). Scatter, the server's colliders and the
 * cover sampler all read it, so nothing else needs re-running after a write.
 */
import fs from "node:fs";
import {
  clearingSchema,
  createWorldField,
  pointInPolygon,
  regionVegetationSchema,
  scatterCell,
  vegetationIndex,
  type WorldRecipe,
} from "@hitreg/core";

export interface VegetationHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
}

/** JSON from an inline string or a file path. */
function readJson(host: VegetationHost, value: string): unknown {
  const text = value.trim().startsWith("{") || value.trim().startsWith("[") ? value : fs.readFileSync(value, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    host.fail(`not JSON: ${value} (${(error as Error).message})`);
  }
}

export function commandVegetation(host: VegetationHost): void {
  const { argv } = host;
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const dry = has("dry-run") || has("dry");
  const { recipe, file } = host.loadRecipe();
  const regionId = opt("region");
  const region = regionId ? (recipe.regions.find((r) => r.id === regionId) ?? host.fail(`no region "${regionId}"`)) : null;
  let wrote = false;

  if (region && (has("set") || has("clear"))) {
    if (has("clear")) delete region.vegetation;
    else {
      const parsed = regionVegetationSchema.safeParse(readJson(host, opt("set") ?? host.fail("--set needs a JSON value or file")));
      if (!parsed.success) host.fail(`invalid vegetation for ${region.id}:\n${parsed.error.message}`);
      region.vegetation = parsed.data;
    }
    wrote = true;
  }
  const clearingsArg = opt("clearings");
  if (clearingsArg) {
    const raw = readJson(host, clearingsArg) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { clearings?: unknown[] }).clearings ?? host.fail("--clearings: expected an array or { clearings: [...] }");
    const parsed = list.map((c, i) => {
      const r = clearingSchema.safeParse(c);
      if (!r.success) host.fail(`clearing ${i}: ${r.error.message}`);
      return r.data;
    });
    const ids = new Set(parsed.map((c) => c.id));
    recipe.features.clearings = [...(recipe.features.clearings ?? []).filter((c) => !ids.has(c.id)), ...parsed];
    console.log(`clearings: upserted ${parsed.length} (${recipe.features.clearings.length} total)`);
    wrote = true;
  }
  const removeArg = opt("remove-clearings");
  if (removeArg) {
    const keys = new Set(removeArg.split(","));
    const before = recipe.features.clearings?.length ?? 0;
    recipe.features.clearings = (recipe.features.clearings ?? []).filter((c) => !keys.has(c.id) && !(c.owner && keys.has(c.owner)));
    console.log(`clearings: removed ${before - recipe.features.clearings.length}`);
    wrote = true;
  }

  // report (always, after any edit, so a dry run shows what it would write)
  const index = vegetationIndex(recipe);
  const ruleIds = recipe.scatter.map((r) => r.id);
  const layerIds = recipe.cover.map((l) => l.id);
  for (const [i, r] of recipe.regions.entries()) {
    const plan = index.plans[i];
    if (!plan) continue;
    const own = r.vegetation ? "own" : `inherits ${r.within}`;
    const swaps = ruleIds.map((id, k) => (plan.replace[k] !== k ? `${id}->${ruleIds[plan.replace[k]!]}` : "")).filter(Boolean);
    const thinned = ruleIds.map((id, k) => (plan.ruleKeep[k] !== 1 ? `${id} x${plan.ruleKeep[k]!.toFixed(2)}` : "")).filter(Boolean);
    const cover = layerIds.map((id, k) => (plan.layerKeep[k] !== 1 ? `${id} x${plan.layerKeep[k]!.toFixed(2)}` : "")).filter(Boolean);
    console.log(`${r.id.padEnd(22)} (${own})${r.vegetation?.note ? ` "${r.vegetation.note}"` : ""}`);
    if (swaps.length) console.log(`    swap   ${swaps.join(", ")}`);
    if (thinned.length) console.log(`    scatter ${thinned.join(", ")}`);
    if (cover.length) console.log(`    cover  ${cover.join(", ")}`);
    if (plan.lean) console.log(`    lean   ${((plan.lean.radians * 180) / Math.PI).toFixed(0)} deg`);
  }
  const clearings = recipe.features.clearings ?? [];
  if (clearings.length) {
    const owners = new Map<string, number>();
    for (const c of clearings) owners.set(c.owner ?? "(no owner)", (owners.get(c.owner ?? "(no owner)") ?? 0) + 1);
    console.log(`clearings: ${clearings.length} — ${[...owners].map(([o, n]) => `${o} ${n}`).join(", ")}`);
  }
  for (const w of index.warnings) console.log(`WARNING ${w}`);
  if (!index.hasPlans && !clearings.length) console.log("no region vegetation and no clearings: the biomes decide everywhere");

  const at = opt("at");
  if (at) {
    const [x, z] = at.split(",").map(Number) as [number, number];
    const plan = index.planAt(x, z);
    console.log(`at ${x},${z}: region plan ${plan?.region ?? "none"}; clearing keep scatter ${index.clearingKeep(x, z, 0).toFixed(2)}, cover ${index.clearingKeep(x, z, 1).toFixed(2)}`);
  }

  if (region && has("count")) {
    const field = createWorldField(recipe);
    const size = recipe.cellSize;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of region.polygon) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const tally = new Map<string, number>();
    let cells = 0;
    for (let cz = Math.floor(z0 / size); cz <= Math.floor(z1 / size); cz++) {
      for (let cx = Math.floor(x0 / size); cx <= Math.floor(x1 / size); cx++) {
        cells++;
        for (const inst of scatterCell(field, cx, cz, { fastGround: true })) {
          if (!pointInPolygon(inst.position[0] + cx * size, inst.position[2] + cz * size, region.polygon)) continue;
          tally.set(inst.rule, (tally.get(inst.rule) ?? 0) + 1);
        }
      }
    }
    console.log(`${region.id}: ${cells} cells solved; scatter inside the polygon: ${[...tally].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ") || "none"}`);
  }

  if (wrote) {
    if (dry) console.log("(dry run: nothing written)");
    else host.writeRecipe(recipe, file);
  }
}
