import * as THREE from "three/webgpu";
import {
  CascadeShadowSystem,
  applyShadowSettings,
  shadowPassCost,
  type CascadeShadowStats,
  type ShadowSettings,
} from "./csm.js";
import {
  DEFAULT_VOLUMETRIC_SETTINGS,
  FogSystem,
  volumetricLightCandidates,
  volumetricSignature,
  type FogSettings,
  type VolumetricRequest,
  type VolumetricSettings,
} from "./atmosphere.js";
import {
  EnvironmentSystem,
  applyEnvironment,
  type EnvironmentSettings,
  type SkyEnvironmentSource,
} from "./environment.js";
import { setEnvironment as setMaterialEnvironment } from "./material-maps.js";

/**
 * The per-scene half of the lighting/atmosphere stack: everything `csm.ts`,
 * `environment.ts` and `atmosphere.ts` need in order to be driven by a built
 * scene, in one object the builder creates and the renderer finds again.
 *
 * WHY IT IS ATTACHED TO THE SCENE rather than passed around: the playground
 * host calls `buildScene()` and `EngineRenderer.render(scene, camera)` and
 * nothing in between. Cascade refits, the PMREM prefilter and the volumetric
 * light query all need the *render camera and renderer*, which only the
 * renderer has, while the settings they act on only the builder has seen. A
 * handle on `scene.userData` is the one channel both already share — so this
 * whole feature set turns on with no host change at all, and a host that
 * builds scenes it never renders (thumbnails) pays nothing.
 */
const SCENE_LIGHTING_KEY = "hitregLighting";

/** `sky.fog`, zod-defaulted — the shape `FogSystem` consumes. */
export type SkyFogData = FogSettings;

/** The `sky` component payload, zod-defaulted. */
export interface SkyData extends SkyEnvironmentSource {
  light: number;
  fog?: SkyFogData | undefined;
  volumetric?: VolumetricSettings | undefined;
  environment?: EnvironmentSettings | undefined;
}

export interface SceneLightingOptions {
  /** Asset id -> URL; same contract as `BuildOptions.resolveTexture`. */
  resolveTexture?: ((assetId: string) => string | undefined) | undefined;
}

/**
 * How often the volumetric light query re-scans the scene, in frames.
 *
 * Not every frame, for two reasons that both cost real time. The scan is a
 * graph traversal; more importantly a CHANGE in the shaft light set forces a
 * post-pipeline rebuild (the node graph holds direct references to specific
 * lights), and `LightBudgetSystem` hides and unhides point lights as the
 * camera moves — so an unthrottled query would recompile the whole post chain
 * whenever a brazier crossed the budget line. A quarter-second of latency on
 * "which light casts the shaft" is invisible; the recompile stutter is not.
 */
const VOLUMETRIC_POLL_FRAMES = 15;

/**
 * Number of lights allowed to cast shafts at once. One, deliberately: each is
 * an independent full raymarch, and the composite can only depth-aware-upsample
 * the first one (see `VolumetricShafts`).
 */
const VOLUMETRIC_MAX_LIGHTS = 1;

/**
 * The scene whose environment is currently on the shared materials.
 *
 * The material-side IBL seam in `material-maps` is module-global, because
 * materials are deduped and shared across every build. Exactly one scene may
 * therefore drive it, and it has to be the one being RENDERED — not the one
 * being built. Pushing it from `buildScene` instead would let every thumbnail
 * bake and every streamed chunk (both of which build scenes nobody renders)
 * clear the live scene's IBL and flag every PBR material for recompile.
 */
let materialEnvironmentOwner: SceneLighting | null = null;

export interface SceneLightingStats extends CascadeShadowStats {
  /** Lights currently casting volumetric shafts. */
  shaftLights: number;
  /** True when image-based lighting is active on this scene. */
  environment: boolean;
}

export class SceneLighting {
  readonly cascades = new CascadeShadowSystem();
  readonly fog = new FogSystem();
  readonly environment: EnvironmentSystem;

  /** Shadow-map render passes owed by the lights cascades doesn't own. */
  private readonly otherShadowPasses = new Map<THREE.Light, number>();
  private volumetric: VolumetricSettings = DEFAULT_VOLUMETRIC_SETTINGS;
  private shaftLights: THREE.Light[] = [];
  private shaftSignature = "";
  private pollCountdown = 0;
  /** The texture last pushed to the shared materials; guards a recompile storm. */
  private pushedEnvironment: THREE.Texture | null | undefined = undefined;

  constructor(
    private readonly scene: THREE.Scene,
    options: SceneLightingOptions = {},
  ) {
    this.environment = new EnvironmentSystem({
      resolveTexture: options.resolveTexture,
      // An HDRI/cubemap that lands after the build still has to reach the
      // materials; without this the scene keeps the null environment it was
      // built with and every metal stays black until the next rebuild.
      onChange: () => applyEnvironment(this.scene, this.environment.current),
    });
    scene.userData[SCENE_LIGHTING_KEY] = this;
  }

  /**
   * Turn a light's `shadow` block into three state. The one place that knows
   * `cascades`/`cascadeSplit` are directional-only — the schema cannot express
   * a conditional field, so the condition lives here.
   */
  registerLight(light: THREE.Light, castShadow: boolean, settings: ShadowSettings, shadowSize: number): void {
    this.otherShadowPasses.delete(light);
    if ((light as THREE.DirectionalLight).isDirectionalLight === true) {
      this.cascades.register(light as THREE.DirectionalLight, castShadow, settings, shadowSize);
      return;
    }
    const enabled = applyShadowSettings(light, castShadow, settings, shadowSize);
    if (!enabled) return;
    const kind = (light as THREE.PointLight).isPointLight === true
      ? "point"
      : (light as THREE.SpotLight).isSpotLight === true
        ? "spot"
        : "ambient";
    // A shadow-casting point light is SIX depth renders of everything in range,
    // which is why one can outweigh a dozen unshadowed lights — surface it.
    const cost = shadowPassCost(kind, settings);
    if (cost > 0) this.otherShadowPasses.set(light, cost);
  }

  /** Drop a light's shadow bookkeeping (entity rebuilt, chunk unloaded). */
  releaseLight(light: THREE.Light): void {
    this.otherShadowPasses.delete(light);
    if ((light as THREE.DirectionalLight).isDirectionalLight === true) {
      this.cascades.release(light as THREE.DirectionalLight);
    }
  }

  /**
   * Fold a scene's `sky` component in. Safe to call with null (no sky
   * component): fog is cleared and IBL is off, which is exactly what a scene
   * without a sky did before this existed.
   */
  applySky(sky: SkyData | null): void {
    this.fog.apply(this.scene, sky?.fog ?? null);
    this.volumetric = sky?.volumetric ?? DEFAULT_VOLUMETRIC_SETTINGS;
    // Re-query on the next frame rather than keeping a set that was chosen for
    // the previous sky.
    this.pollCountdown = 0;

    const settings = sky?.environment;
    if (!sky || !settings) {
      this.environment.update(null, { mode: "none", intensity: 1, rotation: 0 });
    } else {
      this.environment.update(sky, settings);
    }
    // Scene-local only. The shared material seam is pushed from frame(), by
    // whichever scene is actually being rendered.
    applyEnvironment(this.scene, this.environment.current);
  }

  /**
   * Per-frame, called by `EngineRenderer.render()` before it renders. Cheap:
   * one string compare per cascaded light, and the volumetric scan only runs
   * when volumetrics are enabled and only every `VOLUMETRIC_POLL_FRAMES`.
   */
  frame(camera: THREE.Camera): void {
    this.cascades.update(camera);
    this.claimMaterialEnvironment();

    if (!this.volumetric.enabled) {
      if (this.shaftLights.length > 0) {
        this.shaftLights = [];
        this.shaftSignature = "";
      }
      return;
    }
    if (this.pollCountdown > 0) {
      this.pollCountdown--;
      return;
    }
    this.pollCountdown = VOLUMETRIC_POLL_FRAMES;
    // Traversed rather than read from a registry the builder fills: chunk and
    // subscene loads build their own scenes and reparent the results into this
    // one, so a registry would miss every light that streamed in — which in a
    // chunked world is most of them.
    const lights: THREE.Light[] = [];
    this.scene.traverseVisible((object) => {
      if ((object as THREE.Light).isLight === true) lights.push(object as THREE.Light);
    });
    const next = volumetricLightCandidates(lights, VOLUMETRIC_MAX_LIGHTS);
    const signature = volumetricSignature(next);
    if (signature === this.shaftSignature) return;
    this.shaftLights = next;
    this.shaftSignature = signature;
  }

  /** What the post chain needs to build/retune shafts, or null when they're off. */
  volumetricRequest(): VolumetricRequest | null {
    if (!this.volumetric.enabled || this.shaftLights.length === 0) return null;
    return { settings: this.volumetric, lights: this.shaftLights, signature: this.shaftSignature };
  }

  stats(): SceneLightingStats {
    const cascades = this.cascades.stats();
    let shadowPasses = cascades.shadowPasses;
    for (const cost of this.otherShadowPasses.values()) shadowPasses += cost;
    return {
      ...cascades,
      shadowPasses,
      shaftLights: this.shaftLights.length,
      environment: this.environment.current.texture !== null,
    };
  }

  dispose(): void {
    if (materialEnvironmentOwner === this) materialEnvironmentOwner = null;
    this.otherShadowPasses.clear();
    this.cascades.dispose();
    this.fog.dispose(this.scene);
    this.environment.dispose();
    this.shaftLights = [];
    this.shaftSignature = "";
    if (this.scene.userData[SCENE_LIGHTING_KEY] === this) {
      delete this.scene.userData[SCENE_LIGHTING_KEY];
    }
  }

  /**
   * Take over the shared material seam. `scene.environment` alone is not
   * enough: three resolves env intensity as
   * `material.envMap ? material.envMapIntensity : scene.environmentIntensity`,
   * so supplying it only through the scene silently ignores every material's
   * own `envMapIntensity` — see `material-maps.setEnvironment`.
   */
  private claimMaterialEnvironment(): void {
    const texture = this.environment.current.texture;
    if (materialEnvironmentOwner === this && this.pushedEnvironment === texture) return;
    materialEnvironmentOwner = this;
    this.pushedEnvironment = texture;
    // Cheap when nothing moved: `setEnvironment` skips materials that already
    // hold this texture, and a rebuild gets the SAME texture object back from
    // the sky cache — so no recompile and no re-PMREM.
    setMaterialEnvironment(texture);
  }
}

/** The lighting state a built scene carries, if it has one. */
export function sceneLighting(scene: THREE.Scene): SceneLighting | null {
  const value = scene.userData[SCENE_LIGHTING_KEY];
  return value instanceof SceneLighting ? value : null;
}
