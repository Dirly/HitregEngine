/**
 * How far away a creature is sent to players: its SIGHT radius.
 *
 * A person-sized body is seen out to the server's interest radius; a bigger one
 * is seen further, in proportion to its height (a giant, a troll, a dragon must be
 * seen coming — "that is a fight for a team, stay clear" is read at a distance),
 * up to SIGHT_MAX. A scene or prefab overrides it with a `netObject` on the root:
 * `{ relevancy: "proximity", radius: <m> }`. Player bodies always use the interest
 * radius (both sides of a PvP fight see each other at the same range).
 */

import type { EntityDoc, NetObjectData } from "@hitreg/core";

/** Collider height (m) seen at exactly the interest radius: a person. */
export const SIGHT_REFERENCE_HEIGHT = 2.6;
/** Furthest a creature is sent by size alone (the fog has eaten most of it beyond). */
export const SIGHT_MAX = 600;

/** Height of a root's collider in metres (capsule: cylinder + caps), scaled; null without one. */
export function colliderHeight(doc: EntityDoc): number | null {
  const c = doc.components["collider"] as { shape?: string; size?: number[] } | undefined;
  if (!c?.size) return null;
  const [w = 0, h = 0] = c.size;
  const height = c.shape === "capsule" ? h + w : c.shape === "sphere" ? w : h;
  const scale = (doc.components["transform"] as { scale?: number[] } | undefined)?.scale?.[1] ?? 1;
  return height * Math.abs(scale);
}

/** Metres within which players are sent this root (0 = interest off: everyone gets everything). */
export function sightRadius(doc: EntityDoc, interest: number): number {
  if (interest <= 0) return 0;
  const net = doc.components["netObject"] as NetObjectData | undefined;
  if (net) return net.relevancy === "always" ? Infinity : net.radius;
  const height = colliderHeight(doc);
  if (height === null || height <= SIGHT_REFERENCE_HEIGHT) return interest;
  return Math.min(SIGHT_MAX, Math.max(interest, (interest * height) / SIGHT_REFERENCE_HEIGHT));
}
