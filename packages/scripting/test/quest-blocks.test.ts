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
  WORLD_DAY_KEY,
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

function harness(opts: { repeat?: boolean; autoStart?: string[] } = {}) {
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
  // a quest OBJECT: an entity running the npc builtin (it holds a dialogue), used by talking to it
  add("roll-talk", "dialogue", { start: [{ node: "r" }], nodes: { r: { text: "Names, inked in rows.", choices: [{ text: "Leave it" }] } } });
  add("muster", "quest", {
    id: "muster", title: "Muster", description: "",
    objectives: [
      { id: "sign", label: "Sign the roll", kind: "interact", target: "roll" },
      { id: "leave", label: "Leave tokens", kind: "deliver", target: "roll", item: "token", required: 2, after: ["sign"] },
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
  add("patrol", "quest", {
    id: "patrol", title: "Patrol", description: "", rewardCoins: 5, repeat: { after: "day", limit: 2 },
    source: { kind: "auto" },
    objectives: [{ id: "walk", label: "Walk", kind: "visit", area: { label: "here", center: [0, 0], radius: 50 } }],
  });
  // a drop from the slain: tokens off wolves, only while the step is open
  add("pelts", "quest", {
    id: "pelts", title: "Pelts", description: "",
    objectives: [{ id: "pelts", label: "Take tokens off wolves", kind: "collect", target: "token", required: 2, from: "tag:creature:wolf", chance: 0.5 }],
  });
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);
  const entity = (id: string, parent: string | null, components: Record<string, unknown>, tags: string[] = []): Op => ({
    op: "add-entity", id, entity: { name: id, parent, tags, components: { transform: {}, ...components } },
  });
  const ops: Op[] = [
    entity("player", null, {}, ["player"]),
    entity("player-sheet", "player", { script: { name: "character-sheet", params: { actor: "player", persist: false } } }),
    entity("player-quests", "player", { script: { name: "quest-log", params: { actor: "player", autoStart: opts.autoStart ?? ["order"], autoOffer: opts.repeat ? ["patrol"] : ["night"], performActions: "moves" } } }),
    ...(opts.repeat ? [entity("clock", null, { script: { name: "day-night", params: { startHour: 10 } } })] : []),
    entity("lever", null, {}, ["interactable"]),
    entity("cairn", null, {}, ["interactable"]),
    entity("stone", null, {}, []),
    entity("ferry", null, { script: { name: "npc", params: { name: "Ferryman", dialogue: "ferry-talk", radius: 3, presence: { clock: { from: 18, to: 22 } } } } }, ["interactable"]),
    entity("sign", null, { script: { name: "npc", params: { name: "Sign", dialogue: "sign-text", places: "near", face: false, readable: true, radius: 3 } } }, ["interactable"]),
    entity("roll", null, { script: { name: "npc", params: { name: "Muster Roll", dialogue: "roll-talk", face: false, radius: 3 } } }, ["interactable"]),
    entity("wolf-1", null, {}, ["npc", "creature:wolf"]),
    entity("wolf-2", null, {}, ["npc", "creature:wolf"]),
    entity("wolf-3", null, {}, ["npc", "creature:wolf"]),
    entity("wolf-4", null, {}, ["npc", "creature:wolf"]),
    entity("rat-1", null, {}, ["npc", "creature:rat"]),
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const at = (x: number, z: number) => { const o = new THREE.Object3D(); o.position.set(x, 0, z); return o; };
  const player = new THREE.Object3D();
  const objects = new Map<string, THREE.Object3D>([
    ["player", player], ["player-sheet", new THREE.Object3D()], ["player-quests", new THREE.Object3D()],
    ["lever", at(2, 0)], ["cairn", at(-2, 0)], ["clock", new THREE.Object3D()], ["stone", at(0, 3)], ["sign", at(1, 1)], ["ferry", at(-1, 1)], ["roll", at(0, -2)],
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

  it("an npc quest object is used by talking to it, the way the client clicks it: interact and deliver count once per conversation", () => {
    const h = harness({ autoStart: ["muster"] });
    const interacted: string[] = [];
    h.bus.on("player.interacted", (p) => interacted.push((p as { entityId: string }).entityId));
    h.player.position.set(30, 0, 0);
    h.ask("npc.talk", { npcId: "roll" }); // out of range: no conversation, no use
    expect(h.progress("muster", "sign")).toBe(0);
    h.player.position.set(0, 0, 0);
    h.ask("npc.talk", { npcId: "roll" }, "peer-b"); // not the owner
    expect(h.progress("muster", "sign")).toBe(0);
    h.ask("npc.talk", { npcId: "roll" });
    expect(h.netState.get("dialogue/player")).toMatchObject({ npc: "roll" });
    expect(h.progress("muster", "sign")).toBe(1);
    expect(interacted).toEqual(["roll"]);
    h.ask("npc.leave", { npcId: "roll" });

    h.bus.emit("inventory.give", { actorId: "player", itemId: "token", qty: 3 });
    h.tick(5);
    expect(h.progress("muster", "leave")).toBe(0); // carrying is not delivering: the roll must be used
    h.ask("npc.talk", { npcId: "roll" });
    expect(h.progress("muster", "leave")).toBe(2);
    expect(h.tokens()).toBe(1);
    expect(h.journal().quests.muster?.status).toBe("complete");
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

describe("collect from the slain", () => {
  it("a matching kill by this character rolls the chance and drops the item into its bags, never past required", () => {
    const h = harness({ autoStart: ["pelts"] });
    const roll = QuestLog.roll;
    try {
      const kill = (victimId: string, killerId = "player") => { h.bus.emit("combat.killed", { killerId, victimId }); h.tick(40); }; // the drop lands one pass after the kill
      QuestLog.roll = () => 0;
      kill("rat-1"); // not a wolf
      kill("wolf-1", "someone-else"); // not this character's kill
      expect(h.tokens()).toBe(0);
      kill("wolf-1");
      expect(h.tokens()).toBe(1);
      expect(h.progress("pelts", "pelts")).toBe(1);
      QuestLog.roll = () => 0.9; // above the chance: nothing drops
      kill("wolf-2");
      expect(h.tokens()).toBe(1);
      QuestLog.roll = () => 0;
      kill("wolf-3");
      kill("wolf-4"); // the step is done: no more drops
      expect(h.tokens()).toBe(2);
      expect(h.journal().quests.pelts?.status).toBe("complete");
    } finally {
      QuestLog.roll = roll;
      h.runtime.dispose();
    }
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

describe("repeat on the authority", () => {
  it("a daily completes, waits for the next world day (day-night's world/day), is taken up again and pays again, up to its limit", () => {
    const h = harness({ repeat: true });
    const coins = () => (h.netState.get("character/player") as CharacterSheet).coins;
    h.tick(120);
    expect(h.journal().quests.patrol).toMatchObject({ status: "complete", completions: 1 });
    expect(h.journal().quests.patrol?.completedAt).toBeCloseTo(10, 0);
    const paid = coins();
    expect(paid).toBeGreaterThanOrEqual(5);
    h.runtime.runConsoleCommand("time", ["23"]);
    h.tick(60);
    expect(h.journal().quests.patrol?.completions).toBe(1); // same world day: not offered again
    expect(h.runtime.runConsoleCommand("time", ["1"])?.ok).toBe(true); // earlier hour = tomorrow
    expect(h.netState.get(WORLD_DAY_KEY)).toBe(1);
    h.tick(60);
    expect(h.journal().quests.patrol).toMatchObject({ status: "complete", completions: 2 });
    expect(coins()).toBe(paid + 5);
    h.runtime.runConsoleCommand("time", ["+48"]);
    h.tick(60);
    expect(h.journal().quests.patrol?.completions).toBe(2); // limit 2
    h.runtime.dispose();
  });
});

/** tide, escort and choose: a second small scene (two players share one escorted NPC). */
function mechHarness() {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const add = (id: string, type: string, data: unknown) => assets.addDataAsset({ id, type, name: id, data });
  add("maud-talk", "dialogue", { start: [{ node: "m" }], nodes: { m: { text: "Walk with me.", choices: [{ text: "Go" }] } } });
  add("walk-maud", "quest", { id: "walk-maud", title: "Walk Maud", description: "", objectives: [{ id: "walk", label: "Walk Maud home", kind: "escort", target: "maud", radius: 8, grace: 2 }] });
  add("bell", "quest", {
    id: "bell", title: "Bell", description: "",
    objectives: [
      { id: "ring", label: "Ring", kind: "interact", target: "bell-a", then: [{ do: "choose", choice: "bell-fate", option: "rang" }] },
      { id: "muffle", label: "Muffle", kind: "interact", target: "bell-b", then: [{ do: "choose", choice: "bell-fate", option: "muffled" }] },
    ],
  });
  add("bell-later", "quest", {
    id: "bell-later", title: "Bell later", description: "",
    objectives: [
      { id: "ring", label: "Ring", kind: "interact", target: "bell-a", then: [{ do: "choose", choice: "bell-fate", option: "rang" }], when: { flag: "later" } },
      { id: "muffle", label: "Muffle", kind: "interact", target: "bell-b", then: [{ do: "choose", choice: "bell-fate", option: "muffled" }] },
    ],
  });
  add("ebb", "quest", { id: "ebb", title: "Ebb", description: "", objectives: [{ id: "flats", label: "Flats", kind: "visit", area: { label: "flats", center: [0, 0], radius: 50 }, when: { tide: "low" } }] });
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);
  const entity = (id: string, parent: string | null, components: Record<string, unknown>, tags: string[] = []): Op => ({
    op: "add-entity", id, entity: { name: id, parent, tags, components: { transform: {}, ...components } },
  });
  const ops: Op[] = [
    entity("player", null, {}, ["player"]),
    entity("player-sheet", "player", { script: { name: "character-sheet", params: { actor: "player", persist: false } } }),
    entity("player-quests", "player", { script: { name: "quest-log", params: { actor: "player", autoStart: ["walk-maud", "bell", "bell-later", "ebb"] } } }),
    entity("p2", null, {}, ["player"]),
    entity("p2-quests", "p2", { script: { name: "quest-log", params: { actor: "p2", autoStart: ["walk-maud"] } } }),
    entity("maud", null, { script: { name: "npc", params: { name: "Maud", dialogue: "maud-talk", escort: { route: [[0, 0, 10], [10, 0, 10]], speed: 4, hold: 1 } } } }, ["interactable"]),
    entity("bell-a", null, {}, ["interactable"]),
    entity("bell-b", null, {}, ["interactable"]),
  ];
  const doc = applyOps(createScene("m"), ops, coreRegistry).doc;
  const at = (x: number, z: number) => { const o = new THREE.Object3D(); o.position.set(x, 0, z); return o; };
  const player = at(200, 200);
  const p2 = at(300, 300);
  const maud = at(0, 0);
  const objects = new Map<string, THREE.Object3D>([
    ["player", player], ["player-sheet", new THREE.Object3D()], ["player-quests", new THREE.Object3D()], ["p2", p2], ["p2-quests", new THREE.Object3D()],
    ["maud", maud], ["bell-a", at(100, 0)], ["bell-b", at(101, 0)],
  ]);
  const netState = new NetStateStore();
  registerCharacterNetState(netState);
  netState.set("owner/player", "peer-a");
  const bus = new EventBus(events);
  const runtime = new ScriptRuntime({ doc, objects, sim: null, registry, input: noInput, events: bus, netState, assets, localPlayer: () => "player" });
  runtime.start();
  const tick = (n = 1) => { for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60); };
  tick(70);
  const ask = (name: string, payload: Record<string, unknown>) => { bus.injectFromPeer("peer-a", [{ name, payload: { actorId: "player", ...payload } }]); tick(20); };
  const progress = (actor: string, q: string, o: string) => questState(netState.get(`quests/${actor}`) as QuestJournal, q)?.progress[o] ?? 0;
  const status = (q: string) => questState(netState.get("quests/player") as QuestJournal, q)?.status;
  const flags = () => (netState.get("npc/player") as NpcMemory | undefined)?.flags ?? {};
  const claim = () => netState.get("escort/maud") as { by: string; state: string; d: number } | undefined;
  return { netState, player, p2, maud, tick, ask, progress, status, flags, claim };
}

describe("tide, escort and choose on the authority", () => {
  it("tide: a step gated on low water progresses only in the low window of world/day * 24 + world/hour", () => {
    const h = mechHarness();
    h.player.position.set(0, 0, 0);
    h.netState.set(WORLD_DAY_KEY, 0);
    h.netState.set(WORLD_HOUR_KEY, 0); // high water
    h.tick(30);
    expect(h.progress("player", "ebb", "flats")).toBe(0);
    h.netState.set(WORLD_HOUR_KEY, 6.2); // low water
    h.tick(30);
    expect(h.status("ebb")).toBe("complete");
  });

  it("escort: claimed by the first character near, walks only while it stays near, fails when left, retried, completes on arrival", () => {
    const h = mechHarness();
    h.tick(30);
    expect(h.claim()).toBeUndefined(); // nobody near
    h.player.position.set(3, 0, 0);
    h.tick(20);
    expect(h.claim()).toMatchObject({ by: "player", state: "walk" });
    h.p2.position.set(-3, 0, 0); // the second character waits: one claim at a time
    h.tick(20);
    expect(h.claim()?.by).toBe("player");
    // left behind: grace 2 s, then it fails and walks back; the step stays open
    h.player.position.set(200, 0, 200);
    h.p2.position.set(300, 0, 300);
    h.tick(60 * 3);
    expect(["failed", "return"]).toContain(h.claim()?.state);
    expect(h.progress("player", "walk-maud", "walk")).toBe(0);
    h.tick(60 * 4);
    expect(h.claim()).toBeUndefined();
    expect([h.maud.position.x, h.maud.position.z]).toEqual([0, 0]);
    // retry: stay beside it all the way (route 20 m at 4 m/s)
    h.player.position.set(2, 0, 0);
    for (let i = 0; i < 60 * 7; i++) {
      h.player.position.set(h.maud.position.x + 2, 0, h.maud.position.z);
      h.tick();
    }
    expect(h.progress("player", "walk-maud", "walk")).toBe(1);
    expect(h.status("walk-maud")).toBe("complete");
    expect(h.progress("p2", "walk-maud", "walk")).toBe(0);
    h.tick(60 * 8); // holds 1 s, walks back, the claim ends: free for the next character
    expect(h.claim()).toBeUndefined();
    h.p2.position.set(1, 0, 0);
    h.tick(20);
    expect(h.claim()?.by).toBe("p2");
  });

  it("choose: one option sets <choice>=<option> and locks the other here and in any other quest", () => {
    const h = mechHarness();
    h.player.position.set(100.5, 0, 0);
    h.ask("player.interact", { entityId: "bell-a" });
    h.tick(20);
    expect(h.flags()["bell-fate=rang"]).toBe(true);
    expect(h.status("bell")).toBe("complete"); // the other option counts as settled
    expect(h.progress("player", "bell", "muffle")).toBe(0);
    // bell-later: its `ring` option waits on a flag, `muffle` is locked by the choice already made
    h.ask("player.interact", { entityId: "bell-b" });
    h.tick(20);
    expect(h.progress("player", "bell-later", "muffle")).toBe(0);
    expect(h.flags()["bell-fate=muffled"]).toBeUndefined();
  });
});
