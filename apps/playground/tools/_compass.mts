/**
 * THE world compass for briefs and builders (one function, decided 2026-10-22): north = -Z, east = +X, bearings in
 * degrees clockwise from north. Every tool already reads it so (worldgen grids "row 0 = north (-z)", site-finder
 * bearing(), light-shots facing, town-npcs fillPlaces), and the zone briefs write it so ("faces E to the sea" on an
 * east coast). A brief's `site.faces` text starts with the compass word its FRONT looks toward ("S over the fen trail
 * ...", "NE: the canyon mouth opens ..."); the rest is prose.
 *
 *   facesDir("S over the fen")  -> [0, 1]        the world direction the front looks (unit x, z)
 *   facesYaw("E to the sea")    -> PI / 2        yaw about +Y that turns a prefab's +Z front onto it
 */
export type Dir2 = [number, number];

const BEARING: Record<string, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };

/** Bearing (deg) of a compass word (N, NE, ... NW, any case), or null. */
export function compassBearing(word: string): number | null {
  const b = BEARING[word.trim().toLowerCase()];
  return b === undefined ? null : b;
}

/** Unit world direction (x, z) of a bearing: 0 = north = -Z, 90 = east = +X. */
export function bearingDir(deg: number): Dir2 {
  const r = (deg * Math.PI) / 180, x = Math.sin(r), z = -Math.cos(r);
  return [Math.abs(x) < 1e-12 ? 0 : x, Math.abs(z) < 1e-12 ? 0 : z];
}

/** The leading compass word of a brief's `faces` text ("NE: the canyon mouth ..."), or null when it has none. */
export function facesWord(text: string | undefined | null): string | null {
  const m = text?.trim().match(/^(NE|NW|SE|SW|N|S|E|W)(?![a-z])/i);
  return m ? m[1]!.toUpperCase() : null;
}

/** The world direction a brief's `faces` text names, or null. */
export function facesDir(text: string | undefined | null): Dir2 | null {
  const w = facesWord(text);
  return w ? bearingDir(compassBearing(w)!) : null;
}

/** Yaw (radians about +Y) that turns a prefab's +Z front onto a world direction. */
export const yawOfDir = (d: Dir2): number => Math.atan2(d[0], d[1]);

/** Yaw for a brief's `faces` text, or null. */
export function facesYaw(text: string | undefined | null): number | null {
  const d = facesDir(text);
  return d ? yawOfDir(d) : null;
}
