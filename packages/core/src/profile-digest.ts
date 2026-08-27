import type { ProfileSummary } from "./profiler.js";

/**
 * Turn a profile into a few sentences of English.
 *
 * The raw summary is a wall of percentiles, scope trees, and spike captures.
 * That is the right thing to KEEP, and the wrong thing to hand someone as an
 * answer — a human reading "off-loop avg 727ms, render self 21.9ms, p99
 * 4288ms" still has to know which of those numbers is the finding. So does an
 * agent, which will otherwise burn a turn re-deriving a conclusion the data
 * already fully determines.
 *
 * The digest states the conclusion: whether it's fast enough, where the time
 * actually goes, and what the worst frames had in common. It travels with
 * every snapshot, so whoever opens one first — person or model — reads the
 * same verdict.
 *
 * Deliberately conservative: it reports what the numbers say and stops. It
 * does not guess at causes it cannot see, because a confidently wrong
 * diagnosis is worse than none — chasing it costs more than reading the
 * table would have.
 */

export type PerfVerdict = "smooth" | "misses-60" | "misses-30";

export interface ProfileDigest {
  /** One line: the headline numbers plus the verdict. */
  headline: string;
  verdict: PerfVerdict;
  /** Which of JS / GPU / off-loop dominates, named in plain terms. */
  bottleneck: string;
  /** The full digest, one finding per line (headline first). */
  lines: string[];
  /** `lines` joined with newlines — what gets printed or pasted. */
  text: string;
}

const round = (v: number, digits = 1): string => v.toFixed(digits);

export function digestProfile(summary: ProfileSummary): ProfileDigest {
  if (!summary.enabled || summary.frames === 0) {
    const headline = "No frames recorded — the profiler was disabled or has just been cleared.";
    return { headline, verdict: "smooth", bottleneck: headline, lines: [headline], text: headline };
  }

  const { intervalMs, frameMs, gapMs, gpuMs } = summary;
  const verdict: PerfVerdict =
    intervalMs.p95 <= 16.7 ? "smooth" : intervalMs.p95 <= 33.3 ? "misses-60" : "misses-30";
  const verdictText =
    verdict === "smooth"
      ? "holds 60fps"
      : verdict === "misses-60"
        ? "misses 60fps, holds 30"
        : "misses 30fps";

  const headline =
    `${round(summary.fps, 0)} fps · frame p50 ${round(intervalMs.p50)}ms / ` +
    `p95 ${round(intervalMs.p95)}ms / worst ${round(intervalMs.max)}ms — ${verdictText} ` +
    `(${summary.frames} frames over ${summary.windowSeconds}s)`;

  const lines: string[] = [headline];

  // -- where the time goes ---------------------------------------------------
  // Compared as averages over the same window, so the three are commensurable.
  // GPU is only comparable when timestamps were actually resolved; treating a
  // missing GPU number as zero would silently "prove" the CPU is the problem.
  const js = frameMs.avg;
  const gap = gapMs.avg;
  const gpu = gpuMs?.avg ?? null;
  let bottleneck: string;
  if (gap >= js && (gpu === null || gap >= gpu)) {
    bottleneck =
      `Dominant cost is OFF-LOOP: ${round(gap)}ms/frame average spent outside the frame ` +
      `callback entirely (vs ${round(js)}ms of JS${gpu !== null ? ` and ${round(gpu)}ms of GPU` : ""}). ` +
      `That is garbage collection, shader/pipeline compilation, async work landing between ` +
      `frames, or a blocked GPU queue — no scope timing can see it, so optimising the ` +
      `breakdown below will not move it. Check the Events list for long-tasks and loads.`;
  } else if (gpu !== null && gpu >= js) {
    bottleneck =
      `Dominant cost is the GPU: ${round(gpu)}ms/frame average against ${round(js)}ms of JS. ` +
      `This is fill rate, shader cost, or overdraw — cutting draw calls, entity counts, or ` +
      `script work will not help. Resolution/devicePixelRatio, post-processing, and ` +
      `per-pixel shader complexity are the levers.`;
  } else {
    const hottest = [...summary.scopes].sort((a, b) => b.avgSelfMs - a.avgSelfMs)[0];
    bottleneck =
      `Dominant cost is main-thread JS: ${round(js)}ms/frame average` +
      (gpu !== null ? ` against ${round(gpu)}ms of GPU` : "") +
      (hottest ? `, led by \`${hottest.path}\` at ${round(hottest.avgSelfMs, 2)}ms self.` : ".");
  }
  lines.push(bottleneck);

  // -- the heavy scopes ------------------------------------------------------
  const hot = [...summary.scopes]
    .sort((a, b) => b.avgSelfMs - a.avgSelfMs)
    .filter((s) => s.avgSelfMs >= 0.1)
    .slice(0, 4);
  if (hot.length > 0) {
    lines.push(
      `Heaviest scopes (self ms/frame): ` +
        hot.map((s) => `${s.path} ${round(s.avgSelfMs, 2)}`).join(", ") +
        ".",
    );
  }

  // A scope whose average is trivial but whose max is enormous is a SPIKE
  // source, and neither number alone says so. This is the single most common
  // shape of "it runs fine and then jerks", so it gets its own line.
  const spiky = [...summary.scopes]
    .filter((s) => s.maxMs >= 16 && s.maxMs >= s.avgSelfMs * 20)
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, 3);
  if (spiky.length > 0) {
    lines.push(
      `Bursty (cheap on average, expensive at worst): ` +
        spiky.map((s) => `${s.path} avg ${round(s.avgSelfMs, 2)}ms / max ${round(s.maxMs)}ms`).join(", ") +
        ".",
    );
  }

  // -- what the bad frames had in common -------------------------------------
  if (summary.spikes.length > 0) {
    const worst = [...summary.spikes].sort(
      (a, b) => Math.max(b.totalMs, b.intervalMs) - Math.max(a.totalMs, a.intervalMs),
    )[0]!;
    const worstMs = Math.max(worst.totalMs, worst.intervalMs);
    const offLoopShare = worstMs > 0 ? worst.gapMs / worstMs : 0;
    lines.push(
      `${summary.spikes.length} spike${summary.spikes.length === 1 ? "" : "s"} captured; ` +
        `worst ${round(worstMs)}ms (${round(worst.gapMs)}ms of it off-loop, ${round(worst.totalMs)}ms in JS)` +
        (offLoopShare > 0.6
          ? " — so that frame was stalled by something outside the loop, not by the work in it."
          : " — so that frame's cost was inside the loop.") ,
    );
    // Which marker keeps showing up under spikes is usually the whole answer.
    const counts = new Map<string, number>();
    for (const spike of summary.spikes) {
      for (const label of new Set(spike.markers.map((m) => m.label))) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    const common = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (common.length > 0) {
      lines.push(
        `Spans overlapping spikes: ` +
          common.map(([label, n]) => `${label} (${n}/${summary.spikes.length})`).join(", ") +
          ".",
      );
    } else {
      lines.push(
        `No recorded span overlapped the spikes — the stalls are not chunk loads, scene ` +
          `rebuilds, or long tasks the app knows about.`,
      );
    }
  }

  // -- counters worth flagging ----------------------------------------------
  const flags: string[] = [];
  const draws = summary.counters["drawCalls"];
  if (draws && draws.max >= 2000) flags.push(`draw calls peak ${Math.round(draws.max)}`);
  const tris = summary.counters["triangles"];
  if (tris && tris.max >= 5_000_000) {
    flags.push(`triangles peak ${(tris.max / 1_000_000).toFixed(1)}M`);
  }
  const programs = summary.counters["programs"];
  if (programs && programs.max > programs.last + 5) {
    flags.push(`shader programs still climbing (${Math.round(programs.max)})`);
  }
  const loading = summary.counters["loading"];
  if (loading && loading.max > 0) flags.push(`peak ${Math.round(loading.max)} concurrent loads`);
  if (flags.length > 0) lines.push(`Also: ${flags.join(", ")}.`);

  if (gpuMs === null) {
    lines.push(
      `GPU timing was unavailable in this capture, so the JS/GPU split is unproven — ` +
        `open the profiler window (which enables timestamp queries) before capturing if that matters.`,
    );
  }

  return { headline, verdict, bottleneck, lines, text: lines.join("\n") };
}
