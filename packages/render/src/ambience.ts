import type * as THREE from "three/webgpu";
import { chimneySmoke } from "./chimney-smoke.js";
import { birds, birdMaterial } from "./birds.js";
import { distantWindowMaterial, distantWindows } from "./distant-windows.js";
import { smokeMaterial } from "./chimney-smoke.js";
import { haloMaterial } from "./light-glow.js";
import { poolMaterial } from "./light-pools.js";
import { shadowMaterial } from "./contact-shadows.js";
import { windowCardMaterial } from "./window-lights.js";
import { cloudShadow } from "./cloud-shadow.js";
import { fogLamps } from "./atmosphere.js";
import { setSunGlareEnabled } from "./sun-glare.js";
import { lightShading } from "./light-budget.js";

let fogGain = fogLamps.gain.value;

/**
 * Switch every cheap world extra off or on at once — light halos, pools and
 * fog glow, window light cards, chimney smoke, birds, contact shadows, cloud
 * shadows, sun glare — for an A/B frame-time measurement in one session.
 * Material visibility and uniforms only: no rebuild, no recompile.
 */
export function setWorldExtrasEnabled(on: boolean): void {
  for (const m of [haloMaterial(), poolMaterial(), birdMaterial(), shadowMaterial(), smokeMaterial(), windowCardMaterial(), distantWindowMaterial()]) m.visible = on;
  if (!on && fogLamps.gain.value > 0) fogGain = fogLamps.gain.value;
  fogLamps.gain.value = on ? fogGain : 0;
  cloudShadow.strength.value = on ? cloudShadow.strength.value : 0;
  cloudShadow.on.value = on ? 1 : 0;
  setSunGlareEnabled(on);
}

/** What a point light adds to a frame, one switch each (light-shots --layers: which of them washes a frame out). */
export type LightLayer = "halos" | "pools" | "fog" | "shading";
export const LIGHT_LAYERS: readonly LightLayer[] = ["halos", "pools", "fog", "shading"];

/**
 * Switch one point-light contribution off or on — the halo sprites, the screen-space pools past the budget, the lamp
 * glow in the fog, or the budgeted lights' own shading of surfaces — to measure what each adds to a frame. Material
 * visibility and uniforms only: no rebuild, no recompile.
 */
export function setLightLayerEnabled(layer: LightLayer, on: boolean): void {
  if (layer === "halos") haloMaterial().visible = on;
  else if (layer === "pools") poolMaterial().visible = on;
  else if (layer === "fog") {
    if (!on && fogLamps.gain.value > 0) fogGain = fogLamps.gain.value;
    fogLamps.gain.value = on ? fogGain : 0;
  } else if (layer === "shading") lightShading.enabled = on;
}

/**
 * The world's ambient life — chimney smoke, birds and far-off lit windows — one call a frame from
 * the host. Each is a single instanced draw animated on the GPU; this only
 * keeps their camera-facing axes and their (rarely changing) lists current.
 */
export function updateWorldAmbience(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
  chimneySmoke.update(scene, camera);
  distantWindows.update(scene, camera);
  birds.update(scene, camera, dt);
}
