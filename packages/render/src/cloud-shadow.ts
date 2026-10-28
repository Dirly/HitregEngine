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
 * The mask is a SOFTENED copy of the dome's cloud coverage, not the painted
 * image itself (softenCoverage). The art is PSX: a 1-bit alpha painted at
 * about 128 px and scaled up in blocks, which the dome wants (chunky cells in
 * the sky) but which on the ground, at ~1 m per texel, drew every cloud's
 * shadow as a hard 7 m stair-step. A real cloud shadow has a penumbra tens
 * of metres wide, so the coverage is downsampled and blurred once, when the
 * layer loads, and sampled linearly with mips (far ground does not shimmer).
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
/** The softened mask's size: one repeat of the layer is ~950 m at the dome's usual scale, so ~3.7 m per texel. */
export const SHADOW_MASK_SIZE = 256;
/** Box-blur radius in mask texels, applied SHADOW_BLUR_PASSES times (three boxes ≈ a gaussian of σ ≈ 3.5 texels, ~13 m). */
export const SHADOW_BLUR_RADIUS = 3;
export const SHADOW_BLUR_PASSES = 3;

/**
 * Blur a coverage field in place, wrapping at the edges (the layer tiles):
 * `passes` separable box blurs of `radius`. Pure, so it is testable headless.
 */
export function softenCoverage(field: Float32Array, width: number, height: number, radius = SHADOW_BLUR_RADIUS, passes = SHADOW_BLUR_PASSES): Float32Array {
  if (radius <= 0 || passes <= 0) return field;
  const scratch = new Float32Array(field.length);
  const span = radius * 2 + 1;
  for (let pass = 0; pass < passes; pass++) {
    // rows
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) sum += field[row + ((dx + width) % width)]!;
      for (let x = 0; x < width; x++) {
        scratch[row + x] = sum / span;
        sum += field[row + ((x + radius + 1) % width)]! - field[row + ((x - radius + width) % width)]!;
      }
    }
    // columns
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++) sum += scratch[((dy + height) % height) * width + x]!;
      for (let y = 0; y < height; y++) {
        field[y * width + x] = sum / span;
        sum += scratch[((y + radius + 1) % height) * width + x]! - scratch[((y - radius + height) % height) * width + x]!;
      }
    }
  }
  return field;
}

/**
 * The painted layer's alpha, box-downsampled to the mask size and softened —
 * drawn through a canvas, so only in a browser; elsewhere (tests, the
 * headless server) the raw image stands in.
 */
function softenedMask(image: TexImageSource): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  try {
    const size = SHADOW_MASK_SIZE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image as CanvasImageSource, 0, 0, size, size);
    const pixels = ctx.getImageData(0, 0, size, size);
    const field = new Float32Array(size * size);
    for (let i = 0; i < field.length; i++) field[i] = pixels.data[i * 4 + 3]! / 255;
    softenCoverage(field, size, size);
    // white with the coverage in alpha: the shader reads `.a` only, and white
    // survives the canvas's premultiplied storage exactly
    for (let i = 0; i < field.length; i++) {
      pixels.data[i * 4] = 255;
      pixels.data[i * 4 + 1] = 255;
      pixels.data[i * 4 + 2] = 255;
      pixels.data[i * 4 + 3] = Math.round(field[i]! * 255);
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

/** Hand the dome's freshly loaded cloud image to the shadow layer. */
export function setCloudShadowImage(image: unknown): void {
  cloudShadowTexture.image = softenedMask(image as TexImageSource) ?? (image as TexImageSource);
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
  // a wide band over the softened coverage: the penumbra softenCoverage made is the shadow's edge
  const shade: N = smoothstep(0.15, 0.85, a.mul(gate));
  return float(1).sub(shade.mul(cloudShadow.strength).mul(cloudShadow.on));
}
