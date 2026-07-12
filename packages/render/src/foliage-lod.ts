import * as THREE from "three/webgpu";

/**
 * One (assetId, node) group's near (real geometry, one mesh per submesh) and
 * far (single cheap proxy standing in for the whole model) instanced tiers.
 * Every array here is index-aligned across near/far/positions/matrices — the
 * same instance index means the same placed prop everywhere.
 */
export interface InstancedPropBatch {
  near: THREE.InstancedMesh[];
  far: THREE.InstancedMesh;
  /** World-space position per instance — what LOD distance is measured from. */
  positions: THREE.Vector3[];
  /** Each instance's real world matrix; reused for whichever tier is active. */
  matrices: THREE.Matrix4[];
}

const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

/** Instances re-evaluated per batch, per `update()` call — bounds the worst
 * case (many instances crossing the threshold in the same frame, e.g. flying
 * straight at a dense cluster) to a fixed cost instead of an unbounded spike;
 * the rest catch up over the next few frames, which is imperceptible for LOD. */
const INSTANCES_PER_TICK = 200;

/**
 * Distance-based LOD for instanced props — the piece chunk streaming's
 * load/unload radius doesn't cover: a chunk can be well within the streamed
 * radius and still not deserve full detail because it's far from where the
 * camera is actually looking right now. Swaps each instance between its real
 * geometry and a cheap proxy by distance to the camera.
 *
 * Plain `THREE.InstancedMesh` has no per-instance visibility/culling API, so
 * "not in this tier" means "collapsed to a zero-scale matrix" (degenerate,
 * costs nothing to rasterize) rather than removed — cheap and standard.
 * Only instances that actually CHANGE tier get a matrix rewrite. Two
 * safeguards against a visible hitch:
 *  - hysteresis (a separate, closer threshold to come back near) so hovering
 *    right at the boundary doesn't flip-flop every frame.
 *  - a per-tick instance budget, round-robined across calls, so a big cluster
 *    crossing the threshold all at once (e.g. flying straight at a dense
 *    stand of trees) spreads its matrix rewrites over several frames instead
 *    of stalling one of them.
 */
export class FoliageLodSystem {
  private readonly batches = new Set<InstancedPropBatch>();
  private readonly tierByBatch = new WeakMap<InstancedPropBatch, Uint8Array>();
  private readonly cursorByBatch = new WeakMap<InstancedPropBatch, { i: number }>();

  constructor(
    private lodDistance = 100,
    private hysteresis = 0.85,
  ) {}

  setLodDistance(distance: number): void {
    this.lodDistance = distance;
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

  update(cameraPosition: THREE.Vector3): void {
    const farThresholdSq = this.lodDistance * this.lodDistance;
    const nearThresholdSq = (this.lodDistance * this.hysteresis) ** 2;
    for (const batch of this.batches) {
      const tiers = this.tierByBatch.get(batch);
      const cursor = this.cursorByBatch.get(batch);
      if (!tiers || !cursor) continue;
      const count = batch.positions.length;
      if (count === 0) continue;
      const steps = Math.min(count, INSTANCES_PER_TICK);
      let touched = false;
      for (let step = 0; step < steps; step++) {
        const i = (cursor.i + step) % count;
        const distSq = batch.positions[i]!.distanceToSquared(cameraPosition);
        const wasNear = tiers[i] === 1;
        // hysteresis: only flip far->near once WELL inside the boundary,
        // near->far only once past it — a dead zone in between holds still
        const isNear = wasNear ? distSq < farThresholdSq : distSq < nearThresholdSq;
        const wantTier = isNear ? 1 : 2;
        if (tiers[i] === wantTier) continue;
        tiers[i] = wantTier;
        touched = true;
        const matrix = batch.matrices[i]!;
        for (const mesh of batch.near) mesh.setMatrixAt(i, isNear ? matrix : ZERO_SCALE);
        batch.far.setMatrixAt(i, isNear ? ZERO_SCALE : matrix);
      }
      cursor.i = (cursor.i + steps) % count;
      if (touched) {
        for (const mesh of batch.near) mesh.instanceMatrix.needsUpdate = true;
        batch.far.instanceMatrix.needsUpdate = true;
      }
    }
  }
}
