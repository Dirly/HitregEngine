import type { VfxEffect, VfxModuleOf } from "./modules.js";

/**
 * THE SMOKE STANDARD — one place every smoke in the game is measured against (Derek, 2026-10-22: "that smoke from the
 * castle needs to be turned down by a lot"; the Ravenstacks plume read at 300 m as a dark smear taller and wider than
 * the castle). Smoke is a thin column that thins to nothing within a few times its source's height; it is never a
 * cloud that reads larger than the thing burning, never near-black, never glowing at night, and it leans with the wind.
 *
 * A smoke layer is a normal-blended `particles` module. Its plume is measured from the emitter numbers alone
 * ({@link measurePlume}, worst case: the longest life, the fastest particle, full wind), so the gate
 * (tools/smoke-check.mts, `zonegen status` row `smoke`) needs no renderer. The chimney batch (render chimney-smoke.ts)
 * takes its numbers from {@link CHIMNEY_SMOKE}.
 */
export type SmokeClass = "chimney" | "kiln" | "fire" | "pyre";

export interface SmokeCap {
  /** The plume's visible top, above the source's ground, at most this many times the source's height... */
  topX: number;
  /** ...but a small source may always reach this (m): a wisp needs room to read as smoke. */
  minTop: number;
  /** Hard ceiling on the plume's visible top above the source's ground (m), whatever the source. */
  maxTop: number;
  /** Plume width at most this many times the source's width (never under 1 m)... */
  widthX: number;
  /** ...and never wider than this (m). */
  maxWidth: number;
  /** Peak per-particle opacity. */
  opacity: number;
  what: string;
}

export const SMOKE_CLASSES: Record<SmokeClass, SmokeCap> = {
  chimney: { topX: 2, minTop: 4, maxTop: 24, widthX: 2, maxWidth: 1.5, opacity: 0.35, what: "chimney/hearth: a thin column <= 1.5 m wide, gone by ~2x the chimney height" },
  kiln: { topX: 3, minTop: 4, maxTop: 8, widthX: 2, maxWidth: 1.6, opacity: 0.4, what: "kiln/forge: one thread per kiln, slightly denser" },
  fire: { topX: 3, minTop: 3, maxTop: 9, widthX: 2, maxWidth: 3, opacity: 0.35, what: "camp fire/brazier/torch: a small wisp" },
  pyre: { topX: 3, minTop: 6, maxTop: 14, widthX: 2, maxWidth: 6, opacity: 0.35, what: "pyre/burnt ruin: a moderate translucent column, <= 3x the source" },
};

/** Smoke colours are pale grey: relative luminance of the start and end colour at least this (sRGB #6b6b6b ~ 0.15). */
export const SMOKE_MIN_LUMINANCE = 0.15;
/** A smoke layer must darken at night at least this much (`nightDim`): particles are unlit, pale smoke would glow. */
export const SMOKE_MIN_NIGHT_DIM = 0.5;
/** A smoke layer must drift with the wind (`windDrift` m/s, world space): the lean is live, never a pooled cloud. */
export const SMOKE_MIN_WIND_DRIFT = 0.2;
/** Opacity below this is "gone": the visible plume ends where the curve drops under it. */
export const SMOKE_VISIBLE_OPACITY = 0.04;

/** The chimney batch's numbers (render chimney-smoke.ts reads these; the gate checks them as a chimney-class plume). */
export const CHIMNEY_SMOKE = {
  /** Puffs cycling per chimney. */
  puffs: 8,
  /** Seconds one puff takes to rise and fade. */
  period: 7,
  /** Metres one puff rises over its life. */
  rise: 3.5,
  /** Puff quad width at birth and how much it grows over its life (width = start + grow * age). */
  sizeStart: 0.3,
  sizeGrow: 0.6,
  /** Peak opacity of a fully lit chimney. */
  opacity: 0.3,
  /** Metres the wind leans a puff over its life at full wind. */
  lean: 0.6,
  /** Day colour (linear rgb): a pale grey a shade under the cloud deck. */
  day: [0.42, 0.41, 0.4] as [number, number, number],
  /** Night colour (linear rgb): a moonlit grey, never brighter than the night sky around it. */
  night: [0.1, 0.11, 0.13] as [number, number, number],
};

export interface PlumeMeasure {
  /** Visible top above the emitter's origin (m): anchor + rise + half the last visible puff. */
  top: number;
  /** Metres the puffs climb while visible. */
  rise: number;
  /** Widest the plume gets while visible (m), lean and spread included. */
  width: number;
  /** Peak per-particle opacity. */
  opacity: number;
  /** Seconds a puff stays visible (worst case). */
  visibleSeconds: number;
}

type Emitter = VfxModuleOf<"particles">["emitter"];

function sample(curve: Array<[number, number]>, t: number): number {
  if (t <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [t1, v1] = curve[i]!;
    const [t0, v0] = curve[i - 1]!;
    if (t <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return curve[curve.length - 1]![1];
}

/** A small deterministic generator, so the gate measures the same plume every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (v: number[], p: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!;
};

/**
 * The plume a smoke emitter draws, measured by running the engine's own particle integrator (render particles.ts:
 * spawn in the shape, aim within `spread`, gravity, the per-particle turbulence wander, linear drag; the wind at full
 * strength along +X) for a few hundred seeded particles and sampling every one that is still visible (opacity >=
 * SMOKE_VISIBLE_OPACITY). top = the 95th percentile of puff tops; width = the 5..95 % band of puff centres across the
 * wider horizontal axis plus the 90th percentile puff size. `anchorY` = the emitter's height over the source ground.
 */
export function measurePlume(e: Emitter, anchorY = 0): PlumeMeasure {
  const op = (t: number) =>
    e.opacityCurve?.length
      ? sample(e.opacityCurve, t)
      : e.fadeIn > 0 && t < e.fadeIn
        ? e.opacityStart * (t / e.fadeIn)
        : e.opacityStart + (e.opacityEnd - e.opacityStart) * t;
  const size = (t: number) => {
    const s = e.sizeCurve?.length ? sample(e.sizeCurve, t) : e.sizeStart + (e.sizeEnd - e.sizeStart) * t;
    return e.snap && e.snap > 0 && s > 0 ? Math.max(e.snap, Math.round(s / e.snap) * e.snap) : s;
  };
  let peak = 0;
  for (let i = 0; i <= 100; i++) peak = Math.max(peak, op(i / 100));
  const R = rng(0x5e0ce);
  const [dx0, dy0, dz0] = e.direction;
  const dl = Math.hypot(dx0, dy0, dz0) || 1;
  const [ax, ay, az] = [dx0 / dl, dy0 / dl, dz0 / dl];
  // a basis around the aim, for the spread cone
  const ux = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const b1 = [ay * ux[2]! - az * ux[1]!, az * ux[0]! - ax * ux[2]!, ax * ux[1]! - ay * ux[0]!];
  const b1l = Math.hypot(b1[0]!, b1[1]!, b1[2]!) || 1;
  const p1 = [b1[0]! / b1l, b1[1]! / b1l, b1[2]! / b1l];
  const p2 = [ay * p1[2]! - az * p1[1]!, az * p1[0]! - ax * p1[2]!, ax * p1[1]! - ay * p1[0]!];
  const angle = Math.max(e.shape === "cone" ? e.coneAngle : 0, e.spread);
  const cosA = Math.cos((angle * Math.PI) / 180);
  const drift = e.space === "world" ? (e.windDrift ?? 0) : 0;
  const [sx, sy, sz] = e.shape === "sphere" || e.shape === "box" ? e.shapeSize : [0, 0, 0];
  const dt = e.frameRate && e.frameRate > 0 ? 1 / e.frameRate : 1 / 30;
  const tops: number[] = [], xs: number[] = [], zs: number[] = [], sizes: number[] = [];
  let seconds = 0;
  const N = 240;
  for (let n = 0; n < N; n++) {
    // spawn
    let ox = 0, oy = 0, oz = 0;
    if (e.shape === "sphere") {
      do { ox = R() * 2 - 1; oy = R() * 2 - 1; oz = R() * 2 - 1; } while (ox * ox + oy * oy + oz * oz > 1);
      ox *= sx!; oy *= sy!; oz *= sz!;
    } else if (e.shape === "box") {
      ox = (R() * 2 - 1) * sx!; oy = (R() * 2 - 1) * sy!; oz = (R() * 2 - 1) * sz!;
    }
    let dx = ax, dy = ay, dz = az;
    if (angle > 0) {
      const z = 1 - R() * (1 - cosA), r = Math.sqrt(Math.max(0, 1 - z * z)), phi = R() * Math.PI * 2;
      const c1 = r * Math.cos(phi), c2 = r * Math.sin(phi);
      dx = p1[0]! * c1 + p2[0]! * c2 + ax * z; dy = p1[1]! * c1 + p2[1]! * c2 + ay * z; dz = p1[2]! * c1 + p2[2]! * c2 + az * z;
    }
    const speed = e.speed[0] + R() * (e.speed[1] - e.speed[0]);
    let vx = dx * speed + drift, vy = dy * speed, vz = dz * speed;
    let x = ox, y = oy, zz = oz;
    const life = Math.max(0.05, e.lifetime[0] + R() * (e.lifetime[1] - e.lifetime[0]));
    const phase = R() * Math.PI * 2;
    // the emitter clock this particle was born on (turbulence is a field over emitter time)
    let clock = R() * 60;
    const damp = e.drag > 0 ? Math.max(0, 1 - e.drag * dt) : 1;
    for (let age = 0; age < life; age += dt) {
      const t = age / life;
      if (op(t) >= SMOKE_VISIBLE_OPACITY) {
        const s = size(t);
        tops.push(anchorY + y + s / 2); xs.push(x); zs.push(zz); sizes.push(s);
        seconds = Math.max(seconds, age);
      }
      vy -= e.gravity * dt;
      if (e.turbulence > 0) {
        const sw = e.turbulence * dt, c = clock * e.turbulenceSpeed;
        vx += Math.sin(c + phase) * sw; vy += Math.sin(c * 0.73 + phase * 2.1) * sw; vz += Math.sin(c * 1.31 + phase * 3.7) * sw;
      }
      vx *= damp; vy *= damp; vz *= damp;
      x += vx * dt; y += vy * dt; zz += vz * dt;
      clock += dt;
    }
  }
  const band = Math.max(pct(xs, 0.95) - pct(xs, 0.05), pct(zs, 0.95) - pct(zs, 0.05));
  const top = pct(tops, 0.95);
  return { top, rise: Math.max(0, top - anchorY), width: band + pct(sizes, 0.9), opacity: peak, visibleSeconds: seconds };
}


export interface SmokeLayer {
  index: number;
  id: string;
  module: VfxModuleOf<"particles">;
}

/** The smoke layers of an effect. */
export function smokeLayers(effect: VfxEffect): SmokeLayer[] {
  const out: SmokeLayer[] = [];
  effect.modules.forEach((m, index) => {
    if (m.kind !== "particles") return;
    const p = m as VfxModuleOf<"particles">;
    // a smoke layer: normal-blended (flames, sparks, embers are additive) and named as smoke, or in a `smoke` effect
    // (mist banks and spell shadows are normal-blended too, and are not smoke)
    const named = /smoke|plume|column|soot/i.test(p.id ?? "");
    if ((p.blend === "normal" || p.emitter.blending === "normal") && (named || effect.smoke)) out.push({ index, id: p.id || `#${index}`, module: p });
  });
  return out;
}

export interface SmokeSource {
  /** Height of the burning thing above its ground (m): the chimney top, the pyre, the kiln. */
  height: number;
  /** Its width across (m). */
  width: number;
  /** Height of the effect's origin above the source's ground (m), when the effect is placed off the ground. */
  emitterY?: number;
}

export interface SmokeFault {
  layer: string;
  rule: "height" | "width" | "opacity" | "colour" | "night" | "wind";
  detail: string;
}

/** Relative luminance of an sRGB hex colour. */
export function hexLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The caps a class gives a source: the plume's top above the source ground and its width, in metres. */
export function smokeCaps(cls: SmokeClass, src: SmokeSource): { top: number; width: number } {
  const c = SMOKE_CLASSES[cls];
  return { top: Math.min(c.maxTop, Math.max(c.minTop, c.topX * src.height)), width: Math.min(c.maxWidth, Math.max(1, c.widthX * src.width)) };
}

/**
 * Every rule a smoke effect breaks for a source. `colours` resolves a palette slot (`primary`, `glow`, ...) to hex
 * when the effect colours from a material; authored hex colours are read as they are.
 */
export function checkSmoke(
  effect: VfxEffect,
  src: SmokeSource,
  colours: (slot: string) => string | undefined = () => undefined,
  cls?: SmokeClass,
): SmokeFault[] {
  const klass: SmokeClass = cls ?? effect.smoke ?? "fire";
  const c = SMOKE_CLASSES[klass];
  const caps = smokeCaps(klass, src);
  const faults: SmokeFault[] = [];
  for (const L of smokeLayers(effect)) {
    const e = L.module.emitter;
    const m = measurePlume(e, (L.module.anchor?.offset?.[1] ?? 0) + (src.emitterY ?? 0));
    if (m.top > caps.top + 0.05) faults.push({ layer: L.id, rule: "height", detail: `top ${r1(m.top)} m > ${klass} cap ${r1(caps.top)} m (source ${r1(src.height)} m tall)` });
    if (m.width > caps.width + 0.05) faults.push({ layer: L.id, rule: "width", detail: `width ${r1(m.width)} m > ${klass} cap ${r1(caps.width)} m (source ${r1(src.width)} m wide)` });
    if (m.opacity > c.opacity + 1e-6) faults.push({ layer: L.id, rule: "opacity", detail: `peak opacity ${m.opacity.toFixed(2)} > ${c.opacity}` });
    const pairs: Array<[string | undefined, string]> = [
      [L.module.color, e.colorStart],
      [L.module.colorEnd ?? L.module.color, e.colorEnd],
    ];
    for (const [slot, authored] of pairs) {
      const hex = authored && authored.toLowerCase() !== "#ffffff" ? authored : slot && slot.startsWith("#") ? slot : slot ? colours(slot) : undefined;
      if (hex && hexLuminance(hex) < SMOKE_MIN_LUMINANCE)
        faults.push({ layer: L.id, rule: "colour", detail: `${hex} (luminance ${hexLuminance(hex).toFixed(2)} < ${SMOKE_MIN_LUMINANCE}: near-black smoke reads as a smear)` });
    }
    if ((e.nightDim ?? 0) < SMOKE_MIN_NIGHT_DIM) faults.push({ layer: L.id, rule: "night", detail: `nightDim ${e.nightDim ?? 0} < ${SMOKE_MIN_NIGHT_DIM} (unlit smoke glows at night)` });
    if (e.space !== "world" || (e.windDrift ?? 0) < SMOKE_MIN_WIND_DRIFT)
      faults.push({ layer: L.id, rule: "wind", detail: `windDrift ${e.windDrift ?? 0} (${e.space} space) < ${SMOKE_MIN_WIND_DRIFT}: smoke leans with the live wind` });
  }
  return faults;
}

/** The chimney batch as a plume, for the gate: its top above the chimney cap, and the cap check for a `height` m chimney. */
export function chimneyPlume(height: number): PlumeMeasure & { faults: SmokeFault[] } {
  const s = CHIMNEY_SMOKE;
  const m: PlumeMeasure = { top: height + s.rise + (s.sizeStart + s.sizeGrow) / 2, rise: s.rise, width: s.sizeStart + s.sizeGrow + s.lean, opacity: s.opacity, visibleSeconds: s.period };
  const caps = smokeCaps("chimney", { height, width: 0.75 });
  const faults: SmokeFault[] = [];
  if (m.top > caps.top + 0.05) faults.push({ layer: "chimney", rule: "height", detail: `top ${r1(m.top)} m > chimney cap ${r1(caps.top)} m (chimney ${r1(height)} m)` });
  if (m.width > caps.width + 0.05) faults.push({ layer: "chimney", rule: "width", detail: `width ${r1(m.width)} m > chimney cap ${r1(caps.width)} m` });
  if (m.opacity > SMOKE_CLASSES.chimney.opacity) faults.push({ layer: "chimney", rule: "opacity", detail: `opacity ${m.opacity} > ${SMOKE_CLASSES.chimney.opacity}` });
  return { ...m, faults };
}
