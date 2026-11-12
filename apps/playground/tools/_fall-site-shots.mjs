// Full-window review shots of one fall site in the mmo scene (edit mode, orbit camera, no editor chrome).
//   node tools/_fall-site-shots.mjs <baseUrl> <outDir> [river] [--scene mmo] [--recipe <world recipe.json>]   (run from apps/playground)
// Needs Playwright: the apps/playground devDependency (PLAYWRIGHT_MODULE / HITREG_PLAYWRIGHT override; tools/_playwright.mjs).
// Views: the 8 from tools/_site-views.mts (5 framing, pool eye level, 3/4 hero, close on the curtain),
// then a 2x4 contact sheet sheet.png. The editor panels/stats are hidden by CSS injection and the canvas is
// forced to the full 1280x800 window (main.ts onResize sizes the renderer from canvas.clientWidth/Height).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await (await import("./_playwright.mjs")).loadPlaywright();

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const pos = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const base = (pos[0] ?? "http://localhost:5199/").replace(/\/?$/, "/");
const outDir = path.resolve(pos[1] ?? "shots/latest");
const river = pos[2] ?? "river-15";
const scene = opt("scene", "mmo");
const recipeFile = opt("recipe", "projects/proving/assets/worlds/mmo.json");
const PLAYGROUND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1280, H = 800;
fs.mkdirSync(outDir, { recursive: true });

// ---- views: tools/_site-views.mts prints cameras [name, cx, cy, cz, tx, ty, tz], already lifted clear of the ground
const run = (cmd) => execSync(cmd, { cwd: PLAYGROUND, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" } });
const lastJson = (s) => JSON.parse(s.trim().split("\n").filter((l) => l.startsWith("[")).pop());
const views = lastJson(run(`npx tsx tools/_site-views.mts ${river} "${recipeFile}"`)).map(([name, cx, cy, cz, tx, ty, tz]) => ({ name, cam: [cx, cy, cz], target: [tx, ty, tz] }));
fs.writeFileSync(path.join(outDir, "views.json"), JSON.stringify(views, null, 1));
console.log(`${views.length} views`);

// ---- browser
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
// clean view settings before boot: no stats HUD, no gizmos, no grid (merged over the stored settings by createEditorSettings)
await ctx.addInitScript(() => {
  try {
    const k = "hitreg-editor-settings";
    const cur = JSON.parse(localStorage.getItem(k) || "{}");
    localStorage.setItem(k, JSON.stringify({ ...cur, showStats: false, showGizmos: false, grid: false, showPhysics: false, showLights: false, showSkeletons: false }));
  } catch {}
});
// Freeze the page at the code it booted with: other agents edit the tree mid-run and Vite's HMR client would
// full-reload the page (losing the camera and the injected style). A stub /@vite/client keeps CSS imports working.
await ctx.route(/\/@vite\/client(\?.*)?$/, (route) => route.fulfill({
  contentType: "application/javascript",
  body: `const styles = new Map();
export const createHotContext = () => ({ data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {} });
export const updateStyle = (id, css) => { let s = styles.get(id); if (!s) { s = document.createElement("style"); s.setAttribute("data-vite-dev-id", id); document.head.appendChild(s); styles.set(id, s); } s.textContent = css; };
export const removeStyle = (id) => { styles.get(id)?.remove(); styles.delete(id); };
export const injectQuery = (url) => url;
export class ErrorOverlay extends HTMLElement {}
`,
}));
const page = await ctx.newPage();
const logs = [];
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
page.on("console", (m) => { if (m.type() === "error") logs.push("console.error " + m.text().slice(0, 300)); });
// Other agents edit the tree while this runs, so Vite can full-reload the page at any moment: every view
// re-checks that the app is booted and the chrome-hiding style is present, and a shot taken across a reload is retaken.
let loads = 0;
page.on("load", () => loads++);
async function ensureReady() {
  const ok = await page.evaluate(() => !!window.__hitreg?.controls && !!document.getElementById("site-shots-clean")).catch(() => false);
  if (ok) return;
  await page.waitForFunction(() => !!window.__hitreg && !!window.__hitreg.chunkManager, null, { timeout: 180000 });
  await page.waitForTimeout(3000);
  // hide every editor panel / overlay and give the canvas the whole window
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.id = "site-shots-clean";
    st.textContent = `
      body > *:not(#app):not(script):not(style):not(link) { display: none !important; }
      #app { position: fixed !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; }`;
    document.head.append(st);
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(500);
  const size = await page.evaluate(() => { const c = document.getElementById("app"); return [c.clientWidth, c.clientHeight, c.width, c.height]; });
  console.log("(re)booted; canvas css / backing size", size.join(" x "));
}
await page.goto(base + "?scene=" + encodeURIComponent(scene), { waitUntil: "load" });
await ensureReady();

async function settle() {
  // chunks stream around the orbit target: wait until nothing is loading and the draw count holds
  let last = -1, still = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const [n, loading] = await page.evaluate(() => {
      const h = window.__hitreg;
      let d = 0, l = 0;
      try { d = h.info().render.drawCalls ?? 0; } catch {}
      try { l = h.chunkManager.stats.loading ?? 0; } catch {}
      return [d, l];
    });
    still = n === last && loading === 0 ? still + 1 : 0;
    last = n;
    if (i >= 5 && still >= 3) break;
  }
  await page.waitForTimeout(1200);
}

const files = [];
for (const v of views) {
 for (let attempt = 0; attempt < 6; attempt++) {
  try {
  await ensureReady();
  const before = loads;
  await page.evaluate(([c, t]) => {
    const h = window.__hitreg;
    h.controls.setLookAt(c[0], c[1], c[2], t[0], t[1], t[2], false);
    window.dispatchEvent(new Event("resize")); // keep the full-window aspect if the dock re-laid out the canvas
  }, [v.cam, v.target]);
  await settle().catch(() => {});
  if (loads !== before) { console.log(`page reloaded during ${v.name}, retaking`); continue; }
  const file = path.join(outDir, `${v.name}.png`);
  await page.screenshot({ path: file });
  if (loads !== before) { console.log(`page reloaded during ${v.name}, retaking`); continue; }
  files.push({ name: v.name, file });
  console.log("saved", file);
  break;
  } catch (e) { console.log(`${v.name} attempt ${attempt + 1} failed: ${String(e.message).split("\n")[0]}`); }
 }
}

// ---- 2x4 contact sheet, composed in a blank page canvas (each tile 640x400, labelled)
const tiles = files.map((f) => ({ name: f.name, url: "data:image/png;base64," + fs.readFileSync(f.file).toString("base64") }));
const sheetPage = await ctx.newPage();
await sheetPage.setViewportSize({ width: 1280, height: 1600 });
await sheetPage.goto("about:blank");
const dataUrl = await sheetPage.evaluate(async (tiles) => {
  const TW = 640, TH = 400, cols = 2, rows = 4;
  const cv = document.createElement("canvas");
  cv.width = TW * cols; cv.height = TH * rows;
  const g = cv.getContext("2d");
  g.fillStyle = "#0b0e14"; g.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < tiles.length && i < cols * rows; i++) {
    const img = new Image();
    img.src = tiles[i].url;
    await img.decode();
    const x = (i % cols) * TW, y = Math.floor(i / cols) * TH;
    g.drawImage(img, x, y, TW, TH);
    g.font = "600 18px ui-monospace, monospace";
    const w = g.measureText(tiles[i].name).width;
    g.fillStyle = "rgba(0,0,0,0.65)"; g.fillRect(x + 6, y + 6, w + 14, 26);
    g.fillStyle = "#ffffff"; g.fillText(tiles[i].name, x + 13, y + 25);
  }
  return cv.toDataURL("image/png");
}, tiles);
fs.writeFileSync(path.join(outDir, "sheet.png"), Buffer.from(dataUrl.split(",")[1], "base64"));
console.log("saved", path.join(outDir, "sheet.png"));
if (logs.length) console.log(logs.slice(0, 10).join("\n"));
await browser.close();
