import * as THREE from "three/webgpu";

/**
 * One (assetId, node) group's near (real geometry, one mesh per submesh),
 * optional mid (decimated geometry, same submesh split — see
 * `MID_TIER_MIN_VERTS` in scene-builder.ts), and far (single cheap proxy
 * standing in for the whole model) instanced tiers. Every array here is
 * index-aligned across near/mid/far/positions/matrices — the same instance
 * index means the same placed prop everywhere.
 */
export interface InstancedPropBatch {
  near: THREE.InstancedMesh[];
  /** Present only for models heavy enough that a decimated middle tier is
   * worth the one-time simplification cost (see scene-builder.ts). Props
   * without one just swap directly between near and far, as before. */
  mid?: THREE.InstancedMesh[];
  far: THREE.InstancedMesh;
  /** World-space position per instance — what LOD distance is measured from. */
  positions: THREE.Vector3[];
  /** Each instance's real world matrix; reused for whichever tier is active. */
  matrices: THREE.Matrix4[];
}

const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

/** Instances re-evaluated per batch, per `update()` call — bounds the worst
 * case (many instances crossing a threshold in the same frame, e.g. flying
 * straight at a dense cluster) to a fixed cost instead of an unbounded spike;
 * the rest catch up over the next few frames, which is imperceptible for LOD. */
const INSTANCES_PER_TICK = 200;

/**
 * Distance-based LOD for instanced props — the piece chunk streaming's
 * load/unload radius doesn't cover: a chunk can be well within the streamed
 * radius and still not deserve full detail because it's far from where the
 * camera is actually looking right now. Swaps each instance between tiers by
 * distance to the camera: full-detail near, an optional decimated mid tier,
 * and a cheap billboard/box far tier.
 *
 * Plain `THREE.InstancedMesh` has no per-instance visibility/culling API, so
 * "not in this tier" means "collapsed to a zero-scale matrix" (degenerate,
 * costs nothing to rasterize) rather than removed — cheap and standard.
 * Only instances that actually CHANGE tier get a matrix rewrite. Two
 * safeguards against a visible hitch:
 *  - hysteresis (a separate, closer threshold to come back toward the camera)
 *    so hovering right at a boundary doesn't flip-flop every frame.
 *  - a per-tick instance budget, round-robined across calls, so a big cluster
 *    crossing a threshold all at once (e.g. flying straight at a dense stand
 *    of trees) spreads its matrix rewrites over several frames instead of
 *    stalling one of them.
 */
export class FoliageLodSystem {
  private readonly batches = new Set<InstancedPropBatch>();
  private readonly tierByBatch = new WeakMap<InstancedPropBatch, Uint8Array>();
  private readonly cursorByBatch = new WeakMap<InstancedPropBatch, { i: number }>();

  constructor(
    /** far threshold: past this, everything collapses to the billboard/box proxy. */
    private lodDistance = 100,
    private hysteresis = 0.85,
    /** near threshold: inside this, full-detail geometry; between this and
     * `lodDistance`, the decimated mid tier (when a batch has one). */
    private nearDistance = 40,
  ) {}

  setLodDistance(distance: number): void {
    this.lodDistance = distance;
  }

  setNearDistance(distance: number): void {
    this.nearDistance = distance;
  }

  register(batch: InstancedPropBatch): void {
    this.batches.add(batch);
    this.tierByBatch.set(batch, new Uint8Array(batch.positions.length)); // 0 = unset, forces a first write
    this.cursorByBatch.set(batch, { i: 0 });
  }

  unregister(batch: InstancedPropBatch): void {
    this.batches.delete(batch);
    this.tierByBatch.delete(batch);
    this.cursorByBatch.delete(batch);
  }

  /** Instance counts currently resident in each tier, summed across every
   * registered batch — for the stats HUD, not the hot path. */
  tierCounts(): { near: number; mid: number; far: number } {
    const counts = { near: 0, mid: 0, far: 0 };
    for (const batch of this.batches) {
      const tiers = this.tierByBatch.get(batch);
      if (!tiers) continue;
      for (const tier of tiers) {
        if (tier === 1) counts.near++;
        else if (tier === 2) counts.mid++;
        else if (tier === 3) counts.far++;
      }
    }
    return counts;
  }

  update(cameraPosition: THREE.Vector3): void {
    const midFarThresholdSq = this.lodDistance * this.lodDistance;
    const midFarHystSq = (this.lodDistance * this.hysteresis) ** 2;
    const nearMidThresholdSq = this.nearDistance * this.nearDistance;
    const nearMidHystSq = (this.nearDistance * this.hysteresis) ** 2;
    for (const batch of this.batches) {
      const tiers = this.tierByBatch.get(batch);
      const cursor = this.cursorByBatch.get(batch);
      if (!tiers || !cursor) continue;
      const count = batch.positions.length;
      if (count === 0) continue;
      const hasMid = !!batch.mid && batch.mid.length > 0;
      const steps = Math.min(count, INSTANCES_PER_TICK);
      let touched = false;
      for (let step = 0; step < steps; step++) {
        const i = (cursor.i + step) % count;
        const distSq = batch.positions[i]!.distanceToSquared(cameraPosition);
        const prevTier = tiers[i];
        let wantTier: number;
        if (!hasMid) {
          // original 2-tier behavior: 1 = near, 3 = far (2 is simply unused)
          const wasNear = prevTier === 1;
          const isNear = wasNear ? distSq < midFarThresholdSq : distSq < midFarHystSq;
          wantTier = isNear ? 1 : 3;
        } else {
          const wasNear = prevTier === 1;
          const wasMidOrNear = prevTier === 1 || prevTier === 2;
          const isNearSide = wasNear ? distSq < nearMidThresholdSq : distSq < nearMidHystSq;
          const isMidOrCloser = wasMidOrNear ? distSq < midFarThresholdSq : distSq < midFarHystSq;
          wantTier = !isMidOrCloser ? 3 : isNearSide ? 1 : 2;
        }
        if (tiers[i] === wantTier) continue;
        tiers[i] = wantTier;
        touched = true;
        const matrix = batch.matrices[i]!;
        for (const mesh of batch.near) mesh.setMatrixAt(i, wantTier === 1 ? matrix : ZERO_SCALE);
        if (hasMid) for (const mesh of batch.mid!) mesh.setMatrixAt(i, wantTier === 2 ? matrix : ZERO_SCALE);
        batch.far.setMatrixAt(i, wantTier === 3 ? matrix : ZERO_SCALE);
      }
      cursor.i = (cursor.i + steps) % count;
      if (touched) {
        for (const mesh of batch.near) mesh.instanceMatrix.needsUpdate = true;
        if (hasMid) for (const mesh of batch.mid!) mesh.instanceMatrix.needsUpdate = true;
        batch.far.instanceMatrix.needsUpdate = true;
      }
    }
  }
}
