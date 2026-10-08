import * as THREE from "three/webgpu";
import {
  abs,
  add,
  clamp,
  color as tslColor,
  dot,
  float,
  floor,
  fract,
  hash,
  max,
  min,
  div,
  exp2,
  log2,
  length,
  positionWorld,
  cameraPosition,
  mix,
  mul,
  normalize,
  saturate,
  smoothstep,
  sin,
  cos,
  step,
  sub,
  time,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { foliageWindScale } from "./foliage-wind.js";
import { sceneLighting, type SkyDomeUniforms } from "./scene-lighting.js";

/**
 * The OPEN-SEA layer of the water shader (`material.water.sea`).
 *
 * Built for cost first — the ocean is the biggest surface on screen:
 *
 * - every feature is compiled in only when its strength is above 0 at build
 *   time, so a disabled knob is no maths at all;
 * - no noise functions, no loops, no extra texture fetches: hashes on a
 *   snapped world grid, two sines for the swell, and the depth/normal/foam
 *   values the water shader has already computed;
 * - the live sky comes in as a handful of uniforms copied once per render
 *   from whatever scene is being rendered (its dome's uniforms), so
 *   day/night, weather and zone moods reach the sea with no material change
 *   and no recompile.
 */

/** `material.water.sea`, zod-defaulted (see `seaWaterSchema` in @hitreg/core). */
export interface SeaParams {
  sky: number;
  skySteps: number;
  swellHeight: number;
  swellLength: number;
  swellDirection: [number, number];
  swellWind: number;
  swellStorm: number;
  shelterDepth: number;
  abyssColor: string;
  abyssDepth: number;
  abyssStrength: number;
  breakers: number;
  breakerReach: number;
  breakerCount: number;
  breakerPeriod: number;
  breakerWidth: number;
  /** Water depth (m) the breakers run over, on depth contours; 0 = the older shore-distance estimate. */
  breakerDepth?: number;
  /** 0 = clean even lines, 1 = fronts torn into segments and frayed by the texture. */
  breakerBreakup?: number;
  whitecaps: number;
  whitecapStorm: number;
  whitecapPixel: number;
  glints: number;
  glintPixel: number;
  glintSize: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Live sky + weather, shared by every sea material. Values are copied from
 * the rendered scene's sky dome by `syncSeaSky` (an onRenderUpdate on the
 * uniforms the graphs use), so they are right for whichever scene draws.
 */
export const seaSky = {
  /** 1 when the scene has a live gradient dome; 0 falls back to the old rim colour. */
  on: uniform(0),
  top: uniform(new THREE.Color("#5fa9ff")),
  bottom: uniform(new THREE.Color("#101522")),
  /** The cloud deck as lit right now (mid of its lit and shadow colours, times its light). */
  cloud: uniform(new THREE.Color("#8a94a8")),
  cloudCover: uniform(0),
  /** Toward the sun, unit. */
  sunDirection: uniform(new THREE.Vector3(0.4, 0.55, 0.3).normalize()),
  sunColor: uniform(new THREE.Color("#fff6df")),
  /** Glint strength 0..1: daylight, minus storm and cloud. */
  glint: uniform(0),
  /** Unit wind direction on world XZ (where the weather is blowing), or zero with no wind. */
  wind: uniform(new THREE.Vector2(0, 0)),
  /** Storm level 0..1. */
  storm: uniform(0),
};

let stormOverride: number | null = null;

/**
 * Pin the sea's storm level (0..1); null returns it to the default, which is
 * derived from the weather wind (`setSkyLive({ weather: { wind } })` — the
 * weather builtin raises it with its storm).
 */
export function setSeaStorm(storm: number | null): void {
  stormOverride = storm === null ? null : Math.min(1, Math.max(0, storm));
}

/** The dome's sun direction as first seen: unchanged means no day/night script moves it. */
const initialSun = new WeakMap<object, THREE.Vector3>();
const scratch = new THREE.Color();
let lastRender = -1;

function syncSeaSky(frame: { scene?: THREE.Scene | null; renderId?: number }): undefined {
  // several uniforms carry this hook; do the copy once per render
  if (frame.renderId !== undefined && frame.renderId === lastRender) return undefined;
  lastRender = frame.renderId ?? -1;
  const scene = frame.scene;
  const lighting = scene ? sceneLighting(scene) : null;
  const dome = lighting?.skyDomeUniforms() as SkyDomeUniforms | null | undefined;
  // the foliage wind multiplier is 1 when calm and ~1 + 3 x storm under the
  // weather builtin (its windMax), so this is the storm level it published
  const storm = stormOverride ?? Math.min(1, Math.max(0, (foliageWindScale.value - 1) / 2.25));
  seaSky.storm.value = storm;
  if (!dome || !lighting) {
    seaSky.on.value = 0;
    seaSky.glint.value = 0;
    return undefined;
  }
  seaSky.on.value = 1;
  seaSky.top.value.copy(dome.top.value);
  seaSky.bottom.value.copy(dome.bottom.value);
  const light = dome.cloudLight.value;
  scratch.copy(dome.cloudColor.value).lerp(dome.cloudShadow.value, 0.55).multiplyScalar(light);
  seaSky.cloud.value.copy(scratch);
  const cover = dome.cloudCoverage.value;
  seaSky.cloudCover.value = cover;
  const speed = dome.cloudSpeed.value;
  const len = Math.hypot(speed.x, speed.y);
  // the dome scrolls its cloud texture BY the speed, so the clouds themselves move against it
  if (len > 1e-4) seaSky.wind.value.set(-speed.x / len, -speed.y / len);
  else seaSky.wind.value.set(0, 0);
  // the sun: the dome's when a day/night script is moving it, otherwise the
  // authored directional light (the dome's own default is not tied to it)
  let first = initialSun.get(dome);
  if (!first) initialSun.set(dome, (first = dome.sunDirection.value.clone()));
  let sunY: number;
  if (dome.sunIntensity.value > 0 || !first.equals(dome.sunDirection.value)) {
    seaSky.sunDirection.value.copy(dome.sunDirection.value);
    seaSky.sunColor.value.copy(dome.sunColor.value);
    sunY = dome.sunDirection.value.y;
  } else {
    const base = lighting.liveSkyBase()?.sun;
    if (base) {
      seaSky.sunDirection.value.set(base.direction[0], base.direction[1], base.direction[2]).normalize();
      seaSky.sunColor.value.set(base.color);
    }
    sunY = seaSky.sunDirection.value.y;
  }
  const up = Math.min(1, Math.max(0, sunY * 6));
  seaSky.glint.value = lighting.daylight() * up * (1 - 0.9 * storm) * (1 - 0.7 * Math.max(0, cover - 0.3));
  return undefined;
}

seaSky.on.onRenderUpdate(syncSeaSky);
seaSky.storm.onRenderUpdate(syncSeaSky);
seaSky.glint.onRenderUpdate(syncSeaSky);

/**
 * A hash seed for a world cell. TSL's `hash` converts its seed to an UNSIGNED
 * int, so every negative seed (any cell at negative world x or z) collapsed
 * to one value and a whole region of cells acted as one — a glint "sheet".
 * Folded positive with abs (a mirror pairing of far-apart cells, never seen).
 */
function cellSeed(cell: N): N {
  return add(abs(dot(cell, vec2(float(1), float(157)))), float(1));
}

/** What the swell hands the rest of the sea graph. */
export interface SeaSwell {
  /** World-XZ slope of the swell surface, to bend the normal by. */
  slopeX: N;
  slopeZ: N;
  /** Normalised height, about -1 (trough) .. 1 (crest), already sheltered. */
  crest: N;
  /** Travel direction (unit, world XZ) and speed m/s — whitecaps drift with it. */
  dir: N;
  speed: number;
}

/**
 * Two long sines (the second turned 35 degrees, shorter) — the swell. Pure
 * shading: on the ocean's ~100 m grid a displaced swell would alias, and
 * the reflection of the sky gradient along the slope is what reads as a
 * roll. ~20 ALU.
 */
export function seaSwell(sea: SeaParams, worldXZ: N, shelter: N): SeaSwell | null {
  if (sea.swellHeight <= 0) return null;
  const k1 = (Math.PI * 2) / Math.max(1, sea.swellLength);
  const k2 = k1 * 1.37;
  // deep-water dispersion, eased: a 60 m swell rolls at ~7 m/s
  const w1 = Math.sqrt(9.81 * k1) * 0.7;
  const w2 = Math.sqrt(9.81 * k2) * 0.7;
  const [ax, az] = sea.swellDirection;
  const al = Math.hypot(ax, az) || 1;
  const authored = vec2(float(ax / al), float(az / al));
  const dir: N = sea.swellWind > 0 ? normalize(mix(authored, seaSky.wind as N, float(sea.swellWind)).add(vec2(float(1e-4), float(0)))) : authored;
  const c = Math.cos(0.61);
  const s = Math.sin(0.61);
  const dir2: N = vec2(sub(mul(dir.x, float(c)), mul(dir.y, float(s))), add(mul(dir.x, float(s)), mul(dir.y, float(c))));
  const p1: N = sub(mul(dot(worldXZ, dir), float(k1)), mul(time, float(w1)));
  const p2: N = add(sub(mul(dot(worldXZ, dir2), float(k2)), mul(time, float(w2))), float(1.7));
  const amp: N = mul(mul(float(sea.swellHeight * 0.5), add(float(1), mul(seaSky.storm as N, float(sea.swellStorm)))), shelter);
  const c1: N = mul(cos(p1), float(k1));
  const c2: N = mul(cos(p2), float(k2 * 0.6));
  return {
    slopeX: mul(amp, add(mul(c1, dir.x), mul(c2, dir2.x))),
    slopeZ: mul(amp, add(mul(c1, dir.y), mul(c2, dir2.y))),
    crest: mul(mul(add(sin(p1), mul(sin(p2), float(0.6))), float(1 / 1.6)), shelter),
    dir,
    speed: w1 / k1,
  };
}

/**
 * The live sky along the reflected ray: the dome's zenith/horizon gradient
 * with its horizon haze, posterised, greyed by the cloud cover. ~18 ALU.
 * `fallback` is what the old rim was (used with no dome in the scene).
 */
export function seaSkyReflection(sea: SeaParams, reflected: N, fallback: N): N {
  const ry: N = max(reflected.y, float(0));
  let t: N = saturate(mul(add(ry, float(0.35)), float(1 / 1.35)));
  if (sea.skySteps > 0) t = mul(floor(add(mul(t, float(sea.skySteps)), float(0.5))), float(1 / sea.skySteps));
  let sky: N = mix(seaSky.bottom as N, seaSky.top as N, t);
  const haze: N = sub(float(1), smoothstep(float(0), float(0.22), ry));
  sky = mix(sky, seaSky.bottom as N, mul(haze, float(0.6)));
  // the deck covers the upper sky; low rays still see the horizon under it
  sky = mix(sky, seaSky.cloud as N, mul(mul(seaSky.cloudCover as N, float(0.85)), smoothstep(float(0.03), float(0.3), ry)));
  return mix(fallback, sky, mul(seaSky.on as N, float(sea.sky)));
}

/**
 * Pixel-snapped sun glints: each `glintPixel` cell gets a jittered facet; it
 * lights when the jittered reflection lands inside the sun cone, and blinks
 * in steps. Returns an additive colour. ~25 ALU, no fetch.
 */
export function seaGlint(sea: SeaParams, worldXZ: N, reflected: N, swell: SeaSwell | null): N | null {
  if (sea.glints <= 0) return null;
  // the grid drifts with the swell so the glitter rides the waves
  const drift: N = swell ? mul(swell.dir, mul(time, float(swell.speed * 0.25))) : vec2(float(0), float(0));
  // the cell size steps with camera distance (powers of two), so a glint is
  // about the same few pixels near and far instead of a tile at your feet
  const dist: N = length(sub(positionWorld, cameraPosition));
  const lod: N = exp2(floor(log2(clamp(mul(dist, float(1 / 40)), 0.125, 8))));
  const cell: N = floor(div(sub(worldXZ, drift), mul(lod, float(sea.glintPixel))));
  const h: N = hash(add(cellSeed(cell), mul(lod, float(1.3e5))));
  // only a few cells can glint at all: sparkles, never a sheet
  const eligible: N = step(h, float(0.14));
  const blink: N = hash(add(mul(h, float(1e6)), floor(add(mul(time, float(5)), mul(h, float(3))))));
  const jitter: N = mul(sub(vec2(hash(mul(h, float(7.3e5))), hash(mul(h, float(3.1e5)))), float(0.5)), float(0.5));
  const facet: N = normalize(vec3(add(reflected.x, jitter.x), abs(reflected.y), add(reflected.z, jitter.y)));
  const facing: N = step(float(1 - sea.glintSize), dot(facet, seaSky.sunDirection as N));
  const g: N = mul(mul(mul(facing, eligible), step(float(0.5), blink)), mul(seaSky.glint as N, float(sea.glints * 1.6)));
  // clamped: a glint is a bright pixel, never a blown-out patch under bloom
  return min(mul(seaSky.sunColor as N, g), vec3(float(1.4), float(1.4), float(1.4)));
}

/**
 * Whitecaps: blocky flecks on swell crests in open water, more in a storm.
 * Two levels (core + half-tone fringe) — PS1, not a gradient. ~20 ALU.
 */
export function seaWhitecaps(sea: SeaParams, worldXZ: N, swell: SeaSwell | null, shelter: N): N | null {
  if (sea.whitecaps <= 0 && sea.whitecapStorm <= 0) return null;
  const drift: N = swell ? mul(swell.dir, mul(time, float(swell.speed * 0.5))) : vec2(float(0), float(0));
  const moved: N = sub(worldXZ, drift);
  const cell: N = floor(mul(moved, float(1 / sea.whitecapPixel)));
  const h: N = hash(cellSeed(cell));
  // each block re-rolls on its own slow clock, so caps form and die
  const n: N = hash(add(mul(h, float(1e6)), floor(add(mul(time, float(0.6)), h))));
  // ...and they come in CLUMPS: a coarse cell (6 blocks across) is either a
  // breaking patch or calm, so a cap is a ragged cluster, not one lone tile
  // (looked up at a point jittered by the block's own hash, so a clump's edge is
  // ragged block by block instead of the coarse cell's square)
  const ragged: N = add(moved, mul(sub(vec2(h, hash(mul(h, float(5.3e5)))), float(0.5)), float(sea.whitecapPixel * 4)));
  const patch: N = hash(add(cellSeed(floor(mul(ragged, float(1 / (sea.whitecapPixel * 6))))), float(7)));
  const clump: N = mul(step(patch, float(0.3)), float(3));
  const crest: N = swell ? saturate(swell.crest) : float(0.6);
  const amount: N = mul(add(float(sea.whitecaps), mul(seaSky.storm as N, float(sea.whitecapStorm))), shelter);
  const want: N = mul(mul(mul(crest, crest), amount), clump);
  return add(step(n, mul(want, float(0.55))), mul(step(n, want), float(0.45)));
}

/**
 * Breaker lines: fronts parallel to the shore (on the water shader's
 * distance-to-shore field, metres) rolling in in sets, a solid front with a
 * stepped foam trail tearing up behind it, broken into segments. `breakup`
 * is the water texture's snapped foam sample if any. ~24 ALU, no fetch.
 */
export function seaBreakers(sea: SeaParams, shoreDistance: N, worldXZ: N, breakup: N | null, steps: number, swell: SeaSwell | null = null, depth: N | null = null): N | null {
  if (sea.breakers <= 0) return null;
  // Depth contours when asked (`breakerDepth`): the bed is smooth, so lines of
  // equal depth run evenly parallel to the beach. The shore-distance estimate
  // is a screen-space derivative — blocky in 2x2 quads, and it wobbles with the
  // view and every bump in the bed, which is what broke the lines up.
  const byDepth = (sea.breakerDepth ?? 0) > 0 && depth !== null;
  const u: N = byDepth ? mul(depth, float(1 / sea.breakerDepth!)) : mul(shoreDistance, float(1 / sea.breakerReach));
  const tearAmount = Math.min(1, Math.max(0, sea.breakerBreakup ?? 1));
  let phase: N = add(mul(u, float(sea.breakerCount)), mul(time, float(1 / sea.breakerPeriod)));
  // the swell bends the fronts gently; the texture frays them by `breakerBreakup`
  if (swell) phase = add(phase, mul(swell.crest, float(0.22 * (0.4 + 0.6 * tearAmount))));
  if (breakup && tearAmount > 0) phase = add(phase, mul(sub(breakup, float(0.45)), float(0.3 * tearAmount)));
  const p: N = fract(phase);
  const wave: N = floor(phase);
  // segments ~5 m long, re-dealt for every wave; dropped only by `breakerBreakup`
  const seg: N = hash(add(cellSeed(floor(mul(worldXZ, float(1 / 5))) as N), mul(fract(mul(wave, float(0.1031))), float(5e5))) as N);
  const strength: N = tearAmount > 0
    ? mix(float(1), mul(step(float(0.3), seg), add(float(0.4), mul(seg, float(0.6)))), float(tearAmount))
    : float(1);
  // a solid roll at the front, then a trail that tears into blocks of the
  // (snapped) texture as it thins out behind
  const trail: N = saturate(sub(float(1), mul(p, float(1 / sea.breakerWidth))));
  const torn: N = breakup ? saturate(mul(sub(add(breakup, mul(trail, float(0.9))), float(0.5)), float(4))) : trail;
  const tear: N = tearAmount > 0 ? mix(trail, torn, float(tearAmount)) : trail;
  const line: N = mul(trail, tear);
  // build up as they cross into breaking depth, die as they reach the beach
  const env: N = mul(sub(float(1), smoothstep(float(0.75), float(1), u)), smoothstep(float(0), float(0.04), u));
  const raw: N = mul(mul(line, env), mul(strength, float(sea.breakers)));
  const s = Math.max(1, steps);
  return clamp(mul(floor(mul(raw, float(s + 0.999))), float(1 / s)), 0, 1);
}

/** Deep water sinks toward the abyss colour, over the texture. ~6 ALU. */
export function seaAbyss(sea: SeaParams, base: N, depth: N): N {
  if (sea.abyssStrength <= 0) return base;
  return mix(base, tslColor(sea.abyssColor) as N, mul(smoothstep(float(0), float(sea.abyssDepth), depth), float(sea.abyssStrength)));
}
