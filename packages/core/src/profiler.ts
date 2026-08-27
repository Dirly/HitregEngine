/**
 * Frame profiler: a hierarchical, per-frame sampler with a rolling history.
 *
 * Why this exists rather than the EMA counters it replaces: smoothed averages
 * are the wrong instrument for the problem people actually have. "The game
 * hitches" is a question about the WORST frames, and an exponential moving
 * average is specifically a machine for erasing those — a 40ms spike every
 * two seconds barely moves a 0.15-alpha EMA, so the HUD reads "fine" while
 * the game visibly stutters. This keeps every frame in a ring buffer, so
 * p95/max/spike-capture are answerable, and nests scopes so the answer is
 * "chunks/build-entities", not "chunks".
 *
 * Zero-allocation in steady state, deliberately: a profiler that allocates
 * per frame creates the GC hitches it is meant to find. Scope paths are
 * interned to integer ids on first use; samples live in pre-allocated typed
 * arrays reused as the ring wraps. The only allocations after warmup are
 * markers (rare, human-scale events) and spike captures (bounded).
 *
 * DOM-free by construction — core runs headless in Node, and a server can
 * profile its own fixed loop with the same class the browser uses.
 */

const now = (): number => performance.now();

/** Rolling window, in frames. 600 is roughly 10s at 60fps. */
const DEFAULT_HISTORY = 600;
/** Distinct scope paths. Well past any hand-instrumented frame. */
const DEFAULT_MAX_SCOPES = 192;
const DEFAULT_MAX_COUNTERS = 48;
const DEFAULT_MARKER_HISTORY = 512;
const DEFAULT_SPIKE_HISTORY = 32;
/** Nesting cap. Deeper begins are counted and unwound, never recorded. */
const MAX_STACK = 64;

export interface ProfilerOptions {
  historyFrames?: number;
  maxScopes?: number;
  maxCounters?: number;
  markerHistory?: number;
  spikeHistory?: number;
  /**
   * Frames slower than this are captured whole (full tree + the markers that
   * overlapped them). Default 33.3ms, i.e. anything that missed 30fps.
   */
  spikeMs?: number;
}

/** A one-off event worth aligning against the frame graph (chunk load, glTF parse, rebuild). */
export interface ProfileMarker {
  /** performance.now() at the START of the event. */
  t: number;
  /** Monotonic index of the frame the marker started in. */
  frame: number;
  label: string;
  /** Wall-clock span for async work; 0 for instantaneous marks. */
  ms: number;
  /** Free-form detail: the chunk key, the model url, the entity count. */
  detail?: string;
}

/** Aggregate for one scope over the sampled window. */
export interface ScopeStat {
  path: string;
  name: string;
  depth: number;
  /** Mean inclusive ms PER FRAME (frames it never ran in count as zero — that is the useful number). */
  avgMs: number;
  /** Mean exclusive (self) ms per frame: inclusive minus direct children. */
  avgSelfMs: number;
  p95Ms: number;
  maxMs: number;
  /** Mean begin/end pairs per frame (>1 for per-entity or substepped scopes). */
  callsPerFrame: number;
  /** avgMs as a fraction of mean total frame time. */
  share: number;
}

/** One captured slow frame, kept whole so you can see what that frame actually did. */
export interface SpikeFrame {
  frame: number;
  t: number;
  totalMs: number;
  /** Wall-clock since the previous frame started, and the unaccounted part of it. */
  intervalMs: number;
  gapMs: number;
  gpuMs: number;
  /** Inclusive/self ms per scope path, only scopes that ran, worst self-time first. */
  scopes: Array<{ path: string; ms: number; selfMs: number; calls: number }>;
  /** Markers overlapping this frame — usually the whole explanation. */
  markers: ProfileMarker[];
  counters: Record<string, number>;
}

export interface ProfileSummary {
  enabled: boolean;
  /** Frames actually sampled in the window. */
  frames: number;
  windowSeconds: number;
  fps: number;
  /** Time spent INSIDE the instrumented frame callback. */
  frameMs: { last: number; avg: number; p50: number; p95: number; p99: number; max: number };
  /** Wall-clock time between frame starts — what the player actually feels. */
  intervalMs: { avg: number; p50: number; p95: number; p99: number; max: number };
  /** interval minus JS: GPU wait, GC, async work, browser work. See beginFrame. */
  gapMs: { avg: number; p95: number; max: number };
  gpuMs: { avg: number; p95: number; max: number } | null;
  /** Share of frames over 16.7 / 33.3ms — the "is it smooth" numbers. */
  over16Pct: number;
  over33Pct: number;
  scopes: ScopeStat[];
  counters: Record<string, { last: number; avg: number; max: number }>;
  markers: ProfileMarker[];
  spikes: SpikeFrame[];
}

/**
 * The begin/end surface as seen by instrumented code. Deliberately minimal so
 * packages that shouldn't know the profiler's internals (scripting, render)
 * can accept `ProfilerLike | undefined` and stay decoupled.
 */
export interface ProfilerLike {
  readonly enabled: boolean;
  begin(name: string): void;
  end(): void;
  mark(label: string, detail?: string): void;
  /** Start a spanning event; call the returned closer when it finishes. */
  span(label: string, detail?: string): () => void;
}

export class Profiler implements ProfilerLike {
  /** Off by default: instrumentation must cost nothing until someone looks. */
  enabled = false;

  readonly historyFrames: number;
  readonly maxScopes: number;
  spikeMs: number;

  // -- scope interning -------------------------------------------------------
  // Paths resolve through (parentId -> name -> id) maps rather than string
  // concatenation, so a hot begin() allocates nothing after warmup.
  private readonly scopePaths: string[] = [];
  private readonly scopeNames: string[] = [];
  private readonly scopeParents: number[] = [];
  private readonly scopeDepths: number[] = [];
  private readonly childIds = new Map<number, Map<string, number>>();
  private scopeCount = 0;
  /** Set once the scope budget is exhausted, so the UI can say so. */
  private overflowed = false;

  // -- live stack ------------------------------------------------------------
  private readonly stackIds = new Int32Array(MAX_STACK);
  private readonly stackStarts = new Float64Array(MAX_STACK);
  private stackDepth = 0;
  /** Scopes begun past the cap (or past the scope budget): popped, not recorded. */
  private unwind = 0;

  // -- per-frame sample ring -------------------------------------------------
  private readonly times: Float64Array; // historyFrames * maxScopes, inclusive ms
  private readonly calls: Uint16Array; // historyFrames * maxScopes
  private readonly counterValues: Float64Array; // historyFrames * maxCounters
  private readonly frameTotals: Float64Array;
  private readonly frameGpu: Float64Array;
  private readonly frameStamps: Float64Array;
  private readonly frameSeqs: Float64Array;
  private readonly frameHeap: Float64Array;
  private readonly frameIntervals: Float64Array;
  private readonly frameGaps: Float64Array;
  private slot = -1;
  private filled = 0;
  private frameSeq = 0;
  private frameStartedAt = 0;
  private prevFrameStartedAt = 0;
  private lastFrameMs = 0;

  private readonly counterIds = new Map<string, number>();
  private readonly maxCounters: number;

  // -- markers / spikes ------------------------------------------------------
  private readonly markerRing: ProfileMarker[] = [];
  private readonly markerHistory: number;
  private readonly spikeRing: SpikeFrame[] = [];
  private readonly spikeHistory: number;

  constructor(options: ProfilerOptions = {}) {
    this.historyFrames = options.historyFrames ?? DEFAULT_HISTORY;
    this.maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
    this.maxCounters = options.maxCounters ?? DEFAULT_MAX_COUNTERS;
    this.markerHistory = options.markerHistory ?? DEFAULT_MARKER_HISTORY;
    this.spikeHistory = options.spikeHistory ?? DEFAULT_SPIKE_HISTORY;
    this.spikeMs = options.spikeMs ?? 33.3;

    this.times = new Float64Array(this.historyFrames * this.maxScopes);
    this.calls = new Uint16Array(this.historyFrames * this.maxScopes);
    this.counterValues = new Float64Array(this.historyFrames * this.maxCounters);
    this.frameTotals = new Float64Array(this.historyFrames);
    this.frameGpu = new Float64Array(this.historyFrames);
    this.frameStamps = new Float64Array(this.historyFrames);
    this.frameSeqs = new Float64Array(this.historyFrames);
    this.frameHeap = new Float64Array(this.historyFrames);
    this.frameIntervals = new Float64Array(this.historyFrames);
    this.frameGaps = new Float64Array(this.historyFrames);
  }

  // -- instrumentation API ---------------------------------------------------

  /**
   * Open a scope. Nests: begin("chunks"); begin("parse"); end(); end() records
   * "chunks/parse" inside "chunks". Cost when disabled is one branch.
   */
  begin(name: string): void {
    if (!this.enabled) return;
    if (this.stackDepth >= MAX_STACK) {
      this.unwind++;
      return;
    }
    const parent = this.stackDepth > 0 ? this.stackIds[this.stackDepth - 1]! : -1;
    const id = this.intern(parent, name);
    if (id < 0) {
      this.unwind++;
      return;
    }
    this.stackIds[this.stackDepth] = id;
    this.stackStarts[this.stackDepth] = now();
    this.stackDepth++;
  }

  /** Close the innermost open scope. An unbalanced end() is a no-op, never a throw. */
  end(): void {
    if (!this.enabled) return;
    if (this.unwind > 0) {
      this.unwind--;
      return;
    }
    if (this.stackDepth === 0) return;
    this.stackDepth--;
    if (this.slot < 0) return; // outside a frame (boot, teardown) — ignore
    const id = this.stackIds[this.stackDepth]!;
    const elapsed = now() - this.stackStarts[this.stackDepth]!;
    const index = this.slot * this.maxScopes + id;
    this.times[index]! += elapsed;
    // saturate rather than wrap: a mis-instrumented 65k-call scope must not
    // silently report "3 calls"
    const c = this.calls[index]!;
    if (c < 65535) this.calls[index] = c + 1;
  }

  /** Time a synchronous function as one scope. Rethrows after closing the scope. */
  scope<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();
    this.begin(name);
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  /** Record an instantaneous event, aligned to the current frame. */
  mark(label: string, detail?: string): void {
    if (!this.enabled) return;
    this.pushMarker({ t: now(), frame: this.frameSeq, label, ms: 0, detail });
  }

  /**
   * Record a spanning event (async load, shader compile) — returns the closer.
   * Unlike a scope, a span may outlive the frame it started in, which is the
   * point: "the hitch at 12.4s is that 900ms chunk load landing" is only
   * visible if the span can be drawn against the frame graph.
   */
  span(label: string, detail?: string): () => void {
    if (!this.enabled) return () => undefined;
    const startedAt = now();
    const startFrame = this.frameSeq;
    let closed = false;
    return () => {
      if (closed || !this.enabled) return;
      closed = true;
      this.pushMarker({ t: startedAt, frame: startFrame, label, ms: now() - startedAt, detail });
    };
  }

  /**
   * Record a span that already happened, with its own start and duration.
   *
   * For events reported after the fact by the platform rather than wrapped by
   * us — PerformanceObserver long tasks above all. Those are the single most
   * useful markers there are (they name the stalls no scope can see), and
   * mark() would flatten them to zero-width points on the timeline, exactly
   * losing the duration that makes them worth showing.
   */
  recordSpan(label: string, startedAt: number, ms: number, detail?: string): void {
    if (!this.enabled) return;
    this.pushMarker({ t: startedAt, frame: this.frameSeq, label, ms, detail });
  }

  /** Per-frame scalar (draw calls, entity count, bodies) — sampled and graphable. */
  setCounter(name: string, value: number): void {
    if (!this.enabled || this.slot < 0) return;
    let id = this.counterIds.get(name);
    if (id === undefined) {
      if (this.counterIds.size >= this.maxCounters) return;
      id = this.counterIds.size;
      this.counterIds.set(name, id);
    }
    this.counterValues[this.slot * this.maxCounters + id] = value;
  }

  /** GPU time for the frame, fed out-of-band (timestamp queries resolve late). */
  setGpuMs(ms: number): void {
    if (!this.enabled || this.slot < 0) return;
    this.frameGpu[this.slot] = ms;
  }

  // -- frame boundary --------------------------------------------------------

  beginFrame(): void {
    if (!this.enabled) return;
    // an unbalanced frame (a throw mid-scope) must not corrupt the next one
    this.stackDepth = 0;
    this.unwind = 0;
    this.slot = (this.slot + 1) % this.historyFrames;
    this.frameSeq++;
    const base = this.slot * this.maxScopes;
    this.times.fill(0, base, base + this.maxScopes);
    this.calls.fill(0, base, base + this.maxScopes);
    const cbase = this.slot * this.maxCounters;
    this.counterValues.fill(0, cbase, cbase + this.maxCounters);
    this.frameGpu[this.slot] = 0;
    this.frameStartedAt = now();
    this.frameStamps[this.slot] = this.frameStartedAt;
    this.frameSeqs[this.slot] = this.frameSeq;
    // Wall-clock interval, and the part of it this profiler CANNOT see.
    //
    // Scope timing only covers what runs inside the instrumented callback. A
    // chunk's JSON.parse landing in a promise continuation, a GC pause, style
    // recalc, or the browser blocking on a full GPU queue all happen between
    // frames — invisible to every scope, yet they are exactly what a hitch is
    // made of. gap = interval - previous frame's JS total makes that missing
    // time an explicit number instead of a mystery, so "my scopes add up to
    // 4ms but the game runs at 20fps" has an answer on screen.
    const prevStart = this.prevFrameStartedAt;
    if (prevStart > 0) {
      const interval = this.frameStartedAt - prevStart;
      this.frameIntervals[this.slot] = interval;
      this.frameGaps[this.slot] = Math.max(0, interval - this.lastFrameMs);
    } else {
      this.frameIntervals[this.slot] = 0;
      this.frameGaps[this.slot] = 0;
    }
    this.prevFrameStartedAt = this.frameStartedAt;
  }

  endFrame(): void {
    if (!this.enabled || this.slot < 0) return;
    const total = now() - this.frameStartedAt;
    this.frameTotals[this.slot] = total;
    this.lastFrameMs = total;
    // Chrome-only and flag-gated on some builds, so: optional signal, never a
    // dependency. A per-frame sawtooth here is the signature of allocation
    // churn causing GC hitches, which no scope timing would ever show.
    const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    this.frameHeap[this.slot] = mem ? mem.usedJSHeapSize / 1048576 : 0;
    if (this.filled < this.historyFrames) this.filled++;
    // Capture on EITHER a slow callback or a slow wall-clock interval. The
    // second case is the one that would otherwise get away: a 4ms frame that
    // took 90ms to arrive is the hitch people complain about, and a
    // JS-total-only trigger never sees it.
    if (total >= this.spikeMs || this.frameIntervals[this.slot]! >= this.spikeMs) {
      this.captureSpike(total);
    }
  }

  // -- read side -------------------------------------------------------------

  summary(): ProfileSummary {
    const frames = this.filled;
    if (!this.enabled || frames === 0) return emptySummary(this.enabled);

    const totals = new Float64Array(frames);
    const intervals = new Float64Array(frames);
    const gaps = new Float64Array(frames);
    let sumTotal = 0;
    let sumInterval = 0;
    let sumGap = 0;
    let over16 = 0;
    let over33 = 0;
    let oldestStamp = Infinity;
    let newestStamp = 0;
    for (let i = 0; i < frames; i++) {
      const slot = this.slotAt(i);
      const v = this.frameTotals[slot]!;
      totals[i] = v;
      sumTotal += v;
      const interval = this.frameIntervals[slot]!;
      intervals[i] = interval;
      sumInterval += interval;
      gaps[i] = this.frameGaps[slot]!;
      sumGap += gaps[i]!;
      // smoothness is judged on the WALL CLOCK, not on JS time: a 4ms frame
      // that took 50ms to arrive is a stutter, whatever the scopes say
      if (interval > 16.7) over16++;
      if (interval > 33.3) over33++;
      const stamp = this.frameStamps[slot]!;
      if (stamp < oldestStamp) oldestStamp = stamp;
      if (stamp > newestStamp) newestStamp = stamp;
    }
    const sorted = totals.slice().sort();
    const sortedIntervals = intervals.slice().sort();
    const sortedGaps = gaps.slice().sort();
    const avgTotal = sumTotal / frames;
    const windowSeconds = Math.max(0, (newestStamp - oldestStamp) / 1000);
    // real fps from wall-clock frame spacing, NOT 1000/avgJsTime — those two
    // diverge exactly when it matters most (GPU-bound: JS cheap, frames slow)
    const fps = windowSeconds > 0 ? (frames - 1) / windowSeconds : 0;

    const gpuVals: number[] = [];
    let gpuSum = 0;
    let gpuMax = 0;
    for (let i = 0; i < frames; i++) {
      const v = this.frameGpu[this.slotAt(i)]!;
      if (v > 0) {
        gpuSum += v;
        gpuVals.push(v);
        if (v > gpuMax) gpuMax = v;
      }
    }
    gpuVals.sort((a, b) => a - b);

    // scopes: inclusive sums first, then self = inclusive - sum(direct children)
    const inclusiveSum = new Float64Array(this.scopeCount);
    const callSum = new Float64Array(this.scopeCount);
    const childSum = new Float64Array(this.scopeCount);
    const maxMs = new Float64Array(this.scopeCount);
    const perScope: Array<Float64Array | null> = new Array(this.scopeCount).fill(null);
    for (let i = 0; i < frames; i++) {
      const base = this.slotAt(i) * this.maxScopes;
      for (let s = 0; s < this.scopeCount; s++) {
        const calls = this.calls[base + s]!;
        const v = this.times[base + s]!;
        if (calls === 0 && v === 0) continue;
        inclusiveSum[s]! += v;
        callSum[s]! += calls;
        if (v > maxMs[s]!) maxMs[s] = v;
        let series = perScope[s];
        if (!series) {
          series = new Float64Array(frames);
          perScope[s] = series;
        }
        series[i] = v;
        const parent = this.scopeParents[s]!;
        if (parent >= 0) childSum[parent]! += v;
      }
    }
    const scopes: ScopeStat[] = [];
    for (let s = 0; s < this.scopeCount; s++) {
      if (callSum[s] === 0) continue;
      const avgMs = inclusiveSum[s]! / frames;
      const series = perScope[s];
      const p95 = series
        ? series.slice().sort()[Math.min(frames - 1, Math.floor(frames * 0.95))]!
        : 0;
      scopes.push({
        path: this.scopePaths[s]!,
        name: this.scopeNames[s]!,
        depth: this.scopeDepths[s]!,
        avgMs,
        avgSelfMs: Math.max(0, (inclusiveSum[s]! - childSum[s]!) / frames),
        p95Ms: p95,
        maxMs: maxMs[s]!,
        callsPerFrame: callSum[s]! / frames,
        share: avgTotal > 0 ? avgMs / avgTotal : 0,
      });
    }
    // by path, so the flat table still reads as the tree it came from
    scopes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const counters: ProfileSummary["counters"] = {};
    for (const [name, id] of this.counterIds) {
      let sum = 0;
      let max = 0;
      for (let i = 0; i < frames; i++) {
        const v = this.counterValues[this.slotAt(i) * this.maxCounters + id]!;
        sum += v;
        if (v > max) max = v;
      }
      counters[name] = {
        last: this.counterValues[this.slot * this.maxCounters + id]!,
        avg: sum / frames,
        max,
      };
    }
    const heapLast = this.frameHeap[this.slot]!;
    if (heapLast > 0) {
      let sum = 0;
      let max = 0;
      for (let i = 0; i < frames; i++) {
        const v = this.frameHeap[this.slotAt(i)]!;
        sum += v;
        if (v > max) max = v;
      }
      counters["heapMB"] = { last: heapLast, avg: sum / frames, max };
    }

    return {
      enabled: this.enabled,
      frames,
      windowSeconds: Number(windowSeconds.toFixed(2)),
      fps: Number(fps.toFixed(1)),
      frameMs: {
        last: this.lastFrameMs,
        avg: avgTotal,
        p50: sorted[Math.floor(frames * 0.5)] ?? 0,
        p95: sorted[Math.min(frames - 1, Math.floor(frames * 0.95))] ?? 0,
        p99: sorted[Math.min(frames - 1, Math.floor(frames * 0.99))] ?? 0,
        max: sorted[frames - 1] ?? 0,
      },
      intervalMs: {
        avg: sumInterval / frames,
        p50: sortedIntervals[Math.floor(frames * 0.5)] ?? 0,
        p95: sortedIntervals[Math.min(frames - 1, Math.floor(frames * 0.95))] ?? 0,
        p99: sortedIntervals[Math.min(frames - 1, Math.floor(frames * 0.99))] ?? 0,
        max: sortedIntervals[frames - 1] ?? 0,
      },
      gapMs: {
        avg: sumGap / frames,
        p95: sortedGaps[Math.min(frames - 1, Math.floor(frames * 0.95))] ?? 0,
        max: sortedGaps[frames - 1] ?? 0,
      },
      gpuMs:
        gpuVals.length > 0
          ? {
              avg: gpuSum / gpuVals.length,
              p95: gpuVals[Math.min(gpuVals.length - 1, Math.floor(gpuVals.length * 0.95))] ?? 0,
              max: gpuMax,
            }
          : null,
      over16Pct: (over16 / frames) * 100,
      over33Pct: (over33 / frames) * 100,
      scopes,
      counters,
      markers: this.markerRing.slice(),
      spikes: this.spikeRing.slice(),
    };
  }

  /** Per-frame series for the graph: totals, GPU, and one lane per top-level scope. */
  frameSeries(): {
    totals: Float64Array;
    intervals: Float64Array;
    gaps: Float64Array;
    gpu: Float64Array;
    seqs: Float64Array;
    stamps: Float64Array;
    lanes: Array<{ path: string; values: Float64Array }>;
  } {
    const frames = this.filled;
    const totals = new Float64Array(frames);
    const intervals = new Float64Array(frames);
    const gaps = new Float64Array(frames);
    const gpu = new Float64Array(frames);
    const seqs = new Float64Array(frames);
    const stamps = new Float64Array(frames);
    const topIds: number[] = [];
    for (let s = 0; s < this.scopeCount; s++) if (this.scopeDepths[s] === 0) topIds.push(s);
    const lanes = topIds.map((s) => ({
      path: this.scopePaths[s]!,
      values: new Float64Array(frames),
    }));
    for (let i = 0; i < frames; i++) {
      const slot = this.slotAt(i);
      totals[i] = this.frameTotals[slot]!;
      intervals[i] = this.frameIntervals[slot]!;
      gaps[i] = this.frameGaps[slot]!;
      gpu[i] = this.frameGpu[slot]!;
      seqs[i] = this.frameSeqs[slot]!;
      stamps[i] = this.frameStamps[slot]!;
      const base = slot * this.maxScopes;
      for (let l = 0; l < topIds.length; l++) lanes[l]!.values[i] = this.times[base + topIds[l]!]!;
    }
    return { totals, intervals, gaps, gpu, seqs, stamps, lanes };
  }

  /** Drop history but keep interned scopes, so graph lane colors stay stable. */
  reset(): void {
    this.filled = 0;
    this.slot = -1;
    this.markerRing.length = 0;
    this.spikeRing.length = 0;
  }

  get scopeBudget(): { used: number; max: number; overflowed: boolean } {
    return { used: this.scopeCount, max: this.maxScopes, overflowed: this.overflowed };
  }

  // -- internals -------------------------------------------------------------

  /** Ring index of the i-th oldest frame in the current window. */
  private slotAt(i: number): number {
    const oldest = (this.slot - this.filled + 1 + this.historyFrames) % this.historyFrames;
    return (oldest + i) % this.historyFrames;
  }

  private intern(parent: number, name: string): number {
    let byName = this.childIds.get(parent);
    if (!byName) {
      byName = new Map();
      this.childIds.set(parent, byName);
    }
    const existing = byName.get(name);
    if (existing !== undefined) return existing;
    if (this.scopeCount >= this.maxScopes) {
      this.overflowed = true;
      return -1;
    }
    const id = this.scopeCount++;
    byName.set(name, id);
    this.scopeNames[id] = name;
    this.scopeParents[id] = parent;
    this.scopeDepths[id] = parent < 0 ? 0 : this.scopeDepths[parent]! + 1;
    this.scopePaths[id] = parent < 0 ? name : `${this.scopePaths[parent]!}/${name}`;
    return id;
  }

  private pushMarker(marker: ProfileMarker): void {
    this.markerRing.push(marker);
    const overflow = this.markerRing.length - this.markerHistory;
    if (overflow > 0) this.markerRing.splice(0, overflow);
  }

  private captureSpike(totalMs: number): void {
    const base = this.slot * this.maxScopes;
    const childSum = new Float64Array(this.scopeCount);
    for (let s = 0; s < this.scopeCount; s++) {
      const parent = this.scopeParents[s]!;
      if (parent >= 0) childSum[parent]! += this.times[base + s]!;
    }
    const scopes: SpikeFrame["scopes"] = [];
    for (let s = 0; s < this.scopeCount; s++) {
      if (this.calls[base + s] === 0) continue;
      const ms = this.times[base + s]!;
      scopes.push({
        path: this.scopePaths[s]!,
        ms,
        selfMs: Math.max(0, ms - childSum[s]!),
        calls: this.calls[base + s]!,
      });
    }
    // worst SELF time first: the leaf that actually burned the frame, not the
    // root that merely contains it
    scopes.sort((a, b) => b.selfMs - a.selfMs);

    const counters: Record<string, number> = {};
    for (const [name, id] of this.counterIds) {
      counters[name] = this.counterValues[this.slot * this.maxCounters + id]!;
    }
    // markers whose SPAN overlaps this frame, not merely ones stamped to it —
    // an 800ms glTF parse that started 40 frames ago is the explanation for
    // this frame, and frame-stamping alone would hide exactly that case.
    // The window reaches back across the gap too: work that ran BETWEEN the
    // last frame and this one is precisely what a gap-triggered spike is.
    const gap = this.frameGaps[this.slot]!;
    const windowStart = this.frameStartedAt - gap;
    const windowEnd = this.frameStartedAt + totalMs;
    const markers = this.markerRing.filter((m) => m.t + m.ms >= windowStart && m.t <= windowEnd);

    this.spikeRing.push({
      frame: this.frameSeq,
      t: this.frameStartedAt,
      totalMs,
      intervalMs: this.frameIntervals[this.slot]!,
      gapMs: gap,
      gpuMs: this.frameGpu[this.slot]!,
      scopes: scopes.slice(0, 24),
      markers,
      counters,
    });
    const overflow = this.spikeRing.length - this.spikeHistory;
    if (overflow > 0) this.spikeRing.splice(0, overflow);
  }
}

function emptySummary(enabled: boolean): ProfileSummary {
  return {
    enabled,
    frames: 0,
    windowSeconds: 0,
    fps: 0,
    frameMs: { last: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
    intervalMs: { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
    gapMs: { avg: 0, p95: 0, max: 0 },
    gpuMs: null,
    over16Pct: 0,
    over33Pct: 0,
    scopes: [],
    counters: {},
    markers: [],
    spikes: [],
  };
}

/** Shared no-op for packages that take an optional profiler. */
export const noopProfiler: ProfilerLike = {
  enabled: false,
  begin: () => undefined,
  end: () => undefined,
  mark: () => undefined,
  span: () => () => undefined,
};
