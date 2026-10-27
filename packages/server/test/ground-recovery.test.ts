import { describe, expect, it } from "vitest";
import { groundVerdict, type GroundProbe } from "../src/ground-recovery.js";

/** The authority's "fell through the earth" decision (ground-recovery.ts), on synthetic probes. */
const probe = (o: Partial<GroundProbe>): GroundProbe => ({ position: [0, 10.9, 0], surface: 10, floorNear: 10, colliderBelow: 0.9, cellResident: true, ...o });

describe("groundVerdict", () => {
  it("leaves a body standing on the surface alone", () => {
    expect(groundVerdict(probe({})).kind).toBe("ok");
  });
  it("loads the cell first when the body stands where nothing is resident", () => {
    expect(groundVerdict(probe({ cellResident: false, position: [0, -40, 0], colliderBelow: null })).kind).toBe("uncovered");
  });
  it("calls a body inside the rock with nothing under it fallen", () => {
    const v = groundVerdict(probe({ position: [0, 2, 0], floorNear: null, colliderBelow: null }));
    expect(v).toEqual({ kind: "fell", depth: 8 });
  });
  it("calls a body under a cave floor (the floor above it) fallen", () => {
    expect(groundVerdict(probe({ position: [0, -20, 0], floorNear: -16, colliderBelow: null })).kind).toBe("fell");
  });
  it("leaves a body in a cave, on its floor, alone", () => {
    expect(groundVerdict(probe({ position: [0, -19.1, 0], floorNear: -20, colliderBelow: null })).kind).toBe("ok");
  });
  it("leaves a body on a buried landmark floor (collider under it, rock around it) alone", () => {
    expect(groundVerdict(probe({ position: [0, 5, 0], floorNear: null, colliderBelow: 0.9 })).kind).toBe("ok");
  });
  it("calls anything 80 m under the surface with nothing close below fallen", () => {
    expect(groundVerdict(probe({ position: [0, -100, 0], floorNear: -101, colliderBelow: null })).kind).toBe("fell");
  });
});
