#!/usr/bin/env tsx
/**
 * hitreg-zone-budget — will one copy of each zone of this scene hold its players? A clear PASS or FAIL.
 *
 *   pnpm -F @hitreg/server zone-budget --scene proving
 *   pnpm -F @hitreg/server zone-budget --scene proving --bots 32 --seconds 90
 *
 * 1. The census (src/zone-budget.ts): per zone, placed entities, colliders, trimesh triangles, the largest
 *    trimesh, creatures, and the most creatures that can wake around one spot — each against its budget.
 * 2. With --bots N: a fresh `serve` on a free port, N bots walking the zone camp to camp (the project's
 *    driver with --driver <file>, e.g. a game's load-bots.mts; else the engine's bin/bots.ts), and the
 *    tick marks: p95 ≤ --p95 ms (8), max < --max ms (33), sim time dropped = 0, timing corrections ≤
 *    --corrections per player-minute (1, when the driver reports them). The server it starts is stopped by
 *    the pid it started.
 *
 * Options: --scene, --playground (this repo's apps/playground), --budget '<json ZoneBudget overrides>',
 * --crowd-radius (150), --json (machine-readable result). Exit code 0 = PASS, 1 = FAIL, 2 = could not run.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent, playgroundRoots } from "../src/assets.js";
import { defaultRegistry } from "../src/world.js";
import { fileMeshGeometry } from "../src/mesh-geometry.js";
import { zoneCensus, type ZoneBudget } from "../src/zone-budget.js";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(arg("playground", path.resolve(here, "../../../apps/playground"))!);
const scene = arg("scene");
const asJson = process.argv.includes("--json");
if (!scene) {
  console.error("usage: zone-budget --scene <name> [--bots N --seconds S --driver <file>] [--budget '{json}']");
  process.exit(2);
}

const content = loadContent(playgroundRoots(playground));
const doc = content.scenes.get(scene);
if (!doc) {
  console.error(`scene "${scene}" not found`);
  process.exit(2);
}
const census = zoneCensus({
  doc,
  assets: content.assets,
  registry: defaultRegistry(),
  meshGeometry: fileMeshGeometry((id) => content.assets.getModel(id)?.url),
  crowdRadius: Number(arg("crowd-radius", "150")),
  ...(arg("budget") ? { budget: JSON.parse(arg("budget")!) as Partial<ZoneBudget> } : {}),
});

const lines: string[] = [];
lines.push(`zone budget — scene "${scene}" (${census.zones.length} zones)`);
lines.push(`budget: ${JSON.stringify(census.budget)}`);
for (const z of census.zones) {
  lines.push(
    `  ${z.over.length ? "FAIL" : "ok  "} ${z.zone.padEnd(16)} entities ${String(z.entities).padStart(5)}  colliders ${String(z.colliders).padStart(5)}  triangles ${String(z.triangles).padStart(8)}` +
      `  largest ${String(z.largestTrimesh?.triangles ?? 0).padStart(7)}  creatures ${String(z.creatures).padStart(4)} in ${z.spawnAreas} areas  crowd ${z.crowd.creatures}`,
  );
  for (const o of z.over) lines.push(`         over: ${o}`);
}

interface Live { players: number; tickP50: number; tickP95: number; tickMax: number; lostSimMs: number | null; correctionsPerMin: number | null; machineBusyPct: number | null; pass: boolean; why: string[] }
let live: Live | null = null;
const bots = Number(arg("bots", "0"));
if (bots > 0) live = await liveRun(bots);

const pass = census.pass && (live?.pass ?? true);
if (asJson) console.log(JSON.stringify({ scene, pass, census, live }, null, 2));
else {
  for (const l of lines) console.log(l);
  if (live) {
    console.log(`live: ${live.players} bots — tick p50 ${live.tickP50} / p95 ${live.tickP95} / max ${live.tickMax} ms; sim dropped ${live.lostSimMs ?? "?"} ms; corrections ${live.correctionsPerMin ?? "?"}/player/min; machine ${live.machineBusyPct ?? "?"}% busy`);
    for (const w of live.why) console.log(`      over: ${w}`);
    if ((live.machineBusyPct ?? 0) > 60) console.log("      (the machine was busy: timings are not comparable with a quiet run)");
  }
  console.log(pass ? "PASS" : "FAIL");
}
process.exit(pass ? 0 : 1);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

async function liveRun(players: number): Promise<Live> {
  const port = await freePort();
  const engine = path.resolve(here, "../../..");
  const server = spawn(`pnpm -F @hitreg/server serve --scene ${scene} --port ${port} --profile`, { cwd: engine, shell: true, stdio: "ignore" });
  const stop = (): void => {
    try {
      if (process.platform === "win32" && server.pid) execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" });
      else server.kill("SIGTERM");
    } catch {
      // gone
    }
  };
  try {
    const admin = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 240 && !up; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      up = await fetch(`${admin}/health`).then((r) => r.ok, () => false);
    }
    if (!up) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 15_000)); // boot settles (threads retire, NPCs dormant)
    const seconds = arg("seconds", "90")!;
    const driver = arg("driver");
    const out = path.join(fs.mkdtempSync(path.join(process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp", "zone-budget-")), "bots.json");
    const cmd = driver
      ? `npx tsx "${path.resolve(driver)}" --url ws://127.0.0.1:${port} --players ${players} --mode roam --seconds ${seconds} --warmup 20 --out "${out}"`
      : `pnpm -F @hitreg/server exec tsx bin/bots.ts --url ws://127.0.0.1:${port} --count ${players} --seconds ${Number(seconds) + 20}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, { cwd: driver ? path.dirname(path.dirname(path.resolve(driver))) : engine, shell: true, stdio: "ignore" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`bot driver exited ${code}`))));
    });
    const status = (await (await fetch(`${admin}/admin/status`)).json()) as { tickMs: { p50: number; p95: number; max: number }; slow?: { lostSimMs?: number; over33?: number } };
    const r = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, "utf8")) as { server: { tickP50: number; tickP95: number; tickMax: number; machineBusyPct: number }; corrections?: { timingPerMin: number; lostSimMs: number } }) : null;
    const p95Limit = Number(arg("p95", "8"));
    const maxLimit = Number(arg("max", "33"));
    const corrLimit = Number(arg("corrections", "1"));
    const result: Live = {
      players,
      tickP50: r?.server.tickP50 ?? status.tickMs.p50,
      tickP95: r?.server.tickP95 ?? status.tickMs.p95,
      tickMax: r?.server.tickMax ?? status.tickMs.max,
      lostSimMs: r?.corrections?.lostSimMs ?? null,
      correctionsPerMin: r?.corrections?.timingPerMin ?? null,
      machineBusyPct: r?.server.machineBusyPct ?? null,
      pass: true,
      why: [],
    };
    if (result.tickP95 > p95Limit) result.why.push(`tick p95 ${result.tickP95} > ${p95Limit} ms`);
    if (result.tickMax >= maxLimit) result.why.push(`tick max ${result.tickMax} ≥ ${maxLimit} ms`);
    if ((result.lostSimMs ?? 0) > 0) result.why.push(`${result.lostSimMs} ms of simulation dropped`);
    if ((result.correctionsPerMin ?? 0) > corrLimit) result.why.push(`${result.correctionsPerMin} corrections/player/min > ${corrLimit}`);
    result.pass = result.why.length === 0;
    return result;
  } finally {
    stop();
  }
}
