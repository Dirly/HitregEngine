import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  createScene,
  EventRegistry,
  NetStateStore,
  registerCharacterNetState,
  registerCoreAssetTypes,
  registerCoreComponents,
  registerCoreEvents,
  registerTransferLockNetState,
  type NpcMemory,
  type Op,
  type PortalTravel,
} from "@hitreg/core";
import { EventBus, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);
const noInput: InputLike = { isDown: () => false };

function harness() {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);
  const entity = (id: string, components: Record<string, unknown>, tags: string[] = []): Op => ({
    op: "add-entity",
    id,
    entity: { name: id, parent: null, tags, components: { transform: {}, ...components } },
  });
  const ops: Op[] = [
    entity("player", {}, ["player"]),
    entity("door", { script: { name: "portal", params: { scene: "barrow", anchor: "entry", radius: 3, name: "the Barrow" } } }, ["interactable"]),
    entity("sealed", { script: { name: "portal", params: { scene: "vault", condition: { flag: "has-key" }, refusal: "Locked." } } }, ["interactable"]),
    entity("typo", { script: { name: "portal", params: { scene: "vault", condition: { hasKey: true } } } }, ["interactable"]),
    entity("way-out", { script: { name: "portal", params: { back: true, scene: "surface", anchor: "gate", party: false } } }, ["interactable"]),
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const at = (x: number, z: number) => {
    const o = new THREE.Object3D();
    o.position.set(x, 0, z);
    return o;
  };
  const player = at(0, 2);
  const objects = new Map<string, THREE.Object3D>([
    ["player", player],
    ["door", at(0, 0)],
    ["sealed", at(1, 0)],
    ["typo", at(-1, 0)],
    ["way-out", at(0, 1)],
  ]);
  const netState = new NetStateStore();
  registerCharacterNetState(netState);
  registerTransferLockNetState(netState);
  netState.set("owner/player", "peer-a");
  const bus = new EventBus(events);
  const runtime = new ScriptRuntime({ doc, objects, sim: null, registry, input: noInput, events: bus, netState, assets, localPlayer: () => "player" });
  runtime.start();
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60);
  };
  tick(2);
  const travels: PortalTravel[] = [];
  const refused: string[] = [];
  bus.on("portal.travel", (p) => travels.push(p as PortalTravel));
  bus.on("character.refused", (p) => refused.push((p as { error: string }).error));
  const use = (entityId: string, from = "peer-a") => {
    bus.injectFromPeer(from, [{ name: "player.interact", payload: { actorId: "player", entityId } }]);
    tick(4);
  };
  return { netState, player, bus, tick, use, travels, refused, runtime };
}

describe("portal builtin (authority)", () => {
  it("clears the owner in range and hands the trip to the host with the way back", () => {
    const h = harness();
    h.use("door", "peer-b"); // not the owner
    expect(h.travels).toHaveLength(0);
    h.player.position.set(0, 0, 9); // out of range
    h.use("door");
    expect(h.travels).toHaveLength(0);
    h.player.position.set(0, 0, 2);
    h.use("door");
    expect(h.travels).toHaveLength(1);
    const t = h.travels[0]!;
    expect(t).toMatchObject({ actorId: "player", portalId: "door", scene: "barrow", anchor: "entry", back: false, party: true });
    // the way back: where the traveller stood, turned away from the door (+Z here)
    expect(t.returnTo?.position).toEqual([0, 0, 2]);
    expect(t.returnTo?.yaw).toBeCloseTo(0);
    // a double click is one trip
    h.use("door");
    expect(h.travels).toHaveLength(1);
  });

  it("refuses with the portal's line when the condition does not hold, and a typo refuses everyone", () => {
    const h = harness();
    h.player.position.set(1, 0, 1);
    h.use("sealed");
    expect(h.travels).toHaveLength(0);
    expect(h.refused).toContain("Locked.");
    const memory: NpcMemory = { met: {}, flags: { "has-key": true } };
    h.netState.set("npc/player", memory);
    h.use("sealed");
    expect(h.travels.map((t) => t.portalId)).toEqual(["sealed"]);
    h.player.position.set(-1, 0, 1);
    h.use("typo");
    expect(h.travels.map((t) => t.portalId)).toEqual(["sealed"]);
  });

  it("will not let a fighter leave", () => {
    const h = harness();
    h.netState.set("transferLock/player", 1e9);
    h.use("door");
    expect(h.travels).toHaveLength(0);
    expect(h.refused[0]).toMatch(/fight/);
  });

  it("a return portal goes back to the recorded scene; with none recorded, to its own target", () => {
    const h = harness();
    h.player.position.set(0, 0, 1.5);
    h.use("way-out");
    expect(h.travels[0]).toMatchObject({ portalId: "way-out", back: true, scene: "surface", anchor: "gate", party: false });
    expect(h.travels[0]!.returnTo).toBeUndefined();
    const h2 = harness();
    h2.netState.set("portal/player", { return: { scene: "proving", position: [3144, 20, -333], yaw: 0, srv: "layer-2" } });
    h2.player.position.set(0, 0, 1.5);
    h2.use("way-out");
    expect(h2.travels[0]).toMatchObject({ back: true, scene: "proving" });
    expect(h2.travels[0]!.anchor).toBeUndefined();
  });
});

/** A walk-through portal: a 2.4 x 2.6 x 1.5 m box at the origin of entity "mouth" (z -0.75..0.75). */
function triggerHarness(extra: Record<string, unknown> = {}) {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);
  const entity = (id: string, components: Record<string, unknown>, tags: string[] = []): Op => ({
    op: "add-entity",
    id,
    entity: { name: id, parent: null, tags, components: { transform: {}, ...components } },
  });
  const doc = applyOps(
    createScene("t"),
    [
      entity("player", {}, ["player"]),
      entity("mouth", { script: { name: "portal", params: { mode: "trigger", scene: "barrow", anchor: "entry", arrivalGrace: 1, ...extra } } }),
      entity("door", { script: { name: "portal", params: { scene: "barrow", anchor: "entry" } } }, ["interactable"]),
    ],
    coreRegistry,
  ).doc;
  const player = new THREE.Object3D();
  player.position.set(0, 1.2, 6);
  const door = new THREE.Object3D();
  door.position.set(20, 0, 0);
  const objects = new Map<string, THREE.Object3D>([
    ["player", player],
    ["mouth", new THREE.Object3D()],
    ["door", door],
  ]);
  const netState = new NetStateStore();
  registerCharacterNetState(netState);
  registerTransferLockNetState(netState);
  netState.set("owner/player", "peer-a");
  const bus = new EventBus(events);
  const runtime = new ScriptRuntime({ doc, objects, sim: null, registry, input: noInput, events: bus, netState, assets, localPlayer: () => "player" });
  runtime.start();
  const travels: PortalTravel[] = [];
  const refused: string[] = [];
  bus.on("portal.travel", (p) => travels.push(p as PortalTravel));
  bus.on("character.refused", (p) => refused.push((p as { error: string }).error));
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60);
  };
  /** walk along z from the body's z to `z` at 4 m/s, one tick per step */
  const walkZ = (z: number) => {
    const step = 4 / 60;
    while (Math.abs(player.position.z - z) > step) {
      player.position.z += Math.sign(z - player.position.z) * step;
      tick();
    }
    player.position.z = z;
    tick();
  };
  return { netState, player, bus, tick, walkZ, travels, refused };
}

describe("portal builtin: walk-through (trigger mode)", () => {
  it("sends a body that walks INTO the box, once, with the way back just outside it facing away", () => {
    const h = triggerHarness();
    h.tick(90); // past the arrival grace, standing outside
    h.walkZ(1.5);
    expect(h.travels).toHaveLength(0); // outside still (the box ends at z 0.75)
    h.walkZ(0);
    expect(h.travels).toHaveLength(1);
    const t = h.travels[0]!;
    expect(t).toMatchObject({ actorId: "player", portalId: "mouth", scene: "barrow", anchor: "entry", back: false });
    // the way back: outside the box, on the side it came from, turned away from the portal
    expect(t.returnTo!.position[2]).toBeGreaterThan(1.6);
    expect(t.returnTo!.yaw).toBeCloseTo(0);
    // standing in it, walking about inside it: no second trip
    h.tick(240);
    h.walkZ(-0.5);
    expect(h.travels).toHaveLength(1);
  });

  it("an arrival inside the box, or beside it within the grace, does not fire (no ping-pong)", () => {
    const h = triggerHarness();
    h.player.position.set(0, 1.2, 0); // landed inside the volume
    h.tick(240);
    expect(h.travels).toHaveLength(0);
    h.walkZ(5); // leaves it ...
    h.walkZ(0); // ... and walks back in: now it is a walk-in
    expect(h.travels).toHaveLength(1);

    const g = triggerHarness();
    g.player.position.set(0, 1.2, 1.0); // landed just outside the box
    g.tick(5);
    g.walkZ(0); // straight back in inside the 1 s grace
    expect(g.travels).toHaveLength(0);
  });

  it("an arrival a few metres off that turns straight round and walks in is sent, grace or not", () => {
    // the dungeon exit case: the entry anchor stands 3 m in front of the return portal; a player who arrives and
    // leaves at once used to walk through the whole box unarmed (the grace) and on into the dark behind it
    const h = triggerHarness({ arrivalGrace: 30 });
    h.player.position.set(0, 1.2, 3.25);
    h.tick(2);
    h.walkZ(0);
    expect(h.travels).toHaveLength(1);
  });

  it("a refusal is said once per entry and nobody moves", () => {
    const h = triggerHarness({ condition: { flag: "has-key" }, refusal: "Locked." });
    h.tick(90);
    h.walkZ(0);
    h.tick(120); // loitering inside
    expect(h.travels).toHaveLength(0);
    expect(h.refused).toEqual(["Locked."]);
    h.walkZ(4);
    h.walkZ(0);
    expect(h.refused).toEqual(["Locked.", "Locked."]);
  });

  it("modes: a trigger portal ignores [E]; an interact portal ignores walking", () => {
    const h = triggerHarness();
    h.tick(90);
    h.player.position.set(0, 1.2, 1.2);
    h.bus.injectFromPeer("peer-a", [{ name: "player.interact", payload: { actorId: "player", entityId: "mouth" } }]);
    h.tick(4);
    expect(h.travels).toHaveLength(0);
    h.player.position.set(20, 1.2, 4);
    h.tick(2);
    h.walkZ(0); // straight through the interact door's spot
    expect(h.travels).toHaveLength(0);
    h.bus.injectFromPeer("peer-a", [{ name: "player.interact", payload: { actorId: "player", entityId: "door" } }]);
    h.tick(4);
    expect(h.travels.map((t) => t.portalId)).toEqual(["door"]);
  });
});
