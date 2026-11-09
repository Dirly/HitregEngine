/**
 * Where a player enters a world, from the world's own data, so every world gets it without a hand-placed point:
 *
 *   the STARTER town   a recipe town tagged "starter", else the first town;
 *   its gate + street  the town design (`program.source`, authoring/towns/<town>-design.json): its `gate` (else the
 *                      recipe gate) and the street that leaves it (a `main` street first);
 *   the spot           on that street, past the gate court (the farthest `kind: "gate"` square vertex along the street
 *                      + 4 m; 12 m with none), never beyond half the street;
 *   facing             up the street, toward its far end (the square).
 * A town without a design: its centre, facing in from its first gate. A world without towns: null (keep the scene's).
 * XZ only: the caller probes the ground (the world field's surfaceCast) for the height.
 *
 * Redstrand 2026-10-31: the world scene was written before its town existed, so the player stood at the origin.
 */
import fs from "node:fs";
import path from "node:path";

type V2 = [number, number];
export interface WorldSpawn {
  at: V2;
  /** Unit XZ direction the player faces. */
  facing: V2;
  /** Y-axis quaternion [x, y, z, w] for that facing (forward = +Z). */
  rotation: [number, number, number, number];
  town: string;
  /** How it was found (for reports). */
  from: string;
}

interface TownLike { id: string; center: V2; tags?: string[]; gates?: Array<{ at: V2; facing: V2 }>; program?: { source?: string } }
interface RecipeLike { features: { towns: TownLike[] } }
interface DesignLike {
  gate?: { at: V2; facing: V2 };
  streets?: Array<{ id: string; kind?: string; points: V2[] }>;
  squares?: Array<{ id: string; kind?: string; polygon: V2[] }>;
}

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: V2) => Math.hypot(a[0], a[1]);
const unit = (a: V2): V2 => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Y rotation quaternion that turns +Z to `facing`. */
export function yawQuat(facing: V2): [number, number, number, number] {
  const theta = Math.atan2(facing[0], facing[1]);
  return [0, +Math.sin(theta / 2).toFixed(6), 0, +Math.cos(theta / 2).toFixed(6)];
}

export function worldSpawn(recipe: RecipeLike, projectDir: string): WorldSpawn | null {
  const towns = recipe.features.towns;
  const town = towns.find((t) => (t.tags ?? []).includes("starter")) ?? towns[0];
  if (!town) return null;
  const which = (town.tags ?? []).includes("starter") ? "starter-tagged town" : "first town";
  const designFile = town.program?.source ? path.join(projectDir, town.program.source) : null;
  const design: DesignLike | null = designFile && fs.existsSync(designFile) ? JSON.parse(fs.readFileSync(designFile, "utf8")) : null;
  const gate = design?.gate ?? town.gates?.[0];
  if (design && gate) {
    // the street that leaves the gate, oriented gate -> far end; a main street first
    const fromGate = (design.streets ?? [])
      .map((s) => {
        const a = s.points[0]!, b = s.points[s.points.length - 1]!;
        return len(sub(a, gate.at)) <= 10 ? { s, pts: s.points } : len(sub(b, gate.at)) <= 10 ? { s, pts: [...s.points].reverse() } : null;
      })
      .filter((x): x is { s: NonNullable<DesignLike["streets"]>[number]; pts: V2[] } => !!x)
      // inward: the street must head into the town (against the gate's outward facing)
      .filter((x) => dot(unit(sub(x.pts[1]!, x.pts[0]!)), unit(gate.facing)) < 0)
      .sort((a, b) => Number(b.s.kind === "main") - Number(a.s.kind === "main"));
    const street = fromGate[0];
    if (street) {
      const p0 = street.pts[0]!, p1 = street.pts[1]!;
      const dir = unit(sub(p1, p0));
      const court = (design.squares ?? []).filter((q) => q.kind === "gate").flatMap((q) => q.polygon);
      const past = court.length ? Math.max(...court.map((v) => dot(sub(v, p0), dir))) + 4 : 12;
      const inset = Math.min(Math.max(past, 6), len(sub(p1, p0)) / 2);
      const at: V2 = [r2(p0[0] + dir[0] * inset), r2(p0[1] + dir[1] * inset)];
      const facing = unit(sub(street.pts[street.pts.length - 1]!, at));
      return { at, facing, rotation: yawQuat(facing), town: town.id, from: `${which} ${town.id}: ${street.s.id} ${inset.toFixed(1)} m in from the gate, facing up it` };
    }
  }
  const inward: V2 = gate ? unit([-gate.facing[0], -gate.facing[1]]) : [0, 1];
  return { at: [r2(town.center[0]), r2(town.center[1])], facing: inward, rotation: yawQuat(inward), town: town.id, from: `${which} ${town.id}: its centre (no design street from the gate)` };
}
