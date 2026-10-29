import { describe, expect, it } from "vitest";
import {
  defaultSeatContact,
  fieldSolidProbe,
  ROCK_EMBED,
  ROCK_EMBED_MIN,
  flatSafeSink,
  seatObject,
  triangleSolidProbe,
  unionSolidProbe,
  type SeatField,
  type SolidProbe,
} from "../src/index.js";

/** Flat ground at y=0 for x<10, a 6 m monument top (y=6) for x>=10, a beam (solid 3..3.3) over x in [-22,-20], a wall at z>=30. */
const ground = (x: number, z: number): number => (z >= 30 ? 50 : x >= 10 ? 6 : 0);
const field: SeatField = {
  voxelSize: 1,
  height: ground,
  density: (x, y, z) => {
    if (x >= -22 && x <= -20 && y >= 3 && y <= 3.3) return -1;
    return y - ground(x, z);
  },
};
const probe = fieldSolidProbe(field);

describe("seatObject", () => {
  it("base: floating crate is corrected down onto the ground, sunk 3 cm", () => {
    const r = seatObject(probe, { x: 2, z: 2, y: 0.4, halfX: 0.5, halfZ: 0.5, height: 1 }, "base");
    expect(r.status).toBe("off");
    expect(r.gap).toBeCloseTo(0.4, 1);
    expect(r.y).toBeCloseTo(-0.03, 2);
  });
  it("base: a box's inner floor or a barrel's bottom never lands on the floor's plane (one mesh owns each plane)", () => {
    // box-small-a: inner floor 4.4 cm up; sunk the default 3 cm it sat 1.4 cm over the floor (the zfight gate's 2 cm)
    const box = seatObject(probe, { x: 2, z: 2, y: 0.4, halfX: 0.3, halfZ: 0.3, height: 0.5, flats: [0.044] }, "base");
    expect(Math.abs(0.044 + (box.y ?? 0))).toBeGreaterThanOrEqual(0.025);
    expect(box.y).toBeCloseTo(-0.019, 2);
    // a barrel's bottom 1.5 cm up goes under the floor instead: pressed 4 cm
    expect(seatObject(probe, { x: 2, z: 2, y: 0.4, halfX: 0.3, halfZ: 0.3, height: 0.7, flats: [0.014, 0.015] }, "base").y).toBeCloseTo(-0.04, 2);
    expect(flatSafeSink(0.03, [], 0.025)).toBe(0.03);
    expect(flatSafeSink(0.03, [0.2], 0.025)).toBe(0.03);
  });
  it("base: seated within 5 cm is ok", () => {
    expect(seatObject(probe, { x: 2, z: 2, y: 0.02, halfX: 0.5, halfZ: 0.5, height: 1 }, "base").status).toBe("ok");
  });
  it("base: a brazier perched on the monument edge (centre over the drop) is unsupported", () => {
    const r = seatObject(probe, { x: 9.8, z: 2, y: 6, halfX: 0.6, halfZ: 0.6, height: 1 }, "base", { reachDown: 8 });
    expect(r.status).toBe("unsupported");
  });
  it("embed: a rock straddling the 6 m edge is unsupported (drop it), one on the flat is sunk ROCK_EMBED (15%)", () => {
    expect(seatObject(probe, { x: 10, z: 2, y: 5.5, halfX: 1, halfZ: 1, height: 1.5 }, "embed", { reachDown: 8 }).status).toBe("unsupported");
    const flat = seatObject(probe, { x: 3, z: 3, y: 0.5, halfX: 1, halfZ: 1, height: 1.5 }, "embed");
    expect(flat.status).toBe("off");
    expect(flat.y).toBeCloseTo(-ROCK_EMBED * 1.5, 2);
    expect(seatObject(probe, { x: 3, z: 3, y: -0.3, halfX: 1, halfZ: 1, height: 1.5 }, "embed").status).toBe("ok");
  });
  it("embed: a rock mostly on the upper side of a step deeper than its reach is unsupported (the low side is not left out)", () => {
    // 70 % of the footprint on the 6 m top, reach 2.1 m (the placer reaches twice the rock): the low samples find no ground
    const r = seatObject(probe, { x: 10.6, z: 2, y: 6, halfX: 1, halfZ: 1, height: 1 }, "embed", { reachDown: 2.1 });
    expect(r.status).toBe("unsupported");
    expect(r.reason).toMatch(/straddles a step deeper/);
    // wholly on the top it seats as before
    expect(seatObject(probe, { x: 12, z: 2, y: 6.2, halfX: 1, halfZ: 1, height: 1 }, "embed", { reachDown: 2.1 }).status).toBe("off");
  });
  it("embed means EMBEDDED: a rock merely touching the ground is off; one 10% in is ok; the fix sinks it 15%", () => {
    const touching = seatObject(probe, { x: 3, z: 3, y: 0.02, halfX: 0.5, halfZ: 0.5, height: 1 }, "embed");
    expect(touching.status).toBe("off");
    expect(touching.gap).toBeGreaterThan(0.05); // short of the 10% by ~0.12 m
    expect(touching.reason).toMatch(/embedded 0% of its height \(< 10%\)/);
    expect(touching.y).toBeCloseTo(-ROCK_EMBED, 2);
    expect(seatObject(probe, { x: 3, z: 3, y: -ROCK_EMBED_MIN * 1.2 - 0.01, halfX: 0.5, halfZ: 1, height: 1.2 }, "embed").status).toBe("ok");
    expect(seatObject(probe, { x: 3, z: 3, y: -0.05, halfX: 0.5, halfZ: 0.5, height: 1 }, "embed").status).toBe("off");
  });
  it("embed on a slope sinks deeper than on the flat: the bottom follows the ground", () => {
    const slope = fieldSolidProbe({ voxelSize: 1, height: (x) => x * 0.58, density: (x, y) => y - x * 0.58 });
    const fp = { x: 5, z: 0, halfX: 0.6, halfZ: 0.6, height: 1 };
    const r = seatObject(slope, { ...fp, y: 5 * 0.58 }, "embed");
    expect(r.status).toBe("off");
    const lowest = (5 - 0.6 * 0.85) * 0.58;
    const sunk = lowest - r.y!;
    expect(sunk).toBeGreaterThan(ROCK_EMBED + 0.05); // more than the flat 15%
    expect(sunk).toBeLessThan(0.45 + 1e-6);
    // and once re-seated it is ok
    expect(seatObject(slope, { ...fp, y: r.y! }, "embed").status).toBe("ok");
  });
  it("embed with align: a rock tilted to a smooth 30° slope is ok; the same rock over the edge is not", () => {
    const slope = fieldSolidProbe({ voxelSize: 1, height: (x) => x * 0.58, density: (x, y) => y - x * 0.58 });
    expect(seatObject(slope, { x: 5, z: 0, y: 5 * 0.58 - 0.2, halfX: 0.6, halfZ: 0.6, height: 1, align: 0.85 }, "embed").status).toBe("ok");
    expect(seatObject(slope, { x: 5, z: 0, y: 5 * 0.58 - 0.1, halfX: 0.6, halfZ: 0.6, height: 1, align: 0 }, "embed").status).toBe("off");
    expect(seatObject(probe, { x: 10.2, z: 2, y: 5.9, halfX: 0.6, halfZ: 0.6, height: 1, align: 0.85 }, "embed", { reachDown: 8 }).status).toBe("unsupported");
  });
  it("legs: a table with a foot over nothing reports the hanging foot", () => {
    const r = seatObject(probe, { x: 9.6, z: 2, y: 6, halfX: 0.6, halfZ: 0.4, height: 0.8 }, "legs", { reachDown: 8 });
    expect(r.status).toBe("off");
    expect(r.gap).toBeGreaterThan(5);
  });
  it("hang: a lantern under the beam is pulled up to touch it; one in open air is unsupported", () => {
    const r = seatObject(probe, { x: -21, z: 2, y: 2.4, halfX: 0.15, halfZ: 0.15, height: 0.4 }, "hang");
    expect(r.status).toBe("off");
    expect(r.y).toBeCloseTo(2.6, 1);
    expect(seatObject(probe, { x: 5, z: 2, y: 2.4, halfX: 0.15, halfZ: 0.15, height: 0.4 }, "hang").status).toBe("unsupported");
  });
  it("wall: a sconce 0.5 m off the wall is moved back onto it", () => {
    // back = local -Z; yaw PI turns the back toward +Z (the wall)
    const r = seatObject(probe, { x: 5, z: 29.4, y: 2, halfX: 0.2, halfZ: 0.1, yaw: Math.PI, height: 0.5 }, "wall");
    expect(r.status).toBe("off");
    expect(r.z!).toBeGreaterThan(29.8);
  });
});

describe("seated (a sitting figure: hips on the seat, legs over its edge)", () => {
  // a 1.1 m bench over x <= 0 (its front edge at x = 0), floor at 0 in front of it; a back wall from x <= -1.2
  const bench: SolidProbe = {
    floor: (x, _z, hi, lo) => {
      const top = x <= -1.2 ? 5 : x <= 0 ? 1.1 : 0;
      return top < lo ? null : Math.min(top, hi);
    },
  };
  // the figure spans x in [-0.7, 1.3] (its centre past the edge): hips (underside 1.1) over x <= 0, shins/feet (underside 0.4) hanging past the edge
  const fp = { x: 0.3, z: 0, y: 0.4, halfX: 1, halfZ: 0.4, height: 2.6 };
  const underside = (dy = 0) => (x: number): number => (x <= 0 ? 1.1 : 0.4) + dy;
  it("as a flat base it reads 'centre over a drop' — the fault seated fixes", () => {
    expect(seatObject(bench, { ...fp, y: 1.1 }, "base").status).toBe("unsupported");
  });
  it("hips on the seat with the legs over the edge are ok", () => {
    const r = seatObject(bench, { ...fp, underside: underside() }, "seated");
    expect(r.status).toBe("ok");
    expect(r.gap).toBeCloseTo(0, 2);
  });
  it("lifted 0.3 m off its seat it is off and comes back down onto it", () => {
    const r = seatObject(bench, { ...fp, y: 0.7, underside: underside(0.3) }, "seated");
    expect(r.status).toBe("off");
    expect(r.gap).toBeCloseTo(0.3, 2);
    expect(r.y!).toBeCloseTo(0.4 - 0.03, 2);
  });
  it("over nothing at all it is unsupported", () => {
    const air: SolidProbe = { floor: () => null };
    expect(seatObject(air, { ...fp, underside: underside() }, "seated").status).toBe("unsupported");
  });
  it("defaults to contact from the catalogue entry", () => {
    expect(defaultSeatContact({ contact: "seated" }, "statues/king")).toBe("seated");
  });
});

describe("triangle probe (dungeon floors, decks)", () => {
  // a 4x4 deck at y=2 over (0..4, 0..4)
  const deck = [0, 2, 0, 4, 2, 0, 4, 2, 4, 0, 2, 0, 4, 2, 4, 0, 2, 4];
  it("seats a basket on the deck and finds the deck under a union with the field", () => {
    const p = unionSolidProbe(probe, triangleSolidProbe(deck));
    const r = seatObject(p, { x: 2, z: 2, y: 2.5, halfX: 0.3, halfZ: 0.3, height: 0.5 }, "base");
    expect(r.status).toBe("off");
    expect(r.y).toBeCloseTo(1.97, 2);
  });
});

describe("defaultSeatContact", () => {
  it("derives contact from mount, id and category; explicit wins", () => {
    expect(defaultSeatContact({ mount: "floor" }, "rock-kit/boulder-m-1")).toBe("embed");
    expect(defaultSeatContact({ mount: "wall" }, "fixtures/sconce-fire")).toBe("wall");
    expect(defaultSeatContact({ mount: "ceiling" }, "x/chandelier")).toBe("hang");
    expect(defaultSeatContact({ mount: "floor" }, "poi-props/hanging-lantern")).toBe("hang");
    expect(defaultSeatContact({ mount: "floor" }, "house-interior/table-a")).toBe("legs");
    expect(defaultSeatContact({ mount: "floor" }, "poi-props/basket")).toBe("base");
    expect(defaultSeatContact({ mount: "floor", contact: "base" }, "rock-kit/boulder-s-1")).toBe("base");
  });
});

describe("reachUp (the editor's Drop to surface lifts a sunk prop)", () => {
  it("a crate sunk 1.2 m stays buried with the default 0.6 m look-up, is lifted onto the ground with reachUp height", () => {
    const fp = { x: 2, z: 2, y: -1.2, halfX: 0.5, halfZ: 0.5, height: 1.5 };
    const def = seatObject(probe, fp, "base");
    expect(def.y === null || def.y < -0.5).toBe(true);
    const up = seatObject(probe, fp, "base", { reachUp: "height" });
    expect(up.y).toBeCloseTo(-0.03, 2);
  });
});
