import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  createScene,
  EventRegistry,
  NetStateStore,
  questState,
  registerCharacterNetState,
  registerCoreAssetTypes,
  registerCoreComponents,
  registerCoreEvents,
  WORLD_HOUR_KEY,
  WORLD_WEATHER_KEY,
  type CharacterSheet,
  type NpcMemory,
  type Op,
  type QuestJournal,
} from "@hitreg/core";
import { EventBus, presentFor, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike } from "../src/index.js";
import { QuestLog } from "../src/quest-log.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);
const noInput: InputLike = { isDown: () => false };

function harness() {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const add = (id: string, type: string, data: unknown) => assets.addDataAsset({ id, type, name: id, data });
  add("token", "item", { name: "Token", stack: 10, value: 1, kind: "misc" });
  add("moves", "performActions", { actions: [{ name: "whistle", label: "Whistle" }] });
  add("near", "places", { origin: [0, 0], places: { ford: { at: [300, 0], name: "the ford" } } });
  add("ferry-talk", "dialogue", { start: [{ node: "f" }], nodes: { f: { text: "Across?", choices: [{ text: "Not yet" }] } } });
  add("sign-text", "dialogue", { start: [{ node: "r" }], nodes: { r: { text: "The ford lies {dir:ford}.", choices: [{ text: "Back" }] } } });
  add("order", "quest", {
    id: "order", title: "Order", description: "",
    objectives: [
      { id: "pull", label: "Pull", kind: "interact", target: "lever", then: [{ do: "setFlag", flag: "pulled" }] },
      { id: "leave", label: "Leave", kind: "deliver", target: "cairn", item: "token", required: 2, after: ["pull"] },
      { id: "sign", label: "Read", kind: "read", target: "sign", after: ["leave"] },
    ],
  });
  add("night", "quest", {
    id: "night", title: "Night", description: "", rewardCoins: 4,
    source: { kind: "auto", when: { flag: "pulled" } },
    objectives: [
      { id: "dance", label: "Dance", kind: "perform", action: "dance", target: "stone", when: { clock: { from: 20, to: 4 } } },
      { id: "whistle", label: "Whistle", kind: "perform", action: "whistle", after: ["dance"] },
      { id: "wait", label: "Wait", kind: "endure", seconds: 1, area: { label: "here", center: [0, 0], radius: 50 }, after: ["whistle"], when: { weather: { min: 0.4, biomes: ["tundra"] } } },
    ],
  });
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);
  const entity = (id: string, parent: string | null, components: Record<string, unknown>, tags: string[] = []): Op => ({
    op: "add-entity", id, entity: { name: id, parent, tags, components: { transform: {}, ...components } },
  });
  const ops: Op[] = [
    entity("player", null, {}, ["player"]),
    entity("player-sheet", "player", { script: { name: "character-sheet", params: { actor: "player", persist: false } } }),
    entity("player-quests", "player", { script: { name: "quest-log", params: { actor: "player", autoStart: ["order"], autoOffer: ["night"], performActions: "moves" } } }),
    entity("lever", null, {}, ["interactable"]),
    entity("cairn", null, {}, ["interactable"]),
    entity("stone", null, {}, []),
    entity("ferry", null, { script: { name: "npc", params: { name: "Ferryman", dialogue: "ferry-talk", radius: 3, presence: { clock: { from: 18, to: 22 } } } } }, ["interactable"]),
    entity("sign", null, { script: { name: "npc", params: { name: "Sign", dialogue: "sign-text", places: "near", face: false, readable: true, radius: 3 } } }, ["interactable"]),
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const at = (x: number, z: number) => { const o = new THREE.Object3D(); o.position.set(x, 0, z); return o; };
  const player = new THREE.Object3D();
  const objects = new Map<string, THREE.Object3D>([
    ["player", player], ["player-sheet", new THREE.Object3D()], ["player-quests", new THREE.Object3D()],
    ["lever", at(2, 0)], ["cairn", at(-2, 0)], ["stone", at(0, 3)], ["sign", at(1, 1)], ["ferry", at(-1, 1)],
  ]);
  const netState = new NetStateStore();
  registerCharacterNetState(netState);
  netState.set("owner/player", "peer-a");
  const bus = new EventBus(events);
  const biomeAt = (x: number) => ({ id: x < 10 ? "tundra" : "meadow", zone: "", weights: {}, ground: 0, temperature: 0, moisture: 0, slope: 0 });
  const runtime = new ScriptRuntime({ doc, objects, sim: null, registry, input: noInput, events: bus, netState, assets, biomeAt, localPlayer: () => "player" });
  runtime.start();
  const tick = (n = 1) => { for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60); };
  tick(2);
  const ask = (name: string, payload: Record<string, unknown>, from = "peer-a") => { bus.injectFromPeer(from, [{ name, payload: { actorId: "player", ...payload } }]); tick(20); };
  const journal = () => netState.get("quests/player") as QuestJournal;
  const progress = (q: string, o: string) => questState(journal(), q)?.progress[o] ?? 0;
  const sheet = () => netState.get("character/player") as CharacterSheet;
  const tokens = () => Object.values(sheet().items).reduce((n, s) => n + (s.itemId === "token" ? s.qty : 0), 0);
  const performed: string[] = [];
  bus.on("player.performed", (p) => performed.push((p as { action: string }).action));
  return { runtime, netState, player, bus, tick, ask, journal, progress, tokens, performed };
}

describe("quest blocks on the authority", () => {
  it("interact (owner + range), then-flag, deliver after order, read with resolved text", () => {
    const h = harness();
    expect(h.journal().quests.order?.status).toBe("active");
    h.ask("player.interact", { entityId: "lever" }, "peer-b"); // not the owner
    expect(h.progress("order", "pull")).toBe(0);
    h.player.position.set(30, 0, 0);
    h.ask("player.interact", { entityId: "lever" }); // out of range
    expect(h.progress("order", "pull")).toBe(0);
    h.player.position.set(0, 0, 0);
    h.ask("player.interact", { entityId: "lever" });
    expect(h.progress("order", "pull")).toBe(1);
    expect((h.netState.get("npc/player") as NpcMemory).flags.pulled).toBe(true);

    h.ask("npc.talk", { npcId: "sign" }); // read before deliver: order holds it back
    expect(h.progress("order", "sign")).toBe(0);
    h.ask("npc.leave", { npcId: "sign" });

    h.bus.emit("inventory.give", { actorId: "player", itemId: "token", qty: 3 });
    h.tick(5);
    h.ask("player.interact", { entityId: "cairn" });
    expect(h.progress("order", "leave")).toBe(2);
    expect(h.tokens()).toBe(1);

    h.ask("npc.talk", { npcId: "sign" });
    expect((h.netState.get("dialogue/player") as { text: string }).text).toBe("The ford lies east.");
    expect(h.journal().quests.order?.status).toBe("complete");
    h.runtime.dispose();
  });

  it("auto source starts a quest straight into the journal; perform with clock gate, vocabulary, tolerance and rate; endure resets", () => {
    const h = harness();
    expect(questState(h.journal(), "night")).toBeUndefined();
    h.ask("player.interact", { entityId: "lever" }); // sets the flag the auto source waits on
    h.tick(20);
    expect(h.journal().quests.night?.status).toBe("active");

    h.netState.set(WORLD_HOUR_KEY, 12);
    h.ask("player.perform", { action: "dance", at: [0, 0, 0] });
    expect(h.performed).toEqual(["dance"]);
    expect(h.progress("night", "dance")).toBe(0); // daytime
    h.netState.set(WORLD_HOUR_KEY, 22);
    h.ask("player.perform", { action: "dance", at: [0, 0, 0] }); // inside the cooldown: refused
    expect(h.performed).toEqual(["dance"]);
    h.tick(90);
    h.ask("player.perform", { action: "dance", at: [0, 0, 30] }); // claims to stand 30 m away: refused
    h.ask("player.perform", { action: "juggle", at: [0, 0, 0] }); // not in the vocabulary
    expect(h.performed).toEqual(["dance"]);
    h.ask("player.perform", { action: "dance", at: [0, 0, 0] });
    expect(h.progress("night", "dance")).toBe(1);
    h.tick(90);
    h.ask("player.perform", { action: "whistle", at: [0, 0, 0] }); // project vocabulary
    expect(h.progress("night", "whistle")).toBe(1);

    h.netState.set(WORLD_WEATHER_KEY, { precipitation: 0.6, storm: 0 });
    h.tick(36); // 0.6 s in the area
    h.player.position.set(60, 0, 0); // leaves: the count starts over
    h.tick(30);
    h.player.position.set(0, 0, 0);
    h.tick(45);
    expect(h.progress("night", "wait")).toBe(0);
    h.tick(30);
    expect(h.journal().quests.night?.status).toBe("complete");
    h.runtime.dispose();
  });

  it("weather with biomes holds only over those biomes", () => {
    const h = harness();
    h.ask("player.interact", { entityId: "lever" });
    h.netState.set(WORLD_HOUR_KEY, 22);
    h.tick(90);
    h.ask("player.perform", { action: "dance", at: [0, 0, 0] });
    h.tick(90);
    h.ask("player.perform", { action: "whistle", at: [0, 0, 0] });
    h.netState.set(WORLD_WEATHER_KEY, { precipitation: 0.6, storm: 0 });
    h.player.position.set(20, 0, 0); // meadow, inside the area
    h.tick(120);
    expect(h.progress("night", "wait")).toBe(0);
    h.player.position.set(5, 0, 0); // tundra
    h.tick(90);
    expect(h.progress("night", "wait")).toBe(1);
    h.runtime.dispose();
  });
});

describe("presence and player commands", () => {
  it("a presence npc is only there in its window, and never leaves mid-conversation", () => {
    const h = harness();
    const conv = () => h.netState.get("dialogue/player") as { npc: string } | undefined;
    h.netState.set(WORLD_HOUR_KEY, 12);
    h.ask("npc.talk", { npcId: "ferry" });
    expect(conv()).toBeUndefined();
    h.netState.set(WORLD_HOUR_KEY, 19);
    h.ask("npc.talk", { npcId: "ferry" });
    expect(conv()?.npc).toBe("ferry");
    h.netState.set(WORLD_HOUR_KEY, 23); // the window closes while they talk
    h.tick(60);
    expect(conv()?.npc).toBe("ferry");
    h.ask("npc.leave", { npcId: "ferry" });
    expect(presentFor({ getEntity: () => ({ components: { script: { name: "npc", params: { presence: { clock: { from: 18, to: 22 } } } } } }) as never, getObject: () => undefined }, h.netState, "ferry", "player")).toBe(false);
    h.ask("npc.talk", { npcId: "ferry" });
    expect(conv()).toBeUndefined();
    h.runtime.dispose();
  });

  it("/dance typed by the local player becomes a perform request", () => {
    const h = harness();
    expect(h.runtime.playerCommands().map((c) => c.name)).toContain("dance");
    expect(h.runtime.runPlayerCommand("dance", [])).toEqual({ ok: true, text: "" });
    expect(h.runtime.runPlayerCommand("whistle", [])?.ok).toBe(true); // the project's vocabulary
    expect(h.runtime.runPlayerCommand("juggle", [])).toBeNull();
    h.tick(20);
    expect(h.performed).toEqual(["dance"]); // whistle fell inside the cooldown
    h.runtime.dispose();
  });
});

describe("kill targets", () => {
  it("matches an entity id, a spawn template, and a tag record", () => {
    expect(QuestLog.matchesKill("boss-1", "boss-1")).toBe(true);
    expect(QuestLog.matchesKill("camp-3#pop-wolf-timber-l3#2", "pop-wolf-timber-l3")).toBe(true);
    expect(QuestLog.matchesKill("camp-3#pop-wolf-timber-l3#2", "wolf")).toBe(false);
    // a tag target counts only the record the kill event wrote for that tag
    expect(QuestLog.matchesKill("tag:creature:wolf|camp-3#pop-wolf-timber-l3#2", "tag:creature:wolf")).toBe(true);
    expect(QuestLog.matchesKill("camp-3#pop-wolf-timber-l3#2", "tag:creature:wolf")).toBe(false);
    // and a tag record never double-counts for a template target
    expect(QuestLog.matchesKill("tag:creature:wolf|camp-3#pop-wolf-timber-l3#2", "pop-wolf-timber-l3")).toBe(false);
  });
});
