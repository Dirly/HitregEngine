import { describe, expect, it } from "vitest";
import {
  channelForPrefix,
  parseChatInput,
  recipientsFor,
  type RoutingContext,
} from "../src/index.js";

const ctx = (
  teams: Record<string, string> = {},
  parties: Record<string, string> = {},
  positions: Record<string, [number, number, number]> = {},
): RoutingContext => ({
  teamOf: (id) => teams[id] ?? null,
  partyOf: (id) => parties[id] ?? null,
  positionOf: (id) => positions[id] ?? null,
});

describe("parseChatInput", () => {
  it("plain text goes to the active channel", () => {
    expect(parseChatInput("  hello  ", "team")).toEqual({ kind: "message", channel: "team", text: "hello" });
  });
  it("a channel prefix selects the channel for one message", () => {
    expect(parseChatInput("/g everyone", "team")).toEqual({ kind: "message", channel: "global", text: "everyone" });
    expect(parseChatInput("/T   go", "proximity")).toEqual({ kind: "message", channel: "team", text: "go" });
    expect(parseChatInput("/say hi", "global")).toEqual({ kind: "message", channel: "proximity", text: "hi" });
  });
  it("a bare prefix is the channel-switch command; other slash words are app commands", () => {
    expect(parseChatInput("/p", "global")).toEqual({ kind: "command", name: "channel", args: ["party"] });
    expect(parseChatInput("/party red team", "global")).toEqual({ kind: "command", name: "party", args: ["red", "team"] });
    expect(parseChatInput("/Ready", "global")).toEqual({ kind: "command", name: "ready", args: [] });
  });
  it("empty input is empty", () => {
    expect(parseChatInput("   ", "global")).toEqual({ kind: "empty" });
    expect(channelForPrefix("/x")).toBeNull();
  });
});

describe("recipientsFor", () => {
  const all = ["a", "b", "c", "d"];

  it("global reaches everyone", () => {
    expect(recipientsFor("a", "global", all, ctx(), 10)).toEqual({ ok: true, recipients: all });
  });

  it("team reaches exactly the sender's team (sender included) and needs a team", () => {
    const c = ctx({ a: "red", b: "red", c: "blue" });
    expect(recipientsFor("a", "team", all, c, 10)).toEqual({ ok: true, recipients: ["a", "b"] });
    expect(recipientsFor("d", "team", all, c, 10)).toEqual({ ok: false, reason: "you are not on a team" });
  });

  it("party reaches the sender's party and needs one", () => {
    const c = ctx({}, { a: "p1", d: "p1", b: "p2" });
    expect(recipientsFor("d", "party", all, c, 10)).toEqual({ ok: true, recipients: ["a", "d"] });
    expect(recipientsFor("c", "party", all, c, 10)).toEqual({ ok: false, reason: "you are not in a party" });
  });

  it("proximity is a radius around the sender; peers without a position are out; sender must be in the world", () => {
    const c = ctx({}, {}, { a: [0, 0, 0], b: [3, 4, 0], c: [30, 0, 0] });
    expect(recipientsFor("a", "proximity", all, c, 5)).toEqual({ ok: true, recipients: ["a", "b"] });
    expect(recipientsFor("a", "proximity", all, c, 4.9)).toEqual({ ok: true, recipients: ["a"] });
    expect(recipientsFor("d", "proximity", all, c, 100)).toEqual({ ok: false, reason: "you are not in the world" });
  });
});
