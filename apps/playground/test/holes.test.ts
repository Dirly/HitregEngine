import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FALLS, TriangleGrid, classifyArrival, classifyColumn, clusterFaults, samplePoints, type Column } from "../tools/_holes.mts";

/** The fall-through gate's pure half (tools/_holes.mts) on synthetic columns: what the player sees vs what the body stands on. */
const col = (o: Partial<Column>): Column => ({ x: 0, z: 0, surface: 10, surfaceMin: 10, render: null, collider: 10, ...o });
const kind = (o: Partial<Column>) => classifyColumn(col(o))?.kind ?? null;

describe("classifyColumn", () => {
  it("passes ground whose collider is the surface", () => {
    assert.equal(kind({}), null);
    assert.equal(kind({ collider: 9.6 }), null); // mesh slack
    assert.equal(kind({ collider: 14 }), null); // a deck, a prop, a bridge over the ground
  });
  it("fails seen ground with no collider (falls through the earth)", () => {
    assert.equal(kind({ collider: null }), "no-collider");
  });
  it("fails a collider metres under the ground (deep) and lists a knee-deep one (sink)", () => {
    assert.equal(kind({ collider: 2 }), "deep");
    assert.equal(kind({ collider: 8.5 }), "sink");
  });
  it("uses the lowest surface of the neighbourhood on a slope", () => {
    assert.equal(kind({ surfaceMin: 8.2, collider: 8.3 }), null);
  });
  it("fails a landmark drawn over a collider that is not there", () => {
    const f = classifyColumn(col({ render: 20, collider: 10 }));
    assert.equal(f?.kind, "landmark-render");
    assert.ok(Math.abs(f!.drop - 10) < 1e-9);
    assert.equal(kind({ render: 20, collider: 19.8 }), null);
  });
  it("ignores columns with no ground at all", () => {
    assert.equal(kind({ surface: null, collider: null }), null);
  });
});

describe("TriangleGrid", () => {
  it("returns the highest surface over a point, null off the mesh", () => {
    const g = new TriangleGrid(2);
    g.add([0, 5, 0, 10, 5, 0, 0, 5, 10]);
    g.add([0, 7, 0, 4, 7, 0, 0, 7, 4]);
    assert.ok(Math.abs(g.top(1, 1)! - 7) < 1e-9);
    assert.ok(Math.abs(g.top(6, 1)! - 5) < 1e-9);
    assert.equal(g.top(9, 9), null);
  });
});

describe("samplePoints / clusterFaults", () => {
  it("adds the fine lattice on places and along roads, inside the area only", () => {
    const pts = samplePoints({ rect: [0, 0, 40, 40], coarse: 10, fine: 1, discs: [{ x: 5, z: 5, r: 2 }], lines: [{ points: [[20, 20], [30, 20]], halfWidth: 1 }] });
    assert.equal(pts.filter(([x, z]) => x % 10 === 0 && z % 10 === 0).length, 25);
    assert.ok(pts.some(([x, z]) => x === 5 && z === 6));
    assert.ok(pts.some(([x, z]) => x === 25 && z === 21));
    assert.ok(pts.every(([x, z]) => x >= 0 && x <= 40 && z >= 0 && z <= 40));
  });
  it("merges neighbouring faults into one site named after the nearest owner", () => {
    const f = (x: number) => ({ x, z: 0, kind: "no-collider" as const, seen: 10, collider: null, drop: Infinity });
    const c = clusterFaults([f(0), f(1), f(2), f(50)], [{ id: "poi a", x: 0, z: 3 }, { id: "poi b", x: 52, z: 0 }]);
    assert.deepEqual(c.map((s) => s.count), [3, 1]);
    assert.match(c[0]!.near, /^poi a/);
    assert.match(c[1]!.near, /^poi b/);
  });
});

describe("classifyArrival", () => {
  it("passes a spot with a floor a short drop below, fails one over nothing, in rock or under the floor", () => {
    assert.equal(classifyArrival([0, 11.2, 0], 10, false), null);
    assert.equal(classifyArrival([0, 11.2, 0], null, false)?.kind, "arrival");
    assert.equal(classifyArrival([0, 11.2, 0], 5, false)?.kind, "arrival");
    assert.equal(classifyArrival([0, 11.2, 0], 10, true)?.kind, "arrival");
    assert.ok(FALLS.has("arrival") && FALLS.has("no-collider") && !FALLS.has("sink"));
  });
});
