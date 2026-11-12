/**
 * portal-play --dungeon <instance scene> [--world <scene>]                 (the dungeon pipeline's last stage)
 * portal-play --scene <world scene> --portal <portal id> --exit <exit portal id>
 *   [--url http://localhost:<p>] [--port <p>] [--out <dir>] [--no-inside] [--headed] [--exit-from x,y,z] [--walk-s <s>] [--keep-mobs]
 * --walk-s: seconds a walk-in may take before it fails (default 30). w-temple9 2026-11-03: live redstrand ran at 0-3 fps
 *   in the client, so a 10 m walk from a causeway return anchor took longer than 30 s while the headless trip passed.
 *
 * --exit-from: an exit far from the arrival (a dungeon whose way out is at the end of its route) is walked into from this
 * point in the instance (dev fast travel there first, in the passage on the exit's approach side), as portal-trip does:
 * the body walks a straight line and cannot path a dungeon.
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
 * scene that has one, "proving" first, scratch/lab projects never) and the instance's return portal on the same `portal:<x>` tag as the entry
 * anchor. Reports: projects/<instance project>/reports/portal-play.json (the dungeon pipeline's `portal play` stage)
 * and projects/<world project>/reports/portal-play/<world>.json, per portal with the digests of both doors as they
 * were tested (`zonegen status` row `portal play`; an edit to either door makes it STALE).
 *
 * tools/portal-trip.mts (headless PortalHarness) proves the authority's rules; this proves what a player gets: local
 * play's scene swap, the arrival placement, the curtain, the collision on the way to the box. Both are gates.
 *
 * Without --url it starts its own vite (agent-test config, --port, default 5263) and stops it by PID afterwards.
 * Needs playwright: the apps/playground devDependency (`pnpm install`; tools/_playwright.mjs), or an override
 * HITREG_PLAYWRIGHT=<path to the playwright package dir> / PLAYWRIGHT_MODULE=<its index.mjs>.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { killTree } from "./_kill-tree.mts";
import { fileURLToPath } from "node:url";
import type { SceneDoc } from "@hitreg/core";
import { portalDigest, returnSceneFault, walkThroughPortals } from "./_portal-veil-ops.mts";
// @ts-expect-error plain JS module
import { loadPlaywright as loadPlaywrightModule } from "./_playwright.mjs";
import { dropAuthoringWrites } from "./_readonly-posts.mjs";
import { isScratchProject, readProjectManifest } from "./_asset-resolve.mts";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1]! : ""; };
const WALK_MS = Math.max(10, Number(arg("--walk-s")) || 30) * 1000;
type V3 = [number, number, number];
type Params = Record<string, unknown>;

// -- scene files -----------------------------------------------------------------------------------
type Ent = { parent: string | null; tags?: string[]; components: Record<string, unknown> };
/** A scene file's text with its creatures taken out: spawn areas, combatants (their parent when they have one) and mobs/
 *  prefab instances, with everything under them (light-shots mobRemovalOps). Served to the page only; nothing is written. */
function withoutMobs(text: string): string {
  const raw = JSON.parse(text) as { entities: Record<string, Ent> }, E = raw.entities, pick = new Set<string>();
  for (const [id, e] of Object.entries(E)) {
    if (e.components["spawnArea"]) pick.add(id);
    if ((e.tags ?? []).includes("combatant")) pick.add(e.parent && E[e.parent] ? e.parent : id);
    if ((e.components["prefab"] as { prefabId?: string } | undefined)?.prefabId?.startsWith("mobs/")) pick.add(id);
  }
  for (const id of Object.keys(E)) for (let p: string | null = id; p; p = E[p]?.parent ?? null) if (pick.has(p)) { delete E[id]; break; }
  return JSON.stringify(raw);
}
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
  // The default search skips scratch projects (place-build labs, concept copies; i-door 2026-11-03): a lab carries a copy
  // of the world's door from before its fit and sorts ahead of the world (pb-weeping-stair < redstrand), so the
  // undercistern pipeline's `portal play` walked the STALE lab door, stopped 1.8 m short and failed a door that passes live.
  const projectsRoot = path.join(PG, "projects");
  const worlds = prefer ? [prefer] : ["proving", ...fs.readdirSync(projectsRoot).filter((p) => !isScratchProject(p, readProjectManifest(projectsRoot, p))).flatMap((p) => {
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
  if (!PORTAL) {
    // the world's door is not built yet (its world place is unbuilt): nothing to walk in by. Record the stage as WAITING
    // for the door (the dungeon pipeline shows WAITING, not FAILED); the dungeon's own return portal is proven by the
    // `portals` stage (portal-cover) until the door exists, then this runs for real.
    const own = sceneFile(DUNGEON);
    if (own) {
      const rep = path.join(PG, "projects", own.project, "reports", "portal-play.json");
      fs.mkdirSync(path.dirname(rep), { recursive: true });
      fs.writeFileSync(rep, JSON.stringify({ passed: false, waiting: "world door", note: `no walk-through portal into ${DUNGEON} in ${prefer || "any world scene"}: the world's door is not built; re-run once it is`, at: new Date().toISOString() }, null, 1) + "\n");
    }
    console.error(`WAITING: no walk-through portal into ${DUNGEON} in ${prefer || "any world scene"} (the world door is not built) — recorded as waiting for the door`);
    process.exit(2);
  }
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
  // the apps/playground devDependency (tools/_playwright.mjs); HITREG_PLAYWRIGHT / PLAYWRIGHT_MODULE still override
  try { return await loadPlaywrightModule(); } catch (e) { console.error(`STOP: ${(e as Error).message}`); process.exit(2); }
}

let vite: ReturnType<typeof spawn> | null = null;
const viteTail: string[] = [];
let viteDied = "", viteStopping = false;
let base = arg("--url").replace(/\/$/, "");
const stopVite = () => { viteStopping = true; killTree(vite?.pid); }; // synchronous: an async taskkill raced process.exit and leaked vite
if (!base) {
  const port = arg("--port") || "5263";
  vite = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--config", "vite.agent-test.config.ts", "--port", port, "--strictPort"], { cwd: PG, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  base = `http://localhost:${port}`;
  // keep vite's last lines: a dev server that dies mid-run otherwise shows only as the page's ERR_CONNECTION_REFUSED
  vite.stdout!.on("data", (b: Buffer) => viteTail.push(...b.toString().split(/\r?\n/).filter(Boolean)) && viteTail.splice(0, Math.max(0, viteTail.length - 40)));
  vite.stderr!.on("data", (b: Buffer) => viteTail.push(...b.toString().split(/\r?\n/).filter(Boolean)) && viteTail.splice(0, Math.max(0, viteTail.length - 40)));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite did not start in 60 s")), 60000);
    const on = (b: Buffer) => { if (/ready in|Local:/.test(b.toString())) { clearTimeout(t); res(); } };
    vite!.stdout!.on("data", on); vite!.stderr!.on("data", on);
    vite!.on("exit", (c, sig) => {
      if (!viteStopping) viteDied = `vite (pid ${vite!.pid}, port ${port}) exited mid-run: code ${c}${sig ? ` signal ${sig}` : ""}`;
      rej(new Error(`vite exited ${c} (port ${port} taken? pass --port)`));
    });
  }).catch((e) => { console.error("STOP:", (e as Error).message); if (viteTail.length) console.error("  vite said:\n    " + viteTail.join("\n    ")); stopVite(); process.exit(2); });
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "chrome", headless: !process.argv.includes("--headed"), args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let page: any;
const logs: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// a dead dev server fails the phase at once (it would otherwise sit out every 300 s settle budget on a refused page)
const waitUntil = async (cond: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (viteDied) throw new Fail(viteDied); if (await cond()) return true; await sleep(250); } return false; };
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
type St = { scene: string; mode: string; curtain: boolean; travelling: boolean; loading: boolean; sim: boolean; pid: string | null };
const state = () => H((h) => ({ scene: h.sceneName(), mode: h.playMode.get(), curtain: h.portalCurtain(), travelling: h.travelling(), loading: !!h.loading?.(), sim: !!h.sim, pid: h.playerId() })) as Promise<St>;
/** `anyHold`: also accept a body still held for ground. The trip run fast-travels at once, and a world's dev spawn
 *  (the scene's `player` entity) may stand where no ground ever streams (skelmorrow's sat at 0,56,0 with nothing in
 *  the 60 m below: the hold never released) — not what this test is about. */
/** How long a scene may take to settle after a trip (world streaming + the load-in screen); generous because the pipeline runs beside other heavy jobs. */
const SETTLE_MS = 300000;
const settled = async (scene: string, ms = 90000, anyHold = false) => waitUntil(async () => { const s = await state(); return s.scene === scene && s.mode === "playing" && !s.curtain && (anyHold || !s.travelling) && !s.loading && s.sim && !!s.pid; }, ms);

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
  // Aim before pressing W: a cold frame can otherwise walk off a narrow approach
  // using the arrival heading while the first state/evaluation requests complete.
  const initial = await me();
  if (!initial) throw new Fail(`no player body before walking into ${door}`);
  await H((h, y: number) => h.cameraRig.setOrbit(y + Math.PI, null), Math.atan2(goal[0] - initial[0], goal[2] - initial[2]));
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
  // evidence of the failed walk: the body's path (a fall shows as a y drop) and what the camera saw where it stopped
  const tag = `${from}-walk-into-${door}`;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${tag}.trace.json`), JSON.stringify({ door, doorAt, goal, trace: trace.map((p) => p.map((n) => +n.toFixed(2))) }) + "\n");
  await page.screenshot({ path: path.join(OUT, `${tag}.png`), timeout: 120000 }).catch(() => {});
  const drop = trace.findIndex((p, i) => i > 0 && trace[i - 1]![1] - p[1] > 0.6);
  const fell = drop > 0 ? ` — the body FELL ${(trace[drop - 1]![1] - trace.at(-1)![1]).toFixed(1)} m at ${fmt(trace[drop - 1])} (${flat(trace[drop - 1]!, doorAt).toFixed(1)} m from the door)` : "";
  throw new Fail(`walking into ${door} in ${from} for ${ms / 1000} s never started a trip (trips ${s.trips - start.trips}, refusals ${JSON.stringify(s.refusals.slice(start.refusals.length))}); body last at ${fmt(last)}, the door at ${fmt(doorAt)}, ${last ? flat(last, doorAt).toFixed(1) : "?"} m from it${fell}${stuckNote(trace)} (trace + shot: ${path.join(OUT, tag)}.*)`);
}

/** A fresh page on `scene`, in play, settled. */
async function openInPlay(scene: string, travelNext = false): Promise<void> {
  if (page) await page.close().catch(() => {});
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // a test client never writes authoring files: its autosave of the scene it booted with erased later installs
  await page.route(/\/__hitreg\//, dropAuthoringWrites);
  // scene files served WITHOUT their creatures (mobs + spawn areas, as light-shots serves them; --keep-mobs keeps them):
  // the test body is a fresh traveller, and at a hostile camp's door it died before it reached the box (rustgut-entrance
  // 2026-11-09: a populate hyena at Rustgut's camp, "You died" 9 m from the door). This test is about doors, not fights.
  if (!process.argv.includes("--keep-mobs")) await page.route((u: URL) => u.pathname === "/__hitreg/asset-file" && /^scenes\/[^/]+\.scene\.json$/.test(u.searchParams.get("file") ?? ""), async (route: { request(): { url(): string }; fulfill(o: unknown): Promise<void>; continue(): Promise<void> }) => {
    const id = (new URL(route.request().url()).searchParams.get("file") ?? "").replace(/^scenes\//, "").replace(/\.scene\.json$/, "");
    const f = sceneFile(id);
    if (!f) return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: withoutMobs(fs.readFileSync(f.file, "utf8")) });
  });
  // tsx keeps function names with an injected __name() helper: the functions evaluated in the page need it too
  await page.addInitScript(() => { (window as unknown as { __name: (f: unknown) => unknown }).__name = (f: unknown) => f; });
  page.on("console", (m: { text(): string }) => { const t = m.text(); if (/portal|refus|could not open/i.test(t)) logs.push(t); });
  page.on("pageerror", (e: Error) => logs.push("pageerror: " + e.message));
  await page.goto(`${base}/?scene=${encodeURIComponent(scene)}`, { waitUntil: "load", timeout: 180000 }); // a cold vite on a loaded machine took > 30 s (rustgut 2026-11-10)
  if (!(await waitUntil(async () => page.evaluate(() => !!(window as unknown as { __hitreg?: { playerId?: unknown } }).__hitreg?.playerId), 180000))) throw new Fail("the dev app never came up (or it has no __hitreg.playerId: a dev build is needed)");
  await waitUntil(async () => (await state()).scene === scene, 120000);
  await sleep(1500);
  await page.locator("canvas").first().focus().catch(() => {});
  await page.keyboard.press("Backquote");
  if (!(await settled(scene, SETTLE_MS, travelNext))) throw new Fail(`play never started in ${scene} within ${SETTLE_MS / 1000} s: ${JSON.stringify(await state())}`);
  await H(() => document.exitPointerLock?.());
  await sleep(1500);
}

/** Through `door` (a portal in the scene that is up) into `to`; returns where the body landed. */
async function goThrough(from: string, door: string, startAt: V3, to: string, shot: string): Promise<V3> {
  const doorAt = await where(door);
  if (!doorAt) throw new Fail(`no entity ${door} in ${from}`);
  await walkInto(through(startAt, doorAt), from, door, doorAt, WALK_MS);
  if (!(await settled(to, SETTLE_MS))) {
    const s = await state();
    const why = s.scene === from ? `started but never left ${from}` : s.scene !== to ? `went to ${s.scene}, not ${to}`
      : `reached ${to} but never settled in ${SETTLE_MS / 1000} s (${[s.loading && "load screen still up", s.travelling && "still held for ground (travelling)", s.curtain && "curtain up", s.mode !== "playing" && `mode ${s.mode}`].filter(Boolean).join(", ") || "no sim/player"}; a loaded machine streams the world slowly)`;
    throw new Fail(`the trip through ${door} ${why} (${JSON.stringify(s)})`);
  }
  await sleep(1500);
  const at = (await me())!;
  // A swap back from a big instance (undercistern: ~51 MB of inline meshes) can hold the first frame of the world for
  // more than Playwright's 30 s default; the trip itself had already landed. Wait up to 120 s and SAY how long the frame
  // took (a stall a player would see), instead of failing the round trip on the camera.
  const shotT = Date.now();
  await page.screenshot({ path: path.join(OUT, shot), timeout: 120000 });
  const shotS = (Date.now() - shotT) / 1000;
  if (shotS > 10) console.log(`    slow frame: the ${to} arrival screenshot took ${shotS.toFixed(0)} s`);
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
    const msg = e instanceof Fail ? e.message : `error: ${(e as Error).stack ?? e}`;
    const note = viteDied && !msg.includes(viteDied) ? `${msg} [${viteDied}]` : msg;
    phases.push({ name, ok: false, note }); console.log(`  ${name}: FAILED — ${note}`);
    if (logs.length) console.log("    page log:\n      " + logs.slice(-10).join("\n      "));
    if (viteDied && viteTail.length) console.log("    vite said (last lines):\n      " + viteTail.slice(-20).join("\n      "));
  }
  logs.length = 0;
}

console.log(`portal-play: ${SCENE}/${PORTAL} -> ${DEST}, out by ${EXIT}`);
const EXIT_FROM = arg("--exit-from") ? (arg("--exit-from").split(",").map(Number) as V3) : null;
/** --exit-from: dev fast travel to the exit's approach inside the instance; returns where the body settled (null: not asked). */
async function toExitFrom(scene: string): Promise<V3 | null> {
  if (!EXIT_FROM) return null;
  if (await H((h, p: V3) => h.travelTo(p[0], p[1] + 1.5, p[2]), EXIT_FROM) !== "ok") throw new Fail("dev fast travel to --exit-from refused");
  if (!(await settled(scene, 90000))) throw new Fail("fast travel to --exit-from never settled");
  await sleep(2500);
  return (await me())!;
}
const exitParams = paramsOf(destDoc, EXIT);
await phase("trip", async () => {
  if (!exitParams) throw new Fail(`${EXIT} in ${DEST} is not a portal: a player cannot leave`);
  // The dev app loads only the boot scene's project closure (project.json dependsOn); a portal into a project
  // outside it RELOADS the page, which drops the trip (arrives in edit mode, "could not open scene"). A world lists
  // its instance projects in its own dependsOn (proving does) — check before spending minutes in a browser.
  const worldProject = sceneFile(SCENE)!.project;
  if (destInfo!.project !== worldProject) {
    const closure = new Set<string>();
    const visit = (p: string): void => {
      if (closure.has(p)) return;
      closure.add(p);
      const f = path.join(PG, "projects", p, "project.json");
      const deps = fs.existsSync(f) ? ((JSON.parse(fs.readFileSync(f, "utf8")) as { dependsOn?: string[] }).dependsOn ?? []) : [];
      deps.forEach(visit);
    };
    visit(worldProject);
    if (!closure.has(destInfo!.project)) throw new Fail(`project ${destInfo!.project} (scene ${DEST}) is not in ${worldProject}'s dependsOn closure: the editor reloads the page at the door and the trip is lost — add "${destInfo!.project}" to projects/${worldProject}/project.json dependsOn (as proving lists its dungeons)`);
  }
  await openInPlay(SCENE, true);
  const porch = (sp["returnAnchor"] ? await where(String(sp["returnAnchor"])) : null);
  const door = await where(PORTAL);
  if (!door) throw new Fail(`no entity ${PORTAL} in ${SCENE}`);
  const from = porch ?? door; // no return anchor: walk in from wherever travel put us (the door itself is the goal)
  if (await H((h, p: V3) => h.travelTo(p[0], p[1] + 1.5, p[2]), from) !== "ok") throw new Fail("dev fast travel refused");
  // a fast travel streams a whole view in, as a portal arrival does: the same 180 s budget (a cold voxel world after an install needs > 90 s)
  if (!(await settled(SCENE, 180000))) throw new Fail(`fast travel to the porch never settled: ${JSON.stringify(await state())}`);
  await sleep(2500);
  const start = (await me())!;
  const inAt = await goThrough(SCENE, PORTAL, start, DEST, `${DEST}-arrival.png`);
  shots.push(`${DEST}-arrival.png`);
  const entry = String(sp["anchor"] ?? "");
  const entryAt = entry ? await where(entry) : null;
  if (entryAt && flat(inAt, entryAt) > 4) throw new Fail(`arrived ${flat(inAt, entryAt).toFixed(1)} m from the entry anchor ${entry}`);
  const backAt = await goThrough(DEST, EXIT, await toExitFrom(DEST) ?? inAt, SCENE, `${SCENE}-from-${DEST}.png`);
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
    const fault = returnSceneFault(PG, destInfo!.project, fallback);
    if (fault) throw new Fail(`${EXIT}'s fallback: ${fault} (tools/portal-return.mts --to <world scene> <anchor>)`);
    await openInPlay(DEST);
    const start = (await me())!;
    const outAt = await goThrough(DEST, EXIT, await toExitFrom(DEST) ?? start, fallback, `${fallback}-from-${DEST}-reloaded.png`);
    shots.push(`${fallback}-from-${DEST}-reloaded.png`);
    const anchor = String(exitParams["anchor"] ?? "");
    const anchorAt = anchor ? await where(anchor) : null;
    if (anchorAt && flat(outAt, anchorAt) > 4) throw new Fail(`landed ${flat(outAt, anchorAt).toFixed(1)} m from the exit's anchor ${anchor}`);
    return `from ${fmt(start)} out to ${fallback} at ${fmt(outAt)}${anchorAt ? `, ${flat(outAt, anchorAt).toFixed(1)} m from ${anchor}` : ` (anchor ${anchor} not in ${fallback} yet: it installs with the place)`}`;
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
