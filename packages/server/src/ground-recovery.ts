/**
 * GROUND RECOVERY — the authority's sensor and safety net for "I fell through the earth".
 *
 * A player body can end up under the voxel ground in a handful of ways that no client can fix: its cell was not
 * resident on this server when it walked in (the ring lagged an overloaded tick), a landmark or ribbon collider was
 * missing where its render mesh stood, a carve opened the closed volume, a portal/spawn point stood under a floor.
 * Once under the surface there is nothing to land on, and the body falls until the world ends.
 *
 * Every few ticks the server asks, per player body: is it UNDER the open-air surface the recipe field says is there,
 * inside solid rock (no cave or tunnel air around it), with no collider below it to stand on? Then it fell through:
 * lift it onto the first collider over the column (or the field surface) and LOG it with coordinates — that log line
 * (`[server:ground] ... fell through ...`) is the evidence a gate or a playtest report reads. A body in a cave, a
 * tunnel, a dungeon bored into the hill or on a buried landmark floor is left alone: there is air or a collider there.
 *
 * The decision is a pure function of the probes so it can be tested without a world (test/ground-recovery.test.ts).
 */

/** What the server measured about one body this pass. */
export interface GroundProbe {
  /** Body (capsule centre) position. */
  position: [number, number, number];
  /** The open-air surface over the column from the recipe field (`TerrainStreamer.groundHeight`). */
  surface: number;
  /**
   * The floor under the body from the field, allowing caves (`TerrainStreamer.groundNear(x, z, y)`): null = the
   * column is solid rock around the body.
   */
  floorNear: number | null;
  /** Distance to the first collider straight below the body (null = nothing within the probe's reach). */
  colliderBelow: number | null;
  /** Whether the cell the body stands in is resident on this server. */
  cellResident: boolean;
}

export type GroundVerdict =
  | { kind: "ok" }
  /** The body stands in a cell this server has not loaded: load it now (the body has no ground under it here). */
  | { kind: "uncovered" }
  /** Under the surface, in rock, nothing below: it fell through. `depth` = metres under the surface. */
  | { kind: "fell"; depth: number };

/** Metres under the surface the body centre must be before it can count as fallen (a capsule half-height + slack). */
export const FELL_DEPTH = 2.5;
/** Past this depth below the surface a body is fallen whatever the probes say (nothing legitimate is that deep without a collider under it). */
export const FELL_HARD_DEPTH = 80;

export function groundVerdict(p: GroundProbe): GroundVerdict {
  if (!p.cellResident) return { kind: "uncovered" };
  const y = p.position[1];
  const depth = p.surface - y;
  if (depth < FELL_DEPTH) return { kind: "ok" };
  // standing (or about to land) on something: a buried landmark floor, a dungeon bored into the hill, a bridge deck
  if (p.colliderBelow !== null) return depth > FELL_HARD_DEPTH && p.colliderBelow > 4 ? { kind: "fell", depth } : { kind: "ok" };
  // cave / tunnel air around the body with its floor under the body: a legitimate underground place
  if (p.floorNear !== null && p.floorNear <= y + 0.5 && depth < FELL_HARD_DEPTH) return { kind: "ok" };
  return { kind: "fell", depth };
}
