import type { Element, Feel, Palette } from "./elements.js";
import type { AnchorAt, Phase, VfxModule, VfxModuleKind } from "./modules.js";
import type { Rng } from "./rng.js";
import type { SpellArchetype, SpellKind, StatusEffect } from "./spell.js";

/**
 * The preset library — every module a generated spell can contain, authored
 * once by a human, with the ENVELOPE it may be varied within.
 *
 * This is the "combinatorial, not parametric" half of docs/vfx-architecture.md
 * made concrete. A preset is not a module; it is a small function from the
 * spell's reference numbers (radius, intensity, windup, palette, feel) to a
 * module whose every value lands inside a band that was looked at and judged.
 * The generator only ever chooses WHICH presets and HOW MANY. It cannot
 * produce the broken outlier, because no preset can.
 *
 * Sizing convention, so the scale of everything makes sense together:
 *   R  — the archetype radius (a body ≈ 1 for point spells). Sprites, rings,
 *        shells and particle counts are multiples of it.
 *   I  — intensity 0..1. Drives brightness, counts, light, shake, extras.
 *   windup / duration — every charge-up fits the windup, every linger fits
 *        the duration. Nothing is sized in seconds of its own.
 */

// ---------------------------------------------------------------------------
// sprite catalog — the host's flipbook library, by semantic role
// ---------------------------------------------------------------------------

/**
 * What a flipbook IS, not what it is called. The engine ships no sheets; a
 * project maps its own library onto these roles (voxel-demo does it in
 * `scripts/lib/spell-catalog.ts`). A role the catalog lacks is simply never
 * chosen — the procedural modules carry the effect instead.
 */
export const SPRITE_ROLES = [
  "burst", // an explosion / bloom — the core of an impact
  "flash", // a short bright hit spark
  "ring", // an expanding ground shockwave or cast circle
  "rune", // a ground glyph that can loop
  "slash", // a melee arc
  "vortex", // a looping swirl
  "smoke", // a puff that dissipates (normal blend)
  "bolt", // a looping projectile head
  "pillar", // a vertical column of light / fire
  "portal", // a looping vertical gateway face
  "gather", // energy converging (charge-ups)
  "lightning", // an arc / strike flipbook
  "shard", // crystals, spikes, splinters
  "wave", // a horizontal shock / repel wave, vertical orient
] as const;
export type SpriteRole = (typeof SPRITE_ROLES)[number];

export interface SpriteEntry {
  /** Spritesheet data-asset id. */
  sheet: string;
  /** Columns in the sheet — the frame count. */
  frames: number;
  fps?: number;
  /** Width / height of one cell. */
  aspect?: number;
  /** Texture asset id of the sheet, for kinds that sample it directly (particle sub-UV). */
  texture?: string;
  /** Elements this sheet particularly suits (bonus weight), if any. */
  elements?: Element[];
  feel?: Feel[];
}
/** A black-and-white mask laid across a ring's disc (see `fx.mjs masks`). */
export interface MaskEntry {
  /** Texture asset id, e.g. "fx/masks/roots.png". */
  texture: string;
  /** What it means: root, stun, slow, haste, shield, heal, arrow, spike, rune, wedge, generic… */
  tags: string[];
}

/**
 * What a SYMBOL is for. A symbol is one cell of a sheet drawn as a static
 * quad — a sigil under a caster, a glyph orbiting a charge-up, an arrow
 * riding a projectile, a spear stuck in the ground after it lands.
 */
export const SYMBOL_ROLES = [
  "sigil", // a full magic circle: goes under casters, on volumes, in front of a charge-up
  "glyph", // a small icon: orbits, marks, decoration on a stack
  "star", // a spark shape: impact marks, stun stars
  "head", // rides the front of a projectile (arrows, spears, shards — drawn pointing UP)
  "stuck", // the projectile embedded in the ground after impact (drawn with its base at the bottom)
  "mark", // a ground mark left by an impact or a debuff
] as const;
export type SymbolRole = (typeof SYMBOL_ROLES)[number];

/** Orientations a symbol may be drawn in — the catalog says which each allows. */
export const SYMBOL_ORIENTS = ["ground", "facing", "billboard", "vertical", "velocity"] as const;
export type SymbolOrient = (typeof SYMBOL_ORIENTS)[number];

/**
 * When a symbol may TURN in its own plane. Lying flat that is a harmless
 * yaw; standing up it is a roll around a horizontal axis, which is wrong on
 * anything with an up (chevrons, arrows, a hand) and only right on a circle.
 */
export const SYMBOL_SPINS = ["none", "ground", "any"] as const;
export type SymbolSpin = (typeof SYMBOL_SPINS)[number];

/** One symbol: a sheet cell plus the rules a human dictated for it. */
export interface SymbolEntry {
  /** Stable id, "<sheet>:<index>". */
  id: string;
  /** Spritesheet data-asset id (its grid gives the cell size). */
  sheet: string;
  cell: [col: number, row: number];
  roles: SymbolRole[];
  /** Meaning, for the generator's asks: rune, circle, arrow, spear, shard, star, eye, hand, crescent… */
  tags: string[];
  orient: SymbolOrient[];
  spin: SymbolSpin;
  enabled: boolean;
  /** Width / height of the drawn symbol inside its cell (1 = square). */
  aspect?: number;
}

/** The symbol catalog document a project saves (assets/fx-catalog/symbols.json). */
export interface SymbolCatalogDoc {
  version: 1;
  symbols: SymbolEntry[];
}

export type SpriteCatalog = Partial<Record<SpriteRole, SpriteEntry[]>> & {
  /** PSX masks for rings and ground marks. */
  masks?: MaskEntry[];
  /** Static symbols by role — sigils, glyphs, projectile heads, stuck projectiles — each with its own rules. */
  symbols?: SymbolEntry[];
};

/** Symbols the catalog offers for these roles, at this orientation, enabled. */
export function symbolsFor(catalog: SpriteCatalog, roles: readonly SymbolRole[], orient: SymbolOrient): SymbolEntry[] {
  return (catalog.symbols ?? []).filter((s) => s.enabled && s.roles.some((r) => roles.includes(r)) && s.orient.includes(orient));
}

/** The spin a symbol permits at this orientation: its rule clips what the preset wants. */
export function symbolSpin(entry: SymbolEntry, orient: SymbolOrient, wanted: number): number {
  if (entry.spin === "none") return 0;
  if (entry.spin === "ground" && orient !== "ground") return 0;
  return wanted;
}

// ---------------------------------------------------------------------------
// the preset contract
// ---------------------------------------------------------------------------

/** Grammar slots — what a preset is FOR within a phase. */
export const SLOTS = [
  "volume", // the telegraph itself
  "sigil", // ground glyph under a caster / a volume
  "gather", // energy converging on the caster
  "core", // the main body of a moment: the flash, the bloom, the pop
  "release", // the cast moment at the hands
  "ground", // a ground ring / mark
  "debris", // particles thrown or drifting
  "light", // the secondary light
  "tower", // a pillar / sky strike — the vertical exclamation mark
  "shake",
  "head", // the projectile head
  "tail", // the projectile trail
  "line", // beam / bolt between two points
  "body", // the sustained volume of a linger
  "aura", // a sustained effect on a body
  "mark", // a debuff mark
  "thing", // a summoned body / a falling body
  "gate", // a portal face
  "dissipate", // the end
] as const;
export type Slot = (typeof SLOTS)[number];

export interface PresetContext {
  rng: Rng;
  /** Reference radius, metres (≥ 0.6). */
  R: number;
  /** Intensity 0..1. */
  I: number;
  a: SpellArchetype;
  kind: SpellKind;
  element: Element;
  palette: Palette;
  feel: Feel[];
  catalog: SpriteCatalog;
  phase: Phase;
  /** What the payload does, as a look. */
  effect: StatusEffect;
  /** PSX quantisation requested for this spell (0 = smooth). */
  pixel: number;
  /** Seconds this phase lasts (0 for instants). */
  phaseLength: number;
  /** Default anchor for the phase (origin / caster / target / path). */
  at: AnchorAt;
  /** Should modules at `at` follow it (a moving body, a projectile)? */
  follow: boolean;
}

export interface Preset {
  id: string;
  kind: VfxModuleKind;
  slot: Slot;
  phases: readonly Phase[];
  /** Restrict to these spell kinds (omitted = any). */
  kinds?: readonly SpellKind[];
  /** Elements this reads best on (bonus weight; `only` makes it exclusive). */
  elements?: readonly Element[];
  only?: boolean;
  feel?: readonly Feel[];
  /** Sprite role the catalog must provide. */
  needs?: SpriteRole;
  /** Status effects this preset is FOR (exclusive when set). */
  effects?: readonly StatusEffect[];
  /** Mask tags the catalog must offer one of. */
  needsMask?: readonly string[];
  /** Symbol roles the catalog must offer one of (enabled, any orientation). */
  needsSymbol?: readonly SymbolRole[];
  weight?: number;
  /** Minimum intensity before this is eligible. */
  minI?: number;
  build(ctx: PresetContext): Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// helpers shared by the presets
// ---------------------------------------------------------------------------

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Module-shaped object literal; the generator parses it through the schema. */
export type M = Record<string, unknown>;

export function anchor(at: AnchorAt, extra: { socket?: string; offset?: [number, number, number]; follow?: boolean } = {}): M {
  return { at, ...extra };
}

/** A sprite from the catalog, or null when the role is missing. */
export function sprite(ctx: PresetContext, role: SpriteRole, opts: { size: number; orient?: string; loop?: boolean; fps?: number; duration?: number; at?: M; delay?: number; color?: string; opacity?: number; spin?: number; randomYaw?: boolean; blend?: string; sizeCurve?: number[][]; opacityCurve?: number[][]; repeat?: M }): M | null {
  const list = ctx.catalog[role];
  if (!list || list.length === 0) return null;
  const weighted = list.map((e) => ({
    w: 1 + (e.elements?.includes(ctx.element) ? 2 : 0) + (e.feel?.some((f) => ctx.feel.includes(f)) ? 1 : 0),
    v: e,
  }));
  const e = ctx.rng.weighted(weighted);
  return {
    kind: "sprite",
    sheet: e.sheet,
    row: 5,
    fps: opts.fps ?? e.fps ?? 22,
    loop: opts.loop ?? false,
    size: opts.size,
    aspect: e.aspect ?? 1,
    orient: opts.orient ?? "billboard",
    spin: opts.spin ?? 0,
    randomYaw: opts.randomYaw ?? false,
    anchor: opts.at ?? anchor(ctx.at, { follow: ctx.follow }),
    delay: opts.delay ?? 0,
    duration: opts.duration ?? 0,
    color: opts.color ?? "primary",
    opacity: opts.opacity ?? 1,
    blend: opts.blend ?? "additive",
    ...(opts.sizeCurve ? { sizeCurve: opts.sizeCurve } : {}),
    ...(opts.opacityCurve ? { opacityCurve: opts.opacityCurve } : {}),
    ...(opts.repeat ? { repeat: opts.repeat } : {}),
  };
}

/**
 * A symbol from the catalog as a static sprite, honouring the symbol's own
 * rules: only an orientation it allows, only the spin it permits. Returns
 * null when the catalog has nothing for the roles at this orientation — the
 * preset then declines and the procedural modules carry the moment.
 */
export function symbolSprite(
  ctx: PresetContext,
  roles: readonly SymbolRole[],
  opts: {
    size: number;
    orient: SymbolOrient;
    tags?: readonly string[];
    spin?: number;
    at?: M;
    delay?: number;
    duration?: number;
    color?: string;
    opacity?: number;
    blend?: string;
    yaw?: number;
    randomYaw?: boolean;
    orbit?: number;
    orbitSpeed?: number;
    sizeCurve?: number[][];
    opacityCurve?: number[][];
    repeat?: M;
  },
): M | null {
  const list = symbolsFor(ctx.catalog, roles, opts.orient);
  if (list.length === 0) return null;
  const weighted = list.map((e) => ({
    w: 1 + (opts.tags ? e.tags.filter((t) => opts.tags!.includes(t)).length * 2 : 0),
    v: e,
  }));
  const e = ctx.rng.weighted(weighted);
  return {
    kind: "sprite",
    sheet: e.sheet,
    cell: e.cell,
    row: e.cell[1],
    loop: false,
    size: opts.size,
    aspect: e.aspect ?? 1,
    orient: opts.orient,
    spin: symbolSpin(e, opts.orient, opts.spin ?? 0),
    yaw: opts.yaw ?? 0,
    randomYaw: opts.randomYaw ?? false,
    orbit: opts.orbit ?? 0,
    orbitSpeed: opts.orbitSpeed ?? 0,
    anchor: opts.at ?? anchor(ctx.at, { follow: ctx.follow }),
    delay: opts.delay ?? 0,
    duration: opts.duration ?? 0,
    color: opts.color ?? "primary",
    opacity: opts.opacity ?? 1,
    blend: opts.blend ?? "additive",
    // symbols are pixel art: never bilinear
    pixel: Math.max(1, ctx.pixel),
    ...(opts.sizeCurve ? { sizeCurve: opts.sizeCurve } : {}),
    ...(opts.opacityCurve ? { opacityCurve: opts.opacityCurve } : {}),
    ...(opts.repeat ? { repeat: opts.repeat } : {}),
  };
}

/**
 * Element-flavoured particle debris. One function, ten looks: what a hit
 * throws off is the single strongest element cue after colour, so it is
 * tuned per element rather than picked at random.
 */
export type DebrisStyle = "burst" | "gather" | "rise" | "drift" | "fall";

export function debris(ctx: PresetContext, style: DebrisStyle, opts: { count?: number; at?: M; delay?: number; duration?: number; stream?: boolean; scale?: number } = {}): M {
  const { R, I, element, rng } = ctx;
  const scale = opts.scale ?? 1;
  const baseCount = Math.round((16 + 34 * Math.pow(R, 0.75)) * (0.55 + 0.9 * I) * scale);
  const count = clamp(opts.count ?? baseCount, 6, 260);
  const radial = style === "burst" ? "out" : style === "gather" ? "in" : "none";
  // Per-element particle character.
  const E: Record<Element, Partial<M>> = {
    fire: { speed: [1.5, 4.5], gravity: -1.4, drag: 0.9, turbulence: 3, sizeStart: 0.16, sizeEnd: 0.02, lifetime: [0.5, 1.3] },
    arcane: { speed: [1.5, 5], gravity: 0, drag: 1.4, turbulence: 2.4, spin: 3, sizeStart: 0.1, sizeEnd: 0.01, lifetime: [0.5, 1.2] },
    ice: { speed: [3, 8], gravity: 8, drag: 1.4, spin: 4, stretch: 0.06, sizeStart: 0.11, sizeEnd: 0.02, lifetime: [0.45, 1.0] },
    nature: { speed: [0.8, 2.6], gravity: -0.3, drag: 1.5, turbulence: 2.6, turbulenceSpeed: 0.8, sizeStart: 0.13, sizeEnd: 0.03, lifetime: [0.9, 1.9] },
    earth: { speed: [2, 6], gravity: 12, drag: 0.6, sizeStart: 0.22, sizeEnd: 0.08, lifetime: [0.5, 1.2], blending: "normal", opacityStart: 0.9 },
    holy: { speed: [0.6, 2.2], gravity: -1.1, drag: 1.2, turbulence: 1.2, sizeStart: 0.12, sizeEnd: 0.02, lifetime: [0.8, 1.8], fadeIn: 0.1 },
    rose: { speed: [0.8, 2.6], gravity: 0.8, drag: 2.2, turbulence: 2.2, spin: 2, sizeStart: 0.16, sizeEnd: 0.05, lifetime: [0.9, 1.8] },
    blood: { speed: [3, 7], gravity: 14, drag: 0.5, stretch: 0.07, sizeStart: 0.1, sizeEnd: 0.05, lifetime: [0.35, 0.8], blending: "normal", opacityStart: 0.95 },
    void: { speed: [0.8, 3], gravity: -0.4, drag: 1.6, turbulence: 4.5, turbulenceSpeed: 1.6, sizeStart: 0.2, sizeEnd: 0.03, lifetime: [0.7, 1.6], fadeIn: 0.15 },
    storm: { speed: [5, 12], gravity: 10, drag: 1.1, stretch: 0.11, sizeStart: 0.08, sizeEnd: 0.005, lifetime: [0.2, 0.5] },
    shadow: { speed: [0.5, 2], gravity: -0.3, drag: 1.8, turbulence: 3.5, turbulenceSpeed: 1.2, sizeStart: 0.26, sizeEnd: 0.05, lifetime: [0.8, 1.8], fadeIn: 0.2, blending: "normal", opacityStart: 0.85 },
  };
  const e = { ...E[element] };
  // Style adjustments on top of the element character.
  const shape = style === "gather" ? "sphere" : style === "burst" ? "sphere" : style === "fall" ? "box" : "sphere";
  const shapeSize: [number, number, number] =
    style === "gather"
      ? [R * 1.4, R * 1.0, R * 1.4]
      : style === "burst"
        ? [R * 0.25, R * 0.2, R * 0.25]
        : style === "fall"
          ? [R * 0.9, 0.2, R * 0.9]
          : [R * 0.8, R * 0.35, R * 0.8];
  if (style === "gather") {
    e.speed = [R * 1.6, R * 3.2];
    e.gravity = 0;
    e.drag = 0.2;
    e.lifetime = [0.35, 0.7];
  } else if (style === "rise") {
    e.speed = [0.4, 1.6];
    e.gravity = -(0.6 + 0.6 * rng.next());
    e.drag = 1.2;
  } else if (style === "drift") {
    e.speed = [0.2, 0.9];
    e.gravity = typeof e.gravity === "number" ? (e.gravity as number) * 0.2 : 0;
    e.drag = 1.6;
    e.turbulence = Math.max(1.5, (e.turbulence as number | undefined) ?? 0);
  } else if (style === "fall") {
    e.speed = [0.2, 0.8];
    e.gravity = 3 + 3 * rng.next();
    e.drag = 0.4;
  }
  const streaming = opts.stream ?? (style === "rise" || style === "drift" || style === "fall");
  // A sustained stream of matter (dust, blood) must stay thin enough to read
  // bodies through — the audit's readability rule, honoured at the source.
  if (streaming && e.blending === "normal") e.opacityStart = 0.6;
  const life = e.lifetime as [number, number];
  const rate = streaming ? clamp(count / Math.max(0.3, life[1]), 6, 400) : 0;
  return {
    kind: "particles",
    anchor: opts.at ?? anchor(ctx.at, { follow: ctx.follow }),
    delay: opts.delay ?? 0,
    duration: opts.duration ?? 0,
    color: "primary",
    colorEnd: "secondary",
    blend: (e.blending as string | undefined) ?? "additive",
    emitter: {
      emitting: false,
      rate,
      max: clamp(Math.ceil(streaming ? rate * life[1] + 4 : count), 8, 400),
      shape,
      shapeSize,
      spread: 180,
      direction: [0, 1, 0],
      radial,
      space: "world",
      opacityStart: 1,
      opacityEnd: 0,
      ...e,
    },
    burst: streaming ? 0 : count,
    stream: streaming,
  };
}

export function light(ctx: PresetContext, opts: { intensity?: number; range?: number; curve?: number[][]; at?: M; delay?: number; duration?: number; flicker?: number; color?: string } = {}): M {
  const { R, I } = ctx;
  return {
    kind: "light",
    anchor: opts.at ?? anchor(ctx.at, { follow: ctx.follow, offset: [0, Math.min(1.2, 0.4 + R * 0.25), 0] }),
    delay: opts.delay ?? 0,
    duration: opts.duration ?? 0,
    color: opts.color ?? "primary",
    intensity: opts.intensity ?? Math.round((24 + 110 * I) * Math.min(2.2, 0.7 + R * 0.35)),
    range: opts.range ?? clamp(3 + R * 2.2, 3, 22),
    ...(opts.curve ? { intensityCurve: opts.curve } : {}),
    flicker: opts.flicker ?? 0,
  };
}

export function ring(ctx: PresetContext, opts: { radius: number; inner?: number; expand?: [number, number]; duration?: number; delay?: number; at?: M; orient?: string; soft?: number; noise?: number; swirl?: number; spin?: number; color?: string; opacity?: number; ease?: string; opacityCurve?: number[][]; texture?: string; blend?: string; height?: number }): M {
  return {
    kind: "ring",
    anchor: opts.at ?? anchor(ctx.at, { follow: ctx.follow }),
    delay: opts.delay ?? 0,
    duration: opts.duration ?? 0,
    color: opts.color ?? "primary",
    blend: opts.blend ?? "additive",
    opacity: opts.opacity ?? 1,
    radius: opts.radius,
    inner: opts.inner ?? 0.7,
    orient: opts.orient ?? "ground",
    expand: opts.expand ?? [0.1, 1],
    ease: opts.ease ?? "out",
    soft: opts.soft ?? 0.35,
    noise: opts.noise ?? 0,
    swirl: opts.swirl ?? 0,
    spin: opts.spin ?? 0,
    height: opts.height ?? 0,
    ...(opts.texture ? { texture: opts.texture } : {}),
    ...(opts.opacityCurve ? { opacityCurve: opts.opacityCurve } : {}),
  };
}

export const feelOf = (ctx: PresetContext, f: Feel): boolean => ctx.feel.includes(f);

// ---------------------------------------------------------------------------
// the library
// ---------------------------------------------------------------------------

export const BASE_PRESETS: readonly Preset[] = [
  // ----- telegraph -------------------------------------------------------
  {
    id: "telegraph.volume",
    kind: "telegraph",
    slot: "volume",
    phases: ["telegraph"],
    build: (ctx) => {
      const a = ctx.a;
      const grow = a.growTo && a.growTo > a.radius ? a.radius / a.growTo : 1;
      return {
        kind: "telegraph",
        anchor: anchor("origin"),
        shape: a.shape === "point" ? "circle" : a.shape,
        radius: Math.max(0.6, a.growTo ?? a.radius),
        angle: a.angle,
        width: a.width,
        windup: a.windup,
        hold: a.duration,
        growFrom: grow,
        height: a.height,
        color: "primary",
      };
    },
  },
  {
    id: "telegraph.sigil",
    kind: "ring",
    slot: "sigil",
    phases: ["telegraph"],
    minI: 0.35,
    weight: 0.8,
    build: (ctx) =>
      ring(ctx, {
        radius: ctx.R * 0.55,
        inner: 0,
        expand: [0.2, 1],
        duration: ctx.a.windup + ctx.a.duration,
        soft: 0.9,
        noise: 0.6,
        spin: feelOf(ctx, "sharp") ? 1.4 : 0.6,
        opacity: 0.35,
        at: anchor("ground"),
        opacityCurve: [[0, 0], [0.2, 1], [0.9, 1], [1, 0]],
      }),
  },
  {
    id: "telegraph.meteor",
    kind: "mesh",
    slot: "thing",
    phases: ["telegraph"],
    kinds: ["area"],
    elements: ["earth", "fire"],
    only: true,
    minI: 0.45,
    build: (ctx) => ({
      kind: "mesh",
      anchor: anchor("origin"),
      duration: ctx.a.windup,
      primitive: ctx.element === "fire" ? "rock" : "rock",
      size: clamp(ctx.R * 0.5, 0.5, 2.6),
      motion: "drop",
      from: clamp(12 + ctx.R * 3, 12, 30),
      spin: 2.5,
      emissive: ctx.element === "fire" ? 2.5 : 0.8,
      color: "primary",
    }),
  },
  {
    id: "telegraph.skyglow",
    kind: "column",
    slot: "tower",
    phases: ["telegraph"],
    kinds: ["area", "summon"],
    elements: ["holy", "storm", "arcane", "void"],
    minI: 0.5,
    weight: 0.7,
    build: (ctx) => ({
      kind: "column",
      anchor: anchor("origin"),
      duration: ctx.a.windup,
      radius: ctx.R * 0.35,
      topRadius: ctx.R * 0.9,
      height: clamp(ctx.R * 3.5, 4, 16),
      orient: "down",
      scroll: -2,
      noise: 0.7,
      edgeFade: 0.8,
      capFade: [0.1, 0.5],
      opacity: 0.3,
      opacityCurve: [[0, 0], [0.4, 1], [1, 1]],
      expand: [0.4, 1],
      color: "glow",
    }),
  },

  // ----- charge ------------------------------------------------------------
  {
    id: "charge.gather",
    kind: "particles",
    slot: "gather",
    phases: ["charge"],
    build: (ctx) =>
      debris(ctx, "gather", {
        at: anchor("caster", { socket: ctx.rng.chance(0.5) ? "rightHand" : "chest", follow: true }),
        stream: true,
        duration: ctx.phaseLength,
        count: Math.round((30 + 70 * ctx.I) * Math.min(1.6, 0.6 + ctx.R * 0.25)),
        scale: 0.5,
      }),
  },
  {
    id: "charge.orb",
    kind: "shell",
    slot: "core",
    phases: ["charge"],
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor("caster", { socket: "rightHand", follow: true }),
      duration: ctx.phaseLength,
      radius: clamp(0.12 + ctx.R * 0.06 + 0.12 * ctx.I, 0.14, 0.5),
      style: feelOf(ctx, "crystalline") ? "glass" : feelOf(ctx, "wispy") ? "wire" : "energy",
      fresnel: feelOf(ctx, "sharp") ? 3 : 1.6,
      noise: feelOf(ctx, "soft") ? 0.7 : 0.4,
      noiseSpeed: 1.4,
      spin: 2,
      expand: [0.15, 1],
      opacityCurve: [[0, 0], [0.15, 1], [1, 1]],
      color: "glow",
    }),
  },
  {
    id: "charge.vortex",
    kind: "sprite",
    slot: "core",
    phases: ["charge"],
    needs: "vortex",
    weight: 0.8,
    build: (ctx) =>
      sprite(ctx, "vortex", {
        size: clamp(0.5 + ctx.R * 0.18, 0.5, 1.6),
        loop: true,
        duration: ctx.phaseLength,
        at: anchor("caster", { socket: "chest", offset: [0, 0, 0.2], follow: true }),
        spin: feelOf(ctx, "sharp") ? 3 : 1.2,
        color: "primary",
        opacityCurve: [[0, 0], [0.2, 1], [0.9, 1], [1, 0]],
      }),
  },
  {
    id: "charge.gatherSprite",
    kind: "sprite",
    slot: "core",
    phases: ["charge"],
    needs: "gather",
    build: (ctx) =>
      sprite(ctx, "gather", {
        size: clamp(0.8 + ctx.R * 0.2, 0.8, 2.2),
        loop: true,
        duration: ctx.phaseLength,
        at: anchor("caster", { socket: "chest", follow: true }),
        opacityCurve: [[0, 0], [0.15, 1], [0.95, 1], [1, 0]],
      }),
  },
  {
    id: "charge.glow",
    kind: "light",
    slot: "light",
    phases: ["charge"],
    build: (ctx) =>
      light(ctx, {
        at: anchor("caster", { offset: [0, 1.1, 0.3], follow: true }),
        duration: ctx.phaseLength,
        intensity: Math.round(8 + 30 * ctx.I),
        range: 4 + 2 * ctx.I,
        curve: [[0, 0], [0.7, 0.7], [1, 1]],
        flicker: feelOf(ctx, "sharp") ? 0.3 : 0.1,
      }),
  },
  {
    id: "charge.sigil",
    kind: "ring",
    slot: "sigil",
    phases: ["charge"],
    minI: 0.3,
    build: (ctx) =>
      ring(ctx, {
        radius: clamp(0.9 + ctx.R * 0.15, 0.9, 1.8),
        inner: 0,
        expand: [0.4, 1],
        duration: ctx.phaseLength,
        at: anchor("caster", { offset: [0, -0.85, 0], follow: true }),
        soft: 0.8,
        noise: 0.5,
        spin: 1.2,
        opacity: 0.55,
        opacityCurve: [[0, 0], [0.25, 1], [0.9, 1], [1, 0]],
      }),
  },
  {
    id: "charge.arcs",
    kind: "bolt",
    slot: "debris",
    phases: ["charge"],
    elements: ["storm", "arcane", "void"],
    only: true,
    build: (ctx) => ({
      kind: "bolt",
      anchor: anchor("caster", { socket: "leftHand", follow: true }),
      duration: ctx.phaseLength,
      toTarget: false,
      arc: "line",
      length: 0.55,
      width: 0.05,
      segments: 8,
      jitter: 0.12,
      refreshHz: 30,
      branches: 1,
      flicker: 0.6,
      opacity: 0.8,
      color: "primary",
    }),
  },
  {
    id: "charge.rise",
    kind: "particles",
    slot: "debris",
    phases: ["charge"],
    weight: 0.7,
    build: (ctx) =>
      debris(ctx, "rise", {
        at: anchor("caster", { offset: [0, -0.6, 0], follow: true }),
        duration: ctx.phaseLength,
        scale: 0.45,
      }),
  },
  {
    id: "charge.tower",
    kind: "column",
    slot: "tower",
    phases: ["charge"],
    kinds: ["buff", "summon", "portal", "shout", "pulse"],
    minI: 0.45,
    build: (ctx) => ({
      kind: "column",
      anchor: anchor("caster", { offset: [0, -0.9, 0], follow: true }),
      duration: ctx.phaseLength,
      radius: 0.7,
      topRadius: 0.2,
      height: 3.2,
      orient: "up",
      scroll: 1.8,
      noise: 0.7,
      edgeFade: 0.75,
      capFade: [0.05, 0.6],
      opacity: 0.32,
      opacityCurve: [[0, 0], [0.3, 1], [1, 1]],
      expand: [0.3, 1],
      color: "primary",
    }),
  },

  // ----- cast --------------------------------------------------------------
  {
    id: "cast.flash",
    kind: "sprite",
    slot: "release",
    phases: ["cast"],
    needs: "flash",
    build: (ctx) =>
      sprite(ctx, "flash", {
        size: clamp(0.6 + ctx.R * 0.15, 0.6, 1.6),
        at: anchor("caster", { socket: "rightHand", follow: true }),
        randomYaw: true,
        color: "glow",
      }),
  },
  {
    id: "cast.pop",
    kind: "shell",
    slot: "release",
    phases: ["cast"],
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor("caster", { socket: ctx.kind === "buff" || ctx.kind === "shout" ? "chest" : "rightHand", follow: true }),
      duration: 0.28,
      radius: clamp(0.25 + ctx.R * 0.08, 0.25, 0.8),
      style: "energy",
      fresnel: 1.2,
      noise: 0.5,
      expand: [0.3, 2.4],
      opacityCurve: [[0, 1], [1, 0]],
      color: "glow",
    }),
  },
  {
    id: "cast.stomp",
    kind: "ring",
    slot: "ground",
    phases: ["cast"],
    minI: 0.4,
    weight: 0.7,
    build: (ctx) =>
      ring(ctx, {
        radius: clamp(1 + ctx.R * 0.2, 1, 2.2),
        inner: 0.75,
        expand: [0.2, 1],
        duration: 0.45,
        at: anchor("caster", { offset: [0, -0.85, 0] }),
        soft: 0.5,
        opacity: 0.8,
        opacityCurve: [[0, 1], [1, 0]],
      }),
  },
  {
    id: "cast.slash",
    kind: "sprite",
    slot: "core",
    phases: ["cast"],
    kinds: ["melee"],
    needs: "slash",
    weight: 1.5,
    build: (ctx) =>
      sprite(ctx, "slash", {
        size: clamp(ctx.R * 1.1, 1.2, 4),
        orient: "vertical",
        at: anchor("caster", { offset: [0, 0.2, ctx.R * 0.55] }),
        color: "primary",
      }),
  },
  {
    id: "cast.cone",
    kind: "column",
    slot: "core",
    phases: ["cast"],
    kinds: ["melee", "shout"],
    build: (ctx) => ({
      kind: "column",
      anchor: anchor("caster", { offset: [0, 0.1, 0.1] }),
      duration: 0.45,
      radius: 0.15,
      topRadius: clamp(ctx.R * Math.tan(((ctx.a.angle || 45) * Math.PI) / 180) * 0.8, 0.6, 4),
      height: clamp(ctx.R, 1.2, 6),
      orient: "forward",
      scroll: 6,
      noise: 0.8,
      edgeFade: 0.75,
      capFade: [0.1, 0.35],
      // A cone is a lot of overlapping additive surface seen from behind the
      // caster; anything past ~0.4 blows out to a white wedge.
      opacity: 0.38,
      opacityCurve: [[0, 0.2], [0.3, 1], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "cast.light",
    kind: "light",
    slot: "light",
    phases: ["cast"],
    build: (ctx) =>
      light(ctx, {
        at: anchor("caster", { offset: [0, 1, 0.5] }),
        duration: 0.35,
        intensity: Math.round(20 + 50 * ctx.I),
        range: 5,
        curve: [[0, 1], [1, 0]],
      }),
  },
  {
    id: "cast.shockwave",
    kind: "ring",
    slot: "core",
    phases: ["cast"],
    kinds: ["shout", "pulse"],
    build: (ctx) =>
      ring(ctx, {
        radius: ctx.R * 1.1,
        inner: 0.82,
        expand: [0.05, 1],
        duration: clamp(0.3 + ctx.R * 0.07, 0.35, 0.9),
        at: anchor("caster", { offset: [0, -0.85, 0] }),
        soft: 0.4,
        noise: feelOf(ctx, "sharp") ? 0.3 : 0,
        opacityCurve: [[0, 1], [0.6, 0.8], [1, 0]],
      }),
  },
  {
    id: "cast.wave",
    kind: "sprite",
    slot: "ground",
    phases: ["cast"],
    kinds: ["shout"],
    needs: "wave",
    build: (ctx) =>
      sprite(ctx, "wave", {
        size: clamp(ctx.R * 0.9, 1.5, 6),
        orient: "vertical",
        at: anchor("caster", { offset: [0, 0.6, ctx.R * 0.4] }),
      }),
  },
  {
    id: "cast.pillar",
    kind: "column",
    slot: "tower",
    phases: ["cast"],
    kinds: ["buff", "shout", "summon", "portal"],
    minI: 0.3,
    build: (ctx) => ({
      kind: "column",
      anchor: anchor("caster", { offset: [0, -0.9, 0] }),
      duration: clamp(0.6 + ctx.I * 0.6, 0.6, 1.3),
      radius: ctx.kind === "buff" ? 0.45 : clamp(0.5 + ctx.R * 0.15, 0.5, 1.4),
      topRadius: ctx.kind === "buff" ? 0.3 : clamp(0.35 + ctx.R * 0.1, 0.35, 1),
      height: ctx.kind === "buff" ? clamp(3 + ctx.I * 3, 3, 6) : clamp(4 + ctx.I * 6, 4, 12),
      orient: "up",
      scroll: 3,
      noise: 0.6,
      edgeFade: 0.8,
      capFade: [0.05, 0.5],
      opacity: 0.5,
      opacityCurve: [[0, 0], [0.15, 1], [0.6, 0.8], [1, 0]],
      expand: [0.6, 1.15],
      color: feelOf(ctx, "radiant") ? "glow" : "primary",
    }),
  },
  {
    id: "cast.shake",
    kind: "shake",
    slot: "shake",
    phases: ["cast"],
    kinds: ["shout"],
    build: (ctx) => ({ kind: "shake", strength: 0.06 + 0.1 * ctx.I, duration: 0.25, frequency: 20 }),
  },

  // ----- travel ------------------------------------------------------------
  {
    id: "travel.head",
    kind: "sprite",
    slot: "head",
    phases: ["travel"],
    kinds: ["projectile"],
    needs: "bolt",
    build: (ctx) =>
      sprite(ctx, "bolt", {
        size: clamp(0.5 + ctx.R * 0.3, 0.5, 1.6),
        loop: true,
        orient: "velocity",
        duration: ctx.phaseLength,
        at: anchor("path", { follow: true }),
        color: "glow",
      }),
  },
  {
    id: "travel.orb",
    kind: "shell",
    slot: "head",
    phases: ["travel"],
    kinds: ["projectile"],
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor("path", { follow: true }),
      duration: ctx.phaseLength,
      radius: clamp(0.18 + ctx.R * 0.12, 0.18, 0.6),
      style: feelOf(ctx, "crystalline") ? "glass" : "energy",
      fresnel: 1.4,
      noise: 0.6,
      noiseSpeed: 2.5,
      spin: 6,
      color: "glow",
    }),
  },
  {
    id: "travel.trail",
    kind: "trail",
    slot: "tail",
    phases: ["travel"],
    kinds: ["projectile"],
    build: (ctx) => ({
      kind: "trail",
      anchor: anchor("path", { follow: true }),
      duration: ctx.phaseLength,
      width: clamp(0.2 + ctx.R * 0.16, 0.2, 0.9),
      length: clamp(0.18 + ctx.I * 0.25, 0.18, 0.5),
      taper: true,
      color: "primary",
      colorEnd: "secondary",
    }),
  },
  {
    id: "travel.embers",
    kind: "particles",
    slot: "tail",
    phases: ["travel"],
    kinds: ["projectile"],
    build: (ctx) =>
      debris(ctx, "drift", {
        at: anchor("path", { follow: true }),
        duration: ctx.phaseLength,
        stream: true,
        count: Math.round(40 + 60 * ctx.I),
        scale: 0.6,
      }),
  },
  {
    id: "travel.headlight",
    kind: "light",
    slot: "light",
    phases: ["travel"],
    kinds: ["projectile"],
    build: (ctx) =>
      light(ctx, {
        at: anchor("path", { follow: true }),
        duration: ctx.phaseLength,
        intensity: Math.round(12 + 30 * ctx.I),
        range: 5,
        curve: [[0, 1], [1, 1]],
      }),
  },
  {
    id: "travel.beam",
    kind: "beam",
    slot: "line",
    phases: ["travel"],
    kinds: ["beam"],
    build: (ctx) => ({
      kind: "beam",
      anchor: anchor("caster", { socket: "rightHand", follow: true }),
      duration: ctx.phaseLength,
      toTarget: true,
      length: Math.max(4, ctx.a.radius),
      width: clamp(0.18 + ctx.a.width * 0.45 + ctx.I * 0.25, 0.2, 1.1),
      core: feelOf(ctx, "sharp") ? 0.3 : 0.45,
      style: feelOf(ctx, "sharp") ? "laser" : feelOf(ctx, "heavy") ? "plasma" : "energy",
      scroll: 5 + 6 * ctx.I,
      noise: feelOf(ctx, "sharp") ? 0.25 : 0.6,
      pulse: 2 + 3 * ctx.I,
      pulseDepth: 0.15 + 0.2 * ctx.I,
      opacityCurve: [[0, 0], [0.08, 1], [0.92, 1], [1, 0]],
      color: "primary",
      colorEnd: "glow",
    }),
  },
  {
    id: "travel.beamArcs",
    kind: "bolt",
    slot: "line",
    phases: ["travel"],
    kinds: ["beam"],
    elements: ["storm", "arcane", "void"],
    only: true,
    build: (ctx) => ({
      kind: "bolt",
      anchor: anchor("caster", { socket: "rightHand", follow: true }),
      duration: ctx.phaseLength,
      toTarget: true,
      arc: "line",
      length: Math.max(4, ctx.a.radius),
      width: 0.12,
      segments: 18,
      jitter: 0.35,
      refreshHz: 28,
      branches: 2,
      flicker: 0.5,
      opacity: 0.9,
      color: "primary",
    }),
  },
  {
    id: "travel.strike",
    kind: "bolt",
    slot: "line",
    phases: ["travel"],
    kinds: ["bolt"],
    build: (ctx) => ({
      kind: "bolt",
      anchor: anchor("caster", { socket: "rightHand" }),
      duration: clamp(0.18 + ctx.I * 0.2, 0.18, 0.45),
      toTarget: true,
      arc: "line",
      length: Math.max(4, ctx.a.range),
      width: clamp(0.12 + ctx.I * 0.2, 0.12, 0.4),
      segments: 16,
      jitter: feelOf(ctx, "sharp") ? 0.7 : 0.45,
      refreshHz: 30,
      branches: 2 + Math.round(ctx.I * 3),
      branchLength: 0.35,
      flicker: 0.45,
      opacityCurve: [[0, 1], [0.7, 1], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "travel.flashbeam",
    kind: "beam",
    slot: "line",
    phases: ["travel"],
    kinds: ["bolt"],
    weight: 0.8,
    build: (ctx) => ({
      kind: "beam",
      anchor: anchor("caster", { socket: "rightHand" }),
      duration: clamp(0.14 + ctx.I * 0.16, 0.14, 0.35),
      toTarget: true,
      length: Math.max(4, ctx.a.range),
      width: clamp(0.25 + ctx.I * 0.35, 0.25, 0.8),
      core: 0.4,
      style: "laser",
      scroll: 14,
      noise: 0.2,
      pulse: 0,
      taper: 0.3,
      opacityCurve: [[0, 1], [0.5, 1], [1, 0]],
      color: "primary",
      colorEnd: "glow",
    }),
  },
  {
    id: "travel.lineLight",
    kind: "light",
    slot: "light",
    phases: ["travel"],
    kinds: ["beam", "bolt"],
    build: (ctx) =>
      light(ctx, {
        at: anchor("target", { offset: [0, 0.8, 0], follow: ctx.kind === "beam" }),
        duration: ctx.kind === "beam" ? ctx.phaseLength : 0.3,
        intensity: Math.round(18 + 50 * ctx.I),
        range: 6,
        curve: ctx.kind === "beam" ? [[0, 1], [1, 1]] : [[0, 1], [1, 0]],
        flicker: ctx.kind === "beam" ? 0.35 : 0,
      }),
  },
  {
    id: "travel.sizzle",
    kind: "particles",
    slot: "debris",
    phases: ["travel"],
    kinds: ["beam"],
    build: (ctx) =>
      debris(ctx, "burst", {
        at: anchor("target", { follow: true }),
        duration: ctx.phaseLength,
        stream: true,
        count: Math.round(30 + 60 * ctx.I),
        scale: 0.5,
      }),
  },

  // ----- impact ------------------------------------------------------------
  {
    id: "impact.burst",
    kind: "sprite",
    slot: "core",
    phases: ["impact", "tick"],
    needs: "burst",
    build: (ctx) =>
      sprite(ctx, "burst", {
        size: clamp(ctx.R * (ctx.phase === "tick" ? 0.7 : 1.6), 0.8, 10),
        at: anchor(ctx.at, { offset: [0, clamp(ctx.R * 0.45, 0.6, 2.2), 0], follow: ctx.follow }),
        randomYaw: true,
        color: "primary",
      }),
  },
  {
    id: "impact.flash",
    kind: "sprite",
    slot: "core",
    phases: ["impact", "tick"],
    kinds: ["melee", "bolt", "projectile", "debuff", "beam"],
    needs: "flash",
    build: (ctx) =>
      sprite(ctx, "flash", {
        size: clamp(ctx.R * 1.1, 0.8, 3.5),
        at: anchor(ctx.at, { offset: [0, 1, 0], follow: ctx.follow }),
        randomYaw: true,
        color: "glow",
      }),
  },
  {
    id: "impact.pop",
    kind: "shell",
    slot: "core",
    phases: ["impact", "tick"],
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor(ctx.at, { offset: [0, clamp(ctx.R * 0.3, 0.3, 1.2), 0], follow: ctx.follow }),
      duration: clamp(0.25 + ctx.R * 0.06, 0.25, 0.7),
      radius: clamp(ctx.R * (ctx.phase === "tick" ? 0.5 : 0.95), 0.3, 8),
      style: feelOf(ctx, "crystalline") ? "glass" : "energy",
      fresnel: feelOf(ctx, "sharp") ? 3 : 1.5,
      noise: 0.55,
      noiseSpeed: 2,
      expand: [0.25, 1.15],
      dissolve: [[0, 0], [0.5, 0.2], [1, 1]],
      opacityCurve: [[0, 1], [0.6, 0.9], [1, 0]],
      color: "glow",
    }),
  },
  {
    id: "impact.nova",
    kind: "ring",
    slot: "ground",
    phases: ["impact"],
    build: (ctx) =>
      ring(ctx, {
        radius: clamp(ctx.R * 1.25, 1, 12),
        inner: feelOf(ctx, "sharp") ? 0.85 : 0.7,
        expand: [0.08, 1],
        duration: clamp(0.35 + ctx.R * 0.06, 0.35, 1),
        soft: 0.4,
        noise: feelOf(ctx, "wispy") ? 0.5 : 0.15,
        at: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.85, 0] } : {}),
        opacityCurve: [[0, 1], [0.5, 0.85], [1, 0]],
      }),
  },
  {
    id: "impact.ringSprite",
    kind: "sprite",
    slot: "ground",
    phases: ["impact"],
    needs: "ring",
    weight: 0.8,
    build: (ctx) =>
      sprite(ctx, "ring", {
        size: clamp(ctx.R * 2.4, 1.6, 20),
        orient: "ground",
        at: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.8, 0] } : { offset: [0, 0.12, 0] }),
        randomYaw: true,
      }),
  },
  {
    id: "impact.scorch",
    kind: "ring",
    slot: "ground",
    phases: ["impact"],
    minI: 0.35,
    weight: 0.6,
    build: (ctx) =>
      ring(ctx, {
        radius: clamp(ctx.R * 0.7, 0.7, 6),
        inner: 0,
        expand: [0.9, 1],
        duration: clamp(1.2 + ctx.I * 1.2, 1.2, 2.4),
        soft: 1,
        noise: 0.7,
        at: anchor("ground"),
        opacity: 0.45,
        color: "secondary",
        blend: feelOf(ctx, "heavy") ? "normal" : "additive",
        opacityCurve: [[0, 1], [0.4, 0.7], [1, 0]],
      }),
  },
  {
    id: "impact.debris",
    kind: "particles",
    slot: "debris",
    phases: ["impact", "tick"],
    build: (ctx) => debris(ctx, "burst", { scale: ctx.phase === "tick" ? 0.35 : 1, at: anchor(ctx.at, { offset: [0, clamp(ctx.R * 0.3, 0.3, 1), 0], follow: ctx.follow }) }),
  },
  {
    id: "impact.dust",
    kind: "particles",
    slot: "debris",
    phases: ["impact"],
    minI: 0.3,
    weight: 0.7,
    build: (ctx) => ({
      kind: "particles",
      anchor: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.7, 0] } : { offset: [0, 0.2, 0] }),
      delay: 0.04,
      color: ctx.element === "earth" ? "#8a6a52" : "secondary",
      colorEnd: "#000000",
      blend: "normal",
      emitter: {
        emitting: false,
        rate: 0,
        max: 90,
        lifetime: [0.7, 1.6],
        shape: "sphere",
        shapeSize: [ctx.R * 0.6, 0.2, ctx.R * 0.6],
        spread: 120,
        direction: [0, 1, 0],
        speed: [0.5, 2.2],
        gravity: -0.4,
        drag: 1.8,
        turbulence: 1.2,
        sizeStart: clamp(ctx.R * 0.2, 0.25, 0.8),
        sizeEnd: clamp(ctx.R * 0.55, 0.8, 2.4),
        fadeIn: 0.15,
        opacityStart: 0.45,
        opacityEnd: 0,
        softFade: 0.8,
        space: "world",
      },
      burst: Math.round(clamp(10 + ctx.R * 8, 10, 60)),
    }),
  },
  {
    id: "impact.light",
    kind: "light",
    slot: "light",
    phases: ["impact", "tick"],
    build: (ctx) =>
      light(ctx, {
        duration: clamp(0.35 + ctx.R * 0.08, 0.35, 1),
        intensity: Math.round((30 + 120 * ctx.I) * (ctx.phase === "tick" ? 0.4 : 1) * Math.min(2, 0.7 + ctx.R * 0.3)),
        curve: [[0, 1], [0.25, 0.7], [1, 0]],
      }),
  },
  {
    id: "impact.pillar",
    kind: "column",
    slot: "tower",
    phases: ["impact"],
    minI: 0.4,
    build: (ctx) => ({
      kind: "column",
      anchor: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.9, 0] } : {}),
      duration: clamp(0.5 + ctx.I * 0.7, 0.5, 1.4),
      radius: clamp(ctx.R * 0.6, 0.5, 6),
      topRadius: clamp(ctx.R * 0.35, 0.3, 3),
      height: clamp(3 + ctx.R * 1.6, 4, 18),
      orient: "up",
      scroll: 3.5,
      noise: feelOf(ctx, "radiant") ? 0.35 : 0.7,
      edgeFade: 0.8,
      capFade: [0.05, 0.55],
      opacity: 0.4,
      opacityCurve: [[0, 0], [0.12, 1], [0.55, 0.8], [1, 0]],
      expand: [0.7, 1.1],
      color: feelOf(ctx, "radiant") ? "glow" : "primary",
    }),
  },
  {
    id: "impact.skystrike",
    kind: "bolt",
    slot: "tower",
    phases: ["impact", "tick"],
    elements: ["storm", "holy", "arcane"],
    only: true,
    build: (ctx) => ({
      kind: "bolt",
      anchor: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.8, 0] } : {}),
      duration: clamp(0.18 + ctx.I * 0.2, 0.18, 0.4),
      toTarget: false,
      arc: "sky",
      length: clamp(8 + ctx.R * 2, 10, 28),
      width: clamp(0.15 + ctx.I * 0.3 + ctx.R * 0.04, 0.15, 0.6),
      segments: 18,
      jitter: 0.8,
      refreshHz: 30,
      branches: 3,
      branchLength: 0.3,
      flicker: 0.4,
      opacityCurve: [[0, 1], [0.6, 1], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "impact.shards",
    kind: "mesh",
    slot: "thing",
    phases: ["impact"],
    elements: ["ice", "earth", "arcane"],
    only: true,
    minI: 0.4,
    build: (ctx) => ({
      kind: "mesh",
      anchor: anchor("ground"),
      duration: clamp(1 + ctx.I, 1, 2.2),
      primitive: ctx.element === "earth" ? "spike" : "crystal",
      size: clamp(ctx.R * 0.5, 0.5, 2.5),
      motion: "rise",
      count: clamp(3 + Math.round(ctx.R * 1.2), 3, 9),
      spread: clamp(ctx.R * 0.75, 0.5, 6),
      spin: 0,
      emissive: 1.2,
      opacityCurve: [[0, 1], [0.75, 1], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "impact.shake",
    kind: "shake",
    slot: "shake",
    phases: ["impact"],
    minI: 0.5,
    build: (ctx) => ({ kind: "shake", strength: clamp(0.05 + 0.2 * ctx.I * Math.min(1, ctx.R / 3), 0.05, 0.3), duration: 0.35, frequency: 18 }),
  },
  {
    id: "impact.summonRing",
    kind: "ring",
    slot: "ground",
    phases: ["impact"],
    kinds: ["summon", "portal"],
    build: (ctx) =>
      ring(ctx, {
        radius: clamp(ctx.R, 0.8, 5),
        inner: 0,
        expand: [0.3, 1],
        duration: clamp(0.8 + ctx.I, 0.8, 1.8),
        soft: 0.8,
        noise: 0.6,
        swirl: 0.6,
        spin: 1.5,
        at: anchor("ground"),
        opacity: 0.8,
        opacityCurve: [[0, 0], [0.2, 1], [0.8, 0.8], [1, 0]],
      }),
  },
  {
    id: "impact.summoned",
    kind: "mesh",
    slot: "thing",
    phases: ["impact"],
    kinds: ["summon"],
    build: (ctx) => ({
      kind: "mesh",
      anchor: anchor("ground"),
      duration: clamp(0.7 + ctx.I * 0.5, 0.7, 1.4),
      primitive: ctx.rng.pick(["crystal", "spike", "orb", "blade"]),
      size: clamp(ctx.R * 0.9, 0.8, 4),
      motion: "rise",
      spin: 0.6,
      emissive: 1.4,
      color: "primary",
    }),
  },
  {
    id: "impact.gateOpen",
    kind: "ring",
    slot: "gate",
    phases: ["impact"],
    kinds: ["portal"],
    build: (ctx) =>
      ring(ctx, {
        radius: clamp(ctx.R * 0.9, 0.8, 3),
        inner: 0,
        orient: "facing",
        height: clamp(ctx.R * 0.9, 0.9, 3),
        expand: [0.02, 1],
        ease: "out",
        duration: 0.5,
        soft: 0.6,
        swirl: 1.2,
        spin: 2,
        noise: 0.5,
        at: anchor("origin"),
        color: "glow",
      }),
  },
  {
    id: "impact.aura",
    kind: "shell",
    slot: "core",
    phases: ["impact"],
    kinds: ["buff"],
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor("caster", { offset: [0, 0.1, 0], follow: true }),
      duration: 0.5,
      radius: 1.3,
      style: "energy",
      fresnel: 1.4,
      noise: 0.5,
      expand: [0.4, 1.6],
      opacityCurve: [[0, 1], [1, 0]],
      color: "glow",
    }),
  },
  {
    id: "impact.markBurst",
    kind: "particles",
    slot: "debris",
    phases: ["impact"],
    kinds: ["debuff"],
    build: (ctx) => debris(ctx, "gather", { at: anchor("target", { offset: [0, 1, 0], follow: true }), count: 40, stream: false, scale: 0.6 }),
  },

  // ----- linger ------------------------------------------------------------
  {
    id: "linger.dome",
    kind: "shell",
    slot: "body",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse", "summon"],
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.8, 0], follow: true } : {}),
      duration: ctx.phaseLength,
      radius: Math.max(0.6, ctx.a.growTo ?? ctx.R),
      style: feelOf(ctx, "crystalline") ? "glass" : "energy",
      fresnel: 3.2,
      noise: 0.6,
      noiseScale: 1.2,
      noiseSpeed: 0.5,
      spin: 0.3,
      squash: 0.55,
      expand: ctx.a.growTo && ctx.a.growTo > ctx.a.radius ? [ctx.a.radius / ctx.a.growTo, 1] : [0.85, 1],
      opacity: 0.2,
      opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "linger.pillar",
    kind: "column",
    slot: "body",
    phases: ["linger"],
    kinds: ["zone", "channel", "summon", "portal", "beam"],
    build: (ctx) => ({
      kind: "column",
      anchor: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.8, 0], follow: true } : ctx.kind === "beam" ? { follow: true } : {}),
      duration: ctx.phaseLength,
      radius: clamp((ctx.a.growTo ?? ctx.R) * (ctx.kind === "beam" ? 0.6 : 0.95), 0.5, 8),
      topRadius: clamp((ctx.a.growTo ?? ctx.R) * 0.7, 0.3, 6),
      height: clamp(1.5 + ctx.R * 0.8, 2, 8),
      orient: "up",
      scroll: 1.2,
      noise: 0.75,
      noiseScale: 1.2,
      edgeFade: 0.85,
      capFade: [0.05, 0.7],
      spin: 0.4,
      expand: ctx.a.growTo && ctx.a.growTo > ctx.a.radius ? [ctx.a.radius / ctx.a.growTo, 1] : [1, 1],
      opacity: 0.4,
      opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "linger.floor",
    kind: "ring",
    slot: "ground",
    phases: ["linger"],
    kinds: ["zone", "channel", "pulse", "summon", "portal", "beam"],
    build: (ctx) =>
      ring(ctx, {
        radius: Math.max(0.6, ctx.a.growTo ?? ctx.R) * (ctx.kind === "beam" ? 0.7 : 1),
        inner: ctx.rng.chance(0.5) ? 0 : 0.5,
        expand: ctx.a.growTo && ctx.a.growTo > ctx.a.radius ? [ctx.a.radius / ctx.a.growTo, 1] : [1, 1],
        ease: "linear",
        duration: ctx.phaseLength,
        soft: 0.9,
        noise: 0.6,
        swirl: feelOf(ctx, "wispy") ? 0.8 : 0.2,
        spin: feelOf(ctx, "sharp") ? 1.6 : 0.5,
        at: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.85, 0], follow: true } : ctx.kind === "beam" ? { follow: true } : {}),
        opacity: 0.55,
        opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
      }),
  },
  {
    id: "linger.motes",
    kind: "particles",
    slot: "debris",
    phases: ["linger"],
    build: (ctx) =>
      debris(ctx, ctx.kind === "portal" ? "gather" : ctx.element === "blood" || ctx.element === "earth" ? "fall" : "rise", {
        at: anchor(ctx.at === "caster" ? "caster" : ctx.at === "target" ? "target" : "ground", ctx.at !== "ground" && ctx.at !== "origin" ? { offset: [0, ctx.at === "caster" ? -0.4 : 0.2, 0], follow: true } : { offset: [0, 0.3, 0] }),
        duration: ctx.phaseLength,
        stream: true,
        count: Math.round((30 + 80 * ctx.I) * Math.min(2, 0.5 + (ctx.a.growTo ?? ctx.R) * 0.3)),
        scale: 0.8,
      }),
  },
  {
    id: "linger.cloud",
    kind: "particles",
    slot: "body",
    phases: ["linger"],
    kinds: ["zone", "channel"],
    elements: ["nature", "void", "blood", "earth", "rose"],
    only: true,
    weight: 1.4,
    build: (ctx) => {
      const R = Math.max(0.6, ctx.a.growTo ?? ctx.R);
      const smoke = ctx.catalog.smoke?.[0];
      return {
        kind: "particles",
        anchor: anchor("ground", { offset: [0, 0.4, 0] }),
        duration: ctx.phaseLength,
        color: "primary",
        colorEnd: "secondary",
        blend: "normal",
        emitter: {
          emitting: false,
          rate: clamp(Math.round(R * R * 6), 12, 120),
          max: clamp(Math.round(R * R * 18), 40, 320),
          lifetime: [1.8, 3.2],
          shape: "sphere",
          shapeSize: [R * 0.9, R * 0.25, R * 0.9],
          spread: 150,
          direction: [0, 1, 0],
          speed: [0.2, 0.8],
          gravity: -0.2,
          drag: 1.6,
          turbulence: 1.4,
          turbulenceSpeed: 0.45,
          spin: 0.35,
          sizeCurve: [[0, R * 0.25], [0.25, R * 0.7], [1, R * 0.95]],
          opacityStart: 0.55,
          opacityCurve: [[0, 0], [0.15, 0.55], [0.7, 0.45], [1, 0]],
          softFade: 1.2,
          space: "world",
          ...(smoke?.texture ? { texture: smoke.texture, subUV: { cols: smoke.frames, rows: 1, mode: "life", fps: 24 } } : {}),
        },
        burst: clamp(Math.round(R * R * 5), 8, 80),
        stream: true,
      };
    },
  },
  {
    id: "linger.glow",
    kind: "light",
    slot: "light",
    phases: ["linger"],
    build: (ctx) =>
      light(ctx, {
        at: anchor(ctx.at, { offset: [0, clamp(ctx.R * 0.4, 0.6, 2), 0], follow: ctx.at !== "origin" && ctx.at !== "ground" }),
        duration: ctx.phaseLength,
        intensity: Math.round(10 + 40 * ctx.I),
        range: clamp(3 + (ctx.a.growTo ?? ctx.R) * 1.8, 4, 20),
        curve: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]],
        flicker: feelOf(ctx, "sharp") ? 0.4 : 0.15,
      }),
  },
  {
    id: "linger.wisps",
    kind: "mesh",
    slot: "aura",
    phases: ["linger"],
    kinds: ["buff", "debuff", "summon"],
    minI: 0.3,
    build: (ctx) => ({
      kind: "mesh",
      anchor: anchor(ctx.at, { offset: [0, 0.3, 0], follow: true }),
      duration: ctx.phaseLength,
      primitive: feelOf(ctx, "crystalline") ? "crystal" : "orb",
      size: 0.18,
      motion: "orbit",
      count: 3 + Math.round(ctx.I * 3),
      spread: 0.9,
      spin: 3,
      emissive: 2.5,
      opacityCurve: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]],
      color: "glow",
    }),
  },
  {
    id: "linger.ward",
    kind: "shell",
    slot: "aura",
    phases: ["linger"],
    kinds: ["buff", "debuff"],
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor(ctx.at, { offset: [0, 0.05, 0], follow: true }),
      duration: ctx.phaseLength,
      radius: 1.15,
      style: ctx.kind === "debuff" ? (feelOf(ctx, "wispy") ? "wire" : "smoke") : feelOf(ctx, "crystalline") ? "glass" : "energy",
      fresnel: 2.6,
      noise: 0.5,
      noiseSpeed: 0.8,
      spin: 0.6,
      squash: 1.35,
      opacity: ctx.kind === "debuff" ? 0.35 : 0.4,
      opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
      color: ctx.kind === "debuff" ? "secondary" : "primary",
    }),
  },
  {
    id: "linger.halo",
    kind: "ring",
    slot: "aura",
    phases: ["linger"],
    kinds: ["buff", "debuff"],
    build: (ctx) =>
      ring(ctx, {
        radius: 0.95,
        inner: ctx.kind === "debuff" ? 0 : 0.6,
        expand: [1, 1],
        duration: ctx.phaseLength,
        soft: 0.8,
        noise: 0.5,
        swirl: 0.5,
        spin: ctx.kind === "debuff" ? -1.2 : 1.2,
        at: anchor(ctx.at, { offset: [0, -0.85, 0], follow: true }),
        opacity: 0.6,
        opacityCurve: [[0, 0], [0.1, 1], [0.85, 1], [1, 0]],
        color: ctx.kind === "debuff" ? "secondary" : "primary",
      }),
  },
  {
    id: "linger.gate",
    kind: "ring",
    slot: "gate",
    phases: ["linger"],
    kinds: ["portal"],
    build: (ctx) =>
      ring(ctx, {
        radius: clamp(ctx.R * 0.9, 0.8, 3),
        inner: 0,
        orient: "facing",
        height: clamp(ctx.R * 0.9, 0.9, 3),
        expand: [1, 1],
        duration: ctx.phaseLength,
        soft: 0.55,
        swirl: 1.4,
        spin: feelOf(ctx, "sharp") ? 3 : 1.6,
        noise: 0.6,
        at: anchor("origin"),
        opacity: 0.95,
        opacityCurve: [[0, 0], [0.05, 1], [0.95, 1], [1, 0]],
        color: "primary",
      }),
  },
  {
    id: "linger.gateRim",
    kind: "ring",
    slot: "gate",
    phases: ["linger"],
    kinds: ["portal"],
    build: (ctx) =>
      ring(ctx, {
        radius: clamp(ctx.R * 0.98, 0.85, 3.2),
        inner: 0.86,
        orient: "facing",
        height: clamp(ctx.R * 0.9, 0.9, 3),
        expand: [1, 1],
        duration: ctx.phaseLength,
        soft: 0.3,
        noise: 0.4,
        spin: -0.8,
        at: anchor("origin"),
        opacity: 1,
        opacityCurve: [[0, 0], [0.05, 1], [0.95, 1], [1, 0]],
        color: "glow",
      }),
  },
  {
    id: "linger.gateShell",
    kind: "shell",
    slot: "body",
    phases: ["linger"],
    kinds: ["portal"],
    weight: 0.7,
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor("origin", { offset: [0, clamp(ctx.R * 0.9, 0.9, 3), 0] }),
      duration: ctx.phaseLength,
      radius: clamp(ctx.R * 1.05, 0.9, 3.4),
      style: "wire",
      fresnel: 2,
      noise: 0.8,
      noiseSpeed: 0.7,
      spin: 0.8,
      opacity: 0.35,
      opacityCurve: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]],
      color: "secondary",
    }),
  },
  {
    id: "linger.summoned",
    kind: "mesh",
    slot: "thing",
    phases: ["linger"],
    kinds: ["summon"],
    build: (ctx) => ({
      kind: "mesh",
      anchor: anchor("ground"),
      duration: ctx.phaseLength,
      primitive: ctx.rng.pick(["crystal", "spike", "orb", "blade"]),
      size: clamp(ctx.R * 0.9, 0.8, 4),
      motion: "hover",
      spin: 0.5,
      emissive: 1.4,
      opacityCurve: [[0, 1], [0.9, 1], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "linger.arcs",
    kind: "bolt",
    slot: "debris",
    phases: ["linger"],
    elements: ["storm", "arcane", "void"],
    only: true,
    build: (ctx) => ({
      kind: "bolt",
      anchor: anchor(ctx.at, { offset: [0, 0.3, 0], follow: ctx.at !== "origin" && ctx.at !== "ground" }),
      duration: ctx.phaseLength,
      toTarget: false,
      arc: "ground",
      length: clamp((ctx.a.growTo ?? ctx.R) * 0.9, 0.8, 8),
      width: 0.08,
      segments: 12,
      jitter: 0.3,
      refreshHz: 10,
      branches: 2,
      flicker: 0.7,
      opacity: 0.8,
      opacityCurve: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]],
      color: "primary",
    }),
  },

  // ----- tick --------------------------------------------------------------
  {
    id: "tick.wave",
    kind: "ring",
    slot: "ground",
    phases: ["tick"],
    kinds: ["pulse", "zone", "channel"],
    build: (ctx) =>
      ring(ctx, {
        radius: Math.max(0.6, ctx.a.growTo ?? ctx.R),
        inner: 0.85,
        expand: [0.05, 1],
        duration: clamp(0.3 + ctx.R * 0.06, 0.3, 0.8),
        soft: 0.35,
        at: anchor(ctx.at === "caster" ? "caster" : "ground", ctx.at === "caster" ? { offset: [0, -0.85, 0] } : {}),
        opacityCurve: [[0, 1], [0.6, 0.8], [1, 0]],
        color: ctx.rng.chance(0.5) ? "glow" : "primary",
      }),
  },

  // ----- end ---------------------------------------------------------------
  {
    id: "end.collapse",
    kind: "ring",
    slot: "dissipate",
    phases: ["end"],
    build: (ctx) =>
      ring(ctx, {
        radius: Math.max(0.6, ctx.a.growTo ?? ctx.R),
        inner: 0.7,
        expand: [1, 0.05],
        ease: "in",
        duration: 0.45,
        soft: 0.5,
        orient: ctx.kind === "portal" ? "facing" : "ground",
        height: ctx.kind === "portal" ? clamp(ctx.R * 0.9, 0.9, 3) : 0,
        at: anchor(ctx.at === "caster" ? "caster" : ctx.kind === "portal" ? "origin" : "ground", ctx.at === "caster" ? { offset: [0, -0.85, 0], follow: true } : {}),
        opacityCurve: [[0, 1], [1, 0]],
        color: "glow",
      }),
  },
  {
    id: "end.pop",
    kind: "shell",
    slot: "dissipate",
    phases: ["end"],
    build: (ctx) => ({
      kind: "shell",
      anchor: anchor(ctx.at, { offset: [0, ctx.at === "caster" || ctx.at === "target" ? 0.1 : clamp(ctx.R * 0.3, 0.3, 1.2), 0], follow: ctx.at === "caster" || ctx.at === "target" }),
      duration: 0.5,
      radius: ctx.at === "caster" || ctx.at === "target" ? 1.2 : Math.max(0.6, ctx.a.growTo ?? ctx.R),
      style: "energy",
      fresnel: 2,
      noise: 0.6,
      expand: [1, 1.3],
      dissolve: [[0, 0], [1, 1]],
      opacityCurve: [[0, 0.8], [1, 0]],
      color: "primary",
    }),
  },
  {
    id: "end.scatter",
    kind: "particles",
    slot: "debris",
    phases: ["end"],
    build: (ctx) =>
      debris(ctx, "burst", {
        at: anchor(ctx.at, { offset: [0, 0.4, 0], follow: ctx.at === "caster" || ctx.at === "target" }),
        scale: 0.6,
      }),
  },
  {
    id: "end.light",
    kind: "light",
    slot: "light",
    phases: ["end"],
    build: (ctx) => light(ctx, { duration: 0.5, intensity: Math.round(15 + 40 * ctx.I), curve: [[0, 1], [1, 0]] }),
  },
];

/** The grammar: which slots each phase fills, how many, and how likely. */
export interface SlotRule {
  slot: Slot;
  min: number;
  max: number;
  /** Probability the slot is filled at all when `min` is 0; scaled by intensity when `byIntensity`. */
  p?: number;
  byIntensity?: boolean;
}

export const GRAMMAR: Record<Phase, SlotRule[]> = {
  telegraph: [
    { slot: "volume", min: 1, max: 1 },
    { slot: "sigil", min: 0, max: 1, p: 0.5, byIntensity: true },
    { slot: "thing", min: 0, max: 1, p: 0.7 },
    { slot: "tower", min: 0, max: 1, p: 0.5, byIntensity: true },
  ],
  charge: [
    { slot: "gather", min: 1, max: 1 },
    { slot: "core", min: 1, max: 1 },
    { slot: "light", min: 1, max: 1 },
    { slot: "sigil", min: 0, max: 1, p: 0.6, byIntensity: true },
    { slot: "debris", min: 0, max: 1, p: 0.6 },
    { slot: "tower", min: 0, max: 1, p: 0.7, byIntensity: true },
  ],
  cast: [
    { slot: "release", min: 1, max: 1 },
    { slot: "core", min: 0, max: 1, p: 1 },
    { slot: "light", min: 1, max: 1 },
    { slot: "ground", min: 0, max: 1, p: 0.6, byIntensity: true },
    { slot: "tower", min: 0, max: 1, p: 0.75, byIntensity: true },
    { slot: "shake", min: 0, max: 1, p: 0.8 },
  ],
  travel: [
    { slot: "head", min: 0, max: 1, p: 1 },
    { slot: "tail", min: 0, max: 2, p: 1 },
    { slot: "line", min: 0, max: 2, p: 1 },
    { slot: "light", min: 1, max: 1 },
    { slot: "debris", min: 0, max: 1, p: 0.8 },
  ],
  impact: [
    { slot: "core", min: 1, max: 2 },
    { slot: "ground", min: 0, max: 2, p: 0.95 },
    { slot: "debris", min: 1, max: 2 },
    { slot: "light", min: 1, max: 1 },
    { slot: "tower", min: 0, max: 1, p: 0.55, byIntensity: true },
    { slot: "thing", min: 0, max: 1, p: 0.6 },
    { slot: "gate", min: 0, max: 1, p: 1 },
    { slot: "shake", min: 0, max: 1, p: 0.9 },
  ],
  tick: [
    { slot: "core", min: 0, max: 1, p: 0.6 },
    { slot: "ground", min: 0, max: 1, p: 1 },
    { slot: "debris", min: 1, max: 1 },
    { slot: "light", min: 0, max: 1, p: 0.5 },
    { slot: "tower", min: 0, max: 1, p: 0.25 },
  ],
  linger: [
    { slot: "body", min: 0, max: 1, p: 0.95 },
    { slot: "ground", min: 0, max: 1, p: 0.9 },
    { slot: "gate", min: 0, max: 2, p: 1 },
    { slot: "aura", min: 0, max: 2, p: 1 },
    { slot: "thing", min: 0, max: 1, p: 1 },
    { slot: "debris", min: 1, max: 2 },
    { slot: "light", min: 1, max: 1 },
  ],
  end: [
    { slot: "dissipate", min: 1, max: 1 },
    { slot: "debris", min: 0, max: 1, p: 0.8 },
    { slot: "light", min: 0, max: 1, p: 0.6 },
  ],
};

export type { VfxModule };
