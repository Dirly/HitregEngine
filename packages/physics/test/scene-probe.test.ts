import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ComponentRegistry,
  registerCoreComponents,
  sceneDocSchema,
  validateScene,
  type SceneDoc,
} from "@hitreg/core";
import { initPhysics, PhysicsSim } from "../src/index.js";

// Regression guard for the playground scene: file-authored docs skip zod
// default-filling, which once crashed PhysicsSim (heightmap collider without
// `size`) and silently disabled ALL collision. Probes the real scene.

const SCENE = "../../../apps/playground/assets/scenes/my-game.scene.json";

let registry: ComponentRegistry;
let doc: SceneDoc;

beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
  const raw = JSON.parse(readFileSync(new URL(SCENE, import.meta.url), "utf8"));
  const parsed = sceneDocSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`scene schema: ${parsed.error.message.slice(0, 500)}`);
  doc = parsed.data;
});

describe("my-game scene physics probe", () => {
  it("scene document validates", () => {
    const issues = validateScene(doc, registry);
    expect(issues).toEqual([]);
  });

  it("a probe walking east is stopped by the barrier, not at the rocks", () => {
    const probe = structuredClone(doc);
    probe.entities["probe"] = {
      name: "Probe",
      parent: null,
      tags: [],
      components: {
        transform: { position: [10, 1.2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        rigidbody: { kind: "dynamic", lockRotations: true, mass: 0, linearDamping: 0, angularDamping: 1, gravityScale: 1, ccd: false },
        collider: { shape: "capsule", size: [0.8, 1.8, 0.8], offset: [0, 0.9, 0], friction: 0, restitution: 0, density: 1, isTrigger: false },
      },
    };
    const sim = new PhysicsSim(probe);
    for (let i = 0; i < 60 * 5; i++) {
      const v = sim.getLinvel("probe")!;
      sim.setLinvel("probe", [8, v[1], 0]);
      sim.step(1 / 60);
    }
    const x = sim.states().get("probe")!.position[0];
    sim.free();
    // barrier-east sits at x=20 (half thickness 0.5) — the probe must stop there
    expect(x).toBeLessThan(20.2);
    expect(x).toBeGreaterThan(17);
  });

  it("a probe dropped outside the barrier is stopped by a ring rock", () => {
    const probe = structuredClone(doc);
    // find an actual ring rock and aim straight at it from inside its radius
    const rock = Object.values(probe.entities).find((e) => e.name?.startsWith("Ring Rock"))!;
    const [rx, , rz] = (rock.components["transform"] as { position: [number, number, number] }).position;
    const len = Math.hypot(rx, rz);
    const dir: [number, number] = [rx / len, rz / len];
    const start: [number, number] = [rx - dir[0] * 6, rz - dir[1] * 6];
    probe.entities["probe"] = {
      name: "Probe",
      parent: null,
      tags: [],
      components: {
        transform: { position: [start[0], 1.2, start[1]], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        rigidbody: { kind: "dynamic", lockRotations: true, mass: 0, linearDamping: 0, angularDamping: 1, gravityScale: 1, ccd: false },
        collider: { shape: "capsule", size: [0.8, 1.8, 0.8], offset: [0, 0.9, 0], friction: 0, restitution: 0, density: 1, isTrigger: false },
      },
    };
    // delete the barriers so only the rock can stop the probe
    for (const id of Object.keys(probe.entities)) if (id.startsWith("barrier-")) delete probe.entities[id];
    const sim = new PhysicsSim(probe);
    for (let i = 0; i < 60 * 5; i++) {
      const v = sim.getLinvel("probe")!;
      sim.setLinvel("probe", [dir[0] * 8, v[1], dir[1] * 8]);
      sim.step(1 / 60);
    }
    const pos = sim.states().get("probe")!.position;
    const traveled = Math.hypot(pos[0], pos[2]);
    sim.free();
    // rock center is at radius ~len; the probe must be stopped near/before it
    expect(traveled).toBeLessThan(len + 1);
  });
});
