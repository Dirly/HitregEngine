/**
 * Sim step jitter for the server-side proofs (prove.mts fight): a fight judged on a machine too loaded to keep the
 * fixed step is not a verdict. Every server tick is timed; when the MEDIAN tick takes more than 1.5x the fixed step
 * the run is "unjudged (load)" instead of FAILED (a pass still counts: the creatures were beaten anyway).
 *
 *   import { instrumentTicks, judgeUnderLoad } from "../../../../../tools/dungeon-pipeline/step-jitter.mjs";
 *   const jitter = instrumentTicks(server, { fixedStepMs: world.fixedDt * 1000 });   // after the server is built
 *   ...fight...
 *   const verdict = judgeUnderLoad(passed, jitter.summary());
 *   out("fight.json", { ...verdict, ...rest });   // passed, result, unjudged?, stepJitter
 *
 * The pipeline shows a report carrying `unjudged` as UNJUDGED (re-run on a quiet machine), not FAILED.
 */

/** The load rule: median step over the fixed step by more than this fraction. */
export const LOAD_OVER = 0.5;

/** A step-time recorder. `now` is injectable (tests use a fake clock). */
export function stepJitter({ fixedStepMs, now = () => performance.now() }) {
  const steps = [];
  return {
    record(ms) { steps.push(ms); },
    /** wrap a step function so each call is timed */
    wrap(fn) { return function timed(...a) { const t = now(); try { return fn.apply(this, a); } finally { steps.push(now() - t); } }; },
    summary() {
      const s = [...steps].sort((a, b) => a - b), q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
      const medianMs = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
      const r = (v) => +v.toFixed(3);
      return { steps: s.length, fixedStepMs: r(fixedStepMs), medianMs: r(medianMs), p95Ms: r(q(0.95)), maxMs: r(s.at(-1) ?? 0),
        ratio: fixedStepMs > 0 ? r(medianMs / fixedStepMs) : 0, underLoad: s.length > 0 && medianMs > fixedStepMs * (1 + LOAD_OVER) };
    },
  };
}

/** Time every `server.tick()` (replaces the method on this instance). */
export function instrumentTicks(server, { fixedStepMs, now } = {}) {
  const j = stepJitter({ fixedStepMs, now });
  server.tick = j.wrap(server.tick.bind(server));
  return j;
}

/** The fight verdict: PASSED / FAILED, or "unjudged (load)" when it failed while the median step was over the rule. */
export function judgeUnderLoad(passed, stepJitterSummary) {
  const j = stepJitterSummary;
  if (passed) return { passed: true, result: "PASSED", stepJitter: j };
  if (j?.underLoad) return { passed: false, result: "unjudged (load)", unjudged: `load: median step ${j.medianMs} ms > ${1 + LOAD_OVER}x the fixed ${j.fixedStepMs} ms — re-run on a quiet machine`, stepJitter: j };
  return { passed: false, result: "FAILED", stepJitter: j };
}
