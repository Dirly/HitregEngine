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
import { publishDaylight } from "./daylight.js";
import { setRimLight, type RimSettings } from "./rim-light.js";

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
  clouds?:
    | {
        coverage: number;
        scale: number;
        speed: [number, number];
        softness: number;
        color: string;
        shadow: string;
        sun?: string;
        sunAmount?: number;
        texture?: string | undefined;
        pixel?: number;
      }
    | undefined;
  horizon?: { texture: string; height: number; repeat: number; offset: number; opacity: number; depth: number } | undefined;
  rim?: RimSettings | undefined;
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
  cloudSun: { value: THREE.Color };
  cloudSunAmount: { value: number };
  cloudLight: { value: number };
  /** 1 once the painted cloud texture has loaded (until then the layer is the procedural deck alone). */
  cloudTexOn: { value: number };
  /** Horizon backdrop opacity, held at 0 until its texture has loaded. */
  horizonOpacity: { value: number };
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
  /**
   * The dome's cloud layer: coverage 0..1, how lit it is (1 = day), its lit
   * and shadow colours, the DIRECTIONAL dawn/dusk glow (`sun` colour, opened
   * by `sunAmount` 0..1 — the warm side faces the sun, the far sky stays
   * cold), and the wind.
   */
  clouds?: {
    coverage?: number;
    light?: number;
    color?: string;
    shadow?: string;
    sun?: string;
    sunAmount?: number;
    speed?: [number, number];
    scale?: number;
    softness?: number;
  };
  ambient?: { color?: string; intensity?: number };
  /**
   * Weather, applied ON TOP of whatever the day/night values are, so a weather
   * script and a day/night script can both run without knowing about each
   * other: `gloom` (0..1) dims the sun, fill, ambient, IBL and cloud light;
   * `tint` blends the fog and horizon toward a colour by `tintAmount` (sand
   * ochre, snow grey); `wind` scales every foliage wind (1 = authored);
   * `cloudDark` (0..1) drives the deck itself toward storm grey — gloom dims
   * what the cloud LIGHTS, this darkens the cloud you are looking at, and a
   * storm needs both or you get a dim world under a bright white sky;
   * `flash` (0..1) is lightning — a momentary wash over the sky, fog, fill and
   * ambient. It deliberately adds no light and touches no material, so it
   * cannot trigger a recompile at the worst possible moment.
   * `overcast` (0..1) is how much of the sky the deck closes, on top of the
   * authored coverage: 1 fills the whole dome, hides the sun disc and its
   * dawn/dusk glow on the clouds, takes the sun's scatter out of the fog,
   * turns god rays off and softens the sun (no hard shadows under a full
   * deck). Rain drives it to 1; a dry grey day is anywhere in between.
   */
  weather?: { gloom?: number; tint?: string; tintAmount?: number; wind?: number; cloudDark?: number; flash?: number; overcast?: number };
  /**
   * A zone's MOOD, layered over the day/night values and under the weather
   * (see `regionMoodSchema` in @hitreg/core): `sky`/`haze` pull the zenith and
   * the horizon+fog toward a colour by `amount`; `light` and `shade` MULTIPLY
   * the sun's and the fill lights' colours; `lightScale` and `fogDensity`
   * multiply intensities. Omitted fields are neutral. Pass null to clear.
   */
  mood?: { sky?: string; haze?: string; amount?: number; light?: string; lightScale?: number; shade?: string; fogDensity?: number; mist?: number } | null;
  /**
   * How much DAYLIGHT there is here, 0..1 — what a day/night script already
   * computes from the sun elevation, published so the weather layer can be
   * combined with it honestly. A weather `tint` is the colour of falling
   * rain, sand or snow LIT; at midnight there is nothing lighting it, and
   * blending fog toward a daytime grey at full strength is what made night
   * fog read pale. Defaults to 1, so a scene with no day/night script keeps
   * exactly the behaviour it had.
   */
  daylight?: number;
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
  /** The authored cloud layer; `color`/`shadow` are its DAY lighting (a day/night script cools them toward night). */
  clouds: { coverage: number; softness: number; color?: string; shadow?: string } | null;
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
  /** The sky's shafts as authored, and the live copy the post chain reads (`overcast` dims it). */
  private volumetricAuthored: VolumetricSettings = DEFAULT_VOLUMETRIC_SETTINGS;
  private volumetric: VolumetricSettings = { ...DEFAULT_VOLUMETRIC_SETTINGS };
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
    /** Coverage, the sun-side cloud glow and the sun disc as asked for, before `overcast` closed the sky. */
    cloudCoverage: null as number | null,
    cloudSunAmount: null as number | null,
    sunDisc: null as number | null,
    /** Cloud colours as the day/night script asked for them, before weather darkened them. */
    top: null as THREE.Color | null,
    cloudColor: null as THREE.Color | null,
    cloudShadow: null as THREE.Color | null,
    fogColor: null as THREE.Color | null,
    bottom: null as THREE.Color | null,
    /** Sun and ambient colours as asked for, before a zone mood multiplied them. */
    sunColor: null as THREE.Color | null,
    ambientColor: null as THREE.Color | null,
    /** Fog density as asked for (weather writes it), before a zone mood multiplied it. */
    fogDensity: null as number | null,
    /**
     * How much DAYLIGHT there is, 0..1, as the day/night script sees it.
     *
     * Weather owns a tint; only the day/night script knows the hour. Without
     * this the two cannot be combined honestly: a weather tint is the colour
     * of falling rain/sand/snow LIT, and lerping the fog toward it at full
     * strength lit up midnight fog to a daytime grey. 1 when nothing drives
     * it, so a scene with no day/night script is unchanged.
     */
    daylight: 1,
  };
  /**
   * The zone mood layer (LiveSkyOptions.mood): over day/night, under weather.
   * Neutral = no sky/haze colour, white multipliers, scale 1.
   */
  private readonly mood = {
    sky: null as THREE.Color | null,
    haze: null as THREE.Color | null,
    amount: 0,
    light: new THREE.Color(1, 1, 1),
    lightScale: 1,
    shade: new THREE.Color(1, 1, 1),
    fogDensity: 1,
    mist: 1,
  };
  private readonly moodScratch = new THREE.Color();
  private readonly weather = { gloom: 0, tint: new THREE.Color("#808080"), tintAmount: 0, cloudDark: 0, flash: 0, overcast: 0 };
  /** The colour lightning washes everything toward — a cold, slightly blue white. */
  private readonly flashColor = new THREE.Color("#cfe0ff");
  private readonly cloudScratch = new THREE.Color();
  private readonly tintScratch = new THREE.Color();
  /** The weather tint dimmed to the hour — see applyEffective. */
  private readonly litTint = new THREE.Color();
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
      // can it EVER raymarch? (cascades own separate maps; no shadow, no map)
      if (!castShadow || !settings.enabled || settings.cascades > 1) this.screenShaftSuns.add(light);
      else this.screenShaftSuns.delete(light);
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

  /** The dome's live uniforms (read-only use: the sea reflects the sky by them), or null without a dome. */
  skyDomeUniforms(): Readonly<SkyDomeUniforms> | null {
    return this.domeUniforms;
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
      clouds: sky.clouds ? { coverage: sky.clouds.coverage, softness: sky.clouds.softness, color: sky.clouds.color, shadow: sky.clouds.shadow } : null,
    };
    return this.liveBase;
  }

  /** Drive the sky without a rebuild — see {@link LiveSkyOptions}. */
  setSkyLive(live: LiveSkyOptions): void {
    const dome = this.domeUniforms;
    const req = this.req;
    if (live.top !== undefined) {
      (req.top ??= new THREE.Color()).set(live.top);
      if (this.baseSky) this.baseSky = { ...this.baseSky, top: live.top };
    }
    if (live.bottom !== undefined) {
      (req.bottom ??= new THREE.Color()).set(live.bottom);
      if (this.baseSky) this.baseSky = { ...this.baseSky, bottom: live.bottom };
    }
    if (live.fog) {
      if (live.fog.color !== undefined) (req.fogColor ??= new THREE.Color()).set(live.fog.color);
      if (live.fog.density !== undefined) req.fogDensity = Math.max(0, live.fog.density);
      const { color: _color, density: _density, ...rest } = live.fog;
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
      }
      if (live.sun.color !== undefined) (req.sunColor ??= new THREE.Color()).set(live.sun.color);
      if (live.sun.intensity !== undefined) req.sun = Math.max(0, live.sun.intensity);
      if (dome) {
        if (live.sun.direction) dome.sunDirection.value.set(live.sun.direction[0], live.sun.direction[1], live.sun.direction[2]).normalize();
        const disc = live.sun.disc;
        if (disc?.color !== undefined) dome.sunColor.value.set(disc.color);
        if (disc?.size !== undefined) dome.sunSize.value = Math.min(0.9999, Math.max(0.9, disc.size));
        if (disc?.intensity !== undefined) req.sunDisc = Math.max(0, disc.intensity);
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
      if (c.coverage !== undefined) req.cloudCoverage = Math.min(1, Math.max(0, c.coverage));
      if (c.light !== undefined) req.cloudLight = Math.max(0, c.light);
      if (c.color !== undefined) (req.cloudColor ??= new THREE.Color()).set(c.color);
      if (c.shadow !== undefined) (req.cloudShadow ??= new THREE.Color()).set(c.shadow);
      if (c.sun !== undefined) dome.cloudSun.value.set(c.sun);
      if (c.sunAmount !== undefined) req.cloudSunAmount = Math.min(1, Math.max(0, c.sunAmount));
      if (c.speed) dome.cloudSpeed.value.set(c.speed[0], c.speed[1]);
      if (c.scale !== undefined) dome.cloudScale.value = Math.max(0.05, c.scale);
      if (c.softness !== undefined) dome.cloudSoftness.value = Math.min(1, Math.max(0.01, c.softness));
    }
    if (live.ambient) {
      if (live.ambient.color !== undefined) (req.ambientColor ??= new THREE.Color()).set(live.ambient.color);
      if (live.ambient.intensity !== undefined) req.ambient = Math.max(0, live.ambient.intensity);
    }
    if (live.environmentIntensity !== undefined) req.environment = Math.max(0, live.environmentIntensity);
    if (live.weather) {
      const w = live.weather;
      if (w.gloom !== undefined) this.weather.gloom = Math.min(1, Math.max(0, w.gloom));
      if (w.tint !== undefined) this.weather.tint.set(w.tint);
      if (w.tintAmount !== undefined) this.weather.tintAmount = Math.min(1, Math.max(0, w.tintAmount));
      if (w.wind !== undefined) setFoliageWindScale(w.wind);
      if (w.cloudDark !== undefined) this.weather.cloudDark = Math.min(1, Math.max(0, w.cloudDark));
      if (w.flash !== undefined) this.weather.flash = Math.min(1, Math.max(0, w.flash));
      if (w.overcast !== undefined) this.weather.overcast = Math.min(1, Math.max(0, w.overcast));
      // Weather modulates the sun and the fill, so it needs their unmodulated
      // values even in a scene no day/night script drives (else they never move).
      const sun = this.directionalLights.values().next().value as THREE.DirectionalLight | undefined;
      if (sun) req.sun ??= sun.intensity;
      if (this.hemisphere) req.hemisphere ??= this.hemisphere.intensity;
      const ambient = this.findAmbientLights()[0];
      if (ambient) req.ambient ??= ambient.intensity;
    }
    if (live.mood !== undefined) this.setMood(live.mood);
    if (live.daylight !== undefined) this.req.daylight = Math.min(1, Math.max(0, live.daylight));
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
    // Lightning. One factor, applied wherever the sky's own brightness is
    // written, so a strike lifts the whole scene for a few frames and leaves
    // nothing behind: no light is added or removed (the light SET must stay
    // constant — see the day-night script) and no material is touched.
    const flash = this.weather.flash;
    const lift = 1 + 3.5 * flash;
    const dim = (1 - 0.75 * gloom) * lift; // fill, ambient, IBL, cloud light
    // Overcast. A closed deck is a sky with no sun in it: the disc and the
    // sun-side glow go, and the direct light falls to a faint remainder so
    // shadows all but vanish. The fill RISES a little to carry the light the
    // sun lost — an overcast day is flat, not dark (zone moods hold the house
    // brightness; weather must not quietly undo that).
    const overcast = this.weather.overcast;
    const open = 1 - overcast;
    const fillLift = 1 + 0.3 * overcast;
    const sunDim = (1 - 0.85 * gloom) * (1 - 0.75 * overcast) * lift; // the sun goes further: hard shadows vanish under cloud
    if (dome) {
      const sky = this.baseSky;
      const coverage = req.cloudCoverage ?? sky?.clouds?.coverage ?? 0;
      dome.cloudCoverage.value = coverage + (1 - coverage) * overcast;
      dome.cloudSunAmount.value = (req.cloudSunAmount ?? sky?.clouds?.sunAmount ?? 0) * open;
      dome.sunIntensity.value = (req.sunDisc ?? sky?.sun?.intensity ?? 0) * open * open;
    }
    if (req.hemisphere !== null && this.hemisphere) this.hemisphere.intensity = req.hemisphere * dim * fillLift;
    const mood = this.mood;
    if (req.sun !== null) for (const sun of this.directionalLights) sun.intensity = req.sun * sunDim * mood.lightScale;
    if (req.ambient !== null) for (const ambient of this.findAmbientLights()) ambient.intensity = req.ambient * dim * fillLift;
    // colours a mood multiplies (white = as asked)
    if (req.sunColor) for (const sun of this.directionalLights) sun.color.copy(req.sunColor).multiply(mood.light);
    if (req.ambientColor) for (const ambient of this.findAmbientLights()) ambient.color.copy(req.ambientColor).multiply(mood.shade);
    if (req.top && this.hemisphere) this.hemisphere.color.copy(req.top).multiply(mood.shade);
    if (req.cloudLight !== null && dome) dome.cloudLight.value = req.cloudLight * dim;
    // The deck itself: storm grey, and lit from inside by a strike. Derived
    // from what the day/night script asked for, so the two stay independent.
    if (dome) {
      const darken = 1 - 0.72 * this.weather.cloudDark;
      if (req.cloudColor) {
        this.cloudScratch.copy(req.cloudColor).multiplyScalar(darken).lerp(this.flashColor, 0.85 * flash);
        dome.cloudColor.value.copy(this.cloudScratch);
      }
      if (req.cloudShadow) {
        // The shadowed side darkens further — that is what makes a storm deck
        // read as a bruise rather than as evenly grey paper.
        this.cloudScratch.copy(req.cloudShadow).multiplyScalar(1 - 0.85 * this.weather.cloudDark).lerp(this.flashColor, 0.5 * flash);
        dome.cloudShadow.value.copy(this.cloudScratch);
      }
    }
    if (req.environment !== null) {
      const base = this.liveBase?.environmentIntensity ?? this.environment.current.intensity;
      const effective = req.environment * dim;
      this.environmentScale = base > 0 ? effective / base : 0;
      this.scene.environmentIntensity = effective;
      if (materialEnvironmentOwner === this) setEnvironmentScale(this.environmentScale);
    }
    // A weather tint is the colour of falling rain, sand or snow AS LIT, so
    // it has to follow the light — at midnight nothing is lighting it, and
    // applied at full strength it lit the fog back up to a daytime grey while
    // the sky above went dark. One factor, applied twice, because both halves
    // fall together after dark: the weather is DIMMER, and you see LESS of it
    // (visibility collapses at night, so less of the view is weather). The
    // 0.15 floor rather than a hard 0 keeps a night sandstorm reading as brown
    // air instead of vanishing into clear night.
    const lit = 0.15 + 0.85 * req.daylight;
    const amount = this.weather.tintAmount * lit;
    this.litTint.copy(this.weather.tint).multiplyScalar(lit);
    // The SKY ITSELF goes dark under a storm, not only what it lights. Without
    // this a full overcast was a bright grey card with a dim world under it:
    // gloom dims lights and `cloudDark` darkens the deck, but the dome's own
    // gradient — which is most of what you see when you look up — answered to
    // neither. It is the first thing anyone reads the weather off.
    const skyDim = 1 - 0.65 * this.weather.cloudDark;
    if (req.top) {
      this.tintScratch.copy(req.top);
      if (mood.sky) this.tintScratch.lerp(mood.sky, mood.amount);
      this.tintScratch.multiplyScalar(skyDim).lerp(this.litTint, amount * 0.6);
      if (flash > 0) this.tintScratch.lerp(this.flashColor, 0.45 * flash);
      dome?.top.value.copy(this.tintScratch);
    }
    if (req.bottom) {
      this.tintScratch.copy(req.bottom);
      if (mood.haze) this.tintScratch.lerp(mood.haze, mood.amount);
      this.tintScratch.multiplyScalar(skyDim).lerp(this.litTint, amount);
      if (flash > 0) this.tintScratch.lerp(this.flashColor, 0.55 * flash);
      dome?.bottom.value.copy(this.tintScratch);
      this.hemisphere?.groundColor.copy(this.tintScratch);
      if (this.scene.background instanceof THREE.Color) this.scene.background.copy(this.tintScratch);
    }
    if (req.fogDensity !== null) this.fog.retune(this.scene, { density: req.fogDensity * mood.fogDensity });
    if (req.fogColor) {
      this.tintScratch.copy(req.fogColor);
      if (mood.haze) this.tintScratch.lerp(mood.haze, mood.amount);
      this.tintScratch.lerp(this.litTint, amount);
      // Fog IS the air, so a strike has to light it too — without this the
      // flash reads as the sky blinking behind a scene that never noticed.
      if (flash > 0) this.tintScratch.lerp(this.flashColor, 0.6 * flash);
      this.fog.retune(this.scene, { color: "#" + this.tintScratch.getHexString() });
    }
  }

  /**
   * Take a zone mood. The layer can only modulate values it knows the
   * unmodulated form of, so the first mood also seeds those from the scene
   * as authored — which is what keeps a scene with no day/night script
   * returning EXACTLY to its own look when the mood clears.
   */
  private setMood(next: NonNullable<LiveSkyOptions["mood"]> | null): void {
    const m = this.mood;
    const req = this.req;
    m.sky = next?.sky ? (m.sky ?? new THREE.Color()).set(next.sky) : null;
    m.haze = next?.haze ? (m.haze ?? new THREE.Color()).set(next.haze) : null;
    m.amount = Math.min(1, Math.max(0, next?.amount ?? 0));
    m.light.set(next?.light ?? "#ffffff");
    m.lightScale = Math.max(0, next?.lightScale ?? 1);
    m.shade.set(next?.shade ?? "#ffffff");
    m.fogDensity = Math.max(0, next?.fogDensity ?? 1);
    m.mist = Math.max(0, next?.mist ?? 1);
    this.fog.setMistScale(m.mist);
    const sky = this.baseSky;
    if (sky) {
      req.top ??= new THREE.Color(sky.top);
      req.bottom ??= new THREE.Color(sky.bottom);
      if (sky.fog) {
        req.fogColor ??= new THREE.Color(sky.fog.color);
        req.fogDensity ??= sky.fog.density;
      }
    }
    const sun = this.directionalLights.values().next().value as THREE.DirectionalLight | undefined;
    if (sun) {
      req.sunColor ??= sun.color.clone();
      req.sun ??= sun.intensity;
    }
    const ambient = this.findAmbientLights()[0];
    if (ambient) req.ambientColor ??= ambient.color.clone();
  }

  /**
   * How much DAYLIGHT there is here, 0..1, as the day/night layer last said.
   *
   * Published rather than recomputed because only the day/night script knows
   * the hour, and several things that are NOT lights need it: unlit particles
   * (rain is as white at midnight as at noon unless something dims it), a
   * screen-space storm overlay, a script deciding when to light the torches.
   * 1 in a scene with no day/night script, which is what such a scene looked
   * like before this existed.
   */
  daylight(): number {
    return this.req.daylight;
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
    setRimLight(sky?.rim ?? null);
    this.volumetricAuthored = sky?.volumetric ?? DEFAULT_VOLUMETRIC_SETTINGS;
    this.volumetric = { ...this.volumetricAuthored };
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
    this.syncSun();
    publishDaylight(this.req.daylight);

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

  /**
   * The sun as the atmosphere sees it this frame: the first directional
   * light's direction (TOWARD it — local +Y rotated, the same convention as
   * liveSkyBase) and its colour/intensity, pushed to the fog's sun-side glow.
   * One quaternion transform per frame.
   */
  private syncSun(): void {
    const sun = this.directionalLights.values().next().value as THREE.DirectionalLight | undefined;
    if (!sun) return;
    const holder = sun.parent ?? sun;
    this.sunDirection.set(0, 1, 0).applyQuaternion(holder.getWorldQuaternion(this.aimQuaternion)).normalize();
    // no sun-side glow in the fog when the sun is behind a closed deck
    this.fog.setSun(this.sunDirection, sun.color, sun.visible ? sun.intensity * (1 - this.weather.overcast) : 0);
  }

  /** Directional lights that can never raymarch shafts — they get screen-space ones. */
  private readonly screenShaftSuns = new WeakSet<THREE.Light>();

  /** Toward the sun, world space, as of the last frame(). */
  readonly sunDirection = new THREE.Vector3(0, 1, 0);

  /** What the post chain needs to build/retune shafts, or null when they're off. */
  volumetricRequest(): VolumetricRequest | null {
    if (!this.volumetric.enabled) return null;
    // Overcast takes the shafts away — there is no sun to stream from. Never
    // all the way to 0: an intensity of 0 plans the pass OUT, and the chain
    // rebuild that costs is a hitch every time a storm arrives. Below 0.001
    // the screen-space walk skips its loop, so a closed sky costs nothing.
    const open = 1 - this.weather.overcast;
    const authored = this.volumetricAuthored.intensity;
    this.volumetric.intensity = authored > 0 ? Math.max(1e-4, authored * open * open) : 0;
    if (this.shaftLights.length > 0) return { settings: this.volumetric, lights: this.shaftLights, signature: this.shaftSignature };
    // No light can raymarch (a cascaded sun has no single shadow map): fall
    // back to SCREEN-SPACE shafts streaming from the sun across bright sky.
    const sun = this.directionalLights.values().next().value as THREE.DirectionalLight | undefined;
    // only a sun that can NEVER raymarch: one merely waiting for its first
    // shadow render must not flip the chain screen -> raymarch (a rebuild)
    if (!sun || !this.screenShaftSuns.has(sun)) return null;
    return { settings: this.volumetric, lights: [], signature: `screen:${sun.uuid}`, screenSun: { light: sun, direction: this.sunDirection } };
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
