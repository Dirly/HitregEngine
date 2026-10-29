/**
 * TOWN WALL CLEAR — do a town's installed buildings stand clear of its baked `wall` operators (ring wall, dykes)?
 *
 * Cindermoot 2026-10-25 (owner: "the church and one other building are crashing into the wall"): the ring wall was
 * drawn round the LAYOUT envelopes, the shipped chapel / smoke tower / smithy models are 2.4-6 m larger than those
 * envelopes (plinth skirts, an apse, eaves), the wall body is 2.4 m thick with a battered foot, and no gate compared the
 * built wall with the built buildings. This is that gate.
 *
 * The wall is rebuilt exactly as the bake builds it (compileLandmarkOperator -> buildLandmarkMesh at the recipe's
 * `op:<id>:landmark` piece). Every building is its SHIPPED model's plan box (the glb's POSITION bounds, node translations
 * applied) turned and placed as the scene entity stands. Every wall triangle edge is sampled at `step` metres between the
 * building's foot and its top; a sample inside the box REACHES into the building (reach = how far in from the nearest
 * side); otherwise its distance to the box is the clearance. A building fails when a wall reaches into it or stands
 * closer than `clear` (0.5 m: a player must pass between them).
 */
import fs from "node:fs";
import {
  buildLandmarkMesh, compileLandmarkOperator, operatorParams, wallLandmarkParams, type OperatorFieldReader, type WorldRecipe,
} from "@hitreg/core";

export interface PlanBox { id: string; cx: number; cz: number; yaw: number; hx: number; hz: number; y0: number; y1: number }
export interface Seg { a: [number, number, number]; b: [number, number, number] }
export interface WallReach { id: string; wall: string | null; reach: number; clearance: number; at: [number, number] | null; samples: number }

/** The glb's POSITION bounds over its scene nodes (node translations applied; rotations/scales ignored). */
export function glbBounds(file: string): { lo: [number, number, number]; hi: [number, number, number]; prims: number } {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a binary glTF`);
  const len = b.readUInt32LE(12);
  const g = JSON.parse(b.subarray(20, 20 + len).toString("utf8"));
  const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let prims = 0;
  const visit = (ni: number, t: [number, number, number]) => {
    const nd = g.nodes[ni]; const tr = nd.translation ?? [0, 0, 0];
    const tt: [number, number, number] = [t[0] + tr[0], t[1] + tr[1], t[2] + tr[2]];
    if (nd.mesh !== undefined) for (const p of g.meshes[nd.mesh].primitives) {
      const a = g.accessors[p.attributes?.POSITION]; if (!a?.min || !a?.max) continue;
      prims++;
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a.min[i] + tt[i]); hi[i] = Math.max(hi[i], a.max[i] + tt[i]); }
    }
    for (const c of nd.children ?? []) visit(c, tt);
  };
  for (const n of g.scenes?.[0]?.nodes ?? g.nodes.map((_: unknown, i: number) => i)) visit(n, [0, 0, 0]);
  if (!prims) throw new Error(`${file}: no POSITION bounds`);
  return { lo, hi, prims };
}

/** The glb's POSITION bounds read in a frame turned by `yaw` (radians about +y): every vertex is turned by -yaw first.
 * A per-building export bakes the layout's rotation into the vertices (the entity carries none), so its axis-aligned
 * bounds are a rotated building's AABB, metres too big on a turned lot; read in the building's own frame they are its
 * true plan box (then `planBox(..., yaw, ...)` stands it back as built). */
export function glbBoundsInFrame(file: string, yaw: number): { lo: [number, number, number]; hi: [number, number, number]; prims: number } {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a binary glTF`);
  const len = b.readUInt32LE(12);
  const g = JSON.parse(b.subarray(20, 20 + len).toString("utf8"));
  const binAt = 20 + len + 8; // the BIN chunk's data (header: length + type)
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let prims = 0;
  const visit = (ni: number, t: [number, number, number]) => {
    const nd = g.nodes[ni]; const tr = nd.translation ?? [0, 0, 0];
    const tt: [number, number, number] = [t[0] + tr[0], t[1] + tr[1], t[2] + tr[2]];
    if (nd.mesh !== undefined) for (const p of g.meshes[nd.mesh].primitives) {
      const a = g.accessors[p.attributes?.POSITION]; if (!a || a.componentType !== 5126 || a.bufferView === undefined) continue;
      const bv = g.bufferViews[a.bufferView];
      const stride = bv.byteStride ?? 12, off = binAt + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
      prims++;
      for (let i = 0; i < a.count; i++) {
        const o = off + i * stride;
        const x = b.readFloatLE(o) + tt[0], y = b.readFloatLE(o + 4) + tt[1], z = b.readFloatLE(o + 8) + tt[2];
        // the inverse of planBox's turn: world offset -> the building's own frame
        const lx = c * x - s * z, lz = s * x + c * z;
        if (lx < lo[0]) lo[0] = lx; if (lx > hi[0]) hi[0] = lx;
        if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
        if (lz < lo[2]) lo[2] = lz; if (lz > hi[2]) hi[2] = lz;
      }
    }
    for (const ch of nd.children ?? []) visit(ch, tt);
  };
  for (const n of g.scenes?.[0]?.nodes ?? g.nodes.map((_: unknown, i: number) => i)) visit(n, [0, 0, 0]);
  if (!prims) throw new Error(`${file}: no float POSITION data`);
  return { lo, hi, prims };
}

/** Yaw (radians about +y) of a scene rotation quaternion [x, y, z, w]. */
export function yawOf(q: number[] | undefined): number {
  if (!q || q.length < 4) return 0;
  return Math.atan2(2 * (q[3]! * q[1]! + q[0]! * q[2]!), 1 - 2 * (q[1]! * q[1]! + q[2]! * q[2]!));
}

/** A model's plan box as the entity stands: local bounds turned by yaw about the entity position. */
export function planBox(id: string, position: number[], yaw: number, lo: [number, number, number], hi: [number, number, number]): PlanBox {
  // the local box centre is offset from the entity origin: turn that offset too
  const ox = (lo[0] + hi[0]) / 2, oz = (lo[2] + hi[2]) / 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { id, cx: position[0]! + c * ox + s * oz, cz: position[2]! - s * ox + c * oz, yaw, hx: (hi[0] - lo[0]) / 2, hz: (hi[2] - lo[2]) / 2, y0: position[1]! + lo[1], y1: position[1]! + hi[1] };
}

/** Signed plan distance of a world point to the box: < 0 inside (reach = -d), > 0 the clearance. */
export function boxDistance(b: PlanBox, x: number, z: number): number {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const dx = x - b.cx, dz = z - b.cz;
  // world -> local (the inverse turn of planBox)
  const lx = c * dx - s * dz, lz = s * dx + c * dz;
  const ex = Math.abs(lx) - b.hx, ez = Math.abs(lz) - b.hz;
  if (ex <= 0 && ez <= 0) return Math.max(ex, ez); // inside: the (negative) distance to the nearest side
  return Math.hypot(Math.max(ex, 0), Math.max(ez, 0));
}

/** The wall's triangle edges, world coordinates, as segments (each edge once). */
export function wallSegments(groups: { positions: ArrayLike<number>; indices: ArrayLike<number>; vertexCount: number }[], at: [number, number, number]): Seg[] {
  const out: Seg[] = [];
  for (const g of groups) {
    const P = g.positions, I = g.indices;
    const v = (i: number): [number, number, number] => [P[i * 3]! + at[0], P[i * 3 + 1]! + at[1], P[i * 3 + 2]! + at[2]];
    const seen = new Set<string>();
    for (let t = 0; t < I.length / 3; t++) {
      const tri = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
      for (let e = 0; e < 3; e++) {
        const a = tri[e]!, b = tri[(e + 1) % 3]!;
        const k = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ a: v(a), b: v(b) });
      }
    }
  }
  return out;
}

/** How far a wall (its edges) reaches into a building box, else how close it comes; samples between the box foot and top. */
export function wallReach(box: PlanBox, segs: Seg[], wall: string, step = 0.25, footSlack = 0.3): WallReach {
  let reach = 0, clearance = Infinity, at: [number, number] | null = null, samples = 0;
  const y0 = box.y0 + footSlack, y1 = box.y1;
  for (const s of segs) {
    const ya = s.a[1], yb = s.b[1];
    if (Math.max(ya, yb) < y0 || Math.min(ya, yb) > y1) continue;
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    const n = Math.max(1, Math.ceil(L / step));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = ya + (yb - ya) * t;
      if (y < y0 || y > y1) continue;
      const x = s.a[0] + (s.b[0] - s.a[0]) * t, z = s.a[2] + (s.b[2] - s.a[2]) * t;
      samples++;
      const d = boxDistance(box, x, z);
      if (d < 0) { if (-d > reach) { reach = -d; at = [x, z]; } }
      else if (d < clearance) { clearance = d; if (reach === 0) at = [x, z]; }
    }
  }
  return { id: box.id, wall, reach: Math.round(reach * 100) / 100, clearance: clearance === Infinity ? Infinity : Math.round(clearance * 100) / 100, at: at ? [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10] : null, samples };
}

/** Build an installed wall operator as the bake does; its edges in world coordinates. */
export function wallEdgesOf(recipe: WorldRecipe, opId: string, reader: OperatorFieldReader): { segs: Seg[]; at: [number, number, number]; stale: string | null } {
  const doc = (recipe.features.operators ?? []).find((o) => o.id === opId) as Record<string, unknown> | undefined;
  if (!doc || doc.op !== "wall") throw new Error(`no installed wall operator "${opId}"`);
  const c = compileLandmarkOperator(wallLandmarkParams(operatorParams(doc), reader, { id: opId }), reader, { id: opId });
  if (!c) throw new Error(`"${opId}" did not compile`);
  const b = buildLandmarkMesh(c.compiled);
  const piece = (recipe.features.landmarks ?? []).find((l) => l.id === `op:${opId}:landmark`);
  const at: [number, number, number] = piece ? (piece.position as [number, number, number]) : [c.at[0], c.footY ?? 0, c.at[1]];
  const stale = piece && piece.prefab !== `landmarks/${opId}-${c.compiled.digest}` ? `the recipe names ${piece.prefab} but the wall rebuilds as landmarks/${opId}-${c.compiled.digest}` : null;
  return { segs: wallSegments(b.groups as never, at), at, stale };
}

/** Judge every building box against every wall; a row per building (its worst wall). */
export function judgeTown(boxes: PlanBox[], walls: { id: string; segs: Seg[] }[], clear = 0.5, step = 0.25): { rows: (WallReach & { ok: boolean })[]; bad: number } {
  const rows = boxes.map((box) => {
    let worst: WallReach = { id: box.id, wall: null, reach: 0, clearance: Infinity, at: null, samples: 0 };
    for (const w of walls) {
      const r = wallReach(box, w.segs, w.id, step);
      if (r.reach > worst.reach || (r.reach === worst.reach && r.clearance < worst.clearance)) worst = r;
    }
    return { ...worst, ok: worst.reach === 0 && worst.clearance >= clear };
  });
  rows.sort((p, q) => q.reach - p.reach || p.clearance - q.clearance);
  return { rows, bad: rows.filter((r) => !r.ok).length };
}
