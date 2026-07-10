import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LoopbackHub,
  RoomClient,
  RoomHost,
  encodeMessage,
  type RoomPeer,
  type RoomSnapshot,
} from "../src/index.js";

/** Deterministic world: manual flush, no microtask races, no timers. */
function makeRoom(opts?: { maxPeers?: number; snapshotEvery?: number }) {
  const hub = new LoopbackHub({ manualFlush: true });
  const host = new RoomHost(hub.connect("host"), opts);
  host.setStateSource(() => ({ world: "full" }));
  return { hub, host };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RoomHost / RoomClient", () => {
  it("client joins, receives welcome (as a full snapshot) and periodic snapshots", () => {
    const { hub, host } = makeRoom({ snapshotEvery: 3 });
    const client = new RoomClient(hub.connect("c1"), "host");
    const snapshots: RoomSnapshot[] = [];
    client.onSnapshot((s) => snapshots.push(s));

    expect(client.state).toBe("connecting");
    client.join("derek");
    hub.flush();

    expect(client.state).toBe("joined");
    expect(client.peerId).toBe("c1");
    expect(host.peers()).toEqual([{ peerId: "c1", name: "derek" }]);
    expect(snapshots).toEqual([{ tick: 0, baseTick: null, state: { world: "full" } }]);

    host.tick(1);
    host.tick(2);
    hub.flush();
    expect(snapshots).toHaveLength(1); // not a snapshot tick yet

    host.tick(3);
    hub.flush();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toEqual({ tick: 3, baseTick: null, state: { world: "full" } });

    host.tick(6);
    hub.flush();
    expect(snapshots[2]!.tick).toBe(6);
  });

  it("uses the delta hook with the previous snapshot tick as base", () => {
    const { hub, host } = makeRoom({ snapshotEvery: 1 });
    const deltaCalls: number[] = [];
    host.setStateSource(
      () => ({ world: "full" }),
      (baseTick) => {
        deltaCalls.push(baseTick);
        return { since: baseTick };
      },
    );
    const client = new RoomClient(hub.connect("c1"), "host");
    const snapshots: RoomSnapshot[] = [];
    client.onSnapshot((s) => snapshots.push(s));
    client.join("d");
    hub.flush();

    host.tick(1); // no prior snapshot → full
    host.tick(2); // delta on base 1
    hub.flush();

    expect(snapshots[1]).toEqual({ tick: 1, baseTick: null, state: { world: "full" } });
    expect(snapshots[2]).toEqual({ tick: 2, baseTick: 1, state: { since: 1 } });
    expect(deltaCalls).toEqual([1]);
  });

  it("delivers commands with auto tick/seq and drops replayed or reordered seqs", () => {
    const { hub, host } = makeRoom();
    const received: Array<[string, number, unknown]> = [];
    host.onCommand((peer, tick, input) => received.push([peer, tick, input]));

    const client = new RoomClient(hub.connect("c1"), "host");
    client.join("d");
    hub.flush();

    client.sendCommand({ move: 1 });
    client.sendCommand({ move: 2 });
    hub.flush();
    expect(received).toEqual([
      ["c1", 0, { move: 1 }],
      ["c1", 0, { move: 2 }],
    ]);

    // A raw wire-level attacker/glitch replaying old seqs.
    const raw = hub.connect("raw");
    const rawHello = () => raw.send("host", "reliable", encodeMessage({ t: "hello", name: "raw" }));
    rawHello();
    hub.flush();

    const cmd = (seq: number, input: unknown) =>
      raw.send("host", "reliable", encodeMessage({ t: "command", tick: 5, seq, input }));
    cmd(1, "first");
    cmd(1, "duplicate"); // replayed — dropped
    cmd(3, "third");
    cmd(2, "reordered"); // older than last seq — dropped
    hub.flush();

    const fromRaw = received.filter(([peer]) => peer === "raw");
    expect(fromRaw).toEqual([
      ["raw", 5, "first"],
      ["raw", 5, "third"],
    ]);
  });

  it("ignores commands from peers that never said hello, and malformed packets", () => {
    const { hub, host } = makeRoom();
    const onCommand = vi.fn();
    host.onCommand(onCommand);

    const stranger = hub.connect("stranger");
    stranger.send("host", "reliable", encodeMessage({ t: "command", tick: 1, seq: 1, input: 0 }));
    stranger.send("host", "reliable", new Uint8Array([0x02, 1, 2, 3])); // unknown tag
    stranger.send("host", "reliable", new Uint8Array([0x01, 0x7b])); // broken JSON
    hub.flush();

    expect(onCommand).not.toHaveBeenCalled();
    expect(host.peers()).toEqual([]);
  });

  it("structurally ignores state sent by a client: snapshot to host is dropped with one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { hub, host } = makeRoom({ snapshotEvery: 1 });
    let full = { world: "authoritative" };
    host.setStateSource(() => full);

    const client = new RoomClient(hub.connect("mallory"), "host");
    const snapshots: RoomSnapshot[] = [];
    client.onSnapshot((s) => snapshots.push(s));
    client.join("mallory");
    hub.flush();

    // Mallory speaks raw transport to send host-only message types upstream.
    const mallory = hub.connect("mallory2");
    mallory.send("host", "reliable", encodeMessage({ t: "hello", name: "m2" }));
    hub.flush();
    const evil = encodeMessage({
      t: "snapshot",
      tick: 999,
      baseTick: null,
      state: { world: "pwned" },
    });
    mallory.send("host", "reliable", evil);
    mallory.send("host", "reliable", evil); // second copy → still only one warn
    mallory.send(
      "host",
      "reliable",
      encodeMessage({ t: "welcome", peerId: "host", tick: 0, full: { world: "pwned" } }),
    );
    hub.flush();

    // Host's authoritative state is untouched; next snapshot still serves it.
    host.tick(1);
    hub.flush();
    const last = snapshots[snapshots.length - 1]!;
    expect(last.state).toEqual({ world: "authoritative" });
    const snapshotWarns = warn.mock.calls.filter(([m]) => String(m).includes('"snapshot"'));
    expect(snapshotWarns).toHaveLength(1); // warn-once
    const welcomeWarns = warn.mock.calls.filter(([m]) => String(m).includes('"welcome"'));
    expect(welcomeWarns).toHaveLength(1);
  });

  it("rejects joins beyond maxPeers and closes the rejected client", () => {
    const { hub } = makeRoom({ maxPeers: 1 });
    const c1 = new RoomClient(hub.connect("c1"), "host");
    const c2 = new RoomClient(hub.connect("c2"), "host");
    c1.join("one");
    hub.flush();
    c2.join("two");
    hub.flush();

    expect(c1.state).toBe("joined");
    expect(c2.state).toBe("closed");
    expect(c2.peerId).toBeNull();
  });

  it("two clients see each other's join and leave (including roster replay)", () => {
    const { hub, host } = makeRoom();
    const c1 = new RoomClient(hub.connect("c1"), "host");
    const c1Rosters: RoomPeer[][] = [];
    c1.onPeers((peers) => c1Rosters.push(peers));
    c1.join("alice");
    hub.flush();

    const c2 = new RoomClient(hub.connect("c2"), "host");
    c2.join("bob");
    hub.flush();

    // Late joiner got the existing roster replayed before welcome.
    expect(c2.peers()).toEqual([{ peerId: "c1", name: "alice" }]);
    // Existing client saw the join.
    expect(c1Rosters[c1Rosters.length - 1]).toEqual([{ peerId: "c2", name: "bob" }]);

    c2.leave();
    hub.flush();
    expect(c2.state).toBe("closed");
    expect(c1.peers()).toEqual([]);
    expect(c1Rosters[c1Rosters.length - 1]).toEqual([]);
    expect(host.peers()).toEqual([{ peerId: "c1", name: "alice" }]);
  });

  it("propagates transport-level disconnects (vanished peer, no bye)", () => {
    const { hub, host } = makeRoom();
    const c1 = new RoomClient(hub.connect("c1"), "host");
    const c1Rosters: RoomPeer[][] = [];
    c1.onPeers((peers) => c1Rosters.push(peers));
    c1.join("alice");
    const t2 = hub.connect("c2");
    const c2 = new RoomClient(t2, "host");
    c2.join("bob");
    hub.flush();
    expect(host.peers()).toHaveLength(2);

    t2.close(); // network death — the client never sends bye
    hub.flush();

    expect(host.peers()).toEqual([{ peerId: "c1", name: "alice" }]);
    expect(c1.peers()).toEqual([]);
  });

  it("closes the client when the host vanishes", () => {
    const hub = new LoopbackHub({ manualFlush: true });
    const hostTransport = hub.connect("host");
    const host = new RoomHost(hostTransport);
    host.setStateSource(() => null);
    const client = new RoomClient(hub.connect("c1"), "host");
    client.join("alice");
    hub.flush();
    expect(client.state).toBe("joined");

    hostTransport.close();
    hub.flush();
    expect(client.state).toBe("closed");
    expect(() => client.join("again")).toThrow();
  });

  it("sendCommand is a no-op before join and after close", () => {
    const { hub, host } = makeRoom();
    const onCommand = vi.fn();
    host.onCommand(onCommand);
    const client = new RoomClient(hub.connect("c1"), "host");

    client.sendCommand({ move: 1 }); // not joined yet
    hub.flush();
    expect(onCommand).not.toHaveBeenCalled();

    client.join("d");
    hub.flush();
    client.leave();
    client.sendCommand({ move: 2 }); // closed
    hub.flush();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("unsubscribes returned by onCommand/onSnapshot/onPeers work", () => {
    const { hub, host } = makeRoom({ snapshotEvery: 1 });
    const onCommand = vi.fn();
    const offCommand = host.onCommand(onCommand);
    const client = new RoomClient(hub.connect("c1"), "host");
    const onSnapshot = vi.fn();
    const offSnapshot = client.onSnapshot(onSnapshot);
    client.join("d");
    hub.flush();
    expect(onSnapshot).toHaveBeenCalledTimes(1); // welcome

    offSnapshot();
    offCommand();
    client.sendCommand({});
    host.tick(1);
    hub.flush();
    expect(onCommand).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("also works over async (microtask) delivery, not just manual flush", async () => {
    const hub = new LoopbackHub();
    const host = new RoomHost(hub.connect("host"), { snapshotEvery: 1 });
    host.setStateSource(() => ({ ok: true }));
    const client = new RoomClient(hub.connect("c1"), "host");
    const snapshots: RoomSnapshot[] = [];
    client.onSnapshot((s) => snapshots.push(s));

    client.join("d");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(client.state).toBe("joined");

    host.tick(1);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(snapshots[snapshots.length - 1]).toEqual({
      tick: 1,
      baseTick: null,
      state: { ok: true },
    });
  });
});
