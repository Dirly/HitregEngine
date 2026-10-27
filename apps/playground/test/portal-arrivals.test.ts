import { test } from "node:test";
import assert from "node:assert/strict";
import { portalArrivalCandidates, portalArrivalSpot } from "@hitreg/core";
import { checkArrivals, fitArrivalQueue, type ArrivalProbe, type V3 } from "../tools/_portal-arrivals.mts";

// a stair passage along +z: floor 100 at z <= 0, falling 0.36 m per metre after; ceiling 3.6 m over the floor;
// a door's trigger box from z 3.4 on
const floorAt = (z: number) => (z <= 0 ? 100 : 100 - 0.36 * z);
const probe: ArrivalProbe = {
  down: (o, max) => { const d = o[1] - floorAt(o[2]); return d >= 0 && d <= max ? d : null; },
  up: (o, max) => { const d = floorAt(o[2]) + 3.6 - o[1]; return d >= 0 && d <= max ? d : null; },
  clear: () => true,
  inTrigger: (p) => p[2] >= 3.4 - 0.4,
};

const feetOf = (base: V3, corridor: number, q?: (number | null)[]): V3[] => {
  const out: V3[] = [base];
  for (let i = 0; i < 18; i++) {
    const s = portalArrivalSpot(base, 0, corridor, out, q) as V3;
    if (out.some((o) => o[0] === s[0] && o[2] === s[2])) break;
    out.push(s);
  }
  return out; // body centres (anchor + landing lift)
};

test("a sloped corridor's queue follows the floor and stops at the door's box", () => {
  const { queue } = fitArrivalQueue(portalArrivalCandidates([0, 101.2, 0], 0, 4), [0, 100, 0], 4, probe);
  assert.equal(queue.length, 2); // 1.1 m and 2.2 m; 3.3 m is in the box
  assert.ok(Math.abs(queue[0]! + 0.4) < 0.01 && Math.abs(queue[1]! + 0.79) < 0.01);
});

test("unmeasured spots at the anchor's height fail the check; measured ones pass", () => {
  const base: V3 = [0, 101.2, 0];
  assert.ok(checkArrivals(feetOf(base, 4), probe).length > 0);
  const { queue } = fitArrivalQueue(portalArrivalCandidates(base, 0, 4), [0, 100, 0], 4, probe);
  assert.deepEqual(checkArrivals(feetOf(base, 4, queue), probe), []);
});

test("a stair rising into the rock: the spot whose floor jumps ends the corridor queue", () => {
  const steep: ArrivalProbe = { ...probe, down: (o, max) => { const f = o[2] > 1.5 ? 102 : 100; const d = o[1] - f; return d >= 0 && d <= max ? d : null; }, up: () => null, inTrigger: () => false };
  const { queue, spots } = fitArrivalQueue(portalArrivalCandidates([0, 101.2, 0], 0, 4), [0, 100, 0], 4, steep);
  assert.deepEqual(queue, [0]);
  assert.match(spots[1]!.why!, /floor/);
});

test("open ground: a ring spot with no floor is null, the others stay", () => {
  const cliff: ArrivalProbe = { ...probe, down: (o, max) => (o[0] > 1.5 ? null : o[1] - 100 <= max ? o[1] - 100 : null), up: () => null, inTrigger: () => false };
  const { queue } = fitArrivalQueue(portalArrivalCandidates([0, 101.2, 0], 0, 0), [0, 100, 0], 0, cliff);
  assert.ok(queue.includes(null) && queue.some((q) => q === 0));
  assert.deepEqual(checkArrivals(feetOf([0, 101.2, 0], 0, queue), cliff), []);
});
