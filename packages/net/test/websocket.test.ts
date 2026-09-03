import { afterEach, describe, expect, it } from "vitest";
import {
  encodeMessage,
  decodeMessage,
  frameData,
  parseWsHandshake,
  RoomClient,
  RoomHost,
  unframeData,
  WebSocketClientTransport,
  WS_HOST_ID,
  type Channel,
} from "../src/index.js";
import { WebSocketHostTransport } from "../src/server.js";

/**
 * A REAL socket pair: `ws` server on an ephemeral port, Node's built-in
 * WebSocket client dialing it. No fakes — the transport's whole job is the
 * wire, so the wire is what gets tested.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(10);
  }
}

let host: WebSocketHostTransport | null = null;
const clients: WebSocketClientTransport[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  host?.close();
  host = null;
});

async function boot(): Promise<{ host: WebSocketHostTransport; url: string }> {
  host = new WebSocketHostTransport({ port: 0, host: "127.0.0.1" });
  await host.ready();
  return { host, url: `ws://127.0.0.1:${host.port}` };
}

function dial(url: string, peerId?: string): WebSocketClientTransport {
  const c = new WebSocketClientTransport(url, peerId ? { peerId } : {});
  clients.push(c);
  return c;
}

describe("framing + handshake parsing", () => {
  it("round-trips channel tags", () => {
    const data = new Uint8Array([1, 2, 3]);
    for (const channel of ["reliable", "unreliable"] as Channel[]) {
      const frame = frameData(channel, data);
      const back = unframeData(frame);
      expect(back?.channel).toBe(channel);
      expect([...back!.data]).toEqual([1, 2, 3]);
    }
    expect(unframeData(new Uint8Array([]))).toBeNull();
    expect(unframeData(new Uint8Array([7, 1]))).toBeNull();
  });

  it("validates handshakes", () => {
    expect(parseWsHandshake('{"ws":"hello","peerId":"p-abc"}')).toEqual({ ws: "hello", peerId: "p-abc" });
    expect(parseWsHandshake('{"ws":"hello","peerId":"x y"}')).toBeNull();
    expect(parseWsHandshake('{"ws":"welcome","peerId":"p-abc"}')).toEqual({ ws: "welcome", peerId: "p-abc" });
    expect(parseWsHandshake("not json")).toBeNull();
    expect(parseWsHandshake('{"ws":"nope"}')).toBeNull();
  });
});

describe("WebSocket transport", () => {
  it("connects, keeps the proposed id, and exchanges bytes both ways", async () => {
    const { host, url } = await boot();
    const hostSeen: Array<{ from: string; channel: Channel; bytes: number[] }> = [];
    const hostPeers: Array<[string, string]> = [];
    host.onMessage((from, channel, data) => hostSeen.push({ from, channel, bytes: [...data] }));
    host.onPeer((peer, state) => hostPeers.push([peer, state]));

    const client = dial(url, "p-alice");
    const clientSeen: Array<{ from: string; channel: Channel; bytes: number[] }> = [];
    const clientPeers: Array<[string, string]> = [];
    client.onMessage((from, channel, data) => clientSeen.push({ from, channel, bytes: [...data] }));
    client.onPeer((peer, state) => clientPeers.push([peer, state]));

    await until(() => client.peers().length === 1);
    expect(client.localId).toBe("p-alice");
    expect(client.peers()).toEqual([WS_HOST_ID]);
    expect(clientPeers).toEqual([[WS_HOST_ID, "connected"]]);
    await until(() => hostPeers.length === 1);
    expect(hostPeers).toEqual([["p-alice", "connected"]]);
    expect(host.peers()).toEqual(["p-alice"]);

    client.send(WS_HOST_ID, "reliable", new Uint8Array([1, 2]));
    client.send(WS_HOST_ID, "unreliable", new Uint8Array([3]));
    await until(() => hostSeen.length === 2);
    expect(hostSeen).toEqual([
      { from: "p-alice", channel: "reliable", bytes: [1, 2] },
      { from: "p-alice", channel: "unreliable", bytes: [3] },
    ]);

    host.send("p-alice", "unreliable", new Uint8Array([9, 9]));
    host.broadcast("reliable", new Uint8Array([4]));
    await until(() => clientSeen.length === 2);
    expect(clientSeen).toEqual([
      { from: WS_HOST_ID, channel: "unreliable", bytes: [9, 9] },
      { from: WS_HOST_ID, channel: "reliable", bytes: [4] },
    ]);
  });

  it("renames a colliding id and reports disconnects both ways", async () => {
    const { host, url } = await boot();
    const a = dial(url, "p-same");
    await until(() => a.peers().length === 1);
    const b = dial(url, "p-same");
    await until(() => b.peers().length === 1);
    expect(a.localId).toBe("p-same");
    expect(b.localId).not.toBe("p-same");
    expect(b.localId.startsWith("p-same-")).toBe(true);
    await until(() => host.peers().length === 2);

    const gone: string[] = [];
    host.onPeer((peer, state) => {
      if (state === "disconnected") gone.push(peer);
    });
    a.close();
    await until(() => gone.length === 1);
    expect(gone).toEqual(["p-same"]);
    expect(host.peers()).toEqual([b.localId]);

    const clientGone: string[] = [];
    b.onPeer((peer, state) => {
      if (state === "disconnected") clientGone.push(peer);
    });
    host.disconnect(b.localId);
    await until(() => clientGone.length === 1);
    expect(clientGone).toEqual([WS_HOST_ID]);
    expect(b.peers()).toEqual([]);
  });

  it("rejects a peer past maxPeers", async () => {
    host = new WebSocketHostTransport({ port: 0, host: "127.0.0.1", maxPeers: 1 });
    await host.ready();
    const url = `ws://127.0.0.1:${host.port}`;
    const a = dial(url, "p-one");
    await until(() => a.peers().length === 1);
    const b = dial(url, "p-two");
    const states: string[] = [];
    b.onPeer((_p, s) => states.push(s));
    await wait(300);
    expect(b.peers()).toEqual([]);
    expect(states).toEqual([]); // never connected — reject closes before welcome
    expect(host.peers()).toEqual(["p-one"]);
  });

  it("carries the room protocol: hello → welcome, commands up, snapshots down", async () => {
    const { host: transport, url } = await boot();
    const room = new RoomHost(transport, { snapshotEvery: 1 });
    room.setStateSource((peerId) => ({ for: peerId, tick: 1 }));
    const commands: Array<{ peer: string; input: unknown }> = [];
    room.onCommand((peer, _tick, input) => commands.push({ peer, input }));

    const ct = dial(url, "p-bob");
    const client = new RoomClient(ct, WS_HOST_ID);
    const snapshots: unknown[] = [];
    client.onSnapshot((s) => snapshots.push(s.state));
    ct.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join("Bob");
    });
    await until(() => client.state === "joined");
    expect(client.peerId).toBe("p-bob");
    expect(room.peers()).toEqual([{ peerId: "p-bob", name: "Bob" }]);
    expect(snapshots[0]).toEqual({ for: "p-bob", tick: 1 }); // welcome's full state

    client.sendCommand({ t: "input", v: [1, 0] });
    await until(() => commands.length === 1);
    expect(commands[0]).toEqual({ peer: "p-bob", input: { t: "input", v: [1, 0] } });

    room.tick(3);
    await until(() => snapshots.length === 2);
    expect(snapshots[1]).toEqual({ for: "p-bob", tick: 1 });

    // the wire never corrupts a protocol message
    const raw = encodeMessage({ t: "events", tick: 3, events: [{ name: "x", payload: { a: 1 } }] });
    expect(decodeMessage(raw)?.t).toBe("events");
    room.close();
    client.leave();
  });
});
