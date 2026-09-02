import * as THREE from "three/webgpu";
import {
  add,
  clamp,
  float,
  mul,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  time,
  vec3,
} from "three/tsl";
import { editMeshMaterials } from "./node-material.js";

type N = ReturnType<typeof float>;

/** Tag on a material this module has already wired, and the flag hlod-proxy reads. */
export const FOLIAGE_WIND = "foliageWind";

/**
 * How a plant answers the wind.
 *
 * These are two genuinely different motions, not one with a knob, which is why
 * they are an enum rather than a strength:
 *
 * - `sway` BENDS the whole plant from a pinned base. Displacement grows with
 *   height, so the plant leans as one piece and its roots never leave the
 *   ground. This is what a bush or a reed does.
 * - `ripple` shivers each leaf card on the spot with NO net lean. The phase
 *   varies across the model, so cards move against each other and the canopy
 *   shimmers while the tree itself stands still. This is what a big trunk does
 *   in a light wind — the timber does not visibly bend, only the foliage moves.
 *
 * Applying `sway` to a tree is the classic mistake: the trunk swings like a
 * blade of grass and the whole model reads as rubber.
 */
export type FoliageWindMode = "sway" | "ripple";

export interface FoliageWindOptions {
  mode: FoliageWindMode;
  /** Peak displacement in METRES (world units), not a fraction of the model. */
  strength: number;
  /** Oscillations per second, roughly. */
  speed: number;
  /**
   * `ripple` only: fraction of the model's height where the canopy starts.
   *
   * Everything below is held perfectly still, which is how the trunk stays out
   * of it. Deliberately a HEIGHT test and not "is this the leaf material":
   * Blockbench exports every material as `alphaMode: MASK`, so a cutout test
   * catches the trunk too (the same trap `applyFoliageNormals` documents), and
   * where the trunk sits horizontally is model-specific in a way its height
   * is not.
   */
  canopy?: number;
}

/**
 * Give a model's foliage wind motion, as a vertex-shader displacement.
 *
 * The two weights this needs — how high a vertex is up the plant, and how far
 * the whole plant has been placed from the origin — come from two DIFFERENT
 * position nodes, and swapping them is the bug that eats an afternoon:
 *
 * - `positionGeometry` is the raw authored vertex, always model-local. That is
 *   the only thing that can answer "how far up the plant is this?", and it
 *   keeps working under instancing.
 * - `positionLocal` has, by the time this node runs, already been rewritten in
 *   place by the instancing pass to the post-instance-matrix position. So it
 *   is effectively where this copy of the plant STANDS, which is exactly what
 *   a wave phase wants: neighbouring plants come out slightly out of step and
 *   a gust reads as rolling across the field instead of every plant in the
 *   world twitching in unison. (`grass.ts` documents the same pair.)
 *
 * Deliberately no per-instance attribute: deriving the phase from position
 * means this survives the mid-tier decimation and the HLOD merge without
 * needing an attribute that either pass could drop.
 */
export function applyFoliageWind(root: THREE.Object3D, options: FoliageWindOptions): number {
  const strength = Math.max(0, options.strength);
  if (strength === 0) return 0;
  const speed = options.speed > 0 ? options.speed : 1;

  // One bounding box for the WHOLE model, not per submesh: "how far up the
  // plant" has to mean the same thing on the trunk primitive and the leaf
  // primitive, and glTF routinely splits those. (This is the opposite of what
  // `foliageNormals` needs, which is why it computes its own per-primitive.)
  const box = new THREE.Box3().setFromObject(root);
  const height = Math.max(1e-3, box.max.y - box.min.y);
  const base = box.min.y;

  const t = mul(time, float(speed));
  // low spatial frequency, so a gust is metres wide rather than per-plant noise
  const place = mul(add(positionLocal.x, positionLocal.z), float(0.28));
  const up = clamp(positionGeometry.y.sub(float(base)).div(float(height)), 0, 1);

  let offset: N;
  if (options.mode === "sway") {
    // squared, so the bottom of the plant barely moves and the top carries the
    // whole bend — a linear ramp shears the base visibly off the ground
    const bend = mul(up, up);
    // two waves at an irrational-ish ratio: one period is obvious as a loop
    const wave = add(sin(add(t, place)), mul(sin(add(mul(t, float(0.37)), mul(place, float(0.6)))), float(0.5)));
    const amount = mul(wave, mul(bend, float(strength)));
    offset = vec3(amount, mul(amount, float(-0.12)), mul(amount, float(0.35))) as unknown as N;
  } else {
    const canopy = Math.min(0.95, Math.max(0, options.canopy ?? 0.35));
    const mask = smoothstep(float(canopy), float(Math.min(0.98, canopy + 0.2)), up);
    // Phase from the MODEL-LOCAL vertex, so cards on one tree are out of step
    // with each other — that incoherence is the entire difference between a
    // ripple and a sway. `place` is folded in only so two trees standing side
    // by side do not shimmer identically.
    const vertex = add(
      mul(positionGeometry.x, float(3.1)),
      add(mul(positionGeometry.y, float(2.7)), mul(positionGeometry.z, float(4.3))),
    );
    const phase = add(vertex, place);
    const a = sin(add(t, phase));
    const b = sin(add(mul(t, float(1.7)), mul(phase, float(1.3))));
    const amp = mul(mask, float(strength));
    offset = vec3(mul(a, amp), mul(b, mul(amp, float(0.45))), mul(b, amp)) as unknown as N;
  }

  return editMeshMaterials(root, (material) => {
    if (material.userData[FOLIAGE_WIND]) return false;
    material.positionNode = add(positionLocal, offset);
    material.userData[FOLIAGE_WIND] = true;
    return true;
  });
}
