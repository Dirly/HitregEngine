/**
 * `worldgen dogfood <world> --seeds N` — the continent generator eaten N times.
 *
 * Derek, 2026-10-28: "keep dogfooding the continent creation over and over again until it is working correctly." The
 * generator is a LOOP, not a re-tune for one seed. For each seed this runs the ALGORITHMIC chain — init --from <look>,
 * climate (the world's anchors), continents (which derives the relief), coast, rivers, towns, zones — into a scratch
 * project (`projects/dogfood/`, deleted afterwards), judges the result by the rules the status rows use, and writes ONE
 * contact sheet `authoring/dogfood/<world>-seeds.png` (every seed's map with relief, woods and lakes, its numbers under
 * it, pass/fail coloured) plus a table in the console. No key, no hand value: a seed that fails is a generator fault.
 *
 * Rules (each a number, pass/fail):
 *   relief      p05 -> p98 of the land >= RELIEF_MIN_M (100 m)
 *   upland      >= UPLAND_SHARE_MIN (15 %) of the land stands 60 m over p10
 *   silhouette  the upland's extent along its long axis / the landmass width >= SILHOUETTE_MIN (0.4): a spine, not a knot
 *   lakes       >= INTERIOR_LAKES_MIN lake(s) with the centre > 150 m from the sea
 *   woodland    >= WOODLAND_SHARE_MIN (15 %) of the land is woodland (tree rules x biome x plan)
 *   coast       `coast --check` ok (shares, runs, sheltered beaches, a cliff and a beach per zone)
 *   hydrology   the rivers audit: 0 dangling reaches, 0 lakes without a river that are not declared tarns, 0 uphill steps
 *   water       `water-logic` 0 findings (no perched sheets, no lake without an outlet)
 *   border      `regions` 0 findings (every town claimed, borders on ridge/river/coast)
 *   biomes      (A) every adjacent anchor pair legal under `climate.transitions`, wetlands by water/lowland, dry biomes
 *               on the lee; >= 3 anchors at >= 10 % of the land, none over 60 %; (B) >= 5 feature kinds of woodland /
 *               open ground / upland / lake / river / cliff coast / beach or cove / wetland / canyon / crater or tarn
 *
 * Acceptance: >= DOGFOOD_PASS_SHARE (80 %) of the seeds pass every rule. Flags: --seeds 10 (seed list = the world's seed
 * and N-1 more at +101 steps; --seed-list a,b,c), --look proving (the look init borrows), --tile 560 (map px),
 * --keep (keep the scratch project), --only relief,lakes (print only those columns in the table; all are judged),
 * --needs grand-entrance:55:250,walled-town,harbour-town (the run's site needs measured per seed: tools/worldgen-dogfood-needs.mts; a report, not a rule).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { decodePng, encodePng } from "./_png.mjs";
import { drawText } from "./_map-text.mts";
import { biomeFindings, describeBiomes, type BiomeReport } from "./worldgen-climate.mts";
import { parseNeedSpecs, seedNeedLine, seedNeeds, type SeedNeed } from "./worldgen-dogfood-needs.mts";
import {
  INTERIOR_LAKES_MIN,
  RELIEF_MIN_M,
  UPLAND_RISE_M,
  UPLAND_SHARE_MIN,
  WOODLAND_SHARE_MIN,
  altitudeLadder,
  interiorLakes,
  landHeights,
  measureLandWidth,
  samplePoints,
  treeSampler,
  woodlandShare,
  zoneRegions,
  type Ladder,
} from "./worldgen-relief.mts";

/** The upland must stretch at least this share of the landmass width along its long axis (a spine reads; a knot does not). */
export const SILHOUETTE_MIN = 0.4;
/** Share of the seeds that must pass every rule. */
export const DOGFOOD_PASS_SHARE = 0.8;
export const DOGFOOD_SEEDS_DEFAULT = 10;
export const SCRATCH_PROJECT = "dogfood";

export interface DogfoodHost {
  argv: string[];
  worldName: string;
  project: string;
  playground: string;
  fail(message: string): never;
}

export interface SeedResult {
  seed: number;
  name: string;
  ladder: Ladder | null;
  widthKm: number;
  landKm2: number;
  uplandShare: number;
  silhouette: number;
  lakes: number;
  interiorLakes: number;
  woodland: number;
  coastOk: boolean;
  coastShares: string;
  dangling: number;
  lakesNoRiver: number;
  /** lakes no river reaches that are not declared endorheic (the status row's rule; a declared tarn is fine) */
  undeclared: number;
  uphill: number;
  waterFindings: number;
  borderFindings: number;
  rivers: number;
  riverKm: number;
  failed: string[];
  mapPng: string | null;
  seconds: number;
  error: string | null;
  /** The gate lines worth keeping per seed (rivers audit notes, water-logic and regions findings): the sheet's sidecar. */
  notes: string[];
  /** the biomes rule: anchor shares, adjacency pairs, feature inventory */
  biomes: BiomeReport | null;
  /** --needs: the run's site needs measured on the seed (report, not a rule) */
  needs: SeedNeed[];
}

function opt(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}
function num(argv: string[], name: string, fallback: number): number {
  const v = opt(argv, name);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
const r1 = (v: number): number => Math.round(v * 10) / 10;
const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

/** The upland's long-axis extent (p05..p95 of the projection onto the major PCA axis) over the landmass width. */
export function silhouetteRatio(recipe: WorldRecipe, field: ReturnType<typeof createWorldField>, widthKm: number): number {
  const { points } = samplePoints(recipe, null, 2500);
  const sea = recipe.seaLevel;
  const limit = field.worldLimit;
  const land: [number, number, number][] = [];
  for (const [x, z] of points) {
    if (limit !== Infinity && x * x + z * z > limit * limit) continue;
    const h = field.height(x, z);
    if (h > sea + 0.5) land.push([x, z, h - sea]);
  }
  if (land.length < 10 || !(widthKm > 0)) return 0;
  const sorted = land.map((p) => p[2]).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))]!;
  const up = land.filter((p) => p[2] >= p10 + UPLAND_RISE_M);
  if (up.length < 4) return 0;
  const mx = up.reduce((a, p) => a + p[0], 0) / up.length;
  const mz = up.reduce((a, p) => a + p[1], 0) / up.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of up) {
    const dx = p[0] - mx, dz = p[1] - mz;
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
  }
  // major eigenvector of the 2x2 covariance
  const tr = sxx + szz, det = sxx * szz - sxz * sxz;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let ax = sxz, az = l1 - sxx;
  if (Math.abs(ax) + Math.abs(az) < 1e-9) { ax = 1; az = 0; }
  const n = Math.hypot(ax, az);
  ax /= n; az /= n;
  const proj = up.map((p) => (p[0] - mx) * ax + (p[1] - mz) * az).sort((a, b) => a - b);
  const extent = proj[Math.floor(0.95 * (proj.length - 1))]! - proj[Math.floor(0.05 * (proj.length - 1))]!;
  return Math.round((extent / (widthKm * 1000)) * 100) / 100;
}

interface Run { ok: boolean; out: string }

export function commandDogfood(host: DogfoodHost): void {
  const { argv, worldName, project, playground } = host;
  if (!project) host.fail("dogfood needs --project <name>: the world's project gives the scratch project its dependencies");
  const projectDir = path.join(playground, "projects", project);
  const sourceFile = path.join(projectDir, "assets", "worlds", `${worldName}.json`);
  if (!fs.existsSync(sourceFile)) host.fail(`no ${path.relative(process.cwd(), sourceFile)}: dogfood reads the world's seed, climate anchors and continent flags from it`);
  const source = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(sourceFile, "utf8")));
  const projectJson = JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")) as { dependsOn?: string[] };
  const look = opt(argv, "look") ?? "proving";
  const tile = Math.max(240, Math.round(num(argv, "tile", 560)));
  const count = Math.max(1, Math.round(num(argv, "seeds", DOGFOOD_SEEDS_DEFAULT)));
  const seedList = opt(argv, "seed-list");
  const seeds = seedList
    ? seedList.split(",").map((s) => Math.round(Number(s))).filter((n) => Number.isFinite(n))
    : Array.from({ length: count }, (_, i) => source.seed + i * 101);
  const keep = argv.includes("--keep");
  const only = (opt(argv, "only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let needSpecs: ReturnType<typeof parseNeedSpecs> = [];
  try { needSpecs = parseNeedSpecs(opt(argv, "needs") ?? ""); } catch (e) { host.fail((e as Error).message); }

  // the continent flags the real world was laid with (count 1: make() lays radius x 0.8)
  const continents = source.bounds?.continents ?? [];
  const main = continents[0];
  if (!main) host.fail("the world has no continents yet — run worldgen continents first");
  const contFlags = ["--count", "1", "--islands", "0", "--radius", String(Math.round(main.radius / 0.8)), "--lobes", String(main.lobes.length), "--limit", "auto"];
  // the WORLD's climate rides into every seed (2026-10-29 redstrand: the anchors were dropped here, so a dry world was
  // judged on the look's sixteen temperate-to-tropical anchors): its anchor set, aridity and riparian ribbon. A world
  // that kept every anchor of its look passes none and continents picks per cell from the ground as before.
  const srcZones = source.climate.zones;
  const anchors: string[] = srcZones ? srcZones.anchors.map((a) => a.id) : [];
  const climateFlags: string[] = [];
  if (anchors.length > 0) climateFlags.push("--anchors", anchors.join(","));
  if (srcZones?.aridity) climateFlags.push("--aridity", String(srcZones.aridity));
  if (srcZones?.warmth) climateFlags.push("--warmth", String(srcZones.warmth));
  if (srcZones?.riparian) climateFlags.push("--riparian", `${srcZones.riparian.anchor}:${srcZones.riparian.reach}:${srcZones.riparian.rise}`);

  // the scratch project: the world's dependencies, nothing of its own
  const scratchDir = path.join(playground, "projects", SCRATCH_PROJECT);
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(scratchDir, "assets", "worlds"), { recursive: true });
  fs.writeFileSync(
    path.join(scratchDir, "project.json"),
    JSON.stringify({ version: 1, name: SCRATCH_PROJECT, title: "Dogfood (worldgen scratch — deleted after each run)", group: "Worlds", scenes: [], engine: "^0.1", multiplayer: "server", tools: [], dependsOn: projectJson.dependsOn ?? [] }, null, 2),
  );

  const run = (args: string[]): Run => {
    const res = spawnSync("npx", ["tsx", "tools/worldgen.mts", ...args, "--project", SCRATCH_PROJECT], { cwd: playground, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { ok: res.status === 0, out: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
  };

  console.log(`dogfood ${worldName}: ${seeds.length} seed(s) [${seeds.join(", ")}], look ${look}, anchors ${anchors.join("/") || "-"}, continents ${contFlags.join(" ")}`);
  const results: SeedResult[] = [];
  for (const seed of seeds) {
    const t0 = performance.now();
    const name = `${worldName}-s${seed}`;
    const r: SeedResult = { seed, name, ladder: null, widthKm: 0, landKm2: 0, uplandShare: 0, silhouette: 0, lakes: 0, interiorLakes: 0, woodland: 0, coastOk: false, coastShares: "", dangling: -1, lakesNoRiver: -1, undeclared: 0, uphill: -1, waterFindings: -1, borderFindings: -1, rivers: 0, riverKm: 0, failed: [], mapPng: null, seconds: 0, error: null, notes: [], biomes: null, needs: [] };
    results.push(r);
    const stages: [string, string[]][] = [
      ["init", ["init", name, "--from", look, "--seed", String(seed)]],
      ...(climateFlags.length ? [["climate", ["climate", name, ...climateFlags]] as [string, string[]]] : []),
      ["continents", ["continents", name, ...contFlags]],
      ["coast", ["coast", name]],
      ["coast-check", ["coast", name, "--check"]],
      ["rivers", ["rivers", name]],
      ["towns", ["towns", name, "--count", "1", "--tier", "town"]],
      ["zones", ["zones", name, "--count", "1"]],
      ["regions", ["regions", name]],
      ["water-logic", ["water-logic", name]],
      ["map", ["map", name, "--size", String(tile)]],
    ];
    for (const [stage, args] of stages) {
      const res = run(args);
      const out = res.out;
      if (stage === "coast-check") { r.coastOk = /coast gate: ok/.test(out); continue; }
      if (stage === "rivers") {
        for (const line of out.split("\n")) if (/uphill|dangling|held up|drained|perched|^\s+!|audit:|defaults/.test(line)) r.notes.push(`rivers: ${line.trim()}`);
        const m = out.match(/audit: .*?(\d+) dangling\), (\d+) lakes \((\d+) without a river\), (\d+) uphill steps/);
        if (m) { r.dangling = Number(m[1]); r.lakes = Number(m[2]); r.lakesNoRiver = Number(m[3]); r.uphill = Number(m[4]); }
        const u = out.match(/! (\d+) lake\(s\) no river reaches and not declared endorheic/);
        r.undeclared = u ? Number(u[1]) : 0;
        const c = out.match(/carved (\d+) rivers \(.*?, ([\d.]+) km\)/);
        if (c) { r.rivers = Number(c[1]); r.riverKm = Number(c[2]); }
      }
      if (stage === "water-logic") {
        for (const line of out.split("\n")) if (/^\s{2}\S.*\[/.test(line)) r.notes.push(`water-logic: ${line.trim()}`); const m = out.match(/(\d+) finding\(s\)/); r.waterFindings = /^OK:/m.test(out) ? 0 : m ? Number(m[1]) : -1; }
      if (stage === "regions") {
        const at = out.indexOf("finding(s):");
        if (at >= 0) for (const line of out.slice(at).split("\n").slice(1, 12)) if (line.trim()) r.notes.push(`regions: ${line.trim()}`); const m = out.match(/(\d+) finding\(s\):/); r.borderFindings = m ? Number(m[1]) : /no regions/.test(out) ? -1 : 0; }
      if (stage === "map") { const m = out.match(/wrote (.*?-map\.png)/); r.mapPng = m ? path.resolve(playground, m[1]!) : null; }
      if (!res.ok && !["coast-check", "regions", "water-logic"].includes(stage)) {
        r.error = `${stage} failed: ${out.trim().split("\n").filter(Boolean).slice(-2).join(" | ")}`;
        break;
      }
    }
    // the rules, measured in-process on the scratch world
    const file = path.join(scratchDir, "assets", "worlds", `${name}.json`);
    if (fs.existsSync(file) && !r.error) {
      try {
        const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
        const field = createWorldField(recipe);
        const land = landHeights(recipe, field, null);
        r.ladder = altitudeLadder(land);
        const measured = measureLandWidth(recipe, field);
        r.widthKm = measured.widthKm;
        r.landKm2 = measured.landKm2;
        r.uplandShare = r.ladder.count ? land.filter((h) => h >= r.ladder!.p10 + UPLAND_RISE_M).length / r.ladder.count : 0;
        r.silhouette = silhouetteRatio(recipe, field, r.widthKm);
        const wild = zoneRegions(recipe);
        const polygon = wild[0]?.polygon ?? null;
        r.interiorLakes = polygon ? interiorLakes(recipe, field, polygon).length : 0;
        r.woodland = woodlandShare(recipe, field, polygon, treeSampler(recipe, field)).share;
        r.biomes = biomeFindings(recipe, field, polygon, wild[0]?.name ?? "zone");
        for (const f of r.biomes.findings) r.notes.push(`biomes: ${f}`);
        for (const line of describeBiomes(r.biomes)) r.notes.push(`biomes: ${line}`);
        const types = new Map<string, number>();
        for (const s of recipe.features.coastSegments ?? []) types.set(s.type, (types.get(s.type) ?? 0) + 1);
        r.coastShares = [...types.entries()].map(([k, v]) => `${k.replace(/-.*/, "")} ${v}`).join(" ");
        if (needSpecs.length) r.needs = seedNeeds(recipe, needSpecs);
      } catch (e) {
        r.error = `judging: ${(e as Error).message.split("\n")[0]}`;
      }
    }
    if (r.error) r.failed.push("error");
    else {
      if (!r.ladder || r.ladder.relief < RELIEF_MIN_M) r.failed.push("relief");
      if (r.uplandShare < UPLAND_SHARE_MIN) r.failed.push("upland");
      if (r.silhouette < SILHOUETTE_MIN) r.failed.push("silhouette");
      if (r.interiorLakes < INTERIOR_LAKES_MIN) r.failed.push("lakes");
      if (r.woodland < WOODLAND_SHARE_MIN) r.failed.push("woodland");
      if (!r.coastOk) r.failed.push("coast");
      if (r.dangling !== 0 || r.undeclared !== 0 || r.uphill !== 0) r.failed.push("hydrology");
      if (r.waterFindings !== 0) r.failed.push("water");
      if (r.borderFindings !== 0) r.failed.push("border");
      if (!r.biomes || r.biomes.findings.length > 0) r.failed.push("biomes");
    }
    r.seconds = Math.round((performance.now() - t0) / 100) / 10;
    const L = r.ladder;
    console.log(
      `  seed ${String(seed).padStart(6)}  ${r.failed.length ? "FAIL" : "pass"}  relief ${L ? r1(L.relief) : "-"} m  upland ${pct(r.uplandShare)}  silhouette ${r.silhouette}  lakes ${r.interiorLakes}/${r.lakes}  woodland ${pct(r.woodland)}  coast ${r.coastOk ? "ok" : "FAIL"}  hydrology ${r.dangling}/${r.lakesNoRiver}(${r.undeclared} undeclared)/${r.uphill}  water ${r.waterFindings}  border ${r.borderFindings}  rivers ${r.rivers} (${r.riverKm} km)  biomes ${r.biomes ? [...r.biomes.shares.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + (v * 100).toFixed(0) + "%").join("/") + " kinds " + r.biomes.kindCount : "-"}  ${r.seconds}s${r.failed.length ? `  <- ${r.failed.join(", ")}` : ""}${r.error ? `  ${r.error}` : ""}`,
    );
    for (const n of r.needs) console.log(`      needs ${seedNeedLine(n)}`);
  }

  // the contact sheet
  const sheetDir = path.join(projectDir, "authoring", "dogfood");
  fs.mkdirSync(sheetDir, { recursive: true });
  const sheet = path.join(sheetDir, `${worldName}-seeds.png`);
  writeContactSheet(sheet, results, tile, only);
  // the sidecar: every seed's numbers and the gate lines behind them, so a fault is diagnosable without re-running the seed
  const sidecar = path.join(sheetDir, `${worldName}-seeds.md`);
  const md: string[] = [`# dogfood ${worldName} — ${new Date().toISOString()}`, "", `seeds ${seeds.join(", ")}; look ${look}; climate ${climateFlags.join(" ") || "-"}; continents ${contFlags.join(" ")}`, ""];
  for (const r of results) {
    const L = r.ladder;
    md.push(`## seed ${r.seed} — ${r.failed.length ? "FAIL: " + r.failed.join(", ") : "pass"}`);
    md.push(`relief ${L ? r1(L.relief) : "-"} m (p05 ${L ? r1(L.p05) : "-"}, p98 ${L ? r1(L.p98) : "-"}), upland ${pct(r.uplandShare)}, silhouette ${r.silhouette}, land ${r.landKm2} km² / ${r.widthKm} km wide, lakes ${r.interiorLakes} interior of ${r.lakes}, woodland ${pct(r.woodland)}, coast ${r.coastOk ? "ok" : "FAIL"} (${r.coastShares}), rivers ${r.rivers} (${r.riverKm} km), hydrology dangling ${r.dangling} / no-river ${r.lakesNoRiver} / uphill ${r.uphill}, water ${r.waterFindings}, border ${r.borderFindings}, ${r.seconds} s${r.error ? `, ${r.error}` : ""}`);
    for (const n of r.needs) md.push(`- needs: ${seedNeedLine(n)}`);
    for (const n of r.notes) md.push(`- ${n}`);
    md.push("");
  }
  fs.writeFileSync(sidecar, md.join("\n"));
  const passed = results.filter((r) => r.failed.length === 0).length;
  const needed = Math.ceil(seeds.length * DOGFOOD_PASS_SHARE);
  console.log(`\n${passed} of ${seeds.length} seed(s) pass every rule (acceptance ${needed}: ${pct(DOGFOOD_PASS_SHARE)}); sheet ${path.relative(process.cwd(), sheet)}`);
  const faults = new Map<string, number>();
  for (const r of results) for (const f of r.failed) faults.set(f, (faults.get(f) ?? 0) + 1);
  if (faults.size) console.log(`  rule failures: ${[...faults.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(", ")} — fix the GENERATOR (recipe-derived defaults), never the seed`);
  if (!keep) fs.rmSync(scratchDir, { recursive: true, force: true });
  else console.log(`  scratch project kept: ${path.relative(process.cwd(), scratchDir)}`);
  if (passed < needed) process.exitCode = 1;
}

function writeContactSheet(file: string, results: SeedResult[], tile: number, only: string[]): void {
  const cols = Math.min(5, Math.max(1, results.length));
  const rows = Math.ceil(results.length / cols);
  const caption = (12 + Math.max(0, ...results.map((r) => r.needs.length))) * 9 + 6;
  const pad = 6;
  const cw = tile + pad * 2;
  const ch = tile + caption + pad * 2;
  const W = cols * cw;
  const H = rows * ch;
  const rgb = new Uint8Array(W * H * 3).fill(24);
  const put = (x: number, y: number, c: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (x + y * W) * 3;
    rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
  };
  results.forEach((r, k) => {
    const ox = (k % cols) * cw + pad;
    const oy = Math.floor(k / cols) * ch + pad;
    const colour: [number, number, number] = r.failed.length ? [220, 60, 50] : [70, 190, 90];
    // frame
    for (let t = 0; t < 3; t++) {
      for (let x = -t - 1; x <= tile + t; x++) { put(ox + x, oy - t - 1, colour); put(ox + x, oy + tile + caption + t, colour); }
      for (let y = -t - 1; y <= tile + caption + t; y++) { put(ox - t - 1, oy + y, colour); put(ox + tile + t, oy + y, colour); }
    }
    if (r.mapPng && fs.existsSync(r.mapPng)) {
      try {
        const png = decodePng(fs.readFileSync(r.mapPng)) as { width: number; height: number; data: Uint8Array };
        const chans = png.data.length / (png.width * png.height);
        for (let y = 0; y < Math.min(tile, png.height); y++)
          for (let x = 0; x < Math.min(tile, png.width); x++) {
            const i = (x + y * png.width) * chans;
            put(ox + x, oy + y, [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]);
          }
      } catch { /* a map that did not decode leaves the tile dark */ }
    }
    const L = r.ladder;
    const show = (key: string): boolean => only.length === 0 || only.includes(key);
    const bad = (key: string): [number, number, number] => (r.failed.includes(key) ? [255, 120, 110] : [230, 230, 230]);
    const lines: [string, [number, number, number]][] = [
      [`SEED ${r.seed}  ${r.failed.length ? "FAIL: " + r.failed.join(", ").toUpperCase() : "PASS"}`, colour],
      ...(show("relief") ? [[`RELIEF ${L ? r1(L.relief) : "-"} M (P05 ${L ? r1(L.p05) : "-"} P98 ${L ? r1(L.p98) : "-"})  UPLAND ${pct(r.uplandShare)}`, bad(r.failed.includes("upland") ? "upland" : "relief")] as [string, [number, number, number]]] : []),
      ...(show("silhouette") ? [[`SILHOUETTE ${r.silhouette} (MIN ${SILHOUETTE_MIN})  LAND ${r.landKm2} KM2 ${r.widthKm} KM WIDE`, bad("silhouette")] as [string, [number, number, number]]] : []),
      ...(show("lakes") ? [[`LAKES ${r.interiorLakes} INTERIOR / ${r.lakes}  RIVERS ${r.rivers} (${r.riverKm} KM)`, bad("lakes")] as [string, [number, number, number]]] : []),
      ...(show("woodland") ? [[`WOODLAND ${pct(r.woodland)} (MIN ${pct(WOODLAND_SHARE_MIN)})`, bad("woodland")] as [string, [number, number, number]]] : []),
      ...(show("coast") ? [[`COAST ${r.coastOk ? "OK" : "FAIL"}  ${r.coastShares.toUpperCase()}`, bad("coast")] as [string, [number, number, number]]] : []),
      ...(show("hydrology") ? [[`HYDROLOGY DANGLING ${r.dangling} NO-RIVER ${r.lakesNoRiver} UPHILL ${r.uphill}  WATER ${r.waterFindings}  BORDER ${r.borderFindings}`, bad(r.failed.includes("water") ? "water" : r.failed.includes("border") ? "border" : "hydrology")] as [string, [number, number, number]]] : []),
      ...(r.biomes ? describeBiomes(r.biomes).map((line, i) => [line.toUpperCase().slice(0, 92), i === 1 && r.biomes!.pairs.some((p) => !p.legal) ? bad("biomes") : i === 2 && r.biomes!.kindCount < 5 ? bad("biomes") : [200, 220, 200]] as [string, [number, number, number]]) : []),
      ...(r.biomes ? r.biomes.findings.slice(0, 1).map((f) => [("! " + f).toUpperCase().slice(0, 92), [255, 120, 110]] as [string, [number, number, number]]) : []),
      ...r.needs.map((n) => [`NEEDS ${n.label} ${n.met}/${n.measured} MET`.toUpperCase().slice(0, 92), n.met > 0 ? [150, 220, 255] : [255, 200, 120]] as [string, [number, number, number]]),
      ...(r.error ? [[r.error.toUpperCase().slice(0, 80), [255, 120, 110]] as [string, [number, number, number]]] : []),
    ];
    lines.forEach(([text, c], i) => drawText(rgb, W, ox + 4, oy + tile + 6 + i * 9, text, c, 1));
  });
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgba[j] = rgb[i]!; rgba[j + 1] = rgb[i + 1]!; rgba[j + 2] = rgb[i + 2]!; rgba[j + 3] = 255; }
  fs.writeFileSync(file, encodePng(W, H, rgba));
}
