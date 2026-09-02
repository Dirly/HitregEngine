/**
 * Collision layers.
 *
 * Rapier filters pairs with a 32-bit `InteractionGroups`: the high 16 bits are
 * the collider's MEMBERSHIP (what it is), the low 16 bits are its FILTER (what
 * it is willing to interact with). A pair interacts only if each side's
 * membership intersects the other side's filter — the test is symmetric, which
 * is the part people get wrong: setting "the bullet ignores the player" on the
 * bullet alone is enough, because the AND is two-sided.
 *
 * These constants exist so no call site ever spells a raw hex mask. A query
 * that says `{ layers: Layers.WORLD | Layers.TERRAIN }` still reads correctly
 * two years from now; `0x0003` does not, and silently means something else the
 * day a layer is inserted above it. Layer bits are therefore APPEND-ONLY —
 * renumbering one rewrites the meaning of every scene and script that used it.
 */

/** A membership/filter mask. Only the low 16 bits are meaningful to Rapier. */
export type LayerMask = number;

/**
 * The layer set. Deliberately small: every extra layer is a decision every
 * future query has to make, and the useful distinctions are the ones a QUERY
 * wants to draw, not the ones a designer might enjoy naming.
 */
export const Layers = {
  /** Nothing. A collider with no membership is invisible to every query. */
  NONE: 0x0000 as LayerMask,

  /** Static level geometry: walls, floors, stairs, pillars, doors' frames. */
  WORLD: (1 << 0) as LayerMask,
  /**
   * Heightfields and cooked cave/tunnel meshes. Split from WORLD because it is
   * the one static class a query routinely wants to treat differently: ground
   * probes want only this, and a "did my sword hit a pillar" occlusion test
   * wants WORLD without paying for a heightfield's triangle count.
   */
  TERRAIN: (1 << 1) as LayerMask,
  /** Anything alive that can be hit: enemies, NPCs, the player's own body. */
  ACTOR: (1 << 2) as LayerMask,
  /**
   * The local player specifically, as a subset of ACTOR (a player collider is
   * normally a member of BOTH). Lets an AI query say "actors but not players"
   * or a camera say "everything except the guy I'm attached to" without an
   * exclude list.
   */
  PLAYER: (1 << 3) as LayerMask,
  /** Dynamic movable objects: crates, barrels, dropped loot, ragdolls. */
  PROP: (1 << 4) as LayerMask,
  /** Sensors (`collider.isTrigger`). Queries exclude these unless asked. */
  TRIGGER: (1 << 5) as LayerMask,
  /** In-flight projectiles — so two arrows don't collide with each other. */
  PROJECTILE: (1 << 6) as LayerMask,
  /**
   * What a camera boom is allowed to be pushed by. Usually a COARSE proxy of
   * the world, not the world itself: `docs/performance-lessons.md` records a
   * profile where camera-collision raycasts against full-resolution terrain
   * were 70% of frame time. Give the camera its own cheap colliders and put
   * them on this layer.
   */
  CAMERA_BLOCKER: (1 << 7) as LayerMask,
  /** Cosmetic debris/gibs. Collides with the world, is never queried for. */
  DEBRIS: (1 << 8) as LayerMask,
  /** Loot containers, levers, doors, lifts — the "press E" set. */
  INTERACTABLE: (1 << 9) as LayerMask,

  /** Every layer. The default filter, so layering is opt-in and additive. */
  ALL: 0xffff as LayerMask,
} as const;

/** Static, immovable geometry — what a line of sight is actually blocked by. */
export const SOLID_WORLD: LayerMask = Layers.WORLD | Layers.TERRAIN;

/**
 * What blocks vision. Props are included because a stack of crates should hide
 * you; triggers and debris are not, because a trigger volume is not a wall and
 * a bouncing pebble should not break an enemy's line of sight for a frame.
 */
export const VISION_BLOCKERS: LayerMask = Layers.WORLD | Layers.TERRAIN | Layers.PROP;

/** Everything a weapon sweep should stop on or damage. */
export const HITTABLE: LayerMask =
  Layers.WORLD | Layers.TERRAIN | Layers.ACTOR | Layers.PLAYER | Layers.PROP;

/** What a character controller's capsule should be stopped by. */
export const CHARACTER_SOLID: LayerMask =
  Layers.WORLD | Layers.TERRAIN | Layers.PROP | Layers.ACTOR | Layers.PLAYER;

/**
 * Pack membership + filter into Rapier's `InteractionGroups` word.
 *
 * `>>> 0` is load-bearing: `1 << 15 << 16` is negative as a signed int32, and
 * the wasm boundary wants a u32 — without the coercion the top layer bit turns
 * every interaction test into nonsense.
 */
export function interactionGroups(membership: LayerMask, filter: LayerMask): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/**
 * Interaction groups for a QUERY (a ray, a shape cast, an overlap).
 *
 * A query is not a collider, so it has nothing meaningful to "be a member of" —
 * but Rapier still runs the symmetric test, so the query must claim membership
 * in everything or colliders whose own filter is narrow would reject it. Hence
 * membership = ALL, filter = what the caller asked for.
 */
export function queryGroups(layers: LayerMask): number {
  return interactionGroups(Layers.ALL, layers);
}

/** Membership half of a packed `InteractionGroups`. */
export function membershipOf(groups: number): LayerMask {
  return (groups >>> 16) & 0xffff;
}

/** Filter half of a packed `InteractionGroups`. */
export function filterOf(groups: number): LayerMask {
  return groups & 0xffff;
}

/** Human-readable layer list — for editor UI, logs, and AI-facing reports. */
export function layerNames(mask: LayerMask): string[] {
  const out: string[] = [];
  for (const [name, bit] of Object.entries(Layers)) {
    if (name === "NONE" || name === "ALL") continue;
    if ((mask & bit) !== 0) out.push(name);
  }
  return out;
}
