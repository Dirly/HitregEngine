import { anchor, clamp, feelOf, ring, sprite, symbolSprite, type M, type Preset, type PresetContext } from "./presets.js";
import { elementMaskTags, maskFor } from "./presets-more.js";

/**
 * Third pass of the library, from Derek's notes on the second in the lab:
 *
 * - SYMBOLS. A drawn sigil, glyph, star or arrow from the project's symbol
 *   sheets, laid under a caster, stood in front of a charge-up, orbiting a
 *   body, riding a projectile, stuck in the ground after it lands. Every
 *   symbol carries the rules a human dictated — which orientations it may be
 *   drawn in and whether it may turn — because a chevron rolling around a
 *   horizontal axis reads wrong and nobody wants to explain that to a
 *   generator twice.
 * - SLASHES. Melee had a sprite and a cone; now it has a real cut — a leading
 *   edge sweeping a sector with a fading tail, horizontal, vertical, diagonal
 *   or crossed.
 * - STEPS. Nothing tweens: spikes ERUPT one after another along a strike,
 *   fire pops in a line, rings appear each larger than the last, a column of
 *   circles stacks up. All of it is `repeat`, so the documents stay small and
 *   the audit counts every copy.
 */

const onBody = (ctx: PresetContext): boolean => ctx.at === "caster" || ctx.at === "target";
const volumeR = (ctx: PresetContext): number => Math.max(0.6, ctx.a.growTo ?? ctx.R);
/** The ground under the phase's anchor: a body's feet, or the volume's floor. */
function groundAt(ctx: PresetContext, y = 0): M {
  if (ctx.at === "caster") return anchor("caster", { offset: [0, -0.85 + y, 0], follow: true });
  if (ctx.at === "target") return anchor("target", { offset: [0, -0.85 + y, 0], follow: true });
  return anchor("ground", { offset: [0, y, 0] });
}
/** Is the strike a line the steps should march along (cone / line), or a circle to erupt around? */
const marching = (ctx: PresetContext): boolean => ctx.a.shape === "cone" || ctx.a.shape === "line";
/** Symbol tags that suit the element, for marks and sigils. */
function elementSymbolTags(ctx: PresetContext): string[] {
  const byElement: Record<string, string[]> = {
    fire: ["flame", "sun", "burst", "star"],
    arcane: ["rune", "circle", "eye", "spiral"],
    ice: ["star", "circle", "crystal"],
    nature: ["spiral", "leaf", "circle"],
    earth: ["triangle", "circle", "square"],
    holy: ["sun", "star", "cross", "circle"],
    rose: ["circle", "spiral", "moon"],
    blood: ["moon", "crescent", "hand"],
    void: ["eye", "moon", "spiral"],
    storm: ["star", "bolt", "spiral"],
    shadow: ["eye", "moon", "hand"],
  };
  return byElement[ctx.element] ?? [];
}

export const SYMBOL_PRESETS: readonly Preset[] = [
  // ----- sigils: symbols on the ground and in the air ----------------------
  {
    id: "telegraph.symbolSigil",
    kind: "sprite",
    slot: "sigil",
    phases: ["telegraph"],
    needsSymbol: ["sigil"],
    weight: 2.2,
    build: (ctx) =>
      symbolSprite(ctx, ["sigil"], {
        tags: elementSymbolTags(ctx),
        size: volumeR(ctx) * 1.7,
        orient: "ground",
        at: anchor("ground", { offset: [0, 0.06, 0] }),
        duration: ctx.a.windup + ctx.a.duration,
        spin: feelOf(ctx, "sharp") ? 0.6 : 0.25,
        opacity: 0.55,
        sizeCurve: [[0, 0.6], [0.25, 1], [1, 1]],
        opacityCurve: [[0, 0], [0.15, 1], [0.9, 1], [1, 0]],
      }),
  },
  {
    id: "charge.symbolSigil",
    kind: "sprite",
    slot: "sigil",
    phases: ["charge"],
    needsSymbol: ["sigil"],
    weight: 2.4,
    build: (ctx) =>
      symbolSprite(ctx, ["sigil"], {
        tags: elementSymbolTags(ctx),
        size: clamp(1.9 + ctx.R * 0.25, 1.9, 3.2),
        orient: "ground",
        at: anchor("caster", { offset: [0, -0.85, 0], follow: true }),
        duration: ctx.phaseLength,
        spin: 1.1,
        opacity: 0.75,
        sizeCurve: [[0, 0.5], [0.3, 1], [1, 1]],
        opacityCurve: [[0, 0], [0.2, 1], [0.9, 1], [1, 0]],
      }),
  },
  {
    id: "charge.frontSigil",
    kind: "sprite",
    slot: "core",
    phases: ["charge"],
    needsSymbol: ["sigil"],
    weight: 1.6,
    build: (ctx) =>
      symbolSprite(ctx, ["sigil"], {
        tags: elementSymbolTags(ctx),
        size: clamp(1.2 + ctx.R * 0.15, 1.2, 2),
        orient: "facing",
        at: anchor("caster", { offset: [0, 0.95, 0.8], follow: true }),
        duration: ctx.phaseLength,
        spin: feelOf(ctx, "sharp") ? 2 : 1.2,
        opacity: 0.85,
        color: "glow",
        sizeCurve: [[0, 0.3], [0.25, 1], [1, 1]],
        opacityCurve: [[0, 0], [0.15, 1], [0.9, 1], [1, 0]],
      }),
  },
  {
    id: "charge.orbitGlyphs",
    kind: "sprite",
    slot: "gather",
    phases: ["charge"],
    needsSymbol: ["glyph", "star"],
    weight: 1.5,
    build: (ctx) => {
      const count = 3 + Math.round(ctx.I * 2);
      return symbolSprite(ctx, ["glyph", "star"], {
        tags: elementSymbolTags(ctx),
        size: 0.38,
        orient: "facing",
        at: anchor("caster", { offset: [0, 0.9, 0], follow: true }),
        orbit: 0.85,
        orbitSpeed: feelOf(ctx, "sharp") ? 3.2 : 2.2,
        duration: ctx.phaseLength,
        opacity: 0.95,
        color: "glow",
        opacityCurve: [[0, 0], [0.15, 1], [0.9, 1], [1, 0]],
        repeat: { count, turn: 360 / count },
      });
    },
  },
  {
    id: "impact.symbolMark",
    kind: "sprite",
    slot: "ground",
    phases: ["impact"],
    needsSymbol: ["mark", "star", "sigil"],
    weight: 1.8,
    build: (ctx) =>
      symbolSprite(ctx, ["mark", "star", "sigil"], {
        tags: elementSymbolTags(ctx),
        size: clamp(ctx.R * 1.8, 1.2, 12),
        orient: "ground",
        at: groundAt(ctx, 0.08),
        duration: clamp(0.6 + ctx.I * 0.8, 0.6, 1.6),
        spin: ctx.rng.chance(0.5) ? 0 : 1.2,
        opacity: 0.95,
        sizeCurve: [[0, 0.4], [0.15, 1], [1, 1.05]],
        opacityCurve: [[0, 1], [0.5, 0.9], [1, 0]],
      }),
  },
  {
    id: "linger.symbolFloor",
    kind: "sprite",
    slot: "ground",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse", "summon", "portal", "beam"],
    needsSymbol: ["sigil"],
    weight: 2,
    build: (ctx) =>
      symbolSprite(ctx, ["sigil"], {
        tags: elementSymbolTags(ctx),
        size: volumeR(ctx) * (ctx.kind === "beam" ? 1.2 : 1.9),
        orient: "ground",
        at: ctx.kind === "beam" ? anchor("ground", { offset: [0, 0.05, 0], follow: true }) : groundAt(ctx, 0.05),
        duration: ctx.phaseLength,
        spin: feelOf(ctx, "sharp") ? 1.2 : 0.4,
        opacity: 0.7,
        ...(ctx.a.growTo && ctx.a.growTo > ctx.a.radius ? { sizeCurve: [[0, ctx.a.radius / ctx.a.growTo], [1, 1]] } : {}),
        opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
      }),
  },
  {
    id: "linger.symbolStack",
    kind: "sprite",
    slot: "aura",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse", "summon", "buff", "portal"],
    needsSymbol: ["sigil"],
    weight: 1.4,
    build: (ctx) => {
      const R = onBody(ctx) ? 1.0 : volumeR(ctx) * 0.75;
      const count = onBody(ctx) ? 3 : clamp(3 + Math.round(ctx.I * 3), 3, 6);
      const rise = onBody(ctx) ? 0.55 : clamp(0.35 + R * 0.12, 0.4, 0.9);
      return symbolSprite(ctx, ["sigil"], {
        tags: ["circle", "ring", ...elementSymbolTags(ctx)],
        size: R * 2,
        orient: "ground",
        at: onBody(ctx) ? groundAt(ctx, 0.15) : anchor("ground", { offset: [0, 0.25, 0] }),
        duration: ctx.phaseLength,
        spin: feelOf(ctx, "sharp") ? 1.8 : 0.9,
        opacity: 0.65,
        opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
        repeat: { count, every: 0.07, step: [0, rise, 0], alternate: true, scale: 0.86 },
      });
    },
  },

  // ----- projectiles: a symbol at the front, and left stuck in the ground ----
  {
    id: "travel.symbolHead",
    kind: "sprite",
    slot: "head",
    phases: ["travel"],
    kinds: ["projectile"],
    needsSymbol: ["head"],
    weight: 2.5,
    build: (ctx) =>
      symbolSprite(ctx, ["head"], {
        tags: elementSymbolTags(ctx),
        size: clamp(0.7 + ctx.R * 0.35, 0.7, 1.8),
        orient: "velocity",
        at: anchor("path", { follow: true }),
        duration: ctx.phaseLength,
        color: "glow",
      }),
  },
  {
    id: "impact.stuck",
    kind: "sprite",
    slot: "thing",
    phases: ["impact"],
    kinds: ["projectile"],
    needsSymbol: ["stuck"],
    weight: 3,
    build: (ctx) => {
      const size = clamp(ctx.R * 1.1, 0.9, 2.2);
      return symbolSprite(ctx, ["stuck"], {
        tags: elementSymbolTags(ctx),
        size,
        orient: "vertical",
        at: anchor("ground", { offset: [0, size * 0.48, 0] }),
        duration: clamp(1.2 + ctx.I * 1.2, 1.2, 2.4),
        opacityCurve: [[0, 1], [0.7, 1], [1, 0]],
        color: "primary",
      });
    },
  },

  // ----- melee: real cuts ---------------------------------------------------
  {
    id: "cast.sweep",
    kind: "slash",
    slot: "core",
    phases: ["cast"],
    kinds: ["melee"],
    weight: 3,
    build: (ctx) => ({
      kind: "slash",
      anchor: anchor("caster", { offset: [0, 0, 0.35] }),
      duration: clamp(0.3 + ctx.a.radius * 0.05, 0.3, 0.5),
      radius: clamp(ctx.a.radius * 0.95, 1.2, 4),
      inner: feelOf(ctx, "sharp") ? 0.6 : 0.45,
      sweep: clamp(ctx.a.angle * 2.2, 60, 200),
      tilt: ctx.rng.pick([0, 15, -15, 30]),
      reverse: ctx.rng.chance(0.5),
      sweepTime: 0.5,
      tail: 0.7,
      soft: 0.2,
      height: 1,
      core: 0.7,
      color: "primary",
      opacityCurve: [[0, 1], [0.6, 1], [1, 0]],
    }),
  },
  {
    id: "cast.chop",
    kind: "slash",
    slot: "release",
    phases: ["cast"],
    kinds: ["melee"],
    weight: 2.5,
    build: (ctx) => ({
      kind: "slash",
      anchor: anchor("caster", { offset: [0, 0, 0.4] }),
      duration: clamp(0.3 + ctx.a.radius * 0.04, 0.3, 0.45),
      radius: clamp(ctx.a.radius * 0.9, 1.2, 3.5),
      inner: 0.55,
      sweep: clamp(ctx.a.angle * 2, 90, 160),
      tilt: ctx.rng.pick([90, 75, -75]),
      reverse: true,
      sweepTime: 0.45,
      tail: 0.7,
      soft: 0.2,
      height: 1.1,
      core: 0.8,
      color: "glow",
      opacityCurve: [[0, 1], [0.6, 1], [1, 0]],
    }),
  },
  {
    id: "cast.cross",
    kind: "slash",
    slot: "core",
    phases: ["cast"],
    kinds: ["melee"],
    weight: 1.6,
    build: (ctx) => ({
      kind: "slash",
      anchor: anchor("caster", { offset: [0, 0, 0.4] }),
      duration: 0.34,
      radius: clamp(ctx.a.radius * 0.85, 1.2, 3.5),
      inner: 0.6,
      sweep: 130,
      tilt: 45,
      reverse: false,
      sweepTime: 0.5,
      tail: 0.7,
      soft: 0.2,
      height: 1,
      core: 0.75,
      color: "primary",
      opacityCurve: [[0, 1], [0.6, 1], [1, 0]],
      // the second cut mirrors the first: an X
      repeat: { count: 2, every: 0.09, alternate: true },
    }),
  },
  {
    id: "cast.thrust",
    kind: "column",
    slot: "core",
    phases: ["cast"],
    kinds: ["melee"],
    weight: 1,
    build: (ctx) => ({
      kind: "column",
      anchor: anchor("caster", { offset: [0, 0.9, 0.2] }),
      duration: 0.2,
      radius: 0.14,
      topRadius: 0.04,
      height: clamp(ctx.a.radius, 1.2, 4),
      orient: "forward",
      scroll: 12,
      noise: 0.3,
      edgeFade: 0.6,
      capFade: [0.05, 0.3],
      opacity: 0.6,
      opacityCurve: [[0, 1], [0.5, 1], [1, 0]],
      expand: [0.4, 1],
      color: "glow",
    }),
  },

  // ----- stepping: nothing slides, everything erupts -------------------------
  {
    id: "impact.spikeSteps",
    kind: "mesh",
    slot: "thing",
    phases: ["impact"],
    elements: ["earth", "ice", "nature", "arcane", "shadow"],
    only: true,
    weight: 2.5,
    build: (ctx) => {
      if (ctx.a.shape === "point") return null;
      const march = marching(ctx);
      const count = march ? clamp(Math.round(ctx.a.radius / 1.1), 3, 8) : clamp(4 + Math.round(ctx.I * 3), 4, 8);
      const repeat = march
        ? { count, every: 0.06, step: [0, 0, ctx.a.radius / count], jitter: ctx.a.shape === "cone" ? ctx.a.radius * 0.22 : 0.2, scale: 1.05 }
        : { count, every: 0.05, step: [0, 0, ctx.R * 0.55], turn: 360 / count, jitter: ctx.R * 0.15 };
      return {
        kind: "mesh",
        anchor: march ? anchor("caster", { offset: [0, -0.9, 0.9] }) : anchor("ground"),
        duration: clamp(0.9 + ctx.I * 0.6, 0.9, 1.6),
        primitive: ctx.element === "ice" || ctx.element === "arcane" ? "crystal" : "spike",
        size: clamp(ctx.R * 0.45, 0.5, 1.8),
        motion: "rise",
        count: 2,
        spread: 0.35,
        spin: 0,
        emissive: 1.2,
        opacityCurve: [[0, 1], [0.75, 1], [1, 0]],
        color: "primary",
        repeat,
      };
    },
  },
  {
    id: "impact.fireSteps",
    kind: "sprite",
    slot: "core",
    phases: ["impact"],
    needs: "burst",
    elements: ["fire", "holy", "arcane", "void", "rose", "storm"],
    weight: 1.6,
    build: (ctx) => {
      if (ctx.a.shape === "point") return null;
      const march = marching(ctx);
      const count = march ? clamp(Math.round(ctx.a.radius / 1.0), 3, 8) : 6;
      return sprite(ctx, "burst", {
        size: clamp(ctx.R * 0.7, 0.9, 3),
        at: march ? anchor("caster", { offset: [0, 0.5, 1.0] }) : anchor("ground", { offset: [0, 0.5, 0] }),
        randomYaw: true,
        color: "primary",
        repeat: march
          ? { count, every: 0.07, step: [0, 0, ctx.a.radius / count], jitter: ctx.a.shape === "cone" ? ctx.a.radius * 0.2 : 0.15, scale: 1.05 }
          : { count, every: 0.06, step: [0, 0, ctx.R * 0.6], turn: 360 / count, jitter: ctx.R * 0.12 },
      });
    },
  },
  {
    id: "impact.stepRings",
    kind: "ring",
    slot: "ground",
    phases: ["impact"],
    needsMask: ["generic", "rune", "burst", "spike", "storm"],
    weight: 1.4,
    build: (ctx) => {
      const tex = maskFor(ctx, [...elementMaskTags(ctx), "generic"]);
      if (!tex) return null;
      return {
        ...ring(ctx, {
          radius: clamp(ctx.R * 0.45, 0.5, 5),
          inner: 0,
          soft: 0.12,
          expand: [1, 1],
          duration: 0.5,
          spin: 0,
          at: groundAt(ctx, 0.05),
          opacity: 0.95,
          texture: tex,
          opacityCurve: [[0, 1], [0.6, 0.9], [1, 0]],
        }),
        // each ring appears whole, larger than the last: a stepped shockwave
        repeat: { count: 3, every: 0.09, scale: 1.45 },
      };
    },
  },
  {
    id: "linger.stepFire",
    kind: "sprite",
    slot: "debris",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse"],
    needs: "burst",
    elements: ["fire", "holy", "arcane", "void", "storm", "rose"],
    weight: 1.3,
    build: (ctx) => {
      const R = volumeR(ctx);
      const count = clamp(Math.round(ctx.phaseLength * 3), 3, 16);
      return sprite(ctx, "burst", {
        size: clamp(R * 0.4, 0.6, 1.6),
        at: ctx.at === "caster" ? anchor("caster", { offset: [0, -0.45, 0], follow: true }) : anchor("ground", { offset: [0, 0.4, 0] }),
        randomYaw: true,
        color: "primary",
        repeat: { count, every: ctx.phaseLength / count, jitter: R * 0.7 },
      });
    },
  },
];
