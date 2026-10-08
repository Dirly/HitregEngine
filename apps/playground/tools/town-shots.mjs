// Review pictures of a town (or any place) in a project scene: explicit cameras in, full-window shots + a labelled
// contact sheet out. The town pipeline takes one after every stage so the work can be looked at, not just linted.
//   node tools/town-shots.mjs --base http://localhost:5288/ --scene mmo --views <views.json> --out <dir>
// views.json: [{ "name": "gate-approach", "cam": [x, y, z], "target": [x, y, z] }, ...]  (north is -Z)
// Needs Playwright (PLAYWRIGHT_MODULE = its index.mjs) and a dev server of the playground on --base.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const base = opt("base", "http://localhost:5288/").replace(/\/?$/, "/");
const scene = opt("scene", "mmo");
const views = JSON.parse(fs.readFileSync(opt("views", ""), "utf8"));
const outDir = path.resolve(opt("out", "shots/town"));
const W = 1280, H = 800;
fs.mkdirSync(outDir, { recursive: true });
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ??
    "file:///C:/Users/Derek/AppData/Local/Temp/claude/D--Users-Derek-Desktop-HitRegStudios-Engine/29863f0b-4711-4d4d-aeda-fe4ad134b25a/scratchpad/node_modules/playwright/index.mjs"
);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
await ctx.addInitScript(() => {
  try {
    const k = "hitreg-editor-settings";
    const cur = JSON.parse(localStorage.getItem(k) || "{}");
    localStorage.setItem(k, JSON.stringify({ ...cur, showStats: false, showGizmos: false, grid: false, showPhysics: false, showLights: false, showSkeletons: false }));
  } catch {}
});
// freeze the page at the code it booted with (other sessions edit the tree; HMR would reload mid-run)
await ctx.route(/\/@vite\/client(\?.*)?$/, (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `const styles = new Map();
export const createHotContext = () => ({ data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {} });
export const updateStyle = (id, css) => { let s = styles.get(id); if (!s) { s = document.createElement("style"); s.setAttribute("data-vite-dev-id", id); document.head.appendChild(s); styles.set(id, s); } s.textContent = css; };
export const removeStyle = (id) => { styles.get(id)?.remove(); styles.delete(id); };
export const injectQuery = (url) => url;
export class ErrorOverlay extends HTMLElement {}
`,
  }),
);
const page = await ctx.newPage();
const logs = [];
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
await page.goto(`${base}?scene=${encodeURIComponent(scene)}`, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__hitreg && !!window.__hitreg.chunkManager, null, { timeout: 240000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const st = document.createElement("style");
  st.textContent = `
    body > *:not(#app):not(script):not(style):not(link) { display: none !important; }
    #app { position: fixed !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; }`;
  document.head.append(st);
  window.dispatchEvent(new Event("resize"));
});

async function settle() {
  let last = -1, still = 0;
  for (let i = 0; i < 90; i++) {
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
  await page.evaluate(([c, t]) => {
    window.__hitreg.controls.setLookAt(c[0], c[1], c[2], t[0], t[1], t[2], false);
    window.dispatchEvent(new Event("resize"));
  }, [v.cam, v.target]);
  await settle().catch(() => {});
  const file = path.join(outDir, `${v.name}.png`);
  await page.screenshot({ path: file });
  files.push({ name: v.name, file });
  console.log("saved", file);
}

// contact sheet, 2 columns, 640x400 tiles, labelled
const tiles = files.map((f) => ({ name: f.name, url: "data:image/png;base64," + fs.readFileSync(f.file).toString("base64") }));
const sheet = await ctx.newPage();
await sheet.goto("about:blank");
const dataUrl = await sheet.evaluate(async (tiles) => {
  const TW = 640, TH = 400, cols = 2, rows = Math.ceil(tiles.length / cols);
  const cv = document.createElement("canvas");
  cv.width = TW * cols; cv.height = TH * rows;
  const g = cv.getContext("2d");
  g.fillStyle = "#0b0e14"; g.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < tiles.length; i++) {
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
