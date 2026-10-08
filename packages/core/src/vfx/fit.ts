import type { Phase, VfxModule } from "./modules.js";
import type { SpellArchetype, SpellDoc } from "./spell.js";

/**
 * Keep a spell's visuals INSIDE its damage volume.
 *
 * Presets size themselves off the archetype radius, but "sized off" is not
 * "inside": a shockwave expanding to 1.2R, a burst sprite 2.5R wide, embers
 * flung at 6 m/s for a second — each looks right alone and together they
 * paint the ground far past the edge the hit test uses. A player reads the
 * visual as the danger zone, so a visual bigger than the volume is a lie.
 *
 * `moduleReach` is how far a module's visuals go horizontally from its anchor
 * (rings and shells at full expansion, sprites and decals by half their
 * size, particles by emitter extent + how far they can actually travel with
 * their drag, stepped repeats by their last step). `fitSpellToVolume` scales
 * back every piece centred on the volume whose reach passes its edge.
 */

/** Visuals may meet the rim, not cross it. */
export const FOOTPRINT_TOLERANCE = 1.05;

/** Phases whose modules sit on the damage volume (the cast too, when the volume is centred on the caster). */
function onVolume(phase: Phase, a: SpellArchetype): boolean {
  if (phase === "impact" || phase === "tick" || phase === "linger" || phase === "end" || phase === "telegraph") return true;
  return phase === "cast" && a.range === 0 && a.kind !== "projectile" && a.kind !== "melee";
}

function curveMax(curve: number[][] | undefined): number {
  return curve && curve.length > 0 ? Math.max(...curve.map((p) => p[1] ?? 1)) : 1;
}

/** How far the stepped copies of a repeat walk from the first. */
function repeatReach(m: VfxModule): number {
  const r = m.repeat;
  if (!r || r.count <= 1) return 0;
  const step = Math.hypot(r.step[0], r.step[2]);
  return step * (r.count - 1) * Math.max(1, r.scale ** (r.count - 1)) + r.jitter;
}

/**
 * Horizontal metres a module's visuals reach from its anchor, or null for
 * kinds that have no footprint on the volume (lights, sounds, shakes, lines,
 * trails, cuts, anything riding the projectile's path).
 */
export function moduleReach(m: VfxModule): number | null {
  if (m.anchor.at === "path") return null;
  const size = curveMax(m.sizeCurve);
  let own: number | null = null;
  switch (m.kind) {
    case "ring":
      own = m.orient === "ground" ? m.radius * Math.max(m.expand[0], m.expand[1]) * size : null;
      break;
    case "decal":
      own = (Math.max(m.size, m.size / Math.max(1e-3, m.aspect)) / 2) * size;
      break;
    case "sprite":
      own = (m.size / 2) * Math.max(1, 1 / Math.max(1e-3, m.aspect)) * size + m.orbit;
      break;
    case "shell":
      own = m.radius * Math.max(m.expand[0], m.expand[1]) * size;
      break;
    case "column":
      own = Math.max(m.radius, m.topRadius ?? m.radius) * size;
      break;
    case "telegraph":
      own = m.shape === "circle" ? m.radius : null;
      break;
    case "mesh":
      own = m.spread + (m.size / 2) * size;
      break;
    case "particles": {
      const e = m.emitter;
      const vmax = Math.max(Math.abs(e.speed[0]), Math.abs(e.speed[1]));
      const life = Math.max(e.lifetime[0], e.lifetime[1]);
      const travel = e.drag > 0 ? (vmax / e.drag) * (1 - Math.exp(-e.drag * life)) : vmax * life;
      // how much of that travel is SIDEWAYS: a radial burst or a wide spread
      // is all of it; a jet straight up is only its spread's lean
      const d = e.direction;
      const flat = Math.hypot(d[0], d[2]) / Math.max(1e-6, Math.hypot(d[0], d[1], d[2]));
      const lean = e.spread >= 90 || e.radial !== "none" ? 1 : Math.min(1, flat + Math.sin((e.spread * Math.PI) / 180));
      const shape = e.shape === "point" || e.shape === "cone" ? 0 : Math.max(e.shapeSize[0], e.shapeSize[2]);
      own = shape + travel * lean + e.turbulence * 0.25 * life + Math.max(e.sizeStart, e.sizeEnd) / 2;
      break;
    }
    default:
      own = null;
  }
  return own === null ? null : own + repeatReach(m);
}

/** A copy of `m` scaled horizontally by `f` (< 1): the same look, a smaller footprint. */
export function scaleFootprint(m: VfxModule, f: number): VfxModule {
  const c = structuredClone(m) as VfxModule;
  if (c.repeat) {
    c.repeat.step = [c.repeat.step[0] * f, c.repeat.step[1], c.repeat.step[2] * f];
    c.repeat.jitter *= f;
  }
  switch (c.kind) {
    case "ring":
    case "shell":
      c.radius *= f;
      break;
    case "decal":
      c.size *= f;
      break;
    case "sprite":
      c.size *= f;
      c.orbit *= f;
      break;
    case "column":
      c.radius *= f;
      if (c.topRadius !== undefined) c.topRadius *= f;
      break;
    case "telegraph":
      c.radius *= f;
      break;
    case "mesh":
      c.spread *= f;
      c.size *= f;
      break;
    case "particles": {
      const e = c.emitter;
      e.speed = [e.speed[0] * f, e.speed[1] * f];
      e.shapeSize = [e.shapeSize[0] * f, e.shapeSize[1], e.shapeSize[2] * f];
      e.turbulence *= f;
      break;
    }
  }
  return c;
}

/**
 * Shrink one module until it reaches no further than `limit`. Some of a
 * reach does not scale (a particle's own size), so one proportional pass can
 * land just outside; a few passes close the gap.
 */
export function fitModule(m: VfxModule, limit: number): VfxModule {
  let out = m;
  for (let pass = 0; pass < 6; pass++) {
    const reach = moduleReach(out);
    if (reach === null || reach <= limit) return out;
    out = scaleFootprint(out, (limit / reach) * 0.98);
  }
  return out;
}

/** The radius a spell's visuals must stay inside: its volume, or null when it has no circular one. */
export function volumeRadius(a: SpellArchetype): number | null {
  if (a.shape !== "circle") return null;
  return Math.max(a.radius, a.growTo ?? 0);
}

/**
 * Scale back every module on the volume whose reach passes its edge. `volume`
 * overrides the archetype's radius — a game fits a spell to the ability that
 * plays it (its real damage radius, a projectile's splash), so a spell asset
 * authored at another size still tells the truth.
 */
export function fitSpellToVolume(spell: SpellDoc, volume?: { radius: number; growTo?: number }): SpellDoc {
  const R = volume ? Math.max(volume.radius, volume.growTo ?? 0) : volumeRadius(spell.archetype);
  if (!R || R <= 0) return spell;
  const limit = R * FOOTPRINT_TOLERANCE;
  const phases: SpellDoc["phases"] = { ...spell.phases };
  for (const [phase, effect] of Object.entries(spell.phases) as [Phase, NonNullable<SpellDoc["phases"][Phase]>][]) {
    if (!effect || !onVolume(phase, spell.archetype)) continue;
    phases[phase] = {
      ...effect,
      modules: effect.modules.map((m) => fitModule(m, limit)),
    };
  }
  return { ...spell, phases };
}

/** Modules on the volume that reach past its edge: [phase, index, reach, limit]. */
export function footprintOverflows(spell: SpellDoc): Array<{ phase: Phase; index: number; reach: number; limit: number }> {
  const R = volumeRadius(spell.archetype);
  if (!R) return [];
  const limit = R * FOOTPRINT_TOLERANCE;
  const out: Array<{ phase: Phase; index: number; reach: number; limit: number }> = [];
  for (const [phase, effect] of Object.entries(spell.phases) as [Phase, NonNullable<SpellDoc["phases"][Phase]>][]) {
    if (!effect || !onVolume(phase, spell.archetype)) continue;
    effect.modules.forEach((m, index) => {
      const reach = moduleReach(m);
      if (reach !== null && reach > limit * 1.001) out.push({ phase, index, reach, limit });
    });
  }
  return out;
}
