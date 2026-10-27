/**
 * far-draw-probe — what is DRAWN over ground that has not streamed in (placed towns, stairs and POIs hanging in the
 * haze kilometres off, over unloaded cells). Headless Chrome (real WebGPU) on a dev server of its own, edit mode, the
 * editor camera at each spot looking along its heading; the streaming focus is held at the eye so the rings are the
 * ones a player standing there gets. Per spot, once streaming settles, it walks the scene and lists every renderable
 * the main camera would draw (visible, on a camera layer, in the frustum, above the renderer's screen-size cull) whose
 * bounds — for instanced meshes each instance — sit over a cell with no drawn terrain (ChunkManager.coversGround).
 * Each spot is measured twice in one session: the culling ground gate OFF (what was drawn before it) and ON.
 *
 *   node node_modules/tsx/dist/cli.mjs tools/far-draw-probe.mts --scene skelmorrow [--spots <spots.json>] [--out <dir>]
 *     [--url http://localhost:<p>] [--port 5347] [--headed] [--frames 120]
 *
 * spots.json: [{ "name": "hagsheer-moor", "x": -2150, "z": -300, "toward": [-652, -273] }]  (eye at ground + "lift" m, default 4 — a third-person camera,
 *   looking at `toward` [x, z]; optional "y" eye height, "pitch" degrees down). Without --spots: skelmorrow's three.
 * Out: <out>/far-draw-<scene>.json (per spot and arm: counts by kind — base / chunk / hlod / pool — the offenders with
 *   entity ids, distance and cell, culling stats, draw calls, median frame work) and <out>/<spot>-<gate off|on>.png.
 * Exit 1 when any spot draws placed content over unloaded ground with the gate on ("wide" planes, HLOD parts (terrain-backed: their own ground) and "runtime-parked"
 *   objects at the world origin are listed but not counted).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS module
import { loadPlaywright } from "./_playwright.mjs";
// @ts-expect-error plain JS module
import { READ_ONLY_POSTS } from "./_readonly-posts.mjs";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n: string, d = "") => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const SCENE = arg("scene", "skelmorrow");
const OUT = path.resolve(arg("out", path.join(PG, "projects", SCENE, "reports")));
const FRAMES = Number(arg("frames", "120"));
type Spot = { name: string; x: number; z: number; toward: [number, number]; y?: number; lift?: number; pitch?: number };
const DEFAULT_SPOTS: Record<string, Spot[]> = {
  skelmorrow: [
    // Derek's capture: the moor east of Hagsend, looking east toward Cindermoot (another zone, ~1.5 km)
    { name: "hagsheer-moor", x: -2150, z: -300, toward: [-652, -273] },
    { name: "weepwater-gorge", x: -2421, z: -1060, toward: [-652, -273] },
    { name: "reedholt-fen", x: 2150, z: -800, toward: [-652, -273] },
    // the picture: same moor, from a rise (30 m up) so the town 1.5 km off clears the near ground
    { name: "moor-view", x: -2150, z: -300, toward: [-652, -273], lift: 30, pitch: 0.5 },
  ],
};
const SPOTS: Spot[] = arg("spots") ? JSON.parse(fs.readFileSync(arg("spots"), "utf8")) : DEFAULT_SPOTS[SCENE] ?? [];
if (!SPOTS.length) { console.error(`STOP: no spots for ${SCENE} (pass --spots)`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

let vite: ReturnType<typeof spawn> | null = null;
let base = arg("url").replace(/\/$/, "");
const stopVite = () => { if (vite?.pid) { try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(vite.pid), "/t", "/f"]) : process.kill(vite.pid); } catch { /* gone */ } } };
process.on("exit", stopVite);
if (!base) {
  const port = arg("port", "5347");
  const cfg = fs.existsSync(path.join(PG, "vite.agent-test.config.ts")) ? ["--config", "vite.agent-test.config.ts"] : [];
  vite = spawn(process.execPath, [path.join(PG, "node_modules", "vite", "bin", "vite.js"), ...cfg, "--port", port, "--strictPort"], { cwd: PG, stdio: ["ignore", "pipe", "pipe"] });
  console.log(`vite pid ${vite.pid} on :${port}`);
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
// nothing this run does may reach disk; freeze the page at the code it booted with
await ctx.route(/\/__hitreg\//, (route: any) => { const r = route.request(); return r.method() !== "GET" && !READ_ONLY_POSTS.test(r.url()) ? route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" }) : route.continue(); });
await ctx.route(/\/@vite\/client(\?.*)?$/, (route: any) => route.fulfill({ contentType: "application/javascript", body: `export const createHotContext = () => ({ data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {} });
export const updateStyle = (id, css) => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
export const removeStyle = () => {}; export const injectQuery = (u) => u; export class ErrorOverlay extends HTMLElement {}` }));
await ctx.addInitScript(() => {
  (window as any).__name = (f: unknown) => f;
  try { const k = "hitreg-editor-settings"; const cur = JSON.parse(localStorage.getItem(k) || "{}"); localStorage.setItem(k, JSON.stringify({ ...cur, showStats: false, showGizmos: false, grid: false, showPhysics: false, showLights: false, showSkeletons: false })); } catch { /* */ }
});
const page = await ctx.newPage();
const logs: string[] = [];
page.on("pageerror", (e: Error) => logs.push("pageerror: " + e.message.slice(0, 200)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = <T,>(fn: (h: any, ...a: any[]) => T, ...a: unknown[]) => page.evaluate(([src, args]: [string, unknown[]]) => {
  const h = (window as any).__hitreg; return new Function("h", "args", `return (${src})(h, ...args)`)(h, args);
}, [fn.toString(), a]) as Promise<Awaited<T>>;
async function waitFor(cond: () => Promise<boolean>, ms: number, what: string) { const t = Date.now(); while (Date.now() - t < ms) { if (await cond().catch(() => false)) return; await sleep(500); } throw new Error(`timed out waiting for ${what}`); }

/** In the page: every drawn renderable over unloaded ground. */
const probe = (h: any) => {
  const cam = h.camera, cm = h.chunkManager, scene = h.scene();
  const streamer = cm.streamer as { cellSize: number; rings?: { farTerrain?: number } } | null;
  const cell = streamer?.cellSize ?? 48;
  cam.updateMatrixWorld();
  const eye = cam.getWorldPosition(cam.position.clone());
  const pv = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
  // the four side planes (Gribb-Hartmann) — enough to say "on screen" for something kilometres out
  const e = pv.elements;
  const planes = [[e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]], [e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]],
    [e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]], [e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]]]
    .map((q) => { const l = Math.hypot(q[0]!, q[1]!, q[2]!); return q.map((v) => v / l); });
  const inFrustum = (c: any, r: number) => planes.every((q) => q[0]! * c.x + q[1]! * c.y + q[2]! * c.z + q[3]! >= -r);
  const H_ = h.renderer.renderer.domElement.height || 720;
  const tanHalf = Math.tan((cam.fov * Math.PI) / 360) / (cam.zoom || 1);
  const minPx = h.renderer.minScreenRadiusPx ?? 2.5;
  const poolGroup = h.propPool?.group;
  const out: any[] = [];
  const counts: Record<string, { drawn: number; overUnloaded: number }> = {};
  const sph = cam.position.clone(); // scratch vectors from the page's three
  const m4 = cam.matrixWorld.clone();
  const mask = cam.layers.mask;
  const judge = (kind0: string, center: any, radius: number, id: string, label: string) => {
    // not placed content: a plane wider than the streamed rings (the ocean), and runtime objects parked at the world
    // origin (unfilled pool slots, unheld weapons) — listed under their own kinds, never counted as floating
    const kind = radius > 1024 ? "wide" : kind0 === "moving" || (!id && Math.hypot(center.x, center.z) < 64) ? "runtime-parked" : kind0;
    if (!inFrustum(center, radius)) return;
    const d = Math.max(1e-3, center.distanceTo(eye) - radius);
    if ((radius * H_) / (d * tanHalf) < minPx) return;
    const c = (counts[kind] ??= { drawn: 0, overUnloaded: 0 });
    c.drawn++;
    if (cm.coversGround(center.x, center.z)) return;
    c.overUnloaded++;
    if (out.length < 400) out.push({ kind, id, label, dist: Math.round(center.distanceTo(eye)), at: [Math.round(center.x), Math.round(center.y), Math.round(center.z)], cell: `${Math.floor(center.x / cell)}_${Math.floor(center.z / cell)}`, radius: Math.round(radius) });
  };
  const visit = (o: any, kind: string) => {
    if (!o.visible) return;
    if (o.name?.startsWith?.("hlod-supercell:")) kind = "hlod";
    else if (o.name?.startsWith?.("chunk:")) kind = "chunk";
    else if (poolGroup && o === poolGroup) kind = "pool";
    else if (o.name === "moving-instances") kind = "moving";
    if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && (o.layers.mask & mask) !== 0 && o.geometry) {
      const owners = o.userData?.batchOwners?.ids as string[] | undefined;
      const id = o.userData?.entityId ?? (owners ? owners.slice(0, 3).join(",") + (owners.length > 3 ? ` +${owners.length - 3}` : "") : "");
      const label = `${o.parent?.name ?? ""}/${o.name ?? ""}`;
      if (o.isInstancedMesh) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const gs = o.geometry.boundingSphere;
        const ids = o.userData?.instancedEntityIds as string[] | undefined;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m4);
          m4.premultiply(o.matrixWorld);
          const s = m4.getMaxScaleOnAxis();
          if (s < 1e-6) continue;
          // an identity slot at the world origin is an unplaced/parked instance, not placed content
          const parked = Math.abs(m4.elements[12]! - o.matrixWorld.elements[12]!) < 1e-3 && Math.abs(m4.elements[14]! - o.matrixWorld.elements[14]!) < 1e-3;
          sph.copy(gs.center).applyMatrix4(m4);
          judge(parked || kind === "moving" ? "runtime-parked" : kind, sph, gs.radius * s, ids?.[i] ?? id, label);
        }
      } else {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const gs = o.geometry.boundingSphere;
        if (gs) {
          sph.copy(gs.center).applyMatrix4(o.matrixWorld);
          judge(kind, sph, gs.radius * o.matrixWorld.getMaxScaleOnAxis(), id, label);
        }
      }
    }
    for (const c of o.children) visit(c, kind);
  };
  scene.updateMatrixWorld();
  visit(scene, "base");
  out.sort((a, b) => b.dist - a.dist);
  const sum = h.profiler?.summary?.();
  let draws = 0; try { draws = h.renderer.renderer.info.render.drawCalls ?? 0; } catch { /* */ }
  return {
    eye: [Math.round(eye.x), Math.round(eye.y), Math.round(eye.z)],
    farTerrainM: (streamer?.rings?.farTerrain ?? 0) * cell,
    counts, offenders: out, culling: h.culling.stats(), chunks: cm.stats, draws,
    frameWorkMs: sum?.frames ? +sum.frameMs.p50.toFixed(2) : null,
    gpuMs: sum?.gpuMs ? +sum.gpuMs.avg.toFixed(2) : null,
  };
};

const report: any = { scene: SCENE, at: new Date().toISOString(), spots: [] as any[] };
let failing = 0;
try {
  await page.goto(`${base}/?scene=${encodeURIComponent(SCENE)}`, { waitUntil: "load" });
  await waitFor(() => H((h) => !!h?.chunkManager && !!h.controls), 300000, "the dev app");
  await waitFor(() => H((h, s: string) => h.sceneName() === s, SCENE), 300000, `scene ${SCENE}`);
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = `body > *:not(#app):not(script):not(style):not(link) { display: none !important; }
      #app { position: fixed !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; }`;
    document.head.append(st);
    window.dispatchEvent(new Event("resize"));
  });
  for (const spot of SPOTS) {
    const placed = await H((h, s: Spot) => {
      let g = h.terrainHeight(s.x, s.z);
      if (!Number.isFinite(g)) g = 60;
      const y = s.y ?? g + (s.lift ?? 4);
      const dx = s.toward[0] - s.x, dz = s.toward[1] - s.z, len = Math.hypot(dx, dz) || 1;
      const pitch = ((s.pitch ?? 2) * Math.PI) / 180;
      // target 6 m ahead: the edit-mode streaming focus is the orbit target, so the rings centre on the eye
      const t = [s.x + (dx / len) * 6, y - Math.tan(pitch) * 6, s.z + (dz / len) * 6];
      h.controls.setLookAt(s.x, y, s.z, t[0], t[1], t[2], false);
      return [s.x, y, s.z];
    }, spot);
    // settle: nothing loading for 4 s in a row (cap 240 s)
    let quiet = 0;
    for (let i = 0; i < 240 && quiet < 4; i++) { await sleep(1000); quiet = (await H((h) => h.chunkManager.stats.loading)) === 0 ? quiet + 1 : 0; }
    // the eye height again now the ground under it is resident
    await H((h, s: Spot) => {
      const g = h.terrainHeight(s.x, s.z);
      if (s.y === undefined && Number.isFinite(g)) {
        const dx = s.toward[0] - s.x, dz = s.toward[1] - s.z, len = Math.hypot(dx, dz) || 1, y = g + (s.lift ?? 4), pitch = ((s.pitch ?? 2) * Math.PI) / 180;
        h.controls.setLookAt(s.x, y, s.z, s.x + (dx / len) * 6, y - Math.tan(pitch) * 6, s.z + (dz / len) * 6, false);
      }
    }, spot);
    await sleep(2500);
    const arms: any = {};
    for (const gate of [false, true]) {
      await H((h, on: boolean) => { h.culling.groundGate = on; h.profiler.enabled = true; h.profiler.reset(); }, gate);
      await sleep(Math.max(1500, FRAMES * 17));
      const r = await H(probe);
      const file = path.join(OUT, `${spot.name}-gate-${gate ? "on" : "off"}.png`);
      await page.screenshot({ path: file });
      arms[gate ? "on" : "off"] = { ...r, picture: file };
      // placed content only: runtime-parked instances (unfilled pool slots, unheld weapons at the origin) are listed, not counted
      const over = Object.entries(r.counts as Record<string, { overUnloaded: number }>).reduce((a, [k, c]) => a + (k === "runtime-parked" || k === "wide" || k === "hlod" ? 0 : c.overUnloaded), 0);
      if (gate && over > 0) failing++;
      console.log(`${spot.name} gate ${gate ? "on " : "off"}: ${over} drawn over unloaded ground ${JSON.stringify(r.counts)} · culling ${r.culling.ungrounded} ungrounded units · ${r.draws} draws · work p50 ${r.frameWorkMs} ms · gpu ${r.gpuMs} ms`);
    }
    report.spots.push({ ...spot, eye: placed, arms });
  }
} finally {
  report.logs = logs.slice(0, 20);
  const file = path.join(OUT, `far-draw-${SCENE}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  console.log(`report ${file}`);
  await browser.close();
  stopVite();
}
process.exit(failing > 0 ? 1 : 0);
