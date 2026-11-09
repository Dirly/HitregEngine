/**
 * Render scale that backs off on a GPU that cannot keep up.
 *
 * Every per-pixel cost (terrain splat, water, PBR, bloom, volumetrics) follows the pixel count, so resolution is the
 * one lever that helps a weak laptop GPU across the board; the DOM HUD stays sharp because the browser upscales only
 * the canvas. It moves ONLY when the frame is slow and the main thread is not why: a CPU-bound frame gains nothing
 * from fewer pixels and keeps its sharpness.
 *
 * Busy share alone misjudges: loading, shader builds and uploads all stretch the interval without main-thread work, and
 * a first version rode a CPU-bound machine down to its floor that way. So every step down is an EXPERIMENT: the next
 * window must show the frame got faster, or the step is undone and the scale holds for HOLD_WINDOWS. Fewer pixels that
 * buy nothing cost sharpness for nothing. Hosts also skip `frame()` while content is loading.
 *
 * Decisions use medians over a window, so a streaming hitch moves nothing. Resizing reallocates the render targets, so
 * steps are rare; after a raise that had to be undone, the wait before the next raise doubles, so a machine sitting on
 * the edge settles instead of pumping the image sharper and softer.
 *
 * `busyMs` is main-thread time inside the frame. WebGPU submission is asynchronous, so GPU time shows up as frame
 * interval without busy time: that gap is the signal, and it needs no timestamp queries.
 */
export interface AdaptiveResolutionOptions {
  /** Back off when the median frame is slower than this (default 1000/45: only machines truly struggling). */
  slowMs?: number;
  /** Raise again only when the median frame is at least this fast (default 1000/58). */
  fastMs?: number;
  /** Lowest scale (default 0.6). */
  min?: number;
  /** Scale change per step (default 0.1). */
  step?: number;
  /** Frames per decision (default 90). */
  window?: number;
  /** The frame counts as GPU-limited when busy time is under this share of it (default 0.75). */
  gpuShare?: number;
}

/** Longest frame that counts: a hidden tab or a load stall says nothing about the GPU. */
const MAX_SAMPLE_MS = 250;
const MAX_RAISE_WAIT = 64;
/** A step down must make the median frame at least this much faster to stand. */
const STEP_MUST_GAIN = 0.95;
/** Windows to leave the scale alone after a step down bought nothing. */
const HOLD_WINDOWS = 40;

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1] ?? 0;
}

export class AdaptiveResolution {
  scale = 1;
  readonly stats = { down: 0, up: 0, undone: 0, lastFrameMs: 0, lastBusyMs: 0 };
  private readonly slowMs: number;
  private readonly fastMs: number;
  private readonly min: number;
  private readonly step: number;
  private readonly window: number;
  private readonly gpuShare: number;
  private frames: number[] = [];
  private busy: number[] = [];
  private lastTime: number | null = null;
  private fastWindows = 0;
  private raiseWait = 4;
  private justRaised = false;
  /** Median frame before the step down under test, or null. */
  private testing: number | null = null;
  private holdWindows = 0;

  constructor(options: AdaptiveResolutionOptions = {}) {
    this.slowMs = options.slowMs ?? 1000 / 45;
    this.fastMs = options.fastMs ?? 1000 / 58;
    this.min = options.min ?? 0.6;
    this.step = options.step ?? 0.1;
    this.window = options.window ?? 90;
    this.gpuShare = options.gpuShare ?? 0.75;
  }

  /** Feed one frame (rAF time, main-thread ms inside it). Returns the new scale when it changed, else null. */
  frame(time: number, busyMs: number): number | null {
    const last = this.lastTime;
    this.lastTime = time;
    if (last === null) return null;
    const frameMs = time - last;
    if (!(frameMs > 0) || frameMs > MAX_SAMPLE_MS) return null;
    this.frames.push(frameMs);
    this.busy.push(busyMs);
    if (this.frames.length < this.window) return null;
    const medianFrame = median(this.frames);
    const medianBusy = median(this.busy);
    this.frames = [];
    this.busy = [];
    this.stats.lastFrameMs = medianFrame;
    this.stats.lastBusyMs = medianBusy;
    if (this.testing !== null) {
      const before = this.testing;
      this.testing = null;
      if (medianFrame > before * STEP_MUST_GAIN) {
        this.stats.undone++;
        this.holdWindows = HOLD_WINDOWS;
        return this.set(this.scale + this.step);
      }
    }
    if (medianFrame > this.slowMs) {
      this.fastWindows = 0;
      if (this.holdWindows > 0) {
        this.holdWindows--;
        return null;
      }
      if (medianBusy >= medianFrame * this.gpuShare || this.scale <= this.min) return null;
      if (this.justRaised) this.raiseWait = Math.min(MAX_RAISE_WAIT, this.raiseWait * 2);
      this.justRaised = false;
      this.testing = medianFrame;
      this.stats.down++;
      return this.set(this.scale - this.step);
    }
    this.justRaised = false;
    if (this.scale >= 1 || medianFrame > this.fastMs) {
      this.fastWindows = 0;
      return null;
    }
    if (++this.fastWindows < this.raiseWait) return null;
    this.fastWindows = 0;
    this.justRaised = true;
    this.stats.up++;
    return this.set(this.scale + this.step);
  }

  /** Forget the timing history (leaving play, a load): the next frame starts a fresh window. */
  reset(): void {
    this.frames = [];
    this.busy = [];
    this.lastTime = null;
    this.fastWindows = 0;
    this.testing = null;
  }

  private set(scale: number): number {
    this.scale = Math.round(Math.min(1, Math.max(this.min, scale)) * 100) / 100;
    return this.scale;
  }
}

/** `?renderScale=0.75` pins the scale, `?renderScale=1` turns the backing-off off; null = adaptive. */
export function renderScaleFromSearch(search: string): number | null {
  const value = new URLSearchParams(search).get("renderScale");
  if (value === null) return null;
  const scale = Number(value);
  return scale > 0 && scale <= 1 ? scale : null;
}
