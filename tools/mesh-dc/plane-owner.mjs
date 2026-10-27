/**
 * ONE MESH OWNS EACH PLANE — the cross-group rule of a multi-group stamp.
 *
 * Every dc_group bakes as its own volume and its own draw. Where two groups meet, both sources usually carry the
 * same stone: a round well's outer wall and the neighbouring room's wall built outward from the shared room line, two
 * floor slabs that both run through a door threshold. Each volume then meshes a face on the SAME plane facing the
 * SAME way, and the two draws z-fight at close range (the zfight gate: tools/zfight.mts).
 *
 * The fix is ordering, the CSG authoring model itself: groups own planes in stamp order. Before a group is meshed,
 * the crisp solids of every EARLIER group that reach it are appended as `sub` nodes, so a later group keeps only the
 * stone no earlier group already has. A shared face then exists in the earlier group alone; where a later group's
 * stone ran into an earlier one it now ends in a cut face pressed back to back against the owner (hidden, never the
 * same facing). Walls and threshold floors are the same case.
 *
 * The subtracted copy is EXACT, not grown: the cut face of the later group then lies on the owner's face, back to back,
 * with no crack between them (a grown cut opened a slit at every shared door threshold that a ground ray fell through).
 * A lattice sample exactly on a shared plane stays air in the later group, because the triangle field counts a boundary
 * point as solid (d <= 0), so max(d_later, -d_owner) >= 0 there. Only CRISP solids are subtracted: a noised (natural
 * rock) solid's real surface moves by its noise amount, and cutting by its crisp copy could open a hole where the noise
 * pulled the rock back.
 */

/** Per-solid triangle ranges, bounds and data of one stamp mesh (or a role-noise node's mesh). */
export function meshSolids(mesh) {
  const counts = Array.isArray(mesh.solidTriangleCounts) && mesh.solidTriangleCounts.length ? mesh.solidTriangleCounts : [mesh.indices.length / 3];
  const out = [];
  let tri = 0;
  for (const count of counts) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let t = tri; t < tri + count; t++) for (let c = 0; c < 3; c++) {
      const v = mesh.indices[t * 3 + c];
      for (let a = 0; a < 3; a++) { const n = mesh.positions[v * 3 + a]; if (n < lo[a]) lo[a] = n; if (n > hi[a]) hi[a] = n; }
    }
    out.push({ start: tri, count, lo, hi });
    tri += count;
  }
  return out;
}

const boxesTouch = (lo, hi, lo2, hi2, margin) => [0, 1, 2].every((a) => lo[a] - margin <= hi2[a] && hi[a] + margin >= lo2[a]);

/** One closed solid copied out of `mesh` (local positions/indices to append). */
function copySolid(mesh, { start, count }) {
  const remap = new Map(), positions = [], indices = [];
  for (let t = start; t < start + count; t++) for (let c = 0; c < 3; c++) {
    const v = mesh.indices[t * 3 + c];
    let m = remap.get(v);
    if (m === undefined) { m = positions.length / 3; remap.set(v, m); positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]); }
    indices.push(m);
  }
  return { positions, indices };
}

/**
 * The `sub` node that removes every earlier owner's crisp stone from one group.
 *   owners  [{ name, mesh }] the crisp mesh of each EARLIER group (role-noise "imported-mesh" node, or the whole mesh)
 *   lo, hi  the group's own source bounds; margin  how far beyond them an owner's solid still matters (noise + cells)
 * Returns null when no earlier solid reaches the group.
 */
export function ownerCutNode(owners, lo, hi, { margin }) {
  const positions = [], indices = [], solidTriangleCounts = [], from = [];
  for (const { name, mesh } of owners) {
    let used = 0;
    for (const solid of meshSolids(mesh)) {
      if (!boxesTouch(solid.lo, solid.hi, lo, hi, margin)) continue;
      const d = copySolid(mesh, solid);
      const base = positions.length / 3;
      positions.push(...d.positions);
      for (const i of d.indices) indices.push(base + i);
      solidTriangleCounts.push(d.indices.length / 3);
      used++;
    }
    if (used) from.push({ group: name, solids: used });
  }
  if (!solidTriangleCounts.length) return null;
  return { node: { id: "plane-owner-cut", op: "sub", shape: "mesh", position: [0, 0, 0], mesh: { positions, indices, solidTriangleCounts } }, from };
}
