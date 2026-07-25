import { beforeAll, describe, expect, it } from "vitest";
import {
  ComponentRegistry,
  registerCoreComponents,
  sceneDocSchema,
  validateScene,
  type SceneDoc,
} from "@hitreg/core";
import { initPhysics, PhysicsSim } from "../src/index.js";

// Regression guard: a heightmap terrain whose collider is authored WITHOUT an
// explicit `size` (cooked shapes derive their geometry from the mesh, so size
// is meant to be omitted) once crashed PhysicsSim and silently disabled ALL
// collision. This builds that exact scenario inline — self-contained, no
// dependency on any playground scene — and proves a dropped body is caught by
// the cooked terrain instead of falling through it.

let registry: ComponentRegistry;

const terrainDoc = (): SceneDoc => ({
  version: 1,
  name: "heightmap-probe",
  entities: {
    ground: {
      name: "Terrain",
      parent: null,
      tags: ["static"],
      components: {
        transform: {},
        // heightmap mesh the collider cooks from
        mesh: { source: { kind: "heightmap", size: [80, 80], amplitude: 1.6, frequency: 0.06, seed: 12, resolution: 96, flatRadius: 14, flatFalloff: 10 } },
        // the regression case: shape "heightmap", NO `size` field
        collider: { shape: "heightmap", friction: 0.7 },
      },
    },
  },
});

beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

describe("heightmap-collider physics probe", () => {
  it("scene document validates", () => {
    const parsed = sceneDocSchema.safeParse(terrainDoc());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(validateScene(parsed.data, registry)).toEqual([]);
  });

  it("a body dropped onto a heightmap-collider terrain is caught, not dropped through", () => {
    const doc = sceneDocSchema.parse(terrainDoc());
    doc.entities["probe"] = {
      name: "Probe",
      parent: null,
      tags: [],
      components: {
        transform: { position: [0, 8, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        rigidbody: { kind: "dynamic", lockRotations: true, mass: 0, linearDamping: 0, angularDamping: 1, gravityScale: 1, ccd: true },
        collider: { shape: "capsule", size: [0.8, 1.8, 0.8], offset: [0, 0.9, 0], friction: 0.5, restitution: 0, density: 1, isTrigger: false },
      },
    };
    const sim = new PhysicsSim(doc);
    for (let i = 0; i < 60 * 5; i++) sim.step(1 / 60); // 5s under gravity
    const y = sim.states().get("probe")!.position[1];
    sim.free();
    // center is flat (~y=0); the probe must come to rest on the surface, not
    // sink through it (collision disabled would send it to large negatives).
    expect(y).toBeGreaterThan(-0.5);
    expect(y).toBeLessThan(8);
  });
});
