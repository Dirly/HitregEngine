import { describe, expect, it, vi } from "vitest";
import { LoopbackHub, type Channel } from "../src/index.js";

/** Drain chained microtask deliveries (each hop consumes one turn). */
async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe("LoopbackHub", () => {
  it("delivers point-to-point between n peers, to the addressee only", async () => {
    const hub = new LoopbackHub();
    const a = hub.connect("a");
    const b = hub.connect("b");
    const c = hub.connect("c");

    const atB: Array<[string, Channel, Uint8Array]> = [];
    const atC: Array<[string, Channel, Uint8Array]> = [];
    b.onMessage((from, channel, data) => atB.push([from, channel, data]));
    c.onMessage((from, channel, data) => atC.push([from, channel, data]));

    a.send("b", "reliable", bytes(1, 2, 3));
    expect(atB).toHaveLength(0); // never synchronous

    await settle();
    expect(atB).toEqual([["a", "reliable", bytes(1, 2, 3)]]);
    expect(atC).toHaveLength(0);
    expect(a.peers().sort()).toEqual(["b", "c"]);
  });

  it("broadcast reaches every peer except the sender", async () => {
    const hub = new LoopbackHub();
    const a = hub.connect("a");
    const b = hub.connect("b");
    const c = hub.connect("c");

    const got: string[] = [];
    a.onMessage(() => got.push("a"));
    b.onMessage(() => got.push("b"));
    c.onMessage(() => got.push("c"));

    a.broadcast("unreliable", bytes(9));
    await settle();
    expect(got.sort()).toEqual(["b", "c"]);
  });

  it("preserves per-channel send order", async () => {
    const hub = new LoopbackHub();
    const a = hub.connect("a");
    const b = hub.connect("b");

    const reliable: number[] = [];
    const unreliable: number[] = [];
    b.onMessage((_from, channel, data) => {
      (channel === "reliable" ? reliable : unreliable).push(data[0]!);
    });

    a.send("b", "reliable", bytes(1));
    a.send("b", "unreliable", bytes(10));
    a.send("b", "reliable", bytes(2));
    a.send("b", "unreliable", bytes(11));
    a.send("b", "reliable", bytes(3));

    await settle();
    expect(reliable).toEqual([1, 2, 3]);
    expect(unreliable).toEqual([10, 11]);
  });

  it("unsubscribe stops message and peer callbacks", async () => {
    const hub = new LoopbackHub();
    const a = hub.connect("a");
    const b = hub.connect("b");

    const onMsg = vi.fn();
    const onPeer = vi.fn();
    const unsubMsg = b.onMessage(onMsg);
    const unsubPeer = b.onPeer(onPeer);

    a.send("b", "reliable", bytes(1));
    await settle();
    expect(onMsg).toHaveBeenCalledTimes(1);

    unsubMsg();
    unsubPeer();
    a.send("b", "reliable", bytes(2));
    hub.connect("c");
    await settle();
    expect(onMsg).toHaveBeenCalledTimes(1);
    expect(onPeer).not.toHaveBeenCalled();
  });

  it("notifies existing peers of connects and disconnects", async () => {
    const hub = new LoopbackHub();
    const a = hub.connect("a");
    const events: Array<[string, string]> = [];
    a.onPeer((peer, state) => events.push([peer, state]));

    const b = hub.connect("b");
    await settle();
    expect(events).toEqual([["b", "connected"]]);
    expect(a.peers()).toEqual(["b"]);

    b.close();
    await settle();
    expect(events).toEqual([
      ["b", "connected"],
      ["b", "disconnected"],
    ]);
    expect(a.peers()).toEqual([]);
    expect(() => b.send("a", "reliable", bytes(1))).toThrow();
  });

  it("rejects duplicate peer ids", () => {
    const hub = new LoopbackHub();
    hub.connect("a");
    expect(() => hub.connect("a")).toThrow(/already connected/);
  });

  it("manualFlush holds delivery until flush(), including chained replies", () => {
    const hub = new LoopbackHub({ manualFlush: true });
    const a = hub.connect("a");
    const b = hub.connect("b");

    const atA: number[] = [];
    const atB: number[] = [];
    a.onMessage((_f, _c, data) => atA.push(data[0]!));
    b.onMessage((_f, _c, data) => {
      atB.push(data[0]!);
      b.send("a", "reliable", bytes(data[0]! + 100)); // reply during delivery
    });

    a.send("b", "reliable", bytes(1));
    expect(atB).toHaveLength(0);

    hub.flush(); // drains the reply too — the queue loops until empty
    expect(atB).toEqual([1]);
    expect(atA).toEqual([101]);
  });

  it("applies a deterministic drop pattern to the unreliable channel only", async () => {
    // Drop every 2nd unreliable delivery.
    const hub = new LoopbackHub({ drop: [false, true] });
    const a = hub.connect("a");
    const b = hub.connect("b");

    const reliable: number[] = [];
    const unreliable: number[] = [];
    b.onMessage((_f, channel, data) => {
      (channel === "reliable" ? reliable : unreliable).push(data[0]!);
    });

    for (let i = 1; i <= 4; i++) {
      a.send("b", "unreliable", bytes(i));
      a.send("b", "reliable", bytes(i));
    }
    await settle();
    expect(unreliable).toEqual([1, 3]); // 2 and 4 dropped
    expect(reliable).toEqual([1, 2, 3, 4]); // reliable never drops
  });

  it("supports a counter predicate as the drop rule", async () => {
    const hub = new LoopbackHub({ drop: (n) => n % 3 === 0 });
    const a = hub.connect("a");
    const b = hub.connect("b");
    const got: number[] = [];
    b.onMessage((_f, _c, data) => got.push(data[0]!));

    for (let i = 1; i <= 6; i++) a.send("b", "unreliable", bytes(i));
    await settle();
    expect(got).toEqual([1, 2, 4, 5]);
  });

  it("copies payloads so sender mutations cannot alias the receiver", async () => {
    const hub = new LoopbackHub();
    const a = hub.connect("a");
    const b = hub.connect("b");
    let received: Uint8Array | null = null;
    b.onMessage((_f, _c, data) => (received = data));

    const payload = bytes(7);
    a.send("b", "reliable", payload);
    payload[0] = 99; // mutate after send, before delivery
    await settle();
    expect(received).toEqual(bytes(7));
  });
});
