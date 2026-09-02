import { digestProfile, type ProfileSummary, type Profiler } from "@hitreg/core";

/**
 * The profiler UI, in its own browser window.
 *
 * A separate window rather than another dock, for one reason that matters:
 * the thing being profiled is a full-screen 3D viewport, and any panel large
 * enough to read a frame graph in shrinks the render target it is measuring —
 * changing the numbers by looking at them. A popup can also sit on a second
 * monitor while the game is played fullscreen, which is when the hitches
 * people actually complain about happen.
 *
 * Same-origin popups share the opener's JS realm, so this reads the live
 * Profiler object directly. No serialization, no message channel, no copy of
 * the ring buffer.
 *
 * It draws on the popup's own rAF at ~10Hz. The main window's frame loop must
 * not pay for the instrument watching it.
 */

/** Redraw cadence. Fast enough to feel live, slow enough to stay invisible in the profile. */
const REFRESH_MS = 100;
/** Frame-graph bar colors, in the order top-level scopes were first seen. */
const LANE_COLORS = [
  "#79c0ff", // blue
  "#d2a8ff", // purple
  "#7ee787", // green
  "#ffa657", // orange
  "#f778ba", // pink
  "#a5d6ff", // pale blue
  "#e3b341", // gold
  "#ff7b72", // red
];
const GAP_COLOR = "#484f58";
const GPU_COLOR = "#e6edf3";
/**
 * Left gutter shared by the frame graph and the marker timeline below it.
 * They MUST use the same one: a marker sitting directly under the spike it
 * caused is the entire argument for stacking these two canvases, and it only
 * holds if both plots start at the same x.
 */
const GUTTER = 104;

export interface ProfilerWindowHost {
  profiler: Profiler;
  /** Turn GPU timestamp queries on/off; returns whether they actually engaged. */
  setGpuTiming: (on: boolean) => boolean;
  /** Renderer backend name, for the header. */
  backend: string;
  /** Scene name + play mode, re-read on every refresh. */
  describeSession: () => string;
  /**
   * Save a snapshot for an agent to read. Returns the path it was written to,
   * which the window shows the human verbatim — "posted successfully" is not
   * an answer to "where did it go".
   */
  sendToAgent: (note: string) => Promise<{ file: string }>;
}

let openWindow: Window | null = null;

/**
 * Open (or focus) the profiler window. Idempotent: calling it again with the
 * window already open just focuses it, so a toolbar button and a hotkey can
 * both call it freely.
 */
export function openProfilerWindow(host: ProfilerWindowHost): void {
  if (openWindow && !openWindow.closed) {
    openWindow.focus();
    return;
  }
  const win = window.open("", "hitreg-profiler", "width=1180,height=760");
  if (!win) {
    console.warn("[profiler] popup blocked — allow popups for this origin to open the profiler");
    return;
  }
  openWindow = win;
  win.document.title = "HitReg profiler";
  win.document.body.innerHTML = "";
  const style = win.document.createElement("style");
  style.textContent = CSS;
  win.document.head.appendChild(style);
  win.document.body.innerHTML = MARKUP;

  const gpuEnabled = host.setGpuTiming(true);
  mount(win, host, gpuEnabled);

  win.addEventListener("beforeunload", () => {
    // GPU timestamps cost real per-pass work, so they follow the window
    host.setGpuTiming(false);
    openWindow = null;
  });
}

/** Close the profiler window if it is open (scene teardown, hotkey toggle). */
export function closeProfilerWindow(): void {
  if (openWindow && !openWindow.closed) openWindow.close();
  openWindow = null;
}

export function isProfilerWindowOpen(): boolean {
  return openWindow !== null && !openWindow.closed;
}

// -- rendering ---------------------------------------------------------------

function mount(win: Window, host: ProfilerWindowHost, gpuEnabled: boolean): void {
  const doc = win.document;
  const $ = <T extends HTMLElement>(id: string): T => doc.getElementById(id) as T;

  const graph = $<HTMLCanvasElement>("graph");
  const timeline = $<HTMLCanvasElement>("timeline");
  const stats = $<HTMLDivElement>("stats");
  const table = $<HTMLDivElement>("table");
  const spikes = $<HTMLDivElement>("spikes");
  const counters = $<HTMLDivElement>("counters");
  const events = $<HTMLDivElement>("events");
  const status = $<HTMLSpanElement>("status");

  let paused = false;
  /** Stable lane -> color mapping, so a scope keeps its color as scopes appear. */
  const laneColor = new Map<string, string>();
  /** Sort key for the breakdown table. */
  let sortBy: "self" | "total" | "p95" | "max" | "calls" = "self";
  let showTree = true;

  $("pause").addEventListener("click", () => {
    paused = !paused;
    $("pause").textContent = paused ? "▶ resume" : "⏸ pause";
    $("pause").classList.toggle("on", paused);
  });
  $("clear").addEventListener("click", () => host.profiler.reset());
  $("copy").addEventListener("click", () => {
    void win.navigator.clipboard
      .writeText(JSON.stringify(host.profiler.summary(), null, 2))
      .then(() => flash(status, "copied capture to clipboard"))
      .catch(() => flash(status, "clipboard blocked — use 'send to agent'"));
  });
  const note = $<HTMLInputElement>("note");
  const sent = $<HTMLDivElement>("sent");
  const sentBody = $<HTMLDivElement>("sent-body");
  $("send").addEventListener("click", () => {
    const button = $<HTMLButtonElement>("send");
    button.disabled = true;
    // Pause on snapshot. Whatever the human just saw is the thing they want
    // looked at, and letting the graph keep scrolling while they read the
    // confirmation would push it out of the window.
    if (!paused) $("pause").click();
    void host
      .sendToAgent(note.value.trim())
      .then(({ file }) => {
        note.value = "";
        sent.hidden = false;
        sentBody.innerHTML =
          `<b>Snapshot saved.</b> <code>${file}</code>` +
          `<div class="sent-how">Now tell your agent: <b>&ldquo;read the latest profile snapshot&rdquo;</b>` +
          ` &mdash; it is a file in your repo, so Claude can open it directly. An agent already ` +
          `waiting on the editor's agent inbox has been woken by this.</div>`;
      })
      .catch((error: unknown) => {
        sent.hidden = false;
        sentBody.innerHTML =
          `<b class="bad">Snapshot failed.</b> ${String(error)}` +
          `<div class="sent-how">Is the dev server still running? Use <b>copy JSON</b> and paste it instead.</div>`;
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  $("sent-close").addEventListener("click", () => {
    sent.hidden = true;
  });
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[data-sort]"))) {
    el.addEventListener("click", () => {
      sortBy = el.dataset["sort"] as typeof sortBy;
      for (const other of Array.from(doc.querySelectorAll("[data-sort]"))) {
        other.classList.toggle("sorted", other === el);
      }
    });
  }
  $("tree").addEventListener("click", () => {
    showTree = !showTree;
    $("tree").classList.toggle("on", showTree);
  });
  const threshold = $<HTMLInputElement>("threshold");
  threshold.value = String(Math.round(host.profiler.spikeMs));
  threshold.addEventListener("change", () => {
    const v = Number(threshold.value);
    if (Number.isFinite(v) && v > 0) host.profiler.spikeMs = v;
  });

  if (!gpuEnabled) {
    flash(status, "GPU timing unavailable on this backend — JS + off-loop only", 8000);
  }

  let raf = 0;
  let lastDraw = 0;
  const tick = (t: number): void => {
    if (win.closed) return;
    raf = win.requestAnimationFrame(tick);
    if (paused || t - lastDraw < REFRESH_MS) return;
    lastDraw = t;
    const summary = host.profiler.summary();
    drawHeader(stats, summary, host, gpuEnabled);
    drawDigest($("digest"), summary, host.backend);
    drawGraph(graph, host.profiler, laneColor);
    drawTimeline(timeline, host.profiler, summary);
    drawTable(table, summary, sortBy, showTree, laneColor);
    drawSpikes(spikes, summary);
    drawCounters(counters, summary);
    drawEvents(events, summary);
    $("session").textContent = host.describeSession();
  };
  raf = win.requestAnimationFrame(tick);
  win.addEventListener("beforeunload", () => win.cancelAnimationFrame(raf));
}

function flash(el: HTMLElement, message: string, ms = 3000): void {
  el.textContent = message;
  // the POPUP's timer, not the opener's — a timer owned by the opener would
  // outlive the window it is writing into
  const view = el.ownerDocument.defaultView ?? window;
  view.setTimeout(() => {
    if (el.textContent === message) el.textContent = "";
  }, ms);
}

function colorFor(path: string, laneColor: Map<string, string>): string {
  let color = laneColor.get(path);
  if (!color) {
    color = LANE_COLORS[laneColor.size % LANE_COLORS.length]!;
    laneColor.set(path, color);
  }
  return color;
}

function ms(v: number, digits = 1): string {
  return v.toFixed(digits);
}

// -- header ------------------------------------------------------------------

function drawHeader(
  el: HTMLElement,
  s: ProfileSummary,
  host: ProfilerWindowHost,
  gpuEnabled: boolean,
): void {
  // Budget verdict, stated rather than implied. "p95 28ms" means nothing to
  // someone who does not hold 16.7 in their head; "misses 60fps" does.
  const verdict =
    s.intervalMs.p95 <= 16.7
      ? { label: "holds 60fps", cls: "good" }
      : s.intervalMs.p95 <= 33.3
        ? { label: "misses 60fps", cls: "warn" }
        : { label: "misses 30fps", cls: "bad" };
  const cells: Array<[string, string, string?]> = [
    ["fps", s.fps.toFixed(0), verdict.cls],
    ["frame p50", `${ms(s.intervalMs.p50)}ms`],
    ["p95", `${ms(s.intervalMs.p95)}ms`, verdict.cls],
    ["p99", `${ms(s.intervalMs.p99)}ms`],
    ["worst", `${ms(s.intervalMs.max)}ms`],
    ["js", `${ms(s.frameMs.avg)}ms`],
    ["gpu", gpuEnabled && s.gpuMs ? `${ms(s.gpuMs.avg)}ms` : "—"],
    ["off-loop", `${ms(s.gapMs.avg)}ms`, s.gapMs.avg > 4 ? "warn" : undefined],
    ["janky", `${s.over33Pct.toFixed(0)}%`, s.over33Pct > 1 ? "warn" : undefined],
    ["window", `${s.frames}f / ${s.windowSeconds}s`],
  ];
  el.innerHTML =
    cells
      .map(
        ([label, value, cls]) =>
          `<div class="stat"><span class="k">${label}</span><span class="v ${cls ?? ""}">${value}</span></div>`,
      )
      .join("") +
    `<div class="stat"><span class="k">verdict</span><span class="v ${verdict.cls}">${verdict.label}</span></div>` +
    `<div class="stat"><span class="k">backend</span><span class="v">${host.backend}</span></div>`;
}

/**
 * The same digest that ships inside every snapshot, shown live.
 *
 * The tables and graphs below it are the evidence; this is the conclusion. It
 * is here because most of the time nobody wants to read a scope tree — they
 * want to be told whether it's fast enough and what is eating the time, and
 * making them derive that from percentiles is how a profiler ends up unused.
 */
function drawDigest(el: HTMLElement, s: ProfileSummary, backend: string): void {
  const digest = digestProfile(s, { backend });
  const cls =
    digest.verdict === "smooth" ? "good" : digest.verdict === "misses-60" ? "warn" : "bad";
  const [headline, ...rest] = digest.lines;
  el.innerHTML =
    `<div class="digest-head ${cls}">${escapeHtml(headline ?? "")}</div>` +
    rest.map((line) => `<div class="digest-line">${escapeHtml(line)}</div>`).join("");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// -- frame graph -------------------------------------------------------------

/**
 * One bar per frame, stacked by top-level scope, plus the off-loop gap on top
 * and the GPU time as an overlaid line.
 *
 * Bars are WALL-CLOCK height (JS scopes + gap), not JS-only: a graph that
 * plots only what the scopes measured draws a flat line through a stuttering
 * session, which is the exact failure this whole system exists to fix.
 */
function drawGraph(
  canvas: HTMLCanvasElement,
  profiler: Profiler,
  laneColor: Map<string, string>,
): void {
  const ctx = fitCanvas(canvas);
  if (!ctx) return;
  const { width, height } = canvas.getBoundingClientRect();
  const series = profiler.frameSeries();
  const frames = series.totals.length;
  ctx.clearRect(0, 0, width, height);
  if (frames === 0) return;

  // Scale to the worst frame in view but never below 33ms, so a smooth
  // session doesn't magnify 2ms of noise into an alarming-looking mountain
  // range. Capped so one 900ms rebuild can't flatten everything else to
  // invisibility — bars that exceed the cap are drawn clipped and marked.
  let worst = 33.3;
  for (let i = 0; i < frames; i++) worst = Math.max(worst, series.intervals[i]!);
  const scaleMax = Math.min(worst, 120);
  const y = (v: number): number => height - (v / scaleMax) * height;
  const plotWidth = Math.max(1, width - GUTTER - 4);
  const barW = Math.max(0.5, plotWidth / frames);

  // budget guides, labelled in the gutter rather than over the bars
  ctx.font = "9px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const [budget, color, label] of [
    [16.7, "#3fb950", "16.7ms · 60fps"],
    [33.3, "#d29922", "33.3ms · 30fps"],
  ] as const) {
    if (budget > scaleMax) continue;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(GUTTER, y(budget));
    ctx.lineTo(GUTTER + plotWidth, y(budget));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(label, GUTTER - 6, y(budget));
  }
  ctx.textAlign = "left";

  for (let i = 0; i < frames; i++) {
    const x = GUTTER + i * barW;
    let acc = 0;
    for (const lane of series.lanes) {
      const v = lane.values[i]!;
      if (v <= 0) continue;
      ctx.fillStyle = colorFor(lane.path, laneColor);
      const h = (v / scaleMax) * height;
      ctx.fillRect(x, y(acc + v), Math.max(1, barW - 0.25), h);
      acc += v;
    }
    // the unaccounted remainder, drawn in neutral grey and stacked ON TOP so
    // its size is read against the same budget lines as everything else
    const gap = series.gaps[i]!;
    if (gap > 0.2) {
      ctx.fillStyle = GAP_COLOR;
      ctx.fillRect(x, y(acc + gap), Math.max(1, barW - 0.25), (gap / scaleMax) * height);
      acc += gap;
    }
    if (acc > scaleMax) {
      // clipped: mark the top so a truncated bar never reads as merely "tall"
      ctx.fillStyle = "#ff7b72";
      ctx.fillRect(x, 0, Math.max(1, barW - 0.25), 2);
    }
  }

  // GPU as a line over the stack — where it sits relative to the bars is the
  // whole GPU-bound-vs-CPU-bound question, answered by looking
  let hasGpu = false;
  ctx.beginPath();
  ctx.strokeStyle = GPU_COLOR;
  ctx.lineWidth = 1;
  for (let i = 0; i < frames; i++) {
    const v = series.gpu[i]!;
    if (v <= 0) continue;
    const px = GUTTER + i * barW + barW / 2;
    if (!hasGpu) ctx.moveTo(px, y(v));
    else ctx.lineTo(px, y(v));
    hasGpu = true;
  }
  if (hasGpu) ctx.stroke();
}

// -- marker timeline ---------------------------------------------------------

/**
 * Spans (chunk loads, rebuilds, long tasks) drawn on the same time axis as the
 * frame graph directly above. Vertical alignment IS the explanation: a spike
 * with `chunk.build` sitting under it needs no further analysis.
 */
function drawTimeline(canvas: HTMLCanvasElement, profiler: Profiler, s: ProfileSummary): void {
  const ctx = fitCanvas(canvas);
  if (!ctx) return;
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  const series = profiler.frameSeries();
  const frames = series.stamps.length;
  if (frames < 2) return;
  const t0 = series.stamps[0]!;
  const t1 = series.stamps[frames - 1]! + series.totals[frames - 1]!;

  // Map time -> FRAME INDEX, then index -> x, mirroring the graph above
  // exactly. Frames are not evenly spaced in time (that is the whole subject),
  // so a purely time-linear axis here would drift out of alignment with the
  // bars — and alignment is the only reason this strip exists.
  const stamps = series.stamps;
  const indexAt = (t: number): number => {
    if (t <= stamps[0]!) return 0;
    if (t >= stamps[frames - 1]!) return frames - 1;
    let lo = 0;
    let hi = frames - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (stamps[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const plotWidth = Math.max(1, width - GUTTER - 4);
  const barW = plotWidth / frames;
  const rowHeight = 9;
  const rows = new Map<string, { row: number; spans: Array<{ t: number; ms: number }> }>();
  for (const m of s.markers) {
    if (m.t + m.ms < t0 || m.t > t1) continue;
    let lane = rows.get(m.label);
    if (!lane) {
      lane = { row: rows.size, spans: [] };
      rows.set(m.label, lane);
    }
    lane.spans.push({ t: m.t, ms: m.ms });
  }

  ctx.font = "9px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  const maxRows = Math.floor((height - 2) / rowHeight);
  let hidden = 0;
  for (const [label, lane] of rows) {
    if (lane.row >= maxRows) {
      hidden++;
      continue;
    }
    const yy = 1 + lane.row * rowHeight;
    const mid = yy + (rowHeight - 2) / 2;
    ctx.fillStyle = "#8b949e";
    ctx.textAlign = "right";
    ctx.fillText(label.length > 15 ? `${label.slice(0, 14)}…` : label, GUTTER - 6, mid);
    ctx.textAlign = "left";
    // lane rule, so an empty stretch still reads as "this lane, nothing here"
    ctx.fillStyle = "#161b22";
    ctx.fillRect(GUTTER, yy, plotWidth, rowHeight - 2);
    ctx.fillStyle = label === "long-task" ? "#ff7b72" : "#ffa657";
    for (const span of lane.spans) {
      const x = GUTTER + indexAt(span.t) * barW;
      const endX = GUTTER + indexAt(span.t + span.ms) * barW;
      ctx.fillRect(x, yy, Math.max(2, endX - x), rowHeight - 2);
    }
  }
  if (hidden > 0) {
    ctx.fillStyle = "#8b949e";
    ctx.textAlign = "right";
    ctx.fillText(`+${hidden} more`, GUTTER - 6, height - 5);
    ctx.textAlign = "left";
  }
}

function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// -- breakdown table ---------------------------------------------------------

function drawTable(
  el: HTMLElement,
  s: ProfileSummary,
  sortBy: "self" | "total" | "p95" | "max" | "calls",
  showTree: boolean,
  laneColor: Map<string, string>,
): void {
  const rows = [...s.scopes];
  if (showTree) {
    rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } else {
    const key = {
      self: (x: (typeof rows)[number]) => x.avgSelfMs,
      total: (x: (typeof rows)[number]) => x.avgMs,
      p95: (x: (typeof rows)[number]) => x.p95Ms,
      max: (x: (typeof rows)[number]) => x.maxMs,
      calls: (x: (typeof rows)[number]) => x.callsPerFrame,
    }[sortBy];
    rows.sort((a, b) => key(b) - key(a));
  }
  const maxSelf = Math.max(0.001, ...rows.map((r) => r.avgSelfMs));
  el.innerHTML = rows
    .map((r) => {
      const indent = showTree ? r.depth * 12 : 0;
      const swatch = r.depth === 0 ? colorFor(r.path, laneColor) : "transparent";
      const bar = Math.round((r.avgSelfMs / maxSelf) * 100);
      // p95/max next to the mean in every row: a scope whose mean is 0.3ms and
      // whose max is 90ms is a spike source, and only the pair says so
      return (
        `<div class="row">` +
        `<span class="name" style="padding-left:${indent}px" title="${r.path}">` +
        `<i class="dot" style="background:${swatch}"></i>${showTree ? r.name : r.path}</span>` +
        `<span class="num strong">${ms(r.avgSelfMs, 2)}</span>` +
        `<span class="num">${ms(r.avgMs, 2)}</span>` +
        `<span class="num">${ms(r.p95Ms, 2)}</span>` +
        `<span class="num ${r.maxMs > 16 ? "warn" : ""}">${ms(r.maxMs, 1)}</span>` +
        `<span class="num dim">${r.callsPerFrame < 10 ? r.callsPerFrame.toFixed(1) : r.callsPerFrame.toFixed(0)}</span>` +
        `<span class="bar"><i style="width:${bar}%"></i></span>` +
        `</div>`
      );
    })
    .join("");
}

// -- spikes ------------------------------------------------------------------

function drawSpikes(el: HTMLElement, s: ProfileSummary): void {
  if (s.spikes.length === 0) {
    el.innerHTML = `<div class="empty">Nothing above the spike threshold yet.</div>`;
    return;
  }
  el.innerHTML = [...s.spikes]
    .reverse()
    .map((spike) => {
      const worstFrame = Math.max(spike.totalMs, spike.intervalMs);
      // "the hitch was 90ms, 82ms of it outside the loop, and a chunk.build
      // span overlapped it" is a complete diagnosis in one row
      const where =
        spike.gapMs > spike.totalMs
          ? `<span class="tag warn">off-loop ${ms(spike.gapMs)}ms</span>`
          : `<span class="tag">js ${ms(spike.totalMs)}ms</span>`;
      const worst = spike.scopes
        .filter((x) => x.selfMs > 0.2)
        .slice(0, 3)
        .map((x) => `${x.path} <b>${ms(x.selfMs)}</b>`)
        .join(" · ");
      const markers = spike.markers
        .map(
          (m) =>
            `<span class="tag marker">${m.label}${m.ms > 0 ? ` ${m.ms.toFixed(0)}ms` : ""}${m.detail ? ` · ${m.detail}` : ""}</span>`,
        )
        .join("");
      return (
        `<div class="spike">` +
        `<div class="spike-head"><b>${ms(worstFrame)}ms</b> ${where}` +
        (spike.gpuMs > 0 ? `<span class="tag">gpu ${ms(spike.gpuMs)}ms</span>` : "") +
        `<span class="dim">frame ${spike.frame}</span></div>` +
        (worst ? `<div class="spike-scopes">${worst}</div>` : "") +
        (markers ? `<div class="spike-markers">${markers}</div>` : "") +
        `</div>`
      );
    })
    .join("");
}

// -- counters ----------------------------------------------------------------

function drawCounters(el: HTMLElement, s: ProfileSummary): void {
  const entries = Object.entries(s.counters).filter(([, v]) => v.max > 0);
  if (entries.length === 0) {
    el.innerHTML = `<div class="empty">No counters sampled.</div>`;
    return;
  }
  el.innerHTML = entries
    .map(
      ([name, v]) =>
        `<div class="counter"><span class="k">${name}</span>` +
        `<span class="v">${fmtCount(v.last)}</span>` +
        `<span class="dim">peak ${fmtCount(v.max)}</span></div>`,
    )
    .join("");
}

function fmtCount(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}k`;
  return v >= 100 ? v.toFixed(0) : v.toFixed(v % 1 === 0 ? 0 : 1);
}

// -- event log ---------------------------------------------------------------

function drawEvents(el: HTMLElement, s: ProfileSummary): void {
  const recent = [...s.markers].reverse().slice(0, 40);
  if (recent.length === 0) {
    el.innerHTML = `<div class="empty">No loads, rebuilds, or long tasks recorded.</div>`;
    return;
  }
  el.innerHTML = recent
    .map(
      (m) =>
        `<div class="event"><span class="k ${m.ms > 50 ? "warn" : ""}">${m.label}</span>` +
        `<span class="v">${m.ms > 0 ? `${m.ms.toFixed(0)}ms` : "·"}</span>` +
        `<span class="dim">${m.detail ?? ""}</span></div>`,
    )
    .join("");
}

// -- shell -------------------------------------------------------------------

const MARKUP = `
<header>
  <div class="title">HitReg profiler <span id="session" class="dim"></span></div>
  <div class="controls">
    <label class="field">spike &gt; <input id="threshold" type="number" min="4" step="1" /> ms</label>
    <button id="tree" class="on">tree</button>
    <button id="pause">&#9208; pause</button>
    <button id="clear">clear</button>
    <button id="copy">copy JSON</button>
    <span id="status" class="status"></span>
  </div>
</header>
<div class="snapbar">
  <input id="note" placeholder="What were you doing? e.g. flying low over the island, north side" />
  <button id="send" class="primary">&#128248; snapshot &rarr; AI</button>
</div>
<div id="sent" class="sent" hidden>
  <div id="sent-body"></div>
  <button id="sent-close" class="sent-close" title="dismiss">&times;</button>
</div>
<div id="stats" class="stats"></div>
<div id="digest" class="digest"></div>
<section class="graphs">
  <canvas id="graph"></canvas>
  <canvas id="timeline"></canvas>
  <div class="axis"><span>oldest</span><span class="dim">stacked by system &middot; grey = off-loop &middot; white line = GPU</span><span>now</span></div>
</section>
<main>
  <section class="panel wide">
    <h2>Breakdown <span class="dim">ms per frame</span></h2>
    <div class="thead">
      <span class="name">scope</span>
      <span class="num sorted" data-sort="self">self</span>
      <span class="num" data-sort="total">total</span>
      <span class="num" data-sort="p95">p95</span>
      <span class="num" data-sort="max">max</span>
      <span class="num" data-sort="calls">calls</span>
      <span class="bar"></span>
    </div>
    <div id="table" class="table"></div>
  </section>
  <section class="panel">
    <h2>Spikes <span class="dim">worst frames, newest first</span></h2>
    <div id="spikes" class="list"></div>
  </section>
  <section class="panel">
    <h2>Counters</h2>
    <div id="counters" class="list"></div>
    <h2>Events</h2>
    <div id="events" class="list"></div>
  </section>
</main>
`;

const CSS = `
:root {
  --bg: #0b0e14;
  --panel: #0d1117;
  --surface: #161b22;
  --raised: #21262d;
  --border: #30363d;
  --text: #c9d1d9;
  --emphasis: #e6edf3;
  --muted: #8b949e;
  --good: #3fb950;
  --warn: #d29922;
  --bad: #ff7b72;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--panel);
  flex: none;
}
.title { color: var(--emphasis); font-weight: 600; }
.controls { display: flex; align-items: center; gap: 6px; }
.field { color: var(--muted); font-size: 11px; }
.field input {
  width: 46px; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px; padding: 2px 4px;
  font: inherit; font-size: 11px;
}
button {
  background: var(--raised); color: var(--text); border: 1px solid var(--border);
  border-radius: 3px; padding: 3px 8px; font: inherit; font-size: 11px; cursor: pointer;
}
button:hover { border-color: #484f58; }
button.on { color: var(--emphasis); border-color: #484f58; background: #1f3a5f; }
.status { color: var(--warn); font-size: 11px; min-width: 0; }

/* the snapshot bar: the one control most people came here to use, so it gets
   a full-width row and the only filled button in the window */
.snapbar {
  display: flex; gap: 6px; align-items: center; flex: none;
  padding: 5px 10px; background: var(--panel); border-bottom: 1px solid var(--border);
}
.snapbar input {
  flex: 1 1 auto; min-width: 0; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px; padding: 4px 7px; font: inherit;
}
.snapbar input::placeholder { color: #6e7681; }
button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; padding: 4px 10px; }
button.primary:hover { background: #388bfd; border-color: #388bfd; }
button.primary:disabled { opacity: 0.55; cursor: default; }

.sent {
  position: relative; flex: none; padding: 7px 28px 8px 10px;
  background: #12261a; border-bottom: 1px solid #2ea04326; color: var(--text);
}
.sent code {
  background: var(--surface); border: 1px solid var(--border); border-radius: 3px;
  padding: 1px 5px; color: var(--emphasis);
}
.sent-how { color: var(--muted); font-size: 11px; margin-top: 3px; }
.sent-how b { color: var(--text); }
.sent-close {
  position: absolute; top: 4px; right: 6px; background: none; border: none;
  color: var(--muted); font-size: 14px; padding: 0 4px; cursor: pointer;
}
.bad { color: var(--bad); }

/* the conclusion, above the evidence */
.digest { flex: none; padding: 6px 10px 7px; border-bottom: 1px solid var(--border); background: var(--panel); }
.digest-head { font-size: 13px; color: var(--emphasis); }
.digest-head.good { color: var(--good); }
.digest-head.warn { color: var(--warn); }
.digest-head.bad { color: var(--bad); }
.digest-line { color: var(--muted); font-size: 11px; margin-top: 1px; }

.stats {
  display: flex; flex-wrap: wrap; gap: 1px; background: var(--border);
  border-bottom: 1px solid var(--border); flex: none;
}
.stat { display: flex; flex-direction: column; padding: 4px 10px; background: var(--panel); flex: 1 1 auto; min-width: 74px; }
.stat .k { color: var(--muted); font-size: 10px; text-transform: lowercase; }
.stat .v { color: var(--emphasis); font-size: 14px; }
.v.good { color: var(--good); }
.v.warn { color: var(--warn); }
.v.bad { color: var(--bad); }

.graphs { flex: none; padding: 6px 10px 2px; }
#graph { display: block; width: 100%; height: 140px; background: var(--panel); border: 1px solid var(--border); border-radius: 3px; }
#timeline { display: block; width: 100%; height: 62px; background: var(--panel); border: 1px solid var(--border); border-top: none; }
.axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 10px; padding: 2px 1px; }

main { flex: 1 1 auto; display: grid; grid-template-columns: 1.35fr 1fr 0.85fr; gap: 1px; background: var(--border); border-top: 1px solid var(--border); min-height: 0; }
.panel { background: var(--panel); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.panel h2 { margin: 0; padding: 6px 10px 4px; font-size: 11px; font-weight: 600; color: var(--emphasis); border-bottom: 1px solid var(--border); }
.panel h2 .dim { font-weight: 400; }
.dim { color: var(--muted); }
.warn { color: var(--warn); }
.empty { padding: 10px; color: var(--muted); font-size: 11px; }

.thead, .row { display: grid; grid-template-columns: 1fr 54px 54px 54px 54px 44px 64px; gap: 4px; align-items: center; padding: 1px 10px; }
.thead { color: var(--muted); font-size: 10px; border-bottom: 1px solid var(--border); padding-top: 3px; padding-bottom: 3px; }
.thead .num { cursor: pointer; }
.thead .num:hover { color: var(--text); }
.thead .sorted { color: var(--emphasis); text-decoration: underline; }
.table { overflow: auto; flex: 1 1 auto; }
.row:hover { background: #12161d; }
.row .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 5px; }
.row .dot { width: 6px; height: 6px; border-radius: 1px; flex: none; }
.row .num { text-align: right; font-variant-numeric: tabular-nums; }
.row .num.strong { color: var(--emphasis); }
.row .bar { background: var(--surface); height: 6px; border-radius: 1px; overflow: hidden; }
.row .bar i { display: block; height: 100%; background: #39506b; }

.list { overflow: auto; flex: 1 1 auto; padding: 2px 0; }
.spike { padding: 5px 10px; border-bottom: 1px solid #1c222b; }
.spike-head { display: flex; align-items: center; gap: 6px; }
.spike-head b { color: var(--bad); font-size: 13px; }
.spike-scopes { color: var(--muted); font-size: 11px; margin-top: 2px; }
.spike-scopes b { color: var(--text); font-weight: 400; }
.spike-markers { margin-top: 3px; display: flex; flex-wrap: wrap; gap: 3px; }
.tag { background: var(--surface); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; font-size: 10px; color: var(--muted); }
.tag.warn { color: var(--warn); border-color: #493c17; }
.tag.marker { color: #ffa657; border-color: #4a3520; }

.counter, .event { display: grid; grid-template-columns: 1fr auto; gap: 6px; padding: 1px 10px; align-items: baseline; }
.counter .dim, .event .dim { grid-column: 1 / 3; font-size: 10px; margin-top: -2px; }
.counter .v, .event .v { color: var(--emphasis); font-variant-numeric: tabular-nums; }
.event .k { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
