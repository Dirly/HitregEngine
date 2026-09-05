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
import { setEnvironment as setMaterialEnvironment, setEnvironmentScale } from "./material-maps.js";
import { refillSkyEnvironmentTexture } from "./environment.js";
import { setFoliageWindScale } from "./foliage-wind.js";

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
  sun?: { direction: [number, number, number]; color: string; size: number; intensity: number } | undefined;
  moon?: { direction: [number, number, number]; color: string; size: number; intensity: number } | undefined;
  stars?: { intensity: number; density: number; size: number } | undefined;
  clouds?: { coverage: number; scale: number; speed: [number, number]; softness: number; color: string; shadow: string } | undefined;
}

/** `userData` key under which the gradient dome carries its uniforms. */
export const SKY_DOME_UNIFORMS = "hitregSkyUniforms";

/** The gradient dome's live knobs (see `buildSkyDome`). */
export interface SkyDomeUniforms {
  top: { value: THREE.Color };
  bottom: { value: THREE.Color };
  sunDirection: { value: THREE.Vector3 };
  sunColor: { value: THREE.Color };
  sunSize: { value: number };
  sunIntensity: { value: number };
  moonDirection: { value: THREE.Vector3 };
  moonColor: { value: THREE.Color };
  moonSize: { value: number };
  moonIntensity: { value: number };
  starsIntensity: { value: number };
  starsDensity: { value: number };
  starsSize: { value: number };
  /** Unit quaternion (xyzw) the star field is rotated by. */
  starsRotation: { value: THREE.Vector4 };
  cloudCoverage: { value: number };
  cloudScale: { value: number };
  cloudSpeed: { value: THREE.Vector2 };
  cloudSoftness: { value: number };
  cloudColor: { value: THREE.Color };
  cloudShadow: { value: THREE.Color };
  cloudLight: { value: number };
}

/**
 * What a script may change about the sky per frame — every field is a
 * uniform, a light property or a colour write, never a rebuild and never a
 * shader recompile. `sun.direction` and `moon.direction` point TOWARD the
 * body (where it is on the sky sphere). The one deliberately expensive
 * field is `refreshEnvironment`: it re-runs the sky's IBL prefilter from
 * the current gradient, in place (same texture object, so no material
 * recompiles) — a few milliseconds of GPU, meant for a handful of times per
 * game day, never per frame.
 */
export interface LiveSkyOptions {
  top?: string;
  bottom?: string;
  fog?: { color?: string; density?: number; near?: number; far?: number };
  /** Hemisphere fill intensity (the sky's `light`). */
  hemisphere?: number;
  /** The scene's directional light(s): aim, colour, intensity, and the dome's disc. */
  sun?: {
    direction?: [number, number, number];
    color?: string;
    intensity?: number;
    disc?: { color?: string; size?: number; intensity?: number };
  };
  /** The dome's moon disc — a picture on the sky, not a light. */
  moon?: { direction?: [number, number, number]; color?: string; size?: number; intensity?: number };
  /** The dome's star field: brightness (0 hides it), density, dot size, and its rotation as an axis + angle (radians). */
  stars?: { intensity?: number; density?: number; size?: number; rotation?: { axis: [number, number, number]; angle: number } };
  /** The dome's cloud layer: coverage 0..1, how lit it is (1 = day), its lit and shadow colours, and the wind. */
  clouds?: { coverage?: number; light?: number; color?: string; shadow?: string; speed?: [number, number]; scale?: number; softness?: number };
  ambient?: { color?: string; intensity?: number };
  /**
   * Weather, applied ON TOP of whatever the day/night values are, so a weather
   * script and a day/night script can both run without knowing about each
   * other: `gloom` (0..1) dims the sun, fill, ambient, IBL and cloud light;
   * `tint` blends the fog and horizon toward a colour by `tintAmount` (sand
   * ochre, snow grey); `wind` scales every foliage wind (1 = authored).
   */
  weather?: { gloom?: number; tint?: string; tintAmount?: number; wind?: number };
  /** Scales image-based lighting scene-wide (materials' own envMapIntensity stays authored). */
  environmentIntensity?: number;
  refreshEnvironment?: boolean;
}

/** The authored state a day/night script starts from. */
export interface LiveSkyBase {
  top: string;
  bottom: string;
  fog: { color: string; density: number; near: number; far: number } | null;
  hemisphere: number;
  sun: { direction: [number, number, number]; color: string; intensity: number } | null;
  ambient: { color: string; intensity: number } | null;
  environmentIntensity: number;
  clouds: { coverage: number; softness: number } | null;
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
const UP = new THREE.Vector3(0, 1, 0);

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
  /** Live-sky plumbing: the dome, its fill light, the sun(s), the authored sky. */
  private domeUniforms: SkyDomeUniforms | null = null;
  private hemisphere: THREE.HemisphereLight | null = null;
  private readonly directionalLights = new Set<THREE.DirectionalLight>();
  private ambientLights: THREE.AmbientLight[] | null = null;
  private baseSky: SkyData | null = null;
  private liveBase: LiveSkyBase | null = null;
  private environmentScale = 1;
  /** Raw (pre-weather) values the last setSkyLive asked for, so weather can re-derive the effective ones. */
  private readonly req = {
    hemisphere: null as number | null,
    ambient: null as number | null,
    sun: null as number | null,
    environment: null as number | null,
    cloudLight: null as number | null,
    fogColor: null as THREE.Color | null,
    bottom: null as THREE.Color | null,
  };
  private readonly weather = { gloom: 0, tint: new THREE.Color("#808080"), tintAmount: 0 };
  private readonly tintScratch = new THREE.Color();
  private readonly aimQuaternion = new THREE.Quaternion();
  private readonly aimVector = new THREE.Vector3();

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
      this.directionalLights.add(light as THREE.DirectionalLight);
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
      this.directionalLights.delete(light as THREE.DirectionalLight);
      this.cascades.release(light as THREE.DirectionalLight);
    }
  }

  /** The builder hands over the gradient dome it made for this scene's sky. */
  attachSkyDome(dome: THREE.Mesh): void {
    this.domeUniforms = (dome.userData[SKY_DOME_UNIFORMS] as SkyDomeUniforms | undefined) ?? null;
  }

  /** …and the hemisphere fill light, when `sky.light > 0`. */
  attachSkyHemisphere(light: THREE.HemisphereLight): void {
    this.hemisphere = light;
  }

  /**
   * The authored sky and lights, for a script to derive its day from. Null
   * until the scene has a sky; the sun is the first directional light seen.
   */
  liveSkyBase(): LiveSkyBase | null {
    if (this.liveBase) return this.liveBase;
    const sky = this.baseSky;
    if (!sky) return null;
    const sun = this.directionalLights.values().next().value as THREE.DirectionalLight | undefined;
    let sunBase: LiveSkyBase["sun"] = null;
    if (sun) {
      // the convention: a directional light's rotation is its direction, with
      // its target at local (0,-1,0) — so "toward the sun" is local +Y rotated
      const holder = sun.parent ?? sun;
      holder.updateWorldMatrix(true, false);
      this.aimVector.set(0, 1, 0).applyQuaternion(holder.getWorldQuaternion(this.aimQuaternion)).normalize();
      sunBase = {
        direction: [this.aimVector.x, this.aimVector.y, this.aimVector.z],
        color: "#" + sun.color.getHexString(),
        intensity: sun.intensity,
      };
    }
    const ambient = this.findAmbientLights()[0];
    this.liveBase = {
      top: sky.top,
      bottom: sky.bottom,
      fog: sky.fog ? { color: sky.fog.color, density: sky.fog.density, near: sky.fog.near, far: sky.fog.far } : null,
      hemisphere: sky.light,
      sun: sunBase,
      ambient: ambient ? { color: "#" + ambient.color.getHexString(), intensity: ambient.intensity } : null,
      environmentIntensity: this.environment.current.intensity,
      clouds: sky.clouds ? { coverage: sky.clouds.coverage, softness: sky.clouds.softness } : null,
    };
    return this.liveBase;
  }

  /** Drive the sky without a rebuild — see {@link LiveSkyOptions}. */
  setSkyLive(live: LiveSkyOptions): void {
    const dome = this.domeUniforms;
    const req = this.req;
    if (live.top !== undefined) {
      dome?.top.value.set(live.top);
      this.hemisphere?.color.set(live.top);
      if (this.baseSky) this.baseSky = { ...this.baseSky, top: live.top };
    }
    if (live.bottom !== undefined) {
      (req.bottom ??= new THREE.Color()).set(live.bottom);
      if (this.baseSky) this.baseSky = { ...this.baseSky, bottom: live.bottom };
    }
    if (live.fog) {
      if (live.fog.color !== undefined) (req.fogColor ??= new THREE.Color()).set(live.fog.color);
      const { color: _color, ...rest } = live.fog;
      if (Object.keys(rest).length > 0) this.fog.retune(this.scene, rest);
    }
    if (live.hemisphere !== undefined) req.hemisphere = Math.max(0, live.hemisphere);
    if (live.sun) {
      for (const sun of this.directionalLights) {
        if (live.sun.direction) {
          const holder = sun.parent ?? sun;
          this.aimVector.set(live.sun.direction[0], live.sun.direction[1], live.sun.direction[2]).normalize();
          holder.quaternion.setFromUnitVectors(UP, this.aimVector);
          holder.updateMatrixWorld(true);
        }
        if (live.sun.color !== undefined) sun.color.set(live.sun.color);
      }
      if (live.sun.intensity !== undefined) req.sun = Math.max(0, live.sun.intensity);
      if (dome) {
        if (live.sun.direction) dome.sunDirection.value.set(live.sun.direction[0], live.sun.direction[1], live.sun.direction[2]).normalize();
        const disc = live.sun.disc;
        if (disc?.color !== undefined) dome.sunColor.value.set(disc.color);
        if (disc?.size !== undefined) dome.sunSize.value = Math.min(0.9999, Math.max(0.9, disc.size));
        if (disc?.intensity !== undefined) dome.sunIntensity.value = Math.max(0, disc.intensity);
      }
    }
    if (live.moon && dome) {
      if (live.moon.direction) dome.moonDirection.value.set(live.moon.direction[0], live.moon.direction[1], live.moon.direction[2]).normalize();
      if (live.moon.color !== undefined) dome.moonColor.value.set(live.moon.color);
      if (live.moon.size !== undefined) dome.moonSize.value = Math.min(0.9999, Math.max(0.9, live.moon.size));
      if (live.moon.intensity !== undefined) dome.moonIntensity.value = Math.max(0, live.moon.intensity);
    }
    if (live.stars && dome) {
      if (live.stars.intensity !== undefined) dome.starsIntensity.value = Math.max(0, live.stars.intensity);
      if (live.stars.density !== undefined) dome.starsDensity.value = Math.min(1, Math.max(0, live.stars.density));
      if (live.stars.size !== undefined) dome.starsSize.value = Math.max(0.1, live.stars.size);
      if (live.stars.rotation) {
        const { axis, angle } = live.stars.rotation;
        this.aimVector.set(axis[0], axis[1], axis[2]).normalize();
        this.aimQuaternion.setFromAxisAngle(this.aimVector, angle);
        dome.starsRotation.value.set(this.aimQuaternion.x, this.aimQuaternion.y, this.aimQuaternion.z, this.aimQuaternion.w);
      }
    }
    if (live.clouds && dome) {
      const c = live.clouds;
      if (c.coverage !== undefined) dome.cloudCoverage.value = Math.min(1, Math.max(0, c.coverage));
      if (c.light !== undefined) req.cloudLight = Math.max(0, c.light);
      if (c.color !== undefined) dome.cloudColor.value.set(c.color);
      if (c.shadow !== undefined) dome.cloudShadow.value.set(c.shadow);
      if (c.speed) dome.cloudSpeed.value.set(c.speed[0], c.speed[1]);
      if (c.scale !== undefined) dome.cloudScale.value = Math.max(0.05, c.scale);
      if (c.softness !== undefined) dome.cloudSoftness.value = Math.min(1, Math.max(0.01, c.softness));
    }
    if (live.ambient) {
      for (const ambient of this.findAmbientLights()) {
        if (live.ambient.color !== undefined) ambient.color.set(live.ambient.color);
      }
      if (live.ambient.intensity !== undefined) req.ambient = Math.max(0, live.ambient.intensity);
    }
    if (live.environmentIntensity !== undefined) req.environment = Math.max(0, live.environmentIntensity);
    if (live.weather) {
      const w = live.weather;
      if (w.gloom !== undefined) this.weather.gloom = Math.min(1, Math.max(0, w.gloom));
      if (w.tint !== undefined) this.weather.tint.set(w.tint);
      if (w.tintAmount !== undefined) this.weather.tintAmount = Math.min(1, Math.max(0, w.tintAmount));
      if (w.wind !== undefined) setFoliageWindScale(w.wind);
    }
    this.applyEffective();
    if (live.refreshEnvironment && this.baseSky) {
      const texture = this.environment.current.texture;
      if (texture && (texture as THREE.DataTexture).isDataTexture && texture.name === "sky-environment") {
        refillSkyEnvironmentTexture(texture as THREE.DataTexture, this.baseSky);
      }
    }
  }

  /**
   * Write the values the scene actually sees: what the last setSkyLive asked
   * for, dimmed by weather gloom and tinted by weather tint. Called after
   * every setSkyLive, so a weather write re-derives the day/night values and
   * vice versa without either script seeing the other.
   */
  private applyEffective(): void {
    const dome = this.domeUniforms;
    const req = this.req;
    const gloom = this.weather.gloom;
    const dim = 1 - 0.75 * gloom; // fill, ambient, IBL, cloud light
    const sunDim = 1 - 0.85 * gloom; // the sun goes further: hard shadows vanish under cloud
    if (req.hemisphere !== null && this.hemisphere) this.hemisphere.intensity = req.hemisphere * dim;
    if (req.sun !== null) for (const sun of this.directionalLights) sun.intensity = req.sun * sunDim;
    if (req.ambient !== null) for (const ambient of this.findAmbientLights()) ambient.intensity = req.ambient * dim;
    if (req.cloudLight !== null && dome) dome.cloudLight.value = req.cloudLight * dim;
    if (req.environment !== null) {
      const base = this.liveBase?.environmentIntensity ?? this.environment.current.intensity;
      const effective = req.environment * dim;
      this.environmentScale = base > 0 ? effective / base : 0;
      this.scene.environmentIntensity = effective;
      if (materialEnvironmentOwner === this) setEnvironmentScale(this.environmentScale);
    }
    const amount = this.weather.tintAmount;
    if (req.bottom) {
      this.tintScratch.copy(req.bottom).lerp(this.weather.tint, amount);
      dome?.bottom.value.copy(this.tintScratch);
      this.hemisphere?.groundColor.copy(this.tintScratch);
      if (this.scene.background instanceof THREE.Color) this.scene.background.copy(this.tintScratch);
    }
    if (req.fogColor) {
      this.tintScratch.copy(req.fogColor).lerp(this.weather.tint, amount);
      this.fog.retune(this.scene, { color: "#" + this.tintScratch.getHexString() });
    }
  }

  private findAmbientLights(): THREE.AmbientLight[] {
    if (this.ambientLights) return this.ambientLights;
    const found: THREE.AmbientLight[] = [];
    this.scene.traverse((object) => {
      if ((object as THREE.AmbientLight).isAmbientLight === true) found.push(object as THREE.AmbientLight);
    });
    this.ambientLights = found;
    return found;
  }

  /**
   * Fold a scene's `sky` component in. Safe to call with null (no sky
   * component): fog is cleared and IBL is off, which is exactly what a scene
   * without a sky did before this existed.
   */
  applySky(sky: SkyData | null): void {
    this.baseSky = sky;
    this.liveBase = null;
    this.ambientLights = null;
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
    this.liveSkyBase(); // capture the AUTHORED look now, before any script drives the sky
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
    setEnvironmentScale(this.environmentScale);
  }
}

/** The lighting state a built scene carries, if it has one. */
export function sceneLighting(scene: THREE.Scene): SceneLighting | null {
  const value = scene.userData[SCENE_LIGHTING_KEY];
  return value instanceof SceneLighting ? value : null;
}
