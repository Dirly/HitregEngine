import * as THREE from "three/webgpu";
import { float, positionWorld, smoothstep, texture, time, uniform } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Cloud shadows drifting over the land: the sky dome's painted cloud layer,
 * projected straight down onto the world and multiplied into the SUN's
 * shadow term — so only direct sunlight dims under a cloud (fill, lamps and
 * emissive are untouched) and every surface that receives the sun's cascaded
 * shadow gets it, terrain, towns, trees and characters alike. One texture
 * read per sun-lit fragment; no draw, no pass.
 *
 * The image is the dome's own (copied in when the dome's layer loads), with
 * linear filtering and mips of its own so far ground does not shimmer.
 * Scale, drift and coverage follow the dome every frame (SceneLighting), so
 * the shadows move with the clouds overhead and vanish with a clear sky.
 */
export const cloudShadowTexture = new THREE.Texture();
cloudShadowTexture.wrapS = THREE.RepeatWrapping;
cloudShadowTexture.wrapT = THREE.RepeatWrapping;

export const cloudShadow = {
  /** 0 until a painted cloud layer is loaded (procedural skies cast none). */
  on: uniform(0),
  /** How much sun a full cloud takes away (0..1); SceneLighting drives it with daylight and overcast. */
  strength: uniform(0),
  /** The dome's coverage BEFORE overcast closes it. */
  coverage: uniform(0),
  scale: uniform(1),
  speed: uniform(new THREE.Vector2(0.6, 0.2)),
};

/** Height the shadows are cast from, metres — sets how big a cloud's shadow is on the ground. */
const CLOUD_HEIGHT = 600;

/** Hand the dome's freshly loaded cloud image to the shadow layer. */
export function setCloudShadowImage(image: unknown): void {
  cloudShadowTexture.image = image as TexImageSource;
  cloudShadowTexture.colorSpace = THREE.SRGBColorSpace;
  cloudShadowTexture.minFilter = THREE.LinearMipmapLinearFilter;
  cloudShadowTexture.magFilter = THREE.LinearFilter;
  cloudShadowTexture.generateMipmaps = true;
  cloudShadowTexture.needsUpdate = true;
  cloudShadow.on.value = 1;
}

/*
 * Deliberately no "clear" on a new SceneLighting: portraits and face shots
 * build small scenes of their own every few frames, and resetting here
 * switched the world's cloud shadows off for good. A scene with no sun has
 * no cascade for the factor to ride on, and SceneLighting drives the
 * strength from the live dome, so a stale image is harmless.
 */

/** Sun multiplier at this fragment: 1 in open sky, down to 1 - strength under a full cloud. */
export function cloudShadowFactor(): N {
  // the dome maps its plane at 0.35 * scale per unit of view direction; at
  // the zenith that is world xz / height
  const uv: N = positionWorld.xz
    .mul(cloudShadow.scale.mul(0.35 / CLOUD_HEIGHT))
    .add(cloudShadow.speed.mul(time.mul(0.02)));
  // repeat-wrapped, not fract(): a fract seam breaks the mip derivatives into a visible line
  const a: N = texture(cloudShadowTexture, uv).a;
  const gate: N = smoothstep(0.02, 0.2, cloudShadow.coverage);
  const shade: N = smoothstep(0.25, 0.75, a.mul(gate));
  return float(1).sub(shade.mul(cloudShadow.strength).mul(cloudShadow.on));
}
