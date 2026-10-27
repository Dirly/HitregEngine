import { beforeAll, describe, expect, it } from "vitest";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type Op } from "@hitreg/core";
import { initPhysics, PhysicsSim } from "../src/index.js";

// A lift cradle (kinematic box driven by setKinematicTarget) and what stands on it.

let registry: ComponentRegistry;
beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

const DT = 1 / 60;
const TOP = 12;

function entity(id: string, position: [number, number, number], components: Record<string, unknown>): Op {
  return { op: "add-entity", id, entity: { name: id, parent: null, tags: [], components: { transform: { position }, ...components } } };
}

function build(extra: Op[]): PhysicsSim {
  const doc = applyOps(
    createScene("carry"),
    [
      entity("deck", [0, TOP, 0], {
        rigidbody: { kind: "kinematic" },
        collider: { shape: "box", size: [3, 0.2, 3] },
      }),
      ...extra,
    ],
    registry,
  ).doc;
  return new PhysicsSim(doc);
}

/** The deck's y at time t: hold 1 s at the top, travel down at 3 m/s, hold, back up. */
function deckY(t: number): number {
  const travel = TOP / 3;
  const cycle = 2 + travel * 2;
  const u = t % cycle;
  if (u < 1) return TOP;
  if (u < 1 + travel) return TOP - (u - 1) * 3;
  if (u < 2 + travel) return 0;
  return (u - 2 - travel) * 3;
}

describe("kinematic carriers carry what stands on them", () => {
  it("a player-style dynamic body rides a lift down and back up, staying on the deck and reading vy ≈ 0", () => {
    const sim = build([
      entity("rider", [0, TOP + 1.1, 0], {
        rigidbody: { kind: "dynamic", lockRotations: true },
        collider: { shape: "capsule", size: [0.7, 1.8, 0.7] },
      }),
    ]);
    let worstGap = 0;
    let worstVy = 0;
    let minY = Infinity;
    const cycle = 2 + (TOP / 3) * 2;
    for (let i = 0; i < Math.round(cycle / DT); i++) {
      const t = (i + 1) * DT;
      // the controller's habit: horizontal velocity written every tick, vy kept
      const v = sim.getLinvel("rider")!;
      sim.setLinvel("rider", [0, v[1], 0]);
      sim.setKinematicTarget("deck", [0, deckY(t), 0]);
      sim.step(DT);
      if (i < 60) continue; // settling onto the deck
      const deck = sim.getPosition("deck")![1];
      const feet = sim.getPosition("rider")![1] - 0.9;
      worstGap = Math.max(worstGap, Math.abs(feet - (deck + 0.1)));
      worstVy = Math.max(worstVy, Math.abs(sim.getLinvel("rider")![1]));
      minY = Math.min(minY, deck);
    }
    expect(minY).toBeLessThan(0.01); // the deck really went to the bottom
    expect(worstGap).toBeLessThan(0.06);
    expect(worstVy).toBeLessThan(0.5);
    expect(sim.getPosition("rider")![1]).toBeGreaterThan(TOP); // and came back up with it
  });

  it("an inclined deck carries a body sideways too, though its controller writes zero horizontal velocity", () => {
    const sim = build([
      entity("rider", [0, TOP + 1.1, 0], {
        rigidbody: { kind: "dynamic", lockRotations: true },
        collider: { shape: "capsule", size: [0.7, 1.8, 0.7] },
      }),
    ]);
    for (let i = 0; i < 60; i++) sim.step(DT);
    // 8 m down and 3 m out over 4 s
    for (let i = 0; i < 240; i++) {
      const v = sim.getLinvel("rider")!;
      sim.setLinvel("rider", [0, v[1], 0]);
      const s = (i + 1) / 240;
      sim.setKinematicTarget("deck", [0, TOP - 8 * s, 3 * s]);
      sim.step(DT);
    }
    const r = sim.getPosition("rider")!;
    expect(r[2]).toBeCloseTo(3, 1);
    expect(r[1] - 0.9).toBeCloseTo(TOP - 8 + 0.1, 1);
  });

  it("a body touching the cradle's SIDE is not dragged along", () => {
    const sim = build([
      entity("floor", [0, 0, 0], { collider: { shape: "box", size: [20, 0.2, 20], offset: [0, TOP - 1.5, 0] } }),
      entity("beside", [1.86, TOP - 1.4 + 0.9, 0], {
        rigidbody: { kind: "dynamic", lockRotations: true },
        collider: { shape: "capsule", size: [0.7, 1.8, 0.7] },
      }),
    ]);
    for (let i = 0; i < 30; i++) sim.step(DT);
    const before = sim.getPosition("beside")![1];
    for (let i = 0; i < 60; i++) {
      sim.setKinematicTarget("deck", [0, TOP + (i + 1) * DT * 3, 0]);
      sim.step(DT);
    }
    expect(Math.abs(sim.getPosition("beside")![1] - before)).toBeLessThan(0.05);
  });

  it("a character controller standing on the deck rides it down", () => {
    const sim = build([
      entity("hero", [0, TOP + 1.0, 0], {
        rigidbody: { kind: "kinematic", lockRotations: true },
        collider: { shape: "capsule", size: [0.7, 1.8, 0.7] },
      }),
    ]);
    let gap = 0;
    for (let i = 0; i < 240; i++) {
      const t = (i + 1) * DT;
      sim.moveCharacter("hero", [0, -9.8 * DT * DT * 10, 0]); // gravity-ish press
      sim.setKinematicTarget("deck", [0, deckY(t), 0]);
      sim.step(DT);
      if (i > 30) {
        const feet = sim.getPosition("hero")![1] - 0.9;
        gap = Math.max(gap, Math.abs(feet - (sim.getPosition("deck")![1] + 0.1)));
      }
    }
    expect(sim.getPosition("deck")![1]).toBeLessThan(TOP - 5);
    expect(gap).toBeLessThan(0.08);
  });
  it("a collider streamed in between the deck's target and the step (then a ray) does not drop the rider", () => {
    // the server's order: scripts arm the deck, a terrain cell is added, a player's ground probe casts a ray (lazy
    // query refresh), then the step. The refresh must not spend the deck's target (kirk-stair lift 2026-10-22).
    const sim = build([
      entity("rider", [0, TOP + 1.1, 0], {
        rigidbody: { kind: "dynamic", lockRotations: true },
        collider: { shape: "capsule", size: [0.7, 1.8, 0.7] },
      }),
    ]);
    let worstGap = 0;
    for (let i = 0; i < 60 + 180; i++) {
      const t = (i + 1) * DT;
      const v = sim.getLinvel("rider")!;
      sim.setLinvel("rider", [0, v[1], 0]);
      sim.setKinematicTarget("deck", [0, deckY(t), 0]);
      if (i % 10 === 0) {
        sim.addEntities(applyOps(createScene("cell"), [entity(`cell-${i}`, [500 + i, 0, 0], { collider: { shape: "box", size: [2, 2, 2] } })], registry).doc);
        sim.raycast([0, TOP + 5, 0], [0, -1, 0], 50, { exclude: ["rider"] });
      }
      sim.step(DT);
      if (i < 60) continue;
      const deck = sim.getPosition("deck")![1];
      worstGap = Math.max(worstGap, Math.abs(sim.getPosition("rider")![1] - 0.9 - (deck + 0.1)));
    }
    expect(sim.getPosition("deck")![1]).toBeLessThan(TOP - 5);
    expect(worstGap).toBeLessThan(0.06);
  });
});
