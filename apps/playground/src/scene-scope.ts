/**
 * Scene-scoped load for a streamed world (evidence shots, a direct link to one place): the dev app opened with
 *
 *   ?scene=<id>&at=<x>,<z>[,<y>]&streamRadius=<metres>
 *
 * starts its editor camera (the edit-mode streaming focus) looking at x, z instead of the origin, and clamps every
 * streaming ring (simulation, fullRender, hlod, farTerrain, the legacy radius) to `streamRadius` metres, so a place
 * shot loads only the chunks around the place instead of the whole world's far rings (POI-QUALITY's live run timed
 * out at 240 s loading skelmorrow). Without the parameters nothing changes.
 */
import type { ChunkStreamerData } from "@hitreg/core";

export interface SceneScope {
  /** The point to start at: [x, z] and an optional height. */
  at: { x: number; z: number; y: number | null } | null;
  /** Streaming radius cap in metres. */
  streamRadius: number | null;
}

/** Read `at` and `streamRadius` from a query string; malformed values are ignored (null). */
export function parseSceneScope(search: string | URLSearchParams): SceneScope {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  let at: SceneScope["at"] = null;
  const raw = q.get("at");
  if (raw) {
    const n = raw.split(",").map((s) => Number(s.trim()));
    if ((n.length === 2 || n.length === 3) && n.every(Number.isFinite)) at = { x: n[0]!, z: n[1]!, y: n.length === 3 ? n[2]! : null };
  }
  const r = Number(q.get("streamRadius"));
  return { at, streamRadius: q.has("streamRadius") && Number.isFinite(r) && r > 0 ? r : null };
}

/** The streamer with every ring (and the legacy radius) clamped to `radiusM` metres (at least one cell). */
export function scopeStreamer<T extends ChunkStreamerData | null>(streamer: T, radiusM: number | null): T {
  if (!streamer || radiusM === null) return streamer;
  const cells = Math.max(1, Math.ceil(radiusM / streamer.cellSize));
  const c = (v: number) => Math.min(v, cells);
  return {
    ...streamer,
    radius: c(streamer.radius),
    ...(streamer.rings ? { rings: { simulation: c(streamer.rings.simulation), fullRender: c(streamer.rings.fullRender), hlod: c(streamer.rings.hlod), farTerrain: c(streamer.rings.farTerrain) } } : {}),
  };
}

/** Metres behind and above the player the editor camera opens at (`playerFraming`). */
export const FRAME_BEHIND_M = 8;
export const FRAME_UP_M = 4;

/**
 * Where the editor camera opens on a scene with no `?at`: behind its player-tagged root entity, looking along the
 * player's facing (+Z forward, the convention the play host reads a body's heading with), so the first view of a world
 * or a lab is its spawn (Derek 2026-10-31) and entering play (the rig adopts the editor camera's orbit) does not spin.
 * Null when the scene has no positioned player root (the host then keeps its origin framing).
 */
export function playerFraming(doc: { entities: Record<string, { parent?: string | null; tags?: string[]; components?: Record<string, unknown> }> }): { eye: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } } | null {
  const root = Object.values(doc.entities).find((e) => !e.parent && (e.tags ?? []).includes("player"));
  const t = root?.components?.["transform"] as { position?: number[]; rotation?: number[] } | undefined;
  const p = t?.position;
  if (!p || p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) return null;
  const [qx, qy, qz, qw] = t?.rotation?.length === 4 && t.rotation.every(Number.isFinite) ? t.rotation : [0, 0, 0, 1];
  // (0, 0, 1) rotated by the quaternion, flattened to the ground plane
  let fx = 2 * (qx! * qz! + qw! * qy!), fz = 1 - 2 * (qx! * qx! + qy! * qy!);
  const l = Math.hypot(fx, fz);
  if (l < 1e-6) { fx = 0; fz = 1; } else { fx /= l; fz /= l; }
  const [x, y, z] = p as [number, number, number];
  return { eye: { x: x - fx * FRAME_BEHIND_M, y: y + FRAME_UP_M, z: z - fz * FRAME_BEHIND_M }, target: { x, y: y + 1, z } };
}
