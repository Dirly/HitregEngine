import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { z } from "zod";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  EventRegistry,
  NetStateStore,
  combatKey,
  landingKey,
  mobEventDecls,
  noticeKey,
  registerCoreComponents,
  registerCoreEvents,
  registerLandingNetState,
  type Op,
} from "@hitreg/core";
import {
  EventBus,
  registerBuiltinScripts,
  ScriptRegistry,
  ScriptRuntime,
  type InputLike,
  type SimHit,
  type SimLike,
} from "../src/index.js";
import { GROUND_LAYERS, OBSTACLE_LAYERS } from "../src/steering.js";
import { MOVE_TARGET_RULES } from "../src/mob-brain.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);
const noInput: InputLike = { isDown: () => false };

/**
 * A mob, a player, flat ground, and whatever walls the test asks for.
 *
 * The harness integrates the drive channel itself — `impulseVel` times dt —
 * because there is no controller in a headless scene to do it. That is the
 * contract the brain is actually written against (it never touches velocity
 * directly), so integrating it here tests the same thing the game runs.
 */
function harness(opts: {
  params?: Record<string, unknown>;
  mobAt?: [number, number, number];
  playerAt?: [number, number, number];
  walls?: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
  /** More bodies in the scene: a second player, a packmate, the other faction. */
  extras?: Array<{
    id: string;
    at: [number, number, number];
    tags?: string[];
    script?: { name: string; params: Record<string, unknown> };
  }>;
}) {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events);

  const netState = new NetStateStore();
  registerLandingNetState(netState);
  // The combat pools a game publishes. The engine has no combat model; it just
  // agrees on the two keys NpcManager already reads (mob.ts).
  netState.define("combat", z.union([z.number(), z.boolean(), z.string()]));

  const ops: Op[] = [
    {
      op: "add-entity",
      id: "mob",
      entity: {
        name: "mob",
        parent: null,
        tags: ["npc"],
        components: {
          transform: { position: opts.mobAt ?? [0, 0, 0] },
          script: { name: "mob-brain", params: opts.params ?? {} },
        },
      },
    },
    {
      op: "add-entity",
      id: "player",
      entity: {
        name: "player",
        parent: null,
        tags: ["player"],
        components: { transform: { position: opts.playerAt ?? [0, 0, 100] } },
      },
    },
  ];
  for (const extra of opts.extras ?? []) {
    ops.push({
      op: "add-entity",
      id: extra.id,
      entity: {
        name: extra.id,
        parent: null,
        tags: extra.tags ?? [],
        components: {
          transform: { position: extra.at },
          ...(extra.script ? { script: extra.script } : {}),
        },
      },
    });
  }
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;

  const scene = new THREE.Scene();
  const mob = new THREE.Object3D();
  mob.position.fromArray(opts.mobAt ?? [0, 0, 0]);
  const player = new THREE.Object3D();
  player.position.fromArray(opts.playerAt ?? [0, 0, 100]);
  scene.add(mob, player);
  const objects = new Map([
    ["mob", mob],
    ["player", player],
  ]);
  for (const extra of opts.extras ?? []) {
    const obj = new THREE.Object3D();
    obj.position.fromArray(extra.at);
    scene.add(obj);
    objects.set(extra.id, obj);
  }
  scene.updateMatrixWorld(true);

  const walls = opts.walls ?? [];
  // Every query the brain makes, so a test can assert what it asked for and not
  // only what this stub chose to answer — the stub models walls, while the real
  // sim also has BODIES in the way (see the sight test).
  const queries: Array<{ maxDistance: number; exclude: string[] }> = [];
  const sim: SimLike = {
    getLinvel: () => [0, 0, 0],
    setLinvel: () => {},
    applyImpulse: () => {},
    raycast(origin, dir, maxDistance, query): SimHit | null {
      queries.push({ maxDistance, exclude: [...((query?.exclude as string[]) ?? [])] });
      const layers = query?.layers ?? 0xffff;
      if (dir[1] < -0.5) {
        if ((layers & GROUND_LAYERS) === 0) return null;
        // Flat world at y = 0.
        if (origin[1] < 0 || origin[1] > maxDistance) return null;
        return { entityId: "ground", point: [origin[0], 0, origin[2]], normal: [0, 1, 0], distance: origin[1] };
      }
      if ((layers & (OBSTACLE_LAYERS | 0x0002)) === 0) return null;
      for (let i = 1; i <= 60; i++) {
        const t = (i / 60) * maxDistance;
        const x = origin[0] + dir[0] * t;
        const z = origin[2] + dir[2] * t;
        for (const w of walls) {
          if (x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ) {
            return { entityId: "wall", point: [x, origin[1], z], normal: [0, 0, -1], distance: t };
          }
        }
      }
      return null;
    },
  };

  const bus = new EventBus(events);
  const runtime = new ScriptRuntime({ doc, objects, sim, registry, input: noInput, events: bus, netState });

  const heard: Array<{ name: string; payload: Record<string, unknown> }> = [];
  for (const name of ["mob.state", "mob.attack", "mob.alert"]) {
    bus.on(name, (payload) => heard.push({ name, payload: payload as Record<string, unknown> }));
  }
  runtime.start();

  const dt = 1 / 60;
  return {
    runtime,
    heard,
    mob,
    player,
    netState,
    bus,
    objects,
    queries: () => queries,
    drive: () => (mob.userData["impulseVel"] as [number, number]) ?? [0, 0],
    driveOf: (id: string) => (objects.get(id)!.userData["impulseVel"] as [number, number]) ?? [0, 0],
    /** Tell a mob how angry to be — what a game's combat layer does on a hit. */
    threat: (payload: Record<string, unknown>) => bus.emit("mob.threat", { mobId: "mob", ...payload }),
    alerts: () => heard.filter((e) => e.name === "mob.alert"),
    states: () => heard.filter((e) => e.name === "mob.state").map((e) => e.payload["state"]),
    attacks: () => heard.filter((e) => e.name === "mob.attack"),
    movePlayer: (x: number, y: number, z: number) => {
      player.position.set(x, y, z);
      scene.updateMatrixWorld(true);
    },
    /** Tick the sim, moving the mob the way its drive channel asked. */
    step: (ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        runtime.fixedUpdate(dt);
        const v = (mob.userData["impulseVel"] as [number, number] | undefined) ?? [0, 0];
        mob.position.x += v[0] * dt;
        mob.position.z += v[1] * dt;
        scene.updateMatrixWorld(true);
      }
    },
  };
}

describe("mob-brain at rest", () => {
  it("holds the drive channel even standing still", () => {
    // A body that stops writing impulseVel hands itself back to whatever else
    // is driving — on a client, the shared keyboard.
    const h = harness({ params: { roam: 0 } });
    h.step(20);
    expect(h.drive()).toEqual([0, 0]);
    expect(h.mob.userData["impulseUntil"]).toBeGreaterThan(0);
  });

  it("stays put with roam 0 and never leaves home otherwise", () => {
    const h = harness({ params: { roam: 0 } });
    h.step(120);
    expect(Math.hypot(h.mob.position.x, h.mob.position.z)).toBeLessThan(0.01);
  });

  it("wanders inside its roam radius", () => {
    const h = harness({ params: { roam: 5, roamPause: 1, roamSpeed: 2 } });
    h.step(600);
    const d = Math.hypot(h.mob.position.x, h.mob.position.z);
    expect(d).toBeGreaterThan(0.5); // it moved
    expect(d).toBeLessThan(7); // and stayed home-ish
    expect(h.states()).toContain("roam");
  });
});

describe("mob-brain aggro", () => {
  it("chases a player who walks into range, and drives toward them", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16 }, playerAt: [0, 0, 10] });
    h.step(20);
    expect(h.states()).toContain("chase");
    const [vx, vz] = h.drive();
    expect(vz).toBeGreaterThan(0); // +z, toward the player
    expect(Math.abs(vx)).toBeLessThan(0.5);
  });

  it("scales its drive by driveScale (a slow, a root) and yields it while driveHeldUntil holds (a shove)", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16 }, playerAt: [0, 0, 10] });
    h.step(20);
    const full = h.drive()[1];
    expect(full).toBeGreaterThan(0);
    h.mob.userData["driveScale"] = 0.5;
    h.step(1);
    expect(h.drive()[1]).toBeCloseTo(full * 0.5, 3);
    h.mob.userData["driveScale"] = 0;
    h.step(1);
    expect(h.drive()).toEqual([0, 0]);
    // a game's knockback owns the channel until its deadline
    h.mob.userData["driveScale"] = 1;
    h.mob.userData["impulseVel"] = [0, -20];
    h.mob.userData["driveHeldUntil"] = 1e9;
    h.step(3);
    expect(h.drive()).toEqual([0, -20]);
    h.mob.userData["driveHeldUntil"] = 0;
    h.step(1);
    expect(h.drive()[1]).toBeGreaterThan(0);
  });

  it("ignores a player outside aggro range", () => {
    const h = harness({ params: { roam: 0, aggroRange: 5, leash: 100 }, playerAt: [0, 0, 30] });
    h.step(60);
    expect(h.states()).not.toContain("chase");
  });

  it("keeps a target it already has past aggro range — the hysteresis", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 10, deaggroRange: 25, leash: 100, speed: 0 },
      playerAt: [0, 0, 8],
    });
    h.step(20);
    expect(h.states()).toContain("chase");
    // Now step outside aggroRange but inside deaggroRange: still a fight.
    h.movePlayer(0, 0, 18);
    h.step(20);
    expect(h.states().filter((s) => s === "idle")).toHaveLength(0);
    // And past deaggro it gives up.
    h.movePlayer(0, 0, 40);
    h.step(20);
    expect(h.states().at(-1)).toBe("idle");
  });

  it("will not aggro through a wall", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16 },
      playerAt: [0, 0, 10],
      walls: [{ minX: -8, maxX: 8, minZ: 4, maxZ: 5 }],
    });
    h.step(40);
    expect(h.states()).not.toContain("chase");
  });

  it("sees the same player once the wall is not in the way", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, requireLineOfSight: false },
      playerAt: [0, 0, 10],
      walls: [{ minX: -8, maxX: 8, minZ: 4, maxZ: 5 }],
    });
    h.step(40);
    expect(h.states()).toContain("chase");
  });

  it("leaves a landing body alone", () => {
    // landing.ts makes this a contract: a body that just logged in or arrived
    // from another layer is settling, and brains must not touch it.
    const h = harness({ params: { roam: 0, aggroRange: 16 }, playerAt: [0, 0, 6] });
    h.netState.set(landingKey("player"), 60_000);
    h.step(40);
    expect(h.states()).not.toContain("chase");
  });

  it("leaves a dead body alone", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16 }, playerAt: [0, 0, 6] });
    h.netState.set(combatKey.dead("player"), true);
    h.step(40);
    expect(h.states()).not.toContain("chase");
  });

  it("leaves a downed body alone, and drops one that goes down mid-fight", () => {
    // core isDowned: a downed player is out of the fight — brains never finish it
    const h = harness({ params: { roam: 0, aggroRange: 16 }, playerAt: [0, 0, 6] });
    h.netState.set(combatKey.downed("player"), 60);
    h.step(40);
    expect(h.states()).not.toContain("chase");
    h.netState.set(combatKey.downed("player"), 0);
    h.step(40);
    expect(h.states()).toContain("chase");
    const before = h.states().length;
    h.netState.set(combatKey.downed("player"), 60);
    h.step(60);
    expect(h.states().slice(before)).not.toContain("chase");
    expect(h.states().at(-1)).not.toBe("chase");
  });

  it("will not take a fight that would break its leash", () => {
    // The target is well inside aggro range but outside the leash: taking it
    // would drag the pack into the transfer band.
    const h = harness({ params: { roam: 0, aggroRange: 40, leash: 8 }, playerAt: [0, 0, 20] });
    h.step(40);
    expect(h.states()).not.toContain("chase");
  });
});

describe("mob-brain in melee", () => {
  it("closes, stops at attack range, and asks the game to hit", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, attackRange: 2.4, attackInterval: 0.5, speed: 6 },
      playerAt: [0, 0, 10],
    });
    h.step(200);
    const gap = Math.hypot(h.player.position.x - h.mob.position.x, h.player.position.z - h.mob.position.z);
    expect(gap).toBeLessThanOrEqual(2.6); // arrived
    expect(gap).toBeGreaterThan(0.5); // and did not walk through them
    expect(h.states()).toContain("attack");
    expect(h.drive()).toEqual([0, 0]); // a melee mob holds still to swing

    const attacks = h.attacks();
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks[0]!.payload["targetId"]).toBe("player");
    expect(attacks[0]!.payload["mobId"]).toBe("mob");
    const aim = attacks[0]!.payload["aim"] as [number, number];
    expect(Math.hypot(aim[0], aim[1])).toBeCloseTo(1);
    expect(aim[1]).toBeGreaterThan(0.9); // pointing at the player
  });

  it("claims the facing so it does not swing at where the target used to be", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, attackRange: 2.4, speed: 6 },
      playerAt: [0, 0, 10],
    });
    h.step(200);
    expect(typeof h.mob.userData["faceYaw"]).toBe("number");
    expect(h.mob.userData["faceUntil"]).toBeGreaterThan(0);
  });

  it("passes one of its abilities through with the request", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, attackInterval: 0.4, speed: 6, abilities: "cleave,bite" },
      playerAt: [0, 0, 6],
    });
    h.step(200);
    const ids = new Set(h.attacks().map((a) => a.payload["abilityId"]));
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(["cleave", "bite"]).toContain(id);
  });

  it("holds its distance when it is a ranged mob", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 20, preferredRange: 8, attackRange: 12, speed: 5 },
      playerAt: [0, 0, 4],
    });
    h.step(300);
    const gap = Math.hypot(h.player.position.z - h.mob.position.z, h.player.position.x - h.mob.position.x);
    expect(gap).toBeGreaterThan(5); // backed off rather than hugging
    expect(h.attacks().length).toBeGreaterThan(0);
  });

  it("backs away at retreatSpeed, never at its chase speed, so a runner catches it", () => {
    const fastest = (params: Record<string, unknown>) => {
      const h = harness({ params: { roam: 0, aggroRange: 20, preferredRange: 9, attackRange: 14, speed: 5, ...params }, playerAt: [0, 0, 3] });
      let top = 0;
      for (let i = 0; i < 120; i++) {
        h.step(1);
        top = Math.max(top, Math.hypot(...h.drive()));
      }
      return top;
    };
    expect(fastest({})).toBeCloseTo(3, 1); // the old 0.6 x speed
    expect(fastest({ retreatSpeed: 1.2 })).toBeCloseTo(1.2, 1);
  });
});

describe("mob-brain leashing", () => {
  it("walks home when it finds itself past the leash, and heals on arrival", () => {
    // Home is 20 m north; the leash is 10, so it is out of bounds at boot —
    // the same state a mob is in after being dragged.
    const h = harness({
      params: { roam: 0, home: [0, 0, 20], leash: 10, roamSpeed: 6, returnHeal: true },
      mobAt: [0, 0, 0],
      playerAt: [0, 0, 500],
    });
    h.netState.set(combatKey.maxHp("mob"), 100);
    h.netState.set(combatKey.hp("mob"), 13);

    h.step(10);
    expect(h.states()).toContain("leash");
    expect(h.drive()[1]).toBeGreaterThan(0); // heading home, +z

    h.step(400);
    expect(h.mob.position.z).toBeGreaterThan(18);
    expect(h.netState.get(combatKey.hp("mob"))).toBe(100);
    expect(h.states().at(-1)).toBe("idle");
  });

  it("does not invent hp for a game that publishes none", () => {
    const h = harness({
      params: { roam: 0, home: [0, 0, 6], leash: 3, roamSpeed: 6 },
      mobAt: [0, 0, 0],
      playerAt: [0, 0, 500],
    });
    h.step(300);
    expect(h.netState.get(combatKey.hp("mob"))).toBeUndefined();
  });

  it("ignores a target while walking home", () => {
    // A mob that re-aggros on the way back never gets back.
    const h = harness({
      params: { roam: 0, home: [0, 0, 30], leash: 10, aggroRange: 30, roamSpeed: 4 },
      mobAt: [0, 0, 0],
      playerAt: [2, 0, 2],
    });
    h.step(60);
    expect(h.states()).toContain("leash");
    expect(h.states()).not.toContain("chase");
  });
});

describe("mob-brain and death", () => {
  it("stops dead and releases the drive", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16, speed: 6 }, playerAt: [0, 0, 8] });
    h.step(30);
    expect(h.states()).toContain("chase");
    h.netState.set(combatKey.dead("mob"), true);
    h.step(10);
    expect(h.states().at(-1)).toBe("dead");
    expect(h.drive()).toEqual([0, 0]);
  });

  it("picks itself up when the flag clears", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16, speed: 6 }, playerAt: [0, 0, 8] });
    h.netState.set(combatKey.dead("mob"), true);
    h.step(20);
    expect(h.states().at(-1)).toBe("dead");
    h.netState.set(combatKey.dead("mob"), false);
    h.step(30);
    expect(h.states()).toContain("chase");
  });
});

describe("mob-brain determinism", () => {
  it("plays the same fight twice", () => {
    // Every "random" choice is hashed off the entity id, so a replay, a test
    // and a re-simulated tick all agree.
    const run = () => {
      const h = harness({
        params: { roam: 4, roamPause: 1, aggroRange: 16, attackInterval: 0.5, speed: 5 },
        playerAt: [0, 0, 12],
      });
      h.step(400);
      return {
        states: h.states().join(","),
        attacks: h.attacks().length,
        at: [Math.round(h.mob.position.x * 1000), Math.round(h.mob.position.z * 1000)],
      };
    };
    expect(run()).toEqual(run());
  });
});

describe("mob-brain threat", () => {
  it("holds on whoever it hates most, not on whoever is closest", () => {
    // The whole point of a tank. Two players; the far one has been hitting it.
    const h = harness({
      params: { roam: 0, aggroRange: 20, deaggroRange: 30, leash: 100, speed: 4, threatHalfLife: 0 },
      playerAt: [0, 0, 4],
      extras: [{ id: "tank", at: [0, 0, -14], tags: ["player"] }],
    });
    h.step(20);
    expect(h.drive()[1]).toBeGreaterThan(0); // no threat yet: the near one

    h.threat({ sourceId: "tank", amount: 500 });
    h.step(20);
    expect(h.drive()[1]).toBeLessThan(0); // turned around, toward the tank
  });

  it("changes its mind when someone out-threatens the tank", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 20, deaggroRange: 30, leash: 100, speed: 4, threatHalfLife: 0 },
      playerAt: [0, 0, 4],
      extras: [{ id: "tank", at: [0, 0, -14], tags: ["player"] }],
    });
    h.threat({ sourceId: "tank", amount: 100 });
    h.step(20);
    expect(h.drive()[1]).toBeLessThan(0);
    h.threat({ sourceId: "player", amount: 400 });
    h.step(20);
    expect(h.drive()[1]).toBeGreaterThan(0);
  });

  it("answers a taunt even from someone who has done nothing all fight", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 20, deaggroRange: 30, leash: 100, speed: 4, threatHalfLife: 0 },
      playerAt: [0, 0, 4],
      extras: [{ id: "tank", at: [0, 0, -14], tags: ["player"] }],
    });
    h.threat({ sourceId: "player", amount: 900 });
    h.step(20);
    expect(h.drive()[1]).toBeGreaterThan(0);
    h.threat({ sourceId: "tank", kind: "taunt", seconds: 3 });
    h.step(20);
    expect(h.drive()[1]).toBeLessThan(0);
  });

  it("never lets a target's own body block the view of it", () => {
    // This stub's world is walls only, which is exactly why the bug it guards
    // shipped: in the real sim a character body is a dynamic rigidbody, and a
    // dynamic collider defaults to the PROP layer — one of the three sight is
    // traced against. The ray ends at the target's CENTRE, half a body past its
    // own collider, so leaving the target in the query reports "blocked" for
    // every candidate at every range and a mob roams straight past the player
    // it is standing next to.
    const h = harness({
      params: { roam: 0, aggroRange: 20, leash: 100, speed: 4, requireLineOfSight: true },
      playerAt: [0, 0, 6],
    });
    h.step(20);
    expect(h.states()).toContain("chase");
    const sight = h.queries().filter((q) => q.exclude.includes("mob") && q.exclude.includes("player"));
    expect(sight.length).toBeGreaterThan(0);
  });

  it("follows a threat target it cannot see — hate outlives line of sight", () => {
    // Acquisition needs sight; keeping a grudge does not, or every mob would
    // give up the moment you stepped behind a tree.
    const h = harness({
      params: { roam: 0, aggroRange: 20, deaggroRange: 30, leash: 100, speed: 4, requireLineOfSight: true },
      playerAt: [0, 0, 12],
      walls: [{ minX: -8, maxX: 8, minZ: 5, maxZ: 6 }],
    });
    h.step(20);
    expect(h.states()).not.toContain("chase"); // cannot see them
    h.threat({ sourceId: "player", amount: 50 });
    h.step(20);
    expect(h.states()).toContain("chase");
  });

  it("forgets everything when it leashes home", () => {
    const h = harness({
      params: { roam: 0, home: [0, 0, 30], leash: 8, aggroRange: 40, roamSpeed: 8, threatHalfLife: 0 },
      mobAt: [0, 0, 0],
      playerAt: [0, 0, 2],
    });
    h.threat({ sourceId: "player", amount: 9999 });
    h.step(400);
    // Home, calm, and not immediately re-charging the player it hated.
    expect(h.mob.position.z).toBeGreaterThan(28);
    expect(h.states().at(-1)).toBe("idle");
  });

  it("ignores threat aimed at a different mob", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 20, leash: 100, speed: 4, threatHalfLife: 0 },
      playerAt: [0, 0, 4],
      extras: [{ id: "tank", at: [0, 0, -14], tags: ["player"] }],
    });
    h.bus.emit("mob.threat", { mobId: "someone-else", sourceId: "tank", amount: 5000 });
    h.step(20);
    expect(h.drive()[1]).toBeGreaterThan(0); // still on the near one
  });
});

describe("mob-brain factions", () => {
  it("publishes its own faction so everything else can tell friend from foe", () => {
    const h = harness({ params: { roam: 0, faction: "goblin" } });
    h.step(5);
    expect(h.netState.get(combatKey.faction("mob"))).toBe("goblin");
  });

  it("fights a different faction that carries no tag of its own", () => {
    // Goblins vs dwarves, neither side tagged "player".
    const h = harness({
      params: { roam: 0, faction: "goblin", targetTags: "player", aggroRange: 20, leash: 100 },
      playerAt: [0, 0, 200],
      extras: [{ id: "dwarf", at: [0, 0, 8] }],
    });
    h.netState.set(combatKey.faction("dwarf"), "dwarf");
    h.step(40);
    expect(h.states()).toContain("chase");
    expect(h.drive()[1]).toBeGreaterThan(0);
  });

  it("never turns on its own faction, tag or no tag", () => {
    const h = harness({
      params: { roam: 0, faction: "goblin", targetTags: "player", aggroRange: 20, leash: 100 },
      playerAt: [0, 0, 6],
    });
    h.netState.set(combatKey.faction("player"), "goblin");
    h.step(40);
    expect(h.states()).not.toContain("chase");
  });

  it("honours hostileTo when a world has three sides", () => {
    const h = harness({
      params: { roam: 0, faction: "goblin", hostileTo: "dwarf", aggroRange: 20, leash: 100, targetTags: "" },
      playerAt: [0, 0, 200],
      extras: [{ id: "elf", at: [0, 0, 6] }],
    });
    h.netState.set(combatKey.faction("elf"), "elf");
    h.step(40);
    expect(h.states()).not.toContain("chase"); // not on the list
    h.netState.set(combatKey.faction("elf"), "dwarf");
    h.step(60);
    expect(h.states()).toContain("chase");
  });

  it("falls back to tags for anything that publishes no faction", () => {
    const h = harness({
      params: { roam: 0, faction: "goblin", targetTags: "player", aggroRange: 20, leash: 100 },
      playerAt: [0, 0, 6],
    });
    h.step(40);
    expect(h.states()).toContain("chase");
  });
});

describe("mob-brain packs", () => {
  it("shouts once when it pulls, from where the fight started", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, alertRadius: 12, speed: 4 },
      playerAt: [0, 0, 10],
    });
    h.step(120);
    const alerts = h.alerts();
    expect(alerts).toHaveLength(1); // once per target, not once per tick
    expect(alerts[0]!.payload["targetId"]).toBe("player");
    expect(alerts[0]!.payload["radius"]).toBe(12);
    const at = alerts[0]!.payload["at"] as [number, number, number];
    expect(at[2]).toBeLessThan(1); // where it stood when it pulled, not where it is now
  });

  it("drags its packmate into the fight", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, alertRadius: 20, faction: "boar", speed: 4 },
      playerAt: [0, 0, 10],
      extras: [
        {
          id: "boar2",
          at: [14, 0, 0],
          tags: ["npc"],
          // Deaf on its own — only the shout can pull it.
          script: {
            name: "mob-brain",
            params: { roam: 0, aggroRange: 1, alertRadius: 20, faction: "boar", speed: 4, leash: 100 },
          },
        },
      ],
    });
    h.step(60);
    const [vx, vz] = h.driveOf("boar2");
    expect(Math.hypot(vx, vz)).toBeGreaterThan(0.5); // it moved
    expect(vz).toBeGreaterThan(0); // toward the player, who is north of it
  });

  it("does not answer another faction's shout", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, alertRadius: 20, faction: "boar", speed: 4 },
      playerAt: [0, 0, 10],
      extras: [
        {
          id: "wolf",
          at: [14, 0, 0],
          tags: ["npc"],
          script: {
            name: "mob-brain",
            params: { roam: 0, aggroRange: 1, alertRadius: 20, faction: "wolf", speed: 4, leash: 100 },
          },
        },
      ],
    });
    h.step(60);
    expect(h.driveOf("wolf")).toEqual([0, 0]);
  });

  it("does not answer a shout from out of earshot", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, alertRadius: 5, faction: "boar", speed: 4 },
      playerAt: [0, 0, 10],
      extras: [
        {
          id: "boar2",
          at: [60, 0, 0],
          tags: ["npc"],
          script: {
            name: "mob-brain",
            params: { roam: 0, aggroRange: 1, alertRadius: 5, faction: "boar", speed: 4, leash: 100 },
          },
        },
      ],
    });
    h.step(60);
    expect(h.driveOf("boar2")).toEqual([0, 0]);
  });
});

describe("mob-brain debug", () => {
  it("reports why it is doing what it is doing", () => {
    // "It is chasing the wizard" is the symptom; the threat table is the cause,
    // and nothing else in the system can tell you that on a live layer.
    const h = harness({
      params: { roam: 0, aggroRange: 20, leash: 40, faction: "boar", threatHalfLife: 0 },
      playerAt: [0, 0, 6],
      extras: [{ id: "tank", at: [0, 0, -10], tags: ["player"] }],
    });
    h.threat({ sourceId: "tank", amount: 250 });
    h.step(20);
    const ai = h.runtime.debugOf("mob") as {
      script: string;
      state: string;
      target: string;
      faction: string;
      threat: Array<{ id: string; threat: number }>;
    };
    expect(ai.script).toBe("mob-brain");
    expect(ai.state).toBe("chase");
    expect(ai.target).toBe("tank");
    expect(ai.faction).toBe("boar");
    expect(ai.threat[0]).toEqual({ id: "tank", threat: 250 });
  });

  it("names the taunt in force", () => {
    const h = harness({ params: { roam: 0, aggroRange: 20, leash: 40 }, playerAt: [0, 0, 6] });
    h.threat({ sourceId: "player", kind: "taunt", seconds: 5 });
    h.step(10);
    expect((h.runtime.debugOf("mob") as { taunted: string }).taunted).toBe("player");
  });

  it("says nothing for an entity with no script, and never throws", () => {
    const h = harness({ params: { roam: 0 } });
    h.step(5);
    expect(h.runtime.debugOf("player")).toBeUndefined();
    expect(Object.keys(h.runtime.debugTree(["mob", "player"]))).toEqual(["mob"]);
  });
});

// ---------------------------------------------------------------------------
// movesets, turn rate, sight cone — the 2026-10 combat model
// ---------------------------------------------------------------------------

/**
 * A party around a mob at the origin facing +Z: the tank in front holding
 * threat, a mage far in front, a rogue just behind. The mob does not walk
 * (speed 0), so every distance below stays where it was put.
 */
function party(params: Record<string, unknown>) {
  const h = harness({
    params: { roam: 0, aggroRange: 20, deaggroRange: 30, leash: 100, speed: 0, threatHalfLife: 0, attackInterval: 0.3, ...params },
    playerAt: [0, 0, 2],
    extras: [
      { id: "mage", at: [0, 0, 9], tags: ["player"] },
      { id: "rogue", at: [0.3, 0, -1.8], tags: ["player"] },
    ],
  });
  h.threat({ sourceId: "player", amount: 500 });
  const extra: Array<{ name: string; payload: Record<string, unknown> }> = [];
  for (const name of ["mob.engaged", "mob.guard"]) h.bus.on(name, (p) => extra.push({ name, payload: p as Record<string, unknown> }));
  return { ...h, extra };
}

const move = (m: Record<string, unknown>) => ({ cooldown: 30, windup: 0.5, ...m });

/** Step until the first `mob.attack`, then return. */
function untilAttack(h: { attacks: () => unknown[]; step: (n?: number) => void }): void {
  for (let i = 0; i < 300 && h.attacks().length === 0; i++) h.step(1);
}

describe("mob-brain movesets", () => {
  it("goes for the threat target with a `threat` move", () => {
    const h = party({ moves: [move({ ability: "slam", range: [0, 3], target: "threat" })] });
    h.step(120);
    const a = h.attacks()[0]!.payload;
    expect(a["abilityId"]).toBe("slam");
    expect(a["targetId"]).toBe("player");
    expect(a["rule"]).toBe("threat");
    expect(a["windup"]).toBe(0.5);
  });

  it("goes for the furthest player in its band, not the tank", () => {
    const h = party({ moves: [move({ ability: "leap", range: [4, 14], target: "furthest" })] });
    h.step(120);
    expect(h.attacks()[0]!.payload["targetId"]).toBe("mage");
    const at = h.attacks()[0]!.payload["at"] as number[];
    expect(at[2]).toBeCloseTo(9);
  });

  it("goes for the nearest player, whoever holds threat", () => {
    const h = party({ moves: [move({ ability: "bite", range: [0, 3], target: "nearest" })] });
    h.step(120);
    expect(h.attacks()[0]!.payload["targetId"]).toBe("rogue");
  });

  it("lashes at whoever stands behind it", () => {
    const h = party({ moves: [move({ ability: "lash", range: [0, 3], target: "behind" })] });
    h.step(120);
    const a = h.attacks()[0]!.payload;
    expect(a["targetId"]).toBe("rogue");
    expect((a["aim"] as number[])[1]).toBeLessThan(0); // aimed backwards
  });

  it("does not fire a move whose rule finds nobody in its band", () => {
    const h = party({ moves: [move({ ability: "leap", range: [20, 30], target: "furthest" })] });
    h.step(180);
    expect(h.attacks()).toHaveLength(0);
  });

  it("respects each move's cooldown and draws among the ready ones", () => {
    const h = party({
      attackInterval: 0.1,
      attackJitter: 0,
      moves: [
        move({ ability: "a", range: [0, 3], cooldown: 100, windup: 0.4 }),
        move({ ability: "b", range: [0, 3], cooldown: 100, windup: 0.4 }),
      ],
    });
    h.step(600);
    const ids = h.attacks().map((a) => a.payload["abilityId"] as string);
    expect(ids.sort()).toEqual(["a", "b"]); // each once, then both on cooldown
  });

  it("stands committed for the wind-up even when its target walks off", () => {
    const h = party({ speed: 6, moves: [move({ ability: "slam", range: [0, 3], target: "threat", windup: 1, cooldown: 0 })] });
    untilAttack(h);
    expect(h.attacks()).toHaveLength(1);
    h.movePlayer(0, 0, 12); // out of reach: a free mob would chase at once
    for (let i = 0; i < 50; i++) {
      h.step(1);
      expect(h.drive()).toEqual([0, 0]);
    }
    expect(h.attacks()).toHaveLength(1); // and nothing new started mid-wind-up
    h.step(30);
    expect(h.drive()[1]).toBeGreaterThan(0); // released: after them
  });

  it("drops the wind-up and stands still when interrupted", () => {
    const h = party({ speed: 6, moves: [move({ ability: "slam", range: [0, 3], windup: 0.6, cooldown: 0 })] });
    untilAttack(h);
    h.bus.emit("mob.interrupt", { mobId: "mob", seconds: 1.5 });
    h.movePlayer(0, 0, 12);
    h.step(80); // past where the wind-up would have ended
    expect(h.drive()).toEqual([0, 0]);
    expect(h.attacks()).toHaveLength(1);
    h.step(30);
    expect(h.drive()[1]).toBeGreaterThan(0);
  });

  it("springs at the spot of a lunge and lands as the wind-up ends", () => {
    const h = party({ moves: [move({ ability: "leap", range: [4, 14], target: "furthest", windup: 1.2, lunge: true })] });
    untilAttack(h);
    h.step(20);
    expect(h.mob.position.z).toBeLessThan(0.5); // crouched, not yet gone
    h.step(55);
    expect(h.mob.position.z).toBeGreaterThan(6.5); // landed beside the mage
    expect(h.mob.position.z).toBeLessThan(9);
  });

  it("keeps today's single swing when it has no moves", () => {
    const h = party({ abilities: "strike" });
    h.step(120);
    const a = h.attacks()[0]!.payload;
    expect(a["abilityId"]).toBe("strike");
    expect(a["targetId"]).toBe("player");
  });

  it("drops an invalid moveset and falls back to its abilities", () => {
    const h = party({ abilities: "strike", moves: [{ range: [0, 3] }] });
    h.step(120);
    expect(h.attacks()[0]!.payload["abilityId"]).toBe("strike");
  });

  it("names the same target rules as the mob.attack schema", () => {
    const attack = mobEventDecls.find((d) => d.name === "mob.attack")!.schema as z.ZodObject;
    const rule = attack.shape["rule"] as z.ZodDefault<z.ZodEnum>;
    expect([...rule.def.innerType.options]).toEqual([...MOVE_TARGET_RULES]);
  });
});

describe("mob-brain turning", () => {
  const yawOf = (h: { mob: THREE.Object3D }) => h.mob.userData["faceYaw"] as number;
  const DEG = Math.PI / 180;

  it("turns slowly while winding up", () => {
    const h = party({ windupTurnRate: 90, moves: [move({ ability: "lash", range: [0, 3], target: "behind", windup: 1 })] });
    untilAttack(h);
    const start = yawOf(h);
    h.step(30); // half a second
    const turned = Math.abs(yawOf(h) - start);
    expect(turned).toBeGreaterThan(30 * DEG);
    expect(turned).toBeLessThanOrEqual(45.5 * DEG);
  });

  it("lets a move turn faster than the wind-up default", () => {
    const h = party({ windupTurnRate: 30, moves: [move({ ability: "lash", range: [0, 3], target: "behind", windup: 1, turnRate: 360 })] });
    untilAttack(h);
    const start = yawOf(h);
    h.step(30);
    expect(Math.abs(yawOf(h) - start)).toBeGreaterThan(150 * DEG);
  });

  it("turns at a finite rate outside a wind-up too", () => {
    const h = harness({ params: { roam: 0, aggroRange: 20, speed: 0, turnRate: 180 }, playerAt: [0, 0, -3] });
    h.step(12); // the first think claims the facing
    const a = yawOf(h);
    h.step(1);
    expect(Math.abs(yawOf(h) - a)).toBeLessThanOrEqual(3.01 * DEG); // 180°/s at 60 Hz
    h.step(80);
    expect(Math.abs(Math.abs(yawOf(h)) - Math.PI)).toBeLessThan(0.01); // got there
  });
});

describe("mob-brain sight cone", () => {
  it("does not notice a player walking up behind it", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16, sightAngle: 60, hearRadius: 3 }, playerAt: [0, 0, -8] });
    h.step(40);
    expect(h.states()).not.toContain("chase");
  });

  it("hears one who gets close, whatever way it faces", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16, sightAngle: 60, hearRadius: 3, speed: 0, attackRange: 3 }, playerAt: [0, 0, -2.5] });
    h.step(40);
    expect(h.states()).toContain("attack");
  });

  it("sees one in front", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16, sightAngle: 60, hearRadius: 3 }, playerAt: [1, 0, 8] });
    h.step(40);
    expect(h.states()).toContain("chase");
  });

  it("keeps a grudge all round, cone or no cone", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16, sightAngle: 30, hearRadius: 1 }, playerAt: [0, 0, -8] });
    h.threat({ sourceId: "player", amount: 10 });
    h.step(40);
    expect(h.states()).toContain("chase");
  });
});

describe("mob-brain stealth (notice/<bodyId>)", () => {
  it("does not hear a sneaking body at a range it hears a walking one", () => {
    const params = { roam: 0, aggroRange: 16, sightAngle: 60, hearRadius: 4, speed: 0, attackRange: 3 };
    const walking = harness({ params, playerAt: [0, 0, -3] });
    walking.step(40);
    expect(walking.states()).toContain("attack");
    const sneaking = harness({ params, playerAt: [0, 0, -3] });
    sneaking.netState.set(noticeKey("player"), 0.3); // hears it inside 1.2 m now
    sneaking.step(40);
    expect(sneaking.states()).not.toContain("attack");
    sneaking.netState.set(noticeKey("player"), 1); // the stealth broke
    sneaking.step(40);
    expect(sneaking.states()).toContain("attack");
  });

  it("shortens its sight too, but keeps a target it already has", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16, sightAngle: 60, hearRadius: 1 }, playerAt: [0, 0, 8] });
    h.netState.set(noticeKey("player"), 0.3); // seen inside 4.8 m only
    h.step(40);
    expect(h.states()).not.toContain("chase");
    h.netState.set(noticeKey("player"), 1);
    h.step(40);
    expect(h.states()).toContain("chase");
    h.netState.set(noticeKey("player"), 0.3); // sneaking mid-fight ends nothing
    h.step(40);
    expect(h.runtime.debugOf("mob")).toMatchObject({ target: "player" });
  });

  it("lets go of a forgotten source, which must then be noticed afresh", () => {
    const h = harness({ params: { roam: 0, aggroRange: 16, sightAngle: 60, hearRadius: 1, speed: 0 }, playerAt: [0, 0, -8] });
    h.threat({ sourceId: "player", amount: 10 });
    h.step(20);
    expect(h.runtime.debugOf("mob")).toMatchObject({ target: "player" });
    // a hide: dropped from the table AND sneaking (it has turned to face the player by now)
    h.threat({ sourceId: "player", kind: "forget" });
    h.netState.set(noticeKey("player"), 0.3);
    h.step(20);
    expect(h.runtime.debugOf("mob")).toMatchObject({ target: "", threat: [] });
    // forgotten but plainly visible in front of it: noticed again, as a stranger would be
    h.netState.set(noticeKey("player"), 1);
    h.step(20);
    expect(h.runtime.debugOf("mob")).toMatchObject({ target: "player" });
  });
});

describe("mob-brain signals", () => {
  it("says when it becomes aware and when it forgets", () => {
    const h = party({ abilities: "strike" });
    h.step(20);
    const said = h.extra.filter((e) => e.name === "mob.engaged").map((e) => e.payload["engaged"]);
    expect(said).toEqual([true]); // threat was seeded before the first think
    h.netState.set(combatKey.dead("mob"), true);
    h.step(5);
    expect(h.extra.filter((e) => e.name === "mob.engaged").at(-1)!.payload["engaged"]).toBe(false);
  });

  it("starts unaware and says so once", () => {
    const h = harness({ params: { roam: 0, aggroRange: 5 }, playerAt: [0, 0, 50] });
    const said: unknown[] = [];
    h.bus.on("mob.engaged", (p) => said.push((p as { engaged: boolean }).engaged));
    h.step(60);
    expect(said).toEqual([false]);
  });

  it("raises a guard between moves and drops it to swing", () => {
    const h = party({ guardBetween: true, attackInterval: 1, moves: [move({ ability: "slam", range: [0, 3], windup: 0.8, cooldown: 0 })] });
    h.step(300);
    const guards = h.extra.filter((e) => e.name === "mob.guard").map((e) => e.payload["on"]);
    expect(guards[0]).toBe(true);
    expect(guards).toContain(false);
    expect(guards.lastIndexOf(true)).toBeGreaterThan(guards.indexOf(false)); // and up again after
    expect(h.attacks().length).toBeGreaterThan(0);
  });
});

describe("mob-brain temperament", () => {
  it("aggroRange 0 on a hostile mob already fights back when hit (and shouts for its pack) — the baseline", () => {
    const h = harness({ params: { roam: 0, aggroRange: 0, speed: 4, leash: 100 }, playerAt: [0, 0, 3] });
    h.step(60);
    expect(h.states()).not.toContain("chase"); // standing next to it is not enough
    h.threat({ sourceId: "player", amount: 50 });
    h.step(30);
    expect(h.states().some((s) => s === "chase" || s === "attack")).toBe(true);
    expect(h.alerts()).toHaveLength(1); // ...and it shouts: alertRadius defaults to 10 for a hostile mob
  });

  it("passive: never starts a fight, fights back when hit, never shouts, then goes back to wandering", () => {
    const h = harness({
      params: { roam: 4, roamPause: 1, temperament: "passive", speed: 4, leash: 100, threatHalfLife: 1, deaggroRange: 20 },
      playerAt: [0, 0, 2],
    });
    h.step(120);
    expect(h.states()).not.toContain("chase");
    expect(h.states()).not.toContain("attack");
    h.threat({ sourceId: "player", amount: 10 });
    h.step(30);
    expect(h.states().some((s) => s === "chase" || s === "attack")).toBe(true);
    expect(h.alerts()).toHaveLength(0);
    // the attacker walks off past deaggroRange and the grudge decays: back to roaming, and it stays calm
    const mark = h.states().length;
    h.movePlayer(0, 0, 60);
    h.step(600);
    const tail = h.states().slice(mark);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail).not.toContain("attack");
    expect(h.states().at(-1) === "roam" || h.states().at(-1) === "idle").toBe(true);
    h.movePlayer(1, 0, 2); // walking back up to it does not restart the fight
    const before = h.states().length;
    h.step(120);
    expect(h.states().slice(before)).not.toContain("chase");
  });

  it("passive: neither shouts nor answers a packmate's shout unless alertRadius is set", () => {
    const h = harness({
      params: { roam: 0, aggroRange: 16, alertRadius: 20, faction: "deer", speed: 4 },
      playerAt: [0, 0, 10],
      extras: [
        { id: "doe", at: [10, 0, 0], tags: ["npc"], script: { name: "mob-brain", params: { roam: 0, temperament: "passive", faction: "deer", speed: 4, leash: 100 } } },
        { id: "stag", at: [-10, 0, 0], tags: ["npc"], script: { name: "mob-brain", params: { roam: 0, temperament: "passive", alertRadius: 20, faction: "deer", speed: 4, leash: 100 } } },
      ],
    });
    h.step(60);
    expect(h.alerts().filter((a) => a.payload["mobId"] === "mob")).toHaveLength(1); // the hostile one pulled
    expect(h.alerts().filter((a) => a.payload["mobId"] === "doe")).toHaveLength(0);
    const [dx, dz] = h.driveOf("doe");
    expect(Math.hypot(dx, dz)).toBeLessThan(0.01); // passive, default: deaf to it
    const [sx, sz] = h.driveOf("stag");
    expect(Math.hypot(sx, sz)).toBeGreaterThan(0.5); // passive with alertRadius set: joins in
  });

  it("territorial: lets a player pass outside its territory, attacks one who steps inside", () => {
    const h = harness({ params: { roam: 0, temperament: "territorial", territory: 7, aggroRange: 16, speed: 4, leash: 100 }, playerAt: [0, 0, 12] });
    h.step(60);
    expect(h.states()).not.toContain("chase");
    h.movePlayer(0, 0, 5);
    h.step(20);
    expect(h.states().some((s) => s === "chase" || s === "attack")).toBe(true);
  });

  it("territorial: fights back when hit from outside its territory", () => {
    const h = harness({ params: { roam: 0, temperament: "territorial", territory: 7, speed: 4, leash: 100 }, playerAt: [0, 0, 14] });
    h.step(30);
    h.threat({ sourceId: "player", amount: 10 });
    h.step(20);
    expect(h.states()).toContain("chase");
  });

  it("an unknown temperament reads as hostile", () => {
    const h = harness({ params: { roam: 0, temperament: "grumpy", aggroRange: 16 }, playerAt: [0, 0, 10] });
    h.step(20);
    expect(h.states()).toContain("chase");
  });
});

describe("mob-brain patrolDir", () => {
  const route = [[0, 0, 0], [20, 0, 0], [40, 0, 0]];
  it("sets off forward along the segment it stands on", () => {
    const h = harness({ params: { patrol: route, patrolDir: 1, roamSpeed: 2 }, mobAt: [25, 0, 0], playerAt: [0, 0, 500] });
    h.step(30);
    expect(h.drive()[0]).toBeGreaterThan(0.5);
  });
  it("sets off backward with -1", () => {
    const h = harness({ params: { patrol: route, patrolDir: -1, roamSpeed: 2 }, mobAt: [35, 0, 0], playerAt: [0, 0, 500] });
    h.step(30);
    expect(h.drive()[0]).toBeLessThan(-0.5);
  });
  it("0 keeps the old rule: start at the nearest route point", () => {
    const h = harness({ params: { patrol: route, roamSpeed: 2 }, mobAt: [25, 0, 0], playerAt: [0, 0, 500] });
    h.step(30);
    expect(h.drive()[0]).toBeLessThan(-0.5); // nearest point is 20: it walks back to it first
  });
});
