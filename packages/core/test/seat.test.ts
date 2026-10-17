import { describe, expect, it } from "vitest";
import {
  defaultSeatContact,
  fieldSolidProbe,
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
  it("base: seated within 5 cm is ok", () => {
    expect(seatObject(probe, { x: 2, z: 2, y: 0.02, halfX: 0.5, halfZ: 0.5, height: 1 }, "base").status).toBe("ok");
  });
  it("base: a brazier perched on the monument edge (centre over the drop) is unsupported", () => {
    const r = seatObject(probe, { x: 9.8, z: 2, y: 6, halfX: 0.6, halfZ: 0.6, height: 1 }, "base", { reachDown: 8 });
    expect(r.status).toBe("unsupported");
  });
  it("embed: a rock straddling the 6 m edge is unsupported (drop it), one on the flat is sunk a fifth", () => {
    expect(seatObject(probe, { x: 10, z: 2, y: 5.5, halfX: 1, halfZ: 1, height: 1.5 }, "embed", { reachDown: 8 }).status).toBe("unsupported");
    const flat = seatObject(probe, { x: 3, z: 3, y: 0.5, halfX: 1, halfZ: 1, height: 1.5 }, "embed");
    expect(flat.status).toBe("off");
    expect(flat.y).toBeCloseTo(-0.3, 2);
    expect(seatObject(probe, { x: 3, z: 3, y: -0.3, halfX: 1, halfZ: 1, height: 1.5 }, "embed").status).toBe("ok");
  });
  it("embed with align: a rock tilted to a smooth 30° slope is ok; the same rock over the edge is not", () => {
    const slope = fieldSolidProbe({ voxelSize: 1, height: (x) => x * 0.58, density: (x, y) => y - x * 0.58 });
    expect(seatObject(slope, { x: 5, z: 0, y: 5 * 0.58 - 0.1, halfX: 0.6, halfZ: 0.6, height: 1, align: 0.85 }, "embed").status).toBe("ok");
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
