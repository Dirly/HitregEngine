/** Keep the browser frame chain alive when a simulation or render callback throws.
 * Errors still propagate to window.error and the dev log.
 */
export function startFramePump(
  request: (callback: (time: number) => void) => unknown,
  tick: (time: number) => void,
  profiler: { beginFrame(): void; endFrame(): void },
): void {
  const frame = (time: number): void => {
    try {
      profiler.beginFrame();
      try {
        tick(time);
      } finally {
        profiler.endFrame();
      }
    } finally {
      request(frame);
    }
  };
  request(frame);
}
