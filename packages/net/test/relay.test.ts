import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  b64ToBytes,
  bytesToB64,
  mergeTransports,
  parseRelaySignal,
  RelayClientTransport,
  RelayHostTransport,
  RoomClient,
  RoomHost,
  type Channel,
  type PeerState,
  type SignalingChannel,
  type Transport,
} from "../src/index.js";

/**
 * The relay transport runs entirely over a SignalingChannel, so unlike
 * WebRTC it is fully exercisable in Node: a tiny in-memory hub stands in
 * for the dev server's websocket relay and delivers synchronously.
 */

class FakeRelayHub {
  private readonly handlers = new Map<string, Set<(from: string, data: unknown) => void>>();

  channel(selfId: string): SignalingChannel {
    const hub = this;
    if (!this.handlers.has(selfId)) this.handlers.set(selfId, new Set());
    return {
      selfId,
      send(to, data) {
        // structuredClone: no object aliasing between peers, like real JSON transit
        for (const cb of [...(hub.handlers.get(to) ?? [])]) cb(selfId, structuredClone(data));
      },
      onMessage(cb) {
        hub.handlers.get(selfId)!.add(cb);
        return () => hub.handlers.get(selfId)!.delete(cb);
      },
    };
  }
}

const bytes = (...values: number[]) => new Uint8Array(values);

let hub: FakeRelayHub;
beforeEach(() => {
  hub = new FakeRelayHub();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseRelaySignal", () => {
  it("accepts well-formed envelopes", () => {
    expect(parseRelaySignal({ relay: "hello" })).toEqual({ relay: "hello" });
    expect(parseRelaySignal({ relay: "welcome" })).toEqual({ relay: "welcome" });
    expect(parseRelaySignal({ relay: "bye" })).toEqual({ relay: "bye" });
    expect(parseRelaySignal({ relay: "data", channel: "reliable", b64: "AQI=" })).toEqual({
      relay: "data",
      channel: "reliable",
      b64: "AQI=",
    });
  });

  it("rejects malformed envelopes and RTC signals", () => {
    expect(parseRelaySignal(null)).toBeNull();
    expect(parseRelaySignal("hello")).toBeNull();
    expect(parseRelaySignal({})).toBeNull();
    expect(parseRelaySignal({ relay: "data", channel: "reliable" })).toBeNull(); // no b64
    expect(parseRelaySignal({ relay: "data", channel: "bulk", b64: "AQ==" })).toBeNull();
    expect(parseRelaySignal({ rtc: "offer", sdp: "v=0" })).toBeNull(); // RTC is invisible here
  });
});

describe("base64 round-trip", () => {
  it("survives arbitrary bytes and rejects garbage", () => {
    const data = new Uint8Array(256).map((_, i) => i);
    expect(b64ToBytes(bytesToB64(data))).toEqual(data);
    expect(b64ToBytes(bytesToB64(new Uint8Array(0)))).toEqual(new Uint8Array(0));
    expect(b64ToBytes("!!!not-base64!!!")).toBeNull();
  });
});

describe("relay transports", () => {
  it("connects hello→welcome and exchanges messages both ways", () => {
    const host = new RelayHostTransport(hub.channel("h"));
    const client = new RelayClientTransport(hub.channel("c"), "h");

    // synchronous hub: the first hello connects immediately
    expect(host.peers()).toEqual(["c"]);
    expect(client.peers()).toEqual(["h"]);

    const atHost: Array<{ from: string; channel: Channel; data: Uint8Array }> = [];
    const atClient: Array<{ from: string; channel: Channel; data: Uint8Array }> = [];
    host.onMessage((from, channel, data) => atHost.push({ from, channel, data }));
    client.onMessage((from, channel, data) => atClient.push({ from, channel, data }));

    client.send("h", "reliable", bytes(1, 2, 3));
    host.send("c", "unreliable", bytes(9));
    expect(atHost).toEqual([{ from: "c", channel: "reliable", data: bytes(1, 2, 3) }]);
    expect(atClient).toEqual([{ from: "h", channel: "unreliable", data: bytes(9) }]);
  });

  it("retries hello until the host starts listening, then stops", () => {
    const clientChannel = hub.channel("c");
    const sent: unknown[] = [];
    const spySend = clientChannel.send.bind(clientChannel);
    clientChannel.send = (to, data) => {
      sent.push(data);
      spySend(to, data);
    };
    const client = new RelayClientTransport(clientChannel, "h", { helloIntervalMs: 100 });
    expect(client.peers()).toEqual([]); // nobody listening yet
    vi.advanceTimersByTime(250); // two retries into the void
    expect(sent.filter((d) => (d as { relay?: string }).relay === "hello").length).toBe(3);

    const host = new RelayHostTransport(hub.channel("h"));
    vi.advanceTimersByTime(100); // next retry lands
    expect(client.peers()).toEqual(["h"]);
    expect(host.peers()).toEqual(["c"]);

    const before = sent.length;
    vi.advanceTimersByTime(500); // welcomed — no more hellos
    expect(sent.filter((d) => (d as { relay?: string }).relay === "hello").length).toBe(
      (sent.slice(0, before) as Array<{ relay?: string }>).filter((d) => d.relay === "hello")
        .length,
    );
  });

  it("gives up dialing after helloAttempts", () => {
    const client = new RelayClientTransport(hub.channel("c"), "h", {
      helloIntervalMs: 100,
      helloAttempts: 3,
    });
    vi.advanceTimersByTime(1000);
    const host = new RelayHostTransport(hub.channel("h"));
    vi.advanceTimersByTime(1000); // too late — client stopped dialing
    expect(client.peers()).toEqual([]);
    expect(host.peers()).toEqual([]);
  });

  it("duplicate hellos never double-connect", () => {
    const host = new RelayHostTransport(hub.channel("h"));
    const events: Array<{ peer: string; state: PeerState }> = [];
    host.onPeer((peer, state) => events.push({ peer, state }));
    const clientChannel = hub.channel("c");
    new RelayClientTransport(clientChannel, "h", { helloIntervalMs: 100 });
    clientChannel.send("h", { relay: "hello" }); // a stray extra dial
    expect(events).toEqual([{ peer: "c", state: "connected" }]);
    expect(host.peers()).toEqual(["c"]);
  });

  it("bye disconnects both directions; close sends bye", () => {
    const host = new RelayHostTransport(hub.channel("h"));
    const client = new RelayClientTransport(hub.channel("c"), "h");
    const hostEvents: PeerState[] = [];
    const clientEvents: PeerState[] = [];
    host.onPeer((_p, s) => hostEvents.push(s));
    client.onPeer((_p, s) => clientEvents.push(s));

    client.close();
    expect(host.peers()).toEqual([]);
    expect(hostEvents).toEqual(["disconnected"]);

    // reconnect a fresh client (the sync hub connects it inside the
    // constructor, before we can subscribe), then the host closes
    const client2 = new RelayClientTransport(hub.channel("c2"), "h");
    expect(client2.peers()).toEqual(["h"]);
    const client2Events: PeerState[] = [];
    client2.onPeer((_p, s) => client2Events.push(s));
    host.close();
    expect(client2.peers()).toEqual([]);
    expect(client2Events).toEqual(["disconnected"]);
    expect(clientEvents).toEqual([]); // already-closed client hears nothing
  });

  it("drops data from peers that never said hello, and malformed b64", () => {
    const host = new RelayHostTransport(hub.channel("h"));
    const received: unknown[] = [];
    host.onMessage((...args) => received.push(args));
    const stranger = hub.channel("x");
    stranger.send("h", { relay: "data", channel: "reliable", b64: "AQ==" });
    expect(received).toEqual([]);

    const client = new RelayClientTransport(hub.channel("c"), "h");
    hub.channel("c").send("h", { relay: "data", channel: "reliable", b64: "!!bad!!" });
    expect(received).toEqual([]);
    client.send("h", "reliable", bytes(7));
    expect(received).toHaveLength(1);
  });

  it("runs the full room protocol (join, commands, snapshots)", () => {
    const host = new RelayHostTransport(hub.channel("h"));
    const client = new RelayClientTransport(hub.channel("c"), "h");
    const roomHost = new RoomHost(host, { snapshotEvery: 1 });
    const roomClient = new RoomClient(client, "h");

    const commands: Array<{ peer: string; input: unknown }> = [];
    roomHost.onCommand((peer, _tick, input) => commands.push({ peer, input }));
    roomHost.setStateSource(() => ({ score: 42 }));
    const snapshots: unknown[] = [];
    roomClient.onSnapshot((s) => snapshots.push(s.state));

    roomClient.join("derek");
    expect(roomHost.peers().map((p) => p.name)).toEqual(["derek"]);
    roomClient.sendCommand({ t: "presence", position: [1, 2, 3], yaw: 0.5 });
    expect(commands).toEqual([{ peer: "c", input: { t: "presence", position: [1, 2, 3], yaw: 0.5 } }]);
    roomHost.tick(1);
    // two full states: the welcome's initial snapshot + the tick broadcast
    expect(snapshots).toEqual([{ score: 42 }, { score: 42 }]);
  });

  it("replicates gameplay events reliable-ordered, host → peer", () => {
    const host = new RelayHostTransport(hub.channel("h"));
    const client = new RelayClientTransport(hub.channel("c"), "h");
    const roomHost = new RoomHost(host);
    const roomClient = new RoomClient(client, "h");
    const received: Array<{ tick: number; events: unknown[] }> = [];
    roomClient.onEvents((e) => received.push(e));

    roomHost.broadcastEvents([{ name: "too-early", payload: {} }]); // nobody joined
    roomClient.join("derek");
    roomHost.tick(7);
    roomHost.broadcastEvents([
      { name: "round.started", payload: { round: 1 } },
      { name: "player.joined", payload: { peerId: "c", name: "derek" } },
    ]);
    roomHost.broadcastEvents([]); // empty batches never hit the wire
    expect(received).toEqual([
      {
        tick: 7,
        events: [
          { name: "round.started", payload: { round: 1 } },
          { name: "player.joined", payload: { peerId: "c", name: "derek" } },
        ],
      },
    ]);
  });
});

describe("mergeTransports", () => {
  /** Minimal scriptable transport for exercising the merge rules. */
  function stub(localId: string): Transport & {
    fakeConnect(peer: string): void;
    fakeDisconnect(peer: string): void;
    fakeMessage(from: string, channel: Channel, data: Uint8Array): void;
    sent: Array<{ peer: string; channel: Channel; data: Uint8Array }>;
    closed: boolean;
  } {
    const connected = new Set<string>();
    const messageHandlers = new Set<(f: string, c: Channel, d: Uint8Array) => void>();
    const peerHandlers = new Set<(p: string, s: PeerState) => void>();
    return {
      localId,
      sent: [],
      closed: false,
      peers: () => [...connected],
      send(peer, channel, data) {
        this.sent.push({ peer, channel, data });
      },
      broadcast() {},
      onMessage(cb) {
        messageHandlers.add(cb);
        return () => messageHandlers.delete(cb);
      },
      onPeer(cb) {
        peerHandlers.add(cb);
        return () => peerHandlers.delete(cb);
      },
      close() {
        this.closed = true;
      },
      fakeConnect(peer) {
        connected.add(peer);
        for (const cb of peerHandlers) cb(peer, "connected");
      },
      fakeDisconnect(peer) {
        connected.delete(peer);
        for (const cb of peerHandlers) cb(peer, "disconnected");
      },
      fakeMessage(from, channel, data) {
        for (const cb of messageHandlers) cb(from, channel, data);
      },
    };
  }

  it("rejects empty and mismatched-id merges", () => {
    expect(() => mergeTransports([])).toThrow(/no transports/);
    expect(() => mergeTransports([stub("a"), stub("b")])).toThrow(/mismatched/);
  });

  it("unions peers, routes sends to the owner, forwards messages", () => {
    const rtc = stub("h");
    const relay = stub("h");
    const merged = mergeTransports([rtc, relay]);
    const events: Array<{ peer: string; state: PeerState }> = [];
    const messages: string[] = [];
    merged.onPeer((peer, state) => events.push({ peer, state }));
    merged.onMessage((from) => messages.push(from));

    rtc.fakeConnect("a");
    relay.fakeConnect("b");
    expect(merged.peers().sort()).toEqual(["a", "b"]);
    expect(events).toEqual([
      { peer: "a", state: "connected" },
      { peer: "b", state: "connected" },
    ]);

    merged.send("a", "reliable", bytes(1));
    merged.send("b", "reliable", bytes(2));
    expect(rtc.sent.map((s) => s.peer)).toEqual(["a"]);
    expect(relay.sent.map((s) => s.peer)).toEqual(["b"]);

    merged.broadcast("unreliable", bytes(3));
    expect(rtc.sent).toHaveLength(2);
    expect(relay.sent).toHaveLength(2);

    rtc.fakeMessage("a", "reliable", bytes(4));
    relay.fakeMessage("b", "reliable", bytes(5));
    expect(messages).toEqual(["a", "b"]);
  });

  it("a reconnect on the other transport moves ownership without re-announcing", () => {
    const rtc = stub("h");
    const relay = stub("h");
    const merged = mergeTransports([rtc, relay]);
    const events: Array<{ peer: string; state: PeerState }> = [];
    merged.onPeer((peer, state) => events.push({ peer, state }));

    rtc.fakeConnect("a");
    relay.fakeConnect("a"); // same peer re-dials over the relay
    expect(events).toEqual([{ peer: "a", state: "connected" }]); // no duplicate
    merged.send("a", "reliable", bytes(1));
    expect(relay.sent).toHaveLength(1); // latest connect owns the peer
    expect(rtc.sent).toHaveLength(0);

    rtc.fakeDisconnect("a"); // the stale link dropping must not disconnect the peer
    expect(events).toHaveLength(1);
    expect(merged.peers()).toEqual(["a"]);

    relay.fakeDisconnect("a"); // the owner dropping does
    expect(events).toEqual([
      { peer: "a", state: "connected" },
      { peer: "a", state: "disconnected" },
    ]);
    expect(merged.peers()).toEqual([]);
  });

  it("close() closes every underlying transport", () => {
    const rtc = stub("h");
    const relay = stub("h");
    const merged = mergeTransports([rtc, relay]);
    merged.close();
    expect(rtc.closed).toBe(true);
    expect(relay.closed).toBe(true);
  });
});
