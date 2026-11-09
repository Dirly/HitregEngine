/**
 * SUPPORT — a piece placed ON another piece (a brazier on a pillar, a bowl on a plinth, a cairn on a crag top).
 *
 * Moved here from place-build (o-city3 2026-10-30, Derek: "braziers on top of pillars are not centred, or are hanging off
 * edges and clipping through some geometry"). A piece `on` a host snaps to the host's named marker, or, with none, to the
 * centre of the host's top face when that face is a pedestal; `supportOf` then measures that its base lies on the host's
 * top (no overhang) and that the host does not rise into it (no clip). Pure and headless: the host's shape comes in as
 * `top` / `bottom` probes in the host's own (unscaled) frame.
 */

import type { V2 } from "./obb.js";

/** A top face no larger than this x the piece's largest footprint side (both ways) is a pedestal: snap to its centre. */
export const SUPPORT_SNAP_FACE = 2.5;
/** A top face: the connected surface within this of the top at the piece's spot (m). */
export const SUPPORT_FACE_TOL_M = 0.12;
/** A base point more than this over the host's top under it hangs in the air (m). */
export const SUPPORT_SEAT_TOL_M = 0.2;
/** The share of base points that may hang (sampling at the outline's edge). */
export const SUPPORT_OVERHANG_SHARE = 0.05;
/** The host's mesh may rise this far over a piece's underside (m; the seat sets every piece 0.1 m in). */
export const SUPPORT_CLIP_M = 0.25;
/** How far a piece is set into its host's top (m). */
export const SUPPORT_SINK_M = 0.1;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A placed piece in plan: world xz `w`, yaw `ang` (radians, three.js about +Y), base height `y`, uniform scale `k`. */
export interface SupportHost { w: V2; ang: number; y: number; prefab: string; k: number }

/** World xz -> a placed piece's own frame (unscaled), and back. Pure. */
export const hostLocal = (h: { w: V2; ang: number; k: number }, w: V2): V2 => {
  const dx = w[0] - h.w[0], dz = w[1] - h.w[1], c = Math.cos(h.ang), s = Math.sin(h.ang);
  return [(dx * c - dz * s) / h.k, (dx * s + dz * c) / h.k];
};
export const hostWorld = (h: { w: V2; ang: number; k: number }, l: V2): V2 => {
  const c = Math.cos(h.ang), s = Math.sin(h.ang);
  return [h.w[0] + h.k * (l[0] * c + l[1] * s), h.w[1] + h.k * (-l[0] * s + l[1] * c)];
};

/** The flat top face round a local point (a host's frame, unscaled): the grid cells (step) connected to it whose top is
 *  within `tol` of the top there. `closed` false when the face runs to `reach` (a wall walk, a broad plinth). Pure. */
export function topFace(top: (x: number, z: number) => number | null, at: V2, reach: number, step: number, tol = SUPPORT_FACE_TOL_M): { centre: V2; size: V2; y: number; closed: boolean } | null {
  const y0 = top(at[0], at[1]);
  if (y0 == null) return null;
  const n = Math.max(1, Math.ceil(reach / step)), seen = new Set<string>(["0,0"]), q: [number, number][] = [[0, 0]];
  let x0 = 0, x1 = 0, z0 = 0, z1 = 0, closed = true;
  while (q.length) {
    const [i, j] = q.pop()!;
    if (Math.abs(i) >= n || Math.abs(j) >= n) closed = false;
    x0 = Math.min(x0, i); x1 = Math.max(x1, i); z0 = Math.min(z0, j); z1 = Math.max(z1, j);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const a = i + di, b = j + dj, key = `${a},${b}`;
      if (seen.has(key) || Math.abs(a) > n || Math.abs(b) > n) continue;
      seen.add(key);
      const t = top(at[0] + a * step, at[1] + b * step);
      if (t != null && Math.abs(t - y0) <= tol) q.push([a, b]);
    }
  }
  return { centre: [at[0] + ((x0 + x1) / 2) * step, at[1] + ((z0 + z1) / 2) * step], size: [(x1 - x0 + 1) * step, (z1 - z0 + 1) * step], y: y0, closed };
}

/** How a placed piece sits on its host: its BASE (the sample points of its own mesh whose underside lies within 0.25 m of
 *  its lowest) must lie over the host's top (overhang = the share of base points with no host top within
 *  SUPPORT_SEAT_TOL_M under them), and the host's top may not rise into the piece (clip = the most the host's top stands
 *  over the piece's underside anywhere the piece has mesh). `half` = the piece's footprint half extents (m, scaled). Pure. */
export function supportOf(
  piece: { prefab: string; w: V2; ang: number; y: number; k: number; half: V2 },
  host: SupportHost,
  top: (prefab: string, x: number, z: number) => number | null,
  bottom: (prefab: string, x: number, z: number) => number | null,
  n = 16,
): { overhang: number; clip: number; base: number; ok: boolean } {
  const pts: { w: V2; y: number }[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const l: V2 = [((-1 + (2 * i) / n) * piece.half[0]) / piece.k, ((-1 + (2 * j) / n) * piece.half[1]) / piece.k], b = bottom(piece.prefab, l[0], l[1]);
    if (b == null) continue;
    pts.push({ w: hostWorld(piece, l), y: piece.y + b * piece.k });
  }
  if (!pts.length) return { overhang: 0, clip: 0, base: 0, ok: true };
  const lo = Math.min(...pts.map((q) => q.y));
  let base = 0, hang = 0, clip = 0;
  for (const q of pts) {
    const hl = hostLocal(host, q.w), t = top(host.prefab, hl[0], hl[1]), ht = t == null ? null : host.y + t * host.k;
    if (q.y <= lo + 0.25) { base++; if (ht == null || q.y - ht > SUPPORT_SEAT_TOL_M) hang++; }
    if (ht != null) clip = Math.max(clip, ht - q.y);
  }
  const overhang = base ? hang / base : 0;
  return { overhang: r2(overhang), clip: r2(clip), base, ok: overhang <= SUPPORT_OVERHANG_SHARE && clip <= SUPPORT_CLIP_M };
}

/** A host as the solver sees it: where it stands, its top surface (own frame, unscaled; null = no mesh there) and its
 *  named markers (own frame, unscaled: `<model>.markers.json`, so a re-exported kit moves its fires with it). */
export interface HostShape extends SupportHost {
  top: (x: number, z: number) => number | null;
  /** Lowest point of the host's own mesh in its column (for a piece on it, `bottom` of the piece is asked instead). */
  markers?: Record<string, { position: [number, number, number] }>;
}

export interface HostSnap {
  /** World plan position the piece goes to. */
  w: V2;
  /** Base height on the host's top (set SUPPORT_SINK_M + `sink` into it); null when the host has no top there. */
  y: number | null;
  /** How the spot was chosen. */
  how: "marker" | "face-centre" | "as-given";
  /** Metres the piece moved from the spot it was given (0 for a marker). */
  moved: number;
  /** Why the piece cannot go on this host (unknown marker, no top under it). */
  fault?: string;
  /** The top face found under it (own frame), when `how` is face-centre. */
  face?: { size: V2; closed: boolean };
}

/**
 * Snap a piece placed ON a host: to the host's `marker` when named (its position read from the host's markers, never
 * copied coordinates), else (no `sink`) to the centre of the host's top face when that face is a pedestal (at most
 * SUPPORT_SNAP_FACE x the piece's largest footprint side). `half` = the piece's footprint half extents, scaled metres.
 */
export function snapToHost(at: V2, half: V2, host: HostShape, o: { marker?: string; sink?: number } = {}): HostSnap {
  let l = hostLocal(host, at), how: HostSnap["how"] = "as-given", moved = 0, face: HostSnap["face"];
  if (o.marker) {
    const mk = host.markers?.[o.marker];
    if (!mk) return { w: at, y: null, how, moved: 0, fault: `${host.prefab} has no marker ${o.marker} (its <model>.markers.json)` };
    l = [mk.position[0], mk.position[2]];
    how = "marker";
  } else if (!o.sink) {
    const side = 2 * Math.max(half[0], half[1]), step = Math.max(0.05, side / host.k / 12);
    const f = topFace(host.top, l, (SUPPORT_SNAP_FACE * side) / host.k, step);
    if (f && f.closed && f.size[0] * host.k <= SUPPORT_SNAP_FACE * side && f.size[1] * host.k <= SUPPORT_SNAP_FACE * side) {
      moved = Math.hypot(f.centre[0] - l[0], f.centre[1] - l[1]) * host.k;
      l = f.centre;
      how = "face-centre";
      face = { size: [r2(f.size[0] * host.k), r2(f.size[1] * host.k)], closed: f.closed };
    }
  }
  const w = hostWorld(host, l), t = host.top(l[0], l[1]);
  if (t == null) return { w, y: null, how, moved: r2(moved), fault: `no top of ${host.prefab} under it`, ...(face ? { face } : {}) };
  return { w, y: host.y + t * host.k - SUPPORT_SINK_M - (o.sink ?? 0), how, moved: r2(moved), ...(face ? { face } : {}) };
}
