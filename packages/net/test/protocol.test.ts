import { describe, expect, it } from "vitest";
import { FORMAT_JSON, decodeMessage, encodeMessage, type Message } from "../src/index.js";

describe("protocol encode/decode", () => {
  const roundtrips: Message[] = [
    { t: "hello", name: "derek" },
    { t: "command", tick: 42, seq: 7, input: { move: [0, 1], jump: true } },
    { t: "bye" },
    { t: "welcome", peerId: "p1", tick: 100, full: { entities: [{ id: "e1" }] } },
    { t: "snapshot", tick: 103, baseTick: 100, state: { entities: [] } },
    { t: "snapshot", tick: 3, baseTick: null, state: null },
    { t: "peerJoined", peerId: "p2", name: "guest" },
    { t: "peerLeft", peerId: "p2" },
    { t: "reject", reason: "room full" },
  ];

  it.each(roundtrips.map((m) => [m.t, m] as const))("roundtrips %s", (_t, message) => {
    const wire = encodeMessage(message);
    expect(wire[0]).toBe(FORMAT_JSON); // 1-byte format tag prefix
    expect(decodeMessage(wire)).toEqual(message);
  });

  it("rejects an unknown format tag", () => {
    const wire = encodeMessage({ t: "bye" });
    const tagged = wire.slice();
    tagged[0] = 0x02; // future binary format — this decoder must not guess
    expect(decodeMessage(tagged)).toBeNull();
    expect(decodeMessage(new Uint8Array(0))).toBeNull();
  });

  it("rejects invalid JSON payloads", () => {
    const bad = new Uint8Array([FORMAT_JSON, 0x7b, 0x6f]); // "{o"
    expect(decodeMessage(bad)).toBeNull();
  });

  it("rejects unknown message types and non-object payloads", () => {
    const enc = new TextEncoder();
    const make = (json: string) => {
      const body = enc.encode(json);
      const wire = new Uint8Array(1 + body.length);
      wire[0] = FORMAT_JSON;
      wire.set(body, 1);
      return wire;
    };
    expect(decodeMessage(make('{"t":"stateOverride","state":{}}'))).toBeNull();
    expect(decodeMessage(make("[1,2,3]"))).toBeNull();
    expect(decodeMessage(make('"hello"'))).toBeNull();
    expect(decodeMessage(make("null"))).toBeNull();
  });

  it("rejects known types with wrong field types", () => {
    const enc = new TextEncoder();
    const make = (json: string) => {
      const body = enc.encode(json);
      const wire = new Uint8Array(1 + body.length);
      wire[0] = FORMAT_JSON;
      wire.set(body, 1);
      return wire;
    };
    expect(decodeMessage(make('{"t":"hello","name":42}'))).toBeNull();
    expect(decodeMessage(make('{"t":"command","tick":"nope","seq":1}'))).toBeNull();
    expect(decodeMessage(make('{"t":"snapshot","tick":1,"baseTick":"x"}'))).toBeNull();
    expect(decodeMessage(make('{"t":"welcome","peerId":1,"tick":0}'))).toBeNull();
    expect(decodeMessage(make('{"t":"peerLeft"}'))).toBeNull();
    expect(decodeMessage(make('{"t":"reject"}'))).toBeNull();
  });
});
