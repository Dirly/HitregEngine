// Loading art for a dungeon (docs/hosting.md → "Loading art"): a snapshot of one of its rooms, repainted by the image
// generator as a painted fantasy-MMO loading screen of THAT room, installed at half display resolution and recorded on
// the scene as its `loadingScreen` component (one applyOps batch; the inverse goes in the report).
//
//   npx tsx tools/loading-art.mts --project gnawspur-deeps [--scene <id>] [--view <name> | --cam x,y,z --look x,y,z]
//        [--base http://localhost:5173/] [--size 1024x576] [--title "The Gnawspur Deeps"] [--characters "..."]
//        [--brief "..."] [--snapshot-only] [--record-only] [--dry-run] [--timeout 900]
//
// View: --view names an entry of authoring/views/views.json; --cam/--look give one; otherwise the views.json entry
// marked "loading": true, else the most readable picture of the views stage (reports/views/*.png: lit, contrasty,
// least near-black). The snapshot is the views stage's camera at the SHIPPED light (editor chrome hidden), lifted to a
// readable exposure, and kept for review at assets/loading/<scene>.snapshot.png (never shipped, never referenced).
// Needs Playwright (PLAYWRIGHT_MODULE = its index.mjs) and a running playground dev server on --base.
// Never runs codex itself: the painting goes through tools/image-request.mjs gen --paint.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyOps, ComponentRegistry, registerCoreComponents, sceneDocSchema, type Op, type SceneDoc } from "@hitreg/core";
// @ts-expect-error untyped helper module
import { decodePng, encodePng } from "./_png.mjs";

const pg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : d;
};
const flag = (k: string): boolean => argv.includes(`--${k}`);
const die = (m: string): never => {
  console.error(`loading-art: ${m}`);
  process.exit(2);
};

const projectId = opt("project") ?? die("--project <id> is required");
const projDir = path.join(pg, "projects", projectId);
if (!fs.existsSync(path.join(projDir, "project.json"))) die(`no project at ${projDir}`);
const project = JSON.parse(fs.readFileSync(path.join(projDir, "project.json"), "utf8")) as {
  title?: string;
  description?: string;
  scenes?: { id: string; label?: string }[];
};
const sceneId = opt("scene") ?? project.scenes?.[0]?.id ?? projectId;
const sceneFile = path.join(projDir, "assets", "scenes", `${sceneId}.scene.json`);
if (!fs.existsSync(sceneFile)) die(`no scene file ${sceneFile}`);
const title = opt("title") ?? project.scenes?.find((s) => s.id === sceneId)?.label ?? project.title ?? sceneId;
const [W, H] = (opt("size", "1024x576") ?? "").split("x").map(Number) as [number, number];
if (!(W > 0 && H > 0) || Math.abs(W / H - 16 / 9) > 0.01) die("--size must be 16:9, e.g. 1024x576 or 960x540");
const loadingDir = path.join(projDir, "assets", "loading");
const imageRel = `loading/${sceneId}.png`;
const target = path.join(projDir, "assets", imageRel);
const snapshot = path.join(loadingDir, `${sceneId}.snapshot.png`);
const reportFile = path.join(projDir, "reports", "loading-art.json");
const requestId = `loading-${sceneId}`;

// ---- the view -------------------------------------------------------------------------------------------------
type View = { name: string; cam: [number, number, number]; target: [number, number, number]; loading?: boolean };
const vec = (s: string): [number, number, number] => {
  const v = s.split(",").map(Number);
  if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) die(`bad vector "${s}" (want x,y,z)`);
  return v as [number, number, number];
};
const viewsFile = path.join(projDir, "authoring", "views", "views.json");
const views: View[] = fs.existsSync(viewsFile) ? JSON.parse(fs.readFileSync(viewsFile, "utf8")) : [];

/** How readable a review picture is: contrast, with near-black and blown-out pixels held against it. */
function readability(file: string): number {
  const img = decodePng(fs.readFileSync(file)) as { width: number; height: number; data: Uint8Array };
  let n = 0, sum = 0, sum2 = 0, dark = 0, blown = 0;
  for (let i = 0; i < img.data.length; i += 4 * 7) {
    const l = 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
    n++; sum += l; sum2 += l * l;
    if (l < 12) dark++;
    if (l > 245) blown++;
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return sd * (1 - dark / n) * (1 - blown / n) * Math.min(1, mean / 40);
}

function pickView(): { view: View; why: string } {
  const cam = opt("cam"), look = opt("look");
  if (cam || look) {
    if (!cam || !look) die("--cam and --look go together");
    return { view: { name: `cam:${cam}>look:${look}`, cam: vec(cam!), target: vec(look!) }, why: "given" };
  }
  const named = opt("view");
  if (named) {
    const v = views.find((x) => x.name === named) ?? die(`no view "${named}" in ${viewsFile}`);
    return { view: v, why: "--view" };
  }
  const marked = views.find((v) => v.loading);
  if (marked) return { view: marked, why: 'views.json "loading": true' };
  if (views.length === 0) die(`no views in ${viewsFile}: pass --view or --cam/--look`);
  const scored = views
    .map((v) => ({ v, file: path.join(projDir, "reports", "views", `${v.name}.png`) }))
    .filter((x) => fs.existsSync(x.file))
    .map((x) => ({ v: x.v, score: readability(x.file) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { view: views[0]!, why: "first view (no reports/views pictures to judge)" };
  return { view: scored[0]!.v, why: `most readable views-stage picture (score ${scored[0]!.score.toFixed(1)} of ${scored.length})` };
}
const { view, why } = pickView();
console.log(`view: ${view.name} (${why})`);

// ---- the snapshot ---------------------------------------------------------------------------------------------
/** Lift a dark capture to a readable exposure: a gamma that puts the median luma near `target` (never darkens). */
function liftExposure(img: { width: number; height: number; data: Uint8Array }, targetMedian = 0.3): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i += 4) hist[Math.round(0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!)]!++;
  const half = img.data.length / 8;
  let acc = 0, med = 0;
  for (; med < 255 && acc + hist[med]! < half; med++) acc += hist[med]!;
  const m = Math.max(1, med) / 255;
  const gamma = m >= targetMedian ? 1 : Math.max(0.45, Math.log(targetMedian) / Math.log(m));
  if (gamma < 1) {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(v / 255, gamma));
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = lut[img.data[i]!]!;
      img.data[i + 1] = lut[img.data[i + 1]!]!;
      img.data[i + 2] = lut[img.data[i + 2]!]!;
    }
  }
  return gamma;
}

async function capture(): Promise<{ gamma: number }> {
  const base = (opt("base", "http://localhost:5173/") ?? "").replace(/\/?$/, "/");
  const mod = process.env["PLAYWRIGHT_MODULE"] ?? die("set PLAYWRIGHT_MODULE to Playwright's index.mjs (docs: headless browser recipe)");
  const { chromium } = (await import(mod.startsWith("file:") ? mod : `file:///${mod.replace(/\\/g, "/")}`)) as typeof import("playwright");
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(() => {
      try {
        const k = "hitreg-editor-settings";
        const cur = JSON.parse(localStorage.getItem(k) || "{}");
        localStorage.setItem(k, JSON.stringify({ ...cur, showStats: false, showGizmos: false, grid: false, showPhysics: false, showLights: false, showSkeletons: false }));
      } catch {
        /* defaults */
      }
    });
    const page = await ctx.newPage();
    await page.goto(`${base}?scene=${encodeURIComponent(sceneId)}`, { waitUntil: "load" });
    await page.waitForFunction(() => !!(window as any).__hitreg?.chunkManager && (window as any).__hitreg.sceneName?.(), null, { timeout: 240000 });
    const booted = await page.evaluate(() => (window as any).__hitreg.sceneName());
    if (booted !== sceneId) throw new Error(`the page booted "${booted}", not "${sceneId}"`);
    await page.evaluate(() => {
      const st = document.createElement("style");
      st.textContent = `body > *:not(#app):not(script):not(style):not(link) { display: none !important; }
        #app { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; }`;
      document.head.append(st);
      window.dispatchEvent(new Event("resize"));
    });
    await page.evaluate(([c, t]) => {
      (window as any).__hitreg.controls.setLookAt(c[0], c[1], c[2], t[0], t[1], t[2], false);
      window.dispatchEvent(new Event("resize"));
    }, [view.cam, view.target] as const);
    // settle: draw calls steady and nothing streaming for three seconds running
    let last = -1, still = 0;
    for (let i = 0; i < 90 && !(i >= 5 && still >= 3); i++) {
      await page.waitForTimeout(1000);
      const [d, l] = await page.evaluate(() => {
        const h = (window as any).__hitreg;
        return [h.info().render.drawCalls ?? 0, h.chunkManager.stats.loading ?? 0];
      });
      still = d === last && l === 0 ? still + 1 : 0;
      last = d;
    }
    await page.waitForTimeout(1200);
    const png = await page.screenshot();
    const img = decodePng(png) as { width: number; height: number; data: Uint8Array };
    const gamma = liftExposure(img);
    fs.mkdirSync(loadingDir, { recursive: true });
    fs.writeFileSync(snapshot, encodePng(img.width, img.height, img.data));
    return { gamma };
  } finally {
    await browser.close();
  }
}

// ---- the prompt -----------------------------------------------------------------------------------------------
function prompt(): string {
  const room = view.name.replace(/^\d+-/, "").replace(/READ-SHOT-/i, "").replace(/-/g, " ");
  const setting = (project.description ?? "").replace(/\s*GREY BOX\.?\s*/gi, " ").trim().slice(0, 600);
  const characters = opt("characters");
  return [
    `Repaint the attached in-game screenshot of "${title}" (${room}) as a hand-painted fantasy MMO dungeon loading-screen illustration, in the tradition of classic World of Warcraft loading screens.`,
    `Keep the SAME camera, composition and set piece: every major shape — the architecture, the room's centrepiece, props and light sources — stays where it is in the screenshot. Refine and enrich what is there (worn stone, timber grain, ice, carved detail, wet sheen) instead of inventing a different room.`,
    setting ? `Setting, for mood only: ${setting}` : "",
    `Style: painterly, confident visible brushwork, dramatic chiaroscuro light that comes from the scene's own light sources, deep shadow pools, atmospheric haze, a rich but restrained palette. Dark and foreboding mood — but readable: the set piece is clearly lit and the eye goes straight to it.`,
    `The screenshot is a grey-box build: plain orange capsules with a thin red bar above them are stand-ins for creatures and their health bars; paint them out (fill with the room behind them).`,
    characters ? `Characters: ${characters}` : `Do not add any people, creatures, monsters or characters; the room is empty.`,
    `No text, no letters, no title, no logos, no UI, no border or frame, no watermark. Full-bleed 16:9 image.`,
    opt("brief") ?? "",
  ].filter(Boolean).join("\n\n");
}

// ---- record it on the scene (one applyOps batch) ------------------------------------------------------------
function record(): { entity: string; ops: Op[]; inverse: Op[] } {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  const text = fs.readFileSync(sceneFile, "utf8");
  // validated, but written back from the file's own JSON: the batch changes one component and nothing else
  const raw = JSON.parse(text) as SceneDoc;
  sceneDocSchema.parse(raw);
  const doc = raw;
  // the scene's settings entity (sky / postfx), else a root entity of its own
  const settings = Object.entries(doc.entities).find(([, e]) => "sky" in e.components || "postfx" in e.components)?.[0];
  const data = { image: imageRel, title, view: view.name, request: requestId };
  const ops: Op[] = settings
    ? [{ op: "set-component", id: settings, component: "loadingScreen", data }]
    : [{ op: "add-entity", id: "loading-screen", entity: { name: "Loading screen", parent: null, tags: [], components: { loadingScreen: data } } }];
  const result = applyOps(doc, ops, registry);
  fs.writeFileSync(sceneFile, JSON.stringify(result.doc, null, 2) + (text.endsWith("\n") ? "\n" : ""));
  return { entity: settings ?? "loading-screen", ops, inverse: result.inverse };
}

// ---- run --------------------------------------------------------------------------------------------------------
const started = Date.now();
const report: Record<string, unknown> = { project: projectId, scene: sceneId, title, view, viewChoice: why, size: `${W}x${H}`, image: imageRel, snapshot: path.relative(projDir, snapshot).split(path.sep).join("/"), request: requestId };
if (flag("dry-run")) {
  console.log(prompt());
  process.exit(0);
}
if (!flag("record-only")) {
  const { gamma } = await capture();
  report["exposureGamma"] = Number(gamma.toFixed(3));
  console.log(`snapshot: ${snapshot} (exposure gamma ${gamma.toFixed(2)})`);
  if (flag("snapshot-only")) process.exit(0);
  const promptFile = path.join(pg, ".hitreg", "image-staging", `${requestId}.prompt.txt`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt());
  const gen = spawnSync(
    process.execPath,
    ["tools/image-request.mjs", "gen", "--id", requestId, "--target", path.relative(pg, target), "--size", `${W}x${H}`, "--paint",
      "--ref", path.relative(pg, snapshot), "--purpose", `loading art: ${sceneId}`, "--prompt-file", promptFile, "--timeout", opt("timeout", "900")!, "--force"],
    { cwd: pg, encoding: "utf8", maxBuffer: 1 << 24 },
  );
  fs.rmSync(promptFile, { force: true });
  process.stdout.write(gen.stdout ?? "");
  process.stderr.write(gen.stderr ?? "");
  try {
    report["generation"] = JSON.parse(gen.stdout.slice(gen.stdout.indexOf("{")));
  } catch {
    report["generation"] = { exit: gen.status };
  }
  if (gen.status !== 0) {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify({ ...report, passed: false, failures: [{ what: `image-request gen exited ${gen.status}` }] }, null, 2));
    die(`image generation failed (exit ${gen.status}); see ${reportFile}`);
  }
}
if (!fs.existsSync(target)) die(`no image at ${target}`);
const rec = record();
const seconds = Math.round((Date.now() - started) / 1000);
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify({ ...report, entity: rec.entity, ops: rec.ops, inverse: rec.inverse, seconds, at: new Date().toISOString(), passed: true }, null, 2));
console.log(`loading art: ${target}\nrecorded on ${sceneId} → ${rec.entity}.loadingScreen (inverse in ${reportFile}); ${seconds}s`);
