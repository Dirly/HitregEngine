/**
 * town-ground — a town's ground from a generated flat-colour KEY, then footpaths to its doors.
 *
 * The image generator lays the town out over the real site (layout); everything that is a measurement (heights,
 * grades, lot sizes, door paths) is computed here, deterministically. Per-town working files live in
 * `projects/<p>/authoring/towns/<town>-ground/` (config `ground.json`, written with defaults on first use).
 *
 *   npx tsx tools/town-ground.mts export  --project proving --town tidewell [--world proving] [--force-map]
 *       the BARE site (town shaping lifted off, reroutes applied): site.f32 (1 m heights), site-map.png
 *       (1024 px, hillshade + contours + roads + gates + four black registration squares; kept if present), mapping.json
 *   npx tsx tools/town-ground.mts request --project proving --town tidewell [--prev key-2.png] [--dry-run]
 *       compose prompt-key-<k>.txt from the PLAN's building program and the REAL envelopes (pad sizes in px that
 *       the models fit, door steps included) + the site + ground.json `keyBrief`, then image-request gen (--dry-run passes through)
 *   npx tsx tools/town-ground.mts key     --project proving --town tidewell --key key-2.png
 *       register (marks -> affine, residual), classify, clean (majority/open/close/specks) -> key-labels.bin, key-parse.json, overlay
 *   npx tsx tools/town-ground.mts build   --project proving --town tidewell [--dry]
 *       key -> ground: graded streets, level square, a pad per lot from the real envelope, structure sites reserved and
 *       levelled only, harmonic banks; ONE heightPatch + town street roads. Writes ground-edits.json + ground-inverse.json
 *       (and the plan's lots); --dry writes ground-*-dry files only.
 *   npx tsx tools/town-ground.mts doors   --project proving --town tidewell [--dry]
 *       AFTER the buildings are placed: a footpath (road `<townId>-door-<lot>`, narrow, the town's lane surface) from
 *       the foot of every door's steps to the nearest town street, routed over the ground at a walkable grade and
 *       clear of every other lot. Re-runnable: it replaces only its own `-door-` roads. Writes doors-edits.json,
 *       doors-inverse.json and the evidence `<town>-paths.json` beside the layout.
 *   npx tsx tools/town-ground.mts paving  --project proving --town tidewell [--off]
 *       mark the town's own streets, lanes and square (`<townId>-street-*` roads) `role: "paving"`, so they are
 *       painted with the zone's paving tile (recipe `regions[].ground.paving`, `worldgen zone-textures`) instead of
 *       their gravel. Paint only: heights, widths and points are untouched. `build` writes the role itself; this is
 *       for towns built before it. --off restores `road`. Writes paving-inverse.json.
 *   npx tsx tools/town-ground.mts undo    --project proving --town tidewell --step build|doors
 *       apply the saved inverse (build also restores the plan saved before it).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { applyRecipeEdits, createWorldField, worldRecipeSchema } from "@hitreg/core";
// @ts-expect-error plain JS helper
import { encodePng } from "./_png.mjs";
import {
  PRE, bareRecipe, bareRerouted, buildGround, context, dist, envelopeOf, parseKey, readJson, resample, round, segDist, writeJson,
  Heap, type Ctx, type P,
} from "./_town-ground.mts";

const argv = process.argv.slice(2);
const opt = (name: string, fallback = ""): string => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback; };
const flag = (name: string): boolean => argv.includes(`--${name}`);
const COMMANDS = ["export", "request", "key", "build", "doors", "paving", "undo"];
const cmd = argv.find((a) => COMMANDS.includes(a)) ?? "";
if (!COMMANDS.includes(cmd) || !opt("town")) {
  console.error(`usage: town-ground <${COMMANDS.join("|")}> --project <p> --town <town> [--world <w>]  (see the header)`);
  process.exit(2);
}
const c = context(opt("project", "proving"), opt("town"), opt("world") || undefined);
const rel = (f: string): string => path.relative(process.cwd(), f).replaceAll("\\", "/");
const writeRecipe = (recipe: unknown): void => fs.writeFileSync(c.worldFile, `${JSON.stringify(recipe, null, 2)}\n`);

// ------------------------------------------------------------------ export
function exportSite(): void {
  const { x0, z0, size, px } = c.cfg.site, n = c.n;
  const raw = readJson(c.worldFile);
  const recipe = worldRecipeSchema.parse(bareRerouted(c, raw));
  const mapRecipe = recipe; // the roads as they will be (reroutes applied), so the key does not draw the cut stubs
  const field = createWorldField(recipe);
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[i + j * n] = field.height(x0 + i, z0 + j);
  fs.mkdirSync(c.dir, { recursive: true });
  fs.writeFileSync(path.join(c.dir, "site.f32"), Buffer.from(h.buffer));
  const at = (x: number, z: number): number => {
    const u = Math.max(0, Math.min(n - 1.001, x - x0)), v = Math.max(0, Math.min(n - 1.001, z - z0));
    const i = Math.floor(u), j = Math.floor(v), fx = u - i, fz = v - j;
    const a = h[i + j * n]! * (1 - fx) + h[i + 1 + j * n]! * fx, b = h[i + (j + 1) * n]! * (1 - fx) + h[i + 1 + (j + 1) * n]! * fx;
    return a * (1 - fz) + b * fz;
  };
  const m = size / px;
  const town0 = raw.features.towns.find((t: any) => t.id === c.cfg.townId);
  // gates the reroutes will create are drawn and listed too (a town with no gates gets them from its reroutes)
  const town = { ...town0, gates: [...town0.gates, ...c.cfg.reroutes.filter((r, i, a) => !town0.gates.some((g: any) => g.id === r.gate) && a.findIndex((q) => q.gate === r.gate) === i).map((r) => ({ id: r.gate, at: r.cutAt }))] };
  const mapFile = path.join(c.dir, "site-map.png");
  if (!fs.existsSync(mapFile) || flag("force-map")) {
    const rgba = new Uint8Array(px * px * 4);
    for (let y = 0; y < px; y++)
      for (let x = 0; x < px; x++) {
        const wx = x0 + x * m, wz = z0 + y * m, g = at(wx, wz);
        let col: number[];
        if (g < recipe.seaLevel) col = [70, 110, 170];
        else {
          const t = Math.max(0, Math.min(1, g / 45));
          col = [150 + 80 * t, 175 + 40 * t, 120 + 60 * t];
          const sx = at(wx + 1, wz) - at(wx - 1, wz), sz = at(wx, wz + 1) - at(wx, wz - 1);
          const shade = Math.max(0.55, Math.min(1.15, 1 - (sx * 0.7 + sz * 0.7) * 0.25));
          col = col.map((v) => v * shade);
          const k0 = Math.floor(g / 2), k1 = Math.floor(at(wx + m, wz) / 2), k2 = Math.floor(at(wx, wz + m) / 2);
          if (k0 !== k1 || k0 !== k2) col = k0 % 5 === 4 ? [60, 50, 40] : [110, 100, 80];
        }
        rgba.set([...col.map((v) => Math.round(Math.max(0, Math.min(255, v)))), 255], (x + y * px) * 4);
      }
    const dot = (wx: number, wz: number, r: number, col: number[]): void => {
      const cx = (wx - x0) / m, cy = (wz - z0) / m;
      for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++)
        if (x >= 0 && y >= 0 && x < px && y < px && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) rgba.set([...col, 255], (x + y * px) * 4);
    };
    for (const r of mapRecipe.features.roads) {
      if (!r.points.some((p: number[]) => p[0] > x0 - 20 && p[0] < x0 + size + 20 && p[1] > z0 - 20 && p[1] < z0 + size + 20)) continue;
      for (let k = 1; k < r.points.length; k++) {
        const [ax, az] = r.points[k - 1]!, [bx, bz] = r.points[k]!, steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5);
        for (let s = 0; s <= steps; s++) dot(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps, (r.width / 2) / m, [235, 200, 40]);
      }
    }
    for (const g of town.gates) dot(g.at[0], g.at[1], 14 * (px / 1024), [255, 255, 255]);
    const sq = Math.round(32 * (px / 1024)), o = Math.round(8 * (px / 1024));
    for (let y = 0; y < sq; y++) for (let x = 0; x < sq; x++)
      for (const [ox, oy] of [[o, o], [px - o - sq, o], [o, px - o - sq], [px - o - sq, px - o - sq]]) rgba.set([0, 0, 0, 255], (ox! + x + (oy! + y) * px) * 4);
    fs.writeFileSync(mapFile, encodePng(px, px, rgba));
  }
  writeJson(path.join(c.dir, "mapping.json"), {
    world: c.cfg.world, town: c.cfg.townId, ...c.cfg.site, n, metresPerPixel: m,
    pixelToWorld: `X = ${x0} + px * ${m}, Z = ${z0} + py * ${m} (north, -Z, is up)`,
    registration: "four black 32 px squares, top-left at (8,8), (984,8), (8,984), (984,984) (per 1024 px)",
    seaLevel: recipe.seaLevel, heightRange: [h.reduce((a, b) => Math.min(a, b), Infinity), h.reduce((a, b) => Math.max(a, b), -Infinity)],
    gates: town.gates, source: `bare site: ${c.cfg.townId} terraces/pad/roads/patch lifted off; reroutes applied; every other feature kept`,
  });
  console.log(`site exported to ${rel(c.dir)}: heights ${h.reduce((a, b) => Math.min(a, b), Infinity).toFixed(1)}..${h.reduce((a, b) => Math.max(a, b), -Infinity).toFixed(1)} m${fs.existsSync(mapFile) && !flag("force-map") ? " (site-map.png kept)" : ""}`);
}

// ------------------------------------------------------------------ request
function request(): void {
  const { x0, z0, size, px } = c.cfg.site;
  const ppm = px / size;
  const mapping = path.join(c.dir, "mapping.json");
  if (!fs.existsSync(mapping) || !fs.existsSync(path.join(c.dir, "site-map.png"))) throw new Error("run export first");
  const map = readJson(mapping);
  const plan = readJson(path.join(c.townsDir, `${c.town}-plan.json`));
  const env = readJson(path.join(c.townsDir, `${c.town}-envelopes.json`));
  const CELL = c.cfg.cell;
  const toPx = (p: P): string => `x=${Math.round((p[0] - x0) * ppm)}, y=${Math.round((p[1] - z0) * ppm)}`;
  const role = (id: string): string => c.cfg.roles.find(([b]) => b === id)?.[1] ?? "";
  // pad sizes from the REAL models: the measured envelope (eaves + door steps), the 1.5 m pad margin, the front apron to the street
  const pads = plan.buildings.map((b: any) => {
    const model = b.model ?? b.id;
    const ext = envelopeOf(env, model), door = ext.door ?? "-y";
    const g = PRE[door]!(ext[c.cfg.envelope] ?? ext.ground);
    const [w0, d0] = (b.request?.size ?? b.planned?.size) as [number, number];
    const [w, d] = door === "+x" || door === "-x" ? [d0, w0] : [w0, d0];
    const wide = w * CELL + (g.left + g.right) * CELL + 3;
    const deep = d * CELL + g.back * CELL + 1.5 + g.front * CELL + 1.8 + 0.6;
    const r = role(b.id);
    const colour = r === "chapel" ? "yellow #FFFF00" : r === "hall" ? "magenta #FF00FF" : "blue #0000FF";
    return { id: b.id, name: b.name, use: b.use ?? "", colour, wPx: Math.round(wide * ppm), dPx: Math.round(deep * ppm), m: [round(wide, 10), round(deep, 10)] };
  });
  const seaPx = (() => {
    const h = new Float32Array(fs.readFileSync(path.join(c.dir, "site.f32")).buffer.slice(0)), n = c.n;
    let sx = 0, sz = 0, cnt = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (h[i + j * n]! < map.seaLevel) { sx += i; sz += j; cnt++; }
    if (!cnt) return "There is no sea on this site.";
    const fx = sx / cnt / (n - 1), fz = sz / cnt / (n - 1);
    const side = Math.abs(fx - 0.5) > Math.abs(fz - 0.5) ? (fx > 0.5 ? "east (right)" : "west (left)") : fz > 0.5 ? "south (bottom)" : "north (top)";
    return `Blue is the sea (${Math.round((100 * cnt) / (n * n))} % of the map, mostly to the ${side}).`;
  })();
  const raw = readJson(c.worldFile);
  const bare = bareRerouted(c, raw);
  const entries: string[] = [];
  for (const r of bare.features.roads as any[]) {
    const inside = (p: P): boolean => p[0] >= x0 && p[0] <= x0 + size && p[1] >= z0 && p[1] <= z0 + size;
    for (let k = 1; k < r.points.length; k++) if (inside(r.points[k - 1]) !== inside(r.points[k])) entries.push(`the road ${r.id} crosses the map edge near ${toPx(inside(r.points[k]) ? r.points[k] : r.points[k - 1])}`);
  }
  const gates = (map.gates as any[]).map((g) => `${g.id} (white dot, ${toPx(g.at)})`);
  const siteCfg = (id: string): any => (c.cfg.sites ?? []).find((q) => q.structure === id);
  const structures = (plan.structures ?? []).filter((s: any) => s.kind === "dock" || /pan/i.test(s.id) || siteCfg(s.id));
  const brief = c.cfg.keyBrief && fs.existsSync(path.join(c.dir, c.cfg.keyBrief)) ? fs.readFileSync(path.join(c.dir, c.cfg.keyBrief), "utf8").trim() : "";
  const blues = pads.filter((p: any) => p.colour.startsWith("blue"));
  const lines = [
    `TASK: draw a flat-colour town-plan KEY (a categorical map, not a picture) for ${c.townDoc.name ?? c.town}, laid out over the attached SITE MAP. The output is read by a program pixel by pixel, so follow the colour and geometry rules exactly.`,
    "",
    `THE ATTACHED SITE MAP (same framing as your output): ${px} x ${px} px, top-down, north is up, ${ppm} px = 1 metre (the map is ${size} m across). ${seaPx} Thin dark lines are 2 m height contours (heavier every 10 m); the ground runs from ${round(map.heightRange[0], 1)} m to ${round(map.heightRange[1], 1)} m. Yellow lines are the existing roads${entries.length ? `: ${entries.join("; ")}` : ""}. Gates: ${gates.join("; ")}.`,
    "",
    `DRAW ON A PURE WHITE BACKGROUND, at exactly the same framing, ${px} x ${px} px. Keep the four solid black 32 px squares in the four corners exactly where they are in the site map (top-left corner at 8,8 / 984,8 / 8,984 / 984,984). Do NOT copy the map itself: no contours, no shading, no yellow road, no text, no labels, no outlines, no gradients, no anti-aliasing, no drop shadows. Only these flat colours:`,
    "",
    "1. TOWN SQUARE, pink #FF9999: one open square, with the main gate opening onto it.",
    `2. STREETS, red #FF0000, 24 px wide. A street must be a walkable climb: between two neighbouring contour lines it runs at least ${Math.round((2 / c.cfg.grades.street) * ppm * 0.75)} px of street length; where the slope is steep it runs diagonally or turns (a gentle Z), never straight down the contours. Every road that arrives at the map continues into the town at a gentle grade.`,
    "3. SIDE LANES, orange #FF8800, 16 px wide, branching off a street and running ALONG the contours (nearly level), so houses can line them.",
    ...structures.map((s: any, i: number) => s.kind === "dock"
      ? `${4 + i}. QUAY SITE, black #000000: a strip 24 px wide along the waterline (land side) where a street meets the shore (${s.name}). It only marks WHERE the dock goes; it is built later.`
      : siteCfg(s.id)
        ? `${4 + i}. ${String(s.name).toUpperCase()} SITE, cyan #00FFFF: one solid rectangle ${Math.round(siteCfg(s.id).size[0] * ppm)} x ${Math.round(siteCfg(s.id).size[1] * ppm)} px (${siteCfg(s.id).size[0]} x ${siteCfg(s.id).size[1]} m) touching a street or lane along one side (${s.note ? String(s.note).split(".")[0] : s.id}). It only marks WHERE it goes; it is built later.`
        : `${4 + i}. ${String(s.name).toUpperCase()} SITE, cyan #00FFFF: one solid block on level ground (${s.note ? String(s.note).split(".")[0] : s.id}).`),
    `${4 + structures.length}. BUILDING PADS, filled rectangles at EXACTLY these sizes (they are measured from the real building models, door steps included: a smaller pad will not hold its building). Each pad touches a street, a lane or the square along one whole LONG-or-SHORT side as listed (the first number runs along the street: that side is its front door). Rectangles may be rotated to follow their street. Leave at least 12 px of white between any two pads and between a pad and any street it does not front. Exactly ${pads.length} pads:`,
    ...pads.map((p: any) => `   - ${p.name} (${p.use || p.id}): ${p.colour}, ${p.wPx} px along the street x ${p.dPx} px deep (${p.m[0]} x ${p.m[1]} m)`),
    `${5 + structures.length}. STAIRS, purple #8000FF, 16 px wide: only if a short direct footpath is really needed somewhere steep; otherwise none.`,
    "",
    `Everything else must be pure white #FFFFFF. Nothing may be drawn in the sea except a jetty. ${blues.length} plain pads are blue; the special pads are yellow (chapel) and magenta (hall). The whole town should read as ONE connected place.`,
    ...(brief ? ["", "LAYOUT INTENT (where things go):", brief] : []),
    ...(opt("prev") ? ["", `The SECOND attached image is the previous key (${opt("prev")}), for reference only: keep what the layout intent keeps from it, but every pad must now have the size listed above.`] : []),
  ];
  let k = 1;
  while (fs.existsSync(path.join(c.dir, `key-${k}.png`))) k++;
  const promptFile = path.join(c.dir, `prompt-key-${k}.txt`);
  fs.writeFileSync(promptFile, `${lines.join("\n")}\n`);
  writeJson(path.join(c.dir, `prompt-key-${k}.pads.json`), pads);
  const prev = opt("prev");
  const args = ["tools/image-request.mjs", "gen", "--id", `${c.town}-town-key-${k}`, "--target", rel(path.join(c.dir, `key-${k}.png`)), "--size", `${px}x${px}`,
    "--prompt-file", rel(promptFile), "--ref", rel(path.join(c.dir, "site-map.png")), ...(prev ? ["--ref", rel(path.join(c.dir, prev))] : []), ...(flag("dry-run") ? ["--dry-run"] : []), ...(opt("timeout") ? ["--timeout", opt("timeout")] : [])];
  console.log(`prompt written: ${rel(promptFile)} (${pads.length} pads sized from the envelopes)\n> node ${args.join(" ")}`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status) process.exit(r.status);
  if (!flag("dry-run")) console.log(`next: npx tsx tools/town-ground.mts key --project ${c.project} --town ${c.town} --key key-${k}.png`);
}

// ------------------------------------------------------------------ build / undo
function build(): void {
  const dry = flag("dry");
  const r = buildGround(c, { dry });
  console.log(r.summary);
  const elide = (edits: any[]): any[] => edits.map((e) => (e.kind === "heightPatches" ? { ...e, feature: { ...e.feature, heights: `<${c.n * c.n} samples, see the recipe>` } } : e));
  if (dry) {
    writeJson(path.join(c.dir, "ground-edits-dry.json"), elide(r.edits));
    writeJson(path.join(c.dir, "ground-report-dry.json"), r.report);
    fs.writeFileSync(path.join(c.dir, "ground-dry.f32"), Buffer.from(new Float32Array(r.heights).buffer));
    console.log(`dry run: ${rel(c.dir)}/ground-edits-dry.json, ground-report-dry.json, ground-dry.f32 (recipe and plan untouched)`);
    return;
  }
  fs.copyFileSync(path.join(c.townsDir, `${c.town}-plan.json`), path.join(c.dir, "plan-before-build.json"));
  writeJson(path.join(c.dir, "ground-edits.json"), elide(r.edits));
  writeJson(path.join(c.dir, "ground-inverse.json"), r.inverse);
  writeJson(path.join(c.dir, "ground-report.json"), r.report);
  writeRecipe(r.recipe);
  r.writePlan();
  console.log(`installed into ${rel(c.worldFile)}; plan lots written. Next: town-survey, town-layout, then buildings, install, and \`doors\`.`);
}
function undo(): void {
  const step = opt("step");
  const inv = path.join(c.dir, step === "build" ? "ground-inverse.json" : step === "doors" ? "doors-inverse.json" : "");
  if (!step || !fs.existsSync(inv)) throw new Error("undo --step build|doors (needs the saved inverse)");
  const recipe = worldRecipeSchema.parse(readJson(c.worldFile));
  writeRecipe(applyRecipeEdits(recipe, readJson(inv)).recipe);
  if (step === "build" && fs.existsSync(path.join(c.dir, "plan-before-build.json"))) fs.copyFileSync(path.join(c.dir, "plan-before-build.json"), path.join(c.townsDir, `${c.town}-plan.json`));
  fs.renameSync(inv, `${inv}.applied`);
  console.log(`undone: ${step} (${rel(inv)} -> .applied)`);
}

// ------------------------------------------------------------------ doors
interface Poly { id: string; pts: P[] }
const inPoly = (pts: P[], x: number, z: number): boolean => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i]!, [xj, zj] = pts[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
/** Signed-ish distance: 0 inside, else the distance to the polygon's edge. */
const polyDist = (pts: P[], x: number, z: number): number => (inPoly(pts, x, z) ? 0 : segDist([...pts, pts[0]!], x, z));

function doors(): void {
  const dry = flag("dry");
  const T = c.cfg.townId, PREFIX = `${T}-door-`;
  const PC = c.cfg.paths;
  const layoutFile = path.join(c.townsDir, `${c.town}-layout.json`);
  const layout = readJson(layoutFile);
  const manifestFile = opt("manifest") ? path.resolve(opt("manifest")) : path.join(c.projectDir, "assets", "models", "towns", c.town, "manifest.json");
  if (!fs.existsSync(manifestFile)) throw new Error(`no building manifest at ${rel(manifestFile)} (--manifest <file>)`);
  const manifest = readJson(manifestFile);
  const env = readJson(path.join(c.townsDir, `${c.town}-envelopes.json`));
  const plan = readJson(path.join(c.townsDir, `${c.town}-plan.json`));
  const raw = readJson(c.worldFile);
  const recipe0 = worldRecipeSchema.parse(raw);
  // the ground the paths follow: the recipe WITHOUT this step's own paths (so a re-run sees the same ground)
  const withoutMine = { ...recipe0, features: { ...recipe0.features, roads: recipe0.features.roads.filter((r) => !r.id.startsWith(PREFIX)) } };
  const field = createWorldField(withoutMine);
  const streets = withoutMine.features.roads.filter((r) => r.id.startsWith(`${T}-`));
  if (!streets.length) throw new Error(`no town street roads (${T}-*) in the recipe: run build first`);
  const surface = PC.surface ?? (streets.find((r) => /lane/.test(r.id))?.surface || "dirt");
  // the grid: the lots' bounding box + 40 m, 1 m cells
  const allPts = layout.buildings.flatMap((b: any) => b.full ?? b.corners) as P[];
  const gx0 = Math.floor(Math.min(...allPts.map((p) => p[0])) - 40), gz0 = Math.floor(Math.min(...allPts.map((p) => p[1])) - 40);
  const gx1 = Math.ceil(Math.max(...allPts.map((p) => p[0])) + 40), gz1 = Math.ceil(Math.max(...allPts.map((p) => p[1])) + 40);
  const W = gx1 - gx0 + 1, H = gz1 - gz0 + 1, NN = W * H;
  const hh = new Float32Array(NN);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) hh[i + j * W] = field.height(gx0 + i, gz0 + j);
  const KK = (x: number, z: number): number => { const i = Math.round(x - gx0), j = Math.round(z - gz0); return i < 0 || j < 0 || i >= W || j >= H ? -1 : i + j * W; };
  const XY = (k: number): P => [gx0 + (k % W), gz0 + Math.floor(k / W)];
  const hAt = (x: number, z: number): number => field.height(x, z);
  // street cells: inside a town street's paved band (0.5 m in from its edge); the targets
  const streetOf = new Int16Array(NN).fill(-1);
  for (let k = 0; k < NN; k++) { const [x, z] = XY(k); streets.forEach((r, si) => { if (streetOf[k]! < 0 && segDist(r.points as P[], x, z) <= Math.max(0.6, r.width / 2 - 0.5)) streetOf[k] = si; }); }
  // other lots and reserved structure sites are out of bounds for the path's whole band (half width + shoulder + clearance)
  const band = PC.width / 2 + PC.shoulder;
  const lots: (Poly & { ground: P[] })[] = layout.buildings.map((b: any) => ({ id: b.id, pts: (b.full ?? b.corners) as P[], ground: (b.ground ?? b.corners) as P[] }));
  const sites: Poly[] = (plan.structures ?? []).filter((s: any) => s.site?.corners).map((s: any) => ({ id: s.id, pts: s.site.corners as P[] }));
  const sea = (raw.seaLevel ?? 0) + 0.6;
  const lotDist: Float32Array[] = lots.map((l) => { const d = new Float32Array(NN); for (let k = 0; k < NN; k++) d[k] = polyDist(l.pts, ...XY(k)); return d; });
  const siteBlock = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) if (sites.some((s) => polyDist(s.pts, ...XY(k)) < band)) siteBlock[k] = 1;

  const results: any[] = [];
  const features: any[] = [];
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
  for (const [li, b] of layout.buildings.entries()) {
    const model = b.model ?? b.id;
    const m = manifest.models?.[model];
    const row: any = { lot: b.id, model };
    results.push(row);
    if (!m?.door) { row.status = "no-door"; row.why = `manifest has no door for model ${model}`; continue; }
    // the door in the world: the lot's centre + the model's own door, turned by the building's rotation (yaw + preRot)
    const th = (b.yaw ?? 0) + (b.preRot ?? 0), cs = Math.cos(th), sn = Math.sin(th);
    const rot = (x: number, z: number): P => [x * cs + z * sn, -x * sn + z * cs];
    const dp = rot(m.door.position[0], m.door.position[2]), df = rot(m.door.facing[0], m.door.facing[1]);
    const door: P = [b.centre[0] + dp[0], b.centre[1] + dp[1]];
    const ext = envelopeOf(env, model), g = PRE[ext.door ?? "-y"]!(ext.full ?? ext.ground);
    const steps = Math.max(0.5, g.front * c.cfg.cell); // the measured front extent: the entry steps
    const foot: P = [door[0] + df[0] * steps, door[1] + df[1] * steps];
    // the route starts where the door ray leaves the building's own envelope: a recessed door (under a jetty or a
    // porch) opens metres inside the full envelope, so the path runs straight out from the foot first
    let out = steps;
    while (out < 15 && polyDist(lots[li]!.pts, door[0] + df[0] * out, door[1] + df[1] * out) < 1) out += 0.25;
    const startAt = Math.max(out, steps + 1);
    const start: P = [door[0] + df[0] * startAt, door[1] + df[1] * startAt];
    Object.assign(row, { door: door.map((v) => round(v)), facing: df.map((v) => round(v, 1000)), foot: foot.map((v) => round(v)), stepsDepth: round(steps), footY: round(hAt(...foot)) });
    const s0 = KK(...start);
    if (s0 < 0) { row.status = "unreached"; row.why = "door outside the grid"; continue; }
    if (streetOf[s0]! >= 0 || streetOf[KK(...foot)] >= 0) { row.status = "at-street"; row.joins = streets[Math.max(streetOf[s0]!, streetOf[KK(...foot)]!)]!.id; row.length = 0; continue; }
    // Dijkstra to the first street cell. Hard: never through a structure site, the sea, its own building, or with
    // its paved surface inside another lot's envelope. Soft: the shoulder and the clearance margin round another
    // lot cost 5x, so the path keeps off a neighbour's pad wherever there is room.
    const route = (): number[] | null => {
      const cost = (k: number): number => {
        if (streetOf[k]! >= 0) return 1;
        if (siteBlock[k] || hh[k]! < sea) return Infinity;
        let m = 1;
        for (let o = 0; o < lots.length; o++) {
          const d = lotDist[o]![k]!;
          if (o === li) { if (d < 0.5) return Infinity; continue; }
          if (d < PC.width / 2) return Infinity;
          if (d < band + PC.clearance) m = 5;
        }
        return m;
      };
      const D = new Float32Array(NN).fill(Infinity), prev = new Int32Array(NN).fill(-1), heap = new Heap();
      D[s0] = 0; heap.push(0, s0);
      while (heap.size) {
        const [d, k] = heap.pop(); if (d > D[k]!) continue;
        if (streetOf[k]! >= 0) { const out = [k]; while (prev[out.at(-1)!]! >= 0) out.push(prev[out.at(-1)!]!); return out.reverse(); }
        const i = k % W, j = (k - i) / W;
        for (const [di, dj] of nb) {
          const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const kk = ii + jj * W, m = cost(kk); if (m === Infinity) continue;
          const l = Math.hypot(di, dj), gr = Math.abs(hh[kk]! - hh[k]!) / l;
          if (gr > 0.6) continue; // a cliff: never
          const nd = d + l * (m + 10 * Math.max(0, gr - PC.grade * 0.6) + (gr > PC.grade ? 40 * (gr - PC.grade) : 0));
          if (nd < D[kk]!) { D[kk] = nd; prev[kk] = k; heap.push(nd, kk); }
        }
      }
      return null;
    };
    const cells = route();
    if (!cells) { row.status = "unreached"; row.why = "no route to a street clear of the other lots' envelopes, the structure sites and the sea"; continue; }
    // centreline: foot -> (straight out of a recess) -> cells (smoothed) -> 1 m into the street
    const raw0: P[] = [foot, ...(dist(start, foot) > 1.5 ? [start] : []), ...cells.map(XY)];
    const sm: P[] = raw0.map((p, i) => { if (i < 2 || i > raw0.length - 2) return p; let sx = 0, sz = 0, cnt = 0; for (let d = -2; d <= 2; d++) { const q = raw0[Math.max(0, Math.min(raw0.length - 1, i + d))]!; sx += q[0]; sz += q[1]; cnt++; } return [sx / cnt, sz / cnt] as P; });
    const last = sm.at(-1)!, before = sm.at(-2) ?? foot, dl = dist(last, before) || 1;
    const endP: P = [last[0] + ((last[0] - before[0]) / dl) * 1, last[1] + ((last[1] - before[1]) / dl) * 1];
    let pts = resample([...sm, endP], 2);
    if (pts.length > 2 && dist(pts.at(-1)!, pts.at(-2)!) < 1) pts.splice(pts.length - 2, 1); // no stub last segment
    // profile: the ground, anchored at the step foot and at the street, slope-limited to the walkable grade
    const t = pts.map((p) => hAt(p[0], p[1]));
    const L = pts.length, s: number[] = [0];
    for (let i = 1; i < L; i++) s.push(s[i - 1]! + dist(pts[i]!, pts[i - 1]!));
    const yA = hAt(...foot), yB = hAt(...pts.at(-1)!);
    const G = PC.grade;
    const hs = t.map((v, i) => {
      const lo = Math.max(yA - s[i]! * G, yB - (s[L - 1]! - s[i]!) * G), hi = Math.min(yA + s[i]! * G, yB + (s[L - 1]! - s[i]!) * G);
      return lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
    });
    hs[0] = yA; hs[L - 1] = yB;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < L; i++) { const dd = G * (s[i]! - s[i - 1]!); hs[i] = Math.max(hs[i - 1]! - dd, Math.min(hs[i - 1]! + dd, hs[i]!)); }
      for (let i = L - 2; i >= 0; i--) { const dd = G * (s[i + 1]! - s[i]!); hs[i] = Math.max(hs[i + 1]! - dd, Math.min(hs[i + 1]! + dd, hs[i]!)); }
    }
    pts = pts.map((p) => [round(p[0]), round(p[1])] as P);
    let maxGrade = 0, maxCut = 0, length = 0;
    for (let i = 1; i < L; i++) { const l = dist(pts[i]!, pts[i - 1]!); length += l; maxGrade = Math.max(maxGrade, Math.abs(hs[i]! - hs[i - 1]!) / (l || 1)); }
    for (let i = 0; i < L; i++) maxCut = Math.max(maxCut, Math.abs(hs[i]! - t[i]!));
    // clearance check on the final centreline: every other lot's envelope stays outside the band
    let minClear = Infinity, nearest = "";
    for (const p of resample(pts, 0.5)) for (const [o, l] of lots.entries()) if (o !== li) { const d = polyDist(l.pts, p[0], p[1]) - band; if (d < minClear) { minClear = d; nearest = l.id; } }
    const joins = streets[streetOf[cells.at(-1)!]!]!.id;
    const feature = { id: `${PREFIX}${b.id}`, points: pts, width: PC.width, shoulder: PC.shoulder, surfaceY: hs.map((v) => round(v)), smooth: 0, flatten: 1, surface, surfaceEdge: 0.8 };
    features.push(feature);
    Object.assign(row, { status: "painted", road: feature.id, joins, length: round(length, 10), points: L, from: round(yA), to: round(yB), maxGrade: round(maxGrade, 1000), gradeOk: maxGrade <= G + 0.005, maxCutFill: round(maxCut), minClearToOtherLot: round(minClear), nearestLot: nearest });
  }
  const edits: any[] = [
    ...recipe0.features.roads.filter((r) => r.id.startsWith(PREFIX)).map((r) => ({ edit: "remove-feature", kind: "roads", id: r.id })),
    ...features.map((f) => ({ edit: "add-feature", kind: "roads", feature: f })),
  ];
  const result = applyRecipeEdits(recipe0, edits);
  const hash = (f: string): string => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex").slice(0, 12);
  const painted = results.filter((r) => r.status === "painted");
  const failures = results.filter((r) => r.status === "unreached" || r.status === "no-door" || (r.status === "painted" && (!r.gradeOk || r.minClearToOtherLot < -PC.shoulder - 0.01))).map((r) => `${r.lot}: ${r.why ?? (!r.gradeOk ? `grade ${r.maxGrade}` : `band within ${r.minClearToOtherLot} m of ${r.nearestLot}`)}`);
  const report = {
    tool: "town-ground doors", town: c.town, townId: T, world: c.cfg.world, dry,
    inputs: { layout: { file: rel(layoutFile), sha1: hash(layoutFile) }, manifest: { file: rel(manifestFile), sha1: hash(manifestFile) } },
    path: { prefix: PREFIX, width: PC.width, shoulder: PC.shoulder, grade: PC.grade, surface, clearance: PC.clearance },
    counts: { lots: results.length, painted: painted.length, atStreet: results.filter((r) => r.status === "at-street").length, failures: failures.length },
    totalMetres: round(painted.reduce((s, r) => s + r.length, 0), 10), failures, doors: results,
  };
  for (const r of results) console.log(`  ${r.lot.padEnd(16)} ${String(r.status).padEnd(10)} ${r.status === "painted" ? `${String(r.length).padStart(5)} m -> ${r.joins}  max ${(r.maxGrade * 100).toFixed(0)}%  cut/fill ${r.maxCutFill} m  clear ${r.minClearToOtherLot} m${r.minClearToOtherLot < 0 ? " (shoulder grazes " + r.nearestLot + ")" : ""}` : r.why ?? r.joins ?? ""}`);
  console.log(`${painted.length} path(s), ${report.totalMetres} m; ${failures.length} failure(s)${failures.length ? `: ${failures.join("; ")}` : ""}`);
  if (dry) { writeJson(path.join(c.dir, "doors-report-dry.json"), report); console.log("dry run: recipe untouched"); return; }
  writeJson(path.join(c.dir, "doors-edits.json"), edits);
  writeJson(path.join(c.dir, "doors-inverse.json"), result.inverse);
  writeRecipe(result.recipe);
  writeJson(path.join(c.townsDir, `${c.town}-paths.json`), report);
  // review map: the paths over the ground, lots outlined
  {
    const S = 3, Mw = W * S, Mh = H * S, img = new Uint8Array(Mw * Mh * 4);
    const after = createWorldField(worldRecipeSchema.parse(result.recipe));
    const ah = new Float32Array(NN); for (let k = 0; k < NN; k++) ah[k] = after.height(...XY(k));
    for (let y = 0; y < Mh; y++) for (let x = 0; x < Mw; x++) {
      const i = Math.floor(x / S), j = Math.floor(y / S), k = i + j * W, v = ah[k]!;
      const sx = (ah[Math.min(NN - 1, k + 1)]! - ah[Math.max(0, k - 1)]!), sz = (ah[Math.min(NN - 1, k + W)]! - ah[Math.max(0, k - W)]!);
      let col = v < (raw.seaLevel ?? 0) ? [70, 110, 170] : [140 + Math.min(80, v * 2.5), 160 + Math.min(60, v * 1.5), 120];
      col = col.map((q) => q * Math.max(0.55, Math.min(1.2, 1 - (sx + sz) * 0.15)));
      if (streetOf[k]! >= 0) col = [150, 150, 150];
      if (lotDist.some((d) => d[k] === 0)) col = [90, 90, 200];
      img.set([...col.map((q) => Math.max(0, Math.min(255, Math.round(q)))), 255], (x + y * Mw) * 4);
    }
    const dot = (p: P, r: number, col: number[]): void => { const cx = (p[0] - gx0 + 0.5) * S, cy = (p[1] - gz0 + 0.5) * S; for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if (x >= 0 && y >= 0 && x < Mw && y < Mh && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) img.set([...col, 255], (x + y * Mw) * 4); };
    for (const f of features) for (const p of resample(f.points as P[], 0.3)) dot(p, (PC.width / 2) * S, [200, 150, 80]);
    for (const r of results) if (r.foot) dot(r.foot, 4, r.status === "unreached" ? [255, 0, 0] : [255, 255, 255]);
    fs.writeFileSync(path.join(c.dir, "doors-map.png"), encodePng(Mw, Mh, img));
  }
  console.log(`written: ${rel(c.worldFile)} (${features.length} -door- roads), ${rel(path.join(c.townsDir, `${c.town}-paths.json`))}, ${rel(c.dir)}/doors-edits.json, doors-inverse.json, doors-map.png`);
  if (failures.length) process.exitCode = 1;
}

// ------------------------------------------------------------------ paving
function paving(): void {
  // paint role only, on the raw file read fresh: nothing else in the recipe is rewritten
  const raw = readJson(c.worldFile);
  const prefix = `${c.cfg.townId}-street-`;
  const role = flag("off") ? "road" : "paving";
  const before: { id: string; role: string | null }[] = [];
  for (const road of raw.features?.roads ?? []) {
    if (typeof road.id !== "string" || !road.id.startsWith(prefix)) continue;
    if (road.role === role || (role === "road" && road.role === undefined)) continue;
    before.push({ id: road.id, role: road.role ?? null });
    if (role === "road") delete road.role;
    else road.role = role;
  }
  if (before.length === 0) {
    console.log(`${c.town}: every ${prefix}* road already ${role === "paving" ? "paved" : "unpaved"} — nothing written`);
    return;
  }
  worldRecipeSchema.parse(raw); // never leave a broken world on disk
  writeRecipe(raw);
  fs.mkdirSync(c.dir, { recursive: true });
  writeJson(path.join(c.dir, "paving-inverse.json"), before);
  console.log(`${c.town}: ${before.length} street road(s) -> role "${role}" (${before.map((b) => b.id.slice(prefix.length)).join(", ")})`);
  const zone = (raw.regions ?? []).find((r: any) => r.landmarks?.[0] === c.cfg.townId && r.tags?.includes("town"));
  const parent = zone?.within ? (raw.regions ?? []).find((r: any) => r.id === zone.within) : null;
  if (role === "paving" && !(zone?.ground?.paving || parent?.ground?.paving)) console.log(`  note: ${parent?.id ?? "its zone"} has no ground.paving yet — run worldgen zone-textures; until then the streets keep their gravel`);
}

if (cmd === "export") exportSite();
else if (cmd === "paving") paving();
else if (cmd === "request") request();
else if (cmd === "key") { const k = opt("key"); if (!k) throw new Error("key --key <file in the -ground folder>"); console.log(parseKey(c, k)); }
else if (cmd === "build") build();
else if (cmd === "undo") undo();
else if (cmd === "doors") doors();
