import { z } from "zod";
import type { NetStateStore } from "./net-state.js";

/**
 * Sanctuaries — "no player may damage another here".
 *
 * A zone border is a server line, and the pass through a barrier ridge is
 * the one spot where a player is briefly alone on a copy of the world and
 * landing. The waystation at every pass (and the whole of a town) is a
 * SANCTUARY: a circle inside which player-on-player damage is refused. NPCs
 * are untouched — the band and the landing grace handle them — and a
 * chase across a range is still a chase; the runner gets the circle and
 * nothing more (docs/world-editing/barriers.md → "Runtime").
 *
 * The layer publishes every `safe`-tagged POI of the recipe once at boot as
 * `sanctuaries/list` = `[[x, z, radius], …]` — replicated, tiny, readable by
 * any script on any peer — and a game's authoritative combat script asks
 * `sanctuaryAt` before applying a hit between two player-owned bodies
 * (`owner/<bodyId>` says who is a player).
 */
export const SANCTUARIES_NETSTATE = "sanctuaries";

/** The one key under the namespace. */
export const SANCTUARIES_KEY = `${SANCTUARIES_NETSTATE}/list`;

/** `[x, z, radius]` in world metres. */
export type SanctuaryCircle = [number, number, number];

export const sanctuariesSchema = z
  .array(z.tuple([z.number(), z.number(), z.number().positive()]))
  .describe(
    "Sanctuary circles as [x, z, radius] in world metres (sanctuaries/list, written once by the server at boot from " +
      "every recipe POI tagged \"safe\"). Inside one, an authoritative combat script refuses damage between two " +
      "player-owned bodies; NPC damage is untouched.",
  );

/** Register the namespace so writes validate and it shows in the spec. Once per store. */
export function registerSanctuariesNetState(store: NetStateStore): void {
  store.define(SANCTUARIES_NETSTATE, sanctuariesSchema);
}

/** The circles a recipe's POIs declare: every one tagged `safe` with a `radius`. */
export function sanctuariesFromPois(
  pois: ReadonlyArray<{ position: readonly [number, number, number]; radius?: number | undefined; tags: readonly string[] }>,
): SanctuaryCircle[] {
  const out: SanctuaryCircle[] = [];
  for (const poi of pois) {
    if (!poi.tags.includes("safe") || !(typeof poi.radius === "number" && poi.radius > 0)) continue;
    out.push([poi.position[0], poi.position[2], poi.radius]);
  }
  return out;
}

/** Index of the first circle in `list` containing (x, z), or -1. Tolerant of a missing or malformed list. */
export function sanctuaryAt(list: unknown, x: number, z: number): number {
  if (!Array.isArray(list)) return -1;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as unknown;
    if (!Array.isArray(c) || c.length < 3) continue;
    const dx = x - (c[0] as number);
    const dz = z - (c[1] as number);
    const r = c[2] as number;
    if (dx * dx + dz * dz <= r * r) return i;
  }
  return -1;
}

/** Whether (x, z) lies inside any sanctuary in `list` (the netState value, or any array of circles). */
export function inSanctuary(list: unknown, x: number, z: number): boolean {
  return sanctuaryAt(list, x, z) >= 0;
}
