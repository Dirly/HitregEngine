/**
 * portal-play --dungeon <instance scene> [--world <scene>]                 (the dungeon pipeline's last stage)
 * portal-play --scene <world scene> --portal <portal id> --exit <exit portal id>
 *   [--url http://localhost:<p>] [--port <p>] [--out <dir>] [--no-inside] [--headed]
 *
 * The REAL-CLIENT portal round trip: the dev app in a browser (Playwright + system Chrome), local play, the player
 * walked with the keyboard (W held, the camera turned toward the goal every 150 ms). Two runs, each a fresh page:
 *   1. trip: fast-travel to the portal's return anchor in the world scene, WALK into the portal's box, arrive in the
 *      instance (curtain down, terrain held, play resumed), stay 3 s, WALK out through the exit portal, land within
 *      4 m of the return anchor and stay in the world scene.
 *   2. inside (skip with --no-inside): open the instance scene ITSELF (what a page reload inside a dungeon does —
 *      no recorded way back, the dev save of that scene), play, WALK out through the exit portal, land in the exit's
 *      fallback scene within 4 m of its anchor. A player must be able to leave a dungeon however they got into it.
 * Screenshot of each arrival. Exit 1 on any failure, with what it saw (box distance, refusals, a stopped body).
 *
 * --dungeon finds the pair itself: the world portal whose destination is the instance (in --world, default the first
 * scene that has one, "proving" first) and the instance's return portal on the same `portal:<x>` tag as the entry
 * anchor. Reports: projects/<instance project>/reports/portal-play.json (the dungeon pipeline's `portal play` stage)
 * and projects/<world project>/reports/portal-play/<world>.json, per portal with the digests of both doors as they
 * were tested (`zonegen status` row `portal play`; an edit to either door makes it STALE).
 *
 * tools/portal-trip.mts (headless PortalHarness) proves the authority's rules; this proves what a player gets: local
 * play's scene swap, the arrival placement, the curtain, the collision on the way to the box. Both are gates.
 *
 * Without --url it starts its own vite (agent-test config, --port, default 5263) and stops it by PID afterwards.
 * Needs `playwright` resolvable (`npm i playwright` with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 anywhere up the tree, or
 * HITREG_PLAYWRIGHT=<path to the playwright package dir>).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { SceneDoc } from "@hitreg/core";
import { portalDigest, walkThroughPortals } from "./_portal-veil-ops.mts";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1]! : ""; };
type V3 = [number, number, number];
type Params = Record<string, unknown>;

// -- scene files -----------------------------------------------------------------------------------
function sceneFile(id: string): { file: string; project: string } | null {
  for (const p of fs.readdirSync(path.join(PG, "projects"))) {
    const file = path.join(PG, "projects", p, "assets", "scenes", `${id}.scene.json`);
    if (fs.existsSync(file)) return { file, project: p };
  }
  return null;
}
const loadScene = (id: string): SceneDoc => {
  const f = sceneFile(id);
  if (!f) { console.error(`STOP: no scene file ${id}.scene.json in any project`); process.exit(2); }
  return JSON.parse(fs.readFileSync(f.file, "utf8")) as SceneDoc;
};
const paramsOf = (d: SceneDoc, id: string): Params | null => {
  const s = d.entities[id]?.components["script"] as { name?: string; params?: Params } | undefined;
  return s?.name === "portal" ? (s.params ?? {}) : null;
};

let SCENE = arg("--scene"), PORTAL = arg("--portal"), EXIT = arg("--exit");
const DUNGEON = arg("--dungeon");
if (DUNGEON) {
  const prefer = arg("--world");
  const worlds = prefer ? [prefer] : ["proving", ...fs.readdirSync(path.join(PG, "projects")).flatMap((p) => {
    const dir = path.join(PG, "projects", p, "assets", "scenes");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".scene.json")).map((f) => f.slice(0, -".scene.json".length)) : [];
  }).filter((s) => s !== DUNGEON && s !== "proving")];
  for (const w of worlds) {
    const f = sceneFile(w);
    if (!f || fs.statSync(f.file).size < 1000) continue;
    const text = fs.readFileSync(f.file, "utf8");
    if (!text.includes(`"${DUNGEON}"`)) continue;
    const hit = walkThroughPortals(JSON.parse(text) as SceneDoc).find(([, p]) => p["scene"] === DUNGEON && !p["back"]);
    if (hit) { SCENE = w; PORTAL = hit[0]; break; }
  }
  if (!PORTAL) { console.error(`STOP: no walk-through portal into ${DUNGEON} in ${prefer || "any world scene"}`); process.exit(2); }
  const dd = loadScene(DUNGEON);
  const entry = String(paramsOf(loadScene(SCENE), PORTAL)!["anchor"] ?? "");
  const tag = (dd.entities[entry]?.tags ?? []).find((t) => t.startsWith("portal:"));
  const backs = walkThroughPortals(dd).filter(([, p]) => p["back"] === true).map(([id]) => id);
  EXIT = backs.find((id) => tag && dd.entities[id]!.tags.includes(tag)) ?? (backs.length === 1 ? backs[0]! : "");
  if (!EXIT) { console.error(`STOP: no return portal in ${DUNGEON} paired with ${entry} (${tag ?? "no portal:<x> tag"}); found ${backs.join(", ") || "none"} — tools/portal-return.mts`); process.exit(1); }
}
if (!SCENE || !PORTAL || !EXIT) { console.error("usage: portal-play --dungeon <instance scene> [--world <scene>] | --scene <world scene> --portal <portal id> --exit <exit portal id>  [--url <dev app>] [--out <dir>] [--no-inside]"); process.exit(2); }
const worldDoc = loadScene(SCENE);
const sp = paramsOf(worldDoc, PORTAL);
if (!sp) { console.error(`STOP: ${PORTAL} in ${SCENE} is not a portal`); process.exit(2); }
const DEST = String(sp["scene"]);
const destInfo = sceneFile(DEST);
const destDoc = loadScene(DEST);
const OUT = path.resolve(arg("--out") || path.join(PG, "projects", destInfo!.project, "reports", "portal-play"));
fs.mkdirSync(OUT, { recursive: true });

// -- browser ---------------------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPlaywright(): Promise<any> {
  const env = process.env["HITREG_PLAYWRIGHT"];
  if (env) return createRequire(path.join(env, "package.json"))(env);
  try { return await import("playwright"); } catch { /* fall through */ }
  for (const dir of [process.cwd(), PG, path.join(PG, "..", "..")]) {
    try { return createRequire(path.join(dir, "noop.js"))("playwright"); } catch { /* next */ }
  }
  console.error("STOP: playwright is not resolvable — `npm i playwright` (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1) or set HITREG_PLAYWRIGHT");
  process.exit(2);
}

let vite: ReturnType<typeof spawn> | null = null;
let base = arg("--url").replace(/\/$/, "");
const stopVite = () => { if (vite?.pid) { try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(vite.pid), "/t", "/f"]) : process.kill(vite.pid); } catch { /* gone */ } } };
if (!base) {
  const port = arg("--port") || "5263";
  vite = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--config", "vite.agent-test.config.ts", "--port", port, "--strictPort"], { cwd: PG, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  base = `http://localhost:${port}`;
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite did not start in 60 s")), 60000);
    const on = (b: Buffer) => { if (/ready in|Local:/.test(b.toString())) { clearTimeout(t); res(); } };
    vite!.stdout!.on("data", on); vite!.stderr!.on("data", on);
    vite!.on("exit", (c) => rej(new Error(`vite exited ${c} (port ${port} taken? pass --port)`)));
  }).catch((e) => { console.error("STOP:", (e as Error).message); stopVite(); process.exit(2); });
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "chrome", headless: !process.argv.includes("--headed"), args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let page: any;
const logs: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await sleep(250); } return false; };
class Fail extends Error {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const H = <T,>(fn: (h: any, ...a: any[]) => T, ...a: unknown[]) => page.evaluate(([src, args]: [string, unknown[]]) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = (window as any).__hitreg; return new Function("h", "args", `return (${src})(h, ...args)`)(h, args);
}, [fn.toString(), a]) as Promise<T>;

/** world position of an entity in the scene that is up now */
const where = (id: string) => H((h, id: string) => {
  const o = h.object(id); if (!o) return null;
  o.updateWorldMatrix(true, false);
  const p = o.position.clone(); o.getWorldPosition(p);
  return [p.x, p.y, p.z];
}, id) as Promise<V3 | null>;
const me = () => H((h) => { const id = h.playerId(); const o = id && h.object(id); if (!o) return null; const p = o.position.clone(); o.getWorldPosition(p); return [p.x, p.y, p.z]; }) as Promise<V3 | null>;
type St = { scene: string; mode: string; curtain: boolean; travelling: boolean; sim: boolean; pid: string | null };
const state = () => H((h) => ({ scene: h.sceneName(), mode: h.playMode.get(), curtain: h.portalCurtain(), travelling: h.travelling(), sim: !!h.sim, pid: h.playerId() })) as Promise<St>;
const settled = async (scene: string, ms = 90000) => waitUntil(async () => { const s = await state(); return s.scene === scene && s.mode === "playing" && !s.curtain && !s.travelling && s.sim && !!s.pid; }, ms);

/** listen on the live event bus (one per play session) for trips and refusals */
const hookEvents = () => H((h) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any; w.__pp ??= { trips: [], refusals: [], bus: null };
  const bus = h.eventBus; if (!bus || w.__pp.bus === bus) return;
  w.__pp.bus = bus;
  bus.on("portal.travel", (p: unknown) => w.__pp.trips.push(p));
  bus.on("character.refused", (p: { request?: string; error?: string }) => { if (p?.request === "portal") w.__pp.refusals.push(p.error); });
});
const seen = () => H(() => { /* eslint-disable-next-line @typescript-eslint/no-explicit-any */ const w = window as any; return { trips: (w.__pp?.trips ?? []).length, refusals: [...(w.__pp?.refusals ?? [])] }; }) as Promise<{ trips: number; refusals: string[] }>;

const fmt = (v: V3 | null | undefined) => (v ? v.map((n) => n.toFixed(1)).join(", ") : "-");
const flat = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const through = (from: V3, door: V3, beyond = 5): V3 => { const dx = door[0] - from[0], dz = door[2] - from[2], d = Math.hypot(dx, dz) || 1; return [door[0] + (dx / d) * beyond, door[1], door[2] + (dz / d) * beyond]; };
const stuckNote = (trace: V3[]) => { const tail = trace.slice(-12); if (tail.length < 12) return ""; const moved = flat(tail[0]!, tail[tail.length - 1]!); return moved < 0.5 ? ` — the body STOPPED (moved ${moved.toFixed(2)} m in the last ${(tail.length * 0.15).toFixed(1)} s: blocked)` : ""; };

/** Walk with W toward `goal`, re-aiming the camera behind the body, until the scene starts to change or `ms`. */
async function walkInto(goal: V3, from: string, door: string, doorAt: V3, ms: number): Promise<void> {
  await hookEvents();
  const trace: V3[] = [];
  const start = await seen();
  await page.keyboard.down("KeyW");
  const t = Date.now();
  try {
    while (Date.now() - t < ms) {
      await hookEvents();
      const s = await state();
      if (s.scene !== from || s.curtain) return;
      const p = await me();
      if (p) {
        trace.push(p);
        await H((h, y: number) => h.cameraRig.setOrbit(y + Math.PI, null), Math.atan2(goal[0] - p[0], goal[2] - p[2]));
      }
      await sleep(150);
    }
  } finally { await page.keyboard.up("KeyW"); }
  const s = await seen();
  const last = trace.at(-1) ?? null;
  throw new Fail(`walking into ${door} in ${from} for ${ms / 1000} s never started a trip (trips ${s.trips - start.trips}, refusals ${JSON.stringify(s.refusals.slice(start.refusals.length))}); body last at ${fmt(last)}, the door at ${fmt(doorAt)}, ${last ? flat(last, doorAt).toFixed(1) : "?"} m from it${stuckNote(trace)}`);
}

/** A fresh page on `scene`, in play, settled. */
async function openInPlay(scene: string): Promise<void> {
  if (page) await page.close().catch(() => {});
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // tsx keeps function names with an injected __name() helper: the functions evaluated in the page need it too
  await page.addInitScript(() => { (window as unknown as { __name: (f: unknown) => unknown }).__name = (f: unknown) => f; });
  page.on("console", (m: { text(): string }) => { const t = m.text(); if (/portal|refus|could not open/i.test(t)) logs.push(t); });
  page.on("pageerror", (e: Error) => logs.push("pageerror: " + e.message));
  await page.goto(`${base}/?scene=${encodeURIComponent(scene)}`, { waitUntil: "load" });
  if (!(await waitUntil(async () => page.evaluate(() => !!(window as unknown as { __hitreg?: { playerId?: unknown } }).__hitreg?.playerId), 180000))) throw new Fail("the dev app never came up (or it has no __hitreg.playerId: a dev build is needed)");
  await waitUntil(async () => (await state()).scene === scene, 120000);
  await sleep(1500);
  await page.locator("canvas").first().focus().catch(() => {});
  await page.keyboard.press("Backquote");
  if (!(await settled(scene, 180000))) throw new Fail(`play never started in ${scene}: ${JSON.stringify(await state())}`);
  await H(() => document.exitPointerLock?.());
  await sleep(1500);
}

/** Through `door` (a portal in the scene that is up) into `to`; returns where the body landed. */
async function goThrough(from: string, door: string, startAt: V3, to: string, shot: string): Promise<V3> {
  const doorAt = await where(door);
  if (!doorAt) throw new Fail(`no entity ${door} in ${from}`);
  await walkInto(through(startAt, doorAt), from, door, doorAt, 30000);
  if (!(await settled(to, 180000))) {
    const s = await state();
    throw new Fail(s.scene === from ? `the trip through ${door} started but never left ${from} (${JSON.stringify(s)})` : `the trip through ${door} went to ${s.scene}, not ${to} (${JSON.stringify(s)})`);
  }
  await sleep(1500);
  const at = (await me())!;
  await page.screenshot({ path: path.join(OUT, shot) });
  await sleep(3000);
  const s = await state();
  if (s.scene !== to) throw new Fail(`bounced out of ${to} into ${s.scene} within 3 s of arriving`);
  return at;
}

// -- the runs --------------------------------------------------------------------------------------
const t0 = Date.now();
const phases: { name: string; ok: boolean; note: string }[] = [];
const shots: string[] = [];
async function phase(name: string, run: () => Promise<string>): Promise<void> {
  try { const note = await run(); phases.push({ name, ok: true, note }); console.log(`  ${name}: ok — ${note}`); }
  catch (e) {
    const note = e instanceof Fail ? e.message : `error: ${(e as Error).stack ?? e}`;
    phases.push({ name, ok: false, note }); console.log(`  ${name}: FAILED — ${note}`);
    if (logs.length) console.log("    page log:\n      " + logs.slice(-10).join("\n      "));
  }
  logs.length = 0;
}

console.log(`portal-play: ${SCENE}/${PORTAL} -> ${DEST}, out by ${EXIT}`);
const exitParams = paramsOf(destDoc, EXIT);
await phase("trip", async () => {
  if (!exitParams) throw new Fail(`${EXIT} in ${DEST} is not a portal: a player cannot leave`);
  await openInPlay(SCENE);
  const porch = (sp["returnAnchor"] ? await where(String(sp["returnAnchor"])) : null);
  const door = await where(PORTAL);
  if (!door) throw new Fail(`no entity ${PORTAL} in ${SCENE}`);
  const from = porch ?? door; // no return anchor: walk in from wherever travel put us (the door itself is the goal)
  if (await H((h, p: V3) => h.travelTo(p[0], p[1] + 1.5, p[2]), from) !== "ok") throw new Fail("dev fast travel refused");
  if (!(await settled(SCENE, 90000))) throw new Fail("fast travel to the porch never settled");
  await sleep(2500);
  const start = (await me())!;
  const inAt = await goThrough(SCENE, PORTAL, start, DEST, `${DEST}-arrival.png`);
  shots.push(`${DEST}-arrival.png`);
  const entry = String(sp["anchor"] ?? "");
  const entryAt = entry ? await where(entry) : null;
  if (entryAt && flat(inAt, entryAt) > 4) throw new Fail(`arrived ${flat(inAt, entryAt).toFixed(1)} m from the entry anchor ${entry}`);
  const backAt = await goThrough(DEST, EXIT, inAt, SCENE, `${SCENE}-from-${DEST}.png`);
  shots.push(`${SCENE}-from-${DEST}.png`);
  const target = porch ?? start;
  if (flat(backAt, target) > 4) throw new Fail(`came back at ${fmt(backAt)}, ${flat(backAt, target).toFixed(1)} m from the return anchor ${fmt(target)}`);
  return `in at ${fmt(inAt)} (${entry}), back at ${fmt(backAt)}, ${flat(backAt, target).toFixed(1)} m from the return anchor`;
});
if (!process.argv.includes("--no-inside")) {
  await phase("inside", async () => {
    if (!exitParams) throw new Fail(`${EXIT} in ${DEST} is not a portal`);
    const fallback = String(exitParams["scene"] ?? "");
    if (!fallback) throw new Fail(`${EXIT} has no fallback scene: a player who did not come in by the door (a reload, a GM move) cannot leave`);
    await openInPlay(DEST);
    const start = (await me())!;
    const outAt = await goThrough(DEST, EXIT, start, fallback, `${fallback}-from-${DEST}-reloaded.png`);
    shots.push(`${fallback}-from-${DEST}-reloaded.png`);
    const anchor = String(exitParams["anchor"] ?? "");
    const anchorAt = anchor ? await where(anchor) : null;
    if (anchorAt && flat(outAt, anchorAt) > 4) throw new Fail(`landed ${flat(outAt, anchorAt).toFixed(1)} m from the exit's anchor ${anchor}`);
    return `from ${fmt(start)} out to ${fallback} at ${fmt(outAt)}${anchorAt ? `, ${flat(outAt, anchorAt).toFixed(1)} m from ${anchor}` : ""}`;
  });
}
await browser.close().catch(() => {});
stopVite();

// -- reports ---------------------------------------------------------------------------------------
const passed = phases.every((p) => p.ok);
const entryRec = { id: PORTAL, exit: EXIT, scene: DEST, status: passed ? "PASS" : "FAIL", digest: portalDigest(worldDoc, PORTAL), exitDigest: portalDigest(destDoc, EXIT), phases, at: new Date().toISOString() };
const destReport = path.join(PG, "projects", destInfo!.project, "reports", "portal-play.json");
fs.mkdirSync(path.dirname(destReport), { recursive: true });
fs.writeFileSync(destReport, JSON.stringify({ passed, world: SCENE, portal: PORTAL, exit: EXIT, digest: entryRec.digest, exitDigest: entryRec.exitDigest, phases, shots: shots.map((s) => path.join(OUT, s)), failures: phases.filter((p) => !p.ok).map((p) => ({ what: `${p.name}: ${p.note}` })), at: entryRec.at }, null, 1) + "\n");
const worldReport = path.join(PG, "projects", sceneFile(SCENE)!.project, "reports", "portal-play", `${SCENE}.json`);
fs.mkdirSync(path.dirname(worldReport), { recursive: true });
const prev = fs.existsSync(worldReport) ? (JSON.parse(fs.readFileSync(worldReport, "utf8")) as { portals?: (typeof entryRec)[] }).portals ?? [] : [];
fs.writeFileSync(worldReport, JSON.stringify({ scene: SCENE, portals: [...prev.filter((p) => p.id !== PORTAL), entryRec] }, null, 1) + "\n");
console.log(passed ? `PORTAL PLAY OK: ${PORTAL} <-> ${EXIT} (${((Date.now() - t0) / 1000).toFixed(0)} s; shots in ${OUT})` : `PORTAL PLAY FAILED: ${phases.filter((p) => !p.ok).map((p) => p.name).join(", ")}`);
process.exit(passed ? 0 : 1);
