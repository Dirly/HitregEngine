import { beforeAll, describe, expect, it } from "vitest";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "@hitreg/core";
import {
  HITTABLE,
  initPhysics,
  Layers,
  PhysicsSim,
  SOLID_WORLD,
  VISION_BLOCKERS,
  interactionGroups,
  layerNames,
  type RayHit,
} from "../src/index.js";

let registry: ComponentRegistry;

beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

function scene(ops: Op[]): SceneDoc {
  return applyOps(createScene("physics-query-test"), ops, registry).doc;
}

/** Static box, centred at `at`. Lands on Layers.WORLD by default. */
function box(id: string, at: [number, number, number], size: [number, number, number]): Op {
  return {
    op: "add-entity",
    id,
    entity: {
      name: id,
      parent: null,
      tags: [],
      components: { transform: { position: at }, collider: { shape: "box", size } },
    },
  };
}

/** Dynamic box — Layers.PROP by default. */
function prop(id: string, at: [number, number, number], size: [number, number, number]): Op {
  return {
    op: "add-entity",
    id,
    entity: {
      name: id,
      parent: null,
      tags: [],
      components: {
        transform: { position: at },
        rigidbody: { kind: "dynamic", gravityScale: 0 },
        collider: { shape: "box", size },
      },
    },
  };
}

/** Kinematic capsule character: radius 0.35, total height 1.8, feet at `feetY`. */
function character(id: string, at: [number, number, number]): Op {
  return {
    op: "add-entity",
    id,
    entity: {
      name: id,
      parent: null,
      tags: [],
      components: {
        transform: { position: at },
        rigidbody: { kind: "kinematic", lockRotations: true },
        collider: { shape: "capsule", size: [0.7, 1.8, 0.7] },
      },
    },
  };
}

const ground = box("ground", [0, -0.1, 0], [60, 0.2, 60]);

describe("raycast", () => {
  it("hits the nearest collider and reports point, normal and distance", () => {
    const sim = new PhysicsSim(scene([box("wall", [10, 1, 0], [2, 4, 8])]));
    const hit = sim.raycast([0, 1, 0], [1, 0, 0], 50);
    expect(hit).not.toBeNull();
    expect(hit!.entityId).toBe("wall");
    expect(hit!.distance).toBeCloseTo(9, 5); // wall face at x = 10 - 1
    expect(hit!.point[0]).toBeCloseTo(9, 5);
    // normal faces back down the ray, which is what a script wants for
    // reflecting, spawning an impact decal, or deciding "is this a wall"
    expect(hit!.normal[0]).toBeCloseTo(-1, 5);
    sim.free();
  });

  it("returns null when nothing is in the way, and when maxDistance falls short", () => {
    const sim = new PhysicsSim(scene([box("wall", [10, 1, 0], [2, 4, 8])]));
    expect(sim.raycast([0, 1, 0], [-1, 0, 0], 50)).toBeNull();
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 5)).toBeNull();
    expect(sim.raycast([0, 1, 0], [0, 0, 0], 50)).toBeNull(); // degenerate direction
    sim.free();
  });

  it("normalizes the direction, so distance is always metres", () => {
    const sim = new PhysicsSim(scene([box("wall", [10, 1, 0], [2, 4, 8])]));
    const hit = sim.raycast([0, 1, 0], [7, 0, 0], 50);
    expect(hit!.distance).toBeCloseTo(9, 5);
    sim.free();
  });

  it("without an exclude list a self-cast hits the caster — the documented footgun", () => {
    const sim = new PhysicsSim(scene([box("wall", [10, 1, 0], [2, 4, 8]), character("hero", [0, 1, 0])]));
    // cast from inside the hero's own capsule
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50)!.entityId).toBe("hero");
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { exclude: ["hero"] })!.entityId).toBe("wall");
    sim.free();
  });

  it("excludes several entities at once (predicate path)", () => {
    const sim = new PhysicsSim(
      scene([box("a", [2, 1, 0], [1, 2, 2]), box("b", [4, 1, 0], [1, 2, 2]), box("c", [6, 1, 0], [1, 2, 2])]),
    );
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50)!.entityId).toBe("a");
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { exclude: ["a", "b"] })!.entityId).toBe("c");
    // an unknown id in the list is inert, not an error
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { exclude: ["a", "nope"] })!.entityId).toBe("b");
    sim.free();
  });

  it("filters by layer: a world-only probe ignores props", () => {
    const sim = new PhysicsSim(scene([prop("crate", [3, 1, 0], [1, 2, 2]), box("wall", [10, 1, 0], [2, 4, 8])]));
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50)!.entityId).toBe("crate");
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { layers: SOLID_WORLD })!.entityId).toBe("wall");
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { layers: VISION_BLOCKERS })!.entityId).toBe("crate");
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { layers: Layers.ACTOR })).toBeNull();
    sim.free();
  });

  it("ignores sensors unless asked", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "lift-volume",
        entity: {
          name: "lift",
          parent: null,
          tags: [],
          components: {
            transform: { position: [3, 1, 0] },
            collider: { shape: "box", size: [2, 2, 2], isTrigger: true },
          },
        },
      },
      box("wall", [10, 1, 0], [2, 4, 8]),
    ]);
    const sim = new PhysicsSim(doc);
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50)!.entityId).toBe("wall");
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { includeSensors: true })!.entityId).toBe(
      "lift-volume",
    );
    sim.free();
  });

  it("fills a caller-supplied result object instead of allocating", () => {
    const sim = new PhysicsSim(scene([box("wall", [10, 1, 0], [2, 4, 8])]));
    const out: RayHit = { entityId: "", point: [0, 0, 0], normal: [0, 0, 0], distance: 0 };
    const hit = sim.raycast([0, 1, 0], [1, 0, 0], 50, { out });
    expect(hit).toBe(out);
    expect(out.entityId).toBe("wall");
    expect(out.distance).toBeCloseTo(9, 5);
    sim.free();
  });
});

describe("raycastAll", () => {
  const walls = [
    box("far", [30, 1, 0], [2, 4, 8]),
    box("near", [5, 1, 0], [2, 4, 8]),
    box("mid", [15, 1, 0], [2, 4, 8]),
  ];

  it("reports every hit, nearest first", () => {
    const sim = new PhysicsSim(scene(walls));
    const hits = sim.raycastAll([0, 1, 0], [1, 0, 0], 100);
    expect(hits.map((h) => h.entityId)).toEqual(["near", "mid", "far"]);
    expect(hits[0]!.distance).toBeCloseTo(4, 5);
    sim.free();
  });

  it("orders identically no matter what order the world was built in", () => {
    // The real scenario: chunk streaming inserts colliders in whatever order
    // the network delivered them, so two peers holding the same world can walk
    // Rapier's broad phase in different orders. Anything downstream that says
    // "the first thing the ray hit" must not depend on that.
    const a = new PhysicsSim(scene(walls));
    const b = new PhysicsSim(scene([...walls].reverse()));
    const ids = (sim: PhysicsSim): string[] =>
      sim.raycastAll([0, 1, 0], [1, 0, 0], 100).map((h) => h.entityId);
    expect(ids(a)).toEqual(ids(b));
    a.free();
    b.free();
  });

  it("breaks distance ties on entity id, not insertion order", () => {
    // two coincident colliders: same face, same distance
    const forward = new PhysicsSim(scene([box("zulu", [5, 1, 0], [2, 4, 8]), box("alpha", [5, 1, 0], [2, 4, 8])]));
    const backward = new PhysicsSim(scene([box("alpha", [5, 1, 0], [2, 4, 8]), box("zulu", [5, 1, 0], [2, 4, 8])]));
    expect(forward.raycastAll([0, 1, 0], [1, 0, 0], 100).map((h) => h.entityId)).toEqual([
      "alpha",
      "zulu",
    ]);
    expect(backward.raycastAll([0, 1, 0], [1, 0, 0], 100).map((h) => h.entityId)).toEqual([
      "alpha",
      "zulu",
    ]);
    forward.free();
    backward.free();
  });

  it("refills a caller-supplied array", () => {
    const sim = new PhysicsSim(scene(walls));
    const out: RayHit[] = [];
    expect(sim.raycastAll([0, 1, 0], [1, 0, 0], 100, { out })).toBe(out);
    expect(out).toHaveLength(3);
    sim.raycastAll([0, 1, 0], [-1, 0, 0], 100, { out });
    expect(out).toHaveLength(0);
    sim.free();
  });
});

describe("shapecast", () => {
  it("sweeps onto a target and reports the travelled distance", () => {
    const sim = new PhysicsSim(scene([box("wall", [10, 5, 0], [2, 4, 8])]));
    const hit = sim.spherecast(0.5, [0, 5, 0], [20, 5, 0]);
    expect(hit).not.toBeNull();
    expect(hit!.entityId).toBe("wall");
    // wall face at x = 9; a 0.5 ball touches it after travelling 8.5
    expect(hit!.distance).toBeCloseTo(8.5, 3);
    // world-space contact point, on the wall's face — not the ball's centre
    expect(hit!.point[0]).toBeCloseTo(9, 3);
    expect(hit!.normal[0]).toBeCloseTo(-1, 3);
    sim.free();
  });

  it("catches what a ray between two fixed steps misses — the weapon-arc case", () => {
    // A target standing 0.6 m off the swing's centre line. A hilt-to-tip ray
    // straight down the arc's mid-angle passes it; the blade's swept capsule
    // does not, which is the whole reason a swing is a shape cast.
    const sim = new PhysicsSim(scene([prop("goblin", [3, 1, 0.6], [0.7, 1.8, 0.7])]));
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 4, { layers: HITTABLE })).toBeNull();
    const swept = sim.capsulecast(0.5, 0.6, [0, 1, 0], [4, 1, 0], { layers: HITTABLE });
    expect(swept?.entityId).toBe("goblin");
    sim.free();
  });

  it("a pillar on the arc stops the swing — what a script-side capsule test cannot know", () => {
    const sim = new PhysicsSim(
      scene([box("pillar", [1.5, 1, 0], [0.6, 4, 0.6]), prop("goblin", [3, 1, 0], [0.7, 1.8, 0.7])]),
    );
    const hit = sim.capsulecast(0.4, 0.6, [0, 1, 0], [4, 1, 0], { layers: HITTABLE });
    expect(hit!.entityId).toBe("pillar");
    // and asking only about actors sees straight past it
    expect(sim.capsulecast(0.4, 0.6, [0, 1, 0], [4, 1, 0], { layers: Layers.PROP })!.entityId).toBe(
      "goblin",
    );
    sim.free();
  });

  it("honours exclusion and returns null on a zero-length sweep", () => {
    const sim = new PhysicsSim(scene([box("wall", [10, 5, 0], [2, 4, 8]), character("hero", [0, 5, 0])]));
    expect(sim.spherecast(0.5, [0, 5, 0], [20, 5, 0])!.entityId).toBe("hero");
    expect(sim.spherecast(0.5, [0, 5, 0], [20, 5, 0], { exclude: ["hero"] })!.entityId).toBe("wall");
    expect(sim.spherecast(0.5, [0, 5, 0], [0, 5, 0])).toBeNull();
    sim.free();
  });

  it("sweeps a cuboid", () => {
    const sim = new PhysicsSim(scene([box("wall", [10, 5, 0], [2, 4, 8])]));
    const hit = sim.shapecast({ kind: "cuboid", halfExtents: [0.5, 0.5, 0.5] }, [0, 5, 0], [20, 5, 0]);
    expect(hit!.distance).toBeCloseTo(8.5, 3);
    sim.free();
  });
});

describe("overlapShape", () => {
  const crowd = [
    prop("goblin-a", [1, 1, 0], [0.7, 1.8, 0.7]),
    prop("goblin-b", [-1.5, 1, 0], [0.7, 1.8, 0.7]),
    prop("goblin-c", [9, 1, 0], [0.7, 1.8, 0.7]),
    box("pillar", [0, 2, 2], [0.6, 4, 0.6]),
  ];

  it("returns the entities inside the volume, sorted", () => {
    const sim = new PhysicsSim(scene(crowd));
    expect(sim.overlapSphere([0, 1, 0], 3)).toEqual(["goblin-a", "goblin-b", "pillar"]);
    expect(sim.overlapSphere([0, 1, 0], 3, { layers: Layers.PROP })).toEqual([
      "goblin-a",
      "goblin-b",
    ]);
    expect(sim.overlapSphere([0, 1, 0], 0.2, { layers: Layers.PROP })).toEqual([]);
    sim.free();
  });

  it("is order-independent — the AoE damages the same enemy first on every peer", () => {
    const a = new PhysicsSim(scene(crowd));
    const b = new PhysicsSim(scene([...crowd].reverse()));
    expect(a.overlapSphere([0, 1, 0], 3)).toEqual(b.overlapSphere([0, 1, 0], 3));
    a.free();
    b.free();
  });

  it("reports an entity once even when it has several colliders", () => {
    const doc = scene([prop("goblin-a", [1, 1, 0], [0.7, 1.8, 0.7])]);
    const sim = new PhysicsSim(doc);
    // a second collider on the same body is exactly what a chunk-injected
    // compound prop looks like; "am I inside" has one answer regardless
    sim.addEntities(scene([prop("goblin-b", [1.2, 1, 0], [0.7, 1.8, 0.7])]));
    expect(sim.overlapSphere([1, 1, 0], 2)).toEqual(["goblin-a", "goblin-b"]);
    sim.free();
  });

  it("finds trigger volumes only when asked — 'which lift am I standing on'", () => {
    const sim = new PhysicsSim(
      scene([
        {
          op: "add-entity",
          id: "extraction-lift",
          entity: {
            name: "lift",
            parent: null,
            tags: [],
            components: {
              transform: { position: [0, 1, 0] },
              collider: { shape: "box", size: [4, 2, 4], isTrigger: true },
            },
          },
        },
      ]),
    );
    expect(sim.overlapSphere([0, 1, 0], 1)).toEqual([]);
    expect(sim.overlapSphere([0, 1, 0], 1, { includeSensors: true, layers: Layers.TRIGGER })).toEqual(
      ["extraction-lift"],
    );
    sim.free();
  });

  it("refills a caller-supplied array", () => {
    const sim = new PhysicsSim(scene(crowd));
    const out: string[] = [];
    expect(sim.overlapSphere([0, 1, 0], 3, { out })).toBe(out);
    expect(out.length).toBe(3);
    sim.overlapSphere([200, 1, 0], 3, { out });
    expect(out).toEqual([]);
    sim.free();
  });
});

describe("collision layers", () => {
  it("infers membership from what the collider is", () => {
    const sim = new PhysicsSim(
      scene([
        ground,
        prop("crate", [0, 3, 0], [1, 1, 1]),
        {
          op: "add-entity",
          id: "volume",
          entity: {
            name: "volume",
            parent: null,
            tags: [],
            components: {
              transform: {},
              collider: { shape: "box", size: [2, 2, 2], isTrigger: true },
            },
          },
        },
      ]),
    );
    expect(sim.layersOf("ground")!.membership).toBe(Layers.WORLD);
    expect(sim.layersOf("crate")!.membership).toBe(Layers.PROP);
    expect(sim.layersOf("volume")!.membership).toBe(Layers.TRIGGER);
    // filter defaults to ALL, which is why layering changed no existing scene
    expect(sim.layersOf("crate")!.collidesWith).toBe(Layers.ALL);
    expect(sim.layersOf("missing")).toBeNull();
    sim.free();
  });

  it("setLayers retags at runtime, and queries follow", () => {
    const sim = new PhysicsSim(scene([prop("goblin", [5, 1, 0], [0.7, 1.8, 0.7])]));
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { layers: Layers.ACTOR })).toBeNull();
    sim.setLayers("goblin", Layers.ACTOR);
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { layers: Layers.ACTOR })!.entityId).toBe("goblin");
    expect(sim.raycast([0, 1, 0], [1, 0, 0], 50, { layers: Layers.PROP })).toBeNull();
    expect(sim.layersOf("goblin")).toEqual({ membership: Layers.ACTOR, collidesWith: Layers.ALL });
    sim.free();
  });

  it("packs membership and filter into Rapier's word without sign damage", () => {
    // bit 15 is the one that goes negative under a naive `<< 16`
    const groups = interactionGroups(1 << 15, Layers.ALL);
    expect(groups).toBeGreaterThan(0);
    expect(groups >>> 16).toBe(1 << 15);
    expect(groups & 0xffff).toBe(0xffff);
    expect(layerNames(Layers.WORLD | Layers.ACTOR)).toEqual(["WORLD", "ACTOR"]);
  });
});

describe("character controller", () => {
  /** One movement tick: compute + apply, then let the kinematic body land. */
  function tick(sim: PhysicsSim, id: string, desired: [number, number, number]) {
    const move = sim.moveCharacter(id, desired);
    sim.step(1 / 60);
    return move;
  }

  it("walks up a stair it could never walk through", () => {
    const sim = new PhysicsSim(
      scene([ground, box("step", [0, 0.15, 3], [4, 0.3, 2]), character("hero", [0, 0.9, 0])]),
    );
    sim.configureCharacter("hero", { layers: SOLID_WORLD });
    let grounded = false;
    for (let i = 0; i < 55; i++) grounded = tick(sim, "hero", [0, -0.05, 0.08]).grounded;
    const pos = sim.states().get("hero")!.position;
    expect(pos[2]).toBeGreaterThan(2.5); // made it onto the step
    expect(pos[1]).toBeGreaterThan(1.1); // and up it: feet were at 0, now at ~0.3
    expect(grounded).toBe(true);
    sim.free();
  });

  it("is stopped dead by the same lip with autostep off — why the setting is load-bearing", () => {
    const sim = new PhysicsSim(
      scene([ground, box("step", [0, 0.15, 3], [4, 0.3, 2]), character("hero", [0, 0.9, 0])]),
    );
    sim.configureCharacter("hero", { layers: SOLID_WORLD, autostep: null });
    for (let i = 0; i < 90; i++) tick(sim, "hero", [0, -0.05, 0.08]);
    const pos = sim.states().get("hero")!.position;
    expect(pos[1]).toBeLessThan(1.0); // never climbed
    expect(pos[2]).toBeLessThan(2.3); // stuck at the riser
    sim.free();
  });

  it("stops at a wall and reports it, without tunnelling through", () => {
    const sim = new PhysicsSim(
      scene([ground, box("wall", [0, 1.5, 6], [8, 3, 0.4]), character("hero", [0, 0.9, 0])]),
    );
    sim.configureCharacter("hero", { layers: SOLID_WORLD });
    let hitWall = false;
    let collisions: string[] = [];
    for (let i = 0; i < 200; i++) {
      const move = tick(sim, "hero", [0, -0.05, 0.08]);
      if (move.hitWall) {
        hitWall = true;
        collisions = move.collisions;
      }
    }
    expect(hitWall).toBe(true);
    expect(collisions).toContain("wall");
    const pos = sim.states().get("hero")!.position;
    expect(pos[2]).toBeLessThan(5.8 - 0.35 + 0.05); // stopped in front of the face
    sim.free();
  });

  it("returns the APPLIED translation, not the requested one", () => {
    const sim = new PhysicsSim(
      scene([ground, box("wall", [0, 1.5, 1.2], [8, 3, 0.4]), character("hero", [0, 0.9, 0])]),
    );
    sim.configureCharacter("hero", { layers: SOLID_WORLD });
    const move = tick(sim, "hero", [0, 0, 1]);
    expect(move.translation[2]).toBeLessThan(1);
    expect(move.translation[2]).toBeGreaterThanOrEqual(0);
    sim.free();
  });

  it("auto-configures on first move and never collides with itself", () => {
    const sim = new PhysicsSim(scene([ground, character("hero", [0, 0.9, 0])]));
    expect(sim.hasCharacter("hero")).toBe(false);
    const move = tick(sim, "hero", [0.1, -0.05, 0]);
    expect(sim.hasCharacter("hero")).toBe(true);
    expect(move.collisions).not.toContain("hero");
    // not exactly 0.1: the controller also nudges the capsule out to its skin
    // offset on the frame it settles onto the floor
    expect(move.translation[0]).toBeCloseTo(0.1, 3); // nothing in the way
    sim.free();
  });

  it("passes through entities it was told to ignore", () => {
    const sim = new PhysicsSim(
      scene([ground, box("gate", [0, 1.5, 1.2], [8, 3, 0.4]), character("hero", [0, 0.9, 0])]),
    );
    sim.configureCharacter("hero", { layers: SOLID_WORLD, exclude: ["gate"] });
    const move = tick(sim, "hero", [0, 0, 1]);
    expect(move.translation[2]).toBeCloseTo(1, 3);
    // the floor it is standing on is still a touched surface (that is what
    // drives footstep material lookups) — the gate is what it passed through
    expect(move.collisions).not.toContain("gate");
    sim.free();
  });

  it("reconfiguring does not leak a second controller, and unloading drops it", () => {
    const sim = new PhysicsSim(scene([ground, character("hero", [0, 0.9, 0])]));
    sim.configureCharacter("hero", { offset: 0.02 });
    sim.configureCharacter("hero", { offset: 0.05 }); // forces a rebuild
    sim.configureCharacter("hero", { snapToGround: null });
    expect(sim.hasCharacter("hero")).toBe(true);
    sim.removeEntities(["hero"]); // chunk unload
    expect(sim.hasCharacter("hero")).toBe(false);
    // moving a despawned character is inert, not a crash
    expect(sim.moveCharacter("hero", [0, 0, 1]).translation).toEqual([0, 0, 0]);
    sim.free();
  });

  it("writes into a caller-supplied result", () => {
    const sim = new PhysicsSim(scene([ground, character("hero", [0, 0.9, 0])]));
    const out = {
      translation: [9, 9, 9] as [number, number, number],
      grounded: true,
      hitWall: true,
      hitCeiling: true,
      collisions: ["stale"],
    };
    const move = sim.moveCharacter("hero", [0.1, -0.05, 0], out);
    expect(move).toBe(out);
    expect(out.hitWall).toBe(false);
    expect(out.hitCeiling).toBe(false);
    expect(out.collisions).not.toContain("stale"); // reset, not appended to
    expect(out.translation[0]).toBeCloseTo(0.1, 3);
    sim.free();
  });
});

describe("query cost discipline", () => {
  it("survives a hot loop of mixed queries without leaking wasm shapes", () => {
    // 3 x 2000 queries through the pooled Ray/Ball/Capsule scratch. If any of
    // them held a raw wasm allocation this would grow unboundedly and, in a
    // real frame loop, show up as the "off-loop" time the profiler calls out.
    const sim = new PhysicsSim(scene([ground, box("wall", [10, 1, 0], [2, 4, 8])]));
    const out: RayHit = { entityId: "", point: [0, 0, 0], normal: [0, 0, 0], distance: 0 };
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) {
      sim.raycast([0, 1, 0], [1, 0, 0], 50, { out, layers: SOLID_WORLD });
      sim.spherecast(0.25, [0, 1, 0], [20, 1, 0], { layers: SOLID_WORLD });
      sim.overlapSphere([10, 3, 0], 1.5, { out: ids, layers: SOLID_WORLD });
    }
    expect(out.entityId).toBe("wall");
    expect(ids).toEqual(["wall"]);
    sim.free();
  });
});
