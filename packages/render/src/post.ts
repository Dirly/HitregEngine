import * as THREE from "three/webgpu";
import {
  Fn,
  convertToTexture,
  cos,
  dot,
  emissive,
  exp,
  float,
  mix,
  min as tslMin,
  mrt,
  normalView,
  output,
  pass,
  rand,
  renderOutput,
  saturate,
  screenCoordinate,
  screenSize,
  screenUV,
  sin,
  smoothstep,
  texture3D,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
  velocity,
} from "three/tsl";
import { mx_fractal_noise_float } from "three/tsl";
import { posterize } from "./vfx/shaders.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ao as gtao } from "three/addons/tsl/display/GTAONode.js";
import { denoise as bilateralDenoise } from "three/addons/tsl/display/DenoiseNode.js";
import { dof as depthOfField } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { fxaa as fxaaNode } from "three/addons/tsl/display/FXAANode.js";
import { smaa as smaaNode } from "three/addons/tsl/display/SMAANode.js";
import { motionBlur as motionBlurFn } from "three/addons/tsl/display/MotionBlur.js";
import { sharpen as sharpenNode } from "three/addons/tsl/display/SharpenNode.js";
import { chromaticAberration as caNode } from "three/addons/tsl/display/ChromaticAberrationNode.js";
import { lut3D as lut3DNode } from "three/addons/tsl/display/Lut3DNode.js";
import { lut3DTextureFrom } from "./post-lut.js";
import { VolumetricShafts, type VolumetricRequest, type VolumetricSettings } from "./atmosphere.js";

/* -------------------------------------------------------------------------- */
/* Data shape (mirrors core's `postfx` component schema)                       */
/* -------------------------------------------------------------------------- */

export type TonemapMode = "aces" | "agx" | "neutral" | "reinhard" | "linear";
export type AntialiasMode = "none" | "fxaa" | "smaa" | "taa";

export interface BloomFx {
  enabled: boolean;
  strength: number;
  radius: number;
  threshold: number;
}
export interface TonemapFx {
  enabled: boolean;
  mode: TonemapMode;
  exposure: number;
}
export interface AoFx {
  enabled: boolean;
  intensity: number;
  radius: number;
  distanceFalloff: number;
  samples: number;
  denoise: boolean;
}
export interface GradeFx {
  enabled: boolean;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  lift: string;
  gamma: string;
  gain: string;
  lut?: string;
}
export interface VignetteFx {
  enabled: boolean;
  amount: number;
  radius: number;
  smoothness: number;
}
export interface GrainFx {
  enabled: boolean;
  amount: number;
  size: number;
}
export interface ChromaticAberrationFx {
  enabled: boolean;
  amount: number;
}
export interface DofFx {
  enabled: boolean;
  /** World units to the sharp plane. */
  focusDistance: number;
  /** Lens focal length in millimetres. */
  focalLength: number;
  bokehScale: number;
  maxBlur: number;
}
export interface AntialiasFx {
  mode: AntialiasMode;
}
export interface MotionBlurFx {
  enabled: boolean;
  amount: number;
  samples: number;
}
export interface SharpenFx {
  enabled: boolean;
  amount: number;
}

export type PixelateFilter = "nearest" | "linear";

/**
 * What the world looks like from INSIDE water. Driven per frame by how deep
 * the camera is (`EngineRenderer.setSubmersion`), not by the scene document —
 * the document only says what the water is like.
 */
/**
 * The live LENS surface a script drives (ctx.setPostFx), mirrored in
 * @hitreg/scripting the way LiveSkyOptions is — scripting takes no render
 * dependency. The host resolves it against the camera that draws the frame
 * (see EngineRenderer.setSandstorm).
 */
export interface LivePostFxOptions {
  sandstorm?: {
    /** 0 = clear air, 1 = the worst this storm does. */
    amount: number;
    /** World direction the wind blows TOWARD; turned into a screen angle per frame. */
    wind?: [number, number, number];
    /** The grain's colour when it differs from the authored one. */
    color?: string;
  };
}

/** Blowing grit across the lens. See the schema for what each knob decides. */
export interface SandstormFx {
  enabled: boolean;
  color: string;
  opacity: number;
  haze: number;
  scale: number;
  speed: number;
  streak: number;
  swirl: number;
  threshold: number;
  steps: number;
}

export interface UnderwaterFx {
  enabled: boolean;
  color: string;
  density: number;
  tint: number;
  saturation: number;
  wobble: number;
  wobbleSpeed: number;
  wobbleScale: number;
  edge: number;
  fade: number;
}

/**
 * Low internal resolution, scaled up to the screen — the fake-PSX look. Not a
 * pass: the renderer shrinks its backing store (`EngineRenderer.setSize`) and
 * the canvas upscales, with `image-rendering: pixelated` for hard pixels.
 */
export interface PixelateFx {
  enabled: boolean;
  /** Vertical resolution in pixels; width follows the viewport aspect. */
  height: number;
  filter: PixelateFilter;
}

/** The `postfx` component payload, as it arrives from a scene doc. */
export interface PostFxData {
  bloom?: Partial<BloomFx>;
  tonemap?: Partial<TonemapFx>;
  ao?: Partial<AoFx>;
  grade?: Partial<GradeFx>;
  vignette?: Partial<VignetteFx>;
  grain?: Partial<GrainFx>;
  chromaticAberration?: Partial<ChromaticAberrationFx>;
  dof?: Partial<DofFx>;
  antialias?: Partial<AntialiasFx>;
  motionBlur?: Partial<MotionBlurFx>;
  sharpen?: Partial<SharpenFx>;
  pixelate?: Partial<PixelateFx>;
  underwater?: Partial<UnderwaterFx>;
  sandstorm?: Partial<SandstormFx>;
}

export interface ResolvedPostFx {
  bloom: BloomFx;
  tonemap: TonemapFx;
  ao: AoFx;
  grade: GradeFx;
  vignette: VignetteFx;
  grain: GrainFx;
  chromaticAberration: ChromaticAberrationFx;
  dof: DofFx;
  antialias: AntialiasFx;
  motionBlur: MotionBlurFx;
  sharpen: SharpenFx;
  pixelate: PixelateFx;
  underwater: UnderwaterFx;
  sandstorm: SandstormFx;
}

const TONEMAP_MODES: readonly TonemapMode[] = ["aces", "agx", "neutral", "reinhard", "linear"];
const ANTIALIAS_MODES: readonly AntialiasMode[] = ["none", "fxaa", "smaa", "taa"];

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function hex(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}
function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Fill in schema defaults. Mirrors `postfxSchema` in `@hitreg/core`; kept as a
 * plain function rather than importing Zod so the renderer stays usable with a
 * bare JSON blob (and so `setPostFx(null)` has a defined meaning).
 *
 * `tonemap` is the one block that defaults ON — `{}` resolves to ACES at
 * exposure 1, which is exactly what the renderer did unconditionally before
 * this stack existed.
 */
export function resolvePostFx(data: PostFxData | null | undefined): ResolvedPostFx {
  const d = data ?? {};
  const grade = d.grade ?? {};
  return {
    bloom: {
      enabled: bool(d.bloom?.enabled, false),
      strength: num(d.bloom?.strength, 0.5),
      radius: num(d.bloom?.radius, 0.4),
      threshold: num(d.bloom?.threshold, 0.85),
    },
    tonemap: {
      enabled: bool(d.tonemap?.enabled, true),
      mode: pick(d.tonemap?.mode, TONEMAP_MODES, "aces"),
      exposure: num(d.tonemap?.exposure, 1),
    },
    ao: {
      enabled: bool(d.ao?.enabled, false),
      intensity: num(d.ao?.intensity, 1),
      radius: num(d.ao?.radius, 0.5),
      distanceFalloff: num(d.ao?.distanceFalloff, 1),
      samples: Math.round(num(d.ao?.samples, 16)),
      denoise: bool(d.ao?.denoise, true),
    },
    grade: {
      enabled: bool(grade.enabled, false),
      contrast: num(grade.contrast, 1),
      saturation: num(grade.saturation, 1),
      temperature: num(grade.temperature, 0),
      tint: num(grade.tint, 0),
      lift: hex(grade.lift, "#808080"),
      gamma: hex(grade.gamma, "#808080"),
      gain: hex(grade.gain, "#808080"),
      lut: typeof grade.lut === "string" && grade.lut.length > 0 ? grade.lut : undefined,
    },
    vignette: {
      enabled: bool(d.vignette?.enabled, false),
      amount: num(d.vignette?.amount, 0.5),
      radius: num(d.vignette?.radius, 0.75),
      smoothness: num(d.vignette?.smoothness, 0.4),
    },
    grain: {
      enabled: bool(d.grain?.enabled, false),
      amount: num(d.grain?.amount, 0.06),
      size: num(d.grain?.size, 1),
    },
    chromaticAberration: {
      enabled: bool(d.chromaticAberration?.enabled, false),
      amount: num(d.chromaticAberration?.amount, 0.005),
    },
    dof: {
      enabled: bool(d.dof?.enabled, false),
      focusDistance: num(d.dof?.focusDistance, 10),
      focalLength: num(d.dof?.focalLength, 35),
      bokehScale: num(d.dof?.bokehScale, 2),
      maxBlur: num(d.dof?.maxBlur, 0.5),
    },
    antialias: { mode: pick(d.antialias?.mode, ANTIALIAS_MODES, "fxaa") },
    motionBlur: {
      enabled: bool(d.motionBlur?.enabled, false),
      amount: num(d.motionBlur?.amount, 0.3),
      samples: Math.round(num(d.motionBlur?.samples, 12)),
    },
    sharpen: {
      enabled: bool(d.sharpen?.enabled, false),
      amount: num(d.sharpen?.amount, 0.4),
    },
    pixelate: {
      enabled: bool(d.pixelate?.enabled, false),
      height: Math.round(num(d.pixelate?.height, 240)),
      filter: d.pixelate?.filter === "linear" ? "linear" : "nearest",
    },
    sandstorm: {
      enabled: bool(d.sandstorm?.enabled, true),
      color: hex(d.sandstorm?.color, "#c7a06a"),
      opacity: num(d.sandstorm?.opacity, 0.5),
      haze: num(d.sandstorm?.haze, 0.22),
      scale: num(d.sandstorm?.scale, 20),
      speed: num(d.sandstorm?.speed, 1.6),
      streak: num(d.sandstorm?.streak, 9),
      swirl: num(d.sandstorm?.swirl, 0.5),
      threshold: num(d.sandstorm?.threshold, 0.26),
      steps: num(d.sandstorm?.steps, 0),
    },
    underwater: {
      // the one other block that defaults ON: it costs nothing in a scene with
      // no water, because the plan only builds it where water exists
      enabled: bool(d.underwater?.enabled, true),
      color: hex(d.underwater?.color, "#16506b"),
      density: num(d.underwater?.density, 0.055),
      tint: num(d.underwater?.tint, 0.22),
      saturation: num(d.underwater?.saturation, 0.75),
      wobble: num(d.underwater?.wobble, 0.004),
      wobbleSpeed: num(d.underwater?.wobbleSpeed, 1.1),
      wobbleScale: num(d.underwater?.wobbleScale, 9),
      edge: num(d.underwater?.edge, 0.35),
      fade: num(d.underwater?.fade, 0.18),
    },
  };
}

/**
 * The pixel ratio the renderer should actually use for a viewport `cssHeight`
 * CSS pixels tall when the host asked for `requested` (its DPR cap).
 *
 * Pixelate never UPSCALES the backing store past what the host asked for —
 * a 240-line target on a 200px-tall viewport still renders at 200 lines —
 * and it floors at a handful of lines so a degenerate viewport can't produce
 * a zero-sized canvas.
 */
export function pixelateRatio(fx: ResolvedPostFx, cssHeight: number, requested: number): number {
  if (!fx.pixelate.enabled || !(cssHeight > 0)) return requested;
  const lines = Math.max(8, fx.pixelate.height);
  return Math.min(requested, lines / cssHeight);
}

/* -------------------------------------------------------------------------- */
/* Pass plan                                                                   */
/* -------------------------------------------------------------------------- */

export type PostPassId =
  | "volumetrics"
  | "ao"
  | "bloom"
  | "dof"
  | "motionBlur"
  | "underwater"
  | "sandstorm"
  | "tonemap"
  | "grade"
  | "lut"
  | "chromaticAberration"
  | "vignette"
  | "grain"
  | "sharpen"
  | "fxaa"
  | "smaa";

/**
 * The one authoritative order. Everything before `tonemap` runs on linear HDR
 * scene-referred values; everything after runs on display-referred sRGB (which
 * is what FXAA/SMAA need, and what a LUT baked from a graded still expects).
 *
 * `taa` has no entry: see `TAA_FALLBACK_REASON`.
 */
export const POST_PASS_ORDER: readonly PostPassId[] = [
  // Volumetrics run FIRST, on the scene pass's own colour texture, because
  // three's `depthAwareBlend` — the depth-aware upsample that keeps a
  // reduced-resolution raymarch from haloing around foreground silhouettes —
  // samples its base node (`textureSize`, `.sample(uv)`) and so only accepts a
  // real texture, which none of the later nodes in this chain is. The cost of
  // that ordering is that AO then dims the shafts slightly; GTAO returns ~1 in
  // the open air where shafts actually live, so it is not a visible trade.
  "volumetrics",
  "ao",
  // Absorption belongs on the LIT scene, before the tone curve: it is what the
  // water did to the light on its way to the lens, not something the lens did.
  // Bloom then blooms what is left of a submerged lantern, which is right, and
  // AO reads the depth/normal attachments directly so the sway never reaches it.
  "underwater",
  // Grit is IN the air, between the scene and the lens, so it goes on after
  // absorption and before bloom — a sheet of lit sand crossing a bright sky
  // blooms, which is most of what makes it read as glare rather than as a
  // texture stuck to the screen.
  "sandstorm",
  "bloom",
  "dof",
  "motionBlur",
  "tonemap",
  "grade",
  "lut",
  "chromaticAberration",
  "vignette",
  "grain",
  "sharpen",
  "fxaa",
  "smaa",
];

/**
 * Blame order for reactive per-pass degradation. A node graph only fails at
 * shader-build time, inside `pipeline.render()`, and the exception says nothing
 * about which pass caused it — so on failure we retire the most
 * backend-sensitive pass still in the plan and rebuild. Most-suspect first:
 * anything that needs an extra MRT attachment or its own render targets is
 * likelier to hit a backend limit than a few lines of inline math.
 */
const BLAME_ORDER: readonly PostPassId[] = [
  // First: the raymarch is the most backend-sensitive node in the chain (loops,
  // uniform arrays and shadow-map sampling inside a post shader), so on the
  // WebGL2 fallback it is the likeliest thing to have failed.
  "volumetrics",
  "motionBlur",
  "ao",
  "dof",
  "lut",
  "smaa",
  "sharpen",
  "underwater",
  "chromaticAberration",
  "fxaa",
  "bloom",
  "grain",
  "vignette",
  "grade",
  "tonemap",
];

export interface PlanContext {
  /** Passes retired by graceful degradation; never re-added. */
  disabled?: ReadonlySet<PostPassId>;
  /** True when `grade.lut` resolved to a usable 3D texture. */
  lutReady?: boolean;
  /**
   * Volumetric shafts wanted this frame. Unlike every other pass this one is
   * driven by the `sky` component rather than `postfx`, so it arrives beside
   * `fx` instead of inside it. Null/absent means none.
   */
  volumetric?: VolumetricRequest | null | undefined;
  /**
   * Whether this SCENE can have weather at all — it carries the `weather`
   * script, or something else that drives `setSandstorm`.
   *
   * A property of the scene, not of the frame, for exactly the reason
   * `water` is: building the pass when the storm arrives would rebuild the
   * post chain mid-storm, and a rebuild recompiles every material in the
   * scene (docs/performance-lessons.md). One idle pass beats a stall the
   * first time the wind gets up.
   */
  weather?: boolean;
  /**
   * Whether this SCENE has water in it at all — a procedural world with a sea,
   * lakes or rivers, or an entity carrying the `water` component.
   *
   * It is a property of the scene, not of the frame, and that is the whole
   * point: the underwater pass is built once for a scene that has water and
   * then driven by a uniform (`PostChain.setSubmersion`). Planning it at the
   * moment the camera goes under would rebuild the chain mid-dive, and a
   * rebuild recreates the scene pass — a new render target, a new
   * RenderContext, and every material in the scene recompiling its shader on
   * the next draw (see docs/performance-lessons.md). One cheap always-on pass
   * beats a 600 ms stall the first time anybody swims.
   */
  water?: boolean;
}

/**
 * The ordered set of passes that will actually exist in the node graph.
 * A disabled effect is absent, not multiplied by zero — a pass that is not in
 * this list costs nothing at all.
 */
export function passPlan(fx: ResolvedPostFx, ctx: PlanContext = {}): PostPassId[] {
  const off = ctx.disabled;
  const wanted = new Set<PostPassId>();
  const volumetric = ctx.volumetric;
  if (
    volumetric &&
    volumetric.settings.enabled &&
    volumetric.settings.intensity > 0 &&
    volumetric.lights.length > 0
  ) {
    wanted.add("volumetrics");
  }
  if (fx.ao.enabled && fx.ao.intensity > 0) wanted.add("ao");
  // Scene-level, not frame-level: see PlanContext.water.
  if (fx.underwater.enabled && ctx.water) wanted.add("underwater");
  // Scene-level for the same reason water is: planning it when the storm
  // arrives would rebuild the chain mid-storm and recompile every material.
  if (fx.sandstorm.enabled && ctx.weather) wanted.add("sandstorm");
  if (fx.bloom.enabled) wanted.add("bloom");
  if (fx.dof.enabled) wanted.add("dof");
  if (fx.motionBlur.enabled && fx.motionBlur.amount > 0) wanted.add("motionBlur");
  // `linear` is a tone curve of "multiply by exposure" — still a pass, because
  // it is the difference between exposure working and being silently ignored.
  if (fx.tonemap.enabled) wanted.add("tonemap");
  if (fx.grade.enabled) {
    wanted.add("grade");
    if (fx.grade.lut && ctx.lutReady) wanted.add("lut");
  }
  if (fx.chromaticAberration.enabled && fx.chromaticAberration.amount > 0) wanted.add("chromaticAberration");
  if (fx.vignette.enabled && fx.vignette.amount > 0) wanted.add("vignette");
  if (fx.grain.enabled && fx.grain.amount > 0) wanted.add("grain");
  if (fx.sharpen.enabled && fx.sharpen.amount > 0) wanted.add("sharpen");
  const aa = resolveAntialias(fx.antialias.mode);
  if (aa === "fxaa") wanted.add("fxaa");
  if (aa === "smaa") wanted.add("smaa");
  return POST_PASS_ORDER.filter((id) => wanted.has(id) && !off?.has(id));
}

export const TAA_FALLBACK_REASON =
  "[render] postfx.antialias 'taa' is unavailable: three's VelocityNode derives motion from an " +
  "object's world matrix only, so instanced foliage, grass, skinned characters and particles all " +
  "report zero motion and would ghost. Falling back to 'smaa'.";

let taaWarned = false;

/** `taa` degrades to `smaa`, warning once. See `TAA_FALLBACK_REASON`. */
export function resolveAntialias(mode: AntialiasMode): Exclude<AntialiasMode, "taa"> {
  if (mode !== "taa") return mode;
  if (!taaWarned) {
    taaWarned = true;
    console.warn(TAA_FALLBACK_REASON);
  }
  return "smaa";
}

/**
 * Everything that changes graph *topology*. Two configs with the same signature
 * differ only in uniform values and must be retuned in place — rebuilding the
 * pipeline on a slider drag would blow the interactivity budget (a rebuild
 * recompiles shaders; a retune writes a float).
 *
 * Note what is deliberately absent: every numeric knob. `ao.samples` is a
 * uniform inside GTAO's loop bound, `motionBlur.samples` likewise, so even
 * those retune.
 */
export function pipelineSignature(fx: ResolvedPostFx, ctx: PlanContext = {}): string {
  const plan = passPlan(fx, ctx);
  const parts: string[] = plan.slice();
  // The graph holds direct references to specific lights, so a changed shaft
  // set cannot be patched in place — it has to read as a structural change.
  if (plan.includes("volumetrics")) parts.push(`vol:${ctx.volumetric?.signature ?? ""}`);
  if (plan.includes("tonemap")) parts.push(`mode:${fx.tonemap.mode}`);
  // The sway needs a copy of the frame to re-sample (an extra render target),
  // so whether it is wanted at all is structure. Its STRENGTH is a uniform.
  if (plan.includes("underwater") && fx.underwater.wobble > 0) parts.push("uw:wobble");
  if (plan.includes("ao") && fx.ao.denoise) parts.push("ao:denoise");
  if (plan.includes("lut")) parts.push(`lut:${fx.grade.lut}`);
  return parts.join("|");
}

/**
 * Whether a `RenderPipeline` is needed at all. A plan of only `tonemap` is
 * exactly what `renderer.toneMapping` already does on the direct render path,
 * so we skip the fullscreen quad and the intermediate HDR target entirely —
 * a scene with no postfx component renders byte-identically to before.
 */
export function needsPipeline(plan: readonly PostPassId[]): boolean {
  return plan.some((id) => id !== "tonemap");
}

const TONEMAP_CONSTANTS: Record<TonemapMode, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  // three's LinearToneMapping is "multiply by exposure, no curve" — which is
  // what the schema means by `linear`.
  linear: THREE.LinearToneMapping,
};

export function toneMappingConstant(fx: ResolvedPostFx): THREE.ToneMapping {
  return fx.tonemap.enabled ? TONEMAP_CONSTANTS[fx.tonemap.mode] : THREE.NoToneMapping;
}

/* -------------------------------------------------------------------------- */
/* Colour maths — one implementation, two evaluators                           */
/* -------------------------------------------------------------------------- */

/**
 * The slice of arithmetic the grade needs, so the exact same source can be
 * evaluated as TSL (on the GPU) and as plain numbers (in a test). The point is
 * the neutrality guarantee: a `grade` block at its schema defaults must be a
 * bit-for-bit no-op, and the only way to *prove* that about the shader is to
 * run the shader's own expression tree on the CPU.
 */
export interface ColorOps<V> {
  /** Scalar literal. */
  f(n: number): V;
  /** vec3 literal. */
  v3(x: number, y: number, z: number): V;
  /** vec3 from three scalar values. */
  pack(x: V, y: V, z: V): V;
  /** Broadcast a scalar to vec3. */
  splat(a: V): V;
  add(a: V, b: V): V;
  sub(a: V, b: V): V;
  mul(a: V, b: V): V;
  pow(a: V, b: V): V;
  max(a: V, b: V): V;
  dot3(a: V, b: V): V;
  mix(a: V, b: V, t: V): V;
}

/** Rec.709 luma weights — matches three's own `luminance()`. */
const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

export interface GradeTerms<V> {
  contrast: V;
  saturation: V;
  temperature: V;
  tint: V;
  /** Shadow offset, 0 = neutral (decoded from hex). */
  lift: V;
  /** Highlight multiplier, 1 = neutral. */
  gain: V;
  /** Midtone exponent, 1 = neutral. */
  gammaExponent: V;
}

/**
 * Contrast -> saturation -> white balance -> lift/gamma/gain, on
 * display-referred values.
 *
 * Every stage is written so its neutral value is an exact algebraic identity
 * (`mix(x, y, 1) === y`, `pow(x, 1) === x`, `x * 1 === x`), not merely
 * "close to". A grade block that is enabled but untouched must not change a
 * single pixel — the alternative is a whole game silently shifted the day
 * someone ticks the box.
 */
export function gradeColor<V>(ops: ColorOps<V>, rgb: V, t: GradeTerms<V>): V {
  const one = ops.f(1);

  // White balance. Deliberately a plain per-channel scale rather than an
  // LMS round-trip: exact identity at 0/0 matters more here than colorimetric
  // pedigree, and the artist knob is "cooler/warmer", not a Kelvin figure.
  const balance = ops.pack(
    ops.add(one, ops.sub(ops.mul(t.temperature, ops.f(0.25)), ops.mul(t.tint, ops.f(0.1)))),
    ops.add(one, ops.mul(t.tint, ops.f(0.2))),
    ops.sub(one, ops.add(ops.mul(t.temperature, ops.f(0.25)), ops.mul(t.tint, ops.f(0.1)))),
  );
  let c = ops.mul(rgb, balance);

  // Contrast about mid-grey.
  const half = ops.f(0.5);
  c = ops.add(ops.mul(ops.sub(c, half), t.contrast), half);
  c = ops.max(c, ops.f(0));

  // Saturation toward luma.
  const luma = ops.dot3(c, ops.v3(LUMA[0], LUMA[1], LUMA[2]));
  c = ops.mix(ops.splat(luma), c, t.saturation);
  c = ops.max(c, ops.f(0));

  // Lift / gamma / gain, in the classic order. Lift is weighted by (1 - c) so
  // it lands on shadows rather than flatly raising the whole frame.
  c = ops.add(c, ops.mul(t.lift, ops.sub(one, c)));
  c = ops.mul(c, t.gain);
  c = ops.max(c, ops.f(0));
  c = ops.pow(c, t.gammaExponent);

  return c;
}

/**
 * Decode a lift/gamma/gain hex into a signed [-1, 1] per channel.
 *
 * The schema promises `#808080` means "no change". 0x80 is 128, and 128/255 is
 * 0.50196 — so the naive `value/255 - 0.5` leaves a 0.4% bias on every channel
 * of every scene that enables grading. Dividing the *byte* offset by 127
 * instead makes 0x80 land on exactly 0, 0x00 on exactly -1, and 0xff on +1.
 */
export function decodeGradeHex(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const dec = (byte: number) => Math.max(-1, Math.min(1, (byte - 128) / 127));
  return [dec(r), dec(g), dec(b)];
}

export interface GradeUniformValues {
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  lift: [number, number, number];
  gain: [number, number, number];
  gammaExponent: [number, number, number];
}

/** Schema values -> the numbers the shader's uniforms actually hold. */
export function gradeUniformValues(grade: GradeFx): GradeUniformValues {
  const lift = decodeGradeHex(grade.lift);
  const gammaRaw = decodeGradeHex(grade.gamma);
  const gainRaw = decodeGradeHex(grade.gain);
  // gain: -1..1 -> 0..2 multiplier (1 = neutral).
  const gain: [number, number, number] = [1 + gainRaw[0], 1 + gainRaw[1], 1 + gainRaw[2]];
  // gamma: -1..1 -> exponent 1/(1+g), clamped off zero so pow() stays defined.
  const exp = (g: number) => 1 / Math.max(1 + g, 0.01);
  const gammaExponent: [number, number, number] = [exp(gammaRaw[0]), exp(gammaRaw[1]), exp(gammaRaw[2])];
  return {
    contrast: grade.contrast,
    saturation: grade.saturation,
    temperature: grade.temperature,
    tint: grade.tint,
    lift,
    gain,
    gammaExponent,
  };
}

type CpuVec = readonly number[];

function broadcast(a: CpuVec, b: CpuVec): [number[], number[]] {
  const n = Math.max(a.length, b.length);
  const at = (v: CpuVec, i: number) => (v.length === 1 ? (v[0] as number) : (v[i] as number));
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 0; i < n; i++) {
    ra.push(at(a, i));
    rb.push(at(b, i));
  }
  return [ra, rb];
}
function zip(a: CpuVec, b: CpuVec, fn: (x: number, y: number) => number): number[] {
  const [ra, rb] = broadcast(a, b);
  return ra.map((x, i) => fn(x, rb[i] as number));
}

/** CPU evaluator for {@link gradeColor}. Mirrors TSL's scalar broadcasting. */
export const cpuColorOps: ColorOps<CpuVec> = {
  f: (n) => [n],
  v3: (x, y, z) => [x, y, z],
  pack: (x, y, z) => [x[0] as number, y[0] as number, z[0] as number],
  splat: (a) => [a[0] as number, a[0] as number, a[0] as number],
  add: (a, b) => zip(a, b, (x, y) => x + y),
  sub: (a, b) => zip(a, b, (x, y) => x - y),
  mul: (a, b) => zip(a, b, (x, y) => x * y),
  pow: (a, b) => zip(a, b, (x, y) => Math.pow(x, y)),
  max: (a, b) => zip(a, b, (x, y) => Math.max(x, y)),
  dot3: (a, b) => {
    const [ra, rb] = broadcast(a, b);
    return [ra.reduce((acc, x, i) => acc + x * (rb[i] as number), 0)];
  },
  mix: (a, b, t) => {
    const [ra, rb] = broadcast(a, b);
    // Match GLSL/WGSL mix: a + (b - a) * t, which is exactly `b` at t == 1.
    return ra.map((x, i) => {
      const y = rb[i] as number;
      const k = t.length === 1 ? (t[0] as number) : (t[i] as number);
      return x + (y - x) * k;
    });
  },
};

/**
 * Run the grade on the CPU. This is the same expression tree the shader
 * evaluates, not a re-derivation — see {@link gradeColor}.
 */
export function evaluateGrade(rgb: readonly [number, number, number], grade: GradeFx): [number, number, number] {
  const u = gradeUniformValues(grade);
  const out = gradeColor<CpuVec>(cpuColorOps, [rgb[0], rgb[1], rgb[2]], {
    contrast: [u.contrast],
    saturation: [u.saturation],
    temperature: [u.temperature],
    tint: [u.tint],
    lift: u.lift,
    gain: u.gain,
    gammaExponent: u.gammaExponent,
  });
  return [out[0] as number, out[1] as number, out[2] as number];
}

/* -------------------------------------------------------------------------- */
/* Parameter conversions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Full-frame circle of confusion, the standard "acceptably sharp" threshold.
 */
const DOF_COC_MM = 0.03;
/**
 * There is no aperture in the schema (`bokehScale` is the artistic knob
 * instead), so the depth-of-field maths assumes a fixed, cinematic-ish stop.
 * Changing this rescales what every `focalLength` value means.
 */
const DOF_F_NUMBER = 2.8;

/**
 * `DepthOfFieldNode.focalLengthNode` is not a lens length: it is the world-space
 * distance from the focal plane at which a surface is *fully* defocused
 * (`smoothstep(0, focalLength, |z - focus|)`). The schema exposes a real lens in
 * millimetres, so convert with the thin-lens depth-of-field half-depth
 * `N·c·S²/f²` — with S in world units and f in mm that is
 * `1000·N·c·S²/f²`. 10 m at 35 mm gives ~6.9 world units of ramp; 85 mm gives
 * ~1.2, which is the shallow look a long lens is picked for.
 */
export function dofRampWorldUnits(focusDistance: number, focalLengthMm: number): number {
  const f = Math.max(focalLengthMm, 1);
  const s = Math.max(focusDistance, 0.01);
  return Math.min(Math.max((1000 * DOF_F_NUMBER * DOF_COC_MM * s * s) / (f * f), 0.05), 1e4);
}

/** The schema's `bokehScale` ceiling; `maxBlur` is a fraction of it. */
const DOF_MAX_BOKEH = 8;

/**
 * `maxBlur` is the guard against a distant background smearing over the frame.
 * DepthOfFieldNode has no such clamp, but its sample step is
 * `1/size · bokehScale · CoC` with CoC already in [0, 1], so capping the
 * effective bokeh scale *is* capping the blur radius. At the schema defaults
 * (bokehScale 2, maxBlur 0.5 -> cap 4) the clamp is inert, as intended.
 */
export function effectiveBokehScale(bokehScale: number, maxBlur: number): number {
  return Math.min(bokehScale, Math.max(maxBlur, 0) * DOF_MAX_BOKEH);
}

/**
 * ChromaticAberrationNode's `strength` is unitless; the schema promises "split
 * at the screen edge as a fraction of screen width". Its shader offsets red by
 * `offset·(scale·0.02·strength) + offset·(strength·|offset|)·0.01`, and at a
 * corner (|offset| = 0.7071, scale = 1.1) that totals ~0.0205·strength — so
 * this constant is the calibration, and `amount` keeps its documented meaning.
 */
const CA_EDGE_SPLIT_PER_STRENGTH = 0.0205;
const CA_SCALE = 1.1;

export function chromaticAberrationStrength(amount: number): number {
  return Math.max(amount, 0) / CA_EDGE_SPLIT_PER_STRENGTH;
}

/**
 * SharpenNode reads its parameter *backwards* from the schema: 0 is maximum
 * sharpening and 2 is none. Enabling the pass with `amount: 0` must therefore
 * be a no-op, not a maximum.
 */
export function sharpenSharpness(amount: number): number {
  return 2 - Math.min(Math.max(amount, 0), 2);
}

/**
 * Belt-and-suspenders cap on top of the MRT split below — even the emissive
 * channel shouldn't be able to blow bloom out arbitrarily far past 1.0.
 */
const BLOOM_INPUT_CEILING = 4;

/**
 * Bloom's 5-level mip blur chain is a FIXED per-frame cost regardless of scene
 * complexity — its default resolutionScale (0.5) is the single biggest lever to
 * cut that without changing the visible effect much; drop it further for
 * headroom.
 */
const BLOOM_RESOLUTION_SCALE = 0.35;

/**
 * GTAO at full resolution is the most expensive thing in this stack by a wide
 * margin, and its output is a low-frequency occlusion term that survives
 * upsampling almost perfectly — the same fixed-cost-blur-chain reasoning that
 * put bloom at 0.35. Denoise then runs on the smaller buffer too.
 */
const AO_RESOLUTION_SCALE = 0.5;

/* -------------------------------------------------------------------------- */
/* The chain                                                                   */
/* -------------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any */
// TSL's chainable node objects are structurally typed per operation; threading
// exact types through a dynamically assembled graph buys nothing and costs a
// lot of casts, so the graph-building half of this file is deliberately loose.
type Tsl = any;

const tslColorOps: ColorOps<Tsl> = {
  f: (n) => float(n),
  v3: (x, y, z) => vec3(x, y, z),
  pack: (x, y, z) => vec3(x, y, z),
  splat: (a) => vec3(a),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  pow: (a, b) => a.pow(b),
  max: (a, b) => a.max(b),
  dot3: (a, b) => dot(a, b),
  mix: (a, b, t) => mix(a, b, t),
};

interface Disposable {
  dispose?: () => void;
}

/** Resolves a texture asset id to a loaded texture (for `grade.lut`). */
export type PostTextureResolver = (id: string) => THREE.Texture | null | undefined;

export interface PostChainOptions {
  disabled?: ReadonlySet<PostPassId>;
  resolveTexture?: PostTextureResolver | null;
  /** Volumetric shafts from the scene's `sky` component (see PlanContext). */
  volumetric?: VolumetricRequest | null | undefined;
  /** Whether this scene has water at all — see PlanContext.water. */
  water?: boolean;
  /** Whether this scene can have weather at all — see PlanContext.weather. */
  weather?: boolean;
}

/**
 * One assembled post-processing graph. Built for a (scene, camera, signature)
 * triple and thrown away when any of those change; parameter changes are
 * absorbed by {@link retune} instead.
 */
export class PostChain {
  readonly plan: PostPassId[];
  readonly signature: string;
  readonly outputNode: Tsl;
  readonly toneMapping: THREE.ToneMapping;
  /**
   * The pass that draws the scene. Exposed for `EngineRenderer.precompileGroup`:
   * three keys every compiled shader on the render target + MRT it was built
   * for, so a background compile that wants to be USED by this pass has to
   * borrow its target and MRT node — see the renderer.
   */
  readonly scenePass: ReturnType<typeof pass>;

  private readonly disposables: Disposable[] = [];

  private bloomNode: ReturnType<typeof bloom> | null = null;
  private shafts: VolumetricShafts | null = null;
  private aoNode: ReturnType<typeof gtao> | null = null;
  private dofFocus: Tsl = null;
  private dofRamp: Tsl = null;
  private dofBokeh: Tsl = null;
  private motionAmount: Tsl = null;
  private motionSamples: Tsl = null;
  private uwAmount: Tsl = null;
  /** Sandstorm: driven per frame (amount, the wind's angle on screen, how much of it is coming AT you). */
  private sandAmount: Tsl = null;
  private sandAngle: Tsl = null;
  private sandColor: Tsl = null;
  private sandOpacity: Tsl = null;
  private sandHaze: Tsl = null;
  private sandScale: Tsl = null;
  private sandSpeed: Tsl = null;
  private sandStreak: Tsl = null;
  private sandSwirl: Tsl = null;
  private sandThreshold: Tsl = null;
  private sandSteps: Tsl = null;
  private uwColor: Tsl = null;
  private uwDensity: Tsl = null;
  private uwTint: Tsl = null;
  private uwSaturation: Tsl = null;
  private uwEdge: Tsl = null;
  private uwWobble: Tsl = null;
  private uwWobbleSpeed: Tsl = null;
  private uwWobbleScale: Tsl = null;
  private gradeUniforms: Record<string, Tsl> = {};
  private lutIntensity: Tsl = null;
  private caStrength: Tsl = null;
  private vignetteAmount: Tsl = null;
  private vignetteInner: Tsl = null;
  private vignetteOuter: Tsl = null;
  private grainAmount: Tsl = null;
  private grainSize: Tsl = null;
  private grainSeed: Tsl = null;
  private sharpenAmount: Tsl = null;

  constructor(
    renderer: THREE.WebGPURenderer,
    fx: ResolvedPostFx,
    scene: THREE.Scene,
    camera: THREE.Camera,
    options: PostChainOptions = {},
  ) {
    const lutTexture = resolveLut(fx, options.resolveTexture ?? null);
    const ctx: PlanContext = {
      disabled: options.disabled,
      lutReady: lutTexture !== null,
      volumetric: options.volumetric,
      water: options.water,
      weather: options.weather,
    };
    this.plan = passPlan(fx, ctx);
    this.signature = pipelineSignature(fx, ctx);
    this.toneMapping = toneMappingConstant(fx);

    const has = (id: PostPassId) => this.plan.includes(id);

    const scenePass = pass(scene, camera);
    this.scenePass = scenePass;
    this.disposables.push(scenePass as unknown as Disposable);

    // Selective bloom: split the scene pass into its normal lit "output" and
    // the material's own "emissive" contribution (MRT — one pass, two
    // targets). Bloom samples ONLY the emissive channel — a sunlit terrain
    // slope or a grazing-angle water highlight can never feed it, no matter how
    // bright, because ordinary PBR materials never write to `emissive` unless a
    // material explicitly sets one. This is what fixed a repeatable
    // freeze-and-flare at one hillside: threshold/ceiling tuning on the whole
    // scene color couldn't win against a wide-enough bright area, because
    // bloom's cost scales with area above threshold, not peak brightness —
    // excluding lit surfaces from the bloom input entirely removes that failure
    // mode structurally instead of just raising the bar.
    //
    // The split is unconditional even without bloom: it is also what lets AO
    // spare emissive surfaces below, and keeping it fixed means a pass added
    // later can never accidentally reintroduce the bug by taking full colour
    // from the wrong place. Anything needing the whole frame takes `output`.
    const mrtTargets: Record<string, Tsl> = { output, emissive };
    if (has("ao")) mrtTargets["normal"] = normalView;
    if (has("motionBlur")) mrtTargets["velocity"] = velocity;
    scenePass.setMRT(mrt(mrtTargets));

    const sceneColor = scenePass.getTextureNode("output") as Tsl;
    const emissiveColor = scenePass.getTextureNode("emissive") as Tsl;
    let color: Tsl = sceneColor;

    /* ---- linear HDR, scene-referred ---- */

    if (has("volumetrics") && options.volumetric) {
      // The raymarch reads only the pass's depth ATTACHMENT, which every pass
      // already has — so nothing here touches the MRT, and the {output,
      // emissive} split that fixed the bloom freeze-and-flare is untouched.
      const shafts = VolumetricShafts.create({
        colorNode: sceneColor as unknown as THREE.Node<"vec4">,
        depthNode: scenePass.getTextureNode("depth") as unknown as THREE.Node<"vec4">,
        camera,
        lights: options.volumetric.lights,
        settings: options.volumetric.settings,
      });
      if (shafts) {
        this.shafts = shafts;
        this.disposables.push(shafts);
        color = shafts.outputNode as unknown as Tsl;
      }
    }

    if (has("ao")) {
      const depthNode = scenePass.getTextureNode("depth") as Tsl;
      const normalNode = scenePass.getTextureNode("normal") as Tsl;
      const aoPass = gtao(depthNode, normalNode, camera);
      aoPass.resolutionScale = AO_RESOLUTION_SCALE;
      this.aoNode = aoPass;
      this.disposables.push(aoPass as unknown as Disposable);
      let aoTexture: Tsl = aoPass.getTextureNode();
      if (fx.ao.denoise) {
        const denoised = bilateralDenoise(aoTexture, depthNode, normalNode, camera);
        this.disposables.push(denoised as unknown as Disposable);
        aoTexture = denoised;
      }
      // Occlude the lit contribution but not the material's own emission — a
      // brazier in a wall niche is the single most occluded thing in a cave and
      // must not be the dimmest. Costs nothing: the emissive channel is already
      // there for bloom.
      const em = emissiveColor.rgb.max(vec3(0));
      const lit = color.rgb.sub(em).max(vec3(0));
      color = vec4(lit.mul(aoTexture.r).add(em), color.a);
    }

    if (has("underwater")) {
      const uw = fx.underwater;
      this.uwAmount = uniform(0); // driven per frame; 0 = the camera is dry
      this.uwColor = uniform(new THREE.Color(uw.color));
      this.uwDensity = uniform(uw.density);
      this.uwTint = uniform(uw.tint);
      this.uwSaturation = uniform(uw.saturation);
      this.uwEdge = uniform(uw.edge);
      this.uwWobble = uniform(uw.wobble);
      this.uwWobbleSpeed = uniform(uw.wobbleSpeed);
      this.uwWobbleScale = uniform(uw.wobbleScale);
      // Re-sampling the picture at a swayed uv needs a TEXTURE, and by here
      // the colour is a chain of nodes — so the sway (and only the sway) costs
      // the copy `convertToTexture` makes. wobble 0 skips it entirely, which
      // is why it is part of the pipeline signature.
      const swayed = uw.wobble > 0 ? (convertToTexture(color) as Tsl) : null;
      if (swayed) this.disposables.push(swayed as unknown as Disposable);
      const viewZ = scenePass.getViewZNode() as Tsl;
      const amount = this.uwAmount;
      const density = this.uwDensity;
      const water = this.uwColor;
      const tint = this.uwTint;
      const saturation = this.uwSaturation;
      const edge = this.uwEdge;
      const wobble = this.uwWobble;
      const wobbleSpeed = this.uwWobbleSpeed;
      const wobbleScale = this.uwWobbleScale;
      // Plain node expressions rather than an `Fn` body: the passes here
      // compose `color` by value, and the one thing that must never happen is
      // a graph that refers back to the variable this loop keeps reassigning.
      let base: Tsl = color;
      if (swayed) {
        // two sines at right angles, at different rates, so the pattern never
        // settles into a visible grid
        const t: Tsl = time.mul(wobbleSpeed);
        const sway: Tsl = vec2(
          sin(screenUV.y.mul(wobbleScale).add(t) as Tsl),
          sin(screenUV.x.mul(wobbleScale).add(t.mul(1.37)) as Tsl),
        ).mul(wobble.mul(amount));
        base = swayed.sample(screenUV.add(sway)) as Tsl;
      }
      // Absorption: everything fades toward the water's colour with the
      // distance its light travelled through the water. Depth comes from the
      // scene pass's own attachment, so the SKY — the far plane, or a dome
      // several kilometres out — fades out completely, which is the one thing
      // that gives a fake underwater look away.
      const absorbed: Tsl = float(1).sub(exp(viewZ.abs().mul(density).negate() as Tsl));
      const toward: Tsl = saturate(absorbed.add(tint) as Tsl).mul(amount);
      const tinted: Tsl = mix(base.rgb, water, toward);
      // Red goes first in real water; this is the cheap version of that.
      const luma: Tsl = dot(tinted, vec3(0.2126, 0.7152, 0.0722));
      const desaturated: Tsl = mix(vec3(luma), tinted, mix(float(1), saturation, amount));
      // and the corners close in
      const d: Tsl = screenUV.sub(vec2(0.5, 0.5)).length().div(0.70710678);
      const closed: Tsl = desaturated.mul(
        float(1).sub(smoothstep(float(0.2), float(1), d).mul(edge).mul(amount) as Tsl),
      );
      color = vec4(closed, base.a);
    }

    if (has("sandstorm")) {
      const sand = fx.sandstorm;
      this.sandAmount = uniform(0); // 0 = clear air; driven by setSandstorm
      this.sandAngle = uniform(0);
      this.sandColor = uniform(new THREE.Color(sand.color));
      this.sandOpacity = uniform(sand.opacity);
      this.sandHaze = uniform(sand.haze);
      this.sandScale = uniform(sand.scale);
      this.sandSpeed = uniform(sand.speed);
      this.sandStreak = uniform(Math.max(1, sand.streak));
      this.sandSwirl = uniform(sand.swirl);
      this.sandThreshold = uniform(sand.threshold);
      this.sandSteps = uniform(sand.steps);
      const amount = this.sandAmount;
      const angle = this.sandAngle;

      // Screen space, aspect-corrected and centred, so the grain is the same
      // size across the frame and "outward" means outward from where you are
      // looking rather than from a corner.
      const aspect: Tsl = screenSize.x.div(screenSize.y.max(1));
      const centred: Tsl = screenUV.sub(vec2(0.5, 0.5)).mul(vec2(aspect, 1));
      const travel: Tsl = time.mul(this.sandSpeed);

      /**
       * ONE LAYER of blown grit: the noise field rotated to `dir`, squeezed
       * along that axis so each grain is a smear, and scrolled.
       *
       * The field does NOT rotate continuously. That was the first version and
       * it was wrong in a way worth recording: a whole screen of noise turning
       * about the centre does not read as sand, it reads as the LENS being
       * warped — the eye follows the rotation, not the grains. Wind wanders a
       * few degrees; it does not pirouette. So `swirl` is a small oscillation
       * about the wind's own heading, and every layer travels in a straight
       * line.
       */
      const layer = (dir: Tsl, cells: Tsl, rate: Tsl, seed: number): Tsl => {
        const cs: Tsl = cos(dir);
        const sn: Tsl = sin(dir);
        const turned: Tsl = vec2(
          centred.x.mul(cs).sub(centred.y.mul(sn)) as Tsl,
          centred.x.mul(sn).add(centred.y.mul(cs)) as Tsl,
        );
        // Squeezing x smears each grain ALONG its travel: the streak is what
        // the eye reads as speed, not the displacement between frames.
        const p: Tsl = vec2(turned.x.div(this.sandStreak).add(travel.mul(rate)) as Tsl, turned.y).mul(cells);
        return mx_fractal_noise_float(vec3(p, time.mul(0.3).add(seed)), 2, 2, 0.5).mul(0.5).add(0.5);
      };

      // A few degrees of wander, not a rotation (see above).
      const heading: Tsl = angle.add(sin(time.mul(0.37)).mul(this.sandSwirl.mul(0.25)));
      // Two layers at different sizes and speeds: without the parallax the
      // grit is a flat decal on the glass, whatever else is done to it.
      const near: Tsl = layer(heading, this.sandScale, float(1), 0);
      const far: Tsl = layer(heading.add(0.22), this.sandScale.mul(1.7), float(0.55), 17.3);

      // Grains, not cloud: a hard threshold leaves separate specks and
      // streaks with air between them. A soft one leaves a veil, and a veil
      // is just fog that moves — which is exactly what it looked like.
      const threshold = this.sandThreshold;
      // The 1.5 is CONTRAST, not brightness: lifting before the clamp widens
      // the bright cores and keeps the dark air between them, which is the
      // difference between grains and a beige wash. Raising `opacity` instead
      // just fades the whole thing up, haze and all.
      const cut = (n: Tsl): Tsl => saturate(n.sub(threshold).div(float(1).sub(threshold).max(0.001)).mul(1.5) as Tsl);
      // Crossing layers ONLY. There was a second mode here that scrolled the
      // grain radially when you faced into the wind; it read as ripples on
      // the lens rather than as sand, which is the same failure the rotating
      // field had. Sand crossing the view is what looks like sand.
      const field: Tsl = cut(near).mul(0.65).add(cut(far).mul(0.35));

      // Gusts: a big, slow mask, so the storm arrives in SHEETS. An even veil
      // of grain has no event in it and the eye stops seeing it in seconds.
      const gust: Tsl = mx_fractal_noise_float(vec3(centred.mul(0.55).add(vec2(travel.mul(0.3), 0)) as Tsl, time.mul(0.2)), 2, 2, 0.5)
        .mul(0.55)
        .add(0.7);

      const banded: Tsl = posterize(saturate(field.mul(gust) as Tsl), this.sandSteps) as Tsl;
      const grit: Tsl = banded.mul(this.sandOpacity).mul(amount);
      // The air between you and everything else, then the grains on top of it.
      const hazed: Tsl = mix(color.rgb, this.sandColor, this.sandHaze.mul(amount));
      color = vec4(mix(hazed, this.sandColor, grit), color.a);
    }

    if (has("bloom")) {
      const bloomInput = tslMin(emissiveColor, BLOOM_INPUT_CEILING) as Tsl;
      const bloomPass = bloom(bloomInput, fx.bloom.strength, fx.bloom.radius, fx.bloom.threshold);
      bloomPass.setResolutionScale(BLOOM_RESOLUTION_SCALE);
      this.bloomNode = bloomPass;
      this.disposables.push(bloomPass as unknown as Disposable);
      // additive bloom in working space
      color = color.add(bloomPass);
    }

    if (has("dof")) {
      this.dofFocus = uniform(fx.dof.focusDistance);
      this.dofRamp = uniform(dofRampWorldUnits(fx.dof.focusDistance, fx.dof.focalLength));
      this.dofBokeh = uniform(effectiveBokehScale(fx.dof.bokehScale, fx.dof.maxBlur));
      const dofPass = depthOfField(
        color,
        scenePass.getViewZNode() as Tsl,
        this.dofFocus,
        this.dofRamp,
        this.dofBokeh,
      );
      this.disposables.push(dofPass as unknown as Disposable);
      color = dofPass;
    }

    if (has("motionBlur")) {
      // three's VelocityNode reads only the object world matrix, so this blurs
      // camera and rigid-body motion and misses anything animated in the vertex
      // shader (grass, skinning, particles). Missing blur is a soft failure;
      // the same gap is why `taa` is not offered at all.
      this.motionAmount = uniform(fx.motionBlur.amount);
      this.motionSamples = uniform(fx.motionBlur.samples, "int");
      const velocityTexture = scenePass.getTextureNode("velocity") as Tsl;
      color = motionBlurFn(color, velocityTexture.xy.mul(this.motionAmount), this.motionSamples);
    }

    /* ---- tone curve + working-to-display transform ---- */

    // Exposure is not an argument here: three's tone-mapping nodes read
    // `renderer.toneMappingExposure` through a renderer reference, which is a
    // uniform — so exposure retunes for free and also keeps working on the
    // no-pipeline path. See EngineRenderer.applyToneMapping().
    //
    // `renderOutput` with an explicit tone mapping is exactly what
    // RenderPipeline's own output transform builds; doing it here instead is
    // what lets grade/vignette/grain/AA run *after* it, on display-referred
    // values, which is the whole point of the documented pass order.
    color = renderOutput(color, this.toneMapping, renderer.outputColorSpace);

    /* ---- display-referred, sRGB ---- */

    if (has("grade")) {
      const u = gradeUniformValues(fx.grade);
      this.gradeUniforms = {
        contrast: uniform(u.contrast),
        saturation: uniform(u.saturation),
        temperature: uniform(u.temperature),
        tint: uniform(u.tint),
        lift: uniform(new THREE.Vector3(...u.lift)),
        gain: uniform(new THREE.Vector3(...u.gain)),
        gammaExponent: uniform(new THREE.Vector3(...u.gammaExponent)),
      };
      const g = this.gradeUniforms;
      const graded = gradeColor<Tsl>(tslColorOps, color.rgb, {
        contrast: g["contrast"],
        saturation: g["saturation"],
        temperature: g["temperature"],
        tint: g["tint"],
        lift: g["lift"],
        gain: g["gain"],
        gammaExponent: g["gammaExponent"],
      });
      color = vec4(graded, color.a);
    }

    if (has("lut") && lutTexture) {
      this.lutIntensity = uniform(1);
      const lutPass = lut3DNode(color, texture3D(lutTexture.texture) as Tsl, lutTexture.size, this.lutIntensity);
      this.disposables.push(lutPass as unknown as Disposable);
      color = lutPass;
    }

    if (has("chromaticAberration")) {
      this.caStrength = uniform(chromaticAberrationStrength(fx.chromaticAberration.amount));
      const ca = caNode(color, this.caStrength, null, float(CA_SCALE) as never);
      this.disposables.push(ca as unknown as Disposable);
      color = ca;
    }

    if (has("vignette")) {
      this.vignetteAmount = uniform(fx.vignette.amount);
      const [inner, outer] = vignetteEdges(fx.vignette);
      this.vignetteInner = uniform(inner);
      this.vignetteOuter = uniform(outer);
      const amount = this.vignetteAmount;
      const e0 = this.vignetteInner;
      const e1 = this.vignetteOuter;
      // Bound to a const, NOT read off `color` inside the closure. An Fn body
      // runs when the graph is BUILT, and a later pass that re-samples the
      // frame (fxaa, sharpen, chromatic aberration — anything that wraps the
      // chain in a render target) builds it again by then `color` is the
      // wrapper, and the node quietly references itself. Measured: a scene
      // with vignette or grain and the default fxaa threw "Maximum call stack
      // size exceeded" on its first frame and silently retired its AA.
      const src = color;
      const vignette = Fn(() => {
        // 0 at frame centre, 1 at a corner — so `radius` reads as "fraction of
        // the half-diagonal left alone", which is what the schema promises.
        const d = screenUV.sub(vec2(0.5, 0.5)).length().div(0.70710678);
        const falloff = smoothstep(e0, e1, d);
        return vec4(src.rgb.mul(float(1).sub(falloff.mul(amount))), src.a);
      })();
      color = vignette;
    }

    if (has("grain")) {
      this.grainAmount = uniform(fx.grain.amount);
      this.grainSize = uniform(Math.max(fx.grain.size, 0.1));
      // Re-seeded every frame from JS (see update()). A fixed hash reads as
      // dirt on the lens, not as film — and it is instantly obvious in motion.
      this.grainSeed = uniform(0);
      const amount = this.grainAmount;
      const size = this.grainSize;
      const seed = this.grainSeed;
      const src = color; // see the vignette above: never close over `color`
      const grain = Fn(() => {
        const cell = (screenCoordinate as Tsl).div(size).floor();
        const noise = rand(cell.mul(vec2(0.0011, 0.0017)).add(seed).fract() as Tsl);
        // Signed and additive: the job is hiding banding in the dark gradients
        // fog and vignette create, and a multiplicative grain leaves black flat.
        return vec4(src.rgb.add(noise.sub(0.5).mul(amount)), src.a);
      })();
      color = grain;
    }

    if (has("sharpen")) {
      this.sharpenAmount = uniform(sharpenSharpness(fx.sharpen.amount));
      const sharpenPass = sharpenNode(color, this.sharpenAmount);
      this.disposables.push(sharpenPass as unknown as Disposable);
      color = sharpenPass;
    }

    if (has("fxaa")) {
      const pass_ = fxaaNode(color);
      this.disposables.push(pass_ as unknown as Disposable);
      color = pass_;
    } else if (has("smaa")) {
      const pass_ = smaaNode(color);
      this.disposables.push(pass_ as unknown as Disposable);
      color = pass_;
    }

    this.outputNode = color;
  }

  /** True when this chain still matches `fx` structurally. */
  matches(signature: string): boolean {
    return this.signature === signature;
  }

  /**
   * Write new parameter values into the existing uniforms. Never changes the
   * graph — callers must have checked {@link pipelineSignature} first.
   */
  retune(fx: ResolvedPostFx, volumetric?: VolumetricSettings | null): void {
    if (this.shafts && volumetric) this.shafts.setSettings(volumetric);
    if (this.bloomNode) {
      this.bloomNode.strength.value = fx.bloom.strength;
      this.bloomNode.radius.value = fx.bloom.radius;
      this.bloomNode.threshold.value = fx.bloom.threshold;
    }
    if (this.aoNode) {
      // GTAO's `scale` is the exponent on visibility (`ao = pow(ao, scale)`),
      // so it maps straight onto the schema's `intensity`: 0 removes the effect,
      // 1 is physical, above 1 is the stylized darkening the schema warns about.
      this.aoNode.scale.value = fx.ao.intensity;
      this.aoNode.radius.value = fx.ao.radius;
      this.aoNode.distanceFallOff.value = fx.ao.distanceFalloff;
      this.aoNode.samples.value = fx.ao.samples;
    }
    if (this.dofFocus) {
      this.dofFocus.value = fx.dof.focusDistance;
      this.dofRamp.value = dofRampWorldUnits(fx.dof.focusDistance, fx.dof.focalLength);
      this.dofBokeh.value = effectiveBokehScale(fx.dof.bokehScale, fx.dof.maxBlur);
    }
    if (this.motionAmount) {
      this.motionAmount.value = fx.motionBlur.amount;
      this.motionSamples.value = fx.motionBlur.samples;
    }
    if (this.gradeUniforms["contrast"]) {
      const u = gradeUniformValues(fx.grade);
      const g = this.gradeUniforms;
      g["contrast"].value = u.contrast;
      g["saturation"].value = u.saturation;
      g["temperature"].value = u.temperature;
      g["tint"].value = u.tint;
      g["lift"].value.set(...u.lift);
      g["gain"].value.set(...u.gain);
      g["gammaExponent"].value.set(...u.gammaExponent);
    }
    if (this.uwAmount) {
      // `amount` is deliberately NOT retuned: it is this frame's submersion,
      // written by setSubmersion, and an inspector edit must not yank the
      // camera out of the water.
      this.uwColor.value.set(fx.underwater.color);
      this.uwDensity.value = fx.underwater.density;
      this.uwTint.value = fx.underwater.tint;
      this.uwSaturation.value = fx.underwater.saturation;
      this.uwEdge.value = fx.underwater.edge;
      this.uwWobble.value = fx.underwater.wobble;
      this.uwWobbleSpeed.value = fx.underwater.wobbleSpeed;
      this.uwWobbleScale.value = fx.underwater.wobbleScale;
    }
    if (this.sandColor) {
      // `amount`, `angle` and `toward` are this frame's storm (setSandstorm);
      // an inspector edit must not blow the sand away or turn it round.
      const sand = fx.sandstorm;
      this.sandColor.value.set(sand.color);
      this.sandOpacity.value = sand.opacity;
      this.sandHaze.value = sand.haze;
      this.sandScale.value = sand.scale;
      this.sandSpeed.value = sand.speed;
      this.sandStreak.value = Math.max(1, sand.streak);
      this.sandSwirl.value = sand.swirl;
      this.sandThreshold.value = sand.threshold;
      this.sandSteps.value = sand.steps;
    }
    if (this.caStrength) this.caStrength.value = chromaticAberrationStrength(fx.chromaticAberration.amount);
    if (this.vignetteAmount) {
      this.vignetteAmount.value = fx.vignette.amount;
      const [inner, outer] = vignetteEdges(fx.vignette);
      this.vignetteInner.value = inner;
      this.vignetteOuter.value = outer;
    }
    if (this.grainAmount) {
      this.grainAmount.value = fx.grain.amount;
      this.grainSize.value = Math.max(fx.grain.size, 0.1);
    }
    if (this.sharpenAmount) this.sharpenAmount.value = sharpenSharpness(fx.sharpen.amount);
  }

  /**
   * How far the camera is into water this frame, 0..1, and what that water
   * looks like when it differs from the scene's default (a green swamp pool in
   * a world of blue lakes). A uniform write per frame — never a rebuild.
   *
   * A chain built without the underwater pass ignores this, which is what lets
   * the host call it unconditionally.
   */
  setSubmersion(amount: number, look?: { color?: string; density?: number }): void {
    if (!this.uwAmount) return;
    this.uwAmount.value = Math.max(0, Math.min(1, amount));
    if (look?.color) this.uwColor.value.set(look.color);
    if (look?.density !== undefined) this.uwDensity.value = Math.max(0, look.density);
  }

  /**
   * How hard it is blowing this frame, which way the wind runs ON SCREEN
   * (radians), and the grain's colour when the storm differs from the scene's
   * default — a white one is a blizzard. Uniform writes; never a rebuild.
   *
   * A chain built without the pass ignores this, so the host calls it
   * unconditionally.
   */
  setSandstorm(amount: number, angle: number, color?: string): void {
    if (!this.sandAmount) return;
    this.sandAmount.value = Math.max(0, Math.min(1, amount));
    this.sandAngle.value = angle;
    if (color) this.sandColor.value.set(color);
  }

  /** Per-frame uniform housekeeping. Cheap; call before every render. */
  update(): void {
    if (this.grainSeed) this.grainSeed.value = Math.random() * 1000;
    // A script recolouring a brazier has to recolour its shaft too; this is a
    // Color copy per shaft, and there is at most one.
    this.shafts?.refreshTints();
  }

  dispose(): void {
    for (const node of this.disposables) {
      try {
        node.dispose?.();
      } catch {
        // a node that fails to build can also fail to tear down; nothing here
        // is worth taking the frame loop down for
      }
    }
    this.disposables.length = 0;
    this.shafts = null;
  }
}

/**
 * `smoothstep(inner, outer, d)`: `radius` is the untouched fraction of the
 * half-diagonal, `smoothness` the width of the band after it. A zero-width band
 * would make smoothstep degenerate, so the edges are separated here on the CPU
 * rather than guarded per-pixel in the shader.
 */
function vignetteEdges(v: VignetteFx): [number, number] {
  const inner = Math.min(Math.max(v.radius, 0), 1);
  const outer = Math.min(inner + Math.max(v.smoothness, 0.001), 1.4143);
  return [inner, outer];
}

interface ResolvedLut {
  texture: THREE.Data3DTexture;
  size: number;
}

let lutWarned = false;

function resolveLut(fx: ResolvedPostFx, resolve: PostTextureResolver | null): ResolvedLut | null {
  const id = fx.grade.enabled ? fx.grade.lut : undefined;
  if (!id) return null;
  if (!resolve) {
    if (!lutWarned) {
      lutWarned = true;
      console.warn(
        `[render] postfx.grade.lut "${id}" ignored: no texture resolver is wired into EngineRenderer ` +
          "(setPostFxTextureResolver). The numeric grade knobs still apply.",
      );
    }
    return null;
  }
  const source = resolve(id);
  if (!source) return null;
  const lut = lut3DTextureFrom(source);
  if (!lut) {
    if (!lutWarned) {
      lutWarned = true;
      console.warn(
        `[render] postfx.grade.lut "${id}" is not a usable LUT image (expected an N x N*N strip or an ` +
          "N*N x N tile sheet, N a power of two up to 64).",
      );
    }
    return null;
  }
  return lut;
}

/** Test seam: the blame order used by reactive per-pass degradation. */
export function nextPassToBlame(
  plan: readonly PostPassId[],
  alreadyBlamed: ReadonlySet<PostPassId>,
): PostPassId | null {
  for (const id of BLAME_ORDER) {
    if (plan.includes(id) && !alreadyBlamed.has(id)) return id;
  }
  return null;
}
