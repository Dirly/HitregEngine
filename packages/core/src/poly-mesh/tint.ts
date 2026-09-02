import type { PolyMesh, Vec3 } from "./types.js";
import { buildTopology } from "./topology.js";
import { cloneMesh } from "./ops.js";

/**
 * Grime painting — the tint half of the weathering pass. Rules write
 * per-corner face colors (`colors` on PolyFace, #rrggbb) so soot, damp,
 * waterlines, and dust read on machine-exact geometry without touching a
 * single vertex. Materials opt into vertex colors to show the result; this
 * module only writes the data.
 *
 * Blending is multiplicative toward the rule color: at strength s a corner's
 * existing tint (white when absent) is multiplied by lerp(white, ruleColor, s)
 * per channel. Grime therefore only ever darkens/stains toward the rule color,
 * layers commute with themselves, and repeated rules deepen rather than
 * overwrite — the physical model of dirt on stone. Everything is
 * deterministic, clamped to valid #rrggbb, and NaN-safe.
 *
 * Order with weathering: weather first, then paint — subdividing a face has
 * to drop per-corner colors (the corner count changes), so grime painted
 * before `weatherFaces` survives only as flat `color` tints.
 */

export interface RadialGrimeRule {
  kind: "radial";
  /** Center in mesh-local space — a torch position for soot, an impact point for scorch. */
  at: Vec3;
  /** Full fade-out distance in metres; strength falls off smoothly to 0 at the radius. */
  radius: number;
  /** #rrggbb tint multiplied in at full strength. */
  color: string;
  /** 0..1 — how strongly the rule applies at its center. */
  strength: number;
}

export interface HeightBandGrimeRule {
  kind: "heightBand";
  /** Band bottom (local y, metres). */
  from: number;
  /** Band top. `from`/`to` may be given in either order. */
  to: number;
  color: string;
  strength: number;
  /** Linear falloff distance beyond each band edge, metres. Default 0 (hard edge). */
  fade?: number;
}

export interface FacingGrimeRule {
  /** upFacing = dust/moss on tops; downFacing = damp under overhangs. */
  kind: "downFacing" | "upFacing";
  color: string;
  strength: number;
  /** Minimum |normal.y| toward the facing direction before the rule starts, ramping to full strength at 1. Default 0.5. */
  threshold?: number;
}

export type GrimeRule = RadialGrimeRule | HeightBandGrimeRule | FacingGrimeRule;

/**
 * Apply grime rules to every face corner, returning a new PolyMesh with
 * per-corner `colors` written on each face any rule touched. Untouched faces
 * keep their existing tint fields byte-identical; touched faces get a full
 * `colors` array (existing `color`/`colors` values are baked in as the blend
 * base, so nothing is overwritten — only multiplied). Attribute-only: no
 * vertex or face topology changes, and `generator` survives.
 */
export function paintGrime(mesh: PolyMesh, rules: GrimeRule[]): PolyMesh {
  const out = cloneMesh(mesh);
  if (rules.length === 0) return out;
  const topo = buildTopology(out);
  out.faces.forEach((face, fi) => {
    const normal = topo.faceNormals[fi]!;
    let touched = false;
    const result = face.v.map((vi, ci) => {
      const p = out.vertices[vi]!;
      let c = parseHex(face.colors?.[ci] ?? face.color ?? "#ffffff");
      for (const rule of rules) {
        const s = ruleStrength(rule, p, normal);
        if (s <= 0) continue;
        touched = true;
        const tint = parseHex(rule.color);
        c = [
          c[0] * (1 - s + s * tint[0]),
          c[1] * (1 - s + s * tint[1]),
          c[2] * (1 - s + s * tint[2]),
        ];
      }
      return c;
    });
    if (touched) {
      face.colors = result.map(formatHex);
      delete face.color; // baked into every corner of `colors`
    }
  });
  return out;
}

// ------------------------------------------------- rule evaluation

/** Strength of one rule at a corner: rule.strength scaled by the spatial falloff, always in [0, 1]. */
function ruleStrength(rule: GrimeRule, p: Vec3, normal: Vec3): number {
  const strength = clamp01(rule.strength);
  if (strength === 0) return 0;
  switch (rule.kind) {
    case "radial": {
      if (!(rule.radius > 0)) return 0;
      const d = Math.hypot(p[0] - rule.at[0], p[1] - rule.at[1], p[2] - rule.at[2]);
      return strength * smooth(clamp01(1 - d / rule.radius));
    }
    case "heightBand": {
      const lo = Math.min(rule.from, rule.to);
      const hi = Math.max(rule.from, rule.to);
      const y = p[1];
      if (y >= lo && y <= hi) return strength;
      const fade = typeof rule.fade === "number" && rule.fade > 0 ? rule.fade : 0;
      if (fade === 0) return 0;
      const dist = y < lo ? lo - y : y - hi;
      return strength * clamp01(1 - dist / fade);
    }
    case "upFacing":
    case "downFacing": {
      const threshold = clamp01(rule.threshold ?? 0.5);
      const ny = rule.kind === "upFacing" ? normal[1] : -normal[1];
      if (ny < threshold) return 0;
      const span = 1 - threshold;
      return strength * (span <= 1e-9 ? 1 : clamp01((ny - threshold) / span));
    }
  }
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const smooth = (t: number): number => t * t * (3 - 2 * t);

// ------------------------------------------------- color plumbing

/** #rrggbb → linear-ish [r, g, b] in 0..1; anything malformed reads as white (untinted). */
function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** [r, g, b] 0..1 → #rrggbb, clamped and NaN-safe. */
function formatHex(rgb: [number, number, number]): string {
  const to = (x: number): string => {
    const v = Number.isFinite(x) ? Math.round(Math.min(1, Math.max(0, x)) * 255) : 0;
    return v.toString(16).padStart(2, "0");
  };
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}
