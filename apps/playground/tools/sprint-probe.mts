/**
 * sprint-probe --scene <id> --line <name>=<x,z;x,z;...> [--line ...] [--length 1500]
 *   [--url http://localhost:<p>] [--port <p>] [--out <dir>] [--settle-ms 60000] [--headed]
 *
 * Does streaming keep ahead of a SPRINTING player? The dev app in headless Chrome (Playwright + system Chrome, real
 * WebGPU), local play, the body driven with Shift+W along each line (a polyline, extended straight past its last point
 * to --length metres), the camera turned toward a point 25 m further along the line every 100 ms. Each line starts with
 * a dev fast travel to its first point and waits until the world around it has streamed (or --settle-ms).
 *
 * Sampled every 250 ms in the page (no Playwright round trip in the loop):
 *   - player position, speed;
 *   - readyAhead: distance along the line's heading to the first cell that should be full detail but is not loaded
 *     (capped at 600 m) — how far the full-detail world leads the player;
 *   - under: whether the cell under the body is loaded, simulated (collider) and a ray hits ground;
 *   - the nearest 20 TREE instances (pool groups whose asset is a *Tree model): each one's drawn LOD tier against the
 *     tier its distance asks for (near/mid inside the far switch x hysteresis, impostor beyond the far switch);
 *   - chunk manager counters (loading, queue).
 * Per frame (a requestAnimationFrame wrapper installed before boot): frame interval and frame work (time inside rAF
 * callbacks), and every cell ENTRY — whether the cell the body just walked into was loaded and simulated.
 *
 * Outputs (overwritten): <out>/<scene>-sprint.json and <out>/<scene>-sprint.md (one page: per line ready-distance
 * p5/p50, cells entered unloaded, LOD-late counts, frame p95, and the worst moments). Default out:
 * projects/<project>/reports/sprint-probe/.
 *
 * --mode edit: no play session. The editor's streaming focus (the orbit TARGET) is driven along the line at --speed
 * (default 9.5 m/s, a sprint) with the eye 8 m behind and 4 m up — the same streaming and LOD work without gameplay
 * (mobs, combat, stamina) in the numbers. --ab runs each line three times in one page session, velocity-led streaming
 * and the moving LOD sweep OFF, ON, OFF (chunkManager.leadStreaming / foliageLod.movingSweep), so content and
 * machine state are shared by both arms; OFF twice brackets the warm-cache effect.
 *
 * --breakdown: a frame breakdown (window.__frameBreakdown, installed before boot) over 90 frames STANDING at each line's
 * start after the settle, and over 90 frames SPRINTING when the drive passes 40% of the line: draw calls by pass (main /
 * shadow / post) and by scene branch (instances, distinct materials, alphaTest draws, ms inside three's renderObject),
 * world-matrix work (updateMatrix / updateMatrixWorld calls per frame by branch, ms per top-level branch), the
 * profiler's top scopes for the window, and JS heap allocation / GC count (precise memory info). It resets the profiler.
 * --arms "<label>=<js>~<label>=<js>" (no spaces: heavy-lock wrappers re-split on them): in-session A/B arms (instead of --ab); each <js> runs in the page before its run
 * with `h` = window.__hitreg. --stand-only: settle and take the standing breakdown only, no drive. --cpu-profile: a CDP
 * sampling profile over --cpu-ms (3000) standing, by self / inclusive function and by file (decomposes render/draw). --shot: a
 * picture of each arm's standing view, editor overlay hidden (<out>/<scene>-<line>-<arm>.png).
 *
 * Heavy job: run it under the machine's heavy lock and alone (frame numbers are worthless beside other browsers).
 * Without --url it starts its own vite (agent-test config, --port, default 5287) and stops it by PID afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { killTree } from "./_kill-tree.mts";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS module
import { loadPlaywright } from "./_playwright.mjs";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n: string, d = "") => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1]! : d; };
const args = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]!] : []));

const SCENE = arg("--scene");
const LENGTH = +arg("--length", "1500");
const SETTLE_MS = +arg("--settle-ms", "60000");
/** --profile: the engine profiler on during each line; its summary (frame, gap, top scopes, spans) lands in the JSON. */
const PROFILE = argv.includes("--profile");
const MODE = arg("--mode", "play");
const SPEED = +arg("--speed", "9.5");
const AB = argv.includes("--ab");
const BREAKDOWN = argv.includes("--breakdown");
const ARMS_SPEC = arg("--arms");
const STAND_ONLY = argv.includes("--stand-only");
/** --shot: a picture of the standing view per arm (editor overlay hidden): <out>/<scene>-<line>-<arm>.png */
const SHOT = argv.includes("--shot");
/** --cpu-profile: a CDP sampling profile (100 µs) over 3 s standing after the breakdown, aggregated by self time per
 *  function, inclusive time per function and self time per source file — what decomposes a scope the engine profiler
 *  cannot (three's render(), the solver). (idle)/(program)/(garbage collector) rows are V8's own. */
const CPU_PROFILE = argv.includes("--cpu-profile");
const CPU_PROFILE_MS = +arg("--cpu-ms", "3000");
type XZ = [number, number];
const lines = args("--line").map((spec) => {
  const eq = spec.indexOf("=");
  const name = eq > 0 ? spec.slice(0, eq) : `line-${spec.length}`;
  const pts = (eq > 0 ? spec.slice(eq + 1) : spec).split(";").map((p) => p.split(",").map(Number) as XZ);
  return { name, points: extend(pts, LENGTH) };
});
if (!SCENE || lines.length === 0 || lines.some((l) => l.points.length < 2 || l.points.flat().some((n) => !Number.isFinite(n)))) {
  console.error('usage: sprint-probe --scene <id> --line <name>=<x,z;x,z;...> [--line ...] [--length 1500] [--url <dev app>] [--port <p>] [--out <dir>]');
  process.exit(2);
}

/** The polyline cut or extended (straight on along its last segment) to exactly `length` metres. */
function extend(pts: XZ[], length: number): XZ[] {
  const out: XZ[] = [pts[0]!];
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run + seg >= length) { const t = (length - run) / seg; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); return out; }
    out.push(b); run += seg;
  }
  const a = pts[pts.length - 2]!, b = pts[pts.length - 1]!, seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const rest = length - run;
  out.push([b[0] + ((b[0] - a[0]) / seg) * rest, b[1] + ((b[1] - a[1]) / seg) * rest]);
  return out;
}

function sceneProject(id: string): string | null {
  for (const p of fs.readdirSync(path.join(PG, "projects"))) if (fs.existsSync(path.join(PG, "projects", p, "assets", "scenes", `${id}.scene.json`))) return p;
  return null;
}
const project = sceneProject(SCENE);
if (!project) { console.error(`STOP: no scene ${SCENE}.scene.json in any project`); process.exit(2); }
const OUT = path.resolve(arg("--out") || path.join(PG, "projects", project, "reports", "sprint-probe"));
fs.mkdirSync(OUT, { recursive: true });

// -- dev server ------------------------------------------------------------------------------------
let vite: ReturnType<typeof spawn> | null = null;
let base = arg("--url").replace(/\/$/, "");
const stopVite = () => killTree(vite?.pid); // synchronous: an async taskkill raced process.exit and leaked vite
if (!base) {
  const port = arg("--port", "5287");
  vite = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--config", "vite.agent-test.config.ts", "--port", port, "--strictPort"], { cwd: PG, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  console.log(`vite pid ${vite.pid} on :${port}`);
  base = `http://localhost:${port}`;
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite did not start in 60 s")), 60000);
    const on = (b: Buffer) => { if (/ready in|Local:/.test(b.toString())) { clearTimeout(t); res(); } };
    vite!.stdout!.on("data", on); vite!.stderr!.on("data", on);
    vite!.on("exit", (c) => rej(new Error(`vite exited ${c} (port ${port} taken? pass --port)`)));
  }).catch((e) => { console.error("STOP:", (e as Error).message); stopVite(); process.exit(2); });
}
process.on("exit", stopVite);

// -- in-page instruments (plain JS strings: tsx would inject helpers the page does not have) --------
/** Before boot: time every rAF callback; a frame = one batch of callbacks run at the same timestamp. */
const FRAME_HOOK = `(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const frames = []; window.__sprintFrames = frames;
  let cur = null;
  window.requestAnimationFrame = (cb) => raf((ts) => {
    const t0 = performance.now();
    if (!cur || cur.ts !== ts) { cur = { ts, t: t0, work: 0 }; frames.push(cur); if (frames.length > 200000) frames.splice(0, 100000); }
    try { cb(ts); } finally { cur.work += performance.now() - t0; }
  });
})()`;

/**
 * window.__frameBreakdown(n): what the next n frames spend, by cause. Installed before boot; touches nothing until
 * called, and restores every wrapped method afterwards. Branch = the first two levels under the scene (digits folded,
 * so 300 chunk groups are one row).
 */
const BREAKDOWN_HOOK = `(() => {
  // phase 1: n frames with nothing wrapped (the profiler only) — the honest timings; phase 2: n instrumented frames
  // (counts and attribution; the wrappers slow the frame, so its own timings are not comparable)
  window.__frameBreakdown = (n) => new Promise((done) => {
    const p0 = window.__hitreg.profiler; if (p0) { p0.enabled = true; p0.reset?.(); } window.__hitreg.setGpuTiming?.(true);
    const f0c = window.__sprintFrames ? window.__sprintFrames.length : 0; let k = 0;
    const cleanTick = () => {
      if (++k <= n) { requestAnimationFrame(cleanTick); return; }
      const w = window.__sprintFrames ? window.__sprintFrames.slice(f0c + 1, f0c + 1 + n).map((x) => x.work).sort((a, b) => a - b) : [];
      const s = p0?.summary?.();
      const clean = { workP50: w.length ? +w[Math.floor(w.length / 2)].toFixed(1) : null, workP95: w.length ? +w[Math.floor(w.length * 0.95)].toFixed(1) : null,
        frameMs: s?.frameMs, gpuMs: s?.gpuMs ?? null, shaderBuildsPending: window.__hitreg.renderer.shaderBuildsPending ?? null, scopes: s ? [...s.scopes].sort((a, b) => b.avgSelfMs - a.avgSelfMs).slice(0, 20).map((x) => [x.path, +x.avgSelfMs.toFixed(2)]) : null,
        counters: s ? Object.fromEntries(Object.entries(s.counters || {}).map(([kk, v]) => [kk, +(+v.avg).toFixed(1)])) : null };
      instrumented(n).then((res) => done({ clean, ...res }));
    };
    requestAnimationFrame(cleanTick);
  });
  const instrumented = (n) => new Promise((resolve) => {
    const h = window.__hitreg, R = h.renderer.renderer, scene = h.scene(), prof = h.profiler;
    let O3 = Object.getPrototypeOf(scene);
    while (O3 && !(Object.prototype.hasOwnProperty.call(O3, "updateMatrixWorld") && Object.prototype.hasOwnProperty.call(O3, "updateMatrix"))) O3 = Object.getPrototypeOf(O3);
    const labels = new WeakMap();
    const nm = (o) => ((o.name || (o.isMesh && o.material && !Array.isArray(o.material) ? o.type + "[" + (o.material.name || o.material.type) + "]" : o.type) || "?") + "").replace(/-?\\d+(\\.\\d+)?/g, "#").slice(0, 48);
    const label = (o) => { let l = labels.get(o); if (l !== undefined) return l;
      const chain = []; for (let a = o; a && a !== scene; a = a.parent) chain.push(a);
      if (!o.parent && o !== scene) l = "(detached)"; else if (o === scene) l = "(scene)";
      else { const t = chain[chain.length - 1], u = chain[chain.length - 2]; l = nm(t) + (u ? "/" + nm(u) : ""); }
      labels.set(o, l); return l; };
    const bump = (m, k, f) => { let e = m.get(k); if (!e) { e = f(); m.set(k, e); } return e; };
    // -- draws: every renderObject call (one per draw) with its pass, branch, instances, material, time
    const draws = new Map(); const passes = { main: 0, shadow: 0, post: 0, other: 0 }; const mats = new Set(), passMats = { main: new Set(), shadow: new Set() };
    let drawMs = 0; const objs = new Map();
    const origRO = R.renderObject;
    R.renderObject = function (object, sc, camera, geometry, material, group, lightsNode, clip, passId) {
      const t0 = performance.now();
      try { return origRO.apply(this, arguments); } finally {
        const dt = performance.now() - t0; drawMs += dt;
        const pass = sc !== scene ? "post" : camera === h.camera || camera.isPerspectiveCamera ? "main" : camera.isOrthographicCamera ? "shadow" : "other";
        passes[pass]++;
        const k = pass + " " + label(object) + " " + object.type;
        const e = bump(draws, k, () => ({ draws: 0, inst: 0, ms: 0, mats: new Set(), alpha: 0, looks: new Set() }));
        e.draws++; e.ms += dt; e.inst += object.isInstancedMesh ? object.count : 1;
        if (pass !== "post") { const mm0 = sc.overrideMaterial || material;
          const o = bump(objs, object, () => ({ name: label(object) + " " + (object.name || ""), ms: 0, n: 0, verts: geometry?.attributes?.position?.count ?? 0, index: geometry?.index?.count ?? 0,
            attrs: Object.keys(geometry?.attributes ?? {}).join(","), mat: (mm0?.type || "") + ":" + (mm0?.name || ""), mv0: mm0?.version ?? 0, mv: 0,
            av0: Object.values(geometry?.attributes ?? {}).reduce((a, x) => a + (x.version || 0), 0), av: 0, iv0: geometry?.index?.version ?? 0, iv: 0, passes: new Set() }));
          o.ms += dt; o.n++; o.passes.add(pass); o.mv = mm0?.version ?? 0; o.av = Object.values(geometry?.attributes ?? {}).reduce((a, x) => a + (x.version || 0), 0); o.iv = geometry?.index?.version ?? 0; }
        const mm = sc.overrideMaterial || material; if (mm) { if (e.looks.size < 8) e.looks.add((mm.name || mm.type) + "|" + (mm.map ? (mm.map.image?.width ?? "?") + "px " + mm.map.uuid.slice(0, 6) : "nomap")); e.mats.add(mm.uuid); mats.add(mm.uuid); passMats[pass]?.add(mm.uuid); if (mm.alphaTest > 0) e.alpha++; }
      }
    };
    // -- world matrices: calls by branch; ms by top-level branch
    const mcalls = new Map(); let um = 0, umw = 0;
    const origUM = O3.updateMatrix, origUMW = O3.updateMatrixWorld;
    O3.updateMatrix = function () { um++; bump(mcalls, label(this), () => ({ um: 0, umw: 0 })).um++; return origUM.apply(this, arguments); };
    // entry points: an updateMatrixWorld / updateWorldMatrix / getWorldPosition call not nested in another one, by caller
    // (stack frames below the matrix code), with how many updateMatrix calls the whole entry did
    const entries = new Map(); let depth = 0, rootN = 0;
    const entry = (self, fn, args) => {
      if (depth > 0) { depth++; try { return fn.apply(self, args); } finally { depth--; } }
      const um0 = um; depth = 1;
      try { return fn.apply(self, args); } finally {
        depth = 0;
        if ((rootN++ & 15) !== 0) return; // a stack every 16th entry (counts below are x16)
        const st = (new Error().stack || "").split(String.fromCharCode(10)).slice(3, 7).map((l) => l.trim().replace(/^at /, "").replace(/https?:[/][/][^/]+[/]/, "").replace(/[?][^:)]*/, "")).join(" < ");
        const e = bump(entries, st, () => ({ calls: 0, um: 0 })); e.calls += 16; e.um += 16 * (um - um0);
      }
    };
    O3.updateMatrixWorld = function () { umw++; bump(mcalls, label(this), () => ({ um: 0, umw: 0 })).umw++; return entry(this, origUMW, arguments); };
    const origUWM = O3.updateWorldMatrix;
    O3.updateWorldMatrix = function () { return entry(this, origUWM, arguments); };
    const topMs = new Map(); const wrapped = [];
    for (const c of scene.children) {
      const own = Object.prototype.hasOwnProperty.call(c, "updateMatrixWorld"), f = c.updateMatrixWorld, key = nm(c);
      Object.defineProperty(c, "updateMatrixWorld", { configurable: true, writable: true, enumerable: false, value: function () {
        const t0 = performance.now(); try { return f.apply(this, arguments); } finally { const e = bump(topMs, key, () => ({ ms: 0, n: 0 })); e.ms += performance.now() - t0; e.n++; } } });
      wrapped.push([c, own, f]);
    }
    // -- graph shape: objects the per-frame walk reaches (stops at frozen roots) vs. all, by branch
    const shape = new Map(); let reach = 0, all = 0, frozenRoots = 0;
    const wasOwn = new Map(wrapped.map((w) => [w[0], w[1]]));
    const walk = (o, live) => { all++; const fr = o !== scene && (wasOwn.has(o) ? wasOwn.get(o) : Object.prototype.hasOwnProperty.call(o, "updateMatrixWorld"));
      if (fr) frozenRoots++; const lv = live && !fr; if (lv) reach++;
      if (o !== scene) { const e = bump(shape, label(o), () => ({ all: 0, walked: 0, autoUpdate: 0, meshes: 0 })); e.all++; if (lv) e.walked++; if (lv && o.matrixAutoUpdate) e.autoUpdate++; if (o.isMesh) e.meshes++; }
      for (const c of o.children) walk(c, lv); };
    walk(scene, true);
    // -- heap / GC
    const mem = () => performance.memory ? performance.memory.usedJSHeapSize : 0;
    let lastHeap = mem(), alloc = 0, gcs = 0, gcFreed = 0;
    if (prof) { prof.enabled = true; prof.reset?.(); }
    const f0 = window.__sprintFrames ? window.__sprintFrames.length : 0;
    let frames = 0;
    const tick = () => {
      const m = mem(); if (m >= lastHeap) alloc += m - lastHeap; else { gcs++; gcFreed += lastHeap - m; } lastHeap = m;
      if (++frames <= n) { requestAnimationFrame(tick); return; }
      R.renderObject = origRO; O3.updateMatrix = origUM; O3.updateMatrixWorld = origUMW; O3.updateWorldMatrix = origUWM;
      for (const [c, own, f] of wrapped) { if (own) Object.defineProperty(c, "updateMatrixWorld", { configurable: true, writable: true, enumerable: false, value: f }); else delete c.updateMatrixWorld; }
      const F = n, r1 = (x) => +(x / F).toFixed(2), r3 = (x) => +(x / F).toFixed(3);
      const fr = window.__sprintFrames ? window.__sprintFrames.slice(f0 + 1, f0 + 1 + n) : [];
      const works = fr.map((x) => x.work).sort((a, b) => a - b);
      const s = prof?.summary?.();
      const info = R.info;
      resolve({
        frames: F, workP50: works.length ? +works[Math.floor(works.length / 2)].toFixed(1) : null, workAvg: works.length ? +(works.reduce((a, b) => a + b, 0) / works.length).toFixed(1) : null,
        drawsPerFrame: { main: r1(passes.main), shadow: r1(passes.shadow), post: r1(passes.post), other: r1(passes.other) }, renderObjectMs: r3(drawMs),
        slowest: [...objs.values()].sort((a, b) => b.ms - a.ms).slice(0, 8).map((o) => ({ name: o.name, msPerFrame: r3(o.ms), drawsPerFrame: r1(o.n), verts: o.verts, index: o.index, attrs: o.attrs, mat: o.mat,
          matVersionDelta: o.mv - o.mv0, attrVersionDelta: o.av - o.av0, indexVersionDelta: o.iv - o.iv0, passes: [...o.passes].join("/") })),
        materials: { all: mats.size, main: passMats.main.size, shadow: passMats.shadow.size },
        draws: [...draws].map(([k, e]) => ({ k, draws: r1(e.draws), inst: r1(e.inst), mats: e.mats.size, alpha: r1(e.alpha), ms: r3(e.ms), looks: [...e.looks] })).sort((a, b) => b.ms - a.ms).slice(0, 40),
        matrices: { updateMatrix: r1(um), updateMatrixWorld: r1(umw), byBranch: [...mcalls].map(([k, e]) => ({ k, um: r1(e.um), umw: r1(e.umw) })).sort((a, b) => b.umw - a.umw).slice(0, 25),
          entries: [...entries].map(([k, e]) => ({ k, calls: r1(e.calls), um: r1(e.um) })).sort((a, b) => b.um - a.um).slice(0, 20),
          msByTop: [...topMs].map(([k, e]) => ({ k, ms: r3(e.ms) })).sort((a, b) => b.ms - a.ms).slice(0, 15) },
        graph: { objects: all, walked: reach, frozenRoots, byBranch: [...shape].map(([k, e]) => ({ k, ...e })).sort((a, b) => b.walked - a.walked).slice(0, 25) },
        heap: { allocMBperFrame: +(alloc / F / 1048576).toFixed(3), gcs, freedMB: +(gcFreed / 1048576).toFixed(1) },
        info: { drawCalls: info.render.drawCalls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures },
        foliage: h.foliageLod?.tierCounts?.(), culling: h.culling?.stats?.(), chunks: h.chunkManager.stats,
        profile: s ? { frameMs: s.frameMs, gapMs: s.gapMs, scopes: [...s.scopes].sort((a, b) => b.avgSelfMs - a.avgSelfMs).slice(0, 16).map((x) => [x.path, +x.avgSelfMs.toFixed(2)]),
          counters: Object.fromEntries(Object.entries(s.counters || {}).map(([k, v]) => [k, +(+v.avg).toFixed(1)])) } : null,
      });
    };
    requestAnimationFrame(tick);
  });
})()`;

/** The run: steer, sprint (keys are held from outside), sample. Resolves with the samples when the line is done. */
const RUN = `async ({ points, sampleMs, maxMs, drive, speed, breakdown }) => {
  const h = window.__hitreg;
  const cm = h.chunkManager, fl = h.foliageLod, pool = h.propPool;
  const size = cm.streamer.cellSize;
  const keyAt = (x, z) => Math.floor(x / size) + "_" + Math.floor(z / size);
  const edit = drive === "edit";
  const me = () => { if (edit) return h.controls.getTarget(h.camera.position.clone()); const o = h.object(h.playerId()); if (!o) return null; const p = o.position.clone(); o.getWorldPosition(p); return p; };
  // cumulative polyline lengths, and "where along the line is (x,z)"
  const cum = [0]; for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const total = cum[cum.length - 1];
  const project = (x, z) => { let best = { d: Infinity, s: 0, i: 0 };
    for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)); const d = Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
      if (d < best.d) best = { d, s: cum[i - 1] + t * Math.sqrt(L2), i }; }
    return best; };
  const pointAt = (s) => { s = Math.max(0, Math.min(total, s)); for (let i = 1; i < points.length; i++) if (s <= cum[i] || i === points.length - 1) {
      const seg = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / seg; return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]; } };
  const headingAt = (s) => { const a = pointAt(s), b = pointAt(s + 5); const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };

  // tree instances: pool groups whose asset is a *Tree model
  const treePages = () => { const out = []; for (const g of pool.groups.values()) if (/tree\\.(gltf|glb)$/i.test(g.assetId) && !/stump|log/i.test(g.assetId)) for (const p of g.pages) out.push(p); return out; };
  const lodDefault = fl.lodDistance, hyst = fl.hysteresis;
  const TIER = ["none", "near", "mid", "far"];
  const lodSample = (cam) => {
    const cands = [];
    for (const page of treePages()) {
      const st = fl.stateByBatch.get(page.batch); if (!st) continue;
      const b = page.batch;
      for (let i = 0; i < page.ids.length; i++) {
        if (page.ids[i] === undefined || (st.live && !st.live[i])) continue;
        const d = b.positions[i].distanceTo(cam);
        if (cands.length < 20 || d < cands[cands.length - 1].d) {
          cands.push({ d, tier: st.tier[i], hidden: st.hidden[i] > 0, far: b.lodDistance ?? lodDefault, near: b.mid && b.mid.length ? fl.nearThresholdFor(b) : null, cull: Math.sqrt(st.cullSq) });
          cands.sort((a, c) => a.d - c.d); if (cands.length > 20) cands.pop();
        }
      }
    }
    let late = 0, lateFar = 0, lateNearMid = 0, missing = 0;
    const trees = cands.map((c) => {
      let want = "ok";
      if (!c.hidden && c.d < c.cull * hyst) {
        if (c.tier === 0) { missing++; want = "drawn"; }
        else if (c.tier === 3 && c.d < c.far * hyst) { lateFar++; want = "mesh"; }
        else if (c.tier !== 3 && c.d > c.far) { lateFar++; want = "impostor"; }
        else if (c.near !== null && c.tier === 2 && c.d < c.near * hyst) { lateNearMid++; want = "near"; }
        else if (c.near !== null && c.tier === 1 && c.d > c.near) { lateNearMid++; want = "mid"; }
      }
      if (want !== "ok") late++;
      return [Math.round(c.d), TIER[c.tier], want];
    });
    return { trees, late, lateFar, lateNearMid, missing };
  };

  // frame + cell-entry watcher, every frame
  const entries = [];
  let lastKey = null, watching = true, frameFrom = window.__sprintFrames.length;
  const watch = () => { if (!watching) return; const p = me();
    if (p) { const k = keyAt(p.x, p.z); if (k !== lastKey) { const c = cm.loaded.get(k);
      entries.push({ t: performance.now(), key: k, x: Math.round(p.x), z: Math.round(p.z), exists: cm.hasCell(k), loaded: !!c, simulated: !!(c && c.simulated) }); lastKey = k; } }
    requestAnimationFrame(watch); };
  requestAnimationFrame(watch);

  const samples = []; const nudges = [];
  const t0 = performance.now(); let prev = null; const trail = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastSample = 0;
  let driveS = 0, driveT = performance.now();
  let bd = null;
  for (;;) {
    const now = performance.now(), p = me();
    if (!p) { await sleep(100); if (now - t0 > maxMs) break; continue; }
    const pr = project(p.x, p.z);
    if (breakdown && !bd && pr.s > total * 0.4) bd = window.__frameBreakdown(90);
    if (edit) {
      // the orbit target IS the streaming focus in edit mode: move it along the line at the given speed
      driveS = Math.min(total, driveS + speed * (now - driveT) / 1000); driveT = now;
      const q = pointAt(driveS), hd = headingAt(driveS), gy = (h.terrainHeight(q[0], q[1]) ?? 0) + 1.7;
      h.controls.setLookAt(q[0] - hd[0] * 8, gy + 4, q[1] - hd[1] * 8, q[0], gy, q[1], false);
    } else {
    // steer toward 25 m further along the line
    const goal = pointAt(pr.s + 25);
    h.cameraRig.setOrbit(Math.atan2(goal[0] - p.x, goal[1] - p.z) + Math.PI, null);
    trail.push({ t: now, x: p.x, z: p.z });
    while (trail.length && now - trail[0].t > 2500) trail.shift();
    // a body blocked by a wall/cliff for 2.5 s is carried 8 m along the line (counted: it is not what we measure)
    if (!edit && trail.length > 10 && now - trail[0].t > 2000 && Math.hypot(p.x - trail[0].x, p.z - trail[0].z) < 3 && h.sim) {
      const q = pointAt(pr.s + 8); const y = (h.terrainHeight(q[0], q[1]) ?? p.y) + 1.2;
      h.sim.setPosition(h.playerId(), [q[0], y, q[1]]); h.sim.setLinvel?.(h.playerId(), [0, 0, 0]);
      nudges.push({ t: Math.round(now - t0), x: Math.round(p.x), z: Math.round(p.z) }); trail.length = 0;
    }
    }
    if (now - lastSample >= sampleMs) {
      lastSample = now;
      const speed = prev ? Math.hypot(p.x - prev.x, p.z - prev.z) / ((now - prev.t) / 1000) : 0;
      prev = { t: now, x: p.x, z: p.z };
      const hd = headingAt(pr.s);
      let ahead = 600;
      for (let d = 0; d <= 600; d += 4) { const k = keyAt(p.x + hd[0] * d, p.z + hd[1] * d); if (cm.hasCell(k) && !cm.loaded.has(k)) { ahead = d; break; } }
      let simAhead = 600;
      for (let d = 0; d <= 600; d += 4) { const k = keyAt(p.x + hd[0] * d, p.z + hd[1] * d); const c = cm.loaded.get(k); if (cm.hasCell(k) && !(c && c.simulated)) { simAhead = d; break; } }
      // cells within the trees' mesh range (170 m x hysteresis) not loaded at full detail: their trees can only be
      // HLOD impostors (or nothing) however close the player gets
      let proxyCellsNear = 0;
      { const R = 145, r = Math.ceil(R / size) + 1, ccx = Math.floor(p.x / size), ccz = Math.floor(p.z / size);
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { const cx = ccx + dx, cz = ccz + dz;
          const ex = Math.max(cx * size - p.x, 0, p.x - (cx + 1) * size), ez = Math.max(cz * size - p.z, 0, p.z - (cz + 1) * size);
          if (Math.hypot(ex, ez) > R) continue; const k = cx + "_" + cz; if (cm.hasCell(k) && !cm.loaded.has(k)) proxyCellsNear++; } }
      const uk = keyAt(p.x, p.z), uc = cm.loaded.get(uk);
      const ray = edit ? true : h.sim ? h.sim.raycast([p.x + 1.5, p.y + 20, p.z], [0, -1, 0], 60, { exclude: [h.playerId()] }) : null;
      // LOD is judged from the camera the frame renders with: the third-person rig's eye (private, read anyway)
      const eye = edit ? h.camera.position : h.cameraRig?.eye && h.cameraRig.eye.lengthSq() > 0 ? h.cameraRig.eye : p;
      const lod = lodSample(eye);
      const st = cm.stats;
      const fr = window.__sprintFrames; const recent = fr.slice(Math.max(frameFrom, fr.length - 120));
      samples.push({ t: Math.round(now - t0), s: Math.round(pr.s), off: Math.round(pr.d), x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), speed: +speed.toFixed(2),
        ahead, simAhead, proxyCellsNear, under: { loaded: !!uc, simulated: !!(uc && uc.simulated), ground: !!ray },
        lod, loading: st.loading, chunks: st.chunks, queue: cm.cellQueue.length, pending: cm.pending.size, inFlight: cm.inFlight.size });
      if (pr.s >= total - 3) break;
    }
    if (now - t0 > maxMs) break;
    await sleep(50);
  }
  watching = false;
  const fr = window.__sprintFrames.slice(frameFrom);
  const frames = []; for (let i = 1; i < fr.length; i++) frames.push([Math.round(fr[i].t - t0), +(fr[i].t - fr[i - 1].t).toFixed(1), +fr[i - 1].work.toFixed(1)]);
  return { samples, entries: entries.map((e) => ({ ...e, t: Math.round(e.t - t0) })), frames, nudges, total, breakdown: bd ? await bd : null };
}`;

// -- browser ---------------------------------------------------------------------------------------
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "chrome", headless: !argv.includes("--headed"), args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
// a test client never writes authoring files (its scene autosave erased other tools' installs, 2026-11-03)
await page.route(/\/__hitreg\//, (await import("./_readonly-posts.mjs")).dropAuthoringWrites);
const logs: string[] = [];
page.on("console", (m: { text(): string; type(): string }) => { const t = m.text(); if (m.type() === "error" || /infringes|Invalid RenderPipeline|fell/i.test(t)) logs.push(t.slice(0, 240)); });
page.on("pageerror", (e: Error) => logs.push("pageerror: " + e.message));
page.on("crash", () => logs.push("PAGE CRASHED"));
await page.addInitScript(FRAME_HOOK);
await page.addInitScript(BREAKDOWN_HOOK);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await sleep(500); } return false; };
const ev = <T,>(src: string, a?: unknown) => page.evaluate(`(${src})(${JSON.stringify(a ?? null)})`) as Promise<T>;
type St = { scene: string; mode: string; travelling: boolean; loading: boolean; sim: boolean; pid: string | null; chunkLoading: number; builds: number };
const state = () => ev<St>(`() => { const h = window.__hitreg; return { scene: h.sceneName(), mode: h.playMode.get(), travelling: h.travelling(), loading: !!h.loading?.(), sim: !!h.sim, pid: h.playerId(), chunkLoading: h.chunkManager.stats.loading, builds: h.renderer.shaderBuildsPending ?? 0 }; }`);

const t0 = Date.now();
await page.goto(`${base}/?scene=${encodeURIComponent(SCENE)}`, { waitUntil: "load" });
if (!(await waitUntil(() => page.evaluate(() => !!(window as unknown as { __hitreg?: { playerId?: unknown } }).__hitreg?.playerId), 240000))) { console.error("STOP: the dev app never came up"); await browser.close(); process.exit(2); }
if (!(await waitUntil(async () => (await state()).scene === SCENE, 120000))) console.error(`scene ${SCENE} not up after 120 s: ${JSON.stringify(await state())}; page errors: ${JSON.stringify(logs.slice(-8))}`);
await sleep(1500);
await page.locator("canvas").first().focus().catch(() => {});
if (MODE === "play") {
  await page.keyboard.press("Backquote");
  const inPlay = async () => { const s = await state(); return s.mode === "playing" && s.sim && !!s.pid && !s.loading; };
  if (!(await waitUntil(inPlay, +arg("--play-wait-ms", "300000")))) { console.error(`STOP: play never started: ${JSON.stringify(await state())}; page errors: ${JSON.stringify(logs.slice(-8))}`);
    // what the arrival gate is waiting for: simulation cells desired but not loaded, and the loader's own sets
    console.error("chunk state: " + JSON.stringify(await ev(`() => { const cm = window.__hitreg.chunkManager; const notLoaded = []; for (const [k, r] of cm.desiredCells) if (r === "simulation" && cm.hasCell(k) && !cm.loaded.has(k)) notLoaded.push(k); return { lastFocus: cm.lastFocus, focus: [cm.focusX, cm.focusZ], cellSize: cm.streamer?.cellSize, simNotLoaded: notLoaded, inFlight: [...cm.inFlight], pending: [...cm.pending.keys()], queue: cm.cellQueue.slice(0, 30), inFlightSupercells: [...(cm.inFlightSupercells?.keys?.() ?? cm.inFlightSupercells ?? [])].slice(0, 20), landing: cm.isLandingReady(cm.focusX, cm.focusZ) }; }`))); await browser.close(); process.exit(2); }
  await ev(`() => document.exitPointerLock?.()`);
  console.log(`in play after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else console.log(`edit mode, scene up after ${((Date.now() - t0) / 1000).toFixed(0)} s`);

type Sample = { t: number; s: number; x: number; z: number; speed: number; ahead: number; simAhead: number; proxyCellsNear: number; under: { loaded: boolean; simulated: boolean; ground: boolean }; lod: { late: number; lateFar: number; lateNearMid: number; missing: number; trees: unknown[] }; loading: number; queue: number; pending: number; inFlight: number };
type Entry = { t: number; key: string; x: number; z: number; exists: boolean; loaded: boolean; simulated: boolean };
type Run = { samples: Sample[]; entries: Entry[]; frames: [number, number, number][]; nudges: { t: number; x: number; z: number }[]; total: number; breakdown?: Record<string, unknown> | null };
/** The console line for a breakdown: totals, top scopes, top draw rows and matrix branches. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const brief = (b: any) => ({ clean: b.clean ? { work: b.clean.workP50, p95: b.clean.workP95, gpu: b.clean.gpuMs?.avg, builds: b.clean.shaderBuildsPending, scopes: b.clean.scopes?.slice(0, 10), draws: b.clean.counters?.drawCalls } : null, work: b.workP50, draws: b.drawsPerFrame, roMs: b.renderObjectMs, mats: b.materials, um: b.matrices.updateMatrix, umw: b.matrices.updateMatrixWorld,
  walked: b.graph.walked, objects: b.graph.objects, heap: b.heap, scopes: b.profile?.scopes?.slice(0, 8) });
const results: Record<string, unknown>[] = [];

type CpuRow = { k: string; pct: number; ms: number };
type CpuProfile = { ms: number; samples: number; self: CpuRow[]; inclusive: CpuRow[]; files: CpuRow[] };
/** A CDP sampling profile over `ms` of wall-clock on the page's main thread, aggregated three ways (see --cpu-profile). */
async function cpuProfile(ms: number): Promise<CpuProfile> {
  type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  await sleep(ms);
  const { profile } = (await cdp.send("Profiler.stop")) as { profile: { nodes: Node[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number } };
  await cdp.send("Profiler.disable");
  await cdp.detach();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  const selfUs = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i++) selfUs.set(profile.samples[i]!, (selfUs.get(profile.samples[i]!) ?? 0) + (profile.timeDeltas[i] ?? 0));
  const total = profile.endTime - profile.startTime;
  const src = (n: Node) => n.callFrame.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\?.*$/, "").replace(/^node_modules\/\.vite\/deps\//, "deps/").replace(/^@fs\/.*?\/Engine\//, "");
  const key = (n: Node) => `${n.callFrame.functionName || "(anonymous)"} ${src(n)}:${n.callFrame.lineNumber + 1}`;
  const file = (n: Node) => src(n) || n.callFrame.functionName || "(native)";
  const bySelf = new Map<string, number>(), byFile = new Map<string, number>(), inclusive = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, us: number) => m.set(k, (m.get(k) ?? 0) + us);
  for (const [id, us] of selfUs) {
    const n = byId.get(id)!;
    add(bySelf, key(n), us);
    add(byFile, file(n), us);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parentOf.get(at)) {
      const k = key(byId.get(at)!);
      if (seen.has(k)) continue;
      seen.add(k);
      add(inclusive, k, us);
    }
  }
  const top = (m: Map<string, number>, n: number): CpuRow[] =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => ({ k, pct: +((us / total) * 100).toFixed(1), ms: +(us / 1000).toFixed(1) }));
  return { ms: +(total / 1000).toFixed(0), samples: profile.samples.length, self: top(bySelf, 40), inclusive: top(inclusive, 40), files: top(byFile, 20) };
}
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!; };

const ARMS: { label: string; on: boolean | null; js?: string }[] = ARMS_SPEC
  ? ARMS_SPEC.split("~").map((a) => { const i = a.indexOf("="); return { label: a.slice(0, i), on: null, js: a.slice(i + 1) }; })
  : AB ? [{ label: "off", on: false }, { label: "on", on: true }, { label: "off2", on: false }] : [{ label: "", on: null }];
for (const base of lines) for (const armDef of ARMS) {
  const line = { ...base, name: armDef.label ? `${base.name} [${armDef.label}]` : base.name };
  if (armDef.js) await ev(`() => { const h = window.__hitreg; ${armDef.js}; }`);
  if (armDef.on !== null) await ev(`(on) => { const h = window.__hitreg; h.chunkManager.leadStreaming = on; h.foliageLod.movingSweep = on; }`, armDef.on);
  const [sx, sz] = line.points[0]!;
  const y = await ev<number | null>(`([x, z]) => window.__hitreg.terrainHeight(x, z)`, [sx, sz]);
  const yaw = Math.atan2(line.points[1]![0] - sx, line.points[1]![1] - sz);
  if (MODE === "play") {
    const ok = await ev<string>(`([x, y, z]) => window.__hitreg.travelTo(x, y, z)`, [sx, (y ?? 100) + 1.5, sz]);
    if (ok !== "ok") { console.error(`STOP: fast travel refused: ${ok}`); break; }
    await ev(`(y) => window.__hitreg.cameraRig.setOrbit(y + Math.PI, null)`, yaw);
  } else {
    await ev(`([x, y, z, yaw]) => window.__hitreg.controls.setLookAt(x - Math.sin(yaw) * 8, y + 5.7, z - Math.cos(yaw) * 8, x, y + 1.7, z, false)`, [sx, y ?? 100, sz, yaw]);
  }
  await waitUntil(async () => { const s = await state(); return !s.travelling && !s.loading; }, 240000);
  // settle: the rings around the start finish streaming (or the settle budget runs out)
  await waitUntil(async () => (await state()).chunkLoading === 0, SETTLE_MS);
  // ...and the background shader precompiles those cells queued: a window measured over them is paying for
  // compiles, not the scene (6 ms a frame of compileAsync showed up in a "standing" profile before this wait)
  await waitUntil(async () => (await state()).builds === 0, SETTLE_MS);
  await sleep(3000);
  const standing = BREAKDOWN ? await ev<Record<string, unknown>>(`() => window.__frameBreakdown(90)`) : null;
  if (standing) console.log(JSON.stringify({ line: line.name, standing: brief(standing) }));
  const cpu = CPU_PROFILE ? await cpuProfile(CPU_PROFILE_MS) : null;
  if (cpu) console.log(JSON.stringify({ line: line.name, cpu: { ms: cpu.ms, self: cpu.self.slice(0, 14), files: cpu.files.slice(0, 8) } }));
  if (SHOT) {
    await ev(`() => window.__hitreg.editorVisible?.set(false)`);
    await sleep(1500);
    const file = path.join(OUT, `${SCENE}-${base.name}-${armDef.label || "view"}.png`.replace(/[^\w.-]+/g, "_"));
    await page.screenshot({ path: file });
    await ev(`() => window.__hitreg.editorVisible?.set(true)`);
    console.log(`shot: ${file}`);
  }
  if (STAND_ONLY) { results.push({ summary: { line: line.name }, standing, cpu }); continue; }
  console.log(`${line.name}: start ${sx.toFixed(0)},${sz.toFixed(0)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await page.locator("canvas").first().focus().catch(() => {});
  await ev(`() => document.exitPointerLock?.()`);
  if (MODE === "play") { await page.keyboard.down("ShiftLeft"); await page.keyboard.down("KeyW"); }
  if (PROFILE) await ev(`() => { const p = window.__hitreg.profiler; p.enabled = true; p.reset?.(); }`);
  let run: Run;
  try {
    run = await ev<Run>(RUN, { points: line.points, sampleMs: 250, maxMs: Math.round((LENGTH / 5) * 1000 + 30000), drive: MODE, speed: SPEED, breakdown: BREAKDOWN });
  } finally {
    if (MODE === "play") { await page.keyboard.up("KeyW"); await page.keyboard.up("ShiftLeft"); }
  }
  const profile = PROFILE ? await ev<Record<string, unknown>>(`() => { const p = window.__hitreg.profiler; const s = p.summary(); p.enabled = false;
    return { frameMs: s.frameMs, intervalMs: s.intervalMs, gapMs: s.gapMs, gpuMs: s.gpuMs, windowSeconds: s.windowSeconds,
      scopes: [...s.scopes].sort((a, b) => b.avgSelfMs - a.avgSelfMs).slice(0, 25),
      markers: s.markers.slice(-40), spikes: s.spikes.slice(0, 8) }; }`) : null;
  const S = run.samples.filter((s) => s.speed > 3); // moving samples only
  const ahead = S.map((s) => s.ahead), simAhead = S.map((s) => s.simAhead);
  const entered = run.entries.filter((e) => e.exists);
  const intervals = run.frames.map((f) => f[1]), work = run.frames.map((f) => f[2]);
  const summary = {
    line: line.name, from: line.points[0], length: Math.round(run.total), seconds: +((run.samples.at(-1)?.t ?? 0) / 1000).toFixed(1),
    speedP50: +pct(S.map((s) => s.speed), 50).toFixed(2), nudges: run.nudges.length,
    readyAhead: { p5: pct(ahead, 5), p50: pct(ahead, 50), min: Math.min(...ahead) },
    simAhead: { p5: pct(simAhead, 5), p50: pct(simAhead, 50), min: Math.min(...simAhead) },
    cellsEntered: entered.length, enteredUnloaded: entered.filter((e) => !e.loaded).length, enteredNoCollider: entered.filter((e) => !e.simulated).length,
    underNoGround: S.filter((s) => !s.under.ground).length,
    proxyCellsNear: { samples: S.filter((s) => s.proxyCellsNear > 0).length, max: Math.max(0, ...S.map((s) => s.proxyCellsNear)) },
    lod: { samplesLate: S.filter((s) => s.lod.late > 0).length, lateFar: S.reduce((a, s) => a + s.lod.lateFar, 0), lateNearMid: S.reduce((a, s) => a + s.lod.lateNearMid, 0), missing: S.reduce((a, s) => a + s.lod.missing, 0), samples: S.length },
    frames: { n: run.frames.length, intervalP50: pct(intervals, 50), intervalP95: pct(intervals, 95), intervalP99: pct(intervals, 99), intervalMax: Math.max(...intervals), workP50: pct(work, 50), workP95: pct(work, 95), over33: run.frames.filter((f) => f[1] > 33.4).length },
    worstAhead: [...S].sort((a, b) => a.ahead - b.ahead).slice(0, 6).map((s) => ({ t: s.t, s: s.s, at: [s.x, s.z], ahead: s.ahead, simAhead: s.simAhead, loading: s.loading, queue: s.queue, pending: s.pending, inFlight: s.inFlight })),
    worstFrames: [...run.frames].sort((a, b) => b[1] - a[1]).slice(0, 6).map((f) => ({ t: f[0], interval: f[1], work: f[2] })),
    unloadedEntries: entered.filter((e) => !e.loaded || !e.simulated).slice(0, 12),
    worstLod: [...S].sort((a, b) => b.lod.late - a.lod.late).slice(0, 4).map((s) => ({ t: s.t, at: [s.x, s.z], late: s.lod.late, trees: s.lod.trees })),
  };
  console.log(JSON.stringify({ line: summary.line, readyAhead: summary.readyAhead, enteredUnloaded: summary.enteredUnloaded, enteredNoCollider: summary.enteredNoCollider, lod: summary.lod, proxyCellsNear: summary.proxyCellsNear, frames: summary.frames, nudges: summary.nudges }));
  const sprinting = run.breakdown ?? null; delete run.breakdown;
  if (sprinting) console.log(JSON.stringify({ line: line.name, sprinting: brief(sprinting) }));
  results.push({ summary, profile, standing, cpu, sprinting, run });
  if (profile) console.log(JSON.stringify({ profile: { frameMs: profile["frameMs"], gapMs: profile["gapMs"], gpuMs: profile["gpuMs"], scopes: (profile["scopes"] as { path: string; avgMs: number; avgSelfMs: number }[]).slice(0, 12).map((x) => [x.path, +x.avgSelfMs.toFixed(2), +x.avgMs.toFixed(2)]) } }));
}
await browser.close().catch(() => {});
stopVite();

// -- report ----------------------------------------------------------------------------------------
fs.writeFileSync(path.join(OUT, `${SCENE}-sprint.json`), JSON.stringify({ scene: SCENE, at: new Date().toISOString(), logs: logs.slice(-40), results }) + "\n");
const md: string[] = [`# Sprint probe: ${SCENE}`, "", `${new Date().toISOString()}; ${lines.length} line(s), ${LENGTH} m each; moving samples (speed > 3 m/s) only.`, ""];
md.push("| line | s | speed p50 | ready ahead p5 / p50 / min (m) | collider ahead p5 / p50 | cells entered | entered unloaded | entered w/o collider | LOD-late samples | late far / near-mid | samples with impostor-only cells < 145 m (max) | frame p50 / p95 / p99 / max (ms) | work p95 | >33 ms | nudges |");
md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  const s = r["summary"] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!s.readyAhead) continue;
  md.push(`| ${s.line} | ${s.seconds} | ${s.speedP50} | ${s.readyAhead.p5} / ${s.readyAhead.p50} / ${s.readyAhead.min} | ${s.simAhead.p5} / ${s.simAhead.p50} | ${s.cellsEntered} | ${s.enteredUnloaded} | ${s.enteredNoCollider} | ${s.lod.samplesLate}/${s.lod.samples} | ${s.lod.lateFar} / ${s.lod.lateNearMid} | ${s.proxyCellsNear.samples} (${s.proxyCellsNear.max}) | ${s.frames.intervalP50} / ${s.frames.intervalP95} / ${s.frames.intervalP99} / ${s.frames.intervalMax} | ${s.frames.workP95} | ${s.frames.over33} | ${s.nudges} |`);
}
for (const r of results) {
  const s = r["summary"] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!s.readyAhead) continue;
  md.push("", `## ${s.line} — worst moments`, "", "Least ready distance ahead:");
  for (const w of s.worstAhead) md.push(`- t ${(w.t / 1000).toFixed(1)} s at ${w.at.join(", ")}: full detail ${w.ahead} m ahead, collider ${w.simAhead} m (loading ${w.loading}, queue ${w.queue}, pending ${w.pending}, in flight ${w.inFlight})`);
  md.push("", "Longest frames:");
  for (const f of s.worstFrames) md.push(`- t ${(f.t / 1000).toFixed(1)} s: ${f.interval} ms (work ${f.work} ms)`);
  if (s.unloadedEntries.length) { md.push("", "Cells entered not ready:"); for (const e of s.unloadedEntries) md.push(`- t ${(e.t / 1000).toFixed(1)} s cell ${e.key} at ${e.x}, ${e.z}: loaded ${e.loaded}, collider ${e.simulated}`); }
  if (s.worstLod[0]?.late) { md.push("", "Most LOD-late trees ([distance, drawn tier, wanted]):"); for (const w of s.worstLod) md.push(`- t ${(w.t / 1000).toFixed(1)} s at ${w.at.join(", ")}: ${w.late} late — ${JSON.stringify(w.trees.filter((t: unknown[]) => t[2] !== "ok").slice(0, 8))}`); }
}
const bdRows = results.flatMap((r) => (["standing", "sprinting"] as const).filter((k) => r[k]).map((k) => [`${(r["summary"] as { line: string }).line} ${k}`, r[k]] as const));
if (bdRows.length) {
  md.push("", "## Frame breakdown (per frame, 90 frames)", "", "| when | clean work p50 / p95 | GPU ms avg | clean top scopes (self ms) | instrumented work p50 | draws main / shadow / post | renderObject ms | materials main / shadow | updateMatrix / updateMatrixWorld | objects walked / all | alloc MB/frame, GCs | top scopes (self ms) |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [w, b] of bdRows as [string, any][]) md.push(`| ${w} | ${b.clean?.workP50} / ${b.clean?.workP95} | ${b.clean?.gpuMs?.avg?.toFixed?.(1) ?? "-"} | ${(b.clean?.scopes ?? []).slice(0, 8).map((x: [string, number]) => `${x[0]} ${x[1]}`).join("; ")} | ${b.workP50} | ${b.drawsPerFrame.main} / ${b.drawsPerFrame.shadow} / ${b.drawsPerFrame.post} | ${b.renderObjectMs} | ${b.materials.main} / ${b.materials.shadow} | ${b.matrices.updateMatrix} / ${b.matrices.updateMatrixWorld} | ${b.graph.walked} / ${b.graph.objects} | ${b.heap.allocMBperFrame}, ${b.heap.gcs} | ${(b.profile?.scopes ?? []).slice(0, 6).map((x: [string, number]) => `${x[0]} ${x[1]}`).join("; ")} |`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [w, b] of bdRows as [string, any][]) {
    md.push("", `### ${w}`, "", "Draws (per frame) by pass, branch, type — top by ms:", "");
    for (const d of b.draws.slice(0, 15)) md.push(`- ${d.k}: ${d.draws} draws, ${d.inst} inst, ${d.mats} mats, alphaTest ${d.alpha}, ${d.ms} ms`);
    md.push("", "Slowest render objects (ms per frame; version deltas over the window):", "");
    for (const o of b.slowest ?? []) md.push(`- ${o.name} [${o.passes}]: ${o.msPerFrame} ms, ${o.drawsPerFrame} draws, ${o.verts} verts / ${o.index} idx, attrs ${o.attrs}, ${o.mat}, mat v+${o.matVersionDelta}, attr v+${o.attrVersionDelta}, index v+${o.indexVersionDelta}`);
    md.push("", "Matrix walk by branch (updateMatrixWorld / updateMatrix calls per frame):", "");
    for (const m of b.matrices.byBranch.slice(0, 10)) md.push(`- ${m.k}: ${m.umw} / ${m.um}`);
    md.push("", "Matrix entry points (calls / updateMatrix per frame, caller):", "");
    for (const m of (b.matrices.entries ?? []).slice(0, 10)) md.push(`- ${m.calls} / ${m.um}: ${m.k}`);
    md.push("", `Matrix ms by top-level branch: ${b.matrices.msByTop.slice(0, 8).map((m: { k: string; ms: number }) => `${m.k} ${m.ms}`).join("; ")}`);
  }
}
for (const r of results) {
  const c = r["cpu"] as CpuProfile | null | undefined;
  if (!c) continue;
  md.push("", `## CPU profile standing — ${(r["summary"] as { line: string }).line} (${c.ms} ms, ${c.samples} samples)`, "", "Self time by function (% of wall-clock):", "");
  for (const x of c.self.slice(0, 30)) md.push(`- ${x.pct}% ${x.ms} ms: ${x.k}`);
  md.push("", "Inclusive time by function:", "");
  for (const x of c.inclusive.slice(0, 25)) md.push(`- ${x.pct}% ${x.ms} ms: ${x.k}`);
  md.push("", "Self time by source file:", "");
  for (const x of c.files.slice(0, 15)) md.push(`- ${x.pct}% ${x.ms} ms: ${x.k}`);
}
if (logs.length) md.push("", "## Page errors", "", ...logs.slice(-12).map((l) => `- ${l}`));
fs.writeFileSync(path.join(OUT, `${SCENE}-sprint.md`), md.join("\n") + "\n");
console.log(`sprint-probe: ${path.join(OUT, `${SCENE}-sprint.md`)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(0);
