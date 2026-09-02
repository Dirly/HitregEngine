import * as THREE from "three/webgpu";
import { writeImpostorSlot, type ImpostorInstanceData } from "./impostor.js";
import type { InstancedProps } from "./instancing.js";

/**
 * One (assetId, node) group's near (real geometry, one mesh per submesh),
 * optional mid (decimated geometry, same submesh split — see
 * `MID_TIER_MIN_VERTS` in scene-builder.ts), and far (single cheap proxy
 * standing in for the whole model) instanced tiers. Every array here is
 * index-aligned across near/mid/far/positions/matrices — the same instance
 * index means the same placed prop everywhere.
 */
export interface InstancedPropBatch {
  near: InstancedProps[];
  /** Present only for models heavy enough that a decimated middle tier is
   * worth the one-time simplification cost (see scene-builder.ts). Props
   * without one just swap directly between near and far, as before. */
  mid?: InstancedProps[];
  far: InstancedProps;
  /** World-space position per instance — what LOD distance is measured from. */
  positions: THREE.Vector3[];
  /** Each instance's real world matrix; reused for whichever tier is active. */
  matrices: THREE.Matrix4[];
  /** Geometric deviation of the mid tier from the near tier, in model units
   * (before each instance's own matrix; per-submesh scale already folded in).
   * The system projects it to a screen-space error to pick the near→mid
   * switch distance per batch — a rock whose decimated tier is within a
   * centimetre of the real thing gives up full detail a few metres out; a
   * sloppily-decimated canopy keeps its near tier for longer. Absent or 0 →
   * the system's fixed `nearDistance` fallback. */
  midError?: number;
  /** Present when `far` is an octahedral impostor quad (impostor.ts): each
   * logical instance's rotation/scale, which the system copies into the far
   * geometry's instanced side-buffers whenever it (re)writes a far slot. */
  impostor?: ImpostorInstanceData;
}

/** Instances re-evaluated per batch, per `update()` call — bounds the worst
 * case (many instances crossing a threshold in the same frame, e.g. flying
 * straight at a dense cluster) to a fixed cost instead of an unbounded spike;
 * the rest catch up over the next few frames, which is imperceptible for LOD. */
const INSTANCES_PER_TICK = 200;

const UNSET = 0;
const NEAR = 1;
const MID = 2;
const FAR = 3;

/** Floor on the error-driven near→mid distance: whatever the numbers say, a
 * prop the camera is practically touching shows its real geometry. */
const MIN_NEAR_DISTANCE = 5;
const DEFAULT_VIEWPORT_HEIGHT = 1080;
const DEFAULT_FOV_DEGREES = 50; // three's PerspectiveCamera default

/**
 * Per-batch runtime state for the compacted-buffer scheme (see class doc).
 * `tier[i]`/`slot[i]` are indexed by LOGICAL instance index (the same index
 * space as `batch.positions`/`batch.matrices`). `slotToIndex[tier-1]` is the
 * reverse map — which logical instance currently sits at buffer slot `s` of
 * that tier — needed for O(1) swap-remove. `counts[tier-1]` is that tier's
 * live instance count, i.e. what `mesh.count` is kept in sync with.
 */
interface BatchState {
  tier: Uint8Array;
  slot: Int32Array;
  slotToIndex: [Int32Array, Int32Array, Int32Array];
  counts: [number, number, number];
  cursor: number;
  /** Largest per-axis scale across this batch's instance matrices — what
   * turns the batch's model-unit `midError` into a world-unit one. */
  maxInstanceScale: number;
  /** This batch's near→mid threshold (squared) and its hysteresis twin —
   * per batch, because they derive from the batch's own mid-tier error. */
  nearMidThresholdSq: number;
  nearMidHystSq: number;
}

function tierMeshes(batch: InstancedPropBatch, tierNum: number): readonly InstancedProps[] {
  if (tierNum === NEAR) return batch.near;
  if (tierNum === MID) return batch.mid ?? [];
  return [batch.far];
}

/** Swap-remove logical instance `i` out of `tierNum`'s compacted buffer. */
function removeFromTier(state: BatchState, batch: InstancedPropBatch, tierNum: number, i: number): void {
  const arrIdx = (tierNum - 1) as 0 | 1 | 2;
  const slotToIndex = state.slotToIndex[arrIdx];
  const lastSlot = state.counts[arrIdx] - 1;
  const mySlot = state.slot[i]!;
  const lastIndex = slotToIndex[lastSlot]!;
  const meshes = tierMeshes(batch, tierNum);
  if (lastIndex !== i) {
    // the last active slot's occupant moves into the freed slot, keeping
    // [0, count) fully packed with no gaps
    slotToIndex[mySlot] = lastIndex;
    state.slot[lastIndex] = mySlot;
    const matrix = batch.matrices[lastIndex]!;
    for (const mesh of meshes) {
      mesh.setMatrixAt(mySlot, matrix);
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (tierNum === FAR) writeImpostorSlot(batch.far, batch.impostor, mySlot, lastIndex);
  }
  state.counts[arrIdx] = lastSlot;
  for (const mesh of meshes) mesh.instanceCount = lastSlot;
}

/** Append logical instance `i` to `tierNum`'s compacted buffer. */
function addToTier(state: BatchState, batch: InstancedPropBatch, tierNum: number, i: number): void {
  const arrIdx = (tierNum - 1) as 0 | 1 | 2;
  const slot = state.counts[arrIdx];
  state.slotToIndex[arrIdx][slot] = i;
  state.slot[i] = slot;
  state.counts[arrIdx] = slot + 1;
  const matrix = batch.matrices[i]!;
  const meshes = tierMeshes(batch, tierNum);
  for (const mesh of meshes) {
    mesh.setMatrixAt(slot, matrix);
    mesh.instanceCount = slot + 1;
    mesh.instanceMatrix.needsUpdate = true;
  }
  if (tierNum === FAR) writeImpostorSlot(batch.far, batch.impostor, slot, i);
}

/**
 * Distance-based LOD for instanced props — the piece chunk streaming's
 * load/unload radius doesn't cover: a chunk can be well within the streamed
 * radius and still not deserve full detail because it's far from where the
 * camera is actually looking right now. Swaps each instance between tiers by
 * distance to the camera: full-detail near, an optional decimated mid tier,
 * and a cheap billboard/box far tier.
 *
 * Each tier's `InstancedProps.instanceCount` is kept equal to the number of instances
 * ACTUALLY in that tier, with active instances packed into buffer slots
 * [0, count) — NOT "all N instances always, with inactive ones zero-scaled".
 * Zero-scaling alone hides inactive instances visually but a GPU instanced
 * draw still runs the vertex shader (and counts toward triangle-count stats)
 * for every instance up to `mesh.count`, regardless of scale — so with 4,000+
 * props, the near tier's full vertex cost was being paid every frame for
 * every prop, not just the ~200 actually close to the camera. This is a
 * classic swap-compaction free list (per tier, per batch): moving an
 * instance between tiers is an O(1) remove-from-old + append-to-new, and
 * `mesh.count` is simply that tier's live count — no per-frame resort needed.
 *
 * Two safeguards against a visible hitch:
 *  - hysteresis (a separate, closer threshold to come back toward the camera)
 *    so hovering right at a boundary doesn't flip-flop every frame.
 *  - a per-tick instance budget, round-robined across calls, so a big cluster
 *    crossing a threshold all at once (e.g. flying straight at a dense stand
 *    of trees) spreads its matrix rewrites over several frames instead of
 *    stalling one of them.
 *
 * The near→mid threshold is per batch, driven by screen-space error: a batch
 * that reports its mid tier's geometric deviation (`midError`, from the
 * simplifier) switches where that deviation projects to `screenErrorPx`
 * pixels — `px = error · H / (2 · d · tan(fov/2))`, solved for `d` — so
 * smooth props drop to their cheaper tier close up and rough ones hold on,
 * and a bigger viewport or narrower FOV pushes every threshold out on its
 * own. Batches with no error data keep the fixed `nearDistance`. The mid→far
 * threshold stays a plain distance: the far tier is a billboard/box, not a
 * geometric approximation with a measurable error.
 */
export class FoliageLodSystem {
  private readonly stateByBatch = new Map<InstancedPropBatch, BatchState>();
  private viewportHeight = DEFAULT_VIEWPORT_HEIGHT;
  private tanHalfFov = Math.tan((DEFAULT_FOV_DEGREES * Math.PI) / 360);

  constructor(
    /** far threshold: past this, everything collapses to the billboard/box proxy. */
    private lodDistance = 100,
    private hysteresis = 0.85,
    /** near threshold for batches with no `midError`: inside this, full-detail
     * geometry; between this and `lodDistance`, the decimated mid tier. */
    private nearDistance = 40,
    /** how many pixels of geometric error the mid tier may show before the
     * near tier takes over — the knob behind every error-driven threshold. */
    private screenErrorPx = 2,
  ) {}

  setLodDistance(distance: number): void {
    this.lodDistance = distance;
    this.refreshThresholds();
  }

  setNearDistance(distance: number): void {
    this.nearDistance = distance;
    this.refreshThresholds();
  }

  setScreenError(pixels: number): void {
    this.screenErrorPx = pixels;
    this.refreshThresholds();
  }

  /** Viewport height (pixels) and vertical FOV (degrees) of the camera the
   * LOD is judged against. Cheap and idempotent when nothing changed, so it's
   * fine to call every frame right before `update()`. */
  setProjection(viewportHeightPx: number, fovYDegrees: number): void {
    const tanHalfFov = Math.tan((fovYDegrees * Math.PI) / 360);
    if (viewportHeightPx === this.viewportHeight && Math.abs(tanHalfFov - this.tanHalfFov) < 1e-6) return;
    this.viewportHeight = viewportHeightPx;
    this.tanHalfFov = tanHalfFov;
    this.refreshThresholds();
  }

  /** The distance at which `batch`'s mid tier becomes indistinguishable from
   * its near tier under the current projection — see the class doc. */
  nearThresholdFor(batch: InstancedPropBatch): number {
    const state = this.stateByBatch.get(batch);
    const error = batch.midError;
    if (!state || error === undefined || !(error > 0)) return this.nearDistance;
    const worldError = error * state.maxInstanceScale;
    const distance = (worldError * this.viewportHeight) / (2 * this.tanHalfFov * this.screenErrorPx);
    return Math.min(Math.max(distance, MIN_NEAR_DISTANCE), this.lodDistance);
  }

  private applyThreshold(batch: InstancedPropBatch, state: BatchState): void {
    const distance = this.nearThresholdFor(batch);
    state.nearMidThresholdSq = distance * distance;
    state.nearMidHystSq = (distance * this.hysteresis) ** 2;
  }

  private refreshThresholds(): void {
    for (const [batch, state] of this.stateByBatch) this.applyThreshold(batch, state);
  }

  register(batch: InstancedPropBatch): void {
    const n = batch.positions.length;
    let maxInstanceScale = 0;
    for (const matrix of batch.matrices) maxInstanceScale = Math.max(maxInstanceScale, matrix.getMaxScaleOnAxis());
    const state: BatchState = {
      tier: new Uint8Array(n),
      slot: new Int32Array(n),
      slotToIndex: [new Int32Array(n), new Int32Array(n), new Int32Array(n)],
      counts: [0, 0, 0],
      cursor: 0,
      maxInstanceScale: maxInstanceScale > 0 ? maxInstanceScale : 1,
      nearMidThresholdSq: 0,
      nearMidHystSq: 0,
    };
    this.stateByBatch.set(batch, state);
    this.applyThreshold(batch, state);
    // nothing is classified into any tier yet — every mesh starts at count 0
    // (not the constructor's default of "all N instances") so a freshly
    // registered batch costs nothing until update() actually places instances
    for (const mesh of batch.near) mesh.instanceCount = 0;
    if (batch.mid) for (const mesh of batch.mid) mesh.instanceCount = 0;
    batch.far.instanceCount = 0;
  }

  unregister(batch: InstancedPropBatch): void {
    this.stateByBatch.delete(batch);
  }

  /** Instance counts currently resident in each tier, summed across every
   * registered batch — for the stats HUD, not the hot path. */
  tierCounts(): { near: number; mid: number; far: number } {
    const counts = { near: 0, mid: 0, far: 0 };
    for (const state of this.stateByBatch.values()) {
      counts.near += state.counts[0];
      counts.mid += state.counts[1];
      counts.far += state.counts[2];
    }
    return counts;
  }

  update(cameraPosition: THREE.Vector3): void {
    const midFarThresholdSq = this.lodDistance * this.lodDistance;
    const midFarHystSq = (this.lodDistance * this.hysteresis) ** 2;
    for (const [batch, state] of this.stateByBatch) {
      const count = batch.positions.length;
      if (count === 0) continue;
      const hasMid = !!batch.mid && batch.mid.length > 0;
      const { nearMidThresholdSq, nearMidHystSq } = state;
      const steps = Math.min(count, INSTANCES_PER_TICK);
      for (let step = 0; step < steps; step++) {
        const i = (state.cursor + step) % count;
        const distSq = batch.positions[i]!.distanceToSquared(cameraPosition);
        const prevTier = state.tier[i]!;
        let wantTier: number;
        if (!hasMid) {
          // original 2-tier behavior: 1 = near, 3 = far (2 is simply unused)
          const wasNear = prevTier === NEAR;
          const isNear = wasNear ? distSq < midFarThresholdSq : distSq < midFarHystSq;
          wantTier = isNear ? NEAR : FAR;
        } else {
          const wasNear = prevTier === NEAR;
          const wasMidOrNear = prevTier === NEAR || prevTier === MID;
          const isNearSide = wasNear ? distSq < nearMidThresholdSq : distSq < nearMidHystSq;
          const isMidOrCloser = wasMidOrNear ? distSq < midFarThresholdSq : distSq < midFarHystSq;
          wantTier = !isMidOrCloser ? FAR : isNearSide ? NEAR : MID;
        }
        if (prevTier === wantTier) continue;
        if (prevTier !== UNSET) removeFromTier(state, batch, prevTier, i);
        addToTier(state, batch, wantTier, i);
        state.tier[i] = wantTier;
      }
      state.cursor = (state.cursor + steps) % count;
    }
  }
}
