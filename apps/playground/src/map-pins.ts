/**
 * The player's own map markers ("pins"): where they are kept and how stored
 * data is cleaned on the way in.
 *
 * Pins are CLIENT-SIDE UI STATE, never gameplay: nothing on the server reads
 * them, and they are not replicated. They persist per character and world in
 * this browser's localStorage (`hitreg-map-pins:<character>:<world>`), every
 * access wrapped in try/catch — there is no client-side per-character save
 * store to put them in, and the server's character save is gameplay
 * authority, which a map scribble is not. A private window or blocked
 * storage keeps them for the session only.
 *
 * Sharing a pin with the party is NOT built: see "Player markers" in
 * docs/voxel-worlds.md for what it needs (a host-routed module message).
 */
import { PIN_LABEL_MAX, PIN_SHAPES, type MapPin, type PinShape } from "./map-layers.js";

/** Most pins one character keeps in one world. */
export const PIN_LIMIT = 100;
const PREFIX = "hitreg-map-pins";

export const pinStorageKey = (owner: string, world: string): string => `${PREFIX}:${owner}:${world}`;

/** Only well-formed pins survive: finite position, a known shape, a trimmed label within the limit. */
export function cleanPins(raw: unknown): MapPin[] {
  if (!Array.isArray(raw)) return [];
  const shapes = new Set<string>(PIN_SHAPES.map((s) => s.id));
  const out: MapPin[] = [];
  const seen = new Set<string>();
  for (const p of raw as Partial<MapPin>[]) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.x !== "number" || typeof p.z !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const id = typeof p.id === "string" && p.id && !seen.has(p.id) ? p.id : newPinId();
    seen.add(id);
    out.push({
      id,
      x: p.x,
      z: p.z,
      shape: (typeof p.shape === "string" && shapes.has(p.shape) ? p.shape : "pin") as PinShape,
      label: cleanLabel(p.label),
    });
    if (out.length >= PIN_LIMIT) break;
  }
  return out;
}

export const cleanLabel = (label: unknown): string =>
  typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, PIN_LABEL_MAX) : "";

let seq = 0;
export const newPinId = (): string => `pin-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function loadPins(owner: string, world: string): MapPin[] {
  try {
    return cleanPins(JSON.parse(localStorage.getItem(pinStorageKey(owner, world)) ?? "[]"));
  } catch {
    return [];
  }
}

export function savePins(owner: string, world: string, pins: readonly MapPin[]): void {
  try {
    if (pins.length) localStorage.setItem(pinStorageKey(owner, world), JSON.stringify(pins.slice(0, PIN_LIMIT)));
    else localStorage.removeItem(pinStorageKey(owner, world));
  } catch {
    /* storage blocked: the pins last for this session only */
  }
}
