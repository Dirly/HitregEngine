#!/usr/bin/env node
// Repeatable frame-cost probe for a place in a scene, for pipelines to gate on later. It MEASURES;
// it does not judge (no budgets yet). Boots its OWN vite dev server (agent-test config, so another
// session's edits cannot reload the page mid-run), opens the scene in headless Chrome with real
// WebGPU, enters play mode, stands at the spawn (or --at), waits for streaming to settle and shaders
// to warm, samples the engine profiler, and writes a small JSON report keyed by the scene file's
// hash, so a report goes stale when the scene changes.
//
//   cd apps/playground
//   node tools/town-perf.mjs --scene proving [--at 3670,23,-90] [--yaw 1.6] [--port 5420]
//     [--ms 10000] [--warm 6000] [--legacy] [--out report.json] [--shot view.png] [--settle 0]
//
// Also reports frame WORK (time inside rAF callbacks, the number that matters when headless rAF is
// capped), renderer memory (geometries/textures), distinct materials drawn, resident chunks, the JS
// heap, and `drawsBy`: main-pass and shadow-pass draws per frame attributed to the scene branch that
// issued them (two levels below the scene, digits folded), which says WHAT the draws are.
// `drawsByMaterial`: draws per pass by material: ATLAS (town page) / WIND (vertex-animated, never merged) / own
//   texture, whether the draw was a merged batch, an instanced mesh or a single mesh, and the entity.
// --query <k=v&...> appends URL flags (e.g. sheets=0 for the prop-sheet A/B).
// --vista pins clear weather and hides the HUD before the --shot: two shots can then be compared, weather rolls per run.
//   --weather <clear|drizzle|light|storm> pins that weather instead; --eval "<js>" runs in the page after the pin (knob A/Bs).
//   --init "<js>" (or @file) runs before the page's own scripts, to wrap engine calls without editing source.
// `loadMs`: page load to streaming settled, with the resident cell count.
// --load-trace: `coverDownMs` is when the player gets in (loadMs also holds this probe's own waits); `loadCpu` profiles
//   up to that moment, `afterCoverCpu` the 30 s after it. It samples the boot twice a second into `loadTrace` (time, cells, loading, gltf, draws) and records every
//   long main-thread task plus request totals by type, so a slow load says where the time went.
//   `smooth` (page time, 0 = navigation; coverDownMs also holds vite and Chrome starting): coverDownPageMs, smooth33PageMs = first
//   sustained 3 s of frames under 33 ms after the cover lifts (null = never), smooth50PageMs, last >100 ms frame, long-task totals
//   before the cover lifts and in the 30 s after it, frame spreads for the windows after it.
// --cpu adds a CDP CPU profile of the sample window: `cpu.self` (top self time by function@file:line) and
//   `cpu.total` (top inclusive time), percentages of sampled time — for when a scope can't be split further.
// --settle <s> waits that many extra seconds after streaming settles (the time-sliced precompile
//   occupies the first minute; 60 s gives a steady-state reading).
//
// --legacy turns the 2026-10-02 character savings off at runtime (skinned shadow range 0, held-pose
//   bone walks off), for an in-place before/after on the same build.
// Needs Playwright: the apps/playground devDependency (PLAYWRIGHT_MODULE / HITREG_PLAYWRIGHT override; tools/_playwright.mjs)
// (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright; it drives the installed Chrome).
// Never point it at the owner's :5173: it starts and stops its own server.
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
/** A JS argument: the text, or `@file` to read it from a file. */
const jsArg = (k) => (opt(k, "").startsWith("@") ? fs.readFileSync(opt(k, "").slice(1), "utf8") : opt(k, ""));
const scene = opt("scene", "");
if (!scene) {
  console.error("usage: node tools/town-perf.mjs --scene <id> [--at x,y,z] [--yaw rad] [--port 5420] [--ms 10000] [--legacy] [--out file]");
  process.exit(1);
}
const port = +opt("port", "5420");
if (port === 5173) {
  console.error("refusing :5173 (the owner's live session)");
  process.exit(1);
}
const sampleMs = +opt("ms", "10000");
const warmMs = +opt("warm", "6000");
const at = opt("at", "") ? opt("at", "").split(",").map(Number) : null;
const yaw = opt("yaw", "") === "" ? null : +opt("yaw", "0");
const legacy = argv.includes("--legacy");
/** Top self and inclusive time from a CDP profile, percentages of sampled time. */
function cpuSummary(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const hits = new Map();
  for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1);
  const total = profile.samples.length || 1;
  const label = (n) => {
    const f = n.callFrame;
    return `${f.functionName || "(anon)"}@${(f.url || "").split("/").pop().split("?")[0]}:${f.lineNumber + 1}`;
  };
  const self = new Map(), incl = new Map();
  for (const [id, h] of hits) {
    const n = byId.get(id);
    self.set(label(n), (self.get(label(n)) ?? 0) + h);
    const seen = new Set();
    for (let c = id; c !== undefined; c = parent.get(c)) {
      const l = label(byId.get(c));
      if (seen.has(l)) continue;
      seen.add(l);
      incl.set(l, (incl.get(l) ?? 0) + h);
    }
  }
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, h]) => `${((100 * h) / total).toFixed(1)}% ${l}`);
  return { self: top(self, 40), total: top(incl, 60), sampledS: Math.round(((profile.endTime - profile.startTime) / 1e6)) };
}

/**
 * Runs in the page. Time to smooth play: the first moment after the cover lifts that opens a sustained run (SMOOTH_RUN_MS)
 * of frames all under a budget, in page time (0 = navigation). Null = no such run before the probe ended, which is a
 * real answer on a loaded machine. Reported at 33 ms (the target) and 50 ms (still playable), with the hitches left.
 */
function smoothPlaySummary({ navStartMs }) {
  const RUN_MS = 3000;
  const f = window.__frames ?? [];
  const edges = window.__coverEdges ?? [];
  const up = edges.find((e) => e[1])?.[0] ?? null;
  const down = edges.find((e) => !e[1] && e[0] > (up ?? 0))?.[0] ?? null;
  const from = down ?? 0;
  const firstRun = (budget) => {
    let start = null;
    for (let i = 1; i < f.length; i++) {
      if (f[i - 1] < from) continue;
      if (f[i] - f[i - 1] >= budget) { start = null; continue; }
      start ??= f[i - 1];
      if (f[i] - start >= RUN_MS) return Math.round(start);
    }
    return null;
  };
  const span = (a, b) => {
    const d = [];
    for (let i = 1; i < f.length; i++) if (f[i - 1] >= a && f[i] < b) d.push(f[i] - f[i - 1]);
    const s = d.slice().sort((x, y) => x - y);
    return { frames: d.length, p50: Math.round(s[s.length >> 1] ?? 0), p95: Math.round(s[Math.floor(s.length * 0.95)] ?? 0), worst: Math.round(s[s.length - 1] ?? 0), over50: d.filter((x) => x > 50).length, over100: d.filter((x) => x > 100).length, over250: d.filter((x) => x > 250).length };
  };
  // the pool and the model fetches over time: [bucket start s, replies by kind / models finished]
  const buckets = (rows, at, key) => {
    const m = new Map();
    for (const r of rows) { const b = Math.floor(at(r) / 10000) * 10; const e = m.get(b) ?? {}; const k = key(r); e[k] = (e[k] ?? 0) + 1; m.set(b, e); }
    return [...m].sort((a, b) => a[0] - b[0]);
  };
  const jobs = window.__workerJobs ?? [];
  const lat = {};
  for (const j of jobs) (lat[j[2]] ??= []).push(j[1] - j[0]);
  const models = performance.getEntriesByType("resource").filter((r) => /[.](glb|gltf)([?&]|$)/.test(decodeURIComponent(r.name)));
  const workers = {
    pool: (window.__workers ?? []).slice(0, 12),
    latencyMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => { v.sort((a, b) => a - b); return [k, { n: v.length, p50: v[v.length >> 1], max: v[v.length - 1] }]; })),
    byTime: buckets(jobs, (j) => j[1], (j) => j[2]),
  };
  const modelFetch = { n: models.length, firstStart: Math.round(models.reduce((a, r) => Math.min(a, r.startTime), Infinity)), lastEnd: Math.round(models.reduce((a, r) => Math.max(a, r.responseEnd), 0)), byTime: buckets(models, (r) => r.responseEnd, () => "done") };
  const long = window.__longTasks ?? [];
  const longMs = (a, b, over = 0) => long.filter((t) => t[0] >= a && t[0] < b && t[1] >= over).reduce((sum, t) => sum + t[1], 0);
  let lastHitch100 = null;
  for (let i = f.length - 1; i > 0 && f[i - 1] >= from; i--) if (f[i] - f[i - 1] > 100) { lastHitch100 = Math.round(f[i]); break; }
  const end = f[f.length - 1] ?? 0;
  return {
    workers, modelFetch, navStartMs, coverUpPageMs: up, coverDownPageMs: down, coverEdges: edges.slice(0, 12),
    smooth33PageMs: firstRun(33), smooth50PageMs: firstRun(50), smooth100PageMs: firstRun(100), lastHitch100PageMs: lastHitch100, endPageMs: Math.round(end),
    longBeforeCoverDownMs: longMs(0, from), longAfterCover30sMs: longMs(from, from + 30000), longAfterCover30to90sMs: longMs(from + 30000, from + 90000),
    // a plain frame over 50 ms is a "long task" too, so on a busy machine the totals above track wall time: these are the real stalls
    stallsAfterCover30sMs: longMs(from, from + 30000, 200), stallsAfterCover30to90sMs: longMs(from + 30000, from + 90000, 200),
    framesAfterCover30s: span(from, from + 30000), framesAfterCover30to60s: span(from + 30000, from + 60000), framesLast10s: span(end - 10000, end + 1),
  };
}

/** What the biggest long tasks were: top inclusive functions inside each task's window of a page-clock-aligned CDP profile. */
function longTaskBlame(profiles, tasks) {
  return tasks.map(([start, ms]) => {
    const incl = new Map();
    let n = 0;
    for (const { profile, offset } of profiles) {
      const byId = new Map(profile.nodes.map((x) => [x.id, x]));
      const parent = new Map();
      for (const x of profile.nodes) for (const c of x.children ?? []) parent.set(c, x.id);
      let t = profile.startTime;
      for (let i = 0; i < profile.samples.length; i++) {
        t += profile.timeDeltas[i] ?? 0;
        const at = t / 1000 + offset;
        if (at < start || at > start + ms) continue;
        n++;
        const seen = new Set();
        for (let c = profile.samples[i]; c !== undefined; c = parent.get(c)) {
          const fr = byId.get(c).callFrame;
          const l = (fr.functionName || "(anon)") + "@" + (fr.url || "").split("/").pop().split("?")[0] + ":" + (fr.lineNumber + 1);
          if (seen.has(l)) continue;
          seen.add(l);
          incl.set(l, (incl.get(l) ?? 0) + 1);
        }
      }
    }
    return { start, ms, top: [...incl].sort((a, b) => b[1] - a[1]).slice(0, 26).map(([l, h]) => Math.round((100 * h) / (n || 1)) + "% " + l) };
  });
}

const shotFile = opt("shot", "");
const vista = argv.includes("--vista");
let horizonProbe = null;
const loadTrace = argv.includes("--load-trace");
const trace = [];
const requests = new Map();
const loadStart = Date.now();
let loadMs = null;
let navStartMs = null;
const settleS = +opt("settle", "0");
const cpuProfile = argv.includes("--cpu");
const playerId = opt("player", "player");
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const app = path.resolve(here, "..");
const digestModule = "/@fs/" + path.resolve(app, "..", "..", "packages", "core", "src", "profile-digest.ts").replace(/\\/g, "/").replace(/^\//, "");

// the scene file and its hash
const projects = path.join(app, "projects");
const sceneFile =
  fs.readdirSync(projects).map((p) => path.join(projects, p, "assets", "scenes", `${scene}.scene.json`)).find((f) => fs.existsSync(f)) ??
  path.join(app, "assets", "scenes", `${scene}.scene.json`);
if (!fs.existsSync(sceneFile)) {
  console.error(`no scene file for "${scene}"`);
  process.exit(1);
}
const sceneHash = crypto.createHash("sha256").update(fs.readFileSync(sceneFile)).digest("hex").slice(0, 16);

// the apps/playground devDependency; PLAYWRIGHT_MODULE / HITREG_PLAYWRIGHT override (tools/_playwright.mjs)
const { chromium } = await (await import("./_playwright.mjs")).loadPlaywright();

const server = spawn("npx", ["vite", "--config", "vite.agent-test.config.ts", "--port", String(port), "--strictPort"], { cwd: app, shell: true, stdio: "ignore" });
const stopServer = () => {
  try {
    if (process.platform === "win32") execSync(`taskkill /F /T /PID ${server.pid}`, { stdio: "ignore" });
    else server.kill("SIGTERM");
  } catch {}
};
process.on("exit", stopServer);
const base = `http://localhost:${port}/`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  if (i > 120) {
    console.error("vite did not start");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

const W = 1280;
const H = 720;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--disable-gpu-vsync", "--disable-frame-rate-limit", "--mute-audio"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
await ctx.addInitScript(() => {
  // frame WORK: wall time spent inside rAF callbacks
  const raf = window.requestAnimationFrame.bind(window);
  window.__work = [];
  // callbacks of one frame share its timestamp: sum them per frame
  let lastT = -1;
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const t0 = performance.now();
      try {
        cb(t);
      } finally {
        if (window.__workOn) {
          const d = performance.now() - t0;
          if (t === lastT && window.__work.length) window.__work[window.__work.length - 1] += d;
          else window.__work.push(d);
          lastT = t;
        }
      }
    });
  try {
    const k = "hitreg-editor-settings";
    const cur = JSON.parse(localStorage.getItem(k) || "{}");
    localStorage.setItem(k, JSON.stringify({ ...cur, showStats: false, showGizmos: false, grid: false, showPhysics: false, showLights: false, showSkeletons: false }));
  } catch {}
});
// freeze the page at the code it booted with (HMR from other sessions would reload it mid-run)
await ctx.route(/\/@vite\/client(\?.*)?$/, (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `export const createHotContext = () => ({ data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {} });
export const updateStyle = (id, css) => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
export const removeStyle = () => {}; export const injectQuery = (u) => u; export class ErrorOverlay extends HTMLElement {}`,
  }),
);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
try {
  let loadProf = null;
  let loadCpu = null;
  let coverSeen = false;
  let afterProf = null;
  let afterCoverCpu = null;
  let coverDownMs = null;
  const rawProfiles = [];
  if (loadTrace) {
    loadProf = await ctx.newCDPSession(page);
    await loadProf.send("Profiler.enable");
    await loadProf.send("Profiler.setSamplingInterval", { interval: 1000 });
    await loadProf.send("Profiler.start");
    page.on("response", async (r) => {
      try {
        const u = r.url();
        const kind = /\/@fs\/|\/src\/|\.ts(\?|$)|\.mts|node_modules|@vite/.test(u) ? "code" : (u.match(/\.(glb|png|jpg|webp|json|mp3|ogg|wasm|bin)(\?|&|$)/)?.[1] ?? (u.includes("asset-file") ? (decodeURIComponent(u).match(/\.(\w+)(&|$)/)?.[1] ?? "asset") : "other"));
        const e = requests.get(kind) ?? { n: 0, kb: 0 };
        e.n++;
        e.kb += Number(r.headers()["content-length"] ?? 0) / 1024;
        requests.set(kind, e);
      } catch {}
    });
    await page.addInitScript(() => {
      window.__longTasks = [];
      // every frame's page time and the cover's edges, for time-to-smooth-play: page clocks, not this probe's 500 ms poll
      window.__frames = [];
      window.__coverEdges = [];
      let coverWas = null;
      const logFrame = () => {
        window.__frames.push(performance.now());
        const up = window.__hitreg?.coverUp?.() ?? null;
        if (up !== null && up !== coverWas) window.__coverEdges.push([Math.round(performance.now()), up]);
        if (up !== null) coverWas = up;
        requestAnimationFrame(logFrame);
      };
      requestAnimationFrame(logFrame);
      // every worker round trip: is a stalled ring waiting on the pool, and on what
      window.__workerJobs = [];
      window.__workers = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...a) {
          super(...a);
          const me = { at: Math.round(performance.now()), url: String(a[0]).split("/").pop().slice(0, 40), first: null, replies: 0 };
          window.__workers.push(me);
          const open = (this.__open = new Map());
          this.addEventListener("message", (e) => {
            me.first ??= Math.round(performance.now());
            me.replies++;
            const job = open.get(e.data?.id);
            if (job) { open.delete(e.data.id); window.__workerJobs.push([job[0], Math.round(performance.now()), job[1]]); }
          });
        }
        postMessage(m, ...r) {
          if (m && m.id !== undefined) this.__open.set(m.id, [Math.round(performance.now()), (m.kind ?? "?") + (m.mesh === false ? ":bulk" : "")]);
          return super.postMessage(m, ...r);
        }
      };
      // every texture upload by shape: a load's GPU copies, and what repeats
      const uploads = (window.__uploads = new Map());
      const tally = (key, ms) => { const e = uploads.get(key) ?? [0, 0]; e[0]++; e[1] += ms; uploads.set(key, e); };
      const shape = (s) => Array.isArray(s) ? s.join("x") : [s.width, s.height ?? 1, s.depthOrArrayLayers ?? 1].join("x");
      for (const name of ["writeTexture", "copyExternalImageToTexture"]) {
        const original = GPUQueue.prototype[name];
        GPUQueue.prototype[name] = function (...a) {
          const t = performance.now();
          const r = original.apply(this, a);
          if (name === "writeTexture") (window.__writes ??= []).push([Math.round(t), Math.round(performance.now() - t), a[1].byteLength, a[2].offset ?? 0]);
          tally(name[0] + " " + (a[0].texture?.format ?? a[1]?.texture?.format ?? "") + " " + shape(name === "writeTexture" ? a[3] : a[2]), performance.now() - t);
          return r;
        };
      }
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true });
    });
    const tick = async () => {
      try {
        const v = await page.evaluate(() => {
          const h = window.__hitreg;
          const c = h?.chunkManager?.stats;
          return { hit: !!h, cover: h?.coverUp?.() ?? null, cells: c?.chunks ?? null, loading: c?.loading ?? null, places: h?.placeStreamer?.stats?.loaded ?? null, builds: h?.renderer?.shaderBuildsPending ?? null, queues: h?.chunkManager ? [h.chunkManager.cellQueue?.length, h.chunkManager.pending?.size, h.chunkManager.inFlight?.size, h.chunkManager.supercellQueue?.length, h.chunkManager.inFlightSupercells?.size, h.chunkManager.pendingSupercells?.length] : null, draws: h?.info?.().render.drawCalls ?? null, long: (window.__longTasks ?? []).reduce((a, t) => a + t[1], 0) };
        });
        trace.push({ t: Math.round((Date.now() - loadStart) / 10) / 100, ...v });
        if (v.cover) coverSeen = true;
        if (coverSeen && v.cover === false && coverDownMs === null) {
          coverDownMs = Date.now() - loadStart;
          const done = loadProf;
          loadProf = null;
          if (done) {
            const { profile } = await done.send("Profiler.stop");
            rawProfiles.push({ profile, offset: (await page.evaluate(() => performance.now())) - profile.endTime / 1000 });
            loadCpu = cpuSummary(profile);
            await done.send("Profiler.start");
            afterProf = done;
          }
        }
        if (afterProf && Date.now() - loadStart - coverDownMs > 30000) {
          const done = afterProf;
          afterProf = null;
          const { profile } = await done.send("Profiler.stop");
          rawProfiles.push({ profile, offset: (await page.evaluate(() => performance.now())) - profile.endTime / 1000 });
          afterCoverCpu = cpuSummary(profile);
        }
      } catch {}
      if (loadMs === null) setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  }
  navStartMs = Date.now() - loadStart;
  if (opt("init", "")) await page.addInitScript(jsArg("init"));
  await page.goto(`${base}?scene=${encodeURIComponent(scene)}${opt("query", "") ? "&" + opt("query", "") : ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__hitreg && !!window.__hitreg.chunkManager, null, { timeout: 240000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__hitreg.playMode.set("playing"));
  await page.waitForTimeout(1500);
  // the sim is created a moment after play starts; a teleport before it exists is silently lost (the probe then
  // measured the scene spawn, not --at)
  if (at) await page.waitForFunction(() => !!window.__hitreg.sim, null, { timeout: 60000 });
  // the dev fast-travel (holds the body until the ground there has streamed in); the scene's player id is not
  // always "player", so a raw setTranslation by a guessed id silently measured the spawn instead
  if (at) {
    const how = await page.evaluate(([id, p]) => {
      const h = window.__hitreg;
      if (h.travelTo) return h.travelTo(p[0], p[1], p[2]);
      h.sim?.setTranslation(h.playerId?.() ?? id, p);
      return "setTranslation";
    }, [playerId, at]);
    if (how !== "ok") console.error(`--at: ${how}`);
    await page.waitForTimeout(3000);
  }
  if (yaw !== null) await page.evaluate((y) => window.__hitreg.cameraRig.setOrbit(y, null), yaw);
  // settle streaming: draw count steady and nothing loading for 4 s
  for (let i = 0, still = 0, last = -1; i < 120; i++) {
    await page.waitForTimeout(1000);
    const [n, l] = await page.evaluate(() => {
      const h = window.__hitreg;
      return [h.info().render.drawCalls, h.chunkManager.stats.loading ?? 0];
    });
    still = Math.abs(n - last) < 3 && l === 0 ? still + 1 : 0;
    last = n;
    if (i >= 8 && still >= 4) break;
  }
  loadMs = Date.now() - loadStart;
  if (loadProf) loadCpu = cpuSummary((await loadProf.send("Profiler.stop")).profile);
  if (vista) await page.evaluate((weather) => { const h = window.__hitreg; h.devCommand("weather", [weather]); h.devCommand("time", ["noon"]); h.devCommand("time", ["freeze"]); }, opt("weather", "clear"));
  // --eval <js>: run against the page (h = __hitreg) after the weather pin, for knob A/Bs
  if (opt("eval", "")) await page.evaluate(jsArg("eval"));
  if (settleS > 0) await page.waitForTimeout(settleS * 1000);
  await page.evaluate((legacy) => {
    const h = window.__hitreg;
    // draw attribution: three calls onBeforeRender once per object per pass
    let base = Object.getPrototypeOf(h.scene());
    while (base && !Object.prototype.hasOwnProperty.call(base, "onBeforeRender")) base = Object.getPrototypeOf(base);
    if (base && !base.__drawCounted) {
      const sc = h.scene();
      const nm = (x) => (x ? (x.name || x.type).replace(/[:_]?-?f?\d+(_-?\d+)?(\.\d+)?/g, "#").slice(0, 48) : "");
      const keyOf = (o) => {
        if (o.__drawKey) return o.__drawKey;
        const chain = [];
        for (let c = o; c && c !== sc; c = c.parent) chain.push(c);
        const a = chain[chain.length - 1], b = chain[chain.length - 2];
        return (o.__drawKey = b ? `${nm(a)}/${nm(b)}` : nm(a));
      };
      window.__drawsBy = new Map();
      window.__mats = new Set();
      window.__drawsByEntity = new Map();
      const orig = base.onBeforeRender;
      base.onBeforeRender = function (r, s, cam, g, m) {
        if (window.__drawsOn) {
          const k = (this.__inScene === undefined ? (this.__inScene = keyOf(this) !== null && (() => { for (let c = this; c; c = c.parent) if (c === sc) return true; return false; })()) : this.__inScene) ? (cam && cam.isOrthographicCamera ? "shadow " : "main ") + keyOf(this) : "post";
          window.__drawsBy.set(k, (window.__drawsBy.get(k) || 0) + 1);
          {
            const idx = g?.index?.count ?? g?.attributes?.position?.count ?? 0;
            const n = this.count ?? g?.instanceCount ?? 1;
            window.__trisBy ??= new Map();
            window.__trisBy.set(k, (window.__trisBy.get(k) || 0) + (idx / 3) * (Number.isFinite(n) ? n : 1));
          }
          if (this.__entKey === undefined) {
            let e = null;
            for (let c = this; c && !e; c = c.parent) e = c.userData?.entityId ?? null;
            this.__entKey = e ? String(e).replace(/-?[0-9]+/g, "#") : null;
          }
          if (this.__entKey) window.__drawsByEntity.set(k.split(" ")[0] + " " + this.__entKey, (window.__drawsByEntity.get(k.split(" ")[0] + " " + this.__entKey) || 0) + 1);
          if (m) {
            window.__mats.add(m);
            // described once per material, not per draw: walking a node graph every draw cost ~10% of the sampled frame
            let desc = m.__drawDesc;
            if (desc === undefined) {
              // per material: what kind it is (atlas page / own texture / wind) and whether the draw is a merged batch
              const texName = (t) => t ? (t.name || (t.image?.src || t.image?.currentSrc || "").split("/").pop() || "tex") + "#" + (t.source?.uuid || "").slice(0, 4) : null;
              // a node material carries its texture in the colour node graph, not in `map`
              const nodeTex = (n, d = 0, seen = new Set()) => {
                if (!n || typeof n !== "object" || d > 6 || seen.has(n)) return null;
                seen.add(n);
                if (n.isTextureNode && n.value?.isTexture) return n.value;
                for (const v of Object.values(n)) { const t = v && typeof v === "object" && !v.isTexture ? nodeTex(v, d + 1, seen) : null; if (t) return t; }
                return null;
              };
              const tex = (texName(m.map) ?? (m.colorNode ? "node:" + (texName(nodeTex(m.colorNode)) ?? "none") : "-")) + " u" + m.uuid.slice(0, 4) + " {" + Object.keys(m.userData || {}).join(",").slice(0, 60) + "}";
              const kind = m.userData?.hitregAtlas ? "ATLAS" : m.positionNode ? "WIND" : "own";
                            desc = m.__drawDesc = { kind, label: (m.name || m.type).slice(0, 40) + " [" + String(tex).slice(0, 40) + "]" };
            }
            if (this.__ownerKey === undefined) this.__ownerKey = this.userData?.batchOwners ? "<" + String(this.userData.batchOwners.ids[0]).replace(/-?[0-9]+/g, "#") + " +" + (new Set(this.userData.batchOwners.ids).size - 1) + ">" : this.__entKey || "";
            const how = this.userData?.batchOwners ? "merged" : this.isInstancedMesh ? "inst" : this.isInstancedProps ? "props" : "single";
            const mk = k.split(" ")[0] + " " + desc.kind + " " + how + " " + desc.label + " " + this.__ownerKey;
            window.__drawsByMaterial ??= new Map();
            window.__drawsByMaterial.set(mk, (window.__drawsByMaterial.get(mk) || 0) + 1);
          }
        }
        return orig.apply(this, arguments);
      };
      base.__drawCounted = true;
    }
    try {
      h.renderer.setGpuTiming(true);
    } catch {}
    if (legacy) {
      h.renderer.skinnedShadowDistance = 0;
      if (h.animations) h.animations.holdBones = false;
    }
    // shadow draws: three calls onBeforeShadow once per caster draw in a shadow pass
    let p = Object.getPrototypeOf(h.scene());
    while (p && !Object.prototype.hasOwnProperty.call(p, "onBeforeShadow")) p = Object.getPrototypeOf(p);
    if (p && !p.__counted) {
      const orig = p.onBeforeShadow;
      p.onBeforeShadow = function (...a) {
        window.__shadowDraws = (window.__shadowDraws || 0) + 1;
        return orig.apply(this, a);
      };
      p.__counted = true;
    }
  }, legacy);
  await page.waitForTimeout(warmMs);
  await page.evaluate(() => {
    const p = window.__hitreg.profiler;
    p.enabled = true;
    p.reset();
    window.__shadowDraws = 0;
    window.__work = [];
    window.__workOn = true;
    window.__drawsOn = true;
    window.__drawsBy?.clear();
    window.__drawsByEntity?.clear();
    window.__drawsByMaterial?.clear();
    window.__trisBy?.clear();
    window.__mats?.clear();
  });
  let cdpProf = null;
  if (cpuProfile) {
    cdpProf = await ctx.newCDPSession(page);
    await cdpProf.send("Profiler.enable");
    await cdpProf.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdpProf.send("Profiler.start");
  }
  await page.waitForTimeout(sampleMs);
  let cpu = null;
  if (cdpProf) {
    const { profile } = await cdpProf.send("Profiler.stop");
    cpu = cpuSummary(profile);
  }
  const report = await page.evaluate(async (digestModule) => {
    const h = window.__hitreg;
    const s = h.profiler.summary();
    const info = h.info();
    let digest = null;
    try {
      digest = (await import(digestModule)).digestProfile(s);
    } catch {}
    const visible = (o) => {
      for (let c = o; c; c = c.parent) if (!c.visible) return false;
      return true;
    };
    let bodies = 0, bodiesVisible = 0, lights = 0, shadowLights = 0;
    h.scene().traverse((o) => {
      if (o.isSkinnedMesh) {
        bodies++;
        if (visible(o)) bodiesVisible++;
      }
      if (o.isLight && !o.isAmbientLight && !o.isHemisphereLight && visible(o) && o.intensity > 0) {
        lights++;
        if (o.castShadow) shadowLights++;
      }
    });
    const r2 = (v) => Math.round(v * 100) / 100;
    const cam = h.camera.position;
    let body = null;
    try {
      const o = h.object(h.playerId());
      if (o) body = [o.position.x, o.position.y, o.position.z].map((v) => Math.round(v * 10) / 10);
    } catch {}
    window.__workOn = false;
    window.__drawsOn = false;
    const w = window.__work.slice().sort((a, b) => a - b);
    const q = (f) => (w.length ? w[Math.min(w.length - 1, Math.floor(f * w.length))] : 0);
    const nf = Math.max(1, s.frames);
    const drawsBy = [...(window.__drawsBy ?? new Map())].map(([k, v]) => [k, Math.round((v / nf) * 10) / 10]).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const drawsByEntity = [...(window.__drawsByEntity ?? new Map())].map(([k, v]) => [k, Math.round((v / nf) * 10) / 10]).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const drawsByMaterial = [...(window.__drawsByMaterial ?? new Map())].map(([k, v]) => [k, Math.round((v / nf) * 100) / 100]).filter(([k, v]) => v >= 0.5 || (k.startsWith("post") && v >= 0.02)).sort((a, b) => b[1] - a[1]).slice(0, 400);
    let gs = null;
    try {
      const g = h.graphStats();
      gs = { objects: g.total, instanced: g.instancedMeshes, instances: g.instances, meshes: g.byType.Mesh ?? 0, topRoots: g.topRoots.slice(0, 8).map((x) => `${x.name} ${x.n}`) };
    } catch {}
    return {
      frames: s.frames,
      fps: r2(s.fps),
      frameMs: { p50: r2(s.intervalMs.p50), p95: r2(s.intervalMs.p95) },
      jsMs: { p50: r2(s.frameMs.p50), p95: r2(s.frameMs.p95) },
      workMs: { p50: r2(q(0.5)), p95: r2(q(0.95)), mean: r2(w.reduce((a, b) => a + b, 0) / Math.max(1, w.length)) },
      materialsDrawn: window.__mats?.size ?? null,
      memory: { geometries: info.memory?.geometries, textures: info.memory?.textures, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null },
      chunks: h.chunkManager?.stats ?? null,
      renderScale: h.renderer?.renderScale ?? null,
      adaptive: h.debugHandles?.adaptiveResolution?.stats ?? null,
      chunksResident: h.chunkManager?.stats?.chunks ?? null,
      sheets: h.propSheets ? { ...h.propSheets.stats, usage: h.propSheets.usage() } : null,
      graph: gs,
      drawsBy,
      drawsByEntity,
      drawsByMaterial,
      trisBy: [...(window.__trisBy ?? new Map())].map(([k, v]) => [k, Math.round(v / nf)]).sort((a, b) => b[1] - a[1]).slice(0, 16),
      gpuMs: s.gpuMs ? r2(s.gpuMs.avg) : null,
      draws: info.render.drawCalls,
      triangles: info.render.triangles,
      shadowDraws: Math.round((window.__shadowDraws || 0) / Math.max(1, s.frames)),
      animatedBodies: bodies,
      animatedBodiesVisible: bodiesVisible,
      lights,
      shadowLights,
      camera: [cam.x, cam.y, cam.z].map((v) => Math.round(v * 10) / 10),
      body,
      topScopes: s.scopes.slice().sort((a, b) => b.avgSelfMs - a.avgSelfMs).slice(0, 6).map((x) => `${x.path} ${r2(x.avgSelfMs)}`),
      digest: digest?.lines?.[0] ?? null,
      bottleneck: digest?.bottleneck ?? null,
    };
  }, digestModule);
  if (vista) await page.evaluate(() => {
    for (const el of document.querySelectorAll("body *")) if (el.tagName !== "CANVAS" && !el.querySelector("canvas")) el.style.visibility = "hidden";
  });
  if (shotFile) await page.screenshot({ path: shotFile });
  // the same frame with the horizon mesh hidden: what differs between the two shots is the mesh and nothing else
  if (opt("shot-no-horizon", "")) {
    horizonProbe = await page.evaluate(() => {
      const land = window.__hitreg.horizon?.();
      const mesh = land?.root.children[0];
      if (land) land.root.visible = false;
      return { present: !!land, meshLoaded: !!mesh, triangles: mesh ? mesh.geometry.index.count / 3 : 0 };
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: opt("shot-no-horizon", "") });
  }
  // --eval-after <js>: an expression read back from the page after sampling, reported as `evalAfter`
  if (opt("eval-after", "")) report.evalAfter = await page.evaluate(jsArg("eval-after"));
  // live heap after a forced GC (usedJSHeapSize alone swings by a gigabyte with uncollected garbage)
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage");
    const u = await cdp.send("Runtime.getHeapUsage");
    report.memory.liveHeapMB = Math.round(u.usedSize / 1048576);
  } catch {}
  const smooth = loadTrace ? await page.evaluate(smoothPlaySummary, { navStartMs }) : null;
  const blame = loadTrace ? longTaskBlame(rawProfiles, (await page.evaluate(() => (window.__longTasks ?? []).slice().sort((a, b) => b[1] - a[1]).slice(0, 10)))) : null;
  const out = {
    scene,
    sceneFile: path.relative(app, sceneFile).replace(/\\/g, "/"),
    sceneHash,
    horizonProbe,
    loadMs,
    ...(loadTrace ? { writes: await page.evaluate(() => window.__writes ?? []), uploads: await page.evaluate(() => [...window.__uploads].map(([k, v]) => [k, v[0], Math.round(v[1])]).sort((a, b) => b[2] - a[2]).slice(0, 24)), coverDownMs, smooth, blame, loadCpu, afterCoverCpu, loadTrace: trace, requests: Object.fromEntries(requests), longTasks: await page.evaluate(() => (window.__longTasks ?? []).slice().sort((a, b) => b[1] - a[1]).slice(0, 25)) } : {}),
    at: at ?? "spawn",
    yaw,
    legacy,
    viewport: [W, H],
    sampleMs,
    measuredAt: new Date().toISOString(),
    ...report,
    errors: errors.slice(0, 5),
    ...(cpu ? { cpu } : {}),
  };
  const file = opt("out", "");
  if (file) fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
  stopServer();
}
