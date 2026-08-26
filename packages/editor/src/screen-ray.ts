import * as THREE from "three/webgpu";

/**
 * Screen point -> camera ray, in one place.
 *
 * Four tools grew their own copy of this NDC conversion (viewport picking,
 * viewport asset-drop, terrain strokes, graybox/path snapping). They agree
 * today by luck; the moment one of them handles a canvas with a CSS offset or
 * a device-pixel-ratio quirk differently, picking and painting start
 * disagreeing about where the cursor is — the kind of bug that reads as
 * "the engine is off by a bit" and costs a day. New pointer code uses this.
 */

/** Normalized device coordinates (-1..1, y up) for a client-space point. */
export function screenToNdc(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  out = new THREE.Vector2(),
): THREE.Vector2 {
  const rect = canvas.getBoundingClientRect();
  return out.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
}

/** Aim an existing raycaster at a client-space point (no allocation per call). */
export function setRayFromScreen(
  raycaster: THREE.Raycaster,
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  clientX: number,
  clientY: number,
): void {
  raycaster.setFromCamera(screenToNdc(canvas, clientX, clientY, scratchNdc), camera);
}

const scratchNdc = new THREE.Vector2();
