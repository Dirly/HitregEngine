/**
 * Replication policy — which entities transmit to which peers, how often.
 *
 * The engine-side answer to Unity's NetworkObject: an entity opts into
 * replication declaratively (the `netObject` component in @hitreg/core),
 * and this module turns those declarations into per-peer snapshot VIEWS:
 *
 * - `computeView` — interest management ("need to know"): proximity-scoped
 *   entities only transmit to peers whose player is within `radius`, with
 *   leave-side hysteresis so entities straddling the boundary don't flap.
 * - `dueThisTick` — per-entity send cadence: `sendEvery: 4` transmits on
 *   every 4th snapshot, phase-staggered by entity id so low-rate entities
 *   don't all burst on the same tick. Entities ENTERING a view always get
 *   a full update regardless of cadence.
 *
 * Pure functions over plain data — the host keeps one `Set<string>` of
 * in-view ids per peer and feeds it back in; everything is unit-testable
 * without a network.
 */

export type Relevancy = "always" | "proximity";

/** One replicated entity's policy + current position, as the host sees it. */
export interface ReplicaEntry {
  id: string;
  /** World position — the relevancy test point. */
  p: [number, number, number];
  relevancy: Relevancy;
  /** Proximity range (ignored for "always"). */
  radius: number;
  /** Transmit on every Nth snapshot (1 = every snapshot). */
  sendEvery: number;
}

export interface ReplicaView {
  /** Ids relevant to this peer now (feed back as `prev` next tick). */
  view: Set<string>;
  /** Ids that just became relevant — send a full update immediately. */
  entered: string[];
  /** Ids that just stopped being relevant — tell the peer to drop them. */
  left: string[];
}

export interface ComputeViewOptions {
  /**
   * Extra distance beyond `radius` before an in-view entity leaves
   * (hysteresis, default 5). Prevents enter/leave flapping at the border.
   */
  leavePadding?: number;
}

/**
 * The set of entries relevant to a peer viewing from `center` (null =
 * peer has no position, e.g. not playing — only "always" entities apply).
 */
export function computeView(
  center: [number, number, number] | null,
  entries: ReplicaEntry[],
  prev: ReadonlySet<string>,
  options: ComputeViewOptions = {},
): ReplicaView {
  const leavePadding = options.leavePadding ?? 5;
  const view = new Set<string>();
  const entered: string[] = [];
  for (const entry of entries) {
    let relevant = false;
    if (entry.relevancy === "always") {
      relevant = true;
    } else if (center !== null) {
      const dx = entry.p[0] - center[0];
      const dy = entry.p[1] - center[1];
      const dz = entry.p[2] - center[2];
      const dist = Math.hypot(dx, dy, dz);
      const limit = prev.has(entry.id) ? entry.radius + leavePadding : entry.radius;
      relevant = dist <= limit;
    }
    if (relevant) {
      view.add(entry.id);
      if (!prev.has(entry.id)) entered.push(entry.id);
    }
  }
  const left: string[] = [];
  for (const id of prev) {
    if (!view.has(id)) left.push(id);
  }
  return { view, entered, left };
}

/**
 * Cadence gate: is this entry due for a transmit on `tick`? Phase is
 * staggered by a stable hash of the id so `sendEvery: 4` entities spread
 * across 4 ticks instead of bursting together.
 */
export function dueThisTick(entry: ReplicaEntry, tick: number): boolean {
  const every = Math.max(1, Math.floor(entry.sendEvery));
  if (every === 1) return true;
  let hash = 0;
  for (let i = 0; i < entry.id.length; i++) hash = (hash * 31 + entry.id.charCodeAt(i)) >>> 0;
  return (tick + hash) % every === 0;
}
