import { describe, expect, it } from "vitest";
import { ChatService, foreignRecipients, recipientsFor, staticMembership, type ChatMessage, type CommsLink, type RoutingContext } from "../src/index.js";

/**
 * Party chat across a cluster: a party line is bridged with the sender's
 * party in its scope, and a layer that receives one delivers it to the
 * members standing there — and to nobody else. Plus `announceTo`, the
 * one-participant system line a layer uses for "You are entering …".
 */

const parties: Record<string, string> = { a: "ABC123", b: "ABC123", c: "ZZZ999" };
const ctx: RoutingContext = {
  teamOf: () => null,
  partyOf: (id) => parties[id] ?? null,
  positionOf: () => [0, 0, 0],
  zoneOf: () => "valley",
};

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

describe("party channel across layers", () => {
  it("a foreign party line reaches the members of that party here, nobody else", () => {
    expect(foreignRecipients("party", { zone: null, party: "ABC123" }, ["a", "b", "c", "d"], ctx)).toEqual(["a", "b"]);
    expect(foreignRecipients("party", { zone: null, party: "NOPE" }, ["a", "b", "c"], ctx)).toEqual([]);
    expect(foreignRecipients("party", { zone: null, party: null }, ["a", "b", "c"], ctx)).toEqual([]);
    expect(foreignRecipients("party", { zone: null }, ["a", "b", "c"], ctx)).toEqual([]);
  });

  it("publishes a party line with the sender's party and delivers foreign ones by party", () => {
    const { link, sent } = fakeHost(["a", "b", "c", "d"]);
    const published: Array<{ msg: ChatMessage; zone: string | null; party?: string | null }> = [];
    const chat = new ChatService({
      link,
      membership: staticMembership({ parties }),
      positionOf: () => [0, 0, 0],
      zoneOf: () => "valley",
      bridge: { publish: (msg, scope) => published.push({ msg, zone: scope.zone, party: scope.party }) },
      now: () => 1000,
    });
    const up = chat as unknown as { handleUp(from: string, data: unknown): void };
    up.handleUp("a", { k: "say", channel: "party", text: "regroup at the pass" });
    expect(sent.get("a")).toHaveLength(1);
    expect(sent.get("b")).toHaveLength(1);
    expect(sent.get("c")).toBeUndefined();
    expect(sent.get("d")).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ party: "ABC123", zone: "valley", msg: { channel: "party", from: "a" } });
    // no party: refused locally, never bridged
    up.handleUp("d", { k: "say", channel: "party", text: "hello?" });
    expect(published).toHaveLength(1);
    expect((sent.get("d")![0] as { k: string }).k).toBe("err");

    // a party line from another layer: only the members here hear it
    const foreign: ChatMessage = { id: "far:1", channel: "party", from: "far-away", name: "Far", text: "on my way", at: 5 };
    expect(chat.deliverForeign(foreign, { zone: null, party: "ZZZ999" })).toBe(1);
    expect(sent.get("c")).toHaveLength(1);
    expect(chat.deliverForeign(foreign, { zone: null, party: "ABC123" })).toBe(2);
    expect(chat.deliverForeign(foreign, { zone: null })).toBe(0);
    expect(published).toHaveLength(1); // never re-bridged
  });

  it("announceTo sends one participant a system line and nobody else", () => {
    const { link, sent } = fakeHost(["a", "b"]);
    const chat = new ChatService({ link, membership: staticMembership(), positionOf: () => [0, 0, 0], now: () => 7 });
    chat.announceTo("b", "You are entering the Hollow Vale.");
    expect(sent.get("a")).toBeUndefined();
    expect(sent.get("b")).toHaveLength(1);
    expect((sent.get("b")![0] as { k: string; msg: ChatMessage }).msg).toMatchObject({ channel: "system", from: "system", text: "You are entering the Hollow Vale." });
    // the host itself is a participant too
    chat.announceTo("host", "You are entering the Rim.");
    expect(chat.history().at(-1)?.text).toBe("You are entering the Rim.");
  });
});

describe("block lists", () => {
  it("a recipient who blocked the sender hears nothing on any channel, local or foreign", () => {
    const { link, sent } = fakeHost(["a", "b", "c"]);
    const blocks: Record<string, string[]> = { c: ["a", "far-away"] };
    const chat = new ChatService({
      link,
      membership: staticMembership({ parties }),
      positionOf: () => [0, 0, 0],
      zoneOf: () => "valley",
      mayHear: (recipient, sender) => !(blocks[recipient] ?? []).includes(sender),
      now: () => 1,
    });
    const up = chat as unknown as { handleUp(from: string, data: unknown): void };
    up.handleUp("a", { k: "say", channel: "global", text: "hello all" });
    expect(sent.get("a")).toHaveLength(1);
    expect(sent.get("b")).toHaveLength(1);
    expect(sent.get("c")).toBeUndefined(); // c blocked a
    up.handleUp("b", { k: "say", channel: "global", text: "hi" });
    expect(sent.get("c")).toHaveLength(1); // b is fine
    const foreign: ChatMessage = { id: "far:1", channel: "global", from: "far-away", name: "Far", text: "yo", at: 5 };
    expect(chat.deliverForeign(foreign, { zone: null })).toBe(3); // a, b and the host — not c
    expect(sent.get("c")).toHaveLength(1);
  });
});

describe("guild channel", () => {
  it("routes to guild mates, is bridged with the guild in scope, and is refused without a guild", () => {
    const guilds: Record<string, string> = { a: "gld-1", b: "gld-1", c: "gld-2" };
    const gctx: RoutingContext = { ...ctx, guildOf: (id) => guilds[id] ?? null };
    expect(recipientsFor("a", "guild", ["a", "b", "c", "d"], gctx, 25)).toEqual({ ok: true, recipients: ["a", "b"] });
    expect(recipientsFor("d", "guild", ["a", "d"], gctx, 25)).toMatchObject({ ok: false, reason: /not in a guild/ });
    expect(recipientsFor("a", "guild", ["a", "b"], ctx, 25)).toMatchObject({ ok: false, reason: /not available/ });
    expect(foreignRecipients("guild", { zone: null, guild: "gld-2" }, ["a", "b", "c"], gctx)).toEqual(["c"]);
    expect(foreignRecipients("guild", { zone: null, guild: "gld-2" }, ["a", "b", "c"], ctx)).toEqual([]);
    const { link, sent } = fakeHost(["a", "b", "c"]);
    const published: Array<{ guild?: string | null }> = [];
    const chat = new ChatService({
      link,
      membership: staticMembership({ guilds }),
      positionOf: () => [0, 0, 0],
      bridge: { publish: (_msg, scope) => published.push(scope) },
      now: () => 1,
    });
    (chat as unknown as { handleUp(from: string, data: unknown): void }).handleUp("a", { k: "say", channel: "guild", text: "raid at nine" });
    expect(sent.get("b")).toHaveLength(1);
    expect(sent.get("c")).toBeUndefined();
    expect(published[0]?.guild).toBe("gld-1");
  });
});
