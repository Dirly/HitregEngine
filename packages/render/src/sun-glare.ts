import * as THREE from "three/webgpu";
import { exp, float, length, max, mix, screenUV, smoothstep, step, uniform, vec2, vec3, vec4 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Glare when you look toward the sun: a wide soft bloom of its light over the
 * screen and a faint ghost mirrored through the centre — gone the moment a
 * roof, a cliff or a cloud deck stands in the way. Visibility is five taps of
 * the scene depth around the sun's screen position (sky = far plane), so it
 * is a handful of ALU per pixel plus five texture reads, inside the post
 * chain that already runs; no pass, no draw.
 */
export const sunGlare = {
  uv: uniform(new THREE.Vector2(0.5, 0.5)),
  /** 0 = off (sun behind you, below the horizon, under overcast). */
  amount: uniform(0),
  color: uniform(new THREE.Color(1, 0.9, 0.75)),
  aspect: uniform(16 / 9),
};

/** Off switch for A/B timing (setWorldExtrasEnabled). */
let glareEnabled = true;
export function setSunGlareEnabled(on: boolean): void {
  glareEnabled = on;
}

/** Strength of the glare at full, clear daylight, looking straight at the sun. */
const GLARE = 0.55;

const ndc = new THREE.Vector3();
const eye = new THREE.Vector3();
const forward = new THREE.Vector3();

/** Once a frame: project the sun, weigh by facing and how open the sky is. */
export function updateSunGlare(camera: THREE.Camera, towardSun: THREE.Vector3, color: THREE.Color, strength: number): void {
  camera.getWorldPosition(eye);
  camera.getWorldDirection(forward);
  const facing = forward.dot(towardSun);
  ndc.copy(towardSun).multiplyScalar(1000).add(eye).project(camera);
  const edge = Math.max(Math.abs(ndc.x), Math.abs(ndc.y));
  const onScreen = facing > 0 ? 1 - THREE.MathUtils.smoothstep(edge, 0.9, 1.5) : 0;
  sunGlare.uv.value.set(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  sunGlare.amount.value = glareEnabled ? GLARE * strength * onScreen * Math.max(0, facing) : 0;
  sunGlare.color.value.copy(color);
  const persp = camera as THREE.PerspectiveCamera;
  if (persp.isPerspectiveCamera) sunGlare.aspect.value = persp.aspect;
}

/** Add the glare to the post chain's working colour; `depth`/`scene` = the scene pass depth and colour texture nodes. */
export function applySunGlare(color: N, depth: N, scene: N): N {
  const sun: N = sunGlare.uv;
  // how much of the sun's disc is open sky: five depth taps around it
  const r = 0.006;
  let open: N = float(0);
  for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]] as const) {
    const at: N = sun.add(vec2(dx, dy));
    open = open.add(step(0.9999, depth.sample(at).r));
  }
  open = open.div(5);
  // the dome draws cloud at the far plane too: only a BRIGHT sun pixel (the
  // disc itself, HDR > 1) is a sun you can see; cloud over it is ~0.2-0.6
  const lum: N = scene.sample(sun).rgb.dot(vec3(0.2126, 0.7152, 0.0722));
  open = open.mul(smoothstep(0.7, 1.6, lum));
  const d: N = screenUV.sub(sun).mul(vec2(sunGlare.aspect, 1));
  const glow: N = exp(length(d).mul(-6)).mul(0.6).add(exp(length(d).mul(-22)).mul(0.8));
  // a faint ghost on the far side of the centre
  const ghostAt: N = vec2(1, 1).sub(sun);
  const g: N = screenUV.sub(ghostAt).mul(vec2(sunGlare.aspect, 1));
  const ghost: N = smoothstep(0.09, 0.05, length(g)).mul(0.08);
  const inside: N = step(0, sun.x).mul(step(sun.x, 1)).mul(step(0, sun.y)).mul(step(sun.y, 1));
  const k: N = max(sunGlare.amount, 0).mul(open).mul(mix(float(0.4), float(1), inside));
  return vec4(color.rgb.add(sunGlare.color.mul(glow.add(ghost)).mul(k)), color.a);
}
