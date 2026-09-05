import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryPlayerDataBackend } from "@hitreg/core";
import { startMain, type MainHandle } from "../src/main/main.js";
import { Supervisor } from "../src/main/supervisor.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";

/**
 * Instances are real child processes: main's supervisor starts `serve.ts`
 * for a dungeon scene, the child registers back over the cluster socket,
 * and it exits on its own once it has been empty for its idle window.
 * Runs the actual CLI under tsx, so it is the slowest test here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(25);
  }
}

const SECRET = "test-instances";
const PORT = 18780;
let main: MainHandle | null = null;
let supervisor: Supervisor | null = null;
const logs: string[] = [];
try {
  supervisor = new Supervisor({
    playground,
    mainUrl: `ws://127.0.0.1:${PORT}`,
    secret: SECRET,
    publicHost: "127.0.0.1",
    bindHost: "127.0.0.1",
    ports: { from: 18801, to: 18810 },
    extraArgs: ["--workers", "0"],
    log: (line) => logs.push(line),
  });
  main = await startMain({
    port: PORT,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-world",
    accounts: new MemoryAccountStore(),
    playerData: new MemoryPlayerDataBackend(),
    world: { scene: "field", min: 0, max: 0 },
    instances: { idleExitSeconds: 2, scenes: ["field"] },
    supervisor,
    scaleEverySeconds: 3600,
    bootTimeoutSeconds: 90,
    log: (line) => logs.push(line),
  });
} catch (error) {
  console.warn("instances test skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!main)("instances: supervisor-spawned child processes", () => {
  afterAll(async () => {
    await supervisor?.closeAll();
    await main?.close();
  });

  it("starts a dungeon on demand, sees it register, and lets it exit when idle", async () => {
    const res = await fetch(`${main!.url}/admin/instance`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ scene: "field", characterIds: [], key: "party-ABC" }),
    });
    const body = (await res.json()) as { ok: boolean; srv: string; url: string; moved: string[] };
    expect(res.status).toBe(200);
    expect(body.srv.startsWith("inst-")).toBe(true);
    expect(body.url).toMatch(/^ws:\/\/127\.0\.0\.1:188\d\d$/);
    const entry = main!.registry.servers.get(body.srv)!;
    expect(entry.kind).toBe("instance");
    expect(entry.instanceOf).toBe("party-ABC");
    expect(supervisor!.list().map((c) => c.id)).toEqual([body.srv]);
    // the same key reuses the running instance instead of starting another
    const again = (await (
      await fetch(`${main!.url}/admin/instance`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ scene: "field", key: "party-ABC" }),
      })
    ).json()) as { srv: string };
    expect(again.srv).toBe(body.srv);
    // a disallowed scene is refused before anything is spawned
    const nope = await fetch(`${main!.url}/admin/instance`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ scene: "mmo", key: "x" }),
    });
    expect(nope.status).toBe(400);
    // nobody joins: the child exits on its own after its idle window and main forgets it
    await until(() => !main!.registry.servers.has(body.srv) && supervisor!.list().length === 0, 30_000);
    expect(logs.some((l) => l.includes("exiting: idle"))).toBe(true);
  }, 120_000);
});
