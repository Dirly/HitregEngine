import * as THREE from "three/webgpu";
import {
  cameraPosition,
  clamp,
  dot,
  float,
  fract,
  length,
  mul,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep,
  step,
  sub,
  uniform,
  vec2,
} from "three/tsl";
import { editMeshMaterials } from "./node-material.js";

/** Tag on a material this module has already wired. */
export const FOLIAGE_FADE = "foliageFade";

/**
 * Dissolve foliage that stands between the camera and the character.
 *
 * A third-person camera spends its life being shoved through bushes, and a
 * leaf card 30cm from the near plane is an opaque wall — the player loses
 * their own character behind a texture. Pushing the camera out instead (the
 * other common fix) trades that for the camera lurching every time you walk
 * past a tree, which is worse.
 *
 * The test is a real occlusion test, not a proximity one: a fragment fades
 * only when it is BOTH between the camera and the character AND close to the
 * line joining them. Foliage the character is merely standing beside stays
 * solid, which is the difference between "the bush in the way went quiet" and
 * "the world dissolves whenever I enter a hedge".
 *
 * It dissolves by STIPPLE — a per-pixel dither compared against the fade
 * amount — rather than by alpha blending. That matters for the same reason
 * `grass.ts` refuses `transparent: true`: a blended cutout has to be sorted,
 * gives up early-Z, and on a screen full of overlapping leaf cards that
 * measured a near-3x GPU cost. Stippling keeps the material opaque, keeps
 * depth writing, needs no sort order, and at these fade amounts reads as
 * translucency.
 */
export interface FoliageFadeState {
  /** Off in the editor by default — see `setFoliageFade`. */
  enabled: boolean;
  /** Character world position; the far end of the segment being kept clear. */
  player: THREE.Vector3Like;
  /** Metres either side of the camera-to-character line that get dissolved. */
  radius: number;
  /** How far to take it: 1 removes the occluder outright, ~0.85 leaves a ghost. */
  strength: number;
}

const enabledUniform = uniform(0, "float");
const playerUniform = uniform(new THREE.Vector3(), "vec3");
const radiusUniform = uniform(1.3, "float");
const strengthUniform = uniform(0.9, "float");

/**
 * Point the effect at this frame's camera/character, or switch it off.
 *
 * One set of uniforms drives every foliage material in the scene, so this is a
 * single cheap call per frame rather than a walk over the materials — and a
 * model streamed in later picks up the current state with no extra wiring.
 *
 * Leave it disabled in the editor: dissolving whatever the camera is close to
 * is exactly wrong when the camera is a tool for placing that thing.
 */
export function setFoliageFade(state: Partial<FoliageFadeState>): void {
  if (state.enabled !== undefined) enabledUniform.value = state.enabled ? 1 : 0;
  if (state.player) playerUniform.value.set(state.player.x, state.player.y, state.player.z);
  if (state.radius !== undefined) radiusUniform.value = Math.max(0.01, state.radius);
  if (state.strength !== undefined) strengthUniform.value = Math.min(1, Math.max(0, state.strength));
}

/**
 * Wire the dissolve into every alpha-cutout material under `root`.
 *
 * Scoped to cutout materials because those are the ones that read as a wall:
 * a solid trunk between camera and character is a normal occlusion the player
 * understands, while a leaf card is visually thin and its opacity reads as a
 * bug. (On a Blockbench export every material is `MASK`, so a trunk is caught
 * too — which is survivable here, unlike for normals, because the fade only
 * ever fires on the handful of surfaces actually blocking the shot.)
 */
export function applyFoliageFade(root: THREE.Object3D): number {
  return editMeshMaterials(root, (material) => {
    if (material.userData[FOLIAGE_FADE]) return false;
    if (!(material.alphaTest > 0)) return false;

    const toPlayer = sub(playerUniform, cameraPosition);
    const span = length(toPlayer);
    const dir = toPlayer.div(span.max(float(0.001)));
    const toFragment = sub(positionWorld, cameraPosition);
    // how far along the camera-to-character ray this fragment sits, and how
    // far off it — the two numbers that decide "is this in the shot"
    const along = dot(toFragment, dir);
    const off = length(sub(toFragment, mul(dir, along)));

    // in front of the character (with a soft edge just short of them, so the
    // character's own outline does not sit in a half-dissolved fringe)
    const between = smoothstep(span, mul(span, float(0.82)), along);
    const near = sub(float(1), smoothstep(mul(radiusUniform, float(0.55)), radiusUniform, off));
    const occlusion = mul(mul(between, near), mul(strengthUniform, enabledUniform));

    // Screen-space stipple. Hashing SCREEN pixels (not the surface) is what
    // keeps the dither a stable, fine grain instead of swimming across a leaf
    // as it moves — and it costs one sin.
    const dither = fract(
      mul(sin(dot(vec2(screenCoordinate.x, screenCoordinate.y), vec2(12.9898, 78.233))), float(43758.5453)),
    );
    const keep = clamp(sub(float(1), occlusion), 0, 1);
    // opacityNode multiplies the map's own alpha, so the cutout survives; the
    // step turns a smooth fade into the stipple pattern, which alphaTest then
    // discards for free
    material.opacityNode = step(dither, keep);
    material.userData[FOLIAGE_FADE] = true;
    return true;
  });
}

