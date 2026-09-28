import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";
import { inHours, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, worldClock, type RegionAt } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

const SOUNDS = new Set([
  "ambience/biome/forest-dawn.ogg",
  "ambience/biome/forest-day.ogg",
  "ambience/biome/forest-dusk.ogg",
  "ambience/biome/forest-night.ogg",
  "ambience/biome/grassland-day.ogg",
  "ambience/town/day.ogg",
  "ambience/interior/tavern-busy.ogg",
  "music/biome/forest-day.ogg",
  "music/biome/grassland-day.ogg",
  "music/town/village-day.ogg",
  "music/tavern/jig.ogg",
  "music/combat/normal-1.ogg",
  "spot/crow-caw.mp3",
  "spot/crow-caw-2.mp3",
  "spot/clock-bell-strike.mp3",
  "workshop/wood/saw-stroke.mp3",
  "workshop/wood/saw-stroke-2.mp3",
  "workshop/wood/plank-set-down.mp3",
]);

let loading = false;

interface World {
  biome?: string;
  region?: RegionAt | null;
  zone?: Record<string, unknown>;
  emitter?: Record<string, unknown>;
  params?: Record<string, unknown>;
  trackSeconds?: number;
}

const live: ScriptRuntime[] = [];

function world(opts: World) {
  const ops: Op[] = [
    { op: "add-entity", id: "scape", entity: { name: "Soundscape", parent: null, tags: [], components: { script: { name: "soundscape", params: opts.params ?? {} } } } },
    { op: "add-entity", id: "player", entity: { name: "player", parent: null, tags: ["player"], components: { transform: {} } } },
  ];
  if (opts.zone) {
    ops.push({ op: "add-entity", id: "tavern", entity: { name: "tavern", parent: null, tags: [], components: { transform: {}, script: { name: "sound-zone", params: opts.zone } } } } as Op);
  }
  if (opts.emitter) {
    ops.push({ op: "add-entity", id: "bench", entity: { name: "bench", parent: null, tags: [], components: { transform: { position: [3, 0, 4] }, script: { name: "sound-emitter", params: opts.emitter } } } } as Op);
  }
  const doc: SceneDoc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const objects = new Map<string, THREE.Object3D>();
  for (const id of Object.keys(doc.entities)) objects.set(id, new THREE.Object3D());
  const loops = new Map<string, { sound: string; volume: number }>();
  const shots: Array<{ sound: string; at?: readonly [number, number, number] }> = [];
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  const runtime = new ScriptRuntime({
    doc,
    objects,
    registry,
    sim: { getLinvel: () => [0, 0, 0], setLinvel: () => {}, applyImpulse: () => {} },
    input: { isDown: () => false },
    biomeAt: () => {
      const id = opts.biome ?? "forest";
      return { id, zone: "t", weights: { [id]: 1 }, ground: 0, temperature: 0.5, moisture: 0.5, slope: 0 };
    },
    regionAt: () => opts.region ?? null,
    hasSound: (id) => SOUNDS.has(id),
    worldLoading: () => loading,
    soundDuration: (id) => (id.startsWith("music/") ? opts.trackSeconds ?? 600 : 5),
    setSoundLoop: (_id, slot, sound, o) => {
      if (!sound) loops.delete(slot);
      else loops.set(slot, { sound, volume: o?.volume ?? 1 });
    },
    playSound: (_id, sound, o) => {
      if (sound) shots.push({ sound, ...(o?.at ? { at: o.at } : {}) });
    },
  });
  runtime.start();
  live.push(runtime);
  const step = (seconds: number) => {
    for (let t = 0; t < seconds * 30; t++) {
      runtime.fixedUpdate(1 / 30);
      runtime.lateUpdate(1 / 30);
    }
  };
  /** Sound id → gain, for everything audible right now. */
  const audible = () => {
    const out: Record<string, number> = {};
    for (const { sound, volume } of loops.values()) if (volume > 0.01) out[sound] = (out[sound] ?? 0) + volume;
    return out;
  };
  const player = objects.get("player")!;
  const bench = objects.get("bench");
  bench?.position.set(3, 0, 4);
  bench?.updateMatrixWorld();
  return { step, audible, shots, player, runtime };
}

afterEach(() => {
  // a sound zone registers itself while its script lives: dispose, or it leaks into the next test
  for (const r of live.splice(0)) r.dispose();
  worldClock.hour = Number.NaN;
  loading = false;
});

describe("soundscape", () => {
  it("plays the biome's bed for the hour, and that biome's music", () => {
    worldClock.hour = 12;
    const w = world({});
    w.step(8);
    const a = w.audible();
    expect(a["ambience/biome/forest-day.ogg"]).toBeGreaterThan(0.2);
    expect(a["ambience/biome/forest-night.ogg"]).toBeUndefined();
    expect(a["music/biome/forest-day.ogg"]).toBeGreaterThan(0.2);
  });

  it("hands dawn to day across the band edge instead of switching", () => {
    worldClock.hour = 7.5;
    const w = world({});
    w.step(8);
    const a = w.audible();
    expect(a["ambience/biome/forest-dawn.ogg"]).toBeGreaterThan(0.08);
    expect(a["ambience/biome/forest-day.ogg"]).toBeGreaterThan(0.08);
  });

  it("a biome with no beds borrows the fallback biome's", () => {
    worldClock.hour = 12;
    const w = world({ biome: "savanna" });
    w.step(8);
    expect(w.audible()["ambience/biome/grassland-day.ogg"]).toBeGreaterThan(0.2);
  });

  it("combat music cuts in while the player is fighting and leaves after", () => {
    worldClock.hour = 12;
    const w = world({});
    w.step(6);
    w.player.userData["combatUntil"] = 1e9;
    w.step(3);
    let a = w.audible();
    expect(a["music/combat/normal-1.ogg"]).toBeGreaterThan(0.3);
    expect(a["music/biome/forest-day.ogg"]).toBeUndefined();
    w.player.userData["combatUntil"] = 0;
    w.step(8);
    a = w.audible();
    expect(a["music/combat/normal-1.ogg"]).toBeUndefined();
  });

  it("exploration music plays once, then leaves a silence, then returns", () => {
    worldClock.hour = 12;
    const w = world({ trackSeconds: 20, params: { musicGapMin: 10, musicGapMax: 10, musicFade: 2 } });
    w.step(10);
    expect(w.audible()["music/biome/forest-day.ogg"]).toBeGreaterThan(0.2);
    w.step(14); // past 20 s: faded out, in the gap
    expect(w.audible()["music/biome/forest-day.ogg"]).toBeUndefined();
    w.step(10); // gap over
    expect(w.audible()["music/biome/forest-day.ogg"]).toBeGreaterThan(0);
  });

  it("a town zone adds the town bed under a thinner biome bed and plays town music", () => {
    worldClock.hour = 12;
    const w = world({ region: { id: "brinehold", name: "Brinehold", tags: ["town"] } });
    w.step(8);
    const a = w.audible();
    expect(a["ambience/town/day.ogg"]).toBeGreaterThan(0.05);
    // the town sits UNDER the default ambience level, never on top of it
    expect(a["ambience/town/day.ogg"]).toBeLessThan(0.15);
    expect(a["ambience/biome/forest-day.ogg"]).toBeLessThan(0.15);
    expect(a["music/town/village-day.ogg"]).toBeGreaterThan(0.2);
  });

  it("a sound zone swaps in its own bed and music", () => {
    worldClock.hour = 12;
    const w = world({ zone: { radius: 10, fade: 0, ambience: "ambience/interior/tavern-busy.ogg", music: "music/tavern/jig.ogg", outdoorMix: 0.1 } });
    w.step(8);
    const a = w.audible();
    expect(a["ambience/interior/tavern-busy.ogg"]).toBeGreaterThan(0.2);
    expect(a["ambience/biome/forest-day.ogg"]).toBeLessThan(0.05);
    expect(a["music/tavern/jig.ogg"]).toBeGreaterThan(0.2);
  });

  it("spot emitters land around the player, from the biome's list, every variant eligible", () => {
    worldClock.hour = 12;
    const w = world({ params: { spots: { forest: { day: "spot/crow-caw" } }, spotEveryMin: 1, spotEveryMax: 1 } });
    w.step(12);
    expect(w.shots.length).toBeGreaterThan(5);
    const names = new Set(w.shots.map((s) => s.sound));
    expect([...names].every((n) => n === "spot/crow-caw.mp3" || n === "spot/crow-caw-2.mp3")).toBe(true);
    for (const s of w.shots) {
      const d = Math.hypot(s.at![0], s.at![2]);
      expect(d).toBeGreaterThanOrEqual(10);
      expect(d).toBeLessThanOrEqual(45);
    }
  });

  it("stays silent while the world streams in around a fresh spawn, then settles in", () => {
    worldClock.hour = 12;
    loading = true;
    const w = world({ params: { spotEveryMin: 1, spotEveryMax: 1 } });
    w.step(10);
    expect(w.audible()).toEqual({});
    expect(w.shots.length).toBe(0);
    loading = false;
    w.step(1); // not yet settled
    expect(w.audible()).toEqual({});
    w.step(8);
    expect(w.audible()["ambience/biome/forest-day.ogg"]).toBeGreaterThan(0.2);
    // later streaming (walking into new terrain) does not silence it again
    loading = true;
    w.step(2);
    expect(w.audible()["ambience/biome/forest-day.ogg"]).toBeGreaterThan(0.2);
  });

  it("the town clock tolls the hour from the town square, once, and keeps quiet at night", () => {
    worldClock.hour = 14.95;
    const w = world({ region: { id: "brinehold", name: "Brinehold", tags: ["town"], hub: [100, -40] }, params: { spots: {} } });
    w.step(3); // spawning mid-hour rings nothing
    expect(w.shots.filter((s) => s.sound.startsWith("spot/clock-bell"))).toHaveLength(0);
    worldClock.hour = 15.01;
    w.step(12);
    const bells = w.shots.filter((s) => s.sound.startsWith("spot/clock-bell"));
    expect(bells).toHaveLength(3); // 15:00 = three strikes
    expect(bells[0]!.at![0]).toBe(100);
    expect(bells[0]!.at![2]).toBe(-40);
    worldClock.hour = 23.01; // inside the default 22-6 quiet
    w.step(12);
    expect(w.shots.filter((s) => s.sound.startsWith("spot/clock-bell"))).toHaveLength(3);
  });

  it("no clock outside a town", () => {
    worldClock.hour = 9.99;
    const w = world({ params: { spots: {} } });
    w.step(3);
    worldClock.hour = 10.01;
    w.step(10);
    expect(w.shots.filter((s) => s.sound.startsWith("spot/clock-bell"))).toHaveLength(0);
  });

  it("a sound emitter works in bursts at its beat, at its own spot, only in working hours", () => {
    worldClock.hour = 10;
    const w = world({ emitter: { shots: "workshop/wood/saw-stroke@0.5", burstMin: 4, burstMax: 4, restMin: 1, restMax: 1, extras: "workshop/wood/plank-set-down", extrasChance: 1, hours: "7-19" } });
    w.step(20);
    const saws = w.shots.filter((s) => s.sound.startsWith("workshop/wood/saw-stroke"));
    expect(saws.length).toBeGreaterThan(10);
    expect(w.shots.some((s) => s.sound.startsWith("workshop/wood/plank-set-down"))).toBe(true);
    for (const s of saws) expect([s.at![0], s.at![2]]).toEqual([3, 4]);
    const before = w.shots.length;
    worldClock.hour = 21; // after hours: tools down
    w.step(20);
    expect(w.shots.length).toBe(before);
  });

  it("reads working hours across midnight", () => {
    expect(inHours(23, "22-6")).toBe(true);
    expect(inHours(3, "22-6")).toBe(true);
    expect(inHours(12, "22-6")).toBe(false);
    expect(inHours(12, "7-19")).toBe(true);
    expect(inHours(12, "")).toBe(false);
  });
});
