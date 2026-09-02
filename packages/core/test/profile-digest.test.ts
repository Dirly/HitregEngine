import { describe, expect, it } from "vitest";
import { digestProfile } from "../src/profile-digest.js";
import type { ProfileSummary } from "../src/profiler.js";

function summary(patch: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    enabled: true,
    frames: 600,
    windowSeconds: 10,
    fps: 60,
    frameMs: { last: 4, avg: 4, p50: 4, p95: 5, p99: 6, max: 8 },
    intervalMs: { avg: 16.6, p50: 16.6, p95: 16.7, p99: 16.8, max: 17 },
    gapMs: { avg: 1, p95: 2, max: 3 },
    gpuMs: { avg: 3, p95: 4, max: 5 },
    over16Pct: 0,
    over33Pct: 0,
    scopes: [],
    counters: {},
    markers: [],
    spikes: [],
    ...patch,
  };
}

const scope = (path: string, avgSelfMs: number, maxMs = avgSelfMs) => ({
  path,
  name: path.split("/").pop()!,
  depth: path.split("/").length - 1,
  avgMs: avgSelfMs,
  avgSelfMs,
  p95Ms: avgSelfMs,
  maxMs,
  callsPerFrame: 1,
  share: 0,
});

describe("digestProfile", () => {
  it("says it holds 60fps when it does", () => {
    const d = digestProfile(summary());
    expect(d.verdict).toBe("smooth");
    expect(d.headline).toContain("holds 60fps");
  });

  it("grades on wall-clock p95, not on time spent in the callback", () => {
    // 4ms of JS per frame, but frames arrive 50ms apart — the player sees 20fps
    const d = digestProfile(
      summary({ fps: 20, intervalMs: { avg: 50, p50: 50, p95: 52, p99: 60, max: 90 } }),
    );
    expect(d.verdict).toBe("misses-30");
    expect(d.headline).toContain("misses 30fps");
  });

  it("names off-loop time as the bottleneck and warns that scopes cannot see it", () => {
    const d = digestProfile(
      summary({
        fps: 12,
        intervalMs: { avg: 80, p50: 60, p95: 200, p99: 400, max: 900 },
        frameMs: { last: 5, avg: 5, p50: 5, p95: 8, p99: 9, max: 12 },
        gapMs: { avg: 74, p95: 190, max: 880 },
        gpuMs: { avg: 3, p95: 4, max: 6 },
      }),
    );
    expect(d.bottleneck).toContain("OFF-LOOP");
    expect(d.bottleneck).toMatch(/will not move it/);
  });

  it("distinguishes GPU-bound from CPU-bound, and says the fixes differ", () => {
    const d = digestProfile(
      summary({
        frameMs: { last: 3, avg: 3, p50: 3, p95: 4, p99: 4, max: 6 },
        gpuMs: { avg: 22, p95: 26, max: 30 },
        gapMs: { avg: 1, p95: 2, max: 3 },
      }),
    );
    expect(d.bottleneck).toContain("GPU");
    expect(d.bottleneck).toMatch(/fill rate|shader cost|overdraw/);
  });

  it("blames JS and names the hottest scope when JS actually dominates", () => {
    const d = digestProfile(
      summary({
        frameMs: { last: 20, avg: 20, p50: 20, p95: 24, p99: 26, max: 30 },
        gpuMs: { avg: 2, p95: 3, max: 4 },
        gapMs: { avg: 1, p95: 2, max: 3 },
        scopes: [scope("fixed/scripts/traffic-car", 14), scope("render", 3)],
      }),
    );
    expect(d.bottleneck).toContain("main-thread JS");
    expect(d.bottleneck).toContain("fixed/scripts/traffic-car");
  });

  it("calls out bursty scopes that a mean alone would hide", () => {
    const d = digestProfile({
      ...summary({ scopes: [scope("update/chunks/cells", 0.2, 180)] }),
    });
    expect(d.text).toContain("Bursty");
    expect(d.text).toContain("update/chunks/cells");
    expect(d.text).toContain("max 180");
  });

  it("reports which spans keep overlapping the spikes", () => {
    const spike = (markers: string[]) => ({
      frame: 1,
      t: 0,
      totalMs: 8,
      intervalMs: 120,
      gapMs: 112,
      gpuMs: 2,
      scopes: [],
      markers: markers.map((label) => ({ t: 0, frame: 1, label, ms: 90 })),
      counters: {},
    });
    const d = digestProfile(
      summary({ spikes: [spike(["chunk.build"]), spike(["chunk.build"]), spike(["long-task"])] }),
    );
    expect(d.text).toContain("chunk.build (2/3)");
    expect(d.text).toContain("off-loop");
  });

  it("says so plainly when nothing explains the spikes", () => {
    const d = digestProfile(
      summary({
        spikes: [
          {
            frame: 1,
            t: 0,
            totalMs: 40,
            intervalMs: 42,
            gapMs: 2,
            gpuMs: 1,
            scopes: [],
            markers: [],
            counters: {},
          },
        ],
      }),
    );
    expect(d.text).toContain("No recorded span overlapped the spikes");
  });

  it("flags an unproven JS/GPU split rather than assuming zero GPU time", () => {
    const d = digestProfile(summary({ gpuMs: null }));
    expect(d.text).toContain("GPU timing was unavailable");
    // and must not claim GPU-bound on the strength of a missing number
    expect(d.bottleneck).not.toContain("Dominant cost is the GPU");
  });

  it("handles an empty profile without pretending to a verdict", () => {
    const d = digestProfile(summary({ frames: 0 }));
    expect(d.lines).toHaveLength(1);
    expect(d.text).toContain("No frames recorded");
  });
});

describe("backend fallback warning", () => {
  it("leads with the WebGL-fallback warning, above the bottleneck", () => {
    const d = digestProfile(summary({ fps: 20 }), { backend: "webgl" });
    expect(d.lines[1]).toContain("WEBGL FALLBACK");
    expect(d.text).toContain("find out why the browser fell back");
  });

  it("stays quiet on WebGPU, and when the backend is unknown", () => {
    for (const context of [{ backend: "webgpu" }, {}]) {
      expect(digestProfile(summary(), context).text).not.toContain("WEBGL FALLBACK");
    }
  });
});
