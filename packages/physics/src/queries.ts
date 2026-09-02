import type { Quat, Vec3 } from "@hitreg/core";
import { Layers, type LayerMask } from "./layers.js";

/**
 * Scene-query and character-controller types.
 *
 * Everything here is plain data so it can cross into `@hitreg/scripting`'s
 * `SimLike` structurally — scripting must not depend on this package (the
 * dependency runs the other way, and `packages/core`/`packages/scripting` have
 * to keep running headless without Rapier's wasm).
 */

/**
 * A convex query shape. Only these three: they are the ones Rapier can sweep
 * cheaply and analytically, and a swept concave shape is not a thing you want
 * in a gameplay loop anyway.
 */
export type QueryShape =
  | { kind: "ball"; radius: number }
  /** Vertical capsule. `halfHeight` is the CORE half-length, excluding the caps. */
  | { kind: "capsule"; halfHeight: number; radius: number }
  | { kind: "cuboid"; halfExtents: Vec3 };

/** One query result: what was hit, where, and how far along the query. */
export interface RayHit {
  /** Expanded-scene entity id owning the collider that was hit. */
  entityId: string;
  /** World-space contact point. */
  point: Vec3;
  /** World-space surface normal of the HIT collider, facing back at the query. */
  normal: Vec3;
  /**
   * Metres from the query's origin. For a shape cast this is the distance the
   * shape travelled before touching, NOT the distance to the contact point.
   */
  distance: number;
}

/** A shape cast reports the same four facts a ray does. */
export type ShapeHit = RayHit;

export interface QueryOptions {
  /**
   * Which layers may be hit. Defaults to {@link Layers.ALL}. Use the named
   * masks (`SOLID_WORLD`, `VISION_BLOCKERS`, `HITTABLE`) rather than hex.
   *
   * This is the cheap filter: it runs inside Rapier's broad phase, so a
   * narrow mask genuinely reduces work rather than just discarding results.
   */
  layers?: LayerMask;
  /**
   * Entity ids the query must ignore.
   *
   * **Read this before your first raycast from a character.** A script casting
   * from its own body's position starts the ray INSIDE its own collider, so
   * without an exclusion the nearest hit is always itself and every line-of-
   * sight test comes back "blocked" — an enemy that can never see anything, or
   * a weapon that always hits its own wielder on frame one. Pass
   * `{ exclude: [this.entityId] }`. Excluding exactly one entity is the fast
   * path (Rapier filters the whole rigid body natively); two or more falls back
   * to a per-candidate JS predicate, so keep this list short.
   */
  exclude?: readonly string[];
  /**
   * Include sensor (`collider.isTrigger`) colliders. Off by default: a trigger
   * volume is not geometry, and having one block a sword swing or an enemy's
   * line of sight is never what the author meant. Turn it on to ask "which
   * trigger volumes am I standing in".
   */
  includeSensors?: boolean;
}

export interface RaycastOptions extends QueryOptions {
  /**
   * How to treat a ray that STARTS inside a shape. `true` (default) reports a
   * hit at distance 0; `false` passes through the shape's interior and reports
   * the far wall on the way out. Leave it true unless you specifically want
   * "where would I exit this volume".
   */
  solid?: boolean;
  /**
   * Result object to write into instead of allocating. For per-entity-per-frame
   * queries (ground probes, AI line of sight over dozens of agents) reusing one
   * of these turns the hot path allocation-free. The returned reference IS this
   * object — do not retain it across calls.
   */
  out?: RayHit;
}

export interface RaycastAllOptions extends QueryOptions {
  solid?: boolean;
  /** Array to fill (cleared first) instead of allocating a new one. */
  out?: RayHit[];
}

export interface ShapecastOptions extends QueryOptions {
  /** Orientation of the swept shape. Identity by default. */
  rotation?: Quat;
  /**
   * Report a hit even when the shape starts already overlapping something.
   * Default true — for a weapon sweep, a target already inside the blade at
   * the start of the arc must still be hit.
   */
  stopAtPenetration?: boolean;
  out?: ShapeHit;
}

export interface OverlapOptions extends QueryOptions {
  /** Orientation of the test shape. Identity by default. */
  rotation?: Quat;
  /** Array to fill (cleared first) instead of allocating a new one. */
  out?: string[];
}

/**
 * Kinematic character-controller tuning.
 *
 * These are the knobs that decide whether movement feels like a Souls game or
 * like a crate with legs. Defaults are tuned for a human-sized character in
 * built interiors (see {@link DEFAULT_CHARACTER}).
 */
export interface CharacterOptions {
  /**
   * Skin width kept between the capsule and everything else. Must be non-zero
   * for numerical stability, and small enough not to read as floating.
   */
  offset?: number;
  /**
   * Steepest slope (radians) the character can walk up. Steeper counts as a
   * wall. 50° lets a character take a normal staircase's ramp but not a
   * pillar's chamfer.
   */
  maxSlopeClimbAngle?: number;
  /** Shallowest slope (radians) the character slides back down. */
  minSlopeSlideAngle?: number;
  /**
   * Step-up. `null` disables it. **This is the single most load-bearing
   * setting for an interior game**: without autostep a character stops dead on
   * a 15 cm stair lip, which is most of what makes hand-built architecture feel
   * unwalkable. `minWidth` is how much clear tread must exist on top of the
   * step for the climb to be allowed — it is what stops the controller
   * levitating up a ladder of thin ledges.
   */
  autostep?: { maxHeight: number; minWidth: number; includeDynamicBodies?: boolean } | null;
  /**
   * Distance below the feet to snap to when walking off a small lip. `null`
   * disables. Without this a character launches off the top of every
   * descending stair and arrives at the bottom on a ballistic arc.
   */
  snapToGround?: number | null;
  /** Slide along obstacles instead of stopping at them. Almost always true. */
  slide?: boolean;
  /**
   * Push dynamic bodies the character walks into. On by default: a character
   * that walks through crates without disturbing them reads as a ghost.
   */
  pushDynamicBodies?: boolean;
  /**
   * Mass used when pushing. Defaults to the body's own. Set it low to make a
   * character shove barrels gently, high to bulldoze.
   */
  mass?: number | null;
  /** Which way is up. Defaults to +Y. */
  up?: Vec3;
  /** Layers the capsule is stopped by. Defaults to {@link CHARACTER_SOLID}. */
  layers?: LayerMask;
  /**
   * Entities this character never collides with. The character's OWN entity is
   * always excluded automatically — the controller moves that collider, and a
   * capsule cannot be stopped by itself.
   */
  exclude?: readonly string[];
}

/** What actually happened when a character tried to move. */
export interface CharacterMove {
  /**
   * The translation ACTUALLY applied after sliding, stepping and snapping —
   * never the one you asked for. Integrate your own velocity against this, not
   * against the desired value, or the character accumulates speed into a wall
   * and rockets off the moment it clears the corner.
   */
  translation: Vec3;
  /** Standing on something climbable. The jump/fall-damage gate. */
  grounded: boolean;
  /** Blocked by something too steep to climb — a wall. */
  hitWall: boolean;
  /** Blocked by something above. Cancel upward velocity when true. */
  hitCeiling: boolean;
  /**
   * Entity ids touched during this move, sorted for determinism. Empty when
   * nothing was touched.
   */
  collisions: string[];
}

/**
 * Human-scale interior defaults. `autostep.maxHeight` of 0.4 clears a
 * generous stair riser; `snapToGround` matches it so descending the same stair
 * is not a series of small falls.
 */
export const DEFAULT_CHARACTER: Required<
  Omit<CharacterOptions, "autostep" | "snapToGround" | "mass" | "exclude" | "up">
> & {
  autostep: { maxHeight: number; minWidth: number; includeDynamicBodies: boolean };
  snapToGround: number;
} = {
  offset: 0.02,
  maxSlopeClimbAngle: (50 * Math.PI) / 180,
  minSlopeSlideAngle: (40 * Math.PI) / 180,
  autostep: { maxHeight: 0.4, minWidth: 0.2, includeDynamicBodies: false },
  snapToGround: 0.4,
  slide: true,
  pushDynamicBodies: true,
  layers: Layers.WORLD | Layers.TERRAIN | Layers.PROP | Layers.ACTOR | Layers.PLAYER,
};

/**
 * Total order over hits: nearest first, ties broken on entity id.
 *
 * **This is a multiplayer correctness fix, not tidiness.** Rapier reports
 * multi-hit results in broad-phase traversal order, which depends on collider
 * insertion order — and in a chunk-streamed world that order is set by network
 * timing, so two peers holding the identical world can enumerate the same three
 * hits in different orders. Any gameplay rule of the form "the first thing the
 * sweep touched" (pierce counts, cleave limits, which enemy eats the stagger)
 * then resolves differently per machine, and the desync shows up minutes later
 * as an HP mismatch nobody can trace back. Sorting costs nothing at these
 * lengths and makes the answer a property of the world instead of the schedule.
 */
export function compareHits(a: RayHit, b: RayHit): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}
