export interface LoopOptions {
  /** Simulation rate. Default 60. */
  fixedHz?: number;
  /** Max fixed steps per tick before dropping time (spiral-of-death guard). Default 5. */
  maxSubSteps?: number;
  /** Gameplay state may only change here. Runs on client and headless server alike. */
  fixedUpdate: (dt: number) => void;
  /** Render-side per-frame hook; alpha ∈ [0,1) interpolates between sim states. */
  update?: (dt: number, alpha: number) => void;
}

/**
 * Fixed-timestep simulation loop, decoupled from render. Driver-agnostic: the
 * caller supplies timestamps via tick() (requestAnimationFrame in the browser,
 * setInterval/setImmediate on a headless server, hand-fed times in tests) —
 * which is also what makes the sim deterministic and replayable.
 */
export class FixedTimestepLoop {
  readonly fixedDt: number;
  private readonly maxSubSteps: number;
  private readonly fixedUpdate: (dt: number) => void;
  private readonly update: ((dt: number, alpha: number) => void) | undefined;
  private accumulator = 0;
  private lastMs: number | null = null;

  constructor(options: LoopOptions) {
    this.fixedDt = 1 / (options.fixedHz ?? 60);
    this.maxSubSteps = options.maxSubSteps ?? 5;
    this.fixedUpdate = options.fixedUpdate;
    this.update = options.update;
  }

  tick(nowMs: number): void {
    if (this.lastMs === null) {
      this.lastMs = nowMs;
      return;
    }
    const frameDt = Math.max(0, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    this.accumulator += frameDt;

    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
      this.fixedUpdate(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
    }
    // if we hit the substep cap, drop the backlog instead of spiraling
    if (this.accumulator >= this.fixedDt) {
      this.accumulator = this.accumulator % this.fixedDt;
    }

    this.update?.(frameDt, this.accumulator / this.fixedDt);
  }
}
