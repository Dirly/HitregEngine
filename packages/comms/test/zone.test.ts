import { describe, expect, it } from "vitest";
import {
  BRIDGED_CHANNELS,
  ChatService,
  channelForPrefix,
  foreignRecipients,
  parseChatInput,
  recipientsFor,
  staticMembership,
  type ChatMessage,
  type CommsLink,
  type RoutingContext,
} from "../src/index.js";

const positions: Record<string, [number, number, number]> = {
  a: [0, 0, 0],
  b: [5, 0, 0],
  c: [900, 0, 900],
};
const zones: Record<string, string> = { a: "valley", b: "valley", c: "peaks" };
const ctx: RoutingContext = {
  teamOf: () => null,
  partyOf: () => null,
  positionOf: (id) => positions[id] ?? null,
  zoneOf: (id) => zones[id] ?? null,
};

describe("zone channel", () => {
  it("is a real channel with a prefix and a glyph", () => {
    expect(channelForPrefix("/z")).toBe("zone");
    expect(parseChatInput("/zone hello valley", "proximity")).toEqual({ kind: "message", channel: "zone", text: "hello valley" });
    expect(BRIDGED_CHANNELS).toEqual(["zone", "global", "party", "guild"]);
  });

  it("routes to everyone in the sender's zone and nobody outside it", () => {
    const r = recipientsFor("a", "zone", ["a", "b", "c"], ctx, 25);
    expect(r).toEqual({ ok: true, recipients: ["a", "b"] });
    // proximity is narrower than the zone: b is 5 m away, still in range; a zone spans far more
    expect(recipientsFor("c", "zone", ["a", "b", "c"], ctx, 25)).toEqual({ ok: true, recipients: ["c"] });
  });

  it("is refused where there is no zone lookup (voice) and for a sender out of the world", () => {
    const noZones: RoutingContext = { ...ctx };
    delete (noZones as { zoneOf?: unknown }).zoneOf;
    expect(recipientsFor("a", "zone", ["a", "b"], noZones, 25)).toMatchObject({ ok: false, reason: /not available/ });
    expect(recipientsFor("ghost", "zone", ["a", "ghost"], ctx, 25)).toMatchObject({ ok: false, reason: /not in the world/ });
  });

  it("a line from another layer reaches the players standing in that zone here, or everyone for global", () => {
    expect(foreignRecipients("zone", { zone: "valley" }, ["a", "b", "c"], ctx)).toEqual(["a", "b"]);
    expect(foreignRecipients("zone", { zone: "nowhere" }, ["a", "b", "c"], ctx)).toEqual([]);
    expect(foreignRecipients("global", { zone: null }, ["a", "b", "c"], ctx)).toEqual(["a", "b", "c"]);
    expect(foreignRecipients("proximity", { zone: "valley" }, ["a", "b"], ctx)).toEqual([]);
  });
});

/** A host link over an in-memory star: what each peer received, by peer id. */
function fakeHost(peers: string[]) {
  const sent = new Map<string, unknown[]>();
  const link: CommsLink = {
    selfId: "host",
    selfName: "host",
    role: "host",
    hostId: "host",
    peers: () => peers,
    roster: () => [{ peerId: "host", name: "host" }, ...peers.map((p) => ({ peerId: p, name: p }))],
    nameOf: (id) => id,
    send: (_module, to, data) => {
      sent.set(to, [...(sent.get(to) ?? []), data]);
    },
    onMessage: () => () => undefined,
    onRoster: () => () => undefined,
  };
  return { link, sent };
}

describe("ChatService on a clustered host", () => {
  it("publishes zone/global lines to the bridge with the sender's zone, and delivers foreign lines by zone", () => {
    const { link, sent } = fakeHost(["a", "b", "c"]);
    const published: Array<{ msg: ChatMessage; zone: string | null }> = [];
    const chat = new ChatService({
      link,
      membership: staticMembership(),
      positionOf: (id) => positions[id] ?? null,
      zoneOf: (id) => zones[id] ?? null,
      bridge: { publish: (msg, scope) => published.push({ msg, zone: scope.zone }) },
      now: () => 1000,
    });
    // a peer in the valley says something on zone → a and b get it, c does not, the bridge hears it once
    (chat as unknown as { handleUp(from: string, data: unknown): void }).handleUp("a", { k: "say", channel: "zone", text: "anyone here?" });
    expect(sent.get("a")).toHaveLength(1);
    expect(sent.get("b")).toHaveLength(1);
    expect(sent.get("c")).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ zone: "valley", msg: { channel: "zone", from: "a", text: "anyone here?" } });
    // proximity never reaches the bridge
    (chat as unknown as { handleUp(from: string, data: unknown): void }).handleUp("a", { k: "say", channel: "proximity", text: "psst" });
    expect(published).toHaveLength(1);

    // a line that arrived from another layer for the peaks: only c hears it
    const foreign: ChatMessage = { id: "x:1", channel: "zone", from: "far-away", name: "Far", text: "peaks are cold", at: 5 };
    expect(chat.deliverForeign(foreign, { zone: "peaks" })).toBe(1);
    expect(sent.get("c")).toHaveLength(1);
    expect((sent.get("c")![0] as { msg: ChatMessage }).msg).toEqual(foreign);
    expect(sent.get("a")).toHaveLength(2); // unchanged by the peaks line
    // a foreign global line reaches all three peers (plus the host's own history)
    expect(chat.deliverForeign({ ...foreign, id: "x:2", channel: "global" }, { zone: null })).toBe(4);
    expect(sent.get("b")).toHaveLength(3);
    // never re-bridged: foreign delivery is the end of the line
    expect(published).toHaveLength(1);
  });
});
