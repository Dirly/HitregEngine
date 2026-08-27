import { describe, expect, it } from "vitest";
import { Profiler } from "../src/profiler.js";

/** Burn wall-clock time — the profiler measures performance.now(), not calls. */
function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* spin */
  }
}

function frame(p: Profiler, body: () => void): void {
  p.beginFrame();
  body();
  p.endFrame();
}

describe("Profiler", () => {
  it("records nothing while disabled", () => {
    const p = new Profiler();
    frame(p, () => {
      p.begin("a");
      busy(2);
      p.end();
    });
    const s = p.summary();
    expect(s.enabled).toBe(false);
    expect(s.frames).toBe(0);
    expect(s.scopes).toEqual([]);
  });

  it("nests scopes into paths and splits self vs inclusive time", () => {
    const p = new Profiler();
    p.enabled = true;
    frame(p, () => {
      p.begin("update");
      busy(2); // self time in `update`
      p.begin("physics");
      busy(6);
      p.end();
      p.end();
    });
    const s = p.summary();
    const update = s.scopes.find((x) => x.path === "update")!;
    const physics = s.scopes.find((x) => x.path === "update/physics")!;
    expect(physics.depth).toBe(1);
    expect(physics.name).toBe("physics");
    // inclusive update covers physics; self time does not
    expect(update.avgMs).toBeGreaterThan(physics.avgMs);
    expect(update.avgSelfMs).toBeLessThan(physics.avgMs);
    expect(physics.avgSelfMs).toBeCloseTo(physics.avgMs, 5);
  });

  it("counts repeated scopes per frame rather than overwriting them", () => {
    const p = new Profiler();
    p.enabled = true;
    frame(p, () => {
      for (let i = 0; i < 4; i++) {
        p.begin("script");
        busy(1);
        p.end();
      }
    });
    const script = p.summary().scopes.find((x) => x.path === "script")!;
    expect(script.callsPerFrame).toBe(4);
    expect(script.avgMs).toBeGreaterThanOrEqual(3.5);
  });

  it("keeps the worst frames instead of averaging them away", () => {
    const p = new Profiler({ spikeMs: 20 });
    p.enabled = true;
    for (let i = 0; i < 10; i++) {
      frame(p, () => {
        p.begin("cheap");
        busy(1);
        p.end();
      });
    }
    frame(p, () => {
      p.begin("expensive");
      busy(30);
      p.end();
    });
    // one more frame so the spike's wall-clock cost lands in an interval —
    // arrival lateness is only observable on the frame that arrives late
    frame(p, () => busy(1));
    const s = p.summary();
    // this is the whole point: the mean stays low, the spike is still visible
    expect(s.frameMs.avg).toBeLessThan(10);
    expect(s.frameMs.max).toBeGreaterThanOrEqual(28);
    expect(s.spikes).toHaveLength(2); // the slow callback, then its late successor
    expect(s.spikes[0]!.scopes[0]!.path).toBe("expensive");
    expect(s.over16Pct).toBeGreaterThan(0);
    expect(s.intervalMs.max).toBeGreaterThanOrEqual(28);
  });

  it("separates wall-clock lateness from time spent in the callback", () => {
    const p = new Profiler({ spikeMs: 25 });
    p.enabled = true;
    frame(p, () => busy(1));
    // a stall BETWEEN frames — async chunk parse, GC, a blocked GPU queue.
    // No scope can see it; the gap is the only thing that reports it.
    busy(40);
    frame(p, () => busy(1));
    const s = p.summary();
    expect(s.frameMs.max).toBeLessThan(10); // JS inside the loop stayed cheap
    expect(s.gapMs.max).toBeGreaterThanOrEqual(35); // ...yet the frame was 40ms late
    const spike = s.spikes.at(-1)!;
    expect(spike.gapMs).toBeGreaterThanOrEqual(35);
    expect(spike.totalMs).toBeLessThan(10);
  });

  it("attaches spanning markers to the frame they land in", () => {
    const p = new Profiler({ spikeMs: 20 });
    p.enabled = true;
    p.beginFrame();
    const done = p.span("chunk.load", "3_-2");
    busy(1);
    p.endFrame();
    // the load resolves during a much later, much slower frame
    for (let i = 0; i < 3; i++) frame(p, () => busy(1));
    p.beginFrame();
    done();
    busy(25);
    p.endFrame();
    const spike = p.summary().spikes.at(-1)!;
    expect(spike.markers.map((m) => m.label)).toContain("chunk.load");
    expect(spike.markers[0]!.detail).toBe("3_-2");
    expect(spike.markers[0]!.ms).toBeGreaterThan(0);
  });

  it("tracks counters and per-frame lanes for the graph", () => {
    const p = new Profiler();
    p.enabled = true;
    frame(p, () => {
      p.begin("render");
      busy(1);
      p.end();
      p.setCounter("drawCalls", 120);
      p.setGpuMs(4);
    });
    frame(p, () => {
      p.begin("render");
      busy(1);
      p.end();
      p.setCounter("drawCalls", 300);
      p.setGpuMs(8);
    });
    const s = p.summary();
    expect(s.counters["drawCalls"]).toMatchObject({ last: 300, avg: 210, max: 300 });
    expect(s.gpuMs).toMatchObject({ avg: 6, max: 8 });
    const series = p.frameSeries();
    expect(series.totals).toHaveLength(2);
    expect(series.lanes.map((l) => l.path)).toContain("render");
    expect(series.gpu[1]).toBe(8);
  });

  it("survives unbalanced scopes without corrupting later frames", () => {
    const p = new Profiler();
    p.enabled = true;
    frame(p, () => {
      p.begin("leaked"); // never ended — the frame boundary resets the stack
      busy(1);
    });
    p.end(); // stray end, must be a no-op
    frame(p, () => {
      p.begin("clean");
      busy(2);
      p.end();
    });
    const clean = p.summary().scopes.find((x) => x.path === "clean")!;
    expect(clean.depth).toBe(0); // NOT nested under the leaked scope
    expect(clean.callsPerFrame).toBeCloseTo(0.5, 5); // ran in 1 of 2 frames
  });

  it("wraps its ring buffer instead of growing without bound", () => {
    const p = new Profiler({ historyFrames: 5 });
    p.enabled = true;
    for (let i = 0; i < 20; i++) {
      frame(p, () => {
        p.begin("x");
        p.end();
      });
    }
    const s = p.summary();
    expect(s.frames).toBe(5);
    expect(p.frameSeries().totals).toHaveLength(5);
  });

  it("stops interning once the scope budget is spent, without throwing", () => {
    const p = new Profiler({ maxScopes: 4 });
    p.enabled = true;
    frame(p, () => {
      for (let i = 0; i < 12; i++) {
        p.begin(`s${i}`);
        p.end();
      }
    });
    expect(p.scopeBudget.overflowed).toBe(true);
    expect(p.summary().scopes.length).toBeLessThanOrEqual(4);
  });
});
