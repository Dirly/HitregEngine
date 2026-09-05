import * as THREE from "three/webgpu";
import {
  floor,
  abs,
  atan,
  dot,
  float,
  length,
  mix,
  mx_fractal_noise_float,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  smoothstep,
  sub,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";

/** TSL nodes are structurally dynamic — the same escape hatch grass.ts uses. */
export type N = any;

/**
 * The handful of node-graph idioms every procedural VFX module is built from.
 * They hang on `MeshBasicNodeMaterial`, the same material the particle emitter
 * and the water surface already use, so all of this renders on the WebGPU
 * backend and its WebGL fallback with no second shader system.
 */

/** Uniform bundle every procedural material carries; set per frame by the module. */
export interface FxUniforms {
  color: THREE.UniformNode<"color", THREE.Color>;
  glow: THREE.UniformNode<"color", THREE.Color>;
  opacity: THREE.UniformNode<"float", number>;
  time: THREE.UniformNode<"float", number>;
  /** Free per-kind float knobs (noise strength, softness, dissolve…). */
  a: THREE.UniformNode<"float", number>;
  b: THREE.UniformNode<"float", number>;
  c: THREE.UniformNode<"float", number>;
  d: THREE.UniformNode<"float", number>;
  e: THREE.UniformNode<"float", number>;
}

export function makeUniforms(): FxUniforms {
  return {
    color: uniform(new THREE.Color(1, 1, 1)),
    glow: uniform(new THREE.Color(1, 1, 1)),
    opacity: uniform(1, "float"),
    time: uniform(0, "float"),
    a: uniform(0, "float"),
    b: uniform(0, "float"),
    c: uniform(0, "float"),
    d: uniform(0, "float"),
    e: uniform(0, "float"),
  };
}

/** Rim term: 1 at the silhouette, 0 face-on; symmetric so both sides work. */
export function fresnel(power: N): N {
  const facing: N = abs(dot(normalView, positionViewDirection));
  return pow(saturate(sub(float(1), facing)), power);
}

/** 3D fractal noise mapped to 0..1 — the texture no effect has to ship. */
export function noise01(p: N, octaves = 2): N {
  const n: N = mx_fractal_noise_float(p, octaves, 2, 0.5);
  return saturate(n.mul(0.5).add(0.5));
}

/** Fade in over [0, lo] and out over [1 - hi, 1] of a 0..1 coordinate. */
export function capFade(v: N, lo: N, hi: N): N {
  const inA: N = smoothstep(float(0), lo.max(0.001), v);
  const outA: N = sub(float(1), smoothstep(sub(float(1), hi.max(0.001)), float(1), v));
  return inA.mul(outA);
}

/**
 * A soft annulus on a unit disc's UVs: 1 across the band, feathered at both
 * edges. `inner` 0 makes a filled disc with only the outer edge feathered.
 */
export function ringBand(inner: N, soft: N, r: N): N {
  const edge: N = soft.mul(sub(float(1), inner)).mul(0.5).add(0.02);
  const outer: N = sub(float(1), smoothstep(sub(float(1), edge), float(1), r));
  const innerA: N = smoothstep(inner, inner.add(edge), r);
  return outer.mul(mix(float(1), innerA, saturate(inner.mul(1000))));
}

/** Disc radius (0 centre → 1 rim) and polar angle from the quad's UVs. */
export function discPolar(): { r: N; angle: N } {
  const p: N = uv().sub(vec2(0.5, 0.5)).mul(2);
  return { r: length(p), angle: atan(p.y, p.x) };
}

/** Scrolling noise in polar space so streaks spiral instead of translate. */
export function swirlNoise(r: N, angle: N, swirl: N, time: N, scale: N): N {
  const a: N = angle.add(r.mul(swirl).mul(6)).sub(time.mul(1.5));
  return noise01(vec3(r.mul(scale), a.mul(1.6), time.mul(0.35)), 2);
}

/** Snap a 0..1 coordinate (or vector) to `cells` steps; cells <= 0 leaves it smooth. */
export function quantize(v: N, cells: N): N {
  const c: N = cells.max(1);
  const snapped: N = floor(v.mul(c)).add(0.5).div(c);
  return mix(v, snapped, saturate(cells));
}

/** Posterise an alpha to `steps` bands; steps <= 0 leaves it smooth. */
export function posterize(a: N, steps: N): N {
  const s: N = steps.max(1);
  const banded: N = floor(a.mul(s).add(0.001)).div(s);
  return mix(a, banded, saturate(steps));
}
