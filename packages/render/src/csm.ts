import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { cloudShadowFactor } from "./cloud-shadow.js";
import { CSMFrustum } from "three/addons/csm/CSMFrustum.js";
import { SHADOW_CAMERA_LAYERS } from "./horizon.js";
import { skinnedShadowLimit } from "./skinned-shadows.js";

/**
 * Cascaded shadow maps for directional lights, plus the one place that turns
 * the `light.shadow` schema block into actual three state.
 *
 * WHY THREE'S `CSMShadowNode` AND NOT A HAND-ROLLED CASCADE:
 * three 0.185 ships `three/addons/csm/CSMShadowNode.js`, which is the
 * TSL/node implementation (the older `CSM.js` is the legacy WebGLRenderer one
 * and is NOT what we want). It plugs in through `light.shadow.shadowNode`, so
 * the whole thing is one assignment on an ordinary `THREE.DirectionalLight`,
 * and it already solves the two parts that are easy to get subtly wrong:
 *   - the clip-space convention split (`CSMFrustum` takes `webGL` and
 *     `reversedDepth` flags), which is exactly what makes this work unchanged
 *     on the WebGL2 fallback backend of `WebGPURenderer`;
 *   - per-cascade texel snapping of the shadow-camera centre in
 *     `updateBefore()` (`floor(center / texel) * texel`), without which the
 *     shadow edges crawl as the camera moves.
 * It also has the cross-cascade `fade` blend, so the seam is solved too.
 *
 * WHAT WE ADD ON TOP, and why each is not optional:
 *   1. `cascadeSplit` as a real knob. Three's `practical` mode hardcodes
 *      lambda 0.5; the schema exposes it, so we drive `mode: "custom"` with
 *      our own (tested) split function.
 *   2. Bounding-SPHERE cascade extents instead of three's longest-diagonal
 *      fit, quantised to a coarse step. Three's extent is already rotation
 *      invariant, but it varies continuously with camera near/far/fov/aspect,
 *      so a smooth FOV change (aim-down-sights) moves the texel grid every
 *      frame and the shadows shimmer even though the centre is snapped.
 *      Quantising the extent upward pins the grid across long stretches.
 *   3. Per-cascade bias/normalBias derived from actual texel size and depth
 *      range. Three multiplies bias by `(i + 1)`, which is unrelated to how
 *      the cascades were actually sized. One bias value cannot serve a 20 m
 *      and a 400 m cascade; the far one either acnes or peter-pans.
 *
 * Everything above the class is pure maths with no three-scene-graph state,
 * so it is unit-testable without a GPU.
 */

/** `light.shadow` from the component schema, already zod-defaulted. */
export interface ShadowSettings {
  enabled: boolean;
  mapSize: number;
  bias: number;
  normalBias: number;
  radius: number;
  /** directional only; ignored on point/spot per the schema's `.describe()`. */
  cascades: number;
  /** directional only. 0 = uniform splits, 1 = logarithmic. */
  cascadeSplit: number;
  /** 0 = auto (`shadowFarPlane`). */
  far: number;
}

export const DEFAULT_SHADOW_SETTINGS: ShadowSettings = {
  enabled: true,
  mapSize: 1024,
  bias: -0.0004,
  normalBias: 0.02,
  radius: 1,
  cascades: 1,
  cascadeSplit: 0.5,
  far: 0,
};

/**
 * A far cascade's texels can be 30x the near cascade's; scaling bias by that
 * ratio unclamped produces a bias large enough to detach the shadow from its
 * caster entirely. Past this ratio the far cascade is better served by
 * accepting some acne than by peter-panning a whole building's shadow.
 */
export const CASCADE_BIAS_SCALE_CAP = 12;

/** Effective shadow switch: `castShadow` is the master, `shadow.enabled` an AND-ed force-off. */
export function shadowEnabled(castShadow: boolean, settings: Pick<ShadowSettings, "enabled">): boolean {
  return castShadow && settings.enabled !== false;
}

/**
 * Shadow-camera far plane. `far: 0` means auto and reproduces the value that
 * was hardcoded in scene-builder before the schema existed, so an existing
 * scene renders identically after the switch.
 */
export function shadowFarPlane(shadowSize: number, far: number): number {
  return far > 0 ? far : Math.max(120, shadowSize * 3);
}

/**
 * Cascade split fractions, returned as `breaks` in (0, 1] of the shadow
 * distance, length === `cascades`, last element exactly 1 — the shape
 * `CSMShadowNode.customSplitsCallback` wants.
 *
 * CONVENTION (fixed, do not flip): `lambda` 0 = uniform (even world-space
 * slabs), 1 = logarithmic (perceptually even, far cascade enormous). This
 * matches the `cascadeSplit` schema field and the usual "practical split
 * scheme" lambda from Zhang et al.
 */
export function cascadeSplits(cascades: number, near: number, far: number, lambda: number): number[] {
  const n = Math.max(1, Math.floor(cascades));
  const breaks: number[] = [];
  const l = Math.min(1, Math.max(0, lambda));
  for (let i = 1; i < n; i++) {
    const uniform = (near + ((far - near) * i) / n) / far;
    const logarithmic = (near * (far / near) ** (i / n)) / far;
    breaks.push(uniform + (logarithmic - uniform) * l);
  }
  breaks.push(1);
  return breaks;
}

/** The same splits as world-space distances from the camera, for debug/UI. */
export function cascadeDistances(cascades: number, near: number, far: number, lambda: number): number[] {
  return cascadeSplits(cascades, near, far, lambda).map((b) => b * far);
}

/**
 * Snap a value down to a grid. Used for shadow-camera centre/extent
 * quantisation: a value that changes continuously moves the shadow texel grid
 * continuously, and a moving texel grid is exactly what crawling shadow edges
 * are.
 */
export function snapToTexelGrid(value: number, texelSize: number): number {
  if (!(texelSize > 0)) return value;
  return Math.floor(value / texelSize) * texelSize;
}

/**
 * Quantise a cascade's ortho extent UPWARD to a coarse step (never smaller,
 * so coverage is never lost) tied to its own magnitude, giving ~1/`steps`
 * granularity at every scale. Upward is what makes this safe; the coarseness
 * is what makes the texel grid hold still while the camera zooms.
 */
export function quantizeExtent(extent: number, steps = 64): number {
  if (!(extent > 0)) return extent;
  const step = 2 ** Math.floor(Math.log2(extent)) / steps;
  return Math.ceil(extent / step) * step;
}

/** The 8 view-space corners of a camera frustum slice between two distances. */
export function frustumSliceCorners(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  near: number,
  far: number,
): THREE.Vector3[] {
  const corners: THREE.Vector3[] = [];
  const planes: Array<[number, number]> = [];
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const perspective = camera as THREE.PerspectiveCamera;
    const tan = Math.tan(THREE.MathUtils.degToRad(perspective.fov * 0.5)) / perspective.zoom;
    planes.push([tan * near * perspective.aspect, tan * near], [tan * far * perspective.aspect, tan * far]);
  } else {
    const ortho = camera as THREE.OrthographicCamera;
    const halfWidth = (ortho.right - ortho.left) * 0.5 / ortho.zoom;
    const halfHeight = (ortho.top - ortho.bottom) * 0.5 / ortho.zoom;
    planes.push([halfWidth, halfHeight], [halfWidth, halfHeight]);
  }
  const distances = [near, far];
  for (let p = 0; p < 2; p++) {
    const [halfWidth, halfHeight] = planes[p]!;
    const z = -distances[p]!;
    corners.push(
      new THREE.Vector3(halfWidth, halfHeight, z),
      new THREE.Vector3(halfWidth, -halfHeight, z),
      new THREE.Vector3(-halfWidth, -halfHeight, z),
      new THREE.Vector3(-halfWidth, halfHeight, z),
    );
  }
  return corners;
}

export interface SliceSphere {
  /** Positive distance in front of the camera (view-space z is `-centerDistance`). */
  centerDistance: number;
  radius: number;
}

/**
 * Minimal sphere enclosing a frustum slice, centred on the view axis.
 *
 * A sphere is the right shape here because it is invariant to camera
 * ROTATION: derive the ortho extent from it and the cascade's texel size stops
 * changing when the player merely looks around. Fitting the slice's bounding
 * box instead makes the extent breathe with yaw, which shimmers.
 */
export function frustumSliceSphere(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  near: number,
  far: number,
): SliceSphere {
  const corners = frustumSliceCorners(camera, near, far);
  const nearRadiusSq = corners[0]!.x ** 2 + corners[0]!.y ** 2;
  const farRadiusSq = corners[4]!.x ** 2 + corners[4]!.y ** 2;
  // Solve for the on-axis centre equidistant from a near and a far corner:
  //   A + (zc + near)^2 = B + (zc + far)^2   (view-space z is negative)
  const denominator = 2 * (near - far);
  let centerDistance: number;
  if (denominator === 0) {
    centerDistance = far;
  } else {
    const zc = (farRadiusSq - nearRadiusSq + far * far - near * near) / denominator;
    centerDistance = -zc;
  }
  // Centre in front of the near plane means the far corners alone bound the
  // slice (a wide, shallow cascade) — clamp to the far plane.
  if (centerDistance < near) centerDistance = near;
  if (centerDistance > far) centerDistance = far;
  let radiusSq = 0;
  for (const corner of corners) {
    const dz = corner.z + centerDistance;
    radiusSq = Math.max(radiusSq, corner.x ** 2 + corner.y ** 2 + dz * dz);
  }
  return { centerDistance, radius: Math.sqrt(radiusSq) };
}

/**
 * Per-cascade bias multipliers relative to cascade 0.
 *
 * `normalBias` is a world-space offset along the surface normal, so it scales
 * with the cascade's WORLD TEXEL SIZE. `bias` is an offset in the shadow
 * camera's normalised depth, so the same world-space error is a smaller
 * fraction of a longer depth range — hence the extra depth-range term. Getting
 * this wrong is what makes cascade 2 either striped or floating.
 */
export function cascadeBiasScale(
  texelWorldSize: number,
  depthRange: number,
  referenceTexelWorldSize: number,
  referenceDepthRange: number,
): { bias: number; normalBias: number } {
  if (!(referenceTexelWorldSize > 0) || !(referenceDepthRange > 0)) return { bias: 1, normalBias: 1 };
  const texelRatio = Math.min(CASCADE_BIAS_SCALE_CAP, texelWorldSize / referenceTexelWorldSize);
  const depthRatio = depthRange > 0 ? referenceDepthRange / depthRange : 1;
  return {
    bias: Math.min(CASCADE_BIAS_SCALE_CAP, texelRatio * depthRatio),
    normalBias: texelRatio,
  };
}

/**
 * Number of shadow-map render passes a light costs. This is the currency the
 * light budget actually spends: a shadow-casting point light is SIX depth
 * renders of everything in range, which is why one of them can outweigh a
 * dozen unshadowed lights. Surfaced through `CascadeShadowSystem.stats()` so
 * the profiler can show it next to `LightBudgetSystem.stats()`.
 */
export function shadowPassCost(kind: "directional" | "point" | "spot" | "ambient", settings: ShadowSettings): number {
  switch (kind) {
    case "directional":
      return Math.max(1, Math.min(4, Math.floor(settings.cascades)));
    case "point":
      return 6;
    case "spot":
      return 1;
    default:
      return 0;
  }
}

/**
 * Write the non-cascade parts of `light.shadow` onto any light kind. Safe for
 * point/spot (`cascades`/`cascadeSplit` are deliberately not read here — the
 * schema promises they are directional-only and the schema itself cannot
 * express that).
 *
 * Deliberately touches ONLY `castShadow` and `shadow.*`. It never writes
 * `light.visible`, because that field belongs to `LightBudgetSystem`: the
 * budget culls point lights by hiding them, and three skips the shadow render
 * of a hidden light, so a budget-culled light stops costing its six cube
 * faces with no coordination between the two systems. Two writers on
 * `visible` would break that.
 */
export function applyShadowSettings(
  light: THREE.Light,
  castShadow: boolean,
  settings: ShadowSettings,
  shadowSize: number,
): boolean {
  const enabled = shadowEnabled(castShadow, settings);
  light.castShadow = enabled;
  // THREE.Light itself declares no `shadow` — only the subclasses that can
  // cast one do. Narrow through a shadow-bearing view rather than widening
  // the parameter, so callers can still pass any light.
  const shadow = (light as THREE.Light & { shadow?: THREE.LightShadow }).shadow;
  if (!shadow) return enabled;

  shadow.mapSize.set(settings.mapSize, settings.mapSize);
  shadow.bias = settings.bias;
  shadow.normalBias = settings.normalBias;
  shadow.radius = settings.radius;

  const camera = shadow.camera;
  // shadows keep drawing what the culling system hid from the MAIN camera
  // only (behind terrain): see OCCLUDED_LAYER
  camera.layers.mask = SHADOW_CAMERA_LAYERS;
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const ortho = camera as THREE.OrthographicCamera;
    ortho.left = -shadowSize;
    ortho.right = shadowSize;
    ortho.top = shadowSize;
    ortho.bottom = -shadowSize;
    ortho.near = 0.5;
    ortho.far = shadowFarPlane(shadowSize, settings.far);
    ortho.updateProjectionMatrix();
  } else if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const perspective = camera as THREE.PerspectiveCamera;
    perspective.near = 0.5;
    perspective.far = shadowFarPlane(shadowSize, settings.far);
    perspective.updateProjectionMatrix();
  }
  return enabled;
}

interface CascadeEntry {
  light: THREE.DirectionalLight;
  node: EngineCascadeShadowNode;
  /** Camera state the cascades were last fitted to; a change refits. */
  fitKey: string;
}

/**
 * `CSMShadowNode` with our split scheme, extent fit and bias policy.
 *
 * `updateFrustums()` is three's public "settings changed, refit" entry point
 * and is also what its private `_init()` calls once the render camera is
 * known, so overriding it is enough to have our bounds in place before the
 * first shadow render — no first-frame pop.
 */
/**
 * Far cascades do not re-render every frame. Every cascade redraws every caster it holds, the shadow pass was half of
 * a town's draws, and a far cascade's picture barely changes between frames: a cascade that can hold a walking body's
 * shadow renders every frame, the others every 2^i frames, capped at 4, staggered so two far cascades never land on one
 * frame. A body's shadow on a skipped frame stands still while the body moves on, and a walking unit's shadow stuttered
 * (Derek 2026-11-07), so the line is where animated bodies stop casting (skinned-shadows.ts), not a cascade number. A skipped cascade keeps its map AND its matrix (three writes `shadow.matrix` only
 * when it renders), so the shadow stays exactly where it was drawn.
 *
 * A camera turn slides a far cascade's slice, and a stale map would leave new ground unshadowed at its edge, so a
 * cascade whose fit has moved past CASCADE_STALE_SHARE of its extent renders at once. `?shadowStagger=0` turns it off.
 */
export const cascadeStagger = { enabled: true };

/**
 * The player's shadow setting, for every cascaded sun, present and future (a scene rebuild keeps it). `reach` and on/off
 * apply live with no shader rebuild: `reach` moves the far edge of the last cascade, and off is one uniform that masks
 * the cascades while their passes stop. `light.castShadow = false` would be the plain way, but it changes the lights'
 * cache key, and that recompiles every lit material in the scene. The drifting cloud shade stays on when sun shadows
 * are off.
 *
 * `mapScale` is read when a light's cascades are BUILT, so it takes effect on the next load. Resizing a live cascade's
 * map destroys the old depth texture while bind groups still hold it: measured 2026-11-05, "Destroyed texture
 * ShadowDepthTexture used in a submit", repeating, whether three resized it mid-pass or we did before the frame. Each
 * one is a rejected submit.
 */
export interface SunShadowQuality {
  enabled: boolean;
  /** Times the authored `mapSize` (floor 256 px). Next load only, see above. */
  mapScale: number;
  /** Times the authored shadow distance. */
  reach: number;
}
const sunShadowQuality: SunShadowQuality & { version: number } = { enabled: true, mapScale: 1, reach: 1, version: 0 };
const sunShadowsOn = uniform(1, "float");

export function setSunShadowQuality(quality: SunShadowQuality): void {
  Object.assign(sunShadowQuality, quality);
  sunShadowQuality.version++;
  sunShadowsOn.value = quality.enabled ? 1 : 0;
}

/** The map size a cascade uses for an authored size under `mapScale`. */
export function scaledShadowMapSize(authored: number, mapScale: number): number {
  return Math.max(256, Math.round(authored * mapScale));
}
const CASCADE_MAX_PERIOD = 4;
const CASCADE_STALE_SHARE = 0.08;

/**
 * Is cascade `index` due on frame `frame`, its fit having moved `movedShare` of its extent since it last rendered?
 * `holdsBodies`: its slice starts inside the reach of animated bodies' shadows.
 */
export function cascadeDue(index: number, frame: number, movedShare: number, holdsBodies = false, uncovered = false): boolean {
  if (index <= 0 || holdsBodies || uncovered || movedShare > CASCADE_STALE_SHARE) return true;
  const period = Math.min(CASCADE_MAX_PERIOD, 2 ** index);
  return frame % period === index % period;
}

/** Where a cascade's map was drawn, in light space: the snapped centre and the half-width of its ortho box. */
export interface CascadeCoverage {
  x: number;
  y: number;
  half: number;
}

/**
 * Does the map drawn at `rendered` still hold the whole slice whose light-space box is `box`? A skipped cascade keeps
 * its old map and matrix, and a fragment outside that map reads as lit, so the part of the slice that has slid past the
 * map's edge lost its shadows until the next scheduled pass (measured 2026-11-08 on a run: cascade 2 left uncovered on
 * 7 of 130 skipped frames, by up to 1.9 m, while the old 8%-of-extent drift test saw nothing). Exact, so a cascade
 * whose slice still fits keeps skipping.
 */
export function cascadeCovers(rendered: CascadeCoverage | null | undefined, box: { min: { x: number; y: number }; max: { x: number; y: number } }): boolean {
  if (!rendered) return false;
  return box.min.x >= rendered.x - rendered.half && box.max.x <= rendered.x + rendered.half &&
    box.min.y >= rendered.y - rendered.half && box.max.y <= rendered.y + rendered.half;
}

/**
 * The sun moves a sliver every frame, and that turns every cascade's texel grid with it: texel snapping holds the grid
 * still against the camera, not against a rotation, so each shadow edge re-rasterises onto a new grid every frame and
 * crawls (measured 2026-11-06: edges changed per frame with the clock running, not with it frozen). The cascades aim at
 * a held direction instead, moved in steps; lighting keeps the true sun. A step is under 3 cm for a 10 m caster at noon.
 */
export const SHADOW_SUN_STEP_DEGREES = 0.1;
const SHADOW_SUN_STEP_COS = Math.cos((SHADOW_SUN_STEP_DEGREES * Math.PI) / 180);

/** `?sunStep=0` is the A/B: the cascades follow the true sun every frame. */
export const shadowSunStep = { enabled: true };

/** Bring `held` to `sun` if the sun has left it by a step; true when it moved. Both are unit vectors. */
export function stepHeldSun(held: THREE.Vector3, sun: THREE.Vector3): boolean {
  if (shadowSunStep.enabled && held.lengthSq() > 0 && held.dot(sun) >= SHADOW_SUN_STEP_COS) return false;
  held.copy(sun);
  return true;
}

/** Reused per-frame scratch for updateBefore(); never allocate in a frame loop. */
const CASCADE_UP = new THREE.Vector3(0, 1, 0);
const lightWorld = new THREE.Vector3();
const targetWorld = new THREE.Vector3();
const lightDirection = new THREE.Vector3();
const ORIGIN = new THREE.Vector3();
const heldEye = new THREE.Vector3();
const cascadeCenter = new THREE.Vector3();
const cascadeAim = new THREE.Vector3();
const cascadeBox = new THREE.Box3();
const lightOrientation = new THREE.Matrix4();
const lightOrientationInverse = new THREE.Matrix4();
const parentInverse = new THREE.Matrix4();
const cameraToLight = new THREE.Matrix4();
const lightSpaceFrustum = new CSMFrustum();

class EngineCascadeShadowNode extends CSMShadowNode {
  baseBias = DEFAULT_SHADOW_SETTINGS.bias;
  baseNormalBias = DEFAULT_SHADOW_SETTINGS.normalBias;
  /** Filled by `updateFrustums()`; read by `stats()` and by tests. */
  readonly cascadeExtents: number[] = [];
  /** Where each cascade's fit stood when it last rendered (world), for the stagger's staleness test. */
  private readonly renderedAt: THREE.Vector3[] = [];
  /** Where each cascade's map was last drawn in light space, for the stagger's coverage test (null = never / reset). */
  private readonly renderedCover: (CascadeCoverage | null)[] = [];
  private staggerFrame = 0;
  /** The sun direction the cascades aim along; see SHADOW_SUN_STEP_DEGREES. */
  private readonly heldSun = new THREE.Vector3();
  /** The far edge as authored; `maxFar` is this times the player's `reach`. */
  private authoredFar: number | null = null;
  private qualityVersion = 0;

  /**
   * Three's cascade term, times the drifting cloud shadow (cloud-shadow.ts):
   * the sun's shadow is the one place that dims ONLY direct sunlight on every
   * receiving material, so clouds shade the land, towns and trees here.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override setup(builder: any): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (super.setup(builder) as any).sub(1).mul(sunShadowsOn).add(1).mul(cloudShadowFactor());
  }

  /** Bring this light up to the player's reach; every cascade renders once at it. */
  applyQuality(): void {
    if (this.qualityVersion === sunShadowQuality.version) return;
    this.qualityVersion = sunShadowQuality.version;
    this.authoredFar ??= this.maxFar;
    this.maxFar = this.authoredFar * sunShadowQuality.reach;
    this.updateFrustums();
    for (const at of this.renderedAt) at.set(Infinity, 0, 0);
    this.renderedCover.fill(null);
    for (const cascadeLight of this.lights) if (cascadeLight?.shadow) cascadeLight.shadow.needsUpdate = sunShadowQuality.enabled;
  }

  override updateFrustums(): void {
    if (this.mainFrustum === null) return; // pre-`_init()`; nothing to fit yet
    super.updateFrustums();
    this.refit();
  }

  /**
   * Place each cascade's shadow camera around the render camera — replacing
   * three's `updateBefore()` rather than extending it, because two of its
   * assumptions do not hold here.
   *
   * 1. It derives the light direction from `light.position` and
   *    `light.target.position` — LOCAL coordinates. This engine's convention
   *    is that a directional light's ROTATION is its direction
   *    (scene-builder parents `target` at local `(0,-1,0)`), so those two
   *    local vectors always differ by `(0,-1,0)` no matter how the entity is
   *    rotated. three's own renderer computes the SHADING direction from the
   *    world matrices, so the cascades were being rendered from straight
   *    overhead while the surface was lit from wherever the sun was actually
   *    aimed.
   * 2. It writes the cascade centres, computed in WORLD space from
   *    `camera.matrixWorld`, straight into `lwLight.position` — a LOCAL
   *    position under `light.parent`. That is only correct while the light
   *    hangs off the scene root. Here a light hangs off its entity's
   *    transform group, so every cascade came out displaced by the light
   *    entity's own transform: a sun authored at `(40, 90, 30)` put the
   *    shadowed volume 40m east and 90m above the one place it needed to be,
   *    which reads in-game as "shadows are over there somewhere, never on me".
   *
   * Both are fixed the same way: do the maths in world space, then convert
   * into the parent's space on the way out.
   */
  override updateBefore(): boolean | undefined {
    const camera = this.camera;
    const light = this.light as THREE.DirectionalLight;
    const parent = light.parent;
    if (!camera || !parent || this.frustums.length === 0) return;
    if (!sunShadowQuality.enabled) {
      for (const cascadeLight of this.lights) {
        if (!cascadeLight?.shadow) continue;
        cascadeLight.shadow.autoUpdate = false;
        cascadeLight.shadow.needsUpdate = false;
      }
      return;
    }

    // three does this in its own updateBefore, which we are replacing: the
    // placeholder lights only reach the scene graph when someone adds them.
    for (const cascadeLight of this.lights) {
      if (cascadeLight.parent === null) {
        parent.add(cascadeLight.target);
        parent.add(cascadeLight);
      }
    }

    light.updateWorldMatrix(true, false);
    light.target.updateWorldMatrix(true, false);
    lightWorld.setFromMatrixPosition(light.matrixWorld);
    targetWorld.setFromMatrixPosition(light.target.matrixWorld);
    if (lightWorld.distanceToSquared(targetWorld) < 1e-12) return; // degenerate aim
    lightDirection.subVectors(targetWorld, lightWorld).normalize();
    // every cascade moves together on a step, or their seams would disagree about where the shadow falls
    if (stepHeldSun(this.heldSun, lightDirection)) {
      for (const at of this.renderedAt) at.set(Infinity, 0, 0);
      this.renderedCover.fill(null);
    }
    lightDirection.copy(this.heldSun);
    // Matrix4.lookAt builds rotation only, so only the DIRECTION between these
    // two points matters — which is the whole point of using world ones.
    lightOrientation.lookAt(heldEye.copy(lightDirection).negate(), ORIGIN, CASCADE_UP);
    lightOrientationInverse.copy(lightOrientation).invert();
    parent.updateWorldMatrix(true, false);
    parentInverse.copy(parent.matrixWorld).invert();
    this.staggerFrame++;

    for (let i = 0; i < this.frustums.length; i++) {
      const cascadeLight = this.lights[i];
      const shadow = cascadeLight?.shadow;
      if (!cascadeLight || !shadow) continue;
      const shadowCamera = shadow.camera;
      shadowCamera.layers.mask = SHADOW_CAMERA_LAYERS; // see OCCLUDED_LAYER
      // Texel snapping: without it the cascade slides continuously with the
      // camera and every shadow edge crawls. Same trick as three's.
      const texelWidth = (shadowCamera.right - shadowCamera.left) / shadow.mapSize.width;
      const texelHeight = (shadowCamera.top - shadowCamera.bottom) / shadow.mapSize.height;

      cameraToLight.multiplyMatrices(lightOrientationInverse, camera.matrixWorld);
      this.frustums[i]!.toSpace(cameraToLight, lightSpaceFrustum);

      const nearVertices = lightSpaceFrustum.vertices.near;
      const farVertices = lightSpaceFrustum.vertices.far;
      cascadeBox.makeEmpty();
      for (let j = 0; j < 4; j++) {
        cascadeBox.expandByPoint(nearVertices[j]!);
        cascadeBox.expandByPoint(farVertices[j]!);
      }
      cascadeBox.getCenter(cascadeCenter);
      // Pull the light back off the slice so casters between it and the slice
      // still render into the map — refit() sizes `far` to match.
      cascadeCenter.z = cascadeBox.max.z + this.lightMargin;
      if (texelWidth > 0) cascadeCenter.x = Math.floor(cascadeCenter.x / texelWidth) * texelWidth;
      if (texelHeight > 0) cascadeCenter.y = Math.floor(cascadeCenter.y / texelHeight) * texelHeight;
      const covered = cascadeCovers(this.renderedCover[i], cascadeBox);
      const lightX = cascadeCenter.x;
      const lightY = cascadeCenter.y;
      cascadeCenter.applyMatrix4(lightOrientation);

      cascadeAim.copy(cascadeCenter).add(lightDirection);
      cascadeLight.position.copy(cascadeCenter).applyMatrix4(parentInverse);
      cascadeLight.target.position.copy(cascadeAim).applyMatrix4(parentInverse);

      const at = (this.renderedAt[i] ??= new THREE.Vector3(Infinity, 0, 0));
      const extent = this.cascadeExtents[i] ?? 0;
      const moved = extent > 0 ? at.distanceTo(cascadeCenter) / extent : Infinity;
      const sliceNear = i === 0 ? 0 : (this.breaks[i - 1] ?? 0) * Math.min((camera as THREE.PerspectiveCamera).far, this.maxFar);
      const due = !cascadeStagger.enabled || cascadeDue(i, this.staggerFrame, moved, sliceNear < skinnedShadowLimit(), !covered);
      shadow.autoUpdate = false;
      shadow.needsUpdate = due;
      if (due) {
        at.copy(cascadeCenter);
        const half = (shadowCamera.right - shadowCamera.left) / 2;
        const cover = this.renderedCover[i];
        if (cover) { cover.x = lightX; cover.y = lightY; cover.half = half; }
        else this.renderedCover[i] = { x: lightX, y: lightY, half };
      }
    }
  }

  /**
   * Replace three's per-cascade bounds with a quantised bounding-sphere fit
   * and rescale bias/normalBias to the resulting texel densities.
   */
  refit(): void {
    const camera = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera | null;
    if (!camera || this.lights.length === 0) return;
    const far = Math.min((camera as THREE.PerspectiveCamera).far, this.maxFar);
    const near = camera.near;
    const breaks = this.breaks;

    this.cascadeExtents.length = 0;
    let referenceTexel = 0;
    let referenceDepth = 0;

    for (let i = 0; i < this.lights.length; i++) {
      const shadow = this.lights[i]?.shadow;
      if (!shadow) continue;
      const sliceNear = i === 0 ? near : (breaks[i - 1] ?? 0) * far;
      const sliceFar = (breaks[i] ?? 1) * far;
      const sphere = frustumSliceSphere(camera, sliceNear, Math.max(sliceNear + 1e-4, sliceFar));
      const extent = quantizeExtent(sphere.radius * 2);
      const half = extent * 0.5;

      const shadowCamera = shadow.camera;
      shadowCamera.left = -half;
      shadowCamera.right = half;
      shadowCamera.top = half;
      shadowCamera.bottom = -half;
      // `CSMShadowNode.updateBefore()` places the cascade's light at
      // `bbox.max.z + lightMargin`, so the slice occupies depth
      // [lightMargin, lightMargin + sliceDepth]. near stays small so a caster
      // standing between the light and the slice (a cliff, a roof) still
      // casts into it; far is only as deep as it has to be, because ortho
      // depth precision is spread evenly across the whole range.
      shadowCamera.near = 0.1;
      shadowCamera.far = this.lightMargin + extent + 1;
      shadowCamera.updateProjectionMatrix();

      const texelWorldSize = extent / Math.max(1, shadow.mapSize.width);
      const depthRange = shadowCamera.far - shadowCamera.near;
      if (i === 0) {
        referenceTexel = texelWorldSize;
        referenceDepth = depthRange;
      }
      const scale = cascadeBiasScale(texelWorldSize, depthRange, referenceTexel, referenceDepth);
      shadow.bias = this.baseBias * scale.bias;
      shadow.normalBias = this.baseNormalBias * scale.normalBias;
      this.cascadeExtents.push(extent);
    }
  }
}

/** Camera state that invalidates a cascade fit. Cheap to compute every frame. */
function cameraFitKey(camera: THREE.Camera): string {
  const perspective = camera as THREE.PerspectiveCamera;
  if (perspective.isPerspectiveCamera) {
    return `p:${perspective.fov}:${perspective.aspect}:${perspective.near}:${perspective.far}:${perspective.zoom}`;
  }
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    return `o:${ortho.left}:${ortho.right}:${ortho.top}:${ortho.bottom}:${ortho.near}:${ortho.far}:${ortho.zoom}`;
  }
  return "unknown";
}

export interface CascadeShadowStats {
  /** Directional lights currently running cascades (cascades >= 2). */
  cascadedLights: number;
  /** Shadow-map render passes those lights cost per frame. */
  shadowPasses: number;
}

/**
 * Owns the `CSMShadowNode` attached to each cascaded directional light, and
 * refits them when the render camera changes.
 *
 * The refit is why this is a system and not a one-shot: `CSMShadowNode`
 * captures the render camera once, on its first `setup()`. The playground
 * swaps cameras (edit fly-cam vs. play rig) and resizes change the aspect, and
 * neither is noticed by three — the cascades would silently keep fitting a
 * camera that is no longer rendering.
 */
export class CascadeShadowSystem {
  private readonly entries = new Map<THREE.DirectionalLight, CascadeEntry>();
  private readonly passesByLight = new Map<THREE.DirectionalLight, number>();

  /**
   * Configure a directional light's shadow. Returns true when cascades were
   * attached, false when the light took the plain single-map path.
   *
   * `cascades: 1` deliberately does NOT create a `CSMShadowNode` — it goes
   * through `applyShadowSettings` and produces exactly the single tight ortho
   * frustum that shipped before cascades existed. That is what keeps existing
   * scenes pixel-identical, and it is also simply cheaper.
   */
  register(
    light: THREE.DirectionalLight,
    castShadow: boolean,
    settings: ShadowSettings,
    shadowSize: number,
  ): boolean {
    const cascades = Math.max(1, Math.min(4, Math.floor(settings.cascades)));
    const mapSize = cascades < 2 ? settings.mapSize : scaledShadowMapSize(settings.mapSize, sunShadowQuality.mapScale);
    const enabled = applyShadowSettings(light, castShadow, { ...settings, mapSize }, shadowSize);
    this.release(light);
    if (!enabled || cascades < 2) {
      if (enabled) this.passesByLight.set(light, 1);
      return false;
    }

    const maxFar = shadowFarPlane(shadowSize, settings.far);
    const lambda = settings.cascadeSplit;
    const node = new EngineCascadeShadowNode(light, {
      cascades,
      maxFar,
      mode: "custom",
      // `shadowSize` still supplies the extent, exactly as the schema
      // promises: it is what `shadowFarPlane` derives the cascade distance
      // from, so raising it pushes the cascades further out just as it widened
      // the single frustum before.
      lightMargin: Math.max(60, shadowSize * 1.5),
      customSplitsCallback: (count, cameraNear, cameraFar, breaks) => {
        breaks.length = 0;
        for (const value of cascadeSplits(count, cameraNear, cameraFar, lambda)) breaks.push(value);
      },
    });
    node.baseBias = settings.bias;
    node.baseNormalBias = settings.normalBias;
    // Cross-cascade blend. Off, a cascade boundary is a hard step in shadow
    // softness across the middle of the frame — one of the more obvious
    // "this is a hobby renderer" tells.
    node.fade = true;
    // `mapSize`/`radius` are read when CSM clones `light.shadow` on its first
    // setup, so `applyShadowSettings` above must already have run.
    light.shadow.shadowNode = node;

    // Deliberately NOT seeding `node.camera` here: `CSMShadowNode.setup()`
    // treats a non-null camera as "already initialised" and skips the private
    // `_init()` that creates the per-cascade lights and shadow nodes. The
    // first render fits the cascades; `update()` refits from then on.
    this.entries.set(light, { light, node, fitKey: "" });
    this.passesByLight.set(light, cascades);
    return true;
  }

  /**
   * Per-frame. Cheap when nothing changed: one string compare per cascaded
   * light. Call before rendering.
   */
  update(camera: THREE.Camera): void {
    const key = cameraFitKey(camera);
    for (const entry of this.entries.values()) {
      // Still waiting for its first `setup()`: three has not built the
      // cascade frustums yet, and `updateFrustums()` would dereference a null
      // `mainFrustum`.
      if (entry.node.mainFrustum === null) continue;
      entry.node.applyQuality();
      if (entry.node.camera === camera && entry.fitKey === key) continue;
      entry.node.camera = camera;
      entry.node.updateFrustums();
      entry.fitKey = key;
    }
  }

  /** Drop a light's cascades (entity rebuilt, chunk unloaded, scene swapped). */
  release(light: THREE.DirectionalLight): void {
    const entry = this.entries.get(light);
    this.passesByLight.delete(light);
    if (!entry) return;
    this.entries.delete(light);
    if (light.shadow.shadowNode === entry.node) light.shadow.shadowNode = undefined;
    entry.node.dispose();
  }

  dispose(): void {
    for (const light of [...this.entries.keys()]) this.release(light);
    this.passesByLight.clear();
  }

  stats(): CascadeShadowStats {
    let shadowPasses = 0;
    for (const passes of this.passesByLight.values()) shadowPasses += passes;
    return { cascadedLights: this.entries.size, shadowPasses };
  }
}

