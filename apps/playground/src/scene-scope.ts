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
