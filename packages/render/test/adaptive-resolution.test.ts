import { describe, expect, it } from "vitest";
import { AdaptiveResolution, renderScaleFromSearch } from "../src/adaptive-resolution.js";

/** A machine: its frame time at a scale, and its main-thread work. Runs `frames` frames; returns every scale change. */
function run(a: AdaptiveResolution, frames: number, frameAt: (scale: number) => number, busyMs: number, clock = { t: 0 }): number[] {
  const changes: number[] = [];
  for (let i = 0; i < frames; i++) {
    clock.t += frameAt(a.scale);
    const changed = a.frame(clock.t, busyMs);
    if (changed !== null) changes.push(changed);
  }
  return changes;
}
/** Pixel-bound: frame time follows the pixel count. */
const gpuBound = (full: number) => (scale: number) => full * scale * scale;
const flat = (ms: number) => () => ms;

describe("adaptive resolution", () => {
  it("backs off a GPU-bound machine until it holds its frame rate", () => {
    const a = new AdaptiveResolution({ window: 10 });
    expect(run(a, 100, gpuBound(33), 8)).toEqual([0.9, 0.8]);
    expect(a.stats.undone).toBe(0);
  });

  it("stops at its floor on a machine that can never get there", () => {
    const a = new AdaptiveResolution({ window: 10 });
    expect(run(a, 100, gpuBound(90), 8)).toEqual([0.9, 0.8, 0.7, 0.6]);
  });

  it("undoes a step that bought nothing and then holds: the frame was not limited by pixels", () => {
    const a = new AdaptiveResolution({ window: 10 });
    // looks GPU-limited (busy is low), but fewer pixels change nothing: loading, uploads, a throttled tab
    expect(run(a, 300, flat(33), 8)).toEqual([0.9, 1]);
    expect(a.scale).toBe(1);
    expect(a.stats.undone).toBe(1);
  });

  it("leaves a CPU-bound frame alone", () => {
    const a = new AdaptiveResolution({ window: 10 });
    expect(run(a, 100, flat(33), 30)).toEqual([]);
    expect(a.scale).toBe(1);
  });

  it("leaves a healthy frame alone, and ignores hitches", () => {
    const a = new AdaptiveResolution({ window: 10 });
    expect(run(a, 100, flat(16.7), 8)).toEqual([]);
    const clock = { t: 0 };
    run(a, 9, flat(16.7), 8, clock);
    clock.t += 900; // a load stall: over the sample cap
    a.frame(clock.t, 900);
    expect(a.scale).toBe(1);
  });

  it("raises again once there is headroom, and waits longer after a raise that failed", () => {
    const a = new AdaptiveResolution({ window: 10 });
    // a vsynced machine: 16.7 ms at or under its limit, 33 ms over it
    const edge = (scale: number) => (scale > 0.95 ? 33 : 16.7);
    const clock = { t: 0 };
    const raises: number[] = [];
    for (let i = 0; i < 400; i++) {
      clock.t += edge(a.scale);
      if (a.frame(clock.t, 8) === 1) raises.push(i);
    }
    expect(raises.length).toBeGreaterThanOrEqual(3);
    // each raise fails on this machine, so each wait is longer than the last: it settles rather than pumps
    expect(raises[2]! - raises[1]!).toBeGreaterThan(raises[1]! - raises[0]!);
  });

  it("reads the URL override", () => {
    expect(renderScaleFromSearch("?renderScale=0.75")).toBe(0.75);
    expect(renderScaleFromSearch("?renderScale=1")).toBe(1);
    expect(renderScaleFromSearch("?renderScale=4")).toBeNull();
    expect(renderScaleFromSearch("?scene=x")).toBeNull();
  });
});

import { cascadeDue } from "../src/csm.js";
describe("cascade stagger", () => {
  const dueOver = (index: number, frames: number, moved = 0) => {
    let n = 0;
    for (let f = 0; f < frames; f++) if (cascadeDue(index, f, moved)) n++;
    return n;
  };
  it("keeps the near cascade live and thins the far ones", () => {
    expect(dueOver(0, 16)).toBe(16);
    expect(dueOver(1, 16)).toBe(8);
    expect(dueOver(2, 16)).toBe(4);
    expect(dueOver(3, 16)).toBe(4); // capped
  });
  it("never lands two far cascades on one frame", () => {
    for (let f = 0; f < 16; f++) expect(cascadeDue(1, f, 0) && cascadeDue(2, f, 0)).toBe(false);
  });

  it("renders a cascade holding walking bodies every frame, or their shadows step while they move", () => {
    for (let f = 0; f < 16; f++) expect(cascadeDue(1, f, 0, true)).toBe(true);
  });
  it("renders a cascade at once when its fit has slid", () => {
    expect(dueOver(2, 16, 0.5)).toBe(16);
  });
});
