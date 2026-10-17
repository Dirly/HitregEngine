/**
 * see-through — holes you can see through the map, found ON SCREEN along the real player route.
 *
 * Mesh audits miss what only shows on screen: single-sided faces seen from behind, seams between baked groups, DC
 * slivers on thin arches and hulls, decimation pinches, a group culled while still in sight. This renders the scene
 * in play with a SENTINEL background (pure magenta; sky dome, particles and sprites hidden; no post chain — fog is
 * kept, it never paints magenta) from player eye height every ~3.5 m of the route, six 90° views per sample (a cube),
 * and counts magenta where a surface must be (@hitreg/render see-through.ts: the rule, the clusters, the cause).
 *
 *   node node_modules/tsx/dist/cli.mjs tools/see-through.mts scene <sceneId> [options]
 *       route: the project's reports/walk.json (the dungeon walk gate's legs) unless --route <file> (repeatable): a
 *       POI walk-route*.json ({ spawn:[x,z], legs:[{ to:[x,z] }] }) or [[x,y,z], ...] eye points
 *   node node_modules/tsx/dist/cli.mjs tools/see-through.mts prop <sceneId> --entity <id> [--angles 12] [options]
 *       one big prop / DC group seen ALONE (everything else hidden): an orbit of --angles azimuths at two heights plus
 *       inside views from its centre; only enclosed sentinel counts (light through the hull)
 *
 *   --mode indoor|outdoor   default: outdoor when the scene has a voxelWorld, else indoor (docs/see-through.md)
 *   --openings <file>       allowed openings [{ name, min:[x,y,z], max:[x,y,z] } | { name, center, half }] (default
 *                           <project>/authoring/see-through-openings.json; portal triggers are always allowed)
 *   --step 3.5 --size 128 --min-px 6 --hour 12 --far 600
 *   --batch k/n             this run does every n-th sample from k (1-based); parts merge when all n are present
 *   --out <report.json>     default <project>/reports/see-through.json (prop: reports/see-through-prop-<entity>.json)
 *   --port 5284 | --url <dev app>     --force (ignore the cache)   --headed
 *
 * Cached: the report records an inputs hash (scene file, the project's models, routes, openings, options, this tool and
 * the probe); a re-run with the same hash prints the cached verdict and exits. Exit 1 when holes were found.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(PG, "..", "..");
const PROBE_SRC = path.join(ROOT, "packages", "render", "src", "see-through.ts");
const argv = process.argv.slice(2);
const MODE_CMD = argv[0];
const SCENE = argv[1] ?? "";
const arg = (n: string, d = "") => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const args = (n: string) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]!] : []));
if (!["scene", "prop"].includes(MODE_CMD ?? "") || !SCENE) {
  console.error("usage: see-through.mts scene <sceneId> [--route <file>] | prop <sceneId> --entity <id>   (see the header)");
  process.exit(2);
}
type V3 = [number, number, number];

// -- scene, project, route ----------------------------------------------------------------------------------------
let projectDir = "";
for (const p of fs.readdirSync(path.join(PG, "projects"))) {
  if (fs.existsSync(path.join(PG, "projects", p, "assets", "scenes", `${SCENE}.scene.json`))) { projectDir = path.join(PG, "projects", p); break; }
}
if (!projectDir) { console.error(`STOP: no scenes/${SCENE}.scene.json in any project`); process.exit(2); }
const sceneFile = path.join(projectDir, "assets", "scenes", `${SCENE}.scene.json`);
type Ent = { name: string; parent: string | null; tags?: string[]; components: Record<string, any> };
const doc = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as { entities: Record<string, Ent> };
const voxel = Object.values(doc.entities).some((e) => e.components["voxelWorld"]);
const RULE_MODE = (arg("mode") || (voxel ? "outdoor" : "indoor")) as "indoor" | "outdoor";
const STEP = Number(arg("step", "3.5"));
const SIZE = Number(arg("size", MODE_CMD === "prop" ? "192" : "128"));
const MIN_PX = Number(arg("min-px", "6"));
const FAR = Number(arg("far", "600"));
const HOUR = arg("hour", "12");
const ENTITY = arg("entity");
const ANGLES = Number(arg("angles", "12"));
const [BATCH_K, BATCH_N] = (arg("batch", "1/1").split("/").map(Number) as [number, number]);
const OUT = path.resolve(arg("out", path.join(projectDir, "reports", MODE_CMD === "prop" ? `see-through-prop-${ENTITY.replace(/[^\w-]+/g, "_")}.json` : "see-through.json")));
const OUT_DIR = path.join(path.dirname(OUT), path.basename(OUT, ".json"));
if (MODE_CMD === "prop" && !ENTITY) { console.error("STOP: prop mode needs --entity <id>"); process.exit(2); }

/** A sample: where the player body goes and the eye; `floor` unknown (a 2-D POI route) = found in the page. */
type Sample = { idx: number; leg: string; at: V3; eyeUp: number; floorKnown: boolean };
const routeFiles = args("route").map((f) => path.resolve(f));
const walkFile = path.join(projectDir, "reports", "walk.json");
function sampleRoutes(): Sample[] {
  const raw: Array<{ leg: string; a: V3; b: V3; known: boolean }> = [];
  const pts: Array<{ leg: string; p: V3; known: boolean }> = [];
  if (routeFiles.length) {
    for (const f of routeFiles) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const tag = path.basename(f, ".json");
      if (Array.isArray(j) || Array.isArray(j.points)) { for (const p of (Array.isArray(j) ? j : j.points) as V3[]) pts.push({ leg: tag, p, known: true }); continue; }
      let prev: V3 = [j.spawn[0], 0, j.spawn[1]];
      for (const l of j.legs ?? []) { const to: V3 = [l.to[0], 0, l.to[1]]; raw.push({ leg: `${tag}:${l.id ?? ""}`, a: prev, b: to, known: false }); prev = to; }
    }
  } else if (fs.existsSync(walkFile)) {
    const w = JSON.parse(fs.readFileSync(walkFile, "utf8"));
    for (const l of w.legs ?? []) if (l.from && (l.end ?? l.to)) raw.push({ leg: String(l.id), a: l.from as V3, b: (l.end ?? l.to) as V3, known: true });
  } else { console.error(`STOP: no route — pass --route <walk-route.json> or run the walk gate first (${walkFile})`); process.exit(2); }
  for (const s of raw) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    const n = Math.max(1, Math.ceil(len / STEP));
    for (let k = 0; k <= n; k++) { const t = k / n; pts.push({ leg: s.leg, p: [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t, s.a[2] + (s.b[2] - s.a[2]) * t], known: s.known }); }
  }
  // one sample per STEP/2 cell: routes double back through the same doors
  const seen = new Set<string>(), out: Sample[] = [];
  const cell = STEP / 2;
  for (const q of pts) {
    const key = [q.p[0], q.p[1], q.p[2]].map((v) => Math.round(v / cell)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ idx: out.length, leg: q.leg, at: q.p, eyeUp: q.known ? 0.7 : 1.6, floorKnown: q.known });
  }
  return out;
}
const samples = MODE_CMD === "scene" ? sampleRoutes() : [];

// -- openings -------------------------------------------------------------------------------------------------------
type Opening = { name: string; min: V3; max: V3 };
const openingsFile = path.resolve(arg("openings", path.join(projectDir, "authoring", "see-through-openings.json")));
const declared: Opening[] = fs.existsSync(openingsFile)
  ? (JSON.parse(fs.readFileSync(openingsFile, "utf8")) as any[]).map((o) => (o.min ? o : { name: o.name, min: o.center.map((c: number, a: number) => c - o.half[a]), max: o.center.map((c: number, a: number) => c + o.half[a]) }))
  : [];
/** Walk-through portals (trigger boxes, inflated 1.5 m): their far side may be anything. Resolved in the page. */
const portalIds = Object.entries(doc.entities).filter(([, e]) => e.components["script"]?.name === "portal").map(([id, e]) => ({ id, half: (e.components["script"].params?.halfExtents ?? [2, 2, 1]) as V3, offset: (e.components["script"].params?.offset ?? [0, 1, 0]) as V3 }));

// -- cache ----------------------------------------------------------------------------------------------------------
function hashInputs(): string {
  const h = crypto.createHash("sha256");
  const add = (f: string) => { if (fs.existsSync(f)) { h.update(path.relative(ROOT, f)); h.update(fs.readFileSync(f)); } };
  add(sceneFile); add(PROBE_SRC); add(fileURLToPath(import.meta.url)); add(openingsFile);
  for (const f of routeFiles.length ? routeFiles : [walkFile]) add(f);
  const models = path.join(projectDir, "assets", "models");
  const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n); fs.statSync(f).isDirectory() ? walk(f) : add(f); } };
  walk(models);
  h.update(JSON.stringify({ MODE_CMD, RULE_MODE, STEP, SIZE, MIN_PX, FAR, HOUR, ENTITY, ANGLES, lodFull: argv.includes("--lod-full"), lodNear: argv.includes("--lod-near"), only: arg("samples") }));
  return h.digest("hex").slice(0, 16);
}
const inputsHash = hashInputs();
if (!argv.includes("--force") && fs.existsSync(OUT)) {
  const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
  if (prev.inputsHash === inputsHash) { console.log(`see-through ${SCENE}: cached (${inputsHash}) — ${prev.ok ? "ok" : `FAILED: ${prev.counts?.sites ?? "?"} hole site(s)`}  ${OUT}`); process.exit(prev.ok ? 0 : 1); }
}
const partFile = (k: number) => `${OUT.replace(/\.json$/, "")}.part${k}of${BATCH_N}.json`;
fs.mkdirSync(OUT_DIR, { recursive: true });

// -- browser --------------------------------------------------------------------------------------------------------
async function loadPlaywright(): Promise<any> {
  const env = process.env["HITREG_PLAYWRIGHT"];
  if (env) return createRequire(path.join(env, "package.json"))(env);
  try { return await import("playwright"); } catch { /* fall through */ }
  for (const dir of [process.cwd(), PG, ROOT]) { try { return createRequire(path.join(dir, "noop.js"))("playwright"); } catch { /* next */ } }
  console.error("STOP: playwright is not resolvable — set HITREG_PLAYWRIGHT=<playwright package dir>"); process.exit(2);
}
let vite: ReturnType<typeof spawn> | null = null;
let base = arg("url").replace(/\/$/, "");
const stopVite = () => { if (vite?.pid) { try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(vite.pid), "/t", "/f"]) : process.kill(vite.pid); } catch { /* gone */ } } };
process.on("exit", stopVite);
const t0 = Date.now();
if (!base) {
  const port = arg("port", "5284");
  const cfg = fs.existsSync(path.join(PG, "vite.agent-test.config.ts")) ? ["--config", "vite.agent-test.config.ts"] : [];
  vite = spawn(process.execPath, [path.join(PG, "node_modules", "vite", "bin", "vite.js"), ...cfg, "--port", port, "--strictPort"], { cwd: PG, stdio: ["ignore", "pipe", "pipe"] });
  base = `http://localhost:${port}`;
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite did not start in 90 s")), 90000);
    const on = (b: Buffer) => { if (/ready in|Local:/.test(b.toString())) { clearTimeout(t); res(); } };
    vite!.stdout!.on("data", on); vite!.stderr!.on("data", on);
    vite!.on("exit", (c) => rej(new Error(`vite exited ${c} (port ${port} taken?)`)));
  }).catch((e) => { console.error("STOP:", (e as Error).message); stopVite(); process.exit(2); });
}
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "chrome", headless: !argv.includes("--headed"), args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
// nothing this run does may reach disk; freeze the page at the code it booted with
await ctx.route(/\/__hitreg\//, (route: any) => { const r = route.request(); return r.method() !== "GET" && !/\/__hitreg\/log\b/.test(r.url()) ? route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" }) : route.continue(); });
await ctx.route(/\/@vite\/client(\?.*)?$/, (route: any) => route.fulfill({ contentType: "application/javascript", body: `export const createHotContext = () => ({ data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {} });
export const updateStyle = (id, css) => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
export const removeStyle = () => {}; export const injectQuery = (u) => u; export class ErrorOverlay extends HTMLElement {}` }));
await ctx.addInitScript(() => { (window as any).__name = (f: unknown) => f; try { const k = "hitreg-editor-settings"; const cur = JSON.parse(localStorage.getItem(k) || "{}"); localStorage.setItem(k, JSON.stringify({ ...cur, showStats: false, showGizmos: false, grid: false, showPhysics: false, showLights: false, showSkeletons: false })); } catch { /* */ } });
const page = await ctx.newPage();
const logs: string[] = [];
page.on("pageerror", (e: Error) => logs.push("pageerror: " + e.message.slice(0, 200)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H_ = <T,>(fn: (h: any, ...a: any[]) => T, ...a: unknown[]) => page.evaluate(([src, args]: [string, unknown[]]) => {
  const h = (window as any).__hitreg; return new Function("h", "args", `return (${src})(h, ...args)`)(h, args);
}, [fn.toString(), a]) as Promise<Awaited<T>>;
async function waitFor(cond: () => Promise<boolean>, ms: number, what: string) { const t = Date.now(); while (Date.now() - t < ms) { if (await cond().catch(() => false)) return; await sleep(300); } throw new Error(`timed out waiting for ${what}`); }
const cmd = (line: string) => page.evaluate((line: string) => { const f = document.querySelector(".hitreg-console-field") as HTMLInputElement | null; if (!f) return "! no console"; f.value = line; f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return "sent"; }, line) as Promise<string>;

type Hole = { sample: number; leg: string; view: string; eye: V3; dir: V3; pixels: number; clusterPixels: number; bbox: number[]; size: number; cause: string; entities: string[]; at: V3 | null; depth: number | null; crop?: string };
const holes: Hole[] = [];
let done = 0;
try {
  await page.goto(`${base}/?scene=${encodeURIComponent(SCENE)}`, { waitUntil: "load" });
  await waitFor(() => page.evaluate(() => !!(window as any).__hitreg?.playerId), 240000, "the dev app");
  await waitFor(() => H_((h, s: string) => h.sceneName() === s, SCENE), 240000, `scene ${SCENE}`);
  await sleep(2000);
  // the probe module, from the same dev server (same three instance as the app)
  const modUrl = "/@fs/" + PROBE_SRC.replace(/\\/g, "/").replace(/^\//, "");
  await page.evaluate(async (u: string) => { (window as any).__seeThrough = await import(/* @vite-ignore */ u); }, modUrl);
  if (MODE_CMD === "scene") {
    for (let tries = 0; ; tries++) {
      if (await H_((h) => h.playMode.get() === "edit")) { await page.locator("canvas").first().focus().catch(() => {}); await page.keyboard.press("Backquote"); }
      try { await waitFor(() => H_((h) => h.playMode.get() === "playing" && !!h.sim && !!h.playerId() && !h.travelling()), 60000, "play mode"); break; }
      catch (e) { if (tries >= 3) throw e; }
    }
    if (!(await cmd("/time")).startsWith("!")) { await cmd("/overcast 0"); await cmd("/weather clear"); await cmd(`/time ${HOUR}`); await cmd("/time freeze"); }
    await sleep(2500);
  } else await sleep(4000);
  // --lod-near (diagnosis): every instanced batch held at its full-detail tier — a hole that closes is the distance LOD's
  if (argv.includes("--lod-near")) { await H_((h) => { h.foliageLod?.setScreenError?.(1e-4); h.foliageLod?.setLodDistance?.(1e6); }); await sleep(3000); }
  console.log(`see-through ${SCENE} [${MODE_CMD}${MODE_CMD === "scene" ? `, ${RULE_MODE}` : ""}]: up in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${MODE_CMD === "scene" ? `${samples.length} samples, batch ${BATCH_K}/${BATCH_N}` : ENTITY}`);

  const pageProbe = (h: any, eye: V3, cfg: any, shots: any[] | null) => {
    const m = (window as any).__seeThrough, scene = h.scene();
    const openings = [...cfg.openings];
    for (const p of cfg.portals) {
      const o = h.object(p.id); if (!o) continue;
      const c = o.localToWorld(o.position.clone().set(p.offset[0], p.offset[1], p.offset[2]));
      openings.push({ name: `portal ${p.id}`, min: [0, 1, 2].map((a) => [c.x, c.y, c.z][a] - p.half[a] - 1.5), max: [0, 1, 2].map((a) => [c.x, c.y, c.z][a] + p.half[a] + 1.5) });
    }
    // a voxel world judges outdoor sky by its own solid (carves included): sky out of a gallery's open side is not a hole
    const solid = cfg.mode === "outdoor" && h.voxelSolid?.(0, 0, 0) !== null && h.voxelSolid ? (x: number, y: number, z: number) => h.voxelSolid(x, y, z) === true : undefined;
    const rule = { mode: cfg.mode, openings, ground: cfg.mode === "outdoor" ? (x: number, z: number) => h.terrainHeight(x, z) : undefined, groundReach: 80, enclosedMax: Math.round(cfg.size * cfg.size * 0.04), solid };
    const player = h.playerId?.() ? h.object(h.playerId()) : null;
    const isolate = cfg.entity ? h.object(cfg.entity) : null;
    let clustered = 0;
    scene.traverse((o: any) => { if (o.dag && typeof o.update === "function") { clustered++; if (cfg.lodFull) o.thresholdPx = 0; } });
    (window as any).__seeThroughClustered = clustered;
    const views = shots ? shots.map((s: any) => ({ eye: s.eye, fov: s.fov, view: { name: s.name, dir: s.dir, up: s.up } })) : undefined;
    return m.probeSeeThrough(h.renderer, scene, eye, { rule, size: cfg.size, minPixels: cfg.minPx, far: cfg.far, exclude: player ? [player] : [], isolate, layers: h.camera?.layers?.mask, lodHeight: Math.max(1080, h.renderer?.renderer?.domElement?.height || 0) }, views);
  };
  const cfg = { mode: MODE_CMD === "prop" ? "enclosed" : RULE_MODE, openings: declared, portals: portalIds, size: SIZE, minPx: MIN_PX, far: FAR, entity: MODE_CMD === "prop" ? ENTITY : null, lodFull: argv.includes("--lod-full") };
const ONLY = arg("samples") ? new Set(arg("samples").split(",").map(Number)) : null;

  if (MODE_CMD === "scene") {
    let lastFloor: number | null = null;
    for (const s of samples) {
      if ((s.idx % BATCH_N) !== BATCH_K - 1 || (ONLY && !ONLY.has(s.idx))) continue;
      let at = s.at;
      if (!s.floorKnown) { // a 2-D route: the floor under the point nearest the last one (stairs, decks, bridges)
        const f = await H_((h, x: number, z: number, last: number | null) => {
          const m = (window as any).__seeThrough, g = h.terrainHeight(x, z);
          const top = (Number.isFinite(g) ? g : last ?? 0) + 40;
          const hits = m.castAll(m.surfaceMeshes(h.scene()).filter((o: any) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }), [x, top, z], [0, -1, 0], 120)
            .filter((q: any) => !q.backFace).map((q: any) => q.point[1]);
          if (Number.isFinite(g)) hits.push(g);
          const ref = last ?? g;
          return hits.length ? hits.sort((a: number, b: number) => Math.abs(a - ref) - Math.abs(b - ref))[0] : g;
        }, at[0], at[2], lastFloor);
        lastFloor = Number.isFinite(f) ? f : lastFloor;
        at = [at[0], (lastFloor ?? 0) + 0.9, at[2]];
      }
      const tr = await H_((h, p: V3) => h.travelTo(p[0], p[1], p[2]), at);
      if (tr !== "ok") { console.warn(`  sample ${s.idx}: travel refused (${tr})`); continue; }
      for (let k = 0; k < 30 && (await H_((h) => h.travelling())); k++) await sleep(300);
      if (RULE_MODE === "outdoor") for (let k = 0; k < 30 && (await H_((h) => h.chunkManager?.stats?.loading ?? 0)) > 0; k++) await sleep(500);
      await sleep(450);
      const eye: V3 = [at[0], at[1] + s.eyeUp - (s.floorKnown ? 0 : 0.9), at[2]];
      const found = await H_(pageProbe, eye, cfg, null) as Omit<Hole, "sample" | "leg">[];
      // --dump <entityId> (diagnosis): what the runtime drew for that entity — mesh kind, triangles, tiers, visibility
      if (arg("dump") && done === 0) console.log("  dump", JSON.stringify(await H_((h, id: string) => { const out: any[] = [];
        h.scene().traverse((o: any) => { const ids = o.userData?.entityId === id || (o.userData && Object.values(o.userData).some((v: any) => v?.ids?.includes?.(id))); if (!o.isMesh || !ids) return;
          let vis = true; for (let q = o; q; q = q.parent) if (!q.visible) vis = false;
          out.push({ type: o.type, name: o.name, tris: (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3, drawRange: [o.geometry.drawRange.start, o.geometry.drawRange.count], count: o.count, vis, lod: !!o.userData.foliageLodBatch, layers: o.layers.mask, side: o.material?.side, frustumCulled: o.frustumCulled }); });
        return out; }, arg("dump"))));
      if (arg("dump") && done === 0) for (const f of found) console.log("  ray", f.view, f.pixels, JSON.stringify(await H_((h, eye: V3, dir: V3) => { const m = (window as any).__seeThrough;
        return m.castAll(m.surfaceMeshes(h.scene()), eye, dir, 600).slice(0, 4).map((q: any) => [q.entity, +q.distance.toFixed(2), q.visible, q.backFace, q.point.map((v: number) => +v.toFixed(2))]); }, f.eye, f.dir)), "camLayers", await H_((h) => h.camera.layers.mask));
      for (const f of found) holes.push({ sample: s.idx, leg: s.leg, ...f });
      done++;
      if (done === 1) console.log(`  cluster-LOD meshes in view: ${await page.evaluate(() => (window as any).__seeThroughClustered)}${cfg.lodFull ? " (forced to full detail)" : ""}`);
      if (done % 20 === 0) console.log(`  ${done} samples, ${holes.length} hole views — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  } else {
    // prop: an orbit at two heights + inside views from the centre, the prop alone against the sentinel
    const b = await H_((h, id: string) => { const o = h.object(id); if (!o) return null; const box = new (o.position.constructor as any)(); const T = (window as any).__seeThrough;
      const meshes = T.surfaceMeshes(o); let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const m of meshes) { m.geometry.computeBoundingBox?.(); const bb = m.geometry.boundingBox; if (!bb) continue; for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) { box.set(cx, cy, cz).applyMatrix4(m.matrixWorld); mn = [Math.min(mn[0], box.x), Math.min(mn[1], box.y), Math.min(mn[2], box.z)]; mx = [Math.max(mx[0], box.x), Math.max(mx[1], box.y), Math.max(mx[2], box.z)]; } }
      return { min: mn, max: mx, meshes: meshes.length }; }, ENTITY);
    if (!b || !Number.isFinite(b.min[0])) throw new Error(`entity ${ENTITY} not found or has no meshes`);
    const c: V3 = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2) as V3;
    const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
    const shots: any[] = [];
    for (const elev of [12, 40]) for (let k = 0; k < ANGLES; k++) {
      const az = (k / ANGLES) * Math.PI * 2, e = (elev * Math.PI) / 180, d = r * 1.9;
      const eye: V3 = [c[0] + Math.cos(az) * Math.cos(e) * d, c[1] + Math.sin(e) * d, c[2] + Math.sin(az) * Math.cos(e) * d];
      const dir = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]]; const l = Math.hypot(...dir);
      shots.push({ name: `orbit-${elev}-${Math.round((az * 180) / Math.PI)}`, eye, dir: dir.map((v) => v / l), up: [0, 1, 0], fov: 60 });
    }
    for (const f of [["+x", [1, 0, 0], [0, 1, 0]], ["-x", [-1, 0, 0], [0, 1, 0]], ["+z", [0, 0, 1], [0, 1, 0]], ["-z", [0, 0, -1], [0, 1, 0]], ["up", [0, 1, 0], [0, 0, -1]], ["down", [0, -1, 0], [0, 0, 1]]] as const)
      shots.push({ name: `inside${f[0]}`, eye: c, dir: f[1], up: f[2], fov: 90 });
    console.log(`  ${ENTITY}: ${b.meshes} meshes, radius ${r.toFixed(1)} m, ${shots.length} views`);
    for (let i = 0; i < shots.length; i += 6) {
      const found = await H_(pageProbe, c, cfg, shots.slice(i, i + 6)) as Omit<Hole, "sample" | "leg">[];
      for (const f of found) holes.push({ sample: i, leg: "prop", ...f });
      done += Math.min(6, shots.length - i);
    }
  }
} catch (e) {
  console.error(`STOP: ${(e as Error).message.split("\n")[0]}`);
  await page.screenshot({ path: path.join(OUT_DIR, "failed.png") }).catch(() => {});
  await browser.close().catch(() => {}); stopVite(); process.exit(2);
}

// -- part file, merge, sheet ----------------------------------------------------------------------------------------
for (const [i, hole] of holes.entries()) {
  if (!hole.crop) continue;
  const f = path.join(OUT_DIR, `b${BATCH_K}-${hole.sample}-${hole.view}-${i}.png`);
  fs.writeFileSync(f, Buffer.from(hole.crop.split(",")[1]!, "base64"));
  hole.crop = path.relative(path.dirname(OUT), f).replace(/\\/g, "/");
}
const part = { inputsHash, batch: [BATCH_K, BATCH_N], samples: MODE_CMD === "scene" ? samples.filter((s) => s.idx % BATCH_N === BATCH_K - 1).length : done, probed: done, seconds: Math.round((Date.now() - t0) / 1000), holes };
fs.writeFileSync(partFile(BATCH_K), JSON.stringify(part, null, 1));
console.log(`  batch ${BATCH_K}/${BATCH_N}: ${done} views probed, ${holes.length} hole views, ${part.seconds} s`);

const parts = Array.from({ length: BATCH_N }, (_, k) => partFile(k + 1)).map((f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null));
// --merge: merge the parts present even if an input changed between batches (a scene edited live); recorded as mixedInputs
const MERGE = argv.includes("--merge");
if (parts.every((p) => p && (p.inputsHash === inputsHash || MERGE))) {
  const all: Hole[] = parts.flatMap((p) => p.holes);
  // one physical hole is seen from many samples and faces: group by its world estimate (1.5 m), else by sample+view
  type Site = { id: number; at: V3 | null; cause: string; causes: Record<string, number>; entities: string[]; views: number; maxPixels: number; worst: Hole };
  const sites: Site[] = [];
  for (const h of all.sort((a, b) => b.pixels - a.pixels)) {
    const s = h.at ? sites.find((q) => q.at && Math.hypot(q.at[0] - h.at![0], q.at[1] - h.at![1], q.at[2] - h.at![2]) < 1.5) : undefined;
    if (s) { s.views++; s.causes[h.cause] = (s.causes[h.cause] ?? 0) + 1; for (const e of h.entities) if (!s.entities.includes(e)) s.entities.push(e); continue; }
    sites.push({ id: sites.length + 1, at: h.at ? h.at.map((v) => +v.toFixed(2)) as V3 : null, cause: h.cause, causes: { [h.cause]: 1 }, entities: [...h.entities], views: 1, maxPixels: h.pixels, worst: h });
  }
  for (const s of sites) s.cause = Object.entries(s.causes).sort((a, b) => b[1] - a[1])[0]![0];
  const names = (id: string) => doc.entities[id]?.name ?? id;
  const counts: Record<string, number> = { sites: sites.length, holeViews: all.length };
  for (const s of sites) counts[s.cause] = (counts[s.cause] ?? 0) + 1;
  const report = {
    tool: "see-through", scene: SCENE, mode: MODE_CMD, rule: MODE_CMD === "prop" ? "enclosed" : RULE_MODE, entity: ENTITY || undefined, at: new Date().toISOString(), inputsHash,
    ok: sites.length === 0, passed: sites.length === 0, counts, ...(parts.some((p) => p.inputsHash !== inputsHash) ? { mixedInputs: parts.map((p) => p.inputsHash) } : {}), samples: parts.reduce((s, p) => s + p.samples, 0), seconds: parts.reduce((s, p) => s + p.seconds, 0),
    options: { step: STEP, size: SIZE, minPixels: MIN_PX, hour: HOUR, openings: declared.map((o) => o.name), portals: portalIds.map((p) => p.id) },
    sites: sites.map((s) => ({ id: s.id, cause: s.cause, causes: s.causes, entities: s.entities.map((e) => `${e}${names(e) !== e ? ` (${names(e)})` : ""}`), at: s.at, views: s.views, maxPixels: s.maxPixels,
      worst: { sample: s.worst.sample, leg: s.worst.leg, view: s.worst.view, eye: s.worst.eye.map((v) => +v.toFixed(2)), dir: s.worst.dir.map((v) => +v.toFixed(3)), depth: s.worst.depth && +s.worst.depth.toFixed(2), crop: s.worst.crop } })),
    sheet: sites.length ? path.relative(path.dirname(OUT), path.join(OUT_DIR, "sheet.png")).replace(/\\/g, "/") : null,
  };
  // the contact sheet: the 24 worst sites, labelled
  if (sites.length) {
    const tiles = sites.slice(0, 24).filter((s) => s.worst.crop).map((s) => ({ label: `#${s.id} ${s.cause} ${s.maxPixels}px x${s.views}`, sub: s.entities.slice(0, 2).map(names).join(" | ").slice(0, 48), url: "data:image/png;base64," + fs.readFileSync(path.join(path.dirname(OUT), s.worst.crop!)).toString("base64") }));
    const sp = await ctx.newPage(); await sp.goto("about:blank");
    const dataUrl = await sp.evaluate(async ({ tiles, title }: any) => {
      const TW = 260, TH = 260, cols = 6, rows = Math.ceil(tiles.length / cols), HEAD = 34;
      const cv = document.createElement("canvas"); cv.width = TW * cols; cv.height = TH * rows + HEAD; const g = cv.getContext("2d")!;
      g.fillStyle = "#0b0e14"; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = "#fff"; g.font = "600 16px ui-monospace, monospace"; g.fillText(title, 10, 22);
      for (let i = 0; i < tiles.length; i++) { const img = new Image(); img.src = tiles[i].url; await img.decode(); const x = (i % cols) * TW, y = HEAD + Math.floor(i / cols) * TH;
        const s = Math.min((TW - 8) / img.width, (TH - 44) / img.height); g.imageSmoothingEnabled = false; g.drawImage(img, x + 4, y + 4, img.width * s, img.height * s);
        g.fillStyle = "rgba(0,0,0,0.75)"; g.fillRect(x + 4, y + TH - 40, TW - 8, 36); g.fillStyle = "#fff"; g.font = "600 12px ui-monospace, monospace"; g.fillText(tiles[i].label, x + 8, y + TH - 26); g.fillStyle = "#bbb"; g.fillText(tiles[i].sub, x + 8, y + TH - 10); }
      return cv.toDataURL("image/png"); }, { tiles, title: `see-through ${SCENE}${ENTITY ? ` ${ENTITY}` : ""}: ${sites.length} hole sites (${Object.entries(counts).filter(([k]) => !["sites", "holeViews"].includes(k)).map(([k, v]) => `${k} ${v}`).join(", ")})` });
    fs.writeFileSync(path.join(OUT_DIR, "sheet.png"), Buffer.from(dataUrl.split(",")[1]!, "base64"));
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  for (let k = 1; k <= BATCH_N; k++) fs.rmSync(partFile(k), { force: true });
  console.log(`see-through ${SCENE}: ${report.ok ? "ok" : "FAILED"} — ${sites.length} hole site(s) from ${all.length} hole views over ${report.samples} samples; ${JSON.stringify(counts)}  ${OUT}`);
  for (const s of report.sites.slice(0, 8)) console.log(`  #${s.id} ${s.cause.padEnd(12)} ${String(s.maxPixels).padStart(5)} px x${s.views}  at ${JSON.stringify(s.at)}  ${s.entities.slice(0, 3).join(" | ")}`);
  process.exitCode = report.ok ? 0 : 1;
} else console.log(`  waiting for the other batches (${parts.filter((p) => p && p.inputsHash === inputsHash).length}/${BATCH_N} present)`);
if (logs.length) console.log(logs.slice(0, 5).join("\n"));
await browser.close().catch(() => {});
stopVite();
