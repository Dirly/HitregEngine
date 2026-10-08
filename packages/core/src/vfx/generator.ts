import { ELEMENTS, ELEMENT_PALETTES, paletteFor, type Element, type Feel } from "./elements.js";
import { vfxModuleSchema, type AnchorAt, type Phase, type VfxEffect, type VfxModule, type VfxModuleOf } from "./modules.js";
import { GRAMMAR, decalsFor, forSchool, type Preset, type PresetContext, type SpriteCatalog } from "./presets.js";
import { PRESETS, presetById, presetsFor } from "./library.js";
import { makeRng, type Rng } from "./rng.js";
import { fitSpellToVolume } from "./fit.js";
import { BUDGET } from "./audit.js";
import {
  SPELL_KINDS,
  phasesForKind,
  shotCount,
  spellArchetypeSchema,
  spellSchema,
  spellTimeline,
  type SpellArchetype,
  type SpellDoc,
  type SpellKind,
  type StatusEffect,
} from "./spell.js";

/**
 * The spell generator: seed + archetype + element → a complete, audited
 * `SpellDoc` whose every module came from the preset library.
 *
 * It is deliberately dumb. It knows the GRAMMAR (which slots a phase fills
 * and how many), it weights presets by element and feel so the pick is
 * coherent, and it hands each preset the spell's reference numbers. All the
 * taste lives in the presets; all the safety lives in the audit. Keeping the
 * generator this thin is what lets a human retune one preset and have every
 * spell that uses it improve.
 */

export interface GenerateOptions {
  seed: number | string;
  element?: Element;
  /** Partial archetype merged over a random one of the same kind. */
  archetype?: Partial<SpellArchetype>;
  /** Aesthetic bias; defaults to the element's own. */
  feel?: Feel[];
  catalog?: SpriteCatalog;
  /** Provenance label for the catalog used (a project name, usually). */
  catalogId?: string;
  name?: string;
  /** PSX quantisation applied to every module (0 = smooth, 16–32 = pixel art). Cells per SHAPE — prefer `texel`. */
  pixel?: number;
  /** PSX look in world metres per texel, shared by every module (0 = off). Wins over `pixel`. */
  texel?: number;
  /** Alpha steps applied with `pixel` (default 4 when pixel > 0). */
  posterize?: number;
}

const KIND_NOUN: Record<SpellKind, string[]> = {
  melee: ["Strike", "Cleave", "Rend", "Slash"],
  projectile: ["Bolt", "Shot", "Lance", "Orb"],
  bolt: ["Arc", "Flash", "Lance", "Spear"],
  beam: ["Ray", "Beam", "Torrent", "Gaze"],
  area: ["Nova", "Fall", "Burst", "Ruin"],
  zone: ["Field", "Miasma", "Pool", "Bloom"],
  channel: ["Storm", "Maelstrom", "Vortex", "Well"],
  pulse: ["Pulse", "Cadence", "Heartbeat", "Tremor"],
  buff: ["Ward", "Aegis", "Mantle", "Blessing"],
  shout: ["Shout", "Roar", "Bellow", "Cry"],
  debuff: ["Mark", "Hex", "Brand", "Curse"],
  summon: ["Totem", "Pillar", "Sentinel", "Idol"],
  portal: ["Gate", "Rift", "Door", "Passage"],
};

const ELEMENT_ADJ: Record<Element, string[]> = {
  shadow: ["Shadow", "Dusk", "Umbral", "Veiled", "Hollow"],
  holy: ["Radiant", "Sacred", "Dawn", "Hallowed"],
  nature: ["Verdant", "Thorn", "Spore", "Bramble"],
  water: ["Tidal", "Frost", "Brine", "Glacial", "Torrent"],
  destruction: ["Ember", "Cinder", "Storm", "Ruin", "Cataclysm"],
};

const EFFECT_NOUN: Partial<Record<StatusEffect, string[]>> = {
  root: ["Grasp", "Snare", "Bind", "Roots"],
  stun: ["Daze", "Shock", "Stupor", "Bell"],
  slow: ["Mire", "Drag", "Weight", "Torpor"],
  haste: ["Rush", "Quickening", "Stride", "Gale"],
  shield: ["Ward", "Bulwark", "Aegis", "Shell"],
  heal: ["Mending", "Balm", "Renewal", "Grace"],
  shadow: ["Veil", "Cloak", "Shroud", "Eclipse"],
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, step = 0.05): number => Math.round(v / step) * step;

/** Baseline run speed and reaction time the dodgeability rule assumes. */
export const DODGE_SPEED = 6.5;
export const DODGE_REACTION = 0.15;

/**
 * A random archetype of `kind`, inside bands that play well — and that pass
 * the combat audit's dodgeability rule, so a randomized spell is never one a
 * player could not have cleared.
 */
export function randomArchetype(rng: Rng, kind?: SpellKind, intensity?: number): SpellArchetype {
  const k = kind ?? rng.pick(SPELL_KINDS);
  const I = intensity ?? round(rng.range(0.25, 0.95));
  const base: Partial<SpellArchetype> = { kind: k, intensity: I, cooldown: round(2 + 12 * I, 0.5) };
  const r = (min: number, max: number, step = 0.1): number => round(rng.range(min, max), step);
  let a: Partial<SpellArchetype>;
  switch (k) {
    case "melee":
      a = { shape: "cone", radius: r(2, 3.5), angle: r(40, 80, 5), range: 0, windup: r(0.15, 0.5) };
      break;
    case "projectile": {
      a = { shape: "circle", radius: r(0.8, 2.2), range: r(12, 24, 1), speed: r(16, 30, 1), windup: r(0.25, 0.5) };
      // rapid fire: several lighter shots, a small blast each
      if (rng.chance(0.35)) {
        // a BARRAGE: many small shots in a fast rhythm, scattered at the hand
        a.volley = { count: rng.int(5, 12), interval: r(0.04, 0.09, 0.01), spread: r(6, 18, 1), jitter: r(0.15, 0.4, 0.05) };
        a.radius = r(0.6, 1.2);
        // rapid fire weaves: a burst of dead-straight shots reads as a laser
        a.wiggle = { amplitude: r(0.2, 0.6), wavelength: r(3, 7, 0.5), vertical: r(0.1, 0.4) };
      }
      // seekers: slower, so the steering is something you can watch and out-run
      if (rng.chance(0.3)) {
        a.homing = { turnRate: r(90, 220, 10), acquire: r(18, 28, 1), cone: r(30, 50, 5) };
        a.speed = r(12, 20, 1);
      }
      break;
    }
    case "bolt":
      a = { shape: "point", radius: r(0.8, 1.5), range: r(10, 20, 1), windup: r(0.2, 0.6) };
      break;
    case "beam":
      a = { shape: "line", radius: r(8, 16, 1), width: r(0.4, 1), range: r(8, 16, 1), windup: r(0.3, 0.7), duration: r(1.5, 3.5), ticksPerSecond: r(4, 8, 1) };
      break;
    case "area": {
      const shape = rng.weighted([{ w: 3, v: "circle" as const }, { w: 1, v: "cone" as const }, { w: 1, v: "line" as const }]);
      const radius = shape === "circle" ? r(2.5, 6) : r(4, 9);
      a = { shape, radius, angle: r(30, 70, 5), width: r(0.8, 1.6), range: shape === "circle" ? r(0, 16, 1) : 0 };
      break;
    }
    case "zone": {
      const radius = r(2, 4);
      a = { shape: "circle", radius, growTo: rng.chance(0.6) ? round(radius * rng.range(1.5, 2.4)) : undefined, range: r(6, 12, 1), duration: r(4, 8, 0.5), ticksPerSecond: r(1, 2, 1) };
      break;
    }
    case "channel":
      a = { shape: "circle", radius: r(2.5, 4.5), range: r(4, 10, 1), duration: r(2, 4, 0.5), ticksPerSecond: r(3, 5, 1) };
      break;
    case "pulse":
      a = { shape: "circle", radius: r(3, 6), range: 0, windup: r(0.3, 0.6), duration: r(2, 4, 0.5), ticksPerSecond: r(1, 2, 0.5) };
      break;
    case "buff":
      a = { shape: "point", radius: 1.2, range: 0, windup: r(0.6, 1.2), duration: r(4, 8, 0.5) };
      break;
    case "shout":
      a = { shape: "circle", radius: r(4, 7), range: 0, windup: r(0.2, 0.5) };
      break;
    case "debuff":
      a = { shape: "point", radius: 1, range: r(8, 16, 1), windup: r(0.3, 0.8), duration: r(3, 6, 0.5), ticksPerSecond: rng.chance(0.5) ? 1 : 0 };
      break;
    case "summon":
      a = { shape: "circle", radius: r(1.5, 3), range: r(4, 10, 1), windup: r(0.8, 1.5), duration: r(4, 8, 0.5) };
      break;
    case "portal":
      a = { shape: "circle", radius: r(1.5, 2.5), range: r(3, 8, 1), windup: r(0.8, 1.4), duration: r(4, 8, 0.5) };
      break;
  }
  // What the payload does, as a look. Buffs and debuffs are usually a status;
  // damage kinds occasionally carry one (a rooting nova, a stunning bolt).
  const statusPool: StatusEffect[] =
    k === "buff" ? ["haste", "shield", "heal", "shadow"] : k === "debuff" ? ["root", "stun", "slow", "shadow"] : ["damage", "damage", "damage", "root", "stun", "slow"];
  const effect = a.effect ?? rng.pick(statusPool);
  const channelled = (k === "buff" || k === "debuff") && rng.chance(0.4);
  if (k === "buff" || k === "debuff") {
    // A status flashes when it lands and lingers briefly — unless it is
    // CHANNELLED, in which case the aura holds while the caster holds it.
    a.duration = channelled ? r(3, 6, 0.5) : r(0.6, 1.4);
  }
  const merged = spellArchetypeSchema.parse({ ...base, ...a, effect, channelled });
  // The dodgeability invariant: radius <= DODGE_SPEED * (windup - REACTION).
  if (k === "area" || k === "zone" || k === "channel" || k === "summon") {
    const need = merged.radius / DODGE_SPEED + DODGE_REACTION + 0.08;
    merged.windup = round(Math.max(merged.windup, need, rng.range(0.5, 0.9)));
  }
  return merged;
}

/** Where a phase's modules sit by default, and whether they ride the anchor. */
export function phaseAnchor(kind: SpellKind, phase: Phase): { at: AnchorAt; follow: boolean } {
  switch (phase) {
    case "telegraph":
      return { at: "origin", follow: false };
    case "charge":
    case "cast":
      return { at: "caster", follow: true };
    case "travel":
      return kind === "projectile" ? { at: "path", follow: true } : { at: "caster", follow: true };
    case "impact":
    case "tick":
    case "linger":
    case "end":
      if (kind === "buff" || kind === "pulse" || kind === "shout") return { at: "caster", follow: true };
      if (kind === "debuff") return { at: "target", follow: true };
      return { at: "origin", follow: false };
  }
}

function phaseLength(a: SpellArchetype, phase: Phase): number {
  const t = spellTimeline(a);
  switch (phase) {
    case "telegraph":
      return t.telegraph ? t.telegraph.windup + t.telegraph.hold : a.windup;
    case "charge":
      return t.charge?.duration ?? a.windup;
    case "travel":
      return t.travel?.duration ?? 0.3;
    case "linger":
      return t.linger?.duration ?? 0;
    default:
      return 0;
  }
}

function makeContext(spell: SpellDoc, phase: Phase, rng: Rng, catalog: SpriteCatalog, pixel = 0): PresetContext {
  const a = spell.archetype;
  const point = a.shape === "point";
  const anchorInfo = phaseAnchor(a.kind, phase);
  // A line's `radius` is its LENGTH; what the visuals should scale from is
  // how wide it is — a 16 m beam is not a 16 m explosion. A cone's is its
  // REACH: a 3 m cleave is not a 3 m blast on the caster's head either.
  const R = a.shape === "line" ? clamp(a.width * 2.5, 0.8, 4) : a.shape === "cone" ? clamp(a.radius * 0.45, 0.8, 3) : Math.max(point ? 0.8 : 0.6, a.radius);
  return {
    rng,
    R,
    I: a.intensity,
    a,
    kind: a.kind,
    element: spell.element,
    palette: spell.palette ?? paletteFor(spell.element),
    feel: spell.feel,
    catalog,
    phase,
    effect: a.effect,
    pixel,
    phaseLength: phaseLength(a, phase),
    at: anchorInfo.at,
    follow: anchorInfo.follow,
  };
}

function eligible(preset: Preset, ctx: PresetContext): boolean {
  if (ctx.catalog.disabledPresets?.includes(preset.id)) return false;
  if (preset.kinds && !preset.kinds.includes(ctx.kind)) return false;
  if (preset.only && preset.elements && !preset.elements.includes(ctx.element)) return false;
  if (preset.needs && !(ctx.catalog[preset.needs]?.length)) return false;
  if (preset.minI !== undefined && ctx.I < preset.minI) return false;
  if (preset.effects && !preset.effects.includes(ctx.effect)) return false;
  if (preset.needsMask && !ctx.catalog.masks?.some((m) => m.tags.some((tag) => preset.needsMask!.includes(tag)))) return false;
  if (
    preset.needsSymbol &&
    !ctx.catalog.symbols?.some(
      (s) => s.enabled && s.roles.some((r) => preset.needsSymbol!.includes(r)) && (!s.elements?.length || s.elements.includes(ctx.element)),
    )
  )
    return false;
  if (preset.needsDecal && decalsFor(ctx.catalog, ctx.element).length === 0) return false;
  return true;
}

/**
 * PSX quantisation on everything that shades procedurally; particles get
 * square sprites; flipbooks and symbols go nearest-filtered; trails and
 * telegraphs dither on a world grid.
 */
function applyPixel(modules: VfxModule[], pixel: number, steps: number, texel = 0): void {
  for (const m of modules) {
    if (m.kind === "ring" || m.kind === "shell" || m.kind === "column" || m.kind === "beam" || m.kind === "slash" || m.kind === "trail" || m.kind === "telegraph") {
      m.pixel = pixel;
      m.posterize = steps;
    }
    if (m.kind === "sprite") m.pixel = pixel;
    // one world texel for the whole spell: every textured and procedural kind
    if (texel > 0 && m.kind !== "particles" && m.kind !== "light" && m.kind !== "shake" && m.kind !== "sound") m.texel = texel;
    if (m.kind === "particles" && !m.emitter.texture && m.emitter.sprite === "soft") {
      m.emitter.sprite = m.emitter.stretch > 0 ? "square" : "pixel";
    }
    // the same alpha bands the procedural modules get, on the particle ramp
    if (m.kind === "particles" && m.emitter.steps === 0) m.emitter.steps = steps;
  }
}

function weightOf(preset: Preset, ctx: PresetContext): number {
  let w = preset.weight ?? 1;
  if (preset.elements?.includes(ctx.element)) w *= 2.2;
  const overlap = preset.feel?.filter((f) => ctx.feel.includes(f)).length ?? 0;
  w *= 1 + overlap * 0.8;
  return w;
}

/** Build one module from a preset; null when the preset declines (missing sprite role). */
export function buildFromPreset(preset: Preset, ctx: PresetContext): VfxModule | null {
  const raw = preset.build(ctx);
  if (!raw) return null;
  const m = vfxModuleSchema.parse({ ...raw, preset: preset.id });
  if (m.kind === "mesh") {
    drawnBodies(m, ctx);
    // Derek: no generated cones, diamonds or solid spheres. Without a drawing
    // for them (or a model asset) those bodies are simply not made.
    if (!m.asset && !m.sheet && BANNED_PRIMITIVES.has(m.primitive)) return null;
  }
  return m;
}

/** Procedural bodies that are never generated as 3D: they read as placeholder geometry. */
const BANNED_PRIMITIVES = new Set(["spike", "crystal", "orb"]);

/**
 * Summoned bodies as DRAWINGS: when the school has `object` symbols, a
 * procedural mesh (no model asset) becomes camera-facing billboards of the
 * matching kind — a spike stays a spike, a rock a rock — so what a spell
 * raises is drawn in the same hand as its sigils. Each body gets its own
 * cell, picked by the spell's rng.
 */
function drawnBodies(m: VfxModuleOf<"mesh">, ctx: PresetContext): void {
  if (m.asset || m.sheet) return;
  const pool = forSchool(
    (ctx.catalog.symbols ?? []).filter((s) => s.enabled && s.roles.includes("object")),
    ctx.element,
  );
  if (pool.length === 0) return;
  const same = pool.filter((s) => s.tags.includes(m.primitive));
  const list = same.length > 0 ? same : pool;
  const sheet = ctx.rng.pick(list).sheet;
  const onSheet = list.filter((s) => s.sheet === sheet);
  m.sheet = sheet;
  m.cells = Array.from({ length: Math.min(12, m.count) }, () => ctx.rng.pick(onSheet).cell);
}

/** Generate one phase's effect for a spell. */
export function generatePhase(spell: SpellDoc, phase: Phase, rng: Rng, catalog: SpriteCatalog = {}, style: SpellStyle = {}): VfxEffect {
  // presets only ask "is the PSX look on?"; a texel grid counts as on
  const pixel = style.texel && style.texel > 0 ? Math.max(1, style.pixel ?? 24) : (style.pixel ?? 0);
  const ctx = makeContext(spell, phase, rng, catalog, pixel);
  const modules: VfxModule[] = [];
  for (const rule of GRAMMAR[phase]) {
    let n = rule.min;
    if (rule.max > rule.min) {
      const p = (rule.p ?? 1) * (rule.byIntensity ? 0.35 + 0.9 * ctx.I : 1);
      for (let i = rule.min; i < rule.max; i++) if (rng.chance(p)) n++;
    }
    if (n === 0) continue;
    let candidates = presetsFor(phase, rule.slot).filter((p) => eligible(p, ctx));
    for (let i = 0; i < n && candidates.length > 0; i++) {
      const pick = rng.weighted(candidates.map((p) => ({ w: weightOf(p, ctx), v: p })));
      const built = buildFromPreset(pick, ctx);
      if (built) modules.push(built);
      // No repeats within a slot unless nothing else is on offer.
      const rest = candidates.filter((p) => p !== pick);
      if (rest.length > 0) candidates = rest;
    }
  }
  if (phase === "impact" && spell.archetype.cooldown > 0) fitLifetime(modules, Math.max(0.6, spell.archetype.cooldown));
  if (pixel > 0) applyPixel(modules, pixel, style.posterize ?? 4, style.texel ?? 0);
  return { name: phase, tags: { role: phase, feel: spell.feel }, modules };
}

/**
 * Keep an impact inside the ability's cooldown: a spammable poke whose
 * impact outlives its own cooldown stacks into soup, which the audit
 * rejects — so the generator shortens what it made rather than shipping it.
 */
function fitLifetime(modules: VfxModule[], cap: number): void {
  for (const m of modules) {
    const room = Math.max(0.15, cap - m.delay);
    if (m.duration > room) m.duration = round(room, 0.01);
    if (m.kind === "particles") {
      const [lo, hi] = m.emitter.lifetime;
      if (hi > room) m.emitter.lifetime = [round(Math.min(lo, room * 0.6), 0.01), round(room, 0.01)];
    }
    if (m.kind === "sprite" && !m.loop && m.duration === 0 && 20 / m.fps > room) {
      m.duration = round(room, 0.01);
    }
  }
}

/** Generate every phase the archetype uses, keeping everything else on the spell. */
/** The spell-wide look: PSX cells per shape (legacy), world texel size, alpha bands. */
export interface SpellStyle {
  pixel?: number;
  texel?: number;
  posterize?: number;
}

export function generatePhases(spell: SpellDoc, catalog: SpriteCatalog = {}, style: SpellStyle = {}): SpellDoc {
  const rng = makeRng(spell.seed);
  const phases: SpellDoc["phases"] = {};
  for (const phase of phasesForKind(spell.archetype)) {
    // Derek: no generated telegraph. The dodge volume is the GAME's to draw
    // (the host's telegraph pool reads the ability, not the spell); a second
    // one baked into the spell only doubled it.
    if (phase === "telegraph") continue;
    phases[phase] = generatePhase(spell, phase, rng.fork(phase), catalog, style);
  }
  shapeVolley(spell.archetype, phases);
  // every visual on the damage volume stays inside it (see fit.ts)
  return fitSpellToVolume({ ...spell, phases, texel: style.texel ?? 0 });
}

export function generateSpell(opts: GenerateOptions): SpellDoc {
  const rng = makeRng(opts.seed);
  const element = opts.element ?? rng.pick(ELEMENTS);
  const kind = opts.archetype?.kind;
  const archetype = spellArchetypeSchema.parse({
    ...randomArchetype(rng.fork("archetype"), kind, opts.archetype?.intensity),
    ...stripUndefined(opts.archetype ?? {}),
  });
  const feel = opts.feel ?? [...ELEMENT_PALETTES[element].feel];
  const nameRng = rng.fork("name");
  const noun = EFFECT_NOUN[archetype.effect] && archetype.effect !== "damage" ? EFFECT_NOUN[archetype.effect]! : KIND_NOUN[archetype.kind];
  const name = opts.name ?? `${nameRng.pick(ELEMENT_ADJ[element])} ${nameRng.pick(noun)}`;
  const seed = typeof opts.seed === "number" ? opts.seed : hashToInt(opts.seed);
  const spell = spellSchema.parse({
    name,
    element,
    feel,
    seed,
    archetype,
    phases: {},
    ...(opts.catalogId ? { catalog: opts.catalogId } : {}),
  });
  return generatePhases(spell, opts.catalog ?? {}, { pixel: opts.pixel, texel: opts.texel, posterize: opts.posterize });
}

/**
 * Replace one module with a different preset from the same slot — the lab's
 * "reroll this" button. Returns the new module, or null when the slot has no
 * alternative.
 */
export function rerollModule(spell: SpellDoc, phase: Phase, index: number, seed: number | string, catalog: SpriteCatalog = {}): VfxModule | null {
  const effect = spell.phases[phase];
  const current = effect?.modules[index];
  if (!effect || !current) return null;
  const preset = current.preset ? presetById(current.preset) : undefined;
  const slot = preset?.slot;
  const rng = makeRng(`${spell.seed}:${phase}:${index}:${seed}`);
  const ctx = makeContext(spell, phase, rng, catalog);
  const candidates = PRESETS.filter((p) => p.phases.includes(phase) && (slot ? p.slot === slot : p.kind === current.kind) && eligible(p, ctx));
  const others = candidates.filter((p) => p.id !== current.preset);
  const pool = others.length > 0 ? others : candidates;
  if (pool.length === 0) return null;
  const pick = rng.weighted(pool.map((p) => ({ w: weightOf(p, ctx), v: p })));
  return fitted(spell, phase, buildFromPreset(pick, ctx));
}

/**
 * A VOLLEY plays travel and impact once per shot, so what one shot carries is
 * multiplied by the burst: the per-shot presentation is lightened to keep a
 * six-shot barrage inside the budget one heavy bolt fits in — no light per
 * shot (six point lights would each re-light the scene), particles thinned by
 * √shots, smaller heads — and the CAST repeats with the burst, so every shot
 * leaves the hand with its own flash instead of one flash for six shots.
 */
function shapeVolley(a: SpellArchetype, phases: SpellDoc["phases"]): void {
  const shots = shotCount(a);
  if (shots <= 1) return;
  const thin = 1 / Math.sqrt(shots);
  // the more shots, the smaller each: 3 → ~0.64×, 6 → ~0.45×
  const small = Math.max(0.4, 1.1 / Math.sqrt(shots));
  for (const phase of ["travel", "impact"] as const) {
    const eff = phases[phase];
    if (!eff) continue;
    eff.modules = eff.modules.filter((m) => m.kind !== "light" && m.kind !== "shake");
    for (const m of eff.modules) {
      if (m.kind === "particles") {
        m.burst = Math.max(2, Math.round(m.burst * thin));
        m.emitter.rate = Math.max(2, Math.round(m.emitter.rate * thin));
        m.emitter.max = Math.max(6, Math.round(m.emitter.max * thin));
      }
      if (phase === "travel") {
        if (m.kind === "sprite") m.size = Math.round(m.size * small * 100) / 100;
        if (m.kind === "shell") m.radius = Math.round(m.radius * small * 100) / 100;
        if (m.kind === "trail") m.width = Math.round(m.width * small * 100) / 100;
        if (m.kind === "particles") {
          m.emitter.sizeStart *= small;
          m.emitter.sizeEnd *= small;
          m.emitter.shapeSize = [m.emitter.shapeSize[0] * small, m.emitter.shapeSize[1] * small, m.emitter.shapeSize[2] * small];
        }
      }
    }
  }
  // each shot's impact is a LEAN one: no stepping repeats, and only the most
  // telling pieces — the burst, then what it throws, then its mark — until
  // the whole burst fits the per-phase instance cap
  const impact = phases.impact;
  if (impact) {
    const rank: Record<string, number> = { core: 0, debris: 1, ground: 2, scar: 3, thing: 4 };
    for (const m of impact.modules) if (m.repeat.count > 1) m.repeat = { ...m.repeat, count: 1 };
    impact.modules = impact.modules
      .map((m, i) => ({ m, i, r: rank[presetById(m.preset ?? "")?.slot ?? ""] ?? 9 }))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .slice(0, Math.max(1, Math.floor(BUDGET.instancesPerPhase / shots)))
      .sort((x, y) => x.i - y.i)
      .map((x) => x.m);
  }
  const cast = phases.cast;
  if (cast) {
    for (const m of cast.modules) {
      if (m.kind === "light" || m.kind === "shake" || m.kind === "sound") continue;
      if (m.repeat.count > 1) continue;
      m.repeat = { ...m.repeat, count: shots, every: a.volley.interval };
      if (m.kind === "particles") m.burst = Math.max(2, Math.round(m.burst * thin));
    }
  }
}

/** One new module, fitted to the spell's volume like everything generated. */
function fitted(spell: SpellDoc, phase: Phase, m: VfxModule | null): VfxModule | null {
  if (!m) return null;
  const probe: SpellDoc = { ...spell, phases: { [phase]: { name: phase, tags: { feel: [] }, modules: [m] } } };
  return fitSpellToVolume(probe).phases[phase]!.modules[0]!;
}

/** Build a fresh module of a given preset for a phase (the lab's "add" menu). */
export function addFromPreset(spell: SpellDoc, phase: Phase, presetId: string, seed: number | string, catalog: SpriteCatalog = {}): VfxModule | null {
  const preset = presetById(presetId);
  if (!preset) return null;
  const rng = makeRng(`${spell.seed}:${phase}:${presetId}:${seed}`);
  return fitted(spell, phase, buildFromPreset(preset, makeContext(spell, phase, rng, catalog)));
}

/** Presets that could go in this phase of this spell — for the lab's add menu. */
export function presetsAvailable(spell: SpellDoc, phase: Phase, catalog: SpriteCatalog = {}): Preset[] {
  const ctx = makeContext(spell, phase, makeRng(0), catalog);
  return PRESETS.filter((p) => p.phases.includes(phase) && eligible(p, ctx));
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
