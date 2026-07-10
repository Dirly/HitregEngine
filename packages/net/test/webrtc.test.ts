import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRtcSignal,
  WebRtcClientTransport,
  WebRtcHostTransport,
  type SignalingChannel,
} from "../src/index.js";

/**
 * Node has no RTCPeerConnection, so live connections cannot be exercised
 * here (the playground is the integration test). What CAN be verified in
 * Node: the signal envelope validator, the signaling-side message routing,
 * and that bad input warns instead of throwing (signaling callbacks must
 * never throw back into the relay).
 */

function fakeSignaling(selfId: string) {
  const handlers = new Set<(from: string, data: unknown) => void>();
  const sent: Array<{ to: string; data: unknown }> = [];
  const channel: SignalingChannel = {
    selfId,
    send: (to, data) => sent.push({ to, data }),
    onMessage: (cb) => {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
  };
  const deliver = (from: string, data: unknown) => {
    for (const cb of [...handlers]) cb(from, data);
  };
  return { channel, sent, deliver, handlers };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRtcSignal", () => {
  it("accepts well-formed offer/answer/ice envelopes", () => {
    expect(parseRtcSignal({ rtc: "offer", sdp: "v=0" })).toEqual({ rtc: "offer", sdp: "v=0" });
    expect(parseRtcSignal({ rtc: "answer", sdp: "v=0" })).toEqual({ rtc: "answer", sdp: "v=0" });
    expect(parseRtcSignal({ rtc: "ice", candidate: { candidate: "c", sdpMid: "0" } })).toEqual({
      rtc: "ice",
      candidate: { candidate: "c", sdpMid: "0" },
    });
    // null candidate = trickle-ICE end-of-candidates marker
    expect(parseRtcSignal({ rtc: "ice", candidate: null })).toEqual({ rtc: "ice", candidate: null });
  });

  it("rejects malformed envelopes", () => {
    expect(parseRtcSignal(null)).toBeNull();
    expect(parseRtcSignal(undefined)).toBeNull();
    expect(parseRtcSignal("offer")).toBeNull();
    expect(parseRtcSignal(42)).toBeNull();
    expect(parseRtcSignal([1, 2])).toBeNull();
    expect(parseRtcSignal({})).toBeNull();
    expect(parseRtcSignal({ rtc: "offer" })).toBeNull(); // missing sdp
    expect(parseRtcSignal({ rtc: "offer", sdp: 7 })).toBeNull();
    expect(parseRtcSignal({ rtc: "answer", sdp: null })).toBeNull();
    expect(parseRtcSignal({ rtc: "ice" })).toBeNull(); // undefined ≠ null marker
    expect(parseRtcSignal({ rtc: "ice", candidate: "str" })).toBeNull();
    expect(parseRtcSignal({ rtc: "renegotiate" })).toBeNull(); // unknown kind
  });
});

describe("WebRtcHostTransport signaling router (Node — no live RTC)", () => {
  it("constructs without touching browser globals and starts empty", () => {
    const { channel, handlers } = fakeSignaling("host-1");
    const host = new WebRtcHostTransport(channel);
    expect(host.localId).toBe("host-1");
    expect(host.peers()).toEqual([]);
    expect(handlers.size).toBe(1); // subscribed to signaling
    host.close();
    expect(handlers.size).toBe(0); // unsubscribed on close
  });

  it("ignores malformed signals and stray ICE without warning or throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { channel, deliver } = fakeSignaling("host-1");
    const host = new WebRtcHostTransport(channel);
    deliver("peer-a", "garbage");
    deliver("peer-a", { rtc: "nonsense" });
    deliver("peer-a", { rtc: "ice", candidate: null }); // ICE for a link we never had
    deliver("peer-a", { rtc: "answer", sdp: "v=0" }); // answer without an offer
    deliver("host-1", { rtc: "offer", sdp: "v=0" }); // own echo — filtered
    expect(host.peers()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    host.close();
  });

  it("warns instead of throwing when a valid offer cannot be honored (no RTC here)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { channel, deliver } = fakeSignaling("host-1");
    const host = new WebRtcHostTransport(channel);
    // Node lacks RTCPeerConnection: link construction fails, the wrapper
    // catches it — a hostile/buggy signaling payload must never throw.
    expect(() => deliver("peer-a", { rtc: "offer", sdp: "v=0" })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(host.peers()).toEqual([]);
    host.close();
  });

  it("drops everything after close", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { channel, deliver } = fakeSignaling("host-1");
    const host = new WebRtcHostTransport(channel);
    host.close();
    deliver("peer-a", { rtc: "offer", sdp: "v=0" }); // unsubscribed — never seen
    expect(warn).not.toHaveBeenCalled();
    expect(() => host.send("peer-a", "reliable", new Uint8Array([1]))).not.toThrow();
    expect(() => host.broadcast("unreliable", new Uint8Array([1]))).not.toThrow();
    host.close(); // idempotent
  });
});

describe("WebRtcClientTransport (Node — no live RTC)", () => {
  it("is importable in Node; constructing (which dials) is the browser-only part", () => {
    expect(typeof WebRtcClientTransport).toBe("function");
    const { channel } = fakeSignaling("peer-a");
    // The constructor dials the host immediately, which requires
    // RTCPeerConnection — absent in Node, so it throws here by design.
    expect(() => new WebRtcClientTransport(channel, "host-1")).toThrow();
  });
});
