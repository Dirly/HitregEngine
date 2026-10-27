/**
 * Portal arrival spots, measured (pure; portal-cover runs it against the booted world).
 *
 * An arrival anchor puts the first body on the anchor and the next ones on its overflow spots
 * (core `portalArrivalCandidates`: along the forward line in a corridor, two rings on open ground). Those spots
 * were all at the anchor's own height, so in a sloped passage they stood inside the stair rock (up the slope) or in
 * the air (down it), and a second traveller out of a dungeon fell through the world. `fitArrivalQueue` measures each
 * spot's floor and writes `portalAnchor.queue`; `checkArrivals` proves every spot the anchor can hand out has floor.
 *
 * Rules (a spot = where a body's FEET go; its centre is BODY_HALF above):
 *  - floor: the first surface down from the reference floor + REACH_UP, within STEP of the reference (the previous
 *    spot's floor in a corridor, the anchor's on open ground);
 *  - headroom: STAND clear above that floor;
 *  - reached: a clear line, at body-centre height, from the previous spot (corridor) or the anchor (rings);
 *  - not inside a walk-through portal's box (the body would be sent away the moment its arrival grace ends).
 * A corridor queue stops at its first bad spot (no one is put past a wall, a drop or a door); a ring spot that fails
 * is null and the others stay.
 */
export type V3 = [number, number, number];

export interface ArrivalProbe {
  /** distance down from `from` to the first solid surface, or null within `max` */
  down(from: V3, max: number): number | null;
  /** distance up from `from` to the first solid surface, or null within `max` */
  up(from: V3, max: number): number | null;
  /** a clear straight line between two points */
  clear(a: V3, b: V3): boolean;
  /** the body centre at `p` would stand inside (or touch) a walk-through portal's trigger box */
  inTrigger(p: V3): boolean;
}

export const BODY_HALF = 0.9;
export const REACH_UP = 1.8;
export const STEP = 1.0;
export const STAND = 1.9;

export interface SpotVerdict { i: number; at: V3; floor: number | null; ok: boolean; why?: string }

function measureSpot(probe: ArrivalProbe, x: number, z: number, ref: number, from: V3): SpotVerdict & { centre: V3 | null } {
  const origin: V3 = [x, ref + REACH_UP, z];
  const d = probe.down(origin, REACH_UP + STEP + 0.5);
  if (d === null) return { i: -1, at: [x, ref, z], floor: null, ok: false, why: "no floor", centre: null };
  const floor = origin[1] - d;
  if (Math.abs(floor - ref) > STEP) return { i: -1, at: [x, floor, z], floor, ok: false, why: `floor ${(floor - ref).toFixed(2)} m from the last one`, centre: null };
  const head = probe.up([x, floor + 0.1, z], STAND);
  if (head !== null && head < STAND - 0.1) return { i: -1, at: [x, floor, z], floor, ok: false, why: `${(head + 0.1).toFixed(2)} m headroom`, centre: null };
  const centre: V3 = [x, floor + BODY_HALF, z];
  if (!probe.clear(from, centre)) return { i: -1, at: [x, floor, z], floor, ok: false, why: "walled off from the spot before it", centre };
  if (probe.inTrigger(centre)) return { i: -1, at: [x, floor, z], floor, ok: false, why: "inside a portal's box", centre };
  return { i: -1, at: [x, floor, z], floor, ok: true, centre };
}

/**
 * The measured queue for an anchor whose floor is at `anchor[1]`: one entry per candidate (`candidates` from core
 * `portalArrivalCandidates`, any height), the floor relative to the anchor, or null. A corridor queue is cut at its
 * first bad spot.
 */
export function fitArrivalQueue(candidates: readonly V3[], anchor: V3, corridor: number, probe: ArrivalProbe): { queue: (number | null)[]; spots: SpotVerdict[] } {
  const queue: (number | null)[] = [];
  const spots: SpotVerdict[] = [];
  const anchorCentre: V3 = [anchor[0], anchor[1] + BODY_HALF, anchor[2]];
  let ref = anchor[1], from: V3 = anchorCentre;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const v = measureSpot(probe, c[0], c[2], corridor > 0 ? ref : anchor[1], corridor > 0 ? from : anchorCentre);
    spots.push({ i, at: v.at, floor: v.floor, ok: v.ok, ...(v.why ? { why: v.why } : {}) });
    if (corridor > 0) {
      if (!v.ok) break;
      ref = v.floor!;
      from = v.centre!;
      queue.push(Math.round((v.floor! - anchor[1]) * 100) / 100);
    } else queue.push(v.ok ? Math.round((v.floor! - anchor[1]) * 100) / 100 : null);
  }
  while (queue.length && queue[queue.length - 1] === null) queue.pop();
  return { queue, spots };
}

/**
 * Every spot the anchor hands out (`spots`: where the body CENTRE is put, the anchor first: core `portalArrivalSpot`,
 * anchor + PORTAL_LANDING_LIFT) must land: a floor 0.2-2.5 m under the centre (the holes gate's arrival rule) and the
 * head clear (an up-ray from inside the stair rock meets its surface within BODY_HALF). Returns the failing spots.
 */
export function checkArrivals(spots: readonly V3[], probe: ArrivalProbe): SpotVerdict[] {
  const bad: SpotVerdict[] = [];
  spots.forEach((s, i) => {
    const head = probe.up(s, BODY_HALF);
    if (head !== null) { bad.push({ i, at: s, floor: null, ok: false, why: `the head meets rock ${head.toFixed(2)} m up (the spot is in the rock)` }); return; }
    const d = probe.down(s, 4);
    if (d === null) { bad.push({ i, at: s, floor: null, ok: false, why: "no floor within 4 m" }); return; }
    if (d < 0.2 || d > 2.5) bad.push({ i, at: s, floor: s[1] - d, ok: false, why: `floor ${d.toFixed(2)} m under the body centre (0.2-2.5 m lands)` });
  });
  return bad;
}
