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
//     [--ms 10000] [--warm 6000] [--legacy] [--out report.json]
//
// --legacy turns the 2026-10-02 character savings off at runtime (skinned shadow range 0, held-pose
//   bone walks off), for an in-place before/after on the same build.
// Needs Playwright: PLAYWRIGHT_MODULE=<path to its index.mjs>, or `playwright` resolvable from here
// (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright; it drives the installed Chrome).
// Never point it at the owner's :5173: it starts and stops its own server.
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

const { chromium } = process.env.PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : await import("playwright");

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
  for (let k = 0; at && k < 3; k++) { await page.evaluate(([id, p]) => window.__hitreg.sim?.setTranslation(id, p), [playerId, at]); await page.waitForTimeout(1500); }
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
  await page.evaluate((legacy) => {
    const h = window.__hitreg;
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
  });
  await page.waitForTimeout(sampleMs);
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
    return {
      frames: s.frames,
      fps: r2(s.fps),
      frameMs: { p50: r2(s.intervalMs.p50), p95: r2(s.intervalMs.p95) },
      jsMs: { p50: r2(s.frameMs.p50), p95: r2(s.frameMs.p95) },
      gpuMs: s.gpuMs ? r2(s.gpuMs.avg) : null,
      draws: info.render.drawCalls,
      triangles: info.render.triangles,
      shadowDraws: Math.round((window.__shadowDraws || 0) / Math.max(1, s.frames)),
      animatedBodies: bodies,
      animatedBodiesVisible: bodiesVisible,
      lights,
      shadowLights,
      camera: [cam.x, cam.y, cam.z].map((v) => Math.round(v * 10) / 10),
      topScopes: s.scopes.slice().sort((a, b) => b.avgSelfMs - a.avgSelfMs).slice(0, 6).map((x) => `${x.path} ${r2(x.avgSelfMs)}`),
      digest: digest?.lines?.[0] ?? null,
      bottleneck: digest?.bottleneck ?? null,
    };
  }, digestModule);
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
  };
  const file = opt("out", "");
  if (file) fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
  stopServer();
}
