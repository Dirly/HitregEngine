import { anchor, clamp, decalsFor, type M, type Preset, type PresetContext } from "./presets.js";

/**
 * Ground decals that GROW IN — the mark a spell leaves where it lands.
 *
 * A decal page stores when each texel appears, measured along the art from
 * the strike point, so these presets only choose which mark, how big, how
 * fast it spreads and how it goes: cracks race out and fade, vines creep and
 * withdraw, frost feathers across and melts back. The school picks the
 * sheet (its own marks, never another school's); the tags below only bias
 * which of its marks suits the moment.
 */

const volumeR = (ctx: PresetContext): number => Math.max(0.6, ctx.a.growTo ?? ctx.R);

/** Marks that suit what the spell DOES, before what it is made of. */
const EFFECT_TAGS: Record<string, string[]> = {
  root: ["vine", "root", "bramble", "chain", "thorn"],
  slow: ["frost", "ice", "ooze", "moss"],
  stun: ["crack", "shatter", "star"],
  heal: ["flower", "bloom", "ray", "feather", "halo"],
  shield: ["halo", "ring", "star", "mandala"],
  shadow: ["vein", "smoke", "ooze", "hand"],
};

/** Dark schools leave matter on the floor; bright ones leave light. */
const darkSchool = (ctx: PresetContext): boolean => ctx.element === "shadow" || ctx.element === "destruction";

/** Schools whose marks withdraw rather than fade: growth recedes, frost melts back, veins retract. */
const recedes = (ctx: PresetContext): boolean => ctx.element === "nature" || ctx.element === "water" || ctx.element === "shadow";

function pickDecal(ctx: PresetContext, extraTags: readonly string[] = []): { sheet: string; cell: [number, number]; aspect: number } | null {
  const list = decalsFor(ctx.catalog, ctx.element);
  if (list.length === 0) return null;
  const want = [...(EFFECT_TAGS[ctx.effect] ?? []), ...extraTags];
  const e = ctx.rng.weighted(list.map((d) => ({ w: 1 + d.tags.filter((t) => want.includes(t)).length * 2.5, v: d })));
  return { sheet: e.sheet, cell: e.cell, aspect: e.aspect ?? 1 };
}

function decal(
  ctx: PresetContext,
  opts: { size: number; grow: number; duration: number; fadeOut?: number; at?: M; delay?: number; tags?: readonly string[]; aspect?: number },
): M | null {
  const d = pickDecal(ctx, opts.tags);
  if (!d) return null;
  const dark = darkSchool(ctx);
  return {
    kind: "decal",
    sheet: d.sheet,
    cell: d.cell,
    size: opts.size,
    aspect: opts.aspect ?? d.aspect,
    grow: opts.grow,
    growEase: "out",
    edge: dark ? 0.12 : 0.08,
    edgeColor: dark ? "glow" : "#ffffff",
    shade: dark ? 0.5 : 0.7,
    color: dark ? "secondary" : "primary",
    blend: dark ? "normal" : "additive",
    opacity: dark ? 0.92 : 0.75,
    fadeOut: opts.fadeOut ?? 0.5,
    recede: recedes(ctx),
    randomYaw: true,
    drape: true,
    anchor: opts.at ?? anchor("ground"),
    delay: opts.delay ?? 0,
    duration: opts.duration,
    // the stepping reveal is already pixel art; band the alpha like the rest of the spell
    posterize: ctx.pixel > 0 ? 4 : 0,
  };
}

export const DECAL_PRESETS: readonly Preset[] = [
  {
    // the scar under a landing: sized to the blast, fast out, gone within the impact's tail
    id: "impact.scar",
    kind: "decal",
    slot: "scar",
    phases: ["impact"],
    kinds: ["projectile", "bolt", "beam", "area", "pulse", "melee", "summon"],
    needsDecal: true,
    weight: 2,
    build: (ctx) => {
      if (ctx.a.shape === "cone") return null; // a cone's mark is its wedge ring
      const line = ctx.a.shape === "line";
      const R = volumeR(ctx);
      return decal(ctx, {
        size: clamp(R * (line ? 1.6 : 2.2), 1.2, 14),
        aspect: line ? 0.45 : undefined,
        grow: clamp(0.2 + R * 0.08, 0.2, 0.8),
        duration: 1.3 + ctx.I * 1.0,
        fadeOut: 0.5,
        tags: line ? ["line", "crack", "fissure"] : [],
      });
    },
  },
  {
    // a lingering floor: the mark spreads across the volume while it holds, then withdraws
    id: "linger.scar",
    kind: "decal",
    slot: "scar",
    phases: ["linger"],
    kinds: ["zone", "area", "channel", "summon", "pulse"],
    needsDecal: true,
    weight: 2.2,
    build: (ctx) => {
      if (ctx.a.shape === "cone") return null;
      const R = volumeR(ctx);
      const hold = Math.max(0.8, ctx.phaseLength);
      return decal(ctx, {
        size: clamp(R * 2.1, 1.2, 16),
        aspect: ctx.a.shape === "line" ? 0.45 : undefined,
        grow: clamp(hold * 0.35, 0.4, 1.6),
        duration: hold,
        fadeOut: 0.7,
      });
    },
  },
  {
    // a slam or a war-cry cracks the floor at the caster's feet
    id: "cast.stompScar",
    kind: "decal",
    slot: "scar",
    phases: ["cast"],
    kinds: ["melee", "shout"],
    needsDecal: true,
    minI: 0.45,
    build: (ctx) =>
      decal(ctx, {
        size: clamp(1.6 + ctx.R * 0.8, 1.6, 5),
        grow: 0.25,
        duration: 1.2,
        fadeOut: 0.4,
        at: anchor("caster", { offset: [0, -0.85, 0] }),
        tags: ["crack", "shatter", "scorch", "splash", "ray"],
      }),
  },
];
