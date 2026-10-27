// monument-approach (tools/monument-approach.mts): a stair flight cut into / against the face is held; one standing
// free of it is not (owner ruling 2026-10-13: climb a butte by a ledge carved AROUND it, not a freestanding stair).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SolidProbe } from "@hitreg/core";
import { carvedSpan, classifyStair, MONUMENT_RE, NOT_TREAD_RE, STAIR_RE } from "../tools/monument-approach.mts";

// a flight 2 m wide (x 0..2), 20 m long (z 0..20), climbing from y 0 to 10
const g = { min: [0, 0, 0], max: [2, 10, 20] };
const own: SolidProbe = { floor: (_x, z) => (z / 20) * 10 };
const plain = (z: number) => 0; // flat ground at y 0 all round

test("a flight against a cliff face (rock just west of it) is held", () => {
  const cliff: SolidProbe = {
    floor: (x, z) => plain(z),
    wall: (x, _y, _z, dx) => (dx < 0 && x <= 0.1 ? 0.2 : null), // rock 0.2 m west of the west side
  };
  const r = classifyStair(g, own, cliff);
  assert.ok(r.heldShare >= 0.9, `held ${r.heldShare}`);
});

test("the same flight standing free on the plain is not held (only its foot is at grade)", () => {
  const open: SolidProbe = { floor: (_x, z) => plain(z) };
  const r = classifyStair(g, own, open);
  assert.ok(r.heldShare < 0.5, `held ${r.heldShare}`);
});

test("low steps and broad compound meshes are not judged; kerbs are parts, not treads", () => {
  assert.ok(classifyStair({ min: [0, 0, 0], max: [2, 1, 4] }, own, { floor: () => 0 }).skip);
  assert.ok(classifyStair({ min: [0, 0, 0], max: [30, 40, 80] }, own, { floor: () => 0 }).skip);
  assert.ok(STAIR_RE.test("ok-stair-f1") && NOT_TREAD_RE.test("ok-stair-f1-parapet") && !NOT_TREAD_RE.test("ok-stair-f1"));
  assert.ok(MONUMENT_RE.test("the King's Table mesa") && !MONUMENT_RE.test("a stackyard"));
});

// a 6 m plank span (x 0..6, z 0..2) over a collapse, rising 0..2.5, between two held flights end to end
const span = { min: [0, 0, 0], max: [6, 2.5, 2] };
const spanOwn: SolidProbe = { floor: (x) => (x / 6) * 2.5 };
const flights = [{ min: [-7, -5, 0], max: [0.3, 0, 2] }, { min: [5.7, 2.5, 0], max: [13, 7.5, 2] }];
const nothing: SolidProbe = { floor: () => null, ceiling: () => null, wall: () => null };

test("a short span between held flights inside a carved tunnel (rock above and both sides) is held", () => {
  const tunnel: SolidProbe = { floor: () => null, ceiling: (_x, _z, lo) => lo + 2.5, wall: () => 2 };
  assert.equal(carvedSpan(span, spanOwn, tunnel, flights), true);
});

test("the same span in the open, or joining only one flight, or too long, is not held; free-standing stairs still fail", () => {
  assert.equal(carvedSpan(span, spanOwn, nothing, flights), false);
  const tunnel: SolidProbe = { floor: () => null, ceiling: (_x, _z, lo) => lo + 2.5, wall: () => 2 };
  assert.equal(carvedSpan(span, spanOwn, tunnel, [flights[0]!]), false);
  // rock above but open on one side (a ledge under an overhang) is not a carved passage
  const oneSide: SolidProbe = { floor: () => null, ceiling: (_x, _z, lo) => lo + 2.5, wall: (_x, _y, _z, _dx, dz) => (dz > 0 ? 2 : null) };
  assert.equal(carvedSpan(span, spanOwn, oneSide, flights), false);
  // the 20 m free-standing flight on the plain: too long to be a span, and classified free
  assert.equal(carvedSpan(g, own, tunnel, flights), false);
  assert.ok(classifyStair(g, own, { floor: (_x, z) => plain(z) }).heldShare < 0.5);
});
