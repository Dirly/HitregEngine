import type { Phase, VfxEffect, VfxModule } from "./modules.js";
import { PHASES } from "./modules.js";
import { repeatCount } from "./repeat.js";
import { isTelegraphedKind, spellTimeline, type SpellDoc } from "./spell.js";

/**
 * The invariants a generated spell must satisfy before a player sees it.
 *
 * This is the same discipline `auditAbilities` applies to gameplay, pointed at
 * presentation: generated content is only shippable because the rules are
 * mechanical. Three families —
 *
 *   budget      particles alive, lights, module count — a spell that blows
 *               the frame is rejected, because no human will review it
 *   readability the effect must never hide its own telegraph, and a lingering
 *               volume must stay see-through enough to read who is in it
 *   lifetime    an effect must be over before the ability can be cast again,
 *               or repeated casts stack into soup
 */

export interface SpellViolation {
  phase: Phase | "spell";
  /** Module index within the phase, when one module is to blame. */
  module?: number;
  rule: "budget" | "readability" | "lifetime" | "structure";
  detail: string;
}

export interface PhaseStats {
  modules: number;
  /** Live instances once every `repeat` is expanded. */
  instances: number;
  /** Worst-case particles this phase can have alive at once. */
  particles: number;
  lights: number;
  /** Seconds from phase start until its last module is done. */
  duration: number;
}

export interface SpellStats {
  phases: Partial<Record<Phase, PhaseStats>>;
  /** Worst-case particles alive across overlapping phases. */
  peakParticles: number;
  peakLights: number;
  modules: number;
  /** Seconds the whole presentation runs. */
  total: number;
}

export const BUDGET = {
  /** Particles alive at once, whole spell. */
  peakParticles: 2400,
  /** Particles one phase may put up. */
  phaseParticles: 1400,
  /** Point lights one phase may hold. */
  phaseLights: 2,
  peakLights: 3,
  modulesPerPhase: 12,
  /** Live module INSTANCES one phase may put up once `repeat` is expanded. */
  instancesPerPhase: 40,
  /** Seconds an impact may keep playing after it lands. */
  impactTail: 3,
} as const;

/** Frames assumed for a flipbook whose sheet is unknown to the audit. */
const ASSUMED_FRAMES = 20;

/** Best estimate of how long a module stays on screen (its last repeat copy included). */
export function moduleDuration(m: VfxModule, phaseLength: number): number {
  const last = (repeatCount(m) - 1) * m.repeat.every;
  if (m.duration > 0) return m.delay + last + m.duration;
  switch (m.kind) {
    case "sprite":
      return m.delay + last + (m.cell ? Math.max(0.6, phaseLength) : m.loop ? phaseLength : ASSUMED_FRAMES / Math.max(1, m.fps));
    case "particles":
      return m.delay + last + (m.stream ? phaseLength : 0) + Math.max(...m.emitter.lifetime);
    case "telegraph":
      return m.delay + last + m.windup + m.hold + 0.2;
    case "light":
    case "ring":
    case "shell":
    case "column":
    case "beam":
    case "bolt":
    case "mesh":
    case "trail":
    case "slash":
      return m.delay + last + Math.max(0.3, phaseLength);
    case "shake":
      return m.delay + last + 0.4;
    case "sound":
      return m.delay + last + 1;
  }
}

/** Worst-case particles a module can hold alive, every repeat copy counted. */
export function moduleParticles(m: VfxModule, phaseLength: number): number {
  if (m.kind !== "particles") return 0;
  const life = Math.max(...m.emitter.lifetime);
  const streamed = m.stream ? m.emitter.rate * Math.min(life, m.duration > 0 ? m.duration : phaseLength) : 0;
  return Math.min(m.emitter.max, m.burst + Math.ceil(streamed)) * repeatCount(m);
}

function phaseLengthOf(spell: SpellDoc, phase: Phase): number {
  const t = spellTimeline(spell.archetype);
  switch (phase) {
    case "telegraph":
      return t.telegraph ? t.telegraph.windup + t.telegraph.hold : spell.archetype.windup;
    case "charge":
      return t.charge?.duration ?? spell.archetype.windup;
    case "travel":
      return t.travel?.duration ?? 0.5;
    case "linger":
      return t.linger?.duration ?? 0;
    case "cast":
    case "impact":
    case "tick":
    case "end":
      return 0.8;
  }
}

export function effectStats(effect: VfxEffect, phaseLength: number): PhaseStats {
  let particles = 0;
  let lights = 0;
  let duration = 0;
  let instances = 0;
  for (const m of effect.modules) {
    particles += moduleParticles(m, phaseLength);
    if (m.kind === "light") lights += repeatCount(m);
    instances += repeatCount(m);
    duration = Math.max(duration, moduleDuration(m, phaseLength));
  }
  return { modules: effect.modules.length, instances, particles, lights, duration };
}

export function spellStats(spell: SpellDoc): SpellStats {
  const phases: Partial<Record<Phase, PhaseStats>> = {};
  let modules = 0;
  for (const phase of PHASES) {
    const effect = spell.phases[phase];
    if (!effect) continue;
    const s = effectStats(effect, phaseLengthOf(spell, phase));
    phases[phase] = s;
    modules += s.modules;
  }
  // Overlap is approximate: impact + linger + tick can all be up together;
  // charge and telegraph overlap each other; travel sits alone.
  const sum = (...names: Phase[]): [number, number] => {
    let p = 0;
    let l = 0;
    for (const n of names) {
      p += phases[n]?.particles ?? 0;
      l += phases[n]?.lights ?? 0;
    }
    return [p, l];
  };
  const early = sum("telegraph", "charge");
  const late = sum("impact", "tick", "linger");
  const travel = sum("travel", "cast");
  const tl = spellTimeline(spell.archetype);
  return {
    phases,
    peakParticles: Math.max(early[0], late[0], travel[0]),
    peakLights: Math.max(early[1], late[1], travel[1]),
    modules,
    total: tl.total,
  };
}

export function auditSpell(spell: SpellDoc): SpellViolation[] {
  const out: SpellViolation[] = [];
  const a = spell.archetype;
  const stats = spellStats(spell);

  // --- budget -------------------------------------------------------------
  if (stats.peakParticles > BUDGET.peakParticles) {
    out.push({
      phase: "spell",
      rule: "budget",
      detail: `up to ${stats.peakParticles} particles alive at once — the cap is ${BUDGET.peakParticles}; cut bursts or shorten lifetimes`,
    });
  }
  if (stats.peakLights > BUDGET.peakLights) {
    out.push({
      phase: "spell",
      rule: "budget",
      detail: `${stats.peakLights} point lights up at once — the cap is ${BUDGET.peakLights}`,
    });
  }
  for (const phase of PHASES) {
    const s = stats.phases[phase];
    if (!s) continue;
    if (s.particles > BUDGET.phaseParticles) {
      out.push({ phase, rule: "budget", detail: `${s.particles} particles in one phase (cap ${BUDGET.phaseParticles})` });
    }
    if (s.lights > BUDGET.phaseLights) {
      out.push({ phase, rule: "budget", detail: `${s.lights} lights in one phase (cap ${BUDGET.phaseLights})` });
    }
    if (s.modules > BUDGET.modulesPerPhase) {
      out.push({ phase, rule: "budget", detail: `${s.modules} modules in one phase (cap ${BUDGET.modulesPerPhase})` });
    }
    if (s.instances > BUDGET.instancesPerPhase) {
      out.push({ phase, rule: "budget", detail: `${s.instances} live instances once repeats expand (cap ${BUDGET.instancesPerPhase}) — cut a repeat count` });
    }
  }

  // --- readability --------------------------------------------------------
  if (isTelegraphedKind(a.kind) && a.windup > 0) {
    const tele = spell.phases.telegraph;
    const has = tele?.modules.some((m) => m.kind === "telegraph");
    if (!has) {
      out.push({
        phase: "telegraph",
        rule: "readability",
        detail: `${a.kind} declares a volume but draws no telegraph — the target has nothing to dodge`,
      });
    }
    // Nothing may sit ON the volume during the windup that is opaque enough to
    // hide the rim: the edge is the only number a dodge is judged against.
    const early: Phase[] = ["telegraph", "charge"];
    for (const phase of early) {
      spell.phases[phase]?.modules.forEach((m, i) => {
        if (m.anchor.at !== "origin" && m.anchor.at !== "ground") return;
        if ((m.kind === "shell" || m.kind === "column" || m.kind === "ring") && m.blend === "normal" && m.opacity > 0.45) {
          out.push({ phase, module: i, rule: "readability", detail: `${m.kind} at the volume is opaque enough to hide the telegraph rim during the windup` });
        }
      });
    }
  }
  // A lingering volume has to stay see-through: you must be able to read who
  // is standing in it, and where its edge is, for its whole life.
  spell.phases.linger?.modules.forEach((m, i) => {
    const bodyish = m.kind === "shell" || m.kind === "column";
    if (bodyish && m.blend === "normal" && m.opacity > 0.6) {
      out.push({ phase: "linger", module: i, rule: "readability", detail: `${m.kind} with normal blending at opacity ${m.opacity} hides bodies inside the volume — cap it at 0.6` });
    }
    const peakOpacity =
      m.kind === "particles"
        ? m.emitter.opacityCurve
          ? Math.max(...m.emitter.opacityCurve.map((c) => c[1]))
          : m.emitter.opacityStart
        : 0;
    if (m.kind === "particles" && m.blend === "normal" && peakOpacity > 0.7 && m.stream) {
      out.push({ phase: "linger", module: i, rule: "readability", detail: "a dense normal-blended stream in the linger phase fogs the volume — drop opacityStart below 0.7" });
    }
  });

  // --- lifetime -----------------------------------------------------------
  const impact = stats.phases.impact;
  if (impact && impact.duration > BUDGET.impactTail) {
    out.push({ phase: "impact", rule: "lifetime", detail: `impact keeps playing for ${impact.duration.toFixed(1)}s — anything past ${BUDGET.impactTail}s reads as a second effect` });
  }
  if (impact && a.cooldown > 0 && impact.duration > a.cooldown) {
    out.push({ phase: "impact", rule: "lifetime", detail: `impact (${impact.duration.toFixed(1)}s) outlives the ${a.cooldown}s cooldown — repeated casts stack into soup` });
  }
  const linger = stats.phases.linger;
  if (linger && a.duration > 0) {
    spell.phases.linger?.modules.forEach((m, i) => {
      if (m.duration > a.duration + 0.5) {
        out.push({ phase: "linger", module: i, rule: "lifetime", detail: `${m.kind} runs ${m.duration}s but the volume only lasts ${a.duration}s — the visual says "still dangerous" after it is not` });
      }
    });
  }

  // --- structure ----------------------------------------------------------
  const tl = spellTimeline(a);
  if (!spell.phases.impact || spell.phases.impact.modules.length === 0) {
    out.push({ phase: "impact", rule: "structure", detail: "no impact — the moment of truth has nothing on it" });
  }
  if (tl.travel && a.kind === "projectile" && !spell.phases.travel?.modules.some((m) => m.anchor.at === "path")) {
    out.push({ phase: "travel", rule: "structure", detail: "a projectile with nothing riding the path — the shot is invisible in flight" });
  }
  if (a.kind === "beam" && !spell.phases.travel?.modules.some((m) => m.kind === "beam" || m.kind === "bolt")) {
    out.push({ phase: "travel", rule: "structure", detail: "a beam spell without a beam or bolt module in its travel phase" });
  }
  return out;
}
