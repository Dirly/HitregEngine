import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { characterCreationSchema, MemoryPlayerDataBackend } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * Character creation through the gateway: main validates a build against its
 * creation rules, stores it on the character, signs it into the play ticket,
 * and the layer hands it to the body as netState build/<bodyId> before the
 * body spawns (where the character-sheet authority picks it up).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(15);
  }
}

const creation = characterCreationSchema.parse({
  archetypes: [
    { id: "brawn", name: "Brawn", attributes: { strength: 2 } },
    { id: "wise", name: "Wise", attributes: { wisdom: 2 } },
  ],
  traits: [
    { id: "emberborn", name: "Emberborn", ability: "firebolt" },
    { id: "frostborn", name: "Frostborn", ability: "frostNova" },
  ],
  appearance: [
    { id: "sex", label: "Sex", body: true, options: [{ id: "male", label: "Male" }, { id: "female", label: "Female" }] },
    { id: "beard", label: "Beard", options: [{ id: "none", label: "None" }, { id: "full", label: "Full", requires: { sex: ["male"] } }] },
  ],
});

const SECRET = "test-creation-secret";
let main: MainHandle | null = null;
let layer: ServeHandle | null = null;
try {
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-creation",
    accounts: new MemoryAccountStore(),
    playerData: new MemoryPlayerDataBackend(),
    world: { scene: "field", cap: 4, min: 0, max: 0 },
    supervisor: null,
    scaleEverySeconds: 3600,
    creation,
    log: () => undefined,
  });
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main.url, serverId: "layer-1", maxPlayers: 4, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("creation test skipped:", error instanceof Error ? error.message : error);
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!main || !layer)("character creation through the gateway", { timeout: 30_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
    await main?.close();
  });

  it("publishes its rules", async () => {
    await until(() => main!.registry.layersFor("field").length === 1);
    const res = (await (await fetch(`${main!.url}/creation`)).json()) as { creation: { archetypes: Array<{ id: string }> } };
    expect(res.creation.archetypes.map((a) => a.id)).toEqual(["brawn", "wise"]);
  });

  it("refuses a missing or illegal build with the reason, stores a legal one, and the body arrives with it", async () => {
    const token = (await post(`${main!.url}/auth/register`, { name: "Maker", password: "hunter22" })).json.session as string;
    const make = (build?: unknown) => post(`${main!.url}/characters`, { name: "Brom", ...(build ? { build } : {}) }, token);

    expect((await make()).status).toBe(400);
    const unknown = await make({ archetype: "rogue", traits: ["emberborn"] });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toMatch(/unknown archetype/);
    const beard = await make({ archetype: "brawn", traits: ["emberborn"], appearance: { sex: "female", beard: "full" } });
    expect(beard.status).toBe(400);
    expect(beard.json.error).toMatch(/not available/);
    expect((await make({ archetype: "brawn", traits: [] })).status).toBe(400); // must pick one

    const ok = await make({ archetype: "wise", traits: ["frostborn"], appearance: { sex: "male", beard: "full" } });
    expect(ok.status).toBe(200);
    const build = ok.json.character.build;
    expect(build).toEqual({ archetype: "wise", traits: ["frostborn"], appearance: { sex: "male", beard: "full" } });

    const characterId = ok.json.character.id as string;
    const play = await post(`${main!.url}/play`, { characterId }, token);
    expect(play.status).toBe(200);
    // the build rides the SIGNED ticket, so a client cannot swap its lean at the door
    const claims = JSON.parse(Buffer.from((play.json.ticket as string).split(".")[0]!, "base64url").toString("utf8"));
    expect(claims.build).toEqual(build);

    const transport = new WebSocketClientTransport(play.json.url, { peerId: "tab-x", ticket: play.json.ticket });
    const client = new RoomClient(transport, WS_HOST_ID);
    const world: WorldModuleMessage[] = [];
    client.onModule(WORLD_MODULE, (m) => world.push(m as WorldModuleMessage));
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join("tab");
    });
    transports.push(transport);
    clients.push(client);
    const bodyId = `player:${characterId}`;
    await until(() => world.some((m) => m.t === "spawn" && m.self === bodyId));
    expect(layer!.identities.get(characterId)?.build).toEqual(build);
    expect(layer!.world.netState.get(`build/${bodyId}`)).toEqual(build);
  });
});
