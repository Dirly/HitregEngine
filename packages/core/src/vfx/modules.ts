import { z } from "zod";
import { particlesSchema, vec3 } from "../components/core.js";
import { feelSchema } from "./elements.js";

/**
 * VFX modules — the hand-authored vocabulary a generated spell is composed
 * from.
 *
 * Every module is a registered Zod schema, for the same reason components are:
 * the schema validates the file, drives the lab's knobs, rides into
 * `spec.json` so an agent knows what is legal, and — the part that matters
 * here — tells the GENERATOR what it may vary. Nothing in this file renders;
 * `@hitreg/render`'s VfxSystem turns each kind into geometry and TSL nodes.
 *
 * The vocabulary is deliberately small and orthogonal. A pillar of light, a
 * breath cone and a hanging beam of judgement are all one `column` with
 * different knobs; a portal is a vertical `ring` with a swirl plus a `shell`;
 * a summon is a `mesh` rising through a ground `ring`. Composing a few strong
 * primitives beats a long list of one-off effects, because a generator can
 * only ever recombine what it is given.
 */

const unitT = z.number().min(0).max(1);
/** [[t, value], …] over normalized life. */
export const curveSchema = z.array(z.tuple([unitT, z.number().min(0)])).min(1);
/** [[t, 0..1], …] over normalized life. */
export const unitCurveSchema = z.array(z.tuple([unitT, unitT])).min(1);
export type Curve = z.infer<typeof curveSchema>;

export const ANCHORS = ["origin", "caster", "target", "path", "ground"] as const;
export type AnchorAt = (typeof ANCHORS)[number];

export const anchorSchema = z.object({
  at: z
    .enum(ANCHORS)
    .default("origin")
    .describe(
      "origin = where the spell resolves (the volume's centre, the impact point); caster = the casting body; " +
        "target = the targeted body or point; path = the projectile in flight (travel phase); ground = origin " +
        "projected onto the terrain.",
    ),
  socket: z
    .string()
    .optional()
    .describe(
      "caster/target only: a named attach point — rightHand, leftHand, chest, head, feet — resolved by the host " +
        "to a bone-socket entity under that body. A missing socket falls back to the body itself.",
    ),
  offset: vec3
    .default([0, 0, 0])
    .describe("metres in the anchor's own frame: x right, y up, z FORWARD along the spell direction."),
  follow: z
    .boolean()
    .default(false)
    .describe(
      "Keep tracking the anchor for the module's whole life (a hand mid-swing, a projectile in flight) " +
        "instead of sampling it once at start.",
    ),
});
export type Anchor = z.infer<typeof anchorSchema>;

const colorRef = z
  .string()
  .default("primary")
  .describe('"primary" | "secondary" | "glow" (the spell palette) or a #rrggbb override.');

/**
 * Fields every module shares. `duration: 0` means "natural length": a
 * flipbook's own frame count, a burst's longest particle, or for sustained
 * kinds the length of the phase that plays it.
 */
const moduleBase = {
  id: z.string().optional().describe("Stable key so a human tweak or an agent's note can name this module."),
  preset: z
    .string()
    .optional()
    .describe("The library preset this came from — provenance for tweak-and-regenerate, never read at runtime."),
  anchor: anchorSchema.prefault({}),
  delay: z.number().min(0).default(0).describe("Seconds after the phase starts."),
  duration: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Seconds it lives. 0 = natural length (a flipbook's frames, a burst's longest particle) or, for " +
        "sustained kinds, the phase length.",
    ),
  color: colorRef,
  colorEnd: z
    .string()
    .default("secondary")
    .describe("Where colour fades toward over life, for kinds that fade (particles, trail, beam core)."),
  blend: z
    .enum(["additive", "normal"])
    .default("additive")
    .describe("additive = light (nearly everything magical); normal = matter that occludes (smoke, a poison cloud)."),
  opacity: z.number().min(0).max(1).default(1),
  opacityCurve: unitCurveSchema.optional().describe("[[t, opacity]] over life, multiplied with `opacity`."),
  pixel: z
    .number()
    .min(0)
    .max(256)
    .default(0)
    .describe(
      "PSX look: quantise the procedural shading to this many cells across the shape (0 = off, 16–32 reads as " +
        "pixel art). Rings, shells, columns and beams snap their noise and bands to the grid; masks and sprites " +
        "switch to nearest filtering.",
    ),
  posterize: z
    .number()
    .int()
    .min(0)
    .max(16)
    .default(0)
    .describe("Alpha steps (0 = smooth). 3–5 turns soft falloffs into hard bands — the other half of the PSX look."),
  sizeCurve: curveSchema.optional().describe("[[t, multiplier]] over life, on top of the module's own size."),
  repeat: z
    .object({
      count: z.number().int().min(1).max(24).default(1).describe("Copies played. 1 = the module plays once."),
      every: z.number().min(0).default(0).describe("Seconds between copies — the STEP. Nothing tweens between them; each copy appears whole."),
      step: vec3
        .default([0, 0, 0])
        .describe(
          "Metres each copy moves on from the last, in the spell frame (x right, y up, z forward): [0,0,1.4] marches " +
            "spikes away from the caster, [0,0.5,0] stacks rings into a column.",
        ),
      turn: z
        .number()
        .default(0)
        .describe(
          "Degrees each copy is turned around the anchor's up axis relative to the last. With `step` [0,0,r] and " +
            "turn 360/count the copies stand in a circle; on an orbiting sprite it advances the orbit phase instead.",
        ),
      alternate: z.boolean().default(false).describe("Flip the spin (and a slash's tilt) on every other copy — a column of circles turning against each other."),
      scale: z.number().positive().default(1).describe("Size multiplier applied per copy: 0.85 tapers a stack, 1.3 steps a shockwave outward."),
      jitter: z.number().min(0).default(0).describe("Metres of seeded horizontal scatter added to each copy."),
    })
    .prefault({})
    .describe(
      "Play this module as a STEPPING sequence — spikes that erupt one after another along the strike, a column of " +
        "circles, glyphs spread around the caster. The sequencer expands it into `count` copies; the audit counts them.",
    ),
};

// ---------------------------------------------------------------------------
// module kinds
// ---------------------------------------------------------------------------

export const spriteModuleSchema = z.object({
  kind: z.literal("sprite"),
  ...moduleBase,
  sheet: z
    .string()
    .describe("Spritesheet data-asset id. Its grid is the flipbook: columns are frames, rows are colour variants."),
  row: z
    .number()
    .int()
    .min(0)
    .default(5)
    .describe("Sheet row. 5 is the greyscale variant in the purchased library — leave it and let `color` tint."),
  fps: z.number().positive().default(22),
  loop: z.boolean().default(false),
  size: z.number().positive().default(1).describe("Metres — the quad's width; height follows `aspect`."),
  aspect: z.number().positive().default(1),
  orient: z
    .enum(["billboard", "ground", "vertical", "facing", "velocity"])
    .default("billboard")
    .describe(
      "billboard faces the camera; ground lies flat (marks, runes); vertical stands upright and yaws toward " +
        "the camera (a slash, a wave); facing stands upright with its face along the spell direction (a portal); " +
        "velocity aligns with the anchor's motion.",
    ),
  spin: z
    .number()
    .default(0)
    .describe(
      "Radians/sec the quad turns in its own plane. Lying on the ground that is a yaw; standing up it is a roll " +
        "around a horizontal axis, which reads wrong on most symbols — the symbol catalog says which may.",
    ),
  yaw: z.number().default(0).describe("Fixed rotation around the facing axis, radians."),
  randomYaw: z.boolean().default(false).describe("Roll `yaw` per play — cheap variety for repeated impacts."),
  cell: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .optional()
    .describe(
      "[col, row] of ONE sheet cell shown as a static SYMBOL (a sigil, a glyph, an arrow) instead of playing the " +
        "sheet as a flipbook. `fps`/`loop` are ignored; the symbol lives for `duration` (0 = the phase, or 0.6 s).",
    ),
  orbit: z.number().min(0).default(0).describe("Metres the quad circles the anchor at, around its up axis. 0 = sits on the anchor."),
  orbitSpeed: z.number().default(0).describe("Radians/sec along the orbit; negative runs the other way."),
  orbitPhase: z.number().default(0).describe("Starting angle on the orbit, radians (0 = in front of the anchor). `repeat.turn` advances it per copy."),
});

export const particlesModuleSchema = z.object({
  kind: z.literal("particles"),
  ...moduleBase,
  emitter: particlesSchema
    .prefault({})
    .describe(
      "The emitter, in the `particles` component's own vocabulary. colorStart/colorEnd are overridden by the " +
        "module's `color`/`colorEnd` unless they are left white.",
    ),
  burst: z.number().int().min(0).default(0).describe("Particles spawned the moment the module starts."),
  stream: z
    .boolean()
    .default(false)
    .describe("Keep emitting at the emitter's `rate` for the module's duration — channels, trails, auras."),
});

export const ringModuleSchema = z.object({
  kind: z.literal("ring"),
  ...moduleBase,
  radius: z.number().positive().default(2).describe("Outer radius in metres at scale 1."),
  inner: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("Inner radius as a fraction of the outer. 0 = a filled disc (a rune, a portal floor)."),
  orient: z
    .enum(["ground", "vertical", "facing", "billboard"])
    .default("ground")
    .describe(
      "ground lies on the terrain; vertical stands upright yawed toward the camera; facing stands upright " +
        "with its face along the spell direction (a portal); billboard faces the camera.",
    ),
  expand: z
    .tuple([z.number().min(0), z.number().min(0)])
    .default([0.1, 1])
    .describe("Scale at birth and at death: a shockwave runs 0.1 → 1, a rune holds 1 → 1. `sizeCurve` overrides."),
  ease: z.enum(["out", "in", "linear"]).default("out"),
  soft: z
    .number()
    .min(0)
    .max(1)
    .default(0.35)
    .describe("Edge softness. 0 is a hard band; 1 fades across the whole width."),
  texture: z
    .string()
    .optional()
    .describe("Texture asset id laid across the disc (a rune, a sigil). Omitted = a procedural soft band."),
  spin: z.number().default(0).describe("Radians/sec."),
  arc: z
    .number()
    .min(5)
    .max(360)
    .default(360)
    .describe("Degrees of the disc that are drawn, centred on the spell direction: 360 is a full ring, 90 a wedge in front of the caster."),
  noise: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Breaks the band with scrolling noise so it reads as energy rather than a drawn circle."),
  swirl: z
    .number()
    .min(0)
    .default(0)
    .describe("Spiral distortion strength — the portal look. 0 = none."),
  drape: z
    .boolean()
    .default(true)
    .describe("Ground rings follow the terrain under them (needs the host's ground probe)."),
  height: z.number().default(0).describe("Vertical/billboard: metres above the anchor the centre sits."),
});

export const shellModuleSchema = z.object({
  kind: z.literal("shell"),
  ...moduleBase,
  radius: z.number().positive().default(1),
  style: z
    .enum(["energy", "glass", "smoke", "wire"])
    .default("energy")
    .describe(
      "energy = noisy fresnel rim (barriers, orbs, charge-ups); glass = clean thin rim (bubbles, wards); " +
        "smoke = dense normal-blended body (a cloud, a void); wire = a lattice of noise lines (arcane cages).",
    ),
  fresnel: z.number().min(0).default(2).describe("Rim power — higher is a thinner, brighter edge. 0 = flat."),
  noise: z.number().min(0).max(1).default(0.5).describe("How much scrolling 3D noise breaks the surface."),
  noiseScale: z.number().positive().default(2),
  noiseSpeed: z.number().default(0.6),
  dissolve: unitCurveSchema
    .optional()
    .describe(
      "[[t, threshold]] — the surface burns away where noise < threshold. A curve 0 → 1 is a shell that " +
        "dissolves as it dies; 1 → 0 is one that assembles.",
    ),
  spin: z.number().default(0),
  squash: z.number().positive().default(1).describe("Vertical scale: a dome on the ground is ~0.6, a tall bubble 1.4."),
  expand: z.tuple([z.number().min(0), z.number().min(0)]).default([1, 1]),
});

export const columnModuleSchema = z.object({
  kind: z.literal("column"),
  ...moduleBase,
  radius: z.number().positive().default(1).describe("Base radius, metres."),
  topRadius: z
    .number()
    .min(0)
    .optional()
    .describe("Radius at the far end. Omitted = same as `radius` (a pillar); 0 = a cone to a point."),
  height: z.number().positive().default(4),
  orient: z
    .enum(["up", "forward", "down"])
    .default("up")
    .describe(
      "up = a pillar out of the ground; forward = a cone along the spell direction (breath, spray); " +
        "down = hanging from the sky onto the anchor.",
    ),
  scroll: z.number().default(1.2).describe("Noise scroll speed along the axis; positive = base → far end."),
  noise: z.number().min(0).max(1).default(0.6),
  noiseScale: z.number().positive().default(1.5),
  edgeFade: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe("Fade at the silhouette so the tube has no hard vertical edges."),
  capFade: z
    .tuple([unitT, unitT])
    .default([0.15, 0.4])
    .describe("Fraction of the height faded out at the base and at the far end."),
  spin: z.number().default(0.5),
  expand: z.tuple([z.number().min(0), z.number().min(0)]).default([1, 1]),
});

export const beamModuleSchema = z.object({
  kind: z.literal("beam"),
  ...moduleBase,
  length: z
    .number()
    .positive()
    .default(12)
    .describe("Metres along the spell direction when there is no target (or `toTarget` is off)."),
  toTarget: z.boolean().default(true).describe("Span anchor → target when the frame has one."),
  width: z.number().positive().default(0.5).describe("Glow diameter, metres."),
  core: z.number().min(0).max(1).default(0.35).describe("Bright inner core as a fraction of width. 0 = none."),
  style: z
    .enum(["energy", "laser", "plasma"])
    .default("energy")
    .describe("energy = soft noisy glow; laser = hard clean edge; plasma = fat writhing body."),
  scroll: z.number().default(4).describe("Noise scroll speed toward the far end, metres/sec."),
  noise: z.number().min(0).max(1).default(0.5),
  pulse: z.number().min(0).default(3).describe("Width pulse, Hz."),
  pulseDepth: z.number().min(0).max(1).default(0.2),
  taper: z.number().min(0).max(1).default(0).describe("Narrow toward the far end."),
});

export const boltModuleSchema = z.object({
  kind: z.literal("bolt"),
  ...moduleBase,
  length: z.number().positive().default(10),
  toTarget: z.boolean().default(true),
  width: z.number().positive().default(0.18),
  segments: z.number().int().min(2).max(64).default(14),
  jitter: z.number().min(0).default(0.6).describe("Metres of sideways displacement per segment."),
  refreshHz: z.number().positive().default(24).describe("How often the path re-rolls — the flicker."),
  branches: z.number().int().min(0).max(8).default(2),
  branchLength: z.number().min(0).max(1).default(0.35).describe("Fraction of the main length."),
  count: z.number().int().min(1).max(6).default(1).describe("Independent strands, each with its own path — a channelled storm rather than one arc."),
  spread: z.number().min(0).default(0).describe("count > 1: metres the far ends scatter around the target."),
  core: z.number().min(0).max(1).default(0.4),
  arc: z
    .enum(["line", "sky", "ground"])
    .default("line")
    .describe(
      "line = anchor to target/direction; sky = strikes DOWN onto the anchor from `length` metres up; " +
        "ground = crawls along the terrain outward from the anchor in a random direction.",
    ),
  flicker: z.number().min(0).max(1).default(0.4).describe("Opacity flicker depth."),
});

export const lightModuleSchema = z.object({
  kind: z.literal("light"),
  ...moduleBase,
  intensity: z.number().min(0).default(40),
  range: z.number().positive().default(8).describe("Metres."),
  intensityCurve: curveSchema
    .optional()
    .describe("[[t, multiplier]]. Default is a flash: spike, then decay."),
  flicker: z.number().min(0).max(1).default(0),
});

export const meshModuleSchema = z.object({
  kind: z.literal("mesh"),
  ...moduleBase,
  asset: z.string().optional().describe("Model asset id. Omitted = the procedural `primitive`."),
  primitive: z
    .enum(["rock", "crystal", "spike", "orb", "blade"])
    .default("crystal")
    .describe("Procedural bodies for when no model is given."),
  size: z.number().positive().default(1).describe("Metres, longest extent."),
  motion: z
    .enum(["drop", "rise", "hover", "orbit", "launch", "forward"])
    .default("rise")
    .describe(
      "drop = falls from `from` metres up and lands as the module ends; rise = comes up out of the ground; " +
        "hover = bobs in place; orbit = circles the anchor; launch = flies up and away; forward = glides " +
        "`from` metres along the spell direction (a projection, an afterimage).",
    ),
  from: z.number().min(0).default(0).describe("drop: start height above the anchor; rise: depth below it. 0 = auto."),
  spin: z.number().default(1),
  count: z.number().int().min(1).max(12).default(1),
  spread: z.number().min(0).default(0).describe("count > 1: radius they scatter or orbit within."),
  emissive: z.number().min(0).default(1.5).describe("Glow strength of the tint."),
  tint: z.boolean().default(true).describe("Colour the body with the palette; off keeps the asset's own material."),
});

export const trailModuleSchema = z.object({
  kind: z.literal("trail"),
  ...moduleBase,
  width: z.number().positive().default(0.35),
  length: z.number().positive().default(0.35).describe("Seconds of history the ribbon covers."),
  taper: z.boolean().default(true),
});

export const telegraphModuleSchema = z.object({
  kind: z.literal("telegraph"),
  ...moduleBase,
  shape: z.enum(["circle", "cone", "line"]).default("circle"),
  radius: z.number().positive().default(3).describe("circle: radius; cone: reach; line: length. Metres."),
  angle: z.number().min(5).max(180).default(60).describe("cone: half-angle, degrees."),
  width: z.number().positive().default(0.75).describe("line: half-width."),
  windup: z
    .number()
    .min(0)
    .default(0.8)
    .describe("Seconds the fill takes to reach the rim — the clock the target reads."),
  hold: z.number().min(0).default(0).describe("Seconds the volume stays live after the windup."),
  growFrom: z
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Live volumes that GROW: scale at the start of the hold, reaching 1 at its end."),
  curtain: z.number().min(0).default(0).describe("Height of the vertical curtain, metres. 0 = auto from radius."),
  rim: z.number().positive().default(0.34).describe("Rim band width, metres."),
  fillOpacity: unitT.default(0.22),
  rimOpacity: unitT.default(0.7).describe("The rim is the only number a dodge is judged against — keep it the brightest part, but not blown out."),
  curtainOpacity: unitT.default(0.2),
  dash: z
    .number()
    .min(0)
    .default(0.5)
    .describe("Rim dashing, 0..1: 0 is a solid band, 0.5 draws dashes as long as their gaps — the PSX marker look."),
  height: z
    .number()
    .positive()
    .default(2.5)
    .describe("Vertical extent the drape is clamped to — keep it equal to the hit test's `delivery.height`."),
});

export const slashModuleSchema = z.object({
  kind: z.literal("slash"),
  ...moduleBase,
  radius: z.number().positive().default(2).describe("Outer reach of the arc, metres."),
  inner: z
    .number()
    .min(0)
    .max(1)
    .default(0.45)
    .describe("Inner radius as a fraction of the outer: near 1 a thin crescent, near 0 a fat cleave."),
  sweep: z.number().min(10).max(360).default(140).describe("Degrees the arc covers, centred on the spell direction."),
  tilt: z
    .number()
    .min(-180)
    .max(180)
    .default(0)
    .describe("Roll of the cutting plane around the spell direction: 0 = a horizontal cleave, 90 = a vertical overhead chop, ±45 diagonal."),
  reverse: z.boolean().default(false).describe("Sweep the other way (right-to-left for a cleave, bottom-to-top for a chop)."),
  sweepTime: unitT.default(0.5).describe("Fraction of the life the leading edge takes to cross the arc; the rest is the tail fading out."),
  tail: unitT.default(0.55).describe("Length of the trailing fade behind the leading edge, as a fraction of the sweep."),
  soft: unitT.default(0.25).describe("Edge softness of the band."),
  height: z.number().default(1).describe("Metres above the anchor the arc's centre sits (chest height for a cleave)."),
  core: unitT.default(0.6).describe("How bright the leading edge is, toward the glow colour."),
});

export const shakeModuleSchema = z.object({
  kind: z.literal("shake"),
  ...moduleBase,
  strength: z.number().min(0).default(0.15).describe("Metres of camera displacement at full strength."),
  frequency: z.number().positive().default(18),
});

export const soundModuleSchema = z.object({
  kind: z.literal("sound"),
  ...moduleBase,
  asset: z.string().describe("Sound asset id."),
  volume: z.number().min(0).max(2).default(1),
});

export const vfxModuleSchema = z.discriminatedUnion("kind", [
  spriteModuleSchema,
  particlesModuleSchema,
  ringModuleSchema,
  shellModuleSchema,
  columnModuleSchema,
  beamModuleSchema,
  boltModuleSchema,
  lightModuleSchema,
  meshModuleSchema,
  trailModuleSchema,
  telegraphModuleSchema,
  slashModuleSchema,
  shakeModuleSchema,
  soundModuleSchema,
]);
export type VfxModule = z.infer<typeof vfxModuleSchema>;
export type VfxModuleKind = VfxModule["kind"];
export type VfxModuleOf<K extends VfxModuleKind> = Extract<VfxModule, { kind: K }>;

export const VFX_MODULE_KINDS = [
  "sprite",
  "particles",
  "ring",
  "shell",
  "column",
  "beam",
  "bolt",
  "light",
  "mesh",
  "trail",
  "telegraph",
  "slash",
  "shake",
  "sound",
] as const satisfies readonly VfxModuleKind[];

/** Per-kind schema, for the lab's knob rendering and for the generator's envelopes. */
export const VFX_MODULE_SCHEMAS: Record<VfxModuleKind, z.ZodObject<z.ZodRawShape>> = {
  sprite: spriteModuleSchema,
  particles: particlesModuleSchema,
  ring: ringModuleSchema,
  shell: shellModuleSchema,
  column: columnModuleSchema,
  beam: beamModuleSchema,
  bolt: boltModuleSchema,
  light: lightModuleSchema,
  mesh: meshModuleSchema,
  trail: trailModuleSchema,
  telegraph: telegraphModuleSchema,
  slash: slashModuleSchema,
  shake: shakeModuleSchema,
  sound: soundModuleSchema,
};

// ---------------------------------------------------------------------------
// effects and phases
// ---------------------------------------------------------------------------

/**
 * The moments of a spell. A phase is where a module list plugs into the
 * timeline; the sequencer in @hitreg/render decides WHEN each fires from the
 * archetype (see `spellTimeline`).
 */
export const PHASES = [
  "telegraph",
  "charge",
  "cast",
  "travel",
  "impact",
  "tick",
  "linger",
  "end",
] as const;
export type Phase = (typeof PHASES)[number];
export const phaseSchema = z.enum(PHASES);

export const vfxEffectSchema = z.object({
  name: z.string().default(""),
  tags: z
    .object({
      role: phaseSchema.optional(),
      feel: z.array(feelSchema).default([]),
    })
    .prefault({}),
  modules: z.array(vfxModuleSchema).default([]),
});
export type VfxEffect = z.infer<typeof vfxEffectSchema>;

/** Parse an untrusted effect document; throws with a readable message. */
export function parseVfxEffect(doc: unknown): VfxEffect {
  const parsed = vfxEffectSchema.safeParse(doc);
  if (!parsed.success) throw new Error(`vfx effect: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Fill a partial module with its schema defaults (the lab's "add module" path). */
export function completeModule(module: { kind: VfxModuleKind } & Record<string, unknown>): VfxModule {
  return vfxModuleSchema.parse(module);
}
