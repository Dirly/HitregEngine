// Memory-leak probe for a streamed scene in the dev editor: GC'd samples of the
// JS heap, three's GPU resource counts and live three.js objects over time.
// The instrument that found shared materials pinning every unloaded chunk
// (docs/performance-lessons.md, "Unloaded chunks stayed alive").
//
//   node tools/leak-probe.mjs http://localhost:5173/ stream --min 10     # sweep the camera out and back
//   node tools/leak-probe.mjs http://localhost:5173/ idle --min 5        # sit still in edit mode
//   node tools/leak-probe.mjs http://localhost:5173/ play --min 10       # enter play mode, stand still
//   ... --scene mmo (default) --out leak.json
//
// Every sample forces two GCs first, so only RETAINED memory is counted —
// the play-mode heap's saw-tooth is garbage churn, not a leak. Live objects
// are counted by prototype (CDP queryObjects), which catches what the scene
// graph and renderer.info cannot: objects detached from the scene that
// something still holds. A healthy run keeps Object3D/BufferGeometry tracking
// the scene's own object count and uniform buffers roughly level.
//
// Exit code 1 when the verdict is LEAK: live Object3Ds grow by more than 25%
// over the scene graph's own growth, or the GC'd heap by more than 5%.
//
// Needs `playwright` resolvable from the cwd (`npm i playwright` anywhere up
// the tree, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — it drives the installed
// Chrome). Needs the dev build's `window.__hitreg`. Use a server of your own
// port rather than a tab someone is working in.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [url, mode = "stream", ...rest] = process.argv.slice(2);
if (!url) {
  console.error("usage: node tools/leak-probe.mjs <url> [stream|idle|play] [--min 10] [--scene mmo] [--out file.json]");
  process.exit(2);
}
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const minutes = +opt("min", 10);
const scene = opt("scene", "mmo");
const out = opt("out", null);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript((s) => localStorage.setItem("hitreg-editor-last-scene", s), scene);
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message.slice(0, 200)));
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
await cdp.send("HeapProfiler.enable");

await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__hitreg?.chunkManager, null, { timeout: 180000 });
await page.waitForFunction(() => { const s = window.__hitreg.chunkManager.stats; return s.chunks > 0 && s.loading === 0; }, null, { timeout: 300000 }).catch(() => {});
await page.waitForTimeout(10000);

// prototypes to count live instances of, found from objects the scene holds
await page.evaluate(() => {
  const sc = window.__hitreg.scene();
  let mesh = null;
  sc.traverse((o) => { if (!mesh && o.isMesh && !o.isInstancedMesh) mesh = o; });
  const up = (o, own) => { let p = o && Object.getPrototypeOf(o); while (p && !Object.prototype.hasOwnProperty.call(p, own)) p = Object.getPrototypeOf(p); return p; };
  window.__leakProtos = {
    Object3D: up(sc, "traverse"),
    BufferGeometry: mesh && up(mesh.geometry, "setAttribute"),
    BufferAttribute: mesh && up(mesh.geometry.attributes.position, "setXYZ"),
    Map: Map.prototype,
  };
});
const protoNames = await page.evaluate(() => Object.entries(window.__leakProtos).filter(([, v]) => v).map(([k]) => k));

async function count(name) {
  const { result } = await cdp.send("Runtime.evaluate", { expression: `window.__leakProtos[${JSON.stringify(name)}]` });
  const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: result.objectId });
  const { result: len } = await cdp.send("Runtime.callFunctionOn", { objectId: objects.objectId, functionDeclaration: "function(){return this.length}", returnByValue: true });
  await cdp.send("Runtime.releaseObject", { objectId: objects.objectId });
  return len.value;
}

async function sample(t) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const app = await page.evaluate(() => {
    const h = window.__hitreg; const mem = h.renderer.renderer.info.memory;
    let sceneObjects = 0; h.scene().traverse(() => sceneObjects++);
    const sweep = h.renderer.renderObjectSweep;
    return {
      geometries: mem.geometries, textures: mem.textures, programs: mem.programs, uniformBuffers: mem.uniformBuffers,
      chunks: h.chunkManager.stats.chunks, sceneObjects, sweep: sweep ? { ...sweep.stats } : null,
    };
  });
  const counts = {};
  for (const n of protoNames) counts[n] = await count(n);
  const s = { t, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), listeners: m.JSEventListeners, domNodes: m.Nodes, ...app, counts };
  console.log(`${String(t).padStart(4)}s heap ${s.heapMB} MB · Object3D ${counts.Object3D} (scene ${s.sceneObjects}) · geometry ${counts.BufferGeometry ?? "?"} · uniform buffers ${s.uniformBuffers} · programs ${s.programs} · chunks ${s.chunks}${s.sweep ? ` · swept ${s.sweep.freed}` : ""}`);
  return s;
}

const home = await page.evaluate(() => {
  const c = window.__hitreg.controls; const V = c.camera.position.constructor;
  return { p: c.getPosition(new V()).toArray(), t: c.getTarget(new V()).toArray() };
});
if (mode === "play") { await page.keyboard.press("Backquote"); await page.waitForTimeout(8000); }

// in edit mode the streamer follows the orbit TARGET, so this is a streaming
// stress test with no player physics: out 600 m and back, a new heading each leg
async function leg(n) {
  const ang = (n * 1.3) % (Math.PI * 2); const R = 600; const steps = 60;
  for (let i = 0; i <= steps * 2; i++) {
    const f = i <= steps ? i / steps : 2 - i / steps;
    const dx = Math.cos(ang) * R * f, dz = Math.sin(ang) * R * f;
    await page.evaluate(([c, dx, dz]) => window.__hitreg.controls.setLookAt(c.p[0] + dx, c.p[1], c.p[2] + dz, c.t[0] + dx, c.t[1], c.t[2] + dz, false), [home, dx, dz]);
    await page.waitForTimeout(120);
  }
  await page.waitForFunction(() => window.__hitreg.chunkManager.stats.loading === 0, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

const samples = [await sample(0)];
const t0 = Date.now();
for (let n = 0; Date.now() - t0 < minutes * 60000; n++) {
  if (mode === "stream") await leg(n);
  else await page.waitForTimeout(30000);
  samples.push(await sample(Math.round((Date.now() - t0) / 1000)));
}
await browser.close();

// compare against the first sample AFTER the world settled, not the cold one
const a = samples[1] ?? samples[0]; const b = samples.at(-1);
const objGrowth = (b.counts.Object3D - a.counts.Object3D) - (b.sceneObjects - a.sceneObjects);
const objPct = (100 * objGrowth) / a.counts.Object3D;
const heapPct = (100 * (b.heapMB - a.heapMB)) / a.heapMB;
const leak = objPct > 25 || heapPct > 5;
console.log(`\n${leak ? "LEAK" : "ok"}: detached Object3Ds ${objGrowth >= 0 ? "+" : ""}${objGrowth} (${objPct.toFixed(1)}%), GC'd heap ${heapPct >= 0 ? "+" : ""}${heapPct.toFixed(1)}% over ${b.t - a.t}s${errs.length ? ` · ${errs.length} page errors` : ""}`);
if (out) writeFileSync(out, JSON.stringify({ url, mode, scene, samples, errs }, null, 1));
process.exit(leak ? 1 : 0);
