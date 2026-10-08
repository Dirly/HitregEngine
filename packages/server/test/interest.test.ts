import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * Interest (GameServerOptions.interestRadius / stateInterest): a player is sent the bodies near it, the
 * session state ABOUT those bodies, and the events that name them — not the whole layer's. Two players on
 * the `field` scene with a 12 m radius: apart, neither hears about the other; brought together, each is
 * caught up at once; in one party, they hear about each other from anywhere (a party frame).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await wait(15);
  }
}

let handle: ServeHandle | null = null;
try {
  handle = await serve({ playground, scene: "field", port: 0, respawnSeconds: 0, interestRadius: 12, log: () => undefined });
} catch (error) {
  console.warn("interest test skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!handle)("interest: bodies, state and events by distance", { timeout: 60_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await handle?.close();
  });

  /** A client that keeps the netState it is sent and the entity ids its snapshots carry. */
  function dial(peerId: string) {
    const transport = new WebSocketClientTransport(handle!.url, { peerId });
    const client = new RoomClient(transport, WS_HOST_ID);
    const state = new Map<string, unknown>();
    const seen = new Set<string>();
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    let self = "";
    client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "spawn" && msg.self) self = msg.self;
    });
    client.onState((sync) => {
      if (sync.full) {
        state.clear();
        for (const [k, v] of Object.entries(sync.full)) state.set(k, v);
      }
      for (const [k, v] of Object.entries(sync.delta?.set ?? {})) state.set(k, v);
      for (const k of sync.delta?.removed ?? []) state.delete(k);
    });
    client.onSnapshot((s) => {
      const st = s.state as { entities?: { updates?: Record<string, unknown> } } | null;
      for (const id of Object.keys(st?.entities?.updates ?? {})) seen.add(id);
    });
    client.onEvents(({ events: list }) => {
      for (const e of list) events.push(e as { name: string; payload: Record<string, unknown> });
    });
    transport.onPeer((peer, s) => {
      if (peer === WS_HOST_ID && s === "connected") client.join(peerId);
    });
    transports.push(transport);
    clients.push(client);
    return { client, state, seen, events, self: () => self };
  }

  const world = () => handle!.world;
  const move = (body: string, at: [number, number, number]) => {
    handle!.terrain?.ensureAround(at[0], at[2], 1);
    world().sim.setPosition(body, at);
  };
  const keysAbout = (state: Map<string, unknown>, body: string) => [...state.keys()].filter((k) => k.startsWith(`combat/${body}.`));

  it("apart: neither is sent the other's body, its combat state or the events about it", async () => {
    const a = dial("ann");
    const b = dial("ben");
    await until(() => !!a.self() && !!b.self(), 10_000, "both bodies");
    const annBody = a.self();
    const benBody = b.self();
    const at = world().positionOf(annBody)!;
    move(benBody, [at[0] + 60, at[1] + 1, at[2]]);
    await until(() => (world().netState.get(`combat/${benBody}.hp`) as number) > 0, 10_000, "ben's bars");
    // they spawned side by side: once apart, what Ann was told about Ben is taken back
    await until(() => keysAbout(a.state, benBody).length === 0, 8000, "ben forgotten by ann");
    // each still knows its own state
    expect(keysAbout(a.state, annBody).length).toBeGreaterThan(0);
    expect(keysAbout(b.state, benBody).length).toBeGreaterThan(0);
    // the far body: none of it (once the move has reached Ann's view, and what was already on the wire landed)
    const annView = () => (handle!.server as unknown as { peerViews: Map<string, Set<string>> }).peerViews.get("ann");
    await until(() => !annView()?.has(benBody), 5000, "ben out of ann's view");
    await wait(200);
    a.seen.clear();
    a.events.length = 0;
    world().netState.set(`combat/${benBody}.hp`, 7);
    // a replicated event about Ben (the field scene's combat scripts declare it)
    world().eventBus.emit("combat.struck", { actorId: benBody, sourceId: benBody });
    await wait(600);
    expect(a.seen.has(benBody)).toBe(false);
    expect(keysAbout(a.state, benBody)).toEqual([]);
    expect(a.events.some((e) => e.payload["actorId"] === benBody)).toBe(false);
    await until(() => b.events.some((e) => e.name === "combat.struck" && e.payload["actorId"] === benBody), 3000, "ben hears his own event");
    // ...while Ben hears about himself
    expect(b.state.get(`combat/${benBody}.hp`)).toBe(7);
  });

  it("together: caught up at once with the other's current state; apart again: forgotten", async () => {
    const benBody = "player:ben";
    const at = world().positionOf("player:ann")!;
    move(benBody, [at[0] + 3, at[1] + 1, at[2]]);
    world().netState.set(`combat/${benBody}.hp`, 9);
    // a third player, far at first, walks up to Ben
    const probe = dial("cat");
    await until(() => !!probe.self(), 10_000, "cat's body");
    move(probe.self(), [at[0] - 3, at[1] + 1, at[2]]);
    await until(() => probe.state.get(`combat/${benBody}.hp`) === 9, 5000, "caught up on ben");
    expect(probe.seen.has(benBody)).toBe(true);
    // gone again: its keys are removed from the far client's state
    move(probe.self(), [at[0] - 80, at[1] + 1, at[2]]);
    await until(() => keysAbout(probe.state, benBody).length === 0, 5000, "ben forgotten");
  });

  it("one party: mates hear about each other from anywhere", async () => {
    const dee = dial("dee");
    const eve = dial("eve");
    await until(() => !!dee.self() && !!eve.self(), 10_000, "both bodies");
    const at = world().positionOf(dee.self())!;
    move(eve.self(), [at[0] + 70, at[1] + 1, at[2]]);
    world().netState.set("comms.party/dee", "p1");
    world().netState.set("comms.party/eve", "p1");
    world().netState.set(`combat/${eve.self()}.hp`, 11);
    await until(() => dee.state.get(`combat/${eve.self()}.hp`) === 11, 5000, "dee hears about eve");
    // the body itself is still too far to be sent (they spawned together: look from now on)
    dee.seen.clear();
    await wait(600);
    expect(dee.seen.has(eve.self())).toBe(false);
  });
});
