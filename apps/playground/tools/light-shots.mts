/**
 * light-shots — identical lighting photos for before/after tuning: fixed SPOTS x fixed TIMES OF DAY, the same two
 * reference characters in every frame (light gear left, dark gear right) and a mid-grey floating sphere between them at chest height.
 *
 *   npx tsx tools/light-shots.mts --scene proving --out <dir> [--label before]
 *   npx tsx tools/light-shots.mts --scene gnawspur-deeps --spots <spots.json> --out <dir>      (interior: no time axis)
 *     [--spots <file>]          the spots to shoot; without it they are auto-picked (voxel worlds: one per zone + the
 *                               spawn town) and WRITTEN to <out>/<scene>-spots.json — pass that file on every later
 *                               run so the before and after photos stand in exactly the same places
 *     [--times 6,9,12,15,18,22] clock hours (via the dev console's /time, frozen); ignored where /time is not answered
 *     [--weather clear,starry,broken,clouded,puddled,snowed,snow-edge,overcast,rain,storm,snow,blizzard,sand]   weather states to shoot (default clear), each pinned
 *                               through the dev console and given --weather-settle seconds (default 14) to fade in:
 *                               clear = /weather clear + /overcast 0; overcast = dry /overcast 0.7 (the greyest auto
 *                               roll; overcast-full = 1); drizzle / rain (= light) / storm fall as rain; snow /
 *                               blizzard = light / storm falling as snow; sand = a storm falling as sand.
 *                               Sheet rows become spot x weather; frames are <spot>-<weather>-<hh>.png.
 *     [--no-refs]               clean frames: the reference characters and the grey sphere are hidden (read shots,
 *                               loading art); their brightness numbers are then meaningless
 *     [--url http://localhost:<p>] use a running dev app; otherwise starts its own vite (agent-test config) on --port
 *     [--port 5291]             (default 5291) and stops it by PID afterwards. Never point --url at a server you
 *                               do not own: the page blocks every dev-server write, but it still loads the scene.
 *     [--distance 4] [--gap 2]  camera-to-characters metres, metres between the two characters
 *     [--keep-mobs] [--headed] [--pick-only]   (--pick-only: write the auto spots and stop)
 *     [--ab]                    per spot, time the cheap world extras OFF vs ON in the same session (vsync off)
 * spots.json: [{ "name": "zone-3", "x": 1200, "z": -1500, "facing": 180 }]  (optional "pitch" radians and "distance" m — past the rig's zoom cap = an aerial, the cap is widened for the run;
 *   raise the camera on its orbit for an over-the-roofs view)  — x/z = midpoint between the two
 *   characters; `facing` = compass degrees the CAMERA looks (0 = north/-Z, 90 = east/+X; default 180 = south, so at
 *   noon the sun, whose arc leans north, lights the characters' faces). Optional "y" for interiors (floor height).
 *
 * Out: <out>/<scene>[-<label>]-sheet.png (rows = spots, columns = times; each tile labelled with the clock and the
 * luma read off it), every frame as <scene>[-<label>]/<spot>-<hh>.png, and <scene>[-<label>].json with per frame:
 * clock, zone mood actually showing (/mood), recipe region, camera, and mean luma (Rec.709 on 0-255 sRGB) of the whole
 * frame, the top fifth (sky), the bottom fifth (ground), each character's screen box and the grey sphere (plus its
 * mean RGB, which shows colour cast).
 *
 * How: local play in the dev app (the day-night, zone-mood and weather scripts only run in play). The characters are
 * added in edit mode as plain entities (character-look, as town NPCs are dressed) BEFORE play starts; every dev-server
 * write (scene autosave, player data) is answered by the page route and never reaches disk. Per spot the player is
 * fast-travelled to the midpoint, hidden (its visual group scaled to nothing), the follow rig is aimed along `facing`
 * at head height, and the characters + sphere are moved in front of the camera. /weather clear + /overcast 0 are set once; mobs are
 * removed from the in-memory scene for the run (--keep-mobs keeps them).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createWorldField, worldRecipeSchema, regionAt, type WorldField, type WorldRecipe } from "@hitreg/core";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n: string, d = "") => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const SCENE = arg("scene", "proving");
const LABEL = arg("label");
const OUT = path.resolve(arg("out", path.join(PG, "shots", "light")));
const TIMES = arg("times", "6,9,12,15,18,22").split(",").map(Number).filter((n) => Number.isFinite(n));
const WEATHERS = arg("weather", "clear").split(",").map((s) => s.trim()).filter(Boolean);
const WEATHER_SETTLE = Number(arg("weather-settle", "14")) * 1000;
/** Each weather state as dev-console lines (the weather builtin's /weather and /overcast). */
const WEATHER_CMDS: Record<string, string[]> = {
  clear: ["/ground wet auto", "/ground snow auto", "/ground snowline auto", "/weather biome", "/overcast 0", "/weather clear"],
  // dry sky with the cloud cover pinned: starry = none, broken = some, clouded = as authored
  starry: ["/weather biome", "/overcast 0", "/clouds 0", "/weather clear"],
  broken: ["/weather biome", "/overcast 0", "/clouds 0.6", "/weather clear"],
  clouded: ["/weather biome", "/overcast 0", "/clouds 1", "/weather clear"],
  // what lies on the ground, pinned (the weather would take minutes to lay it): puddled = light rain on a
  // soaked street; snowed = the snowline pinned far below (everything white); snow-edge = the line pinned
  // at ~25 m, ragged across low ground (a coastal town's height in the sample world)
  puddled: ["/ground snowline auto", "/overcast 0", "/weather rain", "/weather light", "/ground wet 1"],
  snowed: ["/ground wet auto", "/weather biome", "/overcast 0", "/clouds 0.6", "/weather clear", "/ground snowline -100"],
  "snow-edge": ["/ground wet auto", "/weather biome", "/overcast 0", "/clouds 0.6", "/weather clear", "/ground snowline 25"],
  overcast: ["/weather biome", "/overcast 0.7", "/weather clear"],
  "overcast-full": ["/weather biome", "/overcast 1", "/weather clear"],
  drizzle: ["/overcast 0", "/weather rain", "/weather drizzle"],
  rain: ["/overcast 0", "/weather rain", "/weather light"],
  storm: ["/overcast 0", "/weather rain", "/weather storm"],
  snow: ["/overcast 0", "/weather snow", "/weather light"],
  blizzard: ["/overcast 0", "/weather snow", "/weather storm"],
  sand: ["/overcast 0", "/weather sand", "/weather storm"],
};
for (const w of WEATHERS) if (!WEATHER_CMDS[w]) { console.error(`STOP: --weather ${w}: expected ${Object.keys(WEATHER_CMDS).join(", ")}`); process.exit(2); }
const MULTI_WEATHER = WEATHERS.length > 1 || WEATHERS[0] !== "clear";
const DIST = Number(arg("distance", "4"));
const GAP = Number(arg("gap", "2"));
const W = 1280, H = 720;
const stem = `${SCENE}${LABEL ? `-${LABEL}` : ""}`;
fs.mkdirSync(path.join(OUT, stem), { recursive: true });

type Spot = { name: string; x: number; z: number; facing?: number; y?: number; pitch?: number; distance?: number };
type V3 = [number, number, number];

// -- scene + world (read-only) -------------------------------------------------------------------
function findAsset(kind: string, file: string): string | null {
  for (const p of fs.readdirSync(path.join(PG, "projects"))) {
    const f = path.join(PG, "projects", p, "assets", kind, file);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const sceneFile = findAsset("scenes", `${SCENE}.scene.json`);
if (!sceneFile) { console.error(`STOP: no scenes/${SCENE}.scene.json in any project`); process.exit(2); }
type Ent = { name: string; parent: string | null; tags: string[]; components: Record<string, any> };
const sceneDoc = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as { entities: Record<string, Ent> };
const worldId = Object.values(sceneDoc.entities).map((e) => e.components["voxelWorld"]?.world as string | undefined).find(Boolean) ?? null;
let field: WorldField | null = null;
let recipe: WorldRecipe | null = null;
if (worldId) {
  const wf = findAsset("worlds", `${worldId}.json`);
  if (wf) { recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(wf, "utf8"))); field = createWorldField(recipe); }
}
const spawnEnt = Object.values(sceneDoc.entities).find((e) => e.tags.includes("player"));
const spawnAt = (spawnEnt?.components["transform"]?.position ?? [0, 0, 0]) as V3;

// -- spots -----------------------------------------------------------------------------------------
const inPoly = (poly: number[][], x: number, z: number) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if (zi! > z !== zj! > z && x < ((xj! - xi!) * (z - zi!)) / (zj! - zi!) + xi!) inside = !inside;
  }
  return inside;
};
/** Camera look direction for compass degrees (0 = north = -Z). */
const lookDir = (deg: number): [number, number] => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];

function autoSpots(): Spot[] {
  if (!field || !recipe) return [{ name: "spawn", x: spawnAt[0], z: spawnAt[2], facing: 180, y: spawnAt[1] - 0.9 }];
  const regions = recipe.regions ?? [];
  const facing = 180;
  const [dx, dz] = lookDir(facing);
  const sea = recipe.seaLevel ?? 0;
  /** Lower is better: open ground, flat, dry, away from roads/rivers/towns, a low horizon along the view. */
  const score = (x: number, z: number, cx: number, cz: number, inTown: boolean): number | null => {
    const g = field!.height(x, z);
    if (g < sea + 3 || field!.waterY(x, z) !== null) return null;
    if (field!.slope(x, z) > 0.18) return null;
    for (const [ox, oz] of [[-DIST * dx, -DIST * dz], [GAP / 2 * dz, -GAP / 2 * dx], [-GAP / 2 * dz, GAP / 2 * dx]]) {
      const h = field!.height(x + ox!, z + oz!);
      if (Math.abs(h - g) > 0.8 || field!.waterY(x + ox!, z + oz!) !== null) return null;
    }
    if (!inTown && field!.featureClearance(x, z) < 10) return null;
    const eye = g + 1.6;
    let horizon = 0;
    for (let d = 8; d <= 200; d += 8) horizon = Math.max(horizon, Math.atan2(field!.height(x + dx * d, z + dz * d) - eye, d));
    if (horizon > (10 * Math.PI) / 180) return null; // the top of the frame must be sky
    return Math.hypot(x - cx, z - cz) / 40 + horizon * 40 + field!.slope(x, z) * 20;
  };
  const pick = (name: string, poly: number[][], excl: number[][][], inTown: boolean, step: number): Spot | null => {
    const xs = poly.map((p) => p[0]!), zs = poly.map((p) => p[1]!);
    // a central-ish target: the mean of the outline, pulled to the nearest valid point
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cz = zs.reduce((a, b) => a + b, 0) / zs.length;
    let best: Spot | null = null, bestS = Infinity;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += step) {
        if (!inPoly(poly, x, z) || excl.some((e) => inPoly(e, x, z))) continue;
        const s = score(x, z, cx, cz, inTown);
        if (s !== null && s < bestS) { bestS = s; best = { name, x: Math.round(x), z: Math.round(z), facing }; }
      }
    }
    return best;
  };
  const out: Spot[] = [];
  const outline = (r: (typeof regions)[number]) => (r as unknown as { polygon?: number[][] }).polygon ?? [];
  const towns = regions.filter((r) => r.tags.includes("town"));
  const places = regions.filter((r) => r.tags.includes("place") || r.tags.includes("town"));
  for (const z of regions.filter((r) => !r.within && !r.tags.includes("town") && !r.tags.includes("place"))) {
    const s = pick(z.id, outline(z), places.map(outline), false, 24);
    if (s) out.push(s); else console.warn(`  no open spot found in ${z.id}`);
  }
  // the town the player spawns in (or the first one): its open ground, near its middle
  // the town the player spawns in: the spawn point itself (open by design; buildings are not in the field), looking
  // whichever way the land falls away most; else the open ground nearest another town's middle
  const home = towns.find((t) => inPoly(outline(t), spawnAt[0], spawnAt[2]));
  if (home) {
    const eye = field.height(spawnAt[0], spawnAt[2]) + 1.6;
    let bestF = 180, bestH = Infinity;
    for (let f = 0; f < 360; f += 45) {
      const [ux, uz] = lookDir(f);
      let hz = -Infinity;
      for (let d = 8; d <= 200; d += 8) hz = Math.max(hz, Math.atan2(field.height(spawnAt[0] + ux * d, spawnAt[2] + uz * d) - eye, d));
      if (hz < bestH - 1e-3) { bestH = hz; bestF = f; }
    }
    out.push({ name: home.id, x: Math.round(spawnAt[0]), z: Math.round(spawnAt[2]), facing: bestF });
  } else if (towns[0]) { const s = pick(towns[0].id, outline(towns[0]), [], true, 6); if (s) out.push(s); }
  return out;
}

let spots: Spot[];
const spotsArg = arg("spots");
if (spotsArg) spots = JSON.parse(fs.readFileSync(spotsArg, "utf8")) as Spot[];
else {
  spots = autoSpots();
  const f = path.join(OUT, `${SCENE}-spots.json`);
  fs.writeFileSync(f, JSON.stringify(spots, null, 1) + "\n");
  console.log(`auto-picked ${spots.length} spots -> ${f} (pass --spots ${f} on the AFTER run)`);
}
if (argv.includes("--pick-only")) { console.log(JSON.stringify(spots)); process.exit(0); }
const regionOf = (x: number, z: number) => {
  if (!recipe) return null;
  const r = regionAt(recipe.regions ?? [], x, z);
  const p = regionAt(recipe.regions ?? [], x, z, { places: true });
  return { zone: r?.id ?? null, place: p && p !== r ? p.id : null };
};

// -- reference characters (entities added in edit mode, never saved) -------------------------------
const creation = JSON.parse(fs.readFileSync(findAsset("creation", "mmo-creation.json")!, "utf8")) as {
  appearance: Array<{ id: string; preview?: boolean; body?: boolean; options: Array<{ id: string; model?: string }> }>;
  mounts: Array<{ model: string; mirrorTo?: unknown }>;
};
const bodyModel = creation.appearance.find((s) => s.body)?.options.find((o) => o.model)?.model ?? "mmo/human-body.glb";
const mountModels = [...new Set(creation.mounts.map((m) => m.model))];
const mirrored = new Set(creation.mounts.filter((m) => m.mirrorTo).map((m) => m.model));
const buildModels = new Set(creation.appearance.filter((s) => !s.preview && !s.body).flatMap((s) => s.options.map((o) => o.model ?? "")).filter(Boolean));
const itemModel = (id: string) => (JSON.parse(fs.readFileSync(findAsset("items", `${id}.json`)!, "utf8")) as { appearance?: { model?: string } }).appearance?.model ?? "";
const REFS = [
  { id: "lightref-light", name: "Light gear (peasant linen)", wear: ["peasant-tunic", "wool-trousers", "peasant-shoes"],
    appearance: { sex: "male", skin: "olive", face: "m-young", hair: "m-short", "hair-colour": "brown", beard: "none" } },
  { id: "lightref-dark", name: "Dark gear (studded leather)", wear: ["studded-jerkin", "studded-leggings", "studded-gloves", "studded-boots", "studded-pauldrons"],
    appearance: { sex: "male", skin: "olive", face: "m-young", hair: "m-short", "hair-colour": "brown", beard: "none" } },
];
const identity = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
function refOps(at: V3): unknown[] {
  const ops: unknown[] = [];
  const add = (id: string, entity: Partial<Ent>) => ops.push({ op: "add-entity", id, entity: { tags: [], parent: null, ...entity } });
  for (const r of REFS) {
    const look = { actor: r.id, creation: "mmo-creation", appearance: r.appearance, wear: r.wear };
    const worn = new Set(r.wear.map(itemModel));
    add(r.id, { name: r.name, tags: ["lightref"], components: { transform: { position: at, rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } });
    add(`${r.id}-visual`, { name: `${r.name} visual`, parent: r.id, components: {
      transform: { position: [0, -0.9, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      mesh: { source: { kind: "asset", assetId: bodyModel, textureFilter: "nearest", partMask: 511 }, castShadow: true, receiveShadow: true, renderMode: "auto", lod: true, static: false },
      animator: { play: "Idle", fade: 0.3, speed: 1 } } });
    add(`${r.id}-look`, { name: `${r.name} look`, parent: `${r.id}-visual`, components: { transform: identity, script: { name: "character-look", params: look } } });
    for (const model of mountModels) {
      if (!buildModels.has(model) && !worn.has(model)) continue;
      const short = model.replace(/^.*\/human-/, "").replace(/\.glb$/, "");
      const copies: Array<[string, boolean]> = mirrored.has(model) ? [[`${short}-l`, false], [`${short}-r`, true]] : [[short, false]];
      for (const [part, mirror] of copies) {
        add(`${r.id}-${part}`, { name: `${r.name} ${part}`, parent: `${r.id}-visual`, components: {
          transform: identity,
          mesh: { source: { kind: "asset", assetId: model, partMask: 0, textureFilter: "pixel" }, castShadow: true, receiveShadow: true, renderMode: "instanced", lod: true, moving: true, static: false },
          script: { name: "character-look", params: mirror ? { ...look, mirror: true } : look } } });
      }
    }
  }
  add("lightref-grey", { name: "Mid-grey reference sphere", tags: ["lightref"], components: {
    transform: { position: at, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    mesh: { source: { kind: "primitive", shape: "sphere", size: [0.4, 0.4, 0.4] }, castShadow: true, receiveShadow: true, renderMode: "auto", static: false } } });
  return ops;
}

/** Mobs and their spawn areas, as top-most removable roots: in play they would walk into the frame and fight the
 *  hidden player (removed from the in-memory doc only; nothing is saved). --keep-mobs leaves them. */
function mobRemovalOps(): unknown[] {
  if (argv.includes("--keep-mobs")) return [];
  const E = sceneDoc.entities;
  const pick = new Set<string>();
  for (const [id, e] of Object.entries(E)) {
    if (e.components["spawnArea"]) pick.add(id);
    if (e.tags.includes("combatant")) pick.add(e.parent && E[e.parent] ? e.parent : id);
    // a dungeon's hand-placed creature (named, boss, a pack's standing template) is a mobs/ prefab instance: its
    // combatant tag lives inside the prefab, not on the scene entity (town NPCs are npcs/ prefabs and stay)
    const pf = (e.components["prefab"] as { prefabId?: string } | undefined)?.prefabId;
    if (pf?.startsWith("mobs/")) pick.add(id);
  }
  const under = (id: string) => { for (let p = E[id]?.parent; p; p = E[p]?.parent ?? null) if (pick.has(p)) return true; return false; };
  return [...pick].filter((id) => !under(id)).map((id) => ({ op: "remove-entity", id }));
}

// -- browser ---------------------------------------------------------------------------------------
async function loadPlaywright(): Promise<any> {
  const env = process.env["HITREG_PLAYWRIGHT"];
  if (env) return createRequire(path.join(env, "package.json"))(env);
  try { return await import("playwright"); } catch { /* fall through */ }
  for (const dir of [process.cwd(), PG, path.join(PG, "..", "..")]) {
    try { return createRequire(path.join(dir, "noop.js"))("playwright"); } catch { /* next */ }
  }
  console.error("STOP: playwright is not resolvable — `npm i playwright` (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1) or set HITREG_PLAYWRIGHT=<playwright package dir>");
  process.exit(2);
}
let vite: ReturnType<typeof spawn> | null = null;
let base = arg("url").replace(/\/$/, "");
const stopVite = () => { if (vite?.pid) { try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(vite.pid), "/t", "/f"]) : process.kill(vite.pid); } catch { /* gone */ } } };
if (!base) {
  const port = arg("port", "5291");
  vite = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--config", "vite.agent-test.config.ts", "--port", port, "--strictPort"], { cwd: PG, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  base = `http://localhost:${port}`;
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite did not start in 60 s")), 60000);
    const on = (b: Buffer) => { if (/ready in|Local:/.test(b.toString())) { clearTimeout(t); res(); } };
    vite!.stdout!.on("data", on); vite!.stderr!.on("data", on);
    vite!.on("exit", (c) => rej(new Error(`vite exited ${c} (port ${port} taken? pass --port)`)));
  }).catch((e) => { console.error("STOP:", (e as Error).message); stopVite(); process.exit(2); });
}
const t0 = Date.now();
const { chromium } = await loadPlaywright();
const AB = argv.includes("--ab");
/** --no-refs: hide the reference characters and sphere (clean read shots / loading art; the frame then has no ref numbers). */
const NO_REFS = argv.includes("--no-refs");
const browser = await chromium.launch({ channel: "chrome", headless: !argv.includes("--headed"), args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", ...(AB ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : [])] });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
// nothing this run does may reach disk: scene autosave, player data, pins, context
await ctx.route(/\/__hitreg\//, (route: any) => {
  const r = route.request();
  if (r.method() !== "GET" && !/\/__hitreg\/log\b/.test(r.url())) return route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" });
  return route.continue();
});
// freeze the page at the code it booted with (other sessions edit the tree; HMR would reload mid-run)
await ctx.route(/\/@vite\/client(\?.*)?$/, (route: any) => route.fulfill({ contentType: "application/javascript", body: `const styles = new Map();
export const createHotContext = () => ({ data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {} });
export const updateStyle = (id, css) => { let s = styles.get(id); if (!s) { s = document.createElement("style"); s.setAttribute("data-vite-dev-id", id); document.head.appendChild(s); styles.set(id, s); } s.textContent = css; };
export const removeStyle = (id) => { styles.get(id)?.remove(); styles.delete(id); };
export const injectQuery = (url) => url;
export class ErrorOverlay extends HTMLElement {}
` }));
await ctx.addInitScript(() => {
  (window as any).__name = (f: unknown) => f;
  try {
    const k = "hitreg-editor-settings";
    const cur = JSON.parse(localStorage.getItem(k) || "{}");
    localStorage.setItem(k, JSON.stringify({ ...cur, showStats: false, showGizmos: false, grid: false, showPhysics: false, showLights: false, showSkeletons: false }));
  } catch { /* private */ }
});
let page: any = null;
const logs: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H_ = <T,>(fn: (h: any, ...a: any[]) => T, ...a: unknown[]) => page.evaluate(([src, args]: [string, unknown[]]) => {
  const h = (window as any).__hitreg; return new Function("h", "args", `return (${src})(h, ...args)`)(h, args);
}, [fn.toString(), a]) as Promise<Awaited<T>>;
async function waitFor(cond: () => Promise<boolean>, ms: number, what: string) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await cond().catch(() => false)) return; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}
/** One console line, as typed into the dev console's field; returns what it printed. */
const cmd = (line: string) => page.evaluate((line: string) => {
  const f = document.querySelector(".hitreg-console-field") as HTMLInputElement | null;
  if (!f) return "! no developer console in this build";
  f.value = line;
  f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const all = [...document.querySelectorAll(".hitreg-console-line")];
  let at = all.length - 1;
  while (at >= 0 && (all[at] as HTMLElement).dataset["kind"] !== "in") at--;
  return all.slice(at + 1).filter((l) => (l as HTMLElement).dataset["kind"] !== "in").map((l) => ((l as HTMLElement).dataset["kind"] === "error" ? "! " : "") + (l.querySelector(".hitreg-console-text")?.textContent ?? "")).join(" | ");
}, line) as Promise<string>;

/** Streaming done and the draw count steady for 3 s (min `minMs`). */
async function settle(minMs: number) {
  const t = Date.now();
  let last = -1, still = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const [n, loading, travelling] = await H_((h) => {
      let d = 0, l = 0;
      try { d = h.info().render.drawCalls ?? 0; } catch { /* */ }
      try { l = h.chunkManager?.stats?.loading ?? 0; } catch { /* */ }
      return [d, l, h.travelling()];
    });
    still = n === last && loading === 0 && !travelling ? still + 1 : 0;
    last = n;
    if (Date.now() - t >= minMs && still >= 3) break;
  }
}

console.log(`light-shots: ${SCENE} — ${spots.length} spots x ${TIMES.length} times`);
let backend = "?", hasClock = false;
/** A fresh page on the scene, references added, mobs removed, in play, overlays off, weather clear, clock frozen. */
async function openSession(): Promise<void> {
if (page) await page.close().catch(() => {});
page = await ctx.newPage();
page.on("pageerror", (e: Error) => logs.push("pageerror: " + e.message));
page.on("crash", () => logs.push("page crashed"));
await page.goto(`${base}/?scene=${encodeURIComponent(SCENE)}`, { waitUntil: "load" });
await waitFor(() => page.evaluate(() => !!(window as any).__hitreg?.playerId), 240000, "the dev app (__hitreg)");
await waitFor(() => H_((h, s: string) => h.sceneName() === s, SCENE), 240000, `scene ${SCENE}`);
await sleep(2000);
// the reference entities, in edit mode (an edit during play would restart the session)
const mobOps = mobRemovalOps();
await H_((h, ops: unknown[]) => h.apply(ops), [...mobOps, ...refOps([spawnAt[0], spawnAt[1] + 40, spawnAt[2]])]);
if (mobOps.length) console.log(`  removed ${mobOps.length} mob/spawn-area roots for the run (--keep-mobs to keep them)`);
await sleep(1500);
// enter play with the key a player uses; a press can land before the canvas takes keys, so press again while still in edit
for (let tries = 0; ; tries++) {
  if (await H_((h) => h.playMode.get() === "edit")) {
    await page.locator("canvas").first().focus().catch(() => {});
    await page.keyboard.press("Backquote");
  }
  try { await waitFor(() => H_((h) => h.playMode.get() === "playing" && !!h.sim && !!h.playerId() && !h.travelling()), 60000, "play mode"); break; }
  catch (e) {
    const st = await H_((h) => ({ mode: h.playMode.get(), sim: !!h.sim, pid: h.playerId(), travelling: h.travelling(), loading: h.chunkManager?.stats?.loading ?? null })).catch(() => null);
    console.warn(`  still not playing after ${(tries + 1) * 60} s: ${JSON.stringify(st)}`);
    if (tries >= 4) { await page.screenshot({ path: path.join(OUT, `${stem}-play-failed.png`) }).catch(() => {}); throw e; }
  }
}
await H_(() => document.exitPointerLock?.());
await sleep(1500);
// every overlay off (HUD, chat, map, nameplates, console): only the canvas draws
await H_((h) => { const c = h.renderer?.renderer?.domElement ?? h.renderer?.domElement; if (c) c.dataset.lightrefMain = "1"; });
await page.addStyleTag({ content: `body * { visibility: hidden !important; } canvas[data-lightref-main] { visibility: visible !important; }` });
backend = await H_((h) => String(h.renderer?.backend ?? h.renderer?.renderer?.backend?.constructor?.name ?? "?"));
const timeProbe = await cmd("/time");
hasClock = !timeProbe.startsWith("!");
await cmd("/overcast 0"); // a clear roll can still come with a grey dry sky: pin it open
const weather = await cmd("/weather clear");
if (hasClock) await cmd("/time freeze");
console.log(`  play up in ${((Date.now() - t0) / 1000).toFixed(0)} s; backend ${backend}; clock: ${hasClock ? timeProbe : "none (no time axis)"}; weather: ${weather}`);
}
try {
await openSession();
const times = hasClock ? TIMES : [NaN];

type Box = { x0: number; y0: number; x1: number; y1: number };
type Shot = { rig?: unknown; spot: string; row: string; weather: string; weatherLine: string; time: number | null; clock: string; mood: string; file: string; boxes: Record<string, Box | null>; camera: { pos: V3; target: V3; distance: number } };
const shots: Shot[] = [];
const spotInfo: Array<Record<string, unknown>> = [];

async function shootSpot(spot: Spot): Promise<void> {
  const facing = spot.facing ?? 180;
  const [dx, dz] = lookDir(facing);
  const groundGuess = spot.y ?? (field ? field.height(spot.x, spot.z) : spawnAt[1] - 0.9);
  const travel = await H_((h, p: V3) => h.travelTo(p[0], p[1], p[2]), [spot.x, groundGuess + 1.5, spot.z] as V3);
  if (travel !== "ok") { console.warn(`  ${spot.name}: travel refused (${travel})`); return; }
  await sleep(1500);
  await settle(4000);
  // hide the player, aim the rig along `facing` at head height
  await H_((h, yaw: number, dist: number, pitch: number) => {
    const o = h.object(h.playerId());
    const vis = o?.children.find((c: any) => /visual/i.test(c.name)) ?? o;
    vis.scale.setScalar(1e-4);
    // an aerial spot (distance past the play rig's zoom cap) widens the cap for the run instead of being clamped to it
    if (dist > h.cameraRig.config.maxDistance) h.cameraRig.configure({ maxDistance: dist, pitchMax: Math.max(h.cameraRig.config.pitchMax, 1.4) });
    h.cameraRig.setDistance(dist);
    h.cameraRig.setOrbit(yaw, pitch);
  }, Math.atan2(dx, dz) + Math.PI, spot.distance ?? DIST, spot.pitch ?? 0.03);
  await sleep(2500);
  // stand the references in front of the camera, on the ground, facing it
  const placed = await H_((h, gap: number, useField: boolean, hide: boolean) => {
    const o = h.object(h.playerId());
    const p = o.getWorldPosition(o.position.clone());
    const c = h.camera.position;
    let fx = p.x - c.x, fz = p.z - c.z;
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const rx = -fz, rz = fx; // camera right
    const feet = p.y - 0.9;
    const ground = (x: number, z: number) => {
      if (!useField) return feet;
      const g = h.terrainHeight(x, z);
      return Number.isFinite(g) && Math.abs(g - feet) < 1.5 ? g : feet;
    };
    const yaw = Math.atan2(-fx, -fz);
    const put = (id: string, x: number, z: number, y: number) => {
      const e = h.object(id);
      e.position.set(x, y, z);
      e.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
      // play freezes still subtrees (freezeStaticSubtree: own updateMatrixWorld, matrixWorldAutoUpdate off): thaw ours
      if (Object.prototype.hasOwnProperty.call(e, "updateMatrixWorld")) delete e.updateMatrixWorld;
      e.matrixWorldAutoUpdate = true;
      e.matrixAutoUpdate = true;
      e.updateMatrix();
      e.updateMatrixWorld(true);
    };
    // light on the camera's left, dark on its right
    const lx = p.x - rx * gap / 2, lz = p.z - rz * gap / 2, kx = p.x + rx * gap / 2, kz = p.z + rz * gap / 2;
    put("lightref-light", lx, lz, ground(lx, lz) + 0.9);
    put("lightref-dark", kx, kz, ground(kx, kz) + 0.9);
    put("lightref-grey", p.x, p.z, ground(p.x, p.z) + 1.1); // chest height: above grass, against the background
    // the grey sphere's own material: the engine default is shared by every untextured mesh
    h.object("lightref-grey").traverse((m: any) => {
      if (m.isMesh && !m.userData.__lightref) { m.material = m.material.clone(); m.material.color.setHex(0x777777); m.material.roughness = 1; m.material.metalness = 0; m.userData.__lightref = true; }
    });
    // --no-refs: a CLEAN frame (a read shot, loading art): the references stay placed for the numbers' bookkeeping but draw nothing
    if (hide) for (const id of ["lightref-light", "lightref-dark", "lightref-grey"]) { const e = h.object(id); if (e) e.visible = false; }
    return { pivot: [p.x, p.y, p.z], cam: [c.x, c.y, c.z], feet, dist: h.cameraRig.distance };
  }, GAP, !!field, NO_REFS);
  await sleep(1500);
  await settle(field ? 8000 : 2000); // zone mood eases in over ~6 s after arrival
  const region = regionOf(placed.pivot[0], placed.pivot[2]);
  spotInfo.push({ ...spot, facing, region, pivot: placed.pivot, camera: placed.cam, cameraDistance: placed.dist });
  for (const weatherName of WEATHERS) {
  let weatherLine = "";
  if (MULTI_WEATHER) {
    for (const line of WEATHER_CMDS[weatherName]!) await cmd(line);
    await sleep(WEATHER_SETTLE);
    weatherLine = await cmd("/weather");
  }
  const row = MULTI_WEATHER ? `${spot.name} · ${weatherName}` : spot.name;
  for (const hour of times) {
    let clock = "";
    if (Number.isFinite(hour)) { clock = await cmd(`/time ${hour}`); await sleep(2200); }
    const mood = field ? await cmd("/mood") : "";
    // the light rig as the scene sees it this frame (what weather/mood/day-night actually wrote)
    const rig = await H_((h) => {
      const sc = h.scene?.(); if (!sc) return null;
      const hex = (c: any) => (c?.getHexString ? "#" + c.getHexString() : null);
      const out: any = { sun: [], hemi: [], ambient: [], env: +(sc.environmentIntensity ?? 0).toFixed(3), background: hex(sc.background), fog: sc.fog ? { color: hex(sc.fog.color), density: sc.fog.density ?? null } : null };
      sc.traverse((o: any) => {
        if (o.isDirectionalLight && o.visible) out.sun.push({ i: +o.intensity.toFixed(3), c: hex(o.color) });
        else if (o.isHemisphereLight) out.hemi.push({ i: +o.intensity.toFixed(3), sky: hex(o.color), ground: hex(o.groundColor) });
        else if (o.isAmbientLight) out.ambient.push({ i: +o.intensity.toFixed(3), c: hex(o.color) });
      });
      // world ambience (cloud shadows, chimney smoke), when the dev handle carries it
      const amb = h.ambience;
      if (amb) out.ambience = { smoke: amb.chimneySmoke.stats(), cloudShadow: { on: amb.cloudShadow.on.value, strength: +amb.cloudShadow.strength.value.toFixed(3), coverage: +amb.cloudShadow.coverage.value.toFixed(3) } };
      return out;
    }).catch(() => null);
    // keep the references where they were put (nothing should move them, but a script might)
    const boxes = await H_((h) => {
      const cam = h.camera;
      cam.updateMatrixWorld(true);
      const v = cam.position.clone();
      const proj = (x: number, y: number, z: number) => { v.set(x, y, z).project(cam); return [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight, v.z]; };
      const box = (id: string, r: number, lo: number, hi: number) => {
        const o = h.object(id); if (!o) return null;
        const p = o.getWorldPosition(o.position.clone());
        const pts = [proj(p.x, p.y + lo, p.z), proj(p.x, p.y + hi, p.z)];
        if (pts.some((q) => q[2]! > 1 || q[2]! < -1)) return null;
        const top = Math.min(pts[0]![1]!, pts[1]![1]!), bot = Math.max(pts[0]![1]!, pts[1]![1]!);
        const half = (bot - top) * r;
        return { x0: Math.round(pts[0]![0]! - half), y0: Math.round(top), x1: Math.round(pts[0]![0]! + half), y1: Math.round(bot) };
      };
      // a torso+legs box inside each body (not its outline, so the sky behind does not count), the sphere's core
      return { light: box("lightref-light", 0.14, -0.7, 0.55), dark: box("lightref-dark", 0.14, -0.7, 0.55), grey: box("lightref-grey", 0.5, -0.1, 0.1) };
    });
    const tag = Number.isFinite(hour) ? String(hour).padStart(2, "0") : "interior";
    const file = path.join(OUT, stem, `${spot.name}${MULTI_WEATHER ? `-${weatherName}` : ""}-${tag}.png`);
    await page.screenshot({ path: file });
    const cam = await H_((h) => [h.camera.position.x, h.camera.position.y, h.camera.position.z]);
    shots.push({ spot: spot.name, row, weather: weatherName, weatherLine, time: Number.isFinite(hour) ? hour : null, clock, mood, rig, file, boxes, camera: { pos: cam as V3, target: placed.pivot as V3, distance: placed.dist } });
  }
  }
  console.log(`  ${spot.name} (${region?.zone ?? "-"}${region?.place ? `/${region.place}` : ""}): ${times.length * WEATHERS.length} frames, camera ${placed.dist.toFixed(1)} m — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (AB) await abSpot(spot.name);
}

/**
 * --ab: the cheap world extras (halos, pools, fog glow, window cards, smoke,
 * birds, contact and cloud shadows, sun glare) OFF vs ON in this one page
 * session, alternating, with a settle after every toggle — frame interval
 * (vsync off) and draw calls. Interleaved because run-to-run noise on this
 * machine is as large as the effects being measured.
 */
const abResults: Array<Record<string, unknown>> = [];
async function abSpot(name: string): Promise<void> {
  const can = await H_((h) => typeof h.ambience?.setWorldExtrasEnabled === "function");
  if (!can) { console.warn("  --ab: this dev app has no ambience toggle"); return; }
  const windows: Record<string, number[][]> = { off: [], on: [] };
  const calls: Record<string, number[]> = { off: [], on: [] };
  for (let k = 0; k < 6; k++) {
    const mode = k % 2 === 0 ? "off" : "on";
    await H_((h, on: boolean) => h.ambience.setWorldExtrasEnabled(on), mode === "on");
    await sleep(2500);
    const m = await page.evaluate(() => new Promise<{ frames: number[]; calls: number }>((resolve) => {
      const frames: number[] = []; let last = performance.now(); const end = last + 3000;
      const tick = (t: number) => { frames.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else {
        const r: any = (window as any).__hitreg?.renderer; const info = r?.renderer?.info ?? r?.info;
        resolve({ frames, calls: info?.render?.drawCalls ?? info?.render?.calls ?? -1 });
      } };
      requestAnimationFrame(tick);
    }));
    windows[mode]!.push(m.frames);
    calls[mode]!.push(m.calls);
  }
  await H_((h) => h.ambience.setWorldExtrasEnabled(true));
  const stat = (all: number[][]) => { const f = all.flat().sort((a, b) => a - b); return { median: +f[Math.floor(f.length / 2)]!.toFixed(2), p95: +f[Math.floor(f.length * 0.95)]!.toFixed(2), frames: f.length }; };
  const r = { spot: name, off: { ...stat(windows.off!), drawCalls: calls.off }, on: { ...stat(windows.on!), drawCalls: calls.on } };
  abResults.push(r);
  console.log(`  A/B ${name}: off median ${r.off.median} ms p95 ${r.off.p95} (calls ${calls.off!.join("/")}) · on median ${r.on.median} ms p95 ${r.on.p95} (calls ${calls.on!.join("/")})`);
}

// a long run across a whole world can lose the tab (GPU/memory): reopen the session and retry that spot once
for (const spot of spots) {
  const keep = shots.length, keepInfo = spotInfo.length;
  try { await shootSpot(spot); }
  catch (e) {
    shots.length = keep; spotInfo.length = keepInfo;
    console.warn(`  ${spot.name}: ${(e as Error).message.split(String.fromCharCode(10))[0]} — reopening the session and retrying once`);
    try { await openSession(); await shootSpot(spot); }
    catch (e2) { shots.length = keep; spotInfo.length = keepInfo; console.warn(`  ${spot.name}: FAILED again (${(e2 as Error).message.split(String.fromCharCode(10))[0]}) — skipped`); await openSession().catch(() => {}); }
  }
}

// -- measure + contact sheet (in a blank page: canvas does the PNG decode) --------------------------
const sheetPage = await ctx.newPage();
await sheetPage.goto("about:blank");
const tiles = shots.map((s) => ({ ...s, url: "data:image/png;base64," + fs.readFileSync(s.file).toString("base64") }));
const rowsNames = [...new Set(shots.map((s) => s.row))];
const colTimes = times.map((t) => (Number.isFinite(t) ? t : null));
const result = await sheetPage.evaluate(async ({ tiles, rowsNames, colTimes, title }: any) => {
  const luma = (d: Uint8ClampedArray, w: number, b: { x0: number; y0: number; x1: number; y1: number } | null) => {
    if (!b) return null;
    const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0), x1 = Math.min(w, b.x1), y1 = Math.min(d.length / 4 / w, b.y1);
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    let s = 0, r = 0, g = 0, bl = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4; r += d[i]!; g += d[i + 1]!; bl += d[i + 2]!; s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!; n++;
    }
    return { luma: +(s / n).toFixed(1), rgb: [Math.round(r / n), Math.round(g / n), Math.round(bl / n)] };
  };
  const TW = 480, TH = 270, LW = 200, HH = 34, TITLE = 30;
  const cv = document.createElement("canvas");
  cv.width = Math.max(1240, LW + TW * colTimes.length); cv.height = TITLE + HH + TH * rowsNames.length;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#0b0e14"; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = "#e6edf3"; g.font = "600 18px ui-monospace, monospace"; g.fillText(title, 10, 21);
  g.font = "600 16px ui-monospace, monospace";
  colTimes.forEach((t: number | null, c: number) => g.fillText(t === null ? "interior" : `${String(t).padStart(2, "0")}:00`, LW + c * TW + 10, TITLE + 23));
  const measures: any[] = [];
  for (const t of tiles) {
    const img = new Image(); img.src = t.url; await img.decode();
    const full = document.createElement("canvas"); full.width = img.width; full.height = img.height;
    const fg = full.getContext("2d")!; fg.drawImage(img, 0, 0);
    const d = fg.getImageData(0, 0, img.width, img.height).data;
    const W = img.width, Hh = img.height;
    const m = {
      frame: luma(d, W, { x0: 0, y0: 0, x1: W, y1: Hh })!.luma,
      sky: luma(d, W, { x0: 0, y0: 0, x1: W, y1: Math.round(Hh * 0.2) })!.luma,
      ground: luma(d, W, { x0: 0, y0: Math.round(Hh * 0.8), x1: W, y1: Hh })!.luma,
      light: luma(d, W, t.boxes.light), dark: luma(d, W, t.boxes.dark), grey: luma(d, W, t.boxes.grey),
    };
    measures.push(m);
    const r = rowsNames.indexOf(t.row), c = Math.max(0, colTimes.indexOf(t.time));
    const x = LW + c * TW, y = TITLE + HH + r * TH;
    g.drawImage(img, x, y, TW, TH);
    g.strokeStyle = "#0b0e14"; g.lineWidth = 2; g.strokeRect(x, y, TW, TH);
    const line = `frame ${m.frame.toFixed(0)} · light ${m.light?.luma.toFixed(0) ?? "-"} · dark ${m.dark?.luma.toFixed(0) ?? "-"} · grey ${m.grey?.luma.toFixed(0) ?? "-"}`;
    g.font = "500 13px ui-monospace, monospace";
    const w = g.measureText(line).width;
    g.fillStyle = "rgba(0,0,0,0.7)"; g.fillRect(x + 4, y + TH - 24, w + 12, 20);
    g.fillStyle = "#ffffff"; g.fillText(line, x + 10, y + TH - 9);
  }
  rowsNames.forEach((n: string, r: number) => {
    const t = tiles.find((s: any) => s.row === n);
    const y = TITLE + HH + r * TH;
    g.fillStyle = "#e6edf3"; g.font = "600 16px ui-monospace, monospace"; g.fillText(n, 10, y + 26);
    g.fillStyle = "#8b949e"; g.font = "500 13px ui-monospace, monospace";
    const mood = (t?.mood ?? "").replace(/^mood:\s*/, "");
    if (mood) g.fillText(`mood ${mood}`.slice(0, 26), 10, y + 48);
  });
  return { png: cv.toDataURL("image/png"), measures };
}, { tiles: tiles.map(({ url, spot, row, time, boxes, mood }) => ({ url, spot, row, time, boxes, mood })), rowsNames, colTimes, title: `${SCENE}${LABEL ? ` · ${LABEL}` : ""} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} · left = light gear, right = dark gear, sphere = mid grey` });
const sheetFile = path.join(OUT, `${stem}-sheet.png`);
fs.writeFileSync(sheetFile, Buffer.from(result.png.split(",")[1]!, "base64"));
const report = {
  scene: SCENE, label: LABEL || null, world: worldId, at: new Date().toISOString(), backend, viewport: [W, H],
  times: hasClock ? TIMES : null, distance: DIST, gap: GAP, references: REFS.map((r) => ({ id: r.id, name: r.name, wear: r.wear })),
  lumaNote: "mean Rec.709 luma of 0-255 sRGB pixels; light/dark = torso+legs box inside each character; grey = the sphere's core (rgb shows colour cast)",
  spots: spotInfo,
  weathers: MULTI_WEATHER ? WEATHERS : null,
  ...(abResults.length ? { ab: abResults } : {}),
  shots: shots.map((s, i) => ({ spot: s.spot, weather: s.weather, weatherLine: s.weatherLine, time: s.time, clock: s.clock, mood: s.mood, rig: s.rig, file: path.relative(OUT, s.file).replace(/\\/g, "/"), camera: s.camera, boxes: s.boxes, ...result.measures[i] })),
  pageErrors: logs.slice(0, 20),
};
fs.writeFileSync(path.join(OUT, `${stem}.json`), JSON.stringify(report, null, 1) + "\n");
console.log(`saved ${sheetFile}\nsaved ${path.join(OUT, `${stem}.json`)} — ${shots.length} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} finally {
  await browser.close().catch(() => {});
  stopVite();
}
process.exit(0);
