import { anchor, clamp, debris, feelOf, light, ring, type M, type Preset, type PresetContext } from "./presets.js";

/**
 * Second pass of the library, from looking at the first in the lab:
 *
 * - PSX MASKS. Perfect procedural circles read as engine geometry; a ring
 *   laid with a 48-px black-and-white mask (dashes, runes, spikes, roots,
 *   chains, chevrons) reads as a drawn sigil. Masks are picked by TAG so a
 *   root gets roots and a haste gets chevrons.
 * - RAIN. Things falling into the volume — bolts, shards, embers — because a
 *   dome and a floor alone make every channel look the same.
 * - WEDGES AND BREATH. Melee and shouts were rings; a cone strike wants a
 *   wedge on the ground and a spray in front of the caster.
 * - STATUS EFFECTS. root / stun / slow / haste / shield / heal / shadow each
 *   have their own look on the body they land on; buffs flash and are gone
 *   unless channelled.
 * - STACKS. A column of circles turning against each other, in place of the
 *   vertical hoops that read as a stretched oval from every camera angle.
 */

/** A mask texture from the catalog whose tags meet `tags`, or undefined. */
export function maskFor(ctx: PresetContext, tags: readonly string[]): string | undefined {
  const list = ctx.catalog.masks?.filter((m) => m.tags.some((t) => tags.includes(t))) ?? [];
  if (list.length === 0) return undefined;
  return ctx.rng.pick(list).texture;
}

/** Mask tags that suit the element, for generic ground marks. */
export function elementMaskTags(ctx: PresetContext): string[] {
  const byElement: Record<string, string[]> = {
    fire: ["burst", "generic"],
    arcane: ["rune", "arcane", "generic"],
    ice: ["spike", "ice", "generic"],
    nature: ["root", "nature", "drip"],
    earth: ["spike", "earth", "generic"],
    holy: ["holy", "cross", "hex", "generic"],
    rose: ["generic", "rune"],
    blood: ["blood", "drip", "crescent"],
    void: ["void", "eye", "chain"],
    storm: ["storm", "lightning", "chevron"],
    shadow: ["shadow", "eye", "void"],
  };
  return byElement[ctx.element] ?? ["generic"];
}

/** A ground ring carrying a mask, scaled and placed like the status it marks. */
function maskRing(ctx: PresetContext, texture: string, opts: { radius: number; duration?: number; spin?: number; color?: string; opacity?: number; at?: M; delay?: number; opacityCurve?: number[][]; expand?: [number, number]; orient?: string; height?: number }): M {
  return ring(ctx, {
    radius: opts.radius,
    inner: 0,
    soft: 0.15,
    noise: 0,
    expand: opts.expand ?? [1, 1],
    ease: "out",
    duration: opts.duration ?? 0,
    spin: opts.spin ?? 0.4,
    color: opts.color ?? "primary",
    opacity: opts.opacity ?? 0.9,
    texture,
    at: opts.at,
    delay: opts.delay,
    orient: opts.orient,
    height: opts.height,
    opacityCurve: opts.opacityCurve ?? [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
  });
}

/** Where a status lands: the body it is on, at its feet. */
function feetOf(ctx: PresetContext): M {
  const body = ctx.at === "target" ? "target" : ctx.at === "caster" ? "caster" : "ground";
  return body === "ground" ? anchor("ground") : anchor(body, { offset: [0, -0.85, 0], follow: true });
}
function bodyOf(ctx: PresetContext, y = 0): M {
  const body = ctx.at === "target" ? "target" : ctx.at === "caster" ? "caster" : "origin";
  return body === "origin" ? anchor("origin", { offset: [0, y + 0.9, 0] }) : anchor(body, { offset: [0, y, 0], follow: true });
}

/** Falling things: a box above the volume, aimed down, square sprites. */
function rain(ctx: PresetContext, opts: { count: number; stream: boolean; duration?: number; at?: M; height?: number; scale?: number }): M {
  const R = Math.max(0.6, ctx.a.growTo ?? ctx.R) * (opts.scale ?? 1);
  const h = opts.height ?? clamp(3 + R * 1.5, 4, 12);
  const storm = ctx.element === "storm" || ctx.element === "holy";
  const life: [number, number] = [h / 14, h / 9];
  const rate = opts.stream ? clamp(opts.count / life[1], 4, 300) : 0;
  return {
    kind: "particles",
    anchor: opts.at ?? anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, h - 0.9, 0], follow: true } : { offset: [0, h, 0] }),
    duration: opts.duration ?? 0,
    color: storm ? "glow" : "primary",
    colorEnd: "secondary",
    blend: "additive",
    emitter: {
      emitting: false,
      rate,
      max: clamp(Math.ceil(opts.stream ? rate * life[1] + 4 : opts.count), 8, 400),
      shape: "box",
      shapeSize: [R * 0.9, 0.2, R * 0.9],
      direction: [0, -1, 0],
      spread: 6,
      speed: [8, 13],
      gravity: 6,
      drag: 0,
      lifetime: life,
      // small and short: at the old size a 5 m pulse's rain read as slabs
      sizeStart: clamp(0.05 + R * 0.01, 0.05, 0.11),
      sizeEnd: clamp(0.04 + R * 0.008, 0.04, 0.09),
      stretch: 0.045,
      sprite: "square",
      opacityStart: 1,
      opacityEnd: 0.6,
      space: "world",
    },
    burst: opts.stream ? 0 : opts.count,
    stream: opts.stream,
  };
}

export const EXTRA_PRESETS: readonly Preset[] = [
  // ----- masks on the ground -----------------------------------------------
  {
    id: "telegraph.sigilMask",
    kind: "ring",
    slot: "sigil",
    phases: ["telegraph"],
    needsMask: ["generic", "rune", "spike", "burst", "storm", "root", "void", "holy", "blood"],
    weight: 1.6,
    build: (ctx) => {
      const tex = maskFor(ctx, elementMaskTags(ctx));
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: Math.max(0.6, ctx.a.growTo ?? ctx.R) * 0.8,
        duration: ctx.a.windup + ctx.a.duration,
        spin: feelOf(ctx, "sharp") ? 0.9 : 0.3,
        opacity: 0.55,
        at: anchor("ground"),
        expand: [0.6, 1],
      });
    },
  },
  {
    id: "charge.sigilMask",
    kind: "ring",
    slot: "sigil",
    phases: ["charge"],
    needsMask: ["generic", "rune", "hex", "storm"],
    weight: 1.6,
    build: (ctx) => {
      const tex = maskFor(ctx, [...elementMaskTags(ctx), "rune"]);
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: clamp(0.9 + ctx.R * 0.15, 0.9, 1.8),
        duration: ctx.phaseLength,
        spin: 1.1,
        opacity: 0.8,
        at: anchor("caster", { offset: [0, -0.85, 0], follow: true }),
        expand: [0.5, 1],
      });
    },
  },
  {
    id: "impact.maskMark",
    kind: "ring",
    slot: "ground",
    phases: ["impact"],
    needsMask: ["generic", "burst", "spike", "rune", "crescent", "storm"],
    weight: 1.8,
    build: (ctx) => {
      const tex = maskFor(ctx, [...elementMaskTags(ctx), "burst"]);
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: clamp(ctx.R * 1.05, 0.9, 10),
        duration: clamp(0.6 + ctx.I * 0.8, 0.6, 1.6),
        spin: ctx.rng.chance(0.5) ? 0 : 1.5,
        opacity: 0.95,
        at: ctx.at === "caster" ? anchor("caster", { offset: [0, -0.85, 0] }) : anchor("ground"),
        expand: [0.4, 1],
        opacityCurve: [[0, 1], [0.5, 0.9], [1, 0]],
      });
    },
  },
  {
    id: "linger.maskFloor",
    kind: "ring",
    slot: "ground",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse", "summon", "portal", "beam"],
    needsMask: ["generic", "rune", "spike", "root", "storm", "void", "holy", "blood", "drip"],
    weight: 2,
    build: (ctx) => {
      const tex = maskFor(ctx, elementMaskTags(ctx));
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: Math.max(0.6, ctx.a.growTo ?? ctx.R) * (ctx.kind === "beam" ? 0.6 : 0.95),
        duration: ctx.phaseLength,
        spin: feelOf(ctx, "sharp") ? 1.4 : ctx.rng.range(-0.6, 0.6),
        opacity: 0.75,
        at: ctx.at === "caster" ? anchor("caster", { offset: [0, -0.85, 0], follow: true }) : ctx.kind === "beam" ? anchor("ground", { follow: true }) : anchor("ground"),
        expand: ctx.a.growTo && ctx.a.growTo > ctx.a.radius ? [ctx.a.radius / ctx.a.growTo, 1] : [1, 1],
      });
    },
  },

  // ----- wedges and breath (melee / shouts) --------------------------------
  {
    id: "impact.wedge",
    kind: "ring",
    slot: "ground",
    phases: ["impact"],
    kinds: ["melee", "area", "shout"],
    weight: 2.5,
    build: (ctx) => {
      if (ctx.a.shape !== "cone") return null;
      const tex = maskFor(ctx, ["wedge"]);
      return ring(ctx, {
        radius: clamp(ctx.a.radius, 1, 10),
        inner: tex ? 0 : 0.2,
        expand: [0.3, 1],
        duration: clamp(0.55 + ctx.R * 0.06, 0.55, 1.1),
        soft: tex ? 0.1 : 0.5,
        noise: tex ? 0 : 0.3,
        at: anchor("caster", { offset: [0, -0.85, 0] }),
        opacityCurve: [[0, 1], [0.6, 0.85], [1, 0]],
        ...(tex ? { texture: tex } : {}),
      }) && {
        ...ring(ctx, {
          radius: clamp(ctx.a.radius, 1, 10),
          inner: tex ? 0 : 0.2,
          expand: [0.3, 1],
          duration: clamp(0.55 + ctx.R * 0.06, 0.55, 1.1),
          soft: tex ? 0.1 : 0.5,
          noise: tex ? 0 : 0.3,
          at: anchor("caster", { offset: [0, -0.85, 0] }),
          opacityCurve: [[0, 1], [0.6, 0.85], [1, 0]],
          ...(tex ? { texture: tex } : {}),
        }),
        arc: tex ? 360 : clamp(ctx.a.angle * 2, 20, 180),
      };
    },
  },
  {
    id: "cast.breath",
    kind: "particles",
    slot: "core",
    phases: ["cast"],
    kinds: ["melee", "shout"],
    weight: 1.5,
    build: (ctx) => {
      const R = Math.max(1, ctx.a.radius);
      return {
        kind: "particles",
        anchor: anchor("caster", { offset: [0, 0.4, 0.3], follow: true }),
        duration: clamp(0.25 + R * 0.05, 0.25, 0.6),
        color: "primary",
        colorEnd: "secondary",
        emitter: {
          emitting: false,
          rate: 260,
          max: 220,
          shape: "cone",
          coneAngle: clamp(ctx.a.angle, 10, 80),
          direction: [0, 0, 1],
          speed: [R * 3, R * 5],
          gravity: 0.5,
          drag: 2.2,
          lifetime: [0.18, 0.32],
          sizeStart: 0.16,
          sizeEnd: 0.05,
          stretch: 0.05,
          sprite: "square",
          opacityStart: 1,
          opacityEnd: 0,
          space: "world",
        },
        burst: 30,
        stream: true,
      };
    },
  },
  {
    id: "impact.slashMask",
    kind: "ring",
    slot: "core",
    phases: ["impact"],
    kinds: ["melee"],
    needsMask: ["crescent", "slash"],
    weight: 1.2,
    build: (ctx) => {
      const tex = maskFor(ctx, ["crescent", "slash"]);
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: clamp(ctx.R * 0.9, 1, 3.5),
        duration: 0.45,
        spin: 0,
        opacity: 1,
        color: "glow",
        orient: "vertical",
        height: 1.1,
        at: anchor("caster", { offset: [0, 0, ctx.R * 0.5] }),
        expand: [0.6, 1.3],
        opacityCurve: [[0, 1], [0.6, 0.9], [1, 0]],
      });
    },
  },

  // ----- rain --------------------------------------------------------------
  {
    id: "impact.rain",
    kind: "particles",
    slot: "tower",
    phases: ["impact"],
    kinds: ["area", "zone", "channel", "pulse", "summon"],
    weight: 1.4,
    build: (ctx) => rain(ctx, { count: Math.round(clamp(18 + ctx.R * 10 * (0.5 + ctx.I), 16, 160)), stream: false }),
  },
  {
    id: "linger.rain",
    kind: "particles",
    slot: "body",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse"],
    weight: 1.6,
    build: (ctx) => rain(ctx, { count: Math.round(clamp(20 + ctx.R * 12 * (0.5 + ctx.I), 16, 220)), stream: true, duration: ctx.phaseLength }),
  },
  {
    id: "tick.rain",
    kind: "particles",
    slot: "debris",
    phases: ["tick"],
    kinds: ["zone", "channel", "pulse"],
    weight: 1.2,
    build: (ctx) => rain(ctx, { count: Math.round(clamp(8 + ctx.R * 4, 8, 60)), stream: false, scale: 0.9 }),
  },

  // ----- multi-strand channels -------------------------------------------
  {
    id: "travel.storm",
    kind: "bolt",
    slot: "line",
    phases: ["travel"],
    kinds: ["beam"],
    weight: 1.6,
    build: (ctx) => ({
      kind: "bolt",
      anchor: anchor("caster", { socket: ctx.rng.chance(0.5) ? "rightHand" : "chest", follow: true }),
      duration: ctx.phaseLength,
      toTarget: true,
      arc: "line",
      length: Math.max(4, ctx.a.radius),
      width: clamp(0.06 + ctx.I * 0.08, 0.06, 0.16),
      segments: 16,
      jitter: 0.45,
      refreshHz: 18 + Math.round(ctx.I * 14),
      branches: 1,
      count: 3 + Math.round(ctx.I * 3),
      spread: clamp(0.5 + ctx.a.width, 0.6, 2.4),
      flicker: 0.5,
      opacity: 0.9,
      color: "primary",
    }),
  },
  {
    id: "linger.stormArcs",
    kind: "bolt",
    slot: "debris",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse", "summon"],
    weight: 0.9,
    build: (ctx) => ({
      kind: "bolt",
      anchor: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, 0.2, 0], follow: true } : { offset: [0, 0.3, 0] }),
      duration: ctx.phaseLength,
      toTarget: false,
      arc: "sky",
      length: clamp(5 + ctx.R * 1.5, 6, 18),
      width: 0.1,
      segments: 14,
      jitter: 0.7,
      refreshHz: 6,
      branches: 2,
      count: 2,
      spread: Math.max(0.6, ctx.a.growTo ?? ctx.R) * 0.9,
      flicker: 0.85,
      opacity: 0.8,
      opacityCurve: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]],
      color: "glow",
    }),
  },

  // ----- stack: a column of circles turning against each other -------------
  // (replaces the vertical "hoops", which read as a stretched oval from any
  // camera that was not looking straight down the spell direction)
  {
    id: "linger.stack",
    kind: "ring",
    slot: "aura",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse", "summon", "buff", "portal"],
    weight: 1.6,
    build: (ctx) => {
      const onBody = ctx.at === "caster" || ctx.at === "target";
      const R = onBody ? 1.0 : Math.max(0.6, ctx.a.growTo ?? ctx.R) * 0.75;
      const tex = maskFor(ctx, ["ring", "rune", "chevron", "generic"]);
      const count = onBody ? 3 : clamp(3 + Math.round(ctx.I * 3), 3, 6);
      const rise = onBody ? 0.55 : clamp(0.35 + R * 0.12, 0.4, 0.9);
      return {
        ...ring(ctx, {
          radius: R,
          inner: tex ? 0 : 0.86,
          orient: "ground",
          expand: [1, 1],
          duration: ctx.phaseLength,
          soft: tex ? 0.1 : 0.3,
          spin: feelOf(ctx, "sharp") ? 1.8 : 0.9,
          at: onBody ? bodyOf(ctx, -0.7) : anchor("ground", { offset: [0, 0.25, 0] }),
          opacity: 0.7,
          opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
          ...(tex ? { texture: tex } : {}),
        }),
        drape: false,
        // each circle a little smaller and turning the other way
        repeat: { count, every: 0.07, step: [0, rise, 0], alternate: true, scale: 0.86 },
      };
    },
  },

  // ----- status: root ------------------------------------------------------
  {
    id: "impact.rootsMark",
    kind: "ring",
    slot: "ground",
    phases: ["impact"],
    effects: ["root"],
    needsMask: ["root", "chain", "pull"],
    weight: 3,
    build: (ctx) => {
      const tex = maskFor(ctx, ["root", "chain", "pull"]);
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: clamp(Math.max(1.2, ctx.R) * 0.9, 1.2, 6),
        duration: clamp(0.8 + ctx.I, 0.8, 2),
        spin: 0,
        opacity: 1,
        at: feetOf(ctx),
        expand: [0.2, 1],
        opacityCurve: [[0, 0.6], [0.2, 1], [0.8, 1], [1, 0]],
      });
    },
  },
  {
    id: "linger.rootsHold",
    kind: "ring",
    slot: "mark",
    phases: ["linger"],
    effects: ["root"],
    needsMask: ["root", "chain", "pull"],
    weight: 3,
    build: (ctx) => {
      const tex = maskFor(ctx, ["root", "chain", "pull"]);
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: clamp(Math.max(1.2, ctx.R) * 0.9, 1.2, 6),
        duration: ctx.phaseLength,
        spin: 0.15,
        opacity: 0.95,
        at: feetOf(ctx),
      });
    },
  },
  {
    id: "linger.rootSpikes",
    kind: "mesh",
    slot: "thing",
    phases: ["linger"],
    effects: ["root"],
    weight: 2,
    build: (ctx) => ({
      kind: "mesh",
      anchor: feetOf(ctx),
      duration: ctx.phaseLength,
      primitive: ctx.element === "ice" ? "crystal" : "spike",
      size: 0.9,
      motion: "rise",
      count: 5,
      spread: 0.8,
      spin: 0,
      emissive: 0.9,
      opacityCurve: [[0, 1], [0.85, 1], [1, 0]],
      color: "primary",
    }),
  },

  // ----- status: stun ------------------------------------------------------
  {
    id: "linger.stunStars",
    kind: "mesh",
    slot: "mark",
    phases: ["linger"],
    effects: ["stun"],
    weight: 3,
    build: (ctx) => ({
      kind: "mesh",
      anchor: bodyOf(ctx, 1.0),
      duration: ctx.phaseLength,
      primitive: "orb",
      size: 0.22,
      motion: "orbit",
      count: 3 + Math.round(ctx.I * 2),
      spread: 0.42,
      spin: 4.5,
      emissive: 3,
      opacityCurve: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]],
      color: "glow",
    }),
  },
  {
    id: "linger.stunRing",
    kind: "ring",
    slot: "aura",
    phases: ["linger"],
    effects: ["stun"],
    needsMask: ["stun", "star", "chain", "storm"],
    weight: 3,
    build: (ctx) => {
      const tex = maskFor(ctx, ["stun", "star", "storm"]);
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: 0.7,
        duration: ctx.phaseLength,
        spin: 3,
        opacity: 1,
        color: "glow",
        at: bodyOf(ctx, 1.95),
      });
    },
  },

  // ----- status: slow ------------------------------------------------------
  {
    id: "linger.slowRing",
    kind: "ring",
    slot: "mark",
    phases: ["linger"],
    effects: ["slow"],
    needsMask: ["slow", "hourglass", "drip", "pull"],
    weight: 3,
    build: (ctx) => {
      const tex = maskFor(ctx, ["slow", "hourglass", "drip", "pull"]);
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: 1.2,
        duration: ctx.phaseLength,
        spin: -0.4,
        opacity: 0.9,
        color: "secondary",
        at: feetOf(ctx),
      });
    },
  },
  {
    id: "linger.slowDrips",
    kind: "particles",
    slot: "debris",
    phases: ["linger"],
    effects: ["slow"],
    weight: 2.5,
    build: (ctx) => debris(ctx, "fall", { at: bodyOf(ctx, 0.6), duration: ctx.phaseLength, stream: true, count: 40, scale: 0.5 }),
  },

  // ----- status: haste -----------------------------------------------------
  {
    id: "linger.speedLines",
    kind: "particles",
    slot: "mark",
    phases: ["linger"],
    effects: ["haste"],
    weight: 3,
    build: (ctx) => ({
      kind: "particles",
      anchor: bodyOf(ctx, -0.5),
      duration: ctx.phaseLength,
      color: "glow",
      colorEnd: "primary",
      emitter: {
        emitting: false,
        rate: 90,
        max: 120,
        shape: "box",
        shapeSize: [0.4, 0.5, 0.4],
        direction: [0, 0, -1],
        spread: 14,
        speed: [4, 7],
        gravity: 0,
        drag: 3,
        lifetime: [0.18, 0.32],
        sizeStart: 0.05,
        sizeEnd: 0.02,
        stretch: 0.14,
        sprite: "square",
        opacityStart: 1,
        opacityEnd: 0,
        space: "world",
      },
      burst: 20,
      stream: true,
    }),
  },
  {
    id: "linger.hasteRing",
    kind: "ring",
    slot: "aura",
    phases: ["linger"],
    effects: ["haste"],
    needsMask: ["haste", "chevron", "arrow"],
    weight: 3,
    build: (ctx) => {
      const tex = maskFor(ctx, ["haste", "chevron"]);
      if (!tex) return null;
      return maskRing(ctx, tex, { radius: 1.1, duration: ctx.phaseLength, spin: 3.5, opacity: 0.9, color: "glow", at: feetOf(ctx) });
    },
  },
  // ----- status: shield / heal ---------------------------------------------
  {
    id: "linger.wardHex",
    kind: "ring",
    slot: "aura",
    phases: ["linger"],
    effects: ["shield"],
    needsMask: ["shield", "hex", "ward"],
    weight: 3,
    build: (ctx) => {
      const tex = maskFor(ctx, ["shield", "hex", "ward"]);
      if (!tex) return null;
      return maskRing(ctx, tex, { radius: 1.25, duration: ctx.phaseLength, spin: 0.6, opacity: 0.9, at: feetOf(ctx) });
    },
  },
  {
    id: "linger.wardShell",
    kind: "shell",
    slot: "mark",
    phases: ["linger"],
    effects: ["shield"],
    weight: 3,
    build: (ctx) => ({
      kind: "shell",
      anchor: bodyOf(ctx, 0.05),
      duration: ctx.phaseLength,
      radius: 1.2,
      style: "glass",
      fresnel: 2.2,
      noise: 0.25,
      noiseSpeed: 0.5,
      spin: 0.4,
      squash: 1.35,
      opacity: 0.7,
      opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "linger.healMotes",
    kind: "particles",
    slot: "mark",
    phases: ["linger"],
    effects: ["heal"],
    weight: 3,
    build: (ctx) => debris(ctx, "rise", { at: bodyOf(ctx, -0.6), duration: ctx.phaseLength, stream: true, count: 50, scale: 0.6 }),
  },
  {
    id: "linger.healCross",
    kind: "ring",
    slot: "aura",
    phases: ["linger"],
    effects: ["heal"],
    needsMask: ["heal", "cross", "holy"],
    weight: 3,
    build: (ctx) => {
      const tex = maskFor(ctx, ["heal", "cross"]);
      if (!tex) return null;
      return maskRing(ctx, tex, { radius: 1.1, duration: ctx.phaseLength, spin: 0.8, opacity: 0.9, color: "glow", at: feetOf(ctx) });
    },
  },

  // ----- shadow: dark matter, fading bodies ---------------------------------
  {
    id: "linger.shroud",
    kind: "shell",
    slot: "mark",
    phases: ["linger"],
    effects: ["shadow"],
    weight: 3,
    build: (ctx) => ({
      kind: "shell",
      anchor: bodyOf(ctx, 0.05),
      duration: ctx.phaseLength,
      radius: 1.15,
      style: "smoke",
      blend: "normal",
      fresnel: 1.2,
      noise: 0.8,
      noiseScale: 1.6,
      noiseSpeed: 0.9,
      spin: 0.3,
      squash: 1.35,
      opacity: 0.55,
      dissolve: [[0, 0.3], [0.5, 0.35], [1, 0.9]],
      opacityCurve: [[0, 0], [0.1, 1], [0.8, 1], [1, 0]],
      color: "secondary",
    }),
  },
  {
    id: "impact.shadowBurst",
    kind: "particles",
    slot: "debris",
    phases: ["impact", "end"],
    effects: ["shadow"],
    weight: 3,
    build: (ctx) => ({
      ...debris(ctx, "burst", { at: bodyOf(ctx, 0.3), count: 60, scale: 0.8 }),
      color: "#1a1424",
      colorEnd: "#000000",
      blend: "normal",
    }),
  },
  {
    id: "linger.shadowEye",
    kind: "ring",
    slot: "aura",
    phases: ["linger"],
    effects: ["shadow"],
    needsMask: ["eye", "shadow", "void"],
    weight: 2,
    build: (ctx) => {
      const tex = maskFor(ctx, ["eye", "shadow", "void"]);
      if (!tex) return null;
      return maskRing(ctx, tex, { radius: 0.8, duration: ctx.phaseLength, spin: 0, opacity: 0.9, color: "glow", orient: "vertical", height: 2.1, at: bodyOf(ctx, 0) });
    },
  },

  // ----- generic extras ------------------------------------------------------
  {
    id: "impact.shardRain",
    kind: "particles",
    slot: "debris",
    phases: ["impact"],
    elements: ["ice", "earth", "storm", "holy"],
    only: true,
    weight: 1.2,
    build: (ctx) => rain(ctx, { count: Math.round(clamp(14 + ctx.R * 8, 12, 90)), stream: false, height: clamp(2 + ctx.R, 3, 8), scale: 0.8 }),
  },
  {
    id: "charge.gatherMask",
    kind: "ring",
    slot: "gather",
    phases: ["charge"],
    needsMask: ["pull", "gather", "arrow"],
    weight: 1.2,
    build: (ctx) => {
      const tex = maskFor(ctx, ["pull", "gather"]);
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: clamp(1.4 + ctx.R * 0.2, 1.4, 2.6),
        duration: ctx.phaseLength,
        spin: -1.5,
        opacity: 0.7,
        at: anchor("caster", { offset: [0, -0.85, 0], follow: true }),
        expand: [1.4, 0.7],
      });
    },
  },
  {
    id: "end.maskFade",
    kind: "ring",
    slot: "dissipate",
    phases: ["end"],
    needsMask: ["generic", "rune", "burst"],
    weight: 1,
    build: (ctx) => {
      const tex = maskFor(ctx, elementMaskTags(ctx));
      if (!tex) return null;
      return maskRing(ctx, tex, {
        radius: Math.max(0.6, ctx.a.growTo ?? ctx.R) * (ctx.at === "caster" || ctx.at === "target" ? 0.5 : 0.9),
        duration: 0.5,
        spin: 2,
        opacity: 0.9,
        color: "glow",
        at: feetOf(ctx),
        expand: [1, 0.2],
        opacityCurve: [[0, 1], [1, 0]],
      });
    },
  },
  {
    id: "light.dark",
    kind: "light",
    slot: "light",
    phases: ["impact", "linger"],
    effects: ["shadow"],
    weight: 3,
    build: (ctx) => light(ctx, { intensity: 6, range: 4, duration: ctx.phaseLength > 0 ? ctx.phaseLength : 0.5, color: "#6a5a9a", curve: [[0, 1], [1, 0.4]] }),
  },
];
