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
