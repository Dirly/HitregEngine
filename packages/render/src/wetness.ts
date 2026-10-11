import { float, mix, mx_noise_float, normalWorld, positionWorld, smoothstep, uniform, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * How wet the world is right now, 0..1 — the weather script's `weather.wet`
 * (soaks in over a shower, dries slowly after). One uniform shared by the
 * big surfaces: voxel/splat ground and the town atlas walls. A uniform
 * write per frame; the graph is built once, so rain never recompiles.
 */
export const wetness = uniform(0);

/**
 * The snowline, world Y: above it snow lies on what faces up — the weather
 * script's `weather.snowLine` (a resting height per world, pushed down the
 * mountain by a snowfall and melting back up). Peaks white, valleys clear;
 * a season is just this number per continent. Default: nowhere.
 */
export const snowLine = uniform(1e6);
/** Height over which the snow thins from full to none, metres. */
const SNOW_BAND = 45;

/** Called by SceneLighting with the drawn scene's snowline. */
export function setSnowLine(y: number): void {
  snowLine.value = Number.isFinite(y) ? y : 1e6;
}

/** Called by SceneLighting when the weather says how wet it is. */
export function setWetness(value: number): void {
  wetness.value = Math.min(1, Math.max(0, value));
}

/** Up-facing ground soaks fully; walls take about a third (rain streaks, not puddles). */
function wetAmount(): N {
  return wetness.mul(mix(float(0.35), float(1), smoothstep(0.25, 0.8, normalWorld.y)));
}

/**
 * Is snow lying at this spot (0..1), before the surface's slope is counted:
 * how far above the snowline it is, with drift noise ragging the line so it
 * climbs gullies and breaks into patches near its edge instead of tracing a
 * contour (big drifts plus a finer noise — smooth blobs read as fog, not
 * snow). Shared by the ground and the grass, so blades sink exactly where
 * the white is.
 */
export function snowAt(x: N, y: N, z: N): N {
  const drift: N = mx_noise_float(vec3(x.mul(0.012), 7.3, z.mul(0.012))).mul(0.65)
    .add(mx_noise_float(vec3(x.mul(0.12), 3.1, z.mul(0.12))).mul(0.25))
    .add(mx_noise_float(vec3(x.mul(0.9), 2.1, z.mul(0.9))).mul(0.1));
  const above: N = y.sub(snowLine).add(drift.mul(SNOW_BAND * 1.4));
  return smoothstep(-SNOW_BAND * 0.5, SNOW_BAND * 0.25, above);
}

/**
 * The weather on a surface: wet ground is darker; in rain, flat ground
 * gathers MATTE puddles (darker, a little cold — no reflection, so the
 * painted look survives); above the snowline what faces up lies white,
 * ragged at the edge. One noise lookup each for the
 * puddle and drift patterns (world-space, so they never swim), on the ground
 * and the town walls only.
 */
export function wetColor(color: N): N {
  const up: N = normalWorld.y;
  let c: N = color.mul(mix(float(1), float(0.7), wetAmount()));
  // puddles: patches on near-level ground, growing with how wet it is
  const puddleNoise: N = mx_noise_float(vec3(positionWorld.x.mul(0.33), 0, positionWorld.z.mul(0.33))).mul(0.5).add(0.5);
  const level: N = smoothstep(0.88, 0.97, up);
  const puddle: N = smoothstep(float(0.72).sub(wetness.mul(0.12)), float(0.76).sub(wetness.mul(0.12)), puddleNoise).mul(level).mul(smoothstep(0.35, 0.8, wetness));
  c = mix(c, c.mul(vec3(0.5, 0.54, 0.62)), puddle);
  // snow: drifts first (where the noise is low), the whole up-facing ground as it deepens
  const lies: N = smoothstep(0.45, 0.8, up);
  const snow: N = snowAt(positionWorld.x, positionWorld.y, positionWorld.z).mul(lies);
  // not paper white: a cold grey-white that keeps the surface's own pattern
  // (cobbles still read as cobbles under it), so the PSX texture survives
  const lum: N = c.x.add(c.y).add(c.z).div(3);
  const white: N = vec3(0.6, 0.64, 0.7).mul(mix(float(0.72), float(1.08), smoothstep(0.03, 0.35, lum)));
  return mix(c, white, snow.mul(0.88));
}

/** …and a touch smoother. Kept mild on purpose: a glossy street fights the painted-pixel look (Derek, 2026-10-10). */
export function wetRoughness(roughness: N): N {
  // a damp sheen, not a mirror: the painted-pixel look survives rain
  return mix(roughness, roughness.mul(0.8), wetAmount());
}

/** Specular for the matte kit materials (specularIntensity 0 dry). */
export function wetSpecular(base: N): N {
  return mix(base, float(0.12), wetAmount());
}
