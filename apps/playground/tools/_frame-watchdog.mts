/**
 * Frame watchdog for headless shot runs (light-shots): a run whose browser hangs on load produces no frame and burns
 * no CPU, and once held a heavy-lock slot for 61 min with 0 frames (2026-10-21). Progress = the run started, a spot
 * started, or a frame landed; when nothing progressed for `limitMs` (10 min) the run is declared hung.
 *
 * Pure timer logic (the clock is injected) so it is testable; the tool polls `check()` and on a verdict kills its
 * browser + dev server and exits non-zero.
 */
export interface FrameWatchdog {
  /** A frame was written. */
  frame(): void;
  /** A new spot began (a spot may load a new region: its own 10 min). */
  spot(name: string): void;
  /** null while healthy; else why the run is hung. */
  check(): string | null;
  readonly frames: number;
}

export function frameWatchdog(opts: { limitMs?: number; now?: () => number } = {}): FrameWatchdog {
  const limit = opts.limitMs ?? 10 * 60_000, now = opts.now ?? Date.now;
  const t0 = now();
  let last = t0, frames = 0, where = "start";
  return {
    frame() { frames++; last = now(); },
    spot(name: string) { where = `spot ${name}`; last = now(); },
    check() {
      const idle = now() - last;
      if (idle <= limit) return null;
      const min = (idle / 60_000).toFixed(1);
      return frames ? `no frame for ${min} min since ${where} (${frames} frame(s) so far)` : `no frame within ${min} min of ${where === "start" ? "the start" : where} (0 frames)`;
    },
    get frames() { return frames; },
  };
}
