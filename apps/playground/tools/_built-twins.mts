/**
 * Coincident end caps in a built landmark: two solids that butt on one plane (a wall-ramp's mitred segments, a section seam)
 * each keep their own cap there, back to back. In the trimesh collider the pair is an internal wall whose top edge sits flush
 * with the walk: the body's capsule catches on it (FIX-HW4: poi-walk STUCK on every mitred landing of the Sexton's Stair), and
 * in the render it z-fights. A triangle with an exact twin (the same three vertices, to the millimetre) facing the other way is
 * interior to the union: both are dropped.
 */
export interface TriGroup { positions: Float32Array; indices: Uint32Array; triangleCount: number }

export function dropTwinFaces<G extends TriGroup>(groups: G[]): { groups: G[]; dropped: number } {
  const key = (g: G, t: number) => [0, 1, 2].map((e) => { const v = g.indices[t * 3 + e]!; return `${Math.round(g.positions[v * 3]! * 1000)},${Math.round(g.positions[v * 3 + 1]! * 1000)},${Math.round(g.positions[v * 3 + 2]! * 1000)}`; }).sort().join("|");
  const normal = (g: G, t: number) => {
    const p = [0, 1, 2].map((e) => { const v = g.indices[t * 3 + e]!; return [g.positions[v * 3]!, g.positions[v * 3 + 1]!, g.positions[v * 3 + 2]!]; });
    const u = [0, 1, 2].map((i) => p[1]![i]! - p[0]![i]!), w = [0, 1, 2].map((i) => p[2]![i]! - p[0]![i]!);
    return [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
  };
  const seen = new Map<string, { gi: number; t: number }[]>();
  groups.forEach((g, gi) => { for (let t = 0; t < g.indices.length / 3; t++) { const k = key(g, t); const l = seen.get(k); if (l) l.push({ gi, t }); else seen.set(k, [{ gi, t }]); } });
  const drop = groups.map(() => new Set<number>());
  for (const list of seen.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!, b = list[j]!, na = normal(groups[a.gi]!, a.t), nb = normal(groups[b.gi]!, b.t);
      if (na[0]! * nb[0]! + na[1]! * nb[1]! + na[2]! * nb[2]! < 0) { drop[a.gi]!.add(a.t); drop[b.gi]!.add(b.t); }
    }
  }
  let dropped = 0;
  const out = groups.map((g, gi) => {
    if (!drop[gi]!.size) return g;
    const idx: number[] = [];
    for (let t = 0; t < g.indices.length / 3; t++) if (!drop[gi]!.has(t)) idx.push(g.indices[t * 3]!, g.indices[t * 3 + 1]!, g.indices[t * 3 + 2]!);
    dropped += drop[gi]!.size;
    return { ...g, indices: Uint32Array.from(idx), triangleCount: idx.length / 3 };
  });
  return { groups: out, dropped };
}
