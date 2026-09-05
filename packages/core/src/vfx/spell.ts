import { z } from "zod";
import { hexColor } from "../components/core.js";
import { elementSchema, feelSchema, paletteFor, type Palette } from "./elements.js";
import { PHASES, vfxEffectSchema, type Phase, type VfxEffect } from "./modules.js";

/**
 * A spell, as data: an ELEMENT, an ARCHETYPE (the gameplay envelope — what
 * shape, how far, how long) and a set of PHASES, each an effect.
 *
 * The archetype is the reference every visual scales from. A 6m nova and a
 * 1.5m poke share presets; they differ in radius, and the generator sizes
 * sprites, rings, lights and particle counts off that number. That is the
 * whole answer to "the scale of this stuff should make sense": nothing is
 * sized in isolation.
 */

export const SPELL_KINDS = [
  "melee",
  "projectile",
  "bolt",
  "beam",
  "area",
  "zone",
  "channel",
  "pulse",
  "buff",
  "shout",
  "debuff",
  "summon",
  "portal",
] as const;
export type SpellKind = (typeof SPELL_KINDS)[number];
export const spellKindSchema = z.enum(SPELL_KINDS);

/** Plain-English meaning of each kind, for the lab and for agents. */
export const SPELL_KIND_NOTES: Record<SpellKind, string> = {
  melee: "short-range strike in front of the caster; resolves after a short windup",
  projectile: "long-range shot that travels and resolves on contact; can splash",
  bolt: "long-range hitscan — lightning or a flash-beam that lands the moment it fires",
  beam: "a sustained line from the caster to the target that ticks while held (roots the caster)",
  area: "a telegraphed volume at range that resolves once after its windup",
  zone: "a telegraphed volume that persists and ticks on its own after the cast",
  channel: "a telegraphed volume that persists and ticks while held (roots the caster)",
  pulse: "rhythmic nova waves radiating from the caster while held",
  buff: "a self-cast: gathers, bursts on the caster, leaves an aura for the duration",
  shout: "an instant burst from the caster outward — a war cry, a stomp, a repel",
  debuff: "a mark placed on the target that lingers on them",
  summon: "something rises out of the ground at the point and stays",
  portal: "a standing gateway opens at the point, holds, and closes",
};

export const STATUS_EFFECTS = ["damage", "root", "stun", "slow", "haste", "shield", "heal", "shadow"] as const;
export type StatusEffect = (typeof STATUS_EFFECTS)[number];
export const statusEffectSchema = z.enum(STATUS_EFFECTS);

export const spellArchetypeSchema = z.object({
  kind: spellKindSchema.default("area"),
  effect: statusEffectSchema
    .default("damage")
    .describe(
      "What the payload DOES, as a look: root (vines, chains, holds), stun (stars, chains overhead), slow (hourglass, drips), " +
        "haste (chevrons, speed lines), shield (hex wards), heal (crosses, rising motes), shadow (dark matter, fading).",
    ),
  channelled: z
    .boolean()
    .default(false)
    .describe(
      "buff/debuff: the aura holds for the duration while the caster channels, then fades. Off = the effect flashes " +
        "when it lands and lingers only briefly.",
    ),
  shape: z
    .enum(["circle", "cone", "line", "point"])
    .default("circle")
    .describe("The volume. point = no volume (a single target, the caster)."),
  radius: z
    .number()
    .min(0)
    .default(2)
    .describe("Metres. circle: radius; cone: reach; line: length; point: a body size. The REFERENCE size every visual scales from."),
  range: z.number().min(0).default(0).describe("Metres from the caster the volume is centred at. 0 = on the caster."),
  angle: z.number().min(5).max(180).default(60).describe("cone: half-angle, degrees."),
  width: z.number().positive().default(0.75).describe("line: half-width, metres."),
  windup: z.number().min(0).default(0.6).describe("Seconds from cast start to the payload resolving."),
  duration: z
    .number()
    .min(0)
    .default(0)
    .describe("Sustained kinds (beam, zone, channel, pulse, buff, summon, portal): seconds the effect holds."),
  ticksPerSecond: z.number().min(0).default(0).describe("Sustained kinds: payload applications per second."),
  speed: z.number().min(0).default(22).describe("projectile: metres/sec."),
  growTo: z.number().min(0).optional().describe("Lingering volumes that grow: the final radius."),
  height: z.number().positive().default(2.5).describe("Vertical extent of the volume, metres either side."),
  cooldown: z.number().min(0).default(6),
  intensity: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("How big a deal this spell is — drives module count, light, shake, and how much budget it may spend."),
});
export type SpellArchetype = z.infer<typeof spellArchetypeSchema>;

const phasesShape = Object.fromEntries(PHASES.map((p) => [p, vfxEffectSchema.optional()])) as Record<
  Phase,
  z.ZodOptional<typeof vfxEffectSchema>
>;

export const spellSchema = z.object({
  name: z.string().default("untitled"),
  note: z.string().default(""),
  element: elementSchema.default("arcane"),
  palette: z
    .object({ primary: hexColor, secondary: hexColor, glow: hexColor })
    .optional()
    .describe("Override the element's palette. Omitted = the element's own."),
  feel: z.array(feelSchema).default([]).describe("Aesthetic bias used when this spell was generated."),
  seed: z.number().int().default(0),
  archetype: spellArchetypeSchema.prefault({}),
  phases: z.object(phasesShape).prefault({}),
  /** Sprite catalog id used at generation time — provenance. */
  catalog: z.string().optional(),
});
export type SpellDoc = z.infer<typeof spellSchema>;

export function parseSpell(doc: unknown): SpellDoc {
  const parsed = spellSchema.safeParse(doc);
  if (!parsed.success) throw new Error(`spell: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function spellPalette(spell: Pick<SpellDoc, "element" | "palette">): Palette {
  return spell.palette ?? paletteFor(spell.element);
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

/** When each phase fires, in seconds from cast start, and how long it holds. */
export interface SpellTimeline {
  /** Telegraph appears at 0 and stays through `windup` + hold. */
  telegraph: { at: number; windup: number; hold: number } | null;
  charge: { at: number; duration: number } | null;
  cast: { at: number } | null;
  /** Projectiles: from cast until arrival. Beams/bolts: the line itself, for `duration`. */
  travel: { at: number; duration: number } | null;
  impact: { at: number } | null;
  /** Times of each tick after impact. */
  ticks: number[];
  linger: { at: number; duration: number } | null;
  end: { at: number } | null;
  /** Total length of the presentation. */
  total: number;
  /** Where the spell resolves relative to the caster: origin distance along facing. */
  reach: number;
}

const SUSTAINED: ReadonlySet<SpellKind> = new Set([
  "beam",
  "zone",
  "channel",
  "pulse",
  "buff",
  "summon",
  "portal",
  "debuff",
]);

export function isSustainedKind(kind: SpellKind): boolean {
  return SUSTAINED.has(kind);
}

/** Kinds whose volume is pre-declared on the ground. */
export function isTelegraphedKind(kind: SpellKind): boolean {
  return kind === "area" || kind === "zone" || kind === "channel" || kind === "summon";
}

export function spellTimeline(a: SpellArchetype): SpellTimeline {
  const windup = a.windup;
  const duration = isSustainedKind(a.kind) ? a.duration : 0;
  const telegraphed = isTelegraphedKind(a.kind);
  const projectile = a.kind === "projectile";
  const reach = a.kind === "melee" || a.kind === "buff" || a.kind === "shout" || a.kind === "pulse" ? 0 : a.range;
  const flight = projectile ? Math.max(0, reach) / Math.max(1, a.speed) : 0;
  const impactAt = windup + flight;
  const lingerAt = impactAt;
  const ticks: number[] = [];
  if (duration > 0 && a.ticksPerSecond > 0) {
    const step = 1 / a.ticksPerSecond;
    for (let t = step; t <= duration + 1e-6; t += step) ticks.push(lingerAt + t);
  }
  const endAt = lingerAt + duration;
  const hold = telegraphed ? duration : 0;
  return {
    telegraph: telegraphed ? { at: 0, windup, hold } : null,
    charge: windup > 0 ? { at: 0, duration: windup } : null,
    cast: { at: windup },
    travel: projectile
      ? { at: windup, duration: flight }
      : a.kind === "beam"
        ? { at: windup, duration }
        : a.kind === "bolt"
          ? { at: windup, duration: 0 }
          : null,
    impact: { at: impactAt },
    ticks,
    linger: duration > 0 ? { at: lingerAt, duration } : null,
    end: duration > 0 ? { at: endAt } : null,
    total: endAt + 2.5,
    reach,
  };
}

/** Which phases a kind makes use of — the generator fills exactly these. */
export function phasesForKind(a: SpellArchetype): Phase[] {
  const t = spellTimeline(a);
  const out: Phase[] = [];
  if (t.telegraph) out.push("telegraph");
  if (t.charge && a.windup >= 0.25) out.push("charge");
  out.push("cast");
  if (t.travel) out.push("travel");
  out.push("impact");
  if (t.ticks.length > 0) out.push("tick");
  if (t.linger) out.push("linger");
  if (t.end) out.push("end");
  return out;
}

/** The effect a spell plays at a phase, or null when it has none. */
export function phaseEffect(spell: SpellDoc, phase: Phase): VfxEffect | null {
  return spell.phases[phase] ?? null;
}
