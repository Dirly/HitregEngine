// Frame-cost probe for a PUBLISHED build, attributing each frame's JS to what
// three's WebGPU renderer was doing — the instrument that found the
// per-InstancedMesh shader builds behind "it hitches when I turn"
// (docs/perf-investigation-2026-09-02.md §8).
//
//   node tools/publish.mjs voxel-demo voxel-demo.scene.json
//   node tools/serve-static.mjs dist/voxel-demo 8099
//   node tools/perf-probe.mjs http://localhost:8099/index.html rotate           # two 360° laps in place
//   node tools/perf-probe.mjs http://localhost:8099/index.html walk --ms 30000  # 30 s straight-line flight
//   ... ?precompile=0 on the URL disables the background precompile for an A/B
//
// Needs `playwright` resolvable from the cwd (`npm i playwright` anywhere up
// the tree; no browser download — it drives the installed Chrome, which gets
// a real WebGPU adapter headless). The published build exposes `window.__hitreg`
// (renderer, chunkManager, profiler, controls, camera, sim) for exactly this.
//
// Per frame it records the engine profiler's JS total and `draw` scope, the
// off-loop gap, renderer counters, and time spent inside three's `Nodes`
// (shader codegen), `Pipelines`, `Bindings`, `Geometries`, the backend's
// attribute/program/pipeline creation, and the raw GPU device/queue calls.
// "codegen" counts node-builder cache misses — every one is a shader being
// generated on the main thread.
//
// Two traps, from the investigation doc: the profiler's gap is measured against
// the PREVIOUS frame's JS, so sort spikes by JS-in-frame; and always check
// draw calls/triangles before believing a win (a player who fell through the
// world renders an empty frustum at 129 fps).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [url, mode = "rotate", ...rest] = process.argv.slice(2);
if (!url) {
  console.error("usage: node tools/perf-probe.mjs <url> [rotate|walk] [--laps 2] [--steps 90] [--ms 30000] [--out file.json]");
  process.exit(1);
}
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const laps = +opt("laps", 2);
const steps = +opt("steps", 90);
const walkMs = +opt("ms", 30000);
const out = opt("out", null);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const logs = [];
page.on("console", (m) => { const t = m.text(); if (/warn|error|fail|fell/i.test(t) && !/404/.test(t)) logs.push(t.slice(0, 200)); });
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));

// raw WebGPU calls, wrapped before the app boots
await page.addInitScript(() => {
  const acc = {}; window.__acc = acc;
  const wrap = (proto, name, key) => {
    if (!proto || !proto[name]) return;
    const orig = proto[name];
    proto[name] = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { const d = performance.now() - t; acc[key] = (acc[key] || 0) + d; acc[key + "#"] = (acc[key + "#"] || 0) + 1; } };
  };
  const g = globalThis;
  wrap(g.GPUDevice?.prototype, "createShaderModule", "gpu.createShaderModule");
  wrap(g.GPUDevice?.prototype, "createRenderPipeline", "gpu.createRenderPipeline");
  wrap(g.GPUDevice?.prototype, "createBuffer", "gpu.createBuffer");
  wrap(g.GPUQueue?.prototype, "writeBuffer", "gpu.writeBuffer");
  wrap(g.GPUQueue?.prototype, "writeTexture", "gpu.writeTexture");
  wrap(g.GPUQueue?.prototype, "submit", "gpu.submit");
});

await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__hitreg, null, { timeout: 120000 });

// three's own stages, wrapped on the live renderer's prototypes
await page.evaluate(() => {
  const h = window.__hitreg; const r = h.renderer.renderer; const acc = window.__acc;
  const wrap = (obj, name, key) => {
    if (!obj) return;
    const proto = Object.getPrototypeOf(obj); const orig = proto[name];
    if (!orig) return;
    proto[name] = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { const d = performance.now() - t; acc[key] = (acc[key] || 0) + d; acc[key + "#"] = (acc[key + "#"] || 0) + 1; } };
  };
  wrap(r._nodes, "getForRender", "three.nodes");
  wrap(r._pipelines, "getForRender", "three.pipelines");
  wrap(r._bindings, "getForRender", "three.bindings");
  wrap(r._geometries, "updateForRender", "three.geometries");
  wrap(r._textures, "updateTexture", "three.textures");
  wrap(r.backend, "createAttribute", "three.createAttribute");
  wrap(r.backend, "updateAttribute", "three.updateAttribute");
  wrap(r.backend, "createProgram", "three.createProgram");
  wrap(r.backend, "createRenderPipeline", "three.createRenderPipeline");
  const nb = r._nodes.nodeBuilderCache; const set = nb.set.bind(nb);
  nb.set = (k, v) => { acc["codegen#"] = (acc["codegen#"] || 0) + 1; return set(k, v); };
  h.renderer.setGpuTiming?.(true);
});

const snap = () => page.evaluate(() => {
  const h = window.__hitreg; const r = h.renderer.renderer; const info = r.info; const cs = h.chunkManager.stats;
  const tgt = h.controls.getTarget(new h.camera.position.constructor());
  return { drawCalls: info.render.drawCalls, triangles: info.render.triangles, programs: info.memory.programs, pipelines: r._pipelines.caches.size, nodeStates: r._nodes.nodeBuilderCache.size, chunks: cs.chunks, loading: cs.loading, targetY: +tgt.y.toFixed(2), x: +h.camera.position.x.toFixed(1), z: +h.camera.position.z.toFixed(1), backend: r.backend.isWebGPUBackend ? "webgpu" : "webgl" };
});

// settle: nothing loading and the chunk count stable for 4 s
const t0 = Date.now(); let last = await snap(); let stableSince = Date.now();
for (;;) {
  await page.waitForTimeout(500);
  const s = await snap();
  if (s.loading !== 0 || s.chunks !== last.chunks) stableSince = Date.now();
  last = s;
  if (Date.now() - stableSince >= 4000 || Date.now() - t0 > 180000) break;
}
console.log(`settled after ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(last));

// per-frame recorder: a page-side rAF that runs after the app's tick
await page.evaluate(() => {
  const h = window.__hitreg; const r = h.renderer.renderer; const info = r.info; const p = h.profiler; const acc = window.__acc; const cs = h.chunkManager.stats;
  for (const k of Object.keys(acc)) acc[k] = 0;
  const frames = []; window.__frames = frames; window.__rec = true; let prevSeq = p.frameSeq; let lastT = performance.now(); window.__lap = 0;
  const tick = () => {
    if (!window.__rec) return;
    const t = performance.now(); const seq = p.frameSeq;
    if (seq !== prevSeq) frames.push({ t, dt: t - lastT, seq, lap: window.__lap, calls: info.render.drawCalls, tris: info.render.triangles, states: r._nodes.nodeBuilderCache.size, programs: info.memory.programs, chunks: cs.chunks, acc: { ...acc } });
    for (const k of Object.keys(acc)) acc[k] = 0;
    prevSeq = seq; lastT = t; requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

if (mode === "rotate") {
  await page.evaluate(async ({ laps, steps }) => {
    const h = window.__hitreg; const d = (Math.PI * 2) / steps;
    for (let lap = 0; lap < laps; lap++) {
      window.__lap = lap;
      await new Promise((res) => { let i = 0; const tick = () => { if (i++ >= steps) return res(); h.controls.rotate(d, 0, false); requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    }
  }, { laps, steps });
} else {
  // Teleport-step the player's body along the camera's forward vector, keeping
  // it on the ground with a downward physics raycast. Keyboard input does not
  // reach the controller from a headless page, and a scripted straight line is
  // repeatable anyway.
  await page.evaluate(({ ms }) => new Promise((resolve) => {
    const h = window.__hitreg; const sim = h.sim; const cam = h.camera;
    const id = sim.states().has("player") ? "player" : [...sim.states().keys()][0];
    const dir = new cam.position.constructor(); cam.getWorldDirection(dir); dir.y = 0; dir.normalize();
    const step = 0.12; const end = performance.now() + ms;
    const tick = () => {
      if (performance.now() > end) return resolve();
      const s = sim.states().get(id);
      if (s) {
        const p = s.position; const nx = p[0] + dir.x * step; const nz = p[2] + dir.z * step;
        const hit = sim.raycast([nx, p[1] + 6, nz], [0, -1, 0], 60, { exclude: [id] });
        sim.setTranslation(id, [nx, hit ? p[1] + 6 - hit.distance + 1.1 : p[1], nz]);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { ms: walkMs });
  await page.waitForTimeout(1500);
}

const after = await snap();
const frames = await page.evaluate(() => {
  window.__rec = false;
  const p = window.__hitreg.profiler; const series = p.frameSeries(); const bySeq = new Map();
  for (let k = 0; k < series.seqs.length; k++) bySeq.set(series.seqs[k], { js: series.totals[k], gap: series.gaps[k], gpu: series.gpu[k], draw: series.lanes.find((l) => l.path === "draw")?.values[k] ?? 0 });
  return window.__frames.map((f) => Object.assign(f, bySeq.get(f.seq) ?? {})).filter((f) => f.js !== undefined);
});
console.log("after", JSON.stringify(after));

const sum = (a) => a.reduce((x, y) => x + y, 0);
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0; };
const report = (label, F) => {
  if (F.length === 0) return;
  const js = F.map((f) => f.js); const gaps = F.map((f) => f.gap);
  const buckets = {}; const counts = {};
  for (const f of F) for (const [k, v] of Object.entries(f.acc)) (k.endsWith("#") ? counts : buckets)[k] = ((k.endsWith("#") ? counts : buckets)[k] || 0) + v;
  console.log(`\n${label}: ${F.length} frames over ${(sum(F.map((f) => f.dt)) / 1000).toFixed(2)}s   js sum ${sum(js).toFixed(0)}  p50 ${pct(js, 0.5).toFixed(1)}  p95 ${pct(js, 0.95).toFixed(1)}  max ${Math.max(...js).toFixed(1)}   frames>50ms ${js.filter((x) => x > 50).length}   gap max ${Math.max(...gaps).toFixed(0)} sum ${sum(gaps).toFixed(0)}   codegen ${counts["codegen#"] ?? 0}`);
  console.log(`  states ${F[0].states} -> ${F.at(-1).states}   programs ${F[0].programs} -> ${F.at(-1).programs}   chunks ${F[0].chunks} -> ${F.at(-1).chunks}   calls ${Math.min(...F.map((f) => f.calls))}-${Math.max(...F.map((f) => f.calls))}`);
  console.log(`  buckets: ${Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v.toFixed(0)}ms x${counts[k + "#"] ?? 0}`).join("  |  ")}`);
  console.log("  worst by JS-in-frame:");
  for (const f of [...F].sort((a, b) => b.js - a.js).slice(0, 5)) {
    console.log("   ", JSON.stringify({ js: +f.js.toFixed(1), draw: +f.draw.toFixed(1), gap: +f.gap.toFixed(1), calls: f.calls, tris: f.tris, codegen: f.acc["codegen#"] ?? 0, nodes: +(f.acc["three.nodes"] ?? 0).toFixed(1), attr: +(f.acc["three.createAttribute"] ?? 0).toFixed(1), pipe: +(f.acc["three.pipelines"] ?? 0).toFixed(1) }));
  }
};
if (mode === "rotate") for (let lap = 0; lap < laps; lap++) report(`lap ${lap}`, frames.filter((f) => f.lap === lap));
else report("walk", frames);
if (logs.length) console.log("\nconsole:", logs.slice(0, 10));
if (out) writeFileSync(out, JSON.stringify({ url, mode, before: last, after, frames, logs }, null, 1));
await browser.close();
