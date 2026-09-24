import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "@hitreg/core";
import { registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type LiveSkyOptions } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

const EMITTERS = ["weather-rain", "weather-snow", "weather-sand", "weather-dust", "weather-splash", "weather-splash-ring"];

interface Emitter {
  rate?: number;
  colorScale?: number;
  emitting?: boolean;
  direction?: [number, number, number];
  speed?: [number, number];
}

/**
 * A world with one `weather` script and the tagged emitters it drives, run for
 * `seconds` of fixed ticks. Returns what the script wrote, in order.
 */
let daylightNow = 1;
/** What the world says the biome blend is at (x, z). Set per test. */
type Blend = Record<string, number>;
let biomeField: ((x: number, z: number) => Blend) | null = null;

function run(seconds: number, params: Record<string, unknown> = {}) {
  const ops: Op[] = [
    {
      op: "add-entity",
      id: "world",
      entity: { name: "World", parent: null, tags: [], components: { script: { name: "weather", params } } },
    },
  ];
  for (const tag of EMITTERS) {
    ops.push({
      op: "add-entity",
      id: tag,
      entity: { name: tag, parent: null, tags: [tag], components: { transform: {} } },
    } as Op);
  }
  // Somebody has to be standing somewhere for "what is the land here" to mean
  // anything: the sampler asks about the local player's position.
  ops.push({
    op: "add-entity",
    id: "player",
    entity: { name: "player", parent: null, tags: ["player"], components: { transform: {} } },
  } as Op);
  const doc: SceneDoc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const objects = new Map<string, THREE.Object3D>([["world", new THREE.Object3D()]]);
  for (const tag of EMITTERS) objects.set(tag, new THREE.Object3D());
  objects.set("player", new THREE.Object3D());

  const sky: LiveSkyOptions[] = [];
  /** The last value written per emitter, and the whole history of rates. */
  const emitters = new Map<string, Emitter>();
  const rates = new Map<string, number[]>();
  const loops = new Map<string, { sound: string; volume: number }>();
  const sounds: Array<{ sound: string; playbackRate: number }> = [];
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  const runtime = new ScriptRuntime({
    doc,
    objects,
    registry,
    sim: { getLinvel: () => [0, 0, 0], setLinvel: () => {}, applyImpulse: () => {} },
    input: { isDown: () => false },
    setSky: (opts) => sky.push(opts),
    daylight: () => daylightNow,
    ...(biomeField
      ? {
          biomeAt: (x: number, z: number) => {
            const weights = biomeField!(x, z);
            const id = Object.entries(weights).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
            return { id, zone: "test", weights, ground: 0, temperature: 0.5, moisture: 0.5, slope: 0 };
          },
        }
      : {}),
    setParticles: (id, opts) => {
      const current = emitters.get(id) ?? {};
      emitters.set(id, { ...current, ...opts });
      if (opts.rate !== undefined) {
        const list = rates.get(id) ?? [];
        list.push(opts.rate);
        rates.set(id, list);
      }
    },
    setSoundLoop: (_id, slot, sound, opts) => {
      if (!sound) loops.delete(slot);
      else loops.set(slot, { sound, volume: opts?.volume ?? 1 });
    },
    playSound: (_id, sound, opts) => {
      if (sound) sounds.push({ sound, playbackRate: opts?.playbackRate ?? 1 });
    },
    getSky: () => ({
      top: "#39598f",
      bottom: "#101522",
      fog: { color: "#101522", density: 0.002, near: 1, far: 400 },
      hemisphere: 0.5,
      sun: { direction: [0.4, 0.55, 0.3], color: "#fff1d6", intensity: 1.2 },
      ambient: null,
      environmentIntensity: 1,
      clouds: { coverage: 0.3, softness: 0.35 },
    }),
  });
  reseed();
  runtime.start();
  const dt = 1 / 30;
  for (let t = 0; t < seconds * 30; t++) runtime.fixedUpdate(dt);
  return { sky, emitters, rates, loops, sounds, last: () => sky[sky.length - 1]! };
}

/** Rain rate at roughly `at` seconds in, from the history of writes. */
function rateAt(rates: number[], at: number): number {
  const i = Math.min(rates.length - 1, Math.round(at * 30));
  return rates[i]!;
}

/**
 * The weather rolls dice — how long a front lasts, when lightning strikes —
 * so these run on a SEEDED random. Without it the sample points below land at
 * different places on the envelope each run, and the suite fails a few percent
 * of the time, which teaches everyone to re-run it instead of reading it.
 */
let entropy = 0;
/** Re-seed once the scene exists: building it also draws from Math.random,
 * so otherwise adding one entity to the harness shifts every weather roll. */
const reseed = () => {
  entropy = 0x9e3779b9;
};
beforeEach(() => {
  entropy = 0x9e3779b9;
  vi.spyOn(Math, "random").mockImplementation(() => {
    entropy = (entropy + 0x6d2b79f5) | 0;
    let t = entropy;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("weather fronts", () => {
  it("opens as a drizzle, builds to a downpour, and eases off again", () => {
    // One 4-minute front, pinned to a storm so the dice cannot make it clear.
    const { rates } = run(240, { force: "storm", changeMinutes: 4, fadeSeconds: 2 });
    const rain = rates.get("weather-rain")!;
    const drizzle = rateAt(rain, 20);
    const building = rateAt(rain, 80);
    const pour = rateAt(rain, 140);

    expect(drizzle).toBeGreaterThan(0); // it IS raining
    expect(drizzle).toBeLessThan(pour * 0.45); // but nothing like the pour
    expect(building).toBeGreaterThan(drizzle);
    expect(pour).toBeGreaterThan(building);
    // and the sky is darkest where the rain is heaviest, not where it started
    expect(Math.max(...rain)).toBeGreaterThan(rain[Math.round(20 * 30)]! * 3);
  });

  it("greys the cloud deck as the storm builds, and it is the deck that darkens, not only the light", () => {
    const { sky } = run(150, { force: "storm", changeMinutes: 4, fadeSeconds: 2 });
    const early = sky[Math.round(15 * 30)]!.weather!;
    const late = sky[sky.length - 1]!.weather!;
    expect(early.cloudDark!).toBeLessThan(0.2);
    expect(late.cloudDark!).toBeGreaterThan(0.4);
    expect(late.gloom!).toBeGreaterThan(early.gloom!);
    // coverage closes over too — a storm is not a bright sky that got dimmer.
    // A RANGE, not a number: the downpour plateau breathes by design, so the
    // exact value at any instant is not the contract.
    expect(sky[sky.length - 1]!.clouds!.coverage!).toBeGreaterThan(0.6);
  });

  it("leans the rain downwind, and the streaks carry the wind's own speed", () => {
    const { emitters } = run(150, { force: "storm", changeMinutes: 4, rainWind: 14, rainSpeed: 24 });
    const rain = emitters.get("weather-rain")!;
    const [x, y, z] = rain.direction!;
    expect(y).toBeLessThan(0); // still falling
    expect(Math.hypot(x, z)).toBeGreaterThan(2); // and blown sideways
    // speed is the magnitude of that aim, or the drops crawl down a steep line
    const magnitude = Math.hypot(x, y, z);
    expect(rain.speed![0]).toBeGreaterThan(magnitude * 0.8);
    expect(rain.speed![1]).toBeLessThan(magnitude * 1.2);
  });

  it("never drives the splash emitters — a splash belongs where the drop landed", () => {
    // The regression this guards: driving splash RATE spawns every splash at
    // the emitter's own origin, which is a puff of particles at your feet.
    const { rates } = run(150, { force: "storm", changeMinutes: 4 });
    expect(rates.has("weather-splash")).toBe(false);
    expect(rates.has("weather-splash-ring")).toBe(false);
  });

  it("flashes the sky for lightning, with a flicker rather than one ramp", () => {
    // A short window so the front BREAKS inside the run: lightning belongs to
    // the downpour, and a pinned storm still has to arrive before it is one.
    const { sky } = run(120, { force: "storm", changeMinutes: 1, lightning: 30 });
    const flashes = sky.map((s) => s.weather?.flash ?? 0);
    expect(Math.max(...flashes)).toBeGreaterThan(0.9);
    // A single ramp rises once. A strike rises, drops into the gap, and
    // rises again for its return strokes, so it rises at least twice.
    let rises = 0;
    for (let i = 1; i < flashes.length; i++) if (flashes[i]! - flashes[i - 1]! > 0.3) rises++;
    expect(rises).toBeGreaterThan(1);
    // and it always goes back to nothing
    expect(flashes[flashes.length - 1]).toBeLessThanOrEqual(1);
    expect(flashes.filter((f) => f === 0).length).toBeGreaterThan(flashes.length / 2);
  });

  it("dims what is falling to the hour, because particles are unlit", () => {
    // The bug this guards: a batch draws with a basic material, so at midnight
    // rain was exactly as white as at noon — bright scratches over a black
    // world. Nothing about the drop changes after dark; the light on it does.
    daylightNow = 1;
    const day = run(60, { force: "storm", changeMinutes: 1 });
    daylightNow = 0;
    const night = run(60, { force: "storm", changeMinutes: 1 });
    daylightNow = 1;

    const dayScale = day.emitters.get("weather-rain")!.colorScale!;
    const nightScale = night.emitters.get("weather-rain")!.colorScale!;
    expect(dayScale).toBeCloseTo(1, 3);
    expect(nightScale).toBeLessThan(0.3);
    // ...but never black: rain picks up the moon, a window, the sky itself
    expect(nightScale).toBeGreaterThan(0.1);
    // every kind, and the splashes, or the storm comes apart after dark
    for (const tag of ["weather-snow", "weather-sand", "weather-dust", "weather-splash", "weather-splash-ring"]) {
      expect(night.emitters.get(tag)?.colorScale).toBeLessThan(0.3);
    }
  });

  it("closes the sky over without flattening it into one grey card", () => {
    const { sky } = run(150, { force: "storm", changeMinutes: 4, fadeSeconds: 2 });
    const clouds = sky[sky.length - 1]!.clouds!;
    expect(clouds.coverage!).toBeGreaterThan(0.6);
    // NOT total: at ~0.95 the deck stops having shapes in it and reads as a
    // flat fog-coloured card — weaker than the overcast it replaced.
    expect(clouds.coverage!).toBeLessThanOrEqual(0.85);
    // and harder-edged, not softer: soft cloud is haze, which fog already does
    expect(clouds.softness!).toBeLessThan(0.35);
  });

  it("does not put a sandstorm over a forest because the player stood on a sandy patch", () => {
    // Derek's report, exactly. Two things caused it: a single-point sample,
    // and a normalisation that divided by the RECOGNISED weight only — so
    // somewhere 85% forest and 15% blight (in no list) with a sandy clearing
    // underfoot came out as a full sandstorm.
    biomeField = (x, z): Blend => (Math.hypot(x, z) < 6 ? { desert: 0.8, forest: 0.2 } : { forest: 0.85, blight: 0.15 });
    try {
      const { rates } = run(80, { force: "storm", changeMinutes: 1 });
      expect(Math.max(...(rates.get("weather-rain") ?? [0]))).toBeGreaterThan(0);
      expect(Math.max(...(rates.get("weather-sand") ?? [0]))).toBe(0);
    } finally {
      biomeField = null;
    }
  });

  it("still gives a real desert its sandstorm", () => {
    biomeField = () => ({ desert: 0.9, badlands: 0.1 });
    try {
      const { rates } = run(80, { force: "storm", changeMinutes: 1 });
      expect(Math.max(...(rates.get("weather-sand") ?? [0]))).toBeGreaterThan(0);
      expect(Math.max(...(rates.get("weather-rain") ?? [0]))).toBe(0);
    } finally {
      biomeField = null;
    }
  });

  it("carries dust in bare country with no weather at all — but never on a beach", () => {
    const dust = (field: (x: number, z: number) => Blend) => {
      biomeField = field;
      try {
        return Math.max(...(run(40, { force: "clear", changeMinutes: 4 }).rates.get("weather-dust") ?? [0]));
      } finally {
        biomeField = null;
      }
    };
    // a desert is dusty on a clear day: nothing holds the ground down
    expect(dust(() => ({ desert: 1 }))).toBeGreaterThan(0);
    // a beach is sand underfoot, not dust in the air — that looked wrong
    expect(dust(() => ({ beach: 0.8, grassland: 0.2 }))).toBe(0);
    expect(dust(() => ({ forest: 1 }))).toBe(0);
  });

  it("stays clear, silent and unlit when the weather is pinned clear", () => {
    const { sky, rates, loops } = run(60, { force: "clear", changeMinutes: 4 });
    const last = sky[sky.length - 1]!.weather!;
    expect(last.gloom).toBeCloseTo(0, 3);
    expect(last.cloudDark).toBeCloseTo(0, 3);
    expect(last.flash).toBe(0);
    expect(Math.max(...(rates.get("weather-rain") ?? [0]))).toBeCloseTo(0, 3);
    expect(loops.size).toBe(0);
  });

  it("keeps locally audible weather loops continuous and proportional to the front", () => {
    const { loops } = run(150, {
      force: "storm",
      changeMinutes: 4,
      fadeSeconds: 2,
      rainSound: "weather/rain-steady.mp3",
      rainSoundVolume: 0.4,
    });
    expect(loops.get("rain")).toEqual({ sound: "weather/rain-steady.mp3", volume: expect.any(Number) });
    expect(loops.get("rain")!.volume).toBeGreaterThan(0.25);
    expect(loops.has("snow")).toBe(false);
    expect(loops.has("sand")).toBe(false);
  });

  it("varies thunder across the authored sound list", () => {
    const { sounds } = run(120, {
      force: "storm",
      changeMinutes: 1,
      lightning: 30,
      thunder: "weather/thunder-a.mp3,weather/thunder-b.mp3,weather/thunder-c.mp3",
    });
    expect(new Set(sounds.map(({ sound }) => sound)).size).toBeGreaterThan(1);
    expect(sounds.every(({ sound }) => sound.startsWith("weather/thunder-"))).toBe(true);
    expect(sounds.every(({ playbackRate }) => playbackRate >= 0.94 && playbackRate <= 1.06)).toBe(true);
  });
});
