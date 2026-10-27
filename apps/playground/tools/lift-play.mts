/**
 * lift-play --job <place job dir> --lift <id> [--scene <world scene>] [--port 5317] [--url http://localhost:<p>] [--out <dir>] [--headed]
 *
 * The REAL-CLIENT lift ride (the place-build `lift` gate is the server's stepping; this is what a player gets): the dev
 * app in a browser (Playwright + system Chrome), local play, the body walked with the keyboard. Fast-travel to the lift's
 * top entry, wait for the deck to arrive, WALK onto it, ride it down (the feet must stay on the deck), walk off at the
 * bottom exit, take the picture from the bottom landing looking UP the rope, wait for the deck to come back, walk on,
 * ride up, walk off at the top. Pictures: <out>/lift-<id>-{top,ride,bottom-up}.png; report <job>/lifts/<id>.play.json.
 * Exit 1 on a fault. Without --url it starts its own vite (agent-test config, --port) and stops it by PID afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS module
import { loadPlaywright } from "./_playwright.mjs";

type V3 = [number, number, number];
const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1]! : ""; };
const JOB = path.resolve(arg("--job")), ID = arg("--lift");
if (!arg("--job") || !ID) { console.error("usage: lift-play --job <place job dir> --lift <id> [--scene s] [--port p] [--out dir]"); process.exit(2); }
const plan = JSON.parse(fs.readFileSync(path.join(JOB, "lifts", `${ID}.plan.json`), "utf8"));
const SCENE = arg("--scene") || "skelmorrow";
const OUT = path.resolve(arg("--out") || path.join(JOB, "lifts"));
fs.mkdirSync(OUT, { recursive: true });
const deckId = `lift-${ID}-deck`;

let base = arg("--url");
let vite: ReturnType<typeof spawn> | null = null;
let vitePort = "";
/** Stop the vite this run started: its process tree, and on Windows the listener on our own --strictPort port (npx's tree
 * does not always reach the node that serves it; a stray vite stayed on the port after two runs, 2026-10-22). */
const stopVite = () => {
  if (!vite?.pid) return;
  try {
    if (process.platform !== "win32") { process.kill(vite.pid); return; }
    spawnSync("taskkill", ["/pid", String(vite.pid), "/t", "/f"]);
    const net = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout ?? "";
    for (const line of net.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && m[1] === vitePort) spawnSync("taskkill", ["/pid", m[2]!, "/t", "/f"]);
    }
  } catch { /* gone */ }
};
if (!base) {
  const port = arg("--port") || "5317";
  vitePort = port;
  vite = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--config", "vite.agent-test.config.ts", "--port", port, "--strictPort"], { cwd: PG, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  console.log(`vite pid ${vite.pid} on ${port}`);
  base = `http://localhost:${port}`;
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite did not start in 60 s")), 60000);
    const on = (b: Buffer) => { if (/ready in|Local:/.test(b.toString())) { clearTimeout(t); res(); } };
    vite!.stdout!.on("data", on); vite!.stderr!.on("data", on);
    vite!.on("exit", (c) => rej(new Error(`vite exited ${c}`)));
  }).catch((e) => { console.error("STOP:", (e as Error).message); stopVite(); process.exit(2); });
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "chrome", headless: !process.argv.includes("--headed"), args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => { (window as unknown as { __name: (f: unknown) => unknown }).__name = (f: unknown) => f; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await sleep(100); } return false; };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const H = <T,>(fn: (h: any, ...a: any[]) => T, ...a: unknown[]) => page.evaluate(([src, args]: [string, unknown[]]) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = (window as any).__hitreg; return new Function("h", "args", `return (${src})(h, ...args)`)(h, args);
}, [fn.toString(), a]) as Promise<T>;
const where = (id: string) => H((h, id: string) => { const o = h.object(id); if (!o) return null; const p = o.position.clone(); o.getWorldPosition(p); return [p.x, p.y, p.z]; }, id) as Promise<V3 | null>;
const me = () => H((h) => { const id = h.playerId(); const o = id && h.object(id); if (!o) return null; const p = o.position.clone(); o.getWorldPosition(p); return [p.x, p.y, p.z]; }) as Promise<V3 | null>;
const state = () => H((h) => ({ scene: h.sceneName(), mode: h.playMode.get(), travelling: h.travelling(), loading: !!h.loading?.(), sim: !!h.sim, pid: h.playerId() })) as Promise<{ scene: string; mode: string; travelling: boolean; loading: boolean; sim: boolean; pid: string | null }>;
const settled = () => waitUntil(async () => { const s = await state(); return s.scene === SCENE && s.mode === "playing" && !s.travelling && !s.loading && s.sim && !!s.pid; }, 300000);
const flat = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const r2 = (v: number) => Math.round(v * 100) / 100;
const deckTopY = async () => ((await where(deckId))?.[1] ?? NaN) + 0.1;
const faults: string[] = [];
const legs: Array<{ leg: string; rideS: number; worst: number; end: V3; want: V3 }> = [];
/** [leg, seconds into the ride, feet y, deck top y] every sample: where a rider parted from the deck, when one did */
const trace: Array<[string, number, number, number]> = [];
const shots: string[] = [];

async function walkTo(goal: V3, tol: number, ms: number): Promise<boolean> {
  await page.keyboard.down("KeyW");
  const t = Date.now();
  try {
    while (Date.now() - t < ms) {
      const p = await me();
      if (p && flat(p, goal) < tol) return true;
      if (p) await H((h, y: number) => h.cameraRig.setOrbit(y + Math.PI, null), Math.atan2(goal[0] - p[0], goal[2] - p[2]));
      await sleep(60);
    }
    return false;
  } finally { await page.keyboard.up("KeyW"); }
}
const near = async (y: number) => Math.abs((await deckTopY()) - y) < 0.05;
/** Wait for the deck to ARRIVE at height y (a fresh dwell). */
async function arrival(y: number): Promise<boolean> {
  // the page's sim clock runs behind real time at a low frame rate (19 fps: ~75 %), so a cycle can take 1.4x its length
  const cycleMs = plan.cycle * 2000 + 20000;
  if (await near(y)) await waitUntil(async () => !(await near(y)), cycleMs);
  return waitUntil(() => near(y), cycleMs);
}
async function ride(leg: string, startY: number, endY: number, off: V3, onBottom?: () => Promise<void>): Promise<void> {
  if (!(await arrival(startY))) { faults.push(`${leg}: the deck never arrived at ${r2(startY)}`); return; }
  const d = (await where(deckId))!;
  if (!(await walkTo(d, 0.5, (plan.spec.dwell - 1) * 1000))) { faults.push(`${leg}: could not walk onto the deck in its dwell`); return; }
  const p0 = (await me())!, foot = p0[1] - (await deckTopY());
  if (leg === "down") { await page.screenshot({ path: path.join(OUT, `lift-${ID}-top.png`) }); shots.push(`lift-${ID}-top.png`); }
  let worst = 0; const t0 = Date.now(); let shot = false;
  await waitUntil(async () => !(await near(startY)), (plan.spec.dwell + 3) * 1000);
  while (!(await near(endY)) && Date.now() - t0 < (plan.length / plan.spec.speed + 30) * 1000) {
    const p = await me(), dt = await deckTopY();
    if (p) { worst = Math.max(worst, Math.abs(p[1] - dt - foot)); trace.push([leg, r2((Date.now() - t0) / 1000), r2(p[1] - foot), r2(dt)]); }
    if (leg === "down" && !shot && Date.now() - t0 > (plan.length / plan.spec.speed / 2) * 1000) {
      await page.screenshot({ path: path.join(OUT, `lift-${ID}-ride.png`) }); shots.push(`lift-${ID}-ride.png`); shot = true;
    }
    await sleep(100);
  }
  const rideS = r2((Date.now() - t0) / 1000);
  await sleep(500);
  const walked = await walkTo(off, 0.8, (plan.spec.dwell - 2) * 1000);
  await sleep(800);
  const end = (await me())!;
  legs.push({ leg, rideS, worst: r2(worst), end: end.map(r2) as V3, want: off });
  if (!walked || worst > 0.5 || flat(end, off) > 1.5) faults.push(`${leg}: ${walked ? "" : "never reached the landing; "}feet off the deck by up to ${r2(worst)} m; ended ${JSON.stringify(end.map(r2))} for ${JSON.stringify(off)}`);
  if (onBottom) await onBottom();
}

let code = 0;
try {
  await page.goto(`${base}/?scene=${encodeURIComponent(SCENE)}`, { waitUntil: "load" });
  if (!(await waitUntil(async () => page.evaluate(() => !!(window as unknown as { __hitreg?: { playerId?: unknown } }).__hitreg?.playerId), 180000))) throw new Error("the dev app never came up");
  await waitUntil(async () => (await state()).scene === SCENE, 120000);
  await sleep(1500);
  await page.locator("canvas").first().focus().catch(() => {});
  await page.keyboard.press("Backquote");
  await waitUntil(async () => (await state()).mode === "playing", 60000);
  await H(() => document.exitPointerLock?.());
  if (!(await where(deckId))) throw new Error(`no ${deckId} in ${SCENE}: install the lift first`);
  const entry = plan.entry as V3, exit = plan.exit as V3;
  if (await H((h, p: V3) => h.travelTo(p[0], p[1] + 1.5, p[2]), entry) !== "ok") throw new Error("dev fast travel refused");
  if (!(await settled())) throw new Error(`fast travel never settled: ${JSON.stringify(await state())}`);
  await sleep(2000);
  await ride("down", plan.deckTop[1], plan.deckBottom[1], exit, async () => {
    // from the bottom landing, look UP the rope to the headframe once the empty deck has climbed a fifth of the way
    // (with the deck still at the bottom its cradle fills the frame and nothing of the shaft reads)
    const fifth = plan.deckBottom[1] + (plan.deckTop[1] - plan.deckBottom[1]) * 0.2;
    await waitUntil(async () => (await deckTopY()) > fifth, plan.cycle * 1000);
    const p = (await me())!, d = (await where(deckId))!;
    await H((h) => { h.cameraRig.config.pitchMin = -1.35; });
    await H((h, y: number) => h.cameraRig.setOrbit(y + Math.PI, -1.25), Math.atan2(d[0] - p[0], d[2] - p[2]));
    await sleep(1200);
    await page.screenshot({ path: path.join(OUT, `lift-${ID}-bottom-up.png`) }); shots.push(`lift-${ID}-bottom-up.png`);
    await H((h) => { h.cameraRig.config.pitchMin = -0.56; h.cameraRig.setOrbit(null, -0.18); });
  });
  if (!faults.length) await ride("up", plan.deckBottom[1], plan.deckTop[1], entry);
} catch (e) {
  faults.push(`STOP: ${(e as Error).message}`);
} finally {
  const ok = !faults.length && legs.length === 2;
  fs.writeFileSync(path.join(JOB, "lifts", `${ID}.play.json`), JSON.stringify({ ok, legs, faults, shots: shots.map((s) => path.join(OUT, s)), trace, at: new Date().toISOString() }, null, 1) + "\n");
  console.log(`lift-play ${ID}: ${ok ? "PASS" : "FAIL"}`);
  for (const l of legs) console.log(`  ${l.leg}: ${l.rideS} s ride, feet within ${l.worst} m of the deck, off at ${JSON.stringify(l.end)} (want ${JSON.stringify(l.want)})`);
  for (const f of faults) console.log(`  FAULT ${f}`);
  code = ok ? 0 : 1;
  await browser.close().catch(() => {});
  stopVite();
}
process.exit(code);
