import * as THREE from "three/webgpu";
import { cameraPosition, fog, float, positionWorld, uniform } from "three/tsl";
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
}

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
  node: THREE.Node<"vec4">;
}

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
    const state = this.state ?? (this.state = buildHeightFogNode());
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

  dispose(scene?: THREE.Scene): void {
    if (scene) {
      scene.fogNode = null;
      scene.fog = null;
    }
    this.state = null;
    this.linear = null;
  }
}

function buildHeightFogNode(): FogNodeState {
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
  const opticalDepth = density.mul(positionWorld.distance(cameraPosition)).mul(altitude).mul(ratio).max(0);
  const factor = opticalDepth.negate().exp().oneMinus();

  return {
    color,
    density,
    heightFalloff,
    baseHeight,
    node: fog(color, factor) as THREE.Node<"vec4">,
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
}

/**
 * Everything about a request that changes the SHAPE of the post graph, as one
 * comparable string. Everything absent from it (`intensity` above zero,
 * `samples`, `decay`, `density`) is a uniform write instead — the difference
 * between retuning a slider and recompiling every shader in the chain.
 */
export function volumetricPlanKey(request: VolumetricRequest | null): string {
  if (!request || !request.settings.enabled || request.lights.length === 0) return "off";
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
