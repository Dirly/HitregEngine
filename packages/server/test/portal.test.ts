import { describe, expect, it } from "vitest";
import { AssetLibrary, createScene, createSheet, registerCoreAssetTypes, type EntityDoc, type SceneDoc } from "@hitreg/core";
import { arrivalFor, PortalHarness, type LoadedContent } from "../src/index.js";

/**
 * A portal round trip inside one process: two scenes, the `portal` builtin on
 * each side, the character carried through a real PlayerStore commit/load —
 * the payload a cluster transfer carries.
 */

const ent = (name: string, components: Record<string, unknown>, tags: string[] = [], parent: string | null = null): EntityDoc => ({ name, parent, tags, components });
const floor = (x: number) =>
  ent("floor", { transform: { position: [x, -0.5, 0] }, rigidbody: { kind: "static" }, collider: { shape: "box", size: [40, 1, 40] } });
const player = (at: [number, number, number]) =>
  ent("player", { transform: { position: at }, rigidbody: { kind: "dynamic", lockRotations: true }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] } }, ["player"]);

function scenes(): Map<string, SceneDoc> {
  const surface = createScene("surface");
  surface.entities["floor"] = floor(0);
  surface.entities["player"] = player([0, 1.2, 8]);
  surface.entities["gate"] = ent("gate", { transform: { position: [0, 0, 0] }, script: { name: "portal", params: { scene: "dungeon", anchor: "entry", name: "the Barrow" } } }, ["interactable"]);
  const dungeon = createScene("dungeon");
  dungeon.entities["floor"] = floor(100);
  dungeon.entities["player"] = player([100, 1.2, 10]);
  // the arrival anchor sits under a rotated room: its world pose is composed up the parent chain
  dungeon.entities["room"] = ent("room", { transform: { position: [100, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } });
  dungeon.entities["entry"] = ent("entry", { transform: { position: [0, 0, -5] } }, ["anchor", "instance-entry"], "room");
  dungeon.entities["exit"] = ent("exit", { transform: { position: [95, 0, 4] }, script: { name: "portal", params: { back: true, scene: "surface", party: false, prompt: "Leave" } } }, ["interactable"]);
  return new Map([
    ["surface", surface],
    ["dungeon", dungeon],
  ]);
}

function content(): LoadedContent {
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  return { assets, scenes: scenes(), sceneFiles: new Map(), worlds: [], worldFiles: new Map(), scriptDirs: [], warnings: [] };
}

describe("portal harness: scene A → instance B → back, state carried", { timeout: 60_000 }, () => {
  it("lands on the anchor with the journal and bags, and the return portal brings the player back to where they entered", async () => {
    const sheet = { ...createSheet(), coins: 777 };
    const journal = { version: 1, tracked: "deep", quests: { deep: { status: "active", progress: { a: 1 } } } };
    const memory = { met: { warden: 2 }, flags: { "heard-of-barrow": true } };
    const h = await PortalHarness.start({ content: content(), scene: "surface", at: [0, 1.2, 2.5], sheet, records: { quests: journal, npc: memory }, projectScripts: false });
    h.step(30);
    expect(h.scene).toBe("surface");

    // out of range: nothing moves
    h.teleport([0, 1.2, 12]);
    expect(await h.interact("gate")).toBeNull();
    h.teleport([0, 1.2, 2.5]);
    h.step(20);
    const inn = await h.interact("gate");
    expect(inn).toMatchObject({ from: "surface", to: "dungeon", portalId: "gate", back: false, anchor: "entry" });
    expect(h.scene).toBe("dungeon");
    // room at x 100 turned +90°: local (0,0,-5) → world (95, 0, 0), heading +90°; lifted 1.2 m onto the floor
    const [x, y, z] = h.positionOf()!;
    expect(x).toBeCloseTo(95, 3);
    expect(y).toBeCloseTo(1.2, 1);
    expect(z).toBeCloseTo(0, 3);
    expect(inn!.yaw).toBeCloseTo(Math.PI / 2, 5);
    // carried: sheet, journal, NPC memory; the arrival consumed, the way back kept
    expect(h.sheet()?.coins).toBe(777);
    expect(h.record("quests")).toEqual(journal);
    expect(h.record("npc")).toEqual(memory);
    const trip = h.record("portal") as { arrive?: unknown; return?: { scene: string; position: number[]; yaw: number } };
    expect(trip.arrive).toBeUndefined();
    expect(trip.return?.scene).toBe("surface");
    expect(trip.return?.position[2]).toBeCloseTo(2.5, 1);
    expect(trip.return?.yaw).toBeCloseTo(0, 3); // turned away from the gate

    // a reconnect inside the instance: the save still knows the way out
    await h.commit();
    const saved = await h.load("dungeon");
    expect((saved.records["portal"] as { return?: { scene: string } }).return?.scene).toBe("surface");
    // ...and a respawn there does NOT land on the anchor again (the arrival was consumed)
    expect(arrivalFor(h.world, "dungeon", saved, () => [0, 0, 0]).portal).toBe(false);

    // things change inside, then out the return portal
    h.setRecord("character", { ...h.sheet()!, coins: 1000 });
    h.teleport([95, 1.2, 3]);
    h.step(10);
    const out = await h.interact("exit");
    expect(out).toMatchObject({ from: "dungeon", to: "surface", back: true, anchor: null });
    expect(h.scene).toBe("surface");
    const back = h.positionOf()!;
    expect(back[0]).toBeCloseTo(0, 1);
    expect(back[2]).toBeCloseTo(2.5, 1);
    expect(h.sheet()?.coins).toBe(1000);
    expect(h.record("quests")).toEqual(journal);
    expect(h.record("portal")).toEqual({}); // the way back is used up
    expect(h.hops.map((t) => `${t.from}>${t.to}`)).toEqual(["surface>dungeon", "dungeon>surface"]);
    await h.close();
  });

  it("a portal whose condition fails refuses with its line and moves nobody", async () => {
    const c = content();
    const surface = c.scenes.get("surface")!;
    (surface.entities["gate"]!.components["script"] as { params: Record<string, unknown> }).params["condition"] = { quest: "deep", status: "complete" };
    (surface.entities["gate"]!.components["script"] as { params: Record<string, unknown> }).params["refusal"] = "Only those who finished the deep may pass.";
    const h = await PortalHarness.start({ content: c, scene: "surface", at: [0, 1.2, 2], projectScripts: false });
    h.step(10);
    expect(await h.interact("gate")).toBeNull();
    expect(h.scene).toBe("surface");
    expect(h.refusals).toContain("Only those who finished the deep may pass.");
    await h.close();
  });
});

describe("portal harness: walk-through portals", { timeout: 60_000 }, () => {
  function walkContent(): LoadedContent {
    const surface = createScene("surface");
    surface.entities["floor"] = floor(0);
    surface.entities["player"] = player([0, 1.2, 8]);
    // a passage mouth: the box spans z -0.75..0.75 at the origin
    surface.entities["mouth"] = ent("mouth", { transform: { position: [0, 0, 0] }, script: { name: "portal", params: { mode: "trigger", scene: "dungeon", anchor: "entry", name: "the Barrow" } } });
    const dungeon = createScene("dungeon");
    dungeon.entities["floor"] = floor(100);
    dungeon.entities["player"] = player([100, 1.2, 10]);
    const east = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; // facing +X, into the dungeon
    dungeon.entities["entry"] = ent("entry", { transform: { position: [100, 0, 0], rotation: east }, portalAnchor: { corridor: 2.4 } }, ["anchor", "instance-entry"]);
    // the return portal's box CONTAINS the arrival anchor
    dungeon.entities["exit"] = ent("exit", { transform: { position: [99.6, 0, 0], rotation: east }, script: { name: "portal", params: { mode: "trigger", back: true, scene: "surface", party: false } } });
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    return { assets, scenes: new Map([["surface", surface], ["dungeon", dungeon]]), sceneFiles: new Map(), worlds: [], worldFiles: new Map(), scriptDirs: [], warnings: [] };
  }

  it("walks in, lands facing in without bouncing back, walks out the way it came", async () => {
    const h = await PortalHarness.start({ content: walkContent(), scene: "surface", at: [0, 1.2, 8], projectScripts: false });
    h.step(150); // the start is an arrival too: past its grace
    const inn = await h.walkThrough("mouth");
    expect(inn).toMatchObject({ from: "surface", to: "dungeon", anchor: "entry" });
    expect(inn!.yaw).toBeCloseTo(Math.PI / 2, 5);
    // standing in the return portal's box on arrival: nothing fires
    h.step(300);
    expect(h.scene).toBe("dungeon");
    expect(h.hops).toHaveLength(1);
    // in a little way, then back out through the exit
    h.walkTo([104, 1.2, 0], { within: 0.4 });
    h.step(10);
    expect(h.scene).toBe("dungeon");
    const out = await h.walkThrough("exit");
    expect(out).toMatchObject({ from: "dungeon", to: "surface", back: true });
    // back outside the mouth's box, on the side the traveller came from, facing away from it
    const [, , z] = h.positionOf()!;
    expect(z).toBeGreaterThan(1.6);
    expect(out!.yaw).toBeCloseTo(0, 3);
    // straight back in inside the arrival grace: the mouth does not take the body again
    expect(await h.walkThrough("mouth", { seconds: 1 })).toBeNull();
    h.step(300);
    expect(h.scene).toBe("surface");
    expect(h.hops.map((t) => `${t.from}>${t.to}`)).toEqual(["surface>dungeon", "dungeon>surface"]);
    await h.close();
  });
});
