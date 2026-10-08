import * as THREE from "three/webgpu";
import { cameraPosition, clamp, dot, floor, fog, float, fract, Fn, hash, If, Loop, max, mix, normalize, positionWorld, pow, screenCoordinate, screenUV, select, smoothstep, time, uniform, vec2, vec3, vec4 } from "three/tsl";
import { godrays } from "three/addons/tsl/display/GodraysNode.js";
import { bilateralBlur } from "three/addons/tsl/display/BilateralBlurNode.js";
import { depthAwareBlend } from "three/addons/tsl/display/depthAwareBlend.js";

/**
 * Fog and volumetric light shafts for `sky.fog` / `sky.volumetric`.
 *
 * Fog is not decoration in this engine's target art direction — the Frostvein
 * bible makes it mandatory in every interior, because it is what separates
 * layers of grey rock into foreground/midground/background. Height fog is the
 * mode that does that: it fills a cave floor and leaves the space above it
 * clear, so a hall reads as deep rather than as a large flat room.
 */

/** `sky.fog`, zod-defaulted. */
export interface FogSettings {
  color: string;
  mode: "linear" | "exponential" | "height";
  /** linear only */
  near: number;
  /** linear only */
  far: number;
  /** exponential + height */
  density: number;
  /** height only */
  heightFalloff: number;
  /** height only */
  baseHeight: number;
  /** exponential/height: glow toward the sun (0 = off — and then not in the shader at all). */
  sunScatter?: number;
  sunScatterPower?: number;
  /** exponential/height: drifting low-lying mist (amount 0 = off, and not in the shader). */
  mist?: { amount: number; top: number; thickness: number; scale: number; speed: [number, number] } | undefined;
}

/**
 * The colour of the sky at the horizon, as a shader uniform any material can
 * read — the fog colour whenever the scene has fog, white otherwise. Water
 * reads it: its fresnel rim is a reflection of the sky, and a fixed
 * near-white rim glowed at dusk while the hills around a distant lake had
 * gone dark into the fog, which is what left bright sheets of water hanging
 * in a night sky with no land under them.
 */
export const horizonTint = uniform(new THREE.Color(1, 1, 1));

/**
 * Clamp on the "camera is below the fog base" term. Physically the density
 * keeps growing without limit as you descend below `baseHeight`; numerically
 * that is an `exp()` that reaches infinity and paints the screen flat. e^4 is
 * ~55x the base density, well past visually opaque, and is where it stops.
 */
const HEIGHT_FOG_EXPONENT_CLAMP: [number, number] = [-20, 4];

/**
 * The altitude term of the height-fog integral, i.e. the factor by which the
 * straight-line distance camera->fragment is scaled to give the amount of
 * participating medium actually crossed.
 *
 * Derivation: density at altitude y is `density * exp(-k * (y - baseHeight))`.
 * Integrating that along the segment and dividing out `density * length`
 * leaves `exp(-k * (y0 - base)) * (1 - exp(-k * dy)) / (k * dy)`. The second
 * factor has a removable singularity at `k * dy == 0` where its limit is 1 —
 * which is also what makes `heightFalloff: 0` degenerate EXACTLY to plain
 * exponential fog, as the schema promises, with no separate code path.
 */
export function heightFogAttenuation(
  heightFalloff: number,
  baseHeight: number,
  cameraY: number,
  fragmentY: number,
): number {
  const dy = fragmentY - cameraY;
  const kdy = heightFalloff * dy;
  const ratio = Math.abs(kdy) < 1e-4 ? 1 : (1 - Math.exp(-kdy)) / kdy;
  const exponent = THREE.MathUtils.clamp(
    -heightFalloff * (cameraY - baseHeight),
    HEIGHT_FOG_EXPONENT_CLAMP[0],
    HEIGHT_FOG_EXPONENT_CLAMP[1],
  );
  return Math.exp(exponent) * ratio;
}

/**
 * CPU reference for the fog blend factor (0 = clear, 1 = fully fogged). The
 * shader below computes exactly this; this version exists so the maths can be
 * asserted without a GPU, and so "how dense is the fog 8 m above the floor"
 * has an answer that does not require taking a screenshot.
 *
 * `distance` is the camera-to-fragment distance for the exponential/height
 * modes and view-space depth for linear, matching three's `rangeFogFactor`.
 */
export function fogFactor(
  settings: FogSettings,
  distance: number,
  cameraY = 0,
  fragmentY = 0,
): number {
  if (settings.mode === "linear") {
    return THREE.MathUtils.smoothstep(distance, settings.near, settings.far);
  }
  const falloff = settings.mode === "height" ? settings.heightFalloff : 0;
  const base = settings.mode === "height" ? settings.baseHeight : 0;
  const attenuation = heightFogAttenuation(falloff, base, cameraY, fragmentY);
  const opticalDepth = Math.max(0, settings.density * distance * attenuation);
  return 1 - Math.exp(-opticalDepth);
}

interface FogNodeState {
  color: THREE.UniformNode<"color", THREE.Color>;
  density: THREE.UniformNode<"float", number>;
  heightFalloff: THREE.UniformNode<"float", number>;
  baseHeight: THREE.UniformNode<"float", number>;
  /** Which optional terms are compiled in — see FogFeatures. */
  features: string;
  node: THREE.Node<"vec4">;
}

/**
 * The optional fog terms. They are decided when the fog is APPLIED (scene
 * build), never per frame: the fog node is shared by every lit material, so
 * changing its graph recompiles the whole scene. A term that is off is absent
 * from the shader rather than multiplied by zero — a scene that never asked
 * for mist pays nothing for it.
 */
interface FogFeatures {
  scatter: boolean;
  mist: boolean;
}

function fogFeatures(settings: FogSettings): FogFeatures {
  return { scatter: (settings.sunScatter ?? 0) > 0, mist: (settings.mist?.amount ?? 0) > 0 };
}

/** Live fog uniforms the optional terms read (shared; only bound when compiled in). */
const fogSun = {
  direction: uniform(new THREE.Vector3(0.4, 0.55, 0.3).normalize()),
  /** The sun's colour already scaled by how bright it is (dim moon, dark night). */
  color: uniform(new THREE.Color(1, 0.9, 0.75)),
  scatter: uniform(0),
  power: uniform(6),
};
const fogMist = {
  amount: uniform(0),
  /** Zone mood multiplier on top of the authored amount. */
  scale: uniform(1),
  top: uniform(12),
  thickness: uniform(10),
  frequency: uniform(0.02),
  speed: uniform(new THREE.Vector2(0.6, 0.25)),
};

/**
 * Owns a scene's fog and retunes it in place.
 *
 * The three modes deliberately do NOT share a shader path with each other:
 *
 * - `linear` is left as a plain `THREE.Fog`, which is byte-for-byte the code
 *   that shipped before this module existed. Existing scenes must not shift a
 *   pixel because a `mode` field with a `linear` default appeared.
 * - `exponential` and `height` share ONE node, with `exponential` running it
 *   at `heightFalloff = 0`. That is not a shortcut — it is the reason the two
 *   modes are guaranteed consistent at the boundary, and it means switching
 *   between them (or dragging `heightFalloff` from 0) is a uniform write with
 *   no shader rebuild.
 */
export class FogSystem {
  private state: FogNodeState | null = null;
  private linear: THREE.Fog | null = null;

  apply(scene: THREE.Scene, settings: FogSettings | null): void {
    horizonTint.value.set(settings ? settings.color : "#ffffff");
    if (!settings) {
      scene.fog = null;
      scene.fogNode = null;
      return;
    }
    if (settings.mode === "linear") {
      scene.fogNode = null;
      if (this.linear) {
        this.linear.color.set(settings.color);
        this.linear.near = settings.near;
        this.linear.far = settings.far;
      } else {
        this.linear = new THREE.Fog(new THREE.Color(settings.color), settings.near, settings.far);
      }
      scene.fog = this.linear;
      return;
    }

    const falloff = settings.mode === "height" ? settings.heightFalloff : 0;
    const base = settings.mode === "height" ? settings.baseHeight : 0;
    const features = fogFeatures(settings);
    const key = `${features.scatter ? "s" : ""}${features.mist ? "m" : ""}`;
    if (this.state && this.state.features !== key) this.state = null;
    const state = this.state ?? (this.state = buildHeightFogNode(features, key));
    fogSun.scatter.value = settings.sunScatter ?? 0;
    fogSun.power.value = settings.sunScatterPower ?? 6;
    const mist = settings.mist;
    fogMist.amount.value = mist?.amount ?? 0;
    if (mist) {
      fogMist.top.value = mist.top;
      fogMist.thickness.value = Math.max(0.1, mist.thickness);
      fogMist.frequency.value = mist.scale;
      fogMist.speed.value.set(mist.speed[0], mist.speed[1]);
    }
    state.color.value.set(settings.color);
    state.density.value = settings.density;
    state.heightFalloff.value = falloff;
    state.baseHeight.value = base;
    // `scene.fogNode` wins over `scene.fog` in three's node pipeline. The
    // FogExp2 alongside it is a descriptor, not a second renderer: consumers
    // that only want the atmosphere colour (far-plane tint, HLOD fade) read
    // `scene.fog.color` without knowing about nodes, and it degrades sanely if
    // `fogNode` is ever cleared.
    scene.fog = new THREE.FogExp2(new THREE.Color(settings.color), settings.density);
    scene.fogNode = state.node;
  }

  /**
   * Change what the CURRENT fog looks like without re-deciding what kind it
   * is: colour and density/near/far land on the live uniforms and fog object.
   * The per-frame half of `apply` for a day/night script.
   */
  retune(scene: THREE.Scene, live: { color?: string; density?: number; near?: number; far?: number }): void {
    if (live.color !== undefined) horizonTint.value.set(live.color);
    const fog = scene.fog;
    if (this.linear && fog === this.linear) {
      if (live.color !== undefined) this.linear.color.set(live.color);
      if (live.near !== undefined) this.linear.near = live.near;
      if (live.far !== undefined) this.linear.far = live.far;
      return;
    }
    if (this.state) {
      if (live.color !== undefined) this.state.color.value.set(live.color);
      if (live.density !== undefined) this.state.density.value = Math.max(0, live.density);
    }
    const exp2 = fog as THREE.FogExp2 | null;
    if (exp2 && (exp2 as THREE.FogExp2).isFogExp2) {
      if (live.color !== undefined) exp2.color.set(live.color);
      if (live.density !== undefined) exp2.density = Math.max(0, live.density);
    }
  }

  /**
   * Where the sun is and how bright, for the fog's sun-side glow — a uniform
   * write, every frame if need be. `direction` points TOWARD the sun.
   */
  setSun(direction: THREE.Vector3, color: THREE.Color, intensity: number): void {
    fogSun.direction.value.copy(direction).normalize();
    // fades with the light itself: a dim moon glows faintly, a dead sky not at all
    // 0.6: the haze is LIT by the sun, never as bright as the sun itself
    fogSun.color.value.copy(color).multiplyScalar(0.6 * Math.min(1, Math.max(0, intensity) / 1.5));
  }

  /** Zone-mood multiplier on the authored mist amount (1 = as authored). */
  setMistScale(scale: number): void {
    fogMist.scale.value = Math.max(0, scale);
  }

  dispose(scene?: THREE.Scene): void {
    if (scene) {
      scene.fogNode = null;
      scene.fog = null;
    }
    this.state = null;
    this.linear = null;
  }
}

/** 2D value noise from four hashes — far cheaper than Perlin, and mist is low-frequency anyway. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function valueNoise2(p: any): any {
  const i: any = floor(p);
  const f: any = fract(p);
  const u: any = f.mul(f).mul(f.mul(-2).add(3));
  // +65536: TSL hash() converts its seed to an UNSIGNED int, so every negative seed
  // (any world cell west or north of the origin) would hash to the same value
  const h = (o: [number, number]): any => hash(dot(i.add(vec2(o[0], o[1])), vec2(127.1, 311.7)).add(65536));
  return mix(mix(h([0, 0]), h([1, 0]), u.x), mix(h([0, 1]), h([1, 1]), u.x), u.y);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function buildHeightFogNode(features: FogFeatures = { scatter: false, mist: false }, key = ""): FogNodeState {
  const color = uniform(new THREE.Color(0x101522));
  const density = uniform(0.015);
  const heightFalloff = uniform(0);
  const baseHeight = uniform(0);

  const dy = positionWorld.y.sub(cameraPosition.y);
  const kdy = heightFalloff.mul(dy);
  const ratio = kdy
    .abs()
    .lessThan(float(1e-4))
    .select(float(1), kdy.negate().exp().oneMinus().div(kdy));
  const altitude = heightFalloff
    .mul(cameraPosition.y.sub(baseHeight))
    .negate()
    .clamp(HEIGHT_FOG_EXPONENT_CLAMP[0], HEIGHT_FOG_EXPONENT_CLAMP[1])
    .exp();
  const distance = positionWorld.distance(cameraPosition);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let opticalDepth: any = density.mul(distance).mul(altitude).mul(ratio).max(0);
  if (features.mist) {
    // Banks of mist: one value-noise octave drifting over the ground, shaped
    // into patches, confined below `top`. Integrated cheaply as "how much of
    // this sight line is mist" from the fragment's own height — exact enough
    // for a layer, and a handful of ALU ops.
    const p: any = positionWorld.xz.add(fogMist.speed.mul(time)).mul(fogMist.frequency);
    const patch: any = smoothstep(0.3, 0.75, valueNoise2(p));
    const below: any = clamp(fogMist.top.sub(positionWorld.y).div(fogMist.thickness), 0, 1);
    opticalDepth = opticalDepth.add(fogMist.amount.mul(fogMist.scale).mul(patch.mul(0.75).add(0.25)).mul(below).mul(distance.min(400)).mul(0.02));
  }
  const factor = opticalDepth.negate().exp().oneMinus();
  let fogColor: any = color;
  if (features.scatter) {
    // Looking into the sun the haze is lit by it; looking away it keeps the
    // cold fog colour. Sun colour pre-scaled by the light's brightness.
    const view: any = normalize(positionWorld.sub(cameraPosition));
    const toward: any = pow(max(dot(view, fogSun.direction), 0), fogSun.power);
    fogColor = mix(color, fogSun.color, clamp(toward.mul(fogSun.scatter), 0, 1));
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    color,
    density,
    heightFalloff,
    baseHeight,
    features: key,
    node: fog(fogColor, factor) as THREE.Node<"vec4">,
  };
}

// ---------------------------------------------------------------------------
// Volumetrics
// ---------------------------------------------------------------------------

/** `sky.volumetric`, zod-defaulted. */
export interface VolumetricSettings {
  enabled: boolean;
  intensity: number;
  samples: number;
  decay: number;
  density: number;
}

export const DEFAULT_VOLUMETRIC_SETTINGS: VolumetricSettings = {
  enabled: false,
  intensity: 1,
  samples: 32,
  decay: 0.95,
  density: 0.5,
};

/**
 * Fraction of the render target the raymarch runs at. Same reasoning as the
 * bloom chain's 0.35 in renderer.ts: this is a fixed per-frame fullscreen cost
 * whose only real lever is pixel count, and volumetrics are low-frequency by
 * nature, so almost nothing of the effect survives at full resolution that
 * does not survive at a third of it. 0.35 is 12% of the pixels.
 */
export const VOLUMETRIC_RESOLUTION_SCALE = 0.35;

/**
 * `decay` -> `GodraysNode.distanceAttenuation`. The schema's decay is
 * per-sample attenuation where LOW means short stubby shafts; three's
 * attenuation is the inverse sense. The scale is chosen so the schema default
 * (0.95) lands exactly on three's default (2), i.e. "unset" behaves as three
 * intends.
 */
export function decayToDistanceAttenuation(decay: number): number {
  return THREE.MathUtils.clamp((1 - decay) * 40, 0, 40);
}

/**
 * `density` -> `GodraysNode.density`, again scaled so the schema default (0.5)
 * lands on three's default (0.7).
 */
export function densityToGodrayDensity(density: number): number {
  return Math.max(0, density) * 1.4;
}

/**
 * Lights that can actually produce a shaft this frame, strongest first.
 *
 * The filter is not conservatism, it is the set of hard requirements:
 * - three's `GodraysNode` supports directional and point lights ONLY. A
 *   SpotLight throws at shader-build time, which in this renderer's pipeline
 *   is caught once and permanently disables the whole post chain — so a spot
 *   must never reach it. Model a forge-mouth shaft as a point light.
 * - the raymarch samples the light's shadow map to decide what is lit, so the
 *   light needs `castShadow` AND an already-allocated `shadow.map`. The map
 *   does not exist until the first shadow render, which is why this is a
 *   per-frame query and not a build-time one (see `volumetricSignature`).
 * - a cascaded directional light has NO `shadow.map` of its own at all — the
 *   cascades own separate maps behind `shadow.shadowNode`. Cascades and sun
 *   shafts are therefore mutually exclusive today; the shaft light wants one
 *   tight frustum anyway, since the raymarch is clipped to it.
 */
export function volumetricLightCandidates(lights: Iterable<THREE.Light>, maxLights = 1): THREE.Light[] {
  const eligible: Array<{ light: THREE.Light; rank: number }> = [];
  for (const light of lights) {
    const isDirectional = (light as THREE.DirectionalLight).isDirectionalLight === true;
    const isPoint = (light as THREE.PointLight).isPointLight === true;
    if (!isDirectional && !isPoint) continue;
    if (!light.visible || !light.castShadow) continue;
    // THREE.Light declares no `shadow`; the directional/point narrowing above
    // already established this one has it.
    const shadow = (light as THREE.Light & { shadow?: THREE.LightShadow & { shadowNode?: unknown; map?: unknown } }).shadow;
    if (!shadow?.map) continue;
    if (shadow.shadowNode) continue;
    const importance = Number(light.userData["lightImportance"]) || 1;
    eligible.push({ light, rank: importance * Math.max(1e-3, light.intensity) });
  }
  eligible.sort((a, b) => b.rank - a.rank);
  return eligible.slice(0, Math.max(0, maxLights)).map((entry) => entry.light);
}

/**
 * Identity of the shaft set baked into a pipeline. The host compares this
 * against the current frame's candidates and rebuilds the post pipeline only
 * when it changes — the node graph holds direct references to specific lights,
 * so a changed set cannot be patched in place, while `intensity`/`samples`/
 * `decay`/`density` all can (`setSettings`).
 */
export function volumetricSignature(lights: THREE.Light[]): string {
  return lights.map((light) => light.uuid).join(",");
}

/**
 * The shaft set a scene wants this frame, handed from `SceneLighting` to the
 * post chain. `lights` is already filtered by `volumetricLightCandidates`;
 * `signature` is `volumetricSignature(lights)`.
 */
export interface VolumetricRequest {
  settings: VolumetricSettings;
  lights: THREE.Light[];
  signature: string;
  /**
   * Set when no light can raymarch (`lights` empty — e.g. a CASCADED sun has
   * no single shadow map): the chain draws cheap screen-space shafts from this
   * sun instead. `direction` points toward it and is updated in place.
   */
  screenSun?: { light: THREE.DirectionalLight; direction: THREE.Vector3 } | undefined;
}

/**
 * Everything about a request that changes the SHAPE of the post graph, as one
 * comparable string. Everything absent from it (`intensity` above zero,
 * `samples`, `decay`, `density`) is a uniform write instead — the difference
 * between retuning a slider and recompiling every shader in the chain.
 */
export function volumetricPlanKey(request: VolumetricRequest | null): string {
  if (!request || !request.settings.enabled || (request.lights.length === 0 && !request.screenSun)) return "off";
  if (!(request.settings.intensity > 0)) return "off";
  return `on:${request.signature}`;
}

export interface VolumetricInputs {
  /** The scene pass's colour texture node — `scenePass.getTextureNode("output")`. */
  colorNode: THREE.Node<"vec4">;
  /** The scene pass's depth texture node — `scenePass.getTextureNode("depth")`. */
  depthNode: THREE.Node<"vec4">;
  /** The camera the scene pass renders with. */
  camera: THREE.Camera;
  /** Already filtered by `volumetricLightCandidates`. */
  lights: THREE.Light[];
  settings: VolumetricSettings;
  resolutionScale?: number | undefined;
  /**
   * Bilateral pre-blur of the raymarch result. It runs at the raymarch's own
   * (reduced) resolution because `BilateralBlurNode` sizes itself from its
   * input texture, so it is cheap; it buys back most of what the dither costs
   * in noise. Off is defensible if `postfx.grain` is already hiding it.
   */
  blur?: boolean | undefined;
}

interface ShaftEntry {
  rays: ReturnType<typeof godrays>;
  blur: ReturnType<typeof bilateralBlur> | null;
  tint: THREE.UniformNode<"color", THREE.Color>;
  intensity: THREE.UniformNode<"float", number>;
}

/**
 * A composited set of volumetric light shafts, ready to be dropped into the
 * post pipeline's `outputNode`.
 *
 * The composite is deliberately layered so the FIRST (strongest) shaft gets
 * three's `depthAwareBlend` — the depth-aware upsample that stops a low-res
 * shaft from bleeding around a foreground silhouette — and any additional
 * shafts are added on top. `depthAwareBlend` needs a sampleable texture as its
 * base, which the first blend's result is not, so it cannot be chained; the
 * asymmetry is that limitation, not a preference. With the default
 * `maxLights` of 1 it never comes up.
 */
export class VolumetricShafts {
  private constructor(
    readonly outputNode: THREE.Node<"vec4">,
    readonly lights: THREE.Light[],
    private readonly entries: ShaftEntry[],
  ) {}

  /** Returns null when volumetrics are off or no light qualifies. */
  static create(inputs: VolumetricInputs): VolumetricShafts | null {
    const { settings, lights } = inputs;
    if (!settings.enabled || lights.length === 0) return null;

    const scale = inputs.resolutionScale ?? VOLUMETRIC_RESOLUTION_SCALE;
    const useBlur = inputs.blur !== false;
    const entries: ShaftEntry[] = [];
    let output: THREE.Node<"vec4"> = inputs.colorNode;

    for (let i = 0; i < lights.length; i++) {
      const light = lights[i]!;
      const rays = godrays(
        inputs.depthNode as unknown as THREE.TextureNode,
        inputs.camera,
        light as THREE.DirectionalLight,
      );
      rays.resolutionScale = scale;
      const blur = useBlur ? bilateralBlur(rays.getTextureNode()) : null;
      const source = (blur ? blur.getTextureNode() : rays.getTextureNode()) as THREE.TextureNode;

      // Tint from the light's own colour: an ember brazier's shaft has to be
      // ember, not white, or the three-value read collapses.
      const tint = uniform(new THREE.Color().copy(light.color));
      const intensity = uniform(settings.intensity);
      const blendColor = tint.mul(intensity);

      if (i === 0) {
        output = depthAwareBlend(output, source, inputs.depthNode, inputs.camera, {
          blendColor,
        }) as THREE.Node<"vec4">;
      } else {
        output = output.add(source.r.mul(blendColor)) as THREE.Node<"vec4">;
      }
      entries.push({ rays, blur, tint, intensity });
    }

    const shafts = new VolumetricShafts(output, [...lights], entries);
    shafts.setSettings(settings);
    return shafts;
  }

  /**
   * Live retune with no pipeline rebuild — every knob here is a uniform.
   * Changing WHICH lights cast shafts is the one thing that is not: that needs
   * a rebuild, which `volumetricSignature` tells the host about.
   */
  setSettings(settings: VolumetricSettings): void {
    const density = densityToGodrayDensity(settings.density);
    const attenuation = decayToDistanceAttenuation(settings.decay);
    for (const entry of this.entries) {
      entry.rays.raymarchSteps.value = Math.max(8, Math.min(128, Math.round(settings.samples)));
      entry.rays.density.value = density;
      entry.rays.distanceAttenuation.value = attenuation;
      entry.intensity.value = settings.intensity;
    }
  }

  /** Re-read each shaft's tint from its light (a script recoloured a brazier). */
  refreshTints(): void {
    for (let i = 0; i < this.entries.length; i++) {
      const light = this.lights[i];
      const entry = this.entries[i];
      if (light && entry) entry.tint.value.copy(light.color);
    }
  }

  dispose(): void {
    for (const entry of this.entries) {
      entry.blur?.dispose();
      entry.rays.dispose();
    }
    this.entries.length = 0;
  }
}

/**
 * Raymarch cost in shadow-map samples per frame — the number that decides
 * whether volumetrics fit the budget, since the inner loop is one shadow
 * compare plus a handful of ALU. Multiply by the light count.
 */
export function volumetricSampleCost(
  width: number,
  height: number,
  samples: number,
  resolutionScale = VOLUMETRIC_RESOLUTION_SCALE,
): number {
  const w = Math.round(width * resolutionScale);
  const h = Math.round(height * resolutionScale);
  return w * h * samples;
}

// ---------------------------------------------------------------------------
// Screen-space sun shafts
// ---------------------------------------------------------------------------

/** Taps along each pixel's line to the sun. Fixed at compile time; jittered per pixel so 16 reads as smooth. */
export const SCREEN_SHAFT_SAMPLES = 16;

/**
 * Crepuscular rays the cheap way (GPU Gems 3, ch. 13): each pixel walks
 * SCREEN_SHAFT_SAMPLES steps toward the sun's position on screen, summing how
 * much bright open SKY it crosses — clouds and terrain block it, gaps in the
 * cloud deck let it through. No shadow map, so it works with a cascaded sun.
 *
 * Cost control: the whole walk sits behind a uniform branch that is false
 * whenever the sun is off screen, behind the camera or below the horizon, so
 * looking away from the sun costs one comparison per pixel.
 */
export class ScreenShafts {
  readonly outputNode: THREE.Node<"vec4">;
  private readonly sunUv = uniform(new THREE.Vector2(0.5, 0.5));
  private readonly strength = uniform(0);
  private readonly tint = uniform(new THREE.Color(1, 1, 1));
  private readonly density = uniform(0.7);
  private readonly decay = uniform(0.95);
  private readonly ndc = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  constructor(
    colorNode: any,
    depthNode: any,
    private readonly camera: THREE.Camera,
    private readonly sun: { light: THREE.DirectionalLight; direction: THREE.Vector3 },
    private settings: VolumetricSettings,
  ) {
    const sunUv = this.sunUv;
    const strength = this.strength;
    const density = this.density;
    const decay = this.decay;
    const tint = this.tint;
    const n = SCREEN_SHAFT_SAMPLES;
    const shafts = Fn(() => {
      const uv: any = screenUV;
      const sum: any = float(0).toVar();
      If(strength.greaterThan(0.001), () => {
        const step: any = uv.sub(sunUv).mul(density.div(n));
        // per-pixel jitter (interleaved gradient noise) hides the 16-tap banding
        const jitter: any = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))));
        const pos: any = uv.sub(step.mul(jitter)).toVar();
        const weight: any = float(1).toVar();
        Loop(n, () => {
          pos.subAssign(step);
          const sky: any = depthNode.sample(pos).r.greaterThanEqual(0.9999);
          const lum: any = dot(colorNode.sample(pos).rgb, vec3(0.299, 0.587, 0.114));
          // linear HDR: the slate sky is ~0.03, lit cloud ~0.2, the sun disc >1 — weight by brightness, capped
          sum.addAssign(select(sky, lum.min(2), float(0)).mul(weight));
          weight.mulAssign(decay);
        });
      });
      return sum.mul(strength.mul(2).div(n));
    })();
    this.outputNode = vec4(colorNode.rgb.add(tint.mul(shafts)), colorNode.a) as THREE.Node<"vec4">;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  setSettings(settings: VolumetricSettings): void {
    this.settings = settings;
  }

  /** Per frame: project the sun, fade with how directly we face it and how high it is. */
  update(): void {
    const s = this.settings;
    const dir = this.sun.direction;
    this.camera.getWorldDirection(this.forward);
    const facing = this.forward.dot(dir);
    const light = this.sun.light;
    const lit = light.visible ? Math.min(1, light.intensity / 1.5) : 0;
    // above the horizon only (the same light plays the moon at night — let it, dimly)
    const elevation = THREE.MathUtils.smoothstep(dir.y, -0.02, 0.08);
    // a point far along the sun direction, projected (no allocation per frame)
    this.camera.getWorldPosition(this.eye);
    this.ndc.copy(dir).multiplyScalar(1000).add(this.eye).project(this.camera);
    // fade as the sun leaves the frame (a little past the edge still streams in)
    const edge = Math.max(Math.abs(this.ndc.x), Math.abs(this.ndc.y));
    const onScreen = facing > 0 ? 1 - THREE.MathUtils.smoothstep(edge, 1.0, 1.6) : 0;
    this.sunUv.value.set(this.ndc.x * 0.5 + 0.5, 0.5 - this.ndc.y * 0.5);
    this.strength.value = s.intensity * onScreen * elevation * lit;
    this.density.value = Math.min(1, Math.max(0.05, s.density * 1.4));
    this.decay.value = Math.min(0.999, Math.max(0.5, s.decay));
    this.tint.value.copy(light.color);
  }
}
