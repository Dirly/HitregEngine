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
const shotFile = opt("shot", "");
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
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--disable-gpu-vsync", "--disable-frame-rate-limit"] });
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
  await page.goto(`${base}?scene=${encodeURIComponent(scene)}`, { waitUntil: "load" });
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
          if (this.__entKey === undefined) {
            let e = null;
            for (let c = this; c && !e; c = c.parent) e = c.userData?.entityId ?? null;
            this.__entKey = e ? String(e).replace(/-?[0-9]+/g, "#") : null;
          }
          if (this.__entKey) window.__drawsByEntity.set(k.split(" ")[0] + " " + this.__entKey, (window.__drawsByEntity.get(k.split(" ")[0] + " " + this.__entKey) || 0) + 1);
          if (m) window.__mats.add(m);
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
    cpu = { self: top(self, 40), total: top(incl, 60) };
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
      graph: gs,
      drawsBy,
      drawsByEntity,
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
  if (shotFile) await page.screenshot({ path: shotFile });
  // live heap after a forced GC (usedJSHeapSize alone swings by a gigabyte with uncollected garbage)
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage");
    const u = await cdp.send("Runtime.getHeapUsage");
    report.memory.liveHeapMB = Math.round(u.usedSize / 1048576);
  } catch {}
  const out = {
    scene,
    sceneFile: path.relative(app, sceneFile).replace(/\\/g, "/"),
    sceneHash,
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
