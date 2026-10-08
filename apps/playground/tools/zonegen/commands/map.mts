/**
 * zonegen map <world> --project <p> [--zone <id>] [--dev] [--scene <id>] [--size <px>] [--base]
 *
 * The REVIEW MAP: the in-game map's layers (zones, roads, towns by name, named places, dungeon entrances,
 * quest givers; with --dev also spawn areas by level and radius, packs/placed creatures, reservations with
 * their radii and the generator's sites) rendered to a labelled PNG for a reviewer judging placement.
 * The drawing is src/map-layers.ts, run unchanged in headless Chrome, so the picture is the one the person
 * in the game sees on M.
 *
 * Writes
 *  - assets/maps/<world>.layers.json   the authoring layers the running game cannot read (quest locations,
 *                                      reservations, site packs, quest-giver ids); the in-game map loads it
 *  - <zone>/reports/map[-dev].png      (or the world's reports/ folder without --zone) + a .json marker list
 * Needs assets/maps/<world>.base.png (the terrain picture); runs `worldgen map <world> --base` when it is
 * missing, or always with --base.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exists, readJson, type Ctx } from "../lib.mts";
import { collectMapData, DEFAULT_LAYERS, LAYERS, layerCounts, mapExtent, type LayerId, type MapExtras, type SceneLike } from "../../../src/map-layers.ts";

type J = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const mapLayersSource = path.resolve(here, "..", "..", "..", "src", "map-layers.ts");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH ?? "",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Every zone folder's authoring data, flattened into the bundle the map reads. */
export function gatherExtras(ctx: Ctx, recipe: J): MapExtras {
  const p = ctx.paths;
  const extras: Required<MapExtras> = { world: ctx.world, questGivers: [], places: [], reservations: [], packs: [] };
  const zonesDir = path.join(p.worldDir, "zones");
  const zones = exists(zonesDir) ? fs.readdirSync(zonesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  const sites = new Map<string, [number, number]>((recipe.features?.pois ?? []).map((s: J) => [s.id, [s.position[0], s.position[2]]]));
  for (const zone of zones) {
    const reservations = exists(p.reservations(zone)) ? ((readJson(p.reservations(zone)) as J).reservations ?? []) : [];
    const byLocation = new Map<string, J>();
    for (const r of reservations) {
      byLocation.set(r.location, r);
      extras.reservations.push({ id: r.location, site: r.site, x: r.center[0], z: r.center[1], radius: r.radius, interior: r.interior, zone });
    }
    if (exists(p.quests(zone))) {
      const quests = readJson(p.quests(zone)) as J;
      for (const q of quests.quests ?? []) if (q.giver?.type === "npc" && q.giver.ref) extras.questGivers.push(q.giver.ref);
      for (const loc of quests.locations ?? []) {
        const r = byLocation.get(loc.id);
        const at = r?.center ?? (loc.site ? sites.get(loc.site) : undefined);
        if (!at) continue;
        extras.places.push({ id: loc.id, name: loc.name, kind: loc.kind, x: at[0], z: at[1], radius: r?.radius, zone });
      }
    }
    const packsFile = path.join(p.zoneDir(zone), "site-packs.json");
    if (exists(packsFile)) {
      for (const pack of ((readJson(packsFile) as J).packs ?? []) as J[]) {
        const count = (pack.members ?? []).reduce((n: number, m: J) => n + (m.count ?? 1), 0);
        extras.packs.push({ id: pack.id, site: pack.site, x: pack.at[0], z: pack.at[pack.at.length === 3 ? 2 : 1], level: pack.level, count, named: pack.named?.name, faction: pack.faction });
      }
    }
  }
  extras.questGivers = [...new Set(extras.questGivers)];
  return extras;
}

/** The scene that streams this world: --scene, else <world>.scene.json, else any scene whose voxelWorld names it. */
export function findScene(ctx: Ctx): { file: string; doc: SceneLike } | null {
  const dir = path.join(ctx.paths.projectDir, "assets", "scenes");
  if (!exists(dir)) return null;
  const wanted = ctx.opt("scene");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".scene.json"));
  const ordered = wanted ? files.filter((f) => f === `${wanted}.scene.json`) : [...files.filter((f) => f === `${ctx.world}.scene.json`), ...files.filter((f) => f !== `${ctx.world}.scene.json`)];
  for (const f of ordered) {
    const file = path.join(dir, f);
    const doc = readJson(file) as SceneLike;
    const streams = Object.values(doc.entities ?? {}).some((e) => (e.components?.["voxelWorld"] as { world?: string } | undefined)?.world === ctx.world);
    if (streams || wanted) return { file, doc };
  }
  return null;
}

async function bundleRenderer(): Promise<string> {
  // esbuild comes with vite (and tsx); resolve it from vite's own location, it is not a direct dependency
  const { createRequire } = await import("node:module");
  const esbuild = createRequire(createRequire(import.meta.url).resolve("vite"))("esbuild") as typeof import("esbuild");
  const out = await esbuild.transform(fs.readFileSync(mapLayersSource, "utf8"), { loader: "ts", format: "iife", globalName: "MapLayers", target: "es2020" });
  return out.code;
}

/**
 * Draw the review map (terrain picture + layers + legend) in headless Chrome and screenshot it to `out`.
 * `overlay` adds a drawing on top: `draw` is the BODY of a function (ctx, data, toX, toY, scale) run in the page, and
 * `data` its JSON argument (`zonegen sites` draws its candidates this way). Returns "" on success, else the error.
 */
export async function shootMap(o: {
  basePng: string;
  data: ReturnType<typeof collectMapData>;
  view: { cx: number; cz: number; scale: number; width: number; height: number };
  layers: Set<LayerId>;
  title: string;
  counts: ReturnType<typeof layerCounts>;
  focusZone?: string;
  out: string;
  overlay?: { data: unknown; draw: string };
}): Promise<string> {
  const { view, out } = o;
  const baseUri = `data:image/png;base64,${fs.readFileSync(o.basePng).toString("base64")}`;
  const overlay = o.overlay
    ? `(function (ctx, data, toX, toY, scale) {\n${o.overlay.draw}\n})(ctx, ${JSON.stringify(o.overlay.data)}, (x) => (x - view.cx) * view.scale + view.width / 2, (z) => (z - view.cz) * view.scale + view.height / 2, view.scale);`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0d1a26;overflow:hidden}</style></head><body>
<canvas id="c" width="${view.width}" height="${view.height}"></canvas>
<script>${await bundleRenderer()}</script>
<script>
const data = ${JSON.stringify(o.data)};
const view = ${JSON.stringify(view)};
const layers = new Set(${JSON.stringify([...o.layers])});
const img = new Image();
img.onload = () => {
  const ctx = document.getElementById("c").getContext("2d");
  MapLayers.drawMapLayers(ctx, data, view, { layers, base: { image: img, width: img.naturalWidth, height: img.naturalHeight, extent: data.extent }, focusZone: ${JSON.stringify(o.focusZone)}, avoid: [[0, 0, 280, 260]] });
  ${overlay}
  MapLayers.drawLegend(ctx, layers, 12, 12, ${JSON.stringify(o.title)}, ${JSON.stringify(o.counts)});
  document.title = "done";
};
img.src = ${JSON.stringify(baseUri)};
</script></body></html>`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zonegen-map-"));
  const page = path.join(tmp, "map.html");
  fs.writeFileSync(page, html);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const chrome = CHROME_CANDIDATES.find((c) => c && fs.existsSync(c));
  if (!chrome) return "no Chrome/Edge found (set CHROME_PATH)";
  if (exists(out)) fs.rmSync(out);
  const shot = spawnSync(
    chrome,
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${path.join(tmp, "profile")}`, `--window-size=${view.width},${view.height}`, "--virtual-time-budget=15000", `--screenshot=${out}`, pathToFileURL(page).href],
    { encoding: "utf8", timeout: 120_000 },
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  return exists(out) ? "" : `Chrome wrote no screenshot\n${shot.stderr ?? ""}`;
}

export async function run(ctx: Ctx): Promise<number> {
  const p = ctx.paths;
  if (!exists(p.recipe)) {
    console.error(`zonegen map: no recipe ${p.recipe}`);
    return 2;
  }
  const recipe = readJson(p.recipe) as J;
  const basePng = path.join(p.projectDir, "assets", "maps", `${ctx.world}.base.png`);
  if (ctx.flag("base") || !exists(basePng)) {
    console.log(`zonegen map: drawing the terrain picture (worldgen map ${ctx.world} --base, ~1-2 min)…`);
    const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve(here, "..", "..", "worldgen.mts"), "map", ctx.world, "--project", ctx.project, "--base"], { stdio: "inherit" });
    if (r.status !== 0 || !exists(basePng)) {
      console.error("zonegen map: worldgen map --base failed");
      return 1;
    }
  }

  const extras = gatherExtras(ctx, recipe);
  const layersFile = path.join(p.projectDir, "assets", "maps", `${ctx.world}.layers.json`);
  fs.mkdirSync(path.dirname(layersFile), { recursive: true });
  fs.writeFileSync(layersFile, JSON.stringify(extras, null, 1) + "\n");

  const scene = findScene(ctx);
  if (!scene) console.warn(`zonegen map: no scene streams "${ctx.world}" — portals, quest givers, spawn areas and built places are missing (--scene <id>)`);
  const data = collectMapData(recipe as never, scene?.doc ?? null, extras, ctx.world);

  // the view: the whole world's land, or one zone's polygon with a margin
  const dev = ctx.flag("dev");
  const layers = new Set<LayerId>(DEFAULT_LAYERS);
  // the generator's sites are 300+ dots: opt in with --sites
  if (dev) for (const l of LAYERS) if (l.dev && l.id !== "sites") layers.add(l.id);
  if (ctx.flag("sites")) layers.add("sites");
  const size = Number(ctx.opt("size", ctx.zone ? "1800" : "1600"));
  let box: [number, number, number, number];
  if (ctx.zone) {
    const region = data.zones.find((z) => z.id === ctx.zone);
    if (!region) {
      console.error(`zonegen map: no region "${ctx.zone}" in ${ctx.world} (${data.zones.filter((z) => !z.town).map((z) => z.id).join(", ")})`);
      return 2;
    }
    const xs = region.polygon.map((q) => q[0]);
    const zs = region.polygon.map((q) => q[1]);
    box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
  } else {
    // every zone, else every town, else the world square
    const pts = data.zones.length ? data.zones.flatMap((z) => z.polygon) : data.markers.filter((m) => m.kind === "town").map((m) => [m.x, m.z] as [number, number]);
    const e = mapExtent(recipe);
    box = pts.length ? [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))] : [-e, -e, e, e];
  }
  const margin = Math.max(box[2] - box[0], box[3] - box[1]) * 0.06 + 60;
  const span = Math.max(box[2] - box[0], box[3] - box[1]) + 2 * margin;
  const view = { cx: (box[0] + box[2]) / 2, cz: (box[1] + box[3]) / 2, scale: size / span, width: size, height: size };

  const zoneName = ctx.zone ? data.zones.find((z) => z.id === ctx.zone)!.name : "";
  const title = `${ctx.zone ? `${zoneName} (${ctx.zone})` : `world ${ctx.world}`}${dev ? " · DEV" : ""} · ${(1 / view.scale).toFixed(1)} m/px`;
  const counts = layerCounts(data);
  const reports = ctx.zone ? path.join(p.zoneDir(ctx.zone), "reports") : path.join(p.worldDir, "reports");
  const out = path.join(reports, `map${dev ? "-dev" : ""}.png`);
  const shot = await shootMap({ basePng, data, view, layers, title, counts, focusZone: ctx.zone || undefined, out });
  if (shot) {
    console.error(`zonegen map: ${shot}`);
    return 1;
  }

  // the same markers as text, for an agent that wants coordinates rather than pixels
  const inView = (x: number, z: number): boolean => Math.abs(x - view.cx) <= span / 2 && Math.abs(z - view.cz) <= span / 2;
  const listing = {
    world: ctx.world,
    zone: ctx.zone || null,
    scene: scene ? path.relative(p.projectDir, scene.file) : null,
    view: { center: [Math.round(view.cx), Math.round(view.cz)], metresAcross: Math.round(span), metresPerPixel: +(1 / view.scale).toFixed(2) },
    layers: [...layers],
    markers: data.markers
      .filter((m) => inView(m.x, m.z) && layers.has(LAYERS.find((l) => l.id === ({ town: "towns", place: "places", dungeon: "dungeons", quest: "quests", spawn: "spawns", pack: "packs", mob: "packs", reservation: "reservations", site: "sites" } as const)[m.kind])!.id))
      .map((m) => ({ kind: m.kind, id: m.id, name: m.name, at: [Math.round(m.x), Math.round(m.z)], ...(m.radius ? { radius: m.radius } : {}), ...(m.level !== undefined ? { level: m.level } : {}), ...(m.detail ? { detail: m.detail } : {}) })),
  };
  fs.writeFileSync(out.replace(/\.png$/, ".json"), JSON.stringify(listing, null, 1) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), out)}  (${size}x${size}, ${listing.view.metresPerPixel} m/px, ${listing.markers.length} markers)`);
  console.log(`wrote ${path.relative(process.cwd(), layersFile)}  (in-game map layers: ${extras.places!.length} places, ${extras.reservations!.length} reservations, ${extras.packs!.length} packs, ${extras.questGivers!.length} quest givers)`);
  console.log(`  counts: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return 0;
}
