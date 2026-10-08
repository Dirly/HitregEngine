import * as THREE from "three/webgpu";

/**
 * Shadow range for animated (skinned) characters.
 *
 * Every skinned body that casts shadows is drawn again in each shadow cascade
 * it touches, with its own bone upload — measured in the Tidewell town square
 * (25 residents) at 1.7-3.7 ms of main-thread time per frame, for shadows
 * of people 40-150 m away that cover a few pixels of the far cascades.
 *
 * Inside an EngineRenderer frame a skinned mesh's `castShadow` reads as
 * "authored AND within `distance` of the render camera". Outside a frame
 * (editor tools, inspectors, portraits, bare Three rendering) it reads as
 * authored, and writes always set the authored value. The renderer opens
 * the frame after its matrix walk, so the distance uses this frame's pose.
 *
 * A small hysteresis band keeps a resident standing on the boundary from
 * flickering as the camera bobs. What a player sees at the edge: that
 * character's ground shadow switches off (or on) at once; their body still
 * draws and still receives shadows. `distance <= 0` or Infinity disables it.
 */
export const DEFAULT_SKINNED_SHADOW_DISTANCE = 40;
const HYSTERESIS = 2;

const eye = new THREE.Vector3();
let frame = 0;
let nextFrame = 0;
let range = DEFAULT_SKINNED_SHADOW_DISTANCE;
const installed = new WeakSet<THREE.Object3D>();

/** Open a render frame: `castShadow` of ranged meshes now depends on `eyePosition`. Returns the previous frame for nesting. */
export function beginSkinnedShadowFrame(eyePosition: THREE.Vector3Like, distance: number): { frame: number; eye: [number, number, number]; range: number } {
  const previous = { frame, eye: [eye.x, eye.y, eye.z] as [number, number, number], range };
  frame = ++nextFrame;
  eye.set(eyePosition.x, eyePosition.y, eyePosition.z);
  range = distance;
  return previous;
}

/** Close a frame, restoring a nested renderer's caller (or leaving render scope). */
export function endSkinnedShadowFrame(previous: { frame: number; eye: [number, number, number]; range: number }): void {
  frame = previous.frame;
  eye.set(previous.eye[0], previous.eye[1], previous.eye[2]);
  range = previous.range;
}

/** Make this skinned mesh's shadow casting range-limited inside renderer frames. Idempotent. */
export function enableSkinnedShadowRange(mesh: THREE.Object3D): void {
  if (installed.has(mesh)) return;
  installed.add(mesh);
  let authored = mesh.castShadow;
  let casting = true;
  let decidedFrame = -1;
  const position = new THREE.Vector3();
  Object.defineProperty(mesh, "castShadow", {
    configurable: true,
    enumerable: true,
    get: (): boolean => {
      if (!authored || frame === 0 || !(range > 0) || range === Infinity) return authored;
      if (decidedFrame === frame) return casting;
      decidedFrame = frame;
      const e = mesh.matrixWorld.elements;
      position.set(e[12]!, e[13]!, e[14]!);
      const d2 = position.distanceToSquared(eye);
      const limit = casting ? range + HYSTERESIS : range;
      casting = d2 <= limit * limit;
      return casting;
    },
    set: (value: boolean): void => {
      authored = value;
    },
  });
}
