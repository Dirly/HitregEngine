import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPhase, shouldReleaseLoad, wantsWorldEntry, type LoadSignals } from "../src/load-screen.js";

test("local character-free previews can play without waiting for a player body", () => {
  assert.equal(wantsWorldEntry(true, false, false), false);
  assert.equal(wantsWorldEntry(true, false, true), true);
});

test("network entry still waits for a body before the player has arrived", () => {
  assert.equal(wantsWorldEntry(true, true, false), true);
  assert.equal(wantsWorldEntry(true, true, true), true);
  for (const networked of [false, true]) for (const hasLocalPlayer of [false, true]) {
    assert.equal(wantsWorldEntry(false, networked, hasLocalPlayer), false);
  }
});

function signals(overrides: Partial<LoadSignals> = {}): LoadSignals {
  return { wanted: () => true, connected: () => true, hasBody: () => true,
    loading: () => 1000, ready: () => true, switching: () => false, place: () => "", ...overrides };
}

test("local readiness allows settling while distant terrain is still loading", () => {
  assert.equal(loadPhase(signals()), "settle");
  assert.equal(loadPhase(signals({ ready: () => false, loading: () => 0 })), "stream");
  assert.equal(loadPhase(signals({ ready: undefined })), "stream");
});

test("world entry cannot time out past missing ground, a missing body or a disconnected link", () => {
  for (const overrides of [{ ready: () => false }, { hasBody: () => false },
    { connected: () => false }, { switching: () => true }]) {
    const phase = loadPhase(signals(overrides));
    assert.equal(shouldReleaseLoad(phase, 999, 999, 999, true), false);
  }
});

test("background hitches have a bounded settling wait once the playable area is ready", () => {
  assert.equal(shouldReleaseLoad("settle", 10, 0, 4.9, true), false);
  assert.equal(shouldReleaseLoad("settle", 10, 0, 5, true), true);
  assert.equal(shouldReleaseLoad("settle", 2, 1, 1, true), true);
  assert.equal(shouldReleaseLoad("settle", 1, 1, 1, true), false);
});

test("the screen holds for a world still finishing, but only so long", () => {
  assert.equal(shouldReleaseLoad("settle", 30, 9, 44, true, true), false);
  assert.equal(shouldReleaseLoad("settle", 60, 0, 45, true, true), true);
  assert.equal(shouldReleaseLoad("settle", 30, 9, 44, true, false), true);
});

test("legacy hosts retain their timeout without explicit ground readiness", () => {
  assert.equal(shouldReleaseLoad("stream", 44, 0, 0, false), false);
  assert.equal(shouldReleaseLoad("stream", 45, 0, 0, false), true);
});
