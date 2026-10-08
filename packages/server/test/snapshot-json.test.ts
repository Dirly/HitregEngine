import { describe, expect, it } from "vitest";
import { snapshotJson } from "../src/server.js";

/** Snapshots are assembled from fragments serialised once per entity and player: the bytes must not change. */
describe("snapshotJson", () => {
  it("is byte-for-byte JSON.stringify of the state, shared parts and all", () => {
    const update = { p: [1, 2, 3], q: [0, 0, 0, 1], anim: "Run", animR: 1.2 };
    const held = { p: [4, 5, 6], q: [0, 0.5, 0, 0.866], h: 1 };
    const player = { position: [1, 2, 3], yaw: 0.5, name: "Ann \"the\" Bold", seq: 7, sa: 33 };
    const state = {
      players: { "p-ann": player, "p-ben": { ...player, name: "Ben" } },
      simMs: 12345.5,
      entities: { updates: { "pop#wolf#1": update, "player:p-ben": held }, managed: ["pop#wolf#1", "player:p-ben"], removed: ["x"] },
    };
    expect(snapshotJson(state)).toBe(JSON.stringify(state));
    // twice (the fragments come from the cache the second time)
    expect(snapshotJson(state)).toBe(JSON.stringify(state));
    const bare = { players: {}, simMs: 0 };
    expect(snapshotJson(bare)).toBe(JSON.stringify(bare));
    const empty = { players: { a: player }, simMs: 1, entities: { updates: {} } };
    expect(snapshotJson(empty)).toBe(JSON.stringify(empty));
  });
});
