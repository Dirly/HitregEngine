import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LoopbackHub,
  RoomClient,
  RoomHost,
  decodeMessage,
  encodeMessage,
} from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("module channel", () => {
  it("round-trips through the wire format", () => {
    const decoded = decodeMessage(encodeMessage({ t: "module", id: "chat", data: { k: "say" } }));
    expect(decoded).toEqual({ t: "module", id: "chat", data: { k: "say" } });
    // an empty module id is malformed
    const raw = new TextEncoder().encode(JSON.stringify({ t: "module", id: "", data: 1 }));
    const packet = new Uint8Array(1 + raw.length);
    packet[0] = 0x01;
    packet.set(raw, 1);
    expect(decodeMessage(packet)).toBeNull();
  });

  it("client → host requests reach the module handler with sender attribution", () => {
    const hub = new LoopbackHub({ manualFlush: true });
    const host = new RoomHost(hub.connect("host"));
    host.setStateSource(() => null);
    const seen: Array<[string, unknown]> = [];
    host.onModule("chat", (peer, data) => seen.push([peer, data]));
    const client = new RoomClient(hub.connect("c1"), "host");
    client.join("derek");
    hub.flush();

    client.sendModule("chat", { k: "say", text: "hi" });
    client.sendModule("other", { k: "x" }); // no handler — warns once, dropped
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    hub.flush();
    expect(seen).toEqual([["c1", { k: "say", text: "hi" }]]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("module requests before hello are dropped (never reach a handler)", () => {
    const hub = new LoopbackHub({ manualFlush: true });
    const host = new RoomHost(hub.connect("host"));
    const seen: unknown[] = [];
    host.onModule("chat", (_peer, data) => seen.push(data));
    const stranger = hub.connect("c1");
    stranger.send("host", "reliable", encodeMessage({ t: "module", id: "chat", data: 1 }));
    hub.flush();
    expect(seen).toEqual([]);
  });

  it("host → client: sendModule targets one peer, broadcastModule fans out with an exclusion", () => {
    const hub = new LoopbackHub({ manualFlush: true });
    const host = new RoomHost(hub.connect("host"));
    host.setStateSource(() => null);
    const c1 = new RoomClient(hub.connect("c1"), "host");
    const c2 = new RoomClient(hub.connect("c2"), "host");
    const got1: unknown[] = [];
    const got2: unknown[] = [];
    c1.onModule("chat", (d) => got1.push(d));
    c2.onModule("chat", (d) => got2.push(d));
    c1.join("a");
    c2.join("b");
    hub.flush();

    host.sendModule("c1", "chat", "only-c1");
    host.broadcastModule("chat", "everyone");
    host.broadcastModule("chat", "not-c2", "c2");
    host.sendModule("ghost", "chat", "nobody"); // not joined — silently dropped
    hub.flush();

    expect(got1).toEqual(["only-c1", "everyone", "not-c2"]);
    expect(got2).toEqual(["everyone"]);
  });

  it("client ignores module data for ids it has no handler for and after leaving", () => {
    const hub = new LoopbackHub({ manualFlush: true });
    const host = new RoomHost(hub.connect("host"));
    host.setStateSource(() => null);
    const c1 = new RoomClient(hub.connect("c1"), "host");
    const got: unknown[] = [];
    const off = c1.onModule("chat", (d) => got.push(d));
    c1.join("a");
    hub.flush();
    host.sendModule("c1", "voice", "ignored");
    host.sendModule("c1", "chat", "kept");
    hub.flush();
    off();
    host.sendModule("c1", "chat", "unsubscribed");
    hub.flush();
    expect(got).toEqual(["kept"]);
    c1.leave();
    hub.flush();
    expect(() => c1.sendModule("chat", 1)).not.toThrow(); // no-op after leave
  });
});
